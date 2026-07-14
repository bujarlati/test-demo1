import type {
  AuditEvent,
  AuthPayload,
  BootstrapPayload,
  CreateStoryInput,
  GenerationJob,
  ModelConnection,
  ModelConnectionInput,
  OpsMetrics,
  RetconTransaction,
  Story,
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
  event: "stage" | "paragraph";
  stage?: number;
  label?: string;
  index?: number;
  title?: string;
  paragraph?: string;
}

async function generateChapterStream(
  story: Story,
  onUpdate?: (update: GenerationStreamUpdate) => void,
) {
  const response = await fetch(`/api/stories/${story.id}/chapters/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${authStore.get() ?? ""}`,
    },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      branchId: story.activeBranchId,
      baseCanonVersion: story.canonVersion,
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
      if (event === "stage" || event === "paragraph") {
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
  createStory: (input: CreateStoryInput) =>
    request<Story>("/api/stories", { method: "POST", body: JSON.stringify(input) }),
  generateChapter: generateChapterStream,
  sendMessage: (story: Story, message: string) =>
    request<{ story: Story; duplicate: boolean }>(`/api/stories/${story.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message,
        branchId: story.activeBranchId,
        baseCanonVersion: story.canonVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    }),
  saveProgress: (storyId: string, chapterId: string, scrollProgress: number) =>
    request<void>(`/api/stories/${storyId}/reading-progress`, {
      method: "PUT",
      body: JSON.stringify({ chapterId, scrollProgress }),
    }),
  toggleProtection: (storyId: string, characterId: string) =>
    request(`/api/stories/${storyId}/characters/${characterId}/protection`, {
      method: "POST",
    }),
  rollbackRetcon: (storyId: string, retconId: string) =>
    request<{ story: Story; retcon: RetconTransaction }>(`/api/stories/${storyId}/retcons/${retconId}/rollback`, {
      method: "POST",
    }),
  markCanonChangesRead: (storyId: string) =>
    request<void>(`/api/stories/${storyId}/canon-changes/read`, { method: "POST" }),
  connections: () =>
    request<{ connections: ModelConnection[]; defaultConnectionId: string }>(
      "/api/model-connections",
    ),
  createConnection: (input: ModelConnectionInput) =>
    request<ModelConnection>("/api/model-connections", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  testConnection: (connectionId: string) =>
    request<ModelConnection>(`/api/model-connections/${connectionId}/test`, { method: "POST" }),
  setDefaultConnection: (connectionId: string) =>
    request<{ defaultConnectionId: string }>(`/api/model-connections/${connectionId}/default`, {
      method: "POST",
    }),
  ops: () => request<{ metrics: OpsMetrics; jobs: GenerationJob[]; auditEvents: AuditEvent[] }>("/api/ops"),
};
