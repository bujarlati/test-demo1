import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { CapabilitySnapshot, ModelConnection, Story } from "../src/types";
import type { CandidateDraft, GeneratedChapter } from "./narrativeEngine";
import { readSecret } from "./vault";

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
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  return isPrivateIpv4(address);
}

export async function assertSafeEndpoint(rawUrl: string): Promise<URL> {
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
  return url;
}

function endpoint(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/$/, "")}${pathname}`;
}

async function modelFetch(
  connection: ModelConnection,
  apiKey: string,
  pathname: string,
  init: RequestInit,
  timeout = 12_000,
) {
  await assertSafeEndpoint(connection.baseUrl);
  return fetch(endpoint(connection.baseUrl, pathname), {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  });
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
    if (!response.ok) return false;
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return false;
    JSON.parse(content);
    return true;
  } catch {
    return false;
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
    const reader = response.body?.getReader();
    const first = reader ? await reader.read() : null;
    await reader?.cancel();
    return response.ok && /text\/event-stream/i.test(contentType) && Boolean(first && !first.done && first.value.length);
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
    if (!response.ok) return false;
    const payload = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
    return Array.isArray(payload.data?.[0]?.embedding);
  } catch {
    return false;
  }
}

export async function testConnection(connection: ModelConnection): Promise<CapabilitySnapshot> {
  await assertSafeEndpoint(connection.baseUrl);
  const apiKey = await readSecret(connection.id);
  const startedAt = performance.now();
  const response = await modelFetch(connection, apiKey, "/models", { method: "GET" }, 10_000);
  if (!response.ok) {
    throw new Error(`连接返回 ${response.status}，请检查地址、Key 与访问权限。`);
  }
  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  const models = (payload.data ?? [])
    .map((item) => item.id)
    .filter((item): item is string => Boolean(item))
    .slice(0, 20);
  const [jsonSchema, streaming, embedding] = await Promise.all([
    probeJson(connection, apiKey),
    probeStreaming(connection, apiKey),
    probeEmbedding(connection, apiKey),
  ]);
  return {
    streaming,
    jsonSchema,
    embedding,
    promptCache: false,
    testedAt: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - startedAt),
    models,
  };
}

async function completeJson<T>(
  connection: ModelConnection,
  model: string,
  system: string,
  prompt: string,
  timeout = 120_000,
): Promise<T> {
  const apiKey = await readSecret(connection.id);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
    stream: false,
  };
  if (connection.capabilities?.jsonSchema) body.response_format = { type: "json_object" };
  const response = await modelFetch(
    connection,
    apiKey,
    "/chat/completions",
    { method: "POST", body: JSON.stringify(body) },
    timeout,
  );
  if (!response.ok) throw new Error(`模型 ${model} 返回 ${response.status}；未启用静默回退。`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error(`模型 ${model} 没有返回可用内容。`);
  try {
    return JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`模型 ${model} 输出不是可修复的 JSON。`);
    return JSON.parse(match[0]) as T;
  }
}

export async function generateCandidateDraftsWithConnection(
  connection: ModelConnection,
  story: Story,
): Promise<CandidateDraft[]> {
  const payload = await completeJson<{ candidates?: CandidateDraft[] }>(
    connection,
    connection.routes.planner,
    "你是剧情规划器。只返回 JSON，包含 candidates 数组；每项必须有 creativeAxis,event,cause,cost,impact,novelty。只给短剧情胶囊，不写正文。",
    `故事：${story.title}；故事基因：${story.storyGene.conflictEngine}；持续代价：${story.storyGene.recurringCost}；下一章编号：${story.chapters.length + 1}。生成 5 个结构不同的候选。`,
    40_000,
  );
  const candidates = (payload.candidates ?? []).filter(
    (item) => item.event && item.cause && item.cost && item.impact && item.novelty,
  );
  if (candidates.length < 3) throw new Error("规划模型未返回至少 3 个有效剧情胶囊。");
  return candidates.slice(0, 5);
}

export async function generateChapterWithConnection(
  connection: ModelConnection,
  prompt: string,
): Promise<GeneratedChapter> {
  const parsed = await completeJson<{ title?: string; paragraphs?: string[] }>(
    connection,
    connection.routes.writer,
    "你是中文连载小说作家。只返回 JSON：{\"title\":\"章节名\",\"paragraphs\":[\"段落\"]}。生成 5 至 8 个完整段落，保持因果与克制。",
    prompt,
  );
  if (!parsed.title || !Array.isArray(parsed.paragraphs) || parsed.paragraphs.length < 4) {
    throw new Error("正文模型输出未通过章节 Schema 校验。");
  }
  return {
    title: parsed.title,
    paragraphs: parsed.paragraphs.map(String),
    model: connection.routes.writer,
  };
}

export async function extractChapterStateWithConnection(
  connection: ModelConnection,
  chapter: GeneratedChapter,
) {
  const parsed = await completeJson<{ events?: unknown[]; characterUpdates?: unknown[] }>(
    connection,
    connection.routes.extractor,
    "你是正史状态抽取器。只返回 JSON：{\"events\":[],\"characterUpdates\":[]}；不得新增正文没有的事实。",
    `${chapter.title}\n${chapter.paragraphs.join("\n")}`,
    30_000,
  );
  if (!Array.isArray(parsed.events) || !Array.isArray(parsed.characterUpdates)) {
    throw new Error("抽取模型输出未通过状态 Schema 校验。");
  }
  return parsed;
}
