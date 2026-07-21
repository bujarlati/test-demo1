import { randomUUID } from "node:crypto";
import type {
  AppendStoryCoreEventInput,
  AppendReaderStoryEventInput,
  CreateStoryConstraintInput,
  Story,
  StoryConstraint,
  StoryConstraintValue,
  StoryCoreEntityState,
  StoryEvent,
  StoryWorldState,
} from "../src/types";
import { captureCanonState } from "./canonState";

const MAX_PERSISTED_CONSTRAINTS = 500;
const MAX_STORY_EVENTS = 2_000;
const MAX_STORY_BYTES = 20 * 1024 * 1024;
const WORLD_STATE_EVENT_WINDOW = 200;
const CONSTRAINABLE_PATHS = {
  story: new Set(["title", "genre", "tone"]),
  character: new Set(["status", "lifecycle", "location", "goal", "relationship", "role", "protected"]),
  item: new Set(["status", "holderCharacterId", "location"]),
  clue: new Set(["status"]),
} as const;

function coreError(status: number, message: string, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function storyEntityId(story: Story): string {
  return `story:${story.id}`;
}

function explicitConstraints(story: Story): StoryConstraint[] {
  return story.constraints ?? [];
}

function legacyConstraints(story: Story): StoryConstraint[] {
  const branchId = story.activeBranchId;
  const common = {
    scope: "story" as const,
    branchId,
    status: "active" as const,
    baseCanonVersion: story.canonVersion,
    createdAt: story.updatedAt,
    readOnly: true,
  };
  const rules: StoryConstraint[] = story.rules.map((rule) => ({
    ...common,
    id: `legacy_rule:${rule.id}`,
    title: rule.title,
    description: rule.description,
    targetEntityId: storyEntityId(story),
    path: `rule.${rule.id}`,
    operator: "exists",
    expectedValue: true,
    source: "legacy_rule",
    hardness: rule.hardness,
    idempotencyKey: `legacy_rule:${rule.id}`,
    enforceable: false,
  }));
  const preferences: StoryConstraint[] = story.preferences
    .filter((preference) => preference.active)
    .map((preference) => ({
      ...common,
      id: `legacy_preference:${preference.id}`,
      title: preference.label,
      description: preference.description,
      targetEntityId: storyEntityId(story),
      path: `preference.${preference.id}`,
      operator: "exists",
      expectedValue: true,
      source: "legacy_preference",
      hardness: preference.kind,
      idempotencyKey: `legacy_preference:${preference.id}`,
      enforceable: false,
    }));
  const protections: StoryConstraint[] = story.characters
    .filter((character) => character.protected)
    .map((character) => ({
      ...common,
      id: `legacy_protection:${character.id}`,
      title: `${character.name}受到角色保护`,
      description: "兼容现有角色保护能力：事件不得令该角色死亡。",
      targetEntityId: character.id,
      path: "lifecycle",
      operator: "neq",
      expectedValue: "dead",
      source: "legacy_rule",
      hardness: "hard",
      scope: "branch",
      idempotencyKey: `legacy_protection:${character.id}`,
      enforceable: true,
    }));
  return [...rules, ...preferences, ...protections];
}

function projectEntitiesAndStates(story: Story) {
  const entities = [
    { id: storyEntityId(story), kind: "story" as const, name: story.title },
    ...story.characters.map((character) => ({ id: character.id, kind: "character" as const, name: character.name })),
    ...story.items.map((item) => ({ id: item.id, kind: "item" as const, name: item.name })),
    ...story.clues.map((clue) => ({ id: clue.id, kind: "clue" as const, name: clue.title })),
  ];
  const states: StoryCoreEntityState[] = [
    {
      entityId: storyEntityId(story),
      kind: "story",
      values: {
        title: story.title,
        genre: story.genre,
        tone: story.tone,
        status: story.status,
        canonVersion: story.canonVersion,
      },
    },
    ...story.characters.map((character) => ({
      entityId: character.id,
      kind: "character" as const,
      values: {
        name: character.name,
        role: character.role,
        status: character.status,
        lifecycle: character.lifecycle,
        location: character.location,
        goal: character.goal,
        relationship: character.relationship,
        protected: character.protected,
        knowledge: structuredClone(character.knowledge),
        inventoryItemIds: structuredClone(character.inventoryItemIds),
      },
    })),
    ...story.items.map((item) => ({
      entityId: item.id,
      kind: "item" as const,
      values: {
        name: item.name,
        status: item.status,
        holderCharacterId: item.holderCharacterId,
        location: item.location,
        sourceChapter: item.sourceChapter,
        sourceRevisionId: item.sourceRevisionId,
      },
    })),
    ...story.clues.map((clue) => ({
      entityId: clue.id,
      kind: "clue" as const,
      values: {
        title: clue.title,
        status: clue.status,
        sourceChapter: clue.sourceChapter,
        description: clue.description,
        spoiler: clue.spoiler,
      },
    })),
  ];
  return { entities, states };
}

export function projectStoryWorldState(story: Story): StoryWorldState {
  const { entities, states } = projectEntitiesAndStates(story);
  const activeEvents = story.events.filter((event) => event.active && event.branchId === story.activeBranchId);
  return {
    storyId: story.id,
    branchId: story.activeBranchId,
    canonVersion: story.canonVersion,
    entities,
    states,
    events: structuredClone(activeEvents.slice(-WORLD_STATE_EVENT_WINDOW)),
    eventCount: activeEvents.length,
    constraints: structuredClone([
      ...explicitConstraints(story).filter((constraint) =>
        constraint.scope === "story" || constraint.branchId === story.activeBranchId,
      ),
      ...legacyConstraints(story),
    ]),
  };
}

function stateForEntity(story: Story, entityId: string): StoryCoreEntityState | undefined {
  return projectEntitiesAndStates(story).states.find((state) => state.entityId === entityId);
}

function readStatePath(state: StoryCoreEntityState, path: string): StoryConstraintValue | undefined {
  const parts = path.split(".");
  let value: unknown = state.values;
  for (const part of parts) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !(part in value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  if (
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) =>
      item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean"
    ))
  ) return value as StoryConstraintValue;
  return undefined;
}

function valuesEqual(left: StoryConstraintValue | undefined, right: StoryConstraintValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function satisfiesConstraint(
  stateByEntityId: ReadonlyMap<string, StoryCoreEntityState>,
  activeBranchId: string,
  constraint: StoryConstraint,
): boolean {
  if (!constraint.enforceable || constraint.status !== "active") return true;
  if (constraint.scope === "branch" && constraint.branchId !== activeBranchId) return true;
  const state = stateByEntityId.get(constraint.targetEntityId);
  if (!state) return false;
  const actual = readStatePath(state, constraint.path);
  switch (constraint.operator) {
    case "eq": return valuesEqual(actual, constraint.expectedValue);
    case "neq": return !valuesEqual(actual, constraint.expectedValue);
    case "exists": return constraint.expectedValue === false ? actual === undefined : actual !== undefined;
    case "in": return Array.isArray(constraint.expectedValue) && constraint.expectedValue.some((value) => valuesEqual(actual, value));
    case "not_in": return Array.isArray(constraint.expectedValue) && !constraint.expectedValue.some((value) => valuesEqual(actual, value));
  }
}

export function assertStoryHardConstraints(story: Story): void {
  const stateByEntityId = new Map(
    projectEntitiesAndStates(story).states.map((state) => [state.entityId, state]),
  );
  const violated = [...explicitConstraints(story), ...legacyConstraints(story)]
    .filter((constraint) => constraint.hardness === "hard" && constraint.status === "active")
    .find((constraint) => !satisfiesConstraint(stateByEntityId, story.activeBranchId, constraint));
  if (violated) {
    throw coreError(422, `正史状态违反硬约束：${violated.title}`, "HARD_CONSTRAINT_VIOLATION");
  }
}

function assertCommandTarget(story: Story, branchId: string, baseCanonVersion: number): void {
  if (branchId !== story.activeBranchId || baseCanonVersion !== story.canonVersion) {
    throw coreError(409, "正史或活动分支已更新，请刷新后重试。", "STALE_CANON");
  }
  if (!story.branches.some((branch) => branch.id === branchId)) {
    throw coreError(409, "活动分支不存在。", "UNKNOWN_BRANCH");
  }
}

function updateCanonHead(story: Story): void {
  story.canonVersion += 1;
  const branch = story.branches.find((candidate) => candidate.id === story.activeBranchId);
  if (!branch) throw coreError(409, "活动分支不存在。", "UNKNOWN_BRANCH");
  branch.headCanonVersion = story.canonVersion;
  branch.stateSnapshot = captureCanonState(story);
  story.updatedAt = new Date().toISOString();
}

function assertStorySize(story: Story): void {
  if (Buffer.byteLength(JSON.stringify(story), "utf8") > MAX_STORY_BYTES) {
    throw coreError(413, "故事的事件与约束数据已达到当前 JSON 存储上限。", "STORY_STORAGE_LIMIT_REACHED");
  }
}

export function createStoryConstraint(story: Story, input: CreateStoryConstraintInput): StoryConstraint {
  const duplicate = explicitConstraints(story).find((constraint) => constraint.idempotencyKey === input.idempotencyKey);
  if (duplicate) {
    const sameCommand = JSON.stringify([
      duplicate.title,
      duplicate.description,
      duplicate.targetEntityId,
      duplicate.path,
      duplicate.operator,
      duplicate.expectedValue,
      duplicate.source,
      duplicate.hardness,
      duplicate.scope,
      duplicate.branchId,
      duplicate.baseCanonVersion,
    ]) === JSON.stringify([
      input.title,
      input.description,
      input.targetEntityId,
      input.path,
      input.operator,
      input.expectedValue,
      input.source,
      input.hardness,
      input.scope,
      input.branchId,
      input.baseCanonVersion,
    ]);
    if (!sameCommand) throw coreError(409, "幂等键已用于不同的约束请求。", "IDEMPOTENCY_CONFLICT");
    return duplicate;
  }
  assertCommandTarget(story, input.branchId, input.baseCanonVersion);
  if (explicitConstraints(story).length >= MAX_PERSISTED_CONSTRAINTS) {
    throw coreError(409, `每个故事最多保存 ${MAX_PERSISTED_CONSTRAINTS} 条通用约束。`, "CONSTRAINT_LIMIT_REACHED");
  }
  const state = stateForEntity(story, input.targetEntityId);
  if (!state) throw coreError(422, "约束引用了未知实体。", "UNKNOWN_ENTITY");
  if (!CONSTRAINABLE_PATHS[state.kind].has(input.path)) {
    throw coreError(422, "该状态路径不允许创建通用约束。", "UNSUPPORTED_CONSTRAINT_PATH");
  }
  const currentValue = readStatePath(state, input.path);
  const describesRequiredAbsence = input.operator === "exists" && input.expectedValue === false;
  if (currentValue === undefined && !describesRequiredAbsence) {
    throw coreError(422, "约束引用了实体上不存在的状态路径。", "UNKNOWN_STATE_PATH");
  }
  if ((input.operator === "in" || input.operator === "not_in") && !Array.isArray(input.expectedValue)) {
    throw coreError(422, "集合约束必须提供数组值。", "INVALID_CONSTRAINT_VALUE");
  }
  if (input.operator === "exists" && typeof input.expectedValue !== "boolean") {
    throw coreError(422, "存在性约束必须提供布尔值。", "INVALID_CONSTRAINT_VALUE");
  }
  const constraint: StoryConstraint = {
    ...structuredClone(input),
    id: `constraint_${randomUUID().slice(0, 12)}`,
    status: "active",
    createdAt: new Date().toISOString(),
    readOnly: false,
    enforceable: true,
  };
  const working = structuredClone(story);
  working.constraints ??= [];
  working.constraints.push(constraint);
  updateCanonHead(working);
  assertStoryHardConstraints(working);
  assertStorySize(working);
  Object.assign(story, working);
  return story.constraints.find((candidate) => candidate.id === constraint.id)!;
}

function assertEventReferences(story: Story, input: AppendStoryCoreEventInput): void {
  const entityIds = new Set(projectEntitiesAndStates(story).entities.map((entity) => entity.id));
  for (const participantId of input.participantIds) {
    if (!entityIds.has(participantId) || !story.characters.some((character) => character.id === participantId)) {
      throw coreError(422, "事件参与者必须引用已知角色实体。", "UNKNOWN_ENTITY");
    }
  }
  for (const dependencyId of input.dependsOn) {
    if (!story.events.some((event) => event.id === dependencyId && event.active && event.branchId === input.branchId)) {
      throw coreError(422, "事件依赖不存在、已失效或属于其他分支。", "INVALID_EVENT_DEPENDENCY");
    }
  }
  const chapter = story.chapters.find((candidate) => candidate.number === input.chapterNumber);
  const revision = chapter?.revisions.find((candidate) => candidate.id === input.revisionId);
  const branch = story.branches.find((candidate) => candidate.id === input.branchId);
  if (!chapter || !revision || branch?.chapterRevisionIds[chapter.id] !== input.revisionId) {
    throw coreError(422, "事件必须绑定活动分支当前采用的章节修订。", "INVALID_REVISION");
  }
  for (const effect of input.stateEffects?.characters ?? []) {
    if (!story.characters.some((character) => character.id === effect.characterId)) {
      throw coreError(422, "事件状态变化引用了未知角色。", "UNKNOWN_ENTITY");
    }
    for (const fact of effect.knowledgeGained ?? []) {
      if (input.source === "reader") {
        throw coreError(403, "读者事件不能直接写入可信知识账本。", "READER_KNOWLEDGE_WRITE_FORBIDDEN");
      }
      if (fact.sourceChapter !== input.chapterNumber || fact.sourceRevisionId !== input.revisionId) {
        throw coreError(422, "新增知识的来源必须与事件绑定的章节修订一致。", "INVALID_KNOWLEDGE_PROVENANCE");
      }
    }
  }
  for (const effect of input.stateEffects?.items ?? []) {
    if (!story.items.some((item) => item.id === effect.itemId)) {
      throw coreError(422, "事件状态变化引用了未知物品。", "UNKNOWN_ENTITY");
    }
    if (effect.holderCharacterId && !story.characters.some((character) => character.id === effect.holderCharacterId)) {
      throw coreError(422, "物品状态引用了未知持有人。", "UNKNOWN_ENTITY");
    }
    if ((effect.status === "held") !== Boolean(effect.holderCharacterId)) {
      throw coreError(422, "只有被持有的物品可以设置持有人，且被持有物品必须有持有人。", "INVALID_ITEM_STATE");
    }
  }
  for (const effect of input.stateEffects?.clues ?? []) {
    if (!story.clues.some((clue) => clue.id === effect.clueId)) {
      throw coreError(422, "事件状态变化引用了未知伏笔。", "UNKNOWN_ENTITY");
    }
  }
  for (const [label, ids] of [
    ["参与者", input.participantIds],
    ["依赖事件", input.dependsOn],
    ["角色状态", (input.stateEffects?.characters ?? []).map((effect) => effect.characterId)],
    ["物品状态", (input.stateEffects?.items ?? []).map((effect) => effect.itemId)],
    ["伏笔状态", (input.stateEffects?.clues ?? []).map((effect) => effect.clueId)],
  ] as const) {
    if (new Set(ids).size !== ids.length) throw coreError(422, `${label}不能重复。`, "DUPLICATE_EVENT_REFERENCE");
  }
  const deaths = (input.stateEffects?.characters ?? []).filter((effect) => effect.lifecycle === "dead");
  if (input.type === "death" && deaths.length === 0) {
    throw coreError(422, "死亡事件必须包含角色死亡状态变化。", "INVALID_DEATH_EVENT");
  }
  if (input.type !== "death" && deaths.length > 0) {
    throw coreError(422, "角色死亡状态变化必须使用死亡事件类型。", "INVALID_DEATH_EVENT");
  }
  if (deaths.some((effect) => !input.participantIds.includes(effect.characterId))) {
    throw coreError(422, "死亡状态变化必须属于事件参与者。", "INVALID_DEATH_EVENT");
  }
}

function applyEventEffects(story: Story, event: StoryEvent): void {
  for (const effect of event.stateEffects?.characters ?? []) {
    const character = story.characters.find((candidate) => candidate.id === effect.characterId)!;
    if (effect.status !== undefined) character.status = effect.status;
    if (effect.lifecycle !== undefined) character.lifecycle = effect.lifecycle;
    if (effect.location !== undefined) character.location = effect.location;
    if (effect.goal !== undefined) character.goal = effect.goal;
    if (effect.relationship !== undefined) character.relationship = effect.relationship;
    if (effect.role !== undefined) character.role = effect.role;
    for (const fact of effect.knowledgeGained ?? []) {
      if (!character.knowledge.includes(fact.fact)) character.knowledge.push(fact.fact);
      if (!character.knowledgeSources.some((candidate) =>
        candidate.fact === fact.fact && candidate.sourceRevisionId === fact.sourceRevisionId
      )) character.knowledgeSources.push(structuredClone(fact));
    }
  }
  for (const effect of event.stateEffects?.items ?? []) {
    const item = story.items.find((candidate) => candidate.id === effect.itemId)!;
    item.status = effect.status;
    item.location = effect.location;
    if (effect.holderCharacterId) item.holderCharacterId = effect.holderCharacterId;
    else delete item.holderCharacterId;
  }
  for (const effect of event.stateEffects?.clues ?? []) {
    story.clues.find((candidate) => candidate.id === effect.clueId)!.status = effect.status;
  }
  for (const character of story.characters) character.inventoryItemIds = [];
  for (const item of story.items) {
    if (item.status === "held" && item.holderCharacterId) {
      story.characters.find((character) => character.id === item.holderCharacterId)?.inventoryItemIds.push(item.id);
    }
  }
}

export function describeReaderStoryEvent(
  story: Story,
  input: AppendReaderStoryEventInput,
): Pick<AppendStoryCoreEventInput, "title" | "cause" | "outcome"> {
  const typeLabels: Record<AppendStoryCoreEventInput["type"], string> = {
    discovery: "发现",
    choice: "选择",
    relationship: "关系变化",
    death: "死亡",
    survival: "幸存",
    consequence: "后果",
  };
  const characterNames = new Map(story.characters.map((character) => [character.id, character.name]));
  const itemNames = new Map(story.items.map((item) => [item.id, item.name]));
  const clueNames = new Map(story.clues.map((clue) => [clue.id, clue.title]));
  const participants = input.participantIds.map((id) => characterNames.get(id) ?? id).join("、") || "世界状态";
  const changes: string[] = [];
  for (const effect of input.stateEffects.characters ?? []) {
    const fields = [
      effect.status !== undefined ? `状态=${effect.status}` : "",
      effect.lifecycle !== undefined ? `生命状态=${effect.lifecycle}` : "",
      effect.location !== undefined ? `位置=${effect.location}` : "",
      effect.goal !== undefined ? `目标=${effect.goal}` : "",
      effect.relationship !== undefined ? `关系=${effect.relationship}` : "",
      effect.role !== undefined ? `角色=${effect.role}` : "",
    ].filter(Boolean).join("，");
    if (fields) changes.push(`${characterNames.get(effect.characterId) ?? effect.characterId}：${fields}`);
  }
  for (const effect of input.stateEffects.items ?? []) {
    changes.push(`${itemNames.get(effect.itemId) ?? effect.itemId}：状态=${effect.status}，位置=${effect.location}`);
  }
  for (const effect of input.stateEffects.clues ?? []) {
    changes.push(`${clueNames.get(effect.clueId) ?? effect.clueId}：伏笔状态=${effect.status}`);
  }
  return {
    title: `${typeLabels[input.type]}：${participants}`.slice(0, 200),
    cause: "读者通过 Story Core API 提交了结构化世界状态变更。",
    outcome: changes.join("；").slice(0, 1_000),
  };
}

export function appendStoryCoreEvent(story: Story, input: AppendStoryCoreEventInput): StoryEvent {
  const duplicate = story.events.find((event) => event.idempotencyKey === input.idempotencyKey);
  if (duplicate) {
    const sameCommand = JSON.stringify([
      duplicate.chapterNumber,
      duplicate.revisionId,
      duplicate.type,
      duplicate.title,
      duplicate.cause,
      duplicate.outcome,
      duplicate.participantIds,
      duplicate.location,
      duplicate.dependsOn,
      duplicate.storyTime,
      duplicate.stateEffects,
      duplicate.branchId,
      duplicate.baseCanonVersion,
      duplicate.source,
    ]) === JSON.stringify([
      input.chapterNumber,
      input.revisionId,
      input.type,
      input.title,
      input.cause,
      input.outcome,
      input.participantIds,
      input.location,
      input.dependsOn,
      input.storyTime,
      input.stateEffects,
      input.branchId,
      input.baseCanonVersion,
      input.source,
    ]);
    if (!sameCommand) throw coreError(409, "幂等键已用于不同的事件请求。", "IDEMPOTENCY_CONFLICT");
    return duplicate;
  }
  assertCommandTarget(story, input.branchId, input.baseCanonVersion);
  if (story.events.length >= MAX_STORY_EVENTS) {
    throw coreError(409, `每个故事最多保存 ${MAX_STORY_EVENTS} 个事件。`, "EVENT_LIMIT_REACHED");
  }
  assertEventReferences(story, input);

  const working = structuredClone(story);
  let maxSequence = 0;
  for (const existing of working.events) maxSequence = Math.max(maxSequence, existing.sequence);
  const sequence = maxSequence + 1;
  const event: StoryEvent = {
    id: `event_${randomUUID().slice(0, 12)}`,
    chapterNumber: input.chapterNumber,
    revisionId: input.revisionId,
    type: input.type,
    title: input.title,
    cause: input.cause,
    outcome: input.outcome,
    participantIds: structuredClone(input.participantIds),
    location: input.location,
    dependsOn: structuredClone(input.dependsOn),
    active: true,
    sequence,
    storyTime: input.storyTime,
    branchId: input.branchId,
    source: input.source,
    stateEffects: structuredClone(input.stateEffects),
    idempotencyKey: input.idempotencyKey,
    baseCanonVersion: input.baseCanonVersion,
    createdAt: new Date().toISOString(),
  };
  const stateBefore = JSON.stringify(captureCanonState(working));
  applyEventEffects(working, event);
  if (JSON.stringify(captureCanonState(working)) === stateBefore) {
    throw coreError(422, "事件必须产生至少一项真实世界状态变化。", "EMPTY_EVENT_EFFECT");
  }
  working.events.push(event);
  updateCanonHead(working);
  assertStoryHardConstraints(working);
  assertStorySize(working);
  Object.assign(story, working);
  return story.events.find((candidate) => candidate.id === event.id)!;
}
