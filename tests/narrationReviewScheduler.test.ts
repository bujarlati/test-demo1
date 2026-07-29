import assert from "node:assert/strict";
import test from "node:test";
import {
  runNarrationReviewSweep,
  type NarrationReviewSweepRepository,
} from "../server/narrationReviewScheduler";
import type {
  NarrationReviewCaseRecord,
  NarrationReviewCleanupCounts,
} from "../server/narrationReviewState";

function reviewFixture(
  id: string,
  status: NarrationReviewCaseRecord["status"],
  deadlineAt: string,
  payloadExpiresAt = "2026-07-25T12:00:00.000Z",
): NarrationReviewCaseRecord {
  return {
    id,
    caseId: id,
    jobId: `job_${id}`,
    ownerId: "user_scheduler",
    contentHash: "b".repeat(64),
    attempt: 1,
    rewriteCount: 0,
    status,
    version: 1,
    deadlineAt,
    payloadExpiresAt,
    decisionSource: status === "timeout_rewrite" ? "timeout" : status === "pending" ? null : "user",
    candidateMetadata: [],
    assessmentMetadata: [],
    encryptedPayload: { version: 1, iv: "x", tag: "x", ciphertext: "x" },
    createdAt: "2026-07-24T11:58:30.000Z",
    resolvedAt: null,
  };
}

class SweepRepository implements NarrationReviewSweepRepository {
  cleanup: NarrationReviewCleanupCounts = { payloads: 0, excerpts: 0 };

  constructor(readonly cases: NarrationReviewCaseRecord[]) {}

  async listRecoverableNarrationReviews(): Promise<NarrationReviewCaseRecord[]> {
    return this.cases.filter((review) =>
      ["pending", "kept", "rewrite_requested", "timeout_rewrite"].includes(review.status)
    );
  }

  async claimExpiredNarrationReviews(now: string): Promise<NarrationReviewCaseRecord[]> {
    const claimed = this.cases.filter((review) =>
      review.status === "pending" &&
      Date.parse(review.deadlineAt) <= Date.parse(now) &&
      Date.parse(review.payloadExpiresAt) > Date.parse(now)
    );
    for (const review of claimed) {
      review.status = "timeout_rewrite";
      review.version += 1;
      review.decisionSource = "timeout";
    }
    return claimed;
  }

  async deleteExpiredNarrationReviewData(): Promise<NarrationReviewCleanupCounts> {
    return this.cleanup;
  }
}

test("sweep leaves a review alone before its deadline and claims it at the exact deadline", async () => {
  const deadline = "2026-07-24T12:00:00.000Z";
  const review = reviewFixture("case_deadline", "pending", deadline);
  const repository = new SweepRepository([review]);
  const resumed: string[] = [];

  const before = await runNarrationReviewSweep({
    now: new Date("2026-07-24T11:59:59.999Z"),
    repository,
    resume: async (caseId) => { resumed.push(caseId); },
  });
  assert.equal(before.timedOut, 0);
  assert.deepEqual(resumed, []);

  const atDeadline = await runNarrationReviewSweep({
    now: new Date(deadline),
    repository,
    resume: async (caseId) => { resumed.push(caseId); },
  });
  assert.equal(atDeadline.timedOut, 1);
  assert.deepEqual(resumed, [review.id]);
  assert.equal(review.status, "timeout_rewrite");
});

test("sweep recovers claimed actions and delegates expired payload failure once", async () => {
  const claimed = reviewFixture(
    "case_claimed",
    "kept",
    "2026-07-24T12:05:00.000Z",
  );
  const expired = reviewFixture(
    "case_expired",
    "pending",
    "2026-07-24T11:59:00.000Z",
    "2026-07-24T12:00:00.000Z",
  );
  const repository = new SweepRepository([claimed, expired]);
  repository.cleanup = { payloads: 2, excerpts: 3 };
  const resumed: string[] = [];
  const result = await runNarrationReviewSweep({
    now: new Date("2026-07-24T12:00:00.000Z"),
    repository,
    resume: async (caseId) => { resumed.push(caseId); },
  });
  assert.deepEqual(resumed.sort(), [claimed.id, expired.id].sort());
  assert.equal(result.recovered, 2);
  assert.equal(result.timedOut, 0);
  assert.equal(result.expiredPayloads, 2);
  assert.equal(result.expiredExcerpts, 3);
});
