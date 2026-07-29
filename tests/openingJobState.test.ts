import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialOpeningJobState,
  openingJobReducer,
  openingJobSecondsRemaining,
  recoverOpeningJobId,
} from "../src/openingJobState";
import type { GenerationJob, OpeningJobStatusPayload } from "../src/types";

const reviewA: Extract<OpeningJobStatusPayload, { status: "awaiting_user_review" }> = {
  jobId: "job_opening",
  status: "awaiting_user_review",
  review: {
    id: "case_a",
    version: 1,
    jobId: "job_opening",
    contentHash: "hash_a",
    deadlineAt: "2026-07-24T04:01:30.000Z",
    candidates: [{
      id: "candidate_a",
      ruleId: "author_side_narration",
      location: "body",
      matchedText: "本卷",
      sentence: "本卷的旧册子已经发黄。",
      previousSentence: "雨停了。",
      nextSentence: "门外响起脚步声。",
      highlightStart: 0,
      highlightEnd: 2,
    }],
  },
};

function pendingJob(overrides: Partial<GenerationJob>): GenerationJob {
  return {
    id: "job_opening",
    ownerId: "user_demo",
    storyId: "opening_pending",
    storyTitle: "正在生成新故事",
    chapterNumber: 1,
    task: "opening",
    model: "writer-model",
    connectionId: "connection_test",
    promptVersion: "test",
    status: "running",
    tokens: 0,
    latencyMs: 0,
    cost: 0,
    createdAt: "2026-07-24T04:00:00.000Z",
    ...overrides,
  };
}

test("opening reducer follows start, poll, review, decision, and completion", () => {
  let state = createInitialOpeningJobState("key_a");
  state = openingJobReducer(state, { type: "start" });
  assert.equal(state.phase, "starting");

  state = openingJobReducer(state, {
    type: "create_result",
    result: { kind: "job", job: { jobId: "job_opening", status: "running" } },
  });
  assert.equal(state.phase, "polling");

  state = openingJobReducer(state, { type: "poll_started", requestId: 1 });
  state = openingJobReducer(state, { type: "status_received", requestId: 1, status: reviewA });
  assert.equal(state.phase, "awaiting_user_review");
  assert.equal(state.review?.id, "case_a");

  state = openingJobReducer(state, { type: "set_context_consent", value: true });
  state = openingJobReducer(state, { type: "decision_started" });
  assert.equal(state.phase, "submitting_decision");

  state = openingJobReducer(state, {
    type: "decision_result",
    status: { jobId: "job_opening", status: "running" },
  });
  assert.equal(state.phase, "polling");

  state = openingJobReducer(state, { type: "poll_started", requestId: 2 });
  state = openingJobReducer(state, {
    type: "status_received",
    requestId: 2,
    status: { jobId: "job_opening", status: "completed", storyId: "story_new" },
  });
  assert.equal(state.phase, "completed");
  assert.equal(state.storyId, "story_new");
});

test("a stale poll response cannot replace a newer review case", () => {
  let state = createInitialOpeningJobState("key_a");
  state = openingJobReducer(state, { type: "recover_job", jobId: "job_opening" });
  state = openingJobReducer(state, { type: "poll_started", requestId: 1 });
  state = openingJobReducer(state, { type: "poll_started", requestId: 2 });
  const reviewB: typeof reviewA = {
    ...reviewA,
    review: {
      ...reviewA.review,
      id: "case_b",
      version: 2,
      contentHash: "hash_b",
      candidates: [{ ...reviewA.review.candidates[0], id: "candidate_b" }],
    },
  };
  state = openingJobReducer(state, { type: "status_received", requestId: 2, status: reviewB });
  state = openingJobReducer(state, { type: "set_context_consent", value: true });
  state = openingJobReducer(state, { type: "status_received", requestId: 1, status: reviewA });

  assert.equal(state.review?.id, "case_b");
  assert.equal(state.shareRedactedContext, true);
});

test("a changed candidate set resets consent even when the case id is reused", () => {
  let state = createInitialOpeningJobState("key_a");
  state = openingJobReducer(state, { type: "recover_job", jobId: "job_opening" });
  state = openingJobReducer(state, { type: "poll_started", requestId: 1 });
  state = openingJobReducer(state, { type: "status_received", requestId: 1, status: reviewA });
  state = openingJobReducer(state, { type: "set_context_consent", value: true });
  state = openingJobReducer(state, { type: "poll_started", requestId: 2 });
  state = openingJobReducer(state, {
    type: "status_received",
    requestId: 2,
    status: {
      ...reviewA,
      review: {
        ...reviewA.review,
        candidates: [{ ...reviewA.review.candidates[0], id: "candidate_changed" }],
      },
    },
  });

  assert.equal(state.shareRedactedContext, false);
});

test("countdown is derived from the server deadline with an injected clock", () => {
  assert.equal(openingJobSecondsRemaining(reviewA.review.deadlineAt, Date.parse("2026-07-24T04:00:00.000Z")), 90);
  assert.equal(openingJobSecondsRemaining(reviewA.review.deadlineAt, Date.parse("2026-07-24T04:01:00.500Z")), 30);
  assert.equal(openingJobSecondsRemaining(reviewA.review.deadlineAt, Date.parse("2026-07-24T04:02:00.000Z")), 0);
});

test("a 409 decision conflict returns to polling without a retry prompt", () => {
  let state = createInitialOpeningJobState("key_a");
  state = openingJobReducer(state, { type: "recover_job", jobId: "job_opening" });
  state = openingJobReducer(state, { type: "poll_started", requestId: 1 });
  state = openingJobReducer(state, { type: "status_received", requestId: 1, status: reviewA });
  state = openingJobReducer(state, { type: "decision_started" });
  state = openingJobReducer(state, { type: "decision_conflict" });

  assert.equal(state.phase, "polling");
  assert.equal(state.error, null);
});

test("terminal failure requires a fresh idempotency key before retry", () => {
  let state = createInitialOpeningJobState("key_a");
  state = openingJobReducer(state, { type: "recover_job", jobId: "job_opening" });
  state = openingJobReducer(state, { type: "poll_started", requestId: 1 });
  state = openingJobReducer(state, {
    type: "status_received",
    requestId: 1,
    status: { jobId: "job_opening", status: "failed", message: "生成失败。", retryable: true },
  });
  state = openingJobReducer(state, { type: "reset_after_failure", idempotencyKey: "key_b" });

  assert.equal(state.phase, "idle");
  assert.equal(state.idempotencyKey, "key_b");
  assert.equal(state.jobId, null);
});

test("URL job wins; otherwise recovery selects the newest pending opening job", () => {
  const jobs = [
    pendingJob({ id: "job_chapter", task: "chapter", chapterNumber: 2, createdAt: "2026-07-24T04:05:00.000Z" }),
    pendingJob({ id: "job_old", createdAt: "2026-07-24T04:00:00.000Z" }),
    pendingJob({ id: "job_new", status: "awaiting_user_review", createdAt: "2026-07-24T04:03:00.000Z" }),
  ];

  assert.equal(recoverOpeningJobId(jobs), "job_new");
  assert.equal(recoverOpeningJobId(jobs, "job_url"), "job_url");
});
