import { createHash } from "node:crypto";
import type { CanonFactCandidateV2, ExperienceEvidenceV2 } from "../../src/types";
import type { ExperienceLedgerPatch, LedgerEvidenceBinding } from "./types";
import { canonicalAuthorizationPayload } from "./scheduler";

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

export function canonFactCandidateId(candidate: Omit<CanonFactCandidateV2, "id">): string {
  return createHash("sha256").update(canonicalAuthorizationPayload(cleanAuthorizationValue(candidate))).digest("base64url");
}

export function ledgerPatchHash(patch: ExperienceLedgerPatch): string {
  return createHash("sha256").update(canonicalAuthorizationPayload(cleanAuthorizationValue(patch))).digest("hex");
}
