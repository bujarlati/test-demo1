import assert from "node:assert/strict";
import test from "node:test";
import { createAuditEvent } from "../server/auth";
import { createGenerationFailureObservation } from "../server/failureTelemetry";
import {
  DELETED_STORY_PLACEHOLDER,
  DELETED_STORY_TITLE,
  applyStoryDeletionToStore,
  assertStoryDeletionTitle,
  createStoryDeletionAudit,
  hasActiveStoryWork,
  sanitizeGenerationFailureAfterStoryDeletion,
  sanitizeGenerationJobAfterStoryDeletion,
} from "../server/storyDeletion";
import { createSeedStore } from "../server/seed";

test("story deletion requires the exact trimmed title", () => {
  assert.doesNotThrow(() => assertStoryDeletionTitle("潮汐背面", "  潮汐背面  "));
  assert.throws(
    () => assertStoryDeletionTitle("Story A", "story a"),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "story_delete_confirmation_mismatch",
  );
});

test("story deletion detects running and awaiting-review work", () => {
  const store = createSeedStore();
  const storyId = store.stories[0]!.id;
  const baseJob = store.jobs[0]!;
  store.jobs.push({ ...baseJob, id: "job_running_delete", storyId, status: "running" });
  assert.equal(hasActiveStoryWork(store, storyId), true);
  store.jobs.at(-1)!.status = "awaiting_user_review";
  assert.equal(hasActiveStoryWork(store, storyId), true);
  store.jobs.at(-1)!.status = "completed";
  assert.equal(hasActiveStoryWork(store, storyId), false);
});

test("retained generation records contain statistics but no story content", () => {
  const base = createSeedStore().jobs[0]!;
  const job = {
    ...base,
    storyId: "story_private",
    storyTitle: "PRIVATE_TITLE_SENTINEL",
    idempotencyKey: "PRIVATE_IDEMPOTENCY_SENTINEL",
    candidateTrace: [{
      id: "candidate_private",
      seed: 1,
      creativeAxis: "PRIVATE_AXIS_SENTINEL",
      event: "PRIVATE_EVENT_SENTINEL",
      cause: "PRIVATE_CAUSE_SENTINEL",
      cost: "PRIVATE_COST_SENTINEL",
      impact: "PRIVATE_IMPACT_SENTINEL",
      novelty: "PRIVATE_NOVELTY_SENTINEL",
      score: 1,
      status: "selected" as const,
      reasons: ["PRIVATE_REASON_SENTINEL"],
    }],
    filterSummary: "PRIVATE_FILTER_SENTINEL",
    contextTrace: [{ component: "canon" as const, sourceIds: ["PRIVATE_SOURCE_SENTINEL"], estimatedTokens: 20 }],
    retconId: "PRIVATE_RETCON_SENTINEL",
    targetEventId: "PRIVATE_EVENT_ID_SENTINEL",
  };
  const failure = createGenerationFailureObservation(
    job,
    new Error("PRIVATE_FAILURE_MESSAGE_SENTINEL"),
    { id: "failure_private", stage: "writer", terminal: true },
  );
  const scrubbedJob = sanitizeGenerationJobAfterStoryDeletion(job);
  const scrubbedFailure = sanitizeGenerationFailureAfterStoryDeletion(failure);
  const serialized = JSON.stringify([scrubbedJob, scrubbedFailure]);
  assert.equal(scrubbedJob.storyId, DELETED_STORY_PLACEHOLDER);
  assert.equal(scrubbedJob.storyTitle, DELETED_STORY_TITLE);
  assert.equal(scrubbedJob.chapterNumber, 0);
  for (const sentinel of ["PRIVATE_TITLE", "PRIVATE_IDEMPOTENCY", "PRIVATE_AXIS", "PRIVATE_EVENT", "PRIVATE_CAUSE", "PRIVATE_FILTER", "PRIVATE_SOURCE", "PRIVATE_RETCON", "PRIVATE_FAILURE_MESSAGE"]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
  assert.equal(scrubbedJob.model, job.model);
  assert.equal(scrubbedFailure.reasonCode, failure.reasonCode);
  assert.notEqual(scrubbedFailure.fingerprint, failure.fingerprint);
  assert.equal(scrubbedFailure.tokens, failure.tokens);
});

test("store deletion removes content, sanitizes operations, and supports rollback", () => {
  const store = createSeedStore();
  const story = store.stories[0]!;
  const owner = store.users.find((user) => user.id === story.ownerId)!;
  owner.activeStoryId = story.id;
  const baseJob = store.jobs[0]!;
  const job = { ...baseJob, id: "job_delete", storyId: story.id, storyTitle: story.title, status: "completed" as const };
  store.jobs.push(job);
  store.generationFailures.push(createGenerationFailureObservation(job, new Error("PRIVATE_FAILURE"), {
    id: "failure_delete",
    stage: "writer",
    terminal: true,
  }));
  store.safetyDecisions.push({
    id: "safety_delete",
    actorUserId: owner.id,
    storyId: story.id,
    surface: "chapter_output",
    decision: "allowed",
    categories: [],
    contentHash: "private_hash",
    createdAt: story.updatedAt,
  });
  store.contentReports.push({
    id: "report_delete",
    reporterUserId: owner.id,
    storyId: story.id,
    reason: "PRIVATE_REPORT_REASON",
    status: "submitted",
    createdAt: story.updatedAt,
    updatedAt: story.updatedAt,
  });
  store.storyCreationRequests.push({ userId: owner.id, storyId: story.id, idempotencyKey: "create_delete", createdAt: story.updatedAt });
  store.auditEvents.unshift(createAuditEvent(owner.id, "story.updated", "story", story.id, { privateField: "PRIVATE_AUDIT" }));
  store.auditEvents.unshift(createAuditEvent(owner.id, "generation.failed", "generation", job.id, {
    storyId: story.id,
    reason: "PRIVATE_GENERATION_REASON",
  }));
  const before = structuredClone(store);

  const audit = createStoryDeletionAudit(owner.id, "audit_delete", story.updatedAt, {
    wasCurrentStory: true,
    wasPublished: false,
    hadChapters: story.chapters.length > 0,
  });
  const rollback = applyStoryDeletionToStore(store, owner.id, story.id, audit);
  assert.equal(store.stories.some((candidate) => candidate.id === story.id), false);
  assert.equal(owner.activeStoryId, null);
  assert.equal(store.safetyDecisions.some((item) => item.storyId === story.id), false);
  assert.equal(store.contentReports.some((item) => item.storyId === story.id), false);
  assert.equal(store.storyCreationRequests.some((item) => item.storyId === story.id), false);
  assert.equal(JSON.stringify(store).includes("PRIVATE_AUDIT"), false);
  assert.equal(JSON.stringify(store).includes("PRIVATE_GENERATION_REASON"), false);
  assert.equal(store.auditEvents[0]?.action, "story.deleted");

  rollback();
  assert.deepEqual(store, before);
});
