import { createHash } from "node:crypto";
import type { DistributionMetricId, EvidencePolicy, ExperienceEvidenceV2, ObservableSignalV2, TextAnchorV2 } from "../../src/types";
import type { SemanticEvidenceAnchor, SemanticEvidenceClaim } from "./types";
import { canonicalAuthorizationPayload } from "./scheduler";

export interface EvidenceFinding { ruleId: string; severity: "rewrite" | "rejected"; dimensionId?: string }
export interface GroundedClaim { claim: SemanticEvidenceClaim; anchors: TextAnchorV2[]; metrics?: Record<string, number> }

export function sourceForArtifact(artifact: { kind: string; value?: unknown; title?: string; paragraphs?: string[] }): string {
  if (artifact.kind === "blueprint") return canonicalAuthorizationPayload(artifact.value);
  return `${artifact.title ?? ""}\n${(artifact.paragraphs ?? []).join("\n")}`;
}

export function hashArtifact(artifact: { kind: string; value?: unknown; title?: string; paragraphs?: string[] }): string {
  const payload = artifact.kind === "blueprint"
    ? { kind: artifact.kind, value: artifact.value }
    : { kind: artifact.kind, title: artifact.title, paragraphs: artifact.paragraphs };
  return createHash("sha256").update(canonicalAuthorizationPayload(payload), "utf8").digest("hex");
}

const metricIds = new Set<DistributionMetricId>(["anchor_spread", "scene_coverage", "paragraph_consistency", "beat_density", "turn_position"]);

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
  const paragraphs = source.split("\n").filter(Boolean); const anchoredParagraphs = new Set(anchors.map((anchor) => source.slice(0, anchor.start).split("\n").length - 1));
  const lengths = anchors.map((anchor) => anchor.end - anchor.start); const mean = lengths.reduce((sum, length) => sum + length, 0) / Math.max(lengths.length, 1); const deviation = lengths.reduce((sum, length) => sum + Math.abs(length - mean), 0) / Math.max(lengths.length * Math.max(mean, 1), 1);
  const requiredCount = Math.max(policy.requiredRegions.length, 1);
  const values: Record<DistributionMetricId, number> = { anchor_spread: spread, scene_coverage: regions.size / requiredCount, paragraph_consistency: Math.max(0, 1 - deviation), beat_density: anchors.length / Math.max(paragraphs.length, 1), turn_position: Math.max(...starts, 0) / Math.max(source.length, 1) };
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
    if (policy.metricIds.some((id) => !metricIds.has(id))) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
    const metricKeys = Object.keys(claim.metrics ?? {}).sort(); const expected = [...policy.metricIds].sort();
    if (metricKeys.join("\u001f") !== expected.join("\u001f")) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
    const metrics = localMetrics(source, anchors, policy); const required = policy.requiredRegions ?? ["opening", "middle", "ending"]; const present = new Set(anchors.map((anchor) => regionFor(source, anchor, policy)));
    if (required.some((region) => !present.has(region)) || Object.entries(policy.metricThresholds ?? {}).some(([id, threshold]) => !Number.isFinite(threshold) || (metrics[id] ?? -Infinity) < threshold)) return { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: signal.dimensionId };
    return { claim, anchors, metrics };
  }
  return { claim, anchors };
}

export function evidenceFromClaim(input: { id: string; contractRevisionId: string; activationId: string; branchId: string; chapterId: string; revisionId: string; sourceHash: string; ticketId: string; jobId: string; attempt: number; stage: string; artifactKind: string; ruleGraphVersion: string; expectedCanonVersion: number; ledgerRevision: number; grounded: GroundedClaim }): ExperienceEvidenceV2 {
  const { grounded, ...binding } = input;
  const slots = grounded.claim.slots ?? {};
  return {
    id: binding.id, contractRevisionId: binding.contractRevisionId, activationId: binding.activationId, branchId: binding.branchId,
    dimensionId: grounded.claim.dimensionId, signalId: grounded.claim.signalId, eventId: grounded.claim.eventId, ticketId: binding.ticketId, jobId: binding.jobId, attempt: binding.attempt, stage: binding.stage, artifactKind: binding.artifactKind, ruleGraphVersion: binding.ruleGraphVersion, expectedCanonVersion: binding.expectedCanonVersion, ledgerRevision: binding.ledgerRevision, chapterId: binding.chapterId, chapterRevisionId: binding.revisionId,
    sourceHash: binding.sourceHash, anchors: grounded.anchors.map((anchor) => ({ ...anchor })),
    observation: { actor: slots.actor, action: slots.action, object: slots.object, feedback: slots.feedback, outcome: slots.outcome, reaction: slots.reaction, reciprocalAction: slots.reciprocalAction, relationshipOrStateChange: slots.relationshipChange, slots: { ...slots }, slotAnchors: Object.fromEntries(Object.entries(grounded.claim.slotAnchorIndices).map(([slot, index]) => [slot, grounded.anchors[index!]]).filter(([, anchor]) => !!anchor)), distributionMetrics: grounded.metrics ? { ...grounded.metrics } : undefined },
    confidence: grounded.claim.confidence, status: "supported",
  };
}
