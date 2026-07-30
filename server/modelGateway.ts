import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { CapabilitySnapshot, EndingContract, ModelConnection, OpenAICompletionApi, OpenAIEmbeddingApi, OpeningRevisionReasonCode, ReadingExperienceContract, ReadingExperienceDeliveryObservation, ReadingExperienceEvidence, Story } from "../src/types";
import {
  assertPersistentExperienceFacts,
  assertReadingExperienceContent,
  assertReadingExperienceEvidence,
  assertReadingExperienceNegativeInvariants,
  contentContainsSourceQuote,
  groundReadingExperienceEvidence,
  normalizeChapterEditorialIssues,
  storyArcPhase,
  type CandidateDraft,
  type ExtractedChapterState,
  type ExtractedEventDraft,
  type GeneratedChapter,
} from "./narrativeEngine";
import type { GeneratedStoryOpening, OpeningGenerationContext } from "./openingService";
import {
  formatReadingExperienceForPrompt,
  formatReadingExperienceCadenceForPrompt,
  readingExperienceAxisUsesSoftWindow,
  refineReadingExperienceContract,
  type ModelExperienceAxisDraft,
} from "./readingExperience";
import {
  assertOpeningNarrationStructure,
  detectNarrationCandidates,
  IMMERSIVE_NARRATION_PROMPT,
  narrationArtifactHash,
  normalizeChapterTitle,
  type NarrationCandidate,
} from "./narrationPolicy";
import {
  narrationReviewerInstruction,
  resolveNarrationAssessments,
  type NarrationReviewResolution,
} from "./narrationReview";
import {
  OPENING_CHAPTER_MIN_CHARACTERS,
  OPENING_CHAPTER_TARGET_CHARACTERS,
  openingChapterCharacterCount,
  openingChapterLengthIsAllowed,
} from "./openingConstraints";
import {
  assertModelCallTokenBudget,
  CONTINUATION_JOB_TOKEN_BUDGET,
  estimateModelCallTokenBudget,
  OPENING_JOB_TOKEN_BUDGET,
} from "./generationBudget";
import { classifyGenerationFailure } from "./failureTelemetry";
import { addModelUsage, attachedModelUsage, attachModelUsage } from "./modelUsage";
import { readSecret } from "./vault";
import { writeAiTrace, type AiTraceEvent, type AiTraceWriter } from "./aiTrace";

export type { AiTraceEvent } from "./aiTrace";

const itemStatuses = new Set(["available", "held", "lost", "destroyed", "consumed"] as const);
const GENERATION_STAGE_TIMEOUT_MS = {
  planner: 180_000,
  writer: 300_000,
  reviewer: 120_000,
} as const;
const chapterWriterInstruction = `你是原创中文长篇连载小说作家。只返回 JSON：{\"title\":\"章节名\",\"paragraphs\":[\"段落\"]}。用户提示中的目标字数与目标段落数是写作建议，可以为了完整表达自然超出；只把明确标出的最低字数当作长度门槛，不要为了贴合建议值删减必要情节。每段包含完整场景动作、感官细节或人物反应，不能用短句凑段。${IMMERSIVE_NARRATION_PROMPT}`;

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
  overallTimeout = timeout,
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
    let idleTimer: ReturnType<typeof setTimeout>;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    const destroyForTimeout = () => request.destroy(new Error("模型连接超时。"));
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(destroyForTimeout, timeout);
    };
    const clearTimers = () => {
      clearTimeout(idleTimer);
      if (overallTimer) clearTimeout(overallTimer);
    };
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
      incoming.on("data", resetIdleTimer);
      incoming.once("end", clearTimers);
      incoming.once("close", clearTimers);
      resolve(new Response(body, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
    });
    idleTimer = setTimeout(destroyForTimeout, timeout);
    overallTimer = setTimeout(destroyForTimeout, Math.max(timeout, overallTimeout));
    request.once("close", clearTimers);
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

function redactProviderDiagnostic(value: string, sensitiveValues: string[]): string {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length >= 4) redacted = redacted.replaceAll(sensitiveValue, "[已隐藏]");
  }
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [已隐藏]")
    .replace(/\b(?:sk|sf)[-_][A-Za-z0-9._-]{8,}\b/gi, "[已隐藏]")
    .replace(/(["']?(?:api[_-]?key|authorization|access[_-]?token|secret)["']?\s*[:=]\s*["']?)[^"',\s}]{6,}/gi, "$1[已隐藏]");
}

async function readProviderError(
  response: Response,
  maxBytes = 4_096,
  sensitiveValues: string[] = [],
): Promise<string> {
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
    if (typeof detail === "string") {
      return redactProviderDiagnostic(detail.replace(/\s+/g, " "), sensitiveValues).slice(0, 300);
    }
  } catch {
    // Fall back to a bounded plain-text diagnostic.
  }
  return redactProviderDiagnostic(raw.replace(/\s+/g, " "), sensitiveValues).slice(0, 300);
}

async function providerResponseError(response: Response, subject: string, apiKey: string): Promise<Error> {
  const detail = await readProviderError(response, 4_096, [apiKey]);
  const rawTraceId = response.headers.get("x-siliconcloud-trace-id")?.trim();
  const traceId = rawTraceId
    ? redactProviderDiagnostic(rawTraceId.replace(/\s+/g, " "), [apiKey]).slice(0, 160)
    : "";
  return new Error([
    `${subject} 返回 ${response.status}`,
    detail ? `：${detail}` : "",
    traceId ? `（追踪 ID：${traceId}）` : "",
    "；未启用静默回退。",
  ].join(""));
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
  completionApi: OpenAICompletionApi,
  externalSignal?: AbortSignal,
) {
  const timeoutMs = 90_000;
  const route = `${roles.map((role) => mandatoryOpeningRouteLabels[role]).join("、")}路由 ${model}`;
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await modelFetch(connection, apiKey, completionApi === "responses" ? "/responses" : "/chat/completions", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify(completionApi === "responses"
          ? {
              model,
              input: "回复：好",
              max_output_tokens: 64,
              stream: false,
            }
          : {
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
      const detail = await readProviderError(response, 4_096, [apiKey]);
      throw Object.assign(
        new Error(`${route}返回 ${response.status}${detail ? `：${detail}` : ""}。`),
        { providerStatus: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${route}的最小请求超时（${timeoutMs / 1_000} 秒）。`);
      }
      const reason = error instanceof Error ? error.message : "未知响应错误";
      throw new Error(`${route}返回的响应不是有效 JSON：${reason.slice(0, 160)}。`);
    }

    const content = completionApi === "responses"
      ? responsesOutputText(payload)
      : (payload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error(`${route}返回 200，但没有可用内容。`);
    }
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
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

function embeddingVector(payload: unknown): number[] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const data = (payload as { data?: unknown }).data;
  const rawEmbedding = Array.isArray(data)
    ? (data[0] && typeof data[0] === "object" ? (data[0] as { embedding?: unknown }).embedding : undefined)
    : (data && typeof data === "object" ? (data as { embedding?: unknown }).embedding : undefined);
  if (!Array.isArray(rawEmbedding) || rawEmbedding.length === 0) return undefined;
  const vector = rawEmbedding.length === 1 && Array.isArray(rawEmbedding[0])
    ? rawEmbedding[0]
    : rawEmbedding;
  return vector.length > 0 && vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ? vector as number[]
    : undefined;
}

async function probeEmbedding(connection: ModelConnection, apiKey: string): Promise<OpenAIEmbeddingApi | undefined> {
  const standard = {
    api: "embeddings" as const,
    pathname: "/embeddings",
    body: { model: connection.routes.embedding, encoding_format: "float", input: ["能力探测"] },
  };
  const multimodal = {
    api: "embeddings_multimodal" as const,
    pathname: "/embeddings/multimodal",
    body: {
      model: connection.routes.embedding,
      encoding_format: "float",
      input: [{ type: "text", text: "能力探测" }],
    },
  };
  const likelyMultimodal = /(?:embedding[-_].*(?:vision|multimodal)|(?:vision|multimodal).*embedding)/i
    .test(connection.routes.embedding);
  const probes = likelyMultimodal ? [multimodal, standard] : [standard, multimodal];
  for (const probe of probes) {
    try {
      const response = await modelFetch(connection, apiKey, probe.pathname, {
        method: "POST",
        body: JSON.stringify(probe.body),
      });
      if (!response.ok) {
        const canTryAlternate = [400, 404, 405, 415, 422, 501].includes(response.status);
        await discardResponse(response);
        if (canTryAlternate) continue;
        return undefined;
      }
      const payload = await response.json();
      if (embeddingVector(payload)) return probe.api;
    } catch {
      return undefined;
    }
  }
  return undefined;
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
  let modelItems: Array<{ id?: string; context_window?: number; max_context_length?: number }> = [];
  try {
    const response = await modelFetch(connection, apiKey, "/models", { method: "GET" }, 10_000);
    if (response.ok) {
      const payload = (await response.json()) as { data?: unknown };
      if (Array.isArray(payload.data)) {
        modelItems = payload.data as typeof modelItems;
      }
    } else {
      await discardResponse(response);
    }
  } catch {
    // Model discovery is not part of every OpenAI-compatible data plane. The
    // configured text routes below are the authoritative connection test.
  }
  const models = modelItems
    .map((item) => item.id)
    .filter((item): item is string => Boolean(item))
    .slice(0, 20);
  const maxContextTokens = Math.max(0, ...modelItems.map((item) => item.context_window ?? item.max_context_length ?? 0)) || null;
  const mandatoryRoutes = new Map<string, MandatoryOpeningRouteRole[]>();
  for (const role of ["planner", "writer", "extractor"] as const) {
    const model = connection.routes[role];
    const roles = mandatoryRoutes.get(model) ?? [];
    roles.push(role);
    mandatoryRoutes.set(model, roles);
  }
  const mandatoryEntries = [...mandatoryRoutes.entries()];
  const firstMandatoryRoute = mandatoryEntries[0];
  if (!firstMandatoryRoute) throw new Error("连接没有配置可测试的文本模型路由。");
  let completionApi: OpenAICompletionApi | undefined;
  let negotiationErrors: unknown[] = [];
  const candidates = ["chat_completions", "responses"] as const;
  const negotiationControllers = candidates.map(() => new AbortController());
  try {
    completionApi = await Promise.any(candidates.map(async (candidate, index) => {
      await assertOpeningRouteCompletion(
        connection,
        apiKey,
        firstMandatoryRoute[0],
        firstMandatoryRoute[1],
        candidate,
        negotiationControllers[index].signal,
      );
      return candidate;
    }));
  } catch (error) {
    negotiationErrors = error instanceof AggregateError ? error.errors : [error];
  } finally {
    negotiationControllers.forEach((controller) => controller.abort());
  }
  if (!completionApi) {
    const providerErrors = negotiationErrors.filter((error) =>
      error && typeof error === "object" && Number.isFinite(Number((error as { providerStatus?: unknown }).providerStatus)));
    const authorizationError = providerErrors.find((error) => {
      const status = Number((error as { providerStatus?: unknown }).providerStatus);
      return status === 401 || status === 403;
    });
    throw authorizationError ?? providerErrors.at(-1) ?? negotiationErrors.at(-1);
  }
  for (const [model, roles] of mandatoryEntries.slice(1)) {
    await assertOpeningRouteCompletion(connection, apiKey, model, roles, completionApi);
  }
  const capabilityResults = completionApi === "chat_completions"
    ? await runWithConcurrency<boolean | OpenAIEmbeddingApi | undefined>([
        () => probeJson(connection, apiKey),
        () => probeStreaming(connection, apiKey),
        () => probeEmbedding(connection, apiKey),
        () => probeToolCalling(connection, apiKey),
        () => probePromptCache(connection, apiKey),
      ], 2)
    : [false, false, await probeEmbedding(connection, apiKey), false, false];
  const jsonSchema = capabilityResults[0] === true;
  const streaming = capabilityResults[1] === true;
  const embeddingApi = typeof capabilityResults[2] === "string" ? capabilityResults[2] : undefined;
  const toolCalling = capabilityResults[3] === true;
  const promptCache = capabilityResults[4] === true;
  return {
    completionApi,
    streaming,
    jsonSchema,
    embedding: Boolean(embeddingApi),
    embeddingApi,
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
  overallTimeout?: number,
) => Promise<Response>;

export interface CompleteJsonDependencies {
  secretReader?: typeof readSecret;
  modelFetcher?: CompletionModelFetcher;
  retryDelay?: (milliseconds: number) => Promise<void>;
  overallTimeoutMs?: number;
  remainingTokens?: number;
  stage?: string;
  now?: () => number;
  traceWriter?: AiTraceWriter;
  validateJson?: (value: unknown) => string[];
}

export type JsonModelCompleter = <T>(
  connection: ModelConnection,
  model: string,
  system: string,
  prompt: string,
  timeout?: number,
  maxTokens?: number,
  dependencies?: Pick<CompleteJsonDependencies, "overallTimeoutMs" | "remainingTokens" | "stage" | "validateJson">,
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

function completionApiFor(connection: ModelConnection): OpenAICompletionApi {
  return connection.capabilities?.completionApi ?? "chat_completions";
}

function responsesOutputText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const direct = (payload as { output_text?: unknown }).output_text;
  if (typeof direct === "string" && direct.trim()) return direct;
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return undefined;
  const fragments: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typedPart = part as { type?: unknown; text?: unknown };
      if (typedPart.type === "output_text" && typeof typedPart.text === "string") {
        fragments.push(typedPart.text);
      }
    }
  }
  const joined = fragments.join("");
  return joined.trim() ? joined : undefined;
}

function isSiliconFlowConnection(connection: ModelConnection): boolean {
  try {
    const hostname = new URL(connection.baseUrl).hostname.toLowerCase();
    return hostname === "siliconflow.cn" || hostname.endsWith(".siliconflow.cn");
  } catch {
    return false;
  }
}

function isVolcengineArkConnection(connection: ModelConnection): boolean {
  try {
    const hostname = new URL(connection.baseUrl).hostname.toLowerCase();
    return hostname.startsWith("ark.") && hostname.endsWith(".volces.com");
  } catch {
    return false;
  }
}

function streamedCompletionOverallTimeout(timeout: number, maxTokens: number): number {
  if (maxTokens >= 6_000) return timeout * 5;
  return timeout * (maxTokens >= 4_000 ? 3 : 2);
}

interface ChatCompletionStreamOptions {
  onContent?: (content: string) => void;
  onUsage?: (usageTokens: number) => void;
}

const MAX_STREAM_CONTENT_BYTES = 1_000_000;
const MAX_STREAM_FRAME_BUFFER_BYTES = 4_000_000;

async function readChatCompletionStream(
  response: Response,
  options: ChatCompletionStreamOptions = {},
): Promise<{
  content: string;
  reportedTokens: number | undefined;
}> {
  if (!response.body) throw new Error("模型流式响应没有可读取的正文。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let eventBuffer = "";
  let content = "";
  let reportedTokens: number | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      const decoded = decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      if (eventBuffer.endsWith("\r") && decoded.startsWith("\n")) {
        eventBuffer = `${eventBuffer.slice(0, -1)}\n${decoded.slice(1)}`;
      } else {
        eventBuffer += decoded;
      }
      const frames = eventBuffer.split("\n\n");
      eventBuffer = frames.pop() ?? "";
      if (Buffer.byteLength(eventBuffer, "utf8") > MAX_STREAM_FRAME_BUFFER_BYTES) {
        throw new Error("模型流式响应的未完成帧超过 4 MB 安全上限。");
      }
      if (done && eventBuffer.trim()) {
        frames.push(eventBuffer);
        eventBuffer = "";
      }
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const payload = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
            usage?: { total_tokens?: number };
          };
          const delta = payload.choices?.[0]?.delta?.content;
          if (typeof delta === "string") {
            content += delta;
            if (Buffer.byteLength(content, "utf8") > MAX_STREAM_CONTENT_BYTES) {
              throw new Error("模型流式响应超过 1 MB 安全上限。");
            }
            options.onContent?.(content);
          }
          const currentReportedTokens = reportedCompletionUsage(payload);
          if (currentReportedTokens !== undefined) {
            reportedTokens = currentReportedTokens;
            options.onUsage?.(currentReportedTokens);
          }
        }
      }
      if (done) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return { content, reportedTokens };
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
  const retryDelay = dependencies.retryDelay ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const traceWriter = dependencies.traceWriter ?? writeAiTrace;
  const traceCallId = randomUUID();
  const traceStartedAt = now();
  const traceStage = dependencies.stage?.trim() || `模型 ${model}`;
  const trace = async (event: AiTraceEvent["event"], details: Partial<AiTraceEvent> = {}) => {
    try {
      await traceWriter({
        timestamp: new Date().toISOString(),
        callId: traceCallId,
        attempt: details.attempt ?? 1,
        stage: traceStage,
        connectionId: connection.id,
        model,
        elapsedMs: Math.max(0, now() - traceStartedAt),
        ...details,
        event,
      });
    } catch (error) {
      console.error(`[AI-TRACE] 记录调用 ${traceCallId} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const apiKey = await secretReader(connection.id, connection.secretVersion);
  const completionApi = completionApiFor(connection);
  const streamStructuredResponse = completionApi === "chat_completions" &&
    connection.capabilities?.streaming === true;
  const useConciseQwenExtractorOutput = isSiliconFlowConnection(connection) &&
    model === connection.routes.extractor && /^Qwen\/Qwen3(?:[-./]|$)/i.test(model);
  const generationStage = dependencies.stage?.trim();
  const isNonPlanningGenerationStage = generationStage
    ? /(?:候选规划|正文|审稿|审计|抽取|提取|修复)/.test(generationStage)
    : model === connection.routes.writer || model === connection.routes.extractor;
  const disableArkDeepThinking = isVolcengineArkConnection(connection) && /^doubao-seed-/i.test(model) &&
    isNonPlanningGenerationStage;
  const completionBody = (requestSystem: string, requestPrompt: string): Record<string, unknown> => {
    const body: Record<string, unknown> = completionApi === "responses"
      ? {
          model,
          instructions: requestSystem,
          input: requestPrompt,
          max_output_tokens: maxTokens,
          stream: false,
        }
      : {
          model,
          messages: [
            { role: "system", content: requestSystem },
            { role: "user", content: requestPrompt },
          ],
          temperature: model === connection.routes.extractor ? 0.2 : 0.7,
          stream: streamStructuredResponse,
          max_tokens: maxTokens,
        };
    if (disableArkDeepThinking) body.thinking = { type: "disabled" };
    if (completionApi === "chat_completions") {
      if (streamStructuredResponse && isVolcengineArkConnection(connection)) {
        body.stream_options = { include_usage: true };
      }
      if (useConciseQwenExtractorOutput) body.enable_thinking = false;
      if (
        connection.capabilities?.jsonSchema &&
        (model === connection.routes.writer || useConciseQwenExtractorOutput)
      ) {
        body.response_format = { type: "json_object" };
      }
    }
    return body;
  };
  const maximumAttempts = 3;
  const logicalOverallTimeout = dependencies.overallTimeoutMs === undefined
    ? streamStructuredResponse
      ? streamedCompletionOverallTimeout(timeout, maxTokens)
      : timeout
    : Math.max(timeout, dependencies.overallTimeoutMs);
  const deadlineAt = now() + logicalOverallTimeout;
  const retryTokenBudget = dependencies.remainingTokens ?? Number.POSITIVE_INFINITY;
  const retryStage = dependencies.stage ?? `模型 ${model}`;
  let priorFailureTokens = 0;
  let priorUsageEstimated = false;
  let requestSystem = system;
  let requestPrompt = prompt;
  const prepareJsonFeedback = (reason: string, rawContent: string) => {
    requestSystem = [
      system,
      "上一轮输出没有通过 JSON 机器校验。必须根据校验错误重新生成完整 JSON；只输出一个 JSON 值，不要解释、不要使用 Markdown 代码块。",
    ].join("\n");
    requestPrompt = [
      "原始任务上下文：",
      prompt,
      "",
      "上一次模型输出：",
      rawContent || "（空输出）",
      "",
      reason,
      "请保留原任务中已经正确的语义，修正语法或补齐缺失字段，然后重新输出完整、可解析且字段齐全的 JSON。",
    ].join("\n");
  };
  const addFailedAttempt = (tokens: number, estimated: boolean) => {
    priorFailureTokens += Math.max(0, Math.round(tokens));
    priorUsageEstimated ||= estimated;
  };
  const transientTransportFailure = (error: unknown) => {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const reason = error instanceof Error ? error.message : String(error);
    return /(?:aborted|terminated|premature|socket hang up|ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|network|fetch failed|连接超时|请求超时)/i.test(
      `${code} ${reason}`,
    );
  };
  const waitBeforeRetry = async (milliseconds: number, failure: unknown) => {
    if (deadlineAt - now() <= milliseconds) {
      throw attachModelUsage(failure, priorFailureTokens, priorUsageEstimated);
    }
    try {
      await retryDelay(milliseconds);
    } catch (error) {
      throw attachModelUsage(error, priorFailureTokens, priorUsageEstimated);
    }
  };
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const body = completionBody(requestSystem, requestPrompt);
    const conservativeFailureTokens = estimatedCompletionFailureTokens(requestSystem, requestPrompt, maxTokens);
    try {
      assertModelCallTokenBudget({
        remainingTokens: retryTokenBudget - priorFailureTokens,
        system: requestSystem,
        prompt: requestPrompt,
        maxOutputTokens: maxTokens,
        stage: attempt === 1 ? retryStage : `${retryStage}重试`,
      });
    } catch (error) {
      throw attachModelUsage(error, priorFailureTokens, priorUsageEstimated);
    }
    const remainingOverallTimeout = deadlineAt - now();
    if (remainingOverallTimeout <= 0) {
      throw attachModelUsage(
        new Error(`模型 ${model} 在总时限内没有完成。`),
        priorFailureTokens,
        priorUsageEstimated,
      );
    }
    await trace("request", {
      attempt,
      completionApi,
      timeoutMs: Math.max(1, Math.min(timeout, remainingOverallTimeout)),
      maxTokens,
      system: requestSystem,
      prompt: requestPrompt,
      providerRequest: body,
    });
    let response: Response;
    try {
      response = await completionFetcher(
        connection,
        apiKey,
        completionApi === "responses" ? "/responses" : "/chat/completions",
        { method: "POST", body: JSON.stringify(body) },
        Math.max(1, Math.min(timeout, remainingOverallTimeout)),
        Math.max(1, remainingOverallTimeout),
      );
    } catch (error) {
      await trace("error", {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      addFailedAttempt(conservativeFailureTokens, true);
      if (attempt < maximumAttempts && transientTransportFailure(error)) {
        await waitBeforeRetry(attempt === 1 ? 2_000 : 5_000, error);
        continue;
      }
      throw attachModelUsage(error, priorFailureTokens, priorUsageEstimated);
    }
    if (!response.ok) {
      const transientOverload = [429, 502, 503, 504].includes(response.status);
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMilliseconds = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(10_000, Math.max(500, retryAfter * 1_000))
        : attempt === 1 ? 2_000 : 5_000;
      const providerError = await providerResponseError(response, `模型 ${model}`, apiKey);
      await trace("error", {
        attempt,
        httpStatus: response.status,
        error: providerError.message,
      });
      addFailedAttempt(conservativeFailureTokens, true);
      if (transientOverload && attempt < maximumAttempts) {
        await waitBeforeRetry(delayMilliseconds, providerError);
        continue;
      }
      throw attachModelUsage(providerError, priorFailureTokens, priorUsageEstimated);
    }
    let content: string | undefined;
    let reportedTokens: number | undefined;
    let providerPayload: unknown;
    if (streamStructuredResponse) {
      let streamedFailureTokens: number | undefined;
      try {
        const streamed = await readChatCompletionStream(response, {
          onUsage: (usageTokens) => { streamedFailureTokens = usageTokens; },
        });
        content = streamed.content;
        reportedTokens = streamed.reportedTokens;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "未知流式响应错误";
        const failureTokens = streamedFailureTokens ?? conservativeFailureTokens;
        const failureUsageEstimated = streamedFailureTokens === undefined;
        addFailedAttempt(failureTokens, failureUsageEstimated);
        const streamFailure = new Error(`模型 ${model} 的流式响应无效：${reason.slice(0, 160)}。`);
        await trace("error", {
          attempt,
          rawContent: content,
          reportedTokens: streamedFailureTokens,
          error: streamFailure.message,
        });
        if (attempt < maximumAttempts && transientTransportFailure(error)) {
          await waitBeforeRetry(attempt === 1 ? 2_000 : 5_000, streamFailure);
          continue;
        }
        throw attachModelUsage(streamFailure, priorFailureTokens, priorUsageEstimated);
      }
    } else {
      try {
        providerPayload = await response.json();
      } catch (error) {
        const reason = error instanceof Error ? error.message : "未知响应错误";
        const invalidResponse = new Error(`模型 ${model} 返回的响应不是有效 JSON：${reason.slice(0, 160)}。`);
        await trace("error", {
          attempt,
          httpStatus: response.status,
          error: invalidResponse.message,
        });
        addFailedAttempt(conservativeFailureTokens, true);
        if (attempt < maximumAttempts && transientTransportFailure(error)) {
          await waitBeforeRetry(attempt === 1 ? 2_000 : 5_000, invalidResponse);
          continue;
        }
        throw attachModelUsage(invalidResponse, priorFailureTokens, priorUsageEstimated);
      }
      content = completionApi === "responses"
        ? responsesOutputText(providerPayload)
        : (providerPayload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
      reportedTokens = reportedCompletionUsage(providerPayload);
    }
    await trace("response", {
      attempt,
      httpStatus: response.status,
      reportedTokens,
      providerPayload,
      rawContent: content,
    });
    const failureTokens = reportedTokens ?? conservativeFailureTokens;
    const failureUsageEstimated = reportedTokens === undefined;
    if (typeof content !== "string" || !content.trim()) {
      const reason = `JSON 解析错误：模型 ${model} 没有返回可用内容。`;
      await trace("error", {
        attempt,
        reportedTokens,
        error: reason,
      });
      addFailedAttempt(failureTokens, failureUsageEstimated);
      if (attempt < maximumAttempts) {
        prepareJsonFeedback(reason, "");
        continue;
      }
      throw attachModelUsage(
        new Error(`模型 ${model} 连续 ${maximumAttempts} 次没有返回可解析 JSON：${reason}`),
        priorFailureTokens,
        priorUsageEstimated,
      );
    }
    let value: T | undefined;
    let parseMode: "direct" | "extracted" = "direct";
    let parseFailure: string | undefined;
    try {
      value = JSON.parse(content) as T;
    } catch (directError) {
      parseMode = "extracted";
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) {
        const detail = directError instanceof Error ? directError.message : String(directError);
        parseFailure = `JSON 解析错误：${detail}；输出中未找到完整的 JSON 对象。`;
      } else {
        try {
          value = JSON.parse(match[0]) as T;
        } catch (extractedError) {
          const detail = extractedError instanceof Error ? extractedError.message : String(extractedError);
          parseFailure = `JSON 解析错误：${detail}`;
        }
      }
    }
    if (parseFailure || value === undefined) {
      const finalParseFailure = parseFailure ?? "JSON 解析错误：解析结果为空。";
      await trace("error", {
        attempt,
        reportedTokens,
        rawContent: content,
        error: finalParseFailure,
      });
      addFailedAttempt(failureTokens, failureUsageEstimated);
      if (attempt < maximumAttempts) {
        prepareJsonFeedback(finalParseFailure, content);
        continue;
      }
      throw attachModelUsage(
        new Error(`模型 ${model} 连续 ${maximumAttempts} 次没有返回可解析 JSON：${finalParseFailure}`),
        priorFailureTokens,
        priorUsageEstimated,
      );
    }
    const validationIssues = dependencies.validateJson?.(value) ?? [];
    if (validationIssues.length > 0) {
      const validationFailure = `JSON 字段校验错误：${validationIssues.join("；")}`;
      await trace("error", {
        attempt,
        reportedTokens,
        rawContent: content,
        parsedValue: value,
        error: validationFailure,
      });
      addFailedAttempt(failureTokens, failureUsageEstimated);
      if (attempt < maximumAttempts) {
        prepareJsonFeedback(validationFailure, content);
        continue;
      }
      throw attachModelUsage(
        new Error(`模型 ${model} 连续 ${maximumAttempts} 次返回的 JSON 字段不完整：${validationIssues.join("；")}。`),
        priorFailureTokens,
        priorUsageEstimated,
      );
    }
    await trace("parsed", {
      attempt,
      reportedTokens,
      parseMode,
      parsedValue: value,
    });
    const successfulTokens = reportedTokens ?? estimateModelCallTokenBudget({
      system: requestSystem,
      prompt: requestPrompt,
      maxOutputTokens: Buffer.byteLength(content, "utf8"),
    });
    return {
      value,
      usageTokens: priorFailureTokens + successfulTokens,
      usageEstimated: priorUsageEstimated || reportedTokens === undefined,
    };
  }
  throw attachModelUsage(
    new Error(`模型 ${model} 连续重试后仍未返回结果。`),
    priorFailureTokens,
    priorUsageEstimated,
  );
}

const OPENING_PLANNER_OVERALL_TIMEOUT_MS = 600_000;

export interface OpeningCompletionRequest {
  connection: ModelConnection;
  model: string;
  system: string;
  prompt: string;
  timeout: number;
  maxTokens: number;
  overallTimeoutMs?: number;
  remainingTokens: number;
  stage: string;
  validateJson?: (value: unknown) => string[];
}

export type OpeningModelCompleter = (
  request: OpeningCompletionRequest,
) => Promise<{ value: unknown; usageTokens: number; usageEstimated: boolean }>;

export interface OpeningGenerationFailure {
  stage: string;
  attempt: number;
  error: unknown;
}

export type OpeningFailureObserver = (
  failure: OpeningGenerationFailure,
) => void | Promise<void>;

const defaultOpeningCompleter: OpeningModelCompleter = async (request) => completeJson<unknown>(
  request.connection,
  request.model,
  request.system,
  request.prompt,
  request.timeout,
  request.maxTokens,
  {
    overallTimeoutMs: request.overallTimeoutMs,
    remainingTokens: request.remainingTokens,
    stage: request.stage,
    validateJson: request.validateJson,
  },
);

export interface OpeningPlanPayload {
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
  narrationAssessments?: unknown;
}
export interface NarrationPermit {
  version: 1;
  contentHash: string;
  candidateIds: string[];
  decision: "semantic_allow" | "user_keep";
  attempt: number;
}

export interface OpeningNarrationReviewTrace {
  contentHash: string;
  candidates: NarrationCandidate[];
  resolution: NarrationReviewResolution;
  attempt: number;
  rewriteCount: number;
}

export function openingNarrationReviewsFromError(
  error: unknown,
): OpeningNarrationReviewTrace[] {
  if (!error || typeof error !== "object" || !("openingNarrationReviews" in error)) return [];
  const reviews = (error as { openingNarrationReviews?: unknown }).openingNarrationReviews;
  return Array.isArray(reviews)
    ? structuredClone(reviews as OpeningNarrationReviewTrace[])
    : [];
}

function attachOpeningNarrationReviews(
  error: unknown,
  reviews: readonly OpeningNarrationReviewTrace[],
): unknown {
  if (error && typeof error === "object") {
    Object.assign(error, { openingNarrationReviews: structuredClone(reviews) });
  }
  return error;
}

export interface PendingNarrationReviewDraft {
  contentHash: string;
  candidates: NarrationCandidate[];
  allCandidateIds: string[];
  resolution: NarrationReviewResolution;
  attempt: number;
  rewriteCount: number;
  baseReviewStatus: "valid" | "unavailable";
}

export interface OpeningDraftCheckpoint {
  title: string;
  paragraphs: string[];
  writerUsageTokens: number;
  writerUsageEstimated: boolean;
}

export interface OpeningGenerationCheckpoint {
  version: 1;
  context: OpeningGenerationContext;
  plan: Required<OpeningPlanPayload>;
  connectionBinding: {
    id: string;
    updatedAt: string;
    routes: ModelConnection["routes"];
  };
  attempt: number;
  rewriteCount: number;
  reviewerResumeCount: number;
  accumulatedTokens: number;
  usageEstimated: boolean;
  tokenBudget: number;
  draft: OpeningDraftCheckpoint;
  generated: GeneratedStoryOpening | null;
  reviewTrace?: OpeningNarrationReviewTrace[];
  review: PendingNarrationReviewDraft;
}

export type OpeningGenerationOutcome =
  | {
      status: "completed";
      generated: GeneratedStoryOpening;
      narrationPermit: NarrationPermit;
      narrationReviews?: OpeningNarrationReviewTrace[];
    }
  | {
      status: "awaiting_user_review";
      checkpoint: OpeningGenerationCheckpoint;
      review: PendingNarrationReviewDraft;
    };

export type NarrationReviewAction =
  | {
      kind: "keep";
      candidateIds: string[];
      contentHash: string;
    }
  | {
      kind: "rewrite";
      source: "user" | "timeout";
    };

export type OpeningProgressUpdate =
  | {
      stage: "drafting";
      activity: "writing";
      draftNumber: 1;
    }
  | {
      stage: "reviewing";
      activity: "checking";
      draftNumber: 1 | 2;
    }
  | {
      stage: "reviewing";
      activity: "revising";
      draftNumber: 2;
      revisionSource: "quality" | "user" | "timeout";
      revisionReason: OpeningRevisionReasonCode;
    };

export type OpeningProgressObserver = (
  update: OpeningProgressUpdate,
) => void | Promise<void>;

export function openingRevisionReasonForError(error: unknown): OpeningRevisionReasonCode {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (code.startsWith("narration_")) {
    return "narration_needs_polish";
  }
  const classification = classifyGenerationFailure(error);
  if (classification.reasonCode === "chapter_length" || classification.reasonCode === "chapter_too_short") {
    return "content_incomplete";
  }
  if (
    classification.category === "json" ||
    /(?:schema|plan|structure|candidate_plan)/i.test(classification.reasonCode)
  ) {
    return "structure_needs_adjustment";
  }
  if (/narration|metadata/.test(classification.reasonCode)) {
    return "narration_needs_polish";
  }
  if (
    classification.category === "quality" &&
    /experience|signal|evidence|system|invincible|persistent|outcome|continuity/.test(classification.reasonCode)
  ) {
    return "experience_not_clear";
  }
  return "quality_needs_adjustment";
}

interface OpeningWorkflowControl {
  pauseOnAskUser?: boolean;
  initialUsageTokens?: number;
  initialUsageEstimated?: boolean;
  startingWriterAttempt?: 1 | 2;
  initialFailureMessage?: string;
  initialRevisionSource?: "user" | "timeout";
  onProgress?: OpeningProgressObserver;
  chapterWriterUsageOverride?: {
    usageTokens: number;
    usageEstimated: boolean;
  };
  reviewerResumeCount?: number;
  onNarrationPermit?: (permit: NarrationPermit) => void;
  initialNarrationReviews?: OpeningNarrationReviewTrace[];
  onNarrationReview?: (review: OpeningNarrationReviewTrace) => void;
}

interface OpeningNarrationPauseDetails {
  checkpoint: OpeningGenerationCheckpoint;
  review: PendingNarrationReviewDraft;
}

const openingPlanJsonExample = JSON.stringify({
  title: "书名",
  subtitle: "一句话副标题",
  leadName: "主角姓名",
  storyGene: {
    protagonistPosition: "主角的起始身份与处境",
    visibleGoal: "主角主动追求的外在目标",
    hiddenNeed: "主角尚未正视的内在需要",
    conflictEngine: "可持续制造事件的核心冲突机制",
    recurringCost: "主角每次推进目标都要面对的持续代价",
    endingShape: "故事最终局面的形态",
    creativeAxes: ["题材机制", "人物关系", "世界变化"],
  },
  endingContract: {
    targetEnding: "明确的目标结局",
    characterArc: "主角从开篇到结局的变化",
    prerequisites: ["结局前必须完成的前置条件"],
  },
  worldBible: {
    organizations: ["至少一个组织"],
    locations: ["至少一个地点"],
    abilityBoundaries: ["能力或机制的明确边界"],
    pointOfView: "近距离第三人称",
    styleParameters: ["目标清晰、回报及时、冲突有效"],
  },
  experienceAxes: [{
    word: "第一个体验词",
    interpretation: "由哪些人物行动和事件结果兑现",
    observableSignals: [{
      description: "主角启动核心机制完成首次操作，现场资源立即增加",
      evidenceAnchors: ["启动核心机制", "现场资源立即增加"],
    }, {
      description: "主角调动新增资源解决眼前阻碍，周围势力当场改变态度",
      evidenceAnchors: ["调动新增资源", "周围势力当场改变态度"],
    }],
    hardPromises: ["本章必须兑现的承诺"],
    forbiddenShortcuts: ["禁止的敷衍写法"],
  }, {
    word: "第二个体验词",
    interpretation: "由哪些人物行动和事件结果兑现",
    observableSignals: [{
      description: "主角作出关键选择兑现人物体验，同行者立刻调整行动",
      evidenceAnchors: ["作出关键选择", "同行者立刻调整行动"],
    }, {
      description: "主角承担关系风险保护重要对象，对方主动回应并改变方案",
      evidenceAnchors: ["承担关系风险", "对方主动回应并改变方案"],
    }],
    hardPromises: ["本章必须兑现的承诺"],
    forbiddenShortcuts: ["禁止的敷衍写法"],
  }],
  openingBeats: ["首段发生的具体事件", "第一章中段的行动结果", "章末推动下一事件的变化"],
});

const openingReviewJsonExample = JSON.stringify({
  experienceEvidence: [{
    axisId: "primary",
    word: "第一个体验词",
    signalIds: ["契约中真实命中的信号 ID"],
    quote: "从正文逐字复制的连续原句证据",
  }],
  event: {
    title: "正文事件名称",
    cause: "正文已经写明的事件原因",
    outcome: "正文已经写明的事件结果",
    location: "正文中的具体地点",
    persistentFacts: ["正文逐字原句事实一", "正文逐字原句事实二"],
  },
});

function isOpeningPlanRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOpeningNonEmptyString(value: unknown, minimumLength = 1): value is string {
  return typeof value === "string" && value.trim().length >= minimumLength;
}

function isOpeningStringArray(value: unknown, minimumItems: number, itemMinimumLength = 1): value is string[] {
  return Array.isArray(value) && value.length >= minimumItems &&
    value.every((item) => isOpeningNonEmptyString(item, itemMinimumLength));
}

function isOpeningExperienceAxes(value: unknown): value is ModelExperienceAxisDraft[] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  return value.every((entry) => {
    if (!isOpeningPlanRecord(entry)) return false;
    if (!isOpeningNonEmptyString(entry.word) || !isOpeningNonEmptyString(entry.interpretation)) return false;
    if (!Array.isArray(entry.observableSignals) || entry.observableSignals.length < 2) return false;
    const validSignals = entry.observableSignals.every((signal) => {
      if (isOpeningNonEmptyString(signal)) return true;
      return isOpeningPlanRecord(signal) && isOpeningNonEmptyString(signal.description) &&
        isOpeningStringArray(signal.evidenceAnchors, 2);
    });
    return validSignals && isOpeningStringArray(entry.hardPromises, 1) &&
      Array.isArray(entry.forbiddenShortcuts) && entry.forbiddenShortcuts.every((item) => isOpeningNonEmptyString(item));
  });
}

function mergeOpeningPlanSchemaRepair(original: unknown, proposal: unknown): unknown {
  if (!isOpeningPlanRecord(original) || !isOpeningPlanRecord(proposal)) return proposal;
  const chooseString = (key: string) => isOpeningNonEmptyString(original[key]) ? original[key] : proposal[key];
  const mergeSection = (
    key: string,
    stringKeys: string[],
    arrayRules: Array<[key: string, minimumItems: number]>,
  ) => {
    const before = isOpeningPlanRecord(original[key]) ? original[key] : {};
    const after = isOpeningPlanRecord(proposal[key]) ? proposal[key] : {};
    return Object.fromEntries([
      ...stringKeys.map((field) => [field, isOpeningNonEmptyString(before[field]) ? before[field] : after[field]]),
      ...arrayRules.map(([field, minimumItems]) => [
        field,
        isOpeningStringArray(before[field], minimumItems) ? before[field] : after[field],
      ]),
    ]);
  };
  return {
    title: chooseString("title"),
    subtitle: chooseString("subtitle"),
    leadName: chooseString("leadName"),
    storyGene: mergeSection(
      "storyGene",
      ["protagonistPosition", "visibleGoal", "hiddenNeed", "conflictEngine", "recurringCost", "endingShape"],
      [["creativeAxes", 3]],
    ),
    endingContract: mergeSection("endingContract", ["targetEnding", "characterArc"], [["prerequisites", 1]]),
    worldBible: mergeSection(
      "worldBible",
      ["pointOfView"],
      [["organizations", 1], ["locations", 1], ["abilityBoundaries", 1], ["styleParameters", 1]],
    ),
    experienceAxes: isOpeningExperienceAxes(original.experienceAxes) ? original.experienceAxes : proposal.experienceAxes,
    openingBeats: isOpeningStringArray(original.openingBeats, 2, 4) ? original.openingBeats : proposal.openingBeats,
  };
}

function openingPlanSemanticRepairTargets(
  value: unknown,
  baseContract: ReadingExperienceContract,
): string[] {
  if (!hasOpeningPlanShape(value)) return [];
  const targets = new Set<string>();
  try {
    refineReadingExperienceContract(baseContract, value.experienceAxes);
  } catch {
    targets.add("experienceAxes");
  }
  const sections: Array<[string, Record<string, unknown>]> = [
    ["storyGene", value.storyGene as unknown as Record<string, unknown>],
    ["endingContract", value.endingContract as unknown as Record<string, unknown>],
    ["worldBible", value.worldBible as unknown as Record<string, unknown>],
  ];
  const collectNegativeInvariantTargets = (experienceContext = "") => {
    for (const [sectionName, section] of sections) {
      for (const [field, fieldValue] of Object.entries(section)) {
        try {
          assertReadingExperienceNegativeInvariants(
            baseContract,
            `${experienceContext}${JSON.stringify({ [sectionName]: { [field]: fieldValue } })}`,
            { protagonistNames: [value.leadName] },
          );
        } catch {
          targets.add(`${sectionName}.${field}`);
        }
      }
    }
  };
  collectNegativeInvariantTargets();
  if (targets.size === 0) {
    collectNegativeInvariantTargets(`阅读体验词：${baseContract.sourceWords.join("、")}，字段内容：`);
  }
  return [...targets];
}

function mergeOpeningPlanSemanticRepair(original: unknown, proposal: unknown, targets: string[]): unknown {
  if (!hasOpeningPlanShape(original) || !isOpeningPlanRecord(proposal)) return original;
  const result: Record<string, unknown> = {
    title: original.title,
    subtitle: original.subtitle,
    leadName: original.leadName,
    storyGene: { ...original.storyGene },
    endingContract: { ...original.endingContract },
    worldBible: { ...original.worldBible },
    experienceAxes: original.experienceAxes,
    openingBeats: original.openingBeats,
  };
  for (const target of targets) {
    if (target === "experienceAxes") {
      result.experienceAxes = proposal.experienceAxes;
      continue;
    }
    const [sectionName, field] = target.split(".");
    if (!field || !isOpeningPlanRecord(result[sectionName]) || !isOpeningPlanRecord(proposal[sectionName])) continue;
    (result[sectionName] as Record<string, unknown>)[field] =
      (proposal[sectionName] as Record<string, unknown>)[field];
  }
  return result;
}

function openingPlanValidationIssues(value: unknown): string[] {
  if (!isOpeningPlanRecord(value)) return ["根节点必须是 JSON 对象"];
  const issues: string[] = [];
  const requireString = (record: Record<string, unknown>, path: string, key: string) => {
    const field = record[key];
    if (typeof field !== "string" || !field.trim()) issues.push(`${path} 必须是非空字符串`);
  };
  const requireStringArray = (
    record: Record<string, unknown>,
    path: string,
    key: string,
    minimum: number,
    itemMinimumLength = 1,
  ) => {
    const field = record[key];
    if (!Array.isArray(field) || field.length < minimum) {
      issues.push(`${path} 必须是至少 ${minimum} 项的字符串数组`);
      return;
    }
    field.forEach((item, index) => {
      if (typeof item !== "string" || item.trim().length < itemMinimumLength) {
        issues.push(`${path}[${index}] 必须是至少 ${itemMinimumLength} 字的字符串`);
      }
    });
  };
  const requireObject = (key: string): Record<string, unknown> | undefined => {
    const field = value[key];
    if (!isOpeningPlanRecord(field)) {
      issues.push(`${key} 必须是 JSON 对象`);
      return undefined;
    }
    return field;
  };

  requireString(value, "title", "title");
  requireString(value, "subtitle", "subtitle");
  requireString(value, "leadName", "leadName");

  const gene = requireObject("storyGene");
  if (gene) {
    for (const key of ["protagonistPosition", "visibleGoal", "hiddenNeed", "conflictEngine", "recurringCost", "endingShape"]) {
      requireString(gene, `storyGene.${key}`, key);
    }
    requireStringArray(gene, "storyGene.creativeAxes", "creativeAxes", 3);
  }

  const ending = requireObject("endingContract");
  if (ending) {
    requireString(ending, "endingContract.targetEnding", "targetEnding");
    requireString(ending, "endingContract.characterArc", "characterArc");
    requireStringArray(ending, "endingContract.prerequisites", "prerequisites", 1);
  }

  const bible = requireObject("worldBible");
  if (bible) {
    requireStringArray(bible, "worldBible.organizations", "organizations", 1);
    requireStringArray(bible, "worldBible.locations", "locations", 1);
    requireStringArray(bible, "worldBible.abilityBoundaries", "abilityBoundaries", 1);
    requireString(bible, "worldBible.pointOfView", "pointOfView");
    requireStringArray(bible, "worldBible.styleParameters", "styleParameters", 1);
  }

  if (!isOpeningExperienceAxes(value.experienceAxes)) {
    issues.push("experienceAxes 必须是严格对应两个体验词、且字段完整的 2 项数组");
  }
  requireStringArray(value, "openingBeats", "openingBeats", 2, 4);
  return issues;
}

function hasOpeningPlanShape(value: unknown): value is Required<OpeningPlanPayload> {
  return openingPlanValidationIssues(value).length === 0;
}

function openingReviewValidationIssues(value: unknown): string[] {
  if (!isOpeningPlanRecord(value)) return ["审稿根节点必须是 JSON 对象"];
  const issues: string[] = [];
  if (!Array.isArray(value.experienceEvidence) || value.experienceEvidence.length > 2) {
    issues.push("experienceEvidence 必须是仅包含实际硬性交付轴证据的 0—2 项数组");
  } else {
    value.experienceEvidence.forEach((entry, index) => {
      if (!isOpeningPlanRecord(entry)) {
        issues.push(`experienceEvidence[${index}] 必须是 JSON 对象`);
        return;
      }
      for (const key of ["axisId", "word", "quote"]) {
        const field = entry[key];
        const minimum = key === "quote" ? 8 : 1;
        if (typeof field !== "string" || field.trim().length < minimum) {
          issues.push(`experienceEvidence[${index}].${key} 必须是至少 ${minimum} 字的字符串`);
        }
      }
      if (
        !Array.isArray(entry.signalIds) || entry.signalIds.length < 1 ||
        entry.signalIds.some((signalId) => typeof signalId !== "string" || !signalId.trim())
      ) {
        issues.push(`experienceEvidence[${index}].signalIds 必须是非空字符串数组`);
      }
    });
  }
  const event = value.event;
  if (!isOpeningPlanRecord(event)) {
    issues.push("event 必须是 JSON 对象");
    return issues;
  }
  for (const key of ["title", "cause", "outcome", "location"]) {
    const field = event[key];
    if (typeof field !== "string" || field.trim().length < 4) {
      issues.push(`event.${key} 必须是至少 4 字的字符串`);
    }
  }
  if (
    !Array.isArray(event.persistentFacts) || event.persistentFacts.length > 8 ||
    event.persistentFacts.some((fact) => typeof fact !== "string" || fact.trim().length < 8)
  ) {
    issues.push("event.persistentFacts 必须是 0—8 条至少 8 字的字符串数组；允许留空后从已验证体验证据补齐");
  }
  return issues;
}

function isOpeningReviewEvidence(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 2 && value.every((entry) =>
    isOpeningPlanRecord(entry) &&
    isOpeningNonEmptyString(entry.axisId) &&
    isOpeningNonEmptyString(entry.word) &&
    isOpeningNonEmptyString(entry.quote, 8) &&
    isOpeningStringArray(entry.signalIds, 1),
  );
}

function mergeOpeningReviewSchemaRepair(original: unknown, proposal: unknown): unknown {
  if (!isOpeningPlanRecord(original) || !isOpeningPlanRecord(proposal)) return proposal;
  const beforeEvent = isOpeningPlanRecord(original.event) ? original.event : {};
  const afterEvent = isOpeningPlanRecord(proposal.event) ? proposal.event : {};
  const chooseEventString = (field: string) =>
    isOpeningNonEmptyString(beforeEvent[field], 4) ? beforeEvent[field] : afterEvent[field];
  const beforeFactsAreValid = Array.isArray(beforeEvent.persistentFacts) && beforeEvent.persistentFacts.length <= 8 &&
    beforeEvent.persistentFacts.every((fact) => isOpeningNonEmptyString(fact, 8));
  return {
    experienceEvidence: isOpeningReviewEvidence(original.experienceEvidence)
      ? original.experienceEvidence
      : proposal.experienceEvidence,
    narrationAssessments: "narrationAssessments" in original
      ? original.narrationAssessments
      : proposal.narrationAssessments,
    event: {
      title: chooseEventString("title"),
      cause: chooseEventString("cause"),
      outcome: chooseEventString("outcome"),
      location: chooseEventString("location"),
      persistentFacts: beforeFactsAreValid ? beforeEvent.persistentFacts : afterEvent.persistentFacts,
    },
  };
}

function hasOpeningReviewShape(value: unknown): value is Required<OpeningReviewPayload> {
  return openingReviewValidationIssues(value).length === 0;
}

function openingWriterValidationIssues(value: unknown): string[] {
  if (!isOpeningPlanRecord(value)) return ["正文根节点必须是 JSON 对象"];
  const issues: string[] = [];
  if (typeof value.title !== "string" || !value.title.trim()) {
    issues.push("title 必须是非空字符串");
  }
  if (!Array.isArray(value.paragraphs)) {
    issues.push("paragraphs 必须是数组");
  } else {
    if (value.paragraphs.length < 4) {
      issues.push("paragraphs 必须至少包含 4 个完整段落");
    }
    value.paragraphs.forEach((paragraph, index) => {
      if (typeof paragraph !== "string" || !paragraph.trim()) {
        issues.push(`paragraphs[${index}] 必须是非空字符串`);
      }
    });
  }
  return issues;
}

function narrationCandidateIds(candidates: readonly NarrationCandidate[]): string[] {
  return candidates.map((candidate) => candidate.id);
}

function sameCandidateIds(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((value, index) => value === right[index]);
}

function issueNarrationPermit(
  contentHash: string,
  candidates: readonly NarrationCandidate[],
  decision: NarrationPermit["decision"],
  attempt: number,
): NarrationPermit {
  return {
    version: 1,
    contentHash,
    candidateIds: narrationCandidateIds(candidates),
    decision,
    attempt,
  };
}

function openingNarrationPauseError(
  details: OpeningNarrationPauseDetails,
): Error {
  return attachModelUsage(
    Object.assign(new Error("Opening narration review is awaiting user input."), {
      code: "narration_review_pending",
      openingNarrationPause: details,
    }),
    details.checkpoint.accumulatedTokens,
    details.checkpoint.usageEstimated,
  );
}

function openingNarrationPauseDetails(error: unknown): OpeningNarrationPauseDetails | null {
  if (!error || typeof error !== "object") return null;
  const details = (error as { openingNarrationPause?: unknown }).openingNarrationPause;
  if (!details || typeof details !== "object") return null;
  const candidate = details as OpeningNarrationPauseDetails;
  return candidate.checkpoint?.version === 1 ? candidate : null;
}

function invalidOpeningCheckpoint(
  checkpoint: OpeningGenerationCheckpoint,
): never {
  throw attachModelUsage(
    Object.assign(new Error("Opening narration review checkpoint is invalid."), {
      code: "narration_review_checkpoint_invalid",
    }),
    checkpoint.accumulatedTokens,
    checkpoint.usageEstimated,
  );
}

function assertOpeningCheckpoint(
  checkpoint: OpeningGenerationCheckpoint,
  connection: ModelConnection,
): NarrationCandidate[] {
  if (
    checkpoint.version !== 1 ||
    checkpoint.attempt < 1 ||
    checkpoint.attempt > 2 ||
    checkpoint.rewriteCount !== checkpoint.attempt - 1 ||
    checkpoint.accumulatedTokens < 0 ||
    checkpoint.tokenBudget <= 0 ||
    checkpoint.connectionBinding.id !== connection.id ||
    checkpoint.connectionBinding.updatedAt !== connection.updatedAt ||
    checkpoint.connectionBinding.routes.planner !== connection.routes.planner ||
    checkpoint.connectionBinding.routes.writer !== connection.routes.writer ||
    checkpoint.connectionBinding.routes.extractor !== connection.routes.extractor ||
    checkpoint.connectionBinding.routes.embedding !== connection.routes.embedding
  ) {
    invalidOpeningCheckpoint(checkpoint);
  }
  const contentHash = narrationArtifactHash(
    checkpoint.draft.title,
    checkpoint.draft.paragraphs,
  );
  const content = checkpoint.draft.paragraphs.join("\n");
  const candidates = [
    ...detectNarrationCandidates("title", checkpoint.draft.title, contentHash),
    ...detectNarrationCandidates("body", content, contentHash),
  ];
  if (
    contentHash !== checkpoint.review.contentHash ||
    checkpoint.review.attempt !== checkpoint.attempt ||
    checkpoint.review.rewriteCount !== checkpoint.rewriteCount ||
    !sameCandidateIds(narrationCandidateIds(candidates), checkpoint.review.allCandidateIds) ||
    !checkpoint.review.candidates.every((candidate) =>
      checkpoint.review.allCandidateIds.includes(candidate.id)
    ) ||
    checkpoint.review.candidates.length === 0 ||
    (checkpoint.review.baseReviewStatus === "valid" && checkpoint.generated === null) ||
    (checkpoint.review.baseReviewStatus === "unavailable" && checkpoint.generated !== null)
  ) {
    invalidOpeningCheckpoint(checkpoint);
  }
  if (checkpoint.generated) {
    const generatedHash = narrationArtifactHash(
      normalizeChapterTitle(checkpoint.generated.chapter.title),
      checkpoint.generated.chapter.paragraphs,
    );
    if (
      generatedHash !== contentHash ||
      checkpoint.generated.usageTokens !== checkpoint.accumulatedTokens
    ) {
      invalidOpeningCheckpoint(checkpoint);
    }
  }
  return candidates;
}
export async function generateStoryOpeningWithConnection(
  context: OpeningGenerationContext,
  connection: ModelConnection,
  complete: OpeningModelCompleter = defaultOpeningCompleter,
  tokenBudget = OPENING_JOB_TOKEN_BUDGET,
  failureObserver?: OpeningFailureObserver,
  workflowControl: OpeningWorkflowControl = {},
): Promise<GeneratedStoryOpening> {
  const observeFailure = async (failure: OpeningGenerationFailure) => {
    try {
      await failureObserver?.(failure);
    } catch (error) {
      console.error(`[FAILURE-OBSERVATION] 记录开篇失败观测失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const observeProgress = async (update: OpeningProgressUpdate) => {
    try {
      await workflowControl.onProgress?.(update);
    } catch {
      console.error("[OPENING-PROGRESS] 持久化开篇进度失败，生成任务继续运行。");
    }
  };
  const plannerRequest: OpeningCompletionRequest = {
    connection,
    model: connection.routes.planner,
    system: [
      "你是原创中文网文总规划师，只返回 JSON。",
      "把用户给出的两个阅读体验词解释为人物行动、机制、冲突结果、世界反应和语言节奏上的可观察承诺；不得把词语直接贴到景物描写上。",
      "开篇必须先发生具体事件：前 200 字给出主角处境、触发事件和第一个行动；第一章内兑现所有硬性交付体验，软窗口体验只需保持长期方向且不能被最终结果推翻。",
      "不要模仿或点名任何在世作者；使用成熟网文的目标清晰、回报及时、冲突有效和章末推动力等通用技巧。",
      "若体验词包含“系统”，任何蓝图字段都不得把系统故障、拒绝结算、撤回奖励、冻结权限或不可使用当作代价与边界；若包含“无敌”，不得安排已经落地的最终落败、他人救场、永久封印或能力移除，但允许暂时受压、势均力敌与冲突未决。持续代价来自力量与既有状态带来的世界、资源或关系变化，不能收回核心体验。",
      "严格按下面的 JSON 结构返回，禁止增加外层包装。storyGene、endingContract、worldBible 必须是 JSON 对象，不能写成字符串；openingBeats 必须是字符串数组，不能写成对象数组。",
      "下面各字段中的文字只说明数据形状，不是故事内容；必须根据题材、灵感和两个体验词全部改写，禁止照抄示例语句。",
      openingPlanJsonExample,
      "experienceAxes 必须按用户两个词的顺序，每项含 word,interpretation,observableSignals(至少2项对象),hardPromises(至少1项),forbiddenShortcuts。每个 observableSignals 对象含 description 与 evidenceAnchors：evidenceAnchors 给出 2—6 个来自 description 本身的语义识别参考，至少分别覆盖一个具体动作和一个对象或结果，禁止只填人物称谓、体验词或“行动/结果”等泛词；参考短语用于帮助识别语义，不要求正文逐字复制。对自定义词，解释、信号或硬承诺中必须原样出现该词并说明它如何由行动兑现。",
    ].join("\n"),
    prompt: [
      `题材：${context.input.genre}`,
      `两个阅读体验词：${context.contract.sourceWords.join(" · ")}`,
      `用户灵感：${context.input.inspiration?.trim() || "由模型原创"}`,
      `预计篇幅：${context.targetChapterCount}章`,
      `本地基础契约仅供参考：${JSON.stringify(context.contract)}`,
      "规划必须使两个词在同一故事机制中兼容；体验硬承诺优先于题材默认套路。",
    ].join("\n"),
    timeout: GENERATION_STAGE_TIMEOUT_MS.planner,
    maxTokens: 2_600,
    overallTimeoutMs: OPENING_PLANNER_OVERALL_TIMEOUT_MS,
    remainingTokens: tokenBudget,
    stage: "开篇规划",
    validateJson: openingPlanValidationIssues,
  };
  assertModelCallTokenBudget({
    remainingTokens: tokenBudget,
    system: plannerRequest.system,
    prompt: plannerRequest.prompt,
    maxOutputTokens: plannerRequest.maxTokens,
    stage: "开篇规划",
  });
  const planner = await complete(plannerRequest);
  let accumulatedTokens = (workflowControl.initialUsageTokens ?? 0) + planner.usageTokens;
  let usageEstimated = (workflowControl.initialUsageEstimated ?? false) || planner.usageEstimated;
  let planValue = planner.value;
  let planIssues = openingPlanValidationIssues(planValue);
  let schemaPlanRepairCount = 0;
  let semanticPlanRepairCount = 0;
  const repairPlan = async (
    issues: string[],
    mode: "schema" | "semantic",
    semanticTargets: string[] = [],
  ): Promise<unknown> => {
    const repairRequest: OpeningCompletionRequest = {
      connection,
      model: connection.routes.extractor,
      system: [
        "你是开篇蓝图 JSON 结构修复与硬契约校正器，只返回修复后的 JSON。",
        "保留原蓝图的书名、人物、机制、事件与体验承诺，只修复指定问题并补齐必填字段；不要写小说正文，不要解释，不要增加外层包装。",
        "若体验词包含“系统”，删除系统故障、拒绝结算、撤回奖励、冻结权限或不可使用等削弱设定；若包含“无敌”，只删除已经落地的最终落败、他人救场、永久封印或能力移除，保留暂时受压、势均力敌与冲突未决。把代价改为力量与既有状态带来的世界、资源或关系后果，绝不收回核心体验。",
        "storyGene、endingContract、worldBible 必须是 JSON 对象，openingBeats 必须是字符串数组。严格采用以下结构：",
        openingPlanJsonExample,
      ].join("\n"),
      prompt: [
        `当前校验问题：${issues.join("；")}`,
        `两个阅读体验词（顺序不可改变）：${context.contract.sourceWords.join(" · ")}`,
        `题材：${context.input.genre}`,
        `原始蓝图：${JSON.stringify(planValue)}`,
        "逐字段删除或改写所有触发问题的原句，不能只在前面添加否定词，也不能保留违规设定再解释它不会发生；原始蓝图缺少的必填内容，应根据已有语义作最小补齐。",
      ].join("\n"),
      timeout: GENERATION_STAGE_TIMEOUT_MS.reviewer,
      maxTokens: 3_200,
      remainingTokens: tokenBudget - accumulatedTokens,
      stage: "开篇蓝图修复",
      validateJson: openingPlanValidationIssues,
    };
    if (mode === "schema") schemaPlanRepairCount += 1;
    else semanticPlanRepairCount += 1;
    try {
      assertModelCallTokenBudget({
        remainingTokens: tokenBudget - accumulatedTokens,
        system: repairRequest.system,
        prompt: repairRequest.prompt,
        maxOutputTokens: repairRequest.maxTokens,
        stage: "开篇蓝图修复",
      });
      const repair = await complete(repairRequest);
      accumulatedTokens += repair.usageTokens;
      usageEstimated ||= repair.usageEstimated;
      return mode === "schema"
        ? mergeOpeningPlanSchemaRepair(planValue, repair.value)
        : mergeOpeningPlanSemanticRepair(planValue, repair.value, semanticTargets);
    } catch (error) {
      throw addModelUsage(error, accumulatedTokens, usageEstimated);
    }
  };
  const interpretPlan = (candidate: unknown) => {
    if (!hasOpeningPlanShape(candidate)) {
      throw new Error(`规划模型输出未通过开篇蓝图 Schema 校验：${openingPlanValidationIssues(candidate).join("；")}。`);
    }
    const plan = candidate;
    const contract = refineReadingExperienceContract(context.contract, plan.experienceAxes);
    assertReadingExperienceNegativeInvariants(contract, JSON.stringify({
      storyGene: plan.storyGene,
      endingContract: plan.endingContract,
      worldBible: plan.worldBible,
    }), { protagonistNames: [plan.leadName] });
    return { plan, contract };
  };
  let plan!: Required<OpeningPlanPayload>;
  let contract!: ReadingExperienceContract;
  const maxSchemaPlanRepairs = 2;
  const maxSemanticPlanRepairs = 2;
  while (true) {
    planIssues = openingPlanValidationIssues(planValue);
    if (planIssues.length > 0) {
      if (schemaPlanRepairCount >= maxSchemaPlanRepairs) {
        throw attachModelUsage(
          new Error(`规划模型输出未通过开篇蓝图 Schema 校验：${planIssues.join("；")}。`),
          accumulatedTokens,
          usageEstimated,
        );
      }
      await observeFailure({
        stage: "开篇蓝图结构校验",
        attempt: schemaPlanRepairCount + 1,
        error: new Error(`规划模型输出未通过开篇蓝图 Schema 校验：${planIssues.join("；")}。`),
      });
      planValue = await repairPlan(planIssues, "schema");
      continue;
    }
    try {
      ({ plan, contract } = interpretPlan(planValue));
      break;
    } catch (error) {
      const semanticIssue = error instanceof Error ? error.message : "蓝图违反阅读体验硬契约";
      const semanticTargets = openingPlanSemanticRepairTargets(planValue, context.contract);
      if (semanticTargets.length === 0) {
        throw attachModelUsage(error, accumulatedTokens, usageEstimated);
      }
      if (semanticPlanRepairCount >= maxSemanticPlanRepairs) {
        throw attachModelUsage(error, accumulatedTokens, usageEstimated);
      }
      await observeFailure({
        stage: "开篇蓝图语义校验",
        attempt: semanticPlanRepairCount + 1,
        error,
      });
      planValue = await repairPlan(
        [`${semanticIssue}；仅允许修复字段：${semanticTargets.join("、")}`],
        "semantic",
        semanticTargets,
      );
    }
  }
  const specializedOpeningInstructions: string[] = [];
  const hardOpeningAxes = contract.axes.filter((axis) =>
    !readingExperienceAxisUsesSoftWindow(contract, axis.id)
  );
  const softOpeningAxes = contract.axes.filter((axis) =>
    readingExperienceAxisUsesSoftWindow(contract, axis.id)
  );
  if (contract.sourceWords.includes("系统")) {
    specializedOpeningInstructions.push(
      `系统体验强制前置：第一段前 120 字内，${plan.leadName}本人必须主动触发系统或打开面板，系统必须立即反馈并结算、发放一项永久可用的奖励、权限或能力，${plan.leadName}须在第一段结束前领取或调用它。至少安排一句不超过 100 字的独立原句，在同一句中明确写出${plan.leadName}打开系统面板、系统发放永久奖励，以及${plan.leadName}点击领取或立即调用；不得把这三步拆散后只用“他”或界面提示代称。不得先写背景，且不得先写赶路、旁观、调查、回忆或长篇环境铺陈。`,
      "系统稳定性写法：不要把上方禁止捷径中的词语复制进小说；只用正面事实写系统持续在线、即时结算、奖励与权限永久生效，并通过主角反复调用后的实际结果证明。",
    );
  }
  if (softOpeningAxes.length > 0) {
    specializedOpeningInstructions.push(
      `${softOpeningAxes.map((axis) => `“${axis.word}”`).join("、")}是跨章节奏主旋律，不是第一章逐句硬指标：本章允许铺垫、暂时五五开或把冲突保持未决，但不得让${plan.leadName}形成已经落地的最终失败。若本章自然安排压倒性胜利，必须由${plan.leadName}本人完成，并写出对手、旁观者、资源、身份或现场秩序的明确现实变化；不要为了过校验强塞固定胜利句。`,
    );
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
    `用户原始灵感（具体设定与结果必须保留）：${context.input.inspiration?.trim() || "由模型原创"}`,
    formatReadingExperienceForPrompt(contract, 1),
    ...specializedOpeningInstructions,
    `写第一章正文。建议写约 ${OPENING_CHAPTER_TARGET_CHARACTERS} 个中文字符、约 18 个完整段落，每段通常 100—220 个中文字符；这些仅是写作建议，可以为完整叙事自然超出，不设最高字数。去除空白后的正文不得少于 ${OPENING_CHAPTER_MIN_CHARACTERS} 字。不要用大量短段凑数。首段直接进入事件；前 15% 兑现所有硬性交付体验轴；软窗口体验只需保持主旋律且不能被最终结果推翻，不要求第一章取胜。本章必须出现一次有分量的行动结果与世界反应。对模型细化的自定义体验轴，正文不必出现体验词本身，须直接写出对应信号约定的人物、动作、对象与结果，禁止贴标签或把词拼到天光、晨雾等景物上。`,
    `只返回 JSON：{\"title\":\"章名\",\"paragraphs\":[\"完整段落\"]}。${IMMERSIVE_NARRATION_PROMPT}`,
  ].join("\n");
  const writerSystem = "你是原创中文长篇网文作家。用现场动作、人物选择、冲突结果和具体关系写作；回报及时，因果清楚，禁止作者侧元叙事。只返回符合要求的 JSON。";
  const traceOpeningDraftFailure = async (
    attempt: number,
    title: string,
    paragraphs: string[],
    error: unknown,
  ) => {
    await writeAiTrace({
      event: "error",
      timestamp: new Date().toISOString(),
      callId: randomUUID(),
      attempt,
      stage: "开篇正文质量校验",
      connectionId: connection.id,
      model: connection.routes.writer,
      prompt: `${title}\n${paragraphs.join("\n")}`,
      parsedValue: { title, paragraphs },
      error: error instanceof Error ? error.message : String(error),
    });
    await observeFailure({ stage: "开篇正文质量校验", attempt, error });
  };

  let lastFailure: unknown = workflowControl.initialFailureMessage
    ? new Error(workflowControl.initialFailureMessage)
    : undefined;
  const narrationReviewTrace = structuredClone(workflowControl.initialNarrationReviews ?? []);
  for (let attempt = workflowControl.startingWriterAttempt ?? 1; attempt <= 2; attempt += 1) {
    let writer: Awaited<ReturnType<OpeningModelCompleter>>;
    const replayingDraft = workflowControl.chapterWriterUsageOverride !== undefined &&
      attempt === (workflowControl.startingWriterAttempt ?? 1);
    if (!replayingDraft) {
      if (attempt === 1) {
        await observeProgress({
          stage: "drafting",
          activity: "writing",
          draftNumber: 1,
        });
      } else {
        await observeProgress({
          stage: "reviewing",
          activity: "revising",
          draftNumber: 2,
          revisionSource: workflowControl.initialRevisionSource ?? "quality",
          revisionReason: openingRevisionReasonForError(lastFailure),
        });
      }
    }
    const recoveryHint = lastFailure instanceof Error && /系统.*(?:稳定结算|持续可用|不可操作|无反馈|无奖励)/.test(lastFailure.message)
      ? "本次重写只用正面事实表现系统持续在线、即时结算、奖励与权限永久生效，代价来自已获状态带来的世界、资源或关系变化。"
      : "本次重写逐项兑现失败原因，并让动作、对象、结果与现场反应出现在相邻句段中；软窗口体验不要求补写本章胜利。";
    const attemptPrompt = attempt === 1
      ? writerPrompt
      : `${writerPrompt}\n上一稿未通过沉浸感或阅读体验检查，请彻底重写，不要解释。失败原因：${lastFailure instanceof Error ? lastFailure.message : "质量证据不足"}\n${recoveryHint}`;
    const writerRequest: OpeningCompletionRequest = {
      connection,
      model: connection.routes.writer,
      system: writerSystem,
      prompt: attemptPrompt,
      timeout: GENERATION_STAGE_TIMEOUT_MS.writer,
      maxTokens: 6_500,
      remainingTokens: tokenBudget - accumulatedTokens,
      stage: "开篇正文",
      validateJson: openingWriterValidationIssues,
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
      written.paragraphs.length < 4 ||
      !written.paragraphs.every((paragraph) => typeof paragraph === "string" && paragraph.trim().length > 0)
    ) {
      lastFailure = new Error("正文模型输出未通过开篇 Schema 校验：至少需要 4 个非空完整段落。");
      continue;
    }
    const normalizedChapterTitle = normalizeChapterTitle(written.title);
    if (!normalizedChapterTitle) {
      lastFailure = new Error("正文模型只返回了章节序号，没有提供有效章名。");
      continue;
    }
    const paragraphs = written.paragraphs.map((paragraph) => paragraph.trim());
    const content = paragraphs.join("\n");
    const contentHash = narrationArtifactHash(normalizedChapterTitle, paragraphs);
    const narrationCandidates = [
      ...detectNarrationCandidates("title", normalizedChapterTitle, contentHash),
      ...detectNarrationCandidates("body", content, contentHash),
    ];
    const validationContext = {
      protagonistNames: [plan.leadName],
      opening: true,
      chapterNumber: 1,
    };
    const characterCount = openingChapterCharacterCount(content);
    if (!openingChapterLengthIsAllowed(content)) {
      lastFailure = new Error(
        `正文字数为 ${characterCount} 字，最低要求 ${OPENING_CHAPTER_MIN_CHARACTERS} 字。`,
      );
      await traceOpeningDraftFailure(attempt, normalizedChapterTitle, paragraphs, lastFailure);
      continue;
    }
    try {
      assertOpeningNarrationStructure(normalizedChapterTitle, content);
      assertReadingExperienceContent(contract, content, validationContext);
    } catch (error) {
      lastFailure = error;
      await traceOpeningDraftFailure(attempt, normalizedChapterTitle, paragraphs, error);
      continue;
    }
    const reviewerRequest: OpeningCompletionRequest = {
      connection,
      model: connection.routes.extractor,
      system: [
        "你是独立的中文小说质量审稿与正史事件抽取器，只返回 JSON。不得替正文补事实，也不得仅因出现体验词就判定兑现。",
        "严格返回 experienceEvidence 0—2 项数组（仅包含实际硬性交付轴，每个硬轴至多一项）与 event 对象，禁止增加外层包装；quote 和 persistentFacts 必须从正文逐字复制，禁止概括、改写或补标点。",
        openingReviewJsonExample,
        narrationReviewerInstruction(narrationCandidates),
      ].join("\n"),
      prompt: [
        `体验契约：${JSON.stringify(contract)}`,
        `正文：${normalizedChapterTitle}\n${content}`,
        `第一章硬性必需 signalIds：${JSON.stringify(contract.openingRequirements.find((requirement) => requirement.chapterOffset === 0)?.requiredSignalIds ?? [])}。硬性交付轴=${hardOpeningAxes.map((axis) => `${axis.id}:${axis.word}`).join("、") || "无"}；仅这些轴的 signalIds 必须列出正文实际兑现的本轴必需 ID。`,
        "只为硬性交付轴返回正文中的连续原句证据以及命中的 signalIds；软窗口轴不要求本章出现正向证据，缺少胜利、铺垫、暂时五五开或冲突未决都不能据此判稿件失败。按大意判断硬轴证据是否具体兑现了人物、动作、对象、结果或感官变化；quote 必须从正文逐字复制。若硬轴同时有 _model_signal_ 与基础 signal，signalIds 必须各命中至少一项；不能把标签、人物称谓共词或无关动作冒充兑现。多个硬轴必须提供不同原句。event.persistentFacts 返回 0—8 条正文连续原句，保存主角已经获得的能力、奖励、权限、资源、关系或世界状态，供下一章直接继承。返回 {experienceEvidence:[{axisId,word,signalIds,quote}],event:{title,cause,outcome,location,persistentFacts}}。任一硬性交付轴没有真实证据时返回缺少该轴的数组，让硬门禁决定是否退修；不要为软窗口轴伪造 evidence。",
      ].join("\n"),
      timeout: GENERATION_STAGE_TIMEOUT_MS.reviewer,
      maxTokens: 3_200,
      remainingTokens: tokenBudget - accumulatedTokens,
      stage: "开篇审稿",
      validateJson: openingReviewValidationIssues,
    };
    await observeProgress({
      stage: "reviewing",
      activity: "checking",
      draftNumber: attempt as 1 | 2,
    });
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
    let reviewerValueForTrace: unknown;
    try {
      const completeReviewerWithSyntaxRetry = async () => {
        let priorFailureTokens = 0;
        let priorUsageEstimated = false;
        const maximumSyntaxAttempts = complete === defaultOpeningCompleter ? 1 : 2;
        for (let syntaxAttempt = 1; syntaxAttempt <= maximumSyntaxAttempts; syntaxAttempt += 1) {
          const request = syntaxAttempt === 1 ? reviewerRequest : {
            ...reviewerRequest,
            system: [
              reviewerRequest.system,
              "上一轮没有形成可解析 JSON。本轮关闭解释和思考，只输出一个从 { 开始、以 } 结束的完整 JSON 对象。",
            ].join("\n"),
            remainingTokens: tokenBudget - accumulatedTokens - priorFailureTokens,
            stage: "开篇审稿重试",
          };
          if (syntaxAttempt > 1) {
            try {
              assertModelCallTokenBudget({
                remainingTokens: tokenBudget - accumulatedTokens - priorFailureTokens,
                system: request.system,
                prompt: request.prompt,
                maxOutputTokens: request.maxTokens,
                stage: "开篇审稿重试",
              });
            } catch (error) {
              throw addModelUsage(error, priorFailureTokens, priorUsageEstimated);
            }
          }
          try {
            const result = await complete(request);
            return {
              ...result,
              usageTokens: priorFailureTokens + result.usageTokens,
              usageEstimated: priorUsageEstimated || result.usageEstimated,
            };
          } catch (error) {
            const retryableSyntaxFailure = /(?:输出不是可修复的 JSON|没有返回可用内容)/.test(
              error instanceof Error ? error.message : String(error),
            );
            if (syntaxAttempt >= maximumSyntaxAttempts || !retryableSyntaxFailure) {
              const failure = addModelUsage(error, priorFailureTokens, priorUsageEstimated);
              if (syntaxAttempt >= maximumSyntaxAttempts && retryableSyntaxFailure) {
                Object.assign(failure, { reviewerProtocolFailure: true });
              }
              throw failure;
            }
            const failedUsage = attachedModelUsage(error);
            priorFailureTokens += failedUsage.tokens;
            priorUsageEstimated ||= failedUsage.estimated;
          }
        }
        throw new Error("开篇审稿重试没有返回结果。");
      };
      let reviewer = await completeReviewerWithSyntaxRetry();
      reviewerValueForTrace = reviewer.value;
      accumulatedTokens += reviewer.usageTokens;
      usageEstimated ||= reviewer.usageEstimated;
      let reviewIssues = openingReviewValidationIssues(reviewer.value);
      if (reviewIssues.length > 0) {
        await observeFailure({
          stage: "开篇审稿结构校验",
          attempt,
          error: new Error(`审稿模型输出未通过 Schema 校验：${reviewIssues.join("；")}。`),
        });
        const reviewRepairRequest: OpeningCompletionRequest = {
          connection,
          model: connection.routes.extractor,
          system: [
            "你是中文小说审稿 JSON 结构修复器，只返回修复后的 JSON。",
            "只依据给定正文和体验契约修复审稿结果；quote 与 persistentFacts 必须从正文逐字复制，不得概括、改写、补标点或虚构事实。",
            `experienceEvidence 必须为 0—2 项且仅覆盖硬性交付轴（${hardOpeningAxes.map((axis) => axis.word).join("、") || "无"}），event 必须含 title、cause、outcome、location、persistentFacts。禁止增加外层包装。`,
            openingReviewJsonExample,
          ].join("\n"),
          prompt: [
            `当前 Schema 问题：${reviewIssues.join("；")}`,
            `体验契约：${JSON.stringify(contract)}`,
            `待修复审稿：${JSON.stringify(reviewer.value)}`,
            `正文：${normalizedChapterTitle}\n${content}`,
            "保留能够被正文逐字验证的内容，缺失字段直接从正文抽取。只返回完整修复 JSON。",
          ].join("\n"),
          timeout: GENERATION_STAGE_TIMEOUT_MS.reviewer,
          maxTokens: 2_400,
          remainingTokens: tokenBudget - accumulatedTokens,
          stage: "开篇审稿修复",
          validateJson: openingReviewValidationIssues,
        };
        assertModelCallTokenBudget({
          remainingTokens: tokenBudget - accumulatedTokens,
          system: reviewRepairRequest.system,
          prompt: reviewRepairRequest.prompt,
          maxOutputTokens: reviewRepairRequest.maxTokens,
          stage: "开篇审稿修复",
        });
        const repairedReviewer = await complete(reviewRepairRequest);
        accumulatedTokens += repairedReviewer.usageTokens;
        usageEstimated ||= repairedReviewer.usageEstimated;
        reviewer = {
          ...repairedReviewer,
          value: mergeOpeningReviewSchemaRepair(reviewer.value, repairedReviewer.value),
        };
        reviewerValueForTrace = reviewer.value;
        reviewIssues = openingReviewValidationIssues(reviewer.value);
      }
      if (!hasOpeningReviewShape(reviewer.value)) {
        throw new Error(`审稿模型没有返回有效的硬性交付轴证据或事件结构：${reviewIssues.join("；")}。`);
      }
      const narrationResolution = resolveNarrationAssessments(
        narrationCandidates,
        reviewer.value.narrationAssessments,
      );
      if (narrationCandidates.length > 0) {
        const narrationReview: OpeningNarrationReviewTrace = {
          contentHash,
          candidates: structuredClone(narrationCandidates),
          resolution: structuredClone(narrationResolution),
          attempt,
          rewriteCount: attempt - 1,
        };
        narrationReviewTrace.push(narrationReview);
        workflowControl.onNarrationReview?.(structuredClone(narrationReview));
      }
      const groundedExperienceEvidence = groundReadingExperienceEvidence(
        contract,
        content,
        reviewer.value.experienceEvidence,
        validationContext,
      );
      assertReadingExperienceEvidence(contract, content, groundedExperienceEvidence, validationContext);
      const groundedPersistentFacts = Array.from(new Set([
        ...groundedExperienceEvidence.map((evidence) => evidence.quote.trim()),
        ...reviewer.value.event.persistentFacts.map((fact) => fact.trim()),
      ])).filter((fact) => {
        const length = Array.from(fact.replace(/\r\n?|\n/g, "")).length;
        return length >= 8 && length <= 300 && contentContainsSourceQuote(content, fact);
      }).slice(0, 8);
      assertPersistentExperienceFacts(contract, content, groundedPersistentFacts, {
        protagonistNames: [plan.leadName],
        chapterNumber: 1,
      });
      const generated: GeneratedStoryOpening = {
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
          experienceEvidence: groundedExperienceEvidence,
          usageTokens: workflowControl.chapterWriterUsageOverride?.usageTokens ?? writer.usageTokens,
          usageEstimated: workflowControl.chapterWriterUsageOverride?.usageEstimated ?? writer.usageEstimated,
        },
        event: { ...reviewer.value.event, persistentFacts: groundedPersistentFacts },
        plannerModel: connection.routes.planner,
        writerModel: connection.routes.writer,
        usageTokens: accumulatedTokens,
        usageEstimated,
      };
      const permit = issueNarrationPermit(
        contentHash,
        narrationCandidates,
        "semantic_allow",
        attempt,
      );
      if (narrationResolution.decision === "ask_user" && workflowControl.pauseOnAskUser) {
        const ambiguousIds = new Set(
          narrationResolution.assessments
            .filter((assessment) => assessment.decision === "ask_user")
            .map((assessment) => assessment.candidateId),
        );
        const ambiguousCandidates = narrationCandidates.filter((candidate) =>
          ambiguousIds.has(candidate.id)
        );
        const review: PendingNarrationReviewDraft = {
          contentHash,
          candidates: ambiguousCandidates,
          allCandidateIds: narrationCandidateIds(narrationCandidates),
          resolution: narrationResolution,
          attempt,
          rewriteCount: attempt - 1,
          baseReviewStatus: "valid",
        };
        const checkpoint: OpeningGenerationCheckpoint = {
          version: 1,
          context: structuredClone(context),
          plan: structuredClone(plan),
          connectionBinding: {
            id: connection.id,
            updatedAt: connection.updatedAt,
            routes: structuredClone(connection.routes),
          },
          attempt,
          rewriteCount: attempt - 1,
          reviewerResumeCount: workflowControl.reviewerResumeCount ?? 0,
          accumulatedTokens,
          usageEstimated,
          tokenBudget,
          draft: {
            title: normalizedChapterTitle,
            paragraphs: [...paragraphs],
            writerUsageTokens: workflowControl.chapterWriterUsageOverride?.usageTokens ?? writer.usageTokens,
            writerUsageEstimated: workflowControl.chapterWriterUsageOverride?.usageEstimated ?? writer.usageEstimated,
          },
          generated,
          reviewTrace: structuredClone(narrationReviewTrace),
          review,
        };
        throw openingNarrationPauseError({ checkpoint, review });
      }
      if (narrationResolution.decision !== "allow") {
        const error = Object.assign(
          new Error("Opening narration review requires " + narrationResolution.decision + "."),
          {
            code: narrationResolution.decision === "rewrite"
              ? "narration_rewrite_requested"
              : "narration_review_state_unavailable",
            narrationReviewResolution: narrationResolution,
            narrationCandidates,
            narrationContentHash: contentHash,
          },
        );
        throw error;
      }
      workflowControl.onNarrationPermit?.(permit);
      return generated;
    } catch (error) {
      const pause = openingNarrationPauseDetails(error);
      if (pause) throw error;
      if (reviewerValueForTrace !== undefined) {
        await writeAiTrace({
          event: "error",
          timestamp: new Date().toISOString(),
          callId: randomUUID(),
          attempt,
          stage: "开篇证据与质量校验",
          connectionId: connection.id,
          model: connection.routes.extractor,
          prompt: `${normalizedChapterTitle}\n${content}`,
          parsedValue: reviewerValueForTrace,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await observeFailure({ stage: "开篇证据与质量校验", attempt, error });
      const failedCallUsage = attachedModelUsage(error);
      accumulatedTokens += failedCallUsage.tokens;
      usageEstimated ||= failedCallUsage.estimated;
      if (
        workflowControl.pauseOnAskUser &&
        narrationCandidates.length > 0 &&
        !hasOpeningReviewShape(reviewerValueForTrace) &&
        (workflowControl.reviewerResumeCount ?? 0) < 1
      ) {
        const resolution = resolveNarrationAssessments(narrationCandidates, undefined);
        const narrationReview: OpeningNarrationReviewTrace = {
          contentHash,
          candidates: structuredClone(narrationCandidates),
          resolution: structuredClone(resolution),
          attempt,
          rewriteCount: attempt - 1,
        };
        narrationReviewTrace.push(narrationReview);
        workflowControl.onNarrationReview?.(structuredClone(narrationReview));
        const review: PendingNarrationReviewDraft = {
          contentHash,
          candidates: [...narrationCandidates],
          allCandidateIds: narrationCandidateIds(narrationCandidates),
          resolution,
          attempt,
          rewriteCount: attempt - 1,
          baseReviewStatus: "unavailable",
        };
        const checkpoint: OpeningGenerationCheckpoint = {
          version: 1,
          context: structuredClone(context),
          plan: structuredClone(plan),
          connectionBinding: {
            id: connection.id,
            updatedAt: connection.updatedAt,
            routes: structuredClone(connection.routes),
          },
          attempt,
          rewriteCount: attempt - 1,
          reviewerResumeCount: workflowControl.reviewerResumeCount ?? 0,
          accumulatedTokens,
          usageEstimated,
          tokenBudget,
          draft: {
            title: normalizedChapterTitle,
            paragraphs: [...paragraphs],
            writerUsageTokens: workflowControl.chapterWriterUsageOverride?.usageTokens ?? writer.usageTokens,
            writerUsageEstimated: workflowControl.chapterWriterUsageOverride?.usageEstimated ?? writer.usageEstimated,
          },
          generated: null,
          review,
          reviewTrace: structuredClone(narrationReviewTrace),
        };
        throw openingNarrationPauseError({ checkpoint, review });
      }
      lastFailure = error;
      if (
        error instanceof Error &&
        (error as Error & { reviewerProtocolFailure?: boolean }).reviewerProtocolFailure === true
      ) {
        throw attachModelUsage(error, accumulatedTokens, usageEstimated);
      }
    }
  }
  if (
    lastFailure instanceof Error &&
    (lastFailure as Error & { code?: string }).code === "narration_rewrite_requested"
  ) {
    throw attachModelUsage(
      Object.assign(new Error("Opening narration rewrite allowance is exhausted."), {
        code: "narration_rewrite_exhausted",
      }),
      accumulatedTokens,
      usageEstimated,
    );
  }
  throw attachModelUsage(
    new Error(`第一章连续两次未通过阅读体验与沉浸感质量门禁：${lastFailure instanceof Error ? lastFailure.message : "未知错误"}`),
    accumulatedTokens,
    usageEstimated,
  );
}

export async function beginStoryOpeningGeneration(
  context: OpeningGenerationContext,
  connection: ModelConnection,
  complete: OpeningModelCompleter = defaultOpeningCompleter,
  tokenBudget = OPENING_JOB_TOKEN_BUDGET,
  failureObserver?: OpeningFailureObserver,
  progressObserver?: OpeningProgressObserver,
): Promise<OpeningGenerationOutcome> {
  let narrationPermit: NarrationPermit | undefined;
  const narrationReviews: OpeningNarrationReviewTrace[] = [];
  try {
    const generated = await generateStoryOpeningWithConnection(
      context,
      connection,
      complete,
      tokenBudget,
      failureObserver,
      {
        pauseOnAskUser: true,
        onNarrationPermit: (permit) => {
          narrationPermit = permit;
        },
        onNarrationReview: (review) => {
          narrationReviews.push(review);
        },
        onProgress: progressObserver,
      },
    );
    if (!narrationPermit) {
      throw Object.assign(new Error("Opening narration permit was not issued."), {
        code: "narration_review_state_unavailable",
      });
    }
    return { status: "completed", generated, narrationPermit, narrationReviews };
  } catch (error) {
    const pause = openingNarrationPauseDetails(error);
    if (pause) {
      return {
        status: "awaiting_user_review",
        checkpoint: pause.checkpoint,
        review: pause.review,
      };
    }
    throw attachOpeningNarrationReviews(error, narrationReviews);
  }
}

export async function resumeStoryOpeningGeneration(
  checkpoint: OpeningGenerationCheckpoint,
  action: NarrationReviewAction,
  connection: ModelConnection,
  complete: OpeningModelCompleter = defaultOpeningCompleter,
  failureObserver?: OpeningFailureObserver,
  progressObserver?: OpeningProgressObserver,
): Promise<OpeningGenerationOutcome> {
  const allCandidates = assertOpeningCheckpoint(checkpoint, connection);
  if (action.kind === "keep") {
    if (
      action.contentHash !== checkpoint.review.contentHash ||
      !sameCandidateIds(
        action.candidateIds,
        checkpoint.review.candidates.map((candidate) => candidate.id),
      )
    ) {
      invalidOpeningCheckpoint(checkpoint);
    }
    if (checkpoint.review.baseReviewStatus === "valid") {
      if (!checkpoint.generated) invalidOpeningCheckpoint(checkpoint);
      return {
        status: "completed",
        generated: checkpoint.generated,
        narrationPermit: issueNarrationPermit(
          checkpoint.review.contentHash,
          allCandidates,
          "user_keep",
          checkpoint.attempt,
        ),
        narrationReviews: structuredClone(checkpoint.reviewTrace ?? []),
      };
    }
  }

  const rewriting = action.kind === "rewrite";
  if (rewriting && (checkpoint.attempt >= 2 || checkpoint.rewriteCount >= 1)) {
    throw attachModelUsage(
      Object.assign(new Error("Opening narration rewrite allowance is exhausted."), {
        code: "narration_rewrite_exhausted",
      }),
      checkpoint.accumulatedTokens,
      checkpoint.usageEstimated,
    );
  }

  let firstCall = true;
  let writerReplayed = false;
  const replayWriter = action.kind === "keep";
  const replayCompleter: OpeningModelCompleter = async (request) => {
    if (firstCall) {
      firstCall = false;
      return { value: structuredClone(checkpoint.plan), usageTokens: 0, usageEstimated: false };
    }
    if (replayWriter && !writerReplayed) {
      writerReplayed = true;
      return {
        value: {
          title: checkpoint.draft.title,
          paragraphs: [...checkpoint.draft.paragraphs],
        },
        usageTokens: 0,
        usageEstimated: false,
      };
    }
    return complete(request);
  };

  let narrationPermit: NarrationPermit | undefined;
  const narrationReviews = structuredClone(checkpoint.reviewTrace ?? []);
  try {
    const generated = await generateStoryOpeningWithConnection(
      checkpoint.context,
      connection,
      replayCompleter,
      checkpoint.tokenBudget,
      failureObserver,
      {
        pauseOnAskUser: true,
        initialUsageTokens: checkpoint.accumulatedTokens,
        initialUsageEstimated: checkpoint.usageEstimated,
        startingWriterAttempt: replayWriter
          ? checkpoint.attempt as 1 | 2
          : (checkpoint.attempt + 1) as 2,
        initialFailureMessage: rewriting
          ? "Narration review requested one rewrite."
          : undefined,
        initialRevisionSource: rewriting ? action.source : undefined,
        onProgress: progressObserver,
        chapterWriterUsageOverride: replayWriter
          ? {
              usageTokens: checkpoint.draft.writerUsageTokens,
              usageEstimated: checkpoint.draft.writerUsageEstimated,
            }
          : undefined,
        reviewerResumeCount: replayWriter
          ? checkpoint.reviewerResumeCount + 1
          : checkpoint.reviewerResumeCount,
        initialNarrationReviews: structuredClone(checkpoint.reviewTrace ?? []),
        onNarrationPermit: (permit) => {
          narrationPermit = permit;
        },
        onNarrationReview: (review) => {
          narrationReviews.push(review);
        },
      },
    );
    if (!narrationPermit) invalidOpeningCheckpoint(checkpoint);
    return { status: "completed", generated, narrationPermit, narrationReviews };
  } catch (error) {
    const pause = openingNarrationPauseDetails(error);
    if (pause) {
      return {
        status: "awaiting_user_review",
        checkpoint: pause.checkpoint,
        review: pause.review,
      };
    }
    throw attachOpeningNarrationReviews(error, narrationReviews);
  }
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
  const plannerSystem = "你是剧情规划器。只返回 JSON，包含 candidates 数组；每项必须有 creativeAxis,event,cause,cost,impact,novelty,participantNames,storyTime,dependsOnEventIds,knowledgeClaims,itemTransitions。knowledgeClaims 每项含 characterName/fact/sourceRevisionId；itemTransitions 只记录实体物品的状态流转，每项含 itemName/actorName/fromStatus/toStatus，fromStatus 与 toStatus 只能是 available、held、lost、destroyed、consumed 之一；能力升级、身份、排名、职位、效忠和权限变化不得填入 itemTransitions，没有实体物品变化时返回空数组。只给短剧情胶囊，不写正文。";
  const cadenceDirective = formatReadingExperienceCadenceForPrompt(
    story.readingExperience,
    story.readingExperienceDeliveryLedger,
    story.chapters.length + 1,
  );
  const plannerPrompt = `故事：${story.title}；题材：${story.genre}；故事基因：${story.storyGene.conflictEngine}；持续代价：${story.storyGene.recurringCost}；题材创意轴：${story.storyGene.creativeAxes.join("、")}；篇幅：第 ${story.chapters.length + 1} / ${story.targetChapterCount} 章，第 ${storyArc.volumeNumber} / ${storyArc.totalVolumes} 卷，本卷第 ${storyArc.chapterInVolume} / ${storyArc.volumeChapterCount} 章，阶段=${storyArc.label}；阶段要求：${storyArc.guidance}；结局契约：${story.endingContract.targetEnding}；必要前置条件：${story.endingContract.prerequisites.join("；")}。${formatReadingExperienceForPrompt(story.readingExperience, story.chapters.length + 1)}。${cadenceDirective}。所有候选必须在同一事件中兑现硬性交付轴，并让硬性结果产生正文可引用的证据；软窗口体验不要求每个候选本章获胜，应按上面的跨章节奏状态安排，至少保留一个符合当前节奏优先级的候选。所有候选的核心事件、资源、两难与代价都必须属于“${story.genre}”的典型叙事，不得把非悬疑题材统一写成追踪线索、救证人或查案；终卷不得开启新世界、新势力或大型支线，目标章候选必须明确兑现结局契约及至少一项必要前置条件。可用人物知识账本：${JSON.stringify(activeKnowledgeLedger)}；可依赖活动事件：${JSON.stringify(activeEventIds)}。每个有参与者的候选至少声明一条正文实际使用、且来自上述账本的 knowledgeClaim；若无法给出来源就不要生成该候选。生成 3 个结构不同的候选。`;
  assertModelCallTokenBudget({
    remainingTokens: tokenBudget,
    system: plannerSystem,
    prompt: plannerPrompt,
    maxOutputTokens: 2_400,
    stage: "候选规划",
  });
  const completion = await complete<{ candidates?: CandidateDraft[] }>(
    connection,
    connection.routes.planner,
    plannerSystem,
    plannerPrompt,
    GENERATION_STAGE_TIMEOUT_MS.planner,
    2_400,
    {
      remainingTokens: tokenBudget,
      stage: "候选规划",
      validateJson: (value) => {
        if (!isOpeningPlanRecord(value) || !Array.isArray(value.candidates)) {
          return ["candidates 必须是数组"];
        }
        const issues: string[] = [];
        if (value.candidates.length < 3) issues.push("candidates 必须至少包含 3 项");
        value.candidates.forEach((candidate, index) => {
          if (!isOpeningPlanRecord(candidate)) {
            issues.push(`candidates[${index}] 必须是 JSON 对象`);
            return;
          }
          for (const field of ["creativeAxis", "event", "cause", "cost", "impact", "novelty", "storyTime"]) {
            if (typeof candidate[field] !== "string" || !candidate[field].trim()) {
              issues.push(`candidates[${index}].${field} 必须是非空字符串`);
            }
          }
          for (const field of ["participantNames", "dependsOnEventIds", "knowledgeClaims", "itemTransitions"]) {
            if (!Array.isArray(candidate[field])) issues.push(`candidates[${index}].${field} 必须是数组`);
          }
        });
        return issues;
      },
    },
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
      Array.isArray(item.itemTransitions),
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
  const selectedCandidates = candidates.slice(0, 3);
  type CandidateAuditPayload = {
    audits?: Array<{ candidateIndex?: number; complete?: boolean; dependencies?: Array<{ characterName?: string; fact?: string }> }>;
  };
  const auditSystem = "你是独立的剧情知识依赖审计器。只返回 JSON：{audits:[{candidateIndex,complete,dependencies:[{characterName,fact}]}]}。逐个候选穷尽提取角色行动所依赖的所有既有信息、解读材料、秘密、凭据、记录和推理前提；不要依赖固定动词或名词表，要理解同义表达、语序和隐含信息依赖。dependencies 只记录行动前必须已知的事实，不记录本章新发生的物理动作；fact 必须逐字复制活动人物知识账本中的对应事实，不得自行改写。每个候选索引必须恰好返回一次。complete 只表示你是否已经检查完该候选并穷尽返回其既有知识依赖，不是剧情风险评级：只要输入完整可读且检查已经完成，complete 必须为 true，即使 dependencies 为空、候选含新人物或本章将发生新事件；仅当输入截断或确实无法完成检查时才返回 false。";
  const auditPrompt = `活动人物知识账本：${JSON.stringify(activeKnowledgeLedger)}；候选：${JSON.stringify(selectedCandidates.map((candidate, candidateIndex) => ({ candidateIndex, event: candidate.event, cause: candidate.cause, cost: candidate.cost, impact: candidate.impact, novelty: candidate.novelty, participantNames: candidate.participantNames, declaredKnowledgeClaims: candidate.knowledgeClaims })))}。候选中新登场的人物、地点、物品以及本章才发生的行动不属于既有知识依赖，不影响 complete=true。`;
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
      GENERATION_STAGE_TIMEOUT_MS.reviewer,
      1_800,
      {
        remainingTokens: tokenBudget - completion.usageTokens,
        stage: "候选审计",
        validateJson: (value) => {
          if (!isOpeningPlanRecord(value)) return ["候选审计根节点必须是 JSON 对象"];
          const audits = value.audits;
          if (!Array.isArray(audits)) return ["audits 必须是数组"];
          const issues: string[] = [];
          selectedCandidates.forEach((_candidate, candidateIndex) => {
            const audit = audits.find((item: unknown) =>
              isOpeningPlanRecord(item) && item.candidateIndex === candidateIndex,
            );
            if (!isOpeningPlanRecord(audit)) {
              issues.push(`audits 缺少 candidateIndex=${candidateIndex}`);
              return;
            }
            if (audit.complete !== true) issues.push(`audits[${candidateIndex}].complete 必须为 true`);
            if (!Array.isArray(audit.dependencies)) issues.push(`audits[${candidateIndex}].dependencies 必须是数组`);
          });
          return issues;
        },
      },
    );
  } catch (error) {
    throw addModelUsage(error, completion.usageTokens, completion.usageEstimated);
  }
  const audits = (auditCompletion.value as CandidateAuditPayload | null)?.audits ?? [];
  let auditedCandidates: CandidateDraft[];
  try {
    auditedCandidates = [];
    selectedCandidates.forEach((candidate, candidateIndex) => {
      const audit = audits.find((item) => item.candidateIndex === candidateIndex);
      if (!audit?.complete || !Array.isArray(audit.dependencies)) return;
      const dependencies = audit.dependencies
        .filter((dependency) => dependency && typeof dependency.characterName === "string" && typeof dependency.fact === "string" && dependency.fact.trim().length >= 2)
        .map((dependency) => ({ characterName: dependency.characterName!.slice(0, 80), fact: dependency.fact!.slice(0, 180) }));
      if (dependencies.length !== audit.dependencies.length) return;
      const knowledgeClaims = [...candidate.knowledgeClaims];
      for (const dependency of dependencies) {
        if (knowledgeClaims.some((claim) =>
          claim.characterName === dependency.characterName &&
          (claim.fact.includes(dependency.fact) || dependency.fact.includes(claim.fact)),
        )) continue;
        const ledgerFact = activeKnowledgeLedger
          .find((entry) => entry.characterName === dependency.characterName)
          ?.facts.find((fact) => fact.fact.includes(dependency.fact) || dependency.fact.includes(fact.fact));
        if (ledgerFact) {
          knowledgeClaims.push({
            characterName: dependency.characterName,
            fact: ledgerFact.fact,
            sourceRevisionId: ledgerFact.sourceRevisionId,
          });
        }
      }
      auditedCandidates.push({ ...candidate, knowledgeClaims, knowledgeAudit: { complete: true, dependencies } });
    });
    if (auditedCandidates.length === 0) throw new Error("没有剧情候选通过完整的独立知识依赖审计。");
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
  writerIdleTimeoutMs: number = GENERATION_STAGE_TIMEOUT_MS.writer,
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
    writerIdleTimeoutMs,
    maxTokens,
    {
      remainingTokens: tokenBudget,
      stage: "正文",
      validateJson: (value) => {
        if (!isOpeningPlanRecord(value)) return ["正文根节点必须是 JSON 对象"];
        const issues: string[] = [];
        if (typeof value.title !== "string" || !value.title.trim()) issues.push("title 必须是非空字符串");
        if (!Array.isArray(value.paragraphs)) {
          issues.push("paragraphs 必须是数组");
        } else {
          if (value.paragraphs.length < 4) issues.push("paragraphs 必须至少包含 4 段");
          if (value.paragraphs.some((paragraph) => typeof paragraph !== "string")) {
            issues.push("paragraphs 的每一项都必须是字符串");
          }
        }
        return issues;
      },
    },
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
  writerIdleTimeoutMs: number = GENERATION_STAGE_TIMEOUT_MS.writer,
): Promise<GeneratedChapter> {
  const systemPrompt = chapterWriterSystemPrompt(true);
  const now = dependencies.now ?? Date.now;
  const traceWriter = dependencies.traceWriter ?? writeAiTrace;
  const traceCallId = randomUUID();
  const traceStartedAt = now();
  const trace = async (event: AiTraceEvent["event"], details: Partial<AiTraceEvent> = {}) => {
    try {
      await traceWriter({
        timestamp: new Date().toISOString(),
        callId: traceCallId,
        attempt: 1,
        stage: dependencies.stage?.trim() || "正文流式生成",
        connectionId: connection.id,
        model: connection.routes.writer,
        elapsedMs: Math.max(0, now() - traceStartedAt),
        ...details,
        event,
      });
    } catch (error) {
      console.error(`[AI-TRACE] 记录调用 ${traceCallId} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
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
  if (isVolcengineArkConnection(connection) && /^doubao-seed-/i.test(connection.routes.writer)) {
    body.thinking = { type: "disabled" };
    body.stream_options = { include_usage: true };
  }
  if (connection.capabilities?.jsonSchema) body.response_format = { type: "json_object" };
  await trace("request", {
    completionApi: "chat_completions",
    timeoutMs: writerIdleTimeoutMs,
    maxTokens,
    system: systemPrompt,
    prompt,
    providerRequest: body,
  });
  let response: Response;
  try {
    response = await streamFetcher(
      connection,
      apiKey,
      "/chat/completions",
      { method: "POST", body: JSON.stringify(body) },
      writerIdleTimeoutMs,
      streamedCompletionOverallTimeout(writerIdleTimeoutMs, maxTokens),
    );
  } catch (error) {
    await trace("error", { error: error instanceof Error ? error.message : String(error) });
    throw attachModelUsage(error, conservativeFailureTokens, true);
  }
  if (!response.ok) {
    const providerError = await providerResponseError(response, "正文模型流式调用", apiKey);
    await trace("error", { httpStatus: response.status, error: providerError.message });
    throw attachModelUsage(
      providerError,
      conservativeFailureTokens,
      true,
    );
  }
  if (!response.body) {
    await trace("error", { httpStatus: response.status, error: "正文模型流式调用没有可读取的响应正文。" });
    throw attachModelUsage(
      new Error("正文模型流式调用没有可读取的响应正文。"),
      conservativeFailureTokens,
      true,
    );
  }
  let content = "";
  let emitted = 0;
  let reportedTokens: number | undefined;
  try {
    const streamed = await readChatCompletionStream(response, {
      onContent: (nextContent) => {
        content = nextContent;
        const fields = completedChapterFields(nextContent);
        while (emitted < fields.paragraphs.length) {
          onParagraph(fields.paragraphs[emitted], emitted, fields.title);
          emitted += 1;
        }
      },
      onUsage: (usageTokens) => { reportedTokens = usageTokens; },
    });
    content = streamed.content;
    reportedTokens = streamed.reportedTokens;
  } catch (error) {
    await trace("error", {
      httpStatus: response.status,
      reportedTokens,
      rawContent: content,
      error: error instanceof Error ? error.message : String(error),
    });
    throw attachModelUsage(
      error,
      reportedTokens ?? conservativeFailureTokens,
      reportedTokens === undefined,
    );
  }
  await trace("response", {
    httpStatus: response.status,
    reportedTokens,
    rawContent: content,
  });
  const fields = completedChapterFields(content);
  const normalizedTitle = normalizeChapterTitle(fields.title);
  if (!normalizedTitle || fields.paragraphs.length < 4) {
    await trace("error", {
      reportedTokens,
      rawContent: content,
      error: "流式正文在完成前中断或未通过章节 Schema 校验。",
    });
    throw attachModelUsage(
      new Error("流式正文在完成前中断或未通过章节 Schema 校验。"),
      reportedTokens ?? conservativeFailureTokens,
      reportedTokens === undefined,
    );
  }
  await trace("parsed", {
    reportedTokens,
    parseMode: "direct",
    parsedValue: { title: normalizedTitle, paragraphs: fields.paragraphs },
  });
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
  chapterNumber?: number,
): Promise<ExtractedChapterState> {
  const evidenceSignalExample = (axis: ReadingExperienceContract["axes"][number]) => {
    const modelSignal = axis.observableSignals.find((signal) => signal.id.includes("_model_signal_"));
    const baselineSignal = axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"));
    return Array.from(new Set([modelSignal?.id, baselineSignal?.id].filter((id): id is string => Boolean(id))));
  };
  const softExperienceAxes = readingExperience?.axes.filter((axis) =>
    readingExperienceAxisUsesSoftWindow(readingExperience, axis.id)
  ) ?? [];
  const hardExperienceAxes = readingExperience?.axes.filter((axis) =>
    !readingExperienceAxisUsesSoftWindow(readingExperience, axis.id)
  ) ?? [];
  const endingSchema = endingContract
    ? `,"endingResolution":{"targetEndingSatisfied":true,"targetEndingEvidence":"正文中的原句","satisfiedPrerequisiteIndices":[0],"prerequisiteEvidence":[{"prerequisiteIndex":0,"evidence":"正文中的原句"}],"noContinuationHook":true}`
    : "";
  const endingInstruction = endingContract
    ? ` 独立判断结局是否在剧情行动中真实完成。结局目标=${endingContract.targetEnding}；前置条件（按下标）=${endingContract.prerequisites.map((item, index) => `${index}:${item}`).join("；")}。evidence 必须逐字引用正文中至少 8 个字的连续原句；仅复述后台契约、不对应行动结果时必须判为 false。`
    : "";
  const chapterRequirement = readingExperience && chapterNumber !== undefined
    ? readingExperience.openingRequirements.find((requirement) =>
        requirement.chapterOffset === chapterNumber - readingExperience.effectiveFromChapter,
      )
    : undefined;
  const signalIdsForEvidence = (axis: ReadingExperienceContract["axes"][number]) => {
    const requiredSignalIds = chapterRequirement?.requiredSignalIds.filter((signalId) =>
      axis.observableSignals.some((signal) => signal.id === signalId),
    ) ?? [];
    return requiredSignalIds.length > 0 ? requiredSignalIds : evidenceSignalExample(axis);
  };
  const experienceSchema = readingExperience
    ? `,"experienceEvidence":${JSON.stringify(hardExperienceAxes.map((axis) => ({ axisId: axis.id, word: axis.word, signalIds: signalIdsForEvidence(axis), quote: "正文中的连续原句" })))},"experienceDelivery":${JSON.stringify(softExperienceAxes.map((axis) => ({ axisId: axis.id, state: "no_conflict", sourceQuote: "非 no_conflict 时填写正文中的连续原句" })))},"editorialIssues":[]`
    : "";
  const experienceInstruction = readingExperience
    ? [
        ` 独立审查阅读体验轴，契约=${JSON.stringify(readingExperience)}。`,
        chapterNumber !== undefined
          ? `当前是第 ${chapterNumber} 章；本章硬性必需信号=${JSON.stringify(chapterRequirement?.requiredSignalIds ?? [])}。`
          : "",
        hardExperienceAxes.length
          ? `硬性交付轴=${hardExperienceAxes.map((axis) => axis.word).join("、")}。这些轴有正文证据时，signalIds 必须包含本章必需信号，不得用其他章节的信号代替。每个 evidence 必须逐字引用正文中至少 8 个字的连续原句，并具体对应人物、动作、对象与结果；申报 _model_signal_ 时，同一句 quote 还必须包含该信号 evidenceAnchors 中至少两个相互独立的短语。无法找到真实证据时不要伪造 evidence，并在 editorialIssues 中给出具体退修问题。`
          : "",
        softExperienceAxes.length
          ? `软窗口轴=${softExperienceAxes.map((axis) => axis.word).join("、")}。软窗口轴不要求本章出现胜利或 evidence，也不得仅因本章铺垫、暂时五五开、冲突未决或缺少压倒性胜利填写 editorialIssues。必须为每个软窗口轴返回 experienceDelivery：state 只能是 no_conflict、open_parity、dominant_victory、conclusive_defeat；dominant_victory 仅指主角已经完成决定性胜利，open_parity 指对抗仍势均力敌或未决，conclusive_defeat 仅指主角已经形成最终落败，暂时受伤、受压或五五开不算。除 no_conflict 外，sourceQuote 必须逐字引用至少 8 个字的正文连续原句。`
          : "",
        `只出现体验词、人物称谓共词或无关动作不算兑现。系统奖励、权限、能力和长期状态必须作为主角的 knowledgeGained 原文保存。editorialIssues 每项格式为 {"code":"missing_experience_signal|weak_experience_signal|unsupported_experience_claim|missing_required_outcome|explicit_protagonist_defeat","axisId":"primary|secondary","axisWord":"契约中的体验词","signalIds":[],"location":"title|body|chapter","sourceQuote":"最接近问题的连续原句，可缺省","reason":"原稿为什么没有满足信号","requestedChange":"作者应如何在保留既有剧情的前提下修改"}。硬性交付轴均满足且没有真正的最终失败时，editorialIssues 必须是空数组。`,
        "只有主角明确形成已经落地的最终失败时，才可在 editorialIssues 使用 code=explicit_protagonist_defeat；暂时受伤、受压、五五开、未决或缺少胜利时不得使用。",
      ].join("")
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
    GENERATION_STAGE_TIMEOUT_MS.reviewer,
    1_500,
    {
      remainingTokens: tokenBudget,
      stage: "状态抽取",
      validateJson: (value) => {
        if (!isOpeningPlanRecord(value)) return ["状态抽取根节点必须是 JSON 对象"];
        const issues: string[] = [];
        if (!Array.isArray(value.events)) issues.push("events 必须是数组");
        if (!Array.isArray(value.characterUpdates)) issues.push("characterUpdates 必须是数组");
        if (!Array.isArray(value.itemUpdates)) issues.push("itemUpdates 必须是数组");
        if (readingExperience && !Array.isArray(value.experienceEvidence)) {
          issues.push("experienceEvidence 必须是数组");
        }
        if (softExperienceAxes.length > 0) {
          if (!Array.isArray(value.experienceDelivery)) {
            issues.push("experienceDelivery 必须是数组");
          } else {
            for (const axis of softExperienceAxes) {
              const observation = value.experienceDelivery.find((candidate) =>
                isOpeningPlanRecord(candidate) && candidate.axisId === axis.id
              );
              if (!observation || typeof observation.state !== "string" ||
                !["no_conflict", "open_parity", "dominant_victory", "conclusive_defeat"].includes(observation.state)) {
                issues.push(`experienceDelivery 缺少 ${axis.id} 的有效状态`);
              } else if (observation.state !== "no_conflict" && typeof observation.sourceQuote !== "string") {
                issues.push(`experienceDelivery[${axis.id}] 的非空状态必须提供 sourceQuote`);
              }
            }
          }
        }
        if (readingExperience && value.editorialIssues !== undefined && !Array.isArray(value.editorialIssues)) {
          issues.push("editorialIssues 必须是数组");
        }
        if (endingContract) {
          const resolution = value.endingResolution;
          if (!isOpeningPlanRecord(resolution)) {
            issues.push("endingResolution 必须是 JSON 对象");
          } else {
            if (typeof resolution.targetEndingSatisfied !== "boolean") {
              issues.push("endingResolution.targetEndingSatisfied 必须是布尔值");
            }
            if (typeof resolution.targetEndingEvidence !== "string") {
              issues.push("endingResolution.targetEndingEvidence 必须是字符串");
            }
            if (!Array.isArray(resolution.satisfiedPrerequisiteIndices)) {
              issues.push("endingResolution.satisfiedPrerequisiteIndices 必须是数组");
            }
            if (!Array.isArray(resolution.prerequisiteEvidence)) {
              issues.push("endingResolution.prerequisiteEvidence 必须是数组");
            }
            if (typeof resolution.noContinuationHook !== "boolean") {
              issues.push("endingResolution.noContinuationHook 必须是布尔值");
            }
          }
        }
        return issues;
      },
    },
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
  let experienceDelivery: ReadingExperienceDeliveryObservation[] | undefined;
  if (softExperienceAxes.length > 0) {
    if (!Array.isArray(parsed.experienceDelivery)) throw new Error("抽取模型没有返回软窗口体验状态。");
    experienceDelivery = softExperienceAxes.map((axis) => {
      const observation = parsed.experienceDelivery!.find((candidate) => candidate?.axisId === axis.id);
      const state = observation?.state;
      if (!state || !["no_conflict", "open_parity", "dominant_victory", "conclusive_defeat"].includes(state)) {
        return { axisId: axis.id, state: "no_conflict" };
      }
      if (state === "no_conflict") return { axisId: axis.id, state };
      const sourceQuote = typeof observation.sourceQuote === "string"
        ? observation.sourceQuote.trim().slice(0, 500)
        : "";
      if (Array.from(sourceQuote.replace(/\r\n?|\n/g, "")).length < 8 ||
        !contentContainsSourceQuote(extractorPrompt, sourceQuote)) {
        return { axisId: axis.id, state: "no_conflict" };
      }
      return { axisId: axis.id, state, sourceQuote };
    });
  }
  const editorialIssues = readingExperience
    ? normalizeChapterEditorialIssues(readingExperience, extractorPrompt, parsed.editorialIssues)
    : undefined;
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
      experienceDelivery,
      editorialIssues,
      endingResolution,
      usageTokens: completion.usageTokens,
      usageEstimated: completion.usageEstimated,
    };
  } catch (error) {
    throw attachModelUsage(error, completion.usageTokens, completion.usageEstimated);
  }
}
