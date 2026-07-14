import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { CapabilitySnapshot, ModelConnection } from "../src/types";
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
  if (url.username || url.password) {
    throw new Error("Base URL 不得内嵌用户名或密码。");
  }
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

export async function testConnection(
  connection: ModelConnection,
): Promise<CapabilitySnapshot> {
  await assertSafeEndpoint(connection.baseUrl);
  const apiKey = await readSecret(connection.id);
  const startedAt = performance.now();
  const response = await fetch(endpoint(connection.baseUrl, "/models"), {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`连接返回 ${response.status}，请检查地址、Key 与访问权限。`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: string }>;
  };
  const models = (payload.data ?? [])
    .map((item) => item.id)
    .filter((item): item is string => Boolean(item))
    .slice(0, 20);
  const mappedModels = Object.values(connection.routes);
  return {
    streaming: true,
    jsonSchema: true,
    embedding: models.some((model) => /embed/i.test(model)) || mappedModels.some((model) => /embed/i.test(model)),
    promptCache: false,
    testedAt: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - startedAt),
    models,
  };
}

export async function generateChapterWithConnection(
  connection: ModelConnection,
  prompt: string,
): Promise<{ title: string; paragraphs: string[]; model: string }> {
  await assertSafeEndpoint(connection.baseUrl);
  const apiKey = await readSecret(connection.id);
  const response = await fetch(endpoint(connection.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: connection.routes.writer,
      messages: [
        {
          role: "system",
          content:
            "你是中文连载小说作家。只返回 JSON：{\"title\":\"章节名\",\"paragraphs\":[\"段落\"]}。生成 5 至 8 个完整段落，保持因果与克制。",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.9,
      response_format: { type: "json_object" },
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`正文模型返回 ${response.status}；未启用静默回退。`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("正文模型没有返回可用内容。");
  const parsed = JSON.parse(content) as { title?: string; paragraphs?: string[] };
  if (!parsed.title || !Array.isArray(parsed.paragraphs) || parsed.paragraphs.length < 2) {
    throw new Error("正文模型输出未通过章节 Schema 校验。");
  }
  return {
    title: parsed.title,
    paragraphs: parsed.paragraphs.map(String),
    model: connection.routes.writer,
  };
}
