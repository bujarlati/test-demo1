export type StoryStatus = "active" | "paused" | "completed" | "archived";

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
}

export interface RetconTransaction {
  id: string;
  title: string;
  sourceText: string;
  summary: string;
  createdAt: string;
  canonVersionBefore: number;
  canonVersionAfter: number;
  changes: RetconChange[];
  cost: string;
  status: "committed" | "rolled_back";
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

export interface Story {
  id: string;
  title: string;
  subtitle: string;
  genre: string;
  tone: string;
  length: string;
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
  status: "completed" | "running" | "failed";
  tokens: number;
  latencyMs: number;
  cost: number;
  createdAt: string;
}

export interface OpsMetrics {
  acceptedChapterRate: number;
  retconSuccessRate: number;
  canonConflictRate: number;
  firstTokenP95: number;
  acceptedChapterCost: number;
  activeStories: number;
}

export interface AppStore {
  user: {
    id: string;
    name: string;
    initials: string;
    activeStoryId: string | null;
    defaultConnectionId: string;
  };
  stories: Story[];
  connections: ModelConnection[];
  jobs: GenerationJob[];
  metrics: OpsMetrics;
  idempotencyKeys: string[];
}

export interface BootstrapPayload {
  user: AppStore["user"];
  stories: StorySummary[];
  activeStoryId: string | null;
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
