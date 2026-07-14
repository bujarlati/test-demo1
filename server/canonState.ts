import type { CanonStateSnapshot, Story, StoryEvent } from "../src/types";

export function captureCanonState(story: Story): CanonStateSnapshot {
  return {
    characters: story.characters.map((character) => ({
      id: character.id,
      status: character.status,
      lifecycle: character.lifecycle,
      location: character.location,
      goal: character.goal,
      knowledge: structuredClone(character.knowledge),
      knowledgeSources: structuredClone(character.knowledgeSources),
      relationship: character.relationship,
      role: character.role,
      inventoryItemIds: structuredClone(character.inventoryItemIds),
    })),
    items: structuredClone(story.items),
    clues: structuredClone(story.clues),
  };
}

export function restoreCanonState(story: Story, snapshot: CanonStateSnapshot) {
  for (const state of snapshot.characters) {
    const character = story.characters.find((item) => item.id === state.id);
    if (character) Object.assign(character, structuredClone(state));
  }
  story.items = structuredClone(snapshot.items);
  story.clues = structuredClone(snapshot.clues);
}

export function deriveStateEffects(before: CanonStateSnapshot, after: CanonStateSnapshot): NonNullable<StoryEvent["stateEffects"]> {
  const characters = after.characters.flatMap((state) => {
    const previous = before.characters.find((item) => item.id === state.id);
    if (!previous) return [];
    const knowledgeGained = state.knowledgeSources.filter((fact) =>
      !previous.knowledgeSources.some((item) => item.fact === fact.fact && item.sourceRevisionId === fact.sourceRevisionId),
    );
    const changed = previous.status !== state.status || previous.lifecycle !== state.lifecycle ||
      previous.location !== state.location || previous.goal !== state.goal ||
      previous.relationship !== state.relationship || previous.role !== state.role || knowledgeGained.length > 0;
    return changed ? [{
      characterId: state.id,
      status: state.status,
      lifecycle: state.lifecycle,
      location: state.location,
      goal: state.goal,
      relationship: state.relationship,
      role: state.role,
      knowledgeGained,
    }] : [];
  });
  const items = after.items.flatMap((state) => {
    const previous = before.items.find((item) => item.id === state.id);
    if (previous && previous.status === state.status && previous.holderCharacterId === state.holderCharacterId && previous.location === state.location) return [];
    return [{ itemId: state.id, status: state.status, holderCharacterId: state.holderCharacterId, location: state.location }];
  });
  const clues = after.clues.flatMap((state) => {
    const previous = before.clues.find((item) => item.id === state.id);
    return previous && previous.status !== state.status ? [{ clueId: state.id, status: state.status }] : [];
  });
  return {
    ...(characters.length ? { characters } : {}),
    ...(items.length ? { items } : {}),
    ...(clues.length ? { clues } : {}),
  };
}

export function replayBranchState(story: Story, branchId: string) {
  const branch = story.branches.find((item) => item.id === branchId);
  if (!branch) throw new Error("活动分支缺少状态快照。");
  const base = branch.baseStateSnapshot ?? branch.stateSnapshot;
  if (!base) throw new Error("活动分支没有可信状态快照，已拒绝提交修史。");
  restoreCanonState(story, base);
  const events = story.events
    .filter((event) => event.active && event.branchId === branchId && event.sequence > branch.baseEventSequence)
    .sort((a, b) => a.sequence - b.sequence);
  for (const event of events) {
    for (const effect of event.stateEffects?.characters ?? []) {
      const character = story.characters.find((item) => item.id === effect.characterId);
      if (!character) throw new Error(`事件 ${event.id} 引用未知角色状态。`);
      if (effect.status !== undefined) character.status = effect.status;
      if (effect.lifecycle !== undefined) character.lifecycle = effect.lifecycle;
      if (effect.location !== undefined) character.location = effect.location;
      if (effect.goal !== undefined) character.goal = effect.goal;
      if (effect.relationship !== undefined) character.relationship = effect.relationship;
      if (effect.role !== undefined) character.role = effect.role;
      for (const fact of effect.knowledgeGained ?? []) {
        if (!character.knowledge.includes(fact.fact)) character.knowledge.push(fact.fact);
        if (!character.knowledgeSources.some((item) => item.fact === fact.fact && item.sourceRevisionId === fact.sourceRevisionId)) {
          character.knowledgeSources.push(structuredClone(fact));
        }
      }
    }
    for (const effect of event.stateEffects?.items ?? []) {
      const item = story.items.find((candidate) => candidate.id === effect.itemId);
      if (!item) throw new Error(`事件 ${event.id} 引用未知物品状态。`);
      Object.assign(item, effect);
    }
    for (const effect of event.stateEffects?.clues ?? []) {
      const clue = story.clues.find((candidate) => candidate.id === effect.clueId);
      if (!clue) throw new Error(`事件 ${event.id} 引用未知伏笔状态。`);
      clue.status = effect.status;
    }
  }
  for (const character of story.characters) character.inventoryItemIds = [];
  for (const item of story.items.filter((candidate) => candidate.status === "held" && candidate.holderCharacterId)) {
    story.characters.find((character) => character.id === item.holderCharacterId)?.inventoryItemIds.push(item.id);
  }
  branch.stateSnapshot = captureCanonState(story);
  return branch.stateSnapshot;
}
