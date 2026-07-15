import type { GenerationJob } from "../src/types";

export interface ModelUsageFailure extends Error {
  usageTokens?: number;
  usageEstimated?: boolean;
}

export function attachModelUsage(error: unknown, usageTokens: number, usageEstimated: boolean): ModelUsageFailure {
  const failure = (error instanceof Error ? error : new Error(String(error))) as ModelUsageFailure;
  failure.usageTokens = Math.max(failure.usageTokens ?? 0, Math.max(0, Math.round(usageTokens)));
  failure.usageEstimated = usageEstimated;
  return failure;
}

export function addModelUsage(error: unknown, usageTokens: number, usageEstimated: boolean): ModelUsageFailure {
  const failure = (error instanceof Error ? error : new Error(String(error))) as ModelUsageFailure;
  const localTokens = Math.max(0, Math.round(failure.usageTokens ?? 0));
  const priorTokens = Math.max(0, Math.round(usageTokens));
  failure.usageTokens = priorTokens + localTokens;
  failure.usageEstimated = usageEstimated || (localTokens > 0 && (failure.usageEstimated ?? true));
  return failure;
}

export function attachedModelUsage(error: unknown): { tokens: number; estimated: boolean } {
  if (!(error instanceof Error)) return { tokens: 0, estimated: false };
  const failure = error as ModelUsageFailure;
  const tokens = Math.max(0, Math.round(failure.usageTokens ?? 0));
  return { tokens, estimated: tokens > 0 && (failure.usageEstimated ?? true) };
}

export function accumulateModelUsage(
  observed: { tokens: number; estimated: boolean },
  error: unknown,
): { tokens: number; estimated: boolean } {
  const failure = attachedModelUsage(error);
  return {
    tokens: Math.max(0, Math.round(observed.tokens)) + failure.tokens,
    estimated: observed.estimated || failure.estimated,
  };
}

export function recordFailedJobUsage(
  job: GenerationJob,
  error: unknown,
  observed: { tokens: number; estimated: boolean; costPerMillion: number },
): void {
  const failure = error instanceof Error ? error as ModelUsageFailure : undefined;
  const errorTokens = Math.max(0, Math.round(failure?.usageTokens ?? 0));
  const observedTokens = Math.max(0, Math.round(observed.tokens));
  const useErrorUsage = errorTokens > observedTokens;
  const tokens = Math.max(errorTokens, observedTokens);
  job.tokens = tokens;
  job.usageEstimated = useErrorUsage ? (failure?.usageEstimated ?? true) : observed.estimated;
  job.cost = Number(((tokens / 1_000_000) * observed.costPerMillion).toFixed(4));
  job.costEstimated = job.usageEstimated;
}
