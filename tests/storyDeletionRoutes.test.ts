import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  authenticate,
  createAuthSession,
  createReaderAccount,
} from "../server/auth";
import { apiErrorHandler } from "../server/apiError";
import {
  createStoryDeletionRouter,
  createStoryMutationLockManager,
  loadStoryUnlessDeleting,
  type StoryDeletionRouterOptions,
  runWithStoryMutationLease,
  type StoryMutationLockManager,
} from "../server/storyDeletionRoutes";
import {
  assertStoryDeletionTitle,
  storyDeletionBusyError,
  storyNotFoundError,
} from "../server/storyDeletion";
import type { AppStore, UserAccount } from "../src/types";
import { createSeedStore } from "../server/seed";

const owner: UserAccount = {
  ...createReaderAccount("owner@example.com", "correct-horse-battery", "作者"),
  id: "user_owner",
};

const otherUser: UserAccount = {
  ...createReaderAccount("other@example.com", "correct-horse-battery", "其他作者"),
  id: "user_other",
};

interface DeletionHarness {
  baseUrl: string;
  token: string;
  otherToken: string;
  close(): Promise<void>;
}

async function startDeletionHarness(options: {
  authenticated?: boolean;
  lockManager?: StoryMutationLockManager;
  deleteStory?: StoryDeletionRouterOptions["deleteStory"];
  ownsStory?: StoryDeletionRouterOptions["ownsStory"];
} = {}): Promise<DeletionHarness> {
  const store: AppStore = createSeedStore();
  store.users = [owner, otherUser];
  store.sessions = [];
  const { token, session } = createAuthSession(owner.id);
  const { token: otherToken, session: otherSession } = createAuthSession(otherUser.id);
  store.sessions.push(session, otherSession);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", authenticate(store));
  app.use("/api", createStoryDeletionRouter({
    storyMutationLocks: options.lockManager ?? createStoryMutationLockManager(),
    deleteStory: options.deleteStory ?? (async () => undefined),
    ownsStory: options.ownsStory ?? (async (ownerId) => ownerId === owner.id),
  }));
  app.use(apiErrorHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: options.authenticated === false ? "invalid-token" : token,
    otherToken,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function requestDelete(
  harness: DeletionHarness,
  storyId: string,
  body: unknown,
  token = harness.token,
): Promise<globalThis.Response> {
  return fetch(`${harness.baseUrl}/api/stories/${encodeURIComponent(storyId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function responseJson(response: globalThis.Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

test("DELETE /api/stories/:storyId uses real bearer authentication", async (t) => {
  const harness = await startDeletionHarness({ authenticated: false });
  t.after(() => harness.close());

  const response = await requestDelete(harness, "story_a", { confirmationTitle: "故事 A" });
  assert.equal(response.status, 401);
  assert.deepEqual(await responseJson(response), {
    message: "请登录后继续。",
    code: "authentication_required",
  });
});

test("DELETE strictly validates its params and JSON body", async (t) => {
  const harness = await startDeletionHarness();
  t.after(() => harness.close());

  const cases: Array<[string, unknown]> = [
    ["story_a", {}],
    ["story_a", { confirmationTitle: "" }],
    ["story_a", { confirmationTitle: "x".repeat(201) }],
    ["story_a", { confirmationTitle: "故事 A", extra: true }],
    ["x".repeat(201), { confirmationTitle: "故事 A" }],
  ];
  for (const [storyId, body] of cases) {
    const response = await requestDelete(harness, storyId, body);
    assert.equal(response.status, 400, storyId.length.toString());
    const result = await responseJson(response);
    assert.equal(result.message, "提交内容不完整或格式不正确。");
    assert.ok(Array.isArray(result.issues));
  }

  const emptyBody = await fetch(`${harness.baseUrl}/api/stories/story_a`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${harness.token}`,
      "Content-Type": "application/json",
    },
  });
  assert.equal(emptyBody.status, 400);
  const emptyResult = await responseJson(emptyBody);
  assert.equal(emptyResult.message, "提交内容不完整或格式不正确。");
  assert.ok(Array.isArray(emptyResult.issues));
});

test("DELETE maps domain and unexpected failures through the production error handler", async (t) => {
  const outcomes = [
    () => assertStoryDeletionTitle("故事 A", "故事 B"),
    () => { throw storyNotFoundError(); },
    () => { throw storyDeletionBusyError(); },
    () => { throw Object.assign(new Error("存储暂时不可用。"), { code: 123 }); },
    () => { throw Object.assign(new Error("安全检查未通过。"), {
      status: 422,
      code: "story_delete_busy",
      safetyDecisionId: "safety_1",
      privateDetails: "do-not-serialize",
    }); },
  ];
  const expected = [
    [400, "story_delete_confirmation_mismatch"],
    [404, "story_not_found"],
    [409, "story_delete_busy"],
    [500, undefined],
    [422, "story_delete_busy"],
  ] as const;

  for (const [index, outcome] of outcomes.entries()) {
    const harness = await startDeletionHarness({
      deleteStory: async () => outcome(),
    });
    t.after(() => harness.close());
    const response = await requestDelete(harness, "story_a", { confirmationTitle: index === 0 ? "故事 B" : "故事 A" });
    assert.equal(response.status, expected[index]![0]);
    const body = await responseJson(response);
    assert.equal(body.code, expected[index]![1]);
    if (index === 4) {
      assert.equal(body.safetyDecisionId, "safety_1");
      assert.equal(body.privateDetails, undefined);
      assert.deepEqual(Object.keys(body).sort(), ["code", "message", "safetyDecisionId"]);
    }
  }
});

test("DELETE forwards valid trimmed input and returns an empty 204", async (t) => {
  const calls: unknown[] = [];
  const harness = await startDeletionHarness({
    deleteStory: async (input) => { calls.push(input); },
  });
  t.after(() => harness.close());

  const response = await requestDelete(harness, " story_a ", { confirmationTitle: "  故事 A  " });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls, [{ ownerId: owner.id, storyId: "story_a", confirmationTitle: "故事 A" }]);
});

test("two concurrent deletes for one story invoke storage only once", async (t) => {
  let calls = 0;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const manager = createStoryMutationLockManager();
  const harness = await startDeletionHarness({
    lockManager: manager,
    deleteStory: async () => {
      calls += 1;
      await pending;
    },
  });
  t.after(() => harness.close());

  const first = requestDelete(harness, "story_a", { confirmationTitle: "故事 A" });
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.isDeleting("story_a"), true);
  const second = await requestDelete(harness, "story_a", { confirmationTitle: "故事 A" });
  assert.equal(second.status, 409);
  assert.equal((await responseJson(second)).code, "story_delete_busy");
  assert.equal(calls, 1);
  finish();
  assert.equal((await first).status, 204);
  assert.equal(manager.has("story_a"), false);
});

test("success and every storage error release the acquired lease", async (t) => {
  const outcomes = [
    async () => undefined,
    async () => assertStoryDeletionTitle("故事 A", "故事 B"),
    async () => { throw storyNotFoundError(); },
    async () => { throw storyDeletionBusyError(); },
    async () => { throw new Error("unexpected"); },
  ];
  for (const deleteStory of outcomes) {
    const manager = createStoryMutationLockManager();
    const harness = await startDeletionHarness({ lockManager: manager, deleteStory });
    t.after(() => harness.close());
    await requestDelete(harness, "story_a", { confirmationTitle: "故事 A" });
    assert.equal(manager.has("story_a"), false);
  }
});

test("a request cannot release a lease held by another owner", async (t) => {
  const manager = createStoryMutationLockManager();
  const held = manager.tryAcquire("story_a", owner.id);
  assert.equal(held.acquired, true);
  if (!held.acquired) throw new Error("expected an acquired lease");
  const harness = await startDeletionHarness({ lockManager: manager });
  t.after(() => harness.close());

  const response = await requestDelete(harness, "story_a", { confirmationTitle: "故事 A" });
  assert.equal(response.status, 409);
  assert.equal(manager.has("story_a"), true);
  held.release();
  assert.equal(manager.has("story_a"), false);
});

test("a same-owner conflict stays busy while deletion has temporarily removed runtime ownership", async (t) => {
  const manager = createStoryMutationLockManager();
  let owned = true;
  let ownershipChecks = 0;
  let deleteCalls = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const harness = await startDeletionHarness({
    lockManager: manager,
    ownsStory: async (ownerId, storyId) => {
      ownershipChecks += 1;
      assert.equal(ownerId, owner.id);
      assert.equal(storyId, "story_a");
      return owned;
    },
    deleteStory: async () => {
      deleteCalls += 1;
      owned = false;
      markStarted();
      await pending;
      owned = true;
      throw new Error("simulated persistence rollback");
    },
  });
  t.after(async () => {
    finish();
    await harness.close();
  });

  const first = requestDelete(harness, "story_a", { confirmationTitle: "故事 A" });
  await started;
  assert.equal(owned, false);
  const second = await requestDelete(harness, "story_a", { confirmationTitle: "故事 A" });
  assert.equal(second.status, 409);
  assert.equal((await responseJson(second)).code, "story_delete_busy");
  assert.equal(ownershipChecks, 1);
  assert.equal(deleteCalls, 1);

  finish();
  assert.equal((await first).status, 500);
  assert.equal(owned, true);
  assert.equal(manager.has("story_a"), false);
});

test("a locked story does not reveal its existence to another authenticated user", async (t) => {
  const manager = createStoryMutationLockManager();
  const held = manager.tryAcquire("story_a", owner.id);
  assert.equal(held.acquired, true);
  if (!held.acquired) throw new Error("expected an acquired lease");
  let deleteCalls = 0;
  let ownershipChecks = 0;
  const harness = await startDeletionHarness({
    lockManager: manager,
    ownsStory: async (ownerId, storyId) => {
      ownershipChecks += 1;
      assert.equal(storyId, "story_a");
      return ownerId === owner.id;
    },
    deleteStory: async () => {
      deleteCalls += 1;
      throw storyNotFoundError();
    },
  });
  t.after(() => harness.close());

  const locked = await requestDelete(
    harness,
    "story_a",
    { confirmationTitle: "故事 A" },
    harness.otherToken,
  );
  assert.equal(locked.status, 404);
  assert.equal(deleteCalls, 0);
  assert.equal(ownershipChecks, 1);
  const lockedBody = await responseJson(locked);

  held.release();
  const unlocked = await requestDelete(harness, "story_a", { confirmationTitle: "故事 A" }, harness.otherToken);
  assert.equal(unlocked.status, 404);
  assert.equal(deleteCalls, 0);
  assert.equal(ownershipChecks, 2);
  assert.deepEqual(await responseJson(unlocked), lockedBody);
});

test("lock leases are idempotent and stale release cannot unlock a successor", () => {
  const manager = createStoryMutationLockManager();
  const first = manager.tryAcquire("story_a", owner.id);
  assert.equal(first.acquired, true);
  if (!first.acquired) throw new Error("expected an acquired lease");
  assert.deepEqual(manager.tryAcquire("story_a", otherUser.id), {
    acquired: false,
    ownerId: owner.id,
    kind: "mutation",
  });
  first.release();
  const second = manager.tryAcquire("story_a", otherUser.id);
  assert.equal(second.acquired, true);
  if (!second.acquired) throw new Error("expected an acquired lease");
  first.release();
  assert.equal(manager.has("story_a"), true);
  second.release();
  second.release();
  assert.equal(manager.has("story_a"), false);
});

test("mutation leases and deletion leases expose deletion state separately", () => {
  const manager = createStoryMutationLockManager();
  const mutation = manager.tryAcquire("story_a", owner.id);
  assert.equal(mutation.acquired, true);
  assert.equal(manager.isDeleting("story_a"), false);
  if (!mutation.acquired) throw new Error("expected a mutation lease");
  mutation.release();

  const deletion = manager.tryAcquire("story_a", owner.id, "deletion");
  assert.equal(deletion.acquired, true);
  assert.equal(manager.isDeleting("story_a"), true);
  if (!deletion.acquired) throw new Error("expected a deletion lease");
  deletion.release();
  assert.equal(manager.isDeleting("story_a"), false);
});

test("a story load that finishes after deletion starts reports pending instead of false absence", async () => {
  const manager = createStoryMutationLockManager();
  let finishLoad!: (story: { id: string }) => void;
  const pendingLoad = new Promise<{ id: string }>((resolve) => { finishLoad = resolve; });
  const loaded = loadStoryUnlessDeleting(manager, "story_a", owner.id, () => pendingLoad);

  const deletion = manager.tryAcquire("story_a", owner.id, "deletion");
  assert.equal(deletion.acquired, true);
  finishLoad({ id: "story_a" });
  await assert.rejects(
    loaded,
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "story_delete_busy",
  );
  if (deletion.acquired) deletion.release();
});

test("an owner gets pending even when the database load would return null", async () => {
  const manager = createStoryMutationLockManager();
  const deletion = manager.tryAcquire("story_private", owner.id, "deletion");
  assert.equal(deletion.acquired, true);
  try {
    await assert.rejects(
      loadStoryUnlessDeleting(manager, "story_private", owner.id, async () => {
        assert.fail("the owner should be rejected before loading a tombstoned story");
      }),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "story_delete_busy",
    );
  } finally {
    if (deletion.acquired) deletion.release();
  }
});

test("a deletion lease does not reveal a null story to another user", async () => {
  const manager = createStoryMutationLockManager();
  const deletion = manager.tryAcquire("story_private", owner.id, "deletion");
  assert.equal(deletion.acquired, true);
  try {
    assert.equal(
      await loadStoryUnlessDeleting(manager, "story_private", otherUser.id, async () => null),
      null,
    );
  } finally {
    if (deletion.acquired) deletion.release();
  }
});

test("the shared mutation wrapper excludes deletion for the complete async mutation", async () => {
  const manager = createStoryMutationLockManager();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let finishMutation!: () => void;
  const canFinish = new Promise<void>((resolve) => { finishMutation = resolve; });
  const mutation = runWithStoryMutationLease(manager, "story_a", otherUser.id, async () => {
    markStarted();
    await canFinish;
    return "saved";
  });
  await started;

  assert.deepEqual(manager.tryAcquire("story_a", owner.id, "deletion"), {
    acquired: false,
    ownerId: otherUser.id,
    kind: "mutation",
  });
  finishMutation();
  assert.equal(await mutation, "saved");

  const deletion = manager.tryAcquire("story_a", owner.id, "deletion");
  assert.equal(deletion.acquired, true);
  if (deletion.acquired) deletion.release();

  await assert.rejects(
    runWithStoryMutationLease(manager, "story_a", otherUser.id, async () => {
      throw new Error("mutation failed");
    }),
    /mutation failed/u,
  );
  const afterFailure = manager.tryAcquire("story_a", owner.id, "deletion");
  assert.equal(afterFailure.acquired, true);
  if (afterFailure.acquired) afterFailure.release();
});
