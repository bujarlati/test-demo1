import assert from "node:assert/strict";
import test from "node:test";
import { captureCanonState, replayBranchState } from "../server/canonState";
import { generateLocalChapter, planNextChapter } from "../server/narrativeEngine";
import { createSeedStore } from "../server/seed";
import { createStoreMutationGate, createStoreSaveQueue, shouldAbandonQueuedRequest } from "../server/storage";
import {
  appendStoryCoreEvent,
  createStoryConstraint,
  describeReaderStoryEvent,
  projectStoryWorldState,
} from "../server/storyCore";
import { commitNextChapter } from "../server/storyService";
import type { Story, StoryConstraint } from "../src/types";

function fixture(): Story {
  const story = structuredClone(createSeedStore().stories[0]);
  story.constraints = [];
  const branch = story.branches.find((item) => item.id === story.activeBranchId);
  assert.ok(branch);
  branch.stateSnapshot = captureCanonState(story);
  return story;
}

function currentRevision(story: Story) {
  const chapter = story.chapters.at(-1);
  assert.ok(chapter);
  return { chapter, revisionId: chapter.currentRevisionId };
}

test("world-state projection unifies legacy entities without mutating the story", () => {
  const story = fixture();
  const before = JSON.stringify(story);

  const world = projectStoryWorldState(story);

  assert.equal(world.storyId, story.id);
  assert.equal(world.branchId, story.activeBranchId);
  assert.equal(world.canonVersion, story.canonVersion);
  assert.equal(world.entities.filter((entity) => entity.kind === "character").length, story.characters.length);
  assert.equal(world.entities.filter((entity) => entity.kind === "item").length, story.items.length);
  assert.equal(world.entities.filter((entity) => entity.kind === "clue").length, story.clues.length);
  assert.ok(world.entities.some((entity) => entity.id === `story:${story.id}` && entity.kind === "story"));
  assert.ok(world.states.some((state) => state.entityId === story.characters[0].id && state.values.lifecycle));
  assert.equal(JSON.stringify(story), before);
});

test("legacy rules, preferences, and protected characters are exposed as read-only constraints", () => {
  const story = fixture();
  story.characters[0].protected = true;
  story.preferences[0].active = true;

  const constraints = projectStoryWorldState(story).constraints;

  assert.ok(constraints.some((constraint) => constraint.source === "legacy_rule" && constraint.readOnly));
  assert.ok(constraints.some((constraint) => constraint.source === "legacy_preference" && constraint.readOnly));
  assert.ok(constraints.some((constraint) =>
    constraint.targetEntityId === story.characters[0].id &&
    constraint.path === "lifecycle" &&
    constraint.operator === "neq" &&
    constraint.expectedValue === "dead" &&
    constraint.enforceable,
  ));
  assert.deepEqual(story.constraints, []);
});

test("constraint creation is append-only, versioned, and idempotent", () => {
  const story = fixture();
  const character = story.characters.find((candidate) => candidate.lifecycle === "alive");
  assert.ok(character);
  const baseCanonVersion = story.canonVersion;
  const input = {
    title: `${character.name}必须存活`,
    description: "后续事件不得把该角色置为死亡。",
    targetEntityId: character.id,
    path: "lifecycle",
    operator: "eq" as const,
    expectedValue: "alive",
    source: "reader" as const,
    hardness: "hard" as const,
    scope: "branch" as const,
    branchId: story.activeBranchId,
    baseCanonVersion,
    idempotencyKey: "constraint-test-key",
  };

  const first = createStoryConstraint(story, input);
  const duplicate = createStoryConstraint(story, input);

  assert.equal(first.id, duplicate.id);
  assert.equal(story.constraints.length, 1);
  assert.equal(story.canonVersion, baseCanonVersion + 1);
  assert.equal(story.branches.find((branch) => branch.id === story.activeBranchId)?.headCanonVersion, story.canonVersion);
  const committed = JSON.stringify(story);
  assert.throws(
    () => createStoryConstraint(story, { ...input, description: "同一幂等键不能代表另一条约束。" }),
    /幂等键/,
  );
  assert.equal(JSON.stringify(story), committed);
});

test("an immediately unsatisfied hard constraint is rejected atomically", () => {
  const story = fixture();
  const character = story.characters.find((candidate) => candidate.lifecycle === "alive");
  assert.ok(character);
  const before = JSON.stringify(story);

  assert.throws(() => createStoryConstraint(story, {
    title: "不成立的死亡约束",
    description: "当前角色没有死亡，不能直接把冲突约束提交进正史。",
    targetEntityId: character.id,
    path: "lifecycle",
    operator: "eq",
    expectedValue: "dead",
    source: "reader",
    hardness: "hard",
    scope: "branch",
    branchId: story.activeBranchId,
    baseCanonVersion: story.canonVersion,
    idempotencyKey: "unsatisfied-hard-key",
  }), /约束/);
  assert.equal(JSON.stringify(story), before);
});

test("an exists-false constraint can protect a supported optional state field", () => {
  const story = fixture();
  const item = story.items[0];
  assert.ok(item);
  item.status = "available";
  delete item.holderCharacterId;

  const constraint = createStoryConstraint(story, {
    title: `${item.name}不得被任何角色持有`,
    description: "持有人字段必须保持不存在。",
    targetEntityId: item.id,
    path: "holderCharacterId",
    operator: "exists",
    expectedValue: false,
    source: "reader",
    hardness: "hard",
    scope: "branch",
    branchId: story.activeBranchId,
    baseCanonVersion: story.canonVersion,
    idempotencyKey: "holder-absence-key",
  });

  assert.equal(constraint.operator, "exists");
  assert.equal(constraint.expectedValue, false);
});

test("event append atomically changes state, sequence, snapshot, and canon version", () => {
  const story = fixture();
  const character = story.characters.find((candidate) => !candidate.protected) ?? story.characters[0];
  character.protected = false;
  const { chapter, revisionId } = currentRevision(story);
  const baseCanonVersion = story.canonVersion;
  const previousMaxSequence = Math.max(0, ...story.events.map((event) => event.sequence));

  const event = appendStoryCoreEvent(story, {
    chapterNumber: chapter.number,
    revisionId,
    type: "relationship",
    title: "关系重新确认",
    cause: "双方完成了一次坦诚对话",
    outcome: "两人的互信得到恢复",
    participantIds: [character.id],
    location: character.location,
    dependsOn: [],
    storyTime: `事件序列${previousMaxSequence + 1}·场景1`,
    stateEffects: {
      characters: [{ characterId: character.id, relationship: "互相信任" }],
    },
    branchId: story.activeBranchId,
    baseCanonVersion,
    idempotencyKey: "event-test-key",
    source: "system",
  });

  assert.equal(event.sequence, previousMaxSequence + 1);
  assert.equal(story.events.at(-1)?.id, event.id);
  assert.equal(story.characters.find((item) => item.id === character.id)?.relationship, "互相信任");
  assert.equal(story.canonVersion, baseCanonVersion + 1);
  assert.equal(
    story.branches.find((branch) => branch.id === story.activeBranchId)?.stateSnapshot?.characters
      .find((state) => state.id === character.id)?.relationship,
    "互相信任",
  );
});

test("event append is idempotent even when the retry observes the old canon version", () => {
  const story = fixture();
  const character = story.characters.find((candidate) => !candidate.protected) ?? story.characters[0];
  character.protected = false;
  const { chapter, revisionId } = currentRevision(story);
  const input = {
    chapterNumber: chapter.number,
    revisionId,
    type: "relationship" as const,
    title: "一次握手",
    cause: "冲突暂时结束",
    outcome: "双方同意合作",
    participantIds: [character.id],
    location: character.location,
    dependsOn: [],
    storyTime: "当前时间·场景1",
    stateEffects: { characters: [{ characterId: character.id, relationship: "暂时合作" }] },
    branchId: story.activeBranchId,
    baseCanonVersion: story.canonVersion,
    idempotencyKey: "event-retry-key",
    source: "system" as const,
  };

  const first = appendStoryCoreEvent(story, input);
  const duplicate = appendStoryCoreEvent(story, input);

  assert.equal(duplicate.id, first.id);
  assert.equal(story.events.filter((event) => event.idempotencyKey === input.idempotencyKey).length, 1);
  const committed = JSON.stringify(story);
  assert.throws(() => appendStoryCoreEvent(story, { ...input, title: "复用幂等键的不同事件" }), /幂等键/);
  assert.equal(JSON.stringify(story), committed);
});

test("unknown entities, invalid dependencies, and stale commands leave the story unchanged", () => {
  const base = fixture();
  const { chapter, revisionId } = currentRevision(base);
  const command = {
    chapterNumber: chapter.number,
    revisionId,
    type: "consequence" as const,
    title: "非法事件",
    cause: "测试",
    outcome: "不应提交",
    participantIds: [base.characters[0].id],
    location: base.characters[0].location,
    dependsOn: [],
    storyTime: "当前时间·场景1",
    stateEffects: {},
    branchId: base.activeBranchId,
    baseCanonVersion: base.canonVersion,
    idempotencyKey: "invalid-event-key",
    source: "system" as const,
  };

  for (const invalid of [
    { ...command, stateEffects: { characters: [{ characterId: "missing-entity", lifecycle: "dead" as const }] } },
    { ...command, idempotencyKey: "invalid-dependency-key", dependsOn: ["missing-event"] },
    { ...command, idempotencyKey: "stale-key", baseCanonVersion: base.canonVersion - 1 },
  ]) {
    const story = structuredClone(base);
    const before = JSON.stringify(story);
    assert.throws(() => appendStoryCoreEvent(story, invalid));
    assert.equal(JSON.stringify(story), before);
  }
});

test("empty transitions and reader-authored knowledge cannot enter the event log", () => {
  const base = fixture();
  const character = base.characters[0];
  character.protected = false;
  const { chapter, revisionId } = currentRevision(base);
  const command = {
    chapterNumber: chapter.number,
    revisionId,
    type: "discovery" as const,
    title: "结构化发现",
    cause: "测试",
    outcome: "测试",
    participantIds: [character.id],
    location: character.location,
    dependsOn: [],
    storyTime: "当前时间·场景1",
    branchId: base.activeBranchId,
    baseCanonVersion: base.canonVersion,
    source: "reader" as const,
  };
  for (const stateEffects of [
    {},
    { characters: [{
      characterId: character.id,
      knowledgeGained: [{ fact: "未经可信抽取的事实", sourceChapter: chapter.number, sourceRevisionId: revisionId }],
    }] },
  ]) {
    const story = structuredClone(base);
    const before = JSON.stringify(story);
    assert.throws(() => appendStoryCoreEvent(story, {
      ...command,
      stateEffects,
      idempotencyKey: `blocked-reader-${JSON.stringify(stateEffects).length}`,
    }));
    assert.equal(JSON.stringify(story), before);
  }
});

test("reader event prose is derived from structured effects", () => {
  const story = fixture();
  const character = story.characters.find((candidate) => candidate.lifecycle === "alive");
  assert.ok(character);
  const { chapter, revisionId } = currentRevision(story);
  const narrative = describeReaderStoryEvent(story, {
    chapterNumber: chapter.number,
    revisionId,
    type: "relationship",
    participantIds: [character.id],
    location: character.location,
    dependsOn: [],
    storyTime: "当前时间·场景1",
    stateEffects: { characters: [{ characterId: character.id, relationship: "重新建立信任" }] },
    branchId: story.activeBranchId,
    baseCanonVersion: story.canonVersion,
    idempotencyKey: "reader-narrative-key",
  });

  assert.match(narrative.title, /关系变化/);
  assert.match(narrative.outcome, /重新建立信任/);
  assert.doesNotMatch(narrative.outcome, /用户自定义正文/);
});

test("a generic hard constraint rejects a conflicting event without a partial write", () => {
  const story = fixture();
  const character = story.characters.find((candidate) => candidate.lifecycle === "alive");
  assert.ok(character);
  character.protected = false;
  const constraint: StoryConstraint = {
    id: "constraint_keep_alive",
    title: `${character.name}必须存活`,
    description: "测试通用约束执行器",
    targetEntityId: character.id,
    path: "lifecycle",
    operator: "eq",
    expectedValue: "alive",
    source: "reader",
    hardness: "hard",
    scope: "branch",
    branchId: story.activeBranchId,
    status: "active",
    baseCanonVersion: story.canonVersion,
    createdAt: new Date().toISOString(),
    idempotencyKey: "keep-alive-key",
    readOnly: false,
    enforceable: true,
  };
  story.constraints.push(constraint);
  const { chapter, revisionId } = currentRevision(story);
  const before = JSON.stringify(story);

  assert.throws(() => appendStoryCoreEvent(story, {
    chapterNumber: chapter.number,
    revisionId,
    type: "death",
    title: `${character.name}死亡`,
    cause: "测试冲突",
    outcome: "不应进入正史",
    participantIds: [character.id],
    location: character.location,
    dependsOn: [],
    storyTime: "当前时间·场景1",
    stateEffects: { characters: [{ characterId: character.id, lifecycle: "dead", status: "确认死亡" }] },
    branchId: story.activeBranchId,
    baseCanonVersion: story.canonVersion,
    idempotencyKey: "blocked-death-key",
    source: "system",
  }), /约束/);
  assert.equal(JSON.stringify(story), before);
});

test("legacy stories without a constraints field remain readable without mutation", () => {
  const story = fixture() as Story & { constraints?: StoryConstraint[] };
  delete story.constraints;
  const before = JSON.stringify(story);

  const world = projectStoryWorldState(story as Story);

  assert.ok(Array.isArray(world.constraints));
  assert.equal(JSON.stringify(story), before);
});

test("branch replay clears a stale item holder when an event makes the item available", () => {
  const story = fixture();
  const item = story.items[0];
  const holder = story.characters[0];
  assert.ok(item && holder);
  item.status = "held";
  item.holderCharacterId = holder.id;
  holder.inventoryItemIds = [item.id];
  const branch = story.branches.find((candidate) => candidate.id === story.activeBranchId);
  assert.ok(branch);
  branch.baseEventSequence = Math.max(0, ...story.events.map((event) => event.sequence));
  branch.baseStateSnapshot = captureCanonState(story);
  const { chapter, revisionId } = currentRevision(story);
  story.events.push({
    id: "event_release_item",
    chapterNumber: chapter.number,
    revisionId,
    type: "consequence",
    title: "物品被放下",
    cause: "持有人主动放下",
    outcome: "物品重新可用",
    participantIds: [holder.id],
    location: holder.location,
    dependsOn: [],
    active: true,
    sequence: branch.baseEventSequence + 1,
    storyTime: "当前时间·场景1",
    branchId: story.activeBranchId,
    stateEffects: { items: [{ itemId: item.id, status: "available", location: holder.location }] },
  });

  replayBranchState(story, story.activeBranchId);

  assert.equal(story.items.find((candidate) => candidate.id === item.id)?.holderCharacterId, undefined);
  assert.ok(!story.characters.find((candidate) => candidate.id === holder.id)?.inventoryItemIds.includes(item.id));
});

test("ordinary chapter commits enforce persisted hard constraints", () => {
  const story = fixture();
  story.constraints.push({
    id: "constraint_chapter_commit_hook",
    title: "正史版本必须保持当前值",
    description: "用于验证常规章节提交也会经过 Story Core 硬约束门禁。",
    targetEntityId: `story:${story.id}`,
    path: "canonVersion",
    operator: "eq",
    expectedValue: story.canonVersion,
    source: "system",
    hardness: "hard",
    scope: "story",
    branchId: story.activeBranchId,
    baseCanonVersion: story.canonVersion,
    status: "active",
    createdAt: new Date().toISOString(),
    idempotencyKey: "chapter-constraint-hook-key",
    readOnly: false,
    enforceable: true,
  });
  const plan = planNextChapter(story);
  const generated = generateLocalChapter(story, plan);

  assert.throws(() => commitNextChapter(story, plan, generated), /约束/);
});

test("queued persistence snapshots cannot include a later uncommitted mutation", async () => {
  const store = createSeedStore();
  const firstStoryId = store.stories[0].id;
  const secondStoryId = store.stories[1].id;
  const snapshots: string[] = [];
  let attempt = 0;
  let releaseFirstWrite!: () => void;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const save = createStoreSaveQueue(async (snapshot) => {
    snapshots.push(snapshot);
    attempt += 1;
    if (attempt === 1) {
      await firstWriteGate;
      return;
    }
    throw new Error("simulated persistence failure");
  });

  store.users[0].activeStoryId = firstStoryId;
  const firstSave = save(store);
  store.users[0].activeStoryId = secondStoryId;
  const secondSave = save(store, () => {
    store.users[0].activeStoryId = firstStoryId;
  });
  const secondFailure = assert.rejects(secondSave, /simulated persistence failure/);

  releaseFirstWrite();
  await Promise.all([firstSave, secondFailure]);

  assert.equal(JSON.parse(snapshots[0]).users[0].activeStoryId, firstStoryId);
  assert.equal(JSON.parse(snapshots[1]).users[0].activeStoryId, secondStoryId);
  assert.equal(store.users[0].activeStoryId, firstStoryId);
});

test("store mutation gate prevents a failed transaction leaking into the next successful save", async () => {
  const store = createSeedStore();
  const firstStoryId = store.stories[0].id;
  const secondStoryId = store.stories[1].id;
  const acquire = createStoreMutationGate();
  const persisted: string[] = [];
  const save = createStoreSaveQueue(async (snapshot) => {
    persisted.push(snapshot);
    if (persisted.length === 1) throw new Error("first write fails");
  });

  const firstTransaction = (async () => {
    const release = await acquire();
    const previous = store.users[0].activeStoryId;
    try {
      store.users[0].activeStoryId = firstStoryId;
      await save(store, () => {
        store.users[0].activeStoryId = previous;
      });
    } finally {
      release();
    }
  })();
  const firstFailure = assert.rejects(firstTransaction, /first write fails/);
  const secondTransaction = (async () => {
    const release = await acquire();
    try {
      store.users[0].activeStoryId = secondStoryId;
      await save(store);
    } finally {
      release();
    }
  })();

  await Promise.all([firstFailure, secondTransaction]);

  assert.equal(JSON.parse(persisted[1]).users[0].activeStoryId, secondStoryId);
  assert.equal(store.users[0].activeStoryId, secondStoryId);
});

test("a consumed JSON request is not mistaken for an aborted queued request", () => {
  assert.equal(shouldAbandonQueuedRequest(
    { aborted: false, destroyed: true },
    { writableEnded: false },
  ), false);
  assert.equal(shouldAbandonQueuedRequest(
    { aborted: true, destroyed: true },
    { writableEnded: false },
  ), true);
});
