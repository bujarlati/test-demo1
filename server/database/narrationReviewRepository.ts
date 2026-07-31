import type { GenerationJob } from "../../src/types";
import {
  normalizeNarrationAssessmentMetadata,
  normalizeNarrationCandidateMetadata,
  type EncryptedEnvelopeV1,
  type NarrationReviewCaseRecord,
  type NarrationReviewCleanupCounts,
  type NarrationReviewDecisionClaim,
  type NarrationReviewFeedbackRecord,
} from "../narrationReviewState";
import { DELETED_STORY_PLACEHOLDER } from "../storyDeletion";
import type { DatabaseExecutor } from "./types";

interface NarrationReviewCaseRow {
  id: string;
  job_id: string;
  owner_id: string;
  content_hash: string;
  attempt: number;
  rewrite_count: number;
  status: NarrationReviewCaseRecord["status"];
  version: number;
  deadline_at: Date | string;
  payload_expires_at: Date | string;
  decision_source: NarrationReviewCaseRecord["decisionSource"];
  candidate_metadata: unknown;
  assessment_metadata: unknown;
  encrypted_payload: unknown | null;
  created_at: Date | string;
  resolved_at: Date | string | null;
}

const caseColumns = `
  id, job_id, owner_id, content_hash, attempt, rewrite_count, status, version,
  deadline_at, payload_expires_at, decision_source, candidate_metadata,
  assessment_metadata, encrypted_payload, created_at, resolved_at
`;

function parseJson<Value>(value: unknown): Value {
  return (typeof value === "string" ? JSON.parse(value) : value) as Value;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toCase(row: NarrationReviewCaseRow): NarrationReviewCaseRecord {
  return {
    id: row.id,
    caseId: row.id,
    jobId: row.job_id,
    ownerId: row.owner_id,
    contentHash: row.content_hash,
    attempt: row.attempt,
    rewriteCount: row.rewrite_count,
    status: row.status,
    version: row.version,
    deadlineAt: iso(row.deadline_at),
    payloadExpiresAt: iso(row.payload_expires_at),
    decisionSource: row.decision_source,
    candidateMetadata: normalizeNarrationCandidateMetadata(parseJson(row.candidate_metadata)),
    assessmentMetadata: normalizeNarrationAssessmentMetadata(parseJson(row.assessment_metadata)),
    encryptedPayload: row.encrypted_payload === null
      ? null
      : parseJson<EncryptedEnvelopeV1>(row.encrypted_payload),
    createdAt: iso(row.created_at),
    resolvedAt: row.resolved_at === null ? null : iso(row.resolved_at),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function assertPauseInput(job: GenerationJob, review: NarrationReviewCaseRecord): void {
  if (job.status !== "awaiting_user_review") {
    throw new Error("Only an awaiting_user_review job can be paused.");
  }
  if (
    review.id !== review.caseId ||
    review.jobId !== job.id ||
    review.ownerId !== job.ownerId ||
    review.status !== "pending" ||
    review.version < 1 ||
    review.encryptedPayload === null
  ) {
    throw new Error("Invalid narration review pause state.");
  }
}

interface LockedGenerationJobRow {
  owner_id: string;
  story_id: string;
  status: GenerationJob["status"];
}

function narrationReviewStateUnavailable(): Error {
  return Object.assign(new Error("Narration review state is unavailable."), {
    code: "narration_review_state_unavailable" as const,
  });
}

async function lockGenerationJob(
  executor: DatabaseExecutor,
  jobId: string,
): Promise<LockedGenerationJobRow | null> {
  const result = await executor.query<LockedGenerationJobRow>(
    `SELECT owner_id, story_id, status FROM xumo_generation_jobs
     WHERE id = $1
     FOR UPDATE`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function lockMatchingGenerationJob(
  executor: DatabaseExecutor,
  job: GenerationJob,
): Promise<LockedGenerationJobRow | null> {
  const result = await executor.query<LockedGenerationJobRow>(
    `SELECT owner_id, story_id, status FROM xumo_generation_jobs
     WHERE id = $1
       AND owner_id = $2
       AND story_id = $3
       AND task = $4
       AND created_at = $5::timestamptz
     FOR UPDATE`,
    [job.id, job.ownerId, job.storyId, job.task, job.createdAt],
  );
  return result.rows[0] ?? null;
}

function isLiveBoundJob(
  locked: LockedGenerationJobRow | null,
  job: GenerationJob,
): boolean {
  return locked !== null
    && locked.owner_id === job.ownerId
    && locked.story_id === job.storyId
    && (locked.status === "running" || locked.status === "awaiting_user_review");
}

async function updateGenerationJob(
  executor: DatabaseExecutor,
  job: GenerationJob,
): Promise<void> {
  const result = await executor.query<{ id: string }>(
    `UPDATE xumo_generation_jobs
     SET status = $2, payload = $3::jsonb
     WHERE id = $1
     RETURNING id`,
    [job.id, job.status, stableJson(job)],
  );
  if (result.rows.length === 0) throw narrationReviewStateUnavailable();
}

async function insertReviewCase(
  executor: DatabaseExecutor,
  review: NarrationReviewCaseRecord,
): Promise<void> {
  const candidates = normalizeNarrationCandidateMetadata(review.candidateMetadata);
  const assessments = normalizeNarrationAssessmentMetadata(review.assessmentMetadata);
  await executor.query(
    `INSERT INTO xumo_narration_review_cases(
       id, job_id, owner_id, content_hash, attempt, rewrite_count, status, version,
       deadline_at, payload_expires_at, decision_source, candidate_metadata,
       assessment_metadata, encrypted_payload, created_at, resolved_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12::jsonb,
       $13::jsonb, $14::jsonb, $15, $16
     )`,
    [
      review.id,
      review.jobId,
      review.ownerId,
      review.contentHash,
      review.attempt,
      review.rewriteCount,
      review.status,
      review.version,
      review.deadlineAt,
      review.payloadExpiresAt,
      review.decisionSource,
      stableJson(candidates),
      stableJson(assessments),
      review.encryptedPayload ? stableJson(review.encryptedPayload) : null,
      review.createdAt,
      review.resolvedAt,
    ],
  );
}

export class NarrationReviewPostgresRepository {
  constructor(private readonly executor: DatabaseExecutor) {}

  async pauseOpeningForNarrationReview(
    job: GenerationJob,
    review: NarrationReviewCaseRecord,
  ): Promise<void> {
    assertPauseInput(job, review);
    await this.executor.transaction(async (transaction) => {
      const locked = await lockMatchingGenerationJob(transaction, job);
      if (!isLiveBoundJob(locked, job)) {
        throw narrationReviewStateUnavailable();
      }
      await updateGenerationJob(transaction, job);
      await insertReviewCase(transaction, review);
    });
  }

  async getNarrationReviewCaseForOwner(
    ownerId: string,
    jobId: string,
  ): Promise<NarrationReviewCaseRecord | null> {
    const result = await this.executor.query<NarrationReviewCaseRow>(
      `SELECT ${caseColumns}
       FROM xumo_narration_review_cases
       WHERE owner_id = $1 AND job_id = $2
         AND status IN ('pending', 'kept', 'rewrite_requested', 'timeout_rewrite')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [ownerId, jobId],
    );
    return result.rows[0] ? toCase(result.rows[0]) : null;
  }

  async getNarrationReviewCaseById(id: string): Promise<NarrationReviewCaseRecord | null> {
    const result = await this.executor.query<NarrationReviewCaseRow>(
      `SELECT ${caseColumns} FROM xumo_narration_review_cases WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? toCase(result.rows[0]) : null;
  }

  async claimNarrationReviewDecision(
    claim: NarrationReviewDecisionClaim,
  ): Promise<NarrationReviewCaseRecord | null> {
    const isUserDecision = claim.decisionSource === "user";
    const validStatus = isUserDecision
      ? claim.status === "kept" || claim.status === "rewrite_requested"
      : claim.status === "timeout_rewrite";
    if (!validStatus || (isUserDecision && !claim.ownerId)) {
      throw new Error("Invalid narration review decision claim.");
    }
    const result = await this.executor.query<NarrationReviewCaseRow>(
      `UPDATE xumo_narration_review_cases
       SET status = $4, version = version + 1, decision_source = $5
       WHERE id = $1
         AND status = 'pending'
         AND version = $2
         AND content_hash = $3
         AND payload_expires_at > $6
         AND ($5 <> 'user' OR deadline_at > $6)
         AND ($7::text IS NULL OR owner_id = $7)
       RETURNING ${caseColumns}`,
      [
        claim.id,
        claim.expectedVersion,
        claim.contentHash,
        claim.status,
        claim.decisionSource,
        claim.decidedAt,
        claim.ownerId ?? null,
      ],
    );
    return result.rows[0] ? toCase(result.rows[0]) : null;
  }

  async claimExpiredNarrationReviews(
    now: string,
    limit: number,
  ): Promise<NarrationReviewCaseRecord[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
    const result = await this.executor.query<NarrationReviewCaseRow>(
      `WITH due AS (
         SELECT id
         FROM xumo_narration_review_cases
         WHERE status = 'pending'
           AND deadline_at <= $1
           AND payload_expires_at > $1
         ORDER BY deadline_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE xumo_narration_review_cases AS review
       SET status = 'timeout_rewrite', version = review.version + 1, decision_source = 'timeout'
       FROM due
       WHERE review.id = due.id AND review.status = 'pending'
       RETURNING review.*`,
      [now, safeLimit],
    );
    return result.rows.map(toCase);
  }

  async listRecoverableNarrationReviews(limit = 200): Promise<NarrationReviewCaseRecord[]> {
    const safeLimit = Math.max(1, Math.min(1000, Math.round(limit)));
    const result = await this.executor.query<NarrationReviewCaseRow>(
      `SELECT ${caseColumns}
       FROM xumo_narration_review_cases
       WHERE status IN ('pending', 'kept', 'rewrite_requested', 'timeout_rewrite')
       ORDER BY created_at, id
       LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map(toCase);
  }

  async replaceNarrationReviewCase(
    oldCaseId: string,
    job: GenerationJob,
    review: NarrationReviewCaseRecord,
    resolvedAt: string,
  ): Promise<boolean> {
    assertPauseInput(job, review);
    return this.executor.transaction(async (transaction) => {
      const locked = await lockMatchingGenerationJob(transaction, job);
      if (!isLiveBoundJob(locked, job)) return false;
      const retired = await transaction.query<{ id: string }>(
        `UPDATE xumo_narration_review_cases
         SET status = 'resolved', encrypted_payload = NULL, resolved_at = $4,
             decision_source = coalesce(decision_source, 'system'), version = version + 1
         WHERE id = $1 AND job_id = $2 AND owner_id = $3
           AND status IN ('pending', 'kept', 'rewrite_requested', 'timeout_rewrite')
         RETURNING id`,
        [oldCaseId, review.jobId, review.ownerId, resolvedAt],
      );
      if (retired.rows.length === 0) return false;
      await updateGenerationJob(transaction, job);
      await insertReviewCase(transaction, review);
      return true;
    });
  }

  async resolveNarrationReviewCase(
    id: string,
    finalStatus: "resolved" | "failed",
    resolvedAt: string,
  ): Promise<boolean> {
    const result = await this.executor.query<{ id: string }>(
      `UPDATE xumo_narration_review_cases
       SET status = $2, encrypted_payload = NULL, resolved_at = $3,
           decision_source = coalesce(decision_source, 'system'), version = version + 1
       WHERE id = $1
         AND status IN ('pending', 'kept', 'rewrite_requested', 'timeout_rewrite')
       RETURNING id`,
      [id, finalStatus, resolvedAt],
    );
    return result.rows.length > 0;
  }

  async failExpiredNarrationReviewCase(id: string, now: string): Promise<boolean> {
    const result = await this.executor.query<{ id: string }>(
      `UPDATE xumo_narration_review_cases
       SET status = 'failed', encrypted_payload = NULL, resolved_at = $2,
           decision_source = coalesce(decision_source, 'system'), version = version + 1
       WHERE id = $1
         AND status IN ('pending', 'kept', 'rewrite_requested', 'timeout_rewrite')
         AND payload_expires_at <= $2
       RETURNING id`,
      [id, now],
    );
    return result.rows.length > 0;
  }

  async upsertNarrationReviewFeedback(feedback: NarrationReviewFeedbackRecord): Promise<void> {
    await this.executor.transaction(async (transaction) => {
      const locked = await lockGenerationJob(transaction, feedback.jobId);
      if (!locked || locked.owner_id !== feedback.ownerId) {
        throw narrationReviewStateUnavailable();
      }
      if (locked.story_id === DELETED_STORY_PLACEHOLDER) return;
      await transaction.query(
      `INSERT INTO xumo_narration_review_feedback(
         id, case_id, job_id, owner_id, candidate_id, rule_id, rule_version, location,
         model, reported_decision, decision, confidence, threshold, resolution_source,
         user_decision, rewrite_count, rewrite_succeeded, job_completed, latency_ms,
         content_hash, consented_excerpt_ciphertext, excerpt_expires_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19,
         $20, $21::jsonb, $22, $23, $24
       )
       ON CONFLICT (job_id, content_hash, candidate_id) DO UPDATE SET
         case_id = excluded.case_id,
         model = excluded.model,
         reported_decision = excluded.reported_decision,
         decision = excluded.decision,
         confidence = excluded.confidence,
         threshold = excluded.threshold,
         resolution_source = excluded.resolution_source,
         user_decision = excluded.user_decision,
         rewrite_count = excluded.rewrite_count,
         rewrite_succeeded = excluded.rewrite_succeeded,
         job_completed = excluded.job_completed,
         latency_ms = excluded.latency_ms,
         consented_excerpt_ciphertext = coalesce(
           excluded.consented_excerpt_ciphertext,
           xumo_narration_review_feedback.consented_excerpt_ciphertext
         ),
         excerpt_expires_at = coalesce(
           excluded.excerpt_expires_at,
           xumo_narration_review_feedback.excerpt_expires_at
         ),
         updated_at = excluded.updated_at`,
      [
        feedback.id,
        feedback.caseId,
        feedback.jobId,
        feedback.ownerId,
        feedback.candidateId,
        feedback.ruleId,
        feedback.ruleVersion,
        feedback.location,
        feedback.model,
        feedback.reportedDecision,
        feedback.decision,
        feedback.confidence,
        feedback.threshold,
        feedback.resolutionSource,
        feedback.userDecision,
        feedback.rewriteCount,
        feedback.rewriteSucceeded,
        feedback.jobCompleted,
        feedback.latencyMs,
        feedback.contentHash,
        feedback.consentedExcerptCiphertext
          ? stableJson(feedback.consentedExcerptCiphertext)
          : null,
        feedback.excerptExpiresAt,
        feedback.createdAt,
        feedback.updatedAt,
      ],
    );
    });
  }

  async deleteExpiredNarrationReviewData(now: string): Promise<NarrationReviewCleanupCounts> {
    return this.executor.transaction(async (transaction) => {
      const payloads = await transaction.query<{ id: string }>(
        `UPDATE xumo_narration_review_cases
         SET encrypted_payload = NULL
         WHERE encrypted_payload IS NOT NULL
           AND payload_expires_at <= $1
           AND status IN ('resolved', 'failed')
         RETURNING id`,
        [now],
      );
      const excerpts = await transaction.query<{ id: string }>(
        `UPDATE xumo_narration_review_feedback
         SET consented_excerpt_ciphertext = NULL, excerpt_expires_at = NULL, updated_at = $1
         WHERE consented_excerpt_ciphertext IS NOT NULL AND excerpt_expires_at <= $1
         RETURNING id`,
        [now],
      );
      return { payloads: payloads.rows.length, excerpts: excerpts.rows.length };
    });
  }
}
