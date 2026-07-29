import assert from "node:assert/strict";
import test from "node:test";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { createAuditEvent, createAuthSession, createReaderAccount, hashSessionToken } from "../server/auth";
import { PostgresDatabase } from "../server/database/postgres";
import type { DatabaseExecutor, QueryResult } from "../server/database/types";
import { createGenerationFailureObservation } from "../server/failureTelemetry";
import type { NarrationReviewFeedbackRecord } from "../server/narrationReviewState";
import { createSeedStore } from "../server/seed";

interface PGliteQueryable {
  query<Row>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}

class PGliteExecutor implements DatabaseExecutor {
  constructor(private readonly database: PGliteInterface, private readonly queryable: PGliteQueryable = database) {}

  async query<Row = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.queryable.query<Row>(sql, parameters);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async execute(sql: string): Promise<void> {
    await this.queryable.exec(sql);
  }

  async transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.database.transaction((transaction: Transaction) => work(new PGliteExecutor(this.database, transaction)));
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}

test("PostgreSQL persistence migrates, paginates books, and reconstructs chapter revisions", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    await database.migrate();
    assert.equal(await database.isEmpty(), true);

    const seed = createSeedStore();
    await database.saveSnapshot(seed);
    assert.deepEqual(await database.counts(), {
      users: seed.users.length,
      stories: seed.stories.length,
      chapters: seed.stories.reduce((total, story) => total + story.chapters.length, 0),
      revisions: seed.stories.reduce(
        (total, story) => total + story.chapters.reduce((chapterTotal, chapter) => chapterTotal + chapter.revisions.length, 0),
        0,
      ),
    });

    const firstPage = await database.listStories("user_demo", 2);
    assert.equal(firstPage.stories.length, 2);
    assert.equal(firstPage.totalStories, 3);
    assert.ok(firstPage.nextCursor);
    const secondPage = await database.listStories("user_demo", 2, firstPage.nextCursor!);
    assert.equal(secondPage.stories.length, 1);
    assert.equal(new Set([...firstPage.stories, ...secondPage.stories].map((story) => story.id)).size, 3);

    const source = seed.stories.find((story) => story.id === "story_black_tide")!;
    const restored = await database.loadStory(source.ownerId, source.id);
    assert.ok(restored);
    assert.equal(restored.title, source.title);
    assert.equal(restored.chapters.length, source.chapters.length);
    assert.deepEqual(restored.chapters[0].revisions[0].paragraphs, source.chapters[0].revisions[0].paragraphs);
    assert.equal(await database.loadStory("user_reader", source.id), null);

    const failure = createGenerationFailureObservation(
      seed.jobs[0],
      new Error("正文没有实际兑现阅读体验证据。"),
      { stage: "章节质量校验", terminal: false, id: "failure_database_test" },
    );
    seed.generationFailures.unshift(failure);
    await database.saveSnapshot(seed);
    const runtime = await database.loadRuntimeStore();
    assert.equal(runtime.generationFailures[0]?.id, failure.id);
    const failureRows = await pglite.query<{ reason_code: string; terminal: boolean }>(
      "SELECT reason_code, terminal FROM xumo_generation_failure_observations WHERE id = $1",
      [failure.id],
    );
    assert.deepEqual(failureRows.rows[0], { reason_code: "experience_quality_gate", terminal: false });
    const [pattern] = await database.listGenerationFailurePatterns(10);
    assert.equal(pattern.reasonCode, "experience_quality_gate");
    assert.equal(pattern.occurrences, 1);
    assert.equal(pattern.recoveredJobs, 1);
  } finally {
    await database.close();
  }
});

test("PostgreSQL registration is unique and sessions resolve without loading every user", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    const user = createReaderAccount("New.Reader@Example.com", "strong-password-2026", "新读者");
    const { session } = createAuthSession(user.id);
    const event = createAuditEvent(user.id, "auth.register", "auth", user.id, { role: "reader" });
    await database.register(user, session, event);

    const byEmail = await database.findUserByEmail("new.reader@example.com");
    assert.equal(byEmail?.id, user.id);
    assert.equal(byEmail?.role, "reader");
    assert.equal((await database.findUserBySessionTokenHash(session.tokenHash))?.id, user.id);

    assert.equal(await database.reserveIdempotencyKey(user.id, "request-12345678"), true);
    assert.equal(await database.reserveIdempotencyKey(user.id, "request-12345678"), false);
    assert.equal(await database.hasIdempotencyKey(user.id, "request-12345678"), true);
    await database.releaseIdempotencyKey(user.id, "request-12345678");
    assert.equal(await database.hasIdempotencyKey(user.id, "request-12345678"), false);

    const duplicate = createReaderAccount("NEW.READER@example.com", "another-password-2026", "另一个人");
    const duplicateSession = createAuthSession(duplicate.id).session;
    await assert.rejects(
      database.register(duplicate, duplicateSession, createAuditEvent(duplicate.id, "auth.register", "auth", duplicate.id)),
      /已经注册/,
    );

    await database.deleteSession(session.tokenHash);
    assert.equal(await database.findUserBySessionTokenHash(hashSessionToken("not-the-token")), null);
    assert.equal(await database.findUserBySessionTokenHash(session.tokenHash), null);
  } finally {
    await database.close();
  }
});

test("PostgreSQL runtime load tolerates audit payloads missing structural table fields", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    const insertLegacyAudit = async (id: string, createdAt: string) => {
      await pglite.query(
        `INSERT INTO xumo_audit_events(
          id, actor_user_id, action, target_type, target_id, created_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          id,
          "user_demo",
          "connection.update",
          "model_connection",
          "conn_test",
          createdAt,
          JSON.stringify({ source: "legacy-production-maintenance", auditId: id }),
        ],
      );
    };
    await insertLegacyAudit("audit_legacy_a", "2026-07-22T10:00:00.000Z");
    await insertLegacyAudit("audit_legacy_b", "2026-07-22T10:01:00.000Z");

    const runtime = await database.loadRuntimeStore();
    runtime.auditEvents.unshift(
      createAuditEvent("user_demo", "story.create", "story", "story_test"),
    );
    await database.saveSnapshot(runtime);

    const restored = runtime.auditEvents.filter((event) => event.targetId === "conn_test");
    assert.deepEqual(restored.map((event) => event.id), ["audit_legacy_b", "audit_legacy_a"]);
    assert.ok(restored.every((event) => event.targetType === "connection"));
    assert.equal(restored[0]?.metadata.auditId, "audit_legacy_b");
  } finally {
    await database.close();
  }
});

test("narration review metrics aggregate structured feedback without exposing excerpts", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    const seed = createSeedStore();
    const baseJob = seed.jobs[0];
    assert.ok(baseJob);
    const jobOwners = ["user_demo", "user_demo", "user_demo", "user_demo", "user_reader", "user_demo"];
    const jobs = jobOwners.map((ownerId, index) => ({
      ...structuredClone(baseJob),
      id: `job_narration_metric_${index + 1}`,
      ownerId,
      storyId: `story_narration_metric_${index + 1}`,
      idempotencyKey: `narration-metric-${index + 1}`,
      status: "completed" as const,
      createdAt: `2026-07-24T12:0${index}:00.000Z`,
    }));
    seed.jobs.unshift(...jobs);
    await database.saveSnapshot(seed);

    const sensitiveSentence = "雨停后，半本卷边残诗稿被放在桌上。";
    const feedback = (
      index: number,
      overrides: Partial<NarrationReviewFeedbackRecord>,
    ): NarrationReviewFeedbackRecord => ({
      id: `narration_feedback_metric_${index}`,
      caseId: null,
      jobId: jobs[index - 1]!.id,
      ownerId: jobs[index - 1]!.ownerId,
      candidateId: `candidate_metric_${index}`,
      ruleId: "author_side_narration",
      ruleVersion: "2026-07-24.1",
      location: "body",
      model: "reviewer-model",
      reportedDecision: "ask_user",
      decision: "ask_user",
      confidence: 0.6,
      threshold: 0.85,
      resolutionSource: "user",
      userDecision: null,
      rewriteCount: 0,
      rewriteSucceeded: null,
      jobCompleted: true,
      latencyMs: 1000 + index,
      contentHash: index.toString(16).padStart(64, "0"),
      consentedExcerptCiphertext: index === 2 ? {
        version: 1,
        iv: "metric-iv",
        tag: "metric-tag",
        ciphertext: sensitiveSentence,
      } : null,
      excerptExpiresAt: index === 2 ? "2026-10-22T12:00:00.000Z" : null,
      createdAt: `2026-07-24T12:0${index}:00.000Z`,
      updatedAt: `2026-07-24T12:0${index}:30.000Z`,
      ...overrides,
    });

    await database.upsertNarrationReviewFeedback(feedback(1, {
      reportedDecision: "allow",
      decision: "allow",
      confidence: 0.96,
      resolutionSource: "automatic",
    }));
    await database.upsertNarrationReviewFeedback(feedback(2, { userDecision: "keep" }));
    await database.upsertNarrationReviewFeedback(feedback(3, {
      userDecision: "rewrite",
      rewriteCount: 1,
      rewriteSucceeded: true,
    }));
    await database.upsertNarrationReviewFeedback(feedback(4, {
      resolutionSource: "timeout",
      rewriteCount: 1,
      rewriteSucceeded: false,
      jobCompleted: false,
    }));
    await database.upsertNarrationReviewFeedback(feedback(5, { userDecision: "keep" }));
    await database.upsertNarrationReviewFeedback(feedback(6, {
      ruleVersion: "2026-07-24.2",
      reportedDecision: "rewrite",
      decision: "rewrite",
      confidence: 0.93,
      resolutionSource: "automatic",
      rewriteCount: 1,
      rewriteSucceeded: true,
    }));

    const metrics = await database.listNarrationReviewMetrics(20);
    assert.equal(metrics.length, 2);
    assert.deepEqual(metrics[0], {
      key: "author_side_narration:2026-07-24.2",
      ruleId: "author_side_narration",
      ruleVersion: "2026-07-24.2",
      candidates: 1,
      modelAllow: 0,
      modelRewrite: 1,
      modelAskUser: 0,
      userKeep: 0,
      userRewrite: 0,
      timeoutRewrite: 0,
      rewriteSucceeded: 1,
      finalJobsCompleted: 1,
      lastSeenAt: "2026-07-24T12:06:30.000Z",
    });
    assert.deepEqual(metrics[1], {
      key: "author_side_narration:2026-07-24.1",
      ruleId: "author_side_narration",
      ruleVersion: "2026-07-24.1",
      candidates: 5,
      modelAllow: 1,
      modelRewrite: 0,
      modelAskUser: 4,
      userKeep: 2,
      userRewrite: 1,
      timeoutRewrite: 1,
      rewriteSucceeded: 1,
      finalJobsCompleted: 4,
      lastSeenAt: "2026-07-24T12:05:30.000Z",
    });
    const serialized = JSON.stringify(metrics);
    assert.equal(serialized.includes(sensitiveSentence), false);
    assert.equal(serialized.includes("ciphertext"), false);
    assert.equal(metrics[1]!.userKeep / metrics[1]!.candidates, 0.4);
  } finally {
    await database.close();
  }
});
