import assert from "node:assert/strict";
import test from "node:test";
import { PostgresDatabase } from "../server/database/postgres";
import { createSeedStore } from "../server/seed";
import type { Story, UserAccount } from "../src/types";
import { PGlite, PGliteExecutor } from "./helpers/pglite";

const PRIVATE_INSPIRATION = "PRIVATE_INSPIRATION_SENTINEL";
const PRIVATE_PAYLOAD = "PRIVATE_PAYLOAD_SENTINEL";
const PRIVATE_HISTORY = "PRIVATE_HISTORY_PARAGRAPH_SENTINEL";
const PRIVATE_REASON = "PRIVATE_REVISION_REASON_SENTINEL";
const PRIVATE_MODEL = "PRIVATE_MODEL_NAME_SENTINEL";
const PRIVATE_PROMPT = "PRIVATE_PROMPT_VERSION_SENTINEL";

function storyWithChapters(stories: Story[]): Story {
  const story = stories.find((candidate) => candidate.chapters.length > 0);
  assert.ok(story, "seed should include a story with a successful chapter");
  return story;
}

function readerFor(users: UserAccount[], ownerId: string): UserAccount {
  const reader = users.find((candidate) => candidate.id !== ownerId);
  assert.ok(reader, "seed should include a second user");
  return reader;
}

test("004 migration keeps existing stories private and enforces publication/progress constraints", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    await database.migrate();

    const migrations = await pglite.query<{ version: string; checksum: string | null }>(
      "SELECT version, checksum FROM xumo_schema_migrations WHERE version = '004_public_story_sharing.sql'",
    );
    assert.equal(migrations.rows.length, 1);
    assert.ok(migrations.rows[0]?.checksum);

    const seed = createSeedStore();
    await database.saveSnapshot(seed);
    const story = storyWithChapters(seed.stories);
    const reader = readerFor(seed.users, story.ownerId);

    const existingUsers = await pglite.query<{ public_pen_name: string | null }>(
      "SELECT public_pen_name FROM xumo_users",
    );
    assert.ok(existingUsers.rows.every((row) => row.public_pen_name === null));
    assert.equal((await pglite.query("SELECT story_id FROM xumo_story_publications")).rows.length, 0);

    await assert.rejects(
      pglite.query(
        `INSERT INTO xumo_story_publications(
           story_id, owner_id, status, first_published_at, status_updated_at
         ) VALUES ($1, $2, 'active', now(), now())`,
        [story.id, reader.id],
      ),
    );
    await assert.rejects(
      pglite.query("UPDATE xumo_users SET public_pen_name = ' a ' WHERE id = $1", [story.ownerId]),
    );
    await assert.rejects(
      pglite.query(
        `INSERT INTO xumo_story_publications(
           story_id, owner_id, status, first_published_at, status_updated_at
         ) VALUES ($1, $2, 'invalid_status', now(), now())`,
        [story.id, story.ownerId],
      ),
    );
    await assert.rejects(
      pglite.query(
        `INSERT INTO xumo_story_publications(
           story_id, owner_id, status, first_published_at, status_updated_at, admin_reason
         ) VALUES ($1, $2, 'active', now(), now(), 'should not be present')`,
        [story.id, story.ownerId],
      ),
    );

    await pglite.query(
      `INSERT INTO xumo_story_publications(
         story_id, owner_id, status, first_published_at, status_updated_at
       ) VALUES ($1, $2, 'active', now(), now())`,
      [story.id, story.ownerId],
    );
    const chapter = story.chapters[0]!;
    const insertProgress = (scrollProgress: number, progressVersion: number) => pglite.query(
      `INSERT INTO xumo_public_reading_progress(
         reader_user_id, story_id, chapter_id, chapter_number, scroll_progress, progress_version, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [reader.id, story.id, chapter.id, chapter.number, scrollProgress, progressVersion],
    );
    await assert.rejects(insertProgress(1.01, 1));
    await assert.rejects(insertProgress(0.5, 0));
    await insertProgress(0.5, 1);

    await pglite.query("DELETE FROM xumo_users WHERE id = $1", [reader.id]);
    assert.equal((await pglite.query("SELECT story_id FROM xumo_public_reading_progress")).rows.length, 0);
    await pglite.query("DELETE FROM xumo_stories WHERE id = $1", [story.id]);
    assert.equal((await pglite.query("SELECT story_id FROM xumo_story_publications")).rows.length, 0);
  } finally {
    await database.close();
  }
});

test("public repository lists and reads only safe current-canon fields", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    const seed = createSeedStore();
    const publicStories = seed.stories.filter((story) => story.chapters.length > 0).slice(0, 3);
    assert.equal(publicStories.length, 3);
    const author = seed.users.find((user) => user.id === publicStories[0]!.ownerId);
    assert.ok(author);
    author.publicPenName = "青砚阁";
    publicStories.forEach((story, index) => {
      story.updatedAt = `2026-07-${String(20 + index).padStart(2, "0")}T12:00:00.000Z`;
    });
    publicStories[2]!.title = "百分之百 % 好故事";
    await database.saveSnapshot(seed);

    assert.equal((await database.findUserByEmail(author.email))?.publicPenName, "青砚阁");
    for (const story of publicStories) {
      await pglite.query(
        `INSERT INTO xumo_story_publications(
           story_id, owner_id, status, first_published_at, status_updated_at
         ) VALUES ($1, $2, 'active', now(), now())`,
        [story.id, story.ownerId],
      );
    }

    const target = publicStories[0]!;
    const targetChapter = target.chapters[0]!;
    const currentRevision = targetChapter.revisions.find(
      (revision) => revision.id === targetChapter.currentRevisionId,
    );
    assert.ok(currentRevision);
    await pglite.query(
      "UPDATE xumo_stories SET payload = payload || $2::jsonb WHERE id = $1",
      [target.id, JSON.stringify({ inspiration: PRIVATE_INSPIRATION, privateValue: PRIVATE_PAYLOAD })],
    );
    await pglite.query(
      `UPDATE xumo_chapter_revisions
       SET reason = $2, model_name = $3, prompt_version = $4
       WHERE id = $1`,
      [currentRevision.id, PRIVATE_REASON, PRIVATE_MODEL, PRIVATE_PROMPT],
    );
    await pglite.query(
      `INSERT INTO xumo_chapter_revisions(
         id, story_id, chapter_id, parent_revision_id, title, paragraphs, reason,
         model_name, prompt_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
      [
        "revision_private_history",
        target.id,
        targetChapter.id,
        currentRevision.id,
        "未公开历史稿",
        JSON.stringify([PRIVATE_HISTORY]),
        PRIVATE_REASON,
        PRIVATE_MODEL,
        PRIVATE_PROMPT,
        "2026-07-29T12:00:00.000Z",
      ],
    );

    const firstPage = await database.publicStories.list({ limit: 1 });
    assert.equal(firstPage.stories.length, 1);
    assert.equal(firstPage.stories[0]?.id, publicStories[2]!.id);
    assert.ok(firstPage.nextCursor);
    const secondPage = await database.publicStories.list({ limit: 1, cursor: firstPage.nextCursor! });
    assert.equal(secondPage.stories.length, 1);
    assert.notEqual(secondPage.stories[0]?.id, firstPage.stories[0]?.id);

    const literalPercent = await database.publicStories.list({ query: "%" });
    assert.deepEqual(literalPercent.stories.map((story) => story.id), [publicStories[2]!.id]);
    assert.equal((await database.publicStories.list({ query: "_" })).stories.length, 0);
    assert.equal((await database.publicStories.list({ query: "青砚" })).stories.length, 3);
    const genrePage = await database.publicStories.list({ genre: target.genre });
    assert.ok(genrePage.stories.length > 0);
    assert.ok(genrePage.stories.every((story) => story.genre === target.genre));

    await assert.rejects(
      database.publicStories.list({ query: "changed filter", cursor: firstPage.nextCursor! }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_public_story_cursor");
        assert.equal((error as { status?: number }).status, 400);
        return true;
      },
    );
    await assert.rejects(
      database.publicStories.list({ cursor: "not-a-valid-cursor" }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_public_story_cursor");
        return true;
      },
    );

    const reader = readerFor(seed.users, target.ownerId);
    const detail = await database.publicStories.read(reader.id, target.id);
    assert.ok(detail);
    assert.equal(detail.authorPenName, "青砚阁");
    assert.equal(detail.viewerIsOwner, false);
    assert.equal(detail.targetChapterCount, target.targetChapterCount);
    assert.equal(detail.chapters[0]?.currentRevision.id, currentRevision.id);
    assert.deepEqual(detail.chapters[0]?.currentRevision.paragraphs, currentRevision.paragraphs);
    assert.equal(detail.chapters.some((chapter) => chapter.currentRevision.id === "revision_private_history"), false);

    const serialized = JSON.stringify({ firstPage, detail });
    for (const sentinel of [
      PRIVATE_INSPIRATION,
      PRIVATE_PAYLOAD,
      PRIVATE_HISTORY,
      PRIVATE_REASON,
      PRIVATE_MODEL,
      PRIVATE_PROMPT,
    ]) {
      assert.equal(serialized.includes(sentinel), false, `public result leaked ${sentinel}`);
    }
    for (const forbiddenField of [
      "ownerId",
      "inspiration",
      "payload",
      "reason",
      "modelName",
      "promptVersion",
      "revisions",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(detail, forbiddenField), false);
      assert.equal(serialized.includes(`\"${forbiddenField}\"`), false);
    }
  } finally {
    await database.close();
  }
});

test("publication changes are owner-scoped, atomic, idempotent, and suspension-aware", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    const seed = createSeedStore();
    await database.saveSnapshot(seed);
    const sharing = database.publicStorySharing;
    const author = seed.users.find((user) => user.id === "user_demo")!;
    const stranger = readerFor(seed.users, author.id);
    assert.equal(stranger.role, "reader");
    const [archivedStory, emptyStory, publishableStory] = seed.stories;
    assert.ok(archivedStory && emptyStory && publishableStory);

    await pglite.query("UPDATE xumo_stories SET status = 'archived' WHERE id = $1", [archivedStory.id]);
    await assert.rejects(
      sharing.setOwnerPublication(author, archivedStory.id, { published: true, publicPenName: "原子笔名" }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "story_not_publishable");
        return true;
      },
    );
    assert.equal(
      (await pglite.query<{ public_pen_name: string | null }>(
        "SELECT public_pen_name FROM xumo_users WHERE id = $1",
        [author.id],
      )).rows[0]?.public_pen_name,
      null,
    );

    await pglite.query("DELETE FROM xumo_chapters WHERE story_id = $1", [emptyStory.id]);
    await pglite.query(
      "UPDATE xumo_stories SET chapter_count = 0, current_chapter_number = 0, current_chapter_title = '' WHERE id = $1",
      [emptyStory.id],
    );
    await assert.rejects(
      sharing.setOwnerPublication(author, emptyStory.id, { published: true, publicPenName: "原子笔名" }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "story_not_publishable");
        return true;
      },
    );

    await assert.rejects(
      sharing.getOwnerPublication(stranger.id, publishableStory.id),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 403);
        return true;
      },
    );
    await assert.rejects(
      sharing.setOwnerPublication(stranger, publishableStory.id, {
        published: true,
        publicPenName: "越权笔名",
      }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 403);
        return true;
      },
    );

    let firstPublishedAt: string | null = null;
    for (const status of ["active", "paused", "completed"] as const) {
      await pglite.query("UPDATE xumo_stories SET status = $2 WHERE id = $1", [publishableStory.id, status]);
      const published = await sharing.setOwnerPublication(author, publishableStory.id, {
        published: true,
        ...(firstPublishedAt ? {} : { publicPenName: "青砚阁" }),
      });
      assert.equal(published.status, "active");
      firstPublishedAt ??= published.firstPublishedAt;
      assert.equal(published.firstPublishedAt, firstPublishedAt);

      const repeated = await sharing.setOwnerPublication(author, publishableStory.id, { published: true });
      assert.equal(repeated.firstPublishedAt, firstPublishedAt);
      assert.equal(repeated.statusUpdatedAt, published.statusUpdatedAt);

      const unpublished = await sharing.setOwnerPublication(author, publishableStory.id, { published: false });
      assert.equal(unpublished.status, "author_unpublished");
      assert.equal(unpublished.firstPublishedAt, firstPublishedAt);
      assert.equal(unpublished.sharePath, `/public/story/${publishableStory.id}`);
    }

    await assert.rejects(
      sharing.moderate(stranger.id, publishableStory.id, {
        action: "suspend",
        reason: "普通用户不能下架",
      }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 403);
        return true;
      },
    );
    await assert.rejects(
      sharing.moderate(author.id, publishableStory.id, {
        action: "suspend",
        reason: "作者已取消公开",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "public_story_unavailable");
        return true;
      },
    );

    const republished = await sharing.setOwnerPublication(author, publishableStory.id, { published: true });
    assert.equal(republished.firstPublishedAt, firstPublishedAt);
    await assert.rejects(
      sharing.moderate(author.id, publishableStory.id, {
        action: "suspend",
        reason: "包含换行\n的原因",
      }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 422);
        return true;
      },
    );
    const suspended = await sharing.moderate(author.id, publishableStory.id, {
      action: "suspend",
      reason: "等待管理员复核",
    });
    assert.equal(suspended.status, "admin_suspended");
    const repeatedSuspension = await sharing.moderate(author.id, publishableStory.id, {
      action: "suspend",
      reason: "试图改写下架原因",
    });
    assert.equal(repeatedSuspension.status, "admin_suspended");
    assert.equal(repeatedSuspension.adminReason, "等待管理员复核");
    assert.equal(repeatedSuspension.statusUpdatedAt, suspended.statusUpdatedAt);
    const ownerSuspendedState = await sharing.getOwnerPublication(author.id, publishableStory.id);
    assert.equal(ownerSuspendedState.status, "admin_suspended");
    assert.equal(ownerSuspendedState.adminReason, "等待管理员复核");
    await assert.rejects(
      sharing.setOwnerPublication(author, publishableStory.id, { published: false }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "publication_suspended");
        return true;
      },
    );
    assert.equal((await sharing.listModeration(10))[0]?.storyId, publishableStory.id);
    const moderationOverview = await sharing.moderationOverview(10);
    assert.deepEqual(moderationOverview, {
      counts: {
        total: 1,
        active: 0,
        authorUnpublished: 0,
        adminSuspended: 1,
      },
      recent: [repeatedSuspension],
    });
    const serializedOverview = JSON.stringify(moderationOverview);
    for (const forbidden of [
      "paragraphs",
      "currentRevision",
      "payload",
      "modelConnectionId",
      "conversation",
      "passwordHash",
      publishableStory.chapters[0]!.revisions[0]!.paragraphs[0]!,
    ]) {
      assert.equal(serializedOverview.includes(forbidden), false, `ops overview leaked ${forbidden}`);
    }

    const restored = await sharing.moderate(author.id, publishableStory.id, { action: "restore" });
    assert.equal(restored.status, "active");
    assert.equal(restored.storyId, publishableStory.id);
    assert.equal(restored.firstPublishedAt, firstPublishedAt);
    assert.equal((await sharing.updatePublicProfile(author.id, { publicPenName: "新青砚" })).publicPenName, "新青砚");
    assert.equal((await sharing.discover(stranger.id, { query: "新青砚" })).stories[0]?.id, publishableStory.id);
  } finally {
    await database.close();
  }
});

test("public stories follow successful canon commits and ignore rolled-back or historical revisions", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    const seed = structuredClone(createSeedStore());
    const [target, other] = seed.stories;
    assert.ok(target && other);
    const author = seed.users.find((user) => user.id === target.ownerId)!;
    const reader = readerFor(seed.users, author.id);
    target.updatedAt = "2026-07-20T12:00:00.000Z";
    other.updatedAt = "2026-07-21T12:00:00.000Z";
    await database.saveSnapshot(seed);
    const sharing = database.publicStorySharing;
    await sharing.setOwnerPublication(author, target.id, { published: true, publicPenName: "同步作者" });
    await sharing.setOwnerPublication(author, other.id, { published: true });
    assert.equal((await sharing.discover(reader.id, { limit: 10 })).stories[0]?.id, other.id);

    const previousLast = target.chapters.at(-1)!;
    const previousRevision = previousLast.revisions.find(
      (revision) => revision.id === previousLast.currentRevisionId,
    )!;
    const appendedRevision = {
      ...structuredClone(previousRevision),
      id: "revision_public_auto_sync",
      parentRevisionId: previousRevision.id,
      title: "自动同步的新章",
      paragraphs: ["AUTO_SYNC_NEW_CHAPTER"],
      createdAt: "2026-07-29T12:00:00.000Z",
    };
    target.chapters.push({
      ...structuredClone(previousLast),
      id: "chapter_public_auto_sync",
      number: previousLast.number + 1,
      title: appendedRevision.title,
      currentRevisionId: appendedRevision.id,
      revisions: [appendedRevision],
    });
    target.latestExcerpt = appendedRevision.paragraphs[0]!;
    target.updatedAt = "2026-07-29T12:00:00.000Z";
    await database.saveSnapshot(seed);

    assert.equal((await sharing.discover(reader.id, { limit: 10 })).stories[0]?.id, target.id);
    const afterAppend = await sharing.read(reader.id, target.id);
    assert.equal(afterAppend.chapters.at(-1)?.currentRevision.id, appendedRevision.id);
    assert.deepEqual(afterAppend.chapters.at(-1)?.currentRevision.paragraphs, ["AUTO_SYNC_NEW_CHAPTER"]);

    const firstChapter = target.chapters[0]!;
    const oldCurrent = firstChapter.revisions.find((revision) => revision.id === firstChapter.currentRevisionId)!;
    const replacement = {
      ...structuredClone(oldCurrent),
      id: "revision_public_replacement",
      parentRevisionId: oldCurrent.id,
      title: "公开正史替换稿",
      paragraphs: ["CURRENT_CANON_REPLACEMENT"],
      createdAt: "2026-07-29T12:01:00.000Z",
    };
    firstChapter.revisions.push(replacement);
    firstChapter.currentRevisionId = replacement.id;
    firstChapter.title = replacement.title;
    target.updatedAt = "2026-07-29T12:01:00.000Z";
    await database.saveSnapshot(seed);
    assert.deepEqual((await sharing.read(reader.id, target.id)).chapters[0]?.currentRevision.paragraphs, [
      "CURRENT_CANON_REPLACEMENT",
    ]);

    firstChapter.revisions.push({
      ...structuredClone(replacement),
      id: "revision_public_history_only",
      parentRevisionId: replacement.id,
      paragraphs: ["HISTORY_MUST_NOT_REPLACE_CANON"],
      createdAt: "2026-07-29T12:02:00.000Z",
    });
    target.updatedAt = "2026-07-29T12:02:00.000Z";
    await database.saveSnapshot(seed);
    const afterHistory = await sharing.read(reader.id, target.id);
    assert.deepEqual(afterHistory.chapters[0]?.currentRevision.paragraphs, ["CURRENT_CANON_REPLACEMENT"]);
    assert.equal(JSON.stringify(afterHistory).includes("HISTORY_MUST_NOT_REPLACE_CANON"), false);
    assert.deepEqual(await sharing.validateReportTarget(reader.id, target.id, firstChapter.id), {
      storyId: target.id,
      chapterId: firstChapter.id,
      revisionId: replacement.id,
    });

    const rollbackRevision = {
      ...structuredClone(replacement),
      id: "revision_public_rolled_back",
      parentRevisionId: replacement.id,
      paragraphs: ["ROLLED_BACK_CANON_MUST_NOT_APPEAR"],
      createdAt: "2026-07-29T12:03:00.000Z",
    };
    firstChapter.revisions.push(rollbackRevision);
    firstChapter.currentRevisionId = rollbackRevision.id;
    target.title = "回滚中的标题";
    target.updatedAt = "2026-07-29T12:03:00.000Z";
    target.chapters.push({
      ...structuredClone(previousLast),
      id: "chapter_public_invalid_rollback",
      number: 0,
      currentRevisionId: "revision_public_invalid_rollback",
      revisions: [],
    });
    let rollbackCalled = false;
    await assert.rejects(database.saveSnapshot(seed, () => { rollbackCalled = true; }));
    assert.equal(rollbackCalled, true);
    const afterRollback = await sharing.read(reader.id, target.id);
    assert.equal(afterRollback.title === "回滚中的标题", false);
    assert.deepEqual(afterRollback.chapters[0]?.currentRevision.paragraphs, ["CURRENT_CANON_REPLACEMENT"]);
    assert.equal(JSON.stringify(afterRollback).includes("ROLLED_BACK_CANON_MUST_NOT_APPEAR"), false);

    const archivedSnapshot = structuredClone(seed);
    const archivedTarget = archivedSnapshot.stories.find((story) => story.id === target.id)!;
    archivedTarget.status = "archived";
    archivedTarget.chapters = archivedTarget.chapters.filter((chapter) => chapter.number > 0);
    archivedTarget.title = "归档后的标题";
    archivedTarget.updatedAt = "2026-07-29T12:04:00.000Z";
    await database.saveSnapshot(archivedSnapshot);
    assert.equal((await sharing.getOwnerPublication(author.id, target.id)).status, "author_unpublished");
    await assert.rejects(
      sharing.read(reader.id, target.id),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "public_story_unavailable");
        return true;
      },
    );
  } finally {
    await database.close();
  }
});

test("reading progress uses CAS, survives unpublishing, and falls back after chapter replacement", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    const seed = createSeedStore();
    await database.saveSnapshot(seed);
    const story = storyWithChapters(seed.stories);
    assert.ok(story.chapters.length >= 3);
    const author = seed.users.find((user) => user.id === story.ownerId)!;
    const reader = readerFor(seed.users, author.id);
    const sharing = database.publicStorySharing;
    await sharing.setOwnerPublication(author, story.id, { published: true, publicPenName: "进度作者" });
    const [firstChapter, secondChapter, thirdChapter] = story.chapters;
    assert.ok(firstChapter && secondChapter && thirdChapter);

    const initial = await sharing.saveProgress(reader.id, story.id, {
      chapterId: secondChapter.id,
      scrollProgress: 0.25,
      expectedVersion: 0,
    });
    assert.equal(initial.progressVersion, 1);
    const second = await sharing.saveProgress(reader.id, story.id, {
      chapterId: secondChapter.id,
      scrollProgress: 0.4,
      expectedVersion: 1,
    });
    assert.equal(second.progressVersion, 2);

    const concurrent = await Promise.allSettled([
      sharing.saveProgress(reader.id, story.id, {
        chapterId: secondChapter.id,
        scrollProgress: 0.5,
        expectedVersion: 2,
      }),
      sharing.saveProgress(reader.id, story.id, {
        chapterId: secondChapter.id,
        scrollProgress: 0.6,
        expectedVersion: 2,
      }),
    ]);
    const successes = concurrent.filter((result) => result.status === "fulfilled");
    const failures = concurrent.filter((result) => result.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    const conflict = (failures[0] as PromiseRejectedResult).reason as {
      code?: string;
      details?: { latestProgress?: { progressVersion?: number } };
    };
    assert.equal(conflict.code, "progress_conflict");
    assert.equal(conflict.details?.latestProgress?.progressVersion, 3);

    const suspended = await sharing.moderate(author.id, story.id, {
      action: "suspend",
      reason: "进度保留测试",
    });
    assert.equal(suspended.status, "admin_suspended");
    await assert.rejects(
      sharing.read(reader.id, story.id),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "public_story_unavailable");
        return true;
      },
    );
    const restored = await sharing.moderate(author.id, story.id, { action: "restore" });
    assert.equal(restored.status, "active");
    assert.equal(restored.storyId, story.id);
    const restoredDetail = await sharing.read(reader.id, story.id);
    assert.equal(restoredDetail.id, story.id);
    assert.equal(restoredDetail.readingProgress?.progressVersion, 3);
    assert.equal(restoredDetail.readingProgress?.chapterId, secondChapter.id);

    await sharing.setOwnerPublication(author, story.id, { published: false });
    await assert.rejects(
      sharing.saveProgress(reader.id, story.id, {
        chapterId: secondChapter.id,
        scrollProgress: 0.7,
        expectedVersion: 3,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "public_story_unavailable");
        return true;
      },
    );
    await sharing.setOwnerPublication(author, story.id, { published: true });
    assert.equal((await sharing.read(reader.id, story.id)).readingProgress?.progressVersion, 3);

    await pglite.query("DELETE FROM xumo_chapters WHERE id = $1", [secondChapter.id]);
    const earlierFallback = (await sharing.read(reader.id, story.id)).readingProgress;
    assert.equal(earlierFallback?.chapterId, firstChapter.id);
    assert.equal(earlierFallback?.chapterNumber, firstChapter.number);
    assert.equal(earlierFallback?.scrollProgress, 0);

    const movedToFirst = await sharing.saveProgress(reader.id, story.id, {
      chapterId: firstChapter.id,
      scrollProgress: 0.8,
      expectedVersion: 3,
    });
    assert.equal(movedToFirst.progressVersion, 4);
    await pglite.query("DELETE FROM xumo_chapters WHERE id = $1", [firstChapter.id]);
    const firstAvailableFallback = (await sharing.read(reader.id, story.id)).readingProgress;
    assert.equal(firstAvailableFallback?.chapterId, thirdChapter.id);
    assert.equal(firstAvailableFallback?.chapterNumber, thirdChapter.number);
    assert.equal(firstAvailableFallback?.scrollProgress, 0);
  } finally {
    await database.close();
  }
});
