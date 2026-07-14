import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { ModelConnection, UserAccount } from "../src/types";
import { audit, authenticate, login, publicUser, requireAdmin, type AuthLocals } from "./auth";
import {
  assertSafeEndpoint,
  extractChapterStateWithConnection,
  generateCandidateDraftsWithConnection,
  generateChapterWithConnection,
  testConnection,
} from "./modelGateway";
import {
  buildChapterPrompt,
  generateLocalChapter,
  planNextChapter,
  type GenerationPlan,
  type GeneratedChapter,
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
const port = Number(process.env.PORT ?? 8787);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..");
const generationLocks = new Set<string>();
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
  const story = storyOrThrow(storyId, user);
  if (body.branchId !== story.activeBranchId || body.baseCanonVersion !== story.canonVersion) {
    const error = new Error("正史或活动分支已更新，请刷新后重试。");
    Object.assign(error, { status: 409 });
    throw error;
  }
  const scopedKey = `${user.id}:${body.idempotencyKey}`;
  if (store.idempotencyKeys.includes(scopedKey)) {
    return { story, chapter: story.chapters.at(-1)!, duplicate: true };
  }
  if (generationLocks.has(story.id)) {
    const error = new Error("这个故事已有续章作业在运行，请等待当前作业完成。");
    Object.assign(error, { status: 409 });
    throw error;
  }
  generationLocks.add(story.id);
  store.idempotencyKeys.push(scopedKey);
  store.idempotencyKeys = store.idempotencyKeys.slice(-500);
  const connectionId = story.modelConnectionId ?? user.defaultConnectionId;
  const connection = connectionOrThrow(connectionId, user);
  const startedAt = performance.now();
  let plan: GenerationPlan | undefined;
  let generated: GeneratedChapter | undefined;
  let effectiveConnection = connection;
  let isManagedLocal = connection.secretRef.startsWith("platform://managed");
  try {
    emit("stage", { stage: 0, label: "组装当前正史与相关记忆" });
    const runRoutes = async () => {
      const externalDrafts = isManagedLocal
        ? undefined
        : await generateCandidateDraftsWithConnection(effectiveConnection, story);
      plan = planNextChapter(story, externalDrafts);
      emit("stage", { stage: 1, label: `生成 ${plan.candidates.length} 个短剧情胶囊` });
      emit("stage", { stage: 2, label: plan.filterSummary });
      const prompt = buildChapterPrompt(story, plan);
      generated = isManagedLocal
        ? generateLocalChapter(story, plan)
        : await generateChapterWithConnection(effectiveConnection, prompt);
      if (!isManagedLocal) await extractChapterStateWithConnection(effectiveConnection, generated);
    };
    try {
      await runRoutes();
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
      audit(store, user.id, "generation.explicit-fallback", "generation", story.id, {
        fromConnectionId: connection.id,
        toConnectionId: effectiveConnection.id,
        policy: connection.fallbackPolicy,
      });
      await runRoutes();
    }
    if (!plan || !generated) throw new Error("生成管线没有产生可提交的章节。");
    emit("stage", { stage: 3, label: "入选方案扩写完成，正在逐段提交" });
    for (const [index, paragraph] of generated.paragraphs.entries()) {
      emit("paragraph", { index, title: generated.title, paragraph });
      if (isManagedLocal) await new Promise((resolve) => setTimeout(resolve, 90));
    }
    const chapter = commitNextChapter(story, plan, generated);
    emit("stage", { stage: 4, label: "事件已提取并提交为不可变 Revision" });
    store.jobs.unshift({
      id: `job_${randomUUID().slice(0, 8)}`,
      storyTitle: story.title,
      chapterNumber: chapter.number,
      task: "chapter",
      model: effectiveConnection.routes.writer,
      connectionId: effectiveConnection.id,
      promptVersion: "story-v8",
      status: "completed",
      tokens: isManagedLocal ? 5280 : 7320,
      latencyMs: Math.round(performance.now() - startedAt),
      cost: isManagedLocal ? 0.37 : 0,
      createdAt: new Date().toISOString(),
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
    await persist();
    return { story, chapter, duplicate: false };
  } catch (error) {
    store.idempotencyKeys = store.idempotencyKeys.filter((key) => key !== scopedKey);
    store.jobs.unshift({
      id: `job_${randomUUID().slice(0, 8)}`,
      storyTitle: story.title,
      chapterNumber: (story.chapters.at(-1)?.number ?? 0) + 1,
      task: "chapter",
      model: connection.routes.writer,
      connectionId: connection.id,
      promptVersion: "story-v8",
      status: "failed",
      tokens: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      cost: 0,
      createdAt: new Date().toISOString(),
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
    generationLocks.delete(story.id);
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
  const story = storyOrThrow(request.params.storyId, user);
  const body = z.object({
    message: z.string().trim().min(1).max(500),
    branchId: z.string().min(1),
    baseCanonVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(120),
  }).parse(request.body);
  if (body.branchId !== story.activeBranchId || body.baseCanonVersion !== story.canonVersion) {
    response.status(409).json({ message: "正史或活动分支已更新，请刷新后重新提交。" });
    return;
  }
  const scopedKey = `${user.id}:${body.idempotencyKey}`;
  if (store.idempotencyKeys.includes(scopedKey)) {
    response.json({ story, duplicate: true });
    return;
  }
  store.idempotencyKeys.push(scopedKey);
  const message = handleReaderMessage(store, story, body.message);
  audit(store, user.id, "retcon.message", "retcon", message.retconId ?? message.id, {
    storyId: story.id,
    changedCanon: Boolean(message.retconId),
  });
  await persist();
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
  const story = storyOrThrow(request.params.storyId, user);
  const retcon = rollbackRetcon(story, request.params.retconId);
  audit(store, user.id, "retcon.rollback", "retcon", retcon.id, {
    storyId: story.id,
    reverses: request.params.retconId,
  });
  await persist();
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
