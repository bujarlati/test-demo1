import { ApiError, ApiTransportError } from "./api";
import type { BootstrapPayload } from "./types";

const DEFAULT_PROBE_DELAYS_MS = [100, 300, 700] as const;
const DEFAULT_PROBE_TIMEOUT_MS = 600;

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function storyDeletionTitleMatches(
  storyTitle: string,
  confirmationTitle: string,
): boolean {
  return confirmationTitle.trim() === storyTitle;
}

export class StoryDeletionFailedError extends Error {
  readonly code = "story_deletion_failed";

  constructor(cause: ApiTransportError) {
    super("删除请求未完成，故事仍然存在，请稍后重试。", { cause });
    this.name = "StoryDeletionFailedError";
  }
}

export class StoryDeletionOutcomeUnknownError extends Error {
  readonly code = "story_deletion_outcome_unknown";

  constructor(cause: ApiTransportError) {
    super("连接中断，暂时无法确认故事是否已删除。请刷新书架后再操作。", { cause });
    this.name = "StoryDeletionOutcomeUnknownError";
  }
}

export type StoryDeletionBootstrapRefreshOutcome =
  | { kind: "refreshed"; payload: BootstrapPayload }
  | { kind: "authentication_required" }
  | { kind: "unavailable" };

export async function refreshStoryDeletionBootstrapBestEffort(
  loadBootstrap: () => Promise<BootstrapPayload>,
): Promise<StoryDeletionBootstrapRefreshOutcome> {
  try {
    return { kind: "refreshed", payload: await loadBootstrap() };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { kind: "authentication_required" };
    }
    return { kind: "unavailable" };
  }
}

interface DeleteStoryWithReconciliationOptions {
  storyId: string;
  confirmationTitle: string;
  deleteRequest(storyId: string, confirmationTitle: string): Promise<void>;
  probeStory(storyId: string, signal?: AbortSignal): Promise<unknown>;
  probeDelaysMs?: readonly number[];
  probeTimeoutMs?: number;
  wait?(milliseconds: number): Promise<void>;
}

type ProbeResult =
  | { kind: "exists" }
  | { kind: "absent" }
  | { kind: "pending" }
  | { kind: "transport"; error: ApiTransportError }
  | { kind: "server_error"; error: ApiError }
  | { kind: "timeout" };

function classifyProbeError(error: unknown): ProbeResult {
  if (error instanceof ApiError) {
    if (error.status === 404) return { kind: "absent" };
    if (error.status >= 500) return { kind: "server_error", error };
    if (error.status === 409 && error.code === "story_delete_busy") {
      return { kind: "pending" };
    }
    throw error;
  }
  if (error instanceof ApiTransportError) return { kind: "transport", error };
  throw error;
}

async function probeDeletionOutcome(
  options: DeleteStoryWithReconciliationOptions,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const configuredTimeout = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(1, configuredTimeout)
    : DEFAULT_PROBE_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout>;
  const probe = options.probeStory(options.storyId, controller.signal).then<ProbeResult, ProbeResult>(
    () => ({ kind: "exists" }),
    (error: unknown) => controller.signal.aborted
      ? { kind: "timeout" }
      : classifyProbeError(error),
  );
  const timedOut = new Promise<ProbeResult>((resolve) => {
    timeout = setTimeout(() => {
      resolve({ kind: "timeout" });
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([probe, timedOut]);
  } finally {
    clearTimeout(timeout!);
  }
}

export async function deleteStoryWithReconciliation(
  options: DeleteStoryWithReconciliationOptions,
): Promise<void> {
  let responseLoss: ApiTransportError;
  try {
    await options.deleteRequest(options.storyId, options.confirmationTitle);
    return;
  } catch (error) {
    if (!(error instanceof ApiTransportError)) throw error;
    responseLoss = error;
  }

  const probeDelays = options.probeDelaysMs ?? DEFAULT_PROBE_DELAYS_MS;
  const delay = options.wait ?? wait;
  let lastResult: ProbeResult | undefined;

  for (const configuredDelay of probeDelays) {
    const delayMs = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 0;
    await delay(delayMs);
    const result = await probeDeletionOutcome(options);
    if (result.kind === "absent") return;
    lastResult = result;
  }

  if (lastResult?.kind === "exists") {
    throw new StoryDeletionFailedError(responseLoss);
  }
  if (lastResult?.kind === "server_error") throw lastResult.error;
  throw new StoryDeletionOutcomeUnknownError(responseLoss);
}
