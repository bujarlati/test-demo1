import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type {
  AppStore,
  AuditEvent,
  AuthSession,
  Chapter,
  ChapterRevision,
  ContentReport,
  GenerationFailureObservation,
  GenerationFailureSummaryBucket,
  GenerationJob,
  NarrationReviewMetricBucket,
  ModelConnection,
  SafetyDecision,
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
import {
  createPublicStorySharingModule,
  type PublicStorySharingModule,
} from "../publicStorySharing";
import {
  assertStoryDeletionTitle,
  createStoryDeletionAudit,
  DELETED_STORY_PLACEHOLDER,
  sanitizeGenerationFailureAfterStoryDeletion,
  sanitizeGenerationJobAfterStoryDeletion,
  sanitizeStoryAuditAfterDeletion,
  storyDeletionBusyError,
  storyNotFoundError,
  type PersistStoryDeletionInput,
  type StoryDeletionResult,
} from "../storyDeletion";
import { summarizeStory } from "../storyService";
import { NarrationReviewPostgresRepository } from "./narrationReviewRepository";
import { PublicStoryPostgresRepository } from "./publicStoryRepository";
import type { DatabaseExecutor, LegacyImportCounts, PersistenceDatabase, QueryResult, StoryPage } from "./types";

const { Pool } = pg;

interface JsonRow {
  payload: unknown;
}

interface AuditRow extends JsonRow {
  id: string;
  actor_user_id: string;
  action: string;
  target_type: AuditEvent["targetType"] | "model_connection";
  target_id: string;
  created_at: Date | string;
}

interface UserRow {
  id: string;
  email: string;
  password_salt: string;
  password_hash: string;
  name: string;
  initials: string;
  role: UserAccount["role"];
  active_story_id: string | null;
  default_connection_id: string;
  public_pen_name: string | null;
}

interface StoryRow extends JsonRow {
  id: string;
  owner_id: string;
  updated_at: Date | string;
}

interface ChapterRow {
  id: string;
  chapter_number: number;
  title: string;
  current_revision_id: string;
  estimated_minutes: number;
  has_unread_revision: boolean;
}

interface RevisionRow {
  id: string;
  chapter_id: string;
  parent_revision_id: string | null;
  title: string;
  paragraphs: unknown;
  reason: string;
  created_at: Date | string;
  model_name: string;
  prompt_version: string;
  change_summary: string | null;
  branch_id: string | null;
  ending_resolution: unknown;
}

interface StorySummaryRow {
  id: string;
  title: string;
  subtitle: string;
  genre: string;
  tone: string;
  length_label: string;
  target_chapter_count: number;
  cover_theme: Story["coverTheme"];
  status: Story["status"];
  canon_version: number;
  latest_excerpt: string;
  updated_at: Date | string;
  unread_canon_changes: number;
  current_chapter_number: number;
  current_chapter_title: string;
  chapter_count: number;
}

function rowCount(value: number | null | undefined): number {
  return value ?? 0;
}

export class PgExecutor implements DatabaseExecutor {
  constructor(private readonly pool: pg.Pool) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    parameters: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.pool.query(sql, parameters);
    return { rows: result.rows as Row[], rowCount: rowCount(result.rowCount) };
  }

  async execute(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const transactionExecutor: DatabaseExecutor = {
      query: async <Row = Record<string, unknown>>(sql: string, parameters: unknown[] = []) => {
        const result = await client.query(sql, parameters);
        return { rows: result.rows as Row[], rowCount: rowCount(result.rowCount) };
      },
      execute: async (sql: string) => { await client.query(sql); },
      transaction: async <Nested>(nested: (executor: DatabaseExecutor) => Promise<Nested>) => nested(transactionExecutor),
      close: async () => undefined,
    };
    try {
      await client.query("BEGIN");
      const value = await work(transactionExecutor);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function parseJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const auditStructuralFields = new Set([
  "id",
  "actorUserId",
  "action",
  "targetType",
  "targetId",
  "createdAt",
  "metadata",
]);

function auditMetadata(payload: unknown): AuditEvent["metadata"] {
  const parsed = parseJson<unknown>(payload);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const root = parsed as Record<string, unknown>;
  const candidate = root.metadata && typeof root.metadata === "object" && !Array.isArray(root.metadata)
    ? root.metadata as Record<string, unknown>
    : root;
  const metadata: AuditEvent["metadata"] = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (auditStructuralFields.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      metadata[key] = value;
    }
  }
  return metadata;
}

function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type === "model_connection" ? "connection" : row.target_type,
    targetId: row.target_id,
    createdAt: iso(row.created_at),
    metadata: auditMetadata(row.payload),
  };
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toUser(row: UserRow): UserAccount {
  return {
    id: row.id,
    email: row.email,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    name: row.name,
    initials: row.initials,
    role: row.role,
    activeStoryId: row.active_story_id,
    defaultConnectionId: row.default_connection_id,
    publicPenName: row.public_pen_name,
  };
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.updatedAt !== "string" || typeof value.id !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
      throw new Error("invalid cursor");
    }
    return { updatedAt: value.updatedAt, id: value.id };
  } catch {
    throw Object.assign(new Error("书架分页游标无效，请重新加载。"), { status: 400 });
  }
}

function storySummaryFromRow(row: StorySummaryRow): StorySummary {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    genre: row.genre,
    tone: row.tone,
    length: row.length_label,
    targetChapterCount: row.target_chapter_count,
    coverTheme: row.cover_theme,
    status: row.status,
    canonVersion: row.canon_version,
    latestExcerpt: row.latest_excerpt,
    updatedAt: iso(row.updated_at),
    unreadCanonChanges: row.unread_canon_changes,
    currentChapterNumber: row.current_chapter_number,
    currentChapterTitle: row.current_chapter_title,
    chapterCount: row.chapter_count,
    progress: Math.min(1, row.current_chapter_number / Math.max(1, row.target_chapter_count)),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function migrationDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(moduleDirectory) === "database"
    ? path.join(moduleDirectory, "migrations")
    : path.join(moduleDirectory, "database", "migrations");
}

export function createPostgresDatabase(connectionString: string): PostgresDatabase {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "xumo-api",
  });
  return new PostgresDatabase(new PgExecutor(pool));
}

export class PostgresDatabase implements PersistenceDatabase {
  readonly kind = "postgresql" as const;
  readonly publicStories: PublicStoryPostgresRepository;
  readonly publicStorySharing: PublicStorySharingModule;
  private saveQueue = Promise.resolve();
  private readonly deletedStoryIds = new Set<string>();
  private readonly uncertainStoryIds = new Set<string>();
  private readonly fingerprints = new Map<string, string>();
  private readonly narrationReviews: NarrationReviewPostgresRepository;

  constructor(private readonly executor: DatabaseExecutor) {
    this.narrationReviews = new NarrationReviewPostgresRepository(executor);
    this.publicStories = new PublicStoryPostgresRepository(executor);
    this.publicStorySharing = createPublicStorySharingModule(this.publicStories);
  }

  async migrate(): Promise<void> {
    await this.executor.execute(`
      CREATE TABLE IF NOT EXISTS xumo_schema_migrations (
        version text PRIMARY KEY,
        checksum text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.executor.execute("ALTER TABLE xumo_schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
    const entries = (await readdir(migrationDirectory())).filter((entry) => entry.endsWith(".sql")).sort();
    for (const entry of entries) {
      const sql = await readFile(path.join(migrationDirectory(), entry), "utf8");
      const checksum = fingerprint(sql);
      const applied = await this.executor.query<{ version: string; checksum: string | null }>(
        "SELECT version, checksum FROM xumo_schema_migrations WHERE version = $1",
        [entry],
      );
      if (applied.rows[0]) {
        if (applied.rows[0].checksum && applied.rows[0].checksum !== checksum) {
          throw new Error(`数据库 migration ${entry} 已执行但文件校验和发生变化；请创建新的前向 migration。`);
        }
        if (!applied.rows[0].checksum) {
          await this.executor.query("UPDATE xumo_schema_migrations SET checksum = $2 WHERE version = $1", [entry, checksum]);
        }
        continue;
      }
      await this.executor.transaction(async (transaction) => {
        await transaction.execute(sql);
        await transaction.query(
          "INSERT INTO xumo_schema_migrations(version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
          [entry, checksum],
        );
      });
    }
  }

  async isEmpty(): Promise<boolean> {
    const result = await this.executor.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_users");
    return Number(result.rows[0]?.count ?? 0) === 0;
  }

  async health(): Promise<void> {
    await this.executor.query("SELECT 1 AS ok");
  }

  private markLoaded(table: string, id: string, payload: unknown): void {
    this.fingerprints.set(`${table}:${id}`, fingerprint(payload));
  }

  private changed(table: string, id: string, payload: unknown): boolean {
    return this.fingerprints.get(`${table}:${id}`) !== fingerprint(payload);
  }

  private markSaved(table: string, id: string, payload: unknown): void {
    this.markLoaded(table, id, payload);
  }

  private async enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
    let result!: T;
    const task = this.saveQueue.catch(() => undefined).then(async () => {
      result = await work();
    });
    this.saveQueue = task;
    await task;
    return result;
  }

  private async resolveUncertainStoryIds(): Promise<void> {
    for (const storyId of this.uncertainStoryIds) {
      const authoritativeStory = await this.executor.query(
        "SELECT 1 FROM xumo_stories WHERE id = $1",
        [storyId],
      );
      if (authoritativeStory.rows.length > 0) {
        this.deletedStoryIds.delete(storyId);
      } else {
        this.deletedStoryIds.add(storyId);
      }
      this.uncertainStoryIds.delete(storyId);
    }
  }

  private sanitizeAuditForDeletedStory(event: AuditEvent): AuditEvent {
    const metadataStoryId = event.metadata?.storyId;
    const deletedStoryId = this.deletedStoryIds.has(event.targetId)
      ? event.targetId
      : typeof metadataStoryId === "string" && this.deletedStoryIds.has(metadataStoryId)
        ? metadataStoryId
        : null;
    return deletedStoryId
      ? sanitizeStoryAuditAfterDeletion(event, deletedStoryId)
      : event;
  }

  async loadRuntimeStore(): Promise<AppStore> {
    const [activeJobOwners, connections, jobs, failures, audits, safety, reports, keys, requests] = await Promise.all([
      this.executor.query<UserRow>(
        `SELECT DISTINCT u.id, u.email, u.password_salt, u.password_hash, u.name, u.initials,
                u.role, u.active_story_id, u.default_connection_id, u.public_pen_name
         FROM xumo_users u
         JOIN xumo_generation_jobs j ON j.owner_id = u.id
         WHERE j.status IN ('running', 'awaiting_user_review')`,
      ),
      this.executor.query<JsonRow>("SELECT payload FROM xumo_model_connections ORDER BY updated_at DESC"),
      this.executor.query<JsonRow>(`SELECT payload FROM xumo_generation_jobs
        WHERE status IN ('running', 'awaiting_user_review') OR id IN (
          SELECT id FROM xumo_generation_jobs ORDER BY created_at DESC LIMIT 2000
        ) ORDER BY created_at DESC`),
      this.executor.query<JsonRow>(
        "SELECT payload FROM xumo_generation_failure_observations ORDER BY created_at DESC LIMIT 2000",
      ),
      this.executor.query<AuditRow>(
        `SELECT id, actor_user_id, action, target_type, target_id, created_at, payload
         FROM xumo_audit_events ORDER BY created_at DESC LIMIT 500`,
      ),
      this.executor.query<JsonRow>("SELECT payload FROM xumo_safety_decisions ORDER BY created_at DESC LIMIT 1000"),
      this.executor.query<JsonRow>("SELECT payload FROM xumo_content_reports ORDER BY updated_at DESC LIMIT 1000"),
      this.executor.query<{ user_id: string; idempotency_key: string }>(
        "SELECT user_id, idempotency_key FROM xumo_idempotency_keys ORDER BY created_at DESC LIMIT 500",
      ),
      this.executor.query<{ user_id: string; idempotency_key: string; story_id: string; created_at: Date | string }>(
        "SELECT user_id, idempotency_key, story_id, created_at FROM xumo_story_creation_requests ORDER BY created_at DESC LIMIT 500",
      ),
    ]);
    const store: AppStore = {
      users: activeJobOwners.rows.map(toUser),
      sessions: [],
      stories: [],
      connections: connections.rows.map((row) => parseJson<ModelConnection>(row.payload)),
      jobs: jobs.rows.map((row) => parseJson<GenerationJob>(row.payload)),
      generationFailures: failures.rows.map((row) => parseJson<GenerationFailureObservation>(row.payload)),
      auditEvents: audits.rows.map(toAuditEvent),
      safetyDecisions: safety.rows.map((row) => parseJson<SafetyDecision>(row.payload)),
      contentReports: reports.rows.map((row) => parseJson<ContentReport>(row.payload)),
      idempotencyKeys: keys.rows.map((row) => `${row.user_id}:${row.idempotency_key}`),
      storyCreationRequests: requests.rows.map((row) => ({
        userId: row.user_id,
        idempotencyKey: row.idempotency_key,
        storyId: row.story_id,
        createdAt: iso(row.created_at),
      })),
    };
    for (const user of store.users) this.markLoaded("user", user.id, user);
    for (const connection of store.connections) this.markLoaded("connection", connection.id, connection);
    for (const job of store.jobs) this.markLoaded("job", job.id, job);
    for (const failure of store.generationFailures) this.markLoaded("failure", failure.id, failure);
    for (const event of store.auditEvents) this.markLoaded("audit", event.id, event);
    for (const decision of store.safetyDecisions) this.markLoaded("safety", decision.id, decision);
    for (const report of store.contentReports) this.markLoaded("report", report.id, report);
    return store;
  }

  async findUserByEmail(email: string): Promise<UserAccount | null> {
    const result = await this.executor.query<UserRow>(
      `SELECT id, email, password_salt, password_hash, name, initials, role, active_story_id, default_connection_id, public_pen_name
       FROM xumo_users WHERE normalized_email = $1`,
      [normalizedEmail(email)],
    );
    const user = result.rows[0] ? toUser(result.rows[0]) : null;
    if (user) this.markLoaded("user", user.id, user);
    return user;
  }

  async listGenerationFailurePatterns(limit: number): Promise<GenerationFailureSummaryBucket[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
    const result = await this.executor.query<{
      category: GenerationFailureSummaryBucket["category"];
      reason_code: string;
      stage: string;
      model: string;
      occurrences: string;
      affected_jobs: string;
      terminal_failures: string;
      recovered_jobs: string;
      last_seen_at: Date | string;
    }>(
      `SELECT f.category, f.reason_code, f.stage, f.model,
              count(*)::text AS occurrences,
              count(DISTINCT f.job_id)::text AS affected_jobs,
              count(*) FILTER (WHERE f.terminal)::text AS terminal_failures,
              count(DISTINCT f.job_id) FILTER (WHERE j.status = 'completed')::text AS recovered_jobs,
              max(f.created_at) AS last_seen_at
       FROM xumo_generation_failure_observations f
       LEFT JOIN xumo_generation_jobs j ON j.id = f.job_id
       GROUP BY f.category, f.reason_code, f.stage, f.model
       ORDER BY count(*) DESC, max(f.created_at) DESC
       LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map((row) => ({
      key: [row.category, row.reason_code, row.stage, row.model].join("|"),
      category: row.category,
      reasonCode: row.reason_code,
      stage: row.stage,
      model: row.model,
      occurrences: Number(row.occurrences),
      affectedJobs: Number(row.affected_jobs),
      terminalFailures: Number(row.terminal_failures),
      recoveredJobs: Number(row.recovered_jobs),
      lastSeenAt: iso(row.last_seen_at),
    }));
  }

  async listNarrationReviewMetrics(limit: number): Promise<NarrationReviewMetricBucket[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
    const result = await this.executor.query<{
      rule_id: string;
      rule_version: string;
      candidates: string;
      model_allow: string;
      model_rewrite: string;
      model_ask_user: string;
      user_keep: string;
      user_rewrite: string;
      timeout_rewrite: string;
      rewrite_succeeded: string;
      final_jobs_completed: string;
      last_seen_at: Date | string;
    }>(
      `SELECT rule_id, rule_version,
              count(*)::text AS candidates,
              count(*) FILTER (WHERE decision = 'allow')::text AS model_allow,
              count(*) FILTER (WHERE decision = 'rewrite')::text AS model_rewrite,
              count(*) FILTER (WHERE decision = 'ask_user')::text AS model_ask_user,
              count(*) FILTER (WHERE user_decision = 'keep')::text AS user_keep,
              count(*) FILTER (WHERE user_decision = 'rewrite')::text AS user_rewrite,
              count(*) FILTER (WHERE resolution_source = 'timeout')::text AS timeout_rewrite,
              count(*) FILTER (WHERE rewrite_succeeded IS TRUE)::text AS rewrite_succeeded,
              count(*) FILTER (WHERE job_completed IS TRUE)::text AS final_jobs_completed,
              max(updated_at) AS last_seen_at
       FROM xumo_narration_review_feedback
       GROUP BY rule_id, rule_version
       ORDER BY max(updated_at) DESC, rule_id, rule_version
       LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map((row) => ({
      key: `${row.rule_id}:${row.rule_version}`,
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
      candidates: Number(row.candidates),
      modelAllow: Number(row.model_allow),
      modelRewrite: Number(row.model_rewrite),
      modelAskUser: Number(row.model_ask_user),
      userKeep: Number(row.user_keep),
      userRewrite: Number(row.user_rewrite),
      timeoutRewrite: Number(row.timeout_rewrite),
      rewriteSucceeded: Number(row.rewrite_succeeded),
      finalJobsCompleted: Number(row.final_jobs_completed),
      lastSeenAt: iso(row.last_seen_at),
    }));
  }

  async findUserBySessionTokenHash(tokenHash: string): Promise<UserAccount | null> {
    const result = await this.executor.query<UserRow>(
      `SELECT u.id, u.email, u.password_salt, u.password_hash, u.name, u.initials, u.role,
              u.active_story_id, u.default_connection_id, u.public_pen_name
       FROM xumo_auth_sessions s
       JOIN xumo_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    const user = result.rows[0] ? toUser(result.rows[0]) : null;
    if (user) this.markLoaded("user", user.id, user);
    return user;
  }

  async register(user: UserAccount, session: AuthSession, event: AuditEvent): Promise<void> {
    try {
      await this.executor.transaction(async (transaction) => {
        await this.upsertUser(transaction, user, true);
        await this.upsertSession(transaction, session);
        await this.upsertAudit(transaction, event);
      });
      this.markSaved("user", user.id, user);
      this.markSaved("audit", event.id, event);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "23505") {
        throw Object.assign(new Error("该邮箱已经注册，请直接登录。"), { status: 409 });
      }
      throw error;
    }
  }

  async saveSession(session: AuthSession): Promise<void> {
    await this.upsertSession(this.executor, session);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.executor.query("DELETE FROM xumo_auth_sessions WHERE token_hash = $1", [tokenHash]);
  }

  async reserveIdempotencyKey(userId: string, idempotencyKey: string): Promise<boolean> {
    const result = await this.executor.query<{ idempotency_key: string }>(
      `INSERT INTO xumo_idempotency_keys(user_id, idempotency_key) VALUES ($1, $2)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [userId, idempotencyKey],
    );
    return result.rows.length > 0;
  }

  async hasIdempotencyKey(userId: string, idempotencyKey: string): Promise<boolean> {
    const result = await this.executor.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM xumo_idempotency_keys WHERE user_id = $1 AND idempotency_key = $2",
      [userId, idempotencyKey],
    );
    return result.rows.length > 0;
  }

  async releaseIdempotencyKey(userId: string, idempotencyKey: string): Promise<void> {
    await this.executor.query(
      "DELETE FROM xumo_idempotency_keys WHERE user_id = $1 AND idempotency_key = $2",
      [userId, idempotencyKey],
    );
  }

  async findStoryCreationRequest(userId: string, idempotencyKey: string): Promise<string | null> {
    const result = await this.executor.query<{ story_id: string }>(
      "SELECT story_id FROM xumo_story_creation_requests WHERE user_id = $1 AND idempotency_key = $2",
      [userId, idempotencyKey],
    );
    return result.rows[0]?.story_id ?? null;
  }


  async findGenerationJobByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<GenerationJob | null> {
    const result = await this.executor.query<JsonRow>(
      `SELECT payload FROM xumo_generation_jobs
       WHERE owner_id = $1 AND payload->>'idempotencyKey' = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId, idempotencyKey],
    );
    return result.rows[0] ? parseJson<GenerationJob>(result.rows[0].payload) : null;
  }

  async listStories(ownerId: string, limit: number, cursor?: string): Promise<StoryPage> {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const position = cursor ? decodeCursor(cursor) : null;
    const parameters: unknown[] = [ownerId, safeLimit + 1];
    const cursorClause = position ? "AND (updated_at, id) < ($3::timestamptz, $4::text)" : "";
    if (position) parameters.push(position.updatedAt, position.id);
    const [page, totals] = await Promise.all([
      this.executor.query<StorySummaryRow>(
        `SELECT id, title, subtitle, genre, tone, length_label, target_chapter_count, cover_theme,
                status, canon_version, latest_excerpt, updated_at, unread_canon_changes,
                current_chapter_number, current_chapter_title, chapter_count
         FROM xumo_stories
         WHERE owner_id = $1 AND status <> 'archived' ${cursorClause}
         ORDER BY updated_at DESC, id DESC
         LIMIT $2`,
        parameters,
      ),
      this.executor.query<{ story_count: string; chapter_count: string }>(
        `SELECT count(*)::text AS story_count, coalesce(sum(chapter_count), 0)::text AS chapter_count
         FROM xumo_stories WHERE owner_id = $1 AND status <> 'archived'`,
        [ownerId],
      ),
    ]);
    const hasMore = page.rows.length > safeLimit;
    const visibleRows = page.rows.slice(0, safeLimit);
    const last = visibleRows.at(-1);
    return {
      stories: visibleRows.map(storySummaryFromRow),
      nextCursor: hasMore && last ? encodeCursor(iso(last.updated_at), last.id) : null,
      totalStories: Number(totals.rows[0]?.story_count ?? 0),
      totalChapters: Number(totals.rows[0]?.chapter_count ?? 0),
    };
  }

  async loadStory(ownerId: string, storyId: string): Promise<Story | null> {
    const storyResult = await this.executor.query<StoryRow>(
      "SELECT id, owner_id, updated_at, payload FROM xumo_stories WHERE id = $1 AND owner_id = $2",
      [storyId, ownerId],
    );
    const storyRow = storyResult.rows[0];
    if (!storyRow) return null;
    const [chapterResult, revisionResult] = await Promise.all([
      this.executor.query<ChapterRow>(
        `SELECT id, chapter_number, title, current_revision_id, estimated_minutes, has_unread_revision
         FROM xumo_chapters WHERE story_id = $1 ORDER BY chapter_number`,
        [storyId],
      ),
      this.executor.query<RevisionRow>(
        `SELECT id, chapter_id, parent_revision_id, title, paragraphs, reason, created_at, model_name,
                prompt_version, change_summary, branch_id, ending_resolution
         FROM xumo_chapter_revisions WHERE story_id = $1 ORDER BY chapter_id, created_at, id`,
        [storyId],
      ),
    ]);
    const revisions = new Map<string, ChapterRevision[]>();
    for (const row of revisionResult.rows) {
      const revision: ChapterRevision = {
        id: row.id,
        parentRevisionId: row.parent_revision_id,
        title: row.title,
        paragraphs: parseJson<string[]>(row.paragraphs),
        reason: row.reason,
        createdAt: iso(row.created_at),
        modelName: row.model_name,
        promptVersion: row.prompt_version,
        ...(row.change_summary ? { changeSummary: row.change_summary } : {}),
        ...(row.branch_id ? { branchId: row.branch_id } : {}),
        ...(row.ending_resolution ? { endingResolution: parseJson<ChapterRevision["endingResolution"]>(row.ending_resolution) } : {}),
      };
      const values = revisions.get(row.chapter_id) ?? [];
      values.push(revision);
      revisions.set(row.chapter_id, values);
    }
    const chapters: Chapter[] = chapterResult.rows.map((row) => ({
      id: row.id,
      number: row.chapter_number,
      title: row.title,
      currentRevisionId: row.current_revision_id,
      revisions: revisions.get(row.id) ?? [],
      estimatedMinutes: row.estimated_minutes,
      ...(row.has_unread_revision ? { hasUnreadRevision: true } : {}),
    }));
    const story = { ...parseJson<Omit<Story, "chapters">>(storyRow.payload), chapters } as Story;
    this.markLoaded("story", story.id, story);
    return story;
  }

  async saveSnapshot(store: AppStore, rollbackOnFailure?: () => void): Promise<void> {
    const snapshot = structuredClone(store);
    const task = async () => {
      const marks: Array<[string, string, unknown]> = [];
      try {
        await this.resolveUncertainStoryIds();
        await this.executor.transaction(async (transaction) => {
          for (const user of snapshot.users) {
            const persistedUser = user.activeStoryId && this.deletedStoryIds.has(user.activeStoryId)
              ? { ...user, activeStoryId: null }
              : user;
            if (!this.changed("user", persistedUser.id, persistedUser)) continue;
            await this.upsertUser(transaction, persistedUser, false);
            marks.push(["user", persistedUser.id, persistedUser]);
          }
          for (const session of snapshot.sessions) await this.upsertSession(transaction, session);
          for (const connection of snapshot.connections) {
            if (!this.changed("connection", connection.id, connection)) continue;
            await transaction.query(
              `INSERT INTO xumo_model_connections(id, owner_scope, owner_id, status, updated_at, payload)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb)
               ON CONFLICT (id) DO UPDATE SET owner_scope = excluded.owner_scope, owner_id = excluded.owner_id,
                 status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload`,
              [connection.id, connection.ownerScope, connection.ownerId, connection.status, connection.updatedAt, stableJson(connection)],
            );
            marks.push(["connection", connection.id, connection]);
          }
          for (const story of snapshot.stories) {
            if (this.deletedStoryIds.has(story.id)) continue;
            if (!this.changed("story", story.id, story)) continue;
            await this.upsertStory(transaction, story);
            marks.push(["story", story.id, story]);
          }
          for (const job of snapshot.jobs) {
            const persistedJob = this.deletedStoryIds.has(job.storyId)
              ? sanitizeGenerationJobAfterStoryDeletion(job)
              : job;
            if (!this.changed("job", persistedJob.id, persistedJob)) continue;
            await transaction.query(
              `INSERT INTO xumo_generation_jobs(id, owner_id, story_id, task, status, created_at, payload)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
               ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, story_id = excluded.story_id,
                 task = excluded.task, status = excluded.status, created_at = excluded.created_at, payload = excluded.payload`,
              [persistedJob.id, persistedJob.ownerId, persistedJob.storyId, persistedJob.task,
                persistedJob.status, persistedJob.createdAt, stableJson(persistedJob)],
            );
            marks.push(["job", persistedJob.id, persistedJob]);
          }
          for (const failure of snapshot.generationFailures) {
            const persistedFailure = this.deletedStoryIds.has(failure.storyId)
              ? sanitizeGenerationFailureAfterStoryDeletion(failure)
              : failure;
            if (!this.changed("failure", persistedFailure.id, persistedFailure)) continue;
            await transaction.query(
              `INSERT INTO xumo_generation_failure_observations(
                 id, job_id, owner_id, story_id, task, stage, classifier_version, category, reason_code, fingerprint,
                 model, connection_id, prompt_version, attempt, terminal, retryable, latency_ms,
                 tokens, created_at, payload
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14, $15, $16, $17,
                 $18, $19, $20::jsonb
               ) ON CONFLICT (id) DO NOTHING`,
              [
                persistedFailure.id,
                persistedFailure.jobId,
                persistedFailure.ownerId,
                persistedFailure.storyId,
                persistedFailure.task,
                persistedFailure.stage,
                persistedFailure.classifierVersion,
                persistedFailure.category,
                persistedFailure.reasonCode,
                persistedFailure.fingerprint,
                persistedFailure.model,
                persistedFailure.connectionId,
                persistedFailure.promptVersion,
                persistedFailure.attempt,
                persistedFailure.terminal,
                persistedFailure.retryable,
                persistedFailure.latencyMs,
                persistedFailure.tokens,
                persistedFailure.createdAt,
                stableJson(persistedFailure),
              ],
            );
            marks.push(["failure", persistedFailure.id, persistedFailure]);
          }
          for (const event of snapshot.auditEvents) {
            const persistedAudit = this.sanitizeAuditForDeletedStory(event);
            if (!this.changed("audit", persistedAudit.id, persistedAudit)) continue;
            await this.upsertAudit(transaction, persistedAudit);
            marks.push(["audit", persistedAudit.id, persistedAudit]);
          }
          for (const decision of snapshot.safetyDecisions) {
            if (decision.storyId && this.deletedStoryIds.has(decision.storyId)) continue;
            if (!this.changed("safety", decision.id, decision)) continue;
            await transaction.query(
              `INSERT INTO xumo_safety_decisions(id, actor_user_id, story_id, created_at, payload)
               VALUES ($1, $2, $3, $4, $5::jsonb)
               ON CONFLICT (id) DO UPDATE SET payload = excluded.payload`,
              [decision.id, decision.actorUserId, decision.storyId ?? null, decision.createdAt, stableJson(decision)],
            );
            marks.push(["safety", decision.id, decision]);
          }
          for (const report of snapshot.contentReports) {
            if (report.storyId && this.deletedStoryIds.has(report.storyId)) continue;
            if (!this.changed("report", report.id, report)) continue;
            await transaction.query(
              `INSERT INTO xumo_content_reports(id, reporter_user_id, story_id, status, created_at, updated_at, payload)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
               ON CONFLICT (id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload`,
              [report.id, report.reporterUserId, report.storyId ?? null, report.status, report.createdAt, report.updatedAt, stableJson(report)],
            );
            marks.push(["report", report.id, report]);
          }
          for (const scopedKey of snapshot.idempotencyKeys) {
            const separator = scopedKey.indexOf(":");
            if (separator <= 0) continue;
            await transaction.query(
              `INSERT INTO xumo_idempotency_keys(user_id, idempotency_key) VALUES ($1, $2)
               ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
              [scopedKey.slice(0, separator), scopedKey.slice(separator + 1)],
            );
          }
          for (const request of snapshot.storyCreationRequests) {
            if (this.deletedStoryIds.has(request.storyId)) continue;
            await transaction.query(
              `INSERT INTO xumo_story_creation_requests(user_id, idempotency_key, story_id, created_at)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id, idempotency_key) DO UPDATE SET story_id = excluded.story_id`,
              [request.userId, request.idempotencyKey, request.storyId, request.createdAt],
            );
          }
        });
        for (const [table, id, value] of marks) this.markSaved(table, id, value);
      } catch (error) {
        rollbackOnFailure?.();
        throw error;
      }
    };
    await this.enqueueMutation(task);
  }

  async deleteOwnedStory(input: PersistStoryDeletionInput): Promise<StoryDeletionResult> {
    const result = await this.enqueueMutation(async () => {
      await this.resolveUncertainStoryIds();
      let tombstoneAdded = false;
      try {
        return await this.executor.transaction(async (transaction) => {
          const storyRows = await transaction.query<{
            title: string;
            chapter_count: number;
            was_current: boolean;
            was_published: boolean;
          }>(
            `SELECT s.title, s.chapter_count,
                    (u.active_story_id = s.id) AS was_current,
                    EXISTS (
                      SELECT 1 FROM xumo_story_publications p
                      WHERE p.story_id = s.id AND p.status = 'active'
                    ) AS was_published
             FROM xumo_stories s
             JOIN xumo_users u ON u.id = s.owner_id
             WHERE s.id = $1 AND s.owner_id = $2
             FOR UPDATE OF s, u`,
            [input.storyId, input.ownerId],
          );
          const row = storyRows.rows[0];
          if (!row) throw storyNotFoundError();
          assertStoryDeletionTitle(row.title, input.confirmationTitle);

          const lockedJobs = await transaction.query<{ id: string; status: GenerationJob["status"] }>(
            `SELECT id, status FROM xumo_generation_jobs
             WHERE story_id = $1
             ORDER BY id
             FOR UPDATE`,
            [input.storyId],
          );
          if (lockedJobs.rows.some((job) => job.status === "running" || job.status === "awaiting_user_review")) {
            throw storyDeletionBusyError();
          }
          this.deletedStoryIds.add(input.storyId);
          tombstoneAdded = true;

          const feedbackRows = await transaction.query<{ id: string }>(
            `SELECT id FROM xumo_narration_review_feedback
             WHERE job_id IN (SELECT id FROM xumo_generation_jobs WHERE story_id = $1)`,
            [input.storyId],
          );
          for (const feedbackRow of feedbackRows.rows) {
            await transaction.query(
              `UPDATE xumo_narration_review_feedback
               SET content_hash = $2, consented_excerpt_ciphertext = NULL, excerpt_expires_at = NULL
               WHERE id = $1`,
              [feedbackRow.id, fingerprint({ deletedNarrationFeedbackId: feedbackRow.id })],
            );
          }
          await transaction.query(
            `DELETE FROM xumo_narration_review_cases
             WHERE job_id IN (SELECT id FROM xumo_generation_jobs WHERE story_id = $1)`,
            [input.storyId],
          );

          const jobs = await transaction.query<{ id: string; payload: unknown }>(
            "SELECT id, payload FROM xumo_generation_jobs WHERE story_id = $1",
            [input.storyId],
          );
          for (const jobRow of jobs.rows) {
            const job = sanitizeGenerationJobAfterStoryDeletion(parseJson<GenerationJob>(jobRow.payload));
            await transaction.query(
              "UPDATE xumo_generation_jobs SET story_id = $2, payload = $3::jsonb WHERE id = $1",
              [jobRow.id, DELETED_STORY_PLACEHOLDER, stableJson(job)],
            );
          }

          const failures = await transaction.query<{ id: string; payload: unknown }>(
            "SELECT id, payload FROM xumo_generation_failure_observations WHERE story_id = $1",
            [input.storyId],
          );
          for (const failureRow of failures.rows) {
            const failure = sanitizeGenerationFailureAfterStoryDeletion(
              parseJson<GenerationFailureObservation>(failureRow.payload),
            );
            await transaction.query(
              `UPDATE xumo_generation_failure_observations
               SET story_id = $2, fingerprint = $3, payload = $4::jsonb WHERE id = $1`,
              [failureRow.id, DELETED_STORY_PLACEHOLDER, failure.fingerprint, stableJson(failure)],
            );
          }

          await transaction.query("DELETE FROM xumo_safety_decisions WHERE story_id = $1", [input.storyId]);
          await transaction.query("DELETE FROM xumo_content_reports WHERE story_id = $1", [input.storyId]);

          const affectedAudits = await transaction.query<AuditRow>(
            `SELECT id, actor_user_id, action, target_type, target_id, created_at, payload
             FROM xumo_audit_events
             WHERE target_id = $1
                OR payload #>> '{metadata,storyId}' = $1
                OR payload ->> 'storyId' = $1`,
            [input.storyId],
          );
          for (const auditRow of affectedAudits.rows) {
            const event = sanitizeStoryAuditAfterDeletion(toAuditEvent(auditRow), input.storyId);
            await transaction.query(
              "UPDATE xumo_audit_events SET target_id = $2, payload = $3::jsonb WHERE id = $1",
              [auditRow.id, event.targetId, stableJson(event)],
            );
          }

          await transaction.query(
            "UPDATE xumo_users SET active_story_id = NULL WHERE active_story_id = $1",
            [input.storyId],
          );
          await transaction.query(
            "DELETE FROM xumo_stories WHERE id = $1 AND owner_id = $2",
            [input.storyId, input.ownerId],
          );

          const deletionResult: StoryDeletionResult = {
            wasCurrentStory: row.was_current,
            wasPublished: row.was_published,
            hadChapters: row.chapter_count > 0,
          };
          await this.upsertAudit(
            transaction,
            createStoryDeletionAudit(input.ownerId, input.auditId, input.deletedAt, deletionResult),
          );
          return deletionResult;
        });
      } catch (error) {
        if (tombstoneAdded) {
          try {
            const authoritativeStory = await this.executor.query(
              "SELECT 1 FROM xumo_stories WHERE id = $1",
              [input.storyId],
            );
            if (authoritativeStory.rows.length > 0) {
              this.deletedStoryIds.delete(input.storyId);
            }
            this.uncertainStoryIds.delete(input.storyId);
          } catch {
            this.uncertainStoryIds.add(input.storyId);
          }
        }
        throw error;
      }
    });
    this.fingerprints.delete(`story:${input.storyId}`);
    return result;
  }

  private async upsertUser(executor: DatabaseExecutor, user: UserAccount, insertOnly: boolean): Promise<void> {
    const conflict = insertOnly ? "DO NOTHING" : `DO UPDATE SET email = excluded.email, normalized_email = excluded.normalized_email,
      password_salt = excluded.password_salt, password_hash = excluded.password_hash, name = excluded.name,
      initials = excluded.initials, role = excluded.role, active_story_id = excluded.active_story_id,
      default_connection_id = excluded.default_connection_id, public_pen_name = excluded.public_pen_name, updated_at = now()`;
    const result = await executor.query(
      `INSERT INTO xumo_users(id, email, normalized_email, password_salt, password_hash, name, initials, role,
                              active_story_id, default_connection_id, public_pen_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (normalized_email) ${conflict}`,
      [user.id, user.email, normalizedEmail(user.email), user.passwordSalt, user.passwordHash, user.name,
        user.initials, user.role, user.activeStoryId, user.defaultConnectionId, user.publicPenName],
    );
    if (insertOnly && result.rowCount === 0) {
      throw Object.assign(new Error("该邮箱已经注册，请直接登录。"), { status: 409, code: "23505" });
    }
  }

  private async upsertSession(executor: DatabaseExecutor, session: AuthSession): Promise<void> {
    await executor.query(
      `INSERT INTO xumo_auth_sessions(id, user_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at`,
      [session.id, session.userId, session.tokenHash, session.createdAt, session.expiresAt],
    );
  }

  private async upsertAudit(executor: DatabaseExecutor, event: AuditEvent): Promise<void> {
    await executor.query(
      `INSERT INTO xumo_audit_events(id, actor_user_id, action, target_type, target_id, created_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (id) DO UPDATE SET payload = excluded.payload`,
      [event.id, event.actorUserId, event.action, event.targetType, event.targetId, event.createdAt, stableJson(event)],
    );
  }

  private async upsertStory(executor: DatabaseExecutor, story: Story): Promise<void> {
    const { chapters, ...payload } = story;
    const summary = summarizeStory(story);
    await executor.query(
      `INSERT INTO xumo_stories(
         id, owner_id, title, subtitle, genre, tone, length_label, target_chapter_count, cover_theme, status,
         canon_version, latest_excerpt, unread_canon_changes, current_chapter_number, current_chapter_title,
         chapter_count, payload, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, title = excluded.title,
         subtitle = excluded.subtitle, genre = excluded.genre, tone = excluded.tone, length_label = excluded.length_label,
         target_chapter_count = excluded.target_chapter_count, cover_theme = excluded.cover_theme, status = excluded.status,
         canon_version = excluded.canon_version, latest_excerpt = excluded.latest_excerpt,
         unread_canon_changes = excluded.unread_canon_changes, current_chapter_number = excluded.current_chapter_number,
         current_chapter_title = excluded.current_chapter_title, chapter_count = excluded.chapter_count,
         payload = excluded.payload, updated_at = excluded.updated_at`,
      [story.id, story.ownerId, story.title, story.subtitle, story.genre, story.tone, story.length,
        story.targetChapterCount, story.coverTheme, story.status, story.canonVersion, story.latestExcerpt,
        story.unreadCanonChanges, summary.currentChapterNumber, summary.currentChapterTitle, summary.chapterCount,
        stableJson(payload), story.updatedAt],
    );
    if (story.status === "archived") {
      await executor.query(
        `UPDATE xumo_story_publications
         SET status = 'author_unpublished',
             status_updated_at = now(),
             admin_actor_user_id = NULL,
             admin_reason = NULL
         WHERE story_id = $1 AND status = 'active'`,
        [story.id],
      );
    }
    for (const chapter of chapters) {
      await executor.query(
        `INSERT INTO xumo_chapters(id, story_id, chapter_number, title, current_revision_id, estimated_minutes,
                                   has_unread_revision, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET chapter_number = excluded.chapter_number, title = excluded.title,
           current_revision_id = excluded.current_revision_id, estimated_minutes = excluded.estimated_minutes,
           has_unread_revision = excluded.has_unread_revision, updated_at = excluded.updated_at`,
        [chapter.id, story.id, chapter.number, chapter.title, chapter.currentRevisionId, chapter.estimatedMinutes,
          chapter.hasUnreadRevision ?? false, story.updatedAt],
      );
      for (const revision of chapter.revisions) {
        await executor.query(
          `INSERT INTO xumo_chapter_revisions(
             id, story_id, chapter_id, parent_revision_id, title, paragraphs, reason, model_name, prompt_version,
             branch_id, change_summary, ending_resolution, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13)
           ON CONFLICT (id) DO NOTHING`,
          [revision.id, story.id, chapter.id, revision.parentRevisionId, revision.title,
            stableJson(revision.paragraphs), revision.reason, revision.modelName, revision.promptVersion,
            revision.branchId ?? null, revision.changeSummary ?? null,
            revision.endingResolution ? stableJson(revision.endingResolution) : null, revision.createdAt],
        );
      }
    }
  }

  async pauseOpeningForNarrationReview(
    job: GenerationJob,
    review: NarrationReviewCaseRecord,
  ): Promise<void> {
    await this.narrationReviews.pauseOpeningForNarrationReview(job, review);
    this.markSaved("job", job.id, job);
  }

  async getNarrationReviewCaseForOwner(
    ownerId: string,
    jobId: string,
  ): Promise<NarrationReviewCaseRecord | null> {
    return this.narrationReviews.getNarrationReviewCaseForOwner(ownerId, jobId);
  }

  async getNarrationReviewCaseById(id: string): Promise<NarrationReviewCaseRecord | null> {
    return this.narrationReviews.getNarrationReviewCaseById(id);
  }

  async claimNarrationReviewDecision(
    claim: NarrationReviewDecisionClaim,
  ): Promise<NarrationReviewCaseRecord | null> {
    return this.narrationReviews.claimNarrationReviewDecision(claim);
  }

  async claimExpiredNarrationReviews(
    now: string,
    limit: number,
  ): Promise<NarrationReviewCaseRecord[]> {
    return this.narrationReviews.claimExpiredNarrationReviews(now, limit);
  }

  async listRecoverableNarrationReviews(limit?: number): Promise<NarrationReviewCaseRecord[]> {
    return this.narrationReviews.listRecoverableNarrationReviews(limit);
  }

  async replaceNarrationReviewCase(
    oldCaseId: string,
    job: GenerationJob,
    review: NarrationReviewCaseRecord,
    resolvedAt: string,
  ): Promise<boolean> {
    const replaced = await this.narrationReviews.replaceNarrationReviewCase(
      oldCaseId,
      job,
      review,
      resolvedAt,
    );
    if (replaced) this.markSaved("job", job.id, job);
    return replaced;
  }

  async resolveNarrationReviewCase(
    id: string,
    finalStatus: "resolved" | "failed",
    resolvedAt: string,
  ): Promise<boolean> {
    return this.narrationReviews.resolveNarrationReviewCase(id, finalStatus, resolvedAt);
  }

  async failExpiredNarrationReviewCase(id: string, now: string): Promise<boolean> {
    return this.narrationReviews.failExpiredNarrationReviewCase(id, now);
  }

  async upsertNarrationReviewFeedback(feedback: NarrationReviewFeedbackRecord): Promise<void> {
    await this.narrationReviews.upsertNarrationReviewFeedback(feedback);
  }

  async deleteExpiredNarrationReviewData(now: string): Promise<NarrationReviewCleanupCounts> {
    return this.narrationReviews.deleteExpiredNarrationReviewData(now);
  }

  async deleteModelConnection(connectionId: string): Promise<void> {
    await this.executor.query("DELETE FROM xumo_model_connections WHERE id = $1", [connectionId]);
    this.fingerprints.delete(`connection:${connectionId}`);
  }

  async clearStoryModelConnection(connectionId: string): Promise<void> {
    await this.executor.query(
      `UPDATE xumo_stories
       SET payload = jsonb_set(payload, '{modelConnectionId}', 'null'::jsonb, true), updated_at = updated_at
       WHERE payload ->> 'modelConnectionId' = $1`,
      [connectionId],
    );
  }

  async hasLegacyImport(sourceFingerprint: string): Promise<boolean> {
    const result = await this.executor.query<{ source_fingerprint: string }>(
      "SELECT source_fingerprint FROM xumo_legacy_imports WHERE source_fingerprint = $1",
      [sourceFingerprint],
    );
    return result.rows.length > 0;
  }

  async recordLegacyImport(
    sourceFingerprint: string,
    sourcePath: string,
    counts: LegacyImportCounts,
  ): Promise<void> {
    await this.executor.query(
      `INSERT INTO xumo_legacy_imports(
         source_fingerprint, source_path, user_count, story_count, chapter_count, revision_count
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (source_fingerprint) DO NOTHING`,
      [sourceFingerprint, sourcePath, counts.users, counts.stories, counts.chapters, counts.revisions],
    );
  }

  async counts(): Promise<LegacyImportCounts> {
    const result = await this.executor.query<{
      users: string;
      stories: string;
      chapters: string;
      revisions: string;
    }>(`SELECT
      (SELECT count(*) FROM xumo_users)::text AS users,
      (SELECT count(*) FROM xumo_stories)::text AS stories,
      (SELECT count(*) FROM xumo_chapters)::text AS chapters,
      (SELECT count(*) FROM xumo_chapter_revisions)::text AS revisions`);
    const row = result.rows[0];
    return {
      users: Number(row?.users ?? 0),
      stories: Number(row?.stories ?? 0),
      chapters: Number(row?.chapters ?? 0),
      revisions: Number(row?.revisions ?? 0),
    };
  }

  async close(): Promise<void> {
    await this.saveQueue.catch(() => undefined);
    await this.executor.close();
  }
}
