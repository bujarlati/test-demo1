import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { CapabilitySnapshot, ModelConnection, Story } from "../src/types";
import type {
  CandidateDraft,
  ExtractedChapterState,
  ExtractedEventDraft,
  GeneratedChapter,
} from "./narrativeEngine";
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
  const candidates = (payload.candidates ?? [])
    .filter((item) =>
      item && [item.creativeAxis, item.event, item.cause, item.cost, item.impact, item.novelty]
        .every((value) => typeof value === "string" && value.trim().length > 0),
    )
    .map((item) => ({
      creativeAxis: item.creativeAxis.slice(0, 80),
      event: item.event.slice(0, 220),
      cause: item.cause.slice(0, 220),
      cost: item.cost.slice(0, 180),
      impact: item.impact.slice(0, 220),
      novelty: item.novelty.slice(0, 180),
    }));
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
  if (
    typeof parsed.title !== "string" ||
    !Array.isArray(parsed.paragraphs) ||
    parsed.paragraphs.length < 4 ||
    !parsed.paragraphs.every((paragraph) => typeof paragraph === "string")
  ) {
    throw new Error("正文模型输出未通过章节 Schema 校验。");
  }
  return {
    title: parsed.title,
    paragraphs: parsed.paragraphs.map((paragraph) => paragraph.slice(0, 4_000)),
    model: connection.routes.writer,
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
    try { paragraphs.push(JSON.parse(content.slice(start, cursor)) as string); } catch { break; }
  }
  return { title, paragraphs };
}

export async function streamChapterWithConnection(
  connection: ModelConnection,
  prompt: string,
  onParagraph: (paragraph: string, index: number, title: string) => void,
): Promise<GeneratedChapter> {
  const apiKey = await readSecret(connection.id);
  const body: Record<string, unknown> = {
    model: connection.routes.writer,
    messages: [
      {
        role: "system",
        content: "你是中文连载小说作家。只返回 JSON：{\"title\":\"章节名\",\"paragraphs\":[\"段落\"]}。生成 5 至 8 个完整段落。先给 title，再按顺序给 paragraphs；不要在 JSON 外输出文字。",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
    stream: true,
  };
  if (connection.capabilities?.jsonSchema) body.response_format = { type: "json_object" };
  const response = await modelFetch(
    connection,
    apiKey,
    "/chat/completions",
    { method: "POST", body: JSON.stringify(body) },
    120_000,
  );
  if (!response.ok || !response.body) {
    throw new Error(`正文模型流式调用返回 ${response.status}；未启用静默回退。`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let eventBuffer = "";
  let content = "";
  let emitted = 0;
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
        };
        content += payload.choices?.[0]?.delta?.content ?? "";
      }
      const fields = completedChapterFields(content);
      while (emitted < fields.paragraphs.length) {
        onParagraph(fields.paragraphs[emitted], emitted, fields.title);
        emitted += 1;
      }
    }
    if (done) break;
  }
  const fields = completedChapterFields(content);
  if (!fields.title || fields.paragraphs.length < 4) {
    throw new Error("流式正文在完成前中断或未通过章节 Schema 校验。");
  }
  return { title: fields.title, paragraphs: fields.paragraphs, model: connection.routes.writer };
}

export async function extractChapterStateWithConnection(
  connection: ModelConnection,
  chapter: GeneratedChapter,
): Promise<ExtractedChapterState> {
  const parsed = await completeJson<Partial<ExtractedChapterState>>(
    connection,
    connection.routes.extractor,
    "你是正史状态抽取器。只返回 JSON：{\"events\":[{\"type\":\"choice\",\"title\":\"\",\"cause\":\"\",\"outcome\":\"\",\"participantNames\":[],\"location\":\"\"}],\"characterUpdates\":[{\"name\":\"\",\"status\":\"\",\"location\":\"\",\"goal\":\"\",\"knowledgeGained\":[]}]}; 不得新增正文没有的事实。",
    `${chapter.title}\n${chapter.paragraphs.join("\n")}`,
    30_000,
  );
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
  return { events, characterUpdates };
}
