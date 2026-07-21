import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AiTraceEvent {
  event: "request" | "response" | "parsed" | "error";
  timestamp: string;
  callId: string;
  attempt: number;
  stage: string;
  connectionId: string;
  model: string;
  completionApi?: string;
  elapsedMs?: number;
  timeoutMs?: number;
  maxTokens?: number;
  reportedTokens?: number;
  httpStatus?: number;
  system?: string;
  prompt?: string;
  providerRequest?: unknown;
  providerPayload?: unknown;
  rawContent?: string;
  parseMode?: "direct" | "extracted";
  parsedValue?: unknown;
  error?: string;
}

export type AiTraceWriter = (event: AiTraceEvent) => Promise<void>;

export const defaultAiTracePath = path.join(process.cwd(), "server", "data", "ai-trace.jsonl");
let writeQueue = Promise.resolve();

export function aiTraceEnabled(): boolean {
  const configured = process.env.AI_TRACE_ENABLED?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  if (process.env.NODE_TEST_CONTEXT) return false;
  return process.env.NODE_ENV !== "production";
}

export function configuredAiTracePath(): string {
  return process.env.AI_TRACE_FILE?.trim() || defaultAiTracePath;
}

export async function initializeAiTrace(): Promise<void> {
  if (!aiTraceEnabled()) return;
  const tracePath = configuredAiTracePath();
  await mkdir(path.dirname(tracePath), { recursive: true });
  await appendFile(tracePath, "", "utf8");
}

function redactTraceValue(value: unknown, key = ""): unknown {
  if (/^(?:authorization|apiKey|accessToken|refreshToken|password|secret|secretRef)$/i.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactTraceValue(childValue, childKey),
    ]));
  }
  return value;
}

export const writeAiTrace: AiTraceWriter = async (event) => {
  if (!aiTraceEnabled()) return;
  const safeEvent = redactTraceValue(event) as AiTraceEvent;
  const line = JSON.stringify(safeEvent);
  const tracePath = configuredAiTracePath();
  console.log(`[AI-TRACE] ${line}`);
  const write = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(tracePath), { recursive: true });
    await appendFile(tracePath, `${line}\n`, "utf8");
  });
  writeQueue = write.catch((error) => {
    console.error(`[AI-TRACE] 写入失败：${error instanceof Error ? error.message : String(error)}`);
  });
};
