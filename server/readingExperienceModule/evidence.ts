import { createHash } from "node:crypto";
import type { EvidencePolicy, ExperienceEvidenceV2, ObservableSignalV2, TextAnchorV2 } from "../../src/types";
import type { SemanticEvidenceAnchor, SemanticEvidenceClaim } from "./types";
import { canonicalAuthorizationPayload } from "./scheduler";

export interface EvidenceFinding { ruleId: string; severity: "rewrite" | "rejected"; dimensionId?: string }
export interface GroundedClaim { claim: SemanticEvidenceClaim; anchors: TextAnchorV2[]; metrics?: Record<string, number> }

export function sourceForArtifact(artifact: { kind: string; value?: unknown; title?: string; paragraphs?: string[] }): string {
  if (artifact.kind === "blueprint") return canonicalAuthorizationPayload(artifact.value);
  return `${artifact.title ?? ""}\n${(artifact.paragraphs ?? []).join("\n")}`;
}

export function hashArtifact(artifact: { kind: string; value?: unknown; title?: string; paragraphs?: string[] }): string {
  return createHash("sha256").update(sourceForArtifact(artifact), "utf8").digest("hex");
}

function regionFor(source: string, anchor: TextAnchorV2, policy: Extract<EvidencePolicy, { kind: "distribution" }>): "opening" | "middle" | "ending" {
  if (policy.regionSemantics === "paragraph") {
    const before = source.slice(0, anchor.start).split("\n").length - 1;
    const total = Math.max(source.split("\n").length, 1);
    return before < total / 3 ? "opening" : before < (total * 2) / 3 ? "middle" : "ending";
  }
  const length = Math.max(source.length, 1);
  return anchor.start < length / 3 ? "opening" : anchor.start < (length * 2) / 3 ? "middle" : "ending";
}

function localMetrics(source: string, anchors: TextAnchorV2[], policy: Extract<EvidencePolicy, { kind: "distribution" }>): Record<string, number> {
  const regions = new Set(anchors.map((anchor) => regionFor(source, anchor, policy)));
  const starts = anchors.map((anchor) => anchor.start); const spread = anchors.length < 2 ? 0 : (Math.max(...starts) - Math.min(...starts)) / Math.max(source.length, 1);
  const values: Record<string, number> = { anchor_spread: spread, scene_coverage: regions.size / 3 };
  return Object.fromEntries(policy.metricIds.map((id) => [id, values[id] ?? 0]));
}

function hasDuplicateOrOverlap(anchors: TextAnchorV2[]): boolean {
  const sorted = [...anchors].sort((a, b) => a.start - b.start || a.end - b.end);
  return sorted.some((anchor, index) => index > 0 && anchor.start < sorted[index - 1].end);
}

/** Ground exactly the source slice returned by the judge; it never searches or repairs quotes. */
export function groundClaim(source: string, claim: SemanticEvidenceClaim, signal: Pick<ObservableSignalV2, "dimensionId" | "id" | "verification">): GroundedClaim | EvidenceFinding {
  if (claim.dimensionId !== signal.dimensionId || claim.signalId !== signal.id || claim.version !== 1 || !Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
  if (!Array.isArray(claim.anchors) || claim.anchors.length < signal.verification.minimumAnchors) return { ruleId: "evidence.insufficient_anchors", severity: "rewrite", dimensionId: signal.dimensionId };
  const anchors = claim.anchors.map(({ start, end, quote }: SemanticEvidenceAnchor) => ({ start, end, text: quote }));
  if (anchors.some((anchor) => !Number.isInteger(anchor.start) || !Number.isInteger(anchor.end) || anchor.start < 0 || anchor.end <= anchor.start || anchor.end > source.length || source.slice(anchor.start, anchor.end) !== anchor.text)) return { ruleId: "evidence.anchor_not_grounded", severity: "rewrite", dimensionId: signal.dimensionId };
  if (hasDuplicateOrOverlap(anchors)) return { ruleId: "evidence.anchor_overlap", severity: "rewrite", dimensionId: signal.dimensionId };
  if (signal.verification.kind === "distribution") {
    const policy = signal.verification as Extract<EvidencePolicy, { kind: "distribution" }>;
    const metricKeys = Object.keys(claim.metrics ?? {}).sort(); const expected = [...policy.metricIds].sort();
    if (metricKeys.join("\u001f") !== expected.join("\u001f")) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
    const metrics = localMetrics(source, anchors, policy); const required = policy.requiredRegions ?? ["opening", "middle", "ending"]; const present = new Set(anchors.map((anchor) => regionFor(source, anchor, policy)));
    if (required.some((region) => !present.has(region)) || Object.entries(policy.metricThresholds ?? {}).some(([id, threshold]) => !Number.isFinite(threshold) || (metrics[id] ?? -Infinity) < threshold)) return { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: signal.dimensionId };
    return { claim, anchors, metrics };
  }
  return { claim, anchors };
}

export function evidenceFromClaim(input: { id: string; contractRevisionId: string; activationId: string; branchId: string; chapterId: string; revisionId: string; sourceHash: string; grounded: GroundedClaim }): ExperienceEvidenceV2 {
  const { grounded, ...binding } = input;
  const slots = grounded.claim.slots ?? {};
  return {
    id: binding.id, contractRevisionId: binding.contractRevisionId, activationId: binding.activationId, branchId: binding.branchId,
    dimensionId: grounded.claim.dimensionId, signalId: grounded.claim.signalId, chapterId: binding.chapterId, chapterRevisionId: binding.revisionId,
    sourceHash: binding.sourceHash, anchors: grounded.anchors.map((anchor) => ({ ...anchor })),
    observation: { actor: slots.actor, action: slots.action, object: slots.object, feedback: slots.feedback, outcome: slots.outcome, reaction: slots.reaction, reciprocalAction: slots.reciprocalAction, relationshipOrStateChange: slots.relationshipChange, slots: { ...slots }, distributionMetrics: grounded.metrics ? { ...grounded.metrics } : undefined },
    confidence: grounded.claim.confidence, status: "supported",
  };
}
