import type {
  AppStore,
  AuditEvent,
  AuthSession,
  GenerationFailureSummaryBucket,
  NarrationReviewMetricBucket,
  GenerationJob,
  PublicStoryDetail,
  PublicStoryPage,
  PublicStoryQuery,
  Story,
  StorySummary,
  UserAccount,
} from "../../src/types";
import type {
  NarrationReviewCaseRecord,
  NarrationReviewCleanupCounts,
  NarrationReviewDecisionClaim,
  NarrationReviewFeedbackRecord,
} from "../narrationReviewState";
import type { PublicStorySharingModule } from "../publicStorySharing";
import type { PersistStoryDeletionInput, StoryDeletionResult } from "../storyDeletion";

export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface DatabaseExecutor {
  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row>>;
  execute(sql: string): Promise<void>;
  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface StoryPage {
  stories: StorySummary[];
  nextCursor: string | null;
  totalStories: number;
  totalChapters: number;
}

export interface PublicStoryReadRepository {
  list(query: PublicStoryQuery): Promise<PublicStoryPage>;
  read(viewerId: string, storyId: string): Promise<PublicStoryDetail | null>;
}

export interface LegacyImportCounts {
  users: number;
  stories: number;
  chapters: number;
  revisions: number;
}

export interface PersistenceDatabase {
  readonly kind: "postgresql";
  readonly publicStories: PublicStoryReadRepository;
  readonly publicStorySharing: PublicStorySharingModule;
  isStoryDeleted(storyId: string): boolean;
  migrate(): Promise<void>;
  isEmpty(): Promise<boolean>;
  loadRuntimeStore(): Promise<AppStore>;
  saveSnapshot(store: AppStore, rollbackOnFailure?: () => void): Promise<void>;
  deleteOwnedStory(input: PersistStoryDeletionInput): Promise<StoryDeletionResult>;
  findUserByEmail(normalizedEmail: string): Promise<UserAccount | null>;
  findUserBySessionTokenHash(tokenHash: string): Promise<UserAccount | null>;
  register(user: UserAccount, session: AuthSession, event: AuditEvent): Promise<void>;
  saveSession(session: AuthSession): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  reserveIdempotencyKey(userId: string, idempotencyKey: string): Promise<boolean>;
  hasIdempotencyKey(userId: string, idempotencyKey: string): Promise<boolean>;
  releaseIdempotencyKey(userId: string, idempotencyKey: string): Promise<void>;
  findStoryCreationRequest(userId: string, idempotencyKey: string): Promise<string | null>;
  findGenerationJobByIdempotencyKey(userId: string, idempotencyKey: string): Promise<GenerationJob | null>;
  listStories(ownerId: string, limit: number, cursor?: string): Promise<StoryPage>;
  loadStory(ownerId: string, storyId: string): Promise<Story | null>;
  listGenerationFailurePatterns(limit: number): Promise<GenerationFailureSummaryBucket[]>;
  listNarrationReviewMetrics(limit: number): Promise<NarrationReviewMetricBucket[]>;
  pauseOpeningForNarrationReview(job: GenerationJob, review: NarrationReviewCaseRecord): Promise<void>;
  getNarrationReviewCaseForOwner(ownerId: string, jobId: string): Promise<NarrationReviewCaseRecord | null>;
  getNarrationReviewCaseById(id: string): Promise<NarrationReviewCaseRecord | null>;
  claimNarrationReviewDecision(claim: NarrationReviewDecisionClaim): Promise<NarrationReviewCaseRecord | null>;
  claimExpiredNarrationReviews(now: string, limit: number): Promise<NarrationReviewCaseRecord[]>;
  listRecoverableNarrationReviews(limit?: number): Promise<NarrationReviewCaseRecord[]>;
  replaceNarrationReviewCase(
    oldCaseId: string,
    job: GenerationJob,
    review: NarrationReviewCaseRecord,
    resolvedAt: string,
  ): Promise<boolean>;
  resolveNarrationReviewCase(
    id: string,
    finalStatus: "resolved" | "failed",
    resolvedAt: string,
  ): Promise<boolean>;
  failExpiredNarrationReviewCase(id: string, now: string): Promise<boolean>;
  upsertNarrationReviewFeedback(feedback: NarrationReviewFeedbackRecord): Promise<void>;
  deleteExpiredNarrationReviewData(now: string): Promise<NarrationReviewCleanupCounts>;
  deleteModelConnection(connectionId: string): Promise<void>;
  clearStoryModelConnection(connectionId: string): Promise<void>;
  recordLegacyImport(sourceFingerprint: string, sourcePath: string, counts: LegacyImportCounts): Promise<void>;
  hasLegacyImport(sourceFingerprint: string): Promise<boolean>;
  counts(): Promise<LegacyImportCounts>;
  health(): Promise<void>;
  close(): Promise<void>;
}
