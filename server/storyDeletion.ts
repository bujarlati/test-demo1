import { createHash } from "node:crypto";
import type {
  AppStore,
  AuditEvent,
  GenerationFailureObservation,
  GenerationJob,
} from "../src/types";

export const DELETED_STORY_PLACEHOLDER = "deleted";
export const DELETED_STORY_TITLE = "已删除故事";
export const DELETED_FAILURE_MESSAGE = "故事已删除；仅保留脱敏失败统计。";

export type StoryDeletionErrorCode =
  | "story_not_found"
  | "story_delete_confirmation_mismatch"
  | "story_delete_busy";

export interface PersistStoryDeletionInput {
  ownerId: string;
  storyId: string;
  confirmationTitle: string;
  auditId: string;
  deletedAt: string;
}

export interface StoryDeletionResult {
  wasCurrentStory: boolean;
  wasPublished: boolean;
  hadChapters: boolean;
}

export class StoryDeletionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: StoryDeletionErrorCode,
  ) {
    super(message);
    this.name = "StoryDeletionError";
  }
}

export function storyNotFoundError(): StoryDeletionError {
  return new StoryDeletionError("故事不存在或不属于当前账号。", 404, "story_not_found");
}

export function storyDeletionBusyError(): StoryDeletionError {
  return new StoryDeletionError("故事正在续写、修史、保存或等待审核；任务完成后再删除。", 409, "story_delete_busy");
}

export function assertStoryDeletionTitle(title: string, confirmationTitle: string): void {
  if (confirmationTitle.trim() !== title) {
    throw new StoryDeletionError("输入的故事标题不一致，未执行删除。", 400, "story_delete_confirmation_mismatch");
  }
}

export function hasActiveStoryWork(store: AppStore, storyId: string): boolean {
  return store.jobs.some((job) => job.storyId === storyId
    && (job.status === "running" || job.status === "awaiting_user_review"));
}

export function sanitizeGenerationJobAfterStoryDeletion(job: GenerationJob): GenerationJob {
  return {
    id: job.id,
    ownerId: job.ownerId,
    storyId: DELETED_STORY_PLACEHOLDER,
    storyTitle: DELETED_STORY_TITLE,
    chapterNumber: 0,
    task: job.task,
    model: job.model,
    connectionId: job.connectionId,
    promptVersion: job.promptVersion,
    status: job.status,
    tokens: job.tokens,
    ...(job.tokenBudget === undefined ? {} : { tokenBudget: job.tokenBudget }),
    ...(job.usageEstimated === undefined ? {} : { usageEstimated: job.usageEstimated }),
    ...(job.budgetDegraded === undefined ? {} : { budgetDegraded: job.budgetDegraded }),
    latencyMs: job.latencyMs,
    ...(job.firstTokenMs === undefined ? {} : { firstTokenMs: job.firstTokenMs }),
    cost: job.cost,
    ...(job.costEstimated === undefined ? {} : { costEstimated: job.costEstimated }),
    createdAt: job.createdAt,
    ...(job.acceptedAt ? { acceptedAt: job.acceptedAt } : {}),
    ...(job.rejectedAt ? { rejectedAt: job.rejectedAt } : {}),
    ...(job.acceptanceSignal ? { acceptanceSignal: job.acceptanceSignal } : {}),
  };
}

export function sanitizeGenerationFailureAfterStoryDeletion(
  failure: GenerationFailureObservation,
): GenerationFailureObservation {
  return {
    id: failure.id,
    jobId: failure.jobId,
    ownerId: failure.ownerId,
    storyId: DELETED_STORY_PLACEHOLDER,
    task: failure.task,
    stage: failure.stage,
    classifierVersion: failure.classifierVersion,
    category: failure.category,
    reasonCode: failure.reasonCode,
    message: DELETED_FAILURE_MESSAGE,
    fingerprint: createHash("sha256")
      .update([failure.classifierVersion, failure.category, failure.reasonCode, failure.stage].join("\u0000"))
      .digest("hex"),
    model: failure.model,
    connectionId: failure.connectionId,
    promptVersion: failure.promptVersion,
    attempt: failure.attempt,
    terminal: failure.terminal,
    retryable: failure.retryable,
    latencyMs: failure.latencyMs,
    tokens: failure.tokens,
    createdAt: failure.createdAt,
  };
}

export function sanitizeStoryAuditAfterDeletion(event: AuditEvent, storyId: string): AuditEvent {
  const referencesStory = event.targetId === storyId || event.metadata?.storyId === storyId;
  if (!referencesStory) return event;
  return { ...event, targetId: DELETED_STORY_PLACEHOLDER, metadata: { storyDeleted: true } };
}

export function createStoryDeletionAudit(
  ownerId: string,
  auditId: string,
  deletedAt: string,
  result: StoryDeletionResult,
): AuditEvent {
  return {
    id: auditId,
    actorUserId: ownerId,
    action: "story.deleted",
    targetType: "story",
    targetId: DELETED_STORY_PLACEHOLDER,
    createdAt: deletedAt,
    metadata: {
      storyDeleted: true,
      wasCurrentStory: result.wasCurrentStory,
      wasPublished: result.wasPublished,
      hadChapters: result.hadChapters,
    },
  };
}

export function applyStoryDeletionToStore(
  store: AppStore,
  ownerId: string,
  storyId: string,
  deletionAudit: AuditEvent,
): () => void {
  const before = structuredClone(store);
  store.stories = store.stories.filter((story) => story.id !== storyId || story.ownerId !== ownerId);
  for (const user of store.users) {
    if (user.activeStoryId === storyId) user.activeStoryId = null;
  }
  store.jobs = store.jobs.map((job) => job.storyId === storyId
    ? sanitizeGenerationJobAfterStoryDeletion(job)
    : job);
  store.generationFailures = store.generationFailures.map((failure) => failure.storyId === storyId
    ? sanitizeGenerationFailureAfterStoryDeletion(failure)
    : failure);
  store.safetyDecisions = store.safetyDecisions.filter((decision) => decision.storyId !== storyId);
  store.contentReports = store.contentReports.filter((report) => report.storyId !== storyId);
  store.storyCreationRequests = store.storyCreationRequests.filter((request) => request.storyId !== storyId);
  store.auditEvents = [
    deletionAudit,
    ...store.auditEvents.map((event) => sanitizeStoryAuditAfterDeletion(event, storyId)),
  ].slice(0, 500);
  return () => Object.assign(store, before);
}
