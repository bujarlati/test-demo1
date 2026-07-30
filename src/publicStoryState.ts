import { STORY_GENRES, type StoryGenre } from "./storyConfig";
import type { PublicStoryPage, PublicStoryQuery, PublicStorySummary } from "./types";

export const PUBLIC_STORY_PAGE_SIZE = 24;

export interface PublicStoryFilters {
  query: string;
  genre: StoryGenre | null;
}

export interface PublicStoryListState {
  filters: PublicStoryFilters;
  stories: PublicStorySummary[];
  nextCursor: string | null;
  loading: "idle" | "initial" | "more";
  hasLoaded: boolean;
  error: string | null;
  activeRequestId: number | null;
  unavailableStoryRemoved: boolean;
}

export type PublicStoryListAction =
  | { type: "filters_changed"; filters: PublicStoryFilters }
  | { type: "request_started"; requestId: number; append: boolean }
  | { type: "request_succeeded"; requestId: number; append: boolean; page: PublicStoryPage }
  | { type: "request_failed"; requestId: number; message: string }
  | { type: "story_unavailable"; storyId: string }
  | { type: "unavailable_notice_dismissed" };

const publicStoryGenres = new Set<string>(STORY_GENRES.map((option) => option.label));

export function parsePublicStoryGenre(value: string | null | undefined): StoryGenre | null {
  return value && publicStoryGenres.has(value) ? value as StoryGenre : null;
}

export function normalizePublicStoryFilters(filters: Partial<PublicStoryFilters> = {}): PublicStoryFilters {
  return {
    query: filters.query?.trim() ?? "",
    genre: parsePublicStoryGenre(filters.genre),
  };
}

export function publicStoryCollectionUrl(query: PublicStoryQuery = {}): string {
  const parameters = new URLSearchParams();
  const normalizedQuery = query.query?.trim();
  if (normalizedQuery) parameters.set("query", normalizedQuery);
  if (query.genre !== undefined) parameters.set("genre", query.genre);
  if (query.cursor !== undefined) parameters.set("cursor", query.cursor);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  const suffix = parameters.toString();
  return suffix ? `/api/public-stories?${suffix}` : "/api/public-stories";
}

export function createPublicStoryListState(
  filters: Partial<PublicStoryFilters> = {},
): PublicStoryListState {
  return {
    filters: normalizePublicStoryFilters(filters),
    stories: [],
    nextCursor: null,
    loading: "idle",
    hasLoaded: false,
    error: null,
    activeRequestId: null,
    unavailableStoryRemoved: false,
  };
}

function sameFilters(left: PublicStoryFilters, right: PublicStoryFilters): boolean {
  return left.query === right.query && left.genre === right.genre;
}

function appendUniqueStories(
  existing: PublicStorySummary[],
  incoming: PublicStorySummary[],
): PublicStorySummary[] {
  const seen = new Set(existing.map((story) => story.id));
  return [
    ...existing,
    ...incoming.filter((story) => {
      if (seen.has(story.id)) return false;
      seen.add(story.id);
      return true;
    }),
  ];
}

export function publicStoryListReducer(
  state: PublicStoryListState,
  action: PublicStoryListAction,
): PublicStoryListState {
  switch (action.type) {
    case "filters_changed": {
      const filters = normalizePublicStoryFilters(action.filters);
      return sameFilters(state.filters, filters) ? state : createPublicStoryListState(filters);
    }
    case "request_started":
      return {
        ...state,
        loading: action.append ? "more" : "initial",
        hasLoaded: action.append ? state.hasLoaded : false,
        error: null,
        activeRequestId: action.requestId,
      };
    case "request_succeeded":
      if (state.activeRequestId !== action.requestId) return state;
      return {
        ...state,
        stories: action.append
          ? appendUniqueStories(state.stories, action.page.stories)
          : appendUniqueStories([], action.page.stories),
        nextCursor: action.page.nextCursor,
        loading: "idle",
        hasLoaded: true,
        error: null,
        activeRequestId: null,
      };
    case "request_failed":
      if (state.activeRequestId !== action.requestId) return state;
      return {
        ...state,
        loading: "idle",
        hasLoaded: true,
        error: action.message,
        activeRequestId: null,
      };
    case "story_unavailable": {
      const stories = state.stories.filter((story) => story.id !== action.storyId);
      return stories.length === state.stories.length && state.unavailableStoryRemoved
        ? state
        : { ...state, stories, unavailableStoryRemoved: true };
    }
    case "unavailable_notice_dismissed":
      return state.unavailableStoryRemoved
        ? { ...state, unavailableStoryRemoved: false }
        : state;
  }
}
