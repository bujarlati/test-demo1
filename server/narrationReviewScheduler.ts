import type {
  NarrationReviewCaseRecord,
  NarrationReviewCleanupCounts,
} from "./narrationReviewState";

export interface NarrationReviewSweepRepository {
  listRecoverableNarrationReviews(limit?: number): Promise<NarrationReviewCaseRecord[]>;
  claimExpiredNarrationReviews(now: string, limit: number): Promise<NarrationReviewCaseRecord[]>;
  deleteExpiredNarrationReviewData(now: string): Promise<NarrationReviewCleanupCounts>;
}

export interface NarrationReviewSweepOptions {
  now: Date;
  repository: NarrationReviewSweepRepository;
  resume(caseId: string): Promise<void>;
  limit?: number;
}

export interface NarrationReviewSweepResult {
  recovered: number;
  timedOut: number;
  expiredPayloads: number;
  expiredExcerpts: number;
}

export async function runNarrationReviewSweep(
  options: NarrationReviewSweepOptions,
): Promise<NarrationReviewSweepResult> {
  const limit = Math.max(1, Math.min(100, Math.round(options.limit ?? 50)));
  const now = options.now.toISOString();
  const recoverable = await options.repository.listRecoverableNarrationReviews(limit);
  const resumed = new Set<string>();

  for (const review of recoverable) {
    const payloadExpired = Date.parse(review.payloadExpiresAt) <= options.now.getTime();
    const hasClaimedAction = review.status === "kept" ||
      review.status === "rewrite_requested" ||
      review.status === "timeout_rewrite";
    if (!payloadExpired && !hasClaimedAction) continue;
    resumed.add(review.id);
    await options.resume(review.id);
  }

  const claimed = await options.repository.claimExpiredNarrationReviews(now, limit);
  for (const review of claimed) {
    if (resumed.has(review.id)) continue;
    resumed.add(review.id);
    await options.resume(review.id);
  }

  const cleanup = await options.repository.deleteExpiredNarrationReviewData(now);
  return {
    recovered: resumed.size,
    timedOut: claimed.length,
    expiredPayloads: cleanup.payloads,
    expiredExcerpts: cleanup.excerpts,
  };
}

export interface NarrationReviewSchedulerOptions {
  sweep(): Promise<unknown>;
  intervalMs?: number;
  onError?(error: unknown): void;
}

export interface NarrationReviewSchedulerHandle {
  runNow(): Promise<void>;
  stop(): void;
}

export function startNarrationReviewScheduler(
  options: NarrationReviewSchedulerOptions,
): NarrationReviewSchedulerHandle {
  let stopped = false;
  let active: Promise<void> | null = null;
  const runNow = async () => {
    if (stopped) return;
    if (active) return active;
    active = options.sweep()
      .then(() => undefined)
      .catch((error) => options.onError?.(error))
      .finally(() => {
        active = null;
      });
    return active;
  };
  const configured = options.intervalMs ?? 5_000;
  const intervalMs = Math.max(1_000, Math.min(60_000, Math.round(configured)));
  const timer = setInterval(() => void runNow(), intervalMs);
  timer.unref();
  void runNow();
  return {
    runNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
