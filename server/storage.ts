import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppStore, AuditEvent, AuthSession, NarrationReviewMetricBucket, Story, UserAccount } from "../src/types";
import { loadApplicationEncryptionKey } from "./appEncryption";
import { createSeedStore } from "./seed";
import type { GenerationJob } from "../src/types";
import type {
  NarrationReviewCaseRecord,
  NarrationReviewCleanupCounts,
  NarrationReviewDecisionClaim,
  NarrationReviewFeedbackRecord,
} from "./narrationReviewState";
import { captureCanonState } from "./canonState";
import { createLegacyExperienceContract, normalizeReadingExperienceContract, normalizeReadingExperienceDeliveryLedger } from "./readingExperience";
import { narrationReviewConfidenceThreshold } from "./narrationReview";
import {
  assertPublicStorySharingPrerequisites,
  createPublicStorySharingDisabledError,
  publicStorySharingEnabled,
  type PublicStorySharingModule,
} from "./publicStorySharing";
import { summarizeStory } from "./storyService";
import { createPostgresDatabase } from "./database/postgres";
import type { PersistenceDatabase, StoryPage } from "./database/types";
import {
  appendGenerationFailure,
  createGenerationFailureObservation,
  summarizeGenerationFailures,
  upgradeGenerationFailureObservation,
} from "./failureTelemetry";
import {
  applyStoryDeletionToStore,
  assertStoryDeletionTitle,
  createStoryDeletionAudit,
  hasActiveStoryWork,
  storyDeletionBusyError,
  storyNotFoundError,
  type PersistStoryDeletionInput,
  type StoryDeletionResult,
} from "./storyDeletion";

export const dataDirectory = process.env.XUMO_DATA_DIRECTORY?.trim()
  || (process.env.NODE_ENV === "production" ? "/tmp/xumo-data" : path.join(process.cwd(), "server", "data"));
const storePath = path.join(dataDirectory, "store.json");
let persistentStorageAvailable = process.env.XUMO_STORAGE_MODE?.trim().toLowerCase() !== "memory";
let database: PersistenceDatabase | null = null;

function databaseUrl(): string {
  return process.env.DATABASE_URL?.trim() ?? "";
}

export function contextualNarrationReviewEnabled(): boolean {
  return process.env.CONTEXTUAL_NARRATION_REVIEW_ENABLED?.trim().toLowerCase() === "true";
}

export function usesDatabaseStorage(): boolean {
  return database !== null;
}

export function storageBackend(): "postgresql" | "filesystem" | "memory" {
  if (database) return "postgresql";
  return persistentStorageAvailable ? "filesystem" : "memory";
}

export function usesPersistentStorage(): boolean {
  return database !== null || persistentStorageAvailable;
}

function isUnavailableFilesystem(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return ["EACCES", "EPERM", "EROFS", "ENOSYS"].includes(code)
    || (error instanceof Error && /operation not permitted|read-only file system/i.test(error.message));
}

export function createStoreSaveQueue(writeSnapshot: (snapshot: string) => Promise<void>) {
  let queue = Promise.resolve();
  return async (store: AppStore, rollbackOnFailure?: () => void): Promise<void> => {
    // Capture before yielding to the queue. Otherwise a later request can mutate the
    // shared store and leak its uncommitted state into an earlier successful write.
    const snapshot = JSON.stringify(store, null, 2);
    queue = queue.catch(() => undefined).then(async () => {
      try {
        await writeSnapshot(snapshot);
      } catch (error) {
        rollbackOnFailure?.();
        throw error;
      }
    });
    await queue;
  };
}

export function createStoreMutationGate() {
  let tail = Promise.resolve();
  return async (): Promise<() => void> => {
    const predecessor = tail.catch(() => undefined);
    let releaseSlot!: () => void;
    const slot = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    tail = predecessor.then(() => slot);
    await predecessor;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
  };
}

export function shouldSerializeFileStoreRequest(request: { method: string; path: string }): boolean {
  if (!request.path.startsWith("/api/") || request.path === "/api/health") return false;
  const method = request.method.toUpperCase();
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export function shouldAbandonQueuedRequest(
  request: { aborted: boolean; destroyed: boolean },
  response: { writableEnded: boolean },
): boolean {
  // A fully consumed JSON request can be marked destroyed even though the
  // client did not abort. Only the explicit aborted signal is authoritative.
  return request.aborted || response.writableEnded;
}

const enqueueStoreSave = createStoreSaveQueue(async (snapshot) => {
  if (!persistentStorageAvailable) return;
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, snapshot, "utf8");
  await rename(temporaryPath, storePath);
});

export function normalizeStore(store: AppStore): AppStore {
  for (const user of store.users ?? []) {
    user.publicPenName ??= null;
  }

  store.generationFailures ??= [];
  store.generationFailures = store.generationFailures
    .map((failure) => upgradeGenerationFailureObservation(failure))
    .slice(0, 2_000);
  store.safetyDecisions ??= [];
  store.contentReports ??= [];
  store.idempotencyKeys ??= [];
  store.storyCreationRequests ??= [];
  store.jobs ??= [];
  for (const story of store.stories ?? []) {
    story.readingExperience ??= createLegacyExperienceContract({
      tone: story.tone,
      genre: story.genre,
      effectiveFromChapter: story.chapters.length + 1,
      createdAt: story.updatedAt,
    });
    story.readingExperience = normalizeReadingExperienceContract(story.readingExperience);
    story.readingExperienceDeliveryLedger = normalizeReadingExperienceDeliveryLedger(
      story.readingExperience,
      story.readingExperienceDeliveryLedger,
      story.chapters.at(-1)?.number ?? 0,
    );
    story.proposals ??= [];
    story.items ??= [];
    story.constraints ??= [];
    story.worldBible ??= {
      version: 1,
      organizations: [],
      locations: [...new Set((story.characters ?? []).map((character) => character.location).filter(Boolean))],
      abilityBoundaries: (story.rules ?? []).filter((rule) => rule.hardness === "hard").map((rule) => rule.description),
      pointOfView: "近距离第三人称",
      styleParameters: [story.tone],
      sourceRevisionIds: story.chapters.slice(0, 3).map((chapter) => chapter.currentRevisionId),
    };
    story.summaries ??= [
      ...story.chapters.map((chapter) => ({
        id: `summary_${story.id}_chapter_${chapter.number}`,
        branchId: story.activeBranchId,
        layer: "chapter" as const,
        text: `${chapter.title}：${chapter.revisions.find((revision) => revision.id === chapter.currentRevisionId)?.paragraphs.at(-1) ?? ""}`.slice(0, 420),
        fromChapter: chapter.number,
        toChapter: chapter.number,
        sourceRevisionIds: [chapter.currentRevisionId],
        updatedAt: story.updatedAt,
      })),
      { id: `summary_${story.id}_book`, branchId: story.activeBranchId, layer: "book" as const, text: story.summary, fromChapter: 1, toChapter: story.chapters.length, sourceRevisionIds: story.chapters.slice(-12).map((chapter) => chapter.currentRevisionId), updatedAt: story.updatedAt },
    ];
    for (const summary of story.summaries) summary.branchId ??= story.activeBranchId;
    story.branches ??= [{
      id: story.activeBranchId,
      name: "迁移后的主线",
      basedOnBranchId: null,
      baseCanonVersion: 1,
      headCanonVersion: story.canonVersion,
      createdAt: story.updatedAt,
      status: "active",
      chapterRevisionIds: Object.fromEntries(story.chapters.map((chapter) => [chapter.id, chapter.currentRevisionId])),
      baseEventSequence: story.events?.length ?? 0,
    }];
    for (const branch of story.branches) {
      branch.chapterRevisionIds ??= Object.fromEntries(story.chapters.map((chapter) => [chapter.id, chapter.currentRevisionId]));
      branch.baseEventSequence ??= Math.max(0, ...(story.events ?? []).filter((event) => event.branchId === branch.id).map((event) => event.sequence ?? 0));
    }
    story.readingProgress.progressVersion ??= 1;
    story.readingProgress.activeBranchId ??= story.activeBranchId;
    story.readingProgress.canonVersion ??= story.canonVersion;
    story.conversationThreads ??= [{ id: `thread_${story.id}_main`, branchId: story.activeBranchId, summary: null, summaries: [], parentThreadId: null }];
    if (story.conversationThreads.length === 0) story.conversationThreads.push({ id: `thread_${story.id}_main`, branchId: story.activeBranchId, summary: null, summaries: [], parentThreadId: null });
    for (const thread of story.conversationThreads) {
      thread.summaries ??= thread.summary ? [thread.summary] : [];
      thread.parentThreadId ??= null;
      for (const [index, summary] of thread.summaries.entries()) {
        summary.version ??= index + 1;
        summary.parentSummaryId ??= index > 0 ? thread.summaries[index - 1].id : null;
        summary.sourceThreadId ??= thread.id;
      }
      if (thread.summary) {
        thread.summary.version ??= thread.summaries.length || 1;
        thread.summary.parentSummaryId ??= thread.summaries.length > 1 ? thread.summaries.at(-2)?.id ?? null : null;
        thread.summary.sourceThreadId ??= thread.id;
      }
    }
    const defaultThread = story.conversationThreads.find((thread) => thread.branchId === story.activeBranchId) ?? story.conversationThreads[0];
    for (const message of story.conversation ?? []) {
      message.branchId ??= story.activeBranchId;
      message.threadId ??= defaultThread.id;
    }
    for (const character of story.characters ?? []) {
      character.lifecycle ??= /死亡|死去/.test(character.status)
        ? "dead"
        : /失踪/.test(character.status)
          ? "missing"
          : "alive";
      character.knowledgeSources ??= character.knowledge.map((fact) => ({
        fact,
        sourceChapter: 1,
        sourceRevisionId: story.chapters[0]?.currentRevisionId ?? "migration_unknown",
      }));
      character.inventoryItemIds ??= [];
    }
    for (const [index, event] of (story.events ?? []).entries()) {
      event.sequence ??= index + 1;
      if (event.cause === "上一章留下的未解线索") event.cause = "尚未查明的异常痕迹仍在现场";
      if (/^第\s*\d+\s*章产生一条可继续追查的事实$/.test(event.outcome)) event.outcome = "现场新增一条可继续追查的事实";
      event.storyTime ??= `事件序列${event.sequence}·场景1`;
      event.storyTime = event.storyTime.replace(/^第\d+章·场景/, `事件序列${event.sequence}·场景`);
      event.branchId ??= story.activeBranchId;
    }
    for (const chapter of story.chapters ?? []) {
      for (const revision of chapter.revisions ?? []) revision.branchId ??= story.activeBranchId;
    }
    const migratedState = captureCanonState(story);
    for (const branch of story.branches) {
      branch.stateSnapshot ??= structuredClone(migratedState);
      branch.baseStateSnapshot ??= structuredClone(migratedState);
    }
    for (const retcon of story.retcons ?? []) {
      for (const snapshot of retcon.characterSnapshots ?? []) {
        const relationship = story.characters.find((character) => character.id === snapshot.characterId)?.relationship ?? "未记录";
        snapshot.before.relationship ??= relationship;
        snapshot.after.relationship ??= relationship;
      }
    }
  }
  for (const job of store.jobs) {
    const story = store.stories.find((item) => item.id === job.storyId) ?? store.stories.find((item) => item.title === job.storyTitle);
    job.storyId ??= story?.id ?? "story_unknown";
    job.ownerId ??= story?.ownerId ?? "system";
  }
  for (const job of store.jobs.filter((item) => item.status === "failed")) {
    if (store.generationFailures.some((failure) => failure.jobId === job.id && failure.terminal)) continue;
    const observedAt = new Date(Date.parse(job.createdAt) + Math.max(0, job.latencyMs || 0));
    appendGenerationFailure(store, createGenerationFailureObservation(
      job,
      new Error(job.filterSummary || "历史生成作业失败。"),
      {
        id: `failure_backfill_${job.id}`,
        stage: job.task === "opening" ? "开篇生成" : "章节生成",
        terminal: true,
        latencyMs: job.latencyMs,
        tokens: job.tokens,
        now: () => Number.isFinite(observedAt.getTime()) ? observedAt : new Date(job.createdAt),
      },
    ));
  }
  for (const connection of store.connections ?? []) {
    connection.secretVersion ??= connection.secretRef.startsWith("platform://") ? 0 : 1;
    if (connection.capabilities) {
      connection.capabilities.toolCalling ??= false;
      connection.capabilities.maxContextTokens ??= null;
    }
  }
  return store;
}

export async function loadStore(): Promise<AppStore> {
  const connectionString = databaseUrl();
  assertPublicStorySharingPrerequisites();
  const narrationReviewEnabled = contextualNarrationReviewEnabled();
  if (!connectionString && narrationReviewEnabled) {
    throw new Error("CONTEXTUAL_NARRATION_REVIEW_ENABLED requires PostgreSQL DATABASE_URL.");
  }
  // Validate the stable master key at startup instead of discovering a missing or
  // malformed key only after a user's generation has already reached a pause.
  if (narrationReviewEnabled) {
    narrationReviewConfidenceThreshold();
    await loadApplicationEncryptionKey();
  }
  if (connectionString) {
    database = createPostgresDatabase(connectionString);
    const autoMigrate = process.env.DATABASE_AUTO_MIGRATE?.trim().toLowerCase() !== "false";
    if (autoMigrate) await database.migrate();
    if (await database.isEmpty()) {
      let initialStore: AppStore | null = null;
      let legacyFingerprint: string | null = null;
      try {
        const legacyContents = await readFile(storePath);
        legacyFingerprint = createHash("sha256").update(legacyContents).digest("hex");
        initialStore = normalizeStore(JSON.parse(legacyContents.toString("utf8")) as AppStore);
        console.log(`[storage] PostgreSQL 为空，正在无损导入 ${storePath}`);
      } catch (error) {
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
        if (!missing) throw error;
      }
      await database.saveSnapshot(initialStore ?? createSeedStore());
      if (initialStore && legacyFingerprint) {
        const expected = {
          users: initialStore.users.length,
          stories: initialStore.stories.length,
          chapters: initialStore.stories.reduce((total, story) => total + story.chapters.length, 0),
          revisions: initialStore.stories.reduce(
            (total, story) => total + story.chapters.reduce((chapterTotal, chapter) => chapterTotal + chapter.revisions.length, 0),
            0,
          ),
        };
        const actual = await database.counts();
        for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
          if (actual[key] < expected[key]) {
            throw new Error(`旧 JSON 自动导入校验失败：${key} 期望至少 ${expected[key]}，数据库只有 ${actual[key]}。`);
          }
        }
        await database.recordLegacyImport(legacyFingerprint, storePath, expected);
      }
    }
    return normalizeStore(await database.loadRuntimeStore());
  }
  const allowsEphemeralProduction = process.env.XUMO_ALLOW_EPHEMERAL_PRODUCTION?.trim().toLowerCase() === "true";
  if (process.env.NODE_ENV === "production" && !allowsEphemeralProduction) {
    throw new Error(
      "生产环境必须配置 DATABASE_URL，拒绝把真实账号和故事写入临时 JSON；纯演示环境可显式设置 XUMO_ALLOW_EPHEMERAL_PRODUCTION=true。",
    );
  }
  if (!persistentStorageAvailable) return createSeedStore();
  try {
    await mkdir(dataDirectory, { recursive: true });
    const contents = await readFile(storePath, "utf8");
    return normalizeStore(JSON.parse(contents) as AppStore);
  } catch (error) {
    if (isUnavailableFilesystem(error)) {
      persistentStorageAvailable = false;
      return createSeedStore();
    }
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) {
      throw error;
    }
    const store = createSeedStore();
    await saveStore(store);
    return store;
  }
}

export async function saveStore(store: AppStore, rollbackOnFailure?: () => void): Promise<void> {
  if (database) {
    await database.saveSnapshot(store, rollbackOnFailure);
    return;
  }
  await enqueueStoreSave(store, rollbackOnFailure);
}

type StoryDeletionCommand = Pick<
  PersistStoryDeletionInput,
  "ownerId" | "storyId" | "confirmationTitle"
>;

interface StoryDeletionStorageDependencies {
  getDatabase(): PersistenceDatabase | null;
  save(store: AppStore, rollbackOnFailure?: () => void): Promise<void>;
  now(): string;
  createAuditId(): string;
}

export function createStoryDeletionStorage(dependencies: StoryDeletionStorageDependencies) {
  return async (
    store: AppStore,
    input: StoryDeletionCommand,
  ): Promise<StoryDeletionResult> => {
    const persistence = dependencies.getDatabase();
    const persistenceInput: PersistStoryDeletionInput = {
      ...input,
      auditId: dependencies.createAuditId(),
      deletedAt: dependencies.now(),
    };

    if (persistence) {
      // The transaction owns the authoritative title and job state. Runtime data can
      // be stale after another process committed, so it must never veto PostgreSQL.
      const result = await persistence.deleteOwnedStory(persistenceInput);
      applyStoryDeletionToStore(
        store,
        input.ownerId,
        input.storyId,
        createStoryDeletionAudit(
          input.ownerId,
          persistenceInput.auditId,
          persistenceInput.deletedAt,
          result,
        ),
      );
      return result;
    }

    const story = store.stories.find(
      (candidate) => candidate.id === input.storyId && candidate.ownerId === input.ownerId,
    );
    if (!story) throw storyNotFoundError();
    assertStoryDeletionTitle(story.title, input.confirmationTitle);
    if (hasActiveStoryWork(store, input.storyId)) throw storyDeletionBusyError();

    const owner = store.users.find((user) => user.id === input.ownerId);
    const result: StoryDeletionResult = {
      wasCurrentStory: owner?.activeStoryId === input.storyId,
      wasPublished: false,
      hadChapters: story.chapters.length > 0,
    };
    const stagedStore = structuredClone(store);
    applyStoryDeletionToStore(
      stagedStore,
      input.ownerId,
      input.storyId,
      createStoryDeletionAudit(input.ownerId, persistenceInput.auditId, persistenceInput.deletedAt, result),
    );
    await dependencies.save(stagedStore);
    Object.assign(store, stagedStore);
    return result;
  };
}

export const deleteOwnedStory = createStoryDeletionStorage({
  getDatabase: () => database,
  save: saveStore,
  now: () => new Date().toISOString(),
  createAuditId: () => `audit_${randomUUID().slice(0, 10)}`,
});

export async function loadLegacyStoreFromFile(filePath: string): Promise<AppStore> {
  const contents = await readFile(filePath, "utf8");
  return normalizeStore(JSON.parse(contents) as AppStore);
}

export function cacheUserForRuntime(
  store: AppStore,
  user: UserAccount,
  isStoryDeleted: (storyId: string) => boolean = (storyId) => database?.isStoryDeleted(storyId) ?? false,
): UserAccount {
  const safeUser = user.activeStoryId && isStoryDeleted(user.activeStoryId)
    ? { ...user, activeStoryId: null }
    : user;
  const index = store.users.findIndex((item) => item.id === safeUser.id);
  if (index >= 0) store.users[index] = safeUser;
  else store.users.push(safeUser);
  return safeUser;
}

export async function findUserByEmail(store: AppStore, email: string): Promise<UserAccount | null> {
  if (database) {
    const user = await database.findUserByEmail(email);
    return user ? cacheUserForRuntime(store, user) : null;
  }
  return store.users.find((item) => item.email.toLowerCase() === email.trim().toLowerCase()) ?? null;
}

export async function findUserBySessionTokenHash(store: AppStore, hash: string): Promise<UserAccount | null> {
  if (database) {
    const user = await database.findUserBySessionTokenHash(hash);
    return user ? cacheUserForRuntime(store, user) : null;
  }
  const session = store.sessions.find((item) => item.tokenHash === hash && Date.parse(item.expiresAt) > Date.now());
  return session ? store.users.find((item) => item.id === session.userId) ?? null : null;
}

export async function registerUser(
  store: AppStore,
  user: UserAccount,
  session: AuthSession,
  event: AuditEvent,
): Promise<void> {
  if (database) {
    await database.register(user, session, event);
    cacheUserForRuntime(store, user);
    store.auditEvents.unshift(event);
    store.auditEvents = store.auditEvents.slice(0, 500);
    return;
  }
  if (store.users.some((item) => item.email.trim().toLowerCase() === user.email.trim().toLowerCase())) {
    throw Object.assign(new Error("该邮箱已经注册，请直接登录。"), { status: 409 });
  }
  store.users.push(user);
  store.sessions.push(session);
  store.auditEvents.unshift(event);
  store.auditEvents = store.auditEvents.slice(0, 500);
  await saveStore(store, () => {
    store.users = store.users.filter((item) => item.id !== user.id);
    store.sessions = store.sessions.filter((item) => item.id !== session.id);
    store.auditEvents = store.auditEvents.filter((item) => item.id !== event.id);
  });
}

export async function saveAuthSession(store: AppStore, session: AuthSession): Promise<void> {
  const existing = store.sessions.findIndex((item) => item.id === session.id);
  if (existing >= 0) store.sessions[existing] = session;
  else store.sessions.push(session);
  if (database) await database.saveSession(session);
}

export async function deleteAuthSession(store: AppStore, hash: string): Promise<void> {
  store.sessions = store.sessions.filter((session) => session.tokenHash !== hash);
  if (database) await database.deleteSession(hash);
}

export async function reserveStoredIdempotencyKey(
  store: AppStore,
  userId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const scopedKey = `${userId}:${idempotencyKey}`;
  if (database) {
    const reserved = await database.reserveIdempotencyKey(userId, idempotencyKey);
    if (reserved && !store.idempotencyKeys.includes(scopedKey)) store.idempotencyKeys.push(scopedKey);
    return reserved;
  }
  if (store.idempotencyKeys.includes(scopedKey)) return false;
  store.idempotencyKeys.push(scopedKey);
  store.idempotencyKeys = store.idempotencyKeys.slice(-500);
  return true;
}

export async function hasStoredIdempotencyKey(
  store: AppStore,
  userId: string,
  idempotencyKey: string,
): Promise<boolean> {
  if (database) return database.hasIdempotencyKey(userId, idempotencyKey);
  return store.idempotencyKeys.includes(`${userId}:${idempotencyKey}`);
}

export async function releaseStoredIdempotencyKey(
  store: AppStore,
  userId: string,
  idempotencyKey: string,
): Promise<void> {
  const scopedKey = `${userId}:${idempotencyKey}`;
  store.idempotencyKeys = store.idempotencyKeys.filter((key) => key !== scopedKey);
  if (database) await database.releaseIdempotencyKey(userId, idempotencyKey);
}

export async function findStoredStoryCreationRequest(
  store: AppStore,
  userId: string,
  idempotencyKey: string,
): Promise<string | null> {
  if (database) return database.findStoryCreationRequest(userId, idempotencyKey);
  return store.storyCreationRequests.find((request) =>
    request.userId === userId && request.idempotencyKey === idempotencyKey,
  )?.storyId ?? null;
}


export async function findStoredGenerationJob(
  store: AppStore,
  userId: string,
  idempotencyKey: string,
): Promise<GenerationJob | null> {
  const cached = store.jobs.find((job) =>
    job.ownerId === userId && job.idempotencyKey === idempotencyKey
  );
  if (cached) return cached;
  if (!database) return null;
  return database.findGenerationJobByIdempotencyKey(userId, idempotencyKey);
}

function encodeLegacyCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString("base64url");
}

function decodeLegacyCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.updatedAt !== "string" || typeof value.id !== "string") throw new Error("invalid");
    return { updatedAt: value.updatedAt, id: value.id };
  } catch {
    throw Object.assign(new Error("书架分页游标无效，请重新加载。"), { status: 400 });
  }
}

export async function listStoryPage(
  store: AppStore,
  ownerId: string,
  limit = 24,
  cursor?: string,
): Promise<StoryPage> {
  if (database) return database.listStories(ownerId, limit, cursor);
  const all = store.stories
    .filter((story) => story.ownerId === ownerId && story.status !== "archived")
    .map(summarizeStory)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id));
  const position = cursor ? decodeLegacyCursor(cursor) : null;
  const start = position
    ? all.findIndex((story) => story.updatedAt < position.updatedAt || (story.updatedAt === position.updatedAt && story.id < position.id))
    : 0;
  const safeStart = start < 0 ? all.length : start;
  const safeLimit = Math.max(1, Math.min(100, limit));
  const stories = all.slice(safeStart, safeStart + safeLimit);
  const last = stories.at(-1);
  return {
    stories,
    nextCursor: safeStart + stories.length < all.length && last ? encodeLegacyCursor(last.updatedAt, last.id) : null,
    totalStories: all.length,
    totalChapters: all.reduce((total, story) => total + story.chapterCount, 0),
  };
}

export async function listGenerationFailurePatterns(
  store: AppStore,
  limit = 30,
) {
  const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
  if (database) return database.listGenerationFailurePatterns(safeLimit);
  return summarizeGenerationFailures(store.generationFailures, store.jobs).slice(0, safeLimit);
}

export async function listNarrationReviewMetrics(
  limit = 30,
): Promise<NarrationReviewMetricBucket[]> {
  if (!database) return [];
  const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
  try {
    return await database.listNarrationReviewMetrics(safeLimit);
  } catch (error) {
    console.error("[NARRATION-REVIEW] Failed to aggregate structured metrics.", error);
    return [];
  }
}

export async function loadOwnedStory(store: AppStore, ownerId: string, storyId: string): Promise<Story | null> {
  // Tombstones, including uncertain commit outcomes, must bypass runtime cache.
  // Postgres resolves uncertainty authoritatively before returning.
  if (database?.isStoryDeleted(storyId)) return database.loadStory(ownerId, storyId);
  const cached = store.stories.find((story) => story.id === storyId && story.ownerId === ownerId);
  if (cached) return cached;
  if (!database) return null;
  return database.loadStory(ownerId, storyId);
}

export async function deletePersistedModelConnection(connectionId: string): Promise<void> {
  if (database) await database.deleteModelConnection(connectionId);
}

export async function clearPersistedStoryModelConnection(connectionId: string): Promise<void> {
  if (database) await database.clearStoryModelConnection(connectionId);
}

export async function checkStorageHealth(): Promise<void> {
  if (database) await database.health();
}

export function requirePublicStorySharingModule(): PublicStorySharingModule {
  if (!publicStorySharingEnabled() || !database) {
    throw createPublicStorySharingDisabledError();
  }
  return database.publicStorySharing;
}

export function supportsDurableNarrationReview(): boolean {
  return database !== null;
}

function requireNarrationReviewDatabase(): PersistenceDatabase {
  if (!database) {
    throw Object.assign(new Error("Narration review state requires PostgreSQL persistence."), {
      code: "narration_review_state_unavailable",
    });
  }
  return database;
}

export async function pauseOpeningForNarrationReview(
  job: GenerationJob,
  review: NarrationReviewCaseRecord,
): Promise<void> {
  await requireNarrationReviewDatabase().pauseOpeningForNarrationReview(job, review);
}

export async function getNarrationReviewCaseForOwner(
  ownerId: string,
  jobId: string,
): Promise<NarrationReviewCaseRecord | null> {
  return requireNarrationReviewDatabase().getNarrationReviewCaseForOwner(ownerId, jobId);
}

export async function getNarrationReviewCaseById(
  id: string,
): Promise<NarrationReviewCaseRecord | null> {
  return requireNarrationReviewDatabase().getNarrationReviewCaseById(id);
}

export async function claimNarrationReviewDecision(
  claim: NarrationReviewDecisionClaim,
): Promise<NarrationReviewCaseRecord | null> {
  return requireNarrationReviewDatabase().claimNarrationReviewDecision(claim);
}

export async function claimExpiredNarrationReviews(
  now: string,
  limit: number,
): Promise<NarrationReviewCaseRecord[]> {
  return requireNarrationReviewDatabase().claimExpiredNarrationReviews(now, limit);
}

export async function listRecoverableNarrationReviews(
  limit?: number,
): Promise<NarrationReviewCaseRecord[]> {
  return requireNarrationReviewDatabase().listRecoverableNarrationReviews(limit);
}

export async function replaceNarrationReviewCase(
  oldCaseId: string,
  job: GenerationJob,
  review: NarrationReviewCaseRecord,
  resolvedAt: string,
): Promise<boolean> {
  return requireNarrationReviewDatabase().replaceNarrationReviewCase(
    oldCaseId,
    job,
    review,
    resolvedAt,
  );
}

export async function resolveNarrationReviewCase(
  id: string,
  finalStatus: "resolved" | "failed",
  resolvedAt: string,
): Promise<boolean> {
  return requireNarrationReviewDatabase().resolveNarrationReviewCase(id, finalStatus, resolvedAt);
}

export async function failExpiredNarrationReviewCase(id: string, now: string): Promise<boolean> {
  return requireNarrationReviewDatabase().failExpiredNarrationReviewCase(id, now);
}

export async function upsertNarrationReviewFeedback(
  feedback: NarrationReviewFeedbackRecord,
): Promise<void> {
  await requireNarrationReviewDatabase().upsertNarrationReviewFeedback(feedback);
}

export async function deleteExpiredNarrationReviewData(
  now: string,
): Promise<NarrationReviewCleanupCounts> {
  return requireNarrationReviewDatabase().deleteExpiredNarrationReviewData(now);
}
