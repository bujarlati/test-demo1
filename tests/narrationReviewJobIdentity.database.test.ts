import assert from "node:assert/strict";
import test from "node:test";
import { PostgresDatabase } from "../server/database/postgres";
import type {
  NarrationReviewCaseRecord,
  NarrationReviewFeedbackRecord,
} from "../server/narrationReviewState";
import { createSeedStore } from "../server/seed";
import type { GenerationJob } from "../src/types";
import { PGlite, PGliteExecutor } from "./helpers/pglite";

interface Harness {
  pglite: PGlite;
  database: PostgresDatabase;
  job: GenerationJob;
  otherOwnerId: string;
}

async function createHarness(suffix: string): Promise<Harness> {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  await database.migrate();
  const store = createSeedStore();
  const story = store.stories.find((candidate) => candidate.chapters.length > 0)!;
  const owner = store.users.find((candidate) => candidate.id === story.ownerId)!;
  const otherOwnerId = store.users.find((candidate) => candidate.id !== owner.id)!.id;
  const sourceJob = store.jobs.find((candidate) => candidate.storyId === story.id) ?? store.jobs[0]!;
  const job: GenerationJob = {
    ...sourceJob,
    id: `job_narration_identity_${suffix}`,
    ownerId: owner.id,
    storyId: story.id,
    storyTitle: story.title,
    status: "running",
    createdAt: "2026-07-30T10:00:00.000Z",
  };
  store.jobs = store.jobs.filter((candidate) => candidate.storyId !== story.id);
  store.jobs.push(job);
  await database.saveSnapshot(store);
  return { pglite, database, job, otherOwnerId };
}

function reviewFor(job: GenerationJob, suffix: string): NarrationReviewCaseRecord {
  const caseId = `narration_case_identity_${suffix}`;
  return {
    id: caseId,
    caseId,
    jobId: job.id,
    ownerId: job.ownerId,
    contentHash: "a".repeat(64),
    attempt: 1,
    rewriteCount: 0,
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
      ciphertext: `PRIVATE_${suffix}_CIPHERTEXT`,
    },
    createdAt: "2026-07-30T10:00:00.000Z",
    resolvedAt: null,
  };
}

function feedbackFor(job: GenerationJob, ownerId: string): NarrationReviewFeedbackRecord {
  return {
    id: "narration_feedback_identity_owner",
    caseId: null,
    jobId: job.id,
    ownerId,
    candidateId: "candidate_feedback_owner",
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
    contentHash: "b".repeat(64),
    consentedExcerptCiphertext: null,
    excerptExpiresAt: null,
    createdAt: "2026-07-30T10:01:00.000Z",
    updatedAt: "2026-07-30T10:01:00.000Z",
  };
}

function hasUnavailableCode(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "narration_review_state_unavailable";
}

test("immutable owner, task, and createdAt mismatches cannot rewrite a job or create a review case", async (context) => {
  const scenarios: Array<{
    name: string;
    mutate(job: GenerationJob, harness: Harness): GenerationJob;
  }> = [
    { name: "owner", mutate: (job, harness) => ({ ...job, ownerId: harness.otherOwnerId }) },
    { name: "task", mutate: (job) => ({ ...job, task: job.task === "chapter" ? "retcon" : "chapter" }) },
    { name: "createdAt", mutate: (job) => ({ ...job, createdAt: "2026-07-30T10:00:01.000Z" }) },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const harness = await createHarness(scenario.name);
      try {
        const before = await harness.pglite.query<{ status: string; payload: GenerationJob }>(
          "SELECT status, payload FROM xumo_generation_jobs WHERE id = $1",
          [harness.job.id],
        );
        const incoming = scenario.mutate({
          ...harness.job,
          status: "awaiting_user_review",
          storyTitle: `PRIVATE_IDENTITY_${scenario.name}`,
        }, harness);
        const review = reviewFor(incoming, scenario.name);

        await assert.rejects(
          harness.database.pauseOpeningForNarrationReview(incoming, review),
          hasUnavailableCode,
        );

        const after = await harness.pglite.query<{
          status: string;
          payload: GenerationJob;
          case_count: string;
        }>(
          `SELECT status, payload,
             (SELECT count(*) FROM xumo_narration_review_cases WHERE job_id = $1)::text AS case_count
           FROM xumo_generation_jobs WHERE id = $1`,
          [harness.job.id],
        );
        assert.equal(after.rows[0]?.status, before.rows[0]?.status);
        assert.deepEqual(after.rows[0]?.payload, before.rows[0]?.payload);
        assert.equal(after.rows[0]?.case_count, "0");
      } finally {
        await harness.database.close();
      }
    });
  }
});

test("feedback owner mismatch fails stably without creating a feedback row", async () => {
  const harness = await createHarness("feedback_owner");
  try {
    const feedback = feedbackFor(harness.job, harness.otherOwnerId);
    await assert.rejects(
      harness.database.upsertNarrationReviewFeedback(feedback),
      hasUnavailableCode,
    );
    const saved = await harness.pglite.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM xumo_narration_review_feedback WHERE id = $1",
      [feedback.id],
    );
    assert.equal(saved.rows[0]?.count, "0");
  } finally {
    await harness.database.close();
  }
});
