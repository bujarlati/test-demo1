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

const metricIds = new Set<DistributionMetricId>(["anchor_spread", "scene_coverage", "paragraph_consistency", "beat_density", "turn_position", "abstraction_coverage", "sensory_coverage", "rhetoric_coverage", "event_density", "pressure_window", "paragraph_length_density", "sentence_length_density"]);
const voiceFacetMetrics = new Set<DistributionMetricId>(["abstraction_coverage", "sensory_coverage", "rhetoric_coverage"]);
const pacingFacetMetrics = new Set<DistributionMetricId>(["beat_density", "turn_position", "event_density", "pressure_window", "paragraph_length_density", "sentence_length_density"]);

export interface GroundingOptions { bodyStart?: number }
interface TextUnit { text: string; start: number; end: number }

function textGeometry(source: string, bodyStart: number): { paragraphs: TextUnit[]; sentences: TextUnit[] } {
  const paragraphs: TextUnit[] = []; const sentences: TextUnit[] = []; let cursor = bodyStart;
  for (const line of source.slice(bodyStart).split("\n")) {
    const lineStart = cursor; const lineEnd = lineStart + line.length;
    if (line.trim()) {
      paragraphs.push({ text: line, start: lineStart, end: lineEnd });
      for (const match of line.matchAll(/[^.!?。！？]+(?:[.!?。！？]+|$)/gu)) {
        const raw = match[0]; const leading = raw.length - raw.trimStart().length; const trailing = raw.length - raw.trimEnd().length;
        if (raw.trim()) sentences.push({ text: raw.trim(), start: lineStart + (match.index ?? 0) + leading, end: lineStart + (match.index ?? 0) + raw.length - trailing });
      }
    }
    cursor = lineEnd + 1;
  }
  return { paragraphs, sentences };
}

function containingUnitIndex(units: TextUnit[], anchor: TextAnchorV2): number {
  return units.findIndex((unit) => anchor.start >= unit.start && anchor.end <= unit.end);
}

function regionFor(source: string, anchor: TextAnchorV2, policy: Extract<EvidencePolicy, { kind: "distribution" }>, bodyStart = 0, paragraphs = textGeometry(source, bodyStart).paragraphs): "opening" | "middle" | "ending" {
  if (policy.regionSemantics === "paragraph") {
    const index = Math.max(0, containingUnitIndex(paragraphs, anchor)); const total = Math.max(paragraphs.length, 1);
    return index < total / 3 ? "opening" : index < (total * 2) / 3 ? "middle" : "ending";
  }
  const length = Math.max(source.length - bodyStart, 1); const relativeStart = anchor.start - bodyStart;
  return relativeStart < length / 3 ? "opening" : relativeStart < (length * 2) / 3 ? "middle" : "ending";
}

function localMetrics(source: string, anchors: TextAnchorV2[], policy: Extract<EvidencePolicy, { kind: "distribution" }>, facets: SemanticEvidenceClaim["distributionAnchorIndices"] | undefined, bodyStart: number): Record<string, number> {
  const { paragraphs, sentences } = textGeometry(source, bodyStart); const bodyLength = Math.max(source.length - bodyStart, 1);
  const starts = anchors.map((anchor) => anchor.start); const spread = starts.length < 2 ? 0 : (Math.max(...starts) - Math.min(...starts)) / bodyLength;
  const regions = new Set(anchors.map((anchor) => regionFor(source, anchor, policy, bodyStart, paragraphs)));
  const lengths = paragraphs.flatMap((paragraph) => paragraph.text.split(/(?<=[.!?。！？])/u).map((sentence) => sentence.trim()).filter(Boolean).map((sentence) => Array.from(sentence).length));
  const mean = lengths.reduce((sum, length) => sum + length, 0) / Math.max(lengths.length, 1); const deviation = lengths.reduce((sum, length) => sum + Math.abs(length - mean), 0) / Math.max(lengths.length * Math.max(mean, 1), 1);
  const facetParagraphCoverage = (name: "abstraction" | "sensory" | "rhetoric") => new Set((facets?.[name] ?? []).map((index) => containingUnitIndex(paragraphs, anchors[index])).filter((index) => index >= 0)).size / Math.max(paragraphs.length, 1);
  const beatIndices = [...new Set(facets?.beat ?? [])]; const beatSentenceCount = new Set(beatIndices.map((index) => containingUnitIndex(sentences, anchors[index])).filter((index) => index >= 0)).size;
  const turnIndex = facets?.turn?.[0]; const turnStart = turnIndex === undefined ? bodyStart : anchors[turnIndex]?.start ?? bodyStart;
  const pressureStarts = [...new Set(facets?.pressure ?? [])].map((index) => anchors[index]?.start).filter((start): start is number => start !== undefined);
  const requiredCount = Math.max(policy.requiredRegions.length, 1);
  const paragraphLengthDensity = paragraphs.filter((paragraph) => { const length = Array.from(paragraph.text.trim()).length; return length >= 4 && length <= 360; }).length / Math.max(paragraphs.length, 1);
  const sentenceLengthDensity = sentences.filter((sentence) => { const length = Array.from(sentence.text).length; return length >= 2 && length <= 120; }).length / Math.max(sentences.length, 1);
  const eventDensity = beatSentenceCount / Math.max(sentences.length, 1);
  const values: Record<DistributionMetricId, number> = {
    anchor_spread: spread,
    scene_coverage: Math.min(1, regions.size / requiredCount),
    paragraph_consistency: Math.max(0, 1 - deviation),
    beat_density: eventDensity,
    turn_position: (turnStart - bodyStart) / bodyLength,
    abstraction_coverage: facetParagraphCoverage("abstraction"),
    sensory_coverage: facetParagraphCoverage("sensory"),
    rhetoric_coverage: facetParagraphCoverage("rhetoric"),
    event_density: eventDensity,
    pressure_window: pressureStarts.length ? Math.max(0, turnStart - Math.min(...pressureStarts)) / bodyLength : 0,
    paragraph_length_density: paragraphLengthDensity,
    sentence_length_density: sentenceLengthDensity,
  };
  return Object.fromEntries(policy.metricIds.map((id) => [id, values[id] ?? 0]));
}

function hasDuplicateOrOverlap(anchors: TextAnchorV2[]): boolean {
  const sorted = [...anchors].sort((a, b) => a.start - b.start || a.end - b.end);
  return sorted.some((anchor, index) => index > 0 && anchor.start < sorted[index - 1].end);
}

/** Ground exactly the source slice returned by the judge; it never searches or repairs quotes. */
export function groundClaim(source: string, claim: SemanticEvidenceClaim, signal: Pick<ObservableSignalV2, "dimensionId" | "id" | "verification">, options: GroundingOptions = {}): GroundedClaim | EvidenceFinding {
  if (claim.dimensionId !== signal.dimensionId || claim.signalId !== signal.id || claim.version !== 1 || !Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
  if (!Array.isArray(claim.anchors) || claim.anchors.length < signal.verification.minimumAnchors) return { ruleId: "evidence.insufficient_anchors", severity: "rewrite", dimensionId: signal.dimensionId };
  const anchors = claim.anchors.map(({ start, end, quote }: SemanticEvidenceAnchor) => ({ start, end, text: quote }));
  if (anchors.some((anchor) => !Number.isInteger(anchor.start) || !Number.isInteger(anchor.end) || anchor.start < 0 || anchor.end <= anchor.start || anchor.end > source.length || source.slice(anchor.start, anchor.end) !== anchor.text)) return { ruleId: "evidence.anchor_not_grounded", severity: "rewrite", dimensionId: signal.dimensionId };
  if (hasDuplicateOrOverlap(anchors)) return { ruleId: "evidence.anchor_overlap", severity: "rewrite", dimensionId: signal.dimensionId };
  if (signal.verification.kind === "distribution") {
    const policy = signal.verification as Extract<EvidencePolicy, { kind: "distribution" }>;
    const bodyStart = options.bodyStart ?? 0;
    if (!Number.isInteger(bodyStart) || bodyStart < 0 || bodyStart > source.length) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
    if (anchors.some((anchor) => anchor.start < bodyStart)) return { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: signal.dimensionId };
    if (policy.metricIds.some((id) => !metricIds.has(id))) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
    const metricKeys = Object.keys(claim.metrics ?? {}).sort(); const expected = [...policy.metricIds].sort();
    if (metricKeys.join("\u001f") !== expected.join("\u001f")) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
    const voiceMetrics = policy.metricIds.some((id) => voiceFacetMetrics.has(id));
    const pacingMetrics = policy.metricIds.some((id) => pacingFacetMetrics.has(id));
    const facets = claim.distributionAnchorIndices;
    const expectedFacetKeys = [...(voiceMetrics ? ["abstraction", "rhetoric", "sensory"] : []), ...(pacingMetrics ? ["beat", "goal", "pressure", "turn"] : [])].sort();
    if (expectedFacetKeys.length) {
      const keys = Object.keys(facets ?? {}).sort();
      if (keys.join("|") !== expectedFacetKeys.join("|") || expectedFacetKeys.some((key) => !Array.isArray(facets?.[key as keyof typeof facets]) || !facets![key as keyof typeof facets]!.length || new Set(facets![key as keyof typeof facets]).size !== facets![key as keyof typeof facets]!.length || facets![key as keyof typeof facets]!.some((index) => !Number.isInteger(index) || index < 0 || index >= anchors.length))) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
    } else if (facets !== undefined) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
    if (voiceMetrics) {
      const distinctVoiceFacets = new Set([...(facets!.abstraction ?? []), ...(facets!.sensory ?? []), ...(facets!.rhetoric ?? [])]);
      if (distinctVoiceFacets.size < 3) return { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: signal.dimensionId };
    }
    if (pacingMetrics) {
      if (facets!.turn!.length !== 1 || facets!.turn![0] !== anchors.length - 1) return { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: signal.dimensionId };
      const goal = Math.min(...facets!.goal!); const pressure = Math.min(...facets!.pressure!); const beat = Math.min(...facets!.beat!); const turn = facets!.turn![0]; const distinct = new Set(Object.values(facets!).flat());
      if (distinct.size < 3 || !(goal < pressure && pressure <= beat && beat <= turn) || regionFor(source, anchors[goal], policy, bodyStart) !== "opening" || regionFor(source, anchors[turn], policy, bodyStart) !== "ending") return { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: signal.dimensionId };
    }
    const metrics = localMetrics(source, anchors, policy, facets, bodyStart); const required = policy.requiredRegions ?? ["opening", "middle", "ending"]; const present = new Set(anchors.map((anchor) => regionFor(source, anchor, policy, bodyStart)));
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
    observation: { actor: slots.actor, action: slots.action, object: slots.object, feedback: slots.feedback, outcome: slots.outcome, reaction: slots.reaction, reciprocalAction: slots.reciprocalAction, relationshipOrStateChange: slots.relationshipChange, slots: { ...slots }, slotAnchors: Object.fromEntries(Object.entries(grounded.claim.slotAnchorIndices).map(([slot, index]) => [slot, grounded.anchors[index!]]).filter(([, anchor]) => !!anchor)), distributionMetrics: grounded.metrics ? { ...grounded.metrics } : undefined, distributionFacetAnchors: grounded.claim.distributionAnchorIndices ? Object.fromEntries(Object.entries(grounded.claim.distributionAnchorIndices).map(([facet, indices]) => [facet, indices!.map((index) => ({ ...grounded.anchors[index] }))])) : undefined },
    confidence: grounded.claim.confidence, status: "supported",
  };
}
