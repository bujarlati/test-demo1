import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { ModelConnection } from "../src/types";
import {
  generateChapterWithConnection,
  testConnection,
} from "./modelGateway";
import { loadStore, saveStore } from "./storage";
import {
  buildChapterPrompt,
  commitNextChapter,
  createStory,
  handleReaderMessage,
  rollbackRetcon,
  summarizeStory,
  toggleCharacterProtection,
} from "./storyService";
import { storeSecret } from "./vault";

const app = express();
const store = await loadStore();
const port = Number(process.env.PORT ?? 8787);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..");

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

function storyOrThrow(id: string) {
  const story = store.stories.find((item) => item.id === id);
  if (!story) {
    const error = new Error("故事不存在。");
    Object.assign(error, { status: 404 });
    throw error;
  }
  return story;
}

function connectionOrThrow(id: string) {
  const connection = store.connections.find((item) => item.id === id);
  if (!connection) {
    const error = new Error("模型连接不存在。");
    Object.assign(error, { status: 404 });
    throw error;
  }
  return connection;
}

async function persist() {
  await saveStore(store);
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
  apiKey: z.string().min(1).max(500),
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

app.get("/api/bootstrap", (_request, response) => {
  response.json({
    user: store.user,
    stories: store.stories
      .filter((story) => story.status !== "archived")
      .map(summarizeStory)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    activeStoryId: store.user.activeStoryId,
  });
});

app.get("/api/stories/:storyId", (request, response) => {
  const story = storyOrThrow(request.params.storyId);
  store.user.activeStoryId = story.id;
  response.json(story);
});

app.post("/api/stories", async (request, response) => {
  const input = createStorySchema.parse(request.body);
  const story = createStory(input);
  story.modelConnectionId = store.user.defaultConnectionId;
  store.stories.unshift(story);
  store.user.activeStoryId = story.id;
  store.metrics.activeStories += 1;
  await persist();
  response.status(201).json(story);
});

app.post("/api/stories/:storyId/chapters/generate", async (request, response) => {
  const story = storyOrThrow(request.params.storyId);
  const body = z
    .object({ idempotencyKey: z.string().min(8).max(120) })
    .parse(request.body);
  if (store.idempotencyKeys.includes(body.idempotencyKey)) {
    response.json({ story, chapter: story.chapters.at(-1), duplicate: true });
    return;
  }
  store.idempotencyKeys.push(body.idempotencyKey);
  store.idempotencyKeys = store.idempotencyKeys.slice(-200);

  const connectionId = story.modelConnectionId ?? store.user.defaultConnectionId;
  const connection = connectionOrThrow(connectionId);
  let generated: { title: string; paragraphs: string[]; model: string } | undefined;
  const startedAt = performance.now();
  try {
    if (connection.ownerScope !== "platform") {
      if (connection.status !== "active") {
        throw new Error("当前自定义模型连接不可用，且默认不静默回退平台模型。");
      }
      generated = await generateChapterWithConnection(connection, buildChapterPrompt(story));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    const chapter = commitNextChapter(story, generated);
    store.jobs.unshift({
      id: `job_${randomUUID().slice(0, 7)}`,
      storyTitle: story.title,
      chapterNumber: chapter.number,
      task: "chapter",
      model: generated?.model ?? connection.routes.writer,
      status: "completed",
      tokens: generated ? 7320 : 5280,
      latencyMs: Math.round(performance.now() - startedAt),
      cost: connection.ownerScope === "platform" ? 0.37 : 0,
      createdAt: new Date().toISOString(),
    });
    await persist();
    response.status(201).json({ story, chapter, duplicate: false });
  } catch (error) {
    store.idempotencyKeys = store.idempotencyKeys.filter((key) => key !== body.idempotencyKey);
    store.jobs.unshift({
      id: `job_${randomUUID().slice(0, 7)}`,
      storyTitle: story.title,
      chapterNumber: (story.chapters.at(-1)?.number ?? 0) + 1,
      task: "chapter",
      model: connection.routes.writer,
      status: "failed",
      tokens: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      cost: 0,
      createdAt: new Date().toISOString(),
    });
    await persist();
    throw error;
  }
});

app.post("/api/stories/:storyId/messages", async (request, response) => {
  const story = storyOrThrow(request.params.storyId);
  const body = z
    .object({
      message: z.string().trim().min(1).max(500),
      branchId: z.string().min(1),
      baseCanonVersion: z.number().int().positive(),
      idempotencyKey: z.string().min(8).max(120),
    })
    .parse(request.body);
  if (body.branchId !== story.activeBranchId) {
    response.status(409).json({ message: "活动分支已变化，请刷新后重新提交。" });
    return;
  }
  if (body.baseCanonVersion !== story.canonVersion) {
    response.status(409).json({ message: "正史版本已更新，请在最新章节重新确认。" });
    return;
  }
  if (store.idempotencyKeys.includes(body.idempotencyKey)) {
    response.json({ story, duplicate: true });
    return;
  }
  store.idempotencyKeys.push(body.idempotencyKey);
  const message = handleReaderMessage(store, story, body.message);
  await persist();
  response.status(201).json({ story, message, duplicate: false });
});

app.put("/api/stories/:storyId/reading-progress", async (request, response) => {
  const story = storyOrThrow(request.params.storyId);
  const body = z
    .object({
      chapterId: z.string().min(1),
      scrollProgress: z.number().min(0).max(1),
    })
    .parse(request.body);
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
  store.user.activeStoryId = story.id;
  await persist();
  response.status(204).end();
});

app.post(
  "/api/stories/:storyId/characters/:characterId/protection",
  async (request, response) => {
    const character = toggleCharacterProtection(
      storyOrThrow(request.params.storyId),
      request.params.characterId,
    );
    await persist();
    response.json(character);
  },
);

app.post("/api/stories/:storyId/retcons/:retconId/rollback", async (request, response) => {
  const story = storyOrThrow(request.params.storyId);
  const retcon = rollbackRetcon(story, request.params.retconId);
  await persist();
  response.json({ story, retcon });
});

app.post("/api/stories/:storyId/canon-changes/read", async (request, response) => {
  const story = storyOrThrow(request.params.storyId);
  story.unreadCanonChanges = 0;
  story.chapters.forEach((chapter) => {
    chapter.hasUnreadRevision = false;
  });
  await persist();
  response.status(204).end();
});

app.get("/api/model-connections", (_request, response) => {
  response.json({
    connections: store.connections,
    defaultConnectionId: store.user.defaultConnectionId,
  });
});

app.post("/api/model-connections", async (request, response) => {
  const input = modelConnectionSchema.parse(request.body);
  const parsedUrl = new URL(input.baseUrl);
  const hostname = parsedUrl.hostname.toLowerCase();
  if (parsedUrl.protocol !== "https:" && process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS !== "true") {
    response.status(400).json({ message: "SaaS 模式仅允许 HTTPS 模型地址。" });
    return;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "169.254.169.254") {
    response.status(400).json({ message: "本地或云元数据地址已被安全策略阻止。" });
    return;
  }
  const id = `conn_${randomUUID().slice(0, 8)}`;
  const secretRef = await storeSecret(id, input.apiKey);
  const connection: ModelConnection = {
    id,
    name: input.name,
    ownerScope: "user",
    protocol: "openai_compatible",
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    maskedKey: `${input.apiKey.slice(0, 3)}${"•".repeat(Math.min(12, input.apiKey.length))}${input.apiKey.slice(-3)}`,
    secretRef,
    status: "draft",
    routes: input.routes,
    fallbackPolicy: input.fallbackPolicy,
    capabilities: null,
    updatedAt: new Date().toISOString(),
  };
  store.connections.push(connection);
  await persist();
  response.status(201).json(connection);
});

app.post("/api/model-connections/:connectionId/test", async (request, response) => {
  const connection = connectionOrThrow(request.params.connectionId);
  if (connection.ownerScope === "platform") {
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
    await persist();
    response.json(connection);
  } catch (error) {
    const message = error instanceof Error ? error.message : "连接测试失败。";
    connection.status = /401|403|凭据/.test(message) ? "revoked" : "degraded";
    connection.lastError = message;
    connection.updatedAt = new Date().toISOString();
    await persist();
    response.status(422).json({ message, connection });
  }
});

app.post("/api/model-connections/:connectionId/default", async (request, response) => {
  const connection = connectionOrThrow(request.params.connectionId);
  if (connection.status !== "active") {
    response.status(409).json({ message: "只有已通过测试的连接可以设为默认。" });
    return;
  }
  store.user.defaultConnectionId = connection.id;
  await persist();
  response.json({ defaultConnectionId: connection.id });
});

app.get("/api/ops", (_request, response) => {
  response.json({ metrics: store.metrics, jobs: store.jobs.slice(0, 20) });
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

app.use(
  (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({
        message: "提交内容不完整或格式不正确。",
        issues: error.issues,
      });
      return;
    }
    const status =
      error instanceof Error && "status" in error && typeof error.status === "number"
        ? error.status
        : 500;
    const message = error instanceof Error ? error.message : "服务器处理失败。";
    console.error(`[api] ${message}`);
    response.status(status).json({ message });
  },
);

app.listen(port, "127.0.0.1", () => {
  console.log(`Xumo API listening on http://127.0.0.1:${port}`);
});
