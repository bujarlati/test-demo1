import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationFailureObservation, GenerationJob } from "../src/types";
import { PostgresDatabase } from "../server/database/postgres";
import type { DatabaseExecutor, QueryResult } from "../server/database/types";
import { createGenerationFailureObservation } from "../server/failureTelemetry";
import { createSeedStore } from "../server/seed";
import { createStoryDeletionStorage } from "../server/storage";
import { DELETED_STORY_PLACEHOLDER } from "../server/storyDeletion";
import { PGlite, PGliteExecutor } from "./helpers/pglite";

interface FailureState {
  armed: boolean;
}

class ArmedFailingExecutor implements DatabaseExecutor {
  constructor(
    private readonly inner: DatabaseExecutor,
    readonly failureState: FailureState = { armed: false },
  ) {}

  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row>> {
    if (this.failureState.armed && /DELETE FROM xumo_stories/u.test(sql)) {
      throw new Error("injected story deletion failure");
    }
    return this.inner.query<Row>(sql, parameters);
  }

  execute(sql: string): Promise<void> {
    return this.inner.execute(sql);
  }

  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.inner.transaction((executor) => work(new ArmedFailingExecutor(executor, this.failureState)));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

class AuthorityQueryFailingExecutor implements DatabaseExecutor {
  constructor(
    private readonly inner: DatabaseExecutor,
    readonly failureState: FailureState = { armed: false },
    private readonly insideTransaction = false,
  ) {}

  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row>> {
    if (this.failureState.armed && this.insideTransaction && /DELETE FROM xumo_stories/u.test(sql)) {
      throw new Error("injected ambiguous story deletion failure");
    }
    if (this.failureState.armed && !this.insideTransaction && /SELECT 1 FROM xumo_stories WHERE id/u.test(sql)) {
      throw new Error("injected authoritative existence query failure");
    }
    return this.inner.query<Row>(sql, parameters);
  }

  execute(sql: string): Promise<void> {
    return this.inner.execute(sql);
  }

  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.inner.transaction((executor) => work(new AuthorityQueryFailingExecutor(
      executor,
      this.failureState,
      true,
    )));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

interface JobStatusTransitionState {
  armed: boolean;
  jobId: string;
  transitioned: boolean;
}

class JobStatusTransitionExecutor implements DatabaseExecutor {
  constructor(
    private readonly inner: DatabaseExecutor,
    readonly transitionState: JobStatusTransitionState = {
      armed: false,
      jobId: "",
      transitioned: false,
    },
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row>> {
    if (this.transitionState.armed
      && !this.transitionState.transitioned
      && /SELECT id, status FROM xumo_generation_jobs[\s\S]*FOR UPDATE/u.test(sql)) {
      this.transitionState.transitioned = true;
      await this.inner.query(
        "UPDATE xumo_generation_jobs SET status = 'running' WHERE id = $1",
        [this.transitionState.jobId],
      );
    }
    return this.inner.query<Row>(sql, parameters);
  }

  execute(sql: string): Promise<void> {
    return this.inner.execute(sql);
  }

  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.inner.transaction((executor) => work(new JobStatusTransitionExecutor(executor, this.transitionState)));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface DeleteGateState {
  reached: Deferred;
  release: Deferred;
  blocked: boolean;
  closed: boolean;
}

class StoryDeleteGateExecutor implements DatabaseExecutor {
  constructor(
    private readonly inner: DatabaseExecutor,
    readonly gate: DeleteGateState = {
      reached: deferred(),
      release: deferred(),
      blocked: false,
      closed: false,
    },
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row>> {
    if (!this.gate.blocked && /DELETE FROM xumo_stories/u.test(sql)) {
      this.gate.blocked = true;
      this.gate.reached.resolve();
      await this.gate.release.promise;
    }
    return this.inner.query<Row>(sql, parameters);
  }

  execute(sql: string): Promise<void> {
    return this.inner.execute(sql);
  }

  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.inner.transaction((executor) => work(new StoryDeleteGateExecutor(executor, this.gate)));
  }

  async close(): Promise<void> {
    this.gate.closed = true;
    return this.inner.close();
  }
}

interface CommitAcknowledgementLossState {
  armed: boolean;
  deletedInsideTransaction: boolean;
}

class CommitAcknowledgementLostExecutor implements DatabaseExecutor {
  constructor(
    private readonly inner: DatabaseExecutor,
    readonly state: CommitAcknowledgementLossState = {
      armed: false,
      deletedInsideTransaction: false,
    },
    private readonly insideTransaction = false,
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row>> {
    if (this.state.armed && this.insideTransaction && /DELETE FROM xumo_stories/u.test(sql)) {
      this.state.deletedInsideTransaction = true;
    }
    return this.inner.query<Row>(sql, parameters);
  }

  execute(sql: string): Promise<void> {
    return this.inner.execute(sql);
  }

  async transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    const result = await this.inner.transaction((executor) => work(
      new CommitAcknowledgementLostExecutor(executor, this.state, true),
    ));
    if (this.state.armed && this.state.deletedInsideTransaction) {
      this.state.deletedInsideTransaction = false;
      throw new Error("injected commit acknowledgement loss");
    }
    return result;
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

interface StaleStoryLoadState {
  armed: boolean;
  captured: Deferred;
  release: Deferred;
  blocked: boolean;
}

class StaleStoryLoadExecutor implements DatabaseExecutor {
  constructor(
    private readonly inner: DatabaseExecutor,
    readonly state: StaleStoryLoadState = {
      armed: false,
      captured: deferred(),
      release: deferred(),
      blocked: false,
    },
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row>> {
    if (this.state.armed
      && !this.state.blocked
      && /SELECT id, owner_id, updated_at, payload FROM xumo_stories WHERE id/u.test(sql)) {
      this.state.blocked = true;
      const captured = await this.inner.query<Row>(sql, parameters);
      this.state.captured.resolve();
      await this.state.release.promise;
      return captured;
    }
    return this.inner.query<Row>(sql, parameters);
  }

  execute(sql: string): Promise<void> {
    return this.inner.execute(sql);
  }

  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.inner.transaction((executor) => work(new StaleStoryLoadExecutor(executor, this.state)));
  }

  close(): Promise<void> {
    this.state.release.resolve();
    return this.inner.close();
  }
}

interface DeletionFixture {
  seed: ReturnType<typeof createSeedStore>;
  story: ReturnType<typeof createSeedStore>["stories"][number];
  owner: ReturnType<typeof createSeedStore>["users"][number];
  reader: ReturnType<typeof createSeedStore>["users"][number];
  job: GenerationJob;
  failure: GenerationFailureObservation;
  sentinels: string[];
  feedbackIdentity: {
    id: string;
    candidateId: string;
    contentHash: string;
  };
}

function createDeletionFixture(prefix: string): DeletionFixture {
  const seed = createSeedStore();
  const story = seed.stories.find((candidate) => candidate.chapters.length > 0)!;
  const owner = seed.users.find((user) => user.id === story.ownerId)!;
  const reader = seed.users.find((user) => user.id !== owner.id)!;
  const chapter = story.chapters[0]!;
  const revision = chapter.revisions[0]!;
  const sentinel = (label: string) => `PRIVATE_${prefix}_${label}_SENTINEL`;

  story.title = sentinel("TITLE");
  story.latestExcerpt = sentinel("LATEST_EXCERPT");
  chapter.title = sentinel("CHAPTER_TITLE");
  revision.title = sentinel("REVISION_TITLE");
  revision.paragraphs = [sentinel("BODY")];
  revision.reason = sentinel("REVISION_REASON");
  revision.changeSummary = sentinel("CHANGE_SUMMARY");
  owner.activeStoryId = story.id;
  reader.activeStoryId = story.id;

  const job: GenerationJob = {
    ...seed.jobs[0]!,
    id: `job_${prefix}`,
    ownerId: owner.id,
    storyId: story.id,
    storyTitle: story.title,
    idempotencyKey: sentinel("IDEMPOTENCY"),
    status: "completed",
    candidateTrace: [{
      id: `candidate_${prefix}`,
      seed: 1,
      creativeAxis: sentinel("CANDIDATE_AXIS"),
      event: sentinel("CANDIDATE_EVENT"),
      cause: sentinel("CANDIDATE_CAUSE"),
      cost: sentinel("CANDIDATE_COST"),
      impact: sentinel("CANDIDATE_IMPACT"),
      novelty: sentinel("CANDIDATE_NOVELTY"),
      score: 1,
      status: "selected",
      reasons: [sentinel("CANDIDATE_REASON")],
    }],
    filterSummary: sentinel("FILTER"),
    contextTrace: [{
      component: "canon",
      sourceIds: [sentinel("CONTEXT")],
      estimatedTokens: 20,
    }],
    retconId: sentinel("RETCON"),
    targetEventId: sentinel("EVENT_ID"),
  };
  seed.jobs.push(job);
  const failure = createGenerationFailureObservation(
    job,
    new Error(sentinel("FAILURE_MESSAGE")),
    { id: `failure_${prefix}`, stage: "writer", terminal: true },
  );
  seed.generationFailures.push(failure);
  seed.safetyDecisions.push({
    id: `safety_${prefix}`,
    actorUserId: owner.id,
    storyId: story.id,
    surface: "chapter_output",
    decision: "allowed",
    categories: [],
    contentHash: sentinel("SAFETY_HASH"),
    createdAt: story.updatedAt,
  });
  seed.contentReports.push({
    id: `report_${prefix}`,
    reporterUserId: reader.id,
    storyId: story.id,
    reason: sentinel("REPORT"),
    status: "submitted",
    createdAt: story.updatedAt,
    updatedAt: story.updatedAt,
  });
  seed.storyCreationRequests.push({
    userId: owner.id,
    idempotencyKey: sentinel("REQUEST"),
    storyId: story.id,
    createdAt: story.updatedAt,
  });
  seed.auditEvents.unshift({
    id: `audit_${prefix}`,
    actorUserId: owner.id,
    action: "generation.failed",
    targetType: "generation",
    targetId: job.id,
    createdAt: story.updatedAt,
    metadata: { storyId: story.id, reason: sentinel("AUDIT") },
  });

  const feedbackCandidateId = "narration_candidate_" + "c".repeat(20);
  const feedbackIdentity = {
    id: "narration_feedback_" + job.id + "_" + feedbackCandidateId,
    candidateId: feedbackCandidateId,
    contentHash: "b".repeat(64),
  };
  return {
    seed,
    story,
    owner,
    reader,
    job,
    failure,
    sentinels: [
      "PRIVATE_" + prefix + "_",
      story.id,
      failure.fingerprint,
      "PRIVATE_REVIEW_IV",
      "PRIVATE_REVIEW_TAG",
      "PRIVATE_FEEDBACK_IV",
      "PRIVATE_FEEDBACK_TAG",
      feedbackIdentity.id,
      feedbackIdentity.candidateId,
      feedbackIdentity.contentHash,
    ],
    feedbackIdentity,
  };
}

async function insertLinkedDatabaseRows(pglite: PGlite, fixture: DeletionFixture): Promise<void> {
  const { story, owner, reader, job } = fixture;
  const { id: feedbackId, candidateId, contentHash } = fixture.feedbackIdentity;
  const prefix = job.id.slice("job_".length);
  await pglite.query(
    `INSERT INTO xumo_story_publications(story_id, owner_id, status, first_published_at, status_updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [story.id, owner.id],
  );
  await pglite.query(
    `INSERT INTO xumo_public_reading_progress(
       reader_user_id, story_id, chapter_id, chapter_number, scroll_progress, progress_version, updated_at
     ) VALUES ($1, $2, $3, 1, 0.5, 1, now())`,
    [reader.id, story.id, story.chapters[0]!.id],
  );
  await pglite.query(
    `INSERT INTO xumo_narration_review_cases(
       id, job_id, owner_id, content_hash, attempt, rewrite_count, status, version,
       deadline_at, payload_expires_at, candidate_metadata, assessment_metadata,
       encrypted_payload, created_at, resolved_at
     ) VALUES (
       $1, $2, $3, repeat('a', 64), 1, 0, 'resolved', 1,
       now(), now(), $4::jsonb, $5::jsonb, $6::jsonb, now(), now()
     )`,
    [
      `case_${prefix}`,
      job.id,
      owner.id,
      JSON.stringify([{ candidate: `PRIVATE_${prefix}_REVIEW_CANDIDATE_SENTINEL` }]),
      JSON.stringify([{ context: `PRIVATE_${prefix}_REVIEW_CONTEXT_SENTINEL` }]),
      JSON.stringify({ version: 1, iv: "PRIVATE_REVIEW_IV", tag: "PRIVATE_REVIEW_TAG", ciphertext: `PRIVATE_${prefix}_REVIEW_CIPHERTEXT_SENTINEL` }),
    ],
  );
  await pglite.query(
    `INSERT INTO xumo_narration_review_feedback(
       id, case_id, job_id, owner_id, candidate_id, rule_id, rule_version, location, model,
       reported_decision, decision, confidence, threshold, resolution_source, user_decision,
       rewrite_count, rewrite_succeeded, job_completed, latency_ms, content_hash,
       consented_excerpt_ciphertext, excerpt_expires_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'rule', 'v1', 'body', 'model',
       'allow', 'allow', 0.9, 0.85, 'user', 'keep', 0, true, true, 12, $6,
       $7::jsonb, now(), now(), now()
     )`,
    [
      feedbackId,
      `case_${prefix}`,
      job.id,
      owner.id,
      candidateId,
      contentHash,
      JSON.stringify({ version: 1, iv: "PRIVATE_FEEDBACK_IV", tag: "PRIVATE_FEEDBACK_TAG", ciphertext: `PRIVATE_${prefix}_REVIEW_EXCERPT_SENTINEL` }),
    ],
  );
}

async function applicationDatabaseJson(pglite: PGlite): Promise<string> {
  const tables = await pglite.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'xumo_%'
     ORDER BY table_name`,
  );
  const contents: unknown[] = [];
  for (const { table_name: tableName } of tables.rows) {
    assert.match(tableName, /^xumo_[a-z_]+$/u);
    const rows = await pglite.query<{ payload: unknown }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(target)), '[]'::jsonb) AS payload FROM ${tableName} target`,
    );
    contents.push({ tableName, payload: rows.rows[0]?.payload });
  }
  return JSON.stringify(contents);
}

async function targetDatabaseState(
  pglite: PGlite,
  fixture: DeletionFixture,
  deletionAuditId: string,
): Promise<Record<string, unknown[]>> {
  const { story, owner, reader, job } = fixture;
  const queries: Record<string, [string, unknown[]]> = {
    stories: ["SELECT to_jsonb(t) AS row FROM xumo_stories t WHERE id = $1", [story.id]],
    chapters: ["SELECT to_jsonb(t) AS row FROM xumo_chapters t WHERE story_id = $1 ORDER BY id", [story.id]],
    revisions: ["SELECT to_jsonb(t) AS row FROM xumo_chapter_revisions t WHERE story_id = $1 ORDER BY id", [story.id]],
    publications: ["SELECT to_jsonb(t) AS row FROM xumo_story_publications t WHERE story_id = $1", [story.id]],
    progress: ["SELECT to_jsonb(t) AS row FROM xumo_public_reading_progress t WHERE story_id = $1 ORDER BY reader_user_id", [story.id]],
    requests: ["SELECT to_jsonb(t) AS row FROM xumo_story_creation_requests t WHERE story_id = $1 ORDER BY user_id, idempotency_key", [story.id]],
    jobs: ["SELECT to_jsonb(t) AS row FROM xumo_generation_jobs t WHERE id = $1", [job.id]],
    failures: ["SELECT to_jsonb(t) AS row FROM xumo_generation_failure_observations t WHERE job_id = $1 ORDER BY id", [job.id]],
    reviewCases: ["SELECT to_jsonb(t) AS row FROM xumo_narration_review_cases t WHERE job_id = $1 ORDER BY id", [job.id]],
    reviewFeedback: ["SELECT to_jsonb(t) AS row FROM xumo_narration_review_feedback t WHERE job_id = $1 ORDER BY id", [job.id]],
    safety: ["SELECT to_jsonb(t) AS row FROM xumo_safety_decisions t WHERE story_id = $1 ORDER BY id", [story.id]],
    reports: ["SELECT to_jsonb(t) AS row FROM xumo_content_reports t WHERE story_id = $1 ORDER BY id", [story.id]],
    users: ["SELECT to_jsonb(t) AS row FROM xumo_users t WHERE id IN ($1, $2) ORDER BY id", [owner.id, reader.id]],
    audits: ["SELECT to_jsonb(t) AS row FROM xumo_audit_events t WHERE id IN ($1, $2) ORDER BY id", [`audit_${job.id.slice("job_".length)}`, deletionAuditId]],
  };
  const state: Record<string, unknown[]> = {};
  for (const [name, [sql, parameters]] of Object.entries(queries)) {
    const result = await pglite.query<{ row: unknown }>(sql, parameters);
    state[name] = result.rows.map((row) => row.row);
  }
  return state;
}

function hasDeletionCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && "code" in error && error.code === expected;
}

test("PostgreSQL permanently deletes content and retains only scrubbed operations", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    const fixture = createDeletionFixture("DELETE_DB");
    const { seed, story, owner, reader, job, failure, sentinels } = fixture;
    await database.saveSnapshot(seed);
    await insertLinkedDatabaseRows(pglite, fixture);

    await assert.rejects(database.deleteOwnedStory({
      ownerId: reader.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: "audit_wrong_owner",
      deletedAt: "2026-07-30T09:57:00.000Z",
    }), hasDeletionCode("story_not_found"));
    await assert.rejects(database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: "错误标题",
      auditId: "audit_wrong_title",
      deletedAt: "2026-07-30T09:58:00.000Z",
    }), hasDeletionCode("story_delete_confirmation_mismatch"));

    const afterValidationFailure = structuredClone(seed);
    afterValidationFailure.stories.find((candidate) => candidate.id === story.id)!.subtitle = "VALIDATION_DID_NOT_TOMBSTONE";
    await database.saveSnapshot(afterValidationFailure);
    const validatedStory = await pglite.query<{ subtitle: string }>(
      "SELECT subtitle FROM xumo_stories WHERE id = $1",
      [story.id],
    );
    assert.equal(validatedStory.rows[0]?.subtitle, "VALIDATION_DID_NOT_TOMBSTONE");
    await pglite.query("UPDATE xumo_generation_jobs SET status = 'running' WHERE id = $1", [job.id]);
    await assert.rejects(database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: "audit_busy_story",
      deletedAt: "2026-07-30T09:59:00.000Z",
    }), hasDeletionCode("story_delete_busy"));
    await pglite.query("UPDATE xumo_generation_jobs SET status = 'completed' WHERE id = $1", [job.id]);

    const result = await database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: "audit_story_delete_db",
      deletedAt: "2026-07-30T10:00:00.000Z",
    });
    assert.deepEqual(result, { wasCurrentStory: true, wasPublished: true, hadChapters: true });

    const requiredDeletedCounts = await Promise.all([
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_stories WHERE id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_chapters WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_chapter_revisions WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_story_publications WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_public_reading_progress WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_story_creation_requests WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_safety_decisions WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_content_reports WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_narration_review_cases WHERE job_id = $1", [job.id]),
    ]);
    assert.deepEqual(requiredDeletedCounts.map((query) => Number(query.rows[0]?.count ?? 0)), Array(9).fill(0));

    const savedJob = await pglite.query<{ story_id: string; payload: unknown }>(
      "SELECT story_id, payload FROM xumo_generation_jobs WHERE id = $1",
      [job.id],
    );
    const savedFailure = await pglite.query<{ story_id: string; fingerprint: string; payload: unknown }>(
      "SELECT story_id, fingerprint, payload FROM xumo_generation_failure_observations WHERE id = $1",
      [failure.id],
    );
    assert.equal(savedJob.rows[0]?.story_id, DELETED_STORY_PLACEHOLDER);
    assert.equal(savedFailure.rows[0]?.story_id, DELETED_STORY_PLACEHOLDER);
    assert.notEqual(savedFailure.rows[0]?.fingerprint, failure.fingerprint);

    const feedback = await pglite.query<{
      id: string;
      candidate_id: string;
      case_id: string | null;
      content_hash: string;
      consented_excerpt_ciphertext: unknown;
      excerpt_expires_at: string | null;
    }>(
      "SELECT id, candidate_id, case_id, content_hash, consented_excerpt_ciphertext, excerpt_expires_at FROM xumo_narration_review_feedback WHERE job_id = $1",
      [job.id],
    );
    assert.match(feedback.rows[0]?.id ?? "", /^narration_feedback_deleted_[0-9a-f-]{36}$/u);
    assert.match(feedback.rows[0]?.candidate_id ?? "", /^narration_candidate_deleted_[0-9a-f-]{36}$/u);
    assert.notEqual(feedback.rows[0]?.id, fixture.feedbackIdentity.id);
    assert.notEqual(feedback.rows[0]?.candidate_id, fixture.feedbackIdentity.candidateId);
    assert.equal(feedback.rows[0]?.case_id, null);
    assert.equal(feedback.rows[0]?.consented_excerpt_ciphertext, null);
    assert.equal(feedback.rows[0]?.excerpt_expires_at, null);
    assert.match(feedback.rows[0]?.content_hash ?? "", /^[0-9a-f]{64}$/u);
    assert.notEqual(feedback.rows[0]?.content_hash, "b".repeat(64));

    const users = await pglite.query<{ active_story_id: string | null }>(
      "SELECT active_story_id FROM xumo_users WHERE id IN ($1, $2)",
      [owner.id, reader.id],
    );
    assert.equal(users.rows.length, 2);
    assert.equal(users.rows.every((row) => row.active_story_id === null), true);
    const deletionAudit = await pglite.query<{ action: string; target_id: string; payload: unknown }>(
      "SELECT action, target_id, payload FROM xumo_audit_events WHERE id = 'audit_story_delete_db'",
    );
    assert.equal(deletionAudit.rows[0]?.action, "story.deleted");
    assert.equal(deletionAudit.rows[0]?.target_id, DELETED_STORY_PLACEHOLDER);
    const existingAudit = await pglite.query<{ target_id: string; payload: unknown }>(
      "SELECT target_id, payload FROM xumo_audit_events WHERE id = 'audit_DELETE_DB'",
    );
    assert.equal(existingAudit.rows[0]?.target_id, DELETED_STORY_PLACEHOLDER);

    const fullDatabase = await applicationDatabaseJson(pglite);
    for (const privateValue of sentinels) {
      assert.equal(fullDatabase.includes(privateValue), false, privateValue);
    }
  } finally {
    await database.close();
  }
});

test("PostgreSQL deletion rolls back every earlier table write when story deletion fails", async () => {
  const pglite = new PGlite();
  const failing = new ArmedFailingExecutor(new PGliteExecutor(pglite));
  const database = new PostgresDatabase(failing);
  try {
    await database.migrate();
    const fixture = createDeletionFixture("ROLLBACK");
    const { seed, story, owner } = fixture;
    await database.saveSnapshot(seed);
    await insertLinkedDatabaseRows(pglite, fixture);
    const deletionAuditId = "audit_delete_rollback";
    const before = await targetDatabaseState(pglite, fixture, deletionAuditId);
    assert.equal(Object.values(before).every((rows, index) => index === 13 || rows.length > 0), true);
    failing.failureState.armed = true;

    await assert.rejects(database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: deletionAuditId,
      deletedAt: "2026-07-30T10:00:00.000Z",
    }), /injected story deletion failure/u);

    failing.failureState.armed = false;
    assert.deepEqual(await targetDatabaseState(pglite, fixture, deletionAuditId), before);

    const recoveredSnapshot = structuredClone(seed);
    recoveredSnapshot.stories.find((candidate) => candidate.id === story.id)!.subtitle = "ROLLBACK_TOMBSTONE_REMOVED";
    await database.saveSnapshot(recoveredSnapshot);
    const savedStory = await pglite.query<{ subtitle: string }>("SELECT subtitle FROM xumo_stories WHERE id = $1", [story.id]);
    assert.equal(savedStory.rows[0]?.subtitle, "ROLLBACK_TOMBSTONE_REMOVED");
  } finally {
    await database.close();
  }
});

test("PostgreSQL locks generation jobs before evaluating a transitioned busy status", async () => {
  const pglite = new PGlite();
  const transitioning = new JobStatusTransitionExecutor(new PGliteExecutor(pglite));
  const database = new PostgresDatabase(transitioning);
  try {
    await database.migrate();
    const fixture = createDeletionFixture("JOB_STATUS_RACE");
    const { seed, story, owner, job } = fixture;
    await database.saveSnapshot(seed);
    transitioning.transitionState.armed = true;
    transitioning.transitionState.jobId = job.id;

    await assert.rejects(database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: "audit_job_status_race",
      deletedAt: "2026-07-30T10:00:00.000Z",
    }), hasDeletionCode("story_delete_busy"));

    assert.equal(transitioning.transitionState.transitioned, true);
    const lockedOutcome = await pglite.query<{ story_count: string; status: string }>(
      `SELECT
         (SELECT count(*) FROM xumo_stories WHERE id = $1)::text AS story_count,
         (SELECT status FROM xumo_generation_jobs WHERE id = $2) AS status`,
      [story.id, job.id],
    );
    assert.equal(lockedOutcome.rows[0]?.story_count, "1");
    assert.equal(lockedOutcome.rows[0]?.status, "completed");

    transitioning.transitionState.armed = false;
    const writableSnapshot = structuredClone(seed);
    writableSnapshot.stories.find((candidate) => candidate.id === story.id)!.subtitle = "BUSY_DID_NOT_TOMBSTONE";
    await database.saveSnapshot(writableSnapshot);
    const savedStory = await pglite.query<{ subtitle: string }>("SELECT subtitle FROM xumo_stories WHERE id = $1", [story.id]);
    assert.equal(savedStory.rows[0]?.subtitle, "BUSY_DID_NOT_TOMBSTONE");
  } finally {
    await database.close();
  }
});

test("an uncertain deletion blocks writes and recovers through an authoritative query", async () => {
  const pglite = new PGlite();
  const failing = new AuthorityQueryFailingExecutor(new PGliteExecutor(pglite));
  const database = new PostgresDatabase(failing);
  try {
    await database.migrate();
    const fixture = createDeletionFixture("AUTHORITY_FAILURE");
    const { seed, story, owner } = fixture;
    await database.saveSnapshot(seed);
    failing.failureState.armed = true;

    await assert.rejects(database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: "audit_authority_failure",
      deletedAt: "2026-07-30T10:00:00.000Z",
    }), /injected ambiguous story deletion failure/u);

    const existingStory = await pglite.query<{ id: string; subtitle: string }>(
      "SELECT id, subtitle FROM xumo_stories WHERE id = $1",
      [story.id],
    );
    assert.equal(existingStory.rows.length, 1);
    assert.equal(existingStory.rows[0]?.subtitle, story.subtitle);

    const blockedSnapshot = structuredClone(seed);
    blockedSnapshot.stories.find((candidate) => candidate.id === story.id)!.subtitle = "MUST_NOT_PERSIST";
    let rollbackCalled = false;
    await assert.rejects(
      database.saveSnapshot(blockedSnapshot, () => { rollbackCalled = true; }),
      /injected authoritative existence query failure/u,
    );
    assert.equal(rollbackCalled, true);
    const blockedStory = await pglite.query<{ subtitle: string }>(
      "SELECT subtitle FROM xumo_stories WHERE id = $1",
      [story.id],
    );
    assert.equal(blockedStory.rows[0]?.subtitle, story.subtitle);

    failing.failureState.armed = false;
    const recoveredProbe = await database.loadStory(owner.id, story.id);
    assert.equal(recoveredProbe?.id, story.id);
    assert.equal(recoveredProbe?.title, story.title);
    assert.equal(database.isStoryDeleted(story.id), false);

    const recoveredSnapshot = structuredClone(seed);
    recoveredSnapshot.stories.find((candidate) => candidate.id === story.id)!.subtitle = "AUTHORITY_QUERY_RECOVERED";
    await database.saveSnapshot(recoveredSnapshot);
    const recoveredStory = await pglite.query<{ subtitle: string }>(
      "SELECT subtitle FROM xumo_stories WHERE id = $1",
      [story.id],
    );
    assert.equal(recoveredStory.rows[0]?.subtitle, "AUTHORITY_QUERY_RECOVERED");
  } finally {
    await database.close();
  }
});

test("stale snapshots queued during deletion cannot reinsert any private story data", async () => {
  const pglite = new PGlite();
  const gateExecutor = new StoryDeleteGateExecutor(new PGliteExecutor(pglite));
  const database = new PostgresDatabase(gateExecutor);
  const concurrentMutations: Promise<unknown>[] = [];
  try {
    await database.migrate();
    const fixture = createDeletionFixture("STALE");
    const { seed, story, owner, job, sentinels } = fixture;
    await database.saveSnapshot(seed);
    await insertLinkedDatabaseRows(pglite, fixture);

    const deletion = database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: "audit_stale_snapshot_delete",
      deletedAt: "2026-07-30T10:00:00.000Z",
    });
    concurrentMutations.push(deletion);
    await gateExecutor.gate.reached.promise;
    const firstStaleSave = database.saveSnapshot(structuredClone(seed));
    const secondStaleSave = database.saveSnapshot(structuredClone(seed));
    concurrentMutations.push(firstStaleSave, secondStaleSave);
    gateExecutor.gate.release.resolve();
    await Promise.all(concurrentMutations);

    const forbiddenCounts = await Promise.all([
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_stories WHERE id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_chapters WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_chapter_revisions WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_story_publications WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_public_reading_progress WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_safety_decisions WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_content_reports WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_story_creation_requests WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_narration_review_cases WHERE job_id = $1", [job.id]),
    ]);
    assert.deepEqual(forbiddenCounts.map((query) => Number(query.rows[0]?.count ?? 0)), Array(9).fill(0));
    const feedback = await pglite.query<{ case_id: string | null; consented_excerpt_ciphertext: unknown }>(
      "SELECT case_id, consented_excerpt_ciphertext FROM xumo_narration_review_feedback WHERE job_id = $1",
      [job.id],
    );
    assert.equal(feedback.rows[0]?.case_id, null);
    assert.equal(feedback.rows[0]?.consented_excerpt_ciphertext, null);

    const fullDatabase = await applicationDatabaseJson(pglite);
    for (const privateValue of sentinels) {
      assert.equal(fullDatabase.includes(privateValue), false, privateValue);
    }
  } finally {
    gateExecutor.gate.release.resolve();
    await Promise.allSettled(concurrentMutations);
    await database.close();
  }
});

test("PostgreSQL close drains an in-flight queued deletion before closing its executor", async () => {
  const pglite = new PGlite();
  const gateExecutor = new StoryDeleteGateExecutor(new PGliteExecutor(pglite));
  const database = new PostgresDatabase(gateExecutor);
  const concurrentMutations: Promise<unknown>[] = [];
  let closing: Promise<void> | null = null;
  try {
    await database.migrate();
    const fixture = createDeletionFixture("CLOSE_QUEUE");
    const { seed, story, owner } = fixture;
    await database.saveSnapshot(seed);

    const deletion = database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: "audit_close_queue",
      deletedAt: "2026-07-30T10:00:00.000Z",
    });
    concurrentMutations.push(deletion);
    await gateExecutor.gate.reached.promise;

    closing = database.close();
    assert.equal(gateExecutor.gate.closed, false);
    gateExecutor.gate.release.resolve();
    await Promise.all([deletion, closing]);
    assert.equal(gateExecutor.gate.closed, true);
  } finally {
    gateExecutor.gate.release.resolve();
    await Promise.allSettled(concurrentMutations);
    if (closing) {
      await closing.catch(() => undefined);
    } else {
      await database.close();
    }
  }
});

test("a load captured before deletion cannot return or recache the story after deletion commits", async () => {
  const pglite = new PGlite();
  const staleLoadExecutor = new StaleStoryLoadExecutor(new PGliteExecutor(pglite));
  const database = new PostgresDatabase(staleLoadExecutor);
  let pendingLoad: Promise<unknown> | null = null;
  try {
    await database.migrate();
    const fixture = createDeletionFixture("LATE_LOAD");
    const { seed, story, owner } = fixture;
    await database.saveSnapshot(seed);
    staleLoadExecutor.state.armed = true;

    pendingLoad = database.loadStory(owner.id, story.id);
    await staleLoadExecutor.state.captured.promise;
    await database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: "audit_late_load_delete",
      deletedAt: "2026-07-30T10:00:00.000Z",
    });
    assert.equal(database.isStoryDeleted(story.id), true);
    staleLoadExecutor.state.release.resolve();
    assert.equal(await pendingLoad, null);
    pendingLoad = null;
  } finally {
    staleLoadExecutor.state.release.resolve();
    if (pendingLoad) await pendingLoad.catch(() => undefined);
    await database.close();
  }
});

test("commit acknowledgement loss returns committed deletion and still cleans runtime state", async () => {
  const pglite = new PGlite();
  const acknowledgementLoss = new CommitAcknowledgementLostExecutor(new PGliteExecutor(pglite));
  const database = new PostgresDatabase(acknowledgementLoss);
  try {
    await database.migrate();
    const fixture = createDeletionFixture("ACK_LOSS");
    const { seed, story, owner } = fixture;
    await database.saveSnapshot(seed);
    const runtimeStore = structuredClone(seed);
    const deleteStory = createStoryDeletionStorage({
      getDatabase: () => database,
      save: async () => assert.fail("PostgreSQL deletion must not save JSON"),
      now: () => "2026-07-30T10:00:00.000Z",
      createAuditId: () => "audit_acknowledgement_loss",
    });
    acknowledgementLoss.state.armed = true;

    const result = await deleteStory(runtimeStore, {
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
    });

    assert.deepEqual(result, {
      wasCurrentStory: true,
      wasPublished: false,
      hadChapters: true,
    });
    assert.equal(runtimeStore.stories.some((candidate) => candidate.id === story.id), false);
    assert.equal(database.isStoryDeleted(story.id), true);
    assert.equal(await database.loadStory(owner.id, story.id), null);
    const authoritative = await pglite.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM xumo_stories WHERE id = $1",
      [story.id],
    );
    assert.equal(authoritative.rows[0]?.count, "0");
  } finally {
    await database.close();
  }
});
