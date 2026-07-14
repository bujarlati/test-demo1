import { randomUUID } from "node:crypto";
import { currentRevision } from "../src/storyDomain";
import type {
  AppStore,
  CharacterProfile,
  ConversationMessage,
  RetconChange,
  RetconTransaction,
  Story,
  StoryEvent,
} from "../src/types";

function addMessage(story: Story, message: ConversationMessage) {
  story.conversation.push(message);
  story.updatedAt = message.createdAt;
}

function activeDeathEvent(story: Story, text: string): StoryEvent | undefined {
  const named = story.characters.find((character) => text.includes(character.name));
  const deaths = story.events
    .filter((event) => event.active && event.type === "death")
    .filter((event) => !named || event.participantIds.includes(named.id))
    .sort((a, b) => b.chapterNumber - a.chapterNumber);
  if (deaths[0]) return deaths[0];

  for (const chapter of [...story.chapters].reverse()) {
    const revision = currentRevision(chapter);
    if (
      !revision ||
      revision.reason.startsWith("读者否决") ||
      !/死亡|死去|断气|曲线已经归零|盖过.*脸/.test(revision.paragraphs.join(""))
    ) continue;
    const character = named ?? story.characters.find((item) => revision.paragraphs.join("").includes(item.name));
    if (!character) continue;
    const event: StoryEvent = {
      id: `event_${randomUUID().slice(0, 10)}`,
      chapterNumber: chapter.number,
      revisionId: revision.id,
      type: "death",
      title: `${character.name}在第 ${chapter.number} 章死亡`,
      cause: "从当前 Revision 正文识别到明确死亡结果",
      outcome: `${character.name}死亡并离开活动人物状态`,
      participantIds: [character.id],
      location: character.location,
      dependsOn: story.events.filter((item) => item.active && item.chapterNumber < chapter.number).slice(-1).map((item) => item.id),
      active: true,
    };
    story.events.push(event);
    return event;
  }
  return undefined;
}

function targetCharacter(story: Story, event: StoryEvent) {
  return (
    event.participantIds
      .map((id) => story.characters.find((character) => character.id === id))
      .find((character): character is CharacterProfile => Boolean(character && /死亡/.test(character.status))) ??
    event.participantIds
      .map((id) => story.characters.find((character) => character.id === id))
      .find((character): character is CharacterProfile => Boolean(character))
  );
}

function createRevisionId(story: Story, chapterNumber: number, count: number) {
  return `rev_${story.id}_${chapterNumber}_${count + 1}_${randomUUID().slice(0, 5)}`;
}

function rewriteDependentParagraphs(paragraphs: string[], name: string) {
  return paragraphs.map((paragraph) =>
    paragraph
      .replaceAll(`${name}的葬礼`, `${name}的秘密转移`)
      .replaceAll(`为${name}复仇`, `护送${name}离开`)
      .replaceAll(`${name}已经死去`, `${name}已被官方宣告死亡`)
      .replaceAll(`${name}死后`, `${name}失去身份后`),
  );
}

function applyDeathVeto(store: AppStore, story: Story, sourceText: string): ConversationMessage {
  const deathEvent = activeDeathEvent(story, sourceText);
  if (!deathEvent) {
    return {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: "当前正史里没有唯一可确认的死亡事件。请点选相关段落或说出角色名字，我只会确认这一次目标。",
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  }
  const character = targetCharacter(story, deathEvent);
  const deathChapter = story.chapters.find((chapter) => chapter.number === deathEvent.chapterNumber);
  if (!character || !deathChapter) {
    return {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: "我找到了死亡事件，但无法把它安全绑定到唯一角色，因此没有改动正史。",
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  }
  const alreadyApplied = story.retcons.some(
    (retcon) =>
      retcon.kind === "intervention" &&
      retcon.targetEventId === deathEvent.id &&
      retcon.status === "committed",
  );
  if (alreadyApplied) {
    return {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: `这次死亡已经被撤销，当前正史中${character.name}仍然存活。`,
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  }

  const createdAt = new Date().toISOString();
  const canonBefore = story.canonVersion;
  const deathParent = currentRevision(deathChapter);
  if (!deathParent) throw new Error("死亡章节缺少可回溯 Revision。");
  const setupChapter = [...story.chapters]
    .filter((chapter) => chapter.number < deathChapter.number)
    .sort((a, b) => Math.abs(a.number - Math.max(1, deathChapter.number - 6)) - Math.abs(b.number - Math.max(1, deathChapter.number - 6)))[0];
  const deathRevisionId = createRevisionId(story, deathChapter.number, deathChapter.revisions.length);
  const changes: RetconChange[] = [];

  deathChapter.revisions.push({
    id: deathRevisionId,
    parentRevisionId: deathParent.id,
    title: deathParent.title,
    paragraphs: [
      deathParent.paragraphs[0] ?? `${character.name}倒在冲突发生的地点，所有人都以为结局已经确定。`,
      `监测结果归零时，在场者把${character.name}判定为死亡；但一处来自前文的身体异常让这个结论留下了极窄的误差。`,
      `${character.name}没有毫发无损地回来。那次异常只延缓了致命结果，也让继续使用原有身份成为不可能。`,
      `为了活着离开，${character.name}必须接受被官方宣告死亡。最亲近的同伴选择配合这个谎言，并承担从此无法公开相认的代价。`,
      `${character.name}仍然活着，却永久失去原来的身份、位置与一部分信任。这份损失替代了死亡原本承担的叙事代价。`,
      `事件结束后，众人没有走向复仇，而是开始处理“一个被世界认定已经死去的人该如何继续行动”这个更危险的问题。`,
    ],
    reason: `读者否决${character.name}在第 ${deathChapter.number} 章的死亡；以身份、位置与关系损失替代死亡代价`,
    createdAt,
    modelName: "retcon-reasoner",
    promptVersion: "retcon-v5",
    changeSummary: `${character.name}存活，但被官方宣告死亡并永久失去原有身份。`,
  });
  deathChapter.currentRevisionId = deathRevisionId;
  deathChapter.hasUnreadRevision = true;
  changes.push({
    chapterNumber: deathChapter.number,
    chapterTitle: deathChapter.title,
    kind: "required",
    summary: `重写死亡结果；${character.name}存活并承担不可逆身份代价。`,
    revisionId: deathRevisionId,
    previousRevisionId: deathParent.id,
  });

  if (setupChapter) {
    const setupParent = currentRevision(setupChapter);
    if (setupParent) {
      const setupRevisionId = createRevisionId(story, setupChapter.number, setupChapter.revisions.length);
      setupChapter.revisions.push({
        id: setupRevisionId,
        parentRevisionId: setupParent.id,
        title: setupParent.title,
        paragraphs: [
          ...setupParent.paragraphs,
          `${character.name}曾被提醒：一次未记录在案的旧伤会在极端状态下造成近似死亡的低耗反应，但这种侥幸不会出现第二次。`,
        ],
        reason: `为第 ${deathChapter.number} 章存活补入最小前置依据`,
        createdAt,
        modelName: "retcon-reasoner",
        promptVersion: "retcon-v5",
        changeSummary: "补入可被误判死亡的前置依据，并明确不可重复使用。",
      });
      setupChapter.currentRevisionId = setupRevisionId;
      setupChapter.hasUnreadRevision = true;
      changes.push({
        chapterNumber: setupChapter.number,
        chapterTitle: setupChapter.title,
        kind: "supporting",
        summary: "补入一次性低耗反应的前置依据。",
        revisionId: setupRevisionId,
        previousRevisionId: setupParent.id,
      });
    }
  }

  const dependentEvents = story.events
    .filter((event) => event.active && event.dependsOn.includes(deathEvent.id))
    .sort((a, b) => a.chapterNumber - b.chapterNumber);
  for (const dependent of dependentEvents.slice(0, 3)) {
    const chapter = story.chapters.find((item) => item.number === dependent.chapterNumber);
    const parent = chapter ? currentRevision(chapter) : null;
    if (!chapter || !parent) continue;
    const paragraphs = rewriteDependentParagraphs(parent.paragraphs, character.name);
    if (paragraphs.every((paragraph, index) => paragraph === parent.paragraphs[index])) continue;
    const revisionId = createRevisionId(story, chapter.number, chapter.revisions.length);
    chapter.revisions.push({
      ...parent,
      id: revisionId,
      parentRevisionId: parent.id,
      paragraphs,
      reason: `替换依赖${character.name}死亡的后果场景`,
      createdAt,
      modelName: "retcon-reasoner",
      promptVersion: "retcon-v5",
      changeSummary: "保留独立场景，只替换依赖死亡的动机与表达。",
    });
    chapter.currentRevisionId = revisionId;
    chapter.hasUnreadRevision = true;
    dependent.outcome = rewriteDependentParagraphs([dependent.outcome], character.name)[0];
    changes.push({
      chapterNumber: chapter.number,
      chapterTitle: chapter.title,
      kind: "supporting",
      summary: "只替换依赖死亡的动机，保留其余场景。",
      revisionId,
      previousRevisionId: parent.id,
    });
  }
  if (!dependentEvents.length) {
    changes.push({
      chapterNumber: (story.chapters.at(-1)?.number ?? deathChapter.number) + 1,
      chapterTitle: "后续大纲",
      kind: "outline",
      summary: `保留${character.name}支线，把复仇或悼念功能替换为护送、隐匿与身份代价。`,
    });
  }

  const before = { status: character.status, location: character.location, role: character.role };
  const after = {
    status: "存活 · 官方死亡",
    location: `${deathEvent.location}附近的隐匿地点`,
    role: character.role.includes("前") ? character.role : `${character.role} · 身份已注销`,
  };
  Object.assign(character, after);
  deathEvent.active = false;
  const survivalEventId = `event_${randomUUID().slice(0, 10)}`;
  story.events.push({
    id: survivalEventId,
    chapterNumber: deathChapter.number,
    revisionId: deathRevisionId,
    type: "survival",
    title: `${character.name}被误判死亡后存活`,
    cause: "一次性低耗反应与同伴配合",
    outcome: `${character.name}存活，但失去原有身份、位置与公开关系`,
    participantIds: [character.id],
    location: after.location,
    dependsOn: deathEvent.dependsOn,
    active: true,
  });

  story.canonVersion += 1;
  story.unreadCanonChanges += changes.filter((change) => Boolean(change.revisionId)).length;
  story.latestExcerpt = `${character.name}仍然活着，却永久失去原来的身份、位置与一部分信任。`;
  story.endingContract.version += 1;
  story.endingContract.status = "reframed";
  story.endingContract.lastEvaluatedAt = createdAt;
  const retconId = `retcon_${randomUUID().slice(0, 8)}`;
  const retcon: RetconTransaction = {
    id: retconId,
    kind: "intervention",
    title: `撤销${character.name}在第 ${deathChapter.number} 章的死亡`,
    sourceText,
    summary: `${character.name}因前文可追溯的一次性异常而被误判死亡；存活的代价是永久失去原有身份与公开关系。`,
    createdAt,
    canonVersionBefore: canonBefore,
    canonVersionAfter: story.canonVersion,
    changes,
    cost: `L${Math.min(3, changes.filter((change) => change.revisionId).length)} · ${changes.filter((change) => change.revisionId).length} 个章节 Revision`,
    status: "committed",
    targetEventId: deathEvent.id,
    characterSnapshots: [{ characterId: character.id, before, after }],
  };
  story.retcons.unshift(retcon);
  story.conversation.forEach((message) => {
    if (message.observedCanonVersion < story.canonVersion) message.oldCanon = true;
  });
  store.jobs.unshift({
    id: `job_${randomUUID().slice(0, 7)}`,
    storyTitle: story.title,
    chapterNumber: deathChapter.number,
    task: "retcon",
    model: "retcon-reasoner",
    connectionId: story.modelConnectionId ?? "conn_platform",
    promptVersion: "retcon-v5",
    status: "completed",
    tokens: 3910,
    latencyMs: 12840,
    cost: 0.29,
    createdAt,
    filterSummary: `事件锚定 ${deathEvent.id}；影响分析命中 ${changes.length} 个节点。`,
  });
  return {
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: "system",
    type: "retcon_result",
    content: `已撤销${character.name}在第 ${deathChapter.number} 章的死亡，并完成最小必要修订。`,
    createdAt,
    observedCanonVersion: story.canonVersion,
    retconId,
  };
}

export function handleReaderMessage(store: AppStore, story: Story, text: string) {
  const createdAt = new Date().toISOString();
  addMessage(story, {
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: "user",
    type: "text",
    content: text,
    createdAt,
    observedCanonVersion: story.canonVersion,
  });

  let response: ConversationMessage;
  if (/不希望.*死|不要.*死|别让.*死|不能.*死/.test(text)) {
    response = applyDeathVeto(store, story, text);
  } else if (/太快|太慢|压抑|轻松|多看看|少一点/.test(text)) {
    const label = text.includes("太快")
      ? "放慢关系与事件推进"
      : text.includes("太慢")
        ? "提高事件推进速度"
        : text.includes("压抑")
          ? "降低连续低谷密度"
          : "近期叙事偏好";
    story.preferences.unshift({
      id: `pref_${randomUUID().slice(0, 8)}`,
      label,
      description: text,
      kind: "soft",
      confidence: 0.72,
      active: true,
    });
    response = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "preference_result",
      content: `已记为可衰减的软偏好：“${label}”。不会回改已确认正史，后续章节会逐步调整。`,
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  } else if (/为什么|怎么会|是谁|吗[？?]?$|[？?]$/.test(text)) {
    const lead = story.characters[0];
    response = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: lead
        ? `按当前正史 v${story.canonVersion}，${lead.name}的核心目标是“${lead.goal}”。依据来自人物状态与事件图；这条回答不会改变故事。`
        : "当前正史中还没有足够依据回答这个问题，我不会把猜测写成事实。",
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  } else {
    response = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: "我已记录这条读者反应。它不会直接覆盖正文；如需改变事实，我会先绑定事件并生成可追溯的正史事务。",
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  }
  addMessage(story, response);
  return response;
}

export function rollbackRetcon(story: Story, retconId: string) {
  const original = story.retcons.find((item) => item.id === retconId);
  if (!original || original.kind !== "intervention" || original.status !== "committed") {
    throw new Error("该修史事务不可回滚。");
  }
  const createdAt = new Date().toISOString();
  const canonBefore = story.canonVersion;
  const rollbackChanges: RetconChange[] = [];

  for (const change of original.changes) {
    if (!change.revisionId || !change.previousRevisionId) continue;
    const chapter = story.chapters.find((item) => item.number === change.chapterNumber);
    const previous = chapter?.revisions.find((revision) => revision.id === change.previousRevisionId);
    const current = chapter ? currentRevision(chapter) : null;
    if (!chapter || !previous || !current) continue;
    const revisionId = createRevisionId(story, chapter.number, chapter.revisions.length);
    chapter.revisions.push({
      ...previous,
      id: revisionId,
      parentRevisionId: current.id,
      reason: `回滚修史事务 ${original.id}；以新 Revision 恢复旧正史`,
      createdAt,
      modelName: "canon-rollback",
      promptVersion: "rollback-v2",
      changeSummary: `恢复 ${previous.id} 的内容；历史 Revision 未删除。`,
    });
    chapter.currentRevisionId = revisionId;
    chapter.hasUnreadRevision = true;
    rollbackChanges.push({
      chapterNumber: chapter.number,
      chapterTitle: chapter.title,
      kind: change.kind,
      summary: `通过新 Revision 恢复修史前内容（来源 ${previous.id}）。`,
      revisionId,
      previousRevisionId: current.id,
    });
  }

  for (const snapshot of original.characterSnapshots ?? []) {
    const character = story.characters.find((item) => item.id === snapshot.characterId);
    if (character) Object.assign(character, snapshot.before);
  }
  const target = original.targetEventId ? story.events.find((event) => event.id === original.targetEventId) : null;
  if (target) target.active = true;
  story.events
    .filter((event) => event.type === "survival" && event.chapterNumber === target?.chapterNumber)
    .forEach((event) => { event.active = false; });

  story.canonVersion += 1;
  story.unreadCanonChanges += rollbackChanges.length;
  story.endingContract.version += 1;
  story.endingContract.status = "needs_review";
  story.endingContract.lastEvaluatedAt = createdAt;
  const rollbackId = `retcon_${randomUUID().slice(0, 8)}`;
  const rollback: RetconTransaction = {
    id: rollbackId,
    kind: "rollback",
    title: `回滚：${original.title}`,
    sourceText: `撤销介入 ${original.id}`,
    summary: "以新的不可变 Revision 恢复修史前内容；原事务与所有历史版本均保留。",
    createdAt,
    canonVersionBefore: canonBefore,
    canonVersionAfter: story.canonVersion,
    changes: rollbackChanges,
    cost: `L${Math.min(3, rollbackChanges.length)} · ${rollbackChanges.length} 个恢复 Revision`,
    status: "committed",
    reversesRetconId: original.id,
    targetEventId: original.targetEventId,
  };
  original.status = "reversed";
  original.reversedByRetconId = rollbackId;
  story.retcons.unshift(rollback);
  story.conversation.forEach((message) => {
    if (message.observedCanonVersion < story.canonVersion) message.oldCanon = true;
  });
  story.conversation.push({
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: "system",
    type: "progress",
    content: `已创建独立回滚事务 ${rollbackId}；当前正史为 v${story.canonVersion}，原修史历史未被覆盖。`,
    createdAt,
    observedCanonVersion: story.canonVersion,
  });
  story.updatedAt = createdAt;
  return rollback;
}
