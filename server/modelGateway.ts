import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { CapabilitySnapshot, EndingContract, ModelConnection, ReadingExperienceContract, ReadingExperienceEvidence, Story } from "../src/types";
import {
  assertImmersiveNarration,
  assertPersistentExperienceFacts,
  assertReadingExperienceEvidence,
  assertReadingExperienceNegativeInvariants,
  storyArcPhase,
  type CandidateDraft,
  type ExtractedChapterState,
  type ExtractedEventDraft,
  type GeneratedChapter,
} from "./narrativeEngine";
import type { GeneratedStoryOpening, OpeningGenerationContext } from "./openingService";
import {
  formatReadingExperienceForPrompt,
  refineReadingExperienceContract,
  type ModelExperienceAxisDraft,
} from "./readingExperience";
import { IMMERSIVE_NARRATION_PROMPT, normalizeChapterTitle } from "./narrationPolicy";
import {
  assertModelCallTokenBudget,
  CONTINUATION_JOB_TOKEN_BUDGET,
  estimateModelCallTokenBudget,
  OPENING_JOB_TOKEN_BUDGET,
} from "./generationBudget";
import { addModelUsage, attachedModelUsage, attachModelUsage } from "./modelUsage";
import { readSecret } from "./vault";

const itemStatuses = new Set(["available", "held", "lost", "destroyed", "consumed"] as const);
const chapterWriterInstruction = `你是原创中文长篇连载小说作家。只返回 JSON：{\"title\":\"章节名\",\"paragraphs\":[\"段落\"]}。必须同时满足用户提示中的中文字符区间与目标段落数；每段包含完整场景动作、感官细节或人物反应，不能用短句凑段。${IMMERSIVE_NARRATION_PROMPT}`;

function chapterWriterSystemPrompt(streaming: boolean) {
  return `${chapterWriterInstruction}${streaming ? "先给 title，再按顺序给 paragraphs；不要在 JSON 外输出文字。" : "用人物行动和冲突结果兑现体验，保持沉浸。"}`;
}

export function estimateChapterWriterInputTokenBudget(prompt: string, streaming: boolean): number {
  return estimateModelCallTokenBudget({
    system: chapterWriterSystemPrompt(streaming),
    prompt,
    maxOutputTokens: 0,
  });
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
    const mappedHex = normalized.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:") ||
      normalized.startsWith("2001:10:")
    );
  }
  return isPrivateIpv4(address);
}

async function resolveSafeEndpoint(rawUrl: string): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Base URL 不是有效地址。");
  }
  const allowPrivate = process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS === "true";
  if (url.username || url.password) throw new Error("Base URL 不得内嵌用户名或密码。");
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new Error("SaaS 模式仅允许受信的 HTTPS 模型地址。");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error("该地址属于本地或云元数据网络，已被安全策略阻止。");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!allowPrivate && addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("该域名解析到私有或保留地址，已阻止连接以避免 SSRF。");
  }
  const selected = addresses[0];
  if (!selected) throw new Error("模型域名没有可用的 DNS 解析结果。");
  return { url, address: selected.address, family: isIP(selected.address) === 6 ? 6 : 4 };
}

export async function assertSafeEndpoint(rawUrl: string): Promise<URL> {
  return (await resolveSafeEndpoint(rawUrl)).url;
}

function endpoint(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/$/, "")}${pathname}`;
}

export function createPinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

async function modelFetch(
  connection: ModelConnection,
  apiKey: string,
  pathname: string,
  init: RequestInit,
  timeout = 12_000,
) {
  const resolved = await resolveSafeEndpoint(connection.baseUrl);
  const url = new URL(endpoint(resolved.url.toString(), pathname));
  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    "Accept-Encoding": "identity",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...init.headers,
  });
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      servername: url.hostname,
      lookup: createPinnedLookup(resolved.address, resolved.family),
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const status = incoming.statusCode ?? 502;
      const body = status === 204 || status === 304 ? null : Readable.toWeb(incoming) as ReadableStream;
      resolve(new Response(body, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
    });
    const timer = setTimeout(() => request.destroy(new Error("模型连接超时。")), timeout);
    request.once("close", () => clearTimeout(timer));
    request.once("error", reject);
    if (init.signal) {
      if (init.signal.aborted) request.destroy(new Error("模型请求已取消。"));
      else init.signal.addEventListener("abort", () => request.destroy(new Error("模型请求已取消。")), { once: true });
    }
    if (typeof init.body === "string" || init.body instanceof Uint8Array) request.write(init.body);
    else if (init.body) {
      request.destroy(new Error("模型网关只接受已序列化的请求正文。"));
      return;
    }
    request.end();
  });
}

async function discardResponse(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Optional capability probes degrade to false even if the provider body is malformed.
  }
}

async function readProviderError(response: Response, maxBytes = 4_096): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - totalBytes;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (value.length > remaining) break;
    }
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return "";
  try {
    const payload = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
    const detail = payload.error?.message ?? payload.message;
    if (typeof detail === "string") return detail.replace(/\s+/g, " ").slice(0, 300);
  } catch {
    // Fall back to a bounded plain-text diagnostic.
  }
  return raw.replace(/\s+/g, " ").slice(0, 300);
}

async function probeJson(connection: ModelConnection, apiKey: string) {
  try {
    const response = await modelFetch(connection, apiKey, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: connection.routes.writer,
        messages: [{ role: "user", content: "只返回 JSON：{\"ok\":true}" }],
        max_tokens: 12,
        response_format: { type: "json_object" },
        stream: false,
      }),
    });
    if (!response.ok) {
      await discardResponse(response);
      return false;
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return false;
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

type MandatoryOpeningRouteRole = "planner" | "writer" | "extractor";

const mandatoryOpeningRouteLabels: Record<MandatoryOpeningRouteRole, string> = {
  planner: "规划（planner）",
  writer: "正文（writer）",
  extractor: "抽取（extractor）",
};

async function assertOpeningRouteCompletion(
  connection: ModelConnection,
  apiKey: string,
  model: string,
  roles: MandatoryOpeningRouteRole[],
) {
  const timeoutMs = 30_000;
  const route = `${roles.map((role) => mandatoryOpeningRouteLabels[role]).join("、")}路由 ${model}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await modelFetch(connection, apiKey, "/chat/completions", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "回复：好" }],
          max_tokens: 64,
          stream: false,
        }),
      }, timeoutMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知传输错误";
      if (controller.signal.aborted || /超时/.test(reason)) {
        throw new Error(`${route}的最小请求超时（${timeoutMs / 1_000} 秒）。`);
      }
      throw new Error(`${route}的最小请求失败：${reason}`);
    }

    if (!response.ok) {
      const detail = await readProviderError(response);
      throw new Error(`${route}返回 ${response.status}${detail ? `：${detail}` : ""}。`);
    }

    let payload: { choices?: Array<{ message?: { content?: string } }> };
    try {
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${route}的最小请求超时（${timeoutMs / 1_000} 秒）。`);
      }
      const reason = error instanceof Error ? error.message : "未知响应错误";
      throw new Error(`${route}返回的响应不是有效 JSON：${reason.slice(0, 160)}。`);
    }

    if (typeof payload.choices?.[0]?.message?.content !== "string" || !payload.choices[0].message.content.trim()) {
      throw new Error(`${route}返回 200，但没有可用内容。`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function probeStreaming(connection: ModelConnection, apiKey: string) {
  try {
    const response = await modelFetch(connection, apiKey, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: connection.routes.writer,
        messages: [{ role: "user", content: "回复一个字：好" }],
        max_tokens: 2,
        stream: true,
      }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !/text\/event-stream/i.test(contentType)) {
      await discardResponse(response);
      return false;
    }
    const reader = response.body?.getReader();
    const first = reader ? await reader.read() : null;
    await reader?.cancel();
    return Boolean(first && !first.done && first.value.length);
  } catch {
    return false;
  }
}

async function probeEmbedding(connection: ModelConnection, apiKey: string) {
  try {
    const response = await modelFetch(connection, apiKey, "/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: connection.routes.embedding, input: "能力探测" }),
    });
    if (!response.ok) {
      await discardResponse(response);
      return false;
    }
    const payload = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
    return Array.isArray(payload.data?.[0]?.embedding);
  } catch {
    return false;
  }
}

async function probeToolCalling(connection: ModelConnection, apiKey: string) {
  try {
    const response = await modelFetch(connection, apiKey, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: connection.routes.planner,
        messages: [{ role: "user", content: "调用 ping 工具" }],
        tools: [{ type: "function", function: { name: "ping", description: "能力探测", parameters: { type: "object", properties: {} } } }],
        tool_choice: { type: "function", function: { name: "ping" } },
        max_tokens: 24,
      }),
    });
    if (!response.ok) {
      await discardResponse(response);
      return false;
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
    return Array.isArray(payload.choices?.[0]?.message?.tool_calls);
  } catch {
    return false;
  }
}

async function probePromptCache(connection: ModelConnection, apiKey: string) {
  const body = JSON.stringify({
    model: connection.routes.planner,
    messages: [{ role: "user", content: `提示词缓存能力探测：${"固定上下文".repeat(180)}` }],
    max_tokens: 2,
    temperature: 0,
  });
  try {
    const warmup = await modelFetch(connection, apiKey, "/chat/completions", { method: "POST", body });
    if (!warmup.ok) {
      await discardResponse(warmup);
      return false;
    }
    await warmup.arrayBuffer();
    const response = await modelFetch(connection, apiKey, "/chat/completions", { method: "POST", body });
    if (!response.ok) {
      await discardResponse(response);
      return false;
    }
    const payload = (await response.json()) as { usage?: { prompt_tokens_details?: { cached_tokens?: number }; cached_tokens?: number } };
    return (payload.usage?.prompt_tokens_details?.cached_tokens ?? payload.usage?.cached_tokens ?? 0) > 0;
  } catch {
    return false;
  }
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

export async function testConnection(
  connection: ModelConnection,
  secretReader: typeof readSecret = readSecret,
): Promise<CapabilitySnapshot> {
  await assertSafeEndpoint(connection.baseUrl);
  const apiKey = await secretReader(connection.id, connection.secretVersion);
  const startedAt = performance.now();
  const response = await modelFetch(connection, apiKey, "/models", { method: "GET" }, 10_000);
  if (!response.ok) {
    const detail = await readProviderError(response);
    throw new Error(`连接返回 ${response.status}${detail ? `：${detail}` : ""}，请检查地址、Key 与访问权限。`);
  }
  const payload = (await response.json()) as { data?: Array<{ id?: string; context_window?: number; max_context_length?: number }> };
  const models = (payload.data ?? [])
    .map((item) => item.id)
    .filter((item): item is string => Boolean(item))
    .slice(0, 20);
  const maxContextTokens = Math.max(0, ...(payload.data ?? []).map((item) => item.context_window ?? item.max_context_length ?? 0)) || null;
  const mandatoryRoutes = new Map<string, MandatoryOpeningRouteRole[]>();
  for (const role of ["planner", "writer", "extractor"] as const) {
    const model = connection.routes[role];
    const roles = mandatoryRoutes.get(model) ?? [];
    roles.push(role);
    mandatoryRoutes.set(model, roles);
  }
  for (const [model, roles] of mandatoryRoutes) {
    await assertOpeningRouteCompletion(connection, apiKey, model, roles);
  }
  const [jsonSchema, streaming, embedding, toolCalling, promptCache] = await runWithConcurrency([
    () => probeJson(connection, apiKey),
    () => probeStreaming(connection, apiKey),
    () => probeEmbedding(connection, apiKey),
    () => probeToolCalling(connection, apiKey),
    () => probePromptCache(connection, apiKey),
  ], 2);
  return {
    streaming,
    jsonSchema,
    embedding,
    promptCache,
    toolCalling,
    maxContextTokens,
    testedAt: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - startedAt),
    models,
  };
}

export type CompletionModelFetcher = (
  connection: ModelConnection,
  apiKey: string,
  pathname: string,
  init: RequestInit,
  timeout?: number,
) => Promise<Response>;

export interface CompleteJsonDependencies {
  secretReader?: typeof readSecret;
  modelFetcher?: CompletionModelFetcher;
}

export type JsonModelCompleter = <T>(
  connection: ModelConnection,
  model: string,
  system: string,
  prompt: string,
  timeout?: number,
  maxTokens?: number,
) => Promise<{ value: T; usageTokens: number; usageEstimated: boolean }>;

function estimatedCompletionFailureTokens(system: string, prompt: string, maxTokens: number): number {
  return estimateModelCallTokenBudget({ system, prompt, maxOutputTokens: maxTokens });
}

function reportedCompletionUsage(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const total = (payload as { usage?: { total_tokens?: unknown } }).usage?.total_tokens;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return undefined;
  const rounded = Math.round(total);
  return rounded > 0 ? rounded : undefined;
}

export async function completeJson<T>(
  connection: ModelConnection,
  model: string,
  system: string,
  prompt: string,
  timeout = 120_000,
  maxTokens = 2_000,
  dependencies: CompleteJsonDependencies = {},
): Promise<{ value: T; usageTokens: number; usageEstimated: boolean }> {
  const secretReader = dependencies.secretReader ?? readSecret;
  const completionFetcher = dependencies.modelFetcher ?? modelFetch;
  const apiKey = await secretReader(connection.id, connection.secretVersion);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
    stream: false,
    max_tokens: maxTokens,
  };
  if (connection.capabilities?.jsonSchema && model === connection.routes.writer) {
    body.response_format = { type: "json_object" };
  }
  const conservativeFailureTokens = estimatedCompletionFailureTokens(system, prompt, maxTokens);
  let response: Response;
  try {
    response = await completionFetcher(
      connection,
      apiKey,
      "/chat/completions",
      { method: "POST", body: JSON.stringify(body) },
      timeout,
    );
  } catch (error) {
    throw attachModelUsage(error, conservativeFailureTokens, true);
  }
  if (!response.ok) {
    await discardResponse(response);
    throw attachModelUsage(
      new Error(`模型 ${model} 返回 ${response.status}；未启用静默回退。`),
      conservativeFailureTokens,
      true,
    );
  }
  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知响应错误";
    throw attachModelUsage(
      new Error(`模型 ${model} 返回的响应不是有效 JSON：${reason.slice(0, 160)}。`),
      conservativeFailureTokens,
      true,
    );
  }
  const reportedTokens = reportedCompletionUsage(payload);
  const failureTokens = reportedTokens ?? conservativeFailureTokens;
  const failureUsageEstimated = reportedTokens === undefined;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw attachModelUsage(
      new Error(`模型 ${model} 没有返回可用内容。`),
      failureTokens,
      failureUsageEstimated,
    );
  }
  let value: T;
  try {
    value = JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw attachModelUsage(
        new Error(`模型 ${model} 输出不是可修复的 JSON。`),
        failureTokens,
        failureUsageEstimated,
      );
    }
    try {
      value = JSON.parse(match[0]) as T;
    } catch {
      throw attachModelUsage(
        new Error(`模型 ${model} 输出不是可修复的 JSON。`),
        failureTokens,
        failureUsageEstimated,
      );
    }
  }
  return {
    value,
    usageTokens: reportedTokens ?? estimateModelCallTokenBudget({
      system,
      prompt,
      maxOutputTokens: Buffer.byteLength(content, "utf8"),
    }),
    usageEstimated: reportedTokens === undefined,
  };
}

export interface OpeningCompletionRequest {
  connection: ModelConnection;
  model: string;
  system: string;
  prompt: string;
  timeout: number;
  maxTokens: number;
}

export type OpeningModelCompleter = (
  request: OpeningCompletionRequest,
) => Promise<{ value: unknown; usageTokens: number; usageEstimated: boolean }>;

const defaultOpeningCompleter: OpeningModelCompleter = async (request) => completeJson<unknown>(
  request.connection,
  request.model,
  request.system,
  request.prompt,
  request.timeout,
  request.maxTokens,
);

interface OpeningPlanPayload {
  title?: string;
  subtitle?: string;
  leadName?: string;
  storyGene?: GeneratedStoryOpening["storyGene"];
  endingContract?: GeneratedStoryOpening["endingContract"];
  worldBible?: GeneratedStoryOpening["worldBible"];
  experienceAxes?: ModelExperienceAxisDraft[];
  openingBeats?: string[];
}

interface OpeningWriterPayload {
  title?: string;
  paragraphs?: string[];
}

interface OpeningReviewPayload {
  experienceEvidence?: ReadingExperienceEvidence[];
  event?: GeneratedStoryOpening["event"];
}

function hasOpeningPlanShape(value: unknown): value is Required<OpeningPlanPayload> {
  if (!value || typeof value !== "object") return false;
  const plan = value as OpeningPlanPayload;
  const gene = plan.storyGene;
  const ending = plan.endingContract;
  const bible = plan.worldBible;
  return [plan.title, plan.subtitle, plan.leadName].every((item) => typeof item === "string" && item.trim().length > 0) &&
    Boolean(gene) && [gene?.protagonistPosition, gene?.visibleGoal, gene?.hiddenNeed, gene?.conflictEngine, gene?.recurringCost, gene?.endingShape]
      .every((item) => typeof item === "string" && item.trim().length > 0) &&
    Array.isArray(gene?.creativeAxes) && gene.creativeAxes.length >= 3 && gene.creativeAxes.every((item) => typeof item === "string" && item.trim()) &&
    Boolean(ending) && [ending?.targetEnding, ending?.characterArc].every((item) => typeof item === "string" && item.trim().length > 0) &&
    Array.isArray(ending?.prerequisites) && ending.prerequisites.length >= 1 && ending.prerequisites.every((item) => typeof item === "string" && item.trim()) &&
    Boolean(bible) &&
    [bible?.organizations, bible?.locations, bible?.abilityBoundaries, bible?.styleParameters]
      .every((items) => Array.isArray(items) && items.length >= 1 && items.every((item) => typeof item === "string" && item.trim().length > 0)) &&
    typeof bible?.pointOfView === "string" && bible.pointOfView.trim().length > 0 &&
    Array.isArray(plan.experienceAxes) && plan.experienceAxes.length === 2 &&
    Array.isArray(plan.openingBeats) && plan.openingBeats.length >= 2 &&
    plan.openingBeats.every((item) => typeof item === "string" && item.trim().length >= 4);
}

function hasOpeningReviewShape(value: unknown): value is Required<OpeningReviewPayload> {
  if (!value || typeof value !== "object") return false;
  const review = value as OpeningReviewPayload;
  return Array.isArray(review.experienceEvidence) && review.experienceEvidence.length === 2 &&
    Boolean(review.event) && [review.event?.title, review.event?.cause, review.event?.outcome, review.event?.location]
      .every((item) => typeof item === "string" && item.trim().length >= 4) &&
    Array.isArray(review.event?.persistentFacts) && review.event.persistentFacts.length >= 2 &&
    review.event.persistentFacts.length <= 8 &&
    review.event.persistentFacts.every((item) => typeof item === "string" && item.trim().length >= 8);
}

export async function generateStoryOpeningWithConnection(
  context: OpeningGenerationContext,
  connection: ModelConnection,
  complete: OpeningModelCompleter = defaultOpeningCompleter,
  tokenBudget = OPENING_JOB_TOKEN_BUDGET,
): Promise<GeneratedStoryOpening> {
  const plannerRequest: OpeningCompletionRequest = {
    connection,
    model: connection.routes.planner,
    system: [
      "你是原创中文网文总规划师，只返回 JSON。",
      "把用户给出的两个阅读体验词解释为人物行动、机制、冲突结果、世界反应和语言节奏上的可观察承诺；不得把词语直接贴到景物描写上。",
      "开篇必须先发生具体事件：前 200 字给出主角处境、触发事件和第一个行动；第一章内兑现两个体验，不得承诺以后再写。",
      "不要模仿或点名任何在世作者；使用成熟网文的目标清晰、回报及时、冲突有效和章末推动力等通用技巧。",
      "JSON 字段：title,subtitle,leadName,storyGene,endingContract,worldBible,experienceAxes,openingBeats。experienceAxes 必须按用户两个词的顺序，每项含 word,interpretation,observableSignals(至少2项对象),hardPromises(至少1项),forbiddenShortcuts。每个 observableSignals 对象含 description 与 evidenceAnchors：evidenceAnchors 给出 2—6 个可自然逐字写入正文的短语，至少分别覆盖一个具体动作和一个对象或结果，短语必须来自 description 本身，禁止只填人物称谓、体验词或“行动/结果”等泛词；对自定义词，解释、信号或硬承诺中必须原样出现该词并说明它如何由行动兑现。",
    ].join("\n"),
    prompt: [
      `题材：${context.input.genre}`,
      `两个阅读体验词：${context.contract.sourceWords.join(" · ")}`,
      `用户灵感：${context.input.inspiration?.trim() || "由模型原创"}`,
      `预计篇幅：${context.targetChapterCount}章`,
      `本地基础契约仅供参考：${JSON.stringify(context.contract)}`,
      "规划必须使两个词在同一故事机制中兼容；体验硬承诺优先于题材默认套路。",
    ].join("\n"),
    timeout: 60_000,
    maxTokens: 2_600,
  };
  assertModelCallTokenBudget({
    remainingTokens: tokenBudget,
    system: plannerRequest.system,
    prompt: plannerRequest.prompt,
    maxOutputTokens: plannerRequest.maxTokens,
    stage: "开篇规划",
  });
  const planner = await complete(plannerRequest);
  if (!hasOpeningPlanShape(planner.value)) {
    throw attachModelUsage(
      new Error("规划模型输出未通过开篇蓝图 Schema 校验。"),
      planner.usageTokens,
      planner.usageEstimated,
    );
  }
  const plan = planner.value;
  let contract: ReadingExperienceContract;
  try {
    contract = refineReadingExperienceContract(context.contract, plan.experienceAxes);
    assertReadingExperienceNegativeInvariants(contract, JSON.stringify({
      storyGene: plan.storyGene,
      endingContract: plan.endingContract,
      worldBible: plan.worldBible,
    }), { protagonistNames: [plan.leadName] });
  } catch (error) {
    throw attachModelUsage(error, planner.usageTokens, planner.usageEstimated);
  }
  const writerPrompt = [
    `开篇蓝图：${JSON.stringify({
      title: plan.title,
      subtitle: plan.subtitle,
      leadName: plan.leadName,
      storyGene: plan.storyGene,
      worldBible: plan.worldBible,
      openingBeats: plan.openingBeats,
    })}`,
    formatReadingExperienceForPrompt(contract, 1),
    "写第一章正文，16—20 个完整段落、2400—4200 个中文字符。首段直接进入事件；前 15% 兑现两个体验轴；本章必须出现一次有分量的行动结果与世界反应。对模型细化的自定义体验轴，正文不必出现体验词本身，须直接写出对应信号约定的人物、动作、对象与结果，禁止贴标签或把词拼到天光、晨雾等景物上。",
    `只返回 JSON：{\"title\":\"章名\",\"paragraphs\":[\"完整段落\"]}。${IMMERSIVE_NARRATION_PROMPT}`,
  ].join("\n");
  const writerSystem = "你是原创中文长篇网文作家。用现场动作、人物选择、冲突结果和具体关系写作；回报及时，因果清楚，禁止作者侧元叙事。只返回符合要求的 JSON。";

  let accumulatedTokens = planner.usageTokens;
  let usageEstimated = planner.usageEstimated;
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let writer: Awaited<ReturnType<OpeningModelCompleter>>;
    const attemptPrompt = attempt === 1
      ? writerPrompt
      : `${writerPrompt}\n上一稿未通过沉浸感或双体验证据检查，请彻底重写，不要解释。失败原因：${lastFailure instanceof Error ? lastFailure.message : "质量证据不足"}`;
    const writerRequest: OpeningCompletionRequest = {
      connection,
      model: connection.routes.writer,
      system: writerSystem,
      prompt: attemptPrompt,
      timeout: 120_000,
      maxTokens: 6_500,
    };
    try {
      assertModelCallTokenBudget({
        remainingTokens: tokenBudget - accumulatedTokens,
        system: writerRequest.system,
        prompt: writerRequest.prompt,
        maxOutputTokens: writerRequest.maxTokens,
        stage: "开篇正文",
      });
      writer = await complete(writerRequest);
    } catch (error) {
      throw addModelUsage(error, accumulatedTokens, usageEstimated);
    }
    accumulatedTokens += writer.usageTokens;
    usageEstimated ||= writer.usageEstimated;
    const written = writer.value as OpeningWriterPayload;
    if (
      typeof written?.title !== "string" || !written.title.trim() || !Array.isArray(written.paragraphs) ||
      written.paragraphs.length < 16 || written.paragraphs.length > 20 ||
      !written.paragraphs.every((paragraph) => typeof paragraph === "string" && paragraph.trim().length > 0)
    ) {
      lastFailure = new Error("正文模型输出未通过开篇 Schema 校验：要求 16—20 个非空完整段落。");
      continue;
    }
    const normalizedChapterTitle = normalizeChapterTitle(written.title);
    if (!normalizedChapterTitle) {
      lastFailure = new Error("正文模型只返回了章节序号，没有提供有效章名。");
      continue;
    }
    const paragraphs = written.paragraphs.map((paragraph) => paragraph.trim());
    const content = paragraphs.join("\n");
    const characterCount = content.replace(/\s/g, "").length;
    if (characterCount < 2_400 || characterCount > 4_800) {
      lastFailure = new Error(`正文字数为 ${characterCount} 字，要求 2400—4800 字。`);
      continue;
    }
    try {
      assertImmersiveNarration(normalizedChapterTitle);
      assertImmersiveNarration(content);
    } catch (error) {
      lastFailure = error;
      continue;
    }
    const reviewerRequest: OpeningCompletionRequest = {
      connection,
      model: connection.routes.extractor,
      system: "你是独立的中文小说质量审稿与正史事件抽取器，只返回 JSON。不得替正文补事实，也不得仅因出现体验词就判定兑现。",
      prompt: [
        `体验契约：${JSON.stringify(contract)}`,
        `正文：${normalizedChapterTitle}\n${content}`,
        "逐轴返回正文中的连续原句证据以及命中的 signalIds；证据必须具体对应所申报模型信号中的人物、动作、对象与结果，并在同一句 quote 中逐字包含该模型信号 evidenceAnchors 中至少两个相互独立的短语。若某轴同时有 _model_signal_ 与基础 signal，signalIds 必须各命中至少一项；quote 不必出现体验词本身，不能把标签、人物称谓共词或无关动作冒充兑现。两个轴必须提供不同原句，不能把同一句泛化动作重复标给两轴。event.persistentFacts 返回 2—8 条正文连续原句，保存主角已经获得的能力、奖励、权限、资源、关系或世界状态，供下一章直接继承。返回 {experienceEvidence:[{axisId,word,signalIds,quote}],event:{title,cause,outcome,location,persistentFacts}}。任一轴没有真实证据时仍返回空 evidence，让本稿失败重写。",
      ].join("\n"),
      timeout: 45_000,
      maxTokens: 1_400,
    };
    try {
      assertModelCallTokenBudget({
        remainingTokens: tokenBudget - accumulatedTokens,
        system: reviewerRequest.system,
        prompt: reviewerRequest.prompt,
        maxOutputTokens: reviewerRequest.maxTokens,
        stage: "开篇审稿",
      });
    } catch (error) {
      throw addModelUsage(error, accumulatedTokens, usageEstimated);
    }
    try {
      const reviewer = await complete(reviewerRequest);
      accumulatedTokens += reviewer.usageTokens;
      usageEstimated ||= reviewer.usageEstimated;
      if (!hasOpeningReviewShape(reviewer.value)) throw new Error("审稿模型没有返回两个体验轴的有效证据。");
      assertPersistentExperienceFacts(contract, content, reviewer.value.event.persistentFacts, {
        protagonistNames: [plan.leadName],
        chapterNumber: 1,
      });
      assertReadingExperienceEvidence(contract, content, reviewer.value.experienceEvidence, {
        protagonistNames: [plan.leadName],
        opening: true,
        chapterNumber: 1,
      });
      return {
        title: plan.title.trim().slice(0, 80),
        subtitle: plan.subtitle.trim().slice(0, 180),
        leadName: plan.leadName.trim().slice(0, 80),
        storyGene: plan.storyGene,
        endingContract: plan.endingContract,
        worldBible: plan.worldBible,
        readingExperience: contract,
        chapter: {
          title: normalizedChapterTitle.slice(0, 120),
          paragraphs,
          model: connection.routes.writer,
          origin: "model",
          experienceEvidence: reviewer.value.experienceEvidence,
          usageTokens: writer.usageTokens,
          usageEstimated: writer.usageEstimated,
        },
        event: reviewer.value.event,
        plannerModel: connection.routes.planner,
        writerModel: connection.routes.writer,
        usageTokens: accumulatedTokens,
        usageEstimated,
      };
    } catch (error) {
      const failedCallUsage = attachedModelUsage(error);
      accumulatedTokens += failedCallUsage.tokens;
      usageEstimated ||= failedCallUsage.estimated;
      lastFailure = error;
    }
  }
  throw attachModelUsage(
    new Error(`第一章连续两次未通过阅读体验与沉浸感质量门禁：${lastFailure instanceof Error ? lastFailure.message : "未知错误"}`),
    accumulatedTokens,
    usageEstimated,
  );
}

export async function generateCandidateDraftsWithConnection(
  connection: ModelConnection,
  story: Story,
  complete: JsonModelCompleter = completeJson,
  tokenBudget = CONTINUATION_JOB_TOKEN_BUDGET,
): Promise<{ candidates: CandidateDraft[]; usageTokens: number; usageEstimated: boolean }> {
  const storyArc = storyArcPhase(story.chapters.length, story.targetChapterCount);
  const activeKnowledgeLedger = story.characters.map((character) => ({
    characterName: character.name,
    facts: character.knowledgeSources.slice(-12).map((fact) => ({ fact: fact.fact, sourceRevisionId: fact.sourceRevisionId })),
  }));
  const activeEventIds = story.events
    .filter((event) => event.active && event.branchId === story.activeBranchId)
    .slice(-12)
    .map((event) => ({ id: event.id, title: event.title, storyTime: event.storyTime }));
  const plannerSystem = "你是剧情规划器。只返回 JSON，包含 candidates 数组；每项必须有 creativeAxis,event,cause,cost,impact,novelty,participantNames,storyTime,dependsOnEventIds,knowledgeClaims,itemTransitions。knowledgeClaims 每项含 characterName/fact/sourceRevisionId；itemTransitions 每项含 itemName/actorName/fromStatus/toStatus。只给短剧情胶囊，不写正文。";
  const plannerPrompt = `故事：${story.title}；题材：${story.genre}；故事基因：${story.storyGene.conflictEngine}；持续代价：${story.storyGene.recurringCost}；题材创意轴：${story.storyGene.creativeAxes.join("、")}；篇幅：第 ${story.chapters.length + 1} / ${story.targetChapterCount} 章，第 ${storyArc.volumeNumber} / ${storyArc.totalVolumes} 卷，本卷第 ${storyArc.chapterInVolume} / ${storyArc.volumeChapterCount} 章，阶段=${storyArc.label}；阶段要求：${storyArc.guidance}；结局契约：${story.endingContract.targetEnding}；必要前置条件：${story.endingContract.prerequisites.join("；")}。${formatReadingExperienceForPrompt(story.readingExperience, story.chapters.length + 1)}。所有候选必须在同一事件中兑现两个阅读体验轴，并让结果产生正文可引用的证据。所有候选的核心事件、资源、两难与代价都必须属于“${story.genre}”的典型叙事，不得把非悬疑题材统一写成追踪线索、救证人或查案；终卷不得开启新世界、新势力或大型支线，目标章候选必须明确兑现结局契约及至少一项必要前置条件。可用人物知识账本：${JSON.stringify(activeKnowledgeLedger)}；可依赖活动事件：${JSON.stringify(activeEventIds)}。每个有参与者的候选至少声明一条正文实际使用、且来自上述账本的 knowledgeClaim；若无法给出来源就不要生成该候选。生成 5 个结构不同的候选。`;
  assertModelCallTokenBudget({
    remainingTokens: tokenBudget,
    system: plannerSystem,
    prompt: plannerPrompt,
    maxOutputTokens: 1_800,
    stage: "候选规划",
  });
  const completion = await complete<{ candidates?: CandidateDraft[] }>(
    connection,
    connection.routes.planner,
    plannerSystem,
    plannerPrompt,
    40_000,
    1_800,
  );
  const payload = completion.value;
  const candidates = (Array.isArray(payload?.candidates) ? payload.candidates : [])
    .filter((item) =>
      item && [item.creativeAxis, item.event, item.cause, item.cost, item.impact, item.novelty]
        .every((value) => typeof value === "string" && value.trim().length > 0) &&
      Array.isArray(item.participantNames) && item.participantNames.every((value) => typeof value === "string") &&
      typeof item.storyTime === "string" && item.storyTime.trim().length > 0 &&
      Array.isArray(item.dependsOnEventIds) && item.dependsOnEventIds.every((value) => typeof value === "string") &&
      Array.isArray(item.knowledgeClaims) && item.knowledgeClaims.every((claim) =>
        claim && typeof claim.characterName === "string" && typeof claim.fact === "string" &&
        typeof claim.sourceRevisionId === "string" && claim.sourceRevisionId.trim().length > 0,
      ) &&
      Array.isArray(item.itemTransitions) && item.itemTransitions.every((transition) =>
        transition && typeof transition.itemName === "string" && typeof transition.actorName === "string" &&
        itemStatuses.has(transition.fromStatus) && itemStatuses.has(transition.toStatus),
      ),
    )
    .map((item) => ({
      creativeAxis: item.creativeAxis.slice(0, 80),
      event: item.event.slice(0, 220),
      cause: item.cause.slice(0, 220),
      cost: item.cost.slice(0, 180),
      impact: item.impact.slice(0, 220),
      novelty: item.novelty.slice(0, 180),
      participantNames: Array.isArray(item.participantNames) ? item.participantNames.filter((value): value is string => typeof value === "string").slice(0, 12) : [],
      storyTime: typeof item.storyTime === "string" ? item.storyTime.slice(0, 80) : undefined,
      dependsOnEventIds: Array.isArray(item.dependsOnEventIds) ? item.dependsOnEventIds.filter((value): value is string => typeof value === "string").slice(0, 12) : [],
      knowledgeClaims: Array.isArray(item.knowledgeClaims) ? item.knowledgeClaims.filter((claim) => claim && typeof claim.characterName === "string" && typeof claim.fact === "string").slice(0, 12).map((claim) => ({ characterName: claim.characterName.slice(0, 80), fact: claim.fact.slice(0, 180), sourceRevisionId: typeof claim.sourceRevisionId === "string" ? claim.sourceRevisionId.slice(0, 120) : undefined })) : [],
      itemTransitions: Array.isArray(item.itemTransitions) ? item.itemTransitions.filter((transition) => transition && typeof transition.itemName === "string" && typeof transition.actorName === "string" && itemStatuses.has(transition.fromStatus) && itemStatuses.has(transition.toStatus)).slice(0, 12).map((transition) => ({ itemName: transition.itemName.slice(0, 120), actorName: transition.actorName.slice(0, 80), fromStatus: transition.fromStatus, toStatus: transition.toStatus })) : [],
    }));
  if (candidates.length < 3) {
    throw attachModelUsage(
      new Error("规划模型未返回至少 3 个有效剧情胶囊。"),
      completion.usageTokens,
      completion.usageEstimated,
    );
  }
  const selectedCandidates = candidates.slice(0, 5);
  type CandidateAuditPayload = {
    audits?: Array<{ candidateIndex?: number; complete?: boolean; dependencies?: Array<{ characterName?: string; fact?: string }> }>;
  };
  const auditSystem = "你是独立的剧情知识依赖审计器。只返回 JSON：{audits:[{candidateIndex,complete,dependencies:[{characterName,fact}]}]}。逐个候选穷尽提取角色行动所依赖的所有既有信息、解读材料、秘密、凭据、记录和推理前提；不要依赖固定动词或名词表，要理解同义表达、语序和隐含信息依赖。dependencies 只记录行动前必须已知的事实，不记录本章新发生的物理动作。只有确认穷尽时 complete 才为 true。";
  const auditPrompt = `活动人物知识账本：${JSON.stringify(activeKnowledgeLedger)}；候选：${JSON.stringify(selectedCandidates.map((candidate, candidateIndex) => ({ candidateIndex, event: candidate.event, cause: candidate.cause, cost: candidate.cost, impact: candidate.impact, novelty: candidate.novelty, participantNames: candidate.participantNames })))}。`;
  let auditCompletion: { value: CandidateAuditPayload; usageTokens: number; usageEstimated: boolean };
  try {
    assertModelCallTokenBudget({
      remainingTokens: tokenBudget - completion.usageTokens,
      system: auditSystem,
      prompt: auditPrompt,
      maxOutputTokens: 1_800,
      stage: "候选审计",
    });
    auditCompletion = await complete<CandidateAuditPayload>(
      connection,
      connection.routes.extractor,
      auditSystem,
      auditPrompt,
      40_000,
      1_800,
    );
  } catch (error) {
    throw addModelUsage(error, completion.usageTokens, completion.usageEstimated);
  }
  const audits = (auditCompletion.value as CandidateAuditPayload | null)?.audits ?? [];
  let auditedCandidates: CandidateDraft[];
  try {
    auditedCandidates = selectedCandidates.map((candidate, candidateIndex) => {
      const audit = audits.find((item) => item.candidateIndex === candidateIndex);
      if (!audit?.complete || !Array.isArray(audit.dependencies)) {
        throw new Error(`候选 ${candidateIndex + 1} 缺少完整的独立知识依赖审计。`);
      }
      const dependencies = audit.dependencies
        .filter((dependency) => dependency && typeof dependency.characterName === "string" && typeof dependency.fact === "string" && dependency.fact.trim().length >= 2)
        .map((dependency) => ({ characterName: dependency.characterName!.slice(0, 80), fact: dependency.fact!.slice(0, 180) }));
      if (dependencies.length !== audit.dependencies.length) throw new Error(`候选 ${candidateIndex + 1} 的知识依赖审计 Schema 无效。`);
      return { ...candidate, knowledgeAudit: { complete: true, dependencies } };
    });
  } catch (error) {
    throw attachModelUsage(
      error,
      completion.usageTokens + auditCompletion.usageTokens,
      completion.usageEstimated || auditCompletion.usageEstimated,
    );
  }
  return {
    candidates: auditedCandidates,
    usageTokens: completion.usageTokens + auditCompletion.usageTokens,
    usageEstimated: completion.usageEstimated || auditCompletion.usageEstimated,
  };
}

export async function generateChapterWithConnection(
  connection: ModelConnection,
  prompt: string,
  maxTokens = 6_500,
  complete: JsonModelCompleter = completeJson,
  tokenBudget = CONTINUATION_JOB_TOKEN_BUDGET,
): Promise<GeneratedChapter> {
  const systemPrompt = chapterWriterSystemPrompt(false);
  assertModelCallTokenBudget({
    remainingTokens: tokenBudget,
    system: systemPrompt,
    prompt,
    maxOutputTokens: maxTokens,
    stage: "正文",
  });
  const completion = await complete<{ title?: string; paragraphs?: string[] }>(
    connection,
    connection.routes.writer,
    systemPrompt,
    prompt,
    120_000,
    maxTokens,
  );
  const parsed = completion.value;
  if (
    !parsed ||
    typeof parsed.title !== "string" ||
    !Array.isArray(parsed.paragraphs) ||
    parsed.paragraphs.length < 4 ||
    !parsed.paragraphs.every((paragraph) => typeof paragraph === "string")
  ) {
    throw attachModelUsage(
      new Error("正文模型输出未通过章节 Schema 校验。"),
      completion.usageTokens,
      completion.usageEstimated,
    );
  }
  const normalizedTitle = normalizeChapterTitle(parsed.title);
  if (!normalizedTitle) {
    throw attachModelUsage(
      new Error("正文模型只返回了章节序号，没有提供有效章名。"),
      completion.usageTokens,
      completion.usageEstimated,
    );
  }
  return {
    title: normalizedTitle.slice(0, 200),
    paragraphs: parsed.paragraphs.map((paragraph) => paragraph.slice(0, 4_000)),
    model: connection.routes.writer,
    origin: "model",
    usageTokens: completion.usageTokens,
    usageEstimated: completion.usageEstimated,
  };
}

function completedChapterFields(content: string) {
  const titleMatch = content.match(/"title"\s*:\s*("(?:\\.|[^"\\])*")/);
  let title = "";
  if (titleMatch) {
    try { title = JSON.parse(titleMatch[1]) as string; } catch { title = ""; }
  }
  const marker = content.search(/"paragraphs"\s*:\s*\[/);
  const paragraphs: string[] = [];
  if (marker < 0) return { title, paragraphs };
  let cursor = content.indexOf("[", marker) + 1;
  while (cursor > 0 && cursor < content.length) {
    while (/\s|,/.test(content[cursor] ?? "")) cursor += 1;
    if (content[cursor] !== '"') break;
    const start = cursor;
    cursor += 1;
    let escaped = false;
    let completed = false;
    while (cursor < content.length) {
      const character = content[cursor];
      if (!escaped && character === '"') {
        completed = true;
        cursor += 1;
        break;
      }
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      cursor += 1;
    }
    if (!completed) break;
    try { paragraphs.push((JSON.parse(content.slice(start, cursor)) as string).slice(0, 4_000)); } catch { break; }
  }
  return { title: title.slice(0, 200), paragraphs };
}

export async function streamChapterWithConnection(
  connection: ModelConnection,
  prompt: string,
  onParagraph: (paragraph: string, index: number, title: string) => void,
  maxTokens = 6_500,
  dependencies: CompleteJsonDependencies = {},
  tokenBudget = CONTINUATION_JOB_TOKEN_BUDGET,
): Promise<GeneratedChapter> {
  const systemPrompt = chapterWriterSystemPrompt(true);
  assertModelCallTokenBudget({
    remainingTokens: tokenBudget,
    system: systemPrompt,
    prompt,
    maxOutputTokens: maxTokens,
    stage: "正文",
  });
  const secretReader = dependencies.secretReader ?? readSecret;
  const streamFetcher = dependencies.modelFetcher ?? modelFetch;
  const apiKey = await secretReader(connection.id, connection.secretVersion);
  const conservativeFailureTokens = estimatedCompletionFailureTokens(systemPrompt, prompt, maxTokens);
  const body: Record<string, unknown> = {
    model: connection.routes.writer,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
    stream: true,
    max_tokens: maxTokens,
  };
  if (connection.capabilities?.jsonSchema) body.response_format = { type: "json_object" };
  let response: Response;
  try {
    response = await streamFetcher(
      connection,
      apiKey,
      "/chat/completions",
      { method: "POST", body: JSON.stringify(body) },
      120_000,
    );
  } catch (error) {
    throw attachModelUsage(error, conservativeFailureTokens, true);
  }
  if (!response.ok || !response.body) {
    await discardResponse(response);
    throw attachModelUsage(
      new Error(`正文模型流式调用返回 ${response.status}；未启用静默回退。`),
      conservativeFailureTokens,
      true,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let eventBuffer = "";
  let content = "";
  let emitted = 0;
  let reportedTokens: number | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      eventBuffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      const frames = eventBuffer.split("\n\n");
      eventBuffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const payload = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { total_tokens?: number };
          };
          content += payload.choices?.[0]?.delta?.content ?? "";
          reportedTokens = reportedCompletionUsage(payload) ?? reportedTokens;
          if (content.length > 1_000_000) {
            throw new Error("流式正文超过 1 MB 安全上限，已中止且不会提交正史。");
          }
        }
        const fields = completedChapterFields(content);
        while (emitted < fields.paragraphs.length) {
          onParagraph(fields.paragraphs[emitted], emitted, fields.title);
          emitted += 1;
        }
      }
      if (done) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw attachModelUsage(
      error,
      reportedTokens ?? conservativeFailureTokens,
      reportedTokens === undefined,
    );
  }
  const fields = completedChapterFields(content);
  const normalizedTitle = normalizeChapterTitle(fields.title);
  if (!normalizedTitle || fields.paragraphs.length < 4) {
    throw attachModelUsage(
      new Error("流式正文在完成前中断或未通过章节 Schema 校验。"),
      reportedTokens ?? conservativeFailureTokens,
      reportedTokens === undefined,
    );
  }
  return {
    title: normalizedTitle.slice(0, 200),
    paragraphs: fields.paragraphs,
    model: connection.routes.writer,
    origin: "model",
    usageTokens: reportedTokens ?? estimateModelCallTokenBudget({
      system: systemPrompt,
      prompt,
      maxOutputTokens: Buffer.byteLength(content, "utf8"),
    }),
    usageEstimated: reportedTokens === undefined,
  };
}

export async function extractChapterStateWithConnection(
  connection: ModelConnection,
  chapter: GeneratedChapter,
  endingContract?: EndingContract,
  readingExperience?: ReadingExperienceContract,
  complete: JsonModelCompleter = completeJson,
  tokenBudget = CONTINUATION_JOB_TOKEN_BUDGET,
): Promise<ExtractedChapterState> {
  const evidenceSignalExample = (axis: ReadingExperienceContract["axes"][number]) => {
    const modelSignal = axis.observableSignals.find((signal) => signal.id.includes("_model_signal_"));
    const baselineSignal = axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"));
    return Array.from(new Set([modelSignal?.id, baselineSignal?.id].filter((id): id is string => Boolean(id))));
  };
  const endingSchema = endingContract
    ? `，"endingResolution":{"targetEndingSatisfied":true,"targetEndingEvidence":"正文中的原句","satisfiedPrerequisiteIndices":[0],"prerequisiteEvidence":[{"prerequisiteIndex":0,"evidence":"正文中的原句"}],"noContinuationHook":true}`
    : "";
  const endingInstruction = endingContract
    ? ` 独立判断结局是否在剧情行动中真实完成。结局目标=${endingContract.targetEnding}；前置条件（按下标）=${endingContract.prerequisites.map((item, index) => `${index}:${item}`).join("；")}。evidence 必须逐字引用正文中至少 8 个字的连续原句；仅复述后台契约、不对应行动结果时必须判为 false。`
    : "";
  const experienceSchema = readingExperience
    ? `，"experienceEvidence":[{"axisId":"primary","word":"${readingExperience.axes[0].word}","signalIds":${JSON.stringify(evidenceSignalExample(readingExperience.axes[0]))},"quote":"正文中的连续原句"},{"axisId":"secondary","word":"${readingExperience.axes[1].word}","signalIds":${JSON.stringify(evidenceSignalExample(readingExperience.axes[1]))},"quote":"正文中的连续原句"}]`
    : "";
  const experienceInstruction = readingExperience
    ? ` 独立审查两个阅读体验轴，契约=${JSON.stringify(readingExperience)}。每个 evidence 必须逐字引用正文中至少 8 个字的连续原句，并具体对应所申报信号中的人物、动作、对象与结果；申报 _model_signal_ 时，同一句 quote 还必须逐字包含该信号 evidenceAnchors 中至少两个相互独立的短语，只出现体验词、人物称谓共词或无关动作不算兑现。若某轴同时有 _model_signal_ 与基础 signal，signalIds 必须各命中至少一项；quote 不必出现体验词本身，但两轴不得复用同一句证据。系统奖励、权限、能力和长期状态必须作为主角的 knowledgeGained 原文保存。无法找到真实证据时返回空数组，让正文被拒绝重写。`
    : "";
  const extractorSystem = `你是独立的正史状态与阅读体验证据抽取器。只返回 JSON：{"events":[{"type":"choice","title":"","cause":"","outcome":"","participantNames":[],"location":""}],"characterUpdates":[{"name":"","status":"","location":"","goal":"","knowledgeGained":[]}],"itemUpdates":[{"name":"","status":"held","holderName":"","location":""}]${experienceSchema}${endingSchema}}；不得新增正文没有的事实。${experienceInstruction}${endingInstruction}`;
  const extractorPrompt = `${chapter.title}\n${chapter.paragraphs.join("\n")}`;
  assertModelCallTokenBudget({
    remainingTokens: tokenBudget,
    system: extractorSystem,
    prompt: extractorPrompt,
    maxOutputTokens: 1_500,
    stage: "状态抽取",
  });
  const completion = await complete<Partial<ExtractedChapterState>>(
    connection,
    connection.routes.extractor,
    extractorSystem,
    extractorPrompt,
    30_000,
    1_500,
  );
  const parsed = completion.value;
  try {
    if (!Array.isArray(parsed.events) || !Array.isArray(parsed.characterUpdates)) {
      throw new Error("抽取模型输出未通过状态 Schema 校验。");
    }
  const eventTypes = new Set(["discovery", "choice", "relationship", "death", "survival", "consequence"]);
  const events = parsed.events
    .filter((event) =>
      event &&
      typeof event.title === "string" &&
      typeof event.cause === "string" &&
      typeof event.outcome === "string",
    )
    .map((event) => ({
      type: typeof event.type === "string" && eventTypes.has(event.type)
        ? event.type as ExtractedEventDraft["type"]
        : undefined,
      title: event.title.slice(0, 180),
      cause: event.cause.slice(0, 240),
      outcome: event.outcome.slice(0, 280),
      participantNames: Array.isArray(event.participantNames)
        ? event.participantNames.filter((name): name is string => typeof name === "string").slice(0, 12)
        : [],
      location: typeof event.location === "string" ? event.location.slice(0, 120) : undefined,
    }));
  const characterUpdates = parsed.characterUpdates
    .filter((item) => item && typeof item.name === "string" && item.name.length > 0)
    .map((item) => ({
      name: item.name.slice(0, 80),
      status: typeof item.status === "string" ? item.status.slice(0, 80) : undefined,
      location: typeof item.location === "string" ? item.location.slice(0, 120) : undefined,
      goal: typeof item.goal === "string" ? item.goal.slice(0, 180) : undefined,
      knowledgeGained: Array.isArray(item.knowledgeGained)
        ? item.knowledgeGained.filter((value): value is string => typeof value === "string").slice(0, 12)
        : [],
    }));
  const itemUpdates = (parsed.itemUpdates ?? [])
    .filter((item) => item && typeof item.name === "string" && item.name.length > 0 && itemStatuses.has(item.status))
    .map((item) => ({
      name: item.name.slice(0, 120),
      status: item.status,
      holderName: typeof item.holderName === "string" ? item.holderName.slice(0, 80) : undefined,
      location: typeof item.location === "string" ? item.location.slice(0, 120) : undefined,
    }));
  let experienceEvidence: ReadingExperienceEvidence[] | undefined;
  if (readingExperience) {
    if (!Array.isArray(parsed.experienceEvidence)) throw new Error("抽取模型没有返回阅读体验正文证据。");
    experienceEvidence = parsed.experienceEvidence
      .filter((item) => item && (item.axisId === "primary" || item.axisId === "secondary") && typeof item.word === "string" && Array.isArray(item.signalIds) && typeof item.quote === "string")
      .map((item) => ({
        axisId: item.axisId,
        word: item.word.slice(0, 24),
        signalIds: item.signalIds.filter((signalId): signalId is string => typeof signalId === "string").slice(0, 6),
        quote: item.quote.slice(0, 500),
      }));
  }
  let endingResolution: ExtractedChapterState["endingResolution"];
  if (endingContract) {
    const resolution = parsed.endingResolution;
    if (
      !resolution ||
      typeof resolution.targetEndingSatisfied !== "boolean" ||
      typeof resolution.targetEndingEvidence !== "string" ||
      !Array.isArray(resolution.satisfiedPrerequisiteIndices) ||
      !resolution.satisfiedPrerequisiteIndices.every((index) => Number.isInteger(index)) ||
      !Array.isArray(resolution.prerequisiteEvidence) ||
      !resolution.prerequisiteEvidence.every((item) => item && Number.isInteger(item.prerequisiteIndex) && typeof item.evidence === "string") ||
      typeof resolution.noContinuationHook !== "boolean"
    ) {
      throw new Error("终章抽取没有返回有效的结构化结局证据。");
    }
    endingResolution = {
      targetEndingSatisfied: resolution.targetEndingSatisfied,
      targetEndingEvidence: resolution.targetEndingEvidence.slice(0, 500),
      satisfiedPrerequisiteIndices: resolution.satisfiedPrerequisiteIndices.slice(0, endingContract.prerequisites.length),
      prerequisiteEvidence: resolution.prerequisiteEvidence.slice(0, endingContract.prerequisites.length).map((item) => ({ prerequisiteIndex: item.prerequisiteIndex, evidence: item.evidence.slice(0, 500) })),
      noContinuationHook: resolution.noContinuationHook,
    };
  }
    return {
      events,
      characterUpdates,
      itemUpdates,
      experienceEvidence,
      endingResolution,
      usageTokens: completion.usageTokens,
      usageEstimated: completion.usageEstimated,
    };
  } catch (error) {
    throw attachModelUsage(error, completion.usageTokens, completion.usageEstimated);
  }
}
