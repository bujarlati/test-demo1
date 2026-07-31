import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationJob } from "../src/types";
import { PostgresDatabase } from "../server/database/postgres";
import type {
  NarrationReviewCaseRecord,
  NarrationReviewFeedbackRecord,
} from "../server/narrationReviewState";
import { createSeedStore } from "../server/seed";
import { DELETED_STORY_PLACEHOLDER } from "../server/storyDeletion";
import { PGlite, PGliteExecutor } from "./helpers/pglite";

interface Harness {
  pglite: PGlite;
  database: PostgresDatabase;
  story: ReturnType<typeof createSeedStore>["stories"][number];
  owner: ReturnType<typeof createSeedStore>["users"][number];
  job: GenerationJob;
}

async function createHarness(
  suffix: string,
  status: GenerationJob["status"] = "completed",
): Promise<Harness> {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  await database.migrate();
  const store = createSeedStore();
  const story = store.stories.find((candidate) => candidate.chapters.length > 0)!;
  const owner = store.users.find((candidate) => candidate.id === story.ownerId)!;
  const sourceJob = store.jobs.find((candidate) => candidate.storyId === story.id) ?? store.jobs[0]!;
  const job: GenerationJob = {
    ...sourceJob,
    id: `job_narration_delete_${suffix}`,
    ownerId: owner.id,
    storyId: story.id,
    storyTitle: story.title,
    status,
    createdAt: "2026-07-30T10:00:00.000Z",
  };
  store.jobs = store.jobs.filter((candidate) => candidate.storyId !== story.id);
  store.jobs.push(job);
  await database.saveSnapshot(store);
  return { pglite, database, story, owner, job };
}

function reviewFor(
  job: GenerationJob,
  suffix: string,
  attempt = 1,
): NarrationReviewCaseRecord {
  const caseId = `narration_case_delete_${suffix}`;
  return {
    id: caseId,
    caseId,
    jobId: job.id,
    ownerId: job.ownerId,
    contentHash: attempt === 1 ? "a".repeat(64) : "b".repeat(64),
    attempt,
    rewriteCount: attempt - 1,
    status: "pending",
    version: 1,
    deadlineAt: "2026-07-30T10:05:00.000Z",
    payloadExpiresAt: "2026-07-31T10:00:00.000Z",
    decisionSource: null,
    candidateMetadata: [{
      id: `candidate_${suffix}`,
      ruleId: "author_facing_narration",
      ruleVersion: "narration-candidates-v1",
      location: "body",
    }],
    assessmentMetadata: [{
      candidateId: `candidate_${suffix}`,
      reportedDecision: "ask_user",
      decision: "ask_user",
      confidence: 0.75,
      worldInternal: true,
      writingProcessReference: true,
    }],
    encryptedPayload: {
      version: 1,
      iv: `PRIVATE_${suffix}_IV`,
      tag: `PRIVATE_${suffix}_TAG`,
      ciphertext: `PRIVATE_${suffix}_REVIEW_CIPHERTEXT`,
    },
    createdAt: "2026-07-30T10:00:00.000Z",
    resolvedAt: null,
  };
}

function feedbackFor(
  job: GenerationJob,
  suffix: string,
): NarrationReviewFeedbackRecord {
  return {
    id: `narration_feedback_delete_${suffix}`,
    caseId: null,
    jobId: job.id,
    ownerId: job.ownerId,
    candidateId: `candidate_${suffix}`,
    ruleId: "author_facing_narration",
    ruleVersion: "narration-candidates-v1",
    location: "body",
    model: job.model,
    reportedDecision: "ask_user",
    decision: "ask_user",
    confidence: 0.75,
    threshold: 0.85,
    resolutionSource: "automatic",
    userDecision: null,
    rewriteCount: 0,
    rewriteSucceeded: null,
    jobCompleted: true,
    latencyMs: 100,
    contentHash: "c".repeat(64),
    consentedExcerptCiphertext: {
      version: 1,
      iv: `PRIVATE_${suffix}_EXCERPT_IV`,
      tag: `PRIVATE_${suffix}_EXCERPT_TAG`,
      ciphertext: `PRIVATE_${suffix}_EXCERPT_CIPHERTEXT`,
    },
    excerptExpiresAt: "2026-10-30T10:00:00.000Z",
    createdAt: "2026-07-30T10:01:00.000Z",
    updatedAt: "2026-07-30T10:01:00.000Z",
  };
}

async function deleteHarnessStory(harness: Harness, suffix: string): Promise<void> {
  await harness.database.deleteOwnedStory({
    ownerId: harness.owner.id,
    storyId: harness.story.id,
    confirmationTitle: harness.story.title,
    auditId: `audit_narration_delete_${suffix}`,
    deletedAt: "2026-07-30T10:02:00.000Z",
  });
}

function hasNarrationStateCode(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "narration_review_state_unavailable";
}

test("deletion before feedback makes the stale writer a no-op", async () => {
  const harness = await createHarness("feedback_after_delete");
  try {
    await deleteHarnessStory(harness, "feedback_after_delete");
    const feedback = feedbackFor(harness.job, "feedback_after_delete");
    await harness.database.upsertNarrationReviewFeedback(feedback);

    const saved = await harness.pglite.query<{ story_id: string; payload: unknown; feedback_count: string }>(
      `SELECT story_id, payload,
         (SELECT count(*) FROM xumo_narration_review_feedback WHERE job_id = $1)::text AS feedback_count
       FROM xumo_generation_jobs WHERE id = $1`,
      [harness.job.id],
    );
    assert.equal(saved.rows[0]?.story_id, DELETED_STORY_PLACEHOLDER);
    assert.equal(saved.rows[0]?.feedback_count, "0");
    assert.equal(JSON.stringify(saved.rows[0]?.payload).includes(feedback.contentHash), false);
    assert.equal(JSON.stringify(saved.rows[0]?.payload).includes("PRIVATE_feedback_after_delete"), false);
  } finally {
    await harness.database.close();
  }
});

test("feedback committed before deletion is scrubbed by deletion", async () => {
  const harness = await createHarness("feedback_before_delete");
  try {
    const feedback = feedbackFor(harness.job, "feedback_before_delete");
    await harness.database.upsertNarrationReviewFeedback(feedback);
    await deleteHarnessStory(harness, "feedback_before_delete");

    const saved = await harness.pglite.query<{
      content_hash: string;
      consented_excerpt_ciphertext: unknown;
      excerpt_expires_at: unknown;
    }>(
      `SELECT content_hash, consented_excerpt_ciphertext, excerpt_expires_at
       FROM xumo_narration_review_feedback WHERE id = $1`,
      [feedback.id],
    );
    assert.equal(saved.rows.length, 1);
    assert.notEqual(saved.rows[0]?.content_hash, feedback.contentHash);
    assert.equal(saved.rows[0]?.consented_excerpt_ciphertext, null);
    assert.equal(saved.rows[0]?.excerpt_expires_at, null);
  } finally {
    await harness.database.close();
  }
});

test("deletion before a stale pause rejects without resurrecting review state", async () => {
  const harness = await createHarness("pause_after_delete");
  try {
    await deleteHarnessStory(harness, "pause_after_delete");
    const staleJob = {
      ...harness.job,
      status: "awaiting_user_review" as const,
      storyTitle: "PRIVATE_STALE_PAUSE_TITLE",
    };
    const review = reviewFor(staleJob, "pause_after_delete");
    await assert.rejects(
      harness.database.pauseOpeningForNarrationReview(staleJob, review),
      hasNarrationStateCode,
    );

    const saved = await harness.pglite.query<{ story_id: string; payload: unknown; case_count: string }>(
      `SELECT story_id, payload,
         (SELECT count(*) FROM xumo_narration_review_cases WHERE job_id = $1)::text AS case_count
       FROM xumo_generation_jobs WHERE id = $1`,
      [harness.job.id],
    );
    assert.equal(saved.rows[0]?.story_id, DELETED_STORY_PLACEHOLDER);
    assert.equal(saved.rows[0]?.case_count, "0");
    assert.equal(JSON.stringify(saved.rows[0]?.payload).includes("PRIVATE_STALE_PAUSE_TITLE"), false);
    assert.equal(JSON.stringify(saved.rows[0]?.payload).includes("PRIVATE_pause_after_delete"), false);
  } finally {
    await harness.database.close();
  }
});

test("deletion before replacement returns false without creating a case", async () => {
  const harness = await createHarness("replace_after_delete");
  try {
    await deleteHarnessStory(harness, "replace_after_delete");
    const staleJob = { ...harness.job, status: "awaiting_user_review" as const };
    const replacement = reviewFor(staleJob, "replace_after_delete", 2);
    assert.equal(await harness.database.replaceNarrationReviewCase(
      "missing_old_case",
      staleJob,
      replacement,
      "2026-07-30T10:03:00.000Z",
    ), false);
    const cases = await harness.pglite.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM xumo_narration_review_cases WHERE job_id = $1",
      [harness.job.id],
    );
    assert.equal(cases.rows[0]?.count, "0");
  } finally {
    await harness.database.close();
  }
});

test("a stale opening-pending replacement cannot rewrite a real story binding", async () => {
  const harness = await createHarness("binding_mismatch", "running");
  try {
    const liveJob = { ...harness.job, status: "awaiting_user_review" as const };
    const firstReview = reviewFor(liveJob, "binding_mismatch_first");
    await harness.database.pauseOpeningForNarrationReview(liveJob, firstReview);

    const staleJob = {
      ...liveJob,
      storyId: `opening_pending_${liveJob.id}`,
      storyTitle: "PRIVATE_STALE_PENDING_TITLE",
    };
    const replacement = reviewFor(staleJob, "binding_mismatch_replacement", 2);
    assert.equal(await harness.database.replaceNarrationReviewCase(
      firstReview.id,
      staleJob,
      replacement,
      "2026-07-30T10:03:00.000Z",
    ), false);

    const saved = await harness.pglite.query<{ story_id: string; payload: GenerationJob; status: string }>(
      "SELECT story_id, payload, status FROM xumo_generation_jobs WHERE id = $1",
      [harness.job.id],
    );
    assert.equal(saved.rows[0]?.story_id, harness.story.id);
    assert.equal(saved.rows[0]?.status, "awaiting_user_review");
    assert.equal(saved.rows[0]?.payload.storyId, harness.story.id);
    assert.equal(JSON.stringify(saved.rows[0]?.payload).includes("PRIVATE_STALE_PENDING_TITLE"), false);
    assert.equal(await harness.database.getNarrationReviewCaseById(firstReview.id).then(Boolean), true);
    assert.equal(await harness.database.getNarrationReviewCaseById(replacement.id), null);
  } finally {
    await harness.database.close();
  }
});

test("feedback for a missing job fails with stable state-unavailable code", async () => {
  const harness = await createHarness("missing_feedback_job");
  try {
    const feedback = {
      ...feedbackFor(harness.job, "missing_feedback_job"),
      jobId: "job_missing_narration_feedback",
    };
    await assert.rejects(
      harness.database.upsertNarrationReviewFeedback(feedback),
      hasNarrationStateCode,
    );
  } finally {
    await harness.database.close();
  }
});
