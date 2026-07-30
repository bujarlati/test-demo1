import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PUBLIC_READING_PROGRESS_DEBOUNCE_MS,
  canSavePublicReadingProgress,
  createPublicProgressDebouncer,
  createPublicReadingProgressState,
  progressFromConflictDetails,
  publicReadingProgressReducer,
  restorePublicReadingProgress,
} from "../src/publicReadingProgress";
import {
  loadReaderSettings,
  saveReaderSettings,
  type ReaderSettingsStorage,
} from "../src/readerSettings";
import type { PublicReadingProgress, PublicStoryDetail } from "../src/types";

function progress(overrides: Partial<PublicReadingProgress> = {}): PublicReadingProgress {
  return {
    storyId: "story-public",
    chapterId: "chapter-2",
    chapterNumber: 2,
    scrollProgress: 0.42,
    progressVersion: 3,
    updatedAt: "2026-07-29T08:00:00.000Z",
    ...overrides,
  };
}

function detail(readingProgress: PublicReadingProgress | null = progress()): PublicStoryDetail {
  return {
    id: "story-public",
    title: "星海来信",
    subtitle: "写给远方的一封信",
    genre: "科幻",
    tone: "理性 · 冷静",
    length: "标准长篇",
    coverTheme: "moon",
    status: "active",
    authorPenName: "青砚",
    chapterCount: 2,
    currentChapterNumber: 2,
    currentChapterTitle: "回声",
    latestExcerpt: "星光穿过旧舷窗。",
    updatedAt: "2026-07-29T08:00:00.000Z",
    viewerIsOwner: false,
    readingProgress,
    chapters: [
      {
        id: "chapter-1",
        number: 1,
        title: "启航",
        estimatedMinutes: 8,
        currentRevision: {
          id: "revision-1",
          title: "启航",
          paragraphs: ["第一章正文。"],
          createdAt: "2026-07-29T07:00:00.000Z",
        },
      },
      {
        id: "chapter-2",
        number: 2,
        title: "回声",
        estimatedMinutes: 9,
        currentRevision: {
          id: "revision-2",
          title: "回声",
          paragraphs: ["第二章正文。"],
          createdAt: "2026-07-29T08:00:00.000Z",
        },
      },
    ],
  };
}

class FakeClock {
  private now = 0;
  private nextId = 1;
  private tasks = new Map<number, { dueAt: number; callback: () => void }>();
  clearCalls = 0;

  readonly adapter = {
    setTimeout: (callback: () => void, delay: number): unknown => {
      const id = this.nextId++;
      this.tasks.set(id, { dueAt: this.now + delay, callback });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      this.clearCalls += 1;
      this.tasks.delete(handle as number);
    },
  };

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      this.now = next[1].dueAt;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

test("public detail restores its independent chapter, scroll position, and version", () => {
  const restored = restorePublicReadingProgress(detail());
  assert.equal(restored.storyId, "story-public");
  assert.equal(restored.chapterId, "chapter-2");
  assert.equal(restored.scrollProgress, 0.42);
  assert.equal(restored.progressVersion, 3);
  assert.equal(restored.availability, "available");

  const firstVisit = restorePublicReadingProgress(detail(null));
  assert.equal(firstVisit.chapterId, "chapter-1");
  assert.equal(firstVisit.scrollProgress, 0);
  assert.equal(firstVisit.progressVersion, 0);

  const replacedChapter = restorePublicReadingProgress(detail(progress({ chapterId: "removed" })));
  assert.equal(replacedChapter.chapterId, "chapter-2");
  assert.equal(replacedChapter.scrollProgress, 0);
});

test("progress saves wait 900ms and retain only the latest pending position", () => {
  const clock = new FakeClock();
  const saved: Array<{ chapterId: string; scrollProgress: number }> = [];
  const debouncer = createPublicProgressDebouncer((value) => saved.push(value), {
    clock: clock.adapter,
  });

  debouncer.schedule({ chapterId: "chapter-1", scrollProgress: 0.1 });
  clock.advance(500);
  debouncer.schedule({ chapterId: "chapter-1", scrollProgress: 0.6 });
  clock.advance(PUBLIC_READING_PROGRESS_DEBOUNCE_MS - 1);
  assert.deepEqual(saved, []);
  clock.advance(1);
  assert.deepEqual(saved, [{ chapterId: "chapter-1", scrollProgress: 0.6 }]);
});

test("successful saves advance the version without rolling back newer local scrolling", () => {
  let state = restorePublicReadingProgress(detail());
  state = publicReadingProgressReducer(state, {
    type: "position_changed",
    chapterId: "chapter-2",
    scrollProgress: 0.88,
  });
  state = publicReadingProgressReducer(state, { type: "save_started" });
  state = publicReadingProgressReducer(state, {
    type: "save_succeeded",
    progress: progress({ scrollProgress: 0.6, progressVersion: 4 }),
  });

  assert.equal(state.progressVersion, 4);
  assert.equal(state.scrollProgress, 0.88);
  assert.equal(state.saveStatus, "saved");
});

test("a 409 conflict adopts and validates the server's latest progress", () => {
  const latest = progress({ chapterId: "chapter-1", chapterNumber: 1, scrollProgress: 0.73, progressVersion: 8 });
  assert.deepEqual(progressFromConflictDetails({ latestProgress: latest }), latest);
  assert.equal(progressFromConflictDetails({ latestProgress: { ...latest, scrollProgress: 2 } }), undefined);

  const state = publicReadingProgressReducer(restorePublicReadingProgress(detail()), {
    type: "server_progress_received",
    progress: latest,
  });
  assert.equal(state.chapterId, "chapter-1");
  assert.equal(state.scrollProgress, 0.73);
  assert.equal(state.progressVersion, 8);
  assert.equal(state.saveStatus, "conflict");
});

test("a 404 keeps loaded text state but stops all later progress saves", () => {
  const clock = new FakeClock();
  const saved: unknown[] = [];
  const debouncer = createPublicProgressDebouncer((value) => saved.push(value), {
    clock: clock.adapter,
  });
  debouncer.schedule({ chapterId: "chapter-2", scrollProgress: 0.5 });
  debouncer.stop();
  debouncer.schedule({ chapterId: "chapter-2", scrollProgress: 0.9 });
  clock.advance(PUBLIC_READING_PROGRESS_DEBOUNCE_MS * 2);

  const before = restorePublicReadingProgress(detail());
  const unavailable = publicReadingProgressReducer(before, { type: "story_unavailable" });
  assert.equal(unavailable.chapterId, before.chapterId);
  assert.equal(unavailable.availability, "unavailable");
  assert.equal(canSavePublicReadingProgress(unavailable), false);
  assert.deepEqual(saved, []);
});

test("unmount cancellation clears a pending timer without permanently stopping later instances", () => {
  const clock = new FakeClock();
  const saved: unknown[] = [];
  const debouncer = createPublicProgressDebouncer((value) => saved.push(value), {
    clock: clock.adapter,
  });
  debouncer.schedule({ chapterId: "chapter-1", scrollProgress: 0.2 });
  assert.equal(debouncer.hasPending(), true);
  debouncer.cancel();
  assert.equal(debouncer.hasPending(), false);
  assert.equal(clock.clearCalls, 1);
  clock.advance(PUBLIC_READING_PROGRESS_DEBOUNCE_MS);
  assert.deepEqual(saved, []);

  debouncer.schedule({ chapterId: "chapter-1", scrollProgress: 0.4 });
  clock.advance(PUBLIC_READING_PROGRESS_DEBOUNCE_MS);
  assert.deepEqual(saved, [{ chapterId: "chapter-1", scrollProgress: 0.4 }]);
});

test("an empty progress state is inert until a detail response arrives", () => {
  const state = createPublicReadingProgressState("story-public");
  assert.equal(state.chapterId, null);
  assert.equal(state.availability, "loading");
  assert.equal(canSavePublicReadingProgress(state), false);
});

test("shared reader settings persist display preferences without author generation controls", () => {
  const values = new Map<string, string>([[
    "xumo-reader-settings",
    JSON.stringify({ theme: "night", fontSize: 99, lineHeight: 1.8, width: 777, chapterLength: "immersive" }),
  ]]);
  const storage: ReaderSettingsStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  const loaded = loadReaderSettings(storage);
  assert.deepEqual(loaded, { theme: "night", fontSize: 26, lineHeight: 1.8, width: 780 });

  saveReaderSettings(loaded, storage);
  const persisted = JSON.parse(values.get("xumo-reader-settings") ?? "{}") as Record<string, unknown>;
  assert.equal(persisted.chapterLength, undefined);
  assert.deepEqual(Object.keys(persisted).sort(), ["fontSize", "lineHeight", "theme", "width"]);
});

test("the public reader source has no path to author write capabilities or HTML injection", () => {
  const source = readFileSync(new URL("../src/pages/PublicReaderPage.tsx", import.meta.url), "utf8");
  const apiMethods = [...source.matchAll(/\bapi\.([A-Za-z][A-Za-z0-9]*)/g)]
    .map((match) => match[1])
    .filter((method, index, methods) => methods.indexOf(method) === index)
    .sort();
  assert.deepEqual(apiMethods, [
    "publicStory",
    "reportPublicStory",
    "savePublicStoryProgress",
  ]);
  for (const forbidden of [
    "dangerouslySetInnerHTML",
    "generateChapter",
    "sendMessage",
    "toggleProtection",
    "rollbackRetcon",
    "StoryPublicationActions",
  ]) {
    assert.equal(source.includes(forbidden), false, `public reader must not contain ${forbidden}`);
  }
});
