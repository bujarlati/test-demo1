import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { ContentReport, GenerationJob, ModelConnection, OpsMetrics, OpsQualityBucket, Story, UserAccount } from "../src/types";
import { audit, authenticate, login, publicUser, requireAdmin, type AuthLocals } from "./auth";
import {
  assertSafeEndpoint,
  extractChapterStateWithConnection,
  generateCandidateDraftsWithConnection,
  generateChapterWithConnection,
  streamChapterWithConnection,
  testConnection,
} from "./modelGateway";
import {
  buildChapterPrompt,
  generateLocalChapter,
  planNextChapter,
  type GenerationPlan,
  type GeneratedChapter,
  type ExtractedChapterState,
} from "./narrativeEngine";
import { handleReaderMessage, rollbackRetcon } from "./retconService";
import { loadStore, saveStore } from "./storage";
import {
  commitNextChapter,
  createStory,
  summarizeStory,
  toggleCharacterProtection,
} from "./storyService";
import { deleteSecrets, storeSecret } from "./vault";
import { assertSafetyAllowed, recordSafetyDecision, safetyCategories } from "./safetyService";

const app = express();
const store = await loadStore();
const interruptedJobs = store.jobs.filter((job) => job.status === "running");
if (interruptedJobs.length > 0) {
  for (const job of interruptedJobs) {
    job.status = "failed";
    job.filterSummary = "服务重启中断了这次生成，正史没有提交；可以安全重试。";
    if (job.idempotencyKey) {
      const scopedKey = `${job.ownerId}:${job.idempotencyKey}`;
      store.idempotencyKeys = store.idempotencyKeys.filter((key) => key !== scopedKey);
    }
  }
  await saveStore(store);
}
const port = Number(process.env.PORT ?? 8787);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..");
const storyMutationLocks = new Set<string>();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const JOB_TOKEN_BUDGET = 12_000;
const USER_DAILY_TOKEN_BUDGET = 120_000;
const STORY_DAILY_TOKEN_BUDGET = 60_000;

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

async function persist() {
  await saveStore(store);
}

function currentUser(response: Response) {
  return (response.locals as AuthLocals).user;
}

function maskApiKey(apiKey: string) {
  return `${apiKey.slice(0, 2)}${"•".repeat(8)}${apiKey.slice(-2)}`;
}

function storyOrThrow(id: string, user: UserAccount) {
  const story = store.stories.find((item) => item.id === id && item.ownerId === user.id);
  if (!story) {
    const error = new Error("故事不存在或不属于当前账号。");
    Object.assign(error, { status: 404 });
    throw error;
  }
  return story;
}

function storyIndexOrThrow(id: string) {
  const index = store.stories.findIndex((story) => story.id === id);
  if (index < 0) {
    const error = new Error("故事在提交期间已不存在。");
    Object.assign(error, { status: 409 });
    throw error;
  }
  return index;
}

function connectionOrThrow(id: string, user: UserAccount) {
  const connection = store.connections.find(
    (item) => item.id === id && (item.ownerScope === "platform" || item.ownerId === user.id),
  );
  if (!connection) {
    const error = new Error("模型连接不存在或无权访问。");
    Object.assign(error, { status: 404 });
    throw error;
  }
  return connection;
}

function assertCanonCommand(
  story: ReturnType<typeof storyOrThrow>,
  command: { branchId: string; baseCanonVersion: number },
) {
  if (
    command.branchId !== story.activeBranchId ||
    command.baseCanonVersion !== story.canonVersion
  ) {
    const error = new Error("正史或活动分支已更新，请刷新后重试。");
    Object.assign(error, { status: 409 });
    throw error;
  }
}

function reserveIdempotencyKey(userId: string, idempotencyKey: string) {
  const scopedKey = `${userId}:${idempotencyKey}`;
  if (store.idempotencyKeys.includes(scopedKey)) return { duplicate: true, scopedKey };
  store.idempotencyKeys.push(scopedKey);
  store.idempotencyKeys = store.idempotencyKeys.slice(-500);
  return { duplicate: false, scopedKey };
}

function hasIdempotencyKey(userId: string, idempotencyKey: string) {
  return store.idempotencyKeys.includes(`${userId}:${idempotencyKey}`);
}

function mergeConcurrentReaderState(next: Story, baseline: Story, current: Story) {
  const generatedProgressVersion = next.readingProgress.progressVersion;
  const hadConcurrentProgressWrite = current.readingProgress.progressVersion !== baseline.readingProgress.progressVersion;
  next.readingProgress = structuredClone(current.readingProgress);
  next.readingProgress.activeBranchId = next.activeBranchId;
  next.readingProgress.canonVersion = next.canonVersion;
  next.readingProgress.progressVersion = Math.max(current.readingProgress.progressVersion, generatedProgressVersion) + (hadConcurrentProgressWrite ? 1 : 0);
  next.readingProgress.updatedAt = new Date().toISOString();
  const newUnreadChanges = Math.max(0, next.unreadCanonChanges - baseline.unreadCanonChanges);
  next.unreadCanonChanges = current.unreadCanonChanges + newUnreadChanges;
  for (const chapter of next.chapters) {
    const baselineChapter = baseline.chapters.find((item) => item.id === chapter.id);
    const currentChapter = current.chapters.find((item) => item.id === chapter.id);
    if (
      baselineChapter &&
      currentChapter &&
      chapter.currentRevisionId === baselineChapter.currentRevisionId &&
      currentChapter.currentRevisionId === baselineChapter.currentRevisionId
    ) {
      chapter.hasUnreadRevision = currentChapter.hasUnreadRevision;
    }
  }
}

function assertTokenBudget(userId: string, storyId: string) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  const recent = store.jobs.filter((job) => Date.parse(job.createdAt) >= cutoff);
  const reserved = (job: GenerationJob) => job.status === "running" ? (job.tokenBudget ?? JOB_TOKEN_BUDGET) : job.tokens;
  const userTokens = recent.filter((job) => job.ownerId === userId).reduce((total, job) => total + reserved(job), 0);
  const storyTokens = recent.filter((job) => job.storyId === storyId).reduce((total, job) => total + reserved(job), 0);
  if (userTokens + JOB_TOKEN_BUDGET > USER_DAILY_TOKEN_BUDGET || storyTokens + JOB_TOKEN_BUDGET > STORY_DAILY_TOKEN_BUDGET) {
    const error = new Error("已达到 24 小时生成预算上限。正史不受影响，请稍后再试。");
    Object.assign(error, { status: 429 });
    throw error;
  }
}

function calculateOpsMetrics(): OpsMetrics {
  const chapterJobs = store.jobs.filter((job) => job.task === "chapter" && job.status !== "running");
  const observedChapters = chapterJobs.filter((job) => job.acceptedAt || job.rejectedAt);
  const completedChapters = observedChapters.filter((job) => job.acceptedAt && !job.rejectedAt);
  const retconJobs = store.jobs.filter((job) => job.task === "retcon" && job.status === "completed" && job.retconId);
  const successfulRetcons = retconJobs.filter((job) => {
    const story = store.stories.find((item) => item.id === job.storyId);
    const transaction = story?.retcons.find((retcon) => retcon.id === job.retconId);
    if (!story || !transaction || transaction.status !== "committed") return false;
    return !story.proposals.some((proposal) =>
      proposal.createdAt > transaction.createdAt &&
      proposal.targetEventId === job.targetEventId &&
      (proposal.status === "committed" || proposal.status === "reversed"),
    );
  });
  const candidates = store.jobs.flatMap((job) => job.candidateTrace ?? []);
  const hardConflicts = candidates.filter((candidate) => candidate.score === 0 && candidate.reasons.some((reason) => /违反|硬约束|状态|安全/.test(reason)));
  const firstTokenSamples = completedChapters
    .map((job) => job.firstTokenMs)
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
    .sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(firstTokenSamples.length * 0.95) - 1);
  return {
    acceptedChapterRate: observedChapters.length ? completedChapters.length / observedChapters.length : 0,
    retconSuccessRate: retconJobs.length ? successfulRetcons.length / retconJobs.length : 0,
    canonConflictRate: candidates.length ? hardConflicts.length / candidates.length : 0,
    firstTokenP95: firstTokenSamples.length ? Number((firstTokenSamples[p95Index] / 1_000).toFixed(1)) : 0,
    firstTokenSampleCount: firstTokenSamples.length,
    acceptedChapterCost: completedChapters.length
      ? Number((completedChapters.reduce((total, acceptedJob) => total + store.jobs
          .filter((job) => job.storyId === acceptedJob.storyId && job.chapterNumber === acceptedJob.chapterNumber)
          .reduce((subtotal, job) => subtotal + job.cost, 0), 0) / completedChapters.length).toFixed(4))
      : 0,
    acceptedChapterCostEstimated: completedChapters.some((acceptedJob) => store.jobs.some((job) => job.storyId === acceptedJob.storyId && job.chapterNumber === acceptedJob.chapterNumber && job.costEstimated)),
    activeStories: store.stories.filter((story) => story.status === "active").length,
  };
}

function calculateQualityBreakdown(): OpsQualityBucket[] {
  const buckets = new Map<string, OpsQualityBucket>();
  for (const job of store.jobs) {
    const story = store.stories.find((item) => item.id === job.storyId);
    const genre = story?.genre ?? "未知";
    const key = `${job.model}|${job.promptVersion}|${genre}`;
    const bucket = buckets.get(key) ?? {
      key,
      model: job.model,
      promptVersion: job.promptVersion,
      genre,
      jobs: 0,
      completed: 0,
      blockedCandidates: 0,
      reports: 0,
    };
    bucket.jobs += 1;
    if (job.status === "completed") bucket.completed += 1;
    bucket.blockedCandidates += (job.candidateTrace ?? []).filter((candidate) => candidate.score === 0).length;
    buckets.set(key, bucket);
  }
  for (const report of store.contentReports) {
    const story = report.storyId ? store.stories.find((item) => item.id === report.storyId) : undefined;
    const chapterNumber = report.chapterId ? story?.chapters.find((chapter) => chapter.id === report.chapterId)?.number : undefined;
    const job = store.jobs.find((item) => item.storyId === report.storyId && (chapterNumber === undefined || item.chapterNumber === chapterNumber));
    if (!job) continue;
    const bucket = buckets.get(`${job.model}|${job.promptVersion}|${story?.genre ?? "未知"}`);
    if (bucket) bucket.reports += 1;
  }
  return [...buckets.values()].sort((a, b) => b.jobs - a.jobs).slice(0, 20);
}

const createStorySchema = z.object({
  genre: z.string().min(1).max(30),
  tone: z.string().max(40).optional(),
  length: z.string().max(40).optional(),
  inspiration: z.string().max(180).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

const modelConnectionSchema = z.object({
  name: z.string().min(1).max(50),
  baseUrl: z.string().url(),
  apiKey: z.string().min(8).max(500),
  routes: z.object({
    planner: z.string().min(1).max(100),
    writer: z.string().min(1).max(100),
    extractor: z.string().min(1).max(100),
    embedding: z.string().min(1).max(100),
  }),
  fallbackPolicy: z.enum(["none", "same_connection", "platform_managed"]),
});
const modelConnectionUpdateSchema = modelConnectionSchema.partial().refine((value) => Object.keys(value).length > 0, "至少提供一个更新字段");

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "xumo-api" });
});

app.post("/api/auth/login", async (request, response) => {
  const key = request.ip ?? "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (attempt && attempt.resetAt > now && attempt.count >= 8) {
    response.status(429).json({ message: "登录尝试过多，请稍后再试。" });
    return;
  }
  const body = z.object({ email: z.string().email(), password: z.string().min(8).max(200) }).parse(request.body);
  const result = login(store, body.email, body.password);
  if (!result) {
    loginAttempts.set(key, {
      count: attempt && attempt.resetAt > now ? attempt.count + 1 : 1,
      resetAt: now + 10 * 60 * 1000,
    });
    response.status(401).json({ message: "邮箱或密码不正确。" });
    return;
  }
  loginAttempts.delete(key);
  await persist();
  response.json(result);
});

app.use("/api", authenticate(store));

app.post("/api/auth/logout", async (request, response) => {
  const header = request.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(token).digest("hex");
  store.sessions = store.sessions.filter((session) => session.tokenHash !== hash);
  audit(store, currentUser(response).id, "auth.logout", "auth", currentUser(response).id);
  await persist();
  response.status(204).end();
});

app.get("/api/bootstrap", (_request, response) => {
  const user = currentUser(response);
  response.json({
    user: publicUser(user),
    stories: store.stories
      .filter((story) => story.ownerId === user.id && story.status !== "archived")
      .map(summarizeStory)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    activeStoryId: user.activeStoryId,
    pendingJobs: store.jobs.filter((job) => job.ownerId === user.id && job.status === "running"),
    recoverableJobs: store.jobs.filter(
      (job) => job.ownerId === user.id && job.status === "failed" && job.filterSummary?.includes("可以安全重试"),
    ).slice(0, 3),
  });
});

app.get("/api/stories/:storyId", async (request, response) => {
  const user = currentUser(response);
  const story = storyOrThrow(request.params.storyId, user);
  user.activeStoryId = story.id;
  await persist();
  response.json(story);
});

app.post("/api/stories", async (request, response) => {
  const user = currentUser(response);
  const input = createStorySchema.parse(request.body);
  const idempotencyKey = input.idempotencyKey ?? request.header("idempotency-key") ?? randomUUID();
  const priorRequest = store.storyCreationRequests.find((item) => item.userId === user.id && item.idempotencyKey === idempotencyKey);
  if (priorRequest) {
    const priorStory = store.stories.find((story) => story.id === priorRequest.storyId && story.ownerId === user.id);
    if (priorStory) {
      response.json(priorStory);
      return;
    }
  }
  const safety = recordSafetyDecision(
    store,
    user.id,
    "story_input",
    `${input.genre} ${input.tone ?? ""} ${input.inspiration ?? ""}`,
  );
  audit(store, user.id, `safety.${safety.decision}`, "story", "new-story", { surface: safety.surface });
  await persist();
  assertSafetyAllowed(safety);
  const reservation = reserveIdempotencyKey(user.id, idempotencyKey);
  if (reservation.duplicate) {
    const duplicateRequest = store.storyCreationRequests.find((item) => item.userId === user.id && item.idempotencyKey === idempotencyKey);
    const duplicateStory = duplicateRequest ? store.stories.find((story) => story.id === duplicateRequest.storyId) : undefined;
    if (duplicateStory) {
      response.json(duplicateStory);
      return;
    }
    response.status(409).json({ message: "相同开书请求正在提交，请安全重试同一幂等键。" });
    return;
  }
  const story = createStory(input, user.id);
  story.modelConnectionId = user.defaultConnectionId;
  store.stories.unshift(story);
  user.activeStoryId = story.id;
  store.storyCreationRequests.push({ userId: user.id, idempotencyKey, storyId: story.id, createdAt: new Date().toISOString() });
  store.storyCreationRequests = store.storyCreationRequests.slice(-500);
  audit(store, user.id, "story.create", "story", story.id, { genre: story.genre });
  await persist();
  response.status(201).json(story);
});

interface GenerationResult {
  story: ReturnType<typeof storyOrThrow>;
  chapter: ReturnType<typeof commitNextChapter>;
  duplicate: boolean;
}

function duplicateGenerationResult(story: Story, userId: string, idempotencyKey: string): GenerationResult {
  const priorJob = store.jobs.find(
    (job) => job.ownerId === userId && job.storyId === story.id && job.idempotencyKey === idempotencyKey && job.status === "completed",
  );
  const chapter = priorJob
    ? story.chapters.find((item) => item.number === priorJob.chapterNumber)
    : story.chapters.at(-1);
  if (!chapter) throw new Error("幂等请求对应的章节不存在。");
  return { story, chapter, duplicate: true };
}

async function generateChapter(
  storyId: string,
  user: UserAccount,
  body: { idempotencyKey: string; branchId: string; baseCanonVersion: number; chapterLength: "compact" | "standard" | "immersive" },
  emit: (event: string, payload: unknown) => void,
): Promise<GenerationResult> {
  const storedStory = storyOrThrow(storyId, user);
  if (storedStory.status !== "active") {
    const error = new Error(storedStory.status === "paused" ? "故事已暂停；恢复连载后才能生成下一章。" : "这个故事已结束或归档，不能继续生成。");
    Object.assign(error, { status: 409 });
    throw error;
  }
  if (storyMutationLocks.has(storedStory.id)) {
    const error = new Error("这个故事已有续章作业在运行，请等待当前作业完成。");
    Object.assign(error, { status: 409 });
    throw error;
  }
  if (hasIdempotencyKey(user.id, body.idempotencyKey)) {
    return duplicateGenerationResult(storedStory, user.id, body.idempotencyKey);
  }
  assertCanonCommand(storedStory, body);
  const previousChapterNumber = storedStory.chapters.at(-1)?.number;
  const previousChapterJob = previousChapterNumber === undefined ? undefined : store.jobs.find(
    (job) => job.ownerId === user.id && job.storyId === storedStory.id && job.task === "chapter" && job.chapterNumber === previousChapterNumber && job.status === "completed" && !job.acceptedAt && !job.rejectedAt,
  );
  if (previousChapterJob) {
    previousChapterJob.acceptedAt = new Date().toISOString();
    previousChapterJob.acceptanceSignal = "continued_generation";
  }
  assertTokenBudget(user.id, storedStory.id);
  const connectionId = storedStory.modelConnectionId ?? user.defaultConnectionId;
  const connection = connectionOrThrow(connectionId, user);
  if (connection.status !== "active") {
    const error = new Error(`模型连接当前为 ${connection.status}，请先更新凭据并重新测试；不会静默切换供应商。`);
    Object.assign(error, { status: 409 });
    throw error;
  }
  const reservation = reserveIdempotencyKey(user.id, body.idempotencyKey);
  if (reservation.duplicate) return duplicateGenerationResult(storedStory, user.id, body.idempotencyKey);
  storyMutationLocks.add(storedStory.id);
  const baselineStory = structuredClone(storedStory);
  const story = structuredClone(baselineStory);
  const startedAt = performance.now();
  const job: GenerationJob = {
    id: `job_${randomUUID().slice(0, 8)}`,
    ownerId: user.id,
    storyId: story.id,
    idempotencyKey: body.idempotencyKey,
    storyTitle: story.title,
    chapterNumber: (story.chapters.at(-1)?.number ?? 0) + 1,
    task: "chapter",
    model: connection.routes.writer,
    connectionId: connection.id,
    promptVersion: "story-v8",
    status: "running",
    tokens: 0,
    tokenBudget: JOB_TOKEN_BUDGET,
    usageEstimated: false,
    budgetDegraded: false,
    latencyMs: 0,
    cost: 0,
    costEstimated: true,
    createdAt: new Date().toISOString(),
    filterSummary: "正在组装正史上下文与候选剧情。",
  };
  store.jobs.unshift(job);
  audit(store, user.id, "generation.start", "generation", job.id, {
    storyId: story.id,
    connectionId: connection.id,
    chapterNumber: job.chapterNumber,
  });
  let plan: GenerationPlan | undefined;
  let generated: GeneratedChapter | undefined;
  let extracted: ExtractedChapterState | undefined;
  let usedTokens = 0;
  let usageEstimated = false;
  let budgetDegraded = false;
  let streamedParagraphCount = 0;
  let firstTokenMs: number | undefined;
  let effectiveConnection = connection;
  let isManagedLocal = connection.secretRef.startsWith("platform://managed");
  try {
    await persist();
    emit("stage", { stage: 0, label: "组装当前正史与相关记忆" });
    const runGenerationPipeline = async () => {
      const candidateBatch = isManagedLocal
        ? undefined
        : await generateCandidateDraftsWithConnection(effectiveConnection, story);
      if (candidateBatch) {
        usedTokens += candidateBatch.usageTokens;
        usageEstimated ||= candidateBatch.usageEstimated;
      }
      const candidateDrafts = candidateBatch?.candidates;
      if (candidateDrafts && usedTokens > JOB_TOKEN_BUDGET * 0.2) {
        candidateDrafts.splice(3);
        budgetDegraded = true;
      }
      const crossStoryRecentAxes = store.stories
        .filter((item) => item.ownerId === user.id && item.id !== story.id)
        .flatMap((item) => item.events.filter((event) => event.active && event.branchId === item.activeBranchId).slice(-8).map((event) => event.creativeAxis))
        .filter((axis): axis is string => Boolean(axis));
      plan = planNextChapter(story, candidateDrafts, body.chapterLength, crossStoryRecentAxes);
      for (const candidate of plan.candidates) {
        recordSafetyDecision(
          store,
          user.id,
          "candidate",
          `${candidate.event} ${candidate.cause} ${candidate.cost} ${candidate.impact}`,
          story.id,
        );
      }
      emit("stage", { stage: 1, label: `生成 ${plan.candidates.length} 个短剧情胶囊` });
      emit("stage", { stage: 2, label: plan.filterSummary });
      const prompt = buildChapterPrompt(story, plan);
      const promptTokenEstimate = Math.ceil(prompt.length / 2);
      const writerTokenBudget = Math.min(6_500, JOB_TOKEN_BUDGET - usedTokens - promptTokenEstimate - 1_500);
      if (!isManagedLocal && writerTokenBudget < 2_000) {
        throw new Error("候选与上下文已接近 Token 上限，未启动正文调用；可以缩短章节后重试。");
      }
      if (isManagedLocal) {
        generated = generateLocalChapter(story, plan);
      } else if (effectiveConnection.capabilities?.streaming) {
        generated = await streamChapterWithConnection(
          effectiveConnection,
          prompt,
          (paragraph, index, title) => {
            if (safetyCategories(paragraph).length > 0) {
              const decision = recordSafetyDecision(store, user.id, "chapter_output", paragraph, story.id);
              streamedParagraphCount = 0;
              emit("reset_draft", { reason: "流式正文触发安全策略，草稿已撤回且不会提交正史。" });
              assertSafetyAllowed(decision);
            }
            streamedParagraphCount = index + 1;
            firstTokenMs ??= Math.round(performance.now() - startedAt);
            emit("paragraph", { index, title, paragraph });
          },
          writerTokenBudget,
        );
      } else {
        generated = await generateChapterWithConnection(effectiveConnection, prompt, writerTokenBudget);
      }
      if (isManagedLocal) {
        usedTokens += Math.ceil(generated.paragraphs.join("\n").length / 2);
        usageEstimated = true;
      } else {
        usedTokens += generated.usageTokens ?? 0;
        usageEstimated ||= generated.usageEstimated ?? true;
      }
      const extractionInputEstimate = Math.ceil((generated.title.length + generated.paragraphs.join("\n").length) / 2);
      if (!isManagedLocal && usedTokens + extractionInputEstimate + 1_500 <= JOB_TOKEN_BUDGET) {
        extracted = await extractChapterStateWithConnection(effectiveConnection, generated);
        usedTokens += extracted.usageTokens ?? 0;
        usageEstimated ||= extracted.usageEstimated ?? true;
      } else if (!isManagedLocal) {
        extracted = undefined;
        budgetDegraded = true;
      }
      if (usedTokens > JOB_TOKEN_BUDGET) throw new Error("本次作业超过 12,000 Token 上限，未提交正史。");
    };
    try {
      await runGenerationPipeline();
    } catch (routeError) {
      if (routeError instanceof Error && "status" in routeError && routeError.status === 422) throw routeError;
      if (connection.fallbackPolicy === "none") throw routeError;
      if (connection.fallbackPolicy === "same_connection") {
        effectiveConnection = {
          ...connection,
          routes: {
            ...connection.routes,
            planner: connection.routes.writer,
            extractor: connection.routes.writer,
          },
        };
      } else {
        effectiveConnection = connectionOrThrow("conn_platform", user);
        isManagedLocal = true;
      }
      emit("stage", {
        stage: 0,
        label: `已按预授权策略切换至${connection.fallbackPolicy === "same_connection" ? "同连接正文模型" : "平台托管连接"}`,
      });
      if (streamedParagraphCount > 0) {
        streamedParagraphCount = 0;
        emit("reset_draft", { reason: "原连接中断，已按预授权回退策略重新生成。" });
      }
      audit(store, user.id, "generation.explicit-fallback", "generation", story.id, {
        fromConnectionId: connection.id,
        toConnectionId: effectiveConnection.id,
        policy: connection.fallbackPolicy,
      });
      await runGenerationPipeline();
    }
    if (!plan || !generated) throw new Error("生成管线没有产生可提交的章节。");
    const outputSafety = recordSafetyDecision(
      store,
      user.id,
      "chapter_output",
      `${generated.title}\n${generated.paragraphs.join("\n")}`,
      story.id,
    );
    assertSafetyAllowed(outputSafety);
    emit("stage", { stage: 3, label: "入选方案扩写完成，正在逐段提交" });
    for (const [index, paragraph] of generated.paragraphs.entries()) {
      if (index < streamedParagraphCount) continue;
      firstTokenMs ??= Math.round(performance.now() - startedAt);
      emit("paragraph", { index, title: generated.title, paragraph });
      if (isManagedLocal) await new Promise((resolve) => setTimeout(resolve, 90));
    }
    const chapter = commitNextChapter(story, plan, generated, extracted);
    emit("stage", { stage: 4, label: "事件已提取并提交为不可变 Revision" });
    Object.assign(job, {
      chapterNumber: chapter.number,
      model: effectiveConnection.routes.writer,
      connectionId: effectiveConnection.id,
      status: "completed" as const,
      tokens: usedTokens,
      usageEstimated,
      budgetDegraded,
      latencyMs: Math.round(performance.now() - startedAt),
      firstTokenMs: firstTokenMs ?? Math.round(performance.now() - startedAt),
      cost: Number(((usedTokens / 1_000_000) * (isManagedLocal ? 0.8 : 1.2)).toFixed(4)),
      costEstimated: true,
      candidateTrace: plan.candidates,
      contextTrace: [
        { component: "canon", sourceIds: story.events.filter((event) => event.active).slice(-8).map((event) => event.id), estimatedTokens: 650 },
        { component: "hard_constraints", sourceIds: story.rules.filter((rule) => rule.hardness === "hard").map((rule) => rule.id), estimatedTokens: 220 },
        { component: "recent_chapter", sourceIds: plan.memories.map((memory) => memory.sourceId), estimatedTokens: Math.ceil(plan.memories.reduce((total, memory) => total + memory.text.length, 0) / 2) },
        { component: "conversation_summary", sourceIds: plan.conversationContext.sourceMessageIds, estimatedTokens: Math.ceil(plan.conversationContext.summary.length / 2) },
        { component: "relevant_messages", sourceIds: plan.conversationContext.sourceMessageIds.slice(-7, -4), estimatedTokens: Math.ceil(plan.conversationContext.relevantMessages.join("\n").length / 2) },
        { component: "recent_messages", sourceIds: plan.conversationContext.sourceMessageIds.slice(-4), estimatedTokens: Math.ceil(plan.conversationContext.recentMessages.join("\n").length / 2) },
      ],
      filterSummary: `${plan.filterSummary}${budgetDegraded ? " 已触发预算降级：减少候选或延后状态抽取。" : ""}`,
    });
    audit(store, user.id, "generation.commit", "generation", chapter.id, {
      storyId: story.id,
      connectionId: effectiveConnection.id,
      planner: effectiveConnection.routes.planner,
      writer: effectiveConnection.routes.writer,
      extractor: effectiveConnection.routes.extractor,
    });
    const commitIndex = storyIndexOrThrow(story.id);
    const concurrentStory = store.stories[commitIndex];
    mergeConcurrentReaderState(story, baselineStory, concurrentStory);
    store.stories[commitIndex] = story;
    try {
      await persist();
    } catch (persistError) {
      store.stories[storyIndexOrThrow(story.id)] = concurrentStory;
      throw persistError;
    }
    return { story, chapter, duplicate: false };
  } catch (error) {
    store.idempotencyKeys = store.idempotencyKeys.filter((key) => key !== reservation.scopedKey);
    Object.assign(job, {
      model: effectiveConnection.routes.writer,
      connectionId: effectiveConnection.id,
      status: "failed" as const,
      tokens: usedTokens,
      usageEstimated,
      budgetDegraded,
      latencyMs: Math.round(performance.now() - startedAt),
      cost: Number(((usedTokens / 1_000_000) * (isManagedLocal ? 0.8 : 1.2)).toFixed(4)),
      costEstimated: true,
      candidateTrace: plan?.candidates,
      filterSummary: error instanceof Error ? error.message : "生成失败",
    });
    audit(store, user.id, "generation.failed", "generation", story.id, {
      connectionId: connection.id,
      reason: error instanceof Error ? error.message : "unknown",
    });
    await persist();
    throw error;
  } finally {
    storyMutationLocks.delete(story.id);
  }
}

const generateSchema = z.object({
  idempotencyKey: z.string().min(8).max(120),
  branchId: z.string().min(1),
  baseCanonVersion: z.number().int().positive(),
  chapterLength: z.enum(["compact", "standard", "immersive"]).default("standard"),
});

app.post("/api/stories/:storyId/chapters/generate", async (request, response, next) => {
  const body = generateSchema.parse(request.body);
  const user = currentUser(response);
  const wantsStream = (request.header("accept") ?? "").includes("text/event-stream");
  if (!wantsStream) {
    try {
      response.status(201).json(await generateChapter(request.params.storyId, user, body, () => undefined));
    } catch (error) {
      next(error);
    }
    return;
  }
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  const emit = (event: string, payload: unknown) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  try {
    const result = await generateChapter(request.params.storyId, user, body, emit);
    emit("complete", result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "续章失败。";
    emit("error", { message });
  } finally {
    response.end();
  }
});

app.get("/api/stories/:storyId/messages", (request, response) => {
  const user = currentUser(response);
  const story = storyOrThrow(request.params.storyId, user);
  const branchId = typeof request.query.branchId === "string" ? request.query.branchId : story.activeBranchId;
  if (!story.branches.some((branch) => branch.id === branchId)) {
    response.status(404).json({ message: "对话分支不存在。" });
    return;
  }
  const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 30));
  const branchMessages = story.conversation.filter((message) => message.branchId === branchId);
  const cursor = typeof request.query.cursor === "string" ? request.query.cursor : undefined;
  const cursorIndex = cursor ? branchMessages.findIndex((message) => message.id === cursor) : branchMessages.length;
  const end = cursorIndex < 0 ? branchMessages.length : cursorIndex;
  const items = branchMessages.slice(Math.max(0, end - limit), end);
  response.json({ items, nextCursor: end - limit > 0 ? items[0]?.id ?? null : null });
});

app.post("/api/stories/:storyId/messages", async (request, response) => {
  const user = currentUser(response);
  let storedStory = storyOrThrow(request.params.storyId, user);
  const body = z.object({
    message: z.string().trim().min(1).max(500),
    branchId: z.string().min(1),
    baseCanonVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(120),
    clientContext: z.object({
      chapterId: z.string().min(1),
      revisionId: z.string().min(1),
      selection: z.string().max(500).optional(),
      eventId: z.string().min(1).optional(),
    }).optional(),
  }).parse(request.body);
  const safety = recordSafetyDecision(store, user.id, "reader_message", body.message, storedStory.id);
  audit(store, user.id, `safety.${safety.decision}`, "story", storedStory.id, { surface: safety.surface });
  await persist();
  assertSafetyAllowed(safety);
  storedStory = storyOrThrow(request.params.storyId, user);
  if (storyMutationLocks.has(storedStory.id)) {
    response.status(409).json({ message: "这个故事正在提交另一项正史变更，请稍后重试。" });
    return;
  }
  if (hasIdempotencyKey(user.id, body.idempotencyKey)) {
    response.json({ story: storedStory, duplicate: true });
    return;
  }
  assertCanonCommand(storedStory, body);
  const reservation = reserveIdempotencyKey(user.id, body.idempotencyKey);
  if (reservation.duplicate) {
    response.json({ story: storedStory, duplicate: true });
    return;
  }
  storyMutationLocks.add(storedStory.id);
  const story = structuredClone(storedStory);
  const storyIndex = storyIndexOrThrow(storedStory.id);
  const previousJobs = structuredClone(store.jobs);
  const previousAuditEvents = structuredClone(store.auditEvents);
  let message: ReturnType<typeof handleReaderMessage>;
  try {
    message = handleReaderMessage(store, story, body.message, body.clientContext);
    const proposal = story.proposals[0];
    if (message.retconId || proposal?.scope === "current_event" || proposal?.scope === "current_chapter") {
      const chapterNumber = body.clientContext
        ? story.chapters.find((chapter) => chapter.id === body.clientContext?.chapterId)?.number
        : story.chapters.at(-1)?.number;
      const chapterJob = store.jobs.find((job) => job.storyId === story.id && job.task === "chapter" && job.chapterNumber === chapterNumber && job.status === "completed" && !job.rejectedAt);
      if (chapterJob) {
        chapterJob.rejectedAt = new Date().toISOString();
        chapterJob.acceptedAt = undefined;
        chapterJob.acceptanceSignal = "reader_intervention";
      }
    }
    audit(store, user.id, "retcon.message", "retcon", message.retconId ?? message.id, {
      storyId: story.id,
      changedCanon: Boolean(message.retconId),
    });
    store.stories[storyIndex] = story;
    await persist();
  } catch (error) {
    store.stories[storyIndexOrThrow(storedStory.id)] = storedStory;
    store.jobs = previousJobs;
    store.auditEvents = previousAuditEvents;
    store.idempotencyKeys = store.idempotencyKeys.filter((key) => key !== reservation.scopedKey);
    throw error;
  } finally {
    storyMutationLocks.delete(storedStory.id);
  }
  response.status(201).json({ story, message, duplicate: false });
});

app.put("/api/stories/:storyId/reading-progress", async (request, response) => {
  const user = currentUser(response);
  const story = storyOrThrow(request.params.storyId, user);
  const body = z.object({
    chapterId: z.string().min(1),
    scrollProgress: z.number().min(0).max(1),
    progressVersion: z.number().int().positive(),
    activeBranchId: z.string().min(1),
    canonVersion: z.number().int().positive(),
  }).parse(request.body);
  const chapter = story.chapters.find((item) => item.id === body.chapterId);
  if (!chapter) {
    response.status(400).json({ message: "阅读章节不属于当前故事。" });
    return;
  }
  if (
    body.progressVersion !== story.readingProgress.progressVersion ||
    body.activeBranchId !== story.activeBranchId ||
    body.canonVersion !== story.canonVersion
  ) {
    response.status(409).json({ message: "阅读进度版本已更新，请使用服务器最新进度重试。", readingProgress: story.readingProgress });
    return;
  }
  story.readingProgress = {
    chapterId: chapter.id,
    scrollProgress: body.scrollProgress,
    updatedAt: new Date().toISOString(),
    progressVersion: story.readingProgress.progressVersion + 1,
    activeBranchId: story.activeBranchId,
    canonVersion: story.canonVersion,
  };
  if (body.scrollProgress >= 0.65) {
    const chapterJob = store.jobs.find((job) => job.storyId === story.id && job.task === "chapter" && job.chapterNumber === chapter.number && job.status === "completed" && !job.acceptedAt && !job.rejectedAt);
    if (chapterJob) {
      chapterJob.acceptedAt = new Date().toISOString();
      chapterJob.acceptanceSignal = "read_through";
    }
  }
  user.activeStoryId = story.id;
  await persist();
  response.json(story.readingProgress);
});

app.patch("/api/stories/:storyId/status", async (request, response) => {
  const user = currentUser(response);
  const story = storyOrThrow(request.params.storyId, user);
  const { status } = z.object({ status: z.enum(["active", "paused", "archived"]) }).parse(request.body);
  if (storyMutationLocks.has(story.id)) {
    response.status(409).json({ message: "这个故事正在提交正史变更，请完成后再调整状态。" });
    return;
  }
  if (story.status === "archived") {
    response.status(409).json({ message: "归档是软删除终态；请通过数据恢复流程处理。" });
    return;
  }
  if (status === "active" && story.status !== "paused" && story.status !== "active") {
    response.status(409).json({ message: "只有暂停中的故事可以恢复连载。" });
    return;
  }
  story.status = status;
  story.updatedAt = new Date().toISOString();
  if (status === "archived" && user.activeStoryId === story.id) user.activeStoryId = null;
  else if (status === "active") user.activeStoryId = story.id;
  audit(store, user.id, `story.${status}`, "story", story.id, { softDelete: status === "archived" });
  await persist();
  response.json(story);
});

app.post("/api/stories/:storyId/characters/:characterId/protection", async (request, response) => {
  const user = currentUser(response);
  const story = storyOrThrow(request.params.storyId, user);
  if (storyMutationLocks.has(story.id)) {
    response.status(409).json({ message: "续章或修史正在提交，完成后再修改角色保护。" });
    return;
  }
  const character = toggleCharacterProtection(story, request.params.characterId);
  audit(store, user.id, "story.character-protection", "story", story.id, {
    characterId: character.id,
    protected: character.protected,
  });
  await persist();
  response.json(character);
});

app.post("/api/stories/:storyId/retcons/:retconId/rollback", async (request, response) => {
  const user = currentUser(response);
  const storedStory = storyOrThrow(request.params.storyId, user);
  const body = generateSchema.parse(request.body);
  if (storyMutationLocks.has(storedStory.id)) {
    response.status(409).json({ message: "这个故事正在提交另一项正史变更，请稍后重试。" });
    return;
  }
  if (hasIdempotencyKey(user.id, body.idempotencyKey)) {
    const priorRollback = storedStory.retcons.find(
      (item) => item.kind === "rollback" && item.reversesRetconId === request.params.retconId,
    );
    response.json({ story: storedStory, retcon: priorRollback, duplicate: true });
    return;
  }
  assertCanonCommand(storedStory, body);
  const reservation = reserveIdempotencyKey(user.id, body.idempotencyKey);
  if (reservation.duplicate) {
    response.json({ story: storedStory, duplicate: true });
    return;
  }
  storyMutationLocks.add(storedStory.id);
  const story = structuredClone(storedStory);
  const storyIndex = storyIndexOrThrow(storedStory.id);
  const previousAuditEvents = structuredClone(store.auditEvents);
  let retcon: ReturnType<typeof rollbackRetcon>;
  try {
    retcon = rollbackRetcon(story, request.params.retconId);
    audit(store, user.id, "retcon.rollback", "retcon", retcon.id, {
      storyId: story.id,
      reverses: request.params.retconId,
    });
    store.stories[storyIndex] = story;
    await persist();
  } catch (error) {
    store.stories[storyIndexOrThrow(storedStory.id)] = storedStory;
    store.auditEvents = previousAuditEvents;
    store.idempotencyKeys = store.idempotencyKeys.filter((key) => key !== reservation.scopedKey);
    throw error;
  } finally {
    storyMutationLocks.delete(storedStory.id);
  }
  response.json({ story, retcon });
});

app.post("/api/stories/:storyId/canon-changes/read", async (request, response) => {
  const story = storyOrThrow(request.params.storyId, currentUser(response));
  story.unreadCanonChanges = 0;
  story.chapters.forEach((chapter) => { chapter.hasUnreadRevision = false; });
  await persist();
  response.status(204).end();
});

app.patch("/api/stories/:storyId/preferences/:preferenceId", async (request, response) => {
  const user = currentUser(response);
  const story = storyOrThrow(request.params.storyId, user);
  if (storyMutationLocks.has(story.id)) {
    response.status(409).json({ message: "正史作业运行中，完成后再管理约束。" });
    return;
  }
  const body = z.object({ active: z.boolean() }).parse(request.body);
  const preference = story.preferences.find((item) => item.id === request.params.preferenceId);
  if (!preference) {
    response.status(404).json({ message: "偏好或约束不存在。" });
    return;
  }
  preference.active = body.active;
  if (preference.id.startsWith("protect_")) {
    const character = story.characters.find((item) => item.id === preference.id.slice("protect_".length));
    if (character) character.protected = preference.active;
  }
  audit(store, user.id, "preference.toggle", "story", story.id, { preferenceId: preference.id, active: preference.active });
  await persist();
  response.json(preference);
});

app.delete("/api/stories/:storyId/preferences/:preferenceId", async (request, response) => {
  const user = currentUser(response);
  const story = storyOrThrow(request.params.storyId, user);
  if (storyMutationLocks.has(story.id)) {
    response.status(409).json({ message: "正史作业运行中，完成后再管理约束。" });
    return;
  }
  const index = story.preferences.findIndex((item) => item.id === request.params.preferenceId);
  if (index < 0) {
    response.status(404).json({ message: "偏好或约束不存在。" });
    return;
  }
  const [removed] = story.preferences.splice(index, 1);
  if (removed.id.startsWith("protect_")) {
    const character = story.characters.find((item) => item.id === removed.id.slice("protect_".length));
    if (character) character.protected = false;
  }
  audit(store, user.id, "preference.delete", "story", story.id, { preferenceId: removed.id, kind: removed.kind });
  await persist();
  response.status(204).end();
});

app.get("/api/reports", (request, response) => {
  const user = currentUser(response);
  const storyId = typeof request.query.storyId === "string" ? request.query.storyId : undefined;
  response.json(store.contentReports.filter(
    (report) => report.reporterUserId === user.id && (!storyId || report.storyId === storyId),
  ));
});

app.post("/api/stories/:storyId/reports", async (request, response) => {
  const user = currentUser(response);
  const story = storyOrThrow(request.params.storyId, user);
  const body = z.object({
    chapterId: z.string().min(1),
    reason: z.string().trim().min(3).max(300),
  }).parse(request.body);
  const chapter = story.chapters.find((item) => item.id === body.chapterId);
  if (!chapter) {
    response.status(400).json({ message: "举报章节不属于当前故事。" });
    return;
  }
  const createdAt = new Date().toISOString();
  const report: ContentReport = {
    id: `report_${randomUUID().slice(0, 10)}`,
    reporterUserId: user.id,
    storyId: story.id,
    chapterId: chapter.id,
    revisionId: chapter.currentRevisionId,
    reason: body.reason,
    status: "submitted",
    createdAt,
    updatedAt: createdAt,
  };
  store.contentReports.unshift(report);
  audit(store, user.id, "governance.report", "story", story.id, { reportId: report.id, chapterId: chapter.id });
  await persist();
  response.status(201).json(report);
});

app.post("/api/reports/:reportId/appeal", async (request, response) => {
  const user = currentUser(response);
  const report = store.contentReports.find(
    (item) => item.id === request.params.reportId && item.reporterUserId === user.id,
  );
  if (!report) {
    response.status(404).json({ message: "举报记录不存在。" });
    return;
  }
  report.status = "appealed";
  report.updatedAt = new Date().toISOString();
  audit(store, user.id, "governance.appeal", "story", report.storyId ?? report.safetyDecisionId ?? report.id, { reportId: report.id });
  await persist();
  response.json(report);
});

app.patch("/api/reports/:reportId", requireAdmin, async (request, response) => {
  const user = currentUser(response);
  const report = store.contentReports.find((item) => item.id === request.params.reportId);
  if (!report) {
    response.status(404).json({ message: "举报记录不存在。" });
    return;
  }
  const body = z.object({
    status: z.enum(["reviewing", "resolved"]),
    resolutionNote: z.string().trim().max(300).optional(),
  }).parse(request.body);
  report.status = body.status;
  report.resolutionNote = body.resolutionNote;
  report.updatedAt = new Date().toISOString();
  audit(store, user.id, "governance.review", "story", report.storyId ?? report.safetyDecisionId ?? report.id, { reportId: report.id, status: report.status });
  await persist();
  response.json(report);
});

app.get("/api/model-connections", requireAdmin, (_request, response) => {
  const user = currentUser(response);
  response.json({
    connections: store.connections.filter(
      (connection) => connection.ownerScope === "platform" || connection.ownerId === user.id,
    ),
    defaultConnectionId: user.defaultConnectionId,
  });
});

app.post("/api/model-connections", requireAdmin, async (request, response) => {
  const user = currentUser(response);
  const input = modelConnectionSchema.parse(request.body);
  const id = `conn_${randomUUID().slice(0, 8)}`;
  try {
    await assertSafeEndpoint(input.baseUrl);
  } catch (error) {
    audit(store, user.id, "connection.endpoint-blocked", "connection", id, { hostname: (() => { try { return new URL(input.baseUrl).hostname; } catch { return "invalid"; } })() });
    await persist();
    if (error instanceof Error) Object.assign(error, { status: 422 });
    throw error;
  }
  const secret = await storeSecret(id, input.apiKey);
  const connection: ModelConnection = {
    id,
    name: input.name,
    ownerScope: "platform",
    ownerId: null,
    protocol: "openai_compatible",
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    maskedKey: maskApiKey(input.apiKey),
    secretRef: secret.secretRef,
    secretVersion: secret.version,
    status: "draft",
    routes: input.routes,
    fallbackPolicy: input.fallbackPolicy,
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  store.connections.push(connection);
  audit(store, user.id, "connection.create", "connection", connection.id, {
    baseUrl: connection.baseUrl,
    ownerScope: connection.ownerScope,
  });
  await persist();
  response.status(201).json(connection);
});

app.patch("/api/model-connections/:connectionId", requireAdmin, async (request, response) => {
  const user = currentUser(response);
  const connection = connectionOrThrow(String(request.params.connectionId), user);
  if (connection.secretRef.startsWith("platform://managed")) {
    response.status(409).json({ message: "平台托管连接由部署配置维护，不能在此轮换。" });
    return;
  }
  const input = modelConnectionUpdateSchema.parse(request.body);
  const nextBaseUrl = input.baseUrl ?? connection.baseUrl;
  try {
    await assertSafeEndpoint(nextBaseUrl);
  } catch (error) {
    audit(store, user.id, "connection.endpoint-blocked", "connection", connection.id, { hostname: (() => { try { return new URL(nextBaseUrl).hostname; } catch { return "invalid"; } })() });
    await persist();
    if (error instanceof Error) Object.assign(error, { status: 422 });
    throw error;
  }
  if (input.apiKey) {
    const secret = await storeSecret(connection.id, input.apiKey);
    connection.secretRef = secret.secretRef;
    connection.secretVersion = secret.version;
    connection.maskedKey = maskApiKey(input.apiKey);
  }
  if (input.name) connection.name = input.name;
  if (input.baseUrl) connection.baseUrl = input.baseUrl.replace(/\/$/, "");
  if (input.routes) connection.routes = input.routes;
  if (input.fallbackPolicy) connection.fallbackPolicy = input.fallbackPolicy;
  connection.status = "draft";
  connection.capabilities = null;
  connection.lastError = undefined;
  connection.updatedAt = new Date().toISOString();
  audit(store, user.id, input.apiKey ? "connection.rotate-secret" : "connection.update", "connection", connection.id, { secretVersion: connection.secretVersion });
  await persist();
  response.json(connection);
});

app.delete("/api/model-connections/:connectionId", requireAdmin, async (request, response) => {
  const user = currentUser(response);
  const connection = connectionOrThrow(String(request.params.connectionId), user);
  if (connection.secretRef.startsWith("platform://managed")) {
    response.status(409).json({ message: "平台托管连接不能删除。" });
    return;
  }
  await deleteSecrets(connection.id);
  const fallback = store.connections.find((item) => item.id === "conn_platform")!;
  for (const account of store.users) if (account.defaultConnectionId === connection.id) account.defaultConnectionId = fallback.id;
  for (const story of store.stories) if (story.modelConnectionId === connection.id) story.modelConnectionId = null;
  store.connections = store.connections.filter((item) => item.id !== connection.id);
  audit(store, user.id, "connection.delete", "connection", connection.id, { retainedHistoricalJobReferences: true });
  await persist();
  response.status(204).end();
});

app.post("/api/model-connections/:connectionId/test", requireAdmin, async (request, response) => {
  const user = currentUser(response);
  const connection = connectionOrThrow(String(request.params.connectionId), user);
  if (connection.secretRef.startsWith("platform://managed")) {
    response.json(connection);
    return;
  }
  connection.status = "validating";
  connection.lastError = undefined;
  await persist();
  try {
    connection.capabilities = await testConnection(connection);
    connection.status = "active";
    connection.updatedAt = new Date().toISOString();
    audit(store, user.id, "connection.test-success", "connection", connection.id, {
      streaming: connection.capabilities.streaming,
      jsonSchema: connection.capabilities.jsonSchema,
      embedding: connection.capabilities.embedding,
    });
    await persist();
    response.json(connection);
  } catch (error) {
    const message = error instanceof Error ? error.message : "连接测试失败。";
    connection.status = /401|403|凭据/.test(message) ? "revoked" : "degraded";
    connection.lastError = message;
    connection.updatedAt = new Date().toISOString();
    audit(store, user.id, "connection.test-failed", "connection", connection.id, { reason: message });
    await persist();
    response.status(422).json({ message, connection });
  }
});

app.post("/api/model-connections/:connectionId/default", requireAdmin, async (request, response) => {
  const user = currentUser(response);
  const connection = connectionOrThrow(String(request.params.connectionId), user);
  if (connection.status !== "active") {
    response.status(409).json({ message: "只有已通过测试的连接可以设为默认。" });
    return;
  }
  user.defaultConnectionId = connection.id;
  audit(store, user.id, "connection.set-default", "connection", connection.id);
  await persist();
  response.json({ defaultConnectionId: connection.id });
});

app.get("/api/ops", requireAdmin, (_request, response) => {
  response.json({
    metrics: calculateOpsMetrics(),
    qualityBreakdown: calculateQualityBreakdown(),
    jobs: store.jobs.slice(0, 20),
    auditEvents: store.auditEvents.slice(0, 30),
    reports: store.contentReports.slice(0, 30),
    safetyDecisions: store.safetyDecisions.slice(0, 50),
  });
});

if (process.env.NODE_ENV === "production") {
  const distDirectory = path.join(projectRoot, "dist");
  app.use(express.static(distDirectory));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) {
      next();
      return;
    }
    response.sendFile(path.join(distDirectory, "index.html"));
  });
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    response.status(400).json({ message: "提交内容不完整或格式不正确。", issues: error.issues });
    return;
  }
  const status =
    error instanceof Error && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
  const message = error instanceof Error ? error.message : "服务器处理失败。";
  console.error(`[api] ${message}`);
  const safetyDecisionId = error instanceof Error && "safetyDecisionId" in error && typeof error.safetyDecisionId === "string"
    ? error.safetyDecisionId
    : undefined;
  response.status(status).json({ message, ...(safetyDecisionId ? { safetyDecisionId } : {}) });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Xumo API listening on http://127.0.0.1:${port}`);
});
