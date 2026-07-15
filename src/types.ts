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

export interface CapabilitySnapshot {
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
  task: "chapter" | "retcon" | "extract";
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
}

export interface ModelConnectionInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  routes: ModelRoutes;
  fallbackPolicy: ModelConnection["fallbackPolicy"];
}
