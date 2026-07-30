import type {
  CreateStoryResult,
  GenerationJob,
  OpeningJobProgress,
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
  progress: OpeningJobProgress | null;
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
  | { type: "recover_job"; jobId: string; progress?: OpeningJobProgress | null }
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
    progress: null,
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

function newestProgress(
  current: OpeningJobProgress | null,
  incoming: OpeningJobProgress | null | undefined,
): OpeningJobProgress | null {
  if (!incoming) return current;
  if (!current || incoming.seq > current.seq) return incoming;
  return current;
}

function applyStatus(state: OpeningJobState, status: OpeningJobStatusPayload): OpeningJobState {
  if (state.jobId && status.jobId !== state.jobId) return state;
  if (status.status === "running") {
    return {
      ...state,
      phase: "polling",
      jobId: status.jobId,
      progress: newestProgress(state.progress, status.progress),
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
      progress: newestProgress(state.progress, status.progress),
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
      return { ...state, phase: "starting", progress: null, error: null, failure: null };
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
      if (state.phase !== "idle" && state.jobId === action.jobId) {
        return {
          ...state,
          progress: newestProgress(state.progress, action.progress),
        };
      }
      return {
        ...state,
        phase: "polling",
        jobId: action.jobId,
        progress: action.progress ?? null,
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

export interface OpeningProgressPresentation {
  stepIndex: number;
  title: string;
  detail: string;
}

export function openingProgressPresentation(
  progress: OpeningJobProgress | null,
): OpeningProgressPresentation {
  if (!progress) {
    return {
      stepIndex: -1,
      title: "正在读取真实进度",
      detail: "任务仍在后台处理中，正在等待服务器返回最新阶段。",
    };
  }
  if (progress.stage === "planning") {
    return {
      stepIndex: 0,
      title: "正在构思故事蓝图",
      detail: "正在整理人物、世界规则和核心冲突。",
    };
  }
  if (progress.stage === "drafting") {
    return {
      stepIndex: 1,
      title: "正在写作第一稿",
      detail: "AI 作者正在写下第一章；这一步可能需要几分钟。",
    };
  }
  if (progress.stage === "saving") {
    return {
      stepIndex: 3,
      title: "正在保存到书架",
      detail: "正文已经通过检查，正在保存故事和第一章。",
    };
  }
  if (progress.activity === "checking") {
    return {
      stepIndex: 2,
      title: `正在检查第 ${progress.draftNumber} 稿`,
      detail: "正在检查人物行动、情节因果和阅读体验。",
    };
  }
  if (progress.revisionSource === "user") {
    return {
      stepIndex: 2,
      title: "正在按你的选择修订第 2 稿",
      detail: "原故事设定和已有情节会继续保留。",
    };
  }
  if (progress.revisionSource === "timeout") {
    return {
      stepIndex: 2,
      title: "判断时间已结束，正在自动修订第 2 稿",
      detail: "系统已接管处理，原故事设定会继续保留。",
    };
  }
  const detailByReason: Record<typeof progress.revisionReason, string> = {
    content_incomplete: "第一稿内容还不完整，正在补足关键情节与行动结果。",
    experience_not_clear: "第一稿还没有充分呈现设定的阅读体验，正在加强人物行动与结果。",
    structure_needs_adjustment: "第一稿的结构需要调整，正在整理段落与情节衔接。",
    narration_needs_polish: "第一稿有一句叙述需要处理，正在保留原设定并修订表达。",
    quality_needs_adjustment: "第一稿需要进一步打磨，正在保留原设定并修订细节。",
  };
  return {
    stepIndex: 2,
    title: "第一稿需要调整，正在修订第 2 稿",
    detail: detailByReason[progress.revisionReason],
  };
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
