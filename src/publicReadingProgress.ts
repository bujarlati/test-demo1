import type {
  PublicReadingProgress,
  PublicStoryDetail,
} from "./types";

export const PUBLIC_READING_PROGRESS_DEBOUNCE_MS = 900;

export interface PublicReadingProgressState {
  storyId: string;
  chapterId: string | null;
  scrollProgress: number;
  progressVersion: number;
  availability: "loading" | "available" | "unavailable";
  saveStatus: "idle" | "saving" | "saved" | "conflict" | "error";
  saveError: string | null;
}

export type PublicReadingProgressAction =
  | { type: "reset"; storyId: string }
  | { type: "detail_loaded"; detail: PublicStoryDetail }
  | { type: "position_changed"; chapterId: string; scrollProgress: number }
  | { type: "save_started" }
  | { type: "save_succeeded"; progress: PublicReadingProgress }
  | { type: "server_progress_received"; progress: PublicReadingProgress | null }
  | { type: "save_failed"; message: string }
  | { type: "story_unavailable" };

export interface PublicProgressDraft {
  chapterId: string;
  scrollProgress: number;
}

export interface PublicProgressClock {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PublicProgressDebouncer<Value> {
  schedule(value: Value): void;
  cancel(): void;
  stop(): void;
  resume(): void;
  hasPending(): boolean;
  isStopped(): boolean;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function createPublicReadingProgressState(storyId = ""): PublicReadingProgressState {
  return {
    storyId,
    chapterId: null,
    scrollProgress: 0,
    progressVersion: 0,
    availability: "loading",
    saveStatus: "idle",
    saveError: null,
  };
}

export function restorePublicReadingProgress(detail: PublicStoryDetail): PublicReadingProgressState {
  const chapters = [...detail.chapters].sort((left, right) => left.number - right.number);
  const progress = detail.readingProgress;
  const exactChapter = progress
    ? chapters.find((chapter) => chapter.id === progress.chapterId)
    : null;
  const chapterByNumber = progress && !exactChapter
    ? [...chapters].reverse().find((chapter) => chapter.number <= progress.chapterNumber)
    : null;
  const chapter = exactChapter ?? chapterByNumber ?? chapters[0] ?? null;
  return {
    storyId: detail.id,
    chapterId: chapter?.id ?? null,
    scrollProgress: progress && exactChapter ? clampProgress(progress.scrollProgress) : 0,
    progressVersion: progress && Number.isInteger(progress.progressVersion)
      ? Math.max(0, progress.progressVersion)
      : 0,
    availability: "available",
    saveStatus: "idle",
    saveError: null,
  };
}

export function canSavePublicReadingProgress(state: PublicReadingProgressState): boolean {
  return state.availability === "available" && Boolean(state.chapterId);
}

export function publicReadingProgressReducer(
  state: PublicReadingProgressState,
  action: PublicReadingProgressAction,
): PublicReadingProgressState {
  switch (action.type) {
    case "reset":
      return createPublicReadingProgressState(action.storyId);
    case "detail_loaded":
      return restorePublicReadingProgress(action.detail);
    case "position_changed":
      if (state.availability !== "available") return state;
      return {
        ...state,
        chapterId: action.chapterId,
        scrollProgress: clampProgress(action.scrollProgress),
        saveStatus: "idle",
        saveError: null,
      };
    case "save_started":
      return canSavePublicReadingProgress(state)
        ? { ...state, saveStatus: "saving", saveError: null }
        : state;
    case "save_succeeded":
      if (state.availability !== "available") return state;
      return {
        ...state,
        progressVersion: Math.max(0, action.progress.progressVersion),
        saveStatus: "saved",
        saveError: null,
      };
    case "server_progress_received":
      if (state.availability !== "available") return state;
      return action.progress
        ? {
            ...state,
            chapterId: action.progress.chapterId,
            scrollProgress: clampProgress(action.progress.scrollProgress),
            progressVersion: Math.max(0, action.progress.progressVersion),
            saveStatus: "conflict",
            saveError: null,
          }
        : {
            ...state,
            progressVersion: 0,
            saveStatus: "conflict",
            saveError: null,
          };
    case "save_failed":
      if (state.availability !== "available") return state;
      return { ...state, saveStatus: "error", saveError: action.message };
    case "story_unavailable":
      return {
        ...state,
        availability: "unavailable",
        saveStatus: "idle",
        saveError: null,
      };
  }
}

function validProgress(value: unknown): value is PublicReadingProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.storyId === "string"
    && candidate.storyId.length > 0
    && typeof candidate.chapterId === "string"
    && candidate.chapterId.length > 0
    && Number.isInteger(candidate.chapterNumber)
    && (candidate.chapterNumber as number) > 0
    && typeof candidate.scrollProgress === "number"
    && Number.isFinite(candidate.scrollProgress)
    && candidate.scrollProgress >= 0
    && candidate.scrollProgress <= 1
    && Number.isInteger(candidate.progressVersion)
    && (candidate.progressVersion as number) > 0
    && typeof candidate.updatedAt === "string";
}

export function progressFromConflictDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): PublicReadingProgress | null | undefined {
  if (!details || !("latestProgress" in details)) return undefined;
  if (details.latestProgress === null) return null;
  return validProgress(details.latestProgress) ? details.latestProgress : undefined;
}

const defaultClock: PublicProgressClock = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export function createPublicProgressDebouncer<Value>(
  callback: (value: Value) => void,
  options: {
    delayMs?: number;
    clock?: PublicProgressClock;
  } = {},
): PublicProgressDebouncer<Value> {
  const clock = options.clock ?? defaultClock;
  const delayMs = Math.max(0, options.delayMs ?? PUBLIC_READING_PROGRESS_DEBOUNCE_MS);
  let timer: unknown | null = null;
  let stopped = false;

  const cancel = () => {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  };

  return {
    schedule(value) {
      if (stopped) return;
      cancel();
      timer = clock.setTimeout(() => {
        timer = null;
        if (!stopped) callback(value);
      }, delayMs);
    },
    cancel,
    stop() {
      stopped = true;
      cancel();
    },
    resume() {
      stopped = false;
    },
    hasPending() {
      return timer !== null;
    },
    isStopped() {
      return stopped;
    },
  };
}
