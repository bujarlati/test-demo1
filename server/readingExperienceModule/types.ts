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

export interface SemanticEvidenceAnchor { start: number; end: number; quote: string }

/** Versioned, source-grounded judgement input/output.  The assessor never accepts prose summaries. */
export interface SemanticEvidenceClaim {
  version: 1;
  dimensionId: string;
  signalId: string;
  supported: boolean;
  confidence: number;
  anchors: SemanticEvidenceAnchor[];
  slots?: Partial<Record<"actor" | "action" | "object" | "feedback" | "outcome" | "reaction" | "reciprocalAction" | "relationshipChange", string>>;
  metrics?: Record<string, number>;
}

export interface SemanticEvidenceCase {
  version: 1;
  contractRevisionId: string;
  stage: ExperienceStage;
  artifactKind: ExperienceArtifactKind;
  source: string;
  sourceHash: string;
  signals: Array<{ dimensionId: string; signalId: string; kind: string; policy: EvidencePolicy }>;
}
export interface SemanticVerdict { version: 1; claims: SemanticEvidenceClaim[] }

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
  /** Required by assessment for chapter/retcon artifacts; signed by the plan MAC. */
  chapterId?: string;
  revisionId?: string;
  /** Digest of the pre-approved output manifest, when a producer has one. */
  expectedArtifactDigest?: string;
  chapterNumber?: number;
  failedRuleIds?: string[];
  jobId: string;
  attempt: number;
}

/** A schedule-time debt obligation, bound to the dimension that must carry it. */
export interface ScheduledExperienceDebt extends ExperienceDebtV2 {
  dimensionId: string;
}

export interface ExperienceStagePlan {
  /** Bound to the signed ticket through the trusted plan record, not extra ticket payload fields. */
  chapterNumber: number;
  chapterId?: string;
  revisionId?: string;
  expectedArtifactDigest?: string;
  stage: ExperienceStage;
  artifactKind: ExperienceArtifactKind;
  promptProjection: { dimensions: Array<{ id: string; interpretation: string; signalIds: string[]; factReferences: CanonFactReferenceV2[]; roleBindings: { protagonistId: string } }>; prohibitions: string[] };
  evidenceSchema: EvidencePolicy[];
  duePromiseIds: string[];
  hardPresencePromiseIds: string[];
  softRollingPromiseIds: string[];
  dueSoftPromiseIds: string[];
  carriedDebtPromiseIds: string[];
  newDebts: ScheduledExperienceDebt[];
  authorizationMac: string;
  ticket: ExperienceStageTicket;
}

export interface SchedulerDependencies {
  now: () => Date;
  ticketSecret: string;
  ticketTtlMs: number;
  createTicketId?: (request: ScheduleExperienceRequest) => string;
}

export interface LedgerAuthorization {
  readonly plan: ExperienceStagePlan;
  readonly canon: { branchId: string; canonVersion: number; factReferences: CanonFactReferenceV2[] };
  readonly evidenceIds: string[];
  readonly authorizationRootMac: string;
}

export interface LedgerDependencies extends SchedulerDependencies {
  /** Immutable revision resolved by the ticket's contractRevisionId before the CAS write. */
  contract: CompiledExperienceContractRevision;
  /** Trusted record saved at scheduling time and looked up by the signed ticket/job. */
  authorization: LedgerAuthorization;
  /** Canon is resolved again at CAS time; schedule-time canon is not sufficient. */
  liveCanon: { branchId: string; canonVersion: number; factReferences: CanonFactReferenceV2[] };
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
  | "invalid_debt"
  | "invalid_stage"
  | "invalid_distribution"
  | "plan_mismatch"
  | "unauthorized_delivery"
  | "unauthorized_fact"
  | "insufficient_signals"
  | "invalid_authorization_payload";

export interface AssessExperienceRequest {
  plan: ExperienceStagePlan;
  artifact:
    | { kind: "blueprint"; value: unknown }
    | { kind: "chapter"; chapterId: string; revisionId: string; title: string; paragraphs: string[] }
    | { kind: "retcon_revision"; chapterId: string; revisionId: string; title: string; paragraphs: string[] };
}

export interface ExperiencePublicationPermit {
  version: 1;
  ticketId: string;
  jobId: string;
  attempt: number;
  contractRevisionId: string;
  activationId: string;
  branchId: string;
  chapterId: string;
  revisionId: string;
  artifactHash: string;
  stage: ExperienceStage;
  artifactKind: ExperienceArtifactKind;
  ruleGraphVersion: string;
  expectedCanonVersion: number;
  ledgerRevision: number;
  evidenceIds: string[];
  ledgerPatchHash: string;
  permitId: string;
  expiresAt: string;
  signature: string;
}

export interface AssessorDependencies {
  ticketSecret: string;
  now: () => Date;
  /** The immutable revision resolved from the signed ticket before assessment. */
  contract: CompiledExperienceContractRevision;
  semanticJudgePort: ExperienceSemanticJudgePort;
  statePort: AssessmentStatePort;
  createEvidenceId?: (input: { ticketId: string; signalId: string; chapterId: string; revisionId: string }) => string;
  repairTtlMs?: number;
  permitTtlMs?: number;
  judgeTimeoutMs?: number;
}

export interface AssessmentState {
  activationId: string;
  branchId: string;
  canonVersion: number;
  ledgerRevision: number;
  attempt: number;
  consumedTicketIds: readonly string[];
  consumedPermitIds: readonly string[];
  consumedRepairIds: readonly string[];
  chapterId?: string;
  revisionId?: string;
  expectedArtifactDigest?: string;
}

export interface AssessmentStatePort {
  read(input: { ticketId: string; jobId: string }): Promise<AssessmentState> | AssessmentState;
  consumeTicket(input: { ticketId: string; artifactHash: string; permitId: string }): Promise<boolean> | boolean;
  consumePermit(input: { permitId: string; ticketId: string }): Promise<boolean> | boolean;
  consumeRepair(input: { repairId: string; ticketId: string }): Promise<boolean> | boolean;
}

export interface PublicationPermitContext {
  ticketId: string; jobId: string; attempt: number; contractRevisionId: string; activationId: string; branchId: string;
  stage: ExperienceStage; artifactKind: ExperienceArtifactKind; ruleGraphVersion: string; expectedCanonVersion: number; ledgerRevision: number;
  chapterId: string; revisionId: string; artifactHash: string; evidenceIds: readonly string[]; ledgerPatchHash: string;
}

export interface ExperienceRepairToken {
  version: 1; repairId: string; ticketId: string; jobId: string; attempt: number; contractRevisionId: string; activationId: string; branchId: string;
  stage: ExperienceStage; artifactKind: ExperienceArtifactKind; expectedCanonVersion: number; ledgerRevision: number; chapterId?: string; revisionId?: string; artifactHash: string; failedRuleIds: string[]; expiresAt: string; signature: string;
}

export type ExperienceAssessment =
  | { status: "accepted"; artifactKind: "blueprint"; artifactHash: string }
  | { status: "accepted"; artifactKind: "chapter" | "retcon_revision"; artifactHash: string; permit: ExperiencePublicationPermit; evidence: ExperienceEvidenceV2[]; ledgerPatch: ExperienceLedgerPatch; canonFactCandidates: CanonFactReferenceV2[] }
  | { status: "rewrite"; artifactKind: ExperienceArtifactKind; failedRuleIds: string[]; repairToken: ExperienceRepairToken; message: string }
  | { status: "rejected"; artifactKind: ExperienceArtifactKind; failedRuleIds: string[]; message: string };

/** The public deep-module boundary. The factory is intentionally introduced in Task 3. */
export interface ReadingExperienceModule {
  compile(request: CompileExperienceRequest): Promise<ExperienceOperationResult<CompileOutcome>>;
  schedule(request: ScheduleExperienceRequest): ExperienceStagePlan;
  assess(request: AssessExperienceRequest): Promise<ExperienceOperationResult<ExperienceAssessment>>;
}

export interface ReadingExperienceModuleDependencies extends AssessorDependencies, SchedulerDependencies {
  interpretationPort: ExperienceInterpretationPort;
}
