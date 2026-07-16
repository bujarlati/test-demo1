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
  assertReadingExperienceEvidence,
  assertReadingExperienceNegativeInvariants,
  buildChapterPrompt,
  buildConversationContext,
  endingContractSatisfied,
  eventFromChapter,
  generateLocalChapter,
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
import { listGenerationModelOptions } from "../server/modelConnectionAccess";
import {
  assertGenerationTokenBudget,
  CHAPTER_EXTRACTION_ADMISSION_RESERVE,
  CONTINUATION_JOB_TOKEN_BUDGET,
} from "../server/generationBudget";
import { accumulateModelUsage, attachModelUsage, recordFailedJobUsage } from "../server/modelUsage";
import { refineReadingExperienceContract, usesExperienceWordAsLiteralLabel } from "../server/readingExperience";
import { composeCustomTone, isStoryTone, STORY_GENRES, STORY_LENGTH_OPTIONS, STORY_TONES } from "../src/storyConfig";
import { currentRevision } from "../src/storyDomain";
import type { GenerationJob, ModelConnection } from "../src/types";

interface FakeModelProviderOptions {
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
      activeRequests += 1;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        max_tokens?: number;
        messages?: Array<{ content?: string }>;
        model?: string;
        stream?: boolean;
      };
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
          } else if (request.url === "/embeddings") {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
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
  let writerAttempts = 0;
  const generated = await generateStoryOpeningWithConnection({
    input: { genre: "都市", tone: "机械 · 奶爸", inspiration: "退役机甲师带女儿守住维修铺" },
    contract: base.readingExperience,
    targetChapterCount: base.targetChapterCount,
  }, connection, async ({ model }) => {
    calledModels.push(model);
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
});

test("opening generation retries a draft outside the required paragraph range before review", async () => {
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

  assert.equal(writerAttempts, 2);
  assert.deepEqual(calledModels, ["planner-route", "writer-route", "writer-route", "reviewer-route"]);
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
      assert.equal(error.usageTokens, 1_234);
      assert.equal(error.usageEstimated, false);
      return /Schema/.test(error.message);
    },
  );
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
    expected: { tokens?: number; estimated: boolean; message: RegExp },
  ) => {
    await assert.rejects(
      () => completeJson(
        connection,
        "writer",
        "system prompt",
        "user prompt",
        1_000,
        40,
        { secretReader: async () => "test-key", modelFetcher: async () => response },
      ),
      (error: Error & { usageTokens?: number; usageEstimated?: boolean }) => {
        assert.match(error.message, expected.message);
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
    new Response("upstream unavailable", { status: 503 }),
    { estimated: true, message: /503/ },
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
    { tokens: 23, estimated: false, message: /没有返回可用内容/ },
  );
  await assertFailureUsage(
    new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }], usage: { total_tokens: 37 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    { tokens: 37, estimated: false, message: /不是可修复的 JSON/ },
  );
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

  assert.equal(requestBodies[0].response_format, undefined);
  assert.deepEqual(requestBodies[1].response_format, { type: "json_object" });
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
    itemTransitions: [],
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

test("streaming ignores non-positive provider usage and falls back to a positive estimate", async () => {
  const connection: ModelConnection = {
    id: "conn_stream_usage",
    name: "Stream usage",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://stream-usage",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: { streaming: true, jsonSchema: false, embedding: false, promptCache: false, toolCalling: false, maxContextTokens: null, testedAt: new Date().toISOString(), latencyMs: 1, models: ["writer"] },
    updatedAt: new Date().toISOString(),
  };
  const content = JSON.stringify({ title: "chapter", paragraphs: ["one", "two", "three", "four"] });
  const responseBody = `data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { total_tokens: -500 } })}\n\ndata: [DONE]\n\n`;
  let observedStreamTimeout: number | undefined;

  const result = await streamChapterWithConnection(connection, "prompt", () => undefined, 2_000, {
    secretReader: async () => "test-key",
    modelFetcher: async (_connection, _apiKey, _pathname, _init, timeout) => {
      observedStreamTimeout = timeout;
      return new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  assert.ok(result.usageTokens && result.usageTokens > 0);
  assert.equal(result.usageEstimated, true);
  assert.equal(observedStreamTimeout, 300_000);

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
        usageTokens: 6_500,
        usageEstimated: false,
      };
    }, 7_000),
    (error: Error & { usageTokens?: number }) => {
      assert.match(error.message, /剩余 Token.*审计.*未启动/);
      assert.equal(error.usageTokens, 6_500);
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
    }, 9_000),
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

  for (const plan of [compact, standard, immersive]) {
    const generated = generateLocalChapter(story, plan);
    const characterCount = generated.paragraphs.join("").replace(/\s/g, "").length;
    assert.ok(characterCount >= plan.minCharacters);
    assert.ok(characterCount <= plan.maxCharacters);
    assert.doesNotThrow(() => validateGeneratedChapter(story, generated, plan));
  }
  assert.throws(() => validateGeneratedChapter(story, {
    title: "被填空的短章",
    paragraphs: Array.from({ length: standard.targetParagraphs }, (_, index) => `第 ${index + 1} 段。`),
    model: "test",
  }, standard), /字数/);
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
  assert.doesNotThrow(() => assertImmersiveNarration("他从书架取下小说，翻到夹着书签的一页。"));
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

test("invincible validation binds the dominant victory to the protagonist", () => {
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
    /无敌|落败|压倒性|胜利/,
  );

  const systemEvidence = {
    axisId: "primary" as const,
    word: "系统",
    signalIds: [contract.axes[0].observableSignals[0].id],
    quote: "主角的系统面板发放永久奖励并保持运行",
  };
  for (const falseVictory of [
    "主角对敌人扬言自己会击败所有人，但战斗还没有开始",
    "敌人看着主角，主角无法反抗",
    "主角林越看着敌人一招击败宗门长老",
    "主角在梦中一击镇压敌人，醒来便向现实中的对手投降",
    "主角没能一击击败敌人，反而被对手逼退",
    "主角在幻觉里一击镇压敌人，清醒后对手毫发无损",
    "主角差点一击击败敌人，最终却只能逃走",
    "主角本可以一击击败敌人，但他没有出手",
    "主角一击并未击败敌人，反被对手轰飞",
    "主角一击击败敌人的画面只是系统模拟",
    "主角看着同伴抬手一击镇压敌人，全场无人能够反抗",
    "主角命令护卫一掌轰飞对手，对方毫无还手之力",
    "主角躲在师父身后，只见师父一剑斩杀强者",
    "主角请来高手，那名高手弹指镇压敌人",
    "主角命令兄长一掌镇压敌人，全场无人能够反抗",
    "主角让师兄抬手一击轰飞对手，对方毫无还手之力",
    "主角躲在父亲身后，只见父亲一剑斩杀强者",
  ]) {
    const falseContent = `主角的系统面板发放永久奖励并保持运行。${falseVictory}。`;
    assert.throws(() => assertReadingExperienceEvidence(contract, falseContent, [
      systemEvidence,
      {
        axisId: "secondary",
        word: "无敌",
        signalIds: [contract.axes[1].observableSignals[0].id],
        quote: falseVictory,
      },
    ], { protagonistNames: ["主角"] }), /无敌|落败|压倒性|胜利/);
  }

  for (const chapterWithEarlierDefeat of [
    "主角被真正的对手连打十拳，口吐鲜血，只能狼狈逃走",
    "主角被对手打得吐血，险些丧命，好友出手将他救走",
    "主角跪在对手面前，请求对方放自己一条生路",
    "主角面对强敌毫无办法，只得躲在同伴身后",
    "主角与强敌大战三百回合才勉强取胜",
    "主角被魔头一招打败，当场吐血",
    "主角输给了宗门长老",
    "主角战败后被同伴抬走",
    "主角败下阵来，断了一条手臂",
    "主角被敌人一拳打成重伤",
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
    assert.throws(() => assertReadingExperienceEvidence(contract, noConflictContent, [
      systemEvidence,
      {
        axisId: "secondary",
        word: "无敌",
        signalIds: [contract.axes[1].observableSignals[0].id],
        quote: noOpponentVictory,
      },
    ], { protagonistNames: ["主角"] }), /无敌|压倒性|胜利/);
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
  const firstVolumeTurn = storyArcPhase(49, 1_000);
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
    context.mock.timers.tick(30_000);
    await assert.rejects(testResult, /writer.*超时（30 秒）/i);
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

test("chapter length and minimal retcon are enforced without replacing independent scenes", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  const plan = planNextChapter(story, undefined, "compact");
  assert.throws(() => validateGeneratedChapter(story, {
    title: "过长章节",
    paragraphs: Array.from({ length: plan.targetParagraphs + 2 }, (_, index) => `第 ${index + 1} 段保持完整。`),
    model: "test",
  }, plan), /偏离目标/);

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
