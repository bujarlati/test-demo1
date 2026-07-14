import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { GenerationJob, ModelConnection, Story, UserAccount } from "../src/types";
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
import { storeSecret } from "./vault";

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

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

async function persist() {
  await saveStore(store);
}

function currentUser(response: Response) {
  return (response.locals as AuthLocals).user;
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
  next.readingProgress = structuredClone(current.readingProgress);
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

const createStorySchema = z.object({
  genre: z.string().min(1).max(30),
  tone: z.string().max(40).optional(),
  length: z.string().max(40).optional(),
  inspiration: z.string().max(180).optional(),
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
  const story = createStory(input, user.id);
  story.modelConnectionId = user.defaultConnectionId;
  store.stories.unshift(story);
  user.activeStoryId = story.id;
  store.metrics.activeStories += 1;
  audit(store, user.id, "story.create", "story", story.id, { genre: story.genre });
  await persist();
  response.status(201).json(story);
});

interface GenerationResult {
  story: ReturnType<typeof storyOrThrow>;
  chapter: ReturnType<typeof commitNextChapter>;
  duplicate: boolean;
}

async function generateChapter(
  storyId: string,
  user: UserAccount,
  body: { idempotencyKey: string; branchId: string; baseCanonVersion: number },
  emit: (event: string, payload: unknown) => void,
): Promise<GenerationResult> {
  const storedStory = storyOrThrow(storyId, user);
  if (storyMutationLocks.has(storedStory.id)) {
    const error = new Error("这个故事已有续章作业在运行，请等待当前作业完成。");
    Object.assign(error, { status: 409 });
    throw error;
  }
  if (hasIdempotencyKey(user.id, body.idempotencyKey)) {
    return { story: storedStory, chapter: storedStory.chapters.at(-1)!, duplicate: true };
  }
  assertCanonCommand(storedStory, body);
  const connectionId = storedStory.modelConnectionId ?? user.defaultConnectionId;
  const connection = connectionOrThrow(connectionId, user);
  const reservation = reserveIdempotencyKey(user.id, body.idempotencyKey);
  if (reservation.duplicate) return { story: storedStory, chapter: storedStory.chapters.at(-1)!, duplicate: true };
  storyMutationLocks.add(storedStory.id);
  const baselineStory = structuredClone(storedStory);
  const story = structuredClone(baselineStory);
  const storyIndex = store.stories.findIndex((item) => item.id === storedStory.id);
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
    latencyMs: 0,
    cost: 0,
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
  let streamedParagraphCount = 0;
  let effectiveConnection = connection;
  let isManagedLocal = connection.secretRef.startsWith("platform://managed");
  try {
    await persist();
    emit("stage", { stage: 0, label: "组装当前正史与相关记忆" });
    const runGenerationPipeline = async () => {
      const externalDrafts = isManagedLocal
        ? undefined
        : await generateCandidateDraftsWithConnection(effectiveConnection, story);
      plan = planNextChapter(story, externalDrafts);
      emit("stage", { stage: 1, label: `生成 ${plan.candidates.length} 个短剧情胶囊` });
      emit("stage", { stage: 2, label: plan.filterSummary });
      const prompt = buildChapterPrompt(story, plan);
      if (isManagedLocal) {
        generated = generateLocalChapter(story, plan);
      } else if (effectiveConnection.capabilities?.streaming) {
        generated = await streamChapterWithConnection(
          effectiveConnection,
          prompt,
          (paragraph, index, title) => {
            streamedParagraphCount = index + 1;
            emit("paragraph", { index, title, paragraph });
          },
        );
      } else {
        generated = await generateChapterWithConnection(effectiveConnection, prompt);
      }
      extracted = !isManagedLocal
        ? await extractChapterStateWithConnection(effectiveConnection, generated)
        : undefined;
    };
    try {
      await runGenerationPipeline();
    } catch (routeError) {
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
    emit("stage", { stage: 3, label: "入选方案扩写完成，正在逐段提交" });
    for (const [index, paragraph] of generated.paragraphs.entries()) {
      if (index < streamedParagraphCount) continue;
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
      tokens: isManagedLocal ? 5280 : 7320,
      latencyMs: Math.round(performance.now() - startedAt),
      cost: isManagedLocal ? 0.37 : 0,
      candidateTrace: plan.candidates,
      filterSummary: plan.filterSummary,
    });
    audit(store, user.id, "generation.commit", "generation", chapter.id, {
      storyId: story.id,
      connectionId: effectiveConnection.id,
      planner: effectiveConnection.routes.planner,
      writer: effectiveConnection.routes.writer,
      extractor: effectiveConnection.routes.extractor,
    });
    const concurrentStory = store.stories[storyIndex];
    mergeConcurrentReaderState(story, baselineStory, concurrentStory);
    store.stories[storyIndex] = story;
    try {
      await persist();
    } catch (persistError) {
      store.stories[storyIndex] = concurrentStory;
      throw persistError;
    }
    return { story, chapter, duplicate: false };
  } catch (error) {
    store.idempotencyKeys = store.idempotencyKeys.filter((key) => key !== reservation.scopedKey);
    Object.assign(job, {
      model: effectiveConnection.routes.writer,
      connectionId: effectiveConnection.id,
      status: "failed" as const,
      tokens: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      cost: 0,
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

app.post("/api/stories/:storyId/messages", async (request, response) => {
  const user = currentUser(response);
  const storedStory = storyOrThrow(request.params.storyId, user);
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
  const storyIndex = store.stories.findIndex((item) => item.id === storedStory.id);
  const previousJobs = structuredClone(store.jobs);
  const previousAuditEvents = structuredClone(store.auditEvents);
  let message: ReturnType<typeof handleReaderMessage>;
  try {
    message = handleReaderMessage(store, story, body.message, body.clientContext);
    audit(store, user.id, "retcon.message", "retcon", message.retconId ?? message.id, {
      storyId: story.id,
      changedCanon: Boolean(message.retconId),
    });
    store.stories[storyIndex] = story;
    await persist();
  } catch (error) {
    store.stories[storyIndex] = storedStory;
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
  }).parse(request.body);
  const chapter = story.chapters.find((item) => item.id === body.chapterId);
  if (!chapter) {
    response.status(400).json({ message: "阅读章节不属于当前故事。" });
    return;
  }
  story.readingProgress = {
    chapterId: chapter.id,
    scrollProgress: body.scrollProgress,
    updatedAt: new Date().toISOString(),
  };
  user.activeStoryId = story.id;
  await persist();
  response.status(204).end();
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
  const storyIndex = store.stories.findIndex((item) => item.id === storedStory.id);
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
    store.stories[storyIndex] = storedStory;
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
  await assertSafeEndpoint(input.baseUrl);
  const id = `conn_${randomUUID().slice(0, 8)}`;
  const secretRef = await storeSecret(id, input.apiKey);
  const connection: ModelConnection = {
    id,
    name: input.name,
    ownerScope: "platform",
    ownerId: null,
    protocol: "openai_compatible",
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    maskedKey: `${input.apiKey.slice(0, 3)}${"•".repeat(Math.min(12, input.apiKey.length - 6))}${input.apiKey.slice(-3)}`,
    secretRef,
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
    metrics: store.metrics,
    jobs: store.jobs.slice(0, 20),
    auditEvents: store.auditEvents.slice(0, 30),
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
  response.status(status).json({ message });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Xumo API listening on http://127.0.0.1:${port}`);
});
