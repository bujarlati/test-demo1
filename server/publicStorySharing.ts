import type {
  OwnerPublicationState,
  PublicationModerationInput,
  PublicationModerationOverview,
  PublicationModerationSummary,
  PublicProfile,
  PublicProfileInput,
  PublicReadingProgress,
  PublicStoryDetail,
  PublicStoryPage,
  PublicStoryQuery,
  PublicStoryReportTarget,
  SavePublicReadingProgressInput,
  SetStoryPublicationInput,
  StoryPublicationStatus,
  StoryStatus,
  UserAccount,
} from "../src/types";

export type OwnerPublicationStatus = "private" | StoryPublicationStatus;

export type PublicStorySharingErrorCode =
  | "invalid_public_pen_name"
  | "story_not_owned"
  | "story_not_publishable"
  | "publication_suspended"
  | "public_story_unavailable"
  | "progress_conflict"
  | "invalid_public_story_cursor"
  | "public_story_sharing_disabled"
  | "public_story_sharing_requires_postgresql";

export class PublicStorySharingError extends Error {
  readonly code: PublicStorySharingErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: PublicStorySharingErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "PublicStorySharingError";
    this.code = code;
    this.details = details;
  }
}

export interface PublicStorySharingEnvironment {
  PUBLIC_STORY_SHARING_ENABLED?: string;
  DATABASE_URL?: string;
}

export interface StoryPublishability {
  status: StoryStatus;
  chapterCount: number;
}

export interface PublicStorySharingModule {
  getOwnerPublication(ownerId: string, storyId: string): Promise<OwnerPublicationState>;
  setOwnerPublication(
    actor: Pick<UserAccount, "id" | "role" | "publicPenName">,
    storyId: string,
    input: SetStoryPublicationInput,
  ): Promise<OwnerPublicationState>;
  updatePublicProfile(userId: string, input: PublicProfileInput): Promise<PublicProfile>;
  discover(viewerId: string, query: PublicStoryQuery): Promise<PublicStoryPage>;
  read(viewerId: string, publicStoryId: string): Promise<PublicStoryDetail>;
  saveProgress(
    viewerId: string,
    publicStoryId: string,
    input: SavePublicReadingProgressInput,
  ): Promise<PublicReadingProgress>;
  validateReportTarget(
    viewerId: string,
    publicStoryId: string,
    chapterId: string,
  ): Promise<PublicStoryReportTarget>;
  moderate(
    adminUserId: string,
    publicStoryId: string,
    input: PublicationModerationInput,
  ): Promise<PublicationModerationSummary>;
  listModeration(limit: number): Promise<PublicationModerationSummary[]>;
  moderationOverview(limit: number): Promise<PublicationModerationOverview>;
}

export interface PublicStorySharingPersistence {
  getOwnerPublication(ownerId: string, storyId: string): Promise<OwnerPublicationState>;
  setOwnerPublication(
    actor: Pick<UserAccount, "id" | "role" | "publicPenName">,
    storyId: string,
    input: SetStoryPublicationInput,
  ): Promise<OwnerPublicationState>;
  updatePublicProfile(userId: string, publicPenName: string): Promise<PublicProfile>;
  list(query: PublicStoryQuery): Promise<PublicStoryPage>;
  read(viewerId: string, storyId: string): Promise<PublicStoryDetail | null>;
  saveProgress(
    viewerId: string,
    storyId: string,
    input: SavePublicReadingProgressInput,
  ): Promise<PublicReadingProgress>;
  findReportTarget(
    storyId: string,
    chapterId: string,
  ): Promise<PublicStoryReportTarget | null>;
  moderate(
    adminUserId: string,
    storyId: string,
    input: PublicationModerationInput,
  ): Promise<PublicationModerationSummary>;
  listModeration(limit: number): Promise<PublicationModerationSummary[]>;
  moderationOverview(limit: number): Promise<PublicationModerationOverview>;
}

const invalidPenNameCharacter = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export function normalizePublicPenName(value: string): string {
  if (typeof value !== "string" || invalidPenNameCharacter.test(value)) {
    throw new PublicStorySharingError(
      "invalid_public_pen_name",
      "笔名需为 2 至 20 个字符，且不能包含换行或控制字符。",
    );
  }
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length < 2 || length > 20) {
    throw new PublicStorySharingError(
      "invalid_public_pen_name",
      "笔名需为 2 至 20 个字符，且不能包含换行或控制字符。",
    );
  }
  return normalized;
}

export function publicStorySharePath(storyId: string): string {
  return `/public/story/${encodeURIComponent(storyId)}`;
}

export function ownerPublicationState(
  storyId: string,
  status: OwnerPublicationStatus,
  firstPublishedAt: string | null = null,
  statusUpdatedAt: string | null = null,
  adminReason: string | null = null,
): OwnerPublicationState {
  return {
    storyId,
    status,
    published: status === "active",
    sharePath: publicStorySharePath(storyId),
    firstPublishedAt,
    statusUpdatedAt,
    adminReason,
  };
}

export function nextOwnerPublicationStatus(
  current: OwnerPublicationStatus,
  published: boolean,
): OwnerPublicationStatus {
  if (current === "admin_suspended") {
    throw new PublicStorySharingError(
      "publication_suspended",
      "作品已被管理员下架，作者暂时不能改变公开状态。",
    );
  }
  if (published) return "active";
  return current === "active" ? "author_unpublished" : current;
}

export function assertStoryPublishable(story: StoryPublishability): void {
  if (story.status === "archived" || !Number.isInteger(story.chapterCount) || story.chapterCount < 1) {
    throw new PublicStorySharingError(
      "story_not_publishable",
      "只有至少包含一章成功正文的非归档故事可以公开。",
    );
  }
}

export function publicStorySharingEnabled(
  environment: PublicStorySharingEnvironment = process.env,
): boolean {
  return environment.PUBLIC_STORY_SHARING_ENABLED?.trim().toLowerCase() === "true";
}

export function assertPublicStorySharingPrerequisites(
  environment: PublicStorySharingEnvironment = process.env,
): void {
  if (publicStorySharingEnabled(environment) && !environment.DATABASE_URL?.trim()) {
    throw new PublicStorySharingError(
      "public_story_sharing_requires_postgresql",
      "PUBLIC_STORY_SHARING_ENABLED requires PostgreSQL DATABASE_URL.",
    );
  }
}

export function createStoryOwnershipError(): PublicStorySharingError & { status: 403 } {
  return Object.assign(
    new PublicStorySharingError(
      "story_not_owned",
      "故事不存在或不属于当前账号。",
    ),
    { status: 403 as const },
  );
}

export function createPublicStoryUnavailableError(): PublicStorySharingError {
  return new PublicStorySharingError(
    "public_story_unavailable",
    "作品暂不可读。",
  );
}

export function createProgressConflictError(
  latestProgress: PublicReadingProgress | null,
): PublicStorySharingError {
  return new PublicStorySharingError(
    "progress_conflict",
    "阅读进度已在其他页面更新，请使用服务器最新进度。",
    { latestProgress },
  );
}

export function createInvalidPublicStoryCursorError(): PublicStorySharingError & { status: 400 } {
  return Object.assign(
    new PublicStorySharingError(
      "invalid_public_story_cursor",
      "公共书库分页游标无效，请重新加载。",
    ),
    { status: 400 as const },
  );
}

export function createPublicStorySharingDisabledError(): PublicStorySharingError {
  return new PublicStorySharingError(
    "public_story_sharing_disabled",
    "公共书库暂未开放。",
  );
}

export function createPublicStorySharingModule(
  persistence: PublicStorySharingPersistence,
): PublicStorySharingModule {
  return {
    getOwnerPublication: (ownerId, storyId) => persistence.getOwnerPublication(ownerId, storyId),
    setOwnerPublication: (actor, storyId, input) => persistence.setOwnerPublication(
      actor,
      storyId,
      input.publicPenName === undefined
        ? { published: input.published }
        : {
            published: input.published,
            publicPenName: normalizePublicPenName(input.publicPenName),
          },
    ),
    updatePublicProfile: async (userId, input) => persistence.updatePublicProfile(
      userId,
      normalizePublicPenName(input.publicPenName),
    ),
    discover: (_viewerId, query) => persistence.list(query),
    read: async (viewerId, publicStoryId) => {
      const detail = await persistence.read(viewerId, publicStoryId);
      if (!detail) throw createPublicStoryUnavailableError();
      return detail;
    },
    saveProgress: (viewerId, publicStoryId, input) => persistence.saveProgress(
      viewerId,
      publicStoryId,
      input,
    ),
    validateReportTarget: async (_viewerId, publicStoryId, chapterId) => {
      const target = await persistence.findReportTarget(publicStoryId, chapterId);
      if (!target) throw createPublicStoryUnavailableError();
      return target;
    },
    moderate: (adminUserId, publicStoryId, input) => {
      const reason = input.reason?.trim();
      return persistence.moderate(
        adminUserId,
        publicStoryId,
        reason
          ? { action: input.action, reason }
          : { action: input.action },
      );
    },
    listModeration: (limit) => persistence.listModeration(limit),
    moderationOverview: (limit) => persistence.moderationOverview(limit),
  };
}
