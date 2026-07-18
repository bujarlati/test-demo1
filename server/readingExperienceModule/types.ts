import type {
  CanonFactReferenceV2,
  CanonFactCandidateV2,
  CompiledExperienceContractRevision,
  EvidencePolicy,
  ExperienceContractActivation,
  ExperienceDebtV2,
  ExperienceEvidenceV2,
  ExperienceLedgerV2,
  ExperienceProhibition,
  DeliveryPromiseV2,
  DistributionFacetId,
  ObservableSignalV2,
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
  prohibitions: Array<{ kind: "invariant" | "shortcut" | "style_cliche"; description: string; severity: "block" | "rewrite" | "penalty"; ruleAdapterId?: GenericRuleAdapterId }>;
  confidence: number;
}
export type GenericRuleAdapterId = "event-negated" | "event-intent" | "event-failed-attempt" | "event-simulation" | "event-hearsay" | "helper-substitution" | "contains-pasted-label" | "curated-mechanic-unavailable" | "curated-outcome-weakened";

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
  eventId: string;
  dimensionId: string;
  signalId: string;
  supported: boolean;
  confidence: number;
  anchors: SemanticEvidenceAnchor[];
  slotAnchorIndices: Partial<Record<"actor" | "action" | "object" | "feedback" | "outcome" | "reaction" | "reciprocalAction" | "relationshipChange" | "counterpart" | "counterpartId" | "opponent" | "opponentId", number>>;
  slots?: Partial<Record<"actor" | "action" | "object" | "feedback" | "outcome" | "reaction" | "reciprocalAction" | "relationshipChange" | "counterpart" | "counterpartId" | "opponent" | "opponentId", string>>;
  metrics?: Record<string, number>;
  /** Judge-typed distribution facets; every index addresses this claim's grounded anchors. */
  distributionAnchorIndices?: Partial<Record<DistributionFacetId, number[]>>;
}

export interface SemanticEvidenceCase {
  version: 1;
  contractRevisionId: string;
  stage: ExperienceStage;
  artifactKind: ExperienceArtifactKind;
  source: string;
  sourceHash: string;
  synthesis: { sharedCause: string; dimensionRoles: [string, string] };
  signals: Array<{ dimensionId: string; signalId: string; kind: string; interpretation: string; description: string; semanticSlots?: Record<string, string>; policy: EvidencePolicy; canonFactReferences: CanonFactReferenceV2[]; prohibitions: Array<{ id: string; kind: string; description: string; severity: string; ruleAdapterId?: string }> }>;
}
export interface SemanticSharedCauseLink { dimensionId: string; signalId: string; claimAnchorIndex: number; sharedAnchorIndex: number }
export interface SemanticSharedCauseClaim { eventId: string; supported: boolean; confidence: number; anchors: SemanticEvidenceAnchor[]; links: SemanticSharedCauseLink[] }
export interface SemanticVerdict { version: 1; claims: SemanticEvidenceClaim[]; sharedCause: SemanticSharedCauseClaim }

export interface SemanticBlueprintVerdict {
  version: 1;
  kind: "blueprint";
  signals: Array<{ dimensionId: string; signalId: string; pointer: string; supported: boolean }>;
  promises: Array<{ promiseId: string; pointer: string; supported: boolean }>;
  ending: { targetPointer: string; costPointer: string; supported: boolean; systemState: "available" | "unavailable" | "not_applicable"; protagonistOutcome: "fulfilled" | "defeated" | "unresolved"; hasRealCost: boolean };
  sharedCause: { pointer: string; dimensionIds: string[]; supported: boolean };
  confidence: number;
}

export interface ExperienceSemanticJudgePort {
  judge(input: SemanticEvidenceCase, options?: { signal: AbortSignal }): Promise<SemanticVerdict | SemanticBlueprintVerdict>;
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
  artifactBindingId?: string;
  roleBindings: { version?: 1; protagonistId: string; aliases: string[]; counterpartIds?: string[]; opponentIds?: string[]; counterparts?: Array<{ id: string; aliases: string[] }>; opponents?: Array<{ id: string; aliases: string[] }> };
  chapterNumber?: number;
  repair?: { token: ExperienceRepairToken; expected: RepairTokenContext };
  /** Optional legacy rewrite assertion. It never grants rewrite authority. */
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
  artifactBindingId: string;
  roleBindings: { version: 1; protagonistId: string; aliases: string[]; counterpartIds: string[]; opponentIds: string[]; counterparts: Array<{ id: string; aliases: string[] }>; opponents: Array<{ id: string; aliases: string[] }> };
  stage: ExperienceStage;
  artifactKind: ExperienceArtifactKind;
  /** Descriptor-free, immutable semantics required by assessment. */
  assessmentContract: AssessmentContractProjection;
  promptProjection: { dimensions: Array<{ id: string; interpretation: string; signalIds: string[]; factReferences: CanonFactReferenceV2[] }>; prohibitions: string[] };
  evidenceSchema: EvidencePolicy[];
  ruleAdapterIds: GenericRuleAdapterId[];
  duePromiseIds: string[];
  hardPresencePromiseIds: string[];
  softRollingPromiseIds: string[];
  dueSoftPromiseIds: string[];
  carriedDebtPromiseIds: string[];
  newDebts: ScheduledExperienceDebt[];
  /** Failed rules authorized by a consumed repair token; empty for first drafts. */
  repairRuleIds: string[];
  /** Signed failed-draft authorization, consumed atomically with assessment. */
  repairAuthorization?: { token: ExperienceRepairToken; expected: RepairTokenContext; tokenDigest: string };
  authorizationMac: string;
  ticket: ExperienceStageTicket;
}

export interface AssessmentContractProjection {
  version: 1;
  schemaVersion: 2;
  contractRevisionId: string;
  ruleGraphVersion: string;
  synthesis: { sharedCause: string; dimensionRoles: [string, string] };
  dimensions: Array<{ id: string; interpretation: string; observableSignals: ObservableSignalV2[]; prohibitions: ExperienceProhibition[] }>;
  promises: DeliveryPromiseV2[];
  prohibitions: ExperienceProhibition[];
  identityHash: string;
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
  readonly evidenceBindings: LedgerEvidenceBinding[];
  readonly authorizedPatchHash: string;
  readonly publicationPermit: ExperiencePublicationPermit;
  readonly authorizationRootMac: string;
}

export interface LedgerEvidenceBinding {
  readonly evidenceId: string;
  readonly dimensionId: string;
  readonly signalId: string;
  readonly chapterRevisionId: string;
  readonly sourceHash: string;
  readonly evidenceDigest: string;
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
  /** Signed prospective canon write-set; persistent references must map one-to-one. */
  canonFactCandidates: CanonFactCandidateV2[];
  /** Promise -> dimension -> evidence IDs; `both` promises never collapse axes. */
  promiseEvidenceLinks: Record<string, Record<string, string[]>>;
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
  artifactBindingId: string;
  artifactHash: string;
  stage: ExperienceStage;
  artifactKind: ExperienceArtifactKind;
  ruleGraphVersion: string;
  expectedCanonVersion: number;
  ledgerRevision: number;
  evidenceIds: string[];
  evidenceBindings: LedgerEvidenceBinding[];
  /** Content commitment over the complete, sorted evidence bindings and bodies. */
  evidenceRootHash: string;
  ledgerPatchHash: string;
  permitId: string;
  expiresAt: string;
  signature: string;
}

export interface AssessorDependencies {
  ticketSecret: string;
  now: () => Date;
  /** @deprecated Assessment semantics are carried by the signed descriptor-free plan projection. */
  contract?: CompiledExperienceContractRevision;
  semanticJudgePort: ExperienceSemanticJudgePort;
  statePort: AssessmentStatePort;
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
  existingEvidenceIds: readonly string[];
  chapterId?: string;
  revisionId?: string;
  artifactBindingId: string;
  expectedArtifactDigest: string | null;
}

export interface AssessmentStatePort {
  read(input: { ticketId: string; jobId: string }): Promise<AssessmentState> | AssessmentState;
  consumeTicket(input: { ticketId: string; artifactHash: string; outcomeId: string; outcome: "accepted" | "rewrite" | "rejected" | "blueprint"; newEvidenceIds: readonly string[]; issuedAuthorization?: { kind: "permit"; permitId: string; permitDigest: string; context: PublicationPermitContext } | { kind: "repair"; repairId: string; tokenDigest: string; context: RepairTokenContext }; repairAuthorization?: { repairId: string; tokenDigest: string; expected: RepairTokenContext }; expected: { activationId: string; branchId: string; canonVersion: number; ledgerRevision: number; attempt: number; chapterId?: string; revisionId?: string; artifactBindingId: string; expectedArtifactDigest?: string; existingEvidenceIds: readonly string[] } }): Promise<boolean> | boolean;
  consumePermit(input: { permitId: string; ticketId: string; permitDigest: string; context: PublicationPermitContext; expected: { activationId: string; branchId: string; canonVersion: number; ledgerRevision: number; attempt: number; chapterId: string; revisionId: string; artifactBindingId: string; expectedArtifactDigest: string } }): Promise<boolean> | boolean;
  consumeRepair(input: { repairId: string; ticketId: string; tokenDigest: string; expected: { activationId: string; branchId: string; canonVersion: number; ledgerRevision: number; attempt: number; chapterId?: string; revisionId?: string; artifactBindingId: string; expectedArtifactDigest: string } }): Promise<boolean> | boolean;
  bindArtifactDigest?(input: { ticketId: string; artifactBindingId: string; artifactHash: string; expected: { activationId: string; branchId: string; canonVersion: number; ledgerRevision: number; attempt: number; chapterId?: string; revisionId?: string; expectedArtifactDigest: null } }): Promise<boolean> | boolean;
}

export type RepairTokenContext =
  | { ticketId: string; jobId: string; attempt: number; contractRevisionId: string; activationId: string; branchId: string; stage: ExperienceStage; artifactKind: "blueprint"; ruleGraphVersion: string; expectedCanonVersion: number; ledgerRevision: number; chapterNumber: number; artifactBindingId: string; roleBindings: ExperienceStagePlan["roleBindings"]; artifactHash: string; failedRuleIds: readonly string[] }
  | { ticketId: string; jobId: string; attempt: number; contractRevisionId: string; activationId: string; branchId: string; stage: ExperienceStage; artifactKind: "chapter" | "retcon_revision"; ruleGraphVersion: string; expectedCanonVersion: number; ledgerRevision: number; chapterNumber: number; chapterId: string; revisionId: string; artifactBindingId: string; roleBindings: ExperienceStagePlan["roleBindings"]; artifactHash: string; failedRuleIds: readonly string[] };

export interface PublicationPermitContext {
  ticketId: string; jobId: string; attempt: number; contractRevisionId: string; activationId: string; branchId: string;
  stage: ExperienceStage; artifactKind: ExperienceArtifactKind; ruleGraphVersion: string; expectedCanonVersion: number; ledgerRevision: number;
  chapterId: string; revisionId: string; artifactBindingId: string; artifactHash: string; evidenceIds: readonly string[]; evidenceBindings: readonly LedgerEvidenceBinding[]; evidenceRootHash: string; ledgerPatchHash: string;
}

export interface ExperienceRepairToken {
  version: 1; repairId: string; ticketId: string; jobId: string; attempt: number; contractRevisionId: string; activationId: string; branchId: string;
  stage: ExperienceStage; artifactKind: ExperienceArtifactKind; ruleGraphVersion: string; expectedCanonVersion: number; ledgerRevision: number; chapterNumber: number; chapterId?: string; revisionId?: string; artifactBindingId: string; roleBindings: ExperienceStagePlan["roleBindings"]; artifactHash: string; failedRuleIds: string[]; expiresAt: string; signature: string;
}

export type ExperienceAssessment =
  | { status: "accepted"; artifactKind: "blueprint"; artifactHash: string }
  | { status: "accepted"; artifactKind: "chapter" | "retcon_revision"; artifactHash: string; permit: ExperiencePublicationPermit; evidence: ExperienceEvidenceV2[]; ledgerPatch: ExperienceLedgerPatch; canonFactCandidates: CanonFactCandidateV2[] }
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
