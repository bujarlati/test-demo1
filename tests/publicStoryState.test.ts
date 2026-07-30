import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicStoryListState,
  parsePublicStoryGenre,
  publicStoryCollectionUrl,
  publicStoryListReducer,
} from "../src/publicStoryState";
import type { PublicStorySummary } from "../src/types";

function story(id: string, title = id): PublicStorySummary {
  return {
    id,
    title,
    subtitle: `${title}副标题`,
    genre: "科幻",
    tone: "理性 · 冷静",
    length: "标准长篇",
    coverTheme: "moon",
    status: "active",
    authorPenName: "青砚",
    chapterCount: 3,
    currentChapterNumber: 3,
    currentChapterTitle: "第三章",
    latestExcerpt: "故事仍在继续。",
    updatedAt: "2026-07-29T08:00:00.000Z",
  };
}

test("public story collection URLs safely encode search, genre, cursor, and page size", () => {
  const url = new URL(publicStoryCollectionUrl({
    query: "  山海 & 月?  ",
    genre: "科幻",
    cursor: "2026-07-29T08:00:00.000Z/story + / =",
    limit: 24,
  }), "https://xumo.test");

  assert.equal(url.pathname, "/api/public-stories");
  assert.equal(url.searchParams.get("query"), "山海 & 月?");
  assert.equal(url.searchParams.get("genre"), "科幻");
  assert.equal(url.searchParams.get("cursor"), "2026-07-29T08:00:00.000Z/story + / =");
  assert.equal(url.searchParams.get("limit"), "24");
});

test("only configured story genres are accepted from URL state", () => {
  assert.equal(parsePublicStoryGenre("科幻"), "科幻");
  assert.equal(parsePublicStoryGenre("无限流"), "无限流");
  assert.equal(parsePublicStoryGenre("不存在的题材"), null);
  assert.equal(parsePublicStoryGenre(null), null);
});

test("changing search or genre clears the old page and opaque cursor", () => {
  let state = createPublicStoryListState({ query: "星河", genre: null });
  state = publicStoryListReducer(state, { type: "request_started", requestId: 1, append: false });
  state = publicStoryListReducer(state, {
    type: "request_succeeded",
    requestId: 1,
    append: false,
    page: { stories: [story("story-1")], nextCursor: "opaque-next-page" },
  });

  const searched = publicStoryListReducer(state, {
    type: "filters_changed",
    filters: { query: "月海", genre: null },
  });
  assert.deepEqual(searched.stories, []);
  assert.equal(searched.nextCursor, null);
  assert.equal(searched.hasLoaded, false);

  const filtered = publicStoryListReducer(state, {
    type: "filters_changed",
    filters: { query: "星河", genre: "科幻" },
  });
  assert.deepEqual(filtered.stories, []);
  assert.equal(filtered.nextCursor, null);
  assert.equal(filtered.hasLoaded, false);
});

test("loading another page appends unique stories in server order", () => {
  let state = createPublicStoryListState();
  state = publicStoryListReducer(state, { type: "request_started", requestId: 1, append: false });
  state = publicStoryListReducer(state, {
    type: "request_succeeded",
    requestId: 1,
    append: false,
    page: { stories: [story("story-1", "第一页")], nextCursor: "next" },
  });
  state = publicStoryListReducer(state, { type: "request_started", requestId: 2, append: true });
  state = publicStoryListReducer(state, {
    type: "request_succeeded",
    requestId: 2,
    append: true,
    page: {
      stories: [story("story-1", "重复项"), story("story-2", "第二页")],
      nextCursor: null,
    },
  });

  assert.deepEqual(state.stories.map((item) => item.id), ["story-1", "story-2"]);
  assert.equal(state.stories[0]?.title, "第一页");
  assert.equal(state.nextCursor, null);
});

test("late responses are discarded after a newer request or filter change", () => {
  let state = createPublicStoryListState();
  state = publicStoryListReducer(state, { type: "request_started", requestId: 1, append: false });
  state = publicStoryListReducer(state, {
    type: "filters_changed",
    filters: { query: "新条件", genre: null },
  });
  state = publicStoryListReducer(state, { type: "request_started", requestId: 2, append: false });

  const afterLateResponse = publicStoryListReducer(state, {
    type: "request_succeeded",
    requestId: 1,
    append: false,
    page: { stories: [story("stale")], nextCursor: "stale-cursor" },
  });
  assert.equal(afterLateResponse, state);

  const current = publicStoryListReducer(afterLateResponse, {
    type: "request_succeeded",
    requestId: 2,
    append: false,
    page: { stories: [story("current")], nextCursor: null },
  });
  assert.deepEqual(current.stories.map((item) => item.id), ["current"]);
});

test("retrying an initial request returns the list to a real loading state", () => {
  let state = createPublicStoryListState();
  state = publicStoryListReducer(state, { type: "request_started", requestId: 1, append: false });
  state = publicStoryListReducer(state, { type: "request_failed", requestId: 1, message: "暂时失败" });
  assert.equal(state.hasLoaded, true);

  state = publicStoryListReducer(state, { type: "request_started", requestId: 2, append: false });
  assert.equal(state.loading, "initial");
  assert.equal(state.hasLoaded, false);
  assert.equal(state.error, null);
});

test("a story that has just become unavailable is removed without losing the list", () => {
  let state = createPublicStoryListState();
  state = publicStoryListReducer(state, { type: "request_started", requestId: 1, append: false });
  state = publicStoryListReducer(state, {
    type: "request_succeeded",
    requestId: 1,
    append: false,
    page: { stories: [story("available"), story("unpublished")], nextCursor: null },
  });
  state = publicStoryListReducer(state, { type: "story_unavailable", storyId: "unpublished" });

  assert.deepEqual(state.stories.map((item) => item.id), ["available"]);
  assert.equal(state.unavailableStoryRemoved, true);
  assert.equal(state.hasLoaded, true);

  const returnedFromReader = publicStoryListReducer(createPublicStoryListState(), {
    type: "story_unavailable",
    storyId: "already-absent",
  });
  assert.equal(returnedFromReader.unavailableStoryRemoved, true);
});
