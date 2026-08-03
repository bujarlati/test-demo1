import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import {
  assertSafeEndpoint,
  completeJson,
  createPinnedLookup,
  extractChapterStateWithConnection,
  estimateChapterWriterInputTokenBudget,
  generateCandidateDraftsWithConnection,
  generateChapterWithConnection,
  generateStoryOpeningWithConnection,
  streamChapterWithConnection,
  testConnection,
} from "../server/modelGateway";
import {
  applyExtractedCharacterState,
  assertImmersiveNarration,
  assertPersistentExperienceFacts,
  assertReadingExperienceContent,
  assertReadingExperienceEvidence,
  assertReadingExperienceNegativeInvariants,
  ChapterEditorialValidationError,
  buildEditorialRevisionPrompt,
  editorialRevisionIssuesForFailure,
  buildChapterPrompt,
  buildConversationContext,
  chapterParagraphCountIsAllowed,
  classifyReadingExperienceDelivery,
  endingContractSatisfied,
  eventFromChapter,
  generateLocalChapter,
  groundReadingExperienceEvidence,
  normalizeChapterEditorialIssues,
  planNextChapter,
  retrieveRelevantMemory,
  storyArcPhase,
  validateGeneratedChapter,
} from "../server/narrativeEngine";
import { replayBranchState } from "../server/canonState";
import { handleReaderMessage, rollbackRetcon } from "../server/retconService";
import { safetyCategories } from "../server/safetyService";
import { recordSafetyDecision } from "../server/safetyService";
import { createSeedStore } from "../server/seed";
import { commitNextChapter, createStory, finalizeStoryIfTargetReached } from "../server/storyService";
import {
  assertStoryOpeningPublicationSafe,
  createStoryWithOpening,
  storyOpeningPublicationText,
} from "../server/openingService";
import { connectionStatusAfterTestFailure, listGenerationModelOptions } from "../server/modelConnectionAccess";
import {
  assertGenerationTokenBudget,
  CHAPTER_EXTRACTION_ADMISSION_RESERVE,
  CONTINUATION_GENERATION_TIERS,
  CONTINUATION_JOB_TOKEN_BUDGET,
  estimateModelCallTokenBudget,
} from "../server/generationBudget";
import { accumulateModelUsage, attachModelUsage, recordFailedJobUsage } from "../server/modelUsage";
import {
  formatReadingExperienceCadenceForPrompt,
  normalizeReadingExperienceDeliveryLedger,
  readingExperienceCadenceAuditEvents,
  readingExperienceCadenceState,
  refineReadingExperienceContract,
  readingExperienceAxisUsesSoftWindow,
  updateReadingExperienceDeliveryLedger,
  usesExperienceWordAsLiteralLabel,
} from "../server/readingExperience";
import {
  OPENING_CHAPTER_MIN_CHARACTERS,
  OPENING_CHAPTER_TARGET_CHARACTERS,
  openingChapterLengthIsAllowed,
} from "../server/openingConstraints";
import { composeCustomTone, isStoryTone, STORY_GENRES, STORY_LENGTH_OPTIONS, STORY_TONES } from "../src/storyConfig";
import { currentRevision } from "../src/storyDomain";
import type { GenerationJob, ModelConnection } from "../src/types";

interface FakeModelProviderOptions {
  embeddingMode?: "standard" | "ark_multimodal";
  mandatoryMinCompletionTokens?: number;
  writerDelayMs?: number;
  writerHeadersOnly?: boolean;
  writerStatus?: number;
  routeStatusByModel?: Record<string, number>;
  routeContentByModel?: Record<string, string>;
  responseDelayMs?: number;
}

const readFakeModelSecret = async () => "test-api-key";

async function startFakeModelProvider(options: FakeModelProviderOptions = {}) {
  let activeRequests = 0;
  let maxConcurrentRequests = 0;
  let responsesCalls = 0;
  const embeddingRequests: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const mandatoryProbeModels: string[] = [];
  let resolveWriterProbeSeen: (() => void) | undefined;
  let resolveWriterHeadersSent: (() => void) | undefined;
  const writerProbeSeen = new Promise<void>((resolve) => {
    resolveWriterProbeSeen = resolve;
  });
  const writerHeadersSent = new Promise<void>((resolve) => {
    resolveWriterHeadersSent = resolve;
  });
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "writer-test", context_window: 128_000 }] }));
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (request.url === "/responses") responsesCalls += 1;
      activeRequests += 1;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        input?: unknown;
        max_tokens?: number;
        messages?: Array<{ content?: string }>;
        model?: string;
        stream?: boolean;
      };
      if (request.url?.startsWith("/embeddings")) {
        embeddingRequests.push({ pathname: request.url, body });
      }
      const prompt = body.messages?.[0]?.content ?? "";
      const isMandatoryProbe = prompt === "回复：好";
      if (isMandatoryProbe && body.model) mandatoryProbeModels.push(body.model);
      const isWriterProbe = isMandatoryProbe && body.model === "writer-test";
      if (isWriterProbe) {
        resolveWriterProbeSeen?.();
        resolveWriterProbeSeen = undefined;
      }
      if (isWriterProbe && options.writerHeadersOnly) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write("{\"choices\":", () => {
          resolveWriterHeadersSent?.();
          resolveWriterHeadersSent = undefined;
        });
        return;
      }
      const delay = isWriterProbe ? options.writerDelayMs ?? 0 : options.responseDelayMs ?? 0;
      const sendResponse = () => {
        try {
          const mandatoryRouteStatus = isMandatoryProbe && body.model
            ? options.routeStatusByModel?.[body.model] ?? (isWriterProbe ? options.writerStatus : undefined)
            : undefined;
          if (
            isMandatoryProbe && options.mandatoryMinCompletionTokens &&
            (body.max_tokens ?? 0) < options.mandatoryMinCompletionTokens
          ) {
            response.statusCode = 400;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ error: { message: "max_tokens is below provider minimum" } }));
          } else if (mandatoryRouteStatus && mandatoryRouteStatus !== 200) {
            response.statusCode = mandatoryRouteStatus;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ error: { message: isWriterProbe ? "writer access denied" : `${body.model} access denied` } }));
          } else if (request.url === "/embeddings" && options.embeddingMode === "ark_multimodal") {
            response.statusCode = 404;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ error: { message: "use /embeddings/multimodal" } }));
          } else if (request.url === "/embeddings") {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
          } else if (request.url === "/embeddings/multimodal" && options.embeddingMode === "ark_multimodal") {
            const input = Array.isArray(body.input) ? body.input : [];
            const hasTypedText = input.some((item) => item && typeof item === "object" &&
              (item as { type?: unknown }).type === "text" &&
              typeof (item as { text?: unknown }).text === "string");
            if (!hasTypedText) {
              response.statusCode = 400;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ error: { message: "typed multimodal input required" } }));
            } else {
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ data: [{ embedding: [[0.1, 0.2]] }] }));
            }
          } else if (body.stream) {
            response.setHeader("Content-Type", "text/event-stream");
            response.end("data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n");
          } else {
            const hasRouteContent = Boolean(isMandatoryProbe && body.model && options.routeContentByModel) &&
              Object.prototype.hasOwnProperty.call(options.routeContentByModel, body.model);
            const content = hasRouteContent
              ? options.routeContentByModel![body.model!]
              : prompt.startsWith("只返回 JSON") ? "{\"ok\":true}" : "好";
            const message = prompt === "调用 ping 工具"
              ? { content, tool_calls: [{ id: "call_ping", type: "function", function: { name: "ping", arguments: "{}" } }] }
              : { content };
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({
              choices: [{ message, finish_reason: "stop" }],
              usage: { prompt_tokens_details: { cached_tokens: prompt.startsWith("提示词缓存") ? 8 : 0 } },
            }));
          }
        } finally {
          activeRequests -= 1;
        }
      };
      if (delay > 0) setTimeout(sendResponse, delay);
      else sendResponse();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connection: ModelConnection = {
    id: "conn_test_fake_provider",
    name: "Fake model provider",
    ownerScope: "platform",
    ownerId: null,
    protocol: "openai_compatible",
    baseUrl: `http://127.0.0.1:${address.port}`,
    maskedKey: "test••••key",
    secretRef: "test://fake-provider",
    secretVersion: 1,
    status: "draft",
    routes: {
      planner: "planner-test",
      writer: "writer-test",
      extractor: "extractor-test",
      embedding: "embedding-test",
    },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const previousAllowPrivate = process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS;
  process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS = "true";
  return {
    connection,
    writerHeadersSent,
    writerProbeSeen,
    mandatoryProbeModels: () => [...mandatoryProbeModels],
    maxConcurrentRequests: () => maxConcurrentRequests,
    embeddingRequests: () => structuredClone(embeddingRequests),
    responsesCalls: () => responsesCalls,
    async close() {
      if (previousAllowPrivate === undefined) delete process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS;
      else process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS = previousAllowPrivate;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function startResponsesModelProvider(options: { chatDelayMs?: number; modelsStatus?: number } = {}) {
  const mandatoryProbeModels: string[] = [];
  let chatCompletionCalls = 0;
  let responsesCalls = 0;
  let resolveChatProbeSeen: (() => void) | undefined;
  const chatProbeSeen = new Promise<void>((resolve) => { resolveChatProbeSeen = resolve; });
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/models") {
      if (options.modelsStatus && options.modelsStatus !== 200) {
        response.statusCode = options.modelsStatus;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ error: { message: "model listing is unavailable" } }));
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        data: [
          { id: "planner-responses", context_window: 200_000 },
          { id: "writer-responses", context_window: 200_000 },
          { id: "extractor-responses", context_window: 200_000 },
        ],
      }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        input?: string;
        model?: string;
      };
      if (request.url === "/chat/completions") {
        chatCompletionCalls += 1;
        resolveChatProbeSeen?.();
        resolveChatProbeSeen = undefined;
        const sendFailure = () => {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: { message: "chat endpoint unavailable" } }));
        };
        if (options.chatDelayMs) setTimeout(sendFailure, options.chatDelayMs);
        else sendFailure();
        return;
      }
      if (request.url === "/embeddings") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
        return;
      }
      if (request.url === "/responses" && request.method === "POST") {
        responsesCalls += 1;
        if (body.input === "回复：好" && body.model) mandatoryProbeModels.push(body.model);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          object: "response",
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "好" }],
          }],
          usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 },
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connection: ModelConnection = {
    id: "conn_test_responses_provider",
    name: "Responses model provider",
    ownerScope: "platform",
    ownerId: null,
    protocol: "openai_compatible",
    baseUrl: `http://127.0.0.1:${address.port}`,
    maskedKey: "test••••key",
    secretRef: "test://responses-provider",
    secretVersion: 1,
    status: "draft",
    routes: {
      planner: "planner-responses",
      writer: "writer-responses",
      extractor: "extractor-responses",
      embedding: "embedding-responses",
    },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const previousAllowPrivate = process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS;
  process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS = "true";
  return {
    connection,
    chatProbeSeen,
    mandatoryProbeModels: () => [...mandatoryProbeModels],
    chatCompletionCalls: () => chatCompletionCalls,
    responsesCalls: () => responsesCalls,
    async close() {
      if (previousAllowPrivate === undefined) delete process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS;
      else process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS = previousAllowPrivate;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function budgetTestConnection(id: string): ModelConnection {
  return {
    id,
    name: "Budget test",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: `vault://${id}`,
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
}

function siliconFlowStreamingTestConnection(id: string): ModelConnection {
  const connection = budgetTestConnection(id);
  return {
    ...connection,
    name: "SiliconFlow streaming JSON",
    baseUrl: "https://api.siliconflow.cn/v1",
    routes: {
      planner: "deepseek-ai/DeepSeek-V4-Pro",
      writer: "deepseek-ai/DeepSeek-V4-Pro",
      extractor: "Qwen/Qwen3-14B",
      embedding: "Qwen/Qwen3-Embedding-8B",
    },
    capabilities: {
      streaming: true,
      jsonSchema: true,
      embedding: true,
      promptCache: false,
      toolCalling: false,
      maxContextTokens: null,
      testedAt: new Date().toISOString(),
      latencyMs: 40_039,
      models: ["deepseek-ai/DeepSeek-V4-Pro", "Qwen/Qwen3-14B"],
    },
  };
}

function openingBudgetFixture() {
  const base = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test");
  return {
    context: {
      input: { genre: "都市", tone: "机械 · 奶爸" },
      contract: base.readingExperience,
      targetChapterCount: base.targetChapterCount,
    },
    connection: budgetTestConnection("conn_opening_stage_budget"),
    plan: {
      title: base.title,
      subtitle: base.subtitle,
      leadName: base.characters[0].name,
      storyGene: base.storyGene,
      endingContract: base.endingContract,
      worldBible: base.worldBible,
      experienceAxes: base.readingExperience.axes.map((axis) => ({
        word: axis.word,
        interpretation: axis.interpretation,
        observableSignals: axis.observableSignals.map((signal) => signal.description),
        hardPromises: axis.hardPromises.map((promise) => promise.description),
        forbiddenShortcuts: axis.forbiddenShortcuts,
      })),
      openingBeats: ["机械行动立即改变冲突", "父女选择改变现场关系"],
    },
    paragraph: "机械臂完成精确校准后稳稳托住奶瓶，奶爸周砺俯身听清女儿说出的需要，再用当场完成的维修结果挡住逼近的威胁。父女共同作出的选择改变了维修铺门前的冲突，围观者随即收起武器并重新调整立场，资源和关系都留下了明确变化。".repeat(2),
  };
}

test("opening chapter length keeps only the minimum gate and treats the upper target as Writer guidance", () => {
  assert.equal(OPENING_CHAPTER_MIN_CHARACTERS, 1_800);
  assert.equal(OPENING_CHAPTER_TARGET_CHARACTERS, 2_800);
  assert.equal(openingChapterLengthIsAllowed("字".repeat(1_799)), false);
  assert.equal(openingChapterLengthIsAllowed("字".repeat(1_800)), true);
  assert.equal(openingChapterLengthIsAllowed("字".repeat(5_523)), true);
  assert.equal(openingChapterLengthIsAllowed("字".repeat(6_000)), true);
  assert.equal(openingChapterLengthIsAllowed("字".repeat(6_001)), true);
  assert.equal(openingChapterLengthIsAllowed("字".repeat(12_000)), true);
});

test("new stories expose broad web-fiction genres and serial-scale chapter plans", () => {
  assert.ok(STORY_GENRES.length >= 20);
  assert.deepEqual(STORY_LENGTH_OPTIONS.map((option) => option.chapterCount), [80, 200, 500, 1000]);

  const xianxia = createStory({
    genre: "仙侠",
    lengthPlan: STORY_LENGTH_OPTIONS[1].id,
    inspiration: "一个杂役弟子发现宗门飞升的秘密",
  }, "user_test");
  const system = createStory({
    genre: "系统流",
    lengthPlan: STORY_LENGTH_OPTIONS[3].id,
  }, "user_test");

  assert.equal(xianxia.targetChapterCount, 200);
  assert.equal(system.targetChapterCount, 1000);
  assert.match(JSON.stringify(xianxia.storyGene), /宗门|灵根|飞升|问道/);
  assert.match(JSON.stringify(system.storyGene), /系统|任务|奖励|权限/);

  const genreStories = STORY_GENRES.map((option) => createStory({ genre: option.label }, "user_test"));
  assert.equal(new Set(genreStories.map((story) => story.storyGene.creativeAxes.join("|"))).size, STORY_GENRES.length);
  assert.ok(genreStories.every((story) => story.targetChapterCount === 200));
  assert.ok(genreStories.every((story) => currentRevision(story.chapters[0])!.paragraphs.join("").length >= 2_400));
  const sports = genreStories.find((story) => story.genre === "体育")!;
  assert.match(currentRevision(sports.chapters[0])!.paragraphs.join(""), /训练馆|赛程|队友|竞技/);
  assert.match(currentRevision(xianxia.chapters[0])!.paragraphs.join(""), /山门|灵气|宗门|修炼/);
});

test("system-fiction defaults do not force a broken or reward-withholding system", () => {
  const story = createStory({ genre: "系统流", tone: "爽快 · 逆袭" }, "user_test");

  assert.doesNotMatch(
    JSON.stringify({ gene: story.storyGene, opening: currentRevision(story.chapters[0])!.paragraphs.slice(0, 4) }),
    /故障系统|系统拒绝结算|奖励已撤回|奖励陷阱|长期权限不足/,
  );
});

test("system stability understands an explicit no-penalty and no-reward-withdrawal promise", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test").readingExperience;
  assert.doesNotThrow(() => assertReadingExperienceNegativeInvariants(
    contract,
    "系统不提供任务失败惩罚或奖励撤回，但签到地点会随世界反应改变。",
    { protagonistNames: ["林渊"] },
  ));
  assert.throws(() => assertReadingExperienceNegativeInvariants(
    contract,
    "系统不提供额外解释，随后奖励撤回，已领取能力全部失效。",
    { protagonistNames: ["林渊"] },
  ), /系统|稳定结算|持续可用/);
});

test("story tone presets are broad and two custom words form one safe tone", () => {
  assert.ok(STORY_TONES.length >= 12);
  assert.equal(composeCustomTone(" 清冷 ", "浪漫"), "清冷 · 浪漫");
  assert.equal(composeCustomTone("", "浪漫"), null);
  assert.equal(composeCustomTone("过于漫长的基调词", "浪漫"), null);
  assert.equal(composeCustomTone("清冷 · 阴郁", "浪漫"), null);
  assert.equal(isStoryTone("清冷 · 浪漫"), true);
  assert.equal(isStoryTone("只有一个词语"), false);
  const story = createStory({ genre: "都市", tone: "清冷 · 浪漫" }, "user_test");
  assert.equal(story.tone, "清冷 · 浪漫");
});

test("two reading-feeling words become an observable story contract", () => {
  const story = createStory({
    genre: "玄幻",
    tone: "系统 · 无敌",
    inspiration: "少年绑定最强系统后横推宗门",
  }, "user_test");

  assert.deepEqual(story.readingExperience.sourceWords, ["系统", "无敌"]);
  assert.match(
    JSON.stringify(story.readingExperience),
    /触发条件.*系统反馈.*奖励|压倒性.*获胜|不败|不五五开/,
  );
});

test("planner refinements cannot weaken curated reading-experience guarantees", () => {
  const base = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const refined = refineReadingExperienceContract(base, [
    {
      word: "系统",
      interpretation: "系统偶尔作为背景信息出现，不必影响主角行动",
      observableSignals: ["界面曾经短暂出现", "人物听说过系统传闻"],
      hardPromises: ["故事后期可以再次提到系统"],
      forbiddenShortcuts: [],
    },
    {
      word: "无敌",
      interpretation: "主角最终可能变强，前期可以持续落败",
      observableSignals: ["主角表达变强愿望", "敌人认为主角未来可期"],
      hardPromises: ["结局以前让主角赢下一次"],
      forbiddenShortcuts: [],
    },
  ]);

  assert.match(JSON.stringify(refined.axes[0]), /触发条件.*系统反馈.*奖励|第一章前 15%/);
  assert.match(JSON.stringify(refined.axes[1]), /压倒性获胜|全程不败|不五五开/);
  assert.match(JSON.stringify(refined.axes[1]), /隐藏实力拖延兑现|封印或失忆/);

  const arbitraryBase = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test").readingExperience;
  const arbitraryRefined = refineReadingExperienceContract(arbitraryBase, [
    {
      word: "机械",
      interpretation: "机械装置必须被操作并改变现场资源",
      observableSignals: ["人物操作机械装置并改变资源", "机械故障迫使人物调整行动"],
      hardPromises: ["每章让机械操作产生明确结果"],
      forbiddenShortcuts: [],
    },
    {
      word: "奶爸",
      interpretation: "父亲照料行动必须回应孩子的具体需求",
      observableSignals: ["奶爸父亲吹凉热粥后递给孩子", "奶爸与孩子共同选择并改变关系"],
      hardPromises: ["每章用奶爸行动回应孩子需求"],
      forbiddenShortcuts: [],
    },
  ]);
  for (const axis of arbitraryRefined.axes) {
    assert.ok(axis.observableSignals.some((signal) => signal.id.includes("_model_signal_")));
    assert.ok(axis.observableSignals.some((signal) => !signal.id.includes("_model_signal_")));
  }
});

test("chapter writer receives both reading-experience axes as observable requirements", () => {
  const story = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test");
  const prompt = buildChapterPrompt(story, planNextChapter(story));

  assert.match(prompt, /体验轴“系统”[\s\S]*触发条件[\s\S]*体验轴“无敌”[\s\S]*压倒性/);
  assert.match(prompt, /小说正文与章名必须始终留在故事世界内部[\s\S]*不得出现上一章[\s\S]*作者侧规划词/);
  assert.match(prompt, /篇幅建议[\s\S]*仅为写作建议[\s\S]*不设最高字数[\s\S]*最低/);
  assert.doesNotMatch(prompt, /必须在 \d+—\d+ 字之间/);
});

test("editorial revision prompt returns the original manuscript with concrete reviewer feedback", () => {
  const story = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test");
  const plan = planNextChapter(story);
  const original = {
    title: "第二章 雨棚下的旧机械臂",
    paragraphs: [
      "周砺把维修铺的卷帘门推到一半，先让小满从雨里进来。",
      "机械臂停在工作台旁，父女二人继续查看门外的动静。",
      "协会的人堵住巷口，要求他们立刻交出维修铺。",
      "周砺没有改变已经选定的应对方案，只等对方先开口。",
    ],
    model: "writer-web-fiction",
    origin: "model" as const,
  };
  const axis = story.readingExperience.axes[0];
  const issue = {
    code: "weak_experience_signal" as const,
    axisId: axis.id,
    axisWord: axis.word,
    signalIds: [axis.observableSignals[0].id],
    location: "body" as const,
    sourceQuote: original.paragraphs[1],
    reason: "机械臂只作为布景出现，没有被人物操作，也没有改变现场资源。",
    requestedChange: "保留巷口冲突，让周砺操作机械臂解决眼前障碍并写出直接结果。",
    source: "reviewer" as const,
  };

  const prompt = buildEditorialRevisionPrompt(
    story,
    plan,
    original,
    [issue],
  );

  assert.match(prompt, /编辑退修任务/);
  assert.ok(prompt.includes(original.title));
  for (const paragraph of original.paragraphs) assert.ok(prompt.includes(paragraph));
  assert.ok(prompt.includes(issue.reason));
  assert.ok(prompt.includes(issue.requestedChange));
  assert.ok(prompt.includes(plan.selected.event));
  assert.ok(prompt.includes(plan.selected.cost));
  assert.ok(prompt.includes(plan.selected.impact));
  assert.match(prompt, /建议约 \d+ 字[\s\S]*不设最高字数[\s\S]*最低要求/);
  assert.doesNotMatch(prompt, /必须稳定落在 \d+—\d+ 字/);
  assert.doesNotMatch(prompt, /另起思路|全新成稿/);
});

test("chapter reviewer returns normalized editorial issues for the original manuscript", async () => {
  const story = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test");
  const plan = planNextChapter(story);
  const chapter = {
    ...generateLocalChapter(story, plan),
    model: "writer-web-fiction",
    origin: "model" as const,
  };
  const axis = story.readingExperience.axes[0];
  const sourceQuote = chapter.paragraphs[0].slice(0, 80);
  let reviewerSystem = "";

  const extracted = await extractChapterStateWithConnection(
    budgetTestConnection("conn_editorial_review"),
    chapter,
    undefined,
    story.readingExperience,
    async <T>(_connection, _model, system) => {
      reviewerSystem = system;
      return {
        value: {
          events: [],
          characterUpdates: [],
          itemUpdates: [],
          experienceEvidence: chapter.experienceEvidence ?? [],
          editorialIssues: [{
            code: "weak_experience_signal",
            axisId: axis.id,
            axisWord: axis.word,
            signalIds: [axis.observableSignals[0].id, "invented_signal"],
            location: "body",
            sourceQuote,
            reason: "当前句子只有物件名称，没有可观察的操作与结果。",
            requestedChange: "让主角实际操作该物件并改变现场状态。",
          }],
        } as T,
        usageTokens: 120,
        usageEstimated: false,
      };
    },
    Number.POSITIVE_INFINITY,
    story.chapters.length + 1,
  );

  assert.match(reviewerSystem, /editorialIssues/);
  assert.match(reviewerSystem, /具体问题|修改要求|退修/);
  const schemaText = reviewerSystem.match(/只返回 JSON：(\{.*\})；不得新增正文没有的事实/)?.[1];
  assert.ok(schemaText, "reviewer prompt must contain a machine-parseable JSON example");
  assert.doesNotThrow(() => JSON.parse(schemaText));
  assert.equal(extracted.editorialIssues?.length, 1);
  assert.equal(extracted.editorialIssues?.[0].source, "reviewer");
  assert.equal(extracted.editorialIssues?.[0].axisWord, axis.word);
  assert.deepEqual(extracted.editorialIssues?.[0].signalIds, [axis.observableSignals[0].id]);
  assert.equal(extracted.editorialIssues?.[0].sourceQuote, sourceQuote);
});

test("reviewed and deterministic signal failures expose typed editorial feedback", () => {
  const story = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test");
  const plan = planNextChapter(story);
  const generated = {
    ...generateLocalChapter(story, plan),
    model: "writer-web-fiction",
    origin: "model" as const,
  };
  const axis = story.readingExperience.axes[0];
  const reviewedIssue = {
    code: "weak_experience_signal" as const,
    axisId: axis.id,
    axisWord: axis.word,
    signalIds: [axis.observableSignals[0].id],
    location: "chapter" as const,
    reason: "系统反馈没有转化为主角可使用的结果。",
    requestedChange: "补足主角领取并实际调用奖励的动作和结果。",
    source: "reviewer" as const,
  };

  assert.deepEqual(
    editorialRevisionIssuesForFailure(new Error("模型连接超时"), undefined),
    [],
    "operational errors must not send an accepted manuscript back to the writer",
  );
  assert.deepEqual(
    editorialRevisionIssuesForFailure(new Error("ordinary validation error"), [reviewedIssue]),
    [],
    "reviewer feedback cannot turn an operational or evidence-format error into a writer revision",
  );

  assert.deepEqual(
    editorialRevisionIssuesForFailure(
      new ChapterEditorialValidationError("editorial", [reviewedIssue]),
      [reviewedIssue],
    ),
    [reviewedIssue],
    "typed editorial failures should merge and deduplicate reviewer feedback",
  );

  assert.throws(
    () => validateGeneratedChapter(story, generated, plan, {
      events: [],
      characterUpdates: [],
      experienceEvidence: generated.experienceEvidence,
      editorialIssues: [reviewedIssue],
    }),
    (error) => error instanceof ChapterEditorialValidationError &&
      error.editorialIssues[0].requestedChange === reviewedIssue.requestedChange,
  );

  assert.throws(
    () => validateGeneratedChapter(story, generated, plan, {
      events: [],
      characterUpdates: [],
      experienceEvidence: [],
      editorialIssues: [],
    }),
    (error) => error instanceof ChapterEditorialValidationError &&
      error.editorialIssues.some((issue) => issue.code === "missing_experience_signal" && issue.source === "validator_fallback"),
  );
});

test("a newly created story opens with a substantial first chapter", () => {
  const story = createStory({
    genre: "玄幻",
    lengthPlan: STORY_LENGTH_OPTIONS[1].id,
    inspiration: "被废去修为的少年在矿山里听见远古心跳",
  }, "user_test");
  const revision = currentRevision(story.chapters[0])!;

  assert.ok(revision.paragraphs.length >= 18);
  assert.ok(revision.paragraphs.join("").length >= 2_400);
  assert.ok(story.chapters[0].estimatedMinutes >= 10);
});

test("a system-and-invincible opening delivers both experiences immediately", () => {
  const story = createStory({
    genre: "玄幻",
    tone: "系统 · 无敌",
    inspiration: "少年绑定诸天最强系统，从宗门外门开始横推",
  }, "user_test");
  const text = currentRevision(story.chapters[0])!.paragraphs.join("\n");

  assert.doesNotMatch(text.slice(0, 160), /系统\s*[·・]\s*无敌的天光|系统的天光|无敌的天光/);
  assert.match(text.slice(0, 700), /系统(?:面板|提示|绑定|激活|奖励|任务|权限)/);
  assert.match(text, /(?:碾压|横推|秒杀|一击|绝对差距|压倒性)/);
});

test("arbitrary reading-feeling words are never pasted onto scenery", () => {
  const story = createStory({ genre: "科幻", tone: "机械 · 奶爸" }, "user_test");
  const text = currentRevision(story.chapters[0])!.paragraphs.join("\n");

  assert.doesNotMatch(text, /机械\s*[·・]\s*奶爸的(?:天光|晨雾|暮色)/);
});

test("story creation publishes the selected writer's validated opening without local fallback", async () => {
  const connection: ModelConnection = {
    id: "conn_selected",
    name: "Selected provider",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://selected",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner-strong", writer: "writer-web-fiction", extractor: "extractor-review", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const story = await createStoryWithOpening(
    { genre: "都市", tone: "机械 · 奶爸", inspiration: "退役机甲师独自照顾三岁女儿" },
    "user_test",
    connection,
    async ({ contract }) => {
      const firstQuote = "机械臂稳稳托住滚烫奶瓶，温度停在女儿最习惯的四十度";
      const secondQuote = "小满扑进父亲怀里，让全场绷紧的枪口第一次慢慢垂下";
      return {
        title: "钢铁手臂与草莓奶",
        subtitle: "退役机甲师带女儿重返旧城",
        leadName: "周砺",
        storyGene: {
          protagonistPosition: "带着三岁女儿生活的退役王牌机甲师",
          visibleGoal: "保护女儿并重建被夺走的维修铺",
          hiddenNeed: "学会把保护变成陪伴，而不是替女儿决定一切",
          conflictEngine: "机甲技术解决外部威胁，父女日常决定每次胜利为何值得",
          recurringCost: "胜利会扩大父亲必须保护与照料的社区范围",
          endingShape: "父女守住家与城市，也建立平等可靠的伙伴关系",
          creativeAxes: ["机甲维修", "育儿日常", "父女默契", "旧城重建", "王牌回归"],
        },
        endingContract: {
          targetEnding: "父女共同选择留下并重建旧城",
          characterArc: "从独自承担到与女儿和伙伴共同生活",
          prerequisites: ["维修铺重新开门", "女儿能够表达自己的选择"],
        },
        worldBible: {
          organizations: ["旧城维修协会"],
          locations: ["第七码头维修铺"],
          abilityBoundaries: ["机甲能源必须由现实资源补给"],
          pointOfView: "近距离第三人称",
          styleParameters: ["动作直接", "父女互动具体"],
        },
        chapter: {
          title: "第一章 钢铁手臂热牛奶",
          paragraphs: Array.from({ length: 16 }, (_, index) => `${index === 0 ? firstQuote : index === 1 ? secondQuote : `周砺处理第${index + 1}项眼前麻烦`}。维修铺里的动作、对话和结果都清楚落地；他一边解决逼近的危险，一边回应女儿当下真正需要的照料。旧城众人亲眼看见父女的选择如何改变现场，没有人用抽象标签替他们宣布感受。`.repeat(2)),
          model: "writer-web-fiction",
          experienceEvidence: [
            { axisId: "primary", word: "机械", signalIds: contract.axes[0].observableSignals.slice(0, 2).map((signal) => signal.id), quote: firstQuote },
            { axisId: "secondary", word: "奶爸", signalIds: contract.axes[1].observableSignals.slice(0, 2).map((signal) => signal.id), quote: secondQuote },
          ],
        },
        event: {
          title: "维修铺前的第一次交锋",
          cause: "旧协会强占铺面",
          outcome: "周砺护住女儿并夺回维修铺",
          location: "第七码头维修铺",
          persistentFacts: [firstQuote, secondQuote],
        },
        plannerModel: "planner-strong",
        writerModel: "writer-web-fiction",
        usageTokens: 4_200,
        usageEstimated: false,
      };
    },
  );

  assert.equal(story.modelConnectionId, "conn_selected");
  assert.equal(currentRevision(story.chapters[0])!.modelName, "writer-web-fiction");
  assert.match(currentRevision(story.chapters[0])!.paragraphs.join("\n"), /机械臂.*奶瓶[\s\S]*小满.*父亲怀里/);
  assert.deepEqual(story.characters[0].knowledge, [
    "机械臂稳稳托住滚烫奶瓶，温度停在女儿最习惯的四十度",
    "小满扑进父亲怀里，让全场绷紧的枪口第一次慢慢垂下",
  ]);
  assert.deepEqual(story.items, []);
  assert.deepEqual(story.rules, []);
  assert.deepEqual(story.clues, []);
  assert.equal(story.events.length, 1);
  assert.equal(story.events[0].cause, "旧协会强占铺面");
  assert.equal(story.events[0].outcome, "周砺护住女儿并夺回维修铺");
  assert.doesNotMatch(
    JSON.stringify(story),
    /第一章的异常物|因果不可抹除|开篇出现的本地秩序机构|主角第一次遇见故事核心异常|第一章中亲眼看到的异常/,
  );
  assert.match(buildChapterPrompt(story, planNextChapter(story)), /机械臂稳稳托住滚烫奶瓶/);
});

test("opening publication safety covers generated library metadata as well as chapter prose", () => {
  const unsafeText = "杀光某民族";
  const mutations: Array<[string, (story: ReturnType<typeof createStory>) => void]> = [
    ["book title", (story) => { story.title = unsafeText; }],
    ["subtitle", (story) => { story.subtitle = unsafeText; }],
    ["story gene", (story) => { story.storyGene.conflictEngine = unsafeText; }],
    ["ending contract", (story) => { story.endingContract.prerequisites = [unsafeText]; }],
    ["world bible", (story) => { story.worldBible.organizations = [unsafeText]; }],
    ["event title", (story) => { story.events[0].title = unsafeText; }],
    ["event cause", (story) => { story.events[0].cause = unsafeText; }],
    ["event outcome", (story) => { story.events[0].outcome = unsafeText; }],
    ["event location", (story) => { story.events[0].location = unsafeText; }],
    ["chapter title", (story) => { story.chapters[0].title = unsafeText; }],
    ["chapter prose", (story) => { story.chapters[0].revisions[0].paragraphs[0] = unsafeText; }],
  ];

  for (const [label, mutate] of mutations) {
    const story = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test");
    mutate(story);
    assert.match(storyOpeningPublicationText(story), /杀光某民族/, `${label} must be scanned`);
    assert.throws(
      () => assertStoryOpeningPublicationSafe(story),
      /内容触发安全策略/,
      `${label} must block publication`,
    );
  }
});

test("opening generation uses the selected planner, writer, and independent evidence reviewer", async () => {
  const connection: ModelConnection = {
    id: "conn_opening_pipeline",
    name: "Opening pipeline",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://opening",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner-route", writer: "writer-route", extractor: "reviewer-route", embedding: "embedding-route" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const base = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test");
  const calledModels: string[] = [];
  const calledPrompts: string[] = [];
  let writerAttempts = 0;
  const generated = await generateStoryOpeningWithConnection({
    input: { genre: "都市", tone: "机械 · 奶爸", inspiration: "退役机甲师带女儿守住维修铺" },
    contract: base.readingExperience,
    targetChapterCount: base.targetChapterCount,
  }, connection, async ({ model, prompt }) => {
    calledModels.push(model);
    calledPrompts.push(prompt);
    if (model === "planner-route") return {
      value: {
        title: "钢铁摇篮",
        subtitle: "退役机甲师与三岁女儿的旧城生活",
        leadName: "周砺",
        storyGene: {
          protagonistPosition: "独自照顾女儿的退役机甲师",
          visibleGoal: "守住维修铺和女儿的生活",
          hiddenNeed: "学会倾听女儿自己的选择",
          conflictEngine: "机甲冲突和育儿日常共同改变旧城关系",
          recurringCost: "每次公开实力都会扩大需要照料的社区范围",
          endingShape: "父女和伙伴共同重建旧城",
          creativeAxes: ["机械维修", "父女日常", "旧城守护"],
        },
        endingContract: { targetEnding: "旧城获得新生", characterArc: "从独自保护到共同生活", prerequisites: ["维修铺重开"] },
        worldBible: { organizations: ["维修协会"], locations: ["旧城"], abilityBoundaries: ["机甲需要能源"], pointOfView: "近距离第三人称", styleParameters: ["动作清楚"] },
        experienceAxes: [
          {
            word: "机械",
            interpretation: "机械必须作为可操作能力推动事件",
            observableSignals: [
              { description: "机械臂完成精确动作并挡住威胁", evidenceAnchors: ["机械臂", "精确动作", "挡住威胁"] },
              { description: "机械维修恢复资源并改变现场状态", evidenceAnchors: ["机械维修", "恢复资源", "现场状态"] },
            ],
            hardPromises: ["每章至少一次有效机械操作"],
            forbiddenShortcuts: ["只描写金属颜色"],
          },
          {
            word: "奶爸",
            interpretation: "奶爸的照料和女儿的回应共同推动关系",
            observableSignals: [
              { description: "奶爸周砺听见女儿说出自己的需要", evidenceAnchors: ["听见女儿", "自己的需要"] },
              { description: "女儿作出选择后父亲调整方案", evidenceAnchors: ["作出选择", "调整方案"] },
            ],
            hardPromises: ["每章都有父女双向互动"],
            forbiddenShortcuts: ["把女儿当作被保护的道具"],
          },
        ],
        openingBeats: ["机械动作在首段出现", "父女关系在首个冲突中改变结果"],
      },
      usageTokens: 1_200,
      usageEstimated: false,
    };
    if (model === "writer-route") {
      writerAttempts += 1;
      return {
        value: {
          title: "第一章 机械臂热好的牛奶",
          paragraphs: writerAttempts === 1
            ? Array.from({ length: 16 }, () => "机械臂热好了牛奶。")
            : Array.from({ length: 16 }, (_, index) => `机械臂完成第${index + 1}个精确动作，奶爸周砺同时听见女儿说出自己的需要。父女的选择改变了维修铺门前的冲突结果，围观者随即调整立场，资源和关系都产生清晰变化。这个现场以人物行动继续推进，没有用抽象标签代替感受。`.repeat(2)),
        },
        usageTokens: 2_600,
        usageEstimated: false,
      };
    }
    return {
      value: {
        experienceEvidence: [
          { axisId: "primary", word: "机械", signalIds: ["primary_机械_model_signal_1", "primary_机械_model_signal_2", "primary_机械_signal_1"], quote: "机械臂完成第1个精确动作" },
          { axisId: "secondary", word: "奶爸", signalIds: ["secondary_奶爸_model_signal_1", "secondary_奶爸_model_signal_2", "secondary_奶爸_signal_1"], quote: "奶爸周砺同时听见女儿说出自己的需要" },
        ],
        event: {
          title: "维修铺门前的交锋",
          cause: "维修协会试图收走铺面",
          outcome: "父女共同守住维修铺",
          location: "旧城维修铺",
          persistentFacts: ["机械臂完成第1个精确动作", "周砺同时听见女儿说出自己的需要"],
        },
      },
      usageTokens: 500,
      usageEstimated: false,
    };
  });

  assert.deepEqual(calledModels, ["planner-route", "writer-route", "writer-route", "reviewer-route"]);
  assert.equal(writerAttempts, 2);
  assert.equal(generated.chapter.title, "机械臂热好的牛奶");
  assert.equal(generated.readingExperience?.provenance, "model");
  assert.equal(generated.chapter.experienceEvidence?.length, 2);
  assert.match(
    calledPrompts.at(-1) ?? "",
    /第一章硬性必需 signalIds：\["primary_机械_model_signal_1","primary_机械_signal_1","secondary_奶爸_model_signal_1","secondary_奶爸_signal_1"\]/,
  );
});

test("opening planner request specifies the nested machine-readable blueprint schema", async () => {
  const { context, connection } = openingBudgetFixture();
  let plannerSystem = "";
  let plannerOverallTimeoutMs: number | undefined;

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async (request) => {
      plannerSystem = request.system;
      plannerOverallTimeoutMs = request.overallTimeoutMs;
      throw new Error("stop after planner prompt capture");
    }, Number.POSITIVE_INFINITY),
    /stop after planner prompt capture/,
  );

  assert.match(plannerSystem, /"storyGene"\s*:\s*\{\s*"protagonistPosition"/);
  assert.match(plannerSystem, /"endingContract"\s*:\s*\{\s*"targetEnding"/);
  assert.match(plannerSystem, /"worldBible"\s*:\s*\{\s*"organizations"/);
  assert.match(plannerSystem, /"openingBeats"\s*:\s*\[\s*"/);
  assert.match(plannerSystem, /storyGene、endingContract、worldBible 必须是 JSON 对象/);
  assert.match(plannerSystem, /openingBeats 必须是字符串数组/);
  assert.equal(plannerOverallTimeoutMs, 600_000);

  const schemaLine = plannerSystem.split("\n").find((line) => line.startsWith('{"title":'));
  assert.ok(schemaLine, "planner prompt must contain a parseable JSON example");
  const schema = JSON.parse(schemaLine) as {
    experienceAxes: Array<{
      observableSignals: Array<{ description: string; evidenceAnchors: string[] }>;
    }>;
  };
  assert.equal(schema.experienceAxes.length, 2);
  for (const axis of schema.experienceAxes) {
    assert.ok(axis.observableSignals.length >= 2);
    for (const signal of axis.observableSignals) {
      assert.ok(signal.evidenceAnchors.length >= 2);
      assert.ok(signal.evidenceAnchors.every((anchor) => signal.description.includes(anchor)));
    }
  }
});

test("opening generation repairs a semantically useful planner response with the wrong JSON shape", async () => {
  const { context, connection, plan } = openingBudgetFixture();
  const requests: Array<{ model: string; system: string; prompt: string }> = [];
  const malformedPlan = {
    title: "钢铁摇篮",
    subtitle: "退役机甲师守住女儿与旧城",
    leadName: "周砺",
    storyGene: "机械奶爸、旧城守护、及时回报",
    endingContract: "父女与邻里共同重建旧城",
    worldBible: "维修协会控制旧城资源，机甲能源有限",
    experienceAxes: plan.experienceAxes,
    openingBeats: [
      { beat: "机械臂在首段挡住威胁" },
      { beat: "父女共同选择改变现场关系" },
    ],
  };
  const hostileRepair = {
    ...plan,
    title: "修复器擅自改名",
    subtitle: "修复器擅自更换故事",
    leadName: "陌生主角",
  };

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async (request) => {
      requests.push({ model: request.model, system: request.system, prompt: request.prompt });
      if (requests.length === 1) {
        return { value: malformedPlan, usageTokens: 148, usageEstimated: false };
      }
      if (requests.length === 2) {
        return { value: hostileRepair, usageTokens: 200, usageEstimated: false };
      }
      throw attachModelUsage(new Error("writer transport failed after plan repair"), 300, false);
    }, Number.POSITIVE_INFINITY),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.match(error.message, /writer transport failed after plan repair/);
      assert.equal(error.usageTokens, 648);
      assert.equal(error.usageEstimated, false);
      return true;
    },
  );

  assert.deepEqual(requests.map((request) => request.model), [
    connection.routes.planner,
    connection.routes.extractor,
    connection.routes.writer,
  ]);
  assert.match(requests[1].system, /开篇蓝图.*结构修复/);
  assert.match(requests[1].prompt, /storyGene/);
  assert.match(requests[1].prompt, /openingBeats/);
  assert.match(requests[2].prompt, /"title":"钢铁摇篮"/);
  assert.match(requests[2].prompt, /"leadName":"周砺"/);
  assert.doesNotMatch(requests[2].prompt, /修复器擅自改名|陌生主角/);
});

test("opening semantic repair remains available after two schema repairs", async () => {
  const { connection } = openingBudgetFixture();
  const base = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test");
  const context = {
    input: { genre: "系统流", tone: "系统 · 无敌" },
    contract: base.readingExperience,
    targetChapterCount: base.targetChapterCount,
  };
  const safePlan = {
    title: "签到即无敌",
    subtitle: "每次签到都让世界秩序重新排位",
    leadName: "林峰",
    storyGene: base.storyGene,
    endingContract: base.endingContract,
    worldBible: base.worldBible,
    experienceAxes: base.readingExperience.axes.map((axis) => ({
      word: axis.word,
      interpretation: axis.interpretation,
      observableSignals: axis.observableSignals.map((signal) => signal.description),
      hardPromises: axis.hardPromises.map((promise) => promise.description),
      forbiddenShortcuts: axis.forbiddenShortcuts,
    })),
    openingBeats: ["林峰在首段完成签到并领取奖励", "林峰一击镇压强敌并改变秩序"],
  };
  const unsafeStoryGene = {
    ...safePlan.storyGene,
    recurringCost: "系统会拒绝结算并撤回已经发放的奖励",
  };
  const malformedPlan = {
    ...safePlan,
    storyGene: unsafeStoryGene,
    worldBible: "错误的世界设定形状",
    openingBeats: [{ beat: "错误的节拍形状" }],
  };
  const firstSchemaRepair = {
    ...safePlan,
    openingBeats: [{ beat: "仍然错误的节拍形状" }],
  };
  const semanticRepair = {
    ...safePlan,
    title: "修复器不得改名",
    storyGene: {
      ...safePlan.storyGene,
      recurringCost: "每次胜利都会扩大需要维护的世界秩序与资源范围",
    },
  };
  const requests: Array<{ model: string; prompt: string }> = [];

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async (request) => {
      requests.push({ model: request.model, prompt: request.prompt });
      if (requests.length === 1) return { value: malformedPlan, usageTokens: 100, usageEstimated: false };
      if (requests.length === 2) return { value: firstSchemaRepair, usageTokens: 200, usageEstimated: false };
      if (requests.length === 3) return { value: safePlan, usageTokens: 250, usageEstimated: false };
      if (requests.length === 4) return { value: semanticRepair, usageTokens: 300, usageEstimated: false };
      throw attachModelUsage(new Error("writer reached after independent repair budgets"), 400, false);
    }, Number.POSITIVE_INFINITY),
    (error: Error & { usageTokens?: number }) => {
      assert.match(error.message, /writer reached after independent repair budgets/);
      assert.equal(error.usageTokens, 1_250);
      return true;
    },
  );

  assert.deepEqual(requests.map((request) => request.model), [
    connection.routes.planner,
    connection.routes.extractor,
    connection.routes.extractor,
    connection.routes.extractor,
    connection.routes.writer,
  ]);
  assert.match(requests[3].prompt, /storyGene\.recurringCost/);
  assert.match(requests[4].prompt, /每次胜利都会扩大需要维护的世界秩序与资源范围/);
  assert.doesNotMatch(requests[4].prompt, /修复器不得改名/);
});

test("opening generation retries semantic blueprint repair when the first repair still weakens system guarantees", async () => {
  const { connection } = openingBudgetFixture();
  const base = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test");
  const context = {
    input: { genre: "系统流", tone: "系统 · 无敌" },
    contract: base.readingExperience,
    targetChapterCount: base.targetChapterCount,
  };
  const safePlan = {
    title: "签到即无敌",
    subtitle: "每次签到都让世界秩序重新排位",
    leadName: "林峰",
    storyGene: base.storyGene,
    endingContract: base.endingContract,
    worldBible: base.worldBible,
    experienceAxes: base.readingExperience.axes.map((axis) => ({
      word: axis.word,
      interpretation: axis.interpretation,
      observableSignals: axis.observableSignals.map((signal) => signal.description),
      hardPromises: axis.hardPromises.map((promise) => promise.description),
      forbiddenShortcuts: axis.forbiddenShortcuts,
    })),
    openingBeats: ["林峰在首段完成签到并领取奖励", "林峰一击镇压来犯强敌并改变现场秩序"],
  };
  const unsafePlan = {
    ...safePlan,
    worldBible: {
      ...safePlan.worldBible,
      abilityBoundaries: ["系统随时可能故障并拒绝结算，已经发放的奖励也会被撤回"],
    },
  };
  const hostileSafeRepair = {
    ...safePlan,
    title: "修复器改写的书名",
    leadName: "修复器改写的主角",
    worldBible: {
      ...safePlan.worldBible,
      organizations: ["修复器替换的组织"],
      locations: ["修复器替换的世界"],
      abilityBoundaries: ["系统持续稳定结算，既有奖励永久有效"],
    },
  };
  const requests: Array<{ model: string; system: string; prompt: string }> = [];

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async (request) => {
      requests.push({ model: request.model, system: request.system, prompt: request.prompt });
      if (requests.length === 1) return { value: unsafePlan, usageTokens: 100, usageEstimated: false };
      if (requests.length === 2) return { value: unsafePlan, usageTokens: 200, usageEstimated: false };
      if (requests.length === 3) return { value: hostileSafeRepair, usageTokens: 250, usageEstimated: false };
      throw attachModelUsage(new Error("writer reached after semantic plan repair"), 300, false);
    }, Number.POSITIVE_INFINITY),
    (error: Error & { usageTokens?: number }) => {
      assert.match(error.message, /writer reached after semantic plan repair/);
      assert.equal(error.usageTokens, 850);
      return true;
    },
  );

  assert.deepEqual(requests.map((request) => request.model), [
    connection.routes.planner,
    connection.routes.extractor,
    connection.routes.extractor,
    connection.routes.writer,
  ]);
  assert.match(requests[1].prompt, /稳定结算|持续可用|系统/);
  assert.match(requests[2].prompt, /稳定结算|持续可用|系统/);
  assert.match(requests[3].prompt, new RegExp(`"title":"${safePlan.title}"`));
  assert.match(requests[3].prompt, new RegExp(`"leadName":"${safePlan.leadName}"`));
  assert.doesNotMatch(requests[3].prompt, /修复器改写|修复器替换/);
});

test("opening generation repairs a system invariant that spans adjacent blueprint fields", async () => {
  const { connection } = openingBudgetFixture();
  const base = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test");
  const context = {
    input: { genre: "系统流", tone: "系统 · 无敌" },
    contract: base.readingExperience,
    targetChapterCount: base.targetChapterCount,
  };
  const safePlan = {
    title: "签到即无敌",
    subtitle: "每次签到都让世界秩序重新排位",
    leadName: "林峰",
    storyGene: base.storyGene,
    endingContract: base.endingContract,
    worldBible: base.worldBible,
    experienceAxes: base.readingExperience.axes.map((axis) => ({
      word: axis.word,
      interpretation: axis.interpretation,
      observableSignals: axis.observableSignals.map((signal) => signal.description),
      hardPromises: axis.hardPromises.map((promise) => promise.description),
      forbiddenShortcuts: axis.forbiddenShortcuts,
    })),
    openingBeats: ["林峰在首段完成签到并领取奖励", "林峰一击镇压来犯强敌并改变现场秩序"],
  };
  const unsafePlan = {
    ...safePlan,
    storyGene: {
      ...safePlan.storyGene,
      conflictEngine: "林峰持续调用系统推进目标",
      recurringCost: "拒绝结算会扩大敌方秩序的反应",
    },
  };
  const targetedRepair = {
    ...safePlan,
    title: "修复器擅自改名",
    leadName: "陌生主角",
    storyGene: {
      ...safePlan.storyGene,
      conflictEngine: "修复器擅自替换冲突引擎",
      recurringCost: "每次胜利都会扩大需要维护的世界秩序与资源范围",
    },
  };
  const requests: Array<{ model: string; system: string; prompt: string }> = [];

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async (request) => {
      requests.push({ model: request.model, system: request.system, prompt: request.prompt });
      if (requests.length === 1) return { value: unsafePlan, usageTokens: 100, usageEstimated: false };
      if (requests.length === 2) return { value: targetedRepair, usageTokens: 200, usageEstimated: false };
      throw attachModelUsage(new Error("writer reached after cross-field semantic repair"), 300, false);
    }, Number.POSITIVE_INFINITY),
    (error: Error & { usageTokens?: number }) => {
      assert.match(error.message, /writer reached after cross-field semantic repair/);
      assert.equal(error.usageTokens, 600);
      return true;
    },
  );

  assert.deepEqual(requests.map((request) => request.model), [
    connection.routes.planner,
    connection.routes.extractor,
    connection.routes.writer,
  ]);
  assert.match(requests[1].prompt, /稳定结算|持续可用|系统/);
  assert.match(requests[1].prompt, /storyGene\.recurringCost/);
  assert.match(requests[2].prompt, /"title":"签到即无敌"/);
  assert.match(requests[2].prompt, /"leadName":"林峰"/);
  assert.match(requests[2].prompt, /"conflictEngine":"林峰持续调用系统推进目标"/);
  assert.match(requests[2].prompt, /"recurringCost":"每次胜利都会扩大需要维护的世界秩序与资源范围"/);
  assert.doesNotMatch(requests[2].prompt, /修复器擅自|陌生主角/);
});

test("system-and-invincible writer keeps system payoff hard while treating victory as soft cadence", async () => {
  const { connection } = openingBudgetFixture();
  const base = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test");
  const plan = {
    title: "签到即无敌",
    subtitle: "每次签到都让世界秩序重新排位",
    leadName: "林峰",
    storyGene: base.storyGene,
    endingContract: base.endingContract,
    worldBible: base.worldBible,
    experienceAxes: base.readingExperience.axes.map((axis) => ({
      word: axis.word,
      interpretation: axis.interpretation,
      observableSignals: axis.observableSignals.map((signal) => signal.description),
      hardPromises: axis.hardPromises.map((promise) => promise.description),
      forbiddenShortcuts: axis.forbiddenShortcuts,
    })),
    openingBeats: ["林峰在首段完成签到并领取奖励", "林峰一击镇压来犯强敌并改变现场秩序"],
  };
  let writerPrompt = "";

  await assert.rejects(
    () => generateStoryOpeningWithConnection({
      input: { genre: "系统流", tone: "系统 · 无敌", inspiration: "用户指定的永恒签到系统与宗门秩序" },
      contract: base.readingExperience,
      targetChapterCount: base.targetChapterCount,
    }, connection, async (request) => {
      if (request.model === connection.routes.planner) {
        return { value: plan, usageTokens: 100, usageEstimated: false };
      }
      writerPrompt = request.prompt;
      throw new Error("stop after specialized writer prompt capture");
    }, Number.POSITIVE_INFINITY),
    /stop after specialized writer prompt capture/,
  );

  assert.match(writerPrompt, /第一段前 120 字/);
  assert.match(writerPrompt, /林峰本人/);
  assert.match(writerPrompt, /触发.*系统.*反馈.*奖励/);
  assert.match(writerPrompt, /不超过 100 字/);
  assert.match(writerPrompt, /同一句.*林峰.*系统面板.*领取/);
  assert.match(writerPrompt, /不得先写背景|不得先写赶路/);
  assert.match(writerPrompt, /只用正面事实.*持续在线.*即时结算.*永久生效/);
  assert.match(writerPrompt, /用户指定的永恒签到系统与宗门秩序/);
  assert.match(writerPrompt, /无敌.*跨章节奏主旋律/);
  assert.match(writerPrompt, /允许铺垫、暂时五五开或把冲突保持未决/);
  assert.match(writerPrompt, /不得让林峰形成已经落地的最终失败/);
  assert.match(writerPrompt, /不要为了过校验强塞固定胜利句/);
  assert.match(writerPrompt, /不要求第一章取胜/);
  assert.doesNotMatch(writerPrompt, /必须把以下三句逐字|不超过 80 字|胜利句后/);
  assert.match(writerPrompt, /建议写约 2800 个中文字符、约 18 个完整段落/);
  assert.match(writerPrompt, /仅是写作建议[\s\S]*不设最高字数/);
  assert.match(writerPrompt, /不得少于 1800 字/);
  assert.doesNotMatch(writerPrompt, /严格写 18|目标总长为 2000—3600/);
  const requiredOpeningScaffold = "林峰打开系统面板，系统立即发放永久生效的至尊权限奖励，林峰点击领取并当场调用。林峰随后核对仓库账册，准备追查宗门资源流向。";
  assert.doesNotThrow(() => assertReadingExperienceContent(
    base.readingExperience,
    requiredOpeningScaffold,
    { protagonistNames: ["林峰"], opening: true, chapterNumber: 1 },
  ));
  assert.equal(classifyReadingExperienceDelivery(
    base.readingExperience, requiredOpeningScaffold, { protagonistNames: ["林峰"] },
  )[0]?.state, "no_conflict");
});

test("system-and-invincible opening reaches review without rewriting a valid no-combat chapter", async () => {
  const { connection } = openingBudgetFixture();
  const base = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test");
  const plan = {
    title: "签到即无敌",
    subtitle: "每次签到都让世界秩序重新排位",
    leadName: "林峰",
    storyGene: base.storyGene,
    endingContract: base.endingContract,
    worldBible: base.worldBible,
    experienceAxes: base.readingExperience.axes.map((axis) => ({
      word: axis.word,
      interpretation: axis.interpretation,
      observableSignals: axis.observableSignals.map((signal) => signal.description),
      hardPromises: axis.hardPromises.map((promise) => promise.description),
      forbiddenShortcuts: axis.forbiddenShortcuts,
    })),
    openingBeats: ["林峰在首段完成签到并领取奖励", "林峰一击镇压来犯强敌并改变现场秩序"],
  };
  const quietWork = "林峰把仓库里的木箱逐个归位，又把门窗、灯火、货单与钥匙一一核对，确认每件东西都有清楚去处后才继续整理手边的杂物。";
  const systemPayoff = "林峰完成触发条件，打开系统面板；系统反馈并发放永久奖励，林峰点击领取后确认状态变化已经生效。";
  const paragraphs = Array.from({ length: 16 }, (_, index) =>
    index === 0
      ? `${systemPayoff}${quietWork.repeat(2)}`
      : quietWork.repeat(3),
  );
  const writerPrompts: string[] = [];
  const calledModels: string[] = [];

  const generated = await generateStoryOpeningWithConnection({
      input: { genre: "系统流", tone: "系统 · 无敌" },
      contract: base.readingExperience,
      targetChapterCount: base.targetChapterCount,
    }, connection, async (request) => {
      calledModels.push(request.model);
      if (request.model === connection.routes.planner) {
        return { value: plan, usageTokens: 100, usageEstimated: false };
      }
      if (request.model === connection.routes.writer) {
        writerPrompts.push(request.prompt);
        return {
          value: { title: "第一章 仓库签到", paragraphs },
          usageTokens: 2_000,
          usageEstimated: false,
        };
      }
      return {
        value: {
          experienceEvidence: [{
            axisId: "primary",
            word: "系统",
            signalIds: ["primary_系统_signal_1", "primary_系统_signal_2"],
            quote: systemPayoff,
          }],
          event: {
            title: "仓库签到",
            cause: "林峰接手仓库清点",
            outcome: "系统奖励生效，仓库清点继续推进",
            location: "宗门仓库",
            persistentFacts: [systemPayoff, quietWork],
          },
        },
        usageTokens: 500,
        usageEstimated: false,
      };
    }, Number.POSITIVE_INFINITY);

  assert.deepEqual(calledModels, [connection.routes.planner, connection.routes.writer, connection.routes.extractor]);
  assert.equal(writerPrompts.length, 1);
  assert.deepEqual(generated.chapter.experienceEvidence?.map((evidence) => evidence.word), ["系统"]);
  assert.equal(classifyReadingExperienceDelivery(
    generated.readingExperience!, paragraphs.join("\n"), { protagonistNames: ["林峰"] },
  )[0]?.state, "no_conflict");
});

test("opening generation accepts paragraphs beyond the suggested count without rewriting", async () => {
  const connection: ModelConnection = {
    id: "conn_opening_paragraph_retry",
    name: "Opening paragraph retry",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://opening-paragraph-retry",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner-route", writer: "writer-route", extractor: "reviewer-route", embedding: "embedding-route" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const base = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test");
  const paragraph = "机械臂完成精确校准后稳稳托住奶瓶，奶爸周砺俯身听清女儿说出的需要，再用当场完成的维修结果挡住逼近的威胁。父女共同作出的选择改变了维修铺门前的冲突，围观者随即收起武器并重新调整立场，资源和关系都留下了明确变化。".repeat(2);
  const calledModels: string[] = [];
  let writerAttempts = 0;

  await generateStoryOpeningWithConnection({
    input: { genre: "都市", tone: "机械 · 奶爸" },
    contract: base.readingExperience,
    targetChapterCount: base.targetChapterCount,
  }, connection, async ({ model }) => {
    calledModels.push(model);
    if (model === "planner-route") return {
      value: {
        title: base.title,
        subtitle: base.subtitle,
        leadName: base.characters[0].name,
        storyGene: base.storyGene,
        endingContract: base.endingContract,
        worldBible: base.worldBible,
        experienceAxes: [
          {
            word: "机械",
            interpretation: "机械体验由机械臂的精确校准、托举和维修结果体现",
            observableSignals: ["机械臂完成精确校准后托住奶瓶", "机械维修挡住逼近维修铺的威胁"],
            hardPromises: ["每章让机械操作产生具体结果"],
            forbiddenShortcuts: ["只描写金属颜色"],
          },
          {
            word: "奶爸",
            interpretation: "奶爸体验由父亲听清女儿需要并共同改变选择体现",
            observableSignals: ["奶爸父亲俯身听清女儿说出的需要", "父女共同选择改变现场关系"],
            hardPromises: ["每章用双向父女行动推进关系"],
            forbiddenShortcuts: ["把孩子写成道具"],
          },
        ],
        openingBeats: ["机械行动立即改变冲突", "父女选择改变现场关系"],
      },
      usageTokens: 1_000,
      usageEstimated: false,
    };
    if (model === "writer-route") {
      writerAttempts += 1;
      return {
        value: {
          title: "第一章 修好的机械臂",
          paragraphs: Array.from({ length: writerAttempts === 1 ? 21 : 16 }, () => paragraph),
        },
        usageTokens: 2_000,
        usageEstimated: false,
      };
    }
    return {
      value: {
        experienceEvidence: [
          { axisId: "primary", word: "机械", signalIds: ["primary_机械_model_signal_1", "primary_机械_model_signal_2", "primary_机械_signal_1"], quote: "机械臂完成精确校准后稳稳托住奶瓶" },
          { axisId: "secondary", word: "奶爸", signalIds: ["secondary_奶爸_model_signal_1", "secondary_奶爸_model_signal_2", "secondary_奶爸_signal_1"], quote: "奶爸周砺俯身听清女儿说出的需要" },
        ],
        event: {
          title: "维修铺门前的冲突",
          cause: "武装人员逼近维修铺",
          outcome: "父女共同守住维修铺",
          location: "旧城维修铺门前",
          persistentFacts: ["机械臂完成精确校准后稳稳托住奶瓶", "父女共同作出的选择改变了维修铺门前的冲突"],
        },
      },
      usageTokens: 500,
      usageEstimated: false,
    };
  });

  assert.equal(writerAttempts, 1);
  assert.deepEqual(calledModels, ["planner-route", "writer-route", "reviewer-route"]);
});

test("opening generation grounds paraphrased persistent state in validated prose evidence", async () => {
  const { context, connection, plan, paragraph } = openingBudgetFixture();
  const mechanicalQuote = "机械臂完成精确校准后稳稳托住奶瓶";
  const parentQuote = "奶爸周砺俯身听清女儿说出的需要";
  const groundedPlan = {
    ...plan,
    experienceAxes: [
      {
        word: "机械",
        interpretation: "机械体验由精确校准、托举和维修结果体现",
        observableSignals: [
          { description: mechanicalQuote, evidenceAnchors: ["精确校准", "托住奶瓶"] },
          { description: "机械维修恢复现场资源并挡住逼近威胁", evidenceAnchors: ["恢复现场资源", "挡住逼近威胁"] },
        ],
        hardPromises: ["每章让机械操作产生具体结果"],
        forbiddenShortcuts: ["只描写金属颜色"],
      },
      {
        word: "奶爸",
        interpretation: "奶爸体验由父亲听清女儿需要并共同改变选择体现",
        observableSignals: [
          { description: parentQuote, evidenceAnchors: ["俯身听清", "女儿说出的需要"] },
          { description: "父女共同作出选择并改变维修铺冲突", evidenceAnchors: ["共同作出选择", "改变维修铺冲突"] },
        ],
        hardPromises: ["每章用双向父女行动推进关系"],
        forbiddenShortcuts: ["把孩子写成道具"],
      },
    ],
  };

  const generated = await generateStoryOpeningWithConnection(context, connection, async ({ model }) => {
    if (model === connection.routes.planner) {
      return { value: groundedPlan, usageTokens: 100, usageEstimated: false };
    }
    if (model === connection.routes.writer) {
      return {
        value: {
          title: "第一章 修好的机械臂",
          paragraphs: Array.from({ length: 16 }, () => paragraph),
        },
        usageTokens: 200,
        usageEstimated: false,
      };
    }
    return {
      value: {
        experienceEvidence: [
          {
            axisId: "primary",
            word: "机械",
            signalIds: ["primary_机械_model_signal_1", "primary_机械_model_signal_2", "primary_机械_signal_1"],
            quote: "周砺把机械臂校准好，奶瓶随后被稳稳托住",
          },
          {
            axisId: "secondary",
            word: "奶爸",
            signalIds: ["secondary_奶爸_model_signal_1", "secondary_奶爸_model_signal_2", "secondary_奶爸_signal_1"],
            quote: "周砺弄清了女儿真正想要什么",
          },
        ],
        event: {
          title: "维修铺门前的冲突",
          cause: "武装人员逼近维修铺",
          outcome: "父女共同守住维修铺",
          location: "旧城维修铺门前",
          persistentFacts: [
            "机械臂已经被周砺精确校准并成功托稳奶瓶",
            "周砺听懂女儿需求后调整了守店方案",
          ],
        },
      },
      usageTokens: 300,
      usageEstimated: false,
    };
  });

  assert.deepEqual(generated.event.persistentFacts, [mechanicalQuote, parentQuote]);
});

test("opening generation repairs malformed reviewer JSON without rewriting accepted prose", async () => {
  const { context, connection, plan, paragraph } = openingBudgetFixture();
  const mechanicalQuote = "机械臂完成精确校准后稳稳托住奶瓶";
  const parentQuote = "奶爸周砺俯身听清女儿说出的需要";
  const reviewablePlan = {
    ...plan,
    experienceAxes: [
      {
        word: "机械",
        interpretation: "机械体验由精确校准、托举和维修结果体现",
        observableSignals: [
          { description: mechanicalQuote, evidenceAnchors: ["精确校准", "托住奶瓶"] },
          { description: "机械维修恢复现场资源并挡住逼近威胁", evidenceAnchors: ["恢复现场资源", "挡住逼近威胁"] },
        ],
        hardPromises: ["每章让机械操作产生具体结果"],
        forbiddenShortcuts: ["只描写金属颜色"],
      },
      {
        word: "奶爸",
        interpretation: "奶爸体验由父亲听清女儿需要并共同改变选择体现",
        observableSignals: [
          { description: parentQuote, evidenceAnchors: ["俯身听清", "女儿说出的需要"] },
          { description: "父女共同作出选择并改变维修铺冲突", evidenceAnchors: ["共同作出选择", "改变维修铺冲突"] },
        ],
        hardPromises: ["每章用双向父女行动推进关系"],
        forbiddenShortcuts: ["把孩子写成道具"],
      },
    ],
  };
  const validReview = {
    experienceEvidence: [
      {
        axisId: "primary",
        word: "机械",
        signalIds: ["primary_机械_model_signal_1", "primary_机械_model_signal_2", "primary_机械_signal_1"],
        quote: mechanicalQuote,
      },
      {
        axisId: "secondary",
        word: "奶爸",
        signalIds: ["secondary_奶爸_model_signal_1", "secondary_奶爸_model_signal_2", "secondary_奶爸_signal_1"],
        quote: parentQuote,
      },
    ],
    event: {
      title: "维修铺门前的冲突",
      cause: "武装人员逼近维修铺",
      outcome: "父女共同守住维修铺",
      location: "旧城维修铺门前",
      persistentFacts: [mechanicalQuote, parentQuote],
    },
  };
  const requests: Array<{ model: string; system: string }> = [];
  const observedFailures: Array<{ stage: string; attempt: number; error: unknown }> = [];

  const generated = await generateStoryOpeningWithConnection(context, connection, async (request) => {
    requests.push({ model: request.model, system: request.system });
    if (requests.length === 1) return { value: reviewablePlan, usageTokens: 100, usageEstimated: false };
    if (requests.length === 2) {
      return {
        value: { title: "第一章 修好的机械臂", paragraphs: Array.from({ length: 16 }, () => paragraph) },
        usageTokens: 200,
        usageEstimated: false,
      };
    }
    if (requests.length === 3) {
      return {
        value: { ...validReview, event: { ...validReview.event, location: "", persistentFacts: [] } },
        usageTokens: 300,
        usageEstimated: false,
      };
    }
    return {
      value: {
        ...validReview,
        event: {
          ...validReview.event,
          title: "修复器改写的事件",
          cause: "修复器改写的原因",
          outcome: "修复器改写的结果",
          persistentFacts: ["修复器虚构的状态事实至少八个字"],
        },
      },
      usageTokens: 400,
      usageEstimated: false,
    };
  }, Number.POSITIVE_INFINITY, (failure) => observedFailures.push(failure));

  assert.deepEqual(requests.map((request) => request.model), [
    connection.routes.planner,
    connection.routes.writer,
    connection.routes.extractor,
    connection.routes.extractor,
  ]);
  assert.match(requests[3].system, /审稿.*JSON.*修复/);
  assert.equal(observedFailures.length, 1);
  assert.equal(observedFailures[0].stage, "开篇审稿结构校验");
  assert.match(observedFailures[0].error instanceof Error ? observedFailures[0].error.message : "", /Schema/);
  assert.equal(generated.usageTokens, 1_000);
  assert.equal(generated.chapter.paragraphs.length, 16);
  assert.equal(generated.event.title, validReview.event.title);
  assert.equal(generated.event.cause, validReview.event.cause);
  assert.equal(generated.event.outcome, validReview.event.outcome);
  assert.equal(generated.event.location, validReview.event.location);
  assert.deepEqual(generated.event.persistentFacts, validReview.event.persistentFacts);
  assert.doesNotMatch(JSON.stringify(generated.event), /修复器/);
});

test("opening reviewer retries unparseable JSON without rewriting accepted prose", async () => {
  const { context, connection, plan, paragraph } = openingBudgetFixture();
  const mechanicalQuote = "机械臂完成精确校准后稳稳托住奶瓶";
  const parentQuote = "奶爸周砺俯身听清女儿说出的需要";
  const reviewablePlan = {
    ...plan,
    experienceAxes: [
      {
        word: "机械",
        interpretation: "机械体验由精确校准、托举和维修结果体现",
        observableSignals: [
          { description: mechanicalQuote, evidenceAnchors: ["精确校准", "托住奶瓶"] },
          { description: "机械维修恢复现场资源并挡住逼近威胁", evidenceAnchors: ["恢复现场资源", "挡住逼近威胁"] },
        ],
        hardPromises: ["每章让机械操作产生具体结果"],
        forbiddenShortcuts: ["只描写金属颜色"],
      },
      {
        word: "奶爸",
        interpretation: "奶爸体验由父亲听清女儿需要并共同改变选择体现",
        observableSignals: [
          { description: parentQuote, evidenceAnchors: ["俯身听清", "女儿说出的需要"] },
          { description: "父女共同作出选择并改变维修铺冲突", evidenceAnchors: ["共同作出选择", "改变维修铺冲突"] },
        ],
        hardPromises: ["每章用双向父女行动推进关系"],
        forbiddenShortcuts: ["把孩子写成道具"],
      },
    ],
  };
  const validReview = {
    experienceEvidence: [
      {
        axisId: "primary",
        word: "机械",
        signalIds: ["primary_机械_model_signal_1", "primary_机械_model_signal_2", "primary_机械_signal_1"],
        quote: mechanicalQuote,
      },
      {
        axisId: "secondary",
        word: "奶爸",
        signalIds: ["secondary_奶爸_model_signal_1", "secondary_奶爸_model_signal_2", "secondary_奶爸_signal_1"],
        quote: parentQuote,
      },
    ],
    event: {
      title: "维修铺门前的冲突",
      cause: "武装人员逼近维修铺",
      outcome: "父女共同守住维修铺",
      location: "旧城维修铺门前",
      persistentFacts: [],
    },
  };
  const requests: Array<{ model: string; system: string }> = [];
  let writerCalls = 0;

  const generated = await generateStoryOpeningWithConnection(context, connection, async (request) => {
    requests.push(request);
    if (requests.length === 1) return { value: reviewablePlan, usageTokens: 100, usageEstimated: false };
    if (request.model === connection.routes.writer) {
      writerCalls += 1;
      return {
        value: { title: "第一章 修好的机械臂", paragraphs: Array.from({ length: 16 }, () => paragraph) },
        usageTokens: 200,
        usageEstimated: false,
      };
    }
    if (requests.length === 3) {
      throw attachModelUsage(new Error("模型 Qwen/Qwen3-14B 输出不是可修复的 JSON。"), 300, false);
    }
    return { value: validReview, usageTokens: 400, usageEstimated: false };
  }, Number.POSITIVE_INFINITY);

  assert.equal(writerCalls, 1);
  assert.deepEqual(requests.map((request) => request.model), [
    connection.routes.planner,
    connection.routes.writer,
    connection.routes.extractor,
    connection.routes.extractor,
  ]);
  assert.match(requests[3].system, /上一轮没有形成可解析 JSON/);
  assert.equal(generated.usageTokens, 1_000);
  assert.deepEqual(generated.event.persistentFacts, [mechanicalQuote, parentQuote]);
});

test("opening generation gives slow reasoning routes stage-appropriate deadlines", async () => {
  const { context, connection, plan, paragraph } = openingBudgetFixture();
  const requests: Array<{ model: string; timeout: number }> = [];

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async (request) => {
      requests.push({ model: request.model, timeout: request.timeout });
      if (request.model === connection.routes.planner) {
        return { value: plan, usageTokens: 100, usageEstimated: false };
      }
      if (request.model === connection.routes.writer) {
        return {
          value: { title: "第一章 修好的机械臂", paragraphs: Array.from({ length: 16 }, () => paragraph) },
          usageTokens: 1_000,
          usageEstimated: false,
        };
      }
      throw new Error("reviewer stop after deadline capture");
    }),
    /reviewer stop after deadline capture/,
  );

  assert.deepEqual(requests.slice(0, 3), [
    { model: connection.routes.planner, timeout: 180_000 },
    { model: connection.routes.writer, timeout: 300_000 },
    { model: connection.routes.extractor, timeout: 120_000 },
  ]);
});

test("opening gateway failures expose consumed model usage", async () => {
  const base = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test");
  const connection: ModelConnection = {
    id: "conn_usage_failure",
    name: "Usage failure",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://usage-failure",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner-route", writer: "writer-route", extractor: "reviewer-route", embedding: "embedding-route" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };

  await assert.rejects(
    () => generateStoryOpeningWithConnection({
      input: { genre: "都市", tone: "机械 · 奶爸" },
      contract: base.readingExperience,
      targetChapterCount: base.targetChapterCount,
    }, connection, async () => ({ value: {}, usageTokens: 1_234, usageEstimated: false })),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.equal(error.usageTokens, 3_702);
      assert.equal(error.usageEstimated, false);
      return /Schema/.test(error.message);
    },
  );
});

test("completeJson uses the negotiated OpenAI Responses API and normalizes output_text", async () => {
  const connection: ModelConnection = {
    id: "conn_responses_completion",
    name: "Responses completion",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://responses-completion",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: {
      completionApi: "responses",
      streaming: false,
      jsonSchema: false,
      embedding: false,
      promptCache: false,
      toolCalling: false,
      maxContextTokens: null,
      testedAt: new Date().toISOString(),
      latencyMs: 1,
    },
    updatedAt: new Date().toISOString(),
  };
  let pathname = "";
  let requestBody: Record<string, unknown> = {};

  const result = await completeJson<{ ok: boolean }>(
    connection,
    connection.routes.writer,
    "只返回 JSON",
    "生成正文",
    10_000,
    400,
    {
      secretReader: async () => "test-key",
      modelFetcher: async (_connection, _apiKey, nextPathname, init) => {
        pathname = nextPathname;
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          object: "response",
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "{\"ok\":true}" }],
          }],
          usage: { input_tokens: 35, output_tokens: 8, total_tokens: 43 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  );

  assert.deepEqual(result, { value: { ok: true }, usageTokens: 43, usageEstimated: false });
  assert.equal(pathname, "/responses");
  assert.equal(requestBody.model, "writer");
  assert.equal(requestBody.instructions, "只返回 JSON");
  assert.equal(requestBody.input, "生成正文");
  assert.equal(requestBody.max_output_tokens, 400);
  assert.equal(requestBody.messages, undefined);
  assert.equal(requestBody.temperature, undefined);
});

test("completeJson returns malformed JSON and its parser error to the same model for regeneration", async () => {
  const connection = budgetTestConnection("conn_json_syntax_feedback");
  const requests: Array<Record<string, unknown>> = [];
  const replies = [
    '{"title":"断裂的 JSON","paragraphs":["第一段"]',
    '{"title":"修复完成","paragraphs":["第一段"]}',
  ];
  let calls = 0;

  const result = await completeJson<{ title: string; paragraphs: string[] }>(
    connection,
    connection.routes.writer,
    "你只返回 JSON",
    "生成一个章节对象",
    10_000,
    400,
    {
      secretReader: async () => "test-key",
      modelFetcher: async (_connection, _apiKey, _pathname, init) => {
        requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        const content = replies[calls];
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content } }],
          usage: { total_tokens: calls === 1 ? 11 : 13 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      traceWriter: async () => undefined,
    },
  );

  assert.equal(calls, 2);
  assert.deepEqual(result, {
    value: { title: "修复完成", paragraphs: ["第一段"] },
    usageTokens: 24,
    usageEstimated: false,
  });
  const repairPrompt = (requests[1].messages as Array<{ role: string; content: string }>)[1].content;
  assert.match(repairPrompt, /原始任务上下文[\s\S]*生成一个章节对象/);
  assert.match(repairPrompt, /JSON 解析错误/);
  assert.match(repairPrompt, /断裂的 JSON/);
});

test("completeJson returns missing-field validation issues and the prior JSON for regeneration", async () => {
  const connection = budgetTestConnection("conn_json_schema_feedback");
  const requests: Array<Record<string, unknown>> = [];
  const replies = [
    '{"title":"缺字段"}',
    '{"title":"字段齐全","paragraphs":["第一段"]}',
  ];
  let calls = 0;

  const result = await completeJson<{ title: string; paragraphs: string[] }>(
    connection,
    connection.routes.writer,
    "你只返回 JSON",
    "生成一个章节对象",
    10_000,
    400,
    {
      secretReader: async () => "test-key",
      modelFetcher: async (_connection, _apiKey, _pathname, init) => {
        requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        const content = replies[calls];
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content } }],
          usage: { total_tokens: calls === 1 ? 17 : 19 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      validateJson: (value) => {
        const candidate = value as { paragraphs?: unknown };
        return Array.isArray(candidate?.paragraphs) ? [] : ["paragraphs 必须是数组"];
      },
      traceWriter: async () => undefined,
    },
  );

  assert.equal(calls, 2);
  assert.deepEqual(result, {
    value: { title: "字段齐全", paragraphs: ["第一段"] },
    usageTokens: 36,
    usageEstimated: false,
  });
  const repairPrompt = (requests[1].messages as Array<{ role: string; content: string }>)[1].content;
  assert.match(repairPrompt, /JSON 字段校验错误：paragraphs 必须是数组/);
  assert.match(repairPrompt, /\{"title":"缺字段"\}/);
});

test("chapter generation uses a negotiated Responses API connection through the non-streaming gateway", async () => {
  const connection = budgetTestConnection("conn_responses_chapter");
  connection.capabilities = {
    completionApi: "responses",
    streaming: false,
    jsonSchema: false,
    embedding: false,
    promptCache: false,
    toolCalling: false,
    maxContextTokens: null,
    testedAt: new Date().toISOString(),
    latencyMs: 1,
  };
  const paragraphs = ["第一段发生行动。".repeat(600), "第二段冲突升级。", "第三段付出代价。", "第四段改变局面。"];
  const normalizedParagraphs = paragraphs.map((paragraph) => paragraph.slice(0, 4_000));
  let pathname = "";
  let requestBody: Record<string, unknown> = {};

  const result = await generateChapterWithConnection(
    connection,
    "继续生成下一章",
    2_000,
    async <T>(nextConnection, model, system, prompt, timeout, maxTokens, dependencies) => completeJson<T>(
      nextConnection,
      model,
      system,
      prompt,
      timeout,
      maxTokens,
      {
        ...dependencies,
        secretReader: async () => "test-key",
        modelFetcher: async (_connection, _apiKey, nextPathname, init) => {
          pathname = nextPathname;
          requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({
            object: "response",
            status: "completed",
            output: [{
              type: "message",
              role: "assistant",
              content: [{
                type: "output_text",
                text: JSON.stringify({ title: "局面逆转", paragraphs }),
              }],
            }],
            usage: { input_tokens: 80, output_tokens: 50, total_tokens: 130 },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      },
    ),
  );

  assert.equal(pathname, "/responses");
  assert.equal(requestBody.stream, false);
  assert.deepEqual(result, {
    title: "局面逆转",
    paragraphs: normalizedParagraphs,
    model: "writer",
    origin: "model",
    usageTokens: 130,
    usageEstimated: false,
  });
});

test("completeJson preserves call-local usage for every provider failure shape", async () => {
  const connection: ModelConnection = {
    id: "conn_completion_usage",
    name: "Completion usage",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://completion-usage",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const assertFailureUsage = async (
    response: Response,
    expected: { tokens?: number; estimated: boolean; message: RegExp; redacted?: RegExp },
  ) => {
    await assert.rejects(
      () => completeJson(
        connection,
        "writer",
        "system prompt",
        "user prompt",
        1_000,
        40,
        { secretReader: async () => "test-key", modelFetcher: async () => response.clone() },
      ),
      (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
        assert.match(error.message, expected.message);
        if (expected.redacted) assert.doesNotMatch(error.message, expected.redacted);
        if (expected.tokens === undefined) assert.ok((error.usageTokens ?? 0) >= 40);
        else assert.equal(error.usageTokens, expected.tokens);
        assert.equal(error.usageEstimated, expected.estimated);
        return true;
      },
    );
  };

  await assertFailureUsage(
    new Response(JSON.stringify({ error: { message: "rate limited" }, usage: { total_tokens: 17 } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    }),
    { estimated: true, message: /429/ },
  );
  await assertFailureUsage(
    new Response("upstream unavailable; test-key; sk-provider-leak-123; Authorization: Bearer bearer-secret-123", {
      status: 503,
      headers: { "x-siliconcloud-trace-id": "ti_test_503" },
    }),
    {
      estimated: true,
      message: /503.*upstream unavailable.*ti_test_503/,
      redacted: /test-key|sk-provider-leak-123|bearer-secret-123/,
    },
  );
  await assertFailureUsage(
    new Response("{not-json", { status: 200, headers: { "Content-Type": "application/json" } }),
    { estimated: true, message: /响应不是有效 JSON/ },
  );
  await assertFailureUsage(
    new Response(JSON.stringify({ choices: [{ message: { content: "   " } }], usage: { total_tokens: 23 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    { tokens: 69, estimated: false, message: /没有返回可用内容/ },
  );
  await assertFailureUsage(
    new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }], usage: { total_tokens: 37 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    { tokens: 111, estimated: false, message: /没有返回可解析 JSON/ },
  );
});

test("completeJson retries transient SiliconFlow overloads without changing routes", async () => {
  const connection: ModelConnection = {
    id: "conn_siliconflow_retry",
    name: "SiliconFlow retry",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://api.siliconflow.cn/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://siliconflow-retry",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  let calls = 0;
  let currentTime = 0;
  const delays: number[] = [];
  const overallTimeouts: number[] = [];
  const requiredTokens = estimateModelCallTokenBudget({
    system: "system prompt",
    prompt: "user prompt",
    maxOutputTokens: 40,
  });
  const dependencies = {
    secretReader: async () => "test-key",
    modelFetcher: async (_connection: ModelConnection, _apiKey: string, _pathname: string, _init: RequestInit, _timeout: number, overallTimeout: number) => {
      calls += 1;
      overallTimeouts.push(overallTimeout);
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "System is too busy now. Please try again later." } }), {
          status: 503,
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        usage: { total_tokens: 19 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    retryDelay: async (milliseconds: number) => {
      delays.push(milliseconds);
      currentTime += milliseconds;
    },
    remainingTokens: requiredTokens * 2,
    stage: "测试正文",
    now: () => currentTime,
  } as NonNullable<Parameters<typeof completeJson>[6]> & {
    retryDelay: (milliseconds: number) => Promise<void>;
  };

  const result = await completeJson<{ ok: boolean }>(
    connection,
    connection.routes.writer,
    "system prompt",
    "user prompt",
    10_000,
    40,
    dependencies,
  );

  assert.deepEqual(result, {
    value: { ok: true },
    usageTokens: requiredTokens + 19,
    usageEstimated: true,
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2_000]);
  assert.deepEqual(overallTimeouts, [10_000, 8_000]);
});

test("completeJson refuses a retry that cannot fit in the remaining token budget", async () => {
  const connection: ModelConnection = {
    id: "conn_retry_budget",
    name: "Retry budget",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://retry-budget",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const system = "system prompt";
  const prompt = "user prompt";
  const maxOutputTokens = 40;
  const requiredTokens = estimateModelCallTokenBudget({ system, prompt, maxOutputTokens });
  let calls = 0;

  await assert.rejects(
    () => completeJson(connection, connection.routes.writer, system, prompt, 10_000, maxOutputTokens, {
      secretReader: async () => "test-key",
      modelFetcher: async () => {
        calls += 1;
        return new Response("temporarily unavailable", { status: 503 });
      },
      retryDelay: async () => undefined,
      remainingTokens: requiredTokens * 2 - 1,
      stage: "测试正文",
    }),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.match(error.message, /剩余 Token .*不足以支付测试正文重试/);
      assert.equal(error.usageTokens, requiredTokens);
      assert.equal(error.usageEstimated, true);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("completeJson bounds repeated transient failures to three paid attempts", async () => {
  const connection: ModelConnection = {
    id: "conn_retry_limit",
    name: "Retry limit",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://retry-limit",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const system = "system prompt";
  const prompt = "user prompt";
  const maxOutputTokens = 40;
  const requiredTokens = estimateModelCallTokenBudget({ system, prompt, maxOutputTokens });
  let calls = 0;
  let currentTime = 0;
  const delays: number[] = [];

  await assert.rejects(
    () => completeJson(connection, connection.routes.writer, system, prompt, 30_000, maxOutputTokens, {
      secretReader: async () => "test-key",
      modelFetcher: async () => {
        calls += 1;
        return new Response("temporarily unavailable", { status: 503 });
      },
      retryDelay: async (milliseconds) => {
        delays.push(milliseconds);
        currentTime += milliseconds;
      },
      remainingTokens: requiredTokens * 3,
      stage: "测试正文",
      now: () => currentTime,
    }),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.match(error.message, /503/);
      assert.equal(error.usageTokens, requiredTokens * 3);
      assert.equal(error.usageEstimated, true);
      return true;
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2_000, 5_000]);
});

test("completeJson retries a transient network failure on generic compatible providers", async () => {
  const connection: ModelConnection = {
    id: "conn_network_retry",
    name: "Network retry",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://network-retry",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const system = "system prompt";
  const prompt = "user prompt";
  const maxOutputTokens = 40;
  const requiredTokens = estimateModelCallTokenBudget({ system, prompt, maxOutputTokens });
  let calls = 0;

  const result = await completeJson<{ ok: boolean }>(
    connection,
    connection.routes.writer,
    system,
    prompt,
    10_000,
    maxOutputTokens,
    {
      secretReader: async () => "test-key",
      modelFetcher: async () => {
        calls += 1;
        if (calls === 1) throw new Error("ECONNRESET");
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
          usage: { total_tokens: 19 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      retryDelay: async () => undefined,
      remainingTokens: requiredTokens * 2,
      stage: "测试正文",
    },
  );

  assert.deepEqual(result, {
    value: { ok: true },
    usageTokens: requiredTokens + 19,
    usageEstimated: true,
  });
  assert.equal(calls, 2);
});

test("completeJson retries a transient failure while reading a non-streaming response body", async () => {
  const connection: ModelConnection = {
    id: "conn_body_retry",
    name: "Body retry",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://body-retry",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const system = "system prompt";
  const prompt = "user prompt";
  const maxOutputTokens = 40;
  const requiredTokens = estimateModelCallTokenBudget({ system, prompt, maxOutputTokens });
  let calls = 0;
  const delays: number[] = [];

  const result = await completeJson<{ ok: boolean }>(
    connection,
    connection.routes.writer,
    system,
    prompt,
    10_000,
    maxOutputTokens,
    {
      secretReader: async () => "test-key",
      modelFetcher: async () => {
        calls += 1;
        if (calls === 1) {
          const interruptedBody = new ReadableStream<Uint8Array>({
            start(controller) { controller.error(new Error("terminated")); },
          });
          return new Response(interruptedBody, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
          usage: { total_tokens: 19 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      retryDelay: async (milliseconds) => { delays.push(milliseconds); },
      remainingTokens: requiredTokens * 2,
      stage: "测试正文",
    },
  );

  assert.deepEqual(result, {
    value: { ok: true },
    usageTokens: requiredTokens + 19,
    usageEstimated: true,
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2_000]);
});

test("completeJson recognizes transient Node transport error codes", async () => {
  const connection: ModelConnection = {
    id: "conn_error_code_retry",
    name: "Error code retry",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://error-code-retry",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const system = "system prompt";
  const prompt = "user prompt";
  const maxOutputTokens = 40;
  const requiredTokens = estimateModelCallTokenBudget({ system, prompt, maxOutputTokens });
  let calls = 0;

  const result = await completeJson<{ ok: boolean }>(
    connection,
    connection.routes.writer,
    system,
    prompt,
    10_000,
    maxOutputTokens,
    {
      secretReader: async () => "test-key",
      modelFetcher: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("temporary name service failure"), { code: "EAI_AGAIN" });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
          usage: { total_tokens: 19 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      retryDelay: async () => undefined,
      remainingTokens: requiredTokens * 2,
      stage: "测试正文",
    },
  );

  assert.equal(calls, 2);
  assert.equal(result.usageTokens, requiredTokens + 19);
  assert.equal(result.usageEstimated, true);
});

test("JSON response mode is only reused by routes backed by the tested writer model", async () => {
  const connection: ModelConnection = {
    id: "conn_route_json_capability",
    name: "Route JSON capability",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://route-json-capability",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: {
      streaming: false,
      jsonSchema: true,
      embedding: false,
      promptCache: false,
      toolCalling: false,
      maxContextTokens: null,
      testedAt: new Date().toISOString(),
      latencyMs: 1,
      models: ["planner", "writer", "extractor"],
    },
    updatedAt: new Date().toISOString(),
  };
  const requestBodies: Array<Record<string, unknown>> = [];
  const modelFetcher = async (_connection: ModelConnection, _apiKey: string, _pathname: string, init: RequestInit) => {
    requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "{\"ok\":true}" } }],
      usage: { total_tokens: 5 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await completeJson(connection, "planner", "system", "prompt", 1_000, 20, {
    secretReader: async () => "test-key",
    modelFetcher,
  });
  await completeJson(connection, "writer", "system", "prompt", 1_000, 20, {
    secretReader: async () => "test-key",
    modelFetcher,
  });
  await completeJson(connection, "extractor", "system", "prompt", 1_000, 20, {
    secretReader: async () => "test-key",
    modelFetcher,
  });

  assert.equal(requestBodies[0].response_format, undefined);
  assert.deepEqual(requestBodies[1].response_format, { type: "json_object" });
  assert.equal(requestBodies[2].response_format, undefined);
});

test("SiliconFlow Qwen3 extractor disables thinking and requests concise JSON mode", async () => {
  const streamingConnection = siliconFlowStreamingTestConnection("conn_qwen_json_mode");
  const connection: ModelConnection = {
    ...streamingConnection,
    capabilities: { ...streamingConnection.capabilities!, streaming: false },
  };
  let requestBody: Record<string, unknown> | undefined;

  const result = await completeJson<{ ok: boolean }>(
    connection,
    connection.routes.extractor,
    "只返回 JSON",
    "抽取证据",
    1_000,
    200,
    {
      secretReader: async () => "test-key",
      modelFetcher: async (_connection, _apiKey, _pathname, init) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{\"ok\":true}" } }],
          usage: { total_tokens: 9 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  );

  assert.deepEqual(result, { value: { ok: true }, usageTokens: 9, usageEstimated: false });
  assert.equal(requestBody?.enable_thinking, false);
  assert.equal(requestBody?.temperature, 0.2);
  assert.deepEqual(requestBody?.response_format, { type: "json_object" });
});

test("SiliconFlow structured completions stream long reasoning responses within bounded deadlines", async () => {
  const connection = siliconFlowStreamingTestConnection("conn_siliconflow_streaming_json");
  const frames = [
    { choices: [{ delta: { reasoning_content: "先构造故事规划，但不要把思考混进 JSON。" } }] },
    { choices: [{ delta: { content: "{\"ok\":\"" } }] },
    { choices: [{ delta: { content: "完成\"}" } }] },
    { choices: [], usage: { total_tokens: 321 } },
  ];
  const responseBody = `${frames.map((frame) => `data: ${JSON.stringify(frame)}`).join("\r\n\r\n")}\r\n\r\ndata: [DONE]`;
  let requestBody: Record<string, unknown> | undefined;
  let idleTimeout: number | undefined;
  let overallTimeout: number | undefined;

  const result = await completeJson<{ ok: string }>(
    connection,
    connection.routes.planner,
    "只返回 JSON",
    "生成开篇规划",
    180_000,
    2_600,
    {
      secretReader: async () => "test-key",
      now: () => 0,
      modelFetcher: async (_connection, _apiKey, _pathname, init, timeout, overall) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        idleTimeout = timeout;
        overallTimeout = overall;
        const encoded = new TextEncoder().encode(responseBody);
        const fragmentedBody = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        });
        return new Response(fragmentedBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  );

  assert.deepEqual(result, { value: { ok: "完成" }, usageTokens: 321, usageEstimated: false });
  assert.equal(requestBody?.stream, true);
  assert.equal(idleTimeout, 180_000);
  assert.equal(overallTimeout, 360_000);
});

test("opening planner keeps deep thinking and receives a ten-minute absolute stream deadline", async () => {
  const connection = budgetTestConnection("conn_ark_opening_planner_timeout");
  connection.baseUrl = "https://ark.cn-beijing.volces.com/api/v3";
  connection.routes.planner = "doubao-seed-2-1-turbo-260628";
  connection.capabilities = {
    completionApi: "chat_completions",
    streaming: true,
    jsonSchema: true,
    embedding: false,
    promptCache: false,
    toolCalling: true,
    maxContextTokens: null,
    testedAt: new Date().toISOString(),
    latencyMs: 1,
  };
  let requestBody: Record<string, unknown> | undefined;
  let idleTimeout: number | undefined;
  let overallTimeout: number | undefined;

  await completeJson<{ ok: boolean }>(
    connection,
    connection.routes.planner,
    "只返回 JSON",
    "生成开篇规划",
    180_000,
    2_600,
    {
      overallTimeoutMs: 600_000,
      now: () => 0,
      stage: "开篇规划",
      secretReader: async () => "test-key",
      modelFetcher: async (_connection, _apiKey, _pathname, init, timeout, overall) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        idleTimeout = timeout;
        overallTimeout = overall;
        return new Response([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }] })}`,
          `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 12 } })}`,
          "data: [DONE]",
        ].join("\n\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  );

  assert.equal(requestBody?.max_tokens, 2_600);
  assert.equal(requestBody?.thinking, undefined);
  assert.equal(idleTimeout, 180_000);
  assert.equal(overallTimeout, 600_000);
});

test("OpenAI-compatible long writer completions use negotiated streaming outside SiliconFlow", async () => {
  const connection = budgetTestConnection("conn_ark_long_writer_stream");
  connection.name = "Ark long writer stream";
  connection.baseUrl = "https://ark.cn-beijing.volces.com/api/v3";
  connection.routes = {
    planner: "doubao-seed-2-1-turbo-260628",
    writer: "doubao-seed-2-1-pro-260628",
    extractor: "doubao-seed-character-260628",
    embedding: "doubao-embedding-vision-251215",
  };
  connection.capabilities = {
    completionApi: "chat_completions",
    streaming: true,
    jsonSchema: true,
    embedding: false,
    promptCache: false,
    toolCalling: true,
    maxContextTokens: null,
    testedAt: new Date().toISOString(),
    latencyMs: 44_060,
  };
  const chapter = {
    title: "系统第一次结算",
    paragraphs: Array.from({ length: 18 }, (_, index) => `第${index + 1}段正文。`),
  };
  const responseBody = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(chapter) } }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 932 } })}`,
    "data: [DONE]",
  ].join("\n\n");
  let requestBody: Record<string, unknown> | undefined;
  let idleTimeout: number | undefined;
  let overallTimeout: number | undefined;

  const result = await completeJson<typeof chapter>(
    connection,
    connection.routes.writer,
    "只返回章节 JSON",
    "生成第一章长正文",
    300_000,
    6_500,
    {
      secretReader: async () => "test-key",
      now: () => 1_000,
      retryDelay: async () => undefined,
      modelFetcher: async (_connection, _apiKey, _pathname, init, timeout, overall) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        idleTimeout = timeout;
        overallTimeout = overall;
        if (requestBody.stream !== true) throw new Error("模型连接超时。");
        return new Response(responseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  );

  assert.deepEqual(result, { value: chapter, usageTokens: 932, usageEstimated: false });
  assert.equal(requestBody?.stream, true);
  assert.deepEqual(requestBody?.thinking, { type: "disabled" });
  assert.deepEqual(requestBody?.stream_options, { include_usage: true });
  assert.equal(idleTimeout, 300_000);
  assert.equal(overallTimeout, 1_500_000);

  const sharedPlannerWriterConnection = {
    ...connection,
    routes: { ...connection.routes, planner: connection.routes.writer },
  };
  let plannerRequestBody: Record<string, unknown> | undefined;
  await completeJson<typeof chapter>(
    sharedPlannerWriterConnection,
    sharedPlannerWriterConnection.routes.planner,
    "规划系统",
    "规划开篇",
    180_000,
    6_500,
    {
      stage: "开篇规划",
      secretReader: async () => "test-key",
      modelFetcher: async (_connection, _apiKey, _pathname, init) => {
        plannerRequestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(responseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  );
  assert.equal(plannerRequestBody?.thinking, undefined);

  let candidatePlannerRequestBody: Record<string, unknown> | undefined;
  await completeJson<typeof chapter>(
    sharedPlannerWriterConnection,
    sharedPlannerWriterConnection.routes.planner,
    "候选规划系统",
    "规划下一章候选",
    180_000,
    1_800,
    {
      stage: "候选规划",
      secretReader: async () => "test-key",
      modelFetcher: async (_connection, _apiKey, _pathname, init) => {
        candidatePlannerRequestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(responseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  );
  assert.deepEqual(candidatePlannerRequestBody?.thinking, { type: "disabled" });

  let chapterRequestBody: Record<string, unknown> | undefined;
  let chapterOverallTimeout: number | undefined;
  const streamedChapter = await streamChapterWithConnection(
    connection,
    "生成第二章长正文",
    () => undefined,
    6_500,
    {
      secretReader: async () => "test-key",
      modelFetcher: async (_connection, _apiKey, _pathname, init, _timeout, overall) => {
        chapterRequestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        chapterOverallTimeout = overall;
        return new Response(responseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  );
  assert.equal(streamedChapter.paragraphs.length, 18);
  assert.deepEqual(chapterRequestBody?.thinking, { type: "disabled" });
  assert.deepEqual(chapterRequestBody?.stream_options, { include_usage: true });
  assert.equal(chapterOverallTimeout, 1_500_000);
});

test("SiliconFlow retries a transient aborted structured stream and accounts for both attempts", async () => {
  const connection = siliconFlowStreamingTestConnection("conn_siliconflow_stream_retry");
  let calls = 0;
  const delays: number[] = [];
  const requiredTokens = estimateModelCallTokenBudget({
    system: "system prompt",
    prompt: "user prompt",
    maxOutputTokens: 6_500,
  });
  const successBody = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "{\"ok\":true}" } }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 23 } })}`,
    "data: [DONE]",
  ].join("\n\n");
  const dependencies = {
    secretReader: async () => "test-key",
    modelFetcher: async () => {
      calls += 1;
      if (calls === 1) {
        const abortedBody = new ReadableStream<Uint8Array>({
          start(controller) { controller.error(new Error("aborted")); },
        });
        return new Response(abortedBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(successBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    retryDelay: async (milliseconds: number) => { delays.push(milliseconds); },
    remainingTokens: requiredTokens * 2,
    stage: "测试正文",
  };

  const result = await completeJson<{ ok: boolean }>(
    connection,
    connection.routes.writer,
    "system prompt",
    "user prompt",
    300_000,
    6_500,
    dependencies,
  );

  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.usageTokens, requiredTokens + 23);
  assert.equal(result.usageEstimated, true);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2_000]);
});

test("SiliconFlow structured streams cancel malformed input and enforce the UTF-8 byte cap", async () => {
  const connection = siliconFlowStreamingTestConnection("conn_siliconflow_stream_safety");
  let cancelled = false;
  const malformedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {not-json}\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    () => completeJson(connection, connection.routes.planner, "system", "prompt", 180_000, 2_600, {
      secretReader: async () => "test-key",
      modelFetcher: async () => new Response(malformedBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    }),
    /流式响应无效/,
  );
  assert.equal(cancelled, true);

  const oversizedContent = JSON.stringify({ value: "汉".repeat(333_334) });
  const oversizedFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: oversizedContent } }] })}\n\n`;
  await assert.rejects(
    () => completeJson(connection, connection.routes.planner, "system", "prompt", 180_000, 2_600, {
      secretReader: async () => "test-key",
      modelFetcher: async () => new Response(oversizedFrame, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    }),
    /1 MB/,
  );

  const unterminatedFrame = `data: ${"x".repeat(4_000_001)}`;
  await assert.rejects(
    () => completeJson(connection, connection.routes.planner, "system", "prompt", 180_000, 2_600, {
      secretReader: async () => "test-key",
      modelFetcher: async () => new Response(unterminatedFrame, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    }),
    /未完成帧超过 4 MB/,
  );
});

test("a paid chapter completion retains usage when its schema is rejected", async () => {
  const connection: ModelConnection = {
    id: "conn_chapter_schema_usage",
    name: "Chapter schema usage",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://chapter-schema-usage",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };

  await assert.rejects(
    () => generateChapterWithConnection(connection, "prompt", 2_000, async <T>() => ({
      value: { title: "too short", paragraphs: [] } as T,
      usageTokens: 731,
      usageEstimated: false,
    })),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.match(error.message, /Schema/);
      assert.equal(error.usageTokens, 731);
      assert.equal(error.usageEstimated, false);
      return true;
    },
  );
});

test("a paid candidate completion retains usage when too few candidates are returned", async () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖" }, "user_test");
  const connection: ModelConnection = {
    id: "conn_candidate_schema_usage",
    name: "Candidate schema usage",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://candidate-schema-usage",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };

  await assert.rejects(
    () => generateCandidateDraftsWithConnection(connection, story, async <T>() => ({
      value: { candidates: [] } as T,
      usageTokens: 617,
      usageEstimated: false,
    })),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.match(error.message, /至少 3 个/);
      assert.equal(error.usageTokens, 617);
      assert.equal(error.usageEstimated, false);
      return true;
    },
  );
});

test("candidate generation adds planner usage when its independent audit call fails", async () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖" }, "user_test");
  const connection: ModelConnection = {
    id: "conn_candidate_audit_usage",
    name: "Candidate audit usage",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://candidate-audit-usage",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const candidate = {
    creativeAxis: "目标压力",
    event: "主角必须立刻作出选择",
    cause: "资源窗口即将关闭",
    cost: "失去原有安排",
    impact: "关系与资源同时改变",
    novelty: "同一选择影响两个目标",
    participantNames: [],
    storyTime: "当天",
    dependsOnEventIds: [],
    knowledgeClaims: [],
    itemTransitions: [{
      itemName: "会员等级",
      actorName: "主角",
      fromStatus: "未解锁",
      toStatus: "永久生效",
    }],
  };
  let calls = 0;

  await assert.rejects(
    () => generateCandidateDraftsWithConnection(connection, story, async <T>() => {
      calls += 1;
      if (calls === 1) {
        return { value: { candidates: [candidate, candidate, candidate] } as T, usageTokens: 100, usageEstimated: false };
      }
      throw attachModelUsage(new Error("audit transport failed"), 200, false);
    }),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.equal(error.usageTokens, 300);
      assert.equal(error.usageEstimated, false);
      return true;
    },
  );
});

test("candidate audit supplements planner claims only from the canonical knowledge ledger", async () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖" }, "user_test");
  const lead = story.characters[0]!;
  const canonicalFact = "旧仓库的东门只在午夜开放";
  lead.knowledge.push(canonicalFact);
  lead.knowledgeSources.push({ fact: canonicalFact, sourceChapter: 1, sourceRevisionId: "rev_canonical_fact" });
  const candidate = {
    creativeAxis: "时间窗口",
    event: `${lead.name}赶往旧仓库东门`,
    cause: "午夜将至",
    cost: "暴露行踪",
    impact: "行动窗口被锁定",
    novelty: "用既有时限推动现场选择",
    participantNames: [lead.name],
    storyTime: "当天午夜",
    dependsOnEventIds: [],
    knowledgeClaims: [],
    itemTransitions: [],
  };
  let calls = 0;
  const result = await generateCandidateDraftsWithConnection(
    budgetTestConnection("conn_candidate_audit_supplement"),
    story,
    async <T>() => {
      calls += 1;
      if (calls === 1) {
        return { value: { candidates: [candidate, candidate, candidate] } as T, usageTokens: 100, usageEstimated: false };
      }
      return {
        value: {
          audits: Array.from({ length: 3 }, (_, candidateIndex) => ({
            candidateIndex,
            complete: candidateIndex !== 1,
            dependencies: [{ characterName: lead.name, fact: canonicalFact }],
          })),
        } as T,
        usageTokens: 100,
        usageEstimated: false,
      };
    },
  );

  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0].knowledgeClaims, [{
    characterName: lead.name,
    fact: canonicalFact,
    sourceRevisionId: "rev_canonical_fact",
  }]);
});

test("a paid state-extraction completion retains usage when its schema is rejected", async () => {
  const connection: ModelConnection = {
    id: "conn_extract_schema_usage",
    name: "Extract schema usage",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://extract-schema-usage",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };

  await assert.rejects(
    () => extractChapterStateWithConnection(connection, {
      title: "chapter",
      paragraphs: ["one", "two", "three", "four"],
      model: "writer",
    }, undefined, undefined, async <T>() => ({
      value: { events: null, characterUpdates: [] } as T,
      usageTokens: 421,
      usageEstimated: false,
    })),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.match(error.message, /Schema/);
      assert.equal(error.usageTokens, 421);
      assert.equal(error.usageEstimated, false);
      return true;
    },
  );
});

test("streaming continuation writers use the selected tier timeout with one output limit", async () => {
  const connection = siliconFlowStreamingTestConnection("conn_stream_tier_timeout");
  const content = JSON.stringify({ title: "chapter", paragraphs: ["one", "two", "three", "four"] });
  const responseBody = `data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { total_tokens: 80 } })}\n\ndata: [DONE]\n\n`;
  const observed: Array<{ timeout: number; overallTimeout: number; maxTokens: number }> = [];

  for (const tier of CONTINUATION_GENERATION_TIERS) {
    await streamChapterWithConnection(
      connection,
      "prompt",
      () => undefined,
      6_500,
      {
        secretReader: async () => "test-key",
        modelFetcher: async (_connection, _apiKey, _pathname, init, timeout, overallTimeout) => {
          const body = JSON.parse(String(init.body)) as { max_tokens: number };
          observed.push({ timeout, overallTimeout, maxTokens: body.max_tokens });
          return new Response(responseBody, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        },
      },
      tier.cumulativeTokenBudget,
      tier.writerIdleTimeoutMs,
    );
  }

  assert.deepEqual(observed, [
    { timeout: 300_000, overallTimeout: 1_500_000, maxTokens: 6_500 },
    { timeout: 480_000, overallTimeout: 2_400_000, maxTokens: 6_500 },
    { timeout: 720_000, overallTimeout: 3_600_000, maxTokens: 6_500 },
  ]);
});

test("streaming ignores non-positive provider usage and falls back to a positive estimate", async () => {
  const connection = siliconFlowStreamingTestConnection("conn_stream_usage");
  const content = JSON.stringify({ title: "chapter", paragraphs: ["one", "two", "three", "four"] });
  const responseBody = `data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { total_tokens: -500 } })}\n\ndata: [DONE]\n\n`;
  let observedStreamTimeout: number | undefined;
  let observedStreamOverallTimeout: number | undefined;

  const result = await streamChapterWithConnection(connection, "prompt", () => undefined, 6_500, {
    secretReader: async () => "test-key",
    modelFetcher: async (_connection, _apiKey, _pathname, _init, timeout, overallTimeout) => {
      observedStreamTimeout = timeout;
      observedStreamOverallTimeout = overallTimeout;
      return new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  assert.ok(result.usageTokens && result.usageTokens > 0);
  assert.equal(result.usageEstimated, true);
  assert.equal(observedStreamTimeout, 300_000);
  assert.equal(observedStreamOverallTimeout, 1_500_000);

  await assert.rejects(
    () => streamChapterWithConnection(connection, "prompt", () => undefined, 2_000, {
      secretReader: async () => "test-key",
      modelFetcher: async () => new Response("writer overloaded", {
        status: 503,
        headers: { "x-siliconcloud-trace-id": "ti_writer_503" },
      }),
    }),
    /503.*writer overloaded.*ti_writer_503/,
  );

  await assert.rejects(
    () => streamChapterWithConnection(connection, "prompt", () => undefined, 2_000, {
      secretReader: async () => "test-key",
      modelFetcher: async () => new Response("data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"title\\\":\\\"cut off\\\"\"}}]}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    }),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.match(error.message, /Schema|中断/);
      assert.ok((error.usageTokens ?? 0) >= 2_000);
      assert.equal(error.usageEstimated, true);
      return true;
    },
  );
});

test("streaming emits paragraphs before a byte-fragmented CRLF response closes", async () => {
  const connection = siliconFlowStreamingTestConnection("conn_stream_crlf_fragments");
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const responseBody = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const emittedParagraphs: string[] = [];
  const completion = streamChapterWithConnection(
    connection,
    "prompt",
    (paragraph) => emittedParagraphs.push(paragraph),
    6_500,
    {
      secretReader: async () => "test-key",
      modelFetcher: async () => new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    },
  );
  const chapterPayload = JSON.stringify({
    title: "第一章 流式边界",
    paragraphs: ["第一段。", "第二段。", "第三段。", "第四段。"],
  });
  const firstFrame = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: chapterPayload } }] })}\r\n\r\n`,
  );
  for (const byte of firstFrame) streamController.enqueue(Uint8Array.of(byte));
  for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const emittedBeforeClose = emittedParagraphs.length;

  streamController.enqueue(new TextEncoder().encode("data: [DONE]\r\n\r\n"));
  streamController.close();
  const result = await completion;

  assert.equal(emittedBeforeClose, 4);
  assert.deepEqual(result.paragraphs, ["第一段。", "第二段。", "第三段。", "第四段。"]);
});

test("continuation fallback with only 500 tokens remaining starts neither planner nor audit", async () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖" }, "user_test");
  const connection = budgetTestConnection("conn_fallback_budget");
  let calls = 0;

  await assert.rejects(
    () => generateCandidateDraftsWithConnection(connection, story, async <T>() => {
      calls += 1;
      return { value: { candidates: [] } as T, usageTokens: 1, usageEstimated: false };
    }, 500),
    /剩余 Token.*规划.*未启动/,
  );
  assert.equal(calls, 0);
});

test("candidate audit is admitted separately after the paid planner call", async () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖" }, "user_test");
  const connection = budgetTestConnection("conn_candidate_audit_budget");
  const tokenBudget = 20_000;
  const plannerUsage = 19_500;
  const candidate = {
    creativeAxis: "目标压力",
    event: "主角必须立刻作出选择",
    cause: "资源窗口即将关闭",
    cost: "失去原有安排",
    impact: "关系与资源同时改变",
    novelty: "同一选择影响两个目标",
    participantNames: [],
    storyTime: "当天",
    dependsOnEventIds: [],
    knowledgeClaims: [],
    itemTransitions: [],
  };
  let calls = 0;

  await assert.rejects(
    () => generateCandidateDraftsWithConnection(connection, story, async <T>() => {
      calls += 1;
      return {
        value: { candidates: [candidate, candidate, candidate] } as T,
        usageTokens: plannerUsage,
        usageEstimated: false,
      };
    }, tokenBudget),
    (error: Error & { usageTokens?: number }) => {
      assert.match(error.message, /剩余 Token.*审计.*未启动/);
      assert.equal(error.usageTokens, plannerUsage);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("chapter writers admit the full system and chapter prompt before a paid call", async () => {
  const connection = budgetTestConnection("conn_writer_budget");
  const prompt = "章节提示";
  const oldPromptOnlyBudget = Math.ceil(prompt.length / 2) + 2_000;
  let calls = 0;

  await assert.rejects(
    () => generateChapterWithConnection(connection, prompt, 2_000, async <T>() => {
      calls += 1;
      return { value: {} as T, usageTokens: 1, usageEstimated: false };
    }, oldPromptOnlyBudget),
    /剩余 Token.*正文.*未启动/,
  );
  assert.equal(calls, 0);
});

test("streaming writer admission happens before secret lookup and transport", async () => {
  const connection = budgetTestConnection("conn_stream_writer_budget");
  const prompt = "流式章节提示";
  const oldPromptOnlyBudget = Math.ceil(prompt.length / 2) + 2_000;
  let secretReads = 0;
  let fetches = 0;

  await assert.rejects(
    () => streamChapterWithConnection(connection, prompt, () => undefined, 2_000, {
      secretReader: async () => {
        secretReads += 1;
        return "test-key";
      },
      modelFetcher: async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      },
    }, oldPromptOnlyBudget),
    /剩余 Token.*正文.*未启动/,
  );
  assert.equal(secretReads, 0);
  assert.equal(fetches, 0);
});

test("extractor admission includes reading-experience and terminal contracts", async () => {
  const story = createStory({ genre: "都市", tone: "系统 · 无敌" }, "user_test");
  const connection = budgetTestConnection("conn_extractor_budget");
  const chapter = {
    title: "第二章",
    paragraphs: ["主角当场完成行动。", "对手承认失败。", "奖励已经到账。", "世界状态随即改变。"],
    model: "writer",
  };
  let calls = 0;
  const complete = async <T>() => {
    calls += 1;
    return {
      value: { events: [], characterUpdates: [], itemUpdates: [] } as T,
      usageTokens: 100,
      usageEstimated: false,
    };
  };

  await extractChapterStateWithConnection(connection, chapter, undefined, undefined, complete, 2_100);
  assert.equal(calls, 1, "the compact extraction request should fit the control budget");

  const secondChapterRequirement = story.readingExperience.openingRequirements.find((requirement) => requirement.chapterOffset === 1)!;
  const hardExperienceAxes = story.readingExperience.axes.filter((axis) =>
    !readingExperienceAxisUsesSoftWindow(story.readingExperience, axis.id)
  );
  const softExperienceAxis = story.readingExperience.axes.find((axis) =>
    readingExperienceAxisUsesSoftWindow(story.readingExperience, axis.id))!;
  let secondChapterExtractorSystem = "";
  await extractChapterStateWithConnection(
    connection,
    chapter,
    undefined,
    story.readingExperience,
    async <T>(_connection, _model, system) => {
      secondChapterExtractorSystem = system;
      return {
        value: {
          events: [],
          characterUpdates: [],
          itemUpdates: [],
          experienceEvidence: hardExperienceAxes.map((axis) => ({
            axisId: axis.id,
            word: axis.word,
            signalIds: secondChapterRequirement.requiredSignalIds.filter((signalId) => axis.observableSignals.some((signal) => signal.id === signalId)),
            quote: "正文中的连续原句证据",
          })),
          experienceDelivery: [{ axisId: softExperienceAxis.id, state: "no_conflict" }],
        } as T,
        usageTokens: 100,
        usageEstimated: false,
      };
    },
    CONTINUATION_JOB_TOKEN_BUDGET,
    2,
  );
  for (const axis of hardExperienceAxes) {
    const requiredForAxis = secondChapterRequirement.requiredSignalIds.filter((signalId) => axis.observableSignals.some((signal) => signal.id === signalId));
    assert.ok(secondChapterExtractorSystem.includes(`"signalIds":${JSON.stringify(requiredForAxis)}`));
  }
  assert.match(secondChapterExtractorSystem, /experienceDelivery/);
  assert.ok(secondChapterExtractorSystem.includes(softExperienceAxis.id));
  assert.match(secondChapterExtractorSystem, /no_conflict.*open_parity.*dominant_victory.*conclusive_defeat/);
  assert.match(secondChapterExtractorSystem, /当前是第 2 章/);

  const longText = "必须由主角行动与结果直接兑现".repeat(300);
  const richExperience = {
    ...story.readingExperience,
    axes: story.readingExperience.axes.map((axis) => ({
      ...axis,
      interpretation: `${axis.interpretation}${longText}`,
    })) as typeof story.readingExperience.axes,
  };
  const richEnding = {
    ...story.endingContract,
    targetEnding: `${story.endingContract.targetEnding}${longText}`,
  };
  await assert.rejects(
    () => extractChapterStateWithConnection(connection, chapter, richEnding, richExperience, complete, 2_000),
    /剩余 Token.*抽取.*未启动/,
  );
  assert.equal(calls, 1, "contract-rich request must be rejected before a second paid call");
});

test("a real seed continuation budget admits planner, audit, writer, and extractor", async () => {
  const store = createSeedStore();
  const story = structuredClone(store.stories.find((item) => item.id === "story_black_tide")!);
  const connection = budgetTestConnection("conn_real_seed_pipeline_budget");
  const candidate = {
    creativeAxis: "潮门秩序",
    event: "林夏当众截断黑潮侵入通道",
    cause: "潮门封锁即将失效",
    cost: "旧有身份被更多人看见",
    impact: "港口秩序与盟友立场同时改变",
    novelty: "把封锁危机转为公开站队",
    participantNames: [],
    storyTime: "当夜",
    dependsOnEventIds: [],
    knowledgeClaims: [],
    itemTransitions: [],
  };
  let pipelineCalls = 0;
  const stageTimeouts: Array<{ model: string; timeout: number | undefined }> = [];
  const candidates = await generateCandidateDraftsWithConnection(connection, story, async <T>(_connection, model, _system, _prompt, timeout) => {
    pipelineCalls += 1;
    stageTimeouts.push({ model, timeout });
    if (model === connection.routes.planner) {
      return {
        value: { candidates: Array.from({ length: 5 }, (_, index) => ({ ...candidate, creativeAxis: `${candidate.creativeAxis}${index}` })) } as T,
        usageTokens: 500,
        usageEstimated: false,
      };
    }
    return {
      value: { audits: Array.from({ length: 5 }, (_, candidateIndex) => ({ candidateIndex, complete: true, dependencies: [] })) } as T,
      usageTokens: 300,
      usageEstimated: false,
    };
  }, CONTINUATION_JOB_TOKEN_BUDGET);
  const plan = planNextChapter(story);
  const prompt = buildChapterPrompt(story, plan);
  const writerInput = estimateChapterWriterInputTokenBudget(prompt, false);
  const writerMaxTokens = Math.min(
    6_500,
    CONTINUATION_JOB_TOKEN_BUDGET - candidates.usageTokens - writerInput - CHAPTER_EXTRACTION_ADMISSION_RESERVE,
  );
  assert.ok(writerMaxTokens >= 2_000, `real seed writer allowance was only ${writerMaxTokens}`);
  const admittedChapter = await generateChapterWithConnection(connection, prompt, writerMaxTokens, async <T>(_connection, model, _system, _prompt, timeout) => {
    pipelineCalls += 1;
    stageTimeouts.push({ model, timeout });
    return {
      value: { title: "第2章 潮门断流", paragraphs: ["行动落地。", "局势改变。", "众人回应。", "代价显现。"] } as T,
      usageTokens: 500,
      usageEstimated: false,
    };
  }, CONTINUATION_JOB_TOKEN_BUDGET - candidates.usageTokens);
  assert.equal(admittedChapter.title, "潮门断流");
  const representativeChapter = generateLocalChapter(story, plan);
  await extractChapterStateWithConnection(
    connection,
    representativeChapter,
    undefined,
    story.readingExperience,
    async <T>(_connection, model, _system, _prompt, timeout) => {
      pipelineCalls += 1;
      stageTimeouts.push({ model, timeout });
      return {
        value: { events: [], characterUpdates: [], itemUpdates: [], experienceEvidence: [] } as T,
        usageTokens: 400,
        usageEstimated: false,
      };
    },
    CHAPTER_EXTRACTION_ADMISSION_RESERVE,
  );
  assert.equal(pipelineCalls, 4);
  assert.deepEqual(stageTimeouts, [
    { model: connection.routes.planner, timeout: 180_000 },
    { model: connection.routes.extractor, timeout: 120_000 },
    { model: connection.routes.writer, timeout: 300_000 },
    { model: connection.routes.extractor, timeout: 120_000 },
  ]);
});

test("non-streaming continuation writers use tier timeouts without growing output tokens", async () => {
  const connection = budgetTestConnection("conn_non_stream_tier_timeout");
  const observed: Array<{ timeout: number | undefined; maxTokens: number | undefined; remainingTokens: number | undefined }> = [];

  for (const tier of CONTINUATION_GENERATION_TIERS) {
    await generateChapterWithConnection(
      connection,
      "prompt",
      5_800,
      async <T>(_connection, _model, _system, _prompt, timeout, maxTokens, dependencies) => {
        observed.push({
          timeout,
          maxTokens,
          remainingTokens: dependencies?.remainingTokens,
        });
        return {
          value: { title: "第2章 潮门断流", paragraphs: ["行动。", "变化。", "回应。", "代价。"] } as T,
          usageTokens: 500,
          usageEstimated: false,
        };
      },
      tier.cumulativeTokenBudget,
      tier.writerIdleTimeoutMs,
    );
  }

  assert.deepEqual(observed, CONTINUATION_GENERATION_TIERS.map((tier) => ({
    timeout: tier.writerIdleTimeoutMs,
    maxTokens: 5_800,
    remainingTokens: tier.cumulativeTokenBudget,
  })));
});

test("opening planner admission uses its full request before the first completer call", async () => {
  const { context, connection } = openingBudgetFixture();
  let calls = 0;

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async () => {
      calls += 1;
      return { value: {}, usageTokens: 1, usageEstimated: false };
    }, 100),
    /剩余 Token.*开篇规划.*未启动/,
  );
  assert.equal(calls, 0);
});

test("opening writer admission includes model-refined custom axes", async () => {
  const { context, connection, plan } = openingBudgetFixture();
  let calls = 0;

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async () => {
      calls += 1;
      return { value: plan, usageTokens: 100, usageEstimated: false };
    }, 12_000),
    (error: Error & { usageTokens?: number }) => {
      assert.match(error.message, /剩余 Token.*开篇正文.*未启动/);
      assert.equal(error.usageTokens, 100);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("opening retry is re-admitted with its failure-specific prompt", async () => {
  const { context, connection, plan } = openingBudgetFixture();
  let calls = 0;

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async ({ model }) => {
      calls += 1;
      if (model === "planner") return { value: plan, usageTokens: 100, usageEstimated: false };
      return {
        value: { title: "第一章", paragraphs: Array.from({ length: 16 }, () => "机械臂动了。") },
        usageTokens: 4_000,
        usageEstimated: false,
      };
    }, 16_000),
    (error: Error & { usageTokens?: number }) => {
      assert.match(error.message, /剩余 Token.*开篇正文.*未启动/);
      assert.equal(error.usageTokens, 4_100);
      return true;
    },
  );
  assert.equal(calls, 2, "planner and first draft are paid; retry is not started");
});

test("opening reviewer is admitted after actual planner and writer usage", async () => {
  const { context, connection, plan, paragraph } = openingBudgetFixture();
  let calls = 0;

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async ({ model }) => {
      calls += 1;
      if (model === "planner") return { value: plan, usageTokens: 100, usageEstimated: false };
      return {
        value: { title: "第一章 修好的机械臂", paragraphs: Array.from({ length: 16 }, () => paragraph) },
        usageTokens: 8_500,
        usageEstimated: false,
      };
    }, 20_000),
    (error: Error & { usageTokens?: number }) => {
      assert.match(error.message, /剩余 Token.*开篇审稿.*未启动/);
      assert.equal(error.usageTokens, 8_600);
      return true;
    },
  );
  assert.equal(calls, 2, "reviewer must not start after planner and writer consume its allowance");
});

test("opening usage adds failed writer and reviewer calls to successful prior calls", async () => {
  const base = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test");
  const connection: ModelConnection = {
    id: "conn_opening_usage_aggregation",
    name: "Opening usage aggregation",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://opening-usage-aggregation",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner-route", writer: "writer-route", extractor: "reviewer-route", embedding: "embedding-route" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  const plan = {
    title: base.title,
    subtitle: base.subtitle,
    leadName: base.characters[0].name,
    storyGene: base.storyGene,
    endingContract: base.endingContract,
    worldBible: base.worldBible,
    experienceAxes: base.readingExperience.axes.map((axis) => ({
      word: axis.word,
      interpretation: axis.interpretation,
      observableSignals: axis.observableSignals.map((signal) => signal.description),
      hardPromises: axis.hardPromises.map((promise) => promise.description),
      forbiddenShortcuts: axis.forbiddenShortcuts,
    })),
    openingBeats: ["机械行动立即改变冲突", "父女选择改变现场关系"],
  };
  const paragraph = "机械臂完成精确校准后稳稳托住奶瓶，周砺俯身听清女儿说出的需要，再用当场完成的维修结果挡住逼近的威胁。父女共同作出的选择改变了维修铺门前的冲突，围观者随即收起武器并重新调整立场，资源和关系都留下了明确变化。".repeat(2);
  const context = {
    input: { genre: "都市", tone: "机械 · 奶爸" },
    contract: base.readingExperience,
    targetChapterCount: base.targetChapterCount,
  };

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async ({ model }) => {
      if (model === "planner-route") return { value: plan, usageTokens: 100, usageEstimated: false };
      throw attachModelUsage(new Error("writer transport failed"), 200, false);
    }),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.equal(error.usageTokens, 300);
      assert.equal(error.usageEstimated, false);
      return true;
    },
  );

  await assert.rejects(
    () => generateStoryOpeningWithConnection(context, connection, async ({ model }) => {
      if (model === "planner-route") return { value: plan, usageTokens: 100, usageEstimated: false };
      if (model === "writer-route") return {
        value: { title: "第一章 修好的机械臂", paragraphs: Array.from({ length: 16 }, () => paragraph) },
        usageTokens: 200,
        usageEstimated: false,
      };
      throw attachModelUsage(new Error("reviewer invalid JSON"), 300, false);
    }),
    (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
      assert.equal(error.usageTokens, 1_100);
      assert.equal(error.usageEstimated, false);
      return true;
    },
  );
});

test("new-story model options expose routes without connection secrets", () => {
  const store = createSeedStore();
  const user = store.users[0];
  const options = listGenerationModelOptions(store, user);

  assert.ok(options.length > 0);
  assert.ok(options.some((option) => option.isDefault));
  assert.doesNotMatch(JSON.stringify(options), /secretRef|maskedKey|baseUrl|apiKey/);
});

test("opening admission reserves the full opening token budget", () => {
  const recentJob = {
    id: "job_recent",
    ownerId: "user_budget",
    storyId: "another_story",
    storyTitle: "Existing work",
    chapterNumber: 2,
    task: "chapter" as const,
    model: "writer",
    connectionId: "conn",
    promptVersion: "v1",
    status: "completed" as const,
    tokens: 100_000,
    latencyMs: 1,
    cost: 0,
    createdAt: new Date().toISOString(),
  };

  assert.doesNotThrow(() => assertGenerationTokenBudget({
    jobs: [recentJob],
    userId: "user_budget",
    storyId: "opening_user_budget",
    requestedBudget: 12_000,
    defaultRunningBudget: 12_000,
    userLimit: 120_000,
    storyLimit: 60_000,
  }));
  assert.throws(() => assertGenerationTokenBudget({
    jobs: [recentJob],
    userId: "user_budget",
    storyId: "opening_user_budget",
    requestedBudget: 30_000,
    defaultRunningBudget: 12_000,
    userLimit: 120_000,
    storyLimit: 60_000,
  }), /预算上限/);
});

test("failed opening usage is charged to the failed job", () => {
  const job: GenerationJob = {
    id: "job_failed_opening",
    ownerId: "user_budget",
    storyId: "opening_user_budget",
    storyTitle: "Failed opening",
    chapterNumber: 1,
    task: "opening" as const,
    model: "writer",
    connectionId: "conn",
    promptVersion: "opening-v1",
    status: "running" as const,
    tokens: 0,
    latencyMs: 1,
    cost: 0,
    createdAt: new Date().toISOString(),
  };
  const failure = attachModelUsage(new Error("质量门禁失败"), 18_500, false);

  recordFailedJobUsage(job, failure, { tokens: 0, estimated: true, costPerMillion: 1.2 });

  assert.equal(job.tokens, 18_500);
  assert.equal(job.usageEstimated, false);
  assert.equal(job.cost, 0.0222);
});

test("failed pipeline usage is added to successful calls consumed before the failure", () => {
  const failure = attachModelUsage(new Error("writer failed"), 6_500, true);

  assert.deepEqual(
    accumulateModelUsage({ tokens: 2_300, estimated: false }, failure),
    { tokens: 8_800, estimated: true },
  );
});

test("the second system-and-invincible chapter preserves the system and dominant payoff", () => {
  const story = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test");
  const generated = generateLocalChapter(story, planNextChapter(story));
  const text = generated.paragraphs.join("\n");

  assert.match(text, /系统(?:面板|提示|奖励|任务|权限|状态)/);
  assert.match(text, /(?:碾压|横推|一击|绝对差距|压倒性)/);
  assert.doesNotMatch(text, /(?:封印|失去|削弱).{0,12}(?:能力|修为|系统)|五五开|救场/);
});

test("chapter plans enforce novel-sized prose instead of paragraph-count padding", () => {
  const story = structuredClone(createSeedStore().stories[0]);
  const compact = planNextChapter(story, undefined, "compact");
  const standard = planNextChapter(story, undefined, "standard");
  const immersive = planNextChapter(story, undefined, "immersive");

  assert.ok(compact.targetCharacters < standard.targetCharacters);
  assert.ok(standard.targetCharacters < immersive.targetCharacters);
  assert.ok(standard.targetCharacters >= 2_400);
  assert.ok(standard.minCharacters <= 1_900, "standard chapters should accept concise complete output from compatible providers");

  for (const plan of [compact, standard, immersive]) {
    const generated = generateLocalChapter(story, plan);
    const characterCount = generated.paragraphs.join("").replace(/\s/g, "").length;
    assert.ok(characterCount >= plan.minCharacters);
    assert.doesNotThrow(() => validateGeneratedChapter(story, generated, plan));
  }
  const detailed = generateLocalChapter(story, standard);
  detailed.paragraphs[0] += "风从长街尽头卷来，门窗依次震响，众人仍守在原地确认每一步变化。".repeat(220);
  const detailedCharacterCount = detailed.paragraphs.join("").replace(/\s/g, "").length;
  assert.ok(detailedCharacterCount > standard.targetCharacters * 2);
  assert.doesNotThrow(
    () => validateGeneratedChapter(story, detailed, standard),
    "a complete chapter may naturally exceed the Writer target",
  );
  assert.throws(
    () => validateGeneratedChapter(story, {
      title: "被填空的短章",
      paragraphs: Array.from({ length: standard.targetParagraphs }, (_, index) => `第 ${index + 1} 段。`),
      model: "test",
    }, standard),
    (error: unknown) => {
      assert.ok(error instanceof ChapterEditorialValidationError);
      assert.match(error.message, /最低/);
      assert.equal(error.editorialIssues[0]?.code, "chapter_too_short");
      return true;
    },
  );
});

test("local chapter prose never leaks author-facing chapter metadata", () => {
  const story = createStory({
    genre: "玄幻",
    tone: "系统 · 无敌",
    inspiration: "少年绑定系统后横推宗门",
  }, "user_test");
  const generated = generateLocalChapter(story, planNextChapter(story));

  assert.doesNotMatch(
    generated.paragraphs.join("\n"),
    /上一章|下一章|前后两章|跨过许多章节|一部长篇|角色弧|人物弧|后续故事|开篇时|本卷|卷首|结局契约|终局核验|结局前置条件|预设大纲/,
  );
});

test("chapter validation blocks author-facing narration before publication", () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖" }, "user_test");
  const plan = planNextChapter(story);
  const generated = generateLocalChapter(story, plan);
  generated.paragraphs[0] = `上一章留下的记忆重新浮上来。${generated.paragraphs[0]}`;

  assert.throws(
    () => validateGeneratedChapter(story, generated, plan),
    /元叙事|沉浸感/,
  );
});

test("immersive narration validation also covers titles and common recap phrasing", () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖" }, "user_test");
  const plan = planNextChapter(story);

  const recapTitle = generateLocalChapter(story, plan);
  recapTitle.title = "上一回留下的余波";
  assert.throws(() => validateGeneratedChapter(story, recapTitle, plan), /元叙事|沉浸感/);

  const plotRecap = generateLocalChapter(story, plan);
  plotRecap.paragraphs[0] = `剧情发展到这里，${plotRecap.paragraphs[0]}`;
  assert.throws(() => validateGeneratedChapter(story, plotRecap, plan), /元叙事|沉浸感/);

  for (const authorFacingLine of [
    "按照大纲，主角将在这里进入下一场戏。",
    "作为小说的主角，他知道这一节必须结束。",
    "叙事需要他此时回忆之前发生的事。",
    "前一章留下的记忆重新浮上来。",
    "上一节留下的记忆重新浮上来。",
    "前一幕留下的记忆重新浮上来。",
    "后一章会揭晓答案。",
    "这一章的记忆重新浮上来。",
    "小说中的主角忽然明白了。",
    "人物弧与结局前置条件都将在终局核验时完成。",
    "第一章讲述了主角的觉醒。",
    "第1章讲述了主角的觉醒。",
    "本书的主角终于登场。",
    "作者在这里安排了一次巧合。",
    "预设大纲要求他此刻转身。",
    "此前剧情里的记忆重新浮上来。",
    "先前情节留下的记忆重新浮上来。",
    "前面的故事留下的记忆重新浮上来。",
    "上回书说到，林越刚刚抵达山门。",
    "欲知后事如何，且看下回分解。",
    "前几章留下的记忆重新浮上来。",
    "前两章留下的记忆重新浮上来。",
    "过去三章发生的事重新浮上来。",
    "第一章，林越还很弱。",
    "第2章，主角终于觉醒。",
    "在第十章之后，他将获得系统。",
    "这一段剧情结束以后，他终于松了口气。",
    "前面的桥段让他记忆犹新。",
    "上一节发生的事情重新浮上心头。",
    "前一幕发生的一切让他久久难忘。",
    "上一节的经历让他握紧了拳头。",
    "前一幕的遭遇仍在影响他。",
    "上一话发生的事情重新浮现。",
    "上章的记忆重新浮上来。",
    "第一章 系统觉醒\n林越醒来。",
    "第1章 系统觉醒",
    "第十章 归来",
    "上一幕剧情里的画面重新在他脑中浮现。",
    "上一节的内容让他再次握紧拳头。",
    "前一话的往事仍在影响着他。",
  ]) {
    assert.throws(() => assertImmersiveNarration(authorFacingLine), /元数据|沉浸感/);
  }
  assert.throws(
    () => assertImmersiveNarration("本书的主角终于登场。"),
    /命中作者侧叙事原句.*本书的主角/,
  );
  assert.doesNotThrow(() => assertImmersiveNarration("他从书架取下小说，翻到夹着书签的一页。"));
  assert.doesNotThrow(() => assertImmersiveNarration("她把试卷夹进错题本对应的圆锥曲线章节。"));
  assert.doesNotThrow(() => assertImmersiveNarration("拿一本书就留一颗糖，这几本书里还夹着便签。"));
  assert.doesNotThrow(() => assertImmersiveNarration("上一场比赛失利以后，他在下一场比赛开局便抢回球权。"));
  assert.doesNotThrow(() => assertImmersiveNarration("本场必须结束连败，他盯着记分牌握紧了拳头。"));
  assert.doesNotThrow(() => assertImmersiveNarration("这一回合结束以后，他收剑后退。"));
});

test("reading-experience validation rejects pasted scenery and curated negative shortcuts", () => {
  const systemStory = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test");
  const systemContract = systemStory.readingExperience;
  const systemContent = "系统拒绝结算已经获得的奖励，宿主只能与对手战成五五开。系统面板仍显示任务，主角一击结束了冲突。";
  const systemEvidence = [
    { axisId: "primary" as const, word: "系统", signalIds: [systemContract.axes[0].observableSignals[0].id], quote: "系统面板仍显示任务" },
    { axisId: "secondary" as const, word: "无敌", signalIds: [systemContract.axes[1].observableSignals[0].id], quote: "主角一击结束了冲突" },
  ];
  assert.throws(
    () => assertReadingExperienceEvidence(systemContract, systemContent, systemEvidence, { protagonistNames: ["主角"] }),
    /系统|无敌|捷径|承诺/,
  );
  assert.throws(
    () => assertReadingExperienceNegativeInvariants(
      systemContract,
      JSON.stringify({ recurringCost: "主角的能力会在冲突中被封印" }),
      { protagonistNames: ["主角"] },
    ),
    /无敌|封印|削弱/,
  );
  assert.doesNotThrow(() => assertReadingExperienceNegativeInvariants(
    systemContract,
    JSON.stringify({ recurringCost: "系统不会故障，主角的能力不会被封印或削弱，只会扩大需要保护的范围" }),
    { protagonistNames: ["主角"] },
  ));
  assert.throws(() => assertReadingExperienceNegativeInvariants(
    systemContract,
    "系统面板发放永久奖励以后彻底崩溃，再也无法启动。主角一击镇压敌人。",
    { protagonistNames: ["主角"] },
  ), /系统|持续可用|承诺/);
  assert.doesNotThrow(() => assertReadingExperienceNegativeInvariants(
    systemContract,
    "系统不会崩溃，也不会宕机或停止响应，永久奖励持续生效。主角一击镇压敌人。",
    { protagonistNames: ["主角"] },
  ));
  for (const unusableSystem of [
    "系统面板提示所有功能已被锁死，全部奖励均被冻结，宿主只能看不能用。主角抬手一击镇压敌人。",
    "系统面板发放奖励后与主角永久解绑，从此彻底关闭并消失。主角抬手一击镇压敌人。",
    "主角的系统面板发放永久奖励，但如今权限一概不可使用，所有任务都无法领取。主角抬手一击镇压敌人。",
    "主角的系统面板发放永久奖励后已经报废，只剩一行装饰文字。主角抬手一击镇压敌人。",
    "主角的系统面板发放奖励后解除绑定，所有功能随即归零。主角抬手一击镇压敌人。",
    "主角的系统面板发放永久奖励并保持运行。下一刻，奖励与权限全部作废，任何功能都不能使用。主角抬手一击镇压敌人。",
    "主角的系统面板发放奖励并绑定主角。它随即彻底报废，从此不再响应。主角抬手一击镇压敌人。",
    "主角打开系统面板领取奖励。随后这些功能一概失效，再也无法操作。主角抬手一击镇压敌人。",
    "主角打开系统面板领取永久奖励；随后权限全部作废，功能也无法使用。主角抬手一击镇压敌人。",
    "主角打开系统面板领取永久奖励。系统突然死机，再也打不开。主角抬手一击镇压敌人。",
    "主角打开系统面板领取永久奖励。系统卡死，面板再也点不动。主角抬手一击镇压敌人。",
    "主角打开系统面板领取永久奖励。系统与主角断开连接，再也无法登录。主角抬手一击镇压敌人。",
    "主角打开系统面板领取永久奖励。系统忽然停摆，所有按钮都点不了。主角抬手一击镇压敌人。",
    "主角打开系统面板领取永久奖励。系统彻底罢工，再也不会给出反馈。主角抬手一击镇压敌人。",
  ]) {
    assert.throws(() => assertReadingExperienceNegativeInvariants(
      systemContract,
      unusableSystem,
      { protagonistNames: ["主角"] },
    ), /系统|持续可用|可操作|奖励/);
  }
  assert.doesNotThrow(() => assertReadingExperienceNegativeInvariants(
    systemContract,
    "主角的系统面板不会失效，也不会报废。下一刻，这些权限仍然生效，所有功能都可以正常使用。主角抬手一击镇压敌人。",
    { protagonistNames: ["主角"] },
  ));
  for (const affirmedSystemAvailability of [
    "系统所有功能并未锁死，全部奖励也没有被冻结，宿主可以正常领取。主角抬手一击镇压敌人。",
    "系统的故障记录已经清除，所有功能正常。主角抬手一击镇压敌人。",
    "系统报废程序已经被永久删除，今后不会失效。主角抬手一击镇压敌人。",
    "系统从休眠中苏醒，奖励与权限立即恢复可用。主角抬手一击镇压敌人。",
    "系统不会故障、失灵、离线或崩溃，权限永久可用。主角抬手一击镇压敌人。",
    "系统能够在离线模式下正常使用。主角抬手一击镇压敌人。",
    "系统免于崩溃，所有功能始终稳定。主角抬手一击镇压敌人。",
    "系统的故障自检已完成，所有权限继续生效。主角抬手一击镇压敌人。",
  ]) {
    assert.doesNotThrow(() => assertReadingExperienceNegativeInvariants(
      systemContract,
      affirmedSystemAvailability,
      { protagonistNames: ["主角"] },
    ));
  }
  assert.throws(() => assertReadingExperienceNegativeInvariants(
    systemContract,
    "系统面板没有任何奖励或权限，主角也找不到可操作项。主角一击镇压敌人。",
    { protagonistNames: ["主角"] },
  ), /系统|可操作|持续可用/);
  const earlyContent = "系统面板立刻绑定主角并发放永久奖励，主角依据奖励选择目标。主角一击镇压敌人，全场强者无人敢反抗。";
  assert.throws(() => assertReadingExperienceEvidence(systemContract, earlyContent, [
    { axisId: "primary", word: "系统", signalIds: [systemContract.axes[0].observableSignals[0].id], quote: "系统面板立刻绑定主角并发放永久奖励" },
    { axisId: "secondary", word: "无敌", signalIds: [systemContract.axes[1].observableSignals[0].id], quote: "主角一击镇压敌人，全场强者无人敢反抗" },
  ], { protagonistNames: ["主角"], opening: true, chapterNumber: 1 }), /开篇|必需信号/);
  const lateSystemContent = `${"主角沿着山路前行，暂时没有任何异常发生。".repeat(35)}系统面板在主角眼前终于激活并发放永久奖励，主角一击结束所有冲突。`;
  assert.throws(
    () => assertReadingExperienceEvidence(systemContract, lateSystemContent, [
      { axisId: "primary", word: "系统", signalIds: systemContract.axes[0].observableSignals.slice(0, 2).map((signal) => signal.id), quote: "系统面板在主角眼前终于激活并发放永久奖励" },
      { axisId: "secondary", word: "无敌", signalIds: systemContract.axes[1].observableSignals.slice(0, 2).map((signal) => signal.id), quote: "主角一击结束所有冲突" },
    ], { protagonistNames: ["主角"], opening: true }),
    /15%|开篇/,
  );

  const arbitraryContract = createStory({ genre: "科幻", tone: "机械 · 奶爸" }, "user_test").readingExperience;
  const pastedContent = "机械 · 奶爸的天光慢慢落下来，人物随后采取行动并让冲突结果发生变化。";
  const pastedEvidence = arbitraryContract.axes.map((axis) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [axis.observableSignals[0].id],
    quote: "人物随后采取行动并让冲突结果发生变化",
  }));
  assert.throws(
    () => assertReadingExperienceEvidence(arbitraryContract, pastedContent, pastedEvidence),
    /景物|天光|感觉词/,
  );
});

test("paraphrased system and invincible evidence is grounded in exact validated prose", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const content = "系统面板立刻绑定主角并发放永久奖励，主角依据奖励选择目标。主角一击镇压敌人，全场强者无人敢反抗。";
  const grounded = groundReadingExperienceEvidence(contract, content, [
    {
      axisId: "primary",
      word: "系统",
      signalIds: contract.axes[0].observableSignals.slice(0, 2).map((signal) => signal.id),
      quote: "系统已经选中主角，并把永久奖励交给了他",
    },
    {
      axisId: "secondary",
      word: "无敌",
      signalIds: contract.axes[1].observableSignals.slice(0, 2).map((signal) => signal.id),
      quote: "主角轻易打败强敌，所有旁观者都不敢反抗",
    },
  ], { protagonistNames: ["主角"], opening: true, chapterNumber: 1 });

  assert.deepEqual(grounded.map((item) => item.quote), [
    "系统面板立刻绑定主角并发放永久奖励",
    "主角一击镇压敌人",
  ]);
  assert.doesNotThrow(() => assertReadingExperienceEvidence(
    contract,
    content,
    grounded,
    { protagonistNames: ["主角"], opening: true, chapterNumber: 1 },
  ));
});

test("grounding can preserve an exact adjacent-sentence victory span inside a long paragraph", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const systemQuote = "林峰打开系统面板，领取永久奖励并确认能力已经生效";
  const victorySpan = "林峰面对来敌只抬了抬手。那名强者便被镇压在地，毫无还手之力。";
  const longAftermath = "围观者退到街边，商铺重新开门，原本堵住路口的人群也恢复了通行秩序。".repeat(12);
  const content = `${systemQuote}。\n${victorySpan}${longAftermath}`;
  const grounded = groundReadingExperienceEvidence(contract, content, [
    {
      axisId: "primary",
      word: "系统",
      signalIds: contract.axes[0].observableSignals.slice(0, 2).map((signal) => signal.id),
      quote: systemQuote,
    },
    {
      axisId: "secondary",
      word: "无敌",
      signalIds: contract.axes[1].observableSignals.slice(0, 2).map((signal) => signal.id),
      quote: "林峰抬手便让强者彻底失去反抗能力",
    },
  ], { protagonistNames: ["林峰"], chapterNumber: 1 });

  assert.equal(grounded[1].quote, victorySpan);
  assert.doesNotThrow(() => assertReadingExperienceEvidence(
    contract,
    content,
    grounded,
    { protagonistNames: ["林峰"], chapterNumber: 1 },
  ));
});

test("grounding recognizes a natural named-opponent victory instead of keeping a paraphrased audit quote", () => {
  const contract = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const systemQuote = "陆玄点下系统签到按钮，永久功法奖励立即到账并开始运转";
  const victoryQuote = "围观弟子亲眼看见陆玄一掌把周嵩打退，周嵩连抬头对视的勇气都没有";
  const content = `${systemQuote}。${victoryQuote}。`;
  const grounded = groundReadingExperienceEvidence(contract, content, [
    {
      axisId: "primary",
      word: "系统",
      signalIds: [contract.axes[0].observableSignals[1].id],
      quote: systemQuote,
    },
    {
      axisId: "secondary",
      word: "无敌",
      signalIds: [contract.axes[1].observableSignals[2].id],
      quote: "陆玄只用一掌便将执法长老击退，对方不敢反抗",
    },
  ], { protagonistNames: ["陆玄"] });

  assert.match(grounded[1].quote, /陆玄一掌把周嵩打退/);
  assert.equal(content.includes(grounded[1].quote), true);

  const objectOnly = `${systemQuote}。陆玄一掌把房门击退三丈，门板撞在墙上裂开。`;
  const objectGrounded = groundReadingExperienceEvidence(contract, objectOnly, [
    grounded[0],
    {
      ...grounded[1],
      quote: "陆玄一掌击退强敌，对方不敢反抗",
    },
  ], { protagonistNames: ["陆玄"] });
  assert.equal(objectOnly.includes(objectGrounded[1].quote), false);
});

test("segmented protagonist system interaction is accepted without crediting another character's system", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 明快" }, "user_test").readingExperience;
  const protagonistInteraction = "林峰抬眼，半透明系统面板在他眼前展开。面板提示签到成功，新手奖励十万年修为已经到账。他点击领取，修为永久生效。";
  assert.doesNotThrow(() => assertReadingExperienceContent(
    contract,
    protagonistInteraction,
    { protagonistNames: ["林峰"], opening: true, chapterNumber: 1 },
  ));

  const villainInteraction = "反派赵无极打开系统面板。面板提示签到成功，新手奖励十万年修为已经到账。林峰站在远处看见了这一切。";
  assert.throws(() => assertReadingExperienceContent(
    contract,
    villainInteraction,
    { protagonistNames: ["林峰"], opening: true, chapterNumber: 1 },
  ), /系统|主角|宿主|可操作/);
});

test("natural viewpoint modifiers remain attached to the named protagonist's system", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 明快" }, "user_test").readingExperience;
  for (const protagonistInteraction of [
    "苏尘心念一动打开签到面板，系统瞬间发放绝对领域永久能力，他立刻点击领取。",
    "苏尘在意识模糊间瞥见一道半透明光幕浮在眼前，上面赫然写着每日签到系统已激活，他本能地默念签到，光幕瞬间弹出签到成功、获得永久能力的提示，苏尘想也没想便点击领取。",
  ]) {
    assert.doesNotThrow(() => assertReadingExperienceContent(
      contract,
      protagonistInteraction,
      { protagonistNames: ["苏尘"], opening: true, chapterNumber: 1 },
    ));
  }
});

test("a protagonist's inner invocation remains attached to their system interaction", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 明快" }, "user_test").readingExperience;
  for (const interaction of [
    "林辰心中默念打开面板，眼前浮现签到系统界面并提示签到成功、永久能力已经发放，他点击领取并立即调用。",
    "林辰念动间打开系统面板，签到成功的提示与永久功法奖励一同弹出，他立即点击领取。",
    "林辰伸手点开面板的同时系统提示音响起并发放永久功法奖励，林辰毫不犹豫点击领取。",
    "脑海中响起提示：【签到系统激活，是否签到？】林辰念动间打开系统面板，系统发放永久功法奖励，他立即点击领取。",
    "眼前面板显示：\"签到系统激活，是否签到？\"林辰伸手点开面板，系统发放永久功法奖励，他立即点击领取。",
  ]) {
    assert.doesNotThrow(() => assertReadingExperienceContent(
      contract,
      interaction,
      { protagonistNames: ["林辰"], opening: true, chapterNumber: 1 },
    ));
  }

  assert.throws(() => assertReadingExperienceContent(
    contract,
    "林辰让师兄打开系统面板，系统向师兄发放永久功法奖励，师兄点击领取。",
    { protagonistNames: ["林辰"], opening: true, chapterNumber: 1 },
  ), /系统|主角|宿主|可操作/);
});

test("a named protagonist in the previous sentence anchors a natural pronoun system interaction", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 明快" }, "user_test").readingExperience;
  const protagonistInteraction = "林辰倒在硬板床上，盯着天花板，第五次面试被拒的烦躁堵在胸口。他习惯性默念系统，眼前立刻浮现金色面板并显示系统绑定完成、新手礼包永久能力已发放，他随即点击领取。";
  assert.doesNotThrow(() => assertReadingExperienceContent(
    contract,
    protagonistInteraction,
    { protagonistNames: ["林辰"], opening: true, chapterNumber: 1 },
  ));

  const unrelatedInteraction = "反派赵无极倒在硬板床上，盯着天花板。他习惯性默念系统，眼前立刻浮现金色面板并显示系统绑定完成、新手礼包永久能力已发放，他随即点击领取。";
  assert.throws(() => assertReadingExperienceContent(
    contract,
    unrelatedInteraction,
    { protagonistNames: ["林辰"], opening: true, chapterNumber: 1 },
  ), /系统|主角|宿主|可操作/);
});

test("the opening system interaction grants a durable payoff that the protagonist actually uses", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 明快" }, "user_test").readingExperience;
  const context = { protagonistNames: ["林辰"], opening: true, chapterNumber: 1 };

  for (const emptyInteraction of [
    "林辰打开系统面板，面板显示今日任务是前往城南，他点击确认后关闭界面。",
    "林辰唤出系统面板查看当前状态，面板列出姓名、年龄和待办任务，他随后收起面板。",
    "系统提示林辰完成任务后可以获得永久功法，林辰接受任务，但奖励尚未发放。",
    "林辰打开系统面板，面板显示永久功法将在明日发放，他点击确认后关闭界面。",
    "林辰打开系统面板，系统向同伴发放永久能力，同伴点击领取并立即调用。",
    "林辰打开系统面板，系统向同伴发放永久能力，点击领取并立即调用。",
    "林辰打开系统面板，系统立即发放只能维持一分钟的临时能力奖励。林辰点击领取并立即使用。",
    "林辰打开系统面板，系统立即发放并非永久的领域能力。林辰点击领取并立即调用。",
    "林辰打开系统面板，系统说明这不是一项永久领域能力，却仍立即发放。林辰点击领取并立即调用。",
  ]) {
    assert.throws(
      () => assertReadingExperienceContent(contract, emptyInteraction, context),
      /前 15%|奖励|能力|领取|调用|使用/,
    );
  }

  assert.doesNotThrow(() => assertReadingExperienceContent(
    contract,
    "林辰打开系统面板，系统立即发放永久功法奖励。林辰点击领取，随即运转功法震开门锁。",
    context,
  ));
  assert.doesNotThrow(() => assertReadingExperienceContent(
    contract,
    "林辰打开系统面板，系统立即发放一次性新手礼包，礼包内含永久领域能力。林辰点击领取，随即调用领域能力震开门锁。",
    context,
  ));
});

test("grounding replaces an exact but semantically incomplete system quote", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const content = "苏尘打开系统面板，系统显示永久能力已经发放，苏尘点击领取并立即调用。苏尘抬手一拳击败怪物，对方毫无还手之力。围观者当场退开让路。";
  const incompleteQuote = "系统显示永久能力已经发放";
  const grounded = groundReadingExperienceEvidence(contract, content, [
    {
      axisId: "primary",
      word: "系统",
      signalIds: contract.axes[0].observableSignals.slice(0, 2).map((signal) => signal.id),
      quote: incompleteQuote,
    },
    {
      axisId: "secondary",
      word: "无敌",
      signalIds: contract.axes[1].observableSignals.slice(0, 2).map((signal) => signal.id),
      quote: "苏尘抬手一拳击败怪物，对方毫无还手之力",
    },
  ], { protagonistNames: ["苏尘"], opening: true, chapterNumber: 1 });

  assert.notEqual(grounded[0].quote, incompleteQuote);
  assert.doesNotThrow(() => assertReadingExperienceEvidence(
    contract,
    content,
    grounded,
    { protagonistNames: ["苏尘"], opening: true, chapterNumber: 1 },
  ));
});

test("a system panel may report a defeated opponent's disabled cultivation without failing system availability", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const content = [
    "林峰打开系统面板，系统立即发放诸天镇压永久权限奖励，林峰点击领取并直接调用。",
    "林峰抬手一指点出，来犯的黑煞宗长老李玄通浑身灵力瞬间溃散，当场跪地无法反抗。",
    "系统面板浮现李玄通的信息——修为：凝脉境巅峰（已被镇压，失效），法宝：黑煞旗（已被镇压，失效），目标解除前无法恢复。",
  ].join("\n");

  assert.doesNotThrow(() => assertReadingExperienceContent(
    contract,
    content,
    { protagonistNames: ["林峰"], opening: true, chapterNumber: 1 },
  ));
});

test("cross-sentence victory cannot be credited to the protagonist when a helper supplies the force", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const delegatedVictory = "林峰打开系统面板，领取永久奖励并确认能力已经生效。林峰抬手整理衣袖。那名强者便被护卫镇压在地，毫无还手之力。";
  assert.throws(() => assertReadingExperienceContent(
    contract,
    delegatedVictory,
    { protagonistNames: ["林峰"], chapterNumber: 1 },
  ), /无敌|主角|压倒性胜利/);
});

test("dominant victory accepts natural monster-disintegration and observed-opponent phrasing", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test").readingExperience;
  for (const victory of [
    "林夜抬手一握，领域内所有怪物被无形力场碾成碎末，毫无反抗余地",
    "林夜抬手虚握，那甲虫连同刀臂被无形力场碾成黑灰，毫无反抗余地",
    "林夜看着来势汹汹的长老，随手一挥，那名长老便倒飞百丈，落地再也爬不起来",
    "林夜一拳轰出——拳劲炸开肉眼可见的白色气浪，怪物胸腔被贯穿出一个脸盆大的窟窿，黑血喷溅中它毫无反抗之力地碎裂成一地肉块",
    "林夜抬手一挥，两名特工便倒飞出去砸在车上，两人当场失去行动能力无法反抗",
    "林夜抬手一击拍飞匕首，纵火者向后跌飞撞在垃圾箱上，当场昏迷毫无还手之力",
    "林夜单手压下，漩涡将鳞甲巨兽和数十只变异怪物瞬间吞没，巨兽毫无还手之力便化为虚无",
    "林夜转身抬手，吞噬漩涡一击打出，三只变异犬毫无还手之力便被吞没",
  ]) {
    const content = `林夜打开系统面板，系统立即发放永久奖励，林夜点击领取并直接调用。${victory}。\n围观者当场低头让路。`;
    assert.doesNotThrow(() => assertReadingExperienceContent(
      contract,
      content,
      { protagonistNames: ["林夜"], opening: true, chapterNumber: 1 },
    ));
  }
});

test("an opening victory reaction remains a quality target instead of a soft-window publication gate", () => {
  const contract = createStory({ genre: "系统流", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const context = { protagonistNames: ["林夜"], opening: true, chapterNumber: 1 };
  const systemPayoff = "林夜打开系统面板，系统立即发放永久领域能力，林夜点击领取并直接调用。";
  const victory = "林夜抬手一拳击败宗门长老，对方当场倒地不起。";
  const filler = Array.from({ length: 80 }, () => "林夜沿着演武场边缘检查石阶，周围弟子各自忙碌。 ").join("");
  const publishable = [
    systemPayoff + "\n" + victory,
    systemPayoff + "\n" + victory + "\n山风卷过空荡的演武场。\n围观弟子终于低头让路。",
    systemPayoff + "\n" + victory + "\n围观弟子计划明日低头让路，但此刻仍没有任何人行动。",
    systemPayoff + "\n" + victory + "\n围观弟子没有震惊，也没有退开让路。",
    systemPayoff + "\n" + filler + "\n" + victory + "\n围观弟子当场低头让路。",
    systemPayoff + "\n" + victory + "\n围观弟子当场低头让路，宗门随即撤销了对林夜的禁令。",
  ];
  for (const content of publishable) {
    assert.doesNotThrow(() => assertReadingExperienceContent(contract, content, context));
  }
  assert.equal(
    classifyReadingExperienceDelivery(contract, publishable[0], context)[0]?.state,
    "dominant_victory",
  );
});

test("soft-window invincible chapters allow setup and temporary parity without a per-chapter victory", () => {
  const contract = createStory({ genre: "玄幻", tone: "无敌 · 系统" }, "user_test").readingExperience;
  const context = { protagonistNames: ["林策"], chapterNumber: 3 };
  const systemProgress = "林策打开系统面板，点击领取永久生效的宗门资源调度权限，并立即调用它重新分配药材。";

  assert.doesNotThrow(() => assertReadingExperienceContent(
    contract,
    `${systemProgress}\n林策在议事堂核对三位长老留下的旧账，决定先从资源流向追查幕后联盟。`,
    context,
  ));
  assert.doesNotThrow(() => assertReadingExperienceContent(
    contract,
    `${systemProgress}\n林策与执法长老暂时势均力敌，双方都没有分出胜负，系统任务仍在推进。`,
    context,
  ));
});

test("soft-window invincible evidence may be absent while explicit final defeat remains blocked", () => {
  const contract = createStory({ genre: "玄幻", tone: "无敌 · 系统" }, "user_test").readingExperience;
  const systemAxis = contract.axes.find((axis) => axis.word === "系统")!;
  const content = "林策打开系统面板，领取永久资源权限并立即调用。林策开始核对宗门旧账，本章没有发生正面对抗。";
  const evidence = [{
    axisId: systemAxis.id,
    word: systemAxis.word,
    signalIds: [systemAxis.observableSignals[0].id],
    quote: "林策打开系统面板，领取永久资源权限并立即调用",
  }];

  assert.doesNotThrow(() => assertReadingExperienceEvidence(
    contract,
    content,
    evidence,
    { protagonistNames: ["林策"], chapterNumber: 3 },
  ));
  assert.throws(() => assertReadingExperienceContent(
    contract,
    `${content}\n林策最终向执法长老投降认输，交出了全部权限。`,
    { protagonistNames: ["林策"], chapterNumber: 3 },
  ), /投降|认输|落败|无敌/);
});

test("ambiguous semantic defeat claims degrade to soft cadence instead of becoming a publication gate", () => {
  const contract = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const softAxis = contract.axes.find((axis) =>
    readingExperienceAxisUsesSoftWindow(contract, axis.id))!;
  const context = { protagonistNames: ["林策"], chapterNumber: 3 };
  const temporaryPressure = "林策被执法长老一掌逼退，肩头受伤，但双方仍在重新调整位置。";
  const explicitDefeat = "林策最终向执法长老投降认输，交出了手里的令牌。";

  assert.equal(classifyReadingExperienceDelivery(contract, temporaryPressure, context, [{
    axisId: softAxis.id,
    state: "conclusive_defeat",
    sourceQuote: temporaryPressure,
  }])[0]?.state, "no_conflict");
  assert.equal(classifyReadingExperienceDelivery(contract, explicitDefeat, context, [{
    axisId: softAxis.id,
    state: "conclusive_defeat",
    sourceQuote: explicitDefeat,
  }])[0]?.state, "conclusive_defeat");

  assert.deepEqual(normalizeChapterEditorialIssues(contract, temporaryPressure, [{
    code: "explicit_protagonist_defeat",
    axisId: softAxis.id,
    axisWord: softAxis.word,
    signalIds: [],
    location: "chapter",
    sourceQuote: temporaryPressure,
    reason: "审稿器把暂时受伤误判成了最终落败。",
    requestedChange: "要求整章重写。",
  }]), []);
});

test("soft-window cadence ledger opens debt without blocking and resets idempotently after victory", () => {
  const contract = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const softAxis = contract.axes.find((axis) =>
    readingExperienceAxisUsesSoftWindow(contract, axis.id))!;

  const legacyBaseline = normalizeReadingExperienceDeliveryLedger(contract, undefined, 12);
  assert.deepEqual(legacyBaseline, [{
    axisId: softAxis.id,
    lastEvaluatedChapter: 12,
    silentChapters: 0,
    debtOpen: false,
  }]);

  let ledger = updateReadingExperienceDeliveryLedger(contract, undefined, 1, [
    { axisId: softAxis.id, state: "dominant_victory", sourceQuote: "林策抬手击溃来犯长老，对方当场失去反抗能力" },
  ]);
  assert.equal(ledger[0].lastDeliveredChapter, 1);
  assert.equal(ledger[0].silentChapters, 0);

  ledger = updateReadingExperienceDeliveryLedger(contract, ledger, 2, [
    { axisId: softAxis.id, state: "open_parity", sourceQuote: "林策与执法长老暂时势均力敌，双方都没有分出胜负" },
  ]);
  assert.equal(ledger[0].silentChapters, 1);
  assert.equal(ledger[0].openConflictSinceChapter, 2);
  assert.equal(readingExperienceCadenceState(contract, ledger, 3)[0].status, "due");

  ledger = updateReadingExperienceDeliveryLedger(contract, ledger, 3, [
    { axisId: softAxis.id, state: "no_conflict" },
  ]);
  assert.equal(ledger[0].silentChapters, 2);
  assert.equal(ledger[0].debtOpen, false);

  const beforeDebt = ledger.map((entry) => ({ ...entry }));
  ledger = updateReadingExperienceDeliveryLedger(contract, ledger, 4, [
    { axisId: softAxis.id, state: "no_conflict", sourceQuote: "绝密正文原句不得进入长期观测" },
  ]);
  assert.equal(ledger[0].silentChapters, 3);
  assert.equal(ledger[0].debtOpen, true);
  assert.equal(readingExperienceCadenceState(contract, ledger, 5)[0].status, "debt");
  assert.match(formatReadingExperienceCadenceForPrompt(contract, ledger, 5), /体验债务已打开.*不是发布门禁/);

  const cadenceEvents = readingExperienceCadenceAuditEvents(contract, beforeDebt, ledger, [
    { axisId: softAxis.id, state: "no_conflict", sourceQuote: "绝密正文原句不得进入长期观测" },
  ]);
  assert.deepEqual(cadenceEvents.map((event) => event.code), [
    "experience_cadence_silent",
    "experience_debt_opened",
  ]);
  assert.doesNotMatch(JSON.stringify(cadenceEvents), /绝密正文原句/);

  const repeated = updateReadingExperienceDeliveryLedger(contract, ledger, 4, [
    { axisId: softAxis.id, state: "dominant_victory", sourceQuote: "重复提交不应改写账本" },
  ]);
  assert.deepEqual(repeated, ledger);

  ledger = updateReadingExperienceDeliveryLedger(contract, ledger, 5, [
    { axisId: softAxis.id, state: "dominant_victory", sourceQuote: "林策完成系统任务后击溃长老，对方当场认输" },
  ]);
  assert.equal(ledger[0].lastDeliveredChapter, 5);
  assert.equal(ledger[0].silentChapters, 0);
  assert.equal(ledger[0].debtOpen, false);
  assert.equal(ledger[0].openConflictSinceChapter, undefined);
});

test("committing a chapter persists its soft delivery observation and advances the ledger once", () => {
  const story = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test");
  const plan = planNextChapter(story);
  const generated = generateLocalChapter(story, plan);
  const chapter = commitNextChapter(story, plan, generated);
  const revision = currentRevision(chapter);
  const softAxis = story.readingExperience.axes.find((axis) =>
    readingExperienceAxisUsesSoftWindow(story.readingExperience, axis.id))!;
  const ledger = story.readingExperienceDeliveryLedger?.find((entry) => entry.axisId === softAxis.id);

  assert.equal(revision.experienceDelivery?.[0]?.axisId, softAxis.id);
  assert.equal(ledger?.lastEvaluatedChapter, chapter.number);
  const repeated = updateReadingExperienceDeliveryLedger(
    story.readingExperience,
    story.readingExperienceDeliveryLedger,
    chapter.number,
    revision.experienceDelivery,
  );
  assert.deepEqual(repeated, story.readingExperienceDeliveryLedger);
});

test("soft-window invincible validation allows missing victories but blocks final defeat and delegated wins", () => {
  const contract = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const content = "主角的系统面板发放永久奖励并保持运行。敌人只用一击就击败了主角，主角倒地不起。";
  const evidence = [
    {
      axisId: "primary" as const,
      word: "系统",
      signalIds: [contract.axes[0].observableSignals[0].id],
      quote: "主角的系统面板发放永久奖励并保持运行",
    },
    {
      axisId: "secondary" as const,
      word: "无敌",
      signalIds: [contract.axes[1].observableSignals[0].id],
      quote: "敌人只用一击就击败了主角，主角倒地不起",
    },
  ];

  assert.throws(
    () => assertReadingExperienceEvidence(contract, content, evidence, { protagonistNames: ["主角"] }),
    (error) => {
      assert.ok(error instanceof ChapterEditorialValidationError);
      const issue = error.editorialIssues.find((candidate) =>
        candidate.code === "explicit_protagonist_defeat");
      assert.ok(issue?.sourceQuote);
      assert.ok(content.includes(issue.sourceQuote));
      return true;
    },
  );

  const systemEvidence = {
    axisId: "primary" as const,
    word: "系统",
    signalIds: [contract.axes[0].observableSignals[0].id],
    quote: "主角的系统面板发放永久奖励并保持运行",
  };
  const validateSoftChapter = (scene: string) => assertReadingExperienceEvidence(contract,
    "主角的系统面板发放永久奖励并保持运行。" + scene + "。",
    [
      systemEvidence,
      {
        axisId: "secondary",
        word: "无敌",
        signalIds: [contract.axes[1].observableSignals[0].id],
        quote: scene,
      },
    ],
    { protagonistNames: ["主角"] },
  );

  for (const publishableWithoutVictory of [
    "主角对敌人扬言自己会击败所有人，但战斗还没有开始",
    "敌人看着主角，主角无法反抗",
    "主角林越看着敌人一招击败宗门长老",
    "主角没能一击击败敌人，反而被对手逼退",
    "主角在幻觉里一击镇压敌人，清醒后对手毫发无损",
    "主角本可以一击击败敌人，但他没有出手",
    "主角一击并未击败敌人，反被对手轰飞",
    "主角一击击败敌人的画面只是系统模拟",
  ]) {
    assert.doesNotThrow(() => validateSoftChapter(publishableWithoutVictory));
  }

  for (const blockedFinalResult of [
    "主角在梦中一击镇压敌人，醒来便向现实中的对手投降",
    "主角差点一击击败敌人，最终却只能逃走",
    "主角看着同伴抬手一击镇压敌人，全场无人能够反抗",
    "主角命令护卫一掌轰飞对手，对方毫无还手之力",
    "主角躲在师父身后，只见师父一剑斩杀强者",
    "主角请来高手，那名高手弹指镇压敌人",
    "主角命令兄长一掌镇压敌人，全场无人能够反抗",
    "主角让师兄抬手一击轰飞对手，对方毫无还手之力",
    "主角躲在父亲身后，只见父亲一剑斩杀强者",
  ]) {
    assert.throws(
      () => validateSoftChapter(blockedFinalResult),
      (error) => error instanceof ChapterEditorialValidationError &&
        error.editorialIssues.some((issue) => issue.code === "explicit_protagonist_defeat"),
    );
  }

  for (const temporaryPressure of [
    "主角与强敌大战三百回合才勉强取胜",
    "主角被敌人一拳打成重伤",
  ]) {
    assert.doesNotThrow(() => validateSoftChapter(temporaryPressure));
  }
  for (const chapterWithEarlierDefeat of [
    "主角被真正的对手连打十拳，口吐鲜血，只能狼狈逃走",
    "主角被对手打得吐血，险些丧命，好友出手将他救走",
    "主角跪在对手面前，请求对方放自己一条生路",
    "主角面对强敌毫无办法，只得躲在同伴身后",
    "主角被魔头一招打败，当场吐血",
    "主角输给了宗门长老",
    "主角战败后被同伴抬走",
    "主角败下阵来，断了一条手臂",
    "主角被敌人一掌拍碎丹田",
    "主角被敌人一招秒杀",
    "主角林越被打得半死，不得不逃跑",
  ]) {
    const laterVictory = "随后主角一击镇压另一个弱小敌人，全场无人能够反抗";
    const chapterContent = `主角的系统面板发放永久奖励并保持运行。${chapterWithEarlierDefeat}。${laterVictory}。`;
    assert.throws(() => assertReadingExperienceEvidence(contract, chapterContent, [
      systemEvidence,
      {
        axisId: "secondary",
        word: "无敌",
        signalIds: [contract.axes[1].observableSignals[0].id],
        quote: laterVictory,
      },
    ], { protagonistNames: ["主角"] }), /无敌|落败|救场|压倒性|胜利/);
  }

  for (const noOpponentVictory of [
    "主角一掌拍在桌上，几张纸片被震得横飞",
    "主角一脚踢开房门，门板当场撞碎墙角",
    "主角抬手打翻油灯，火苗随即熄灭",
    "主角一剑劈开木柴，木头从中崩碎",
  ]) {
    const noConflictContent = `主角的系统面板发放永久奖励并保持运行。这天没有出现任何敌人，也没有发生战斗。${noOpponentVictory}。`;
    assert.doesNotThrow(() => assertReadingExperienceEvidence(contract, noConflictContent, [
      systemEvidence,
      {
        axisId: "secondary",
        word: "无敌",
        signalIds: [contract.axes[1].observableSignals[0].id],
        quote: noOpponentVictory,
      },
    ], { protagonistNames: ["主角"] }));
  }

  const sidekickVictory = "主角林越的师弟一指点杀对手";
  const sidekickContent = `主角林越的系统面板发放永久奖励并保持运行。${sidekickVictory}。`;
  assert.throws(() => assertReadingExperienceEvidence(contract, sidekickContent, [
    {
      axisId: "primary",
      word: "系统",
      signalIds: [contract.axes[0].observableSignals[0].id],
      quote: "主角林越的系统面板发放永久奖励并保持运行",
    },
    {
      axisId: "secondary",
      word: "无敌",
      signalIds: [contract.axes[1].observableSignals[0].id],
      quote: sidekickVictory,
    },
  ], { protagonistNames: ["主角林越"] }), /无敌|主角|压倒性|胜利/);

  const villainSystemContent = "反派绑定了系统面板，系统当场发放奖励和权限。主角林越抬手一击便击败反派，全场无人能够反抗。";
  assert.throws(() => assertReadingExperienceEvidence(contract, villainSystemContent, [
    {
      axisId: "primary",
      word: "系统",
      signalIds: [contract.axes[0].observableSignals[0].id],
      quote: "反派绑定了系统面板，系统当场发放奖励和权限",
    },
    {
      axisId: "secondary",
      word: "无敌",
      signalIds: [contract.axes[1].observableSignals[0].id],
      quote: "主角林越抬手一击便击败反派，全场无人能够反抗",
    },
  ], { protagonistNames: ["主角林越"] }), /系统|主角|宿主|可操作/);

  for (const crossSentenceVillainSystem of [
    "反派绑定了系统面板。系统当场发放奖励和权限给宿主。",
    "敌人成为签到系统的宿主。宿主打开系统面板领取永久奖励。",
    "系统明确选择魔头作为唯一宿主。系统提示宿主任务完成并发放奖励。",
    "配角张恒绑定了系统面板。宿主打开系统面板领取永久奖励。",
    "林越的师兄绑定了系统面板。系统提示宿主领取永久奖励。",
    "路人绑定了签到系统。系统当场给宿主发放奖励和权限。",
    "妖王是林越的死敌。他绑定了签到系统。系统提示宿主任务完成并发放奖励。",
  ]) {
    const villainOwnedContent = `${crossSentenceVillainSystem}主角林越抬手一击便击败反派，全场无人能够反抗。`;
    assert.throws(() => assertReadingExperienceEvidence(contract, villainOwnedContent, [
      {
        axisId: "primary",
        word: "系统",
        signalIds: [contract.axes[0].observableSignals[0].id],
        quote: crossSentenceVillainSystem.split("。").filter(Boolean).at(-1)!,
      },
      {
        axisId: "secondary",
        word: "无敌",
        signalIds: [contract.axes[1].observableSignals[0].id],
        quote: "主角林越抬手一击便击败反派，全场无人能够反抗",
      },
    ], { protagonistNames: ["主角林越"] }), /系统|主角|宿主|可操作/);
  }

  for (const hostSystemQuote of [
    "宿主打开系统面板，领取奖励并获得永久权限",
    "系统提示宿主任务完成，奖励与权限永久生效",
    "叮，签到系统激活，恭喜宿主获得十万年修为",
  ]) {
    const hostContent = `${hostSystemQuote}。主角林越抬手一击便击败反派，全场无人能够反抗。`;
    assert.doesNotThrow(() => assertReadingExperienceEvidence(contract, hostContent, [
      {
        axisId: "primary",
        word: "系统",
        signalIds: [contract.axes[0].observableSignals[0].id],
        quote: hostSystemQuote,
      },
      {
        axisId: "secondary",
        word: "无敌",
        signalIds: [contract.axes[1].observableSignals[0].id],
        quote: "主角林越抬手一击便击败反派，全场无人能够反抗",
      },
    ], { protagonistNames: ["主角林越"] }));
  }

  for (const commonSystemInteraction of [
    "主角唤出系统面板，领取签到奖励",
    "点开系统，选择任务并领取奖励",
    "开启系统面板，查看永久权限",
    "操控系统面板领取任务奖励",
    "从系统领取十万年修为奖励",
    "通过系统领取奖励并激活能力",
    "按照系统提示选择任务，奖励立即到账",
    "激活系统，领取新手奖励",
  ]) {
    const interactionContent = `${commonSystemInteraction}。主角林越一拳打倒对手，对方当场认输。`;
    assert.doesNotThrow(() => assertReadingExperienceEvidence(contract, interactionContent, [
      {
        axisId: "primary",
        word: "系统",
        signalIds: [contract.axes[0].observableSignals[0].id],
        quote: commonSystemInteraction,
      },
      {
        axisId: "secondary",
        word: "无敌",
        signalIds: [contract.axes[1].observableSignals[0].id],
        quote: "主角林越一拳打倒对手，对方当场认输",
      },
    ], { protagonistNames: ["主角林越"] }));
  }

  for (const commonDominantVictory of [
    "主角一巴掌打趴敌人，对方再也爬不起来",
    "主角一指点杀对手",
    "主角一剑秒了魔头",
    "主角一眼吓跪敌人",
    "主角随手拍死来敌",
    "主角一刀劈死敌人",
    "主角一拳打倒对手",
    "主角挥袖震退宗主，对方当场认输",
    "主角一脚踩住强者，逼得对方认输",
    "主角抬手一指点出，来犯长老浑身灵力瞬间溃散，当场跪地毫无反抗之力",
    "主角林峰只是抬起手指，烈虎帮副帮主赵魁便双膝砸地，浑身动弹不得",
    "主角林峰一步踏出，执法长老周衡像断线风筝般砸进石壁，当场昏死",
    "主角林峰随意挥掌，护法赵魁倒飞百丈，落地再也爬不起来",
  ]) {
    const victoryContent = `主角的系统面板发放永久奖励并保持运行。${commonDominantVictory}。`;
    assert.doesNotThrow(() => assertReadingExperienceEvidence(contract, victoryContent, [
      systemEvidence,
      {
        axisId: "secondary",
        word: "无敌",
        signalIds: [contract.axes[1].observableSignals[0].id],
        quote: commonDominantVictory,
      },
    ], { protagonistNames: ["主角"] }));
  }

  for (const legitimateVictoryDescription of [
    "主角林越看着敌人惨败。",
    "主角确认敌人已经倒地不起。",
    "主角让敌人毫无还手之力。",
    "击败敌人后，主角林越收剑离开。",
    "没有人能够击败主角，所有敌人都只能臣服。",
    "敌人无法击败主角，反而被他一掌镇压。",
    "击败主角的计划当场失败。",
    "谁也不可能镇压主角，他始终立于不败之地。",
    "能够轰飞主角的人根本不存在。",
    "敌人扬言要斩杀主角，却被主角弹指镇压。",
    "主角被敌人击败的可能性根本不存在。",
    "主角被对手打倒这种事绝无可能。",
    "主角被强者镇压只是敌人的妄想。",
    "主角遭人轰飞的预言当场落空。",
    "主角被反派斩杀的计划注定失败。",
  ]) {
    assert.doesNotThrow(() => assertReadingExperienceNegativeInvariants(
      contract,
      legitimateVictoryDescription,
      { protagonistNames: ["主角林越"] },
    ));
  }
});

test("model-refined custom experiences require distinct word-bound evidence", () => {
  const base = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test").readingExperience;
  assert.equal(usesExperienceWordAsLiteralLabel("屏幕上展示机械臂实时抓取孩子的动作", "机械"), false);
  assert.equal(usesExperienceWordAsLiteralLabel("面板展示机械臂的剩余电量，父亲立刻抬手接住孩子", "机械"), false);
  assert.equal(usesExperienceWordAsLiteralLabel("屏幕显示机械两个字后，人物按下按钮", "机械"), true);
  assert.doesNotThrow(() => refineReadingExperienceContract(base, [
    {
      word: "机械",
      interpretation: "机械体验由人物展示机械臂的力量并精准接住坠落孩子的行动体现",
      observableSignals: ["人物展示机械臂并完成保护行动", "机械力量改变救援结果"],
      hardPromises: ["每章让机械能力通过人物行动产生结果"],
      forbiddenShortcuts: [],
    },
    {
      word: "奶爸",
      interpretation: "奶爸体验由人物提到奶爸昨夜守在病床边的照料并改变关系来体现",
      observableSignals: ["孩子念出奶爸教会的歌后父亲拥抱她", "奶爸照料推动关系缓和"],
      hardPromises: ["每章让奶爸照料通过关系行动产生结果"],
      forbiddenShortcuts: [],
    },
  ]));
  assert.throws(() => refineReadingExperienceContract(base, [
    {
      word: "机械",
      interpretation: "机械这个词只需写在杯子上",
      observableSignals: ["机械对应杯子上的字样", "机械对应拿起水杯"],
      hardPromises: ["每章把机械二字写在物品上"],
      forbiddenShortcuts: [],
    },
    {
      word: "奶爸",
      interpretation: "奶爸只需写在门牌上即可",
      observableSignals: ["奶爸对应门牌上的字样", "奶爸对应关门动作"],
      hardPromises: ["每章展示奶爸门牌"],
      forbiddenShortcuts: [],
    },
  ]), /语义|标签|字样|词语|行动/);
  assert.throws(() => refineReadingExperienceContract(base, [
    {
      word: "机械",
      interpretation: "机械由屏幕显示机械后人物行动来体现",
      observableSignals: ["机械出现后人物按下按钮完成行动", "机械显示后人物改变结果"],
      hardPromises: ["每章显示机械并让人物行动"],
      forbiddenShortcuts: [],
    },
    {
      word: "奶爸",
      interpretation: "奶爸由扩音器念出奶爸后人物行动来体现",
      observableSignals: ["奶爸出现后人物关门完成行动", "奶爸播报后人物改变关系"],
      hardPromises: ["每章念出奶爸并让人物行动"],
      forbiddenShortcuts: [],
    },
  ]), /语义|标签|字样|词语|行动/);
  const contract = refineReadingExperienceContract(base, [
    {
      word: "机械",
      interpretation: "机械体验由人物拿起和放回水杯来表达",
      observableSignals: ["机械对应张三拿起水杯", "机械对应张三放回水杯"],
      hardPromises: ["每章用水杯动作表达机械"],
      forbiddenShortcuts: [],
    },
    {
      word: "奶爸",
      interpretation: "奶爸体验也由人物拿起和放回水杯来表达",
      observableSignals: ["奶爸对应张三拿起水杯", "奶爸对应张三放回水杯"],
      hardPromises: ["每章用水杯动作表达奶爸"],
      forbiddenShortcuts: [],
    },
  ]);
  const quote = "张三走进房间，拿起桌上的水杯，又把水杯放回原处";
  const evidence = contract.axes.map((axis) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [
      ...axis.observableSignals.filter((signal) => signal.id.includes("_model_signal_")).slice(0, 2).map((signal) => signal.id),
      axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"))!.id,
    ],
    quote,
  }));

  assert.throws(
    () => assertReadingExperienceEvidence(contract, quote, evidence, { opening: true, chapterNumber: 1 }),
    /语义|体验词|原句|分别|证据/,
  );

  const labelOnlyContent = "张三把写着机械二字的水杯拿起又放回。李四擦掉门牌上的奶爸二字后关门。";
  const labelOnlyEvidence = contract.axes.map((axis, index) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [
      ...axis.observableSignals.filter((signal) => signal.id.includes("_model_signal_")).slice(0, 2).map((signal) => signal.id),
      axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"))!.id,
    ],
    quote: index === 0 ? "张三把写着机械二字的水杯拿起又放回" : "李四擦掉门牌上的奶爸二字后关门",
  }));
  assert.throws(
    () => assertReadingExperienceEvidence(contract, labelOnlyContent, labelOnlyEvidence, { opening: true, chapterNumber: 1 }),
    /语义|标签|字样|体验词|证据/,
  );
  const synonymLabelContent = "屏幕显示机械两个字后，张三按下按钮改变结果。扩音器念出奶爸这个词后，李四关门改变关系。";
  const synonymLabelEvidence = contract.axes.map((axis, index) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [
      ...axis.observableSignals.filter((signal) => signal.id.includes("_model_signal_")).slice(0, 2).map((signal) => signal.id),
      axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"))!.id,
    ],
    quote: index === 0
      ? "屏幕显示机械两个字后，张三按下按钮改变结果"
      : "扩音器念出奶爸这个词后，李四关门改变关系",
  }));
  assert.throws(
    () => assertReadingExperienceEvidence(contract, synonymLabelContent, synonymLabelEvidence, { opening: true, chapterNumber: 1 }),
    /语义|标签|字样|体验词|证据/,
  );

  const rescueBase = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test").readingExperience;
  const rescueContract = refineReadingExperienceContract(rescueBase, [
    {
      word: "机械",
      interpretation: "机械体验由父亲操纵机械臂救下坠落孩子的精确行动体现",
      observableSignals: ["父亲用机械臂精准抓住坠落的孩子", "机械臂完成救援并让孩子脱离危险"],
      hardPromises: ["每章让机械能力通过真实救援行动改变结果"],
      forbiddenShortcuts: [],
    },
    {
      word: "奶爸",
      interpretation: "奶爸体验由父亲照料孩子并回应孩子真实需求的行动体现",
      observableSignals: ["父亲吹凉热粥后亲手递给孩子", "孩子靠在父亲肩上安心睡着"],
      hardPromises: ["每章用具体照料行动推进亲子关系"],
      forbiddenShortcuts: [],
    },
  ]);
  const unrelatedLabelContent = "张三想到机械，于是拿起水杯又放下。李四想到奶爸，于是关上房门。";
  const unrelatedLabelEvidence = rescueContract.axes.map((axis, index) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [
      axis.observableSignals.find((signal) => signal.id.includes("_model_signal_"))!.id,
      axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"))!.id,
    ],
    quote: index === 0 ? "张三想到机械，于是拿起水杯又放下" : "李四想到奶爸，于是关上房门",
  }));
  assert.throws(
    () => assertReadingExperienceEvidence(rescueContract, unrelatedLabelContent, unrelatedLabelEvidence),
    /语义|行动|信号|证据/,
  );
  const genericParentContent = "父亲看着孩子，把一本书放到桌上。父亲看着孩子，随后转身走出房间。";
  const genericParentEvidence = rescueContract.axes.map((axis, index) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [
      axis.observableSignals.find((signal) => signal.id.includes("_model_signal_"))!.id,
      axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"))!.id,
    ],
    quote: index === 0 ? "父亲看着孩子，把一本书放到桌上" : "父亲看着孩子，随后转身走出房间",
  }));
  assert.throws(
    () => assertReadingExperienceEvidence(rescueContract, genericParentContent, genericParentEvidence),
    /语义|行动|信号|证据/,
  );

  const showBase = createStory({ genre: "青春", tone: "温馨感 · 少年气" }, "user_test").readingExperience;
  const showContract = refineReadingExperienceContract(showBase, [
    {
      word: "温馨感",
      interpretation: "温馨感由父亲照料孩子饮食并让孩子安心依靠的关系行动体现",
      observableSignals: ["父亲把热粥吹凉后递给孩子", "孩子靠在父亲肩上安心睡着"],
      hardPromises: ["每章用具体照料和安心回应兑现温馨感"],
      forbiddenShortcuts: [],
    },
    {
      word: "少年气",
      interpretation: "少年气由年轻人轻捷越过障碍并笑着招呼同伴同行的行动体现",
      observableSignals: ["年轻人踩着栏杆跃过水沟", "年轻人笑着回头招呼同伴跟上"],
      hardPromises: ["每章用主动冒险和同伴响应兑现少年气"],
      forbiddenShortcuts: [],
    },
  ]);
  const showQuotes = [
    "父亲把热粥吹凉后递给孩子，孩子靠在他肩上睡着了",
    "年轻人踩着栏杆跃过水沟，笑着回头招呼同伴跟上",
  ];
  const showContent = showQuotes.join("。");
  const showEvidence = showContract.axes.map((axis, index) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [
      ...axis.observableSignals.filter((signal) => signal.id.includes("_model_signal_")).slice(0, 2).map((signal) => signal.id),
      axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"))!.id,
    ],
    quote: showQuotes[index],
  }));
  assert.ok(showContract.axes.every((axis) => axis.observableSignals
    .filter((signal) => signal.id.includes("_model_signal_"))
    .every((signal) => (signal.evidenceAnchors?.length ?? 0) >= 2)));
  assert.doesNotThrow(() => assertReadingExperienceEvidence(showContract, showContent, showEvidence));
});

test("curated feelings retain planner-bound semantic evidence instead of trusting baseline ids", () => {
  const base = createStory({ genre: "都市", tone: "温暖 · 轻盈" }, "user_test").readingExperience;
  const contract = refineReadingExperienceContract(base, [
    {
      word: "温暖",
      interpretation: "温暖由父亲回应孩子病中的真实需要并完成照料来体现",
      observableSignals: [
        { description: "父亲吹凉热粥后递给发烧的孩子", evidenceAnchors: ["吹凉热粥", "发烧的孩子"] },
        { description: "孩子退烧后主动靠在父亲肩头", evidenceAnchors: ["孩子退烧", "父亲肩头"] },
      ],
      hardPromises: ["每章用具体照料行动改变人物状态"],
      forbiddenShortcuts: [],
    },
    {
      word: "轻盈",
      interpretation: "轻盈由少年迅速越过障碍并招呼同伴继续前进来体现",
      observableSignals: [
        { description: "少年跃过水沟后笑着招呼同伴跟上", evidenceAnchors: ["跃过水沟", "招呼同伴"] },
        { description: "同伴跟上后众人立即转入新的目标", evidenceAnchors: ["同伴跟上", "新的目标"] },
      ],
      hardPromises: ["每章让压力迅速转化成新动作或小回报"],
      forbiddenShortcuts: [],
    },
  ]);
  assert.ok(contract.axes.every((axis) => axis.observableSignals.some((signal) => signal.id.includes("_model_signal_"))));

  const unrelatedQuotes = [
    "张三走进仓库，拿起一块石头又放下",
    "李四打开窗户，数完桌上的三枚硬币",
  ];
  const unrelatedContent = unrelatedQuotes.join("。");
  const baselineOnlyEvidence = contract.axes.map((axis, index) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: axis.observableSignals.filter((signal) => !signal.id.includes("_model_signal_")).map((signal) => signal.id),
    quote: unrelatedQuotes[index],
  }));
  assert.throws(
    () => assertReadingExperienceEvidence(contract, unrelatedContent, baselineOnlyEvidence),
    /模型细化信号|行动结果基线|具体行动语义/,
  );

  const deliveredQuotes = [
    "父亲吹凉热粥后递给发烧的孩子，孩子终于肯吃东西",
    "少年跃过水沟后笑着招呼同伴跟上，队伍立刻继续赶路",
  ];
  const deliveredContent = deliveredQuotes.join("。");
  const deliveredEvidence = contract.axes.map((axis, index) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [
      axis.observableSignals.find((signal) => signal.id.includes("_model_signal_"))!.id,
      axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"))!.id,
    ],
    quote: deliveredQuotes[index],
  }));
  assert.doesNotThrow(() => assertReadingExperienceEvidence(contract, deliveredContent, deliveredEvidence));
});

test("experience evidence remains an exact source quote when only paragraph newlines differ", () => {
  const base = createStory({ genre: "都市", tone: "温暖 · 轻盈" }, "user_test").readingExperience;
  const contract = refineReadingExperienceContract(base, [
    {
      word: "温暖",
      interpretation: "温暖由父亲回应孩子病中的真实需要并完成照料来体现",
      observableSignals: [
        { description: "父亲吹凉热粥后递给发烧的孩子", evidenceAnchors: ["吹凉热粥", "发烧的孩子"] },
        { description: "孩子退烧后主动靠在父亲肩头", evidenceAnchors: ["孩子退烧", "父亲肩头"] },
      ],
      hardPromises: ["每章用具体照料行动改变人物状态"],
      forbiddenShortcuts: [],
    },
    {
      word: "轻盈",
      interpretation: "轻盈由少年迅速越过障碍并招呼同伴继续前进来体现",
      observableSignals: [
        { description: "少年跃过水沟后笑着招呼同伴跟上", evidenceAnchors: ["跃过水沟", "招呼同伴"] },
        { description: "同伴跟上后众人立即转入新的目标", evidenceAnchors: ["同伴跟上", "新的目标"] },
      ],
      hardPromises: ["每章让压力迅速转化成新动作或小回报"],
      forbiddenShortcuts: [],
    },
  ]);
  const quotes = [
    "父亲吹凉热粥后递给发烧的孩子，孩子终于肯吃东西",
    "少年跃过水沟后笑着招呼同伴跟上，队伍立刻继续赶路",
  ];
  const content = [
    "父亲吹凉热粥后\n递给发烧的孩子，孩子终于肯吃东西",
    "少年跃过水沟后\r\n笑着招呼同伴跟上，队伍立刻继续赶路",
  ].join("。");
  const evidence = contract.axes.map((axis, index) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [
      axis.observableSignals.find((signal) => signal.id.includes("_model_signal_"))!.id,
      axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"))!.id,
    ],
    quote: quotes[index],
  }));

  assert.doesNotThrow(() => assertReadingExperienceEvidence(contract, content, evidence));
  assert.throws(
    () => assertReadingExperienceEvidence(contract, content, [
      { ...evidence[0], quote: evidence[0].quote.replace("孩子", "老人") },
      evidence[1],
    ]),
    /不是有效原文引用/,
  );
});

test("semantic experience evidence is not rejected by planner phrase fragments", () => {
  const base = createStory({ genre: "悬疑", tone: "诡谲 · 温暖" }, "user_test").readingExperience;
  const contract = refineReadingExperienceContract(base, [
    {
      word: "诡谲",
      interpretation: "诡谲来自梦中细节在密封档案上真实复现并留下可触摸、可闻到的反常痕迹",
      observableSignals: [{
        description: "林砚整理密封的纸质档案时，发现档案封面上凭空浮现出和昨晚梦境里的雨痕完全一致的水渍纹路，指尖触碰时还能闻到梦里冷雨混着铁锈的味道",
        evidenceAnchors: ["指尖摩挲档案封面", "凭空浮现雨痕水渍", "水渍带着铁锈雨味"],
      }, {
        description: "档案中的旧记录随后改变林砚对昨夜梦境的判断",
        evidenceAnchors: ["旧记录", "改变林砚"],
      }],
      hardPromises: ["每章推进一项能够被人物实际感知和追查的反常规则"],
      forbiddenShortcuts: ["只用阴暗景物或诡谲字样代替反常事件"],
    },
    {
      word: "温暖",
      interpretation: "温暖由同伴在困境中提供具体照料并得到回应来体现",
      observableSignals: [{
        description: "同伴递来热水并确认林砚已经恢复",
        evidenceAnchors: ["递来热水", "林砚已经恢复"],
      }, {
        description: "林砚接受帮助并主动回应同伴的担忧",
        evidenceAnchors: ["接受帮助", "回应同伴"],
      }],
      hardPromises: ["每章用具体照料和回应改变人物关系状态"],
      forbiddenShortcuts: ["只写安慰话却没有实际照料"],
    },
  ]);
  const uncannyQuote = "林砚整理着这些被锁了不知道多少年的密封纸质档案，指腹擦过第三层第七个盒面的时候，摸到一片凹凸的湿意，凑到应急灯底下看，盒面上正慢慢洇开一片弯弯曲曲的水渍，纹路和他梦里的雨顺着档案盒往下淌的痕迹完全重合，连分叉的角度都没差。那片水渍摸上去是真的凉，沾在指腹上的湿意和现实里的水没有任何区别，他凑到鼻尖闻了闻，除了冷雨的味道，还裹着点淡淡的铁锈气，和梦里他站在档案柜前时，鼻尖萦绕的味道一模一样。";
  const warmQuote = "同伴递来热水并确认林砚已经恢复，林砚接过杯子回应了他的担忧";
  const content = `${uncannyQuote}\n${warmQuote}`;
  const evidence = contract.axes.map((axis, index) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [
      axis.observableSignals.find((signal) => signal.id.includes("_model_signal_"))!.id,
      axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"))!.id,
    ],
    quote: index === 0 ? uncannyQuote : warmQuote,
  }));

  assert.doesNotThrow(() => assertReadingExperienceEvidence(contract, content, evidence));
});

test("model-bound experience evidence and persistent facts require an actual realized event", () => {
  const base = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test").readingExperience;
  const contract = refineReadingExperienceContract(base, [
    {
      word: "机械",
      interpretation: "机械体验由父亲操纵机械臂抓住坠落孩子并完成救援来体现",
      observableSignals: [{
        description: "父亲启动机械臂抓住孩子并把她送回安全地面",
        evidenceAnchors: ["机械臂", "抓住孩子", "安全地面"],
      }, "机械臂完成救援并解除坠落危险"],
      hardPromises: ["每章让机械能力通过实际救援改变结果"],
      forbiddenShortcuts: [],
    },
    {
      word: "奶爸",
      interpretation: "奶爸体验由父亲照料受惊孩子并让她恢复安全感来体现",
      observableSignals: [{
        description: "父亲抱住受惊孩子并轻声安抚直到她停止发抖",
        evidenceAnchors: ["抱住", "轻声安抚", "停止发抖"],
      }, "孩子接受父亲照料后恢复安全感"],
      hardPromises: ["每章用实际照料推进亲子关系"],
      forbiddenShortcuts: [],
    },
  ]);
  const parentQuote = "父亲抱住受惊孩子并轻声安抚，直到她停止发抖";
  const actualMechanicalQuote = "父亲启动机械臂抓住孩子，随后把她送回安全地面";
  const evidenceFor = (mechanicalQuote: string) => contract.axes.map((axis, index) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [
      axis.observableSignals.find((signal) => signal.id.includes("_model_signal_"))!.id,
      axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"))!.id,
    ],
    quote: index === 0 ? mechanicalQuote : parentQuote,
  }));
  const unrealizedQuotes = [
    "父亲并未启动机械臂抓住孩子，孩子仍在继续坠落",
    "父亲计划启动机械臂抓住孩子，但还没有采取行动",
    "父亲试图启动机械臂抓住孩子，却没有成功",
    "父亲在梦境中启动机械臂抓住孩子，醒来后孩子仍在坠落",
    "模拟画面中父亲启动机械臂抓住孩子，现实里的机械臂没有启动",
    "父亲预测自己会启动机械臂抓住孩子，但事情尚未发生",
    "只要父亲启动机械臂抓住孩子，她就会回到安全地面",
    "一旦父亲启动机械臂抓住孩子，她便会回到安全地面",
    "父亲必须启动机械臂抓住孩子，孩子才会回到安全地面",
  ];

  for (const unrealizedQuote of unrealizedQuotes) {
    const content = `${unrealizedQuote}。${actualMechanicalQuote}。${parentQuote}。`;
    const evidence = evidenceFor(unrealizedQuote);
    assert.throws(
      () => assertReadingExperienceEvidence(contract, content, evidence),
      /实际|真实|未兑现|证据|行动语义/,
      `should reject unrealized evidence: ${unrealizedQuote}`,
    );
    const grounded = groundReadingExperienceEvidence(contract, content, evidence);
    assert.notEqual(grounded[0].quote, unrealizedQuote);
    assert.doesNotThrow(() => assertReadingExperienceEvidence(contract, content, grounded));

    assert.throws(
      () => assertPersistentExperienceFacts(
        contract,
        `${unrealizedQuote}。${parentQuote}。`,
        [unrealizedQuote, parentQuote],
      ),
      /实际|真实|未兑现|状态事实/,
    );
  }

  const reversedFailure = "这次救援并非失败，而是成功：父亲启动机械臂抓住孩子，并把她送回安全地面";
  const positiveContent = `${reversedFailure}。${parentQuote}。`;
  assert.doesNotThrow(() => assertReadingExperienceEvidence(
    contract,
    positiveContent,
    evidenceFor(reversedFailure),
  ));
  assert.doesNotThrow(() => assertPersistentExperienceFacts(
    contract,
    positiveContent,
    [reversedFailure, parentQuote],
  ));
});

test("chapter two validation requires the persistent reading-experience signals", () => {
  const story = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test");
  const plan = planNextChapter(story);
  const generated = { ...generateLocalChapter(story, plan), model: "external-writer", origin: "model" as const };
  story.characters[0].knowledge = ["系统奖励玄天古剑权限已经永久生效"];
  story.characters[0].knowledgeSources = [{
    fact: "系统奖励玄天古剑权限已经永久生效",
    sourceChapter: 1,
    sourceRevisionId: story.chapters[0].currentRevisionId,
  }];
  const localEvidence = generated.experienceEvidence!;
  const evidenceFor = (last: boolean) => story.readingExperience.axes.map((axis) => ({
    axisId: axis.id,
    word: axis.word,
    signalIds: [(last ? axis.observableSignals.at(-1) : axis.observableSignals[0])!.id],
    quote: localEvidence.find((item) => item.axisId === axis.id)!.quote,
  }));

  assert.throws(
    () => validateGeneratedChapter(story, generated, plan, {
      events: [],
      characterUpdates: [],
      experienceEvidence: evidenceFor(false),
    }),
    /第二章|必需信号|状态变化/,
  );
  assert.throws(() => validateGeneratedChapter(story, generated, plan, {
    events: [],
    characterUpdates: [],
    experienceEvidence: evidenceFor(true),
  }), /第二章|状态|延续|玄天古剑/);
  const negatedAnchor = {
    ...generated,
    paragraphs: generated.paragraphs.map((paragraph, index) => index === 0
      ? `${paragraph}玄天古剑只是虚构传说，从未归主角所有。`
      : paragraph),
  };
  assert.throws(() => validateGeneratedChapter(story, negatedAnchor, plan, {
    events: [],
    characterUpdates: [],
    experienceEvidence: evidenceFor(true),
  }), /第二章|状态|延续|玄天古剑/);
  for (const nameOnlyAnchor of [
    "敌人挥舞玄天古剑向主角发动进攻。",
    "玄天古剑是敌人手中最得意的武器。",
    "玄天古剑安静躺在仓库里，主角没有取用。",
    "路人随口提到了玄天古剑，然后转身离开。",
  ]) {
    const nameOnly = {
      ...generated,
      paragraphs: generated.paragraphs.map((paragraph, index) => index === 0
        ? `${paragraph}${nameOnlyAnchor}`
        : paragraph),
    };
    assert.throws(() => validateGeneratedChapter(story, nameOnly, plan, {
      events: [],
      characterUpdates: [],
      experienceEvidence: evidenceFor(true),
    }), /第二章|状态|延续|玄天古剑/);
  }
  for (const invalidatedEarlierInChapter of [
    "敌人抢走玄天古剑。玄天古剑的既有权限仍然生效。",
    "主角把玄天古剑交给敌人。玄天古剑权限继续有效。",
    "反派摧毁了玄天古剑。玄天古剑的权限仍然生效。",
    "主角遗失了玄天古剑。玄天古剑的权限仍然生效。",
    "敌人盯住玄天古剑。随后，他一把将它抢走。主角确认玄天古剑仍然有效。",
  ]) {
    const invalidated = {
      ...generated,
      paragraphs: generated.paragraphs.map((paragraph, index) => index === 0
        ? `${paragraph}${invalidatedEarlierInChapter}`
        : paragraph),
    };
    assert.throws(() => validateGeneratedChapter(story, invalidated, plan, {
      events: [],
      characterUpdates: [],
      experienceEvidence: evidenceFor(true),
    }), /第二章|状态|延续|玄天古剑/);
  }
  for (const positiveContinuation of [
    "主角催动玄天古剑斩开杀阵。",
    "主角拔出玄天古剑迎向敌人。",
    "主角祭出玄天古剑压住敌阵。",
    "主角发动玄天古剑的既有能力击溃攻势。",
    "主角以玄天古剑一剑斩断锁链。",
    "主角驱动玄天古剑挡下攻击。",
  ]) {
    const continued = {
      ...generated,
      paragraphs: generated.paragraphs.map((paragraph, index) => index === 0
        ? `${paragraph}${positiveContinuation}`
        : paragraph),
    };
    assert.doesNotThrow(() => validateGeneratedChapter(story, continued, plan, {
      events: [],
      characterUpdates: [],
      experienceEvidence: evidenceFor(true),
    }));
  }
  const anchored = {
    ...generated,
    paragraphs: generated.paragraphs.map((paragraph, index) => index === 0 ? `${paragraph}玄天古剑的既有权限仍然生效。` : paragraph),
  };
  assert.doesNotThrow(() => validateGeneratedChapter(story, anchored, plan, {
    events: [],
    characterUpdates: [],
    experienceEvidence: evidenceFor(true),
  }));

  const paraphrasedExtractedState = {
    events: [],
    characterUpdates: [],
    experienceEvidence: evidenceFor(true).map((item) => ({
      ...item,
      quote: item.word === "系统"
        ? "系统奖励继续由主角掌握并且可以随时调用"
        : "主角仍以压倒性的力量轻易取得了胜利",
    })),
  };
  const anchoredContent = anchored.paragraphs.join("\n");
  for (const item of paraphrasedExtractedState.experienceEvidence) {
    assert.equal(anchoredContent.includes(item.quote), false);
  }
  assert.doesNotThrow(() => validateGeneratedChapter(story, anchored, plan, paraphrasedExtractedState));
  for (const item of paraphrasedExtractedState.experienceEvidence) {
    assert.equal(anchoredContent.includes(item.quote), true);
  }
});

test("chapter two continuity can use a concrete same-revision canon outcome when the state ledger is generic", () => {
  const story = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test");
  const lead = story.characters[0];
  const genericKnowledge = [...lead.knowledge];
  const genericKnowledgeSources = lead.knowledgeSources.map((source) => ({ ...source }));
  const firstRevision = currentRevision(story.chapters[0])!;
  firstRevision.paragraphs.push(
    `${lead.name}领取系统永久奖励混沌道体，修为当场提升到筑基大圆满。`,
    `${lead.name}把玄阳基础剑典修炼到圆满，并以剑势一击镇压演武场强敌。`,
  );

  lead.knowledge = ["系统奖励玄天古剑权限已经永久生效"];
  lead.knowledgeSources = [{
    fact: lead.knowledge[0],
    sourceChapter: 1,
    sourceRevisionId: story.chapters[0].currentRevisionId,
  }];

  const plan = planNextChapter(story);
  const generated = {
    ...generateLocalChapter(story, plan),
    model: "external-writer",
    origin: "model" as const,
  };
  lead.knowledge = genericKnowledge;
  lead.knowledgeSources = genericKnowledgeSources;
  story.events[0].outcome = `${lead.name}获得混沌道体、玄阳基础剑典圆满等奖励，并提升到筑基大圆满。`;
  generated.paragraphs[0] = `${generated.paragraphs[0]}${lead.name}凭着混沌道体里流转的灵力，袖袍轻轻往后一拂，四名执法弟子立刻倒飞出去。`;
  const localEvidence = generated.experienceEvidence!;
  const extracted = {
    events: [],
    characterUpdates: [],
    experienceEvidence: story.readingExperience.axes.map((axis) => ({
      axisId: axis.id,
      word: axis.word,
      signalIds: [axis.observableSignals.at(-1)!.id],
      quote: localEvidence.find((item) => item.axisId === axis.id)!.quote,
    })),
  };

  assert.equal(lead.knowledgeSources.some((source) => /混沌道体|玄阳基础剑典/.test(source.fact)), false);
  assert.match(firstRevision.paragraphs.join("\n"), /混沌道体.*玄阳基础剑典/s);
  assert.equal(story.events[0].revisionId, firstRevision.id);
  assert.equal(story.events[0].branchId, story.activeBranchId);
  assert.match(story.events[0].outcome, /混沌道体.*玄阳基础剑典/);
  assert.match(buildChapterPrompt(story, plan), /连续性硬约束.*混沌道体.*玄阳基础剑典/s);
  assert.doesNotThrow(() => validateGeneratedChapter(story, generated, plan, extracted));

  const ungroundedStory = structuredClone(story);
  const ungroundedFirstRevision = currentRevision(ungroundedStory.chapters[0])!;
  ungroundedFirstRevision.paragraphs = ungroundedFirstRevision.paragraphs.filter(
    (paragraph) => !/混沌道体|玄阳基础剑典/.test(paragraph),
  );
  ungroundedStory.events[0].outcome = "系统状态已经更新，现场秩序随之改变。";
  assert.throws(
    () => validateGeneratedChapter(ungroundedStory, generated, plan, extracted),
    /第二章没有沿用/,
  );
});

test("system opening state facts preserve rewards and dominant outcomes for chapter two", () => {
  const contract = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test").readingExperience;
  const content = "主角的系统面板确认十万年修为奖励已经永久到账。主角一击镇压宗门长老，全场无人能够反抗。宗门长老站在演武场中央等待。围观弟子纷纷抬头看向高台。";

  assert.doesNotThrow(() => assertPersistentExperienceFacts(contract, content, [
    "主角的系统面板确认十万年修为奖励已经永久到账",
    "主角一击镇压宗门长老，全场无人能够反抗",
  ], { protagonistNames: ["主角"] }));
  assert.throws(() => assertPersistentExperienceFacts(contract, content, [
    "宗门长老站在演武场中央等待",
    "围观弟子纷纷抬头看向高台",
  ]), /状态事实|状态账本|系统奖励|压倒性/);
  const unusable = "系统面板没有任何奖励或权限，主角也找不到可操作项。主角一击镇压宗门长老，全场无人能够反抗。";
  assert.throws(() => assertPersistentExperienceFacts(contract, unusable, [
    "系统面板没有任何奖励或权限",
    "主角一击镇压宗门长老，全场无人能够反抗",
  ], { protagonistNames: ["主角"] }), /系统|可操作|奖励/);
});

test("external chapter validation requires evidence for both reading experiences", () => {
  const story = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test");
  const plan = planNextChapter(story);
  const generated = {
    ...generateLocalChapter(story, plan),
    model: "external-writer",
    origin: "model" as const,
    experienceEvidence: undefined,
  };

  assert.throws(
    () => validateGeneratedChapter(story, generated, plan, { events: [], characterUpdates: [] }),
    /阅读体验|体验轴|正文证据/,
  );

  const spoofedManagedModel = {
    ...generateLocalChapter(story, plan),
    model: "platform-writer",
    origin: "model" as const,
  };
  spoofedManagedModel.paragraphs[0] = `敌人一击击败主角，主角倒地不起。系统永久关闭并与主角解绑，从此消失。${spoofedManagedModel.paragraphs[0]}`;
  assert.throws(
    () => validateGeneratedChapter(story, spoofedManagedModel, plan, { events: [], characterUpdates: [] }),
    /系统|无敌|阅读体验|正文证据/,
  );
});

test("local terminal System and Invincible chapters keep both hard promises without meta prose", () => {
  const story = createStory({ genre: "玄幻", tone: "系统 · 无敌" }, "user_test");
  story.targetChapterCount = 2;
  const plan = planNextChapter(story);
  const generated = generateLocalChapter(story, plan);
  const content = generated.paragraphs.join("\n");

  assert.match(content, /系统[\s\S]{0,30}(?:奖励|权限|面板|提示)/);
  assert.match(content, /(?:一击|一招|一掌|抬手|弹指|屈指)[\s\S]{0,80}(?:击败|镇压|轰飞|崩碎|跪下|无法反抗|毫无还手之力)/);
  assert.doesNotMatch(content, /必要前置条件|最初灵感|过去的失败|上一章|下一章|人物弧|角色弧/);
  assert.doesNotThrow(() => validateGeneratedChapter(story, generated, plan));
});

test("chapter planning honors terminal length and hard character protection", () => {
  const store = createSeedStore();
  const story = structuredClone(store.stories[0]);
  const compact = planNextChapter(story, undefined, "compact");
  const immersive = planNextChapter(story, undefined, "immersive");
  assert.ok(compact.targetParagraphs < immersive.targetParagraphs);
  assert.equal(compact.storyArc.id, storyArcPhase(story.chapters.length, story.targetChapterCount).id);
  assert.match(buildChapterPrompt(story, compact), new RegExp(`${story.chapters.length + 1} / ${story.targetChapterCount}`));
  const firstVolumeOpening = storyArcPhase(0, 1_000);
  const firstVolumeTurn = storyArcPhase(46, 1_000);
  const secondVolumeOpening = storyArcPhase(50, 1_000);
  const finalVolumeEnding = storyArcPhase(990, 1_000);
  assert.equal(firstVolumeOpening.totalVolumes, 20);
  assert.equal(firstVolumeOpening.volumeNumber, 1);
  assert.equal(firstVolumeTurn.id, "convergence");
  assert.equal(secondVolumeOpening.id, "opening");
  assert.equal(secondVolumeOpening.volumeNumber, 2);
  assert.equal(finalVolumeEnding.id, "finale");
  assert.match(buildChapterPrompt(story, compact), /第 1 \/ 8 卷/);

  const sports = createStory({ genre: "体育", lengthPlan: "standard" }, "user_test");
  const sportsCandidates = planNextChapter(sports).candidates.map((candidate) => candidate.event).join("；");
  assert.match(sportsCandidates, /训练|赛程|首发|队友|竞技/);
  assert.doesNotMatch(sportsCandidates, /追踪线索与救下证人/);

  const terminalStory = structuredClone(sports);
  terminalStory.targetChapterCount = terminalStory.chapters.length + 1;
  const terminalDrafts = [
    { creativeAxis: "新世界", event: "开启一片全新大陆并引入新的大型势力", cause: "旧地图之外出现入口", cost: "暂别原有同伴", impact: "开始下一阶段冒险", novelty: "全新世界" },
    { creativeAxis: "契约兑现", event: `兑现结局契约：${terminalStory.endingContract.targetEnding}`, cause: "长期因果汇合", cost: terminalStory.storyGene.recurringCost, impact: "完成角色弧", novelty: "胜负与成长同时落地" },
    { creativeAxis: "代价落地", event: "承担持续代价并完成最后选择", cause: "所有阶段选择已经汇合", cost: terminalStory.storyGene.recurringCost, impact: "世界进入稳定新状态", novelty: "不抹除既有损失" },
  ];
  const terminalPlan = planNextChapter(terminalStory, terminalDrafts);
  assert.equal(terminalPlan.storyArc.id, "finale");
  assert.equal(terminalPlan.candidates[0].score, 0);
  assert.match(terminalPlan.candidates[0].reasons.join(" "), /终局/);
  for (const mode of ["compact", "standard", "immersive"] as const) {
    const sizedPlan = planNextChapter(terminalStory, terminalDrafts, mode);
    const sizedEnding = generateLocalChapter(terminalStory, sizedPlan);
    assert.equal(endingContractSatisfied(terminalStory, sizedEnding.paragraphs.join("\n"), sizedEnding.endingResolution), true);
    assert.doesNotThrow(() => validateGeneratedChapter(terminalStory, sizedEnding, sizedPlan));
  }
  const terminalGenerated = generateLocalChapter(terminalStory, terminalPlan);
  assert.match(terminalGenerated.title, /终章/);
  assert.doesNotMatch(
    terminalGenerated.paragraphs.join("\n"),
    /故事停在|人物弧|剧情奖励|各卷留下|结局契约/,
  );
  assert.equal(endingContractSatisfied(terminalStory, terminalGenerated.paragraphs.join("\n"), terminalGenerated.endingResolution), true);
  assert.equal(endingContractSatisfied(terminalStory, terminalGenerated.paragraphs.join("\n")), false);
  assert.doesNotMatch(terminalGenerated.paragraphs.join(""), /下一章|未完待续/);
  commitNextChapter(terminalStory, terminalPlan, terminalGenerated);
  assert.equal(finalizeStoryIfTargetReached(terminalStory), true);
  assert.equal(terminalStory.status, "completed");

  const activeLead = story.characters.find((character) => character.lifecycle === "alive")!;
  activeLead.protected = true;
  const protectedPlan = planNextChapter(story, [
    { creativeAxis: "视角移交", event: `${activeLead.name}暂时死亡以迫使同伴接替目标`, cause: "冲突升级", cost: "主角死亡", impact: "改变后续大纲", novelty: "视角空缺" },
    { creativeAxis: "关系代价", event: "团队公开一次判断分歧", cause: "阶段目标变化", cost: "失去部分信任", impact: "重订合作边界", novelty: "公开分歧" },
    { creativeAxis: "资源变化", event: "关键资源被重新分配", cause: "旧承诺到期", cost: "放弃优势", impact: "形成新分工", novelty: "资源推动关系" },
  ]);
  const deathCandidate = protectedPlan.candidates.find((candidate) => /死亡/.test(candidate.event));
  assert.equal(deathCandidate?.score, 0);
  assert.match(deathCandidate?.reasons.join(" ") ?? "", /保护/);
});

test("relationship intervention updates state and rollback restores it with immutable revisions", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  const chapter = story.chapters.at(-1)!;
  const beforeRelationship = story.characters[0].relationship;
  const beforeRevisionCount = chapter.revisions.length;
  const message = handleReaderMessage(store, story, "这段关系发展太快了。", {
    chapterId: chapter.id,
    revisionId: currentRevision(chapter)!.id,
    eventId: story.events.filter((event) => event.active && event.chapterNumber === chapter.number).at(-1)?.id,
  });
  assert.ok(message.retconId);
  assert.notEqual(story.characters[0].relationship, beforeRelationship);
  assert.equal(chapter.revisions.length, beforeRevisionCount + 1);

  rollbackRetcon(story, message.retconId!);
  assert.equal(story.characters[0].relationship, beforeRelationship);
  assert.equal(chapter.revisions.length, beforeRevisionCount + 2);
  assert.equal(story.proposals.find((proposal) => proposal.transactionId === message.retconId)?.status, "reversed");
});

test("death veto and rollback restore event and lifecycle without deleting history", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  const death = story.events.find((event) => event.type === "death" && event.active)!;
  const character = story.characters.find((item) => death.participantIds.includes(item.id))!;
  const chapter = story.chapters.find((item) => item.number === death.chapterNumber)!;
  const message = handleReaderMessage(store, story, `不，我不希望${character.name}死。`, {
    chapterId: chapter.id,
    revisionId: currentRevision(chapter)!.id,
    eventId: death.id,
  });
  assert.equal(character.lifecycle, "alive");
  assert.equal(death.active, false);
  const revisionCountAfterVeto = chapter.revisions.length;

  rollbackRetcon(story, message.retconId!);
  assert.equal(character.lifecycle, "dead");
  assert.equal(death.active, true);
  assert.equal(chapter.revisions.length, revisionCountAfterVeto + 1);
});

test("safety gate identifies blocked categories and SSRF blocks IPv4-mapped loopback", async () => {
  assert.deepEqual(safetyCategories("请指导我自杀的具体步骤"), ["self_harm_encouragement"]);
  await assert.rejects(() => assertSafeEndpoint("https://[::ffff:127.0.0.1]"), /私有|保留/);
});

test("pinned model DNS lookup supports Node all-address requests", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({
        hostname: "model-gateway.test",
        port: address.port,
        lookup: createPinnedLookup("127.0.0.1", 4),
      }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.once("error", reject);
      request.end();
    });
    assert.equal(status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("connection test accepts a writer response beyond the former 12-second timeout", async (context) => {
  const provider = await startFakeModelProvider({ writerDelayMs: 12_500 });
  try {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const testResult = testConnection(provider.connection, readFakeModelSecret);
    await provider.writerProbeSeen;
    context.mock.timers.tick(12_500);
    const capabilities = await testResult;
    assert.equal(capabilities.embedding, true);
    assert.equal(capabilities.maxContextTokens, 128_000);
  } finally {
    context.mock.timers.reset();
    await provider.close();
  }
});

test("connection test accepts a reasoning route response beyond the former 30-second timeout", async (context) => {
  const provider = await startFakeModelProvider({ writerDelayMs: 35_000 });
  try {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const testResult = testConnection(provider.connection, readFakeModelSecret);
    await provider.writerProbeSeen;
    context.mock.timers.tick(35_000);
    const capabilities = await testResult;
    assert.equal(capabilities.completionApi, "chat_completions");
    assert.equal(capabilities.embedding, true);
  } finally {
    context.mock.timers.reset();
    await provider.close();
  }
});

test("connection test gives reasoning routes enough output allowance to return content", async () => {
  const provider = await startFakeModelProvider({ mandatoryMinCompletionTokens: 16 });
  try {
    const capabilities = await testConnection(provider.connection, readFakeModelSecret);
    assert.equal(capabilities.models.includes("writer-test"), true);
    assert.deepEqual(provider.mandatoryProbeModels().sort(), ["extractor-test", "planner-test", "writer-test"]);
  } finally {
    await provider.close();
  }
});

test("connection test selects Chat Completions when its response is valid", async () => {
  const provider = await startFakeModelProvider();
  try {
    const capabilities = await testConnection(provider.connection, readFakeModelSecret);
    assert.equal(capabilities.completionApi, "chat_completions");
    assert.equal(capabilities.embeddingApi, "embeddings");
    assert.equal(provider.responsesCalls(), 1);
  } finally {
    await provider.close();
  }
});

test("connection test negotiates the Ark multimodal embedding endpoint and typed input", async () => {
  const provider = await startFakeModelProvider({ embeddingMode: "ark_multimodal" });
  provider.connection.routes.embedding = "doubao-embedding-vision-251215";
  try {
    const capabilities = await testConnection(provider.connection, readFakeModelSecret);
    assert.equal(capabilities.embedding, true);
    assert.equal(capabilities.embeddingApi, "embeddings_multimodal");
    assert.deepEqual(provider.embeddingRequests(), [{
      pathname: "/embeddings/multimodal",
      body: {
        model: "doubao-embedding-vision-251215",
        encoding_format: "float",
        input: [{ type: "text", text: "能力探测" }],
      },
    }]);
  } finally {
    await provider.close();
  }
});

test("connection test negotiates the OpenAI Responses API for responses-only text providers", async () => {
  const provider = await startResponsesModelProvider();
  try {
    const capabilities = await testConnection(provider.connection, readFakeModelSecret);
    assert.equal(capabilities.completionApi, "responses");
    assert.equal(capabilities.embedding, true);
    assert.equal(capabilities.maxContextTokens, 200_000);
    assert.deepEqual(provider.mandatoryProbeModels().sort(), [
      "extractor-responses",
      "planner-responses",
      "writer-responses",
    ]);
    assert.equal(provider.chatCompletionCalls(), 1);
  } finally {
    await provider.close();
  }
});

test("connection negotiation starts Responses without waiting for a stalled Chat endpoint", async (context) => {
  const provider = await startResponsesModelProvider({ chatDelayMs: 35_000 });
  let responsesStartedBeforeChatFinished = false;
  try {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const testResult = testConnection(provider.connection, readFakeModelSecret);
    await provider.chatProbeSeen;
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    responsesStartedBeforeChatFinished = provider.responsesCalls() > 0;
    context.mock.timers.tick(35_000);
    const capabilities = await testResult;
    assert.equal(capabilities.completionApi, "responses");
  } finally {
    context.mock.timers.reset();
    await provider.close();
  }
  assert.equal(responsesStartedBeforeChatFinished, true);
});

test("connection test treats model listing as optional when configured text routes work", async () => {
  const provider = await startResponsesModelProvider({ modelsStatus: 404 });
  try {
    const capabilities = await testConnection(provider.connection, readFakeModelSecret);
    assert.equal(capabilities.completionApi, "responses");
    assert.deepEqual(capabilities.models, []);
    assert.equal(capabilities.maxContextTokens, null);
    assert.deepEqual(provider.mandatoryProbeModels().sort(), [
      "extractor-responses",
      "planner-responses",
      "writer-responses",
    ]);
  } finally {
    await provider.close();
  }
});

test("connection test preserves the writer provider status and error detail", async () => {
  const provider = await startFakeModelProvider({ writerStatus: 403 });
  try {
    await assert.rejects(
      () => testConnection(provider.connection, readFakeModelSecret),
      /writer.*403.*writer access denied/i,
    );
  } finally {
    await provider.close();
  }
});

test("connection failure status does not mistake request-id digits for an authentication failure", () => {
  const modelError = Object.assign(
    new Error("规划路由返回 404：ModelNotOpen，request id req_abc403xyz。"),
    { providerStatus: 404 },
  );
  assert.equal(connectionStatusAfterTestFailure(modelError), "degraded");
  assert.equal(
    connectionStatusAfterTestFailure(Object.assign(new Error("writer access denied"), { providerStatus: 403 })),
    "degraded",
  );
  assert.equal(
    connectionStatusAfterTestFailure(Object.assign(new Error("认证失败"), { providerStatus: 401 })),
    "revoked",
  );
  assert.equal(
    connectionStatusAfterTestFailure(Object.assign(new Error("invalid API key"), { providerStatus: 403 })),
    "revoked",
  );
});

test("connection test rejects an unavailable planner opening route", async () => {
  const provider = await startFakeModelProvider({ routeStatusByModel: { "planner-test": 403 } });
  try {
    await assert.rejects(
      () => testConnection(provider.connection, readFakeModelSecret),
      /planner.*403.*planner-test access denied/i,
    );
  } finally {
    await provider.close();
  }
});

test("connection test rejects an unavailable extractor opening route", async () => {
  const provider = await startFakeModelProvider({ routeStatusByModel: { "extractor-test": 403 } });
  try {
    await assert.rejects(
      () => testConnection(provider.connection, readFakeModelSecret),
      /extractor.*403.*extractor-test access denied/i,
    );
  } finally {
    await provider.close();
  }
});

test("connection test rejects whitespace-only content from a mandatory opening route", async () => {
  const provider = await startFakeModelProvider({ routeContentByModel: { "planner-test": "   \n\t" } });
  try {
    await assert.rejects(
      () => testConnection(provider.connection, readFakeModelSecret),
      /planner.*200.*没有可用内容/i,
    );
  } finally {
    await provider.close();
  }
});

test("connection test probes a shared mandatory opening model only once", async () => {
  const provider = await startFakeModelProvider();
  provider.connection.routes = {
    ...provider.connection.routes,
    planner: "shared-opening-model",
    writer: "shared-opening-model",
    extractor: "shared-opening-model",
  };
  try {
    await testConnection(provider.connection, readFakeModelSecret);
    assert.deepEqual(provider.mandatoryProbeModels(), ["shared-opening-model"]);
  } finally {
    await provider.close();
  }
});

test("connection test reports a writer timeout when the response body stalls", async (context) => {
  const provider = await startFakeModelProvider({ writerHeadersOnly: true });
  try {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const testResult = testConnection(provider.connection, readFakeModelSecret);
    await provider.writerHeadersSent;
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    context.mock.timers.tick(90_000);
    await assert.rejects(testResult, /writer.*超时（90 秒）/i);
  } finally {
    context.mock.timers.reset();
    await provider.close();
  }
});

test("connection test limits simultaneous capability probes to two", async () => {
  const provider = await startFakeModelProvider({ responseDelayMs: 40, writerDelayMs: 40 });
  try {
    await testConnection(provider.connection, readFakeModelSecret);
    assert.equal(provider.maxConcurrentRequests(), 2);
  } finally {
    await provider.close();
  }
});

test("fresh production seed refuses a public default admin password", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    assert.throws(() => createSeedStore(), /BOOTSTRAP_ADMIN_PASSWORD/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousPassword === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    else process.env.BOOTSTRAP_ADMIN_PASSWORD = previousPassword;
  }
});

test("structured gates reject unsupported knowledge, invalid item reuse, and wrong death participants", () => {
  const store = createSeedStore();
  const story = structuredClone(store.stories.find((item) => item.id === "story_black_tide")!);
  const safeDrafts = [
    { creativeAxis: "证词偏差", event: "周砚核对一份新证词", cause: "时间记录矛盾", cost: "公开来源", impact: "旧案推进", novelty: "证词顺序变化" },
    { creativeAxis: "深海空间", event: "周砚检查潮门外侧", cause: "警报异常", cost: "离开保护区", impact: "找到坐标", novelty: "空间反转" },
    { creativeAxis: "身份注销", event: "何静川撤销一份通行证", cause: "身份记录冲突", cost: "失去盟友", impact: "封锁升级", novelty: "制度成为阻力" },
  ];
  const knowledgeDrafts = structuredClone(safeDrafts);
  knowledgeDrafts[0].event = "周砚早已知道月球背面的密码";
  const knowledgePlan = planNextChapter(story, knowledgeDrafts);
  assert.equal(knowledgePlan.candidates.find((candidate) => candidate.event.includes("月球"))?.score, 0);

  const lastEventId = story.events.filter((event) => event.active && event.branchId === story.activeBranchId).at(-1)!.id;
  const impossibleDrafts = safeDrafts.map((draft) => ({
    ...draft,
    participantNames: ["周砚"],
    storyTime: "第19章·场景1",
    dependsOnEventIds: [lastEventId],
    knowledgeClaims: [] as Array<{ characterName: string; fact: string; sourceRevisionId?: string }>,
    knowledgeAudit: { complete: true, dependencies: [] as Array<{ characterName: string; fact: string }> },
    itemTransitions: [] as Array<{ itemName: string; actorName: string; fromStatus: "available"; toStatus: "held" }>,
  }));
  impossibleDrafts[0].event = "周砚借助月球背面密文找到隐藏入口并打开潮门";
  impossibleDrafts[0].knowledgeAudit.dependencies = [{ characterName: "周砚", fact: "月球背面密文" }];
  impossibleDrafts[1].event = "周砚循着月球背面刻痕找到隐藏入口";
  impossibleDrafts[1].knowledgeAudit.dependencies = [{ characterName: "周砚", fact: "月球背面刻痕" }];
  impossibleDrafts[2] = {
    ...impossibleDrafts[2],
    event: "周砚记得潮门将在三日后失效，随即关闭一扇漏水舱门",
    cause: "水压突然升高",
    cost: "暂时离开安全区",
    impact: "阻止舱室继续进水",
    novelty: "环境压力成为选择",
    knowledgeClaims: [{ characterName: "周砚", fact: "潮门将在三日后失效", sourceRevisionId: "rev_black_16_1" }],
    knowledgeAudit: { complete: true, dependencies: [{ characterName: "周砚", fact: "潮门将在三日后失效" }] },
  };
  const impossiblePlan = planNextChapter(story, impossibleDrafts);
  const impossibleCandidate = impossiblePlan.candidates.find((candidate) => candidate.event.includes("月球背面"));
  assert.equal(impossibleCandidate?.score, 0);
  assert.match(impossibleCandidate?.reasons.join(" ") ?? "", /knowledgeClaim|徽章/);
  assert.equal(impossiblePlan.candidates.find((candidate) => candidate.event.includes("刻痕"))?.score, 0);

  const unrelatedClaimDrafts = structuredClone(impossibleDrafts);
  unrelatedClaimDrafts[0].event = "周砚确认潮门将在三日后失效，又循着月球背面谜面找到隐藏入口";
  unrelatedClaimDrafts[0].knowledgeClaims = [{ characterName: "周砚", fact: "潮门将在三日后失效", sourceRevisionId: "rev_black_16_1" }];
  unrelatedClaimDrafts[0].knowledgeAudit = { complete: true, dependencies: [{ characterName: "周砚", fact: "潮门将在三日后失效" }, { characterName: "周砚", fact: "月球背面谜面" }] };
  const unrelatedClaimPlan = planNextChapter(story, unrelatedClaimDrafts);
  assert.equal(unrelatedClaimPlan.candidates.find((candidate) => candidate.event.includes("谜面"))?.score, 0);

  const semanticDrafts = Array.from({ length: 3 }, (_, index) => ({
    creativeAxis: `语义正史${index}`,
    event: `周砚依据三日后失效的潮门时限，与新任守门人${index}当场调整封锁顺序`,
    cause: "潮压正在升高",
    cost: "公开原有安排",
    impact: "封锁顺序立即改变",
    novelty: "让既有时限直接推动现场行动",
    participantNames: ["周砚", `新任守门人${index}`],
    storyTime: "事故后的第三日",
    dependsOnEventIds: [lastEventId],
    knowledgeClaims: [{ characterName: "周砚", fact: "潮门将在三日后失效", sourceRevisionId: "rev_black_16_1" }],
    knowledgeAudit: { complete: true, dependencies: [{ characterName: "周砚", fact: "潮门将在三日后失效" }] },
    itemTransitions: [{
      itemName: `新制潮门钥匙${index}`,
      actorName: `新任守门人${index}`,
      fromStatus: "available" as const,
      toStatus: "held" as const,
    }],
  }));
  const semanticPlan = planNextChapter(story, semanticDrafts);
  assert.ok(semanticPlan.candidates.some((candidate) => candidate.score > 0));

  const badge = story.items.find((item) => item.name === "王室旧徽章")!;
  badge.status = "destroyed";
  badge.holderCharacterId = undefined;
  story.characters.find((character) => character.id === "char_lin_xia")!.inventoryItemIds = [];
  const itemDrafts = structuredClone(safeDrafts);
  itemDrafts[0].event = "周砚拿出王室旧徽章并再次启动潮门";
  const itemPlan = planNextChapter(story, itemDrafts);
  assert.equal(itemPlan.candidates.find((candidate) => candidate.event.includes("旧徽章"))?.score, 0);

  const generated = { title: "误报", paragraphs: ["何静川站在门口。周砚死亡。", "潮声停下。", "记录仍在。", "本章收束。", "代价保留。"], model: "test" };
  const before = story.characters.find((character) => character.name === "何静川")!.lifecycle;
  applyExtractedCharacterState(story, { events: [], characterUpdates: [{ name: "何静川", status: "死亡" }] }, generated);
  assert.equal(story.characters.find((character) => character.name === "何静川")!.lifecycle, before);
  const extractedEvent = eventFromChapter(story, 19, "rev_test", itemPlan, {
    type: "death", title: "何静川死亡", cause: "误报", outcome: "死亡", participantNames: ["何静川"],
  }, generated);
  assert.equal(extractedEvent.type, "choice");
  assert.deepEqual(extractedEvent.participantIds, []);
});

test("chapter minimum length and minimal retcon are enforced without a paragraph maximum", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  const plan = planNextChapter(story, undefined, "compact");
  assert.equal(chapterParagraphCountIsAllowed(3), false);
  assert.equal(chapterParagraphCountIsAllowed(24), true);
  assert.equal(chapterParagraphCountIsAllowed(25), true);
  const excessiveParagraphs = Math.ceil(plan.targetParagraphs * 1.5) + 1;
  const detailed = generateLocalChapter(story, plan);
  while (detailed.paragraphs.length < excessiveParagraphs) {
    detailed.paragraphs.push("潮声撞上堤岸后重新退去，守门人逐项核对现场变化，并把可以验证的结果告诉仍在等待的人。");
  }
  assert.doesNotThrow(() => validateGeneratedChapter(story, detailed, plan));

  const death = story.events.find((event) => event.type === "death" && event.active)!;
  const chapter = story.chapters.find((item) => item.number === death.chapterNumber)!;
  currentRevision(chapter)!.paragraphs.splice(
    1,
    0,
    "白布盖过周砚与林夏的脸，警报仍在响。",
    "周砚死亡，林夏抱着他的遗物继续前进。",
    "周砚用白布盖过林夏的脸，随后封锁现场。",
    "林夏把周砚的脸用白布盖过，随后独自离开。",
    "白布盖过林夏与周砚的脸，潮声仍在响。",
  );
  const before = [...currentRevision(chapter)!.paragraphs];
  handleReaderMessage(store, story, "不，我不希望林夏死。", {
    chapterId: chapter.id,
    revisionId: currentRevision(chapter)!.id,
    eventId: death.id,
  });
  const after = currentRevision(chapter)!.paragraphs;
  assert.equal(after.length, before.length);
  assert.equal(after[0], before[0]);
  assert.ok(before.filter((paragraph, index) => paragraph === after[index]).length >= 1);
  assert.ok(after.includes("周砚死亡，林夏抱着他的遗物继续前进。"));
  assert.ok(after.includes("林夏把周砚的脸用白布盖过，随后独自离开。"));
  assert.ok(after.some((paragraph) => paragraph.includes("白布盖过周砚的脸；") && paragraph.includes("警报仍在响")));
  assert.ok(after.some((paragraph) => paragraph.includes("白布盖过周砚的脸；") && paragraph.includes("潮声仍在响")));
  assert.ok(after.every((paragraph) => !paragraph.includes("白布盖过林夏")));
  assert.doesNotMatch(after.join(""), /曲线(?:已经)?归零|白布盖过林夏|最后一点体温|确认死亡/);
  const activeSummaries = story.summaries.filter((summary) => summary.branchId === story.activeBranchId);
  assert.ok(activeSummaries.some((summary) => summary.sourceRevisionIds.includes(currentRevision(chapter)!.id)));
  assert.ok(activeSummaries.every((summary) => !summary.text.includes("复仇对象")));
  assert.ok(retrieveRelevantMemory(story, "周砚 复仇对象").every((memory) => !memory.text.includes("复仇对象")));
});

test("branch conversation context is summarized with bounded source ranges", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  for (let index = 0; index < 7; index += 1) {
    handleReaderMessage(store, story, `我想继续关注第 ${index + 1} 条证词。`);
  }
  const context = buildConversationContext(story);
  const thread = story.conversationThreads.find((item) => item.branchId === story.activeBranchId)!;
  assert.ok(thread.summary);
  assert.ok(thread.summary!.fromMessageId);
  assert.ok(thread.summary!.toMessageId);
  assert.ok(context.sourceMessageIds.length > 0);
  assert.ok(context.recentMessages.length <= 4);
  assert.ok(context.estimatedTokens < 1_200);
  assert.ok(thread.summaries.length >= 2);
  assert.equal(thread.summaries.at(-1)?.parentSummaryId, thread.summaries.at(-2)?.id);
  assert.equal(thread.summaries.at(-1)?.sourceThreadId, thread.id);
});

test("memory retrieval excludes active events from superseded branches", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  story.events.push({
    id: "event_old_branch_secret",
    chapterNumber: 18,
    revisionId: "rev_old_branch_secret",
    type: "consequence",
    title: "旧分支葬礼秘密",
    cause: "旧分支残留",
    outcome: "不应进入当前记忆",
    participantIds: [],
    location: "旧分支",
    dependsOn: [],
    active: true,
    sequence: 999,
    storyTime: "旧分支·场景1",
    branchId: "branch_superseded_test",
  });
  const memories = retrieveRelevantMemory(story, "葬礼秘密");
  assert.ok(memories.every((memory) => memory.sourceId !== "event_old_branch_secret"));
});

test("blocked automated safety decisions create an appealable review target", () => {
  const store = createSeedStore();
  const decision = recordSafetyDecision(store, "user_demo", "reader_message", "请指导我自杀的具体步骤", "story_black_tide");
  const report = store.contentReports.find((item) => item.safetyDecisionId === decision.id);
  assert.equal(decision.decision, "blocked");
  assert.equal(report?.status, "submitted");
  assert.equal(report?.reporterUserId, "user_demo");
});

test("delayed death veto forks a branch and preserves the former branch revision heads", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  const death = story.events.find((event) => event.type === "death" && event.active)!;
  const deathChapter = story.chapters.find((chapter) => chapter.number === death.chapterNumber)!;
  const formerBranch = story.branches.find((branch) => branch.id === story.activeBranchId)!;
  const formerDeathRevision = deathChapter.currentRevisionId;
  story.characters.find((character) => character.id === "char_zhou_yan")!.goal = "为林夏复仇";
  let dependencyId = death.id;
  for (let number = 19; number <= 22; number += 1) {
    const revisionId = `rev_delayed_${number}`;
    const chapterId = `chapter_delayed_${number}`;
    story.chapters.push({
      id: chapterId,
      number,
      title: `后续 ${number}`,
      currentRevisionId: revisionId,
      revisions: [{ id: revisionId, parentRevisionId: null, title: `后续 ${number}`, paragraphs: ["无关场景保持不变。", "周砚继续追查旧案。"], reason: "测试后续", createdAt: new Date().toISOString(), modelName: "test", promptVersion: "test", branchId: formerBranch.id }],
      estimatedMinutes: 2,
    });
    formerBranch.chapterRevisionIds[chapterId] = revisionId;
    const eventId = `event_delayed_${number}`;
    story.events.push({
      id: eventId,
      chapterNumber: number,
      revisionId,
      type: "consequence",
      title: `后续 ${number}`,
      cause: number === 19 ? "林夏死亡后留下的空缺" : "前序影响",
      outcome: number === 19 ? "周砚决定为林夏复仇" : "继续追查",
      participantIds: ["char_zhou_yan"],
      location: "海底城",
      dependsOn: [dependencyId],
      active: true,
      sequence: number,
      storyTime: `第${number}章·场景1`,
      branchId: formerBranch.id,
      stateEffects: number === 19 ? { characters: [{ characterId: "char_zhou_yan", goal: "为林夏复仇" }] } : undefined,
    });
    dependencyId = eventId;
  }
  story.canonVersion += 4;
  formerBranch.headCanonVersion = story.canonVersion;
  const response = handleReaderMessage(store, story, "不，我不希望林夏死。", {
    chapterId: deathChapter.id,
    revisionId: deathChapter.currentRevisionId,
    eventId: death.id,
  });
  assert.ok(response.retconId);
  assert.notEqual(story.activeBranchId, formerBranch.id);
  assert.equal(formerBranch.chapterRevisionIds[deathChapter.id], formerDeathRevision);
  const fork = story.branches.find((branch) => branch.id === story.activeBranchId)!;
  assert.notEqual(fork.chapterRevisionIds[deathChapter.id], formerDeathRevision);
  assert.equal(fork.baseEventSequence, formerBranch.baseEventSequence);
  assert.equal(formerBranch.stateSnapshot?.characters.find((character) => character.id === "char_lin_xia")?.lifecycle, "dead");
  assert.equal(fork.stateSnapshot?.characters.find((character) => character.id === "char_lin_xia")?.lifecycle, "alive");
  assert.notEqual(story.characters.find((character) => character.id === "char_zhou_yan")?.goal, "为林夏复仇");
  const rewrittenDependent = story.events.find((event) => event.branchId === fork.id && event.sequence === 19)!;
  assert.equal(rewrittenDependent.stateEffects, undefined);
  assert.doesNotMatch(`${rewrittenDependent.title}${rewrittenDependent.cause}${rewrittenDependent.outcome}`, /林夏死亡|为林夏复仇/);
  const forkSummaries = story.summaries.filter((summary) => summary.branchId === fork.id);
  assert.ok(forkSummaries.length > 0);
  assert.ok(forkSummaries.every((summary) => !summary.text.includes("复仇对象")));
  assert.deepEqual(new Set(story.retcons[0].changes.filter((change) => change.chapterNumber >= 19 && change.chapterNumber <= 22).map((change) => change.chapterNumber)), new Set([19, 20, 21, 22]));
  const once = structuredClone(fork.stateSnapshot);
  replayBranchState(story, fork.id);
  assert.deepEqual(fork.stateSnapshot, once);
  const branchMessages = story.conversation.filter((message) => message.branchId === fork.id);
  assert.equal(branchMessages.at(-2)?.role, "user");
  assert.equal(branchMessages.at(-1)?.role, "system");
  const forkDeath = story.events.find((event) => event.id === story.retcons[0].targetEventId)!;
  const forkSurvival = story.events.find((event) => event.branchId === fork.id && event.type === "survival")!;
  assert.ok(story.events.filter((event) => event.active && event.branchId === fork.id).every((event) => !event.dependsOn.includes(forkDeath.id)));
  assert.ok(story.events.filter((event) => event.active && event.branchId === fork.id && event.sequence > forkSurvival.sequence).some((event) => event.dependsOn.includes(forkSurvival.id)));
  rollbackRetcon(story, response.retconId!);
  assert.equal(story.activeBranchId, formerBranch.id);
  assert.equal(story.characters.find((character) => character.id === "char_lin_xia")?.lifecycle, "dead");
  assert.equal(formerBranch.stateSnapshot?.characters.find((character) => character.id === "char_lin_xia")?.lifecycle, "dead");
  assert.equal(forkDeath.active, false);
  assert.equal(forkSurvival.active, true);
});
