export type StoryStatus = "active" | "paused" | "completed" | "archived";

export type UserRole = "reader" | "admin";

export type CoverTheme = "tide" | "fog" | "moon" | "ember" | "forest";

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
  location: string;
  goal: string;
  knowledge: string[];
  relationship: string;
  protected: boolean;
  accent: "jade" | "rust" | "gold" | "blue";
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
  kind: "required" | "supporting" | "outline";
  summary: string;
  revisionId?: string;
  previousRevisionId?: string;
}

export interface CharacterStateSnapshot {
  characterId: string;
  before: Pick<CharacterProfile, "status" | "location" | "role">;
  after: Pick<CharacterProfile, "status" | "location" | "role">;
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
}

export interface ReadingProgress {
  chapterId: string;
  scrollProgress: number;
  updatedAt: string;
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
  canonVersion: number;
  summary: string;
  latestExcerpt: string;
  updatedAt: string;
  unreadCanonChanges: number;
  readingProgress: ReadingProgress;
  storyGene: StoryGene;
  endingContract: EndingContract;
  events: StoryEvent[];
  chapters: Chapter[];
  characters: CharacterProfile[];
  rules: StoryRule[];
  clues: StoryClue[];
  preferences: ReaderPreference[];
  conversation: ConversationMessage[];
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
  status: ModelConnectionStatus;
  routes: ModelRoutes;
  fallbackPolicy: "none" | "same_connection" | "platform_managed";
  capabilities: CapabilitySnapshot | null;
  updatedAt: string;
  lastError?: string;
}

export interface GenerationJob {
  id: string;
  storyTitle: string;
  chapterNumber: number;
  task: "chapter" | "retcon" | "extract";
  model: string;
  connectionId: string;
  promptVersion: string;
  status: "completed" | "running" | "failed";
  tokens: number;
  latencyMs: number;
  cost: number;
  createdAt: string;
  candidateTrace?: NarrativeCandidate[];
  filterSummary?: string;
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
}

export interface OpsMetrics {
  acceptedChapterRate: number;
  retconSuccessRate: number;
  canonConflictRate: number;
  firstTokenP95: number;
  acceptedChapterCost: number;
  activeStories: number;
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
  metrics: OpsMetrics;
  idempotencyKeys: string[];
}

export interface BootstrapPayload {
  user: UserProfile;
  stories: StorySummary[];
  activeStoryId: string | null;
}

export interface AuthPayload {
  token: string;
  user: UserProfile;
}

export interface CreateStoryInput {
  genre: string;
  tone?: string;
  length?: string;
  inspiration?: string;
}

export interface ModelConnectionInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  routes: ModelRoutes;
  fallbackPolicy: ModelConnection["fallbackPolicy"];
}
