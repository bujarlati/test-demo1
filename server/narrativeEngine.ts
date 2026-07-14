import { createHash, randomUUID } from "node:crypto";
import type {
  NarrativeCandidate,
  Story,
  StoryEvent,
} from "../src/types";
import { currentRevision } from "../src/storyDomain";
import { safetyCategories } from "./safetyService";

export interface GeneratedChapter {
  title: string;
  paragraphs: string[];
  model: string;
  usageTokens?: number;
  usageEstimated?: boolean;
}

export interface RetrievedMemory {
  sourceId: string;
  confidence: number;
  text: string;
}

export interface GenerationPlan {
  selected: NarrativeCandidate;
  candidates: NarrativeCandidate[];
  memories: RetrievedMemory[];
  filterSummary: string;
  targetParagraphs: number;
  conversationContext: ConversationContext;
}

export interface ConversationContext {
  summary: string;
  recentMessages: string[];
  relevantMessages: string[];
  sourceMessageIds: string[];
  estimatedTokens: number;
}

export interface CandidateDraft {
  creativeAxis: string;
  event: string;
  cause: string;
  cost: string;
  impact: string;
  novelty: string;
  participantNames?: string[];
  storyTime?: string;
  dependsOnEventIds?: string[];
  knowledgeClaims?: Array<{ characterName: string; fact: string; sourceRevisionId?: string }>;
  knowledgeAudit?: {
    complete: boolean;
    dependencies: Array<{ characterName: string; fact: string }>;
  };
  itemTransitions?: Array<{
    itemName: string;
    actorName: string;
    fromStatus: "available" | "held" | "lost" | "destroyed" | "consumed";
    toStatus: "available" | "held" | "lost" | "destroyed" | "consumed";
  }>;
}

export interface ExtractedEventDraft {
  type?: StoryEvent["type"];
  title: string;
  cause: string;
  outcome: string;
  participantNames?: string[];
  location?: string;
}

export interface ExtractedCharacterUpdate {
  name: string;
  status?: string;
  location?: string;
  goal?: string;
  knowledgeGained?: string[];
}

export interface ExtractedChapterState {
  events: ExtractedEventDraft[];
  characterUpdates: ExtractedCharacterUpdate[];
  itemUpdates?: Array<{
    name: string;
    status: "available" | "held" | "lost" | "destroyed" | "consumed";
    holderName?: string;
    location?: string;
  }>;
  usageTokens?: number;
  usageEstimated?: boolean;
}

function numericSeed(value: string) {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

function activeLead(story: Story) {
  return (
    story.characters.find((character) => character.lifecycle === "alive") ??
    story.characters[0]
  );
}

const deathPredicate = /死亡|死去|断气|曲线归零|身亡|咽气/g;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidenceSegments(text: string) {
  return text.split(/[。！？!?；;\n]+/).map((segment) => segment.trim()).filter(Boolean);
}

function hasCharacterPredicateEvidence(
  text: string,
  characterName: string,
  allCharacterNames: string[],
  predicate: RegExp,
) {
  for (const segment of evidenceSegments(text)) {
    const characterIndex = segment.indexOf(characterName);
    if (characterIndex < 0) continue;
    const matches = [...segment.matchAll(new RegExp(predicate.source, "g"))];
    for (const match of matches) {
      const predicateIndex = match.index ?? -1;
      if (predicateIndex < 0 || Math.abs(predicateIndex - characterIndex) > 24) continue;
      const nearest = allCharacterNames
        .flatMap((name) => {
          const indexes: number[] = [];
          let from = 0;
          while (from < segment.length) {
            const index = segment.indexOf(name, from);
            if (index < 0) break;
            indexes.push(index);
            from = index + name.length;
          }
          return indexes.map((index) => ({ name, distance: Math.abs(predicateIndex - index) }));
        })
        .sort((a, b) => a.distance - b.distance)[0];
      if (nearest?.name === characterName) return true;
    }
  }
  return false;
}

function unsupportedKnowledgeClaims(story: Story, text: string) {
  const conflicts: string[] = [];
  for (const character of story.characters) {
    const claimPattern = new RegExp(`${escapeRegExp(character.name)}[^。！？!?\\n]{0,10}(?:早已知道|一直知道|早就明白|已经知道)([^。！？!?\\n]{2,60})`, "g");
    for (const match of text.matchAll(claimPattern)) {
      const claim = match[1].replace(/[，,；;。]/g, "").trim();
      const supported = character.knowledge.some((fact) => {
        const normalized = fact.replace(/[，,；;。]/g, "").trim();
        return normalized.length >= 2 && (claim.includes(normalized) || normalized.includes(claim));
      });
      if (!supported) conflicts.push(`${character.name}无来源地预知“${claim.slice(0, 24)}”`);
    }
  }
  return conflicts;
}

function itemStateConflicts(story: Story, text: string) {
  return story.items
    .filter((item) => item.status === "destroyed" || item.status === "consumed" || item.status === "lost")
    .filter((item) => text.includes(item.name) && /拿出|使用|交给|握着|佩戴|启动|再次出现/.test(text))
    .map((item) => `${item.name}当前状态为 ${item.status}`);
}

function structuredCandidateConflicts(
  story: Story,
  draft: CandidateDraft,
  candidateText: string,
  nextChapterNumber: number,
) {
  const conflicts: string[] = [];
  const participantNames = draft.participantNames?.length
    ? draft.participantNames
    : story.characters.filter((character) => candidateText.includes(character.name)).map((character) => character.name);
  for (const name of participantNames) {
    const character = story.characters.find((item) => item.name === name);
    if (!character) conflicts.push(`候选引用未知参与者 ${name}`);
    else if (character.lifecycle === "dead" && !/回忆|档案|遗物|证词|曾经/.test(candidateText)) conflicts.push(`已死亡参与者 ${name} 无依据进入场景`);
  }
  const activeEvents = story.events.filter((event) => event.active && event.branchId === story.activeBranchId);
  const dependencyIds = draft.dependsOnEventIds ?? activeEvents.slice(-1).map((event) => event.id);
  for (const dependencyId of dependencyIds) {
    if (!activeEvents.some((event) => event.id === dependencyId)) conflicts.push(`依赖事件 ${dependencyId} 不属于活动分支`);
  }
  if (draft.storyTime && !draft.storyTime.includes(`第${nextChapterNumber}章`) && !draft.storyTime.includes(`第 ${nextChapterNumber} 章`)) {
    conflicts.push(`结构化时间 ${draft.storyTime} 不属于下一章`);
  }
  const claims = [...(draft.knowledgeClaims ?? [])];
  const hasExternalStructuredEnvelope = draft.participantNames !== undefined && draft.storyTime !== undefined &&
    draft.dependsOnEventIds !== undefined && draft.knowledgeClaims !== undefined && draft.itemTransitions !== undefined;
  if (hasExternalStructuredEnvelope && participantNames.length > 0 && draft.knowledgeClaims!.length === 0) {
    conflicts.push("外部结构化候选包含参与者却没有声明任何 knowledgeClaim，已按保守知识边界拒绝");
  }
  if (hasExternalStructuredEnvelope) {
    if (!draft.knowledgeAudit?.complete) {
      conflicts.push("外部结构化候选缺少独立语义知识审计，不能证明信息依赖提取完整");
    }
    for (const claim of draft.knowledgeClaims!) {
      if (!participantNames.includes(claim.characterName)) {
        conflicts.push(`knowledgeClaim 的角色 ${claim.characterName} 不在候选参与者中`);
      }
      if (claim.fact.trim().length < 4 || !candidateText.includes(claim.fact.trim())) {
        conflicts.push(`knowledgeClaim“${claim.fact}”未在候选正文中实际使用`);
      }
      if (!claim.sourceRevisionId) conflicts.push(`knowledgeClaim“${claim.fact}”缺少 sourceRevisionId`);
    }
    for (const dependency of draft.knowledgeAudit?.dependencies ?? []) {
      const supportingClaim = draft.knowledgeClaims!.some((claim) =>
        claim.characterName === dependency.characterName &&
        (claim.fact.includes(dependency.fact) || dependency.fact.includes(claim.fact)),
      );
      if (!supportingClaim) {
        conflicts.push(`${dependency.characterName}使用语义审计识别的信息依赖“${dependency.fact}”但没有对应 knowledgeClaim`);
      }
    }
  }
  for (const character of story.characters) {
    const implicit = candidateText.match(new RegExp(`${escapeRegExp(character.name)}[^。！？!?\\n]{0,12}(?:输入|说出|使用|核对)([^。！？!?\\n]{0,24}(?:密码|口令|代码|暗号))`));
    if (implicit) claims.push({ characterName: character.name, fact: implicit[1].trim() });
  }
  for (const claim of claims) {
    const character = story.characters.find((item) => item.name === claim.characterName);
    if (!character) {
      conflicts.push(`知识声明引用未知角色 ${claim.characterName}`);
      continue;
    }
    const source = character.knowledgeSources.find((fact) =>
      (fact.fact.includes(claim.fact) || claim.fact.includes(fact.fact)) &&
      (!claim.sourceRevisionId || fact.sourceRevisionId === claim.sourceRevisionId),
    );
    if (!source) conflicts.push(`${claim.characterName}对“${claim.fact}”没有可追溯知识来源`);
  }
  const transitions = draft.itemTransitions ?? [];
  for (const transition of transitions) {
    const item = story.items.find((candidate) => candidate.name === transition.itemName);
    const actor = story.characters.find((character) => character.name === transition.actorName);
    if (!item || !actor) {
      conflicts.push(`物品转换引用未知物品或角色：${transition.itemName}/${transition.actorName}`);
      continue;
    }
    if (item.status !== transition.fromStatus) conflicts.push(`${item.name}起始状态应为 ${item.status}，不是 ${transition.fromStatus}`);
    if (item.status === "held" && item.holderCharacterId !== actor.id && /使用|交给|丢失|消耗|摧毁/.test(candidateText)) {
      conflicts.push(`${transition.actorName}不是${item.name}的持有人`);
    }
    if ((item.status === "destroyed" || item.status === "consumed") && transition.toStatus === "held") conflicts.push(`${item.name}不能从 ${item.status} 恢复为 held`);
  }
  for (const item of story.items.filter((candidate) => candidateText.includes(candidate.name) && /拿出|使用|交给|握着|佩戴|启动|摧毁|消耗/.test(candidateText))) {
    if (!transitions.some((transition) => transition.itemName === item.name)) conflicts.push(`${item.name}的使用缺少结构化物品状态转换`);
  }
  return { conflicts, participantNames, dependencyIds, claims, transitions };
}

export function assertStoryStateIntegrity(story: Story) {
  const activeEvents = story.events.filter((event) => event.active && event.branchId === story.activeBranchId);
  const sequences = new Set<number>();
  for (const event of activeEvents) {
    if (!Number.isInteger(event.sequence) || event.sequence < 1 || !event.storyTime) {
      throw new Error(`事件 ${event.id} 缺少结构化时间。`);
    }
    if (sequences.has(event.sequence)) throw new Error(`事件时间线序号 ${event.sequence} 重复。`);
    sequences.add(event.sequence);
    for (const dependencyId of event.dependsOn) {
      const dependency = story.events.find((item) => item.id === dependencyId);
      if (!dependency || !dependency.active || dependency.branchId !== event.branchId || dependency.sequence >= event.sequence) {
        throw new Error(`事件 ${event.id} 的依赖边不满足时间顺序。`);
      }
    }
  }
  for (const character of story.characters) {
    for (const itemId of character.inventoryItemIds) {
      const item = story.items.find((candidate) => candidate.id === itemId);
      if (!item || item.holderCharacterId !== character.id || item.status !== "held") {
        throw new Error(`${character.name}的物品状态与库存账本不一致。`);
      }
    }
  }
}

export function buildConversationContext(story: Story, focus = ""): ConversationContext {
  const thread = story.conversationThreads.find((item) => item.branchId === story.activeBranchId);
  const branchMessages = story.conversation.filter((message) => message.branchId === story.activeBranchId);
  const recent = branchMessages.slice(-4);
  const recentIds = new Set(recent.map((message) => message.id));
  const terms = `${focus} ${story.characters.map((character) => character.name).join(" ")}`
    .split(/[，。；：、\s]/)
    .filter((term) => term.length >= 2);
  const relevant = branchMessages
    .filter((message) => !recentIds.has(message.id))
    .map((message) => ({ message, score: terms.filter((term) => message.content.includes(term)).length }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.message.createdAt) - Date.parse(a.message.createdAt))
    .slice(0, 3)
    .map((item) => item.message);
  const summary = thread?.summary?.content.slice(0, 700) ?? "";
  const recentMessages = recent.map((message) => `${message.role === "user" ? "读者" : "系统"}：${message.content.slice(0, 220)}`);
  const relevantMessages = relevant.map((message) => `相关历史[${message.id}] ${message.role === "user" ? "读者" : "系统"}：${message.content.slice(0, 220)}`);
  const sourceMessageIds = [...(thread?.summary?.sourceMessageIds ?? []), ...relevant.map((message) => message.id), ...recent.map((message) => message.id)];
  const estimatedTokens = Math.ceil((summary.length + recentMessages.join("\n").length + relevantMessages.join("\n").length) / 2);
  return { summary, recentMessages, relevantMessages, sourceMessageIds: [...new Set(sourceMessageIds)].slice(-20), estimatedTokens };
}

export function retrieveRelevantMemory(story: Story, focus: string): RetrievedMemory[] {
  const terms = new Set(
    `${focus} ${activeLead(story)?.name ?? ""}`
      .split(/[，。；：、\s]/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  );
  const scored: RetrievedMemory[] = [];

  for (const event of story.events.filter((item) => item.active && item.branchId === story.activeBranchId)) {
    const text = `${event.title}：${event.cause}；${event.outcome}`;
    const matches = [...terms].filter((term) => text.includes(term)).length;
    scored.push({
      sourceId: event.id,
      confidence: Math.min(0.98, 0.52 + matches * 0.12 + event.chapterNumber / 1000),
      text,
    });
  }
  for (const clue of story.clues.filter((item) => item.status !== "resolved")) {
    const text = `${clue.title}：${clue.description}`;
    const matches = [...terms].filter((term) => text.includes(term)).length;
    scored.push({
      sourceId: clue.id,
      confidence: Math.min(0.95, 0.62 + matches * 0.12),
      text,
    });
  }
  for (const summary of story.summaries.filter((item) => item.branchId === story.activeBranchId && (item.layer === "chapter" || item.layer === "arc")).slice(-12)) {
    const matches = [...terms].filter((term) => summary.text.includes(term)).length;
    if (matches > 0) {
      scored.push({
        sourceId: `${summary.id}[${summary.sourceRevisionIds.join(",")}]`,
        confidence: Math.min(0.94, 0.58 + matches * 0.12),
        text: summary.text,
      });
    }
  }
  const latest = story.chapters.at(-1);
  const revision = latest ? currentRevision(latest) : null;
  if (latest && revision) {
    scored.push({
      sourceId: revision.id,
      confidence: 0.99,
      text: revision.paragraphs.slice(-2).join(" "),
    });
  }
  return scored
    .sort((a, b) => b.confidence - a.confidence)
    .reduce<RetrievedMemory[]>((result, item) => {
      const used = result.reduce((total, memory) => total + memory.text.length, 0);
      if (used < 1_200) result.push(item);
      return result;
    }, [])
    .slice(0, 6);
}

export function planNextChapter(
  story: Story,
  externalDrafts?: CandidateDraft[],
  chapterLength: "compact" | "standard" | "immersive" = "standard",
  crossStoryRecentAxes: string[] = [],
): GenerationPlan {
  assertStoryStateIntegrity(story);
  const lead = activeLead(story);
  const leadName = lead?.name ?? "主角";
  const openClue = story.clues.find((clue) => clue.status !== "resolved");
  const axes = story.storyGene.creativeAxes.length
    ? story.storyGene.creativeAxes
    : ["错误证词", "空间误导", "关系代价", "身份交换", "旧物回声"];
  const seed = numericSeed(`${story.id}:${story.canonVersion}:${story.activeBranchId}`);
  const localPatterns: CandidateDraft[] = [
    {
      creativeAxis: axes[0 % axes.length],
      event: `${leadName}发现“${openClue?.title ?? "旧线索"}”与一份新证词互相矛盾`,
      cause: "上一章被忽略的时间差重新出现",
      cost: "必须公开一段原本想保护的秘密",
      impact: "推进主线并改变一段同盟关系",
      novelty: "同一证据在两个空间呈现不同结果",
    },
    {
      creativeAxis: axes[1 % axes.length],
      event: `${leadName}必须在追踪线索与救下证人之间做不可逆选择`,
      cause: "对手利用主角的可见目标设置同时发生的危机",
      cost: "放弃最直接的答案并承受误解",
      impact: "保留结局前置条件，同时制造关系裂缝",
      novelty: "胜利来自主动放弃而非获得更多信息",
    },
    {
      creativeAxis: axes[2 % axes.length],
      event: `一件已确认归属的旧物主动回到${leadName}身边`,
      cause: "旧物携带的来源记录被人为调换",
      cost: "主角原有身份受到公开质疑",
      impact: "把世界规则与人物隐藏需求连接起来",
      novelty: "道具状态变化代替新角色直接说明真相",
    },
    {
      creativeAxis: axes[3 % axes.length],
      event: `${leadName}在安全地点看见不可能出现的已知标记`,
      cause: "场景坐标本身是叙事误导的一部分",
      cost: "必须离开当前保护范围",
      impact: "打开一个受限的新空间，并回收早期伏笔",
      novelty: "空间关系而非幕后身份构成反转",
    },
    {
      creativeAxis: axes[4 % axes.length],
      event: `${leadName}暂时死亡以迫使同伴接替目标`,
      cause: "冲突升级需要移交叙事视角",
      cost: "主角死亡",
      impact: "强制改变后续大纲",
      novelty: "通过视角空缺制造悬念",
    },
  ];
  const patterns = externalDrafts && externalDrafts.length >= 3
    ? externalDrafts.slice(0, 5)
    : localPatterns;
  const candidates = patterns.map<NarrativeCandidate>((pattern, index) => {
    const candidateText = `${pattern.event} ${pattern.cause} ${pattern.cost} ${pattern.impact}`;
    const hardReasons: string[] = [];
    const nextChapterNumber = (story.chapters.at(-1)?.number ?? 0) + 1;
    const structured = structuredCandidateConflicts(story, pattern, candidateText, nextChapterNumber);
    hardReasons.push(...structured.conflicts.map((reason) => `违反结构化状态转换：${reason}`));
    for (const character of story.characters) {
      const characterDeath =
        candidateText.includes(character.name) && /死亡|死去|断气|牺牲|暂时死亡/.test(candidateText);
      if (character.protected && characterDeath) {
        hardReasons.push(`违反硬约束：${character.name}已设为死亡保护角色`);
      }
      if (
        character.lifecycle === "dead" &&
        candidateText.includes(character.name) &&
        !/回忆|档案|遗物|证词|曾经/.test(candidateText)
      ) {
        hardReasons.push(`违反人物状态：已死亡角色 ${character.name} 无依据参与新事件`);
      }
    }
    hardReasons.push(...unsupportedKnowledgeClaims(story, candidateText).map((reason) => `违反人物知识边界：${reason}`));
    hardReasons.push(...itemStateConflicts(story, candidateText).map((reason) => `违反物品状态：${reason}`));
    for (const rule of story.rules.filter((item) => item.hardness === "hard")) {
      if (/不存在复活|不得复活|无复活/.test(rule.description) && /复活|死而复生|重新活过来/.test(candidateText)) {
        hardReasons.push(`违反世界规则：${rule.title}`);
      }
      if (/不以梦境抹除/.test(rule.description) && /原来只是梦|一切都是梦/.test(candidateText)) {
        hardReasons.push(`违反世界规则：${rule.title}`);
      }
      if (
        /潮门/.test(`${rule.title}${rule.description}`) &&
        /徽章/.test(rule.description) &&
        /(?:打开|开启|启动|激活)[^。！？!?\n]{0,12}潮门|潮门[^。！？!?\n]{0,12}(?:打开|开启|启动|激活)/.test(candidateText)
      ) {
        const badgeTransition = structured.transitions.find((transition) => /徽章/.test(transition.itemName));
        const badge = badgeTransition ? story.items.find((item) => item.name === badgeTransition.itemName) : undefined;
        if (!/徽章/.test(candidateText) || !badgeTransition || !badge || badge.status !== badgeTransition.fromStatus) {
          hardReasons.push(`违反世界规则：${rule.title}要求有效徽章及可验证的状态转换`);
        }
      }
    }
    for (const preference of story.preferences.filter((item) => item.active && item.kind === "hard")) {
      if (/洗白|免责|原谅.*反派/.test(`${preference.label} ${preference.description}`) && /洗白|免责|无罪|获得原谅/.test(candidateText)) {
        hardReasons.push(`违反读者硬约束：${preference.label}`);
      }
    }
    const unsafeCategories = safetyCategories(candidateText);
    if (unsafeCategories.length) hardReasons.push(`违反内容安全策略：${unsafeCategories.join(", ")}`);
    const futureChapter = [...candidateText.matchAll(/第\s*(\d+)\s*章/g)]
      .map((match) => Number(match[1]))
      .find((chapterNumber) => chapterNumber > nextChapterNumber);
    if (futureChapter) hardReasons.push(`违反时间线：候选把第 ${futureChapter} 章事实提前为当前事件`);
    for (const clue of story.clues.filter((item) => item.status === "resolved")) {
      if (candidateText.includes(clue.title) && /继续追查|仍未解决|尚未揭开/.test(candidateText)) {
        hardReasons.push(`违反道具/伏笔状态：${clue.title} 已解决`);
      }
    }
    const hardConflict = hardReasons.length > 0;
    const recentAxis = story.events
      .filter((event) => event.active && event.branchId === story.activeBranchId)
      .slice(-4)
      .some((event) => event.creativeAxis === pattern.creativeAxis);
    const repeatedAcrossStories = crossStoryRecentAxes.includes(pattern.creativeAxis);
    const score = 68 + ((seed >> (index * 3)) & 15) + (openClue && index !== 4 ? 7 : 0) - (recentAxis ? 8 : 0) - (repeatedAcrossStories ? 6 : 0);
    return {
      id: `candidate_${randomUUID().slice(0, 8)}`,
      seed: seed + index * 97,
      ...pattern,
      score: hardConflict ? 0 : score,
      status: "rejected",
      reasons: hardConflict
        ? hardReasons
        : recentAxis || repeatedAcrossStories
          ? [`结构轴${recentAxis ? "在本故事近期" : "在同一读者的其他故事中"}重复，已降低新颖度评分`]
          : ["通过人物知识、世界规则与硬偏好门禁"],
      participantNames: structured.participantNames,
      storyTime: pattern.storyTime ?? `第${nextChapterNumber}章·场景1`,
      dependsOnEventIds: structured.dependencyIds,
      knowledgeClaims: structured.claims,
      itemTransitions: structured.transitions,
    };
  });
  const viable = candidates.filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score);
  if (!viable.length) throw new Error("所有剧情候选均违反硬正史，已阻止正文发布。");
  const selected = viable[(story.canonVersion + seed) % Math.min(3, viable.length)];
  selected.status = "selected";
  selected.reasons.push("综合因果、偏好、新颖度、伏笔潜力与修史成本后入选");
  const memories = retrieveRelevantMemory(story, `${selected.event} ${selected.impact}`);
  const conversationContext = buildConversationContext(story, `${selected.event} ${selected.impact}`);
  const baseParagraphs = story.length.includes("短") ? 5 : story.length.includes("长") ? 9 : 7;
  const targetParagraphs = Math.max(5, Math.min(10, baseParagraphs + (chapterLength === "compact" ? -2 : chapterLength === "immersive" ? 2 : 0)));
  return {
    selected,
    candidates,
    memories,
    filterSummary: `${candidates.length} 个短候选；${candidates.filter((item) => item.score === 0).length} 个硬冲突被阻断；固定预算检索 ${memories.length} 条来源。`,
    targetParagraphs,
    conversationContext,
  };
}

export function buildChapterPrompt(story: Story, plan: GenerationPlan): string {
  const latest = story.chapters.at(-1);
  const hardRules = story.rules
    .filter((rule) => rule.hardness === "hard")
    .map((rule) => rule.description)
    .join("；");
  const hardPreferences = story.preferences
    .filter((preference) => preference.active && preference.kind === "hard")
    .map((preference) => preference.description)
    .join("；");
  const softPreferences = story.preferences
    .filter((preference) => preference.active && preference.kind === "soft")
    .map((preference) => preference.description)
    .join("；");
  const characterState = story.characters.map((character) =>
    `${character.name}[${character.lifecycle}]：位置=${character.location}；目标=${character.goal}；已知=${character.knowledge.join("、") || "无"}`,
  ).join("\n");
  const clueState = story.clues.map((clue) => `${clue.title}[${clue.status}]@第${clue.sourceChapter}章`).join("；");
  const itemState = story.items.map((item) => `${item.name}[${item.status}]@${item.location}`).join("；");
  const worldBible = `组织=${story.worldBible.organizations.join("、") || "无"}；地点=${story.worldBible.locations.join("、") || "无"}；能力边界=${story.worldBible.abilityBoundaries.join("、") || "无"}；视角=${story.worldBible.pointOfView}；文风=${story.worldBible.styleParameters.join("、")}`;
  return [
    `故事：《${story.title}》，题材：${story.genre}，氛围：${story.tone}，正史 v${story.canonVersion}。`,
    `故事基因：${story.storyGene.conflictEngine}；持续代价：${story.storyGene.recurringCost}。`,
    `世界观圣经 v${story.worldBible.version}（来源 ${story.worldBible.sourceRevisionIds.join(", ") || "无"}）：${worldBible}。`,
    `暂定结局契约：${story.endingContract.targetEnding}。`,
    `上一章：第${latest?.number ?? 0}章《${latest?.title ?? "序章"}》。`,
    `入选剧情胶囊：事件=${plan.selected.event}；原因=${plan.selected.cause}；代价=${plan.selected.cost}；影响=${plan.selected.impact}。`,
    `结构化转换：参与者=${plan.selected.participantNames?.join("、") || "无"}；时间=${plan.selected.storyTime}；依赖=${plan.selected.dependsOnEventIds?.join("、") || "无"}；知识声明=${plan.selected.knowledgeClaims?.map((claim) => `${claim.characterName}:${claim.fact}`).join("、") || "无"}；物品转换=${plan.selected.itemTransitions?.map((item) => `${item.actorName}:${item.itemName}:${item.fromStatus}->${item.toStatus}`).join("、") || "无"}。`,
    `人物结构化状态：\n${characterState}`,
    `伏笔状态：${clueState || "无"}。物品账本：${itemState || "无"}。目标长度：${plan.targetParagraphs} 个完整段落，允许误差不超过 1 段。`,
    `硬规则：${hardRules || "无"}。读者硬约束：${hardPreferences || "无"}。近期软偏好：${softPreferences || "无"}。`,
    `固定预算相关记忆：\n${plan.memories.map((memory) => `[${memory.sourceId}|${memory.confidence.toFixed(2)}] ${memory.text}`).join("\n")}`,
    `分支会话摘要（来源消息 ${plan.conversationContext.sourceMessageIds.join(", ") || "无"}）：${plan.conversationContext.summary || "无"}`,
    `相关历史消息（按当前事件检索）：\n${plan.conversationContext.relevantMessages.join("\n") || "无"}`,
    `最近会话（固定预算）：\n${plan.conversationContext.recentMessages.join("\n") || "无"}`,
    "只扩写这个方案为完整下一章；不得违反硬规则、人物知识边界或已确认死亡状态。",
  ].join("\n");
}

export function generateLocalChapter(story: Story, plan: GenerationPlan): GeneratedChapter {
  const lead = activeLead(story)?.name ?? "主角";
  const number = (story.chapters.at(-1)?.number ?? 0) + 1;
  const axisTitle: Record<string, string> = {
    错误证词: "证词的背面",
    关系代价: "留下的人先离开",
    空间误导: "门外之门",
    旧物回声: "失物归来",
    身份交换: "另一个名字",
  };
  const title = axisTitle[plan.selected.creativeAxis] ?? `第 ${number} 次回声`;
  const paragraphPool = [
    `清晨到来得比预计更早。${lead}醒来时，最先想起的不是昨夜的危险，而是那条一直没有解释的细小矛盾。`,
    `${plan.selected.event}。它并不凭空出现：${plan.selected.cause}。`,
    `证据仍在原处，可顺序已经改变。${lead}逐一核对来源，确认这不是记忆出错，而是有人希望所有人只看见因果的一面。`,
    `选择没有留下安全的中间地带。${plan.selected.cost}，这成为继续追查必须支付的代价。`,
    `旧线索因此获得了新的方向，也让此前稳定的关系出现裂缝。${plan.selected.impact}。`,
    `他们把时间、地点和证词重新排成一列，只有一处细节无法归位。那处空缺证明，对手并不能随意改写全部事实。`,
    `${lead}没有把推断当成结论，而是留下了可以在下一次行动中验证的标记。谨慎延缓了答案，也避免让未知变成凭空的真相。`,
    `离开之前，${lead}回看了一次现场。旧线索没有消失，只是获得了新的因果位置；后续选择仍要承担今天留下的损失。`,
    `远处的警报重新响起，“${plan.selected.novelty}”不再只是推测，而成为下一步无法回避的结构性难题。`,
    `门在身后合上时，本章的场景已经完整收束。新的问题成立，却没有抹掉任何已确认的代价。`,
  ];
  return {
    title,
    model: "platform-writer",
    paragraphs: paragraphPool.slice(0, plan.targetParagraphs),
  };
}

export function validateGeneratedChapter(
  story: Story,
  generated: GeneratedChapter,
  plan: GenerationPlan,
) {
  if (!generated.title.trim() || generated.paragraphs.length < 4) {
    throw new Error("章节未通过完整性校验，已阻止发布。");
  }
  if (Math.abs(generated.paragraphs.length - plan.targetParagraphs) > 1) {
    throw new Error(`章节长度为 ${generated.paragraphs.length} 段，偏离目标 ${plan.targetParagraphs} 段，已阻止发布。`);
  }
  const content = generated.paragraphs.join("\n");
  const unsafeCategories = safetyCategories(content);
  if (unsafeCategories.length) {
    throw new Error(`章节触发内容安全策略（${unsafeCategories.join(", ")}），已阻止发布。`);
  }
  for (const character of story.characters) {
    if (character.protected && content.includes(character.name) && /死亡|死去|断气|曲线归零/.test(content)) {
      throw new Error(`章节违反“保护 ${character.name}”硬约束，已阻止发布。`);
    }
    if (character.lifecycle === "dead" && content.includes(character.name) && !/回忆|档案|遗物|曾经/.test(content)) {
      throw new Error(`章节让已死亡角色 ${character.name} 无依据重新出现，已阻止发布。`);
    }
  }
  for (const rule of story.rules.filter((item) => item.hardness === "hard")) {
    if (/不存在复活|不得复活|无复活/.test(rule.description) && /复活|死而复生|重新活过来/.test(content)) {
      throw new Error(`章节违反世界规则“${rule.title}”，已阻止发布。`);
    }
    if (/不以梦境抹除/.test(rule.description) && /原来只是梦|一切都是梦/.test(content)) {
      throw new Error(`章节以梦境抹除既有因果，已阻止发布。`);
    }
  }
  for (const preference of story.preferences.filter((item) => item.active && item.kind === "hard")) {
    if (/洗白|免责|原谅.*反派/.test(`${preference.label} ${preference.description}`) && /洗白|免责|无罪|获得原谅/.test(content)) {
      throw new Error(`章节违反读者硬约束“${preference.label}”，已阻止发布。`);
    }
  }
  const knowledgeConflicts = unsupportedKnowledgeClaims(story, content);
  if (knowledgeConflicts.length) throw new Error(`章节违反人物知识边界：${knowledgeConflicts.join("；")}。`);
  const itemConflicts = itemStateConflicts(story, content);
  if (itemConflicts.length) throw new Error(`章节违反物品状态：${itemConflicts.join("；")}。`);
  const nextChapterNumber = (story.chapters.at(-1)?.number ?? 0) + 1;
  const futureChapter = [...content.matchAll(/第\s*(\d+)\s*章/g)]
    .map((match) => Number(match[1]))
    .find((chapterNumber) => chapterNumber > nextChapterNumber);
  if (futureChapter) throw new Error(`章节违反时间线：引用了尚未发生的第 ${futureChapter} 章。`);
  for (const clue of story.clues.filter((item) => item.status === "resolved")) {
    if (content.includes(clue.title) && /继续追查|仍未解决|尚未揭开/.test(content)) {
      throw new Error(`章节违反伏笔状态：${clue.title} 已经解决。`);
    }
  }
  const anchors = [
    ...story.characters.map((character) => character.name),
    ...story.clues.filter((clue) => clue.status !== "resolved").map((clue) => clue.title),
  ].filter((anchor) => plan.selected.event.includes(anchor));
  if (anchors.length > 0 && !anchors.some((anchor) => content.includes(anchor))) {
    throw new Error("正文没有落实入选剧情胶囊中的角色或伏笔锚点，已阻止发布。");
  }
}

export function eventFromChapter(
  story: Story,
  chapterNumber: number,
  revisionId: string,
  plan: GenerationPlan,
  extracted?: ExtractedEventDraft,
  generated?: GeneratedChapter,
): StoryEvent {
  const previousEvent = story.events.filter((event) => event.active && event.branchId === story.activeBranchId).at(-1);
  const lead = activeLead(story);
  const eventTypes = new Set<StoryEvent["type"]>([
    "discovery",
    "choice",
    "relationship",
    "death",
    "survival",
    "consequence",
  ]);
  const chapterText = generated?.paragraphs.join("\n") ?? "";
  let extractedType = extracted?.type && eventTypes.has(extracted.type) ? extracted.type : "choice";
  const claimedParticipants = extracted?.participantNames?.length
    ? story.characters.filter((character) => extracted.participantNames?.includes(character.name))
    : plan.selected.participantNames?.length
      ? story.characters.filter((character) => plan.selected.participantNames?.includes(character.name))
      : lead ? [lead] : [];
  const evidencedParticipants = extractedType === "death" && generated
    ? claimedParticipants.filter((character) => hasCharacterPredicateEvidence(
        chapterText,
        character.name,
        story.characters.map((item) => item.name),
        deathPredicate,
      ))
    : claimedParticipants;
  if (extractedType === "death" && generated && evidencedParticipants.length === 0) extractedType = "choice";
  const sequence = Math.max(0, ...story.events.map((event) => event.sequence)) + 1;
  return {
    id: `event_${randomUUID().slice(0, 10)}`,
    chapterNumber,
    revisionId,
    type: extractedType,
    title: (extracted?.title ?? plan.selected.event).slice(0, 180),
    cause: (extracted?.cause ?? plan.selected.cause).slice(0, 240),
    outcome: (extracted?.outcome ?? `${plan.selected.impact}；代价：${plan.selected.cost}`).slice(0, 280),
    participantIds: evidencedParticipants.map((character) => character.id),
    location: extracted?.location ?? lead?.location ?? "当前场景",
    dependsOn: plan.selected.dependsOnEventIds?.length ? plan.selected.dependsOnEventIds : previousEvent ? [previousEvent.id] : [],
    active: true,
    creativeAxis: plan.selected.creativeAxis,
    sequence,
    storyTime: plan.selected.storyTime ?? `第${chapterNumber}章·场景1`,
    branchId: story.activeBranchId,
  };
}

export function applyExtractedCharacterState(
  story: Story,
  extracted?: ExtractedChapterState,
  generated?: GeneratedChapter,
  source?: { chapterNumber: number; revisionId: string },
) {
  if (!extracted) return;
  const chapterText = generated?.paragraphs.join("\n") ?? "";
  for (const update of extracted.characterUpdates) {
    const character = story.characters.find((item) => item.name === update.name);
    if (!character) continue;
    const characterSupported = !generated || chapterText.includes(character.name);
    if (update.location && characterSupported && chapterText.includes(update.location)) {
      character.location = update.location.slice(0, 120);
    }
    if (update.goal && characterSupported && chapterText.includes(update.goal)) {
      character.goal = update.goal.slice(0, 180);
    }
    if (update.status) {
      const marksDeath = /死亡|死去/.test(update.status);
      const marksMissing = /失踪|下落不明/.test(update.status);
      const marksAlive = /存活|活着|生还/.test(update.status);
      const statusSupported = !generated || (marksDeath
        ? hasCharacterPredicateEvidence(chapterText, character.name, story.characters.map((item) => item.name), deathPredicate)
        : marksMissing
          ? hasCharacterPredicateEvidence(chapterText, character.name, story.characters.map((item) => item.name), /失踪|下落不明/g)
          : marksAlive
            ? hasCharacterPredicateEvidence(chapterText, character.name, story.characters.map((item) => item.name), /存活|活着|生还/g)
            : characterSupported && chapterText.includes(update.status));
      if (statusSupported && !(character.protected && marksDeath)) {
        character.status = update.status.slice(0, 80);
        if (marksDeath) character.lifecycle = "dead";
        else if (/失踪/.test(update.status)) character.lifecycle = "missing";
        else if (/存活|活着/.test(update.status)) character.lifecycle = "alive";
      }
    }
    for (const knowledge of update.knowledgeGained ?? []) {
      const normalized = knowledge.trim().slice(0, 180);
      if (
        normalized &&
        characterSupported &&
        chapterText.includes(normalized) &&
        !character.knowledge.includes(normalized)
      ) {
        character.knowledge.push(normalized);
        if (source) character.knowledgeSources.push({ fact: normalized, sourceChapter: source.chapterNumber, sourceRevisionId: source.revisionId });
      }
    }
  }
  for (const update of extracted.itemUpdates ?? []) {
    if (!chapterText.includes(update.name)) continue;
    const item = story.items.find((candidate) => candidate.name === update.name);
    if (!item || !chapterText.includes(update.status === "held" ? (update.holderName ?? update.name) : update.name)) continue;
    const holder = update.holderName ? story.characters.find((character) => character.name === update.holderName) : undefined;
    item.status = update.status;
    item.holderCharacterId = update.status === "held" ? holder?.id : undefined;
    item.location = update.location && chapterText.includes(update.location) ? update.location.slice(0, 120) : holder?.location ?? item.location;
    if (source) {
      item.sourceChapter = source.chapterNumber;
      item.sourceRevisionId = source.revisionId;
    }
    for (const character of story.characters) {
      character.inventoryItemIds = character.inventoryItemIds.filter((id) => id !== item.id);
    }
    if (update.status === "held" && holder) holder.inventoryItemIds.push(item.id);
  }
}

export function applyPlannedItemTransitions(story: Story, plan: GenerationPlan, generated: GeneratedChapter, source: { chapterNumber: number; revisionId: string }) {
  const content = generated.paragraphs.join("\n");
  for (const transition of plan.selected.itemTransitions ?? []) {
    const item = story.items.find((candidate) => candidate.name === transition.itemName);
    const actor = story.characters.find((character) => character.name === transition.actorName);
    if (!item || !actor || !content.includes(item.name) || !content.includes(actor.name) || item.status !== transition.fromStatus) continue;
    for (const character of story.characters) character.inventoryItemIds = character.inventoryItemIds.filter((id) => id !== item.id);
    item.status = transition.toStatus;
    item.holderCharacterId = transition.toStatus === "held" ? actor.id : undefined;
    item.location = actor.location;
    item.sourceChapter = source.chapterNumber;
    item.sourceRevisionId = source.revisionId;
    if (transition.toStatus === "held") actor.inventoryItemIds.push(item.id);
  }
}
