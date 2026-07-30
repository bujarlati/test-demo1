import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppStore,
  GenerationJob,
  ModelConnection,
  Story,
} from "../src/types";
import {
  OpeningJobService,
  type OpeningJobPersistence,
  type OpeningJobPipeline,
} from "../server/openingJobService";
import type {
  OpeningGenerationCheckpoint,
  OpeningNarrationReviewTrace,
  OpeningGenerationOutcome,
} from "../server/modelGateway";
import {
  openNarrationReviewExcerpt,
  openNarrationReviewPayload,
  sealNarrationReviewExcerpt,
  sealNarrationReviewPayload,
  type NarrationReviewCaseRecord,
  type NarrationReviewDecisionClaim,
  type NarrationReviewFeedbackRecord,
} from "../server/narrationReviewState";
import { createSeedStore } from "../server/seed";

const encryptionKey = Buffer.alloc(32, 17);
const loadKey = async () => encryptionKey;
const contentHash = "a".repeat(64);

class MemoryOpeningPersistence implements OpeningJobPersistence {
  readonly cases = new Map<string, NarrationReviewCaseRecord>();
  readonly reservations = new Set<string>();
  readonly feedback = new Map<string, NarrationReviewFeedbackRecord>();
  saveCalls = 0;

  constructor(private readonly store: AppStore) {}

  async save(): Promise<void> {
    this.saveCalls += 1;
  }

  async findStoryCreationRequest(ownerId: string, idempotencyKey: string): Promise<string | null> {
    return this.store.storyCreationRequests.find((request) =>
      request.userId === ownerId && request.idempotencyKey === idempotencyKey
    )?.storyId ?? null;
  }

  async loadStory(ownerId: string, storyId: string): Promise<Story | null> {
    return this.store.stories.find((story) => story.ownerId === ownerId && story.id === storyId) ?? null;
  }

  async findJob(ownerId: string, idempotencyKey: string): Promise<GenerationJob | null> {
    return this.store.jobs.find((job) =>
      job.ownerId === ownerId && job.idempotencyKey === idempotencyKey
    ) ?? null;
  }

  async reserveIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<boolean> {
    const key = `${ownerId}:${idempotencyKey}`;
    if (this.reservations.has(key)) return false;
    this.reservations.add(key);
    return true;
  }

  async releaseIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<void> {
    this.reservations.delete(`${ownerId}:${idempotencyKey}`);
  }

  async pauseOpeningForNarrationReview(job: GenerationJob, review: NarrationReviewCaseRecord): Promise<void> {
    assert.equal(job.status, "awaiting_user_review");
    this.cases.set(review.id, structuredClone(review));
  }

  async getNarrationReviewCaseForOwner(ownerId: string, jobId: string): Promise<NarrationReviewCaseRecord | null> {
    return [...this.cases.values()].find((review) =>
      review.ownerId === ownerId &&
      review.jobId === jobId &&
      ["pending", "kept", "rewrite_requested", "timeout_rewrite"].includes(review.status)
    ) ?? null;
  }

  async getNarrationReviewCaseById(caseId: string): Promise<NarrationReviewCaseRecord | null> {
    return this.cases.get(caseId) ?? null;
  }

  async claimNarrationReviewDecision(claim: NarrationReviewDecisionClaim): Promise<NarrationReviewCaseRecord | null> {
    const review = this.cases.get(claim.id);
    if (
      !review ||
      review.status !== "pending" ||
      review.ownerId !== claim.ownerId ||
      review.version !== claim.expectedVersion ||
      review.contentHash !== claim.contentHash ||
      Date.parse(review.deadlineAt) <= Date.parse(claim.decidedAt)
    ) return null;
    review.status = claim.status;
    review.version += 1;
    review.decisionSource = claim.decisionSource;
    return structuredClone(review);
  }

  async replaceNarrationReviewCase(
    oldCaseId: string,
    _job: GenerationJob,
    review: NarrationReviewCaseRecord,
    resolvedAt: string,
  ): Promise<boolean> {
    const prior = this.cases.get(oldCaseId);
    if (!prior || !["kept", "rewrite_requested", "timeout_rewrite"].includes(prior.status)) return false;
    prior.status = "resolved";
    prior.encryptedPayload = null;
    prior.resolvedAt = resolvedAt;
    this.cases.set(review.id, structuredClone(review));
    return true;
  }

  async resolveNarrationReviewCase(
    caseId: string,
    finalStatus: "resolved" | "failed",
    resolvedAt: string,
  ): Promise<boolean> {
    const review = this.cases.get(caseId);
    if (!review || review.status === "resolved" || review.status === "failed") return false;
    review.status = finalStatus;
    review.encryptedPayload = null;
    review.resolvedAt = resolvedAt;
    return true;
  }

  async failExpiredNarrationReviewCase(caseId: string, now: string): Promise<boolean> {
    const review = this.cases.get(caseId);
    if (!review || Date.parse(review.payloadExpiresAt) > Date.parse(now)) return false;
    review.status = "failed";
    review.encryptedPayload = null;
    review.resolvedAt = now;
    return true;
  }

  async upsertNarrationReviewFeedback(feedback: NarrationReviewFeedbackRecord): Promise<void> {
    const current = this.feedback.get(feedback.id);
    this.feedback.set(feedback.id, current?.consentedExcerptCiphertext && !feedback.consentedExcerptCiphertext
      ? { ...feedback, consentedExcerptCiphertext: current.consentedExcerptCiphertext, excerptExpiresAt: current.excerptExpiresAt }
      : structuredClone(feedback));
  }
}

function connectionFixture(ownerId: string): ModelConnection {
  return {
    id: "conn_opening_jobs",
    name: "Opening jobs",
    ownerScope: "user",
    ownerId,
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk-test",
    secretRef: "vault://opening-jobs",
    secretVersion: 1,
    status: "active",
    routes: {
      planner: "planner-model",
      writer: "writer-model",
      extractor: "reviewer-model",
      embedding: "embedding-model",
    },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: "2026-07-24T12:00:00.000Z",
  };
}

function completedOutcome(tokens = 700): OpeningGenerationOutcome {
  return {
    status: "completed",
    generated: {
      usageTokens: tokens,
      usageEstimated: false,
    } as Extract<OpeningGenerationOutcome, { status: "completed" }>["generated"],
    narrationPermit: {
      version: 1,
      contentHash,
      candidateIds: ["candidate_1"],
      decision: "user_keep",
      attempt: 1,
    },
  };
}

function automaticRewriteOutcome(): OpeningGenerationOutcome {
  const outcome = completedOutcome();
  if (outcome.status !== "completed") throw new Error("expected completed outcome");
  const trace: OpeningNarrationReviewTrace = {
    contentHash: "b".repeat(64),
    candidates: [{
      id: "candidate_automatic_rewrite",
      ruleId: "author_facing_narration",
      ruleVersion: "narration-candidates-v1",
      location: "body",
      matchedText: "本卷",
      matchStart: 0,
      matchEnd: 2,
      sentenceStart: 0,
      sentence: "本卷目标是推进角色弧。",
      contentHash: "b".repeat(64),
    }],
    resolution: {
      decision: "rewrite",
      threshold: 0.85,
      protocolValid: true,
      assessments: [{
        candidateId: "candidate_automatic_rewrite",
        worldInternal: false,
        writingProcessReference: true,
        reportedDecision: "rewrite",
        decision: "rewrite",
        confidence: 0.97,
        reason: "explicit author-facing instruction",
      }],
    },
    attempt: 1,
    rewriteCount: 0,
  };
  return {
    ...outcome,
    narrationReviews: [trace],
  };
}

function awaitingOutcome(
  context: OpeningGenerationCheckpoint["context"],
  connection: ModelConnection,
): OpeningGenerationOutcome {
  const candidate = {
    id: "candidate_1",
    ruleId: "author_facing_narration",
    ruleVersion: "narration-candidates-v1",
    location: "body" as const,
    matchedText: "本卷",
    matchStart: 8,
    matchEnd: 10,
    sentenceStart: 3,
    sentence: "他拿出半本卷边的旧诗稿。",
    previousSentence: "雨停了。",
    nextSentence: "门外传来脚步。",
    contentHash,
  };
  const review = {
    contentHash,
    candidates: [candidate],
    allCandidateIds: [candidate.id],
    resolution: {
      decision: "ask_user" as const,
      threshold: 0.85,
      protocolValid: true,
      assessments: [{
        candidateId: candidate.id,
        worldInternal: true,
        writingProcessReference: true,
        reportedDecision: "ask_user" as const,
        decision: "ask_user" as const,
        confidence: 0.63,
        reason: "ambiguous",
      }],
    },
    attempt: 1,
    rewriteCount: 0,
    baseReviewStatus: "valid" as const,
  };
  const checkpoint: OpeningGenerationCheckpoint = {
    version: 1,
    context,
    plan: {} as OpeningGenerationCheckpoint["plan"],
    connectionBinding: {
      id: connection.id,
      updatedAt: connection.updatedAt,
      routes: structuredClone(connection.routes),
    },
    attempt: 1,
    rewriteCount: 0,
    reviewerResumeCount: 0,
    accumulatedTokens: 500,
    usageEstimated: false,
    tokenBudget: 120_000,
    draft: {
      title: "旧诗稿",
      paragraphs: [candidate.sentence],
      writerUsageTokens: 300,
      writerUsageEstimated: false,
    },
    generated: {} as NonNullable<OpeningGenerationCheckpoint["generated"]>,
    review,
  };
  return { status: "awaiting_user_review", checkpoint, review };
}

function serviceFixture(
  mode: "completed" | "awaiting" | "failed",
  beginOverride?: OpeningGenerationOutcome | Promise<OpeningGenerationOutcome>,
) {
  const store = createSeedStore();
  store.stories = [];
  store.jobs = [];
  store.auditEvents = [];
  store.storyCreationRequests = [];
  store.generationFailures = [];
  const owner = store.users[0];
  const connection = connectionFixture(owner.id);
  store.connections.push(connection);
  const persistence = new MemoryOpeningPersistence(store);
  let beginCalls = 0;
  let resumeCalls = 0;
  const pipeline: OpeningJobPipeline = {
    begin: async (context, selectedConnection) => {
      beginCalls += 1;
      if (mode === "failed") throw new Error("provider unavailable");
      if (beginOverride) return beginOverride;
      return mode === "awaiting"
        ? awaitingOutcome(context, selectedConnection)
        : completedOutcome();
    },
    resume: async () => {
      resumeCalls += 1;
      return completedOutcome(900);
    },
  };
  let sequence = 0;
  let currentTime = "2026-07-24T12:00:00.000Z";
  const service = new OpeningJobService({
    store,
    persistence,
    pipeline,
    resolveConnection: (_candidate, id) => {
      assert.equal(id, connection.id);
      return connection;
    },
    applyOpening: (prepared, _connection, outcome, gate) => {
      prepared.story.title = `Published ${outcome.generated.usageTokens}`;
      gate(prepared.story);
      return prepared.story;
    },
    publicationGate: () => undefined,
    now: () => new Date(currentTime),
    createId: (prefix) => `${prefix}_${++sequence}`,
    sealPayload: (identity, payload) => sealNarrationReviewPayload(identity, payload, loadKey),
    openPayload: (identity, envelope) => openNarrationReviewPayload(identity, envelope, loadKey),
    sealExcerpt: (identity, candidates) => sealNarrationReviewExcerpt(identity, candidates, loadKey),
  });
  return {
    store,
    owner,
    connection,
    persistence,
    service,
    get beginCalls() { return beginCalls; },
    get resumeCalls() { return resumeCalls; },
    setNow(value: string) { currentTime = value; },
  };
}

const storyInput = {
  genre: "都市" as const,
  tone: "机械 · 奶爸",
  inspiration: "退役机甲师带女儿守住维修铺",
};

test("opening job completes synchronously and commits one story exactly once", async () => {
  const fixture = serviceFixture("completed");
  const result = await fixture.service.start({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-completed-1",
  });
  assert.equal(result.kind, "completed");
  assert.equal(fixture.store.stories.length, 1);
  assert.equal(fixture.store.storyCreationRequests.length, 1);
  assert.equal(fixture.store.auditEvents.filter((event) => event.action === "story.create").length, 1);
  assert.equal(fixture.store.jobs[0].status, "completed");

  const duplicate = await fixture.service.start({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-completed-1",
  });
  assert.equal(duplicate.kind, "completed");
  assert.equal(fixture.beginCalls, 1);
  assert.equal(fixture.store.stories.length, 1);
});

test("a background opening returns persisted progress before generation completes", async () => {
  let completeGeneration!: (outcome: OpeningGenerationOutcome) => void;
  const pendingOutcome = new Promise<OpeningGenerationOutcome>((resolve) => {
    completeGeneration = resolve;
  });
  const fixture = serviceFixture("completed", pendingOutcome);

  const result = await fixture.service.startInBackground({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-background-1",
  });

  assert.equal(result.kind, "job");
  if (result.kind !== "job" || result.job.status !== "running") {
    throw new Error("expected a running background opening");
  }
  assert.equal(result.job.progress?.stage, "planning");
  assert.equal(result.job.progress?.seq, 1);
  assert.equal(fixture.store.stories.length, 0);
  assert.equal(fixture.beginCalls, 1);

  completeGeneration(completedOutcome());
  await fixture.service.waitForIdle();

  assert.equal((await fixture.service.getStatus(fixture.owner.id, result.job.jobId)).status, "completed");
  assert.equal(fixture.store.stories.length, 1);
  assert.equal(fixture.store.jobs[0].openingProgress?.stage, "saving");
});

test("automatic narration decisions persist structured feedback without sentence text", async () => {
  const fixture = serviceFixture("completed", automaticRewriteOutcome());
  await fixture.service.start({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-automatic-feedback-1",
  });

  assert.equal(fixture.persistence.feedback.size, 1);
  const feedback = [...fixture.persistence.feedback.values()][0];
  assert.deepEqual({
    caseId: feedback.caseId,
    decision: feedback.decision,
    resolutionSource: feedback.resolutionSource,
    rewriteCount: feedback.rewriteCount,
    rewriteSucceeded: feedback.rewriteSucceeded,
    jobCompleted: feedback.jobCompleted,
    model: feedback.model,
  }, {
    caseId: null,
    decision: "rewrite",
    resolutionSource: "automatic",
    rewriteCount: 1,
    rewriteSucceeded: true,
    jobCompleted: true,
    model: "reviewer-model",
  });
  assert.equal(JSON.stringify(feedback).includes("本卷目标是推进角色弧"), false);
  assert.equal(JSON.stringify(feedback).includes("explicit author-facing instruction"), false);
});

test("awaiting jobs expose only owner-scoped review data and resume once", async () => {
  const fixture = serviceFixture("awaiting");
  const result = await fixture.service.start({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-awaiting-1",
  });
  assert.equal(result.kind, "job");
  if (result.kind !== "job" || result.job.status !== "awaiting_user_review") {
    throw new Error("expected awaiting review");
  }
  assert.equal(result.job.review.candidates[0].highlightStart, 5);
  assert.equal(result.job.review.candidates[0].highlightEnd, 7);
  assert.equal(JSON.stringify(result.job).includes("ambiguous"), false);
  assert.equal(JSON.stringify(result.job).includes("encryptedPayload"), false);

  const duplicate = await fixture.service.start({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-awaiting-1",
  });
  assert.equal(duplicate.kind, "job");
  assert.equal(fixture.beginCalls, 1);

  await assert.rejects(
    fixture.service.getStatus("user_someone_else", result.job.jobId),
    (error: unknown) => error instanceof Error && (error as Error & { status?: number }).status === 404,
  );
  await assert.rejects(
    fixture.service.decideNarrationReview(fixture.owner.id, result.job.jobId, {
      caseId: result.job.review.id,
      caseVersion: result.job.review.version + 1,
      contentHash: result.job.review.contentHash,
      candidateIds: result.job.review.candidates.map((candidate) => candidate.id),
      decision: "keep",
      shareRedactedContext: false,
    }),
    (error: unknown) => error instanceof Error && (error as Error & { status?: number }).status === 409,
  );

  const decision = {
    caseId: result.job.review.id,
    caseVersion: result.job.review.version,
    contentHash: result.job.review.contentHash,
    candidateIds: result.job.review.candidates.map((candidate) => candidate.id),
    decision: "keep" as const,
    shareRedactedContext: false,
  };
  const decisionStatus = await fixture.service.decideNarrationReview(fixture.owner.id, result.job.jobId, decision);
  assert.equal(decisionStatus.jobId, result.job.jobId);
  assert.equal(decisionStatus.status, "running");
  if (decisionStatus.status === "running") assert.equal(decisionStatus.progress?.activity, "checking");
  await fixture.service.waitForIdle();
  assert.equal(fixture.resumeCalls, 1);
  assert.equal((await fixture.service.getStatus(fixture.owner.id, result.job.jobId)).status, "completed");
  assert.equal((await fixture.service.decideNarrationReview(fixture.owner.id, result.job.jobId, decision)).status, "completed");
  assert.equal(fixture.resumeCalls, 1);
  assert.equal(fixture.store.stories.length, 1);
  assert.equal(fixture.store.storyCreationRequests.length, 1);
});

test("failed openings release their reservation but the same key returns the failed job", async () => {
  const fixture = serviceFixture("failed");
  await assert.rejects(() => fixture.service.start({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-failed-1",
  }), /provider unavailable/);
  assert.equal(fixture.persistence.reservations.size, 0);
  assert.equal(fixture.store.jobs[0].status, "failed");

  const duplicate = await fixture.service.start({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-failed-1",
  });
  assert.equal(duplicate.kind, "job");
  if (duplicate.kind !== "job") throw new Error("expected job result");
  assert.equal(duplicate.job.status, "failed");
  assert.equal(fixture.beginCalls, 1);
});

test("a claimed timeout action resumes after a restart-style sweep", async () => {
  const fixture = serviceFixture("awaiting");
  const result = await fixture.service.start({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-timeout-1",
  });
  assert.equal(result.kind, "job");
  if (result.kind !== "job" || result.job.status !== "awaiting_user_review") {
    throw new Error("expected awaiting review");
  }
  const review = fixture.persistence.cases.get(result.job.review.id)!;
  review.status = "timeout_rewrite";
  review.version += 1;
  review.decisionSource = "timeout";

  await fixture.service.resumeClaimedCase(review.id);
  assert.equal(fixture.resumeCalls, 1);
  assert.equal(fixture.store.jobs[0].status, "completed");
  const feedback = [...fixture.persistence.feedback.values()];
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].resolutionSource, "timeout");
  assert.equal(feedback[0].jobCompleted, true);
});

test("an expired pending payload fails the job and releases its idempotency reservation", async () => {
  const fixture = serviceFixture("awaiting");
  const result = await fixture.service.start({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-expired-1",
  });
  assert.equal(result.kind, "job");
  if (result.kind !== "job" || result.job.status !== "awaiting_user_review") {
    throw new Error("expected awaiting review");
  }
  fixture.setNow("2026-07-25T12:00:00.000Z");
  await fixture.service.resumeClaimedCase(result.job.review.id);
  assert.equal(fixture.store.jobs[0].status, "failed");
  assert.equal(fixture.persistence.cases.get(result.job.review.id)?.status, "failed");
  assert.equal(fixture.persistence.cases.get(result.job.review.id)?.encryptedPayload, null);
  assert.equal(fixture.persistence.reservations.size, 0);
  assert.equal(fixture.resumeCalls, 0);
  assert.equal(
    fixture.store.generationFailures.at(-1)?.reasonCode,
    "narration_review_payload_expired",
  );
});

test("consented context is encrypted while a default decision stores no excerpt", async () => {
  const fixture = serviceFixture("awaiting");
  const result = await fixture.service.start({
    owner: fixture.owner,
    input: storyInput,
    connectionId: fixture.connection.id,
    idempotencyKey: "opening-consent-1",
  });
  assert.equal(result.kind, "job");
  if (result.kind !== "job" || result.job.status !== "awaiting_user_review") {
    throw new Error("expected awaiting review");
  }
  const review = fixture.persistence.cases.get(result.job.review.id)!;
  assert.equal([...fixture.persistence.feedback.values()][0].consentedExcerptCiphertext, null);

  await fixture.service.decideNarrationReview(fixture.owner.id, result.job.jobId, {
    caseId: result.job.review.id,
    caseVersion: result.job.review.version,
    contentHash: result.job.review.contentHash,
    candidateIds: result.job.review.candidates.map((candidate) => candidate.id),
    decision: "keep",
    shareRedactedContext: true,
  });
  await fixture.service.waitForIdle();

  const feedback = [...fixture.persistence.feedback.values()][0];
  assert.ok(feedback.consentedExcerptCiphertext);
  assert.ok(feedback.excerptExpiresAt);
  assert.equal(JSON.stringify(feedback).includes("半本卷边"), false);
  const excerpt = await openNarrationReviewExcerpt(
    review,
    feedback.consentedExcerptCiphertext!,
    loadKey,
  );
  assert.match(excerpt, /半本卷边/);
});
