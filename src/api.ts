import type {
  AuditEvent,
  AuthPayload,
  BootstrapPayload,
  AppendReaderStoryEventInput,
  CreateStoryConstraintInput,
  CreateStoryInput,
  ContentReport,
  GenerationJob,
  ModelConnection,
  ModelConnectionInput,
  OpsMetrics,
  OpsQualityBucket,
  RetconTransaction,
  ReaderMessageContext,
  ReaderPreference,
  ReadingProgress,
  SafetyDecision,
  Story,
  StoryConstraintCommandResult,
  StoryEventCommandResult,
  StoryWorldState,
} from "./types";

const tokenKey = "xumo-auth-token";

export const authStore = {
  get: () => localStorage.getItem(tokenKey),
  set: (token: string) => localStorage.setItem(tokenKey, token),
  clear: () => localStorage.removeItem(tokenKey),
};

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Keep the status-based fallback message.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface GenerationStreamUpdate {
  event: "stage" | "paragraph" | "reset_draft";
  stage?: number;
  label?: string;
  index?: number;
  title?: string;
  paragraph?: string;
}

async function generateChapterStream(
  story: Story,
  onUpdate?: (update: GenerationStreamUpdate) => void,
  options?: {
    chapterLength?: "compact" | "standard" | "immersive";
    idempotencyKey?: string;
  },
) {
  const response = await fetch(`/api/stories/${story.id}/chapters/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${authStore.get() ?? ""}`,
    },
    body: JSON.stringify({
      idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID(),
      branchId: story.activeBranchId,
      baseCanonVersion: story.canonVersion,
      chapterLength: options?.chapterLength ?? "standard",
    }),
  });
  if (!response.ok || !response.body) {
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
  if (!completed) throw new ApiError("续章流在正史提交前中断。", 502);
  return completed;
}

export const api = {
  login: (email: string, password: string) =>
    request<AuthPayload>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  bootstrap: () => request<BootstrapPayload>("/api/bootstrap"),
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
  createStory: (input: CreateStoryInput, idempotencyKey = crypto.randomUUID()) =>
    request<Story>("/api/stories", { method: "POST", body: JSON.stringify({ ...input, idempotencyKey }) }),
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
    jobs: GenerationJob[];
    auditEvents: AuditEvent[];
    reports: ContentReport[];
    safetyDecisions: SafetyDecision[];
  }>("/api/ops"),
};
