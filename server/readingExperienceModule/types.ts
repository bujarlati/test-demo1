import type {
  CanonFactReferenceV2,
  CompiledExperienceContractRevision,
  EvidencePolicy,
  ExperienceContractActivation,
  ExperienceDebtV2,
  ExperienceEvidenceV2,
  ExperienceLedgerV2,
  ReadingExperienceIntent,
} from "../../src/types";

export type ExperienceArtifactKind = "blueprint" | "chapter" | "retcon_revision";
export type ExperienceStage = "blueprint" | "opening" | "continuation" | "rewrite" | "retcon";

export interface CompileExperienceRequest {
  intent: ReadingExperienceIntent;
  context: { genre: string; inspiration: string };
  parentRevisionId: string | null;
  requestedRevision: number;
  jobId: string;
}

export type CompileOutcome =
  | { status: "ready"; revision: CompiledExperienceContractRevision }
  | { status: "needs_resolution"; code: "unknown_intent" | "irreconcilable_intent"; message: string }
  | { status: "rejected"; code: "invalid_intent" | "unsafe_intent"; message: string };

export interface ExperienceOperationError {
  code: "model_unavailable" | "invalid_model_output";
  message: string;
  stage: "interpretation" | "assessment";
  retryable: boolean;
  jobId: string;
}

export type ExperienceOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ExperienceOperationError };

export interface InterpretationSignalDraft {
  description: string;
  kind: "mechanic" | "protagonist_action" | "conflict_outcome" | "world_reaction" | "relationship" | "pacing" | "voice";
  semanticSlots?: { actor?: string; action?: string; object?: string; outcome?: string; reaction?: string };
  verification: EvidencePolicy;
  persistence: "none" | "chapter" | "cross_chapter" | "whole_story";
}

export interface InterpretationDimensionDraft {
  descriptor: string;
  interpretation: string;
  categories: InterpretationSignalDraft["kind"][];
  observableSignals: InterpretationSignalDraft[];
  prohibitions: Array<{ kind: "invariant" | "shortcut" | "style_cliche"; description: string; severity: "block" | "rewrite" | "penalty" }>;
  confidence: number;
}

export interface InterpretationCase {
  intent: ReadingExperienceIntent;
  context: CompileExperienceRequest["context"];
}

export interface InterpretationDraft {
  dimensions: [InterpretationDimensionDraft, InterpretationDimensionDraft];
  synthesis: { sharedCause: string; dimensionRoles: [string, string] };
  provenanceVersion: string;
}

export interface ExperienceInterpretationPort {
  interpret(input: InterpretationCase): Promise<InterpretationDraft>;
}

export interface SemanticEvidenceCase { contract: CompiledExperienceContractRevision; text: string; stage: ExperienceStage }
export interface SemanticVerdict { supported: boolean; confidence: number; message?: string }

export interface ExperienceSemanticJudgePort {
  judge(input: SemanticEvidenceCase): Promise<SemanticVerdict>;
}

export interface ExperienceStageTicket {
  id: string;
  contractRevisionId: string;
  activationId: string;
  ledgerRevision: number;
  branchId: string;
  expectedCanonVersion: number;
  ruleGraphVersion: string;
  stage: ExperienceStage;
  artifactKind: ExperienceArtifactKind;
  jobId: string;
  attempt: number;
  expiresAt: string;
  signature: string;
}

export interface ScheduleExperienceRequest {
  contract: CompiledExperienceContractRevision;
  activation: ExperienceContractActivation;
  ledger: ExperienceLedgerV2;
  canon: { branchId: string; canonVersion: number; factReferences: CanonFactReferenceV2[] };
  /** When omitted, the stage is derived from artifact kind, activation, and retry state. */
  stage?: ExperienceStage;
  artifactKind: ExperienceArtifactKind;
  chapterNumber?: number;
  failedRuleIds?: string[];
  jobId: string;
  attempt: number;
}

export interface ExperienceStagePlan {
  stage: ExperienceStage;
  artifactKind: ExperienceArtifactKind;
  promptProjection: { dimensions: Array<{ id: string; interpretation: string; signalIds: string[]; factReferences: CanonFactReferenceV2[] }>; prohibitions: string[] };
  evidenceSchema: EvidencePolicy[];
  duePromiseIds: string[];
  hardPresencePromiseIds: string[];
  softRollingPromiseIds: string[];
  newDebts: ExperienceDebtV2[];
  ticket: ExperienceStageTicket;
}

export interface SchedulerDependencies {
  now: () => Date;
  ticketSecret: string;
  ticketTtlMs: number;
  createTicketId?: (request: ScheduleExperienceRequest) => string;
}

export interface LedgerDependencies extends SchedulerDependencies {
  /** Immutable revision resolved by the ticket's contractRevisionId before the CAS write. */
  contract: CompiledExperienceContractRevision;
}

export interface ExperienceLedgerPatch {
  ticket: ExperienceStageTicket;
  expectedRevision: number;
  nextRevision: number;
  contractRevisionId: string;
  activationId: string;
  branchId: string;
  expectedCanonVersion: number;
  chapterNumber: number;
  deliveredSignalIdsByDimension: Record<string, string[]>;
  persistentResultsByDimension: Record<string, CanonFactReferenceV2[]>;
  newDebtsByDimension: Record<string, ExperienceDebtV2[]>;
  deliveredPromiseIds: string[];
  evidenceIds: string[];
}

export type ExperienceSchedulingErrorCode =
  | "activation_not_effective"
  | "activation_mismatch"
  | "contract_mismatch"
  | "branch_mismatch"
  | "canon_version_mismatch"
  | "stale_ledger"
  | "ledger_revision_mismatch"
  | "ticket_tampered"
  | "ticket_expired"
  | "ticket_reused"
  | "invalid_debt";

export interface AssessExperienceRequest {
  plan: ExperienceStagePlan;
  artifact:
    | { kind: "blueprint"; value: unknown }
    | { kind: "chapter"; chapterId: string; revisionId: string; title: string; paragraphs: string[] }
    | { kind: "retcon_revision"; chapterId: string; revisionId: string; title: string; paragraphs: string[] };
}

export type ExperienceAssessment =
  | { status: "accepted"; artifactKind: "blueprint"; artifactHash: string }
  | { status: "accepted"; artifactKind: "chapter" | "retcon_revision"; artifactHash: string; evidence: ExperienceEvidenceV2[]; ledgerPatch: unknown; canonFactCandidates: unknown[] }
  | { status: "rewrite"; artifactKind: ExperienceArtifactKind; failedRuleIds: string[]; repairToken: string; message: string }
  | { status: "rejected"; artifactKind: ExperienceArtifactKind; failedRuleIds: string[]; message: string };

/** The public deep-module boundary. The factory is intentionally introduced in Task 3. */
export interface ReadingExperienceModule {
  compile(request: CompileExperienceRequest): Promise<ExperienceOperationResult<CompileOutcome>>;
  schedule(request: ScheduleExperienceRequest): ExperienceStagePlan;
  assess(request: AssessExperienceRequest): Promise<ExperienceOperationResult<ExperienceAssessment>>;
}
