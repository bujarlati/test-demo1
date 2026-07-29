import type {
  CreateStoryResult,
  GenerationJob,
  OpeningJobStatusPayload,
  PendingNarrationReviewView,
} from "./types";

export type OpeningJobPhase =
  | "idle"
  | "starting"
  | "polling"
  | "awaiting_user_review"
  | "submitting_decision"
  | "completed"
  | "failed";

export interface OpeningJobState {
  phase: OpeningJobPhase;
  idempotencyKey: string;
  jobId: string | null;
  review: PendingNarrationReviewView | null;
  storyId: string | null;
  failure: Extract<OpeningJobStatusPayload, { status: "failed" }> | null;
  latestRequestId: number;
  shareRedactedContext: boolean;
  error: string | null;
}

export type OpeningJobAction =
  | { type: "start" }
  | { type: "start_error"; message: string }
  | { type: "create_result"; result: CreateStoryResult }
  | { type: "recover_job"; jobId: string }
  | { type: "poll_started"; requestId: number }
  | { type: "status_received"; requestId: number; status: OpeningJobStatusPayload }
  | { type: "poll_error"; requestId: number; message: string }
  | { type: "set_context_consent"; value: boolean }
  | { type: "decision_started" }
  | { type: "decision_result"; status: OpeningJobStatusPayload }
  | { type: "decision_conflict" }
  | { type: "decision_error"; message: string }
  | { type: "clear_error" }
  | { type: "reset_after_failure"; idempotencyKey: string };

export function createInitialOpeningJobState(idempotencyKey: string): OpeningJobState {
  return {
    phase: "idle",
    idempotencyKey,
    jobId: null,
    review: null,
    storyId: null,
    failure: null,
    latestRequestId: 0,
    shareRedactedContext: false,
    error: null,
  };
}

function reviewFingerprint(review: PendingNarrationReviewView | null): string | null {
  if (!review) return null;
  return [
    review.id,
    String(review.version),
    review.contentHash,
    ...review.candidates.map((candidate) => candidate.id),
  ].join(":");
}

function applyStatus(state: OpeningJobState, status: OpeningJobStatusPayload): OpeningJobState {
  if (state.jobId && status.jobId !== state.jobId) return state;
  if (status.status === "running") {
    return {
      ...state,
      phase: "polling",
      jobId: status.jobId,
      review: null,
      failure: null,
      shareRedactedContext: false,
      error: null,
    };
  }
  if (status.status === "awaiting_user_review") {
    const sameReview = reviewFingerprint(state.review) === reviewFingerprint(status.review);
    return {
      ...state,
      phase: "awaiting_user_review",
      jobId: status.jobId,
      review: status.review,
      failure: null,
      shareRedactedContext: sameReview ? state.shareRedactedContext : false,
      error: sameReview ? state.error : null,
    };
  }
  if (status.status === "completed") {
    return {
      ...state,
      phase: "completed",
      jobId: status.jobId,
      review: null,
      storyId: status.storyId,
      failure: null,
      shareRedactedContext: false,
      error: null,
    };
  }
  return {
    ...state,
    phase: "failed",
    jobId: status.jobId,
    review: null,
    storyId: null,
    failure: status,
    shareRedactedContext: false,
    error: status.message,
  };
}

export function openingJobReducer(state: OpeningJobState, action: OpeningJobAction): OpeningJobState {
  switch (action.type) {
    case "start":
      return { ...state, phase: "starting", error: null, failure: null };
    case "start_error":
      return { ...state, phase: "idle", error: action.message };
    case "create_result":
      if (action.result.kind === "completed") {
        return {
          ...state,
          phase: "completed",
          storyId: action.result.story.id,
          error: null,
          failure: null,
        };
      }
      return applyStatus(state, action.result.job);
    case "recover_job":
      if (state.phase !== "idle" && state.jobId === action.jobId) return state;
      return {
        ...state,
        phase: "polling",
        jobId: action.jobId,
        review: null,
        storyId: null,
        failure: null,
        shareRedactedContext: false,
        error: null,
      };
    case "poll_started":
      if (action.requestId <= state.latestRequestId) return state;
      return { ...state, latestRequestId: action.requestId };
    case "status_received":
      if (action.requestId !== state.latestRequestId) return state;
      return applyStatus(state, action.status);
    case "poll_error":
      if (action.requestId !== state.latestRequestId) return state;
      return { ...state, error: action.message };
    case "set_context_consent":
      if (state.phase !== "awaiting_user_review") return state;
      return { ...state, shareRedactedContext: action.value };
    case "decision_started":
      if (state.phase !== "awaiting_user_review" || !state.review) return state;
      return { ...state, phase: "submitting_decision", error: null };
    case "decision_result":
      return applyStatus(state, action.status);
    case "decision_conflict":
      return {
        ...state,
        phase: "polling",
        review: null,
        shareRedactedContext: false,
        error: null,
      };
    case "decision_error":
      return {
        ...state,
        phase: state.review ? "awaiting_user_review" : "polling",
        error: action.message,
      };
    case "clear_error":
      return { ...state, error: null };
    case "reset_after_failure":
      return createInitialOpeningJobState(action.idempotencyKey);
  }
}

export function openingJobSecondsRemaining(deadlineAt: string, nowMs: number): number {
  const deadlineMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineMs)) return 0;
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
}

export function recoverOpeningJobId(
  pendingJobs: readonly GenerationJob[],
  requestedJobId?: string | null,
): string | null {
  if (requestedJobId) return requestedJobId;
  return pendingJobs
    .filter((job) => job.task === "opening" && (job.status === "running" || job.status === "awaiting_user_review"))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id))[0]
    ?.id ?? null;
}
