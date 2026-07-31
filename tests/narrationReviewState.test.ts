import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { PostgresDatabase } from "../server/database/postgres";
import type { DatabaseExecutor, QueryResult } from "../server/database/types";
import {
  normalizeNarrationAssessmentMetadata,
  normalizeNarrationCandidateMetadata,
  openNarrationReviewExcerpt,
  openNarrationReviewPayload,
  redactNarrationReviewContext,
  sealNarrationReviewExcerpt,
  sealNarrationReviewPayload,
  type NarrationReviewCaseRecord,
  type NarrationReviewFeedbackRecord,
} from "../server/narrationReviewState";
import { createSeedStore } from "../server/seed";
import type { GenerationJob } from "../src/types";

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

const key = Buffer.alloc(32, 7);
const loadKey = async () => key;
const sensitiveSentence = "他从旧箱底抽出半本卷边残诗稿，纸页间还夹着母亲留下的药方。";
const contentHash = createHash("sha256").update(sensitiveSentence, "utf8").digest("hex");

function reviewIdentity(overrides: Partial<{ caseId: string; jobId: string; ownerId: string; contentHash: string }> = {}) {
  return {
    caseId: overrides.caseId ?? "narration_case_test",
    jobId: overrides.jobId ?? "job_test",
    ownerId: overrides.ownerId ?? "user_demo",
    contentHash: overrides.contentHash ?? contentHash,
  };
}

test("narration review payload encryption binds case, job, owner, and content hash", async () => {
  const identity = reviewIdentity();
  const payload = {
    candidates: [{
      id: "narration_candidate_test",
      sentence: sensitiveSentence,
      previousSentence: "雨声敲着窗纸。",
    }],
    checkpoint: { attempt: 1, accumulatedTokens: 3200 },
  };
  const envelope = await sealNarrationReviewPayload(identity, payload, loadKey);
  assert.equal(JSON.stringify(envelope).includes("半本卷边残诗稿"), false);
  assert.deepEqual(await openNarrationReviewPayload(identity, envelope, loadKey), payload);

  for (const wrongIdentity of [
    reviewIdentity({ caseId: "narration_case_other" }),
    reviewIdentity({ jobId: "job_other" }),
    reviewIdentity({ ownerId: "user_other" }),
    reviewIdentity({ contentHash: "f".repeat(64) }),
  ]) {
    await assert.rejects(
      openNarrationReviewPayload(wrongIdentity, envelope, loadKey),
      (error: unknown) => error instanceof Error &&
        (error as Error & { code?: string }).code === "narration_review_state_unavailable" &&
        !error.message.includes(sensitiveSentence),
    );
  }
});

test("consented review context is bounded, redacted, purpose-bound, and encrypted", async () => {
  const identity = reviewIdentity({ caseId: "narration_case_excerpt" });
  const candidates = [{
    id: "candidate_excerpt",
    ruleId: "author_facing_narration",
    ruleVersion: "narration-candidates-v1",
    location: "body" as const,
    matchedText: "本卷",
    matchStart: 4,
    matchEnd: 6,
    sentenceStart: 0,
    previousSentence: "联系 reader@example.com，Bearer abcdefghijklmnop。",
    sentence: "半本卷边残诗稿旁写着 sk-1234567890 和 user_private123。",
    nextSentence: `详情在 https://secret.example/path。${"长".repeat(800)}`,
    contentHash,
  }];
  const redacted = redactNarrationReviewContext(candidates);
  assert.ok(Array.from(redacted).length <= 600);
  assert.match(redacted, /\[REDACTED_EMAIL\]/);
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /sk-\[REDACTED\]/);
  assert.match(redacted, /\[REDACTED_ID\]/);
  assert.match(redacted, /\[REDACTED_URL\]/);
  assert.equal(redacted.includes("reader@example.com"), false);
  assert.equal(redacted.includes("sk-1234567890"), false);

  const envelope = await sealNarrationReviewExcerpt(identity, candidates, loadKey);
  assert.equal(JSON.stringify(envelope).includes("半本卷边残诗稿"), false);
  assert.equal(await openNarrationReviewExcerpt(identity, envelope, loadKey), redacted);
  await assert.rejects(
    openNarrationReviewExcerpt(
      reviewIdentity({ caseId: "narration_case_wrong_excerpt" }),
      envelope,
      loadKey,
    ),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "narration_review_state_unavailable",
  );
});

test("metadata normalization strips all sentence and reviewer-reason plaintext", () => {
  assert.deepEqual(normalizeNarrationCandidateMetadata([{
    id: "candidate_1",
    ruleId: "author_facing_narration",
    ruleVersion: "v1",
    location: "body",
    sentence: sensitiveSentence,
    matchedText: "本卷",
  }]), [{
    id: "candidate_1",
    ruleId: "author_facing_narration",
    ruleVersion: "v1",
    location: "body",
  }]);
  assert.deepEqual(normalizeNarrationAssessmentMetadata([{
    candidateId: "candidate_1",
    reportedDecision: "ask_user",
    decision: "ask_user",
    confidence: 0.72,
    worldInternal: true,
    writingProcessReference: true,
    reason: `模型复述了：${sensitiveSentence}`,
  }]), [{
    candidateId: "candidate_1",
    reportedDecision: "ask_user",
    decision: "ask_user",
    confidence: 0.72,
    worldInternal: true,
    writingProcessReference: true,
  }]);
});

test("PostgreSQL pauses atomically, enforces owner scope, and claims one decision with CAS", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    await database.migrate();
    const store = createSeedStore();
    const sourceJob = store.jobs[0]!;
    sourceJob.status = "running";
    await database.saveSnapshot(store);
    const job: GenerationJob = {
      ...sourceJob,
      status: "awaiting_user_review" as GenerationJob["status"],
    };
    const identity = reviewIdentity({ jobId: job.id, ownerId: job.ownerId });
    const encryptedPayload = await sealNarrationReviewPayload(identity, {
      candidates: [{
        id: "candidate_database",
        matchedText: "本卷",
        sentence: sensitiveSentence,
      }],
      checkpoint: { attempt: 1, connectionId: job.connectionId },
    }, loadKey);
    const review: NarrationReviewCaseRecord = {
      ...identity,
      id: identity.caseId,
      attempt: 1,
      rewriteCount: 0,
      status: "pending",
      version: 1,
      deadlineAt: "2026-07-24T12:01:30.000Z",
      payloadExpiresAt: "2026-07-25T12:00:00.000Z",
      decisionSource: null,
      candidateMetadata: normalizeNarrationCandidateMetadata([{
        id: "candidate_database",
        ruleId: "author_facing_narration",
        ruleVersion: "narration-candidates-v1",
        location: "body",
        sentence: sensitiveSentence,
      }]),
      assessmentMetadata: normalizeNarrationAssessmentMetadata([{
        candidateId: "candidate_database",
        reportedDecision: "ask_user",
        decision: "ask_user",
        confidence: 0.61,
        worldInternal: true,
        writingProcessReference: true,
        reason: sensitiveSentence,
      }]),
      encryptedPayload,
      createdAt: "2026-07-24T12:00:00.000Z",
      resolvedAt: null,
    };

    await database.pauseOpeningForNarrationReview(job, review);
    const persistedJob = await pglite.query<{ status: string; payload: unknown }>(
      "SELECT status, payload FROM xumo_generation_jobs WHERE id = $1",
      [job.id],
    );
    assert.equal(persistedJob.rows[0]?.status, "awaiting_user_review");
    assert.equal((persistedJob.rows[0]?.payload as GenerationJob).status, "awaiting_user_review");

    const plaintextScan = await pglite.query<{
      candidate_metadata: unknown;
      assessment_metadata: unknown;
      encrypted_payload: unknown;
    }>(
      `SELECT candidate_metadata, assessment_metadata, encrypted_payload
       FROM xumo_narration_review_cases WHERE id = $1`,
      [review.id],
    );
    assert.equal(JSON.stringify(plaintextScan.rows).includes("半本卷边残诗稿"), false);
    assert.equal(JSON.stringify(plaintextScan.rows).includes("模型复述"), false);

    assert.equal(await database.getNarrationReviewCaseForOwner("user_other", job.id), null);
    const loaded = await database.getNarrationReviewCaseForOwner(job.ownerId, job.id);
    assert.ok(loaded?.encryptedPayload);
    const restored = await openNarrationReviewPayload<{ candidates: Array<{ sentence: string }> }>(
      loaded,
      loaded.encryptedPayload,
      loadKey,
    );
    assert.equal(restored.candidates[0]?.sentence, sensitiveSentence);

    const claimBase = {
      id: review.id,
      expectedVersion: review.version,
      contentHash: review.contentHash,
      decidedAt: "2026-07-24T12:00:30.000Z",
    } as const;
    assert.equal(await database.claimNarrationReviewDecision({
      ...claimBase,
      ownerId: "user_other",
      status: "kept",
      decisionSource: "user",
    }), null);
    assert.equal(await database.claimNarrationReviewDecision({
      ...claimBase,
      ownerId: job.ownerId,
      contentHash: "a".repeat(64),
      status: "kept",
      decisionSource: "user",
    }), null);
    assert.equal(await database.claimNarrationReviewDecision({
      ...claimBase,
      ownerId: job.ownerId,
      expectedVersion: 2,
      status: "kept",
      decisionSource: "user",
    }), null);

    const decisions = await Promise.all([
      database.claimNarrationReviewDecision({
        ...claimBase,
        ownerId: job.ownerId,
        status: "kept",
        decisionSource: "user",
      }),
      database.claimNarrationReviewDecision({
        ...claimBase,
        ownerId: job.ownerId,
        status: "rewrite_requested",
        decisionSource: "user",
      }),
    ]);
    assert.equal(decisions.filter(Boolean).length, 1);
    assert.equal(decisions.find(Boolean)?.version, 2);

    assert.equal(await database.resolveNarrationReviewCase(review.id, "resolved", "2026-07-24T12:01:00.000Z"), true);
    const resolved = await pglite.query<{
      status: string;
      encrypted_payload: unknown;
      candidate_metadata: unknown;
    }>(
      "SELECT status, encrypted_payload, candidate_metadata FROM xumo_narration_review_cases WHERE id = $1",
      [review.id],
    );
    assert.equal(resolved.rows[0]?.status, "resolved");
    assert.equal(resolved.rows[0]?.encrypted_payload, null);
    assert.equal(JSON.stringify(resolved.rows[0]?.candidate_metadata).includes("candidate_database"), true);
    const timeoutIdentity = reviewIdentity({
      caseId: "narration_case_timeout",
      jobId: job.id,
      ownerId: job.ownerId,
    });
    const timeoutReview: NarrationReviewCaseRecord = {
      ...review,
      ...timeoutIdentity,
      id: timeoutIdentity.caseId,
      status: "pending",
      version: 1,
      decisionSource: null,
      encryptedPayload: await sealNarrationReviewPayload(
        timeoutIdentity,
        { checkpoint: { attempt: 1 }, candidates: [{ id: "candidate_database" }] },
        loadKey,
      ),
      deadlineAt: "2026-07-24T12:02:00.000Z",
      payloadExpiresAt: "2026-07-24T12:05:00.000Z",
      createdAt: "2026-07-24T12:01:10.000Z",
      resolvedAt: null,
    };
    await database.pauseOpeningForNarrationReview(job, timeoutReview);
    const expiredClaims = await database.claimExpiredNarrationReviews(
      "2026-07-24T12:02:00.000Z",
      10,
    );
    assert.equal(expiredClaims.length, 1);
    assert.equal(expiredClaims[0]?.status, "timeout_rewrite");
    assert.equal(expiredClaims[0]?.version, 2);

    const replacementIdentity = reviewIdentity({
      caseId: "narration_case_replacement",
      jobId: job.id,
      ownerId: job.ownerId,
    });
    const replacement: NarrationReviewCaseRecord = {
      ...timeoutReview,
      ...replacementIdentity,
      id: replacementIdentity.caseId,
      attempt: 2,
      rewriteCount: 1,
      status: "pending",
      version: 1,
      decisionSource: null,
      encryptedPayload: await sealNarrationReviewPayload(
        replacementIdentity,
        { checkpoint: { attempt: 2 }, candidates: [{ id: "candidate_database" }] },
        loadKey,
      ),
      deadlineAt: "2026-07-24T12:04:00.000Z",
      payloadExpiresAt: "2026-07-24T12:05:00.000Z",
      createdAt: "2026-07-24T12:02:10.000Z",
      resolvedAt: null,
    };
    assert.equal(await database.replaceNarrationReviewCase(
      timeoutReview.id,
      job,
      replacement,
      "2026-07-24T12:02:10.000Z",
    ), true);
    assert.deepEqual(
      (await database.listRecoverableNarrationReviews()).map((item) => item.id),
      [replacement.id],
    );
    assert.equal(await database.failExpiredNarrationReviewCase(
      replacement.id,
      "2026-07-24T12:04:59.999Z",
    ), false);
    assert.equal(await database.failExpiredNarrationReviewCase(
      replacement.id,
      "2026-07-24T12:05:00.000Z",
    ), true);

    const feedback: NarrationReviewFeedbackRecord = {
      id: "narration_feedback_test",
      caseId: replacement.id,
      jobId: job.id,
      ownerId: job.ownerId,
      candidateId: "candidate_database",
      ruleId: "author_facing_narration",
      ruleVersion: "narration-candidates-v1",
      location: "body",
      model: job.model,
      reportedDecision: "ask_user",
      decision: "ask_user",
      confidence: 0.61,
      threshold: 0.85,
      resolutionSource: "timeout",
      userDecision: null,
      rewriteCount: 1,
      rewriteSucceeded: false,
      jobCompleted: false,
      latencyMs: 90000,
      contentHash,
      consentedExcerptCiphertext: await sealNarrationReviewPayload(
        replacementIdentity,
        { excerpt: "redacted context only" },
        loadKey,
      ),
      excerptExpiresAt: "2026-10-22T12:05:00.000Z",
      createdAt: "2026-07-24T12:05:00.000Z",
      updatedAt: "2026-07-24T12:05:00.000Z",
    };
    await database.upsertNarrationReviewFeedback(feedback);
    assert.deepEqual(
      await database.deleteExpiredNarrationReviewData("2026-10-22T12:05:00.000Z"),
      { payloads: 0, excerpts: 1 },
    );
    const cleanedFeedback = await pglite.query<{
      consented_excerpt_ciphertext: unknown;
      excerpt_expires_at: unknown;
    }>(
      "SELECT consented_excerpt_ciphertext, excerpt_expires_at FROM xumo_narration_review_feedback WHERE id = $1",
      [feedback.id],
    );
    assert.equal(cleanedFeedback.rows[0]?.consented_excerpt_ciphertext, null);
    assert.equal(cleanedFeedback.rows[0]?.excerpt_expires_at, null);
  } finally {
    await database.close();
  }
});
