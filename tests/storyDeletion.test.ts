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
import { createStoreSaveQueue, createStoryDeletionStorage } from "../server/storage";
import type { PersistenceDatabase } from "../server/database/types";

function deletionDatabase(deleteOwnedStory: PersistenceDatabase["deleteOwnedStory"]): PersistenceDatabase {
  return { deleteOwnedStory } as PersistenceDatabase;
}

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

test("PostgreSQL deletion trusts the transaction when the runtime title is stale", async () => {
  const store = createSeedStore();
  const story = store.stories[0]!;
  const owner = store.users.find((user) => user.id === story.ownerId)!;
  const authoritativeTitle = story.title;
  story.title = "STALE_RUNTIME_TITLE";
  const deletionResult = { wasCurrentStory: true, wasPublished: false, hadChapters: true };
  let persistenceInput: Parameters<PersistenceDatabase["deleteOwnedStory"]>[0] | null = null;
  const deleteStory = createStoryDeletionStorage({
    getDatabase: () => deletionDatabase(async (input) => {
      assert.equal(persistenceInput, null, "expected one PostgreSQL deletion call");
      persistenceInput = structuredClone(input);
      return deletionResult;
    }),
    save: async () => assert.fail("PostgreSQL deletion must not save a JSON snapshot"),
    now: () => "2026-07-30T10:00:00.000Z",
    createAuditId: () => "audit_database_stale_title",
  });

  await deleteStory(store, {
    ownerId: owner.id,
    storyId: story.id,
    confirmationTitle: authoritativeTitle,
  });

  assert.deepEqual(persistenceInput, {
    ownerId: owner.id,
    storyId: story.id,
    confirmationTitle: authoritativeTitle,
    auditId: "audit_database_stale_title",
    deletedAt: "2026-07-30T10:00:00.000Z",
  });
  assert.equal(store.stories.some((candidate) => candidate.id === story.id), false);
  assert.deepEqual(store.auditEvents.find((event) => event.id === "audit_database_stale_title"), {
    id: "audit_database_stale_title",
    actorUserId: owner.id,
    action: "story.deleted",
    targetType: "story",
    targetId: DELETED_STORY_PLACEHOLDER,
    createdAt: "2026-07-30T10:00:00.000Z",
    metadata: {
      storyDeleted: true,
      ...deletionResult,
    },
  });
});
test("PostgreSQL deletion trusts the transaction when the runtime job cache looks busy", async () => {
  const store = createSeedStore();
  const story = store.stories[0]!;
  const owner = store.users.find((user) => user.id === story.ownerId)!;
  const staleBusyJob = {
    ...store.jobs[0]!,
    id: "job_stale_busy_cache",
    storyId: story.id,
    storyTitle: story.title,
    status: "awaiting_user_review" as const,
  };
  store.jobs.push(staleBusyJob);
  let persistenceCalls = 0;
  const deleteStory = createStoryDeletionStorage({
    getDatabase: () => deletionDatabase(async () => {
      persistenceCalls += 1;
      return { wasCurrentStory: true, wasPublished: true, hadChapters: true };
    }),
    save: async () => assert.fail("PostgreSQL deletion must not save a JSON snapshot"),
    now: () => "2026-07-30T10:00:00.000Z",
    createAuditId: () => "audit_database_stale_job",
  });

  const result = await deleteStory(store, {
    ownerId: owner.id,
    storyId: story.id,
    confirmationTitle: story.title,
  });

  assert.equal(persistenceCalls, 1);
  assert.equal(result.wasPublished, true);
  assert.equal(store.jobs.find((job) => job.id === staleBusyJob.id)?.storyId, DELETED_STORY_PLACEHOLDER);
});

test("JSON deletion still rejects a mismatched title and active work", async (t) => {
  await t.test("mismatched title", async () => {
    const store = createSeedStore();
    const story = store.stories[0]!;
    let saveCalls = 0;
    const deleteStory = createStoryDeletionStorage({
      getDatabase: () => null,
      save: async () => { saveCalls += 1; },
      now: () => "2026-07-30T10:00:00.000Z",
      createAuditId: () => "audit_json_mismatch",
    });
    await assert.rejects(
      deleteStory(store, { ownerId: story.ownerId, storyId: story.id, confirmationTitle: `${story.title}!` }),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "story_delete_confirmation_mismatch",
    );
    assert.equal(saveCalls, 0);
    assert.equal(store.stories.some((candidate) => candidate.id === story.id), true);
  });

  for (const status of ["running", "awaiting_user_review"] as const) {
    await t.test(status, async () => {
      const store = createSeedStore();
      const story = store.stories[0]!;
      store.jobs.push({
        ...store.jobs[0]!,
        id: `job_json_${status}`,
        storyId: story.id,
        storyTitle: story.title,
        status,
      });
      let saveCalls = 0;
      const deleteStory = createStoryDeletionStorage({
        getDatabase: () => null,
        save: async () => { saveCalls += 1; },
        now: () => "2026-07-30T10:00:00.000Z",
        createAuditId: () => `audit_json_${status}`,
      });
      await assert.rejects(
        deleteStory(store, { ownerId: story.ownerId, storyId: story.id, confirmationTitle: story.title }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "story_delete_busy",
      );
      assert.equal(saveCalls, 0);
      assert.equal(store.stories.some((candidate) => candidate.id === story.id), true);
    });
  }
});

test("JSON deletion returns story_not_found without saving for missing or wrong-owner stories", async (t) => {
  for (const scenario of ["missing", "wrong-owner"] as const) {
    await t.test(scenario, async () => {
      const store = createSeedStore();
      const story = store.stories[0]!;
      const ownerId = scenario === "wrong-owner"
        ? store.users.find((user) => user.id !== story.ownerId)!.id
        : story.ownerId;
      const storyId = scenario === "missing" ? "story_missing" : story.id;
      const before = structuredClone(store);
      let saveCalls = 0;
      const deleteStory = createStoryDeletionStorage({
        getDatabase: () => null,
        save: async () => { saveCalls += 1; },
        now: () => "2026-07-30T10:00:00.000Z",
        createAuditId: () => `audit_json_${scenario}`,
      });

      await assert.rejects(
        deleteStory(store, {
          ownerId,
          storyId,
          confirmationTitle: story.title,
        }),
        (error: unknown) => error instanceof Error
          && "code" in error
          && error.code === "story_not_found",
      );
      assert.equal(saveCalls, 0);
      assert.deepEqual(store, before);
    });
  }
});
test("JSON deletion preserves unrelated records and persists complete target cleanup", async () => {
  const store = createSeedStore();
  const story = store.stories[0]!;
  const unrelatedStory = store.stories[1]!;
  const owner = store.users.find((user) => user.id === story.ownerId)!;
  const unrelatedUser = store.users.find((user) => user.id !== owner.id)!;
  owner.activeStoryId = story.id;
  unrelatedUser.activeStoryId = unrelatedStory.id;
  const targetJob = {
    ...store.jobs[0]!, id: "job_json_delete", ownerId: owner.id, storyId: story.id,
    storyTitle: "PRIVATE_JSON_TITLE_SENTINEL", status: "completed" as const,
    idempotencyKey: "PRIVATE_JSON_JOB_KEY_SENTINEL", filterSummary: "PRIVATE_JSON_FILTER_SENTINEL",
  };
  const unrelatedJob = {
    ...store.jobs[1]!, id: "job_json_unrelated", storyId: unrelatedStory.id,
    storyTitle: "UNRELATED_JSON_TITLE_SENTINEL", status: "completed" as const,
  };
  store.jobs.push(targetJob, unrelatedJob);
  const targetFailure = createGenerationFailureObservation(targetJob, new Error("PRIVATE_JSON_FAILURE_SENTINEL"), {
    id: "failure_json_delete", stage: "writer", terminal: true,
  });
  const unrelatedFailure = createGenerationFailureObservation(unrelatedJob, new Error("UNRELATED_JSON_FAILURE_SENTINEL"), {
    id: "failure_json_unrelated", stage: "writer", terminal: true,
  });
  store.generationFailures.push(targetFailure, unrelatedFailure);
  const targetAudit = createAuditEvent(owner.id, "story.updated", "story", story.id, {
    privateField: "PRIVATE_JSON_AUDIT_SENTINEL",
  });
  const targetMetadataAudit = createAuditEvent(owner.id, "generation.failed", "generation", targetJob.id, {
    storyId: story.id, privateField: "PRIVATE_JSON_METADATA_AUDIT_SENTINEL",
  });
  const unrelatedAudit = createAuditEvent(owner.id, "story.updated", "story", unrelatedStory.id, {
    privateField: "UNRELATED_JSON_AUDIT_SENTINEL",
  });
  store.auditEvents.push(targetAudit, targetMetadataAudit, unrelatedAudit);
  const targetSafety = {
    id: "safety_json_delete", actorUserId: owner.id, storyId: story.id, surface: "chapter_output" as const,
    decision: "allowed" as const, categories: [], contentHash: "PRIVATE_JSON_SAFETY_SENTINEL", createdAt: story.updatedAt,
  };
  const unrelatedSafety = {
    ...targetSafety, id: "safety_json_unrelated", storyId: unrelatedStory.id,
    contentHash: "UNRELATED_JSON_SAFETY_SENTINEL",
  };
  store.safetyDecisions.push(targetSafety, unrelatedSafety);
  const targetReport = {
    id: "report_json_delete", reporterUserId: owner.id, storyId: story.id,
    reason: "PRIVATE_JSON_REPORT_SENTINEL", status: "submitted" as const,
    createdAt: story.updatedAt, updatedAt: story.updatedAt,
  };
  const unrelatedReport = {
    ...targetReport, id: "report_json_unrelated", storyId: unrelatedStory.id,
    reason: "UNRELATED_JSON_REPORT_SENTINEL",
  };
  store.contentReports.push(targetReport, unrelatedReport);
  const targetRequest = {
    userId: owner.id, storyId: story.id, idempotencyKey: "request_json_delete", createdAt: story.updatedAt,
  };
  const unrelatedRequest = {
    ...targetRequest, storyId: unrelatedStory.id, idempotencyKey: "request_json_unrelated",
  };
  store.storyCreationRequests.push(targetRequest, unrelatedRequest);
  store.idempotencyKeys.push("unrelated:key");

  type Store = ReturnType<typeof createSeedStore>;
  const targetJobIds = new Set(store.jobs.filter((job) => job.storyId === story.id).map((job) => job.id));
  const targetFailureIds = new Set(store.generationFailures
    .filter((failure) => failure.storyId === story.id)
    .map((failure) => failure.id));
  const targetAuditIds = new Set(store.auditEvents
    .filter((event) => event.targetId === story.id || event.metadata?.storyId === story.id)
    .map((event) => event.id));
  const unaffectedState = (candidate: Store) => ({
    users: candidate.users.map((user) => user.id === owner.id ? { ...user, activeStoryId: null } : user),
    stories: candidate.stories.filter((candidateStory) => candidateStory.id !== story.id),
    jobs: candidate.jobs.filter((job) => !targetJobIds.has(job.id)),
    generationFailures: candidate.generationFailures.filter((failure) => !targetFailureIds.has(failure.id)),
    auditEvents: candidate.auditEvents.filter((event) => (
      event.id !== "audit_json_success" && !targetAuditIds.has(event.id)
    )),
    safetyDecisions: candidate.safetyDecisions.filter((decision) => decision.storyId !== story.id),
    contentReports: candidate.contentReports.filter((report) => report.storyId !== story.id),
    storyCreationRequests: candidate.storyCreationRequests.filter((request) => request.storyId !== story.id),
    sessions: candidate.sessions,
    connections: candidate.connections,
    idempotencyKeys: candidate.idempotencyKeys,
  });
  const expectedUnaffectedState = structuredClone(unaffectedState(store));
  const deletionResult = {
    wasCurrentStory: true,
    wasPublished: false,
    hadChapters: story.chapters.length > 0,
  };
  let persistedSnapshot: Store | null = null;
  const deleteStory = createStoryDeletionStorage({
    getDatabase: () => null,
    save: createStoreSaveQueue(async (snapshot) => { persistedSnapshot = JSON.parse(snapshot) as Store; }),
    now: () => "2026-07-30T10:00:00.000Z",
    createAuditId: () => "audit_json_success",
  });

  const result = await deleteStory(store, {
    ownerId: owner.id, storyId: story.id, confirmationTitle: story.title,
  });

  assert.deepEqual(result, deletionResult);
  if (!persistedSnapshot) assert.fail("expected a persisted JSON snapshot");
  for (const candidateStore of [store, persistedSnapshot]) {
    assert.deepEqual(unaffectedState(candidateStore), expectedUnaffectedState);
    assert.equal(candidateStore.stories.some((candidate) => candidate.id === story.id), false);
    assert.equal(candidateStore.users.some((user) => user.activeStoryId === story.id), false);
    const savedJob = candidateStore.jobs.find((job) => job.id === targetJob.id);
    const savedFailure = candidateStore.generationFailures.find((failure) => failure.id === targetFailure.id);
    assert.equal(savedJob?.storyId, DELETED_STORY_PLACEHOLDER);
    assert.equal(savedJob?.storyTitle, DELETED_STORY_TITLE);
    assert.equal(savedFailure?.storyId, DELETED_STORY_PLACEHOLDER);
    assert.equal(savedFailure?.message.includes("PRIVATE_JSON_FAILURE_SENTINEL"), false);
    assert.equal(candidateStore.auditEvents.find((event) => event.id === targetAudit.id)?.targetId, DELETED_STORY_PLACEHOLDER);
    assert.deepEqual(candidateStore.auditEvents.find((event) => event.id === targetMetadataAudit.id)?.metadata, { storyDeleted: true });
    assert.deepEqual(candidateStore.auditEvents.find((event) => event.id === "audit_json_success"), {
      id: "audit_json_success",
      actorUserId: owner.id,
      action: "story.deleted",
      targetType: "story",
      targetId: DELETED_STORY_PLACEHOLDER,
      createdAt: "2026-07-30T10:00:00.000Z",
      metadata: {
        storyDeleted: true,
        ...deletionResult,
      },
    });
    assert.equal(candidateStore.safetyDecisions.some((decision) => decision.id === targetSafety.id), false);
    assert.equal(candidateStore.contentReports.some((report) => report.id === targetReport.id), false);
    assert.equal(candidateStore.storyCreationRequests.some((request) => request.idempotencyKey === targetRequest.idempotencyKey), false);
    assert.equal(JSON.stringify(candidateStore).includes("PRIVATE_JSON_"), false);
  }
});

test("JSON deletion rollback restores the full pre-delete store after persistence failure", async () => {
  const store = createSeedStore();
  const story = store.stories[0]!;
  const owner = store.users.find((user) => user.id === story.ownerId)!;
  owner.activeStoryId = story.id;
  const before = structuredClone(store);
  const deleteStory = createStoryDeletionStorage({
    getDatabase: () => null,
    save: createStoreSaveQueue(async () => { throw new Error("injected JSON persistence failure"); }),
    now: () => "2026-07-30T10:00:00.000Z",
    createAuditId: () => "audit_json_rollback",
  });
  await assert.rejects(
    deleteStory(store, { ownerId: owner.id, storyId: story.id, confirmationTitle: story.title }),
    /injected JSON persistence failure/u,
  );
  assert.deepEqual(store, before);
});
