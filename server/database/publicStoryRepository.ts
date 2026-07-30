import { createHash } from "node:crypto";
import type {
  OwnerPublicationState,
  PublicationModerationInput,
  PublicationModerationOverview,
  PublicationModerationSummary,
  PublicProfile,
  PublicReadingProgress,
  PublicStoryChapter,
  PublicStoryDetail,
  PublicStoryPage,
  PublicStoryQuery,
  PublicStoryReportTarget,
  PublicStorySummary,
  SavePublicReadingProgressInput,
  StoryPublicationStatus,
  StoryStatus,
  UserAccount,
} from "../../src/types";
import {
  assertStoryPublishable,
  createInvalidPublicStoryCursorError,
  createProgressConflictError,
  createPublicStoryUnavailableError,
  createStoryOwnershipError,
  nextOwnerPublicationStatus,
  normalizePublicPenName,
  ownerPublicationState,
  type OwnerPublicationStatus,
  type PublicStorySharingPersistence,
} from "../publicStorySharing";
import type { DatabaseExecutor, PublicStoryReadRepository } from "./types";

interface PublicStorySummaryRow {
  id: string;
  title: string;
  subtitle: string;
  genre: string;
  tone: string;
  length_label: string;
  cover_theme: PublicStorySummary["coverTheme"];
  status: PublicStorySummary["status"];
  author_pen_name: string;
  chapter_count: number;
  current_chapter_number: number;
  current_chapter_title: string;
  latest_excerpt: string;
  updated_at: Date | string;
}

interface PublicStoryDetailRow extends PublicStorySummaryRow {
  viewer_is_owner: boolean;
}

interface PublicChapterRow {
  id: string;
  chapter_number: number;
  title: string;
  estimated_minutes: number;
  revision_id: string;
  revision_title: string;
  revision_paragraphs: unknown;
  revision_created_at: Date | string;
}

interface PublicProgressRow {
  story_id: string;
  chapter_id: string;
  chapter_number: number;
  scroll_progress: number;
  progress_version: number;
  updated_at: Date | string;
}

interface OwnerStoryRow {
  story_id: string;
  owner_id: string;
  story_status: StoryStatus;
  chapter_count: number;
  public_pen_name: string | null;
}

interface OwnerPublicationRow {
  story_id: string;
  owner_id: string;
  story_status: StoryStatus;
  chapter_count: number;
  public_pen_name: string | null;
  publication_status: StoryPublicationStatus | null;
  first_published_at: Date | string | null;
  status_updated_at: Date | string | null;
  admin_reason: string | null;
}

interface PublicationRecordRow {
  story_id: string;
  status: StoryPublicationStatus;
  first_published_at: Date | string;
  status_updated_at: Date | string;
}

interface ModerationRow {
  story_id: string;
  story_status: StoryStatus;
  title: string;
  author_pen_name: string;
  status: StoryPublicationStatus;
  first_published_at: Date | string;
  status_updated_at: Date | string;
  admin_reason: string | null;
}

interface ModerationCountsRow {
  total: number | string;
  active: number | string;
  author_unpublished: number | string;
  admin_suspended: number | string;
}

interface PublicStoryCursor {
  updatedAt: string;
  storyId: string;
  filterHash: string;
}

interface NormalizedPublicStoryQuery {
  query: string;
  genre: PublicStoryQuery["genre"] | null;
  limit: number;
  filterHash: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseParagraphs(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) && parsed.every((paragraph) => typeof paragraph === "string")
    ? parsed
    : [];
}

function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function publicFilterHash(query: string, genre: PublicStoryQuery["genre"] | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ query: query.toLowerCase(), genre }))
    .digest("hex");
}

function normalizeQuery(query: PublicStoryQuery): NormalizedPublicStoryQuery {
  const normalizedSearch = truncateCodePoints(query.query?.trim() ?? "", 100);
  const genre = query.genre ?? null;
  const requestedLimit = Number.isFinite(query.limit) ? Math.round(query.limit as number) : 24;
  return {
    query: normalizedSearch,
    genre,
    limit: Math.max(1, Math.min(48, requestedLimit)),
    filterHash: publicFilterHash(normalizedSearch, genre),
  };
}

function encodeCursor(cursor: PublicStoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, expectedFilterHash: string): PublicStoryCursor {
  try {
    if (!cursor || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error("invalid cursor encoding");
    }
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof value.updatedAt !== "string"
      || !Number.isFinite(Date.parse(value.updatedAt))
      || typeof value.storyId !== "string"
      || value.storyId.length === 0
      || typeof value.filterHash !== "string"
      || !/^[a-f0-9]{64}$/.test(value.filterHash)
      || value.filterHash !== expectedFilterHash
    ) {
      throw new Error("invalid cursor payload");
    }
    return {
      updatedAt: value.updatedAt,
      storyId: value.storyId,
      filterHash: value.filterHash,
    };
  } catch {
    throw createInvalidPublicStoryCursorError();
  }
}

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function summaryFromRow(row: PublicStorySummaryRow): PublicStorySummary {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    genre: row.genre,
    tone: row.tone,
    length: row.length_label,
    coverTheme: row.cover_theme,
    status: row.status,
    authorPenName: row.author_pen_name,
    chapterCount: row.chapter_count,
    currentChapterNumber: row.current_chapter_number,
    currentChapterTitle: row.current_chapter_title,
    latestExcerpt: row.latest_excerpt,
    updatedAt: iso(row.updated_at),
  };
}

function chapterFromRow(row: PublicChapterRow): PublicStoryChapter {
  return {
    id: row.id,
    number: row.chapter_number,
    title: row.title,
    estimatedMinutes: row.estimated_minutes,
    currentRevision: {
      id: row.revision_id,
      title: row.revision_title,
      paragraphs: parseParagraphs(row.revision_paragraphs),
      createdAt: iso(row.revision_created_at),
    },
  };
}

function progressFromRow(row: PublicProgressRow): PublicReadingProgress {
  return {
    storyId: row.story_id,
    chapterId: row.chapter_id,
    chapterNumber: row.chapter_number,
    scrollProgress: row.scroll_progress,
    progressVersion: row.progress_version,
    updatedAt: iso(row.updated_at),
  };
}

function resolveReadingProgress(
  row: PublicProgressRow | undefined,
  chapters: PublicStoryChapter[],
): PublicReadingProgress | null {
  if (!row) return null;
  const progress = progressFromRow(row);
  const exact = chapters.find((chapter) => chapter.id === progress.chapterId);
  if (exact) {
    return {
      ...progress,
      chapterNumber: exact.number,
    };
  }
  const fallback = chapters
    .filter((chapter) => chapter.number <= progress.chapterNumber)
    .at(-1) ?? chapters[0];
  if (!fallback) return null;
  return {
    ...progress,
    chapterId: fallback.id,
    chapterNumber: fallback.number,
    scrollProgress: 0,
  };
}

function publicationStateFromRow(row: {
  story_id: string;
  status: StoryPublicationStatus;
  first_published_at: Date | string;
  status_updated_at: Date | string;
}): OwnerPublicationState {
  return ownerPublicationState(
    row.story_id,
    row.status,
    iso(row.first_published_at),
    iso(row.status_updated_at),
  );
}

function moderationFromRow(row: ModerationRow): PublicationModerationSummary {
  return {
    storyId: row.story_id,
    title: row.title,
    authorPenName: row.author_pen_name,
    status: row.status,
    firstPublishedAt: iso(row.first_published_at),
    statusUpdatedAt: iso(row.status_updated_at),
    adminReason: row.admin_reason,
  };
}

const invalidModerationReasonCharacter = /[\p{Cc}\p{Zl}\p{Zp}]/u;

function normalizeModerationReason(value: string | undefined): string {
  const reason = value?.trim() ?? "";
  const length = Array.from(reason).length;
  if (length < 1 || length > 120 || invalidModerationReasonCharacter.test(reason)) {
    throw Object.assign(new Error("下架原因需为 1 至 120 个单行字符。"), { status: 422 as const });
  }
  return reason;
}

function invalidProgressInputError(): Error & { status: 422; code: "invalid_public_progress" } {
  return Object.assign(
    new Error("阅读进度参数无效。"),
    { status: 422 as const, code: "invalid_public_progress" as const },
  );
}

function adminForbiddenError(): Error & { status: 403 } {
  return Object.assign(new Error("只有管理员可以执行该操作。"), { status: 403 as const });
}

export class PublicStoryPostgresRepository
  implements PublicStoryReadRepository, PublicStorySharingPersistence {
  constructor(private readonly executor: DatabaseExecutor) {}

  async getOwnerPublication(ownerId: string, storyId: string): Promise<OwnerPublicationState> {
    const result = await this.executor.query<OwnerPublicationRow>(
      `SELECT
         s.id AS story_id,
         s.owner_id,
         s.status AS story_status,
         s.chapter_count,
         u.public_pen_name,
         p.status AS publication_status,
         p.first_published_at,
         p.status_updated_at,
         p.admin_reason
       FROM xumo_stories s
       JOIN xumo_users u ON u.id = s.owner_id
       LEFT JOIN xumo_story_publications p
         ON p.story_id = s.id
        AND p.owner_id = s.owner_id
       WHERE s.id = $1 AND s.owner_id = $2`,
      [storyId, ownerId],
    );
    const row = result.rows[0];
    if (!row) throw createStoryOwnershipError();
    if (!row.publication_status || !row.first_published_at || !row.status_updated_at) {
      return ownerPublicationState(storyId, "private");
    }
    return ownerPublicationState(
      storyId,
      row.publication_status,
      iso(row.first_published_at),
      iso(row.status_updated_at),
      row.admin_reason,
    );
  }

  async setOwnerPublication(
    actor: Pick<UserAccount, "id" | "role" | "publicPenName">,
    storyId: string,
    input: { published: boolean; publicPenName?: string },
  ): Promise<OwnerPublicationState> {
    return this.executor.transaction(async (transaction) => {
      const lockedStory = await transaction.query<OwnerStoryRow>(
        `SELECT
           s.id AS story_id,
           s.owner_id,
           s.status AS story_status,
           s.chapter_count,
           u.public_pen_name
         FROM xumo_stories s
         JOIN xumo_users u ON u.id = s.owner_id
         WHERE s.id = $1
         FOR UPDATE OF s, u`,
        [storyId],
      );
      const row = lockedStory.rows[0];
      if (!row || row.owner_id !== actor.id) throw createStoryOwnershipError();
      const lockedPublication = await transaction.query<PublicationRecordRow>(
        `SELECT story_id, status, first_published_at, status_updated_at
         FROM xumo_story_publications
         WHERE story_id = $1
         FOR UPDATE`,
        [storyId],
      );
      const currentPublication = lockedPublication.rows[0];

      const currentStatus: OwnerPublicationStatus = currentPublication?.status ?? "private";
      const nextStatus = nextOwnerPublicationStatus(currentStatus, input.published);
      if (input.published) {
        assertStoryPublishable({ status: row.story_status, chapterCount: row.chapter_count });
      }

      const submittedPenName = input.publicPenName === undefined
        ? undefined
        : normalizePublicPenName(input.publicPenName);
      const effectivePenName = submittedPenName ?? row.public_pen_name;
      if (input.published && !effectivePenName) normalizePublicPenName("");

      if (submittedPenName !== undefined && submittedPenName !== row.public_pen_name) {
        await transaction.query(
          "UPDATE xumo_users SET public_pen_name = $2, updated_at = now() WHERE id = $1",
          [actor.id, submittedPenName],
        );
      }

      if (nextStatus === "private") return ownerPublicationState(storyId, "private");
      if (
        nextStatus === currentStatus
        && currentPublication
      ) {
        return ownerPublicationState(
          storyId,
          nextStatus,
          iso(currentPublication.first_published_at),
          iso(currentPublication.status_updated_at),
        );
      }

      let publication: PublicationRecordRow | undefined;
      if (!currentPublication) {
        const inserted = await transaction.query<PublicationRecordRow>(
          `INSERT INTO xumo_story_publications(
             story_id,
             owner_id,
             status,
             first_published_at,
             status_updated_at,
             admin_actor_user_id,
             admin_reason
           ) VALUES ($1, $2, $3, now(), now(), NULL, NULL)
           RETURNING story_id, status, first_published_at, status_updated_at`,
          [storyId, actor.id, nextStatus],
        );
        publication = inserted.rows[0];
      } else {
        const updated = await transaction.query<PublicationRecordRow>(
          `UPDATE xumo_story_publications
           SET status = $2,
               status_updated_at = now(),
               admin_actor_user_id = NULL,
               admin_reason = NULL
           WHERE story_id = $1
           RETURNING story_id, status, first_published_at, status_updated_at`,
          [storyId, nextStatus],
        );
        publication = updated.rows[0];
      }
      if (!publication) throw new Error("发布状态提交失败。");
      return publicationStateFromRow(publication);
    });
  }

  async updatePublicProfile(userId: string, publicPenName: string): Promise<PublicProfile> {
    const normalized = normalizePublicPenName(publicPenName);
    const result = await this.executor.query<{ public_pen_name: string }>(
      `UPDATE xumo_users
       SET public_pen_name = $2, updated_at = now()
       WHERE id = $1
       RETURNING public_pen_name`,
      [userId, normalized],
    );
    const row = result.rows[0];
    if (!row) throw createStoryOwnershipError();
    return { publicPenName: row.public_pen_name };
  }

  async list(query: PublicStoryQuery): Promise<PublicStoryPage> {
    const normalized = normalizeQuery(query);
    const cursor = query.cursor ? decodeCursor(query.cursor, normalized.filterHash) : null;
    const parameters: unknown[] = [];
    const conditions = [
      "p.status = 'active'",
      "s.status <> 'archived'",
      "s.chapter_count > 0",
      "u.public_pen_name IS NOT NULL",
    ];

    if (normalized.query) {
      parameters.push(`%${escapeLikeLiteral(normalized.query)}%`);
      conditions.push(
        `(s.title ILIKE $${parameters.length} ESCAPE E'\\\\'
          OR u.public_pen_name ILIKE $${parameters.length} ESCAPE E'\\\\')`,
      );
    }
    if (normalized.genre) {
      parameters.push(normalized.genre);
      conditions.push(`s.genre = $${parameters.length}`);
    }
    if (cursor) {
      parameters.push(cursor.updatedAt, cursor.storyId);
      conditions.push(
        `(s.updated_at, s.id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::text)`,
      );
    }
    parameters.push(normalized.limit + 1);

    const result = await this.executor.query<PublicStorySummaryRow>(
      `SELECT
         s.id,
         s.title,
         s.subtitle,
         s.genre,
         s.tone,
         s.length_label,
         s.cover_theme,
         s.status,
         u.public_pen_name AS author_pen_name,
         s.chapter_count,
         s.current_chapter_number,
         s.current_chapter_title,
         s.latest_excerpt,
         s.updated_at
       FROM xumo_story_publications p
       JOIN xumo_stories s
         ON s.id = p.story_id
        AND s.owner_id = p.owner_id
       JOIN xumo_users u
         ON u.id = p.owner_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT $${parameters.length}`,
      parameters,
    );

    const hasMore = result.rows.length > normalized.limit;
    const visibleRows = result.rows.slice(0, normalized.limit);
    const last = visibleRows.at(-1);
    return {
      stories: visibleRows.map(summaryFromRow),
      nextCursor: hasMore && last
        ? encodeCursor({
            updatedAt: iso(last.updated_at),
            storyId: last.id,
            filterHash: normalized.filterHash,
          })
        : null,
    };
  }

  async read(viewerId: string, storyId: string): Promise<PublicStoryDetail | null> {
    const summaryResult = await this.executor.query<PublicStoryDetailRow>(
      `SELECT
         s.id,
         s.title,
         s.subtitle,
         s.genre,
         s.tone,
         s.length_label,
         s.cover_theme,
         s.status,
         u.public_pen_name AS author_pen_name,
         s.chapter_count,
         s.current_chapter_number,
         s.current_chapter_title,
         s.latest_excerpt,
         s.updated_at,
         (p.owner_id = $2::text) AS viewer_is_owner
       FROM xumo_story_publications p
       JOIN xumo_stories s
         ON s.id = p.story_id
        AND s.owner_id = p.owner_id
       JOIN xumo_users u
         ON u.id = p.owner_id
       WHERE p.story_id = $1
         AND p.status = 'active'
         AND s.status <> 'archived'
         AND s.chapter_count > 0
         AND u.public_pen_name IS NOT NULL`,
      [storyId, viewerId],
    );
    const summaryRow = summaryResult.rows[0];
    if (!summaryRow) return null;

    const [chapterResult, progressResult] = await Promise.all([
      this.executor.query<PublicChapterRow>(
        `SELECT
           c.id,
           c.chapter_number,
           c.title,
           c.estimated_minutes,
           r.id AS revision_id,
           r.title AS revision_title,
           r.paragraphs AS revision_paragraphs,
           r.created_at AS revision_created_at
         FROM xumo_story_publications p
         JOIN xumo_stories s
           ON s.id = p.story_id
          AND s.owner_id = p.owner_id
         JOIN xumo_chapters c
           ON c.story_id = s.id
         JOIN xumo_chapter_revisions r
           ON r.id = c.current_revision_id
          AND r.chapter_id = c.id
          AND r.story_id = s.id
         WHERE p.story_id = $1
           AND p.status = 'active'
           AND s.status <> 'archived'
         ORDER BY c.chapter_number ASC`,
        [storyId],
      ),
      this.executor.query<PublicProgressRow>(
        `SELECT
           story_id,
           chapter_id,
           chapter_number,
           scroll_progress,
           progress_version,
           updated_at
         FROM xumo_public_reading_progress
         WHERE reader_user_id = $1 AND story_id = $2`,
        [viewerId, storyId],
      ),
    ]);
    if (chapterResult.rows.length === 0) return null;

    const chapters = chapterResult.rows.map(chapterFromRow);
    return {
      ...summaryFromRow(summaryRow),
      chapters,
      readingProgress: resolveReadingProgress(progressResult.rows[0], chapters),
      viewerIsOwner: summaryRow.viewer_is_owner,
    };
  }

  async saveProgress(
    viewerId: string,
    storyId: string,
    input: SavePublicReadingProgressInput,
  ): Promise<PublicReadingProgress> {
    if (
      !input.chapterId.trim()
      || !Number.isFinite(input.scrollProgress)
      || input.scrollProgress < 0
      || input.scrollProgress > 1
      || !Number.isInteger(input.expectedVersion)
      || input.expectedVersion < 0
    ) {
      throw invalidProgressInputError();
    }

    return this.executor.transaction(async (transaction) => {
      const chapter = await transaction.query<{ chapter_number: number }>(
        `SELECT c.chapter_number
         FROM xumo_stories s
         JOIN xumo_story_publications p
           ON p.story_id = s.id
          AND p.owner_id = s.owner_id
         JOIN xumo_chapters c
           ON c.story_id = s.id
         JOIN xumo_chapter_revisions r
           ON r.id = c.current_revision_id
          AND r.chapter_id = c.id
          AND r.story_id = s.id
         WHERE p.story_id = $1
           AND p.status = 'active'
           AND s.status <> 'archived'
           AND c.id = $2
         FOR UPDATE OF s, p, c`,
        [storyId, input.chapterId],
      );
      const chapterRow = chapter.rows[0];
      if (!chapterRow) throw createPublicStoryUnavailableError();

      let saved: PublicProgressRow | undefined;
      if (input.expectedVersion === 0) {
        const inserted = await transaction.query<PublicProgressRow>(
          `INSERT INTO xumo_public_reading_progress(
             reader_user_id,
             story_id,
             chapter_id,
             chapter_number,
             scroll_progress,
             progress_version,
             updated_at
           ) VALUES ($1, $2, $3, $4, $5, 1, now())
           ON CONFLICT (reader_user_id, story_id) DO NOTHING
           RETURNING story_id, chapter_id, chapter_number, scroll_progress, progress_version, updated_at`,
          [viewerId, storyId, input.chapterId, chapterRow.chapter_number, input.scrollProgress],
        );
        saved = inserted.rows[0];
      } else {
        const updated = await transaction.query<PublicProgressRow>(
          `UPDATE xumo_public_reading_progress
           SET chapter_id = $3,
               chapter_number = $4,
               scroll_progress = $5,
               progress_version = progress_version + 1,
               updated_at = now()
           WHERE reader_user_id = $1
             AND story_id = $2
             AND progress_version = $6
           RETURNING story_id, chapter_id, chapter_number, scroll_progress, progress_version, updated_at`,
          [
            viewerId,
            storyId,
            input.chapterId,
            chapterRow.chapter_number,
            input.scrollProgress,
            input.expectedVersion,
          ],
        );
        saved = updated.rows[0];
      }
      if (saved) return progressFromRow(saved);

      const latest = await transaction.query<PublicProgressRow>(
        `SELECT story_id, chapter_id, chapter_number, scroll_progress, progress_version, updated_at
         FROM xumo_public_reading_progress
         WHERE reader_user_id = $1 AND story_id = $2`,
        [viewerId, storyId],
      );
      throw createProgressConflictError(latest.rows[0] ? progressFromRow(latest.rows[0]) : null);
    });
  }

  async findReportTarget(
    storyId: string,
    chapterId: string,
  ): Promise<PublicStoryReportTarget | null> {
    const result = await this.executor.query<{
      story_id: string;
      chapter_id: string;
      revision_id: string;
    }>(
      `SELECT s.id AS story_id, c.id AS chapter_id, r.id AS revision_id
       FROM xumo_story_publications p
       JOIN xumo_stories s
         ON s.id = p.story_id
        AND s.owner_id = p.owner_id
       JOIN xumo_chapters c
         ON c.story_id = s.id
       JOIN xumo_chapter_revisions r
         ON r.id = c.current_revision_id
        AND r.chapter_id = c.id
        AND r.story_id = s.id
       WHERE p.story_id = $1
         AND p.status = 'active'
         AND s.status <> 'archived'
         AND c.id = $2`,
      [storyId, chapterId],
    );
    const row = result.rows[0];
    return row
      ? { storyId: row.story_id, chapterId: row.chapter_id, revisionId: row.revision_id }
      : null;
  }

  async moderate(
    adminUserId: string,
    storyId: string,
    input: PublicationModerationInput,
  ): Promise<PublicationModerationSummary> {
    return this.executor.transaction(async (transaction) => {
      const admin = await transaction.query<{ role: UserAccount["role"] }>(
        "SELECT role FROM xumo_users WHERE id = $1",
        [adminUserId],
      );
      if (admin.rows[0]?.role !== "admin") throw adminForbiddenError();

      const locked = await transaction.query<ModerationRow>(
        `SELECT
           p.story_id,
           s.status AS story_status,
           s.title,
           COALESCE(u.public_pen_name, '') AS author_pen_name,
           p.status,
           p.first_published_at,
           p.status_updated_at,
           p.admin_reason
         FROM xumo_stories s
         JOIN xumo_story_publications p
           ON p.story_id = s.id
          AND p.owner_id = s.owner_id
         JOIN xumo_users u
           ON u.id = p.owner_id
         WHERE p.story_id = $1
         FOR UPDATE OF s, p`,
        [storyId],
      );
      const row = locked.rows[0];
      if (!row || row.status === "author_unpublished" || row.story_status === "archived") {
        throw createPublicStoryUnavailableError();
      }

      if (input.action === "suspend" && row.status === "active") {
        const reason = normalizeModerationReason(input.reason);
        await transaction.query(
          `UPDATE xumo_story_publications
           SET status = 'admin_suspended',
               status_updated_at = now(),
               admin_actor_user_id = $2,
               admin_reason = $3
           WHERE story_id = $1`,
          [storyId, adminUserId, reason],
        );
      } else if (input.action === "restore" && row.status === "admin_suspended") {
        await transaction.query(
          `UPDATE xumo_story_publications
           SET status = 'active',
               status_updated_at = now(),
               admin_actor_user_id = NULL,
               admin_reason = NULL
           WHERE story_id = $1`,
          [storyId],
        );
      }

      const refreshed = await transaction.query<ModerationRow>(
        `SELECT
           p.story_id,
           s.status AS story_status,
           s.title,
           COALESCE(u.public_pen_name, '') AS author_pen_name,
           p.status,
           p.first_published_at,
           p.status_updated_at,
           p.admin_reason
         FROM xumo_story_publications p
         JOIN xumo_stories s
           ON s.id = p.story_id
          AND s.owner_id = p.owner_id
         JOIN xumo_users u
           ON u.id = p.owner_id
         WHERE p.story_id = $1`,
        [storyId],
      );
      const refreshedRow = refreshed.rows[0];
      if (!refreshedRow) throw createPublicStoryUnavailableError();
      return moderationFromRow(refreshedRow);
    });
  }

  async listModeration(limit: number): Promise<PublicationModerationSummary[]> {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.round(limit)))
      : 20;
    const result = await this.executor.query<ModerationRow>(
      `SELECT
         p.story_id,
         s.status AS story_status,
         s.title,
         COALESCE(u.public_pen_name, '') AS author_pen_name,
         p.status,
         p.first_published_at,
         p.status_updated_at,
         p.admin_reason
       FROM xumo_story_publications p
       JOIN xumo_stories s
         ON s.id = p.story_id
        AND s.owner_id = p.owner_id
       JOIN xumo_users u
         ON u.id = p.owner_id
       ORDER BY p.status_updated_at DESC, p.story_id DESC
       LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map(moderationFromRow);
  }

  async moderationOverview(limit: number): Promise<PublicationModerationOverview> {
    const counts = await this.executor.query<ModerationCountsRow>(
      `SELECT
         COUNT(*)::integer AS total,
         COUNT(*) FILTER (WHERE status = 'active')::integer AS active,
         COUNT(*) FILTER (WHERE status = 'author_unpublished')::integer AS author_unpublished,
         COUNT(*) FILTER (WHERE status = 'admin_suspended')::integer AS admin_suspended
       FROM xumo_story_publications`,
    );
    const row = counts.rows[0] ?? {
      total: 0,
      active: 0,
      author_unpublished: 0,
      admin_suspended: 0,
    };
    return {
      counts: {
        total: Number(row.total),
        active: Number(row.active),
        authorUnpublished: Number(row.author_unpublished),
        adminSuspended: Number(row.admin_suspended),
      },
      recent: await this.listModeration(limit),
    };
  }
}
