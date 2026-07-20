import { createHash, createHmac } from "node:crypto";
import type { CanonFactCandidateV2, ExperienceEvidenceV2 } from "../../src/types";
import type { ExperienceLedgerPatch, ExperiencePublicationPermit, LedgerEvidenceBinding, PublicationPermitContext } from "./types";
import { boundedAuthorizationSnapshot, canonicalAuthorizationPayload, sameMac } from "./scheduler";

const permitDomain = "reading-experience:permit:v1";
const permitContextKeys = ["ticketId", "jobId", "attempt", "contractRevisionId", "activationId", "branchId", "stage", "artifactKind", "ruleGraphVersion", "expectedCanonVersion", "ledgerRevision", "chapterId", "revisionId", "artifactBindingId", "artifactHash", "evidenceIds", "evidenceBindings", "evidenceRootHash", "ledgerPatchHash"].sort();

/** Removes optional object properties before they cross the strict MAC boundary. */
export function cleanAuthorizationValue<T>(value: T): T {
  const clean = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map((item) => {
      if (item === undefined) throw new TypeError("undefined array item");
      return clean(item);
    });
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined).map(([key, item]) => [key, clean(item)]));
    }
    return input;
  };
  return clean(value) as T;
}

export function evidenceBinding(evidence: ExperienceEvidenceV2): LedgerEvidenceBinding {
  const clean = cleanAuthorizationValue(evidence);
  return {
    evidenceId: clean.id,
    dimensionId: clean.dimensionId,
    signalId: clean.signalId,
    chapterRevisionId: clean.chapterRevisionId,
    sourceHash: clean.sourceHash,
    evidenceDigest: createHash("sha256").update(canonicalAuthorizationPayload(clean)).digest("hex"),
  };
}

export function sortedEvidenceBindings(evidence: ReadonlyArray<ExperienceEvidenceV2>): LedgerEvidenceBinding[] {
  return evidence.map(evidenceBinding).sort((left, right) => {
    const a = canonicalAuthorizationPayload(left); const b = canonicalAuthorizationPayload(right);
    return a === b ? 0 : a < b ? -1 : 1;
  });
}

export function evidenceRootHash(bindings: ReadonlyArray<LedgerEvidenceBinding>): string {
  const sorted = [...bindings].map((binding) => cleanAuthorizationValue(binding)).sort((left, right) => {
    const a = canonicalAuthorizationPayload(left); const b = canonicalAuthorizationPayload(right);
    return a === b ? 0 : a < b ? -1 : 1;
  });
  return createHash("sha256").update(canonicalAuthorizationPayload(sorted)).digest("hex");
}

export function publicationPermitContext(permit: ExperiencePublicationPermit): PublicationPermitContext {
  return {
    ticketId: permit.ticketId, jobId: permit.jobId, attempt: permit.attempt, contractRevisionId: permit.contractRevisionId,
    activationId: permit.activationId, branchId: permit.branchId, stage: permit.stage, artifactKind: permit.artifactKind,
    ruleGraphVersion: permit.ruleGraphVersion, expectedCanonVersion: permit.expectedCanonVersion, ledgerRevision: permit.ledgerRevision,
    chapterId: permit.chapterId, revisionId: permit.revisionId, artifactBindingId: permit.artifactBindingId, artifactHash: permit.artifactHash,
    evidenceIds: [...permit.evidenceIds], evidenceBindings: permit.evidenceBindings.map((binding) => ({ ...binding })), evidenceRootHash: permit.evidenceRootHash, ledgerPatchHash: permit.ledgerPatchHash,
  };
}

export function issuePublicationPermit(context: PublicationPermitContext, permitId: string, expiresAt: string, secret: string): ExperiencePublicationPermit {
  const unsigned = cleanAuthorizationValue({ version: 1 as const, ...context, evidenceIds: [...context.evidenceIds], evidenceBindings: context.evidenceBindings.map((binding) => ({ ...binding })), permitId, expiresAt });
  const signature = createHmac("sha256", secret).update(permitDomain).update("\u001f").update(canonicalAuthorizationPayload(unsigned)).digest("base64url");
  return { ...unsigned, signature };
}

function validPermitContext(value: unknown): value is PublicationPermitContext {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== permitContextKeys.join("|")) return false;
  const context = value as Record<string, unknown>;
  const bindings = context.evidenceBindings;
  return Array.isArray(context.evidenceIds) && context.evidenceIds.every((id) => typeof id === "string" && !!id)
    && new Set(context.evidenceIds).size === context.evidenceIds.length
    && Array.isArray(bindings) && bindings.every((binding) => !!binding && typeof binding === "object" && !Array.isArray(binding) && Object.keys(binding as object).sort().join("|") === ["evidenceId", "dimensionId", "signalId", "chapterRevisionId", "sourceHash", "evidenceDigest"].sort().join("|") && Object.values(binding as unknown as Record<string, unknown>).every((field) => typeof field === "string" && !!field))
    && new Set(bindings.map((binding) => (binding as LedgerEvidenceBinding).evidenceId)).size === bindings.length
    && canonicalAuthorizationPayload([...context.evidenceIds].sort()) === canonicalAuthorizationPayload(bindings.map((binding) => (binding as LedgerEvidenceBinding).evidenceId).sort())
    && typeof context.evidenceRootHash === "string" && /^[a-f\d]{64}$/i.test(context.evidenceRootHash)
    && context.evidenceRootHash === evidenceRootHash(bindings as LedgerEvidenceBinding[])
    && typeof context.ledgerPatchHash === "string" && /^[a-f\d]{64}$/i.test(context.ledgerPatchHash);
}

export interface VerifiedPublicationPermitSnapshot {
  permit: ExperiencePublicationPermit;
  context: PublicationPermitContext;
}

function publicationPermitSnapshot(value: unknown, context: PublicationPermitContext, secret: string, now?: Date): VerifiedPublicationPermitSnapshot | undefined {
  try {
    const safeValue = boundedAuthorizationSnapshot(value); const safeContext = boundedAuthorizationSnapshot(context);
    if (!validPermitContext(safeContext) || !safeValue || typeof safeValue !== "object" || Array.isArray(safeValue)) return undefined;
    const permit = safeValue as ExperiencePublicationPermit;
    const permitKeys = [...permitContextKeys, "version", "permitId", "expiresAt", "signature"].sort();
    if (Object.keys(safeValue).sort().join("|") !== permitKeys.join("|")) return undefined;
    const { signature, ...unsigned } = permit;
    if (permit.version !== 1 || typeof signature !== "string" || typeof permit.permitId !== "string" || !permit.permitId || typeof permit.expiresAt !== "string" || !Number.isFinite(Date.parse(permit.expiresAt))) return undefined;
    const expected = createHmac("sha256", secret).update(permitDomain).update("\u001f").update(canonicalAuthorizationPayload(unsigned)).digest("base64url");
    if (!sameMac(signature, expected) || !Object.entries(safeContext).every(([key, expectedValue]) => canonicalAuthorizationPayload((permit as unknown as Record<string, unknown>)[key]) === canonicalAuthorizationPayload(expectedValue))) return undefined;
    if (now && Date.parse(permit.expiresAt) <= now.getTime()) return undefined;
    return { permit, context: safeContext };
  } catch { return undefined; }
}

export function verifyPublicationPermitSignature(value: unknown, context: PublicationPermitContext, secret: string): boolean {
  return !!publicationPermitSnapshot(value, context, secret);
}

export function verifyPublicationPermit(value: unknown, context: PublicationPermitContext, secret: string, now: Date): boolean {
  return !!publicationPermitSnapshot(value, context, secret, now);
}

export function verifiedPublicationPermitSnapshot(value: unknown, context: PublicationPermitContext, secret: string, now: Date): VerifiedPublicationPermitSnapshot | undefined {
  return publicationPermitSnapshot(value, context, secret, now);
}

export function publicationPermitDigest(permit: ExperiencePublicationPermit): string {
  return createHash("sha256").update(canonicalAuthorizationPayload(cleanAuthorizationValue(permit))).digest("hex");
}

export function canonFactCandidateId(candidate: Omit<CanonFactCandidateV2, "id">): string {
  return createHash("sha256").update(canonicalAuthorizationPayload(cleanAuthorizationValue(candidate))).digest("base64url");
}

export function ledgerPatchHash(patch: ExperienceLedgerPatch): string {
  return createHash("sha256").update(canonicalAuthorizationPayload(cleanAuthorizationValue(patch))).digest("hex");
}
