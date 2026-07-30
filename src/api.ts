import type {
  ApiErrorPayload,
  AuditEvent,
  AuthPayload,
  BootstrapPayload,
  ChapterGenerationStatusPayload,
  AppendReaderStoryEventInput,
  CreateStoryResult,
  CreateStoryConstraintInput,
  CreateStoryInput,
  ContentReport,
  GenerationFailureSummaryBucket,
  GenerationJob,
  NarrationReviewMetricBucket,
  NarrationReviewDecisionInput,
  OpeningJobStatusPayload,
  ModelConnection,
  ModelConnectionInput,
  OpsMetrics,
  OpsPublicationModeration,
  OpsQualityBucket,
  OwnerPublicationState,
  PublicationModerationSummary,
  PublicProfile,
  PublicProfileInput,
  PublicReadingProgress,
  PublicStoryDetail,
  PublicStoryPage,
  PublicStoryQuery,
  RetconTransaction,
  ReaderMessageContext,
  ReaderPreference,
  ReadingProgress,
  SafetyDecision,
  SavePublicReadingProgressInput,
  SetStoryPublicationInput,
  Story,
  StoryPagePayload,
  StoryConstraintCommandResult,
  StoryEventCommandResult,
  StoryWorldState,
} from "./types";
import { publicStoryCollectionUrl } from "./publicStoryState";

const tokenKey = "xumo-auth-token";

export const authStore = {
  get: () => localStorage.getItem(tokenKey),
  set: (token: string) => localStorage.setItem(tokenKey, token),
  clear: () => localStorage.removeItem(tokenKey),
};

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = authStore.get();
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    let code: string | undefined;
    let details: Readonly<Record<string, unknown>> | undefined;
    try {
      const body = (await response.json()) as Partial<ApiErrorPayload>;
      if (typeof body.message === "string" && body.message) message = body.message;
      if (typeof body.code === "string") code = body.code;
      if (body.details && typeof body.details === "object" && !Array.isArray(body.details)) {
        details = body.details;
      }
    } catch {
      // Keep the status-based fallback message.
    }
    throw new ApiError(message, response.status, code, details);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface GenerationStreamUpdate {
  event: "stage" | "paragraph" | "reset_draft" | "reconnecting";
  stage?: number;
  label?: string;
  index?: number;
  title?: string;
  paragraph?: string;
}

interface GenerateChapterOptions {
  chapterLength?: "compact" | "standard" | "immersive";
  idempotencyKey?: string;
  recoveryPollIntervalMs?: number;
  recoveryTimeoutMs?: number;
}

const CHAPTER_RECOVERY_POLL_INTERVAL_MS = 2_000;
const CHAPTER_RECOVERY_TIMEOUT_MS = 30 * 60 * 1_000;
const CHAPTER_RECOVERY_NOT_FOUND_LIMIT = 3;

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function recoverChapterGeneration(
  story: Story,
  idempotencyKey: string,
  onUpdate: ((update: GenerationStreamUpdate) => void) | undefined,
  options: GenerateChapterOptions,
) {
  onUpdate?.({
    event: "reconnecting",
    label: "连接短暂中断，正在确认后台续写进度。",
  });
  const pollIntervalMs = Math.max(0, options.recoveryPollIntervalMs ?? CHAPTER_RECOVERY_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(1, options.recoveryTimeoutMs ?? CHAPTER_RECOVERY_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let observedJob = false;
  let initialNotFoundResponses = 0;

  while (Date.now() <= deadline) {
    let status: ChapterGenerationStatusPayload | null = null;
    try {
      status = await request<ChapterGenerationStatusPayload>(
        `/api/stories/${story.id}/chapters/generation-status`,
        {
          method: "POST",
          body: JSON.stringify({ idempotencyKey }),
        },
      );
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) throw error;
      // The recovery request can share the same brief network outage. Keep reconciling.
    }
    if (status?.status === "completed") return { story: status.story, duplicate: true };
    if (status?.status === "failed") {
      throw new ApiError(status.message || "续章失败。", status.retryable ? 422 : 500);
    }
    if (status?.status === "running") observedJob = true;
    if (status?.status === "not_found" && !observedJob) {
      initialNotFoundResponses += 1;
      if (initialNotFoundResponses >= CHAPTER_RECOVERY_NOT_FOUND_LIMIT) {
        throw new ApiError("连接在续写开始前中断，本次没有创建后台作业；请重新点击生成。", 503);
      }
    }
    await wait(pollIntervalMs);
  }

  throw new ApiError("连接仍不稳定，后台续写可能还在继续；请稍后刷新本页查看结果。", 202);
}

async function generateChapterStream(
  story: Story,
  onUpdate?: (update: GenerationStreamUpdate) => void,
  options: GenerateChapterOptions = {},
) {
  const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(`/api/stories/${story.id}/chapters/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${authStore.get() ?? ""}`,
      },
      body: JSON.stringify({
        idempotencyKey,
        branchId: story.activeBranchId,
        baseCanonVersion: story.canonVersion,
        chapterLength: options.chapterLength ?? "standard",
      }),
    });
  } catch {
    return recoverChapterGeneration(story, idempotencyKey, onUpdate, options);
  }
  if (!response.ok || !response.body) {
    if (response.ok) return recoverChapterGeneration(story, idempotencyKey, onUpdate, options);
    let message = `续章请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Keep the status-based fallback.
    }
    throw new ApiError(message, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: { story: Story; duplicate: boolean } | null = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = frame.match(/^event:\s*(.+)$/m)?.[1];
        const data = frame.match(/^data:\s*(.+)$/m)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (event === "stage" || event === "paragraph" || event === "reset_draft") {
          onUpdate?.({ event, ...payload } as GenerationStreamUpdate);
        } else if (event === "complete") {
          completed = payload as unknown as { story: Story; duplicate: boolean };
        } else if (event === "error") {
          throw new ApiError(String(payload.message ?? "续章失败。"), 500);
        }
      }
      if (done) break;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return recoverChapterGeneration(story, idempotencyKey, onUpdate, options);
  }
  if (!completed) return recoverChapterGeneration(story, idempotencyKey, onUpdate, options);
  return completed;
}

async function createStory(input: CreateStoryInput, idempotencyKey: string = crypto.randomUUID()): Promise<CreateStoryResult> {
  const result = await request<CreateStoryResult | Story>("/api/stories", {
    method: "POST",
    body: JSON.stringify({ ...input, idempotencyKey }),
  });
  return "kind" in result ? result : { kind: "completed", story: result };
}

export const api = {
  login: (email: string, password: string) =>
    request<AuthPayload>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (name: string, email: string, password: string) =>
    request<AuthPayload>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  bootstrap: () => request<BootstrapPayload>("/api/bootstrap"),
  stories: (cursor: string, limit = 24) =>
    request<StoryPagePayload>(`/api/stories?cursor=${encodeURIComponent(cursor)}&limit=${limit}`),
  ownerPublication: (storyId: string) =>
    request<OwnerPublicationState>(`/api/stories/${encodeURIComponent(storyId)}/publication`),
  setStoryPublication: (storyId: string, input: SetStoryPublicationInput) =>
    request<OwnerPublicationState>(`/api/stories/${encodeURIComponent(storyId)}/publication`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  updatePublicProfile: (input: PublicProfileInput) =>
    request<PublicProfile>("/api/me/public-profile", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  publicStories: (query: PublicStoryQuery = {}, signal?: AbortSignal) =>
    request<PublicStoryPage>(publicStoryCollectionUrl(query), { signal }),
  publicStory: (publicStoryId: string, signal?: AbortSignal) =>
    request<PublicStoryDetail>(`/api/public-stories/${encodeURIComponent(publicStoryId)}`, { signal }),
  savePublicStoryProgress: (publicStoryId: string, input: SavePublicReadingProgressInput) =>
    request<PublicReadingProgress>(`/api/public-stories/${encodeURIComponent(publicStoryId)}/progress`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  reportPublicStory: (publicStoryId: string, chapterId: string, reason: string) =>
    request<ContentReport>(`/api/public-stories/${encodeURIComponent(publicStoryId)}/reports`, {
      method: "POST",
      body: JSON.stringify({ chapterId, reason }),
    }),
  suspendPublicStory: (publicStoryId: string, reason: string) =>
    request<PublicationModerationSummary>(`/api/ops/publications/${encodeURIComponent(publicStoryId)}/suspend`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  restorePublicStory: (publicStoryId: string) =>
    request<PublicationModerationSummary>(`/api/ops/publications/${encodeURIComponent(publicStoryId)}/restore`, {
      method: "POST",
    }),
  story: (storyId: string) => request<Story>(`/api/stories/${storyId}`),
  worldState: (storyId: string) => request<StoryWorldState>(`/api/stories/${storyId}/state`),
  createConstraint: (
    story: Story,
    input: Omit<CreateStoryConstraintInput, "source" | "branchId" | "baseCanonVersion" | "idempotencyKey">,
    idempotencyKey = crypto.randomUUID(),
  ) => request<StoryConstraintCommandResult>(`/api/stories/${story.id}/constraints`, {
    method: "POST",
    body: JSON.stringify({
      ...input,
      branchId: story.activeBranchId,
      baseCanonVersion: story.canonVersion,
      idempotencyKey,
    }),
  }),
  appendEvent: (
    story: Story,
    input: Omit<AppendReaderStoryEventInput, "branchId" | "baseCanonVersion" | "idempotencyKey">,
    idempotencyKey = crypto.randomUUID(),
  ) => request<StoryEventCommandResult>(`/api/stories/${story.id}/events`, {
    method: "POST",
    body: JSON.stringify({
      ...input,
      branchId: story.activeBranchId,
      baseCanonVersion: story.canonVersion,
      idempotencyKey,
    }),
  }),
  createStory,
  generationJob: (jobId: string, signal?: AbortSignal) =>
    request<OpeningJobStatusPayload>(`/api/generation-jobs/${encodeURIComponent(jobId)}`, { signal }),
  decideNarrationReview: (jobId: string, input: NarrationReviewDecisionInput) =>
    request<OpeningJobStatusPayload>(`/api/generation-jobs/${encodeURIComponent(jobId)}/narration-review`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  generateChapter: generateChapterStream,
  sendMessage: (story: Story, message: string, clientContext?: ReaderMessageContext) =>
    request<{ story: Story; duplicate: boolean }>(`/api/stories/${story.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message,
        branchId: story.activeBranchId,
        baseCanonVersion: story.canonVersion,
        idempotencyKey: crypto.randomUUID(),
        clientContext,
      }),
    }),
  saveProgress: (story: Story, chapterId: string, scrollProgress: number, progressVersion: number) =>
    request<ReadingProgress>(`/api/stories/${story.id}/reading-progress`, {
      method: "PUT",
      body: JSON.stringify({
        chapterId,
        scrollProgress,
        progressVersion,
        activeBranchId: story.activeBranchId,
        canonVersion: story.canonVersion,
      }),
    }),
  setStoryStatus: (storyId: string, status: "active" | "paused" | "archived") =>
    request<Story>(`/api/stories/${storyId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  toggleProtection: (storyId: string, characterId: string) =>
    request(`/api/stories/${storyId}/characters/${characterId}/protection`, {
      method: "POST",
    }),
  rollbackRetcon: (story: Story, retconId: string) =>
    request<{ story: Story; retcon: RetconTransaction }>(`/api/stories/${story.id}/retcons/${retconId}/rollback`, {
      method: "POST",
      body: JSON.stringify({
        branchId: story.activeBranchId,
        baseCanonVersion: story.canonVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    }),
  markCanonChangesRead: (storyId: string) =>
    request<void>(`/api/stories/${storyId}/canon-changes/read`, { method: "POST" }),
  setPreferenceActive: (storyId: string, preferenceId: string, active: boolean) =>
    request<ReaderPreference>(`/api/stories/${storyId}/preferences/${preferenceId}`, {
      method: "PATCH",
      body: JSON.stringify({ active }),
    }),
  deletePreference: (storyId: string, preferenceId: string) =>
    request<void>(`/api/stories/${storyId}/preferences/${preferenceId}`, { method: "DELETE" }),
  reports: (storyId?: string) =>
    request<ContentReport[]>(`/api/reports${storyId ? `?storyId=${encodeURIComponent(storyId)}` : ""}`),
  reportChapter: (storyId: string, chapterId: string, reason: string) =>
    request<ContentReport>(`/api/stories/${storyId}/reports`, {
      method: "POST",
      body: JSON.stringify({ chapterId, reason }),
    }),
  appealReport: (reportId: string) =>
    request<ContentReport>(`/api/reports/${reportId}/appeal`, { method: "POST" }),
  reviewReport: (reportId: string, status: "reviewing" | "resolved", resolutionNote?: string) =>
    request<ContentReport>(`/api/reports/${reportId}`, {
      method: "PATCH",
      body: JSON.stringify({ status, resolutionNote }),
    }),
  connections: () =>
    request<{ connections: ModelConnection[]; defaultConnectionId: string }>(
      "/api/model-connections",
    ),
  createConnection: (input: ModelConnectionInput) =>
    request<ModelConnection>("/api/model-connections", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateConnection: (connectionId: string, input: Partial<ModelConnectionInput>) =>
    request<ModelConnection>(`/api/model-connections/${connectionId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteConnection: (connectionId: string) =>
    request<void>(`/api/model-connections/${connectionId}`, { method: "DELETE" }),
  testConnection: (connectionId: string) =>
    request<ModelConnection>(`/api/model-connections/${connectionId}/test`, { method: "POST" }),
  setDefaultConnection: (connectionId: string) =>
    request<{ defaultConnectionId: string }>(`/api/model-connections/${connectionId}/default`, {
      method: "POST",
    }),
  ops: () => request<{
    metrics: OpsMetrics;
    qualityBreakdown: OpsQualityBucket[];
    failurePatterns: GenerationFailureSummaryBucket[];
    narrationReviewMetrics: NarrationReviewMetricBucket[];
    jobs: GenerationJob[];
    auditEvents: AuditEvent[];
    reports: ContentReport[];
    safetyDecisions: SafetyDecision[];
    publicationModeration: OpsPublicationModeration;
  }>("/api/ops"),
};
