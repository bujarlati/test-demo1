import type { StoryGenre, StoryLengthPlanId } from "./storyConfig";

export type StoryStatus = "active" | "paused" | "completed" | "archived";

export type UserRole = "reader" | "admin";

export interface EndingResolution {
  targetEndingSatisfied: boolean;
  targetEndingEvidence: string;
  satisfiedPrerequisiteIndices: number[];
  prerequisiteEvidence: Array<{ prerequisiteIndex: number; evidence: string }>;
  noContinuationHook: boolean;
}

export type CoverTheme = "tide" | "fog" | "moon" | "ember" | "forest";
export type CharacterLifecycle = "alive" | "dead" | "missing" | "presumed_dead";

export interface ChapterRevision {
  id: string;
  parentRevisionId: string | null;
  title: string;
  paragraphs: string[];
  reason: string;
  createdAt: string;
  modelName: string;
  promptVersion: string;
  changeSummary?: string;
  branchId?: string;
  endingResolution?: EndingResolution;
}

export interface Chapter {
  id: string;
  number: number;
  title: string;
  currentRevisionId: string;
  revisions: ChapterRevision[];
  estimatedMinutes: number;
  hasUnreadRevision?: boolean;
}

export interface CharacterProfile {
  id: string;
  name: string;
  role: string;
  initials: string;
  status: string;
  lifecycle: CharacterLifecycle;
  location: string;
  goal: string;
  knowledge: string[];
  knowledgeSources: KnowledgeFact[];
  inventoryItemIds: string[];
  relationship: string;
  protected: boolean;
  accent: "jade" | "rust" | "gold" | "blue";
}

export interface KnowledgeFact {
  fact: string;
  sourceChapter: number;
  sourceRevisionId: string;
}

export interface StoryItem {
  id: string;
  name: string;
  status: "available" | "held" | "lost" | "destroyed" | "consumed";
  holderCharacterId?: string;
  location: string;
  sourceChapter: number;
  sourceRevisionId: string;
}

export interface StoryRule {
  id: string;
  title: string;
  description: string;
  source: string;
  hardness: "hard" | "soft";
}

export interface StoryClue {
  id: string;
  title: string;
  status: "planted" | "strengthened" | "resolved";
  sourceChapter: number;
  description: string;
  spoiler: boolean;
}

export interface ReaderPreference {
  id: string;
  label: string;
  description: string;
  kind: "hard" | "soft";
  confidence: number;
  active: boolean;
}

export interface RetconChange {
  chapterNumber: number;
  chapterTitle: string;
  kind: "required" | "supporting" | "outline" | "unchanged";
  summary: string;
  revisionId?: string;
  previousRevisionId?: string;
}

export interface CharacterStateSnapshot {
  characterId: string;
  before: Pick<CharacterProfile, "status" | "lifecycle" | "location" | "role" | "relationship">;
  after: Pick<CharacterProfile, "status" | "lifecycle" | "location" | "role" | "relationship">;
}

export interface EventStateSnapshot {
  eventId: string;
  before: Pick<StoryEvent, "active" | "title" | "cause" | "outcome" | "revisionId" | "stateEffects">;
  after: Pick<StoryEvent, "active" | "title" | "cause" | "outcome" | "revisionId" | "stateEffects">;
}

export interface RetconTransaction {
  id: string;
  kind: "intervention" | "rollback";
  title: string;
  sourceText: string;
  summary: string;
  createdAt: string;
  canonVersionBefore: number;
  canonVersionAfter: number;
  changes: RetconChange[];
  cost: string;
  status: "committed" | "reversed";
  targetEventId?: string;
  reversesRetconId?: string;
  reversedByRetconId?: string;
  characterSnapshots?: CharacterStateSnapshot[];
  eventSnapshots?: EventStateSnapshot[];
  preferenceIds?: string[];
  branchIdBefore?: string;
  branchIdAfter?: string;
}

export type ConversationMessageType =
  | "text"
  | "progress"
  | "answer"
  | "retcon_result"
  | "preference_result";

export interface ConversationMessage {
  id: string;
  role: "user" | "system";
  type: ConversationMessageType;
  content: string;
  createdAt: string;
  observedCanonVersion: number;
  oldCanon?: boolean;
  retconId?: string;
  branchId?: string;
  threadId?: string;
}

export interface ConversationSummary {
  id: string;
  branchId: string;
  content: string;
  sourceMessageIds: string[];
  fromMessageId: string;
  toMessageId: string;
  updatedAt: string;
  version: number;
  parentSummaryId: string | null;
  sourceThreadId: string;
}

export interface ConversationThread {
  id: string;
  branchId: string;
  summary: ConversationSummary | null;
  summaries: ConversationSummary[];
  parentThreadId: string | null;
}

export interface ReaderMessageContext {
  chapterId: string;
  revisionId: string;
  selection?: string;
  eventId?: string;
}

export interface InterventionProposal {
  id: string;
  sourceMessageId: string;
  sourceText: string;
  classification: "event_veto" | "local_rewrite" | "future_direction" | "hard_constraint" | "soft_preference" | "question";
  confidence: number;
  targetEventId?: string;
  chapterId?: string;
  revisionId?: string;
  selection?: string;
  scope: "current_event" | "current_chapter" | "future" | "conversation_only";
  status: "parsed" | "committed" | "recorded" | "rejected" | "reversed";
  transactionId?: string;
  createdAt: string;
}

export interface ReadingProgress {
  chapterId: string;
  scrollProgress: number;
  updatedAt: string;
  progressVersion: number;
  activeBranchId: string;
  canonVersion: number;
}

export interface StoryBranch {
  id: string;
  name: string;
  basedOnBranchId: string | null;
  baseCanonVersion: number;
  headCanonVersion: number;
  createdAt: string;
  status: "active" | "superseded";
  chapterRevisionIds: Record<string, string>;
  /** Events at or below this sequence are already represented by baseStateSnapshot. */
  baseEventSequence: number;
  baseStateSnapshot?: CanonStateSnapshot;
  stateSnapshot?: CanonStateSnapshot;
}

export interface CanonStateSnapshot {
  characters: Array<Pick<CharacterProfile, "id" | "status" | "lifecycle" | "location" | "goal" | "knowledge" | "knowledgeSources" | "relationship" | "role" | "inventoryItemIds">>;
  items: StoryItem[];
  clues: StoryClue[];
}

export interface StoryGene {
  version: number;
  protagonistPosition: string;
  visibleGoal: string;
  hiddenNeed: string;
  conflictEngine: string;
  recurringCost: string;
  endingShape: string;
  creativeAxes: string[];
  createdAt: string;
}

export type ReadingExperienceAxisId = "primary" | "secondary";

export type ReadingExperienceSignalKind =
  | "mechanic"
  | "protagonist_action"
  | "conflict_outcome"
  | "world_reaction"
  | "relationship"
  | "pacing"
  | "voice";

export interface ReadingExperienceSignal {
  id: string;
  kind: ReadingExperienceSignalKind;
  description: string;
  /** Concrete phrases the writer must realize verbatim so evidence can be checked without reusing the feeling word as a label. */
  evidenceAnchors?: string[];
}

export interface ReadingExperiencePromise {
  id: string;
  description: string;
  scope: "opening" | "every_chapter" | "every_arc" | "whole_story";
}

export interface ReadingExperienceAxisContract {
  id: ReadingExperienceAxisId;
  word: string;
  interpretation: string;
  observableSignals: ReadingExperienceSignal[];
  hardPromises: ReadingExperiencePromise[];
  forbiddenShortcuts: string[];
}

export interface OpeningExperienceRequirement {
  chapterOffset: 0 | 1;
  requiredSignalIds: string[];
  mustHappen: string[];
}

export interface ReadingExperienceContract {
  schemaVersion: 1;
  sourceTone: string;
  sourceWords: [string, string];
  axes: [ReadingExperienceAxisContract, ReadingExperienceAxisContract];
  synthesis: string;
  globalHardPromises: ReadingExperiencePromise[];
  forbiddenCliches: string[];
  openingRequirements: [OpeningExperienceRequirement, OpeningExperienceRequirement];
  delivery: {
    minSignalsPerAxisPerChapter: number;
    maxSilentChapters: number;
    combinedSignalEveryChapters: number;
  };
  effectiveFromChapter: number;
  provenance: "curated" | "model" | "fallback" | "legacy";
  createdAt: string;
}

export interface ReadingExperienceEvidence {
  axisId: ReadingExperienceAxisId;
  word: string;
  signalIds: string[];
  quote: string;
}

/** Immutable V2 input retained for display and audit, never as prose keywords. */
export interface ReadingExperienceIntent {
  descriptors: readonly [
    { text: string; clarification?: string },
    { text: string; clarification?: string },
  ];
  locale: "zh-CN";
}

export type ExperienceCategory = "mechanic" | "protagonist_action" | "conflict_outcome" | "world_reaction" | "relationship" | "pacing" | "voice";
export type DistributionMetricId = "anchor_spread" | "scene_coverage" | "paragraph_consistency" | "beat_density" | "turn_position" | "abstraction_coverage" | "sensory_coverage" | "rhetoric_coverage" | "event_density" | "pressure_window" | "paragraph_length_density" | "sentence_length_density";
export type DistributionFacetId = "goal" | "pressure" | "beat" | "turn" | "abstraction" | "sensory" | "rhetoric";

export type EvidencePolicy =
  | { kind: "event_slots"; requiredSlots: Array<"actor" | "action" | "object" | "outcome" | "reaction">; minimumAnchors: number }
  | { kind: "relationship_change"; requireReciprocalAction: true; minimumAnchors: number }
  | { kind: "distribution"; metricIds: DistributionMetricId[]; minimumAnchors: number; requireSemanticJudge: true; requiredRegions: Array<"opening" | "middle" | "ending">; regionSemantics: "proportional" | "paragraph"; metricThresholds: Partial<Record<DistributionMetricId, number>> };

export interface ObservableSignalV2 {
  id: string;
  dimensionId: string;
  kind: ExperienceCategory;
  description: string;
  semanticSlots?: { actor?: string; action?: string; object?: string; outcome?: string; reaction?: string };
  verification: EvidencePolicy;
  persistence: "none" | "chapter" | "cross_chapter" | "whole_story";
}

export interface ExperienceProhibition {
  id: string;
  dimensionId: string | "both";
  kind: "invariant" | "shortcut" | "style_cliche";
  description: string;
  severity: "block" | "rewrite" | "penalty";
  ruleAdapterId?: string;
}

export interface ExperienceDimension {
  id: string;
  descriptor: string;
  interpretation: string;
  categories: ExperienceCategory[];
  observableSignals: ObservableSignalV2[];
  prohibitions: ExperienceProhibition[];
  confidence: number;
}

export interface DeliveryPromiseV2 {
  id: string;
  dimensionId: string | "both";
  scope: { kind: "chapter"; chapterNumber: number } | { kind: "every_chapter" } | { kind: "rolling_window"; chapters: number; minimumDeliveries: number } | { kind: "every_arc" } | { kind: "whole_story" };
  hardness: "hard" | "soft";
  minimumSignals: number;
  carryRuleIds: string[];
  compensationWindow?: number;
}

export interface CompiledExperienceContractRevision {
  id: string;
  schemaVersion: 2;
  revision: number;
  parentRevisionId: string | null;
  intent: ReadingExperienceIntent;
  dimensions: [ExperienceDimension, ExperienceDimension];
  synthesis: { sharedCause: string; dimensionRoles: [string, string] };
  promises: DeliveryPromiseV2[];
  prohibitions: ExperienceProhibition[];
  ruleGraphVersion: string;
  provenance: Array<{ kind: "curated" | "model" | "migration"; descriptor: string; version: string; interpretationDigest?: string }>;
  createdAt: string;
}

export interface ExperienceContractActivation {
  id: string;
  contractRevisionId: string;
  branchId: string;
  effectiveFromChapter: number;
  effectiveFromCanonVersion: number;
  effectiveThroughCanonVersion: number | null;
  activatedAt: string;
}

export interface TextAnchorV2 { start: number; end: number; text: string }
export interface CanonFactReferenceV2 { id: string; revisionId: string; kind: string }
export interface ExperienceDebtV2 { promiseId: string; dueByChapter: number }
export interface ExperiencePromiseStateV2 { promiseId: string; deliveredChapters: number[] }
export interface ExperienceLedgerHistoryEntryV2 {
  ticketId: string;
  expectedRevision: number;
  nextRevision: number;
  chapterNumber: number;
  appliedAt: string;
}

export interface ExperienceLedgerV2 {
  contractRevisionId: string;
  activationId: string;
  revision: number;
  branchId: string;
  throughCanonVersion: number;
  dimensions: Array<{ dimensionId: string; lastDeliveredChapter: number; silentChapters: number; deliveredSignalIds: string[]; persistentResults: CanonFactReferenceV2[]; debts: ExperienceDebtV2[] }>;
  evidenceIds: string[];
  /** Delivery history is structured data only; it never stores invented narrative facts. */
  promiseStates: ExperiencePromiseStateV2[];
  /** Consumed signed tickets make a successful ledger update single-use. */
  consumedTicketIds: string[];
  /** Append-only audit entries preserve prior successful CAS transitions. */
  history: ExperienceLedgerHistoryEntryV2[];
}

export interface ExperienceEvidenceV2 {
  id: string;
  contractRevisionId: string;
  activationId: string;
  branchId: string;
  dimensionId: string;
  signalId: string;
  eventId: string;
  ticketId: string;
  jobId: string;
  attempt: number;
  stage: string;
  artifactKind: string;
  ruleGraphVersion: string;
  expectedCanonVersion: number;
  ledgerRevision: number;
  chapterId: string;
  chapterRevisionId: string;
  sourceHash: string;
  anchors: TextAnchorV2[];
  observation: { actor?: string; action?: string; object?: string; feedback?: string; outcome?: string; reaction?: string; reciprocalAction?: string; relationshipOrStateChange?: string; slots?: Record<string, string>; slotAnchors?: Record<string, TextAnchorV2>; distributionMetrics?: Record<string, number>; distributionFacetAnchors?: Partial<Record<DistributionFacetId, TextAnchorV2[]>> };
  confidence: number;
  status: "supported" | "insufficient" | "contradicted";
}

export interface CanonFactCandidateV2 {
  id: string;
  evidenceId: string;
  revisionId: string;
  dimensionId: string;
  signalId: string;
  kind: "mechanic" | "relationship" | "outcome";
  observation: ExperienceEvidenceV2["observation"];
  anchors: TextAnchorV2[];
}

export interface ExperienceLedgerCheckpoint {
  id: string;
  branchId: string;
  throughCanonVersion: number;
  ledger: ExperienceLedgerV2;
  createdAt: string;
}

export interface ReadingExperienceStateV2 {
  schemaVersion: 2;
  activeActivationId: string;
  contractRevisions: CompiledExperienceContractRevision[];
  activations: ExperienceContractActivation[];
  ledgers: ExperienceLedgerV2[];
  evidence: ExperienceEvidenceV2[];
  checkpoints: ExperienceLedgerCheckpoint[];
  compilerVersion: string;
  evaluatorVersion: string;
}

export interface EndingContract {
  version: number;
  targetEnding: string;
  characterArc: string;
  prerequisites: string[];
  status: "viable" | "needs_review" | "reframed";
  lastEvaluatedAt: string;
}

export interface WorldBible {
  version: number;
  organizations: string[];
  locations: string[];
  abilityBoundaries: string[];
  pointOfView: string;
  styleParameters: string[];
  sourceRevisionIds: string[];
}

export interface CanonSummary {
  id: string;
  branchId: string;
  layer: "scene" | "chapter" | "arc" | "book";
  text: string;
  fromChapter: number;
  toChapter: number;
  sourceRevisionIds: string[];
  updatedAt: string;
}

export type StoryEventType =
  | "discovery"
  | "choice"
  | "relationship"
  | "death"
  | "survival"
  | "consequence";

export interface StoryEvent {
  id: string;
  chapterNumber: number;
  revisionId: string;
  type: StoryEventType;
  title: string;
  cause: string;
  outcome: string;
  participantIds: string[];
  location: string;
  dependsOn: string[];
  active: boolean;
  creativeAxis?: string;
  sequence: number;
  storyTime: string;
  branchId: string;
  originEventId?: string;
  stateEffects?: {
    characters?: Array<{
      characterId: string;
      status?: string;
      lifecycle?: CharacterLifecycle;
      location?: string;
      goal?: string;
      relationship?: string;
      role?: string;
      knowledgeGained?: KnowledgeFact[];
    }>;
    items?: Array<{ itemId: string; status: StoryItem["status"]; holderCharacterId?: string; location: string }>;
    clues?: Array<{ clueId: string; status: StoryClue["status"] }>;
  };
}

export interface Story {
  id: string;
  ownerId: string;
  title: string;
  subtitle: string;
  genre: string;
  tone: string;
  length: string;
  targetChapterCount: number;
  inspiration: string;
  coverTheme: CoverTheme;
  status: StoryStatus;
  activeBranchId: string;
  branches: StoryBranch[];
  canonVersion: number;
  summary: string;
  latestExcerpt: string;
  updatedAt: string;
  unreadCanonChanges: number;
  readingProgress: ReadingProgress;
  readingExperience: ReadingExperienceContract;
  readingExperienceV2?: ReadingExperienceStateV2;
  storyGene: StoryGene;
  endingContract: EndingContract;
  worldBible: WorldBible;
  summaries: CanonSummary[];
  events: StoryEvent[];
  chapters: Chapter[];
  characters: CharacterProfile[];
  items: StoryItem[];
  rules: StoryRule[];
  clues: StoryClue[];
  preferences: ReaderPreference[];
  conversation: ConversationMessage[];
  conversationThreads: ConversationThread[];
  proposals: InterventionProposal[];
  retcons: RetconTransaction[];
  modelConnectionId: string | null;
}

export interface StorySummary {
  id: string;
  title: string;
  subtitle: string;
  genre: string;
  tone: string;
  length: string;
  targetChapterCount: number;
  coverTheme: CoverTheme;
  status: StoryStatus;
  canonVersion: number;
  latestExcerpt: string;
  updatedAt: string;
  unreadCanonChanges: number;
  currentChapterNumber: number;
  currentChapterTitle: string;
  chapterCount: number;
  progress: number;
}

export interface ModelRoutes {
  planner: string;
  writer: string;
  extractor: string;
  embedding: string;
}

export type OpenAICompletionApi = "chat_completions" | "responses";
export type OpenAIEmbeddingApi = "embeddings" | "embeddings_multimodal";

export interface CapabilitySnapshot {
  completionApi?: OpenAICompletionApi;
  embeddingApi?: OpenAIEmbeddingApi;
  streaming: boolean;
  jsonSchema: boolean;
  embedding: boolean;
  promptCache: boolean;
  toolCalling: boolean;
  maxContextTokens: number | null;
  testedAt: string;
  latencyMs: number;
  models?: string[];
}

export type ModelConnectionStatus =
  | "draft"
  | "validating"
  | "active"
  | "degraded"
  | "disabled"
  | "revoked";

export interface ModelConnection {
  id: string;
  name: string;
  ownerScope: "platform" | "user";
  ownerId: string | null;
  protocol: "openai_compatible";
  baseUrl: string;
  maskedKey: string;
  secretRef: string;
  secretVersion: number;
  status: ModelConnectionStatus;
  routes: ModelRoutes;
  fallbackPolicy: "none" | "same_connection" | "platform_managed";
  capabilities: CapabilitySnapshot | null;
  updatedAt: string;
  lastError?: string;
}

export interface GenerationJob {
  id: string;
  ownerId: string;
  storyId: string;
  idempotencyKey?: string;
  storyTitle: string;
  chapterNumber: number;
  task: "opening" | "chapter" | "retcon" | "extract";
  model: string;
  connectionId: string;
  promptVersion: string;
  status: "completed" | "running" | "failed";
  tokens: number;
  tokenBudget?: number;
  usageEstimated?: boolean;
  budgetDegraded?: boolean;
  latencyMs: number;
  firstTokenMs?: number;
  cost: number;
  costEstimated?: boolean;
  createdAt: string;
  candidateTrace?: NarrativeCandidate[];
  filterSummary?: string;
  contextTrace?: Array<{
    component: "canon" | "hard_constraints" | "recent_chapter" | "conversation_summary" | "relevant_messages" | "recent_messages";
    sourceIds: string[];
    estimatedTokens: number;
  }>;
  acceptedAt?: string;
  rejectedAt?: string;
  acceptanceSignal?: "read_through" | "continued_generation" | "reader_intervention";
  retconId?: string;
  targetEventId?: string;
}

export type SafetySurface = "story_input" | "reader_message" | "candidate" | "chapter_output";

export interface SafetyDecision {
  id: string;
  actorUserId: string;
  storyId?: string;
  surface: SafetySurface;
  decision: "allowed" | "blocked";
  categories: string[];
  contentHash: string;
  createdAt: string;
}

export interface ContentReport {
  id: string;
  reporterUserId: string;
  storyId?: string;
  chapterId?: string;
  revisionId?: string;
  safetyDecisionId?: string;
  reason: string;
  status: "submitted" | "reviewing" | "resolved" | "appealed";
  createdAt: string;
  updatedAt: string;
  resolutionNote?: string;
}

export interface NarrativeCandidate {
  id: string;
  seed: number;
  creativeAxis: string;
  event: string;
  cause: string;
  cost: string;
  impact: string;
  novelty: string;
  score: number;
  status: "selected" | "rejected";
  reasons: string[];
  participantNames?: string[];
  storyTime?: string;
  dependsOnEventIds?: string[];
  knowledgeClaims?: Array<{ characterName: string; fact: string; sourceRevisionId?: string }>;
  knowledgeAudit?: {
    complete: boolean;
    dependencies: Array<{ characterName: string; fact: string }>;
  };
  itemTransitions?: Array<{
    itemName: string;
    actorName: string;
    fromStatus: StoryItem["status"];
    toStatus: StoryItem["status"];
  }>;
}

export interface OpsMetrics {
  acceptedChapterRate: number;
  retconSuccessRate: number;
  canonConflictRate: number;
  firstTokenP95: number;
  firstTokenSampleCount: number;
  acceptedChapterCost: number;
  acceptedChapterCostEstimated: boolean;
  activeStories: number;
}

export interface OpsQualityBucket {
  key: string;
  model: string;
  promptVersion: string;
  genre: string;
  jobs: number;
  completed: number;
  blockedCandidates: number;
  reports: number;
}

export interface UserAccount {
  id: string;
  email: string;
  passwordSalt: string;
  passwordHash: string;
  name: string;
  initials: string;
  role: UserRole;
  activeStoryId: string | null;
  defaultConnectionId: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  initials: string;
  role: UserRole;
  activeStoryId: string | null;
  defaultConnectionId: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface AuditEvent {
  id: string;
  actorUserId: string;
  action: string;
  targetType: "auth" | "story" | "connection" | "generation" | "retcon";
  targetId: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
}

export interface AppStore {
  users: UserAccount[];
  sessions: AuthSession[];
  stories: Story[];
  connections: ModelConnection[];
  jobs: GenerationJob[];
  auditEvents: AuditEvent[];
  safetyDecisions: SafetyDecision[];
  contentReports: ContentReport[];
  idempotencyKeys: string[];
  storyCreationRequests: Array<{ userId: string; idempotencyKey: string; storyId: string; createdAt: string }>;
}

export interface BootstrapPayload {
  user: UserProfile;
  stories: StorySummary[];
  modelConnections: GenerationModelOption[];
  activeStoryId: string | null;
  pendingJobs: GenerationJob[];
  recoverableJobs: GenerationJob[];
}

export interface AuthPayload {
  token: string;
  user: UserProfile;
}

export interface CreateStoryInput {
  genre: StoryGenre;
  tone?: string;
  lengthPlan?: StoryLengthPlanId;
  inspiration?: string;
  modelConnectionId?: string;
}

export interface GenerationModelOption {
  id: string;
  name: string;
  status: ModelConnectionStatus;
  plannerModel: string;
  writerModel: string;
  isDefault: boolean;
  managedLocal: boolean;
}

export interface ModelConnectionInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  routes: ModelRoutes;
  fallbackPolicy: ModelConnection["fallbackPolicy"];
}
