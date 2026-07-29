import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { GenerationJob } from "../src/types";
import {
  deriveApplicationEncryptionKey,
  loadApplicationEncryptionKey,
  type ApplicationEncryptionKeyLoader,
} from "./appEncryption";
import type { NarrationCandidate, NarrationCandidateLocation } from "./narrationPolicy";
import type { NarrationAssessment, NarrationDecision } from "./narrationReview";

const NARRATION_REVIEW_ENCRYPTION_PURPOSE = "xumo:narration-review:v1";
const NARRATION_REVIEW_EXCERPT_PURPOSE = "xumo:narration-review-excerpt:v1";

export interface EncryptedEnvelopeV1 {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface NarrationReviewPayloadIdentity {
  caseId: string;
  jobId: string;
  ownerId: string;
  contentHash: string;
}

export type NarrationReviewCaseStatus =
  | "pending"
  | "kept"
  | "rewrite_requested"
  | "timeout_rewrite"
  | "resolved"
  | "failed";

export type NarrationReviewDecisionSource = "user" | "timeout" | "system";
export type NarrationReviewActionStatus = Extract<
  NarrationReviewCaseStatus,
  "kept" | "rewrite_requested" | "timeout_rewrite"
>;

export interface NarrationReviewCandidateMetadata {
  id: string;
  ruleId: string;
  ruleVersion: string;
  location: NarrationCandidateLocation;
}

export interface NarrationReviewAssessmentMetadata {
  candidateId: string;
  reportedDecision: NarrationDecision;
  decision: NarrationDecision;
  confidence: number;
  worldInternal: boolean;
  writingProcessReference: boolean;
}

export interface NarrationReviewCaseRecord extends NarrationReviewPayloadIdentity {
  id: string;
  attempt: number;
  rewriteCount: number;
  status: NarrationReviewCaseStatus;
  version: number;
  deadlineAt: string;
  payloadExpiresAt: string;
  decisionSource: NarrationReviewDecisionSource | null;
  candidateMetadata: NarrationReviewCandidateMetadata[];
  assessmentMetadata: NarrationReviewAssessmentMetadata[];
  encryptedPayload: EncryptedEnvelopeV1 | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface NarrationReviewDecisionClaim {
  id: string;
  ownerId?: string;
  expectedVersion: number;
  contentHash: string;
  status: NarrationReviewActionStatus;
  decisionSource: Extract<NarrationReviewDecisionSource, "user" | "timeout">;
  decidedAt: string;
}

export interface NarrationReviewFeedbackRecord {
  id: string;
  caseId: string | null;
  jobId: string;
  ownerId: string;
  candidateId: string;
  ruleId: string;
  ruleVersion: string;
  location: NarrationCandidateLocation;
  model: string;
  reportedDecision: NarrationDecision;
  decision: NarrationDecision;
  confidence: number;
  threshold: number;
  resolutionSource: "automatic" | "user" | "timeout" | "system";
  userDecision: "keep" | "rewrite" | null;
  rewriteCount: number;
  rewriteSucceeded: boolean | null;
  jobCompleted: boolean | null;
  latencyMs: number;
  contentHash: string;
  consentedExcerptCiphertext: EncryptedEnvelopeV1 | null;
  excerptExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NarrationReviewCleanupCounts {
  payloads: number;
  excerpts: number;
}

export interface NarrationReviewPauseInput {
  job: GenerationJob;
  review: NarrationReviewCaseRecord;
}

export function projectNarrationCandidateMetadata(
  candidate: NarrationCandidate,
): NarrationReviewCandidateMetadata {
  return {
    id: candidate.id,
    ruleId: candidate.ruleId,
    ruleVersion: candidate.ruleVersion,
    location: candidate.location,
  };
}

export function projectNarrationAssessmentMetadata(
  assessment: NarrationAssessment,
): NarrationReviewAssessmentMetadata {
  return {
    candidateId: assessment.candidateId,
    reportedDecision: assessment.reportedDecision,
    decision: assessment.decision,
    confidence: assessment.confidence,
    worldInternal: assessment.worldInternal,
    writingProcessReference: assessment.writingProcessReference,
  };
}

function isDecision(value: unknown): value is NarrationDecision {
  return value === "allow" || value === "rewrite" || value === "ask_user";
}

export function normalizeNarrationCandidateMetadata(value: unknown): NarrationReviewCandidateMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.ruleId !== "string" ||
      typeof item.ruleVersion !== "string" ||
      (item.location !== "title" && item.location !== "body")
    ) return [];
    return [{
      id: item.id,
      ruleId: item.ruleId,
      ruleVersion: item.ruleVersion,
      location: item.location,
    }];
  });
}

export function normalizeNarrationAssessmentMetadata(value: unknown): NarrationReviewAssessmentMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (
      typeof item.candidateId !== "string" ||
      !isDecision(item.reportedDecision) ||
      !isDecision(item.decision) ||
      typeof item.confidence !== "number" ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1 ||
      typeof item.worldInternal !== "boolean" ||
      typeof item.writingProcessReference !== "boolean"
    ) return [];
    return [{
      candidateId: item.candidateId,
      reportedDecision: item.reportedDecision,
      decision: item.decision,
      confidence: item.confidence,
      worldInternal: item.worldInternal,
      writingProcessReference: item.writingProcessReference,
    }];
  });
}

function payloadAad(identity: NarrationReviewPayloadIdentity): Buffer {
  if (
    !identity.caseId ||
    !identity.jobId ||
    !identity.ownerId ||
    !/^[0-9a-f]{64}$/i.test(identity.contentHash)
  ) {
    throw new Error("待确认状态标识无效。");
  }
  return Buffer.from(
    `narration-review:v1:${identity.caseId}:${identity.jobId}:${identity.ownerId}:${identity.contentHash}`,
    "utf8",
  );
}

function decodeEnvelope(envelope: EncryptedEnvelopeV1): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  if (!envelope || envelope.version !== 1) throw new Error("待确认状态密文版本无效。");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("待确认状态密文格式无效。");
  }
  return { iv, tag, ciphertext };
}

export async function sealNarrationReviewPayload(
  identity: NarrationReviewPayloadIdentity,
  payload: unknown,
  loadKey: ApplicationEncryptionKeyLoader = loadApplicationEncryptionKey,
): Promise<EncryptedEnvelopeV1> {
  const key = deriveApplicationEncryptionKey(await loadKey(), NARRATION_REVIEW_ENCRYPTION_PURPOSE);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(payloadAad(identity));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export async function openNarrationReviewPayload<Payload>(
  identity: NarrationReviewPayloadIdentity,
  envelope: EncryptedEnvelopeV1,
  loadKey: ApplicationEncryptionKeyLoader = loadApplicationEncryptionKey,
): Promise<Payload> {
  try {
    const decoded = decodeEnvelope(envelope);
    const key = deriveApplicationEncryptionKey(await loadKey(), NARRATION_REVIEW_ENCRYPTION_PURPOSE);
    const decipher = createDecipheriv("aes-256-gcm", key, decoded.iv);
    decipher.setAAD(payloadAad(identity));
    decipher.setAuthTag(decoded.tag);
    const plaintext = Buffer.concat([
      decipher.update(decoded.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as Payload;
  } catch {
    throw Object.assign(new Error("待确认状态无法验证或解密。"), {
      code: "narration_review_state_unavailable",
    });
  }
}

function excerptAad(identity: NarrationReviewPayloadIdentity): Buffer {
  if (
    !identity.caseId ||
    !identity.jobId ||
    !identity.ownerId ||
    !/^[0-9a-f]{64}$/i.test(identity.contentHash)
  ) {
    throw new Error("Consented narration review excerpt identity is invalid.");
  }
  return Buffer.from(
    `narration-review-excerpt:v1:${identity.caseId}:${identity.jobId}:${identity.ownerId}:${identity.contentHash}`,
    "utf8",
  );
}

export function redactNarrationReviewContext(
  candidates: readonly NarrationCandidate[],
  maximumCharacters = 600,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const candidate of candidates) {
    for (const value of [candidate.previousSentence, candidate.sentence, candidate.nextSentence]) {
      const normalized = value?.replace(/\s+/gu, " ").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      lines.push(normalized);
    }
  }
  const redacted = lines.join("\n")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]")
    .replace(/https?:\/\/[^\s]+/giu, "[REDACTED_URL]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "sk-[REDACTED]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[A-Za-z0-9._~+\-/=]{8,}\b/giu, "$1=[REDACTED]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "[REDACTED_UUID]")
    .replace(/\b(?:user|conn|job|story)_[A-Za-z0-9_-]+\b/gu, "[REDACTED_ID]");
  const safeMaximum = Number.isFinite(maximumCharacters)
    ? Math.max(1, Math.min(600, Math.floor(maximumCharacters)))
    : 600;
  return Array.from(redacted).slice(0, safeMaximum).join("");
}

export async function sealNarrationReviewExcerpt(
  identity: NarrationReviewPayloadIdentity,
  candidates: readonly NarrationCandidate[],
  loadKey: ApplicationEncryptionKeyLoader = loadApplicationEncryptionKey,
): Promise<EncryptedEnvelopeV1> {
  const excerpt = redactNarrationReviewContext(candidates);
  if (!excerpt) throw new Error("Consented narration review excerpt is empty.");
  const key = deriveApplicationEncryptionKey(await loadKey(), NARRATION_REVIEW_EXCERPT_PURPOSE);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(excerptAad(identity));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ version: 1, excerpt }), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export async function openNarrationReviewExcerpt(
  identity: NarrationReviewPayloadIdentity,
  envelope: EncryptedEnvelopeV1,
  loadKey: ApplicationEncryptionKeyLoader = loadApplicationEncryptionKey,
): Promise<string> {
  try {
    const decoded = decodeEnvelope(envelope);
    const key = deriveApplicationEncryptionKey(await loadKey(), NARRATION_REVIEW_EXCERPT_PURPOSE);
    const decipher = createDecipheriv("aes-256-gcm", key, decoded.iv);
    decipher.setAAD(excerptAad(identity));
    decipher.setAuthTag(decoded.tag);
    const plaintext = Buffer.concat([
      decipher.update(decoded.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as { version?: unknown; excerpt?: unknown };
    if (payload.version !== 1 || typeof payload.excerpt !== "string") throw new Error("invalid");
    return payload.excerpt;
  } catch {
    throw Object.assign(new Error("Consented narration review excerpt cannot be verified or decrypted."), {
      code: "narration_review_state_unavailable",
    });
  }
}
