import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { CapabilitySnapshot, EndingContract, ModelConnection, Story } from "../src/types";
import {
  storyArcPhase,
  type CandidateDraft,
  type ExtractedChapterState,
  type ExtractedEventDraft,
  type GeneratedChapter,
} from "./narrativeEngine";
import { readSecret } from "./vault";

const itemStatuses = new Set(["available", "held", "lost", "destroyed", "consumed"] as const);
const chapterWriterInstruction = "你是中文长篇连载小说作家。只返回 JSON：{\"title\":\"章节名\",\"paragraphs\":[\"段落\"]}。必须同时满足用户提示中的中文字符区间与目标段落数；每段包含完整场景动作、感官细节或人物反应，不能用短句凑段。";

function chapterWriterSystemPrompt(streaming: boolean) {
  return `${chapterWriterInstruction}${streaming ? "先给 title，再按顺序给 paragraphs；不要在 JSON 外输出文字。" : "保持因果与克制。"}`;
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
      lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family),
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

async function probeTextCompletion(connection: ModelConnection, apiKey: string) {
  try {
    const response = await modelFetch(connection, apiKey, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: connection.routes.writer,
        messages: [{ role: "user", content: "回复：好" }],
        max_tokens: 4,
        stream: false,
      }),
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return typeof payload.choices?.[0]?.message?.content === "string";
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
    if (!response.ok) return false;
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
    await warmup.arrayBuffer();
    const response = await modelFetch(connection, apiKey, "/chat/completions", { method: "POST", body });
    if (!response.ok) return false;
    const payload = (await response.json()) as { usage?: { prompt_tokens_details?: { cached_tokens?: number }; cached_tokens?: number } };
    return (payload.usage?.prompt_tokens_details?.cached_tokens ?? payload.usage?.cached_tokens ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function testConnection(connection: ModelConnection): Promise<CapabilitySnapshot> {
  await assertSafeEndpoint(connection.baseUrl);
  const apiKey = await readSecret(connection.id, connection.secretVersion);
  const startedAt = performance.now();
  const response = await modelFetch(connection, apiKey, "/models", { method: "GET" }, 10_000);
  if (!response.ok) {
    throw new Error(`连接返回 ${response.status}，请检查地址、Key 与访问权限。`);
  }
  const payload = (await response.json()) as { data?: Array<{ id?: string; context_window?: number; max_context_length?: number }> };
  const models = (payload.data ?? [])
    .map((item) => item.id)
    .filter((item): item is string => Boolean(item))
    .slice(0, 20);
  const maxContextTokens = Math.max(0, ...(payload.data ?? []).map((item) => item.context_window ?? item.max_context_length ?? 0)) || null;
  const [textCompletion, jsonSchema, streaming, embedding, toolCalling, promptCache] = await Promise.all([
    probeTextCompletion(connection, apiKey),
    probeJson(connection, apiKey),
    probeStreaming(connection, apiKey),
    probeEmbedding(connection, apiKey),
    probeToolCalling(connection, apiKey),
    probePromptCache(connection, apiKey),
  ]);
  if (!textCompletion) throw new Error("连接能列出模型，但最小正文请求失败；请检查 writer 路由与调用权限。");
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

async function completeJson<T>(
  connection: ModelConnection,
  model: string,
  system: string,
  prompt: string,
  timeout = 120_000,
  maxTokens = 2_000,
): Promise<{ value: T; usageTokens: number; usageEstimated: boolean }> {
  const apiKey = await readSecret(connection.id, connection.secretVersion);
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
  if (connection.capabilities?.jsonSchema) body.response_format = { type: "json_object" };
  const response = await modelFetch(
    connection,
    apiKey,
    "/chat/completions",
    { method: "POST", body: JSON.stringify(body) },
    timeout,
  );
  if (!response.ok) throw new Error(`模型 ${model} 返回 ${response.status}；未启用静默回退。`);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error(`模型 ${model} 没有返回可用内容。`);
  let value: T;
  try {
    value = JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`模型 ${model} 输出不是可修复的 JSON。`);
    value = JSON.parse(match[0]) as T;
  }
  const reportedTokens = payload.usage?.total_tokens;
  return {
    value,
    usageTokens: reportedTokens ?? Math.ceil((system.length + prompt.length + content.length) / 2),
    usageEstimated: !reportedTokens,
  };
}

export async function generateCandidateDraftsWithConnection(
  connection: ModelConnection,
  story: Story,
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
  const completion = await completeJson<{ candidates?: CandidateDraft[] }>(
    connection,
    connection.routes.planner,
    "你是剧情规划器。只返回 JSON，包含 candidates 数组；每项必须有 creativeAxis,event,cause,cost,impact,novelty,participantNames,storyTime,dependsOnEventIds,knowledgeClaims,itemTransitions。knowledgeClaims 每项含 characterName/fact/sourceRevisionId；itemTransitions 每项含 itemName/actorName/fromStatus/toStatus。只给短剧情胶囊，不写正文。",
    `故事：${story.title}；题材：${story.genre}；故事基因：${story.storyGene.conflictEngine}；持续代价：${story.storyGene.recurringCost}；题材创意轴：${story.storyGene.creativeAxes.join("、")}；篇幅：第 ${story.chapters.length + 1} / ${story.targetChapterCount} 章，第 ${storyArc.volumeNumber} / ${storyArc.totalVolumes} 卷，本卷第 ${storyArc.chapterInVolume} / ${storyArc.volumeChapterCount} 章，阶段=${storyArc.label}；阶段要求：${storyArc.guidance}；结局契约：${story.endingContract.targetEnding}；必要前置条件：${story.endingContract.prerequisites.join("；")}。所有候选的核心事件、资源、两难与代价都必须属于“${story.genre}”的典型叙事，不得把非悬疑题材统一写成追踪线索、救证人或查案；终卷不得开启新世界、新势力或大型支线，目标章候选必须明确兑现结局契约及至少一项必要前置条件。可用人物知识账本：${JSON.stringify(activeKnowledgeLedger)}；可依赖活动事件：${JSON.stringify(activeEventIds)}。每个有参与者的候选至少声明一条正文实际使用、且来自上述账本的 knowledgeClaim；若无法给出来源就不要生成该候选。生成 5 个结构不同的候选。`,
    40_000,
    1_800,
  );
  const payload = completion.value;
  const candidates = (payload.candidates ?? [])
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
  if (candidates.length < 3) throw new Error("规划模型未返回至少 3 个有效剧情胶囊。");
  const selectedCandidates = candidates.slice(0, 5);
  const auditCompletion = await completeJson<{
    audits?: Array<{ candidateIndex?: number; complete?: boolean; dependencies?: Array<{ characterName?: string; fact?: string }> }>;
  }>(
    connection,
    connection.routes.extractor,
    "你是独立的剧情知识依赖审计器。只返回 JSON：{audits:[{candidateIndex,complete,dependencies:[{characterName,fact}]}]}。逐个候选穷尽提取角色行动所依赖的所有既有信息、解读材料、秘密、凭据、记录和推理前提；不要依赖固定动词或名词表，要理解同义表达、语序和隐含信息依赖。dependencies 只记录行动前必须已知的事实，不记录本章新发生的物理动作。只有确认穷尽时 complete 才为 true。",
    `活动人物知识账本：${JSON.stringify(activeKnowledgeLedger)}；候选：${JSON.stringify(selectedCandidates.map((candidate, candidateIndex) => ({ candidateIndex, event: candidate.event, cause: candidate.cause, cost: candidate.cost, impact: candidate.impact, novelty: candidate.novelty, participantNames: candidate.participantNames })))}。`,
    40_000,
    1_800,
  );
  const audits = auditCompletion.value.audits ?? [];
  const auditedCandidates = selectedCandidates.map((candidate, candidateIndex) => {
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
): Promise<GeneratedChapter> {
  const completion = await completeJson<{ title?: string; paragraphs?: string[] }>(
    connection,
    connection.routes.writer,
    chapterWriterSystemPrompt(false),
    prompt,
    120_000,
    maxTokens,
  );
  const parsed = completion.value;
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
): Promise<GeneratedChapter> {
  const apiKey = await readSecret(connection.id, connection.secretVersion);
  const body: Record<string, unknown> = {
    model: connection.routes.writer,
    messages: [
      {
        role: "system",
        content: chapterWriterSystemPrompt(true),
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
    stream: true,
    max_tokens: maxTokens,
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
          reportedTokens = payload.usage?.total_tokens ?? reportedTokens;
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
    throw error;
  }
  const fields = completedChapterFields(content);
  if (!fields.title || fields.paragraphs.length < 4) {
    throw new Error("流式正文在完成前中断或未通过章节 Schema 校验。");
  }
  return {
    title: fields.title,
    paragraphs: fields.paragraphs,
    model: connection.routes.writer,
    usageTokens: reportedTokens ?? Math.ceil((prompt.length + content.length) / 2),
    usageEstimated: !reportedTokens,
  };
}

export async function extractChapterStateWithConnection(
  connection: ModelConnection,
  chapter: GeneratedChapter,
  endingContract?: EndingContract,
): Promise<ExtractedChapterState> {
  const endingSchema = endingContract
    ? `，"endingResolution":{"targetEndingSatisfied":true,"targetEndingEvidence":"正文中的原句","satisfiedPrerequisiteIndices":[0],"prerequisiteEvidence":[{"prerequisiteIndex":0,"evidence":"正文中的原句"}],"noContinuationHook":true}`
    : "";
  const endingInstruction = endingContract
    ? ` 独立判断结局是否在剧情行动中真实完成。结局目标=${endingContract.targetEnding}；前置条件（按下标）=${endingContract.prerequisites.map((item, index) => `${index}:${item}`).join("；")}。evidence 必须逐字引用正文中至少 8 个字的连续原句；仅复述后台契约、不对应行动结果时必须判为 false。`
    : "";
  const completion = await completeJson<Partial<ExtractedChapterState>>(
    connection,
    connection.routes.extractor,
    `你是独立的正史状态抽取器。只返回 JSON：{"events":[{"type":"choice","title":"","cause":"","outcome":"","participantNames":[],"location":""}],"characterUpdates":[{"name":"","status":"","location":"","goal":"","knowledgeGained":[]}],"itemUpdates":[{"name":"","status":"held","holderName":"","location":""}]${endingSchema}}；不得新增正文没有的事实。${endingInstruction}`,
    `${chapter.title}\n${chapter.paragraphs.join("\n")}`,
    30_000,
    1_500,
  );
  const parsed = completion.value;
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
    endingResolution,
    usageTokens: completion.usageTokens,
    usageEstimated: completion.usageEstimated,
  };
}
