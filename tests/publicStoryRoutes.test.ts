import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createReaderAccount } from "../server/auth";
import {
  createPublicStoryRouter,
  type PublicStoryModerationAuditInput,
  type PublicStoryRequestObservation,
  type PersistPublicStoryReport,
} from "../server/publicStoryRoutes";
import {
  PublicStorySharingError,
  createProgressConflictError,
  createPublicStorySharingDisabledError,
  createPublicStoryUnavailableError,
  createStoryOwnershipError,
  ownerPublicationState,
  type PublicStorySharingModule,
} from "../server/publicStorySharing";
import type {
  ContentReport,
  PublicReadingProgress,
  PublicStoryDetail,
  PublicStorySummary,
  UserAccount,
} from "../src/types";

const reader: UserAccount = {
  ...createReaderAccount("reader@example.com", "correct-horse-battery", "读者"),
  id: "user_reader",
};
const admin: UserAccount = {
  ...createReaderAccount("admin@example.com", "correct-horse-battery", "管理员"),
  id: "user_admin",
  role: "admin",
};

const publicSummary: PublicStorySummary = {
  id: "story_public",
  title: "潮汐背面",
  subtitle: "一封来自昨日的信",
  genre: "悬疑",
  tone: "冷冽 · 克制",
  length: "中篇",
  coverTheme: "tide",
  status: "active",
  authorPenName: "青砚",
  chapterCount: 1,
  currentChapterNumber: 1,
  currentChapterTitle: "潮声",
  latestExcerpt: "潮水退去以后，石阶上只剩一枚旧钥匙。",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

const publicDetail: PublicStoryDetail = {
  ...publicSummary,
  targetChapterCount: 200,
  chapters: [{
    id: "chapter_1",
    number: 1,
    title: "潮声",
    estimatedMinutes: 5,
    currentRevision: {
      id: "revision_current",
      title: "潮声",
      paragraphs: ["潮水退去以后，石阶上只剩一枚旧钥匙。"],
      createdAt: "2026-07-29T00:00:00.000Z",
    },
  }],
  readingProgress: null,
  viewerIsOwner: false,
};

const savedProgress: PublicReadingProgress = {
  storyId: "story_public",
  chapterId: "chapter_1",
  chapterNumber: 1,
  scrollProgress: 0.5,
  progressVersion: 1,
  updatedAt: "2026-07-29T00:01:00.000Z",
};

function fakeSharingModule(
  overrides: Partial<PublicStorySharingModule> = {},
): PublicStorySharingModule {
  return {
    getOwnerPublication: async (_ownerId, storyId) => ownerPublicationState(storyId, "private"),
    setOwnerPublication: async (_actor, storyId, input) => ownerPublicationState(
      storyId,
      input.published ? "active" : "author_unpublished",
      "2026-07-29T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
    ),
    updatePublicProfile: async (_userId, input) => ({ publicPenName: input.publicPenName.trim() }),
    discover: async () => ({ stories: [publicSummary], nextCursor: null }),
    read: async () => publicDetail,
    saveProgress: async () => savedProgress,
    validateReportTarget: async (_viewerId, storyId, chapterId) => ({
      storyId,
      chapterId,
      revisionId: "revision_current",
    }),
    moderate: async (_adminUserId, storyId, input) => ({
      storyId,
      title: publicSummary.title,
      authorPenName: publicSummary.authorPenName,
      status: input.action === "suspend" ? "admin_suspended" : "active",
      firstPublishedAt: "2026-07-29T00:00:00.000Z",
      statusUpdatedAt: "2026-07-29T00:02:00.000Z",
      adminReason: input.action === "suspend" ? input.reason ?? null : null,
    }),
    listModeration: async () => [],
    moderationOverview: async () => ({
      counts: {
        total: 1,
        active: 1,
        authorUnpublished: 0,
        adminSuspended: 0,
      },
      recent: [],
    }),
    ...overrides,
  };
}

function defaultPersistReport(): PersistPublicStoryReport {
  return async (input) => {
    const createdAt = "2026-07-29T00:03:00.000Z";
    return {
      id: "report_public",
      ...input,
      status: "submitted",
      createdAt,
      updatedAt: createdAt,
    };
  };
}

interface RouteHarness {
  baseUrl: string;
  close(): Promise<void>;
}

async function startRouteHarness(options: {
  user?: UserAccount | null;
  getSharingModule?: () => PublicStorySharingModule;
  persistReport?: PersistPublicStoryReport;
  observeRequest?: (observation: PublicStoryRequestObservation) => void;
  recordModerationAudit?: (input: PublicStoryModerationAuditInput) => Promise<void>;
} = {}): Promise<RouteHarness> {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use((_request, response, next) => {
    if (options.user !== null) response.locals.user = options.user ?? reader;
    next();
  });
  app.use("/api", createPublicStoryRouter({
    getSharingModule: options.getSharingModule ?? (() => fakeSharingModule()),
    persistReport: options.persistReport ?? defaultPersistReport(),
    observeRequest: options.observeRequest,
    recordModerationAudit: options.recordModerationAudit ?? (async () => undefined),
  }));
  app.get("/api/private-probe", (_request, response) => {
    response.json({ ok: true });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function requestJson(
  harness: RouteHarness,
  path: string,
  init?: RequestInit,
): Promise<{ response: globalThis.Response; body: Record<string, unknown> }> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = response.status === 204
    ? {}
    : await response.json() as Record<string, unknown>;
  return { response, body };
}

test("all public-story routes require an authenticated user", async (t) => {
  const harness = await startRouteHarness({ user: null });
  t.after(() => harness.close());

  const { response, body } = await requestJson(harness, "/api/public-stories");
  assert.equal(response.status, 401);
  assert.equal(body.code, "authentication_required");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("the feature flag fails closed with the same 404 code on every new route", async (t) => {
  const harness = await startRouteHarness({
    user: admin,
    getSharingModule: () => {
      throw createPublicStorySharingDisabledError();
    },
  });
  t.after(() => harness.close());

  const requests: Array<[string, string, unknown?]> = [
    ["GET", "/api/stories/story_public/publication"],
    ["PUT", "/api/stories/story_public/publication", { published: true, publicPenName: "青砚" }],
    ["PATCH", "/api/me/public-profile", { publicPenName: "青砚" }],
    ["GET", "/api/public-stories"],
    ["GET", "/api/public-stories/story_public"],
    ["PUT", "/api/public-stories/story_public/progress", {
      chapterId: "chapter_1",
      scrollProgress: 0.5,
      expectedVersion: 0,
    }],
    ["POST", "/api/public-stories/story_public/reports", {
      chapterId: "chapter_1",
      reason: "章节疑似违规",
    }],
    ["POST", "/api/ops/publications/story_public/suspend", { reason: "等待人工复核" }],
    ["POST", "/api/ops/publications/story_public/restore"],
  ];

  for (const [method, path, body] of requests) {
    const result = await requestJson(harness, path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(result.response.status, 404, `${method} ${path}`);
    assert.equal(result.body.code, "public_story_sharing_disabled", `${method} ${path}`);
    assert.equal(result.response.headers.get("cache-control"), "private, no-store");
  }

  const privateProbe = await requestJson(harness, "/api/private-probe");
  assert.equal(privateProbe.response.status, 200);
  assert.deepEqual(privateProbe.body, { ok: true });
});

test("owner publication errors map to stable HTTP statuses and codes", async (t) => {
  const sharing = fakeSharingModule({
    getOwnerPublication: async () => {
      throw createStoryOwnershipError();
    },
    setOwnerPublication: async (_actor, _storyId, input) => {
      if (input.publicPenName === "甲") {
        throw new PublicStorySharingError("invalid_public_pen_name", "笔名不合规。");
      }
      if (input.publicPenName === "不可发布") {
        throw new PublicStorySharingError("story_not_publishable", "故事不可发布。");
      }
      throw new PublicStorySharingError("publication_suspended", "作品已被管理员下架。");
    },
  });
  const harness = await startRouteHarness({ getSharingModule: () => sharing });
  t.after(() => harness.close());

  const wrongOwner = await requestJson(harness, "/api/stories/story_other/publication");
  assert.equal(wrongOwner.response.status, 403);
  assert.equal(wrongOwner.body.code, "story_not_owned");

  const cases = [
    ["甲", 422, "invalid_public_pen_name"],
    ["不可发布", 409, "story_not_publishable"],
    ["已下架", 409, "publication_suspended"],
  ] as const;
  for (const [publicPenName, status, code] of cases) {
    const result = await requestJson(harness, "/api/stories/story_public/publication", {
      method: "PUT",
      body: JSON.stringify({ published: true, publicPenName }),
    });
    assert.equal(result.response.status, status);
    assert.equal(result.body.code, code);
  }
});

test("every unavailable public lifecycle state has one non-enumerating response", async (t) => {
  const sharing = fakeSharingModule({
    read: async () => {
      throw createPublicStoryUnavailableError();
    },
  });
  const harness = await startRouteHarness({ getSharingModule: () => sharing });
  t.after(() => harness.close());

  for (const storyId of ["private", "author-unpublished", "admin-suspended", "archived", "missing"]) {
    const result = await requestJson(harness, `/api/public-stories/${storyId}`);
    assert.equal(result.response.status, 404);
    assert.equal(result.body.code, "public_story_unavailable");
    assert.equal(result.body.message, "作品暂不可读。");
  }
});

test("progress conflicts preserve the latest server record in error details", async (t) => {
  const latestProgress = { ...savedProgress, progressVersion: 4, scrollProgress: 0.8 };
  const sharing = fakeSharingModule({
    saveProgress: async () => {
      throw createProgressConflictError(latestProgress);
    },
  });
  const harness = await startRouteHarness({ getSharingModule: () => sharing });
  t.after(() => harness.close());

  const result = await requestJson(harness, "/api/public-stories/story_public/progress", {
    method: "PUT",
    body: JSON.stringify({
      chapterId: "chapter_1",
      scrollProgress: 0.2,
      expectedVersion: 3,
    }),
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, "progress_conflict");
  assert.deepEqual(result.body.details, { latestProgress });
});

test("normal readers cannot call moderation routes", async (t) => {
  let moderateCalls = 0;
  const sharing = fakeSharingModule({
    moderate: async (...args) => {
      moderateCalls += 1;
      return fakeSharingModule().moderate(...args);
    },
  });
  const harness = await startRouteHarness({ user: reader, getSharingModule: () => sharing });
  t.after(() => harness.close());

  const result = await requestJson(harness, "/api/ops/publications/story_public/suspend", {
    method: "POST",
    body: JSON.stringify({ reason: "等待人工复核" }),
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, "admin_required");
  assert.equal(moderateCalls, 0);
});

test("successful moderation emits a bounded audit input without story prose", async (t) => {
  const auditInputs: PublicStoryModerationAuditInput[] = [];
  const harness = await startRouteHarness({
    user: admin,
    recordModerationAudit: async (input) => {
      auditInputs.push(input);
    },
  });
  t.after(() => harness.close());

  const suspended = await requestJson(harness, "/api/ops/publications/story_public/suspend", {
    method: "POST",
    body: JSON.stringify({ reason: "  举报待复核  " }),
  });
  assert.equal(suspended.response.status, 200);
  const restored = await requestJson(harness, "/api/ops/publications/story_public/restore", {
    method: "POST",
  });
  assert.equal(restored.response.status, 200);
  assert.deepEqual(auditInputs, [
    {
      actorUserId: admin.id,
      storyId: "story_public",
      action: "suspend",
      reason: "举报待复核",
      resultingStatus: "admin_suspended",
    },
    {
      actorUserId: admin.id,
      storyId: "story_public",
      action: "restore",
      resultingStatus: "active",
    },
  ]);
  const serialized = JSON.stringify(auditInputs);
  for (const forbidden of [
    publicSummary.title,
    publicSummary.authorPenName,
    publicDetail.chapters[0]!.currentRevision.paragraphs[0]!,
    "paragraphs",
    "currentRevision",
    "payload",
    "modelConnectionId",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `audit input leaked ${forbidden}`);
  }
});

test("request observations contain only safe route metadata for success and failure", async (t) => {
  const observations: PublicStoryRequestObservation[] = [];
  const latestProgress = { ...savedProgress, progressVersion: 3 };
  const sharing = fakeSharingModule({
    saveProgress: async () => {
      throw createProgressConflictError(latestProgress);
    },
  });
  const harness = await startRouteHarness({
    user: admin,
    getSharingModule: () => sharing,
    observeRequest: (observation) => observations.push(observation),
  });
  t.after(() => harness.close());

  const requests: Array<[string, string, unknown?]> = [
    ["GET", "/api/public-stories?query=查询原文秘密"],
    ["GET", "/api/public-stories/story_secret_identifier"],
    ["PUT", "/api/public-stories/story_secret_identifier/progress", {
      chapterId: "chapter_secret_identifier",
      scrollProgress: 0.3,
      expectedVersion: 2,
    }],
    ["PUT", "/api/stories/story_secret_identifier/publication", {
      published: true,
      publicPenName: "绝密笔名",
    }],
    ["PUT", "/api/stories/story_secret_identifier/publication", {
      published: false,
    }],
    ["POST", "/api/ops/publications/story_secret_identifier/suspend", {
      reason: "敏感下架原因",
    }],
  ];
  for (const [method, path, body] of requests) {
    await requestJson(harness, path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  assert.deepEqual(
    observations.map(({ routeName, statusCode }) => ({ routeName, statusCode })),
    [
      { routeName: "public_story.list", statusCode: 200 },
      { routeName: "public_story.detail", statusCode: 200 },
      { routeName: "public_story.progress", statusCode: 409 },
      { routeName: "publication.publish", statusCode: 200 },
      { routeName: "publication.unpublish", statusCode: 200 },
      { routeName: "publication.suspend", statusCode: 200 },
    ],
  );
  assert.equal(new Set(observations.map((item) => item.requestCorrelationId)).size, observations.length);
  for (const observation of observations) {
    assert.deepEqual(
      Object.keys(observation).sort(),
      ["latencyMs", "requestCorrelationId", "routeName", "statusCode"],
    );
    assert.match(observation.requestCorrelationId, /^[0-9a-f-]{36}$/u);
    assert.ok(Number.isInteger(observation.latencyMs));
    assert.ok(observation.latencyMs >= 0);
  }
  const serialized = JSON.stringify(observations);
  for (const forbidden of [
    "查询原文秘密",
    "story_secret_identifier",
    "chapter_secret_identifier",
    "绝密笔名",
    "敏感下架原因",
    publicSummary.title,
    publicDetail.chapters[0]!.currentRevision.paragraphs[0]!,
  ]) {
    assert.equal(serialized.includes(forbidden), false, `observation leaked ${forbidden}`);
  }
});

test("public reports resolve the current revision before persisting bounded metadata", async (t) => {
  const calls: string[] = [];
  let persistedInput: Parameters<PersistPublicStoryReport>[0] | undefined;
  const sharing = fakeSharingModule({
    validateReportTarget: async (viewerId, storyId, chapterId) => {
      calls.push("validate");
      assert.equal(viewerId, reader.id);
      return { storyId, chapterId, revisionId: "revision_current" };
    },
  });
  const persistReport: PersistPublicStoryReport = async (input) => {
    calls.push("persist");
    persistedInput = input;
    return defaultPersistReport()(input);
  };
  const harness = await startRouteHarness({ getSharingModule: () => sharing, persistReport });
  t.after(() => harness.close());

  const result = await requestJson(harness, "/api/public-stories/story_public/reports", {
    method: "POST",
    body: JSON.stringify({ chapterId: "chapter_1", reason: "  章节疑似违规  " }),
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls, ["validate", "persist"]);
  assert.deepEqual(persistedInput, {
    reporterUserId: reader.id,
    storyId: "story_public",
    chapterId: "chapter_1",
    revisionId: "revision_current",
    reason: "章节疑似违规",
  });
  assert.equal("paragraphs" in (persistedInput ?? {}), false);
  assert.equal("body" in (persistedInput ?? {}), false);
});

test("public success payloads are no-store and contain only the public projections", async (t) => {
  const harness = await startRouteHarness();
  t.after(() => harness.close());

  const requests: Array<[string, string, unknown?]> = [
    ["GET", "/api/public-stories"],
    ["GET", "/api/public-stories/story_public"],
    ["PUT", "/api/public-stories/story_public/progress", {
      chapterId: "chapter_1",
      scrollProgress: 0.5,
      expectedVersion: 0,
    }],
    ["POST", "/api/public-stories/story_public/reports", {
      chapterId: "chapter_1",
      reason: "章节疑似违规",
    }],
  ];

  for (const [method, path, body] of requests) {
    const result = await requestJson(harness, path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(result.response.ok, `${method} ${path}`);
    assert.equal(result.response.headers.get("cache-control"), "private, no-store");
    const serialized = JSON.stringify(result.body);
    for (const forbidden of ["passwordHash", "passwordSalt", "payload", "modelConnectionId", "conversation"]) {
      assert.equal(serialized.includes(forbidden), false, `${method} ${path} leaked ${forbidden}`);
    }
  }
});
