import { randomUUID } from "node:crypto";
import type {
  AppStore,
  CreateStoryInput,
  CreateStoryResult,
  GenerationJob,
  ModelConnection,
  NarrationReviewDecisionInput,
  OpeningJobStatusPayload,
  PendingNarrationReviewView,
  Story,
  UserAccount,
} from "../src/types";
import { audit } from "./auth";
import {
  appendGenerationFailure,
  classifyGenerationFailure,
  createGenerationFailureObservation,
  sanitizeGenerationFailureMessage,
} from "./failureTelemetry";
import { OPENING_JOB_TOKEN_BUDGET } from "./generationBudget";
import {
  beginStoryOpeningGeneration,
  openingNarrationReviewsFromError,
  resumeStoryOpeningGeneration,
  type OpeningNarrationReviewTrace,
  type OpeningFailureObserver,
  type OpeningGenerationCheckpoint,
  type OpeningGenerationOutcome,
} from "./modelGateway";
import { recordFailedJobUsage } from "./modelUsage";
import {
  applyGeneratedStoryOpening,
  assertStoryOpeningPublicationSafe,
  prepareStoryOpening,
  type PreparedStoryOpening,
  type StoryOpeningPublicationGate,
} from "./openingService";
import {
  openNarrationReviewPayload,
  projectNarrationAssessmentMetadata,
  projectNarrationCandidateMetadata,
  sealNarrationReviewExcerpt,
  sealNarrationReviewPayload,
  type NarrationReviewCaseRecord,
  type NarrationReviewDecisionClaim,
  type NarrationReviewFeedbackRecord,
} from "./narrationReviewState";

const REVIEW_DEADLINE_MS = 90_000;
const REVIEW_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
const REVIEW_EXCERPT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

export interface StoredOpeningReviewPayload {
  version: 1;
  prepared: PreparedStoryOpening;
  checkpoint: OpeningGenerationCheckpoint;
}

export interface OpeningJobPersistence {
  save(rollbackOnFailure?: () => void): Promise<void>;
  findStoryCreationRequest(ownerId: string, idempotencyKey: string): Promise<string | null>;
  loadStory(ownerId: string, storyId: string): Promise<Story | null>;
  findJob(ownerId: string, idempotencyKey: string): Promise<GenerationJob | null>;
  reserveIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<boolean>;
  releaseIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<void>;
  pauseOpeningForNarrationReview(job: GenerationJob, review: NarrationReviewCaseRecord): Promise<void>;
  getNarrationReviewCaseForOwner(ownerId: string, jobId: string): Promise<NarrationReviewCaseRecord | null>;
  getNarrationReviewCaseById(caseId: string): Promise<NarrationReviewCaseRecord | null>;
  claimNarrationReviewDecision(claim: NarrationReviewDecisionClaim): Promise<NarrationReviewCaseRecord | null>;
  replaceNarrationReviewCase(
    oldCaseId: string,
    job: GenerationJob,
    review: NarrationReviewCaseRecord,
    resolvedAt: string,
  ): Promise<boolean>;
  resolveNarrationReviewCase(
    caseId: string,
    finalStatus: "resolved" | "failed",
    resolvedAt: string,
  ): Promise<boolean>;
  failExpiredNarrationReviewCase(caseId: string, now: string): Promise<boolean>;
  upsertNarrationReviewFeedback(feedback: NarrationReviewFeedbackRecord): Promise<void>;
}

export interface OpeningJobPipeline {
  begin(
    context: PreparedStoryOpening["context"],
    connection: ModelConnection,
    failureObserver?: OpeningFailureObserver,
  ): Promise<OpeningGenerationOutcome>;
  resume(
    checkpoint: OpeningGenerationCheckpoint,
    action: { kind: "keep"; candidateIds: string[]; contentHash: string } |
      { kind: "rewrite"; source: "user" | "timeout" },
    connection: ModelConnection,
    failureObserver?: OpeningFailureObserver,
  ): Promise<OpeningGenerationOutcome>;
}

export interface OpeningJobServiceDependencies {
  store: AppStore;
  persistence: OpeningJobPersistence;
  resolveConnection(owner: UserAccount, connectionId: string): ModelConnection;
  admitStart?(owner: UserAccount, input: CreateStoryInput, connection: ModelConnection): Promise<void> | void;
  publicationGate?: (story: Story, owner: UserAccount) => void;
  pipeline?: OpeningJobPipeline;
  applyOpening?(
    prepared: PreparedStoryOpening,
    connection: ModelConnection,
    outcome: Extract<OpeningGenerationOutcome, { status: "completed" }>,
    publicationGate: StoryOpeningPublicationGate,
  ): Story;
  now?: () => Date;
  createId?: (prefix: "job" | "narration_case") => string;
  sealPayload?: typeof sealNarrationReviewPayload;
  openPayload?: typeof openNarrationReviewPayload;
  sealExcerpt?: typeof sealNarrationReviewExcerpt;
}

export interface StartOpeningJobInput {
  owner: UserAccount;
  input: CreateStoryInput;
  connectionId: string;
  idempotencyKey: string;
}

function httpError(message: string, status: number, code?: string): Error {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((value, index) => value === right[index]);
}

function jobFailurePayload(job: GenerationJob, store: AppStore): OpeningJobStatusPayload {
  const failure = store.generationFailures.find((item) => item.jobId === job.id && item.terminal);
  const message = sanitizeGenerationFailureMessage(job.filterSummary || failure?.message || "开篇生成失败，可以安全重试。");
  return {
    jobId: job.id,
    status: "failed",
    message,
    retryable: failure?.retryable ?? classifyGenerationFailure(message).retryable,
  };
}

function projectPendingReview(
  review: NarrationReviewCaseRecord,
  payload: StoredOpeningReviewPayload,
): PendingNarrationReviewView {
  if (
    payload.version !== 1 ||
    payload.checkpoint.version !== 1 ||
    payload.checkpoint.review.contentHash !== review.contentHash ||
    payload.checkpoint.review.candidates.length === 0 ||
    !sameIds(
      payload.checkpoint.review.candidates.map((candidate) => candidate.id),
      review.candidateMetadata.map((candidate) => candidate.id),
    )
  ) {
    throw httpError("待确认内容已经失效，请安全重试开书。", 409, "narration_review_checkpoint_invalid");
  }
  return {
    id: review.id,
    version: review.version,
    jobId: review.jobId,
    contentHash: review.contentHash,
    deadlineAt: review.deadlineAt,
    candidates: payload.checkpoint.review.candidates.map((candidate) => ({
      id: candidate.id,
      ruleId: candidate.ruleId,
      location: candidate.location,
      matchedText: candidate.matchedText,
      sentence: candidate.sentence,
      ...(candidate.previousSentence ? { previousSentence: candidate.previousSentence } : {}),
      ...(candidate.nextSentence ? { nextSentence: candidate.nextSentence } : {}),
      highlightStart: Math.max(0, candidate.matchStart - candidate.sentenceStart),
      highlightEnd: Math.max(0, candidate.matchEnd - candidate.sentenceStart),
    })),
  };
}

function defaultPipeline(): OpeningJobPipeline {
  return {
    begin: (context, connection, observer) => beginStoryOpeningGeneration(
      context,
      connection,
      undefined,
      OPENING_JOB_TOKEN_BUDGET,
      observer,
    ),
    resume: (checkpoint, action, connection, observer) => resumeStoryOpeningGeneration(
      checkpoint,
      action,
      connection,
      undefined,
      observer,
    ),
  };
}

export class OpeningJobService {
  private readonly store: AppStore;
  private readonly persistence: OpeningJobPersistence;
  private readonly pipeline: OpeningJobPipeline;
  private readonly now: () => Date;
  private readonly createId: (prefix: "job" | "narration_case") => string;
  private readonly sealPayload: typeof sealNarrationReviewPayload;
  private readonly openPayload: typeof openNarrationReviewPayload;
  private readonly activeCases = new Set<string>();
  private readonly sealExcerpt: typeof sealNarrationReviewExcerpt;
  private readonly backgroundTasks = new Set<Promise<void>>();

  constructor(private readonly dependencies: OpeningJobServiceDependencies) {
    this.store = dependencies.store;
    this.persistence = dependencies.persistence;
    this.pipeline = dependencies.pipeline ?? defaultPipeline();
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.sealPayload = dependencies.sealPayload ?? sealNarrationReviewPayload;
    this.openPayload = dependencies.openPayload ?? openNarrationReviewPayload;
    this.sealExcerpt = dependencies.sealExcerpt ?? sealNarrationReviewExcerpt;
  }

  private ownerOrThrow(ownerId: string): UserAccount {
    const owner = this.store.users.find((candidate) => candidate.id === ownerId);
    if (!owner) throw httpError("生成任务不存在或不属于当前账号。", 404);
    return owner;
  }

  private cacheJob(job: GenerationJob): GenerationJob {
    const existing = this.store.jobs.find((candidate) => candidate.id === job.id);
    if (existing) {
      Object.assign(existing, job);
      return existing;
    }
    this.store.jobs.unshift(job);
    return job;
  }

  private async existingJob(ownerId: string, idempotencyKey: string): Promise<GenerationJob | null> {
    const cached = this.store.jobs.find((candidate) =>
      candidate.ownerId === ownerId && candidate.idempotencyKey === idempotencyKey
    );
    if (cached) return cached;
    const persisted = await this.persistence.findJob(ownerId, idempotencyKey);
    return persisted ? this.cacheJob(persisted) : null;
  }

  private failureObserver(job: GenerationJob, startedAt: number): OpeningFailureObserver {
    return async (failure) => {
      appendGenerationFailure(this.store, createGenerationFailureObservation(job, failure.error, {
        stage: failure.stage,
        attempt: failure.attempt,
        terminal: false,
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        tokens: job.tokens,
      }));
      await this.persistence.save();
    };
  }

  private async writeReviewFeedback(
    review: NarrationReviewCaseRecord,
    payload: StoredOpeningReviewPayload,
    options: {
      resolutionSource: NarrationReviewFeedbackRecord["resolutionSource"];
      userDecision: NarrationReviewFeedbackRecord["userDecision"];
      rewriteSucceeded: boolean | null;
      jobCompleted: boolean | null;
      excerpt?: NarrationReviewFeedbackRecord["consentedExcerptCiphertext"];
      excerptExpiresAt?: string | null;
    },
  ): Promise<void> {
    const updatedAt = this.now().toISOString();
    const job = this.store.jobs.find((candidate) => candidate.id === review.jobId);
    for (const candidate of review.candidateMetadata) {
      const assessment = review.assessmentMetadata.find((item) => item.candidateId === candidate.id);
      const feedback: NarrationReviewFeedbackRecord = {
        id: `narration_feedback_${review.jobId}_${candidate.id}`,
        caseId: review.id,
        jobId: review.jobId,
        ownerId: review.ownerId,
        candidateId: candidate.id,
        ruleId: candidate.ruleId,
        ruleVersion: candidate.ruleVersion,
        location: candidate.location,
        model: payload.checkpoint.connectionBinding.routes.extractor,
        reportedDecision: assessment?.reportedDecision ?? "ask_user",
        decision: assessment?.decision ?? "ask_user",
        confidence: assessment?.confidence ?? 0,
        threshold: payload.checkpoint.review.resolution.threshold,
        resolutionSource: options.resolutionSource,
        userDecision: options.userDecision,
        rewriteCount: payload.checkpoint.rewriteCount,
        rewriteSucceeded: options.rewriteSucceeded,
        jobCompleted: options.jobCompleted,
        latencyMs: Math.max(0, job?.latencyMs ?? 0),
        contentHash: review.contentHash,
        consentedExcerptCiphertext: options.excerpt ?? null,
        excerptExpiresAt: options.excerptExpiresAt ?? null,
        createdAt: review.createdAt,
        updatedAt,
      };
      try {
        await this.persistence.upsertNarrationReviewFeedback(feedback);
      } catch (error) {
        console.error(`[NARRATION-REVIEW] Failed to persist structured feedback: ${sanitizeGenerationFailureMessage(error)}`);
      }
    }
  }

  private async writeAutomaticFeedback(
    job: GenerationJob,
    reviewerModel: string,
    traces: readonly OpeningNarrationReviewTrace[],
    completed: boolean | null,
  ): Promise<void> {
    const updatedAt = this.now().toISOString();
    for (const trace of traces) {
      for (const candidate of trace.candidates) {
        const assessment = trace.resolution.assessments.find((item) =>
          item.candidateId === candidate.id
        );
        if (!assessment || assessment.decision === "ask_user") continue;
        const rewriteAttempted = assessment.decision === "rewrite";
        const feedback: NarrationReviewFeedbackRecord = {
          id: `narration_feedback_${job.id}_${candidate.id}`,
          caseId: null,
          jobId: job.id,
          ownerId: job.ownerId,
          candidateId: candidate.id,
          ruleId: candidate.ruleId,
          ruleVersion: candidate.ruleVersion,
          location: candidate.location,
          model: reviewerModel,
          reportedDecision: assessment.reportedDecision,
          decision: assessment.decision,
          confidence: assessment.confidence,
          threshold: trace.resolution.threshold,
          resolutionSource: "automatic",
          userDecision: null,
          rewriteCount: Math.max(trace.rewriteCount, rewriteAttempted ? 1 : 0),
          rewriteSucceeded: rewriteAttempted && completed !== null ? completed : null,
          jobCompleted: completed,
          latencyMs: Math.max(0, job.latencyMs),
          contentHash: trace.contentHash,
          consentedExcerptCiphertext: null,
          excerptExpiresAt: null,
          createdAt: job.createdAt,
          updatedAt,
        };
        try {
          await this.persistence.upsertNarrationReviewFeedback(feedback);
        } catch (error) {
          console.error(
            `[NARRATION-REVIEW] Failed to persist automatic feedback: ${sanitizeGenerationFailureMessage(error)}`,
          );
        }
      }
    }
  }

  private async writeDecisionFeedback(
    review: NarrationReviewCaseRecord,
    payload: StoredOpeningReviewPayload,
    decision: "keep" | "rewrite" | null,
    source: "user" | "timeout",
    shareRedactedContext: boolean,
  ): Promise<void> {
    let excerpt: NarrationReviewFeedbackRecord["consentedExcerptCiphertext"] = null;
    let excerptExpiresAt: string | null = null;
    if (shareRedactedContext) {
      try {
        excerpt = await this.sealExcerpt(
          review,
          payload.checkpoint.review.candidates,
        );
        excerptExpiresAt = new Date(this.now().getTime() + REVIEW_EXCERPT_TTL_MS).toISOString();
      } catch (error) {
        console.error(`[NARRATION-REVIEW] Failed to encrypt consented feedback: ${sanitizeGenerationFailureMessage(error)}`);
      }
    }
    await this.writeReviewFeedback(review, payload, {
      resolutionSource: source,
      userDecision: decision,
      rewriteSucceeded: null,
      jobCompleted: null,
      excerpt,
      excerptExpiresAt,
    });
  }

  private async writeFinalFeedback(
    review: NarrationReviewCaseRecord,
    payload: StoredOpeningReviewPayload,
    completed: boolean,
  ): Promise<void> {
    const source = review.decisionSource === "timeout" ? "timeout" :
      review.decisionSource === "user" ? "user" : "system";
    const userDecision = review.status === "kept" ? "keep" :
      review.status === "rewrite_requested" ? "rewrite" : null;
    const rewriteAttempted = review.status === "rewrite_requested"
      || review.status === "timeout_rewrite"
      || payload.checkpoint.rewriteCount > 0;
    await this.writeReviewFeedback(review, payload, {
      resolutionSource: source,
      userDecision,
      rewriteSucceeded: rewriteAttempted ? completed : null,
      jobCompleted: completed,
    });
  }

  private async statusForJob(job: GenerationJob): Promise<OpeningJobStatusPayload> {
    if (job.status === "completed") {
      return { jobId: job.id, status: "completed", storyId: job.storyId };
    }
    if (job.status === "failed") return jobFailurePayload(job, this.store);
    if (job.status === "running") return { jobId: job.id, status: "running" };
    const review = await this.persistence.getNarrationReviewCaseForOwner(job.ownerId, job.id);
    if (!review || review.status !== "pending") {
      return { jobId: job.id, status: "running" };
    }
    if (!review.encryptedPayload) {
      throw httpError("待确认内容已经失效，请安全重试开书。", 409, "narration_review_state_unavailable");
    }
    const payload = await this.openPayload<StoredOpeningReviewPayload>(review, review.encryptedPayload);
    return {
      jobId: job.id,
      status: "awaiting_user_review",
      review: projectPendingReview(review, payload),
    };
  }

  async getStatus(ownerId: string, jobId: string): Promise<OpeningJobStatusPayload> {
    const job = this.store.jobs.find((candidate) => candidate.id === jobId && candidate.ownerId === ownerId);
    if (!job) throw httpError("生成任务不存在或不属于当前账号。", 404);
    return this.statusForJob(job);
  }

  private async pauseForReview(
    job: GenerationJob,
    prepared: PreparedStoryOpening,
    outcome: Extract<OpeningGenerationOutcome, { status: "awaiting_user_review" }>,
    priorCaseId?: string,
  ): Promise<OpeningJobStatusPayload> {
    const createdAt = this.now();
    const caseId = this.createId("narration_case");
    const identity = {
      caseId,
      jobId: job.id,
      ownerId: job.ownerId,
      contentHash: outcome.review.contentHash,
    };
    const storedPayload: StoredOpeningReviewPayload = {
      version: 1,
      prepared,
      checkpoint: outcome.checkpoint,
    };
    const encryptedPayload = await this.sealPayload(identity, storedPayload);
    const ambiguousIds = new Set(outcome.review.candidates.map((candidate) => candidate.id));
    const review: NarrationReviewCaseRecord = {
      ...identity,
      id: caseId,
      attempt: outcome.review.attempt,
      rewriteCount: outcome.review.rewriteCount,
      status: "pending",
      version: 1,
      deadlineAt: new Date(createdAt.getTime() + REVIEW_DEADLINE_MS).toISOString(),
      payloadExpiresAt: new Date(createdAt.getTime() + REVIEW_PAYLOAD_TTL_MS).toISOString(),
      decisionSource: null,
      candidateMetadata: outcome.review.candidates.map(projectNarrationCandidateMetadata),
      assessmentMetadata: outcome.review.resolution.assessments
        .filter((assessment) => ambiguousIds.has(assessment.candidateId))
        .map(projectNarrationAssessmentMetadata),
      encryptedPayload,
      createdAt: createdAt.toISOString(),
      resolvedAt: null,
    };
    Object.assign(job, {
      status: "awaiting_user_review" as const,
      tokens: outcome.checkpoint.accumulatedTokens,
      usageEstimated: outcome.checkpoint.usageEstimated,
      cost: Number(((outcome.checkpoint.accumulatedTokens / 1_000_000) * 1.2).toFixed(4)),
      costEstimated: outcome.checkpoint.usageEstimated,
      latencyMs: Math.max(0, createdAt.getTime() - Date.parse(job.createdAt)),
      filterSummary: "第一章有一句话需要你判断；90 秒无操作将自动重写。",
    });
    if (priorCaseId) {
      const replaced = await this.persistence.replaceNarrationReviewCase(
        priorCaseId,
        job,
        review,
        createdAt.toISOString(),
      );
      if (!replaced) throw httpError("待确认任务已被其他请求处理，请刷新状态。", 409);
    } else {
      await this.persistence.pauseOpeningForNarrationReview(job, review);
    }
    await this.writeReviewFeedback(review, storedPayload, {
      resolutionSource: "system",
      userDecision: null,
      rewriteSucceeded: null,
      jobCompleted: null,
    });
    await this.writeAutomaticFeedback(
      job,
      outcome.checkpoint.connectionBinding.routes.extractor,
      outcome.checkpoint.reviewTrace ?? [],
      null,
    );
    return {
      jobId: job.id,
      status: "awaiting_user_review",
      review: projectPendingReview(review, storedPayload),
    };
  }

  private publicationGate(owner: UserAccount): StoryOpeningPublicationGate {
    return (story) => {
      if (this.dependencies.publicationGate) {
        this.dependencies.publicationGate(story, owner);
      } else {
        assertStoryOpeningPublicationSafe(story);
      }
    };
  }

  private async completeJob(
    job: GenerationJob,
    owner: UserAccount,
    connection: ModelConnection,
    prepared: PreparedStoryOpening,
    outcome: Extract<OpeningGenerationOutcome, { status: "completed" }>,
    caseId?: string,
  ): Promise<Story> {
    const gate = this.publicationGate(owner);
    const story = this.dependencies.applyOpening
      ? this.dependencies.applyOpening(prepared, connection, outcome, gate)
      : applyGeneratedStoryOpening(
          prepared.story,
          connection,
          outcome.generated,
          outcome.narrationPermit,
          gate,
        );
    const previous = {
      stories: [...this.store.stories],
      jobs: structuredClone(this.store.jobs),
      storyCreationRequests: [...this.store.storyCreationRequests],
      auditEvents: [...this.store.auditEvents],
      activeStoryId: owner.activeStoryId,
    };
    const completedAt = this.now();
    Object.assign(job, {
      storyId: story.id,
      storyTitle: story.title,
      status: "completed" as const,
      tokens: outcome.generated.usageTokens,
      usageEstimated: outcome.generated.usageEstimated,
      latencyMs: Math.max(0, completedAt.getTime() - Date.parse(job.createdAt)),
      firstTokenMs: Math.max(0, completedAt.getTime() - Date.parse(job.createdAt)),
      cost: Number(((outcome.generated.usageTokens / 1_000_000) * 1.2).toFixed(4)),
      costEstimated: outcome.generated.usageEstimated,
      filterSummary: "规划、正文、阅读体验与上下文语义检查均已通过。",
    });
    this.store.stories = this.store.stories.filter((candidate) => candidate.id !== story.id);
    this.store.stories.unshift(story);
    owner.activeStoryId = story.id;
    if (!this.store.storyCreationRequests.some((request) =>
      request.userId === owner.id && request.idempotencyKey === job.idempotencyKey
    )) {
      this.store.storyCreationRequests.push({
        userId: owner.id,
        idempotencyKey: job.idempotencyKey ?? job.id,
        storyId: story.id,
        createdAt: completedAt.toISOString(),
      });
      this.store.storyCreationRequests = this.store.storyCreationRequests.slice(-500);
    }
    if (!this.store.auditEvents.some((event) =>
      event.action === "story.create" && event.targetId === story.id
    )) {
      audit(this.store, owner.id, "story.create", "story", story.id, {
        genre: story.genre,
        connectionId: connection.id,
        planner: connection.routes.planner,
        writer: connection.routes.writer,
      });
    }
    const rollback = () => {
      this.store.stories = previous.stories;
      this.store.jobs = previous.jobs;
      this.store.storyCreationRequests = previous.storyCreationRequests;
      this.store.auditEvents = previous.auditEvents;
      owner.activeStoryId = previous.activeStoryId;
    };
    try {
      await this.persistence.save(rollback);
    } catch (error) {
      rollback();
      throw error;
    }
    if (caseId) {
      try {
        await this.persistence.resolveNarrationReviewCase(caseId, "resolved", completedAt.toISOString());
      } catch (error) {
        console.error(`[NARRATION-REVIEW] 完成故事后清理待确认状态失败：${sanitizeGenerationFailureMessage(error)}`);
      }
    }
    return story;
  }

  private async failJob(
    job: GenerationJob,
    error: unknown,
    startedAt: number,
    caseId?: string,
  ): Promise<void> {
    recordFailedJobUsage(job, error, {
      tokens: job.tokens,
      estimated: job.usageEstimated ?? true,
      costPerMillion: 1.2,
    });
    const message = sanitizeGenerationFailureMessage(error);
    Object.assign(job, {
      status: "failed" as const,
      latencyMs: Math.max(0, this.now().getTime() - startedAt),
      filterSummary: `${message || "开篇生成失败"}；故事未创建，可以安全重试。`,
    });
    appendGenerationFailure(this.store, createGenerationFailureObservation(job, error, {
      stage: "开篇生成",
      terminal: true,
      latencyMs: job.latencyMs,
      tokens: job.tokens,
    }));
    if (job.idempotencyKey) {
      await this.persistence.releaseIdempotencyKey(job.ownerId, job.idempotencyKey);
    }
    await this.persistence.save();
    if (caseId) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      await this.persistence.resolveNarrationReviewCase(
        caseId,
        code === "narration_review_state_unavailable" || code === "narration_review_checkpoint_invalid"
          ? "failed"
          : "resolved",
        this.now().toISOString(),
      );
    }
  }

  async start(input: StartOpeningJobInput): Promise<CreateStoryResult> {
    const priorStoryId = await this.persistence.findStoryCreationRequest(input.owner.id, input.idempotencyKey);
    if (priorStoryId) {
      const story = await this.persistence.loadStory(input.owner.id, priorStoryId);
      if (story) return { kind: "completed", story };
    }
    const priorJob = await this.existingJob(input.owner.id, input.idempotencyKey);
    if (priorJob) return { kind: "job", job: await this.statusForJob(priorJob) };

    const connection = this.dependencies.resolveConnection(input.owner, input.connectionId);
    await this.dependencies.admitStart?.(input.owner, input.input, connection);
    const reserved = await this.persistence.reserveIdempotencyKey(input.owner.id, input.idempotencyKey);
    if (!reserved) {
      const racedJob = await this.existingJob(input.owner.id, input.idempotencyKey);
      if (racedJob) return { kind: "job", job: await this.statusForJob(racedJob) };
      throw httpError("相同开书请求正在提交，请安全重试同一幂等键。", 409);
    }

    const createdAt = this.now();
    const job: GenerationJob = {
      id: this.createId("job"),
      ownerId: input.owner.id,
      storyId: `opening_pending_${randomUUID().slice(0, 8)}`,
      idempotencyKey: input.idempotencyKey,
      storyTitle: "正在生成新故事",
      chapterNumber: 1,
      task: "opening",
      model: connection.routes.writer,
      connectionId: connection.id,
      promptVersion: "opening-v1",
      status: "running",
      tokens: 0,
      tokenBudget: OPENING_JOB_TOKEN_BUDGET,
      usageEstimated: true,
      latencyMs: 0,
      cost: 0,
      costEstimated: true,
      createdAt: createdAt.toISOString(),
      filterSummary: "规划两个阅读体验并生成第一章。",
    };
    this.store.jobs.unshift(job);
    try {
      await this.persistence.save();
    } catch (error) {
      this.store.jobs = this.store.jobs.filter((candidate) => candidate.id !== job.id);
      await this.persistence.releaseIdempotencyKey(input.owner.id, input.idempotencyKey);
      throw error;
    }

    const prepared = prepareStoryOpening(input.input, input.owner.id);
    let automaticReviews: OpeningNarrationReviewTrace[] = [];
    try {
      const outcome = await this.pipeline.begin(
        prepared.context,
        connection,
        this.failureObserver(job, createdAt.getTime()),
      );
      if (outcome.status === "awaiting_user_review") {
        const status = await this.pauseForReview(job, prepared, outcome);
        return { kind: "job", job: status };
      }
      automaticReviews = outcome.narrationReviews ?? [];
      const story = await this.completeJob(job, input.owner, connection, prepared, outcome);
      await this.writeAutomaticFeedback(
        job,
        connection.routes.extractor,
        outcome.narrationReviews ?? [],
        true,
      );
      return { kind: "completed", story };
    } catch (error) {
      const failedReviews = openingNarrationReviewsFromError(error);
      if (failedReviews.length > 0) automaticReviews = failedReviews;
      await this.failJob(job, error, createdAt.getTime());
      await this.writeAutomaticFeedback(job, connection.routes.extractor, automaticReviews, false);
      if (error instanceof Error && !("status" in error)) {
        Object.assign(error, { status: /体验|沉浸|Schema|第一章|开篇/.test(error.message) ? 422 : 502 });
      }
      throw error;
    }
  }

  async decideNarrationReview(
    ownerId: string,
    jobId: string,
    decision: NarrationReviewDecisionInput,
  ): Promise<OpeningJobStatusPayload> {
    const job = this.store.jobs.find((candidate) => candidate.id === jobId && candidate.ownerId === ownerId);
    if (!job) throw httpError("生成任务不存在或不属于当前账号。", 404);
    const review = await this.persistence.getNarrationReviewCaseForOwner(ownerId, jobId);
    if (!review) {
      if (job.status === "running" || job.status === "completed" || job.status === "failed") {
        return this.statusForJob(job);
      }
      throw httpError("待确认内容不存在或已经结束。", 409);
    }
    const requestedStatus = decision.decision === "keep" ? "kept" : "rewrite_requested";
    if (review.status !== "pending") {
      if (review.status === requestedStatus) return this.statusForJob(job);
      throw httpError("这次待确认内容已经由另一个操作处理，请刷新状态。", 409);
    }
    if (
      decision.caseId !== review.id ||
      decision.caseVersion !== review.version ||
      decision.contentHash !== review.contentHash
    ) {
      throw httpError("待确认内容已经变化，请刷新后再选择。", 409);
    }
    if (!review.encryptedPayload) {
      throw httpError("待确认内容已经失效，请安全重试开书。", 409, "narration_review_state_unavailable");
    }
    const payload = await this.openPayload<StoredOpeningReviewPayload>(review, review.encryptedPayload);
    const expectedIds = payload.checkpoint.review.candidates.map((candidate) => candidate.id);
    if (!sameIds(decision.candidateIds, expectedIds)) {
      throw httpError("待确认句子已经变化，请刷新后再选择。", 409);
    }
    const claimed = await this.persistence.claimNarrationReviewDecision({
      id: review.id,
      ownerId,
      expectedVersion: decision.caseVersion,
      contentHash: decision.contentHash,
      status: requestedStatus,
      decisionSource: "user",
      decidedAt: this.now().toISOString(),
    });
    if (!claimed) {
      const latest = await this.persistence.getNarrationReviewCaseForOwner(ownerId, jobId);
      if (latest?.status === requestedStatus) return this.statusForJob(job);
      throw httpError("这次待确认内容已经由另一个操作处理，请刷新状态。", 409);
    }
    await this.writeDecisionFeedback(
      claimed,
      payload,
      decision.decision,
      "user",
      decision.shareRedactedContext,
    );
    job.status = "running";
    job.filterSummary = decision.decision === "keep" ? "正在保留原文并完成其他质量检查。" : "正在按你的选择重写第一章。";
    await this.persistence.save();
    this.enqueueClaimedCase(claimed.id);
    return { jobId: job.id, status: "running" };
  }

  private async expireReview(
    review: NarrationReviewCaseRecord,
    job: GenerationJob,
  ): Promise<void> {
    const now = this.now().toISOString();
    const error = Object.assign(
      new Error("Narration review payload expired before the job could resume."),
      { code: "narration_review_payload_expired" },
    );
    await this.failJob(job, error, Date.parse(job.createdAt));
    const expired = await this.persistence.failExpiredNarrationReviewCase(review.id, now);
    if (!expired) {
      throw httpError("Narration review payload expiry could not be claimed.", 409);
    }
  }

  private enqueueClaimedCase(caseId: string): void {
    const task = this.resumeClaimedCase(caseId).catch((error) => {
      console.error(`[NARRATION-REVIEW] 后台恢复失败：${sanitizeGenerationFailureMessage(error)}`);
    });
    this.backgroundTasks.add(task);
    void task.finally(() => this.backgroundTasks.delete(task));
  }

  async resumeClaimedCase(caseId: string): Promise<void> {
    if (this.activeCases.has(caseId)) return;
    this.activeCases.add(caseId);
    let review: NarrationReviewCaseRecord | null = null;
    let job: GenerationJob | undefined;
    try {
      review = await this.persistence.getNarrationReviewCaseById(caseId);
      if (!review || review.status === "resolved" || review.status === "failed") return;
      job = this.store.jobs.find((candidate) => candidate.id === review!.jobId && candidate.ownerId === review!.ownerId);
      if (!job) throw httpError("待恢复的生成任务不存在。", 404, "narration_review_state_unavailable");
      if (job.status === "completed" || job.status === "failed") {
        await this.persistence.resolveNarrationReviewCase(review.id, "resolved", this.now().toISOString());
        return;
      }
      if (Date.parse(review.payloadExpiresAt) <= this.now().getTime()) {
        await this.expireReview(review, job);
        return;
      }
      if (review.status === "pending") return;
      if (!review.encryptedPayload) {
        throw httpError("待确认内容已经失效。", 409, "narration_review_state_unavailable");
      }
      const payload = await this.openPayload<StoredOpeningReviewPayload>(review, review.encryptedPayload);
      const owner = this.ownerOrThrow(review.ownerId);
      const connection = this.dependencies.resolveConnection(owner, payload.checkpoint.connectionBinding.id);
      const startedAt = Date.parse(job.createdAt);
      const userDecision = review.status === "kept" ? "keep" :
        review.status === "rewrite_requested" ? "rewrite" : null;
      await this.writeDecisionFeedback(
        review,
        payload,
        userDecision,
        review.status === "timeout_rewrite" ? "timeout" : "user",
        false,
      );
      job.status = "running";
      job.tokens = payload.checkpoint.accumulatedTokens;
      job.usageEstimated = payload.checkpoint.usageEstimated;
      await this.persistence.save();
      const action = review.status === "kept"
        ? {
            kind: "keep" as const,
            candidateIds: payload.checkpoint.review.candidates.map((candidate) => candidate.id),
            contentHash: review.contentHash,
          }
        : {
            kind: "rewrite" as const,
            source: review.status === "timeout_rewrite" ? "timeout" as const : "user" as const,
          };
      let automaticReviews = structuredClone(payload.checkpoint.reviewTrace ?? []);
      try {
        const outcome = await this.pipeline.resume(
          payload.checkpoint,
          action,
          connection,
          this.failureObserver(job, startedAt),
        );
        if (outcome.status === "awaiting_user_review") {
          await this.pauseForReview(job, payload.prepared, outcome, review.id);
          return;
        }
        automaticReviews = outcome.narrationReviews ?? automaticReviews;
        await this.completeJob(job, owner, connection, payload.prepared, outcome, review.id);
        await this.writeAutomaticFeedback(
          job,
          connection.routes.extractor,
          outcome.narrationReviews ?? [],
          true,
        );
        await this.writeFinalFeedback(review, payload, true);
      } catch (error) {
        const failedReviews = openingNarrationReviewsFromError(error);
        if (failedReviews.length > 0) automaticReviews = failedReviews;
        await this.failJob(job, error, startedAt, review.id);
        await this.writeAutomaticFeedback(
          job,
          connection.routes.extractor,
          automaticReviews,
          false,
        );
        await this.writeFinalFeedback(review, payload, false);
      }
    } catch (error) {
      if (review && job && job.status !== "completed" && job.status !== "failed") {
        await this.failJob(job, error, Date.parse(job.createdAt), review.id);
        return;
      }
      throw error;
    } finally {
      this.activeCases.delete(caseId);
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.all([...this.backgroundTasks]);
    }
  }
}
