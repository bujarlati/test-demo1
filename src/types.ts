import type { StoryGenre, StoryLengthPlanId } from "./storyConfig";

export type StoryStatus = "active" | "paused" | "completed" | "archived";

export type StoryPublicationStatus = "active" | "author_unpublished" | "admin_suspended";

export type UserRole = "reader" | "admin";

export interface ApiErrorPayload {
  message: string;
  code?: string;
  details?: Readonly<Record<string, unknown>>;
}

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
  experienceEvidence?: ReadingExperienceEvidence[];
  experienceDelivery?: ReadingExperienceDeliveryObservation[];
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

export type StoryCoreEntityKind = "story" | "character" | "item" | "clue";

export type StoryConstraintScalar = string | number | boolean | null;
export type StoryConstraintValue = StoryConstraintScalar | StoryConstraintScalar[];
export type StoryConstraintOperator = "eq" | "neq" | "in" | "not_in" | "exists";
export type StoryConstraintSource = "reader" | "author" | "system" | "legacy_rule" | "legacy_preference";

export interface StoryCoreEntity {
  id: string;
  kind: StoryCoreEntityKind;
  name: string;
}

export interface StoryCoreEntityState {
  entityId: string;
  kind: StoryCoreEntityKind;
  values: Record<string, StoryConstraintValue | undefined>;
}

export interface StoryConstraint {
  id: string;
  title: string;
  description: string;
  targetEntityId: string;
  path: string;
  operator: StoryConstraintOperator;
  expectedValue: StoryConstraintValue;
  source: StoryConstraintSource;
  hardness: "hard" | "soft";
  scope: "story" | "branch";
  branchId: string;
  status: "active" | "inactive";
  baseCanonVersion: number;
  createdAt: string;
  idempotencyKey: string;
  readOnly: boolean;
  enforceable: boolean;
}

export interface CreateStoryConstraintInput {
  title: string;
  description: string;
  targetEntityId: string;
  path: string;
  operator: StoryConstraintOperator;
  expectedValue: StoryConstraintValue;
  source: Exclude<StoryConstraintSource, "legacy_rule" | "legacy_preference">;
  hardness: StoryConstraint["hardness"];
  scope: StoryConstraint["scope"];
  branchId: string;
  baseCanonVersion: number;
  idempotencyKey: string;
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

export type ReadingExperienceDeliveryMode = "hard_every_chapter" | "soft_window";

export interface ReadingExperienceAxisDeliveryPolicy {
  axisId: ReadingExperienceAxisId;
  mode: ReadingExperienceDeliveryMode;
  targetWindowChapters: number;
  targetMaxOpenConflictChapters: number;
}

export type ReadingExperienceConflictState =
  | "no_conflict"
  | "open_parity"
  | "dominant_victory"
  | "conclusive_defeat";

export interface ReadingExperienceDeliveryObservation {
  axisId: ReadingExperienceAxisId;
  state: ReadingExperienceConflictState;
  sourceQuote?: string;
}

export interface ReadingExperienceDeliveryLedgerEntry {
  axisId: ReadingExperienceAxisId;
  lastEvaluatedChapter: number;
  lastDeliveredChapter?: number;
  silentChapters: number;
  debtOpen: boolean;
  openConflictSinceChapter?: number;
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
    axisPolicies?: ReadingExperienceAxisDeliveryPolicy[];
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
  source?: "reader" | "agent" | "system";
  idempotencyKey?: string;
  baseCanonVersion?: number;
  createdAt?: string;
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

export interface AppendStoryCoreEventInput {
  chapterNumber: number;
  revisionId: string;
  type: StoryEventType;
  title: string;
  cause: string;
  outcome: string;
  participantIds: string[];
  location: string;
  dependsOn: string[];
  storyTime: string;
  stateEffects: NonNullable<StoryEvent["stateEffects"]>;
  branchId: string;
  baseCanonVersion: number;
  idempotencyKey: string;
  source: NonNullable<StoryEvent["source"]>;
}

export type AppendReaderStoryEventInput = Omit<
  AppendStoryCoreEventInput,
  "title" | "cause" | "outcome" | "source"
>;

export interface StoryWorldState {
  storyId: string;
  branchId: string;
  canonVersion: number;
  entities: StoryCoreEntity[];
  states: StoryCoreEntityState[];
  events: StoryEvent[];
  eventCount: number;
  constraints: StoryConstraint[];
}

export interface StoryConstraintCommandResult {
  constraint: StoryConstraint;
  worldState: StoryWorldState;
  duplicate: boolean;
}

export interface StoryEventCommandResult {
  event: StoryEvent;
  worldState: StoryWorldState;
  duplicate: boolean;
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
  readingExperienceDeliveryLedger?: ReadingExperienceDeliveryLedgerEntry[];
  storyGene: StoryGene;
  endingContract: EndingContract;
  worldBible: WorldBible;
  summaries: CanonSummary[];
  events: StoryEvent[];
  chapters: Chapter[];
  characters: CharacterProfile[];
  items: StoryItem[];
  rules: StoryRule[];
  constraints: StoryConstraint[];
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

export interface OwnerPublicationState {
  storyId: string;
  status: "private" | StoryPublicationStatus;
  published: boolean;
  sharePath: string;
  firstPublishedAt: string | null;
  statusUpdatedAt: string | null;
  adminReason: string | null;
}

export interface SetStoryPublicationInput {
  published: boolean;
  publicPenName?: string;
}

export interface PublicProfileInput {
  publicPenName: string;
}

export interface PublicProfile {
  publicPenName: string;
}

export interface PublicReadingProgress {
  storyId: string;
  chapterId: string;
  chapterNumber: number;
  scrollProgress: number;
  progressVersion: number;
  updatedAt: string;
}

export interface SavePublicReadingProgressInput {
  chapterId: string;
  scrollProgress: number;
  expectedVersion: number;
}

export interface PublicStoryCurrentRevision {
  id: string;
  title: string;
  paragraphs: string[];
  createdAt: string;
}

export interface PublicStoryChapter {
  id: string;
  number: number;
  title: string;
  estimatedMinutes: number;
  currentRevision: PublicStoryCurrentRevision;
}

export interface PublicStorySummary {
  id: string;
  title: string;
  subtitle: string;
  genre: string;
  tone: string;
  length: string;
  coverTheme: CoverTheme;
  status: Exclude<StoryStatus, "archived">;
  authorPenName: string;
  chapterCount: number;
  currentChapterNumber: number;
  currentChapterTitle: string;
  latestExcerpt: string;
  updatedAt: string;
}

export interface PublicStoryDetail extends PublicStorySummary {
  targetChapterCount: number;
  chapters: PublicStoryChapter[];
  readingProgress: PublicReadingProgress | null;
  viewerIsOwner: boolean;
}

export interface PublicStoryPage {
  stories: PublicStorySummary[];
  nextCursor: string | null;
}

export interface PublicStoryQuery {
  query?: string;
  genre?: StoryGenre;
  cursor?: string;
  limit?: number;
}

export interface PublicStoryReportTarget {
  storyId: string;
  chapterId: string;
  revisionId: string;
}

export interface PublicationModerationInput {
  action: "suspend" | "restore";
  reason?: string;
}

export interface PublicationModerationSummary {
  storyId: string;
  title: string;
  authorPenName: string;
  status: StoryPublicationStatus;
  firstPublishedAt: string;
  statusUpdatedAt: string;
  adminReason: string | null;
}

export interface PublicationModerationCounts {
  total: number;
  active: number;
  authorUnpublished: number;
  adminSuspended: number;
}

export interface PublicationModerationOverview {
  counts: PublicationModerationCounts;
  recent: PublicationModerationSummary[];
}

export interface OpsPublicationModeration extends PublicationModerationOverview {
  enabled: boolean;
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

export type GenerationTask = "opening" | "chapter" | "retcon" | "extract";

export type GenerationFailureCategory =
  | "transport"
  | "timeout"
  | "provider"
  | "json"
  | "quality"
  | "safety"
  | "budget"
  | "interrupted"
  | "persistence"
  | "unknown";

export interface GenerationFailureObservation {
  id: string;
  jobId: string;
  ownerId: string;
  storyId: string;
  task: GenerationTask;
  stage: string;
  classifierVersion: string;
  category: GenerationFailureCategory;
  reasonCode: string;
  message: string;
  fingerprint: string;
  model: string;
  connectionId: string;
  promptVersion: string;
  attempt: number;
  terminal: boolean;
  retryable: boolean;
  latencyMs: number;
  tokens: number;
  createdAt: string;
}

export interface GenerationFailureSummaryBucket {
  key: string;
  category: GenerationFailureCategory;
  reasonCode: string;
  stage: string;
  model: string;
  occurrences: number;
  affectedJobs: number;
  terminalFailures: number;
  recoveredJobs: number;
  lastSeenAt: string;
}

export interface NarrationReviewMetricBucket {
  key: string;
  ruleId: string;
  ruleVersion: string;
  candidates: number;
  modelAllow: number;
  modelRewrite: number;
  modelAskUser: number;
  userKeep: number;
  userRewrite: number;
  timeoutRewrite: number;
  rewriteSucceeded: number;
  finalJobsCompleted: number;
  lastSeenAt: string;
}

export type GenerationJobStatus = "completed" | "running" | "awaiting_user_review" | "failed";

export type OpeningRevisionReasonCode =
  | "content_incomplete"
  | "experience_not_clear"
  | "structure_needs_adjustment"
  | "narration_needs_polish"
  | "quality_needs_adjustment";

interface OpeningJobProgressBase {
  version: 1;
  seq: number;
  stageStartedAt: string;
  updatedAt: string;
}

export type OpeningJobProgress =
  | (OpeningJobProgressBase & {
      stage: "planning";
      activity: "planning";
      draftNumber: null;
    })
  | (OpeningJobProgressBase & {
      stage: "drafting";
      activity: "writing";
      draftNumber: 1;
    })
  | (OpeningJobProgressBase & {
      stage: "reviewing";
      activity: "checking";
      draftNumber: 1 | 2;
    })
  | (OpeningJobProgressBase & {
      stage: "reviewing";
      activity: "revising";
      draftNumber: 2;
      revisionSource: "quality" | "user" | "timeout";
      revisionReason: OpeningRevisionReasonCode;
    })
  | (OpeningJobProgressBase & {
      stage: "saving";
      activity: "saving";
      draftNumber: 1 | 2;
    });

export interface GenerationJob {
  id: string;
  ownerId: string;
  storyId: string;
  idempotencyKey?: string;
  storyTitle: string;
  chapterNumber: number;
  task: GenerationTask;
  model: string;
  connectionId: string;
  promptVersion: string;
  status: GenerationJobStatus;
  tokens: number;
  tokenBudget?: number;
  usageEstimated?: boolean;
  budgetDegraded?: boolean;
  latencyMs: number;
  firstTokenMs?: number;
  cost: number;
  costEstimated?: boolean;
  createdAt: string;
  openingProgress?: OpeningJobProgress;
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

export type ChapterGenerationStatusPayload =
  | { status: "not_found" }
  | { jobId: string; status: "running" }
  | { jobId: string; status: "completed"; story: Story }
  | { jobId: string; status: "failed"; message: string; retryable: boolean };

export interface PendingNarrationReviewView {
  id: string;
  version: number;
  jobId: string;
  contentHash: string;
  deadlineAt: string;
  candidates: Array<{
    id: string;
    ruleId: string;
    location: "title" | "body";
    matchedText: string;
    sentence: string;
    previousSentence?: string;
    nextSentence?: string;
    highlightStart: number;
    highlightEnd: number;
  }>;
}

export interface NarrationReviewDecisionInput {
  caseId: string;
  caseVersion: number;
  contentHash: string;
  candidateIds: string[];
  decision: "keep" | "rewrite";
  shareRedactedContext: boolean;
}

export type OpeningJobStatusPayload =
  | { jobId: string; status: "running"; progress?: OpeningJobProgress | null }
  | {
      jobId: string;
      status: "awaiting_user_review";
      progress?: OpeningJobProgress | null;
      review: PendingNarrationReviewView;
    }
  | { jobId: string; status: "completed"; storyId: string }
  | {
      jobId: string;
      status: "failed";
      message: string;
      retryable: boolean;
    };

export type CreateStoryResult =
  | { kind: "completed"; story: Story }
  | { kind: "job"; job: OpeningJobStatusPayload };

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
  publicPenName: string | null;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  initials: string;
  role: UserRole;
  activeStoryId: string | null;
  defaultConnectionId: string;
  publicPenName: string | null;
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
  generationFailures: GenerationFailureObservation[];
  auditEvents: AuditEvent[];
  safetyDecisions: SafetyDecision[];
  contentReports: ContentReport[];
  idempotencyKeys: string[];
  storyCreationRequests: Array<{ userId: string; idempotencyKey: string; storyId: string; createdAt: string }>;
}

export interface BootstrapPayload {
  user: UserProfile;
  features: { publicStorySharing: boolean };
  stories: StorySummary[];
  storyPage: {
    nextCursor: string | null;
    totalStories: number;
    totalChapters: number;
  };
  modelConnections: GenerationModelOption[];
  activeStoryId: string | null;
  pendingJobs: GenerationJob[];
  recoverableJobs: GenerationJob[];
}

export interface StoryPagePayload {
  stories: StorySummary[];
  nextCursor: string | null;
  totalStories: number;
  totalChapters: number;
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
