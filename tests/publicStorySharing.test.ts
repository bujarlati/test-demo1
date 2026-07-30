import assert from "node:assert/strict";
import test from "node:test";
import { createReaderAccount, publicUser } from "../server/auth";
import {
  PublicStorySharingError,
  assertPublicStorySharingPrerequisites,
  assertStoryPublishable,
  createProgressConflictError,
  createPublicStorySharingModule,
  createPublicStorySharingDisabledError,
  createPublicStoryUnavailableError,
  nextOwnerPublicationStatus,
  normalizePublicPenName,
  ownerPublicationState,
  publicStorySharePath,
  publicStorySharingEnabled,
  type PublicStorySharingPersistence,
} from "../server/publicStorySharing";
import { loadStore } from "../server/storage";
import type { PublicReadingProgress } from "../src/types";

function captureSharingError(work: () => unknown): PublicStorySharingError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof PublicStorySharingError);
    return error;
  }
  assert.fail("Expected a PublicStorySharingError.");
}

test("public pen names trim Unicode input and enforce a 2-20 code-point display value", () => {
  assert.equal(normalizePublicPenName("  青砚  "), "青砚");
  assert.equal(normalizePublicPenName("𠮷野"), "𠮷野");
  assert.equal(normalizePublicPenName("甲".repeat(20)), "甲".repeat(20));

  for (const invalid of ["", "   ", "甲", "甲".repeat(21), "青\n砚", "青\u0000砚", "青\u2028砚"]) {
    assert.equal(captureSharingError(() => normalizePublicPenName(invalid)).code, "invalid_public_pen_name");
  }

  assert.equal(normalizePublicPenName("同名作者"), normalizePublicPenName("同名作者"));
});

test("owner publication transitions are idempotent and suspended publications stay admin-controlled", () => {
  const cases = [
    ["private", false, "private"],
    ["private", true, "active"],
    ["active", true, "active"],
    ["active", false, "author_unpublished"],
    ["author_unpublished", false, "author_unpublished"],
    ["author_unpublished", true, "active"],
  ] as const;

  for (const [current, published, expected] of cases) {
    assert.equal(nextOwnerPublicationStatus(current, published), expected);
  }

  assert.equal(
    captureSharingError(() => nextOwnerPublicationStatus("admin_suspended", true)).code,
    "publication_suspended",
  );
  assert.equal(
    captureSharingError(() => nextOwnerPublicationStatus("admin_suspended", false)).code,
    "publication_suspended",
  );
});

test("share paths are stable for every owner-visible publication state", () => {
  assert.equal(publicStorySharePath("story_123"), "/public/story/story_123");
  assert.equal(publicStorySharePath("story/with space"), "/public/story/story%2Fwith%20space");

  for (const status of ["private", "active", "author_unpublished", "admin_suspended"] as const) {
    const state = ownerPublicationState("story_123", status, "2026-07-29T00:00:00.000Z", "2026-07-29T01:00:00.000Z");
    assert.equal(state.sharePath, "/public/story/story_123");
    assert.equal(state.published, status === "active");
    assert.equal(state.adminReason, null);
  }

  assert.equal(ownerPublicationState(
    "story_123",
    "admin_suspended",
    "2026-07-29T00:00:00.000Z",
    "2026-07-29T01:00:00.000Z",
    "等待管理员复核",
  ).adminReason, "等待管理员复核");
});

test("only stories with a successful chapter and a publishable lifecycle may be published", () => {
  for (const status of ["active", "paused", "completed"] as const) {
    assert.doesNotThrow(() => assertStoryPublishable({ status, chapterCount: 1 }));
  }
  assert.equal(
    captureSharingError(() => assertStoryPublishable({ status: "archived", chapterCount: 1 })).code,
    "story_not_publishable",
  );
  assert.equal(
    captureSharingError(() => assertStoryPublishable({ status: "active", chapterCount: 0 })).code,
    "story_not_publishable",
  );
});

test("public sharing is enabled only by an explicit true value and requires PostgreSQL", async () => {
  assert.equal(publicStorySharingEnabled({}), false);
  assert.equal(publicStorySharingEnabled({ PUBLIC_STORY_SHARING_ENABLED: "false" }), false);
  assert.equal(publicStorySharingEnabled({ PUBLIC_STORY_SHARING_ENABLED: "1" }), false);
  assert.equal(publicStorySharingEnabled({ PUBLIC_STORY_SHARING_ENABLED: " TRUE " }), true);
  assert.doesNotThrow(() => assertPublicStorySharingPrerequisites({ PUBLIC_STORY_SHARING_ENABLED: "false" }));
  assert.doesNotThrow(() => assertPublicStorySharingPrerequisites({
    PUBLIC_STORY_SHARING_ENABLED: "true",
    DATABASE_URL: "postgresql://xumo.invalid/example",
  }));

  const previousFlag = process.env.PUBLIC_STORY_SHARING_ENABLED;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  try {
    process.env.PUBLIC_STORY_SHARING_ENABLED = "true";
    delete process.env.DATABASE_URL;
    await assert.rejects(
      () => loadStore(),
      (error: unknown) => error instanceof PublicStorySharingError
        && error.code === "public_story_sharing_requires_postgresql",
    );
  } finally {
    if (previousFlag === undefined) delete process.env.PUBLIC_STORY_SHARING_ENABLED;
    else process.env.PUBLIC_STORY_SHARING_ENABLED = previousFlag;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test("new accounts start without a pen name and only their own profile exposes later changes", () => {
  const account = createReaderAccount("reader@example.com", "correct-horse-battery", "读者");
  assert.equal(account.publicPenName, null);
  assert.equal(publicUser({ ...account, publicPenName: "青砚" }).publicPenName, "青砚");
});

test("sharing failures expose stable structured reason codes without Express coupling", () => {
  const progress: PublicReadingProgress = {
    storyId: "story_123",
    chapterId: "chapter_1",
    chapterNumber: 1,
    scrollProgress: 0.5,
    progressVersion: 2,
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
  const errors = [
    captureSharingError(() => normalizePublicPenName("x")),
    captureSharingError(() => assertStoryPublishable({ status: "archived", chapterCount: 1 })),
    captureSharingError(() => nextOwnerPublicationStatus("admin_suspended", true)),
    createPublicStoryUnavailableError(),
    createProgressConflictError(progress),
    createPublicStorySharingDisabledError(),
  ];

  assert.deepEqual(errors.map((error) => error.code), [
    "invalid_public_pen_name",
    "story_not_publishable",
    "publication_suspended",
    "public_story_unavailable",
    "progress_conflict",
    "public_story_sharing_disabled",
  ]);
  assert.equal(errors.some((error) => "response" in error), false);
  assert.deepEqual(createProgressConflictError(progress).details, { latestProgress: progress });
});

test("the sharing module normalizes writes and converts missing public projections to one safe error", async () => {
  let submittedPenName: string | undefined;
  let profilePenName: string | undefined;
  const progress: PublicReadingProgress = {
    storyId: "story_123",
    chapterId: "chapter_1",
    chapterNumber: 1,
    scrollProgress: 0.5,
    progressVersion: 1,
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
  const persistence: PublicStorySharingPersistence = {
    getOwnerPublication: async (_ownerId, storyId) => ownerPublicationState(storyId, "private"),
    setOwnerPublication: async (_actor, storyId, input) => {
      submittedPenName = input.publicPenName;
      return ownerPublicationState(storyId, input.published ? "active" : "private");
    },
    updatePublicProfile: async (_userId, publicPenName) => {
      profilePenName = publicPenName;
      return { publicPenName };
    },
    list: async () => ({ stories: [], nextCursor: null }),
    read: async () => null,
    saveProgress: async () => progress,
    findReportTarget: async () => null,
    moderate: async (_adminUserId, storyId) => ({
      storyId,
      title: "测试故事",
      authorPenName: "青砚",
      status: "active",
      firstPublishedAt: "2026-07-29T00:00:00.000Z",
      statusUpdatedAt: "2026-07-29T00:00:00.000Z",
      adminReason: null,
    }),
    listModeration: async () => [],
    moderationOverview: async () => ({
      counts: {
        total: 0,
        active: 0,
        authorUnpublished: 0,
        adminSuspended: 0,
      },
      recent: [],
    }),
  };
  const sharing = createPublicStorySharingModule(persistence);
  const actor = {
    id: "user_123",
    role: "reader" as const,
    publicPenName: null,
  };

  await sharing.setOwnerPublication(actor, "story_123", {
    published: true,
    publicPenName: "  青砚  ",
  });
  assert.equal(submittedPenName, "青砚");
  await sharing.updatePublicProfile(actor.id, { publicPenName: "  新青砚  " });
  assert.equal(profilePenName, "新青砚");

  for (const work of [
    () => sharing.read(actor.id, "story_missing"),
    () => sharing.validateReportTarget(actor.id, "story_missing", "chapter_missing"),
  ]) {
    await assert.rejects(
      work,
      (error: unknown) => error instanceof PublicStorySharingError
        && error.code === "public_story_unavailable",
    );
  }
});
