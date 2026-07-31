import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ApiError } from "../src/api";
import { refreshStoryDeletionBootstrapBestEffort } from "../src/storyDeletion";
import type { BootstrapPayload, GenerationJob, StorySummary } from "../src/types";
import { reconcileStoryDeletionState } from "../src/storyDeletionState";

function story(id: string, chapterCount: number): StorySummary {
  return {
    id,
    title: `故事 ${id}`,
    subtitle: "副标题",
    genre: "科幻",
    tone: "理性 · 冷静",
    length: "标准长篇",
    targetChapterCount: 12,
    coverTheme: "moon",
    status: "active",
    canonVersion: 3,
    latestExcerpt: "仍在继续。",
    updatedAt: "2026-07-31T00:00:00.000Z",
    unreadCanonChanges: 0,
    currentChapterNumber: chapterCount,
    currentChapterTitle: `第 ${chapterCount} 章`,
    chapterCount,
    progress: 0.25,
  };
}

function job(id: string, storyId: string): GenerationJob {
  return {
    id,
    ownerId: "user_owner",
    storyId,
    storyTitle: `故事 ${storyId}`,
    chapterNumber: 2,
    task: "chapter",
    model: "writer-test",
    connectionId: "connection_test",
    promptVersion: "test-v1",
    status: "completed",
    tokens: 200,
    latencyMs: 1_000,
    cost: 0.01,
    createdAt: "2026-07-31T00:00:00.000Z",
  };
}

function bootstrap(): BootstrapPayload {
  return {
    user: {
      id: "user_owner",
      email: "owner@example.test",
      name: "作者",
      initials: "作",
      role: "reader",
      activeStoryId: "story_delete",
      defaultConnectionId: "connection_test",
      publicPenName: "墨客",
    },
    features: { publicStorySharing: true },
    stories: [story("story_keep", 4), story("story_delete", 3)],
    storyPage: {
      nextCursor: "opaque-cursor",
      totalStories: 8,
      totalChapters: 27,
    },
    modelConnections: [],
    activeStoryId: "story_delete",
    pendingJobs: [job("job_delete", "story_delete"), job("job_keep", "story_keep")],
    recoverableJobs: [job("recovery_delete", "story_delete"), job("recovery_keep", "story_keep")],
  };
}

test("a successful post-deletion bootstrap returns authoritative shelf data", async () => {
  const payload = bootstrap();

  assert.deepEqual(
    await refreshStoryDeletionBootstrapBestEffort(async () => payload),
    { kind: "refreshed", payload },
  );
});

test("a post-deletion bootstrap 401 is reported as normal authentication expiry", async () => {
  assert.deepEqual(
    await refreshStoryDeletionBootstrapBestEffort(async () => {
      throw new ApiError("登录已过期", 401, "authentication_required");
    }),
    { kind: "authentication_required" },
  );
});

test("post-deletion bootstrap failures other than 401 are absorbed", async () => {
  const failures = [
    new ApiError("服务暂不可用", 503, "service_unavailable"),
    new TypeError("fetch failed"),
    new Error("unexpected bootstrap failure"),
  ];

  for (const failure of failures) {
    assert.deepEqual(
      await refreshStoryDeletionBootstrapBestEffort(async () => {
        throw failure;
      }),
      { kind: "unavailable" },
    );
  }
});

test("shelf reconciliation removes a loaded story and clears all local references", () => {
  const current = bootstrap();
  const next = reconcileStoryDeletionState(current, {
    storyId: "story_delete",
    chapterCount: 3,
    countedInShelf: true,
  });

  assert.ok(next);
  assert.deepEqual(next.stories.map((item) => item.id), ["story_keep"]);
  assert.equal(next.activeStoryId, null);
  assert.equal(next.user.activeStoryId, null);
  assert.deepEqual(next.pendingJobs.map((item) => item.id), ["job_keep"]);
  assert.deepEqual(next.recoverableJobs.map((item) => item.id), ["recovery_keep"]);
  assert.deepEqual(next.storyPage, {
    nextCursor: "opaque-cursor",
    totalStories: 7,
    totalChapters: 24,
  });
  assert.equal(next.features, current.features);
  assert.equal(next.modelConnections, current.modelConnections);
  assert.equal(next.stories[0], current.stories[0]);
});

test("an unloaded shelf story still decrements totals using the confirmed server story", () => {
  const current = bootstrap();
  current.activeStoryId = "story_keep";
  current.user.activeStoryId = "story_keep";
  current.stories = current.stories.filter((item) => item.id !== "story_delete");

  const next = reconcileStoryDeletionState(current, {
    storyId: "story_delete",
    chapterCount: 9,
    countedInShelf: true,
  });

  assert.ok(next);
  assert.equal(next.stories, current.stories);
  assert.equal(next.activeStoryId, "story_keep");
  assert.equal(next.user, current.user);
  assert.equal(next.storyPage.totalStories, 7);
  assert.equal(next.storyPage.totalChapters, 18);
});

test("an archived story is removed locally without changing non-archived shelf totals", () => {
  const current = bootstrap();
  const next = reconcileStoryDeletionState(current, {
    storyId: "story_delete",
    chapterCount: 3,
    countedInShelf: false,
  });

  assert.ok(next);
  assert.deepEqual(next.stories.map((item) => item.id), ["story_keep"]);
  assert.equal(next.storyPage, current.storyPage);
  assert.equal(next.storyPage.totalStories, 8);
  assert.equal(next.storyPage.totalChapters, 27);
});

test("shelf totals are clamped and null bootstrap state stays null", () => {
  const current = bootstrap();
  current.storyPage = { nextCursor: null, totalStories: 0, totalChapters: 2 };
  const next = reconcileStoryDeletionState(current, {
    storyId: "story_delete",
    chapterCount: 30,
    countedInShelf: true,
  });

  assert.ok(next);
  assert.equal(next.storyPage.totalStories, 0);
  assert.equal(next.storyPage.totalChapters, 0);
  assert.equal(reconcileStoryDeletionState(null, {
    storyId: "story_delete",
    chapterCount: 3,
    countedInShelf: true,
  }), null);
});

test("the permanent-deletion entry is exclusive to ArchivePage", async () => {
  const archiveSource = await readFile(new URL("../src/pages/ArchivePage.tsx", import.meta.url), "utf8");
  const forbiddenSources = await Promise.all([
    "../src/pages/LibraryPage.tsx",
    "../src/pages/ReaderPage.tsx",
    "../src/pages/PublicReaderPage.tsx",
    "../src/components/PublicStoryCard.tsx",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

  assert.match(archiveSource, /<StoryDeletionDialog\b/);
  assert.match(archiveSource, /className="story-danger-zone"/);
  assert.ok(
    archiveSource.indexOf('className="story-danger-zone"') > archiveSource.indexOf('className="archive-layout"'),
    "the danger zone must follow the archive layout",
  );
  for (const source of forbiddenSources) {
    assert.doesNotMatch(source, /StoryDeletionDialog|story-danger-zone|永久删除故事/);
  }
});

test("successful deletion keeps immediate feedback and starts an authoritative refresh afterward", async () => {
  const archiveSource = await readFile(
    new URL("../src/pages/ArchivePage.tsx", import.meta.url),
    "utf8",
  );
  const contextSource = await readFile(
    new URL("../src/context/AppContext.tsx", import.meta.url),
    "utf8",
  );
  const reconcileAt = archiveSource.indexOf("reconcileStoryDeletion({");
  const navigateAt = archiveSource.indexOf('navigate("/", { replace: true });', reconcileAt);
  const toastAt = archiveSource.indexOf('toast("故事已永久删除。");', navigateAt);
  const refreshAt = archiveSource.indexOf("void refreshAfterStoryDeletion();", toastAt);

  assert.ok(reconcileAt >= 0, "successful deletion should reconcile the optimistic shelf state");
  assert.ok(navigateAt > reconcileAt, "navigation should follow optimistic reconciliation");
  assert.ok(toastAt > navigateAt, "the success toast should follow navigation");
  assert.ok(refreshAt > toastAt, "the best-effort authoritative refresh should run after feedback");
  assert.match(contextSource, /refreshAfterStoryDeletion: \(\) => Promise<void>/);
  assert.match(contextSource, /refreshStoryDeletionBootstrapBestEffort\(api\.bootstrap\)/);
  assert.match(contextSource, /if \(result\.kind === "refreshed"\)[\s\S]*setData\(result\.payload\);[\s\S]*setError\(null\);[\s\S]*setAuthRequired\(false\);/);
  assert.match(contextSource, /if \(result\.kind === "authentication_required"\)[\s\S]*authStore\.clear\(\);[\s\S]*setData\(null\);[\s\S]*setAuthRequired\(true\);[\s\S]*setError\(null\);/);
});

test("the owned-story probe route disables caching before both success and not-found lookup paths", async () => {
  const source = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
  const routeAt = source.indexOf('app.get("/api/stories/:storyId/state"');
  const headerAt = source.indexOf(
    'response.setHeader("Cache-Control", "private, no-store");',
    routeAt,
  );
  const lookupAt = source.indexOf("const story = storyOrThrow", routeAt);

  assert.ok(routeAt >= 0, "the owned-story state route should exist");
  assert.ok(headerAt > routeAt, "the route should set a private no-store response header");
  assert.ok(lookupAt > headerAt, "the no-store header must be set before lookup can return 404");
});

test("the deletion dialog retains the accessible busy and error contract", async () => {
  const source = await readFile(
    new URL("../src/components/StoryDeletionDialog.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /readOnly=\{busy\}/);
  assert.match(source, /aria-errormessage=\{error \? ERROR_ID : undefined\}/);
  assert.match(source, /role="status"/);
  assert.match(source, /if \(elements\.length === 0\)/);
  assert.match(source, /previousFocus\?\.isConnected/);
  assert.match(source, /onSubmit=\{submit\}/);
});
