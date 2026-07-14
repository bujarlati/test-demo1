import { randomUUID } from "node:crypto";
import { currentRevision } from "../src/storyDomain";
import type {
  AppStore,
  CharacterProfile,
  ConversationMessage,
  RetconChange,
  RetconTransaction,
  ReaderMessageContext,
  InterventionProposal,
  Story,
  StoryEvent,
} from "../src/types";
import { captureCanonState, replayBranchState, restoreCanonState } from "./canonState";
import { rebuildBranchSummaries } from "./storyService";

function addMessage(story: Story, message: ConversationMessage) {
  let thread = story.conversationThreads.find((item) => item.branchId === story.activeBranchId);
  if (!thread) {
    thread = { id: `thread_${randomUUID().slice(0, 8)}`, branchId: story.activeBranchId, summary: null, summaries: [], parentThreadId: null };
    story.conversationThreads.push(thread);
  }
  message.branchId = story.activeBranchId;
  message.threadId = thread.id;
  story.conversation.push(message);
  const branchMessages = story.conversation.filter((item) => item.branchId === story.activeBranchId);
  const summarized = branchMessages.slice(0, -4).slice(-12);
  if (summarized.length) {
    const previousSummary = thread.summary;
    const nextSummary = {
      id: `summary_${randomUUID().slice(0, 8)}`,
      branchId: story.activeBranchId,
      content: summarized.map((item) => `${item.role === "user" ? "读者" : "系统"}：${item.content}`).join("；").slice(-900),
      sourceMessageIds: summarized.map((item) => item.id),
      fromMessageId: summarized[0].id,
      toMessageId: summarized.at(-1)!.id,
      updatedAt: message.createdAt,
      version: (previousSummary?.version ?? 0) + 1,
      parentSummaryId: previousSummary?.id ?? null,
      sourceThreadId: thread.id,
    };
    thread.summaries.push(nextSummary);
    thread.summaries = thread.summaries.slice(-20);
    thread.summary = nextSummary;
  }
  story.updatedAt = message.createdAt;
}

function activeDeathEvent(
  story: Story,
  text: string,
  context?: ReaderMessageContext,
): StoryEvent | undefined {
  if (context?.eventId) {
    const anchored = story.events.find((event) => event.id === context.eventId && event.active && event.branchId === story.activeBranchId);
    if (anchored?.type === "death") return anchored;
  }
  const named = story.characters.find((character) => text.includes(character.name));
  const deaths = story.events
    .filter((event) => event.active && event.branchId === story.activeBranchId && event.type === "death")
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
      dependsOn: story.events.filter((item) => item.active && item.branchId === story.activeBranchId && item.chapterNumber < chapter.number).slice(-1).map((item) => item.id),
      active: true,
      sequence: Math.max(0, ...story.events.map((item) => item.sequence)) + 1,
      storyTime: `第${chapter.number}章·死亡结果`,
      branchId: story.activeBranchId,
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
      .find((character): character is CharacterProfile => Boolean(character && character.lifecycle === "dead")) ??
    event.participantIds
      .map((id) => story.characters.find((character) => character.id === id))
      .find((character): character is CharacterProfile => Boolean(character))
  );
}

function createRevisionId(story: Story, chapterNumber: number, count: number) {
  return `rev_${story.id}_${chapterNumber}_${count + 1}_${randomUUID().slice(0, 5)}`;
}

function recordBranchRevision(story: Story, chapterId: string, revisionId: string) {
  const branch = story.branches.find((item) => item.id === story.activeBranchId);
  if (branch) branch.chapterRevisionIds[chapterId] = revisionId;
}

function rewriteDependentParagraphs(paragraphs: string[], name: string) {
  return paragraphs.map((paragraph) =>
    paragraph
      .replaceAll(`${name}的葬礼`, `${name}的秘密转移`)
      .replaceAll(`为${name}复仇`, `护送${name}离开`)
      .replaceAll(`${name}已经死去`, `${name}已被官方宣告死亡`)
      .replaceAll(`${name}死亡后`, `${name}被官方宣告死亡并秘密转移后`)
      .replaceAll(`${name}的死亡`, `${name}的官方死亡记录`)
      .replaceAll(`${name}死亡`, `${name}被官方宣告死亡并秘密转移`)
      .replaceAll(`${name}死后`, `${name}失去身份后`)
      .replaceAll("复仇对象", "追查对象"),
  );
}

function deathRepairStrategy(event: StoryEvent) {
  const context = `${event.title} ${event.cause} ${event.outcome}`;
  if (/溺水|缺氧|氧气|海水|窒息/.test(context)) {
    return {
      mechanism: "低温与残余气囊让生命体征短暂低于监测阈值",
      setup: "曾有一次低温环境下生命体征被设备漏报的医疗记录",
      supportPattern: /低温|气囊|漏报|生命体征.*异常/,
      cost: "肺部留下不可逆损伤，此后无法再承受深潜或长时间缺氧",
    };
  }
  if (/枪|刀|刺|弹|武器|失血/.test(context)) {
    return {
      mechanism: "防护夹层改变了创口路径，但没有消除失血与器官损伤",
      setup: "角色此前更换过一件带旧式夹层的防护装备",
      supportPattern: /防护|夹层|护甲|旧伤/,
      cost: "永久失去原有行动能力，并因治疗记录暴露而注销身份",
    };
  }
  if (/爆炸|火|坍塌|燃烧/.test(context)) {
    return {
      mechanism: "结构坍塌形成的狭窄空腔隔开了致命冲击，却造成严重灼伤",
      setup: "现场图曾标出一处不符合施工记录的承重空腔",
      supportPattern: /空腔|承重|施工图|隔热/,
      cost: "身体留下永久伤残，原有身份也因救援记录被迫终止",
    };
  }
  if (/坠|跌落|高处/.test(context)) {
    return {
      mechanism: "坠落途中被隐蔽检修架截住，公开视角只看见角色消失",
      setup: "场景旧图记录过一层被封存的检修架",
      supportPattern: /检修架|旧图|缓冲|安全绳/,
      cost: "脊柱受伤并失去公开行动能力，必须长期隐匿接受治疗",
    };
  }
  return {
    mechanism: "现场判定依赖的单一监测信号存在可追溯误差",
    setup: "此前检查记录过一次不会重复出现的监测误差",
    supportPattern: /监测误差|误判|旧伤|医疗记录/,
    cost: "角色虽然存活，却永久失去原有身份、位置与一部分信任",
  };
}

function deathConclusionTargetsCharacter(sentence: string, characterName: string, allCharacterNames: string[]) {
  const deathPattern = /死亡|死去|断气|曲线(?:已经)?归零|白布盖过|最后一点体温|确认死亡/g;
  for (const match of sentence.matchAll(deathPattern)) {
    const matchIndex = match.index;
    const clauseStart = Math.max(
      sentence.lastIndexOf("，", matchIndex),
      sentence.lastIndexOf(",", matchIndex),
      sentence.lastIndexOf("；", matchIndex),
      sentence.lastIndexOf(";", matchIndex),
      sentence.lastIndexOf("：", matchIndex),
      sentence.lastIndexOf(":", matchIndex),
    ) + 1;
    const nextSeparators = ["，", ",", "；", ";", "：", ":", "。", "！", "？"]
      .map((separator) => sentence.indexOf(separator, matchIndex + match[0].length))
      .filter((index) => index >= 0);
    const clauseEnd = nextSeparators.length ? Math.min(...nextSeparators) : sentence.length;
    const clause = sentence.slice(clauseStart, clauseEnd);
    const names = allCharacterNames
      .flatMap((name) => {
        const positions: number[] = [];
        let from = 0;
        while (from < clause.length) {
          const index = clause.indexOf(name, from);
          if (index < 0) break;
          positions.push(index);
          from = index + name.length;
        }
        return positions.map((index) => ({ name, index: clauseStart + index, end: clauseStart + index + name.length }));
      });
    let boundName: string | undefined;
    if (match[0].startsWith("白布盖过")) {
      const prefix = sentence.slice(clauseStart, matchIndex);
      boundName = names.find((name) => {
        const localName = name.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`把[^，,；;：:。！？!?]{0,12}${localName}(?:的)?(?:脸|面孔|身体)[^，,；;：:。！？!?]{0,12}$`).test(prefix) ||
          new RegExp(`${localName}(?:的)?(?:脸|面孔|身体)[^，,；;：:。！？!?]{0,8}(?:被|让|由)?$`).test(prefix);
      })?.name;
      const followingNames = names
        .filter((name) => name.index >= matchIndex + match[0].length)
        .sort((left, right) => left.index - right.index);
      boundName ??= followingNames.find((name) => name.name === characterName)?.name ?? followingNames[0]?.name;
    } else if (/死亡|死去|断气|确认死亡/.test(match[0])) {
      boundName = names
        .filter((name) => name.end <= matchIndex)
        .sort((left, right) => right.end - left.end)[0]?.name;
      if (!boundName) {
        boundName = names
          .filter((name) => name.index >= matchIndex + match[0].length)
          .sort((left, right) => left.index - right.index)[0]?.name;
      }
    } else {
      boundName = names.find((name) => {
        const between = sentence.slice(name.end, matchIndex);
        return name.end <= matchIndex && /^(?:的|其)?[^，,；;：:。！？!?]{0,8}$/.test(between);
      })?.name;
    }
    if ((boundName ?? characterName) === characterName) return true;
  }
  return false;
}

function repairDeathChapter(
  paragraphs: string[],
  character: CharacterProfile,
  strategy: ReturnType<typeof deathRepairStrategy>,
  allCharacterNames: string[],
) {
  let repairedDeathSentence = false;
  const repaired = paragraphs.map((paragraph) => {
    const sentences = paragraph.match(/[^。！？!?]+[。！？!?]?/g) ?? [paragraph];
    const next = sentences.map((sentence) => {
      const containsDeathConclusion = /死亡|死去|断气|曲线已经归零|曲线归零|白布盖过|最后一点体温/.test(sentence);
      const referencesTarget = deathConclusionTargetsCharacter(sentence, character.name, allCharacterNames);
      const onlyReferencesAnotherCharacter = !referencesTarget;
      if (!containsDeathConclusion || onlyReferencesAnotherCharacter) return sentence;
      const whiteCover = sentence.match(/白布盖过([^，,；;。！？!?]{1,48}?)(?:的)?(?:脸|面孔)/);
      if (whiteCover) {
        const coveredNames = allCharacterNames.filter((name) => whiteCover[1].includes(name));
        const otherCoveredNames = coveredNames.filter((name) => name !== character.name);
        if (coveredNames.includes(character.name) && otherCoveredNames.length > 0) {
          let preservedObjects = whiteCover[1]
            .replace(character.name, "")
            .replace(/^[与和及、跟同]+|[与和及、跟同]+$/g, "")
            .trim();
          if (!preservedObjects) preservedObjects = otherCoveredNames.join("与");
          const targetRepair = repairedDeathSentence
            ? `${character.name}的体温与读数仍低到仪器无法辨认，同伴只能在封锁完成前将她转移。`
            : `${character.name}的生命体征一度被现场判定为死亡；但${strategy.mechanism}。${strategy.cost}。`;
          repairedDeathSentence = true;
          const suffix = sentence.slice((whiteCover.index ?? 0) + whiteCover[0].length);
          const positionedRepair = /^[，,]/.test(suffix) ? targetRepair.replace(/[。！？!?]$/, "") : targetRepair;
          return sentence.replace(whiteCover[0], `白布盖过${preservedObjects}的脸；${positionedRepair}`);
        }
      }
      if (!repairedDeathSentence) {
        repairedDeathSentence = true;
        return `${character.name}的生命体征一度被现场判定为死亡；但${strategy.mechanism}。${strategy.cost}。`;
      }
      return `${character.name}的体温与读数仍低到仪器无法辨认，同伴只能在封锁完成前将她转移。`;
    }).join("");
    return rewriteDependentParagraphs([next], character.name)[0];
  });
  if (!repairedDeathSentence) {
    const index = Math.max(0, repaired.length - 1);
    repaired[index] = `${repaired[index]} ${character.name}一度被判定死亡；但${strategy.mechanism}。${strategy.cost}。`;
  }
  return repaired;
}

function assertRetconRevisionComplies(
  story: Story,
  before: string[],
  after: string[],
  character: CharacterProfile,
  strategy: ReturnType<typeof deathRepairStrategy>,
) {
  if (before.length !== after.length) throw new Error("修史扩大了章节段落范围，已拒绝提交。");
  const content = after.join("\n");
  if (!content.includes(strategy.mechanism) || !content.includes(strategy.cost)) {
    throw new Error("修史没有落实存活机制与不可逆代价，已拒绝提交。");
  }
  if (/原来只是梦|一切都是梦|死而复生|复活术/.test(content)) {
    throw new Error("修史违反世界硬规则，已拒绝提交。");
  }
  const residualDeathConclusion = content
    .split(/(?<=[，,；;：:。！？!?])/)
    .some((clause) => {
      if (!/曲线(?:已经)?归零|白布盖过|最后一点体温|已经死去|确认死亡/.test(clause)) return false;
      return deathConclusionTargetsCharacter(clause, character.name, story.characters.map((item) => item.name));
    });
  if (residualDeathConclusion) {
    throw new Error("修史仍保留目标角色的死亡结论，已拒绝提交。" );
  }
  for (const preference of story.preferences.filter((item) => item.active && item.kind === "hard")) {
    if (/洗白|免责/.test(`${preference.label}${preference.description}`) && /无罪|获得原谅|无需负责/.test(content)) {
      throw new Error(`修史违反读者硬约束“${preference.label}”，已拒绝提交。`);
    }
  }
  const preserved = before.filter((paragraph, index) => paragraph === after[index]).length;
  if (before.length > 1 && preserved === 0) throw new Error(`修史没有保留${character.name}死亡之外的独立场景，已拒绝提交。`);
}

function applyDeathVeto(
  store: AppStore,
  story: Story,
  sourceText: string,
  proposal: InterventionProposal,
  context?: ReaderMessageContext,
): ConversationMessage {
  const matchedDeathEvent = activeDeathEvent(story, sourceText, context);
  if (!matchedDeathEvent) {
    proposal.status = "rejected";
    return {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: "当前正史里没有唯一可确认的死亡事件。请点选相关段落或说出角色名字，我只会确认这一次目标。",
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  }
  let deathEvent: StoryEvent = matchedDeathEvent;
  const character = targetCharacter(story, deathEvent);
  const deathChapter = story.chapters.find((chapter) => chapter.number === deathEvent.chapterNumber);
  if (!character || !deathChapter) {
    proposal.status = "rejected";
    return {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: "我找到了死亡事件，但无法把它安全绑定到唯一角色，因此没有改动正史。",
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  }
  proposal.targetEventId = deathEvent.id;
  proposal.chapterId = deathChapter.id;
  proposal.revisionId = deathEvent.revisionId;
  const alreadyApplied = story.retcons.some(
    (retcon) =>
      retcon.kind === "intervention" &&
      retcon.targetEventId === deathEvent.id &&
      retcon.status === "committed",
  );
  if (alreadyApplied) {
    proposal.status = "recorded";
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
  const branchIdBefore = story.activeBranchId;
  const trustedStateBefore = captureCanonState(story);
  const sourceBranch = story.branches.find((branch) => branch.id === branchIdBefore);
  const sourceBaseEventSequence = sourceBranch?.baseEventSequence ?? Number.MAX_SAFE_INTEGER;
  const sourceBaseStateSnapshot = sourceBranch?.baseStateSnapshot;
  if (!sourceBaseStateSnapshot || sourceBaseEventSequence >= deathEvent.sequence) {
    throw new Error("当前故事缺少死亡事件前的可信状态快照，已拒绝提交可能污染人物状态的修史。");
  }
  if (sourceBranch) {
    sourceBranch.stateSnapshot = structuredClone(trustedStateBefore);
  }
  const latestChapterNumber = story.chapters.at(-1)?.number ?? deathChapter.number;
  if (latestChapterNumber > deathChapter.number) {
    const previousBranch = story.branches.find((branch) => branch.id === story.activeBranchId);
    if (previousBranch) previousBranch.status = "superseded";
    const branchId = `branch_${story.id}_retcon_${randomUUID().slice(0, 6)}`;
    story.branches.push({
      id: branchId,
      name: `从第 ${deathChapter.number} 章改写`,
      basedOnBranchId: story.activeBranchId,
      baseCanonVersion: canonBefore,
      headCanonVersion: canonBefore,
      createdAt,
      status: "active",
      chapterRevisionIds: structuredClone(previousBranch?.chapterRevisionIds ?? Object.fromEntries(story.chapters.map((chapter) => [chapter.id, chapter.currentRevisionId]))),
      baseStateSnapshot: structuredClone(sourceBaseStateSnapshot),
      stateSnapshot: structuredClone(trustedStateBefore),
      baseEventSequence: sourceBaseEventSequence,
    });
    story.activeBranchId = branchId;
    const parentThread = story.conversationThreads.find((item) => item.branchId === branchIdBefore);
    const thread = { id: `thread_${randomUUID().slice(0, 8)}`, branchId, summary: null, summaries: [], parentThreadId: parentThread?.id ?? null };
    story.conversationThreads.push(thread);
    const sourceMessage = story.conversation.find((message) => message.id === proposal.sourceMessageId);
    if (sourceMessage) {
      sourceMessage.branchId = branchId;
      sourceMessage.threadId = thread.id;
    }
    const inheritedEvents = story.events.filter((event) => event.active && event.branchId === branchIdBefore);
    const eventIdMap = new Map(inheritedEvents.map((event) => [event.id, `event_${randomUUID().slice(0, 10)}`]));
    const clonedEvents = inheritedEvents.map((event) => ({
      ...structuredClone(event),
      id: eventIdMap.get(event.id)!,
      originEventId: event.originEventId ?? event.id,
      branchId,
      dependsOn: event.dependsOn.map((dependencyId) => eventIdMap.get(dependencyId) ?? dependencyId),
    }));
    story.events.push(...clonedEvents);
    const clonedDeathId = eventIdMap.get(deathEvent.id);
    deathEvent = clonedEvents.find((event) => event.id === clonedDeathId) ?? deathEvent;
    proposal.targetEventId = deathEvent.id;
  }
  const deathParent = currentRevision(deathChapter);
  if (!deathParent) throw new Error("死亡章节缺少可回溯 Revision。");
  const strategy = deathRepairStrategy(deathEvent);
  const supportExists = story.chapters
    .filter((chapter) => chapter.number < deathChapter.number)
    .some((chapter) => strategy.supportPattern.test(currentRevision(chapter)?.paragraphs.join("\n") ?? ""));
  const setupChapter = supportExists ? undefined : [...story.chapters]
    .filter((chapter) => chapter.number < deathChapter.number)
    .sort((a, b) => Math.abs(a.number - Math.max(1, deathChapter.number - 6)) - Math.abs(b.number - Math.max(1, deathChapter.number - 6)))[0];
  const deathRevisionId = createRevisionId(story, deathChapter.number, deathChapter.revisions.length);
  const changes: RetconChange[] = [];
  const eventSnapshots: NonNullable<RetconTransaction["eventSnapshots"]> = [];

  const repairedDeathParagraphs = repairDeathChapter(deathParent.paragraphs, character, strategy, story.characters.map((item) => item.name));
  assertRetconRevisionComplies(story, deathParent.paragraphs, repairedDeathParagraphs, character, strategy);
  deathChapter.revisions.push({
    id: deathRevisionId,
    parentRevisionId: deathParent.id,
    title: deathParent.title,
    paragraphs: repairedDeathParagraphs,
    reason: `读者否决${character.name}在第 ${deathChapter.number} 章的死亡；以身份、位置与关系损失替代死亡代价`,
    createdAt,
    modelName: "retcon-reasoner",
    promptVersion: "retcon-v5",
    changeSummary: `${character.name}存活，但被官方宣告死亡并永久失去原有身份。`,
    branchId: story.activeBranchId,
  });
  deathChapter.currentRevisionId = deathRevisionId;
  recordBranchRevision(story, deathChapter.id, deathRevisionId);
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
          `${character.name}的旧记录曾提到：${strategy.setup}；这种条件只在本次事件成立，不会成为可重复使用的免死规则。`,
        ],
        reason: `为第 ${deathChapter.number} 章存活补入最小前置依据`,
        createdAt,
        modelName: "retcon-reasoner",
        promptVersion: "retcon-v5",
        changeSummary: `补入“${strategy.setup}”的前置依据，并明确不可重复使用。`,
        branchId: story.activeBranchId,
      });
      setupChapter.currentRevisionId = setupRevisionId;
      recordBranchRevision(story, setupChapter.id, setupRevisionId);
      setupChapter.hasUnreadRevision = true;
      changes.push({
        chapterNumber: setupChapter.number,
        chapterTitle: setupChapter.title,
        kind: "supporting",
        summary: `补入一次性前置依据：${strategy.setup}。`,
        revisionId: setupRevisionId,
        previousRevisionId: setupParent.id,
      });
    }
  }

  const impactedIds = new Set([deathEvent.id]);
  const dependentEvents: StoryEvent[] = [];
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const event of story.events.filter((item) => item.active && item.branchId === story.activeBranchId)) {
      if (impactedIds.has(event.id) || !event.dependsOn.some((dependencyId) => impactedIds.has(dependencyId))) continue;
      impactedIds.add(event.id);
      dependentEvents.push(event);
      expanded = true;
    }
  }
  dependentEvents.sort((a, b) => a.sequence - b.sequence);
  for (const dependent of dependentEvents) {
    const chapter = story.chapters.find((item) => item.number === dependent.chapterNumber);
    const parent = chapter ? currentRevision(chapter) : null;
    if (!chapter || !parent) continue;
    const eventBefore = {
      active: dependent.active,
      title: dependent.title,
      cause: dependent.cause,
      outcome: dependent.outcome,
      revisionId: dependent.revisionId,
      stateEffects: structuredClone(dependent.stateEffects),
    };
    dependent.stateEffects = undefined;
    dependent.title = rewriteDependentParagraphs([dependent.title], character.name)[0];
    dependent.cause = rewriteDependentParagraphs([dependent.cause], character.name)[0];
    dependent.outcome = rewriteDependentParagraphs([dependent.outcome], character.name)[0];
    const paragraphs = rewriteDependentParagraphs(parent.paragraphs, character.name);
    if (paragraphs.every((paragraph, index) => paragraph === parent.paragraphs[index])) {
      eventSnapshots.push({
        eventId: dependent.id,
        before: eventBefore,
        after: {
          active: dependent.active,
          title: dependent.title,
          cause: dependent.cause,
          outcome: dependent.outcome,
          revisionId: dependent.revisionId,
          stateEffects: dependent.stateEffects,
        },
      });
      changes.push({
        chapterNumber: chapter.number,
        chapterTitle: chapter.title,
        kind: "supporting",
        summary: `依赖闭包命中事件 ${dependent.id}；旧后果状态已失效，正文无需改写。`,
      });
      continue;
    }
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
      branchId: story.activeBranchId,
    });
    chapter.currentRevisionId = revisionId;
    recordBranchRevision(story, chapter.id, revisionId);
    chapter.hasUnreadRevision = true;
    dependent.revisionId = revisionId;
    eventSnapshots.push({
      eventId: dependent.id,
      before: eventBefore,
      after: {
        active: dependent.active,
        title: dependent.title,
        cause: dependent.cause,
        outcome: dependent.outcome,
        revisionId: dependent.revisionId,
        stateEffects: dependent.stateEffects,
      },
    });
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
  const changedChapterNumbers = new Set(changes.filter((change) => change.revisionId).map((change) => change.chapterNumber));
  const unaffected = story.chapters.find((chapter) => chapter.number !== deathChapter.number && !changedChapterNumbers.has(chapter.number));
  if (unaffected) {
    changes.push({
      chapterNumber: unaffected.number,
      chapterTitle: unaffected.title,
      kind: "unchanged",
      summary: "依赖图未连接到本次死亡事件，正文与状态均保持不变。",
    });
  }

  const before = { status: character.status, lifecycle: character.lifecycle, location: character.location, role: character.role, relationship: character.relationship };
  const after = {
    status: "存活 · 官方死亡",
    lifecycle: "alive" as const,
    location: `${deathEvent.location}附近的隐匿地点`,
    role: character.role.includes("前") ? character.role : `${character.role} · 身份已注销`,
    relationship: `${character.relationship}；公开关系因官方死亡而中断`,
  };
  Object.assign(character, after);
  const deathEventBefore = {
    active: deathEvent.active,
    title: deathEvent.title,
    cause: deathEvent.cause,
    outcome: deathEvent.outcome,
    revisionId: deathEvent.revisionId,
    stateEffects: structuredClone(deathEvent.stateEffects),
  };
  deathEvent.active = false;
  deathEvent.revisionId = deathRevisionId;
  eventSnapshots.push({
    eventId: deathEvent.id,
    before: deathEventBefore,
    after: {
      active: deathEvent.active,
      title: deathEvent.title,
      cause: deathEvent.cause,
      outcome: deathEvent.outcome,
      revisionId: deathEvent.revisionId,
      stateEffects: structuredClone(deathEvent.stateEffects),
    },
  });
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
    sequence: deathEvent.sequence,
    storyTime: deathEvent.storyTime,
    branchId: story.activeBranchId,
    stateEffects: {
      characters: [{
        characterId: character.id,
        status: after.status,
        lifecycle: after.lifecycle,
        location: after.location,
        relationship: after.relationship,
        role: after.role,
      }],
    },
  });
  for (const event of story.events.filter((item) => item.active && item.branchId === story.activeBranchId && item.id !== survivalEventId)) {
    if (event.dependsOn.includes(deathEvent.id)) {
      event.dependsOn = event.dependsOn.map((dependencyId) => dependencyId === deathEvent.id ? survivalEventId : dependencyId);
    }
  }

  const replayBranch = story.branches.find((branch) => branch.id === story.activeBranchId);
  if (!replayBranch?.baseStateSnapshot || deathEvent.sequence <= replayBranch.baseEventSequence) {
    throw new Error("活动分支缺少死亡事件前的可信回放边界，已拒绝提交修史。");
  }
  replayBranchState(story, story.activeBranchId);

  story.canonVersion += 1;
  const activeBranch = story.branches.find((branch) => branch.id === story.activeBranchId);
  if (activeBranch) activeBranch.headCanonVersion = story.canonVersion;
  story.unreadCanonChanges += changes.filter((change) => Boolean(change.revisionId)).length;
  story.latestExcerpt = `${character.name}仍然活着，却永久失去原来的身份、位置与一部分信任。`;
  story.endingContract.version += 1;
  story.endingContract.status = "reframed";
  story.endingContract.lastEvaluatedAt = createdAt;
  rebuildBranchSummaries(story);
  const retconId = `retcon_${randomUUID().slice(0, 8)}`;
  const retcon: RetconTransaction = {
    id: retconId,
    kind: "intervention",
    title: `撤销${character.name}在第 ${deathChapter.number} 章的死亡`,
    sourceText,
    summary: `${character.name}因“${strategy.mechanism}”被误判死亡；存活代价为“${strategy.cost}”。${supportExists ? "既有正史已提供前置依据，无需补写。" : "仅补入一个最近前置依据。"}`,
    createdAt,
    canonVersionBefore: canonBefore,
    canonVersionAfter: story.canonVersion,
    changes,
    cost: `L${Math.min(3, changes.filter((change) => change.revisionId).length)} · ${changes.filter((change) => change.revisionId).length} 个章节 Revision`,
    status: "committed",
    targetEventId: deathEvent.id,
    characterSnapshots: [{ characterId: character.id, before, after }],
    eventSnapshots,
    branchIdBefore,
    branchIdAfter: story.activeBranchId,
  };
  story.retcons.unshift(retcon);
  proposal.status = "committed";
  proposal.transactionId = retconId;
  story.conversation.forEach((message) => {
    if (message.observedCanonVersion < story.canonVersion) message.oldCanon = true;
  });
  store.jobs.unshift({
    id: `job_${randomUUID().slice(0, 7)}`,
    ownerId: story.ownerId,
    storyId: story.id,
    storyTitle: story.title,
    chapterNumber: deathChapter.number,
    task: "retcon",
    model: "retcon-reasoner",
    connectionId: story.modelConnectionId ?? "conn_platform",
    promptVersion: "retcon-v5",
    status: "completed",
    tokens: 0,
    usageEstimated: false,
    latencyMs: 0,
    cost: 0,
    costEstimated: false,
    createdAt,
    filterSummary: `本地确定性修史；事件锚定 ${deathEvent.id}；影响分析命中 ${changes.length} 个节点。`,
    retconId,
    targetEventId: deathEvent.id,
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

function applyLocalIntervention(
  store: AppStore,
  story: Story,
  sourceText: string,
  proposal: InterventionProposal,
  context: ReaderMessageContext | undefined,
  mode: "relationship" | "accountability" | "selection",
): ConversationMessage {
  const chapter =
    (context?.chapterId && story.chapters.find((item) => item.id === context.chapterId)) ||
    story.chapters.at(-1);
  const parent = chapter ? currentRevision(chapter) : null;
  if (!chapter || !parent || (context?.revisionId && context.revisionId !== parent.id)) {
    proposal.status = "rejected";
    return {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: "你指向的段落已经不在当前 Revision 中。正史没有被改动，请在最新版本重新选择。",
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  }
  const createdAt = new Date().toISOString();
  const canonBefore = story.canonVersion;
  const anchor =
    (context?.eventId && story.events.find((event) => event.id === context.eventId && event.active && event.branchId === story.activeBranchId)) ||
    story.events.filter((event) => event.active && event.branchId === story.activeBranchId && event.chapterNumber === chapter.number).at(-1);
  let paragraphs = [...parent.paragraphs];
  let summary: string;
  let preferenceLabel: string;
  let preferenceKind: "hard" | "soft";
  const relationshipAnchor = mode === "relationship"
    ? (anchor?.type === "relationship"
        ? anchor
        : story.events.filter((event) => event.active && event.branchId === story.activeBranchId && event.type === "relationship" && event.chapterNumber <= chapter.number).at(-1))
    : undefined;
  const relationshipCharacters = relationshipAnchor
    ? relationshipAnchor.participantIds
        .map((id) => story.characters.find((character) => character.id === id))
        .filter((character): character is CharacterProfile => Boolean(character))
    : [];
  const characterSnapshots: NonNullable<RetconTransaction["characterSnapshots"]> = [];
  const snapshotAnchor = mode === "relationship" ? relationshipAnchor : anchor;
  const eventSnapshotBefore = snapshotAnchor ? {
    active: snapshotAnchor.active,
    title: snapshotAnchor.title,
    cause: snapshotAnchor.cause,
    outcome: snapshotAnchor.outcome,
    revisionId: snapshotAnchor.revisionId,
    stateEffects: structuredClone(snapshotAnchor.stateEffects),
  } : undefined;
  if (mode === "relationship") {
    if (!relationshipAnchor || relationshipCharacters.length < 2) {
      proposal.status = "rejected";
      return {
        id: `msg_${randomUUID().slice(0, 8)}`,
        role: "system",
        type: "answer",
        content: "当前分支没有可验证的关系事件与双方参与者，因此没有改动正文或人物状态。",
        createdAt,
        observedCanonVersion: story.canonVersion,
      };
    }
    paragraphs.push("他们没有在这一刻确认关系。共同经历只带来更多需要验证的信任，任何亲近都必须经过后续选择与代价，而不是被一次危机直接兑换。");
    summary = "放慢当前关系确认，把亲近改为仍需验证的信任。";
    preferenceLabel = "关系推进需要选择与代价";
    preferenceKind = "soft";
    for (const character of relationshipCharacters) {
      const before = { status: character.status, lifecycle: character.lifecycle, location: character.location, role: character.role, relationship: character.relationship };
      character.relationship = "关系退回待验证的同盟；亲近需要后续选择与代价";
      characterSnapshots.push({
        characterId: character.id,
        before,
        after: { status: character.status, lifecycle: character.lifecycle, location: character.location, role: character.role, relationship: character.relationship },
      });
    }
    if (relationshipAnchor) {
      relationshipAnchor.stateEffects ??= {};
      const existing = relationshipAnchor.stateEffects.characters ?? [];
      relationshipAnchor.stateEffects.characters = [
        ...existing.filter((effect) => !relationshipCharacters.some((character) => character.id === effect.characterId)),
        ...relationshipCharacters.map((character) => ({ characterId: character.id, relationship: character.relationship })),
      ];
    }
  } else if (mode === "accountability") {
    paragraphs.push("理解他的动机没有抵消已经造成的伤害。人物可以复杂，也必须继续承担责任；这一章不把解释写成原谅。");
    summary = "保留反派动机的复杂性，但撤销把解释等同于免责的表达。";
    preferenceLabel = "反派不因解释获得免责";
    preferenceKind = "hard";
  } else {
    const selection = context?.selection?.trim();
    if (!selection) {
      proposal.status = "rejected";
      return {
        id: `msg_${randomUUID().slice(0, 8)}`,
        role: "system",
        type: "answer",
        content: "局部重写需要一个仍属于当前 Revision 的文本选择；这次没有改动正史。",
        createdAt,
        observedCanonVersion: story.canonVersion,
      };
    }
    let replaced = false;
    paragraphs = paragraphs.map((paragraph) => {
      if (replaced || !paragraph.includes(selection)) return paragraph;
      replaced = true;
      return paragraph.replace(selection, `${selection.replace(/[。！？!?]$/, "")}；但这个判断仍需要在后续事件中付出代价才能成立。`);
    });
    if (!replaced) {
      proposal.status = "rejected";
      return {
        id: `msg_${randomUUID().slice(0, 8)}`,
        role: "system",
        type: "answer",
        content: "选中文本与当前 Revision 不一致，因此没有提交局部重写。",
        createdAt,
        observedCanonVersion: story.canonVersion,
      };
    }
    summary = "只重写选中句并补回叙事代价，其余段落保持不变。";
    preferenceLabel = "选中段落的局部约束";
    preferenceKind = "soft";
  }

  const revisionId = createRevisionId(story, chapter.number, chapter.revisions.length);
  chapter.revisions.push({
    id: revisionId,
    parentRevisionId: parent.id,
    title: parent.title,
    paragraphs,
    reason: `读者介入：${sourceText}`,
    createdAt,
    modelName: "intervention-rewriter",
    promptVersion: "intervention-v2",
    changeSummary: summary,
    branchId: story.activeBranchId,
  });
  chapter.currentRevisionId = revisionId;
  recordBranchRevision(story, chapter.id, revisionId);
  chapter.hasUnreadRevision = true;
  const preference = {
    id: `pref_${randomUUID().slice(0, 8)}`,
    label: preferenceLabel,
    description: sourceText,
    kind: preferenceKind,
    confidence: mode === "accountability" ? 1 : 0.84,
    active: true,
  };
  story.preferences.unshift(preference);
  const retconId = `retcon_${randomUUID().slice(0, 8)}`;
  const retcon: RetconTransaction = {
    id: retconId,
    kind: "intervention",
    title: mode === "relationship" ? `放慢第 ${chapter.number} 章的关系推进` : mode === "accountability" ? `保留第 ${chapter.number} 章的责任边界` : `局部重写第 ${chapter.number} 章选中段落`,
    sourceText,
    summary,
    createdAt,
    canonVersionBefore: canonBefore,
    canonVersionAfter: canonBefore + 1,
    changes: [{
      chapterNumber: chapter.number,
      chapterTitle: chapter.title,
      kind: "required",
      summary,
      revisionId,
      previousRevisionId: parent.id,
    }],
    cost: "L1 · 1 个章节 Revision",
    status: "committed",
    targetEventId: (mode === "relationship" ? relationshipAnchor : anchor)?.id,
    preferenceIds: [preference.id],
    characterSnapshots: characterSnapshots.length ? characterSnapshots : undefined,
    eventSnapshots: snapshotAnchor && eventSnapshotBefore ? [{
      eventId: snapshotAnchor.id,
      before: eventSnapshotBefore,
      after: {
        active: snapshotAnchor.active,
        title: snapshotAnchor.title,
        cause: snapshotAnchor.cause,
        outcome: snapshotAnchor.outcome,
        revisionId,
        stateEffects: structuredClone(snapshotAnchor.stateEffects),
      },
    }] : undefined,
    branchIdBefore: story.activeBranchId,
    branchIdAfter: story.activeBranchId,
  };
  story.retcons.unshift(retcon);
  story.canonVersion += 1;
  const activeBranch = story.branches.find((branch) => branch.id === story.activeBranchId);
  if (activeBranch) activeBranch.headCanonVersion = story.canonVersion;
  story.unreadCanonChanges += 1;
  story.updatedAt = createdAt;
  story.endingContract.version += 1;
  story.endingContract.status = "needs_review";
  story.endingContract.lastEvaluatedAt = createdAt;
  const revisionAnchor = mode === "relationship" ? relationshipAnchor : anchor;
  if (revisionAnchor) revisionAnchor.revisionId = revisionId;
  rebuildBranchSummaries(story);
  story.conversation.forEach((message) => {
    if (message.observedCanonVersion < story.canonVersion) message.oldCanon = true;
  });
  proposal.targetEventId = (mode === "relationship" ? relationshipAnchor : anchor)?.id;
  proposal.chapterId = chapter.id;
  proposal.revisionId = parent.id;
  proposal.status = "committed";
  proposal.transactionId = retconId;
  store.jobs.unshift({
    id: `job_${randomUUID().slice(0, 7)}`,
    ownerId: story.ownerId,
    storyId: story.id,
    storyTitle: story.title,
    chapterNumber: chapter.number,
    task: "retcon",
    model: "intervention-rewriter",
    connectionId: story.modelConnectionId ?? "conn_platform",
    promptVersion: "intervention-v2",
    status: "completed",
    tokens: 0,
    usageEstimated: false,
    latencyMs: 0,
    cost: 0,
    costEstimated: false,
    createdAt,
    filterSummary: `本地确定性介入；分类=${proposal.classification}；事件锚点=${(mode === "relationship" ? relationshipAnchor : anchor)?.id ?? "chapter-only"}；范围=current_chapter。`,
    retconId,
    targetEventId: (mode === "relationship" ? relationshipAnchor : anchor)?.id,
  });
  return {
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: "system",
    type: "retcon_result",
    content: `${summary} 已提交为正史 v${story.canonVersion}。`,
    createdAt,
    observedCanonVersion: story.canonVersion,
    retconId,
  };
}

function answerCanonQuestion(story: Story, text: string) {
  const named = story.characters.find((character) => text.includes(character.name));
  if (named) {
    if (/在哪|位置|哪里/.test(text)) {
      const source = story.events.filter((event) => event.active && event.participantIds.includes(named.id)).at(-1);
      return `按当前正史 v${story.canonVersion}，${named.name}位于“${named.location}”。来源：${source?.id ?? named.knowledgeSources.at(-1)?.sourceRevisionId ?? "人物状态账本"}。`;
    }
    if (/目标|想要|要做什么/.test(text)) {
      return `按当前正史 v${story.canonVersion}，${named.name}的目标是“${named.goal}”。来源：人物状态账本及其最近事件。`;
    }
    if (/知道|得知|了解/.test(text)) {
      const facts = named.knowledgeSources.slice(-4);
      if (!facts.length) return `当前正史没有可追溯来源证明${named.name}知道相关事实，我不会把猜测当成答案。`;
      return `${named.name}当前有来源的已知事实包括：${facts.map((fact) => `${fact.fact}[${fact.sourceRevisionId}]`).join("；")}。`;
    }
    if (/死|存活|状态/.test(text)) {
      const source = story.events.filter((event) => event.participantIds.includes(named.id)).at(-1);
      return `按当前正史 v${story.canonVersion}，${named.name}的状态是“${named.status}”。来源：${source?.id ?? "人物状态账本"}。`;
    }
  }
  const terms = text.split(/[，。；：、\s？?]/).filter((term) => term.length >= 2 && !/为什么|怎么会|是谁|什么|是否/.test(term));
  const event = [...story.events].reverse().find((item) => item.active && terms.some((term) => `${item.title}${item.cause}${item.outcome}`.includes(term)));
  if (event) return `依据事件 ${event.id}（${event.storyTime}）：${event.title}。原因是${event.cause}，结果是${event.outcome}。这条回答不会改变正史。`;
  const clue = story.clues.find((item) => terms.some((term) => `${item.title}${item.description}`.includes(term)));
  if (clue) return `依据第 ${clue.sourceChapter} 章的伏笔“${clue.title}”：${clue.description}。当前状态为 ${clue.status}。`;
  return "当前分支的事件、人物知识与原文来源不足以回答这个问题；我不会把猜测写成事实。";
}

export function handleReaderMessage(
  store: AppStore,
  story: Story,
  text: string,
  context?: ReaderMessageContext,
) {
  const createdAt = new Date().toISOString();
  const sourceMessageId = `msg_${randomUUID().slice(0, 8)}`;
  addMessage(story, {
    id: sourceMessageId,
    role: "user",
    type: "text",
    content: text,
    createdAt,
    observedCanonVersion: story.canonVersion,
  });

  const isDeathVeto = /不希望.*死|不要.*死|别让.*死|不能.*死/.test(text);
  const isRelationshipRewrite = /关系.*太快|感情.*太快|发展太快/.test(text);
  const isAccountabilityConstraint = /不要.*洗白|不能.*洗白|反派.*洗白|不.*原谅.*反派/.test(text);
  const isSelectionRewrite = Boolean(context?.selection) && /改|不要|别|不喜欢|不希望/.test(text);
  const isQuestion = /为什么|怎么会|是谁|吗[？?]?$|[？?]$/.test(text);
  const classification: InterventionProposal["classification"] = isDeathVeto
    ? "event_veto"
    : isRelationshipRewrite || isSelectionRewrite
      ? "local_rewrite"
      : isAccountabilityConstraint
        ? "hard_constraint"
        : isQuestion
          ? "question"
          : /太快|太慢|压抑|轻松|多看看|少一点/.test(text)
            ? "soft_preference"
            : "future_direction";
  const proposal: InterventionProposal = {
    id: `proposal_${randomUUID().slice(0, 8)}`,
    sourceMessageId,
    sourceText: text,
    classification,
    confidence: isDeathVeto || isRelationshipRewrite || isAccountabilityConstraint ? 0.94 : context?.selection ? 0.88 : 0.72,
    chapterId: context?.chapterId,
    revisionId: context?.revisionId,
    selection: context?.selection,
    targetEventId: context?.eventId,
    scope: isDeathVeto ? "current_event" : isRelationshipRewrite || isSelectionRewrite || isAccountabilityConstraint ? "current_chapter" : isQuestion ? "conversation_only" : "future",
    status: "parsed",
    createdAt,
  };
  story.proposals.unshift(proposal);

  let response: ConversationMessage;
  if (isDeathVeto) {
    response = applyDeathVeto(store, story, text, proposal, context);
  } else if (isRelationshipRewrite) {
    response = applyLocalIntervention(store, story, text, proposal, context, "relationship");
  } else if (isAccountabilityConstraint) {
    response = applyLocalIntervention(store, story, text, proposal, context, "accountability");
  } else if (isSelectionRewrite) {
    response = applyLocalIntervention(store, story, text, proposal, context, "selection");
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
    proposal.status = "recorded";
    response = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "preference_result",
      content: `已记为可衰减的软偏好：“${label}”。不会回改已确认正史，后续章节会逐步调整。`,
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  } else if (isQuestion) {
    proposal.status = "recorded";
    response = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: answerCanonQuestion(story, text),
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  } else {
    proposal.status = "recorded";
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
    const error = new Error("该修史事务不可回滚。");
    Object.assign(error, { status: 409 });
    throw error;
  }
  if (story.canonVersion !== original.canonVersionAfter) {
    const error = new Error("只能回滚最新的正史事务；请先处理它之后的修订。");
    Object.assign(error, { status: 409 });
    throw error;
  }
  const createdAt = new Date().toISOString();
  const canonBefore = story.canonVersion;
  const rollbackChanges: RetconChange[] = [];
  const restoringBranchId = original.branchIdBefore && original.branchIdAfter && original.branchIdBefore !== original.branchIdAfter
    ? original.branchIdBefore
    : null;
  const restoresDifferentBranch = restoringBranchId !== null;
  if (restoringBranchId) {
    const abandoned = story.branches.find((branch) => branch.id === original.branchIdAfter);
    const restored = story.branches.find((branch) => branch.id === original.branchIdBefore);
    if (abandoned) abandoned.status = "superseded";
    if (restored) restored.status = "active";
    story.activeBranchId = restoringBranchId;
    if (restored?.stateSnapshot) restoreCanonState(story, restored.stateSnapshot);
  }

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
      branchId: story.activeBranchId,
    });
    chapter.currentRevisionId = revisionId;
    recordBranchRevision(story, chapter.id, revisionId);
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
  for (const snapshot of original.eventSnapshots ?? []) {
    const event = story.events.find((item) => item.id === snapshot.eventId);
    if (!event || (restoresDifferentBranch && event.branchId !== story.activeBranchId)) continue;
    Object.assign(event, snapshot.before);
    const restored = rollbackChanges.find((change) => change.chapterNumber === event.chapterNumber);
    if (restored?.revisionId) event.revisionId = restored.revisionId;
  }
  const target = original.targetEventId ? story.events.find((event) => event.id === original.targetEventId && (!restoresDifferentBranch || event.branchId === story.activeBranchId)) : null;
  if (target) {
    target.active = true;
    const restoredAnchor = rollbackChanges.find((change) => change.chapterNumber === target.chapterNumber);
    if (restoredAnchor?.revisionId) target.revisionId = restoredAnchor.revisionId;
  }
  const restoredSurvivalEvents = story.events.filter((event) => event.branchId === story.activeBranchId && event.type === "survival" && event.chapterNumber === target?.chapterNumber);
  if (target) {
    const survivalIds = new Set(restoredSurvivalEvents.map((event) => event.id));
    for (const event of story.events.filter((item) => item.active && item.branchId === story.activeBranchId)) {
      event.dependsOn = event.dependsOn.map((dependencyId) => survivalIds.has(dependencyId) ? target.id : dependencyId);
    }
  }
  restoredSurvivalEvents.forEach((event) => { event.active = false; });
  for (const preferenceId of original.preferenceIds ?? []) {
    const preference = story.preferences.find((item) => item.id === preferenceId);
    if (preference) preference.active = false;
  }

  story.canonVersion += 1;
  const activeBranch = story.branches.find((branch) => branch.id === story.activeBranchId);
  if (activeBranch) {
    activeBranch.headCanonVersion = story.canonVersion;
    activeBranch.stateSnapshot = captureCanonState(story);
  }
  story.unreadCanonChanges += rollbackChanges.length;
  story.endingContract.version += 1;
  story.endingContract.status = "needs_review";
  story.endingContract.lastEvaluatedAt = createdAt;
  rebuildBranchSummaries(story);
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
    branchIdBefore: original.branchIdAfter ?? story.activeBranchId,
    branchIdAfter: story.activeBranchId,
  };
  original.status = "reversed";
  original.reversedByRetconId = rollbackId;
  story.proposals
    .filter((proposal) => proposal.transactionId === original.id)
    .forEach((proposal) => { proposal.status = "reversed"; });
  story.retcons.unshift(rollback);
  story.conversation.forEach((message) => {
    if (message.observedCanonVersion < story.canonVersion) message.oldCanon = true;
  });
  addMessage(story, {
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: "system",
    type: "progress",
    content: `已创建独立回滚事务 ${rollbackId}；当前正史为 v${story.canonVersion}，原修史历史未被覆盖。`,
    createdAt,
    observedCanonVersion: story.canonVersion,
  });
  story.updatedAt = createdAt;
  const latestRevision = story.chapters.at(-1) ? currentRevision(story.chapters.at(-1)!) : null;
  if (latestRevision?.paragraphs.length) story.latestExcerpt = latestRevision.paragraphs.at(-1) ?? story.latestExcerpt;
  return rollback;
}
