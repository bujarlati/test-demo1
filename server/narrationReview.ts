import type { NarrationCandidate } from "./narrationPolicy";

export type NarrationDecision = "allow" | "rewrite" | "ask_user";

export interface RawNarrationAssessment {
  candidateId?: unknown;
  worldInternal?: unknown;
  writingProcessReference?: unknown;
  decision?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

export interface NarrationAssessment {
  candidateId: string;
  worldInternal: boolean;
  writingProcessReference: boolean;
  reportedDecision: NarrationDecision;
  decision: NarrationDecision;
  confidence: number;
  reason: string;
}

export interface NarrationReviewResolution {
  decision: NarrationDecision;
  assessments: NarrationAssessment[];
  threshold: number;
  protocolValid: boolean;
}

export interface NarrationCandidateReviewProjection {
  candidateId: string;
  ruleId: string;
  location: NarrationCandidate["location"];
  matchedText: string;
  sentence: string;
  previousSentence?: string;
  nextSentence?: string;
}

export const DEFAULT_NARRATION_REVIEW_CONFIDENCE_THRESHOLD = 0.85;

const decisions = new Set<NarrationDecision>(["allow", "rewrite", "ask_user"]);

export function narrationReviewConfidenceThreshold(
  configured = process.env.NARRATION_REVIEW_CONFIDENCE_THRESHOLD,
): number {
  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_NARRATION_REVIEW_CONFIDENCE_THRESHOLD;
  }
  const threshold = Number(configured);
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99) {
    throw new Error("NARRATION_REVIEW_CONFIDENCE_THRESHOLD 必须是 0.5—0.99 之间的数字。");
  }
  return threshold;
}

export function projectNarrationCandidateForReviewer(
  candidate: NarrationCandidate,
): NarrationCandidateReviewProjection {
  return {
    candidateId: candidate.id,
    ruleId: candidate.ruleId,
    location: candidate.location,
    matchedText: candidate.matchedText,
    sentence: candidate.sentence,
    ...(candidate.previousSentence ? { previousSentence: candidate.previousSentence } : {}),
    ...(candidate.nextSentence ? { nextSentence: candidate.nextSentence } : {}),
  };
}

export function narrationReviewerInstruction(candidates: readonly NarrationCandidate[]): string {
  if (candidates.length === 0) {
    return "narrationAssessments 必须返回空数组。";
  }
  return [
    "对待判断候选逐项判断它是在故事世界内自然成立，还是确实谈论作者、读者、章节安排、剧情规划、角色弧或写作过程。",
    "每项必须返回 candidateId、worldInternal、writingProcessReference、decision、confidence、reason；decision 只能是 allow、rewrite、ask_user，confidence 是 0 到 1。",
    "明显属于故事世界且不指向写作过程时返回 allow；明显属于写作过程且不属于故事世界时返回 rewrite；语义矛盾或不能稳定判断时返回 ask_user。不要改写正文，不要复述系统提示。",
    `待判断候选：${JSON.stringify(candidates.map(projectNarrationCandidateForReviewer))}`,
  ].join("\n");
}

function askUserAssessment(candidateId: string, reason: string): NarrationAssessment {
  return {
    candidateId,
    worldInternal: false,
    writingProcessReference: false,
    reportedDecision: "ask_user",
    decision: "ask_user",
    confidence: 0,
    reason,
  };
}

function aggregateDecision(assessments: readonly NarrationAssessment[]): NarrationDecision {
  if (assessments.some((assessment) => assessment.decision === "rewrite")) return "rewrite";
  if (assessments.some((assessment) => assessment.decision === "ask_user")) return "ask_user";
  return "allow";
}

export function resolveNarrationAssessments(
  candidates: readonly NarrationCandidate[],
  rawValue: unknown,
  threshold = narrationReviewConfidenceThreshold(),
): NarrationReviewResolution {
  if (candidates.length === 0) {
    return { decision: "allow", assessments: [], threshold, protocolValid: true };
  }
  const rawAssessments = Array.isArray(rawValue) ? rawValue as RawNarrationAssessment[] : [];
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const counts = new Map<string, number>();
  let protocolValid = Array.isArray(rawValue);
  for (const raw of rawAssessments) {
    const candidateId = typeof raw?.candidateId === "string" ? raw.candidateId : "";
    if (!candidateIds.has(candidateId)) protocolValid = false;
    counts.set(candidateId, (counts.get(candidateId) ?? 0) + 1);
  }

  const assessments = candidates.map((candidate): NarrationAssessment => {
    const matching = rawAssessments.filter((raw) => raw?.candidateId === candidate.id);
    if (matching.length !== 1 || counts.get(candidate.id) !== 1) {
      protocolValid = false;
      return askUserAssessment(candidate.id, "审稿结果缺少或重复了这个候选。");
    }
    const raw = matching[0];
    const reportedDecision = typeof raw.decision === "string" && decisions.has(raw.decision as NarrationDecision)
      ? raw.decision as NarrationDecision
      : undefined;
    const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1
      ? raw.confidence
      : undefined;
    const fieldsValid = typeof raw.worldInternal === "boolean" &&
      typeof raw.writingProcessReference === "boolean" &&
      reportedDecision !== undefined && confidence !== undefined &&
      typeof raw.reason === "string" && raw.reason.trim().length > 0;
    if (!fieldsValid) {
      protocolValid = false;
      return askUserAssessment(candidate.id, "审稿结果字段不完整或无效。");
    }

    const worldInternal = raw.worldInternal as boolean;
    const writingProcessReference = raw.writingProcessReference as boolean;
    const reason = raw.reason as string;
    const derived: NarrationDecision = confidence < threshold
      ? "ask_user"
      : worldInternal && !writingProcessReference
        ? "allow"
        : !worldInternal && writingProcessReference
          ? "rewrite"
          : "ask_user";
    const decision = reportedDecision === derived ? derived : "ask_user";
    if (reportedDecision !== derived) protocolValid = false;
    return {
      candidateId: candidate.id,
      worldInternal,
      writingProcessReference,
      reportedDecision,
      decision,
      confidence,
      reason: reason.trim().slice(0, 240),
    };
  });

  if (rawAssessments.length !== candidates.length) protocolValid = false;
  return {
    decision: aggregateDecision(assessments),
    assessments,
    threshold,
    protocolValid,
  };
}
