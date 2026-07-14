import type {
  BootstrapPayload,
  CreateStoryInput,
  GenerationJob,
  ModelConnection,
  ModelConnectionInput,
  OpsMetrics,
  Story,
} from "./types";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
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

export const api = {
  bootstrap: () => request<BootstrapPayload>("/api/bootstrap"),
  story: (storyId: string) => request<Story>(`/api/stories/${storyId}`),
  createStory: (input: CreateStoryInput) =>
    request<Story>("/api/stories", { method: "POST", body: JSON.stringify(input) }),
  generateChapter: (storyId: string) =>
    request<{ story: Story; duplicate: boolean }>(`/api/stories/${storyId}/chapters/generate`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    }),
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
    request<{ story: Story }>(`/api/stories/${storyId}/retcons/${retconId}/rollback`, {
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
  ops: () => request<{ metrics: OpsMetrics; jobs: GenerationJob[] }>("/api/ops"),
};
