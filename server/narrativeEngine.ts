import { createHash, randomUUID } from "node:crypto";
import type {
  EndingResolution,
  NarrativeCandidate,
  Story,
  StoryEvent,
} from "../src/types";
import { CHAPTER_LENGTH_PRESETS, type ChapterLengthMode } from "../src/storyConfig";
import { currentRevision } from "../src/storyDomain";
import { safetyCategories } from "./safetyService";
import { candidateKitForGenre, sceneKitForGenre } from "./genreProfiles";

export interface GeneratedChapter {
  title: string;
  paragraphs: string[];
  model: string;
  usageTokens?: number;
  usageEstimated?: boolean;
  endingResolution?: EndingResolution;
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
  targetCharacters: number;
  minCharacters: number;
  maxCharacters: number;
  storyArc: StoryArcPhase;
  conversationContext: ConversationContext;
}

export interface StoryArcPhase {
  id: "opening" | "expansion" | "escalation" | "convergence" | "finale";
  label: string;
  progress: number;
  volumeNumber: number;
  totalVolumes: number;
  chapterInVolume: number;
  volumeChapterCount: number;
  guidance: string;
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

export function storyArcPhase(chapterCount: number, targetChapterCount: number): StoryArcPhase {
  const safeTarget = Math.max(1, targetChapterCount);
  const plannedVolumeSize = safeTarget <= 80 ? 20 : safeTarget <= 200 ? 25 : 50;
  const totalVolumes = Math.ceil(safeTarget / plannedVolumeSize);
  const nextChapter = Math.min(safeTarget, Math.max(1, chapterCount + 1));
  const volumeNumber = Math.min(totalVolumes, Math.ceil(nextChapter / plannedVolumeSize));
  const volumeStart = (volumeNumber - 1) * plannedVolumeSize + 1;
  const volumeEnd = Math.min(safeTarget, volumeNumber * plannedVolumeSize);
  const chapterInVolume = nextChapter - volumeStart + 1;
  const volumeChapterCount = volumeEnd - volumeStart + 1;
  const volumeProgress = chapterInVolume / volumeChapterCount;
  const progress = Math.min(1, Math.max(0, nextChapter / safeTarget));
  const base = { progress, volumeNumber, totalVolumes, chapterInVolume, volumeChapterCount };
  const finalVolume = volumeNumber === totalVolumes;
  if (volumeProgress <= 0.15) return { ...base, id: "opening", label: finalVolume ? "终卷起势" : "卷首立题", guidance: finalVolume ? "重新确认结局前置条件与最终人物选择；停止扩建世界，只让已建立的因果进入终局" : "建立本卷阶段目标、核心关系与局部规则；承接上一卷后果，不重复全书开篇" };
  if (volumeProgress <= 0.45) return { ...base, id: finalVolume ? "escalation" : "expansion", label: finalVolume ? "终局升级" : "本卷展开", guidance: finalVolume ? "让主要支线汇入最终冲突，逐项满足结局前置条件，不再新增大型支线" : "扩展本卷人物、场域和次级目标，让当前选择形成可追溯后果" };
  if (volumeProgress <= 0.78) return { ...base, id: "escalation", label: finalVolume ? "终局合流" : "本卷升级", guidance: finalVolume ? "合并主要矛盾与角色弧，把长期代价推至不可回避的位置" : "兑现本卷早期伏笔、提高代价并形成阶段转折，同时保留后续卷的成长空间" };
  if (!finalVolume) return { ...base, id: "convergence", label: "卷末转折", guidance: "收束本卷阶段目标并兑现局部胜负；留下由本卷选择自然产生的新局面，推动下一卷而非提前结束全书" };
  return { ...base, id: "finale", label: "终局兑现", guidance: "集中回应开篇因果、角色弧和结局契约；停止新增支线，在目标章完成可交付的正式结局" };
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
  endingResolution?: EndingResolution;
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
  chapterLength: ChapterLengthMode = "standard",
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
  const storyArc = storyArcPhase(story.chapters.length, story.targetChapterCount);
  const candidateKit = candidateKitForGenre(story.genre);
  const isTerminalChapter = story.chapters.length + 1 >= story.targetChapterCount && storyArc.id === "finale";
  const continuingPatterns: CandidateDraft[] = [
    {
      creativeAxis: axes[0 % axes.length],
      event: `${leadName}在推进“${story.storyGene.visibleGoal}”时，${candidateKit.disruption}`,
      cause: `${storyArc.label}中的既有选择开始显露后果`,
      cost: "必须放弃一种最稳妥的推进方式，并让同伴看见真实顾虑",
      impact: `${storyArc.guidance}，同时改变一段重要关系`,
      novelty: `${openClue?.title ?? axes[0]}不再只是背景设定，而成为人物必须亲自处理的现实阻力`,
    },
    {
      creativeAxis: axes[1 % axes.length],
      event: `${leadName}必须在${candidateKit.dilemma}之间做不可逆选择`,
      cause: candidateKit.pressureMove,
      cost: candidateKit.sacrifice,
      impact: `完成${storyArc.label}的阶段选择，同时让关系与资源承担后果`,
      novelty: "胜利来自主动放弃而非获得更多信息",
    },
    {
      creativeAxis: axes[2 % axes.length],
      event: `${leadName}赖以推进目标的一项关键资源发生变化：${candidateKit.resourceShift}`,
      cause: "上一阶段留下的资源归属与人物承诺发生冲突",
      cost: "主角必须公开承担一次判断失误",
      impact: `把世界规则、人物隐藏需求与${storyArc.label}的阶段目标连接起来`,
      novelty: "用资源和关系的状态变化推进情节，而不是依赖新角色直接说明答案",
    },
    {
      creativeAxis: axes[3 % axes.length],
      event: `${leadName}在最熟悉的行动场域里确认：${candidateKit.ruleShift}`,
      cause: "原本稳定的环境与阶段目标开始互相排斥",
      cost: "必须离开当前优势位置并接受一次公开检验",
      impact: `打开新的行动范围，并按${storyArc.label}要求回收早期承诺`,
      novelty: "由行动场域和规则变化构成反转，而不是突然揭晓幕后身份",
    },
    {
      creativeAxis: axes[4 % axes.length],
      event: `${leadName}把“${axes[4 % axes.length]}”造成的长期代价公开，并邀请同伴共同重订行动边界`,
      cause: "隐瞒代价已经开始伤害协作与阶段目标",
      cost: candidateKit.sacrifice,
      impact: `让人物关系与${storyArc.label}的阶段成果同时进入新状态`,
      novelty: "通过公开边界改变合作结构，而不是靠意外伤亡制造转折",
    },
  ];
  const terminalPatterns: CandidateDraft[] = [
    {
      creativeAxis: axes[0 % axes.length],
      event: `${leadName}兑现结局契约：“${story.endingContract.targetEnding}”`,
      cause: "此前各卷的选择、关系与世界规则终于汇入同一场终局行动",
      cost: story.storyGene.recurringCost,
      impact: `明确完成结局前置条件：${story.endingContract.prerequisites.join("；")}`,
      novelty: "结局由长期因果和人物选择共同完成，而不是外力突然解决",
    },
    {
      creativeAxis: axes[1 % axes.length],
      event: `${leadName}与关键同伴共同完成最后行动，使“${story.endingContract.targetEnding}”成为不可逆的现实`,
      cause: "主要支线已经合流，人物必须承担此前保留下来的持续代价",
      cost: story.storyGene.recurringCost,
      impact: `逐项兑现：${story.endingContract.prerequisites.join("；")}`,
      novelty: "最终胜利保留真实损失，也让角色弧在行动中闭合",
    },
    {
      creativeAxis: axes[2 % axes.length],
      event: `${leadName}完成最后一次不可逆选择，并以“${story.endingContract.targetEnding}”结束核心冲突`,
      cause: "所有可延后的矛盾都已到达结局契约规定的边界",
      cost: story.storyGene.recurringCost,
      impact: `世界与关系进入可稳定延续的新状态；${story.endingContract.prerequisites.join("；")}`,
      novelty: "终章回应开篇因果，不开启新的大型问题",
    },
    {
      creativeAxis: axes[3 % axes.length],
      event: `${leadName}确认核心目标、重要关系与世界秩序均已获得最终结果：“${story.endingContract.targetEnding}”`,
      cause: "终卷已经回收所有决定结局的前置条件",
      cost: story.storyGene.recurringCost,
      impact: `以具体后果完成角色告别：${story.endingContract.prerequisites.join("；")}`,
      novelty: "尾声展示选择后的生活，而非制造下一次危机",
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
  const localPatterns = isTerminalChapter ? terminalPatterns : continuingPatterns;
  const patterns = externalDrafts && externalDrafts.length >= 3
    ? externalDrafts.slice(0, 5)
    : localPatterns;
  const candidates = patterns.map<NarrativeCandidate>((pattern, index) => {
    const candidateText = `${pattern.event} ${pattern.cause} ${pattern.cost} ${pattern.impact}`;
    const hardReasons: string[] = [];
    const nextChapterNumber = (story.chapters.at(-1)?.number ?? 0) + 1;
    const opensMajorBranch = /开启|引入|发现|出现|前往|踏上/.test(candidateText) && /新世界|新大陆|新势力|新组织|新任务|新谜团|新敌人|大型支线|下一阶段冒险/.test(candidateText);
    if (storyArc.volumeNumber === storyArc.totalVolumes && opensMajorBranch) {
      hardReasons.push("违反终卷阶段：不得开启新的大型支线、世界或势力");
    }
    if (isTerminalChapter) {
      const endingSignals = [story.endingContract.targetEnding, ...story.endingContract.prerequisites];
      if (!endingSignals.some((signal) => candidateText.includes(signal))) {
        hardReasons.push("违反终局契约：目标章候选没有兑现结局或任何必要前置条件");
      }
    }
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
  const lengthPreset = CHAPTER_LENGTH_PRESETS[chapterLength];
  return {
    selected,
    candidates,
    memories,
    filterSummary: `${candidates.length} 个短候选；${candidates.filter((item) => item.score === 0).length} 个硬冲突被阻断；固定预算检索 ${memories.length} 条来源。`,
    targetParagraphs: lengthPreset.targetParagraphs,
    targetCharacters: lengthPreset.targetCharacters,
    minCharacters: lengthPreset.minCharacters,
    maxCharacters: lengthPreset.maxCharacters,
    storyArc,
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
    `全书篇幅规划：当前第 ${story.chapters.length + 1} / ${story.targetChapterCount} 章，进度 ${(plan.storyArc.progress * 100).toFixed(1)}%；第 ${plan.storyArc.volumeNumber} / ${plan.storyArc.totalVolumes} 卷，本卷第 ${plan.storyArc.chapterInVolume} / ${plan.storyArc.volumeChapterCount} 章，阶段=${plan.storyArc.label}。阶段要求：${plan.storyArc.guidance}。结局前置条件：${story.endingContract.prerequisites.join("；")}。`,
    `上一章：第${latest?.number ?? 0}章《${latest?.title ?? "序章"}》。`,
    `入选剧情胶囊：事件=${plan.selected.event}；原因=${plan.selected.cause}；代价=${plan.selected.cost}；影响=${plan.selected.impact}。`,
    `结构化转换：参与者=${plan.selected.participantNames?.join("、") || "无"}；时间=${plan.selected.storyTime}；依赖=${plan.selected.dependsOnEventIds?.join("、") || "无"}；知识声明=${plan.selected.knowledgeClaims?.map((claim) => `${claim.characterName}:${claim.fact}`).join("、") || "无"}；物品转换=${plan.selected.itemTransitions?.map((item) => `${item.actorName}:${item.itemName}:${item.fromStatus}->${item.toStatus}`).join("、") || "无"}。`,
    `人物结构化状态：\n${characterState}`,
    `伏笔状态：${clueState || "无"}。物品账本：${itemState || "无"}。篇幅目标：${plan.targetCharacters} 个中文字符（含标点，不计空白），必须在 ${plan.minCharacters}—${plan.maxCharacters} 字之间；写成 ${plan.targetParagraphs} 个完整段落，允许误差不超过 1 段。`,
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
  const isTerminalChapter = number >= story.targetChapterCount && plan.storyArc.id === "finale";
  const title = isTerminalChapter ? "终章 · 回声归处" : axisTitle[plan.selected.creativeAxis] ?? `第 ${number} 次回声`;
  const memory = plan.memories[0]?.text.replace(/\s+/g, " ").slice(0, 150) || story.summary.slice(0, 150);
  const sceneKit = sceneKitForGenre(story.genre);
  const endingPrerequisites = story.endingContract.prerequisites.join("；");
  const terminalParagraphPool = [
    `${sceneKit.setting}。这是所有既定期限汇合的最后一天，${lead}没有再寻找能够拖延决定的借口。他把各卷留下的记录、损失和承诺逐一摆开，让每个参与者都确认终局不是突然降临，而是他们此前每一次选择共同推到眼前的结果。`,
    `${plan.selected.event}。直接原因是${plan.selected.cause}。这一次，行动不再为了打开新的可能，而是要给已经建立的核心冲突一个不可撤销的答案；任何未被承担的代价都会使结果失去意义。`,
    `上一阶段的记忆仍然清楚：“${memory}”。${lead}没有把它当作煽情的回顾，而是用来核对今天的选择是否真的回应了最初问题。开篇时无法说出口的需要、途中反复出现的错误和此刻能够承担的责任，终于落在同一条因果线上。`,
    `结局契约被完整确认：${story.endingContract.targetEnding}。必要前置条件也逐项兑现：${endingPrerequisites}。众人没有用一句宣告代替事实，而是分别拿出行动结果、关系变化与世界状态作为可以复查的证明。`,
    `${lead}先完成${sceneKit.action}，把最后方案从口头承诺变成现实。${sceneKit.pressure}同时到达最高点，过去最有效的捷径仍然摆在面前，但那条路会抹去一路承担的损失，也会让所谓胜利重新建立在旧错误之上。`,
    `关键同伴没有站在旁边等待主角独自解决一切。每个人按此前明确的边界承担自己的部分，赞同者交出资源，反对者指出风险，曾经离开的人也只完成自己愿意负责的动作。${sceneKit.relationship}因此从剧情奖励变成了共同选择的结果。`,
    `对手或旧规则发动最后一次反制，试图证明人们只能回到原来的运行方式。${lead}没有依靠突然出现的力量，也没有让新的陌生人物替所有人收场，而是调动早已建立的能力、信息和关系，一项一项拆掉反制成立的条件。`,
    `真正困难的并非能否取胜，而是取胜以后是否仍愿意支付${story.storyGene.recurringCost}。${lead}公开说出这项代价，拒绝把它藏在庆祝之后；承担者可以同意，也可以退出，没有任何人被宏大目标要求无条件牺牲。`,
    `最后选择到来时，两条路都已经足够清楚。${lead}放弃那条能够保全个人利益、却会恢复旧秩序的道路，转而选择让长期目标真正落地的方案。这个决定回应了“${story.storyGene.hiddenNeed}”，也让角色成长表现为行动而不是一段临时感悟。`,
    `行动进入最紧张的时刻，先前保存的每一项阶段成果都发挥了具体作用。有人守住资源，有人修正判断，有人承担外部压力；${lead}只负责那项无人能够代替的最终决定。多年或数卷积累没有被压缩成幸运，而是共同构成胜负的真实重量。`,
    `局势终于改变。${sceneKit.consequence}也随之落定，核心冲突失去了继续按旧方式运转的条件。胜利并不完美，失去的部分仍然存在，但造成伤害的机制已经被关闭、改写或交到能够公开制衡的人手中。`,
    `短暂安静以后，众人首先确认彼此状态，而不是急着宣布传奇。伤势被处理，责任被记录，承诺有了明确去向。过去被忽略的人能够说出自己的版本，最终结果因此不只属于最强者，也不只留下胜利者的叙述。`,
    `${story.endingContract.targetEnding}不再是一句计划，而成为此刻可以观察的现实。${lead}看见目标实现后的具体样子，也确认它保留了此前所有重要选择的痕迹；结局没有让痛苦失效，却让那些痛苦不必继续以同样方式发生。`,
    `关系也得到明确答案。有人选择留下，有人完成告别，有人只把误解说清便走向自己的生活。${lead}没有要求所有关系都恢复如初，而是接受信任、距离与边界各自真实的形状，这正是一路变化最终能够稳定下来的原因。`,
    `${lead}重新审视自己最初追逐的“${story.storyGene.visibleGoal}”。目标已经完成或获得不可逆的结果，但更重要的是，他不再需要用同一种旧方式证明自身价值。“${story.storyGene.hiddenNeed}”因此在最后选择中得到回答。`,
    `世界的新状态由具体规则确认：谁拥有决定权，资源如何分配，错误怎样被纠正，弱者如何拒绝。众人把这些内容写进可执行的约定，并留下监督与退出机制，避免一场胜利只更换掌权者却保留相同伤害。`,
    `那些没有回到现场的人也被认真记住。名字、选择与损失没有被终局的光亮遮住，${lead}承认自己无法补回全部遗憾，只能确保后来者知道今天的道路由哪些代价铺成。记忆因此成为责任，而不是继续制造仇恨的借口。`,
    `数日之后，最普通的生活重新出现。灯按时亮起，工作与训练恢复，人们仍会争执，也仍要为资源作出选择；不同的是，旧机制不再替他们预先决定答案，每个人获得了真正能够使用的选择权。`,
    `${lead}完成最后一次复盘，把已经解决的主线、已经兑现的承诺和需要由日常维护的规则分别归档。记录中没有制造新的危机，也没有暗示某个更强敌人正在门外等待；它只诚实说明，结局之后的生活仍需要人们继续负责。`,
    `曾经反复出现的象征或旧物被放回合适的位置。它不再指向谜团或任务，而只是见证人物从哪里出发、最终作出了什么选择。${lead}能够看见它而不再被旧恐惧支配，这个细小变化比任何宣言更接近真正的自由。`,
    `告别没有持续太久。同行者各自带走属于自己的成果，也留下愿意共同维护的底线。没有人承诺从此永不失败，他们只确认即使以后犯错，也不会再用沉默、牺牲他人或抹除事实来换取表面安稳。`,
    `暮色落下时，${sceneKit.setting}。${lead}最后回望一次，确认门已经关好、名字已经留下、该说的话也都说完。随后他走向已经由自己选择的生活；故事停在这个完整的动作上，核心因果、人物弧与结局契约都获得了清楚的落点。`,
  ];
  const terminalDetailLayers = [
    `每一项材料都标有来源，任何人都可以指出其中的遗漏，而不是被要求相信主角的权威。`,
    `选择的边界被说清以后，终局第一次不再依赖误会或信息差维持紧张。`,
    `过去的失败仍然影响今天的资源和关系，因此结局保留了长篇应有的累积重量。`,
    `前置条件对应到具体行动与结果，避免用抽象的“终于成功”跳过真正兑现过程。`,
    `这次行动留下明确反馈，使人物知道最后一步改变了什么、没有改变什么。`,
    `合作来自知情同意，任何人的贡献都没有被缩写成主角胜利的背景。`,
    `反制失败有既有因果支撑，不需要临时削弱对手或修改世界规则。`,
    `代价被写进最终结果，胜利因此既值得庆祝，也值得保持克制。`,
    `角色弧在关键动作中闭合，先前反复出现的内在矛盾获得了可见答案。`,
    `所有阶段成果各自完成一次作用，证明多卷规划并非可以随意删去的装饰。`,
    `结果改变的是可持续结构，而不只是眼前一次输赢。`,
    `他们允许沉默与悲伤存在，没有用欢呼强迫所有人同时释怀。`,
    `契约的文字与现实状态完全对应，因此完结不是按章数强制贴上的标签。`,
    `关系结果保留差异，也阻止圆满被误写成所有人回到原位。`,
    `主角仍保有缺点，却已经能够用新的选择回应它。`,
    `新规则具有执行者、监督者和纠错方式，不会在尾声里凭愿望自动生效。`,
    `缺席者的因果被回收，重要损失没有从最终版本中消失。`,
    `生活的恢复证明危机已经结束，而非被暂停到另一个悬念。`,
    `归档把结束与维护区分开来，让开放的人生不等于未完成的故事。`,
    `旧物完成象征功能以后保持安静，不再承担续作预告。`,
    `有限承诺比永恒誓言更可信，也更符合人物一路形成的边界。`,
    `最后画面回应开篇空间，却让人物的位置和选择发生了不可逆变化。`,
  ];
  const paragraphPool = [
    `${sceneKit.setting}。${lead}最先注意到的不是最响亮的变化，而是熟悉节奏里那半拍迟疑。它单独看并不起眼，放回上一章留下的因果后，却意味着某个已经作出的选择正在产生新的回声，而今天必须有人决定如何接住它。`,
    `${plan.selected.event}。这件事并非凭空发生，直接原因是${plan.selected.cause}。${lead}没有让突如其来的解释替代事实，而是先分清哪些变化亲眼可见、哪些只是他人判断，又有哪些后果已经真实落在具体的人身上。`,
    `上一章留下的记忆重新浮上来：“${memory}”。当时不受注意的动作，如今在新的因果位置上显得格外清楚。${lead}把过去的承诺与眼前局面并排，确认这不是可以一笑置之的小波动，而是${plan.storyArc.label}必须处理的阶段性问题。`,
    `${lead}先采取了最小的一步：${sceneKit.action}。这一步无法直接完成“${story.storyGene.visibleGoal}”，却能验证当前判断是否站得住。结果很快出现，其中一部分与预期一致，另一部分却把“${plan.selected.creativeAxis}”从背景推到了行动正中央。围观者的反应也被如实保留，因为同一个结果落在不同人物身上，往往会产生完全不同的下一步。`,
    `第一位作出回应的人没有立刻赞同。他担心${sceneKit.pressure}会因为这次行动全面失控，也质疑${lead}是否准备好承担后果。${lead}没有用一句保证压过对方，而是把已知、未知与必须在今天决定的部分分别说清，让争执至少建立在同一组事实之上。`,
    `新的分歧落在${sceneKit.relationship}。有人愿意继续同行，但要求看见更完整的计划；有人选择暂时后退，也留下自己能够承担的帮助。关系没有因为一次对话变得牢不可破，却从模糊的好意变成了可以检验的承诺。`,
    `阻力比预想更早到来。原本可用的资源被收回，最合适的时间窗口也开始缩短，外部规则仿佛专门针对他们刚刚商定的方案调整。${lead}逐项确认变化，没有把所有不顺都归咎于同一个敌人；有些只是局势，有些才是主动施加的压力。`,
    `在重新安排资源时，${lead}发现一条先前被忽略的路径。它不够安全，也无法带来立刻胜利，却能绕开当前最坚硬的限制。真正的问题不再是“能不能走”，而是谁先走、谁留下，以及失败后还有没有第二次尝试的余地。${lead}把最坏结果也摆到众人面前，拒绝用含糊的乐观换取同意。`,
    `两种选择很快变得无法兼得：一边能够直接推进目标，另一边能够保护刚刚建立的信任。${lead}试图寻找没有损失的第三条路，最终承认那只会拖到两边同时失去。选择之所以重要，正因为它会明确留下不能撤销的部分。`,
    `${lead}作出决定，并把理由清楚告诉所有受影响的人。这个决定意味着${plan.selected.cost}。没有任何漂亮说法能够抹去代价；能做的只有提前约定边界、为被放弃的一侧保留补救路径，并确保损失不会被后来叙述成从未发生。`,
    `行动开始后，先前那次“${sceneKit.action}”不再只是试探。${lead}根据现场变化连续调整两次，第一次守住了关键条件，第二次却暴露自身判断中的空缺。局面因此没有按照任何人的完整计划发展，但至少仍在可以理解和承担的范围内。`,
    `真正的转折来自一位此前保持沉默的人。对方没有提供万能答案，只指出${lead}一直把两个不同问题当成了同一件事：眼前胜负属于今天，长期目标却要跨过许多章节才能兑现。若为一次结果耗尽所有筹码，后面的路便只剩重复。这个提醒也让此前的争执换了角度——不同意见未必来自背叛，可能只是各自在保护不同的未来。`,
    `这个提醒改变了行动的尺度。${lead}放弃追求一次解决全部矛盾，转而拿下一个能够长期保留的阶段成果。${plan.selected.impact}。它看起来不如彻底胜利耀眼，却让人物、规则和资源都进入了新的状态，后续故事有了真实的生长点。`,
    `阶段成果落地的同时，${sceneKit.consequence}也随之显现。损失没有被好运抵消，也没有因为结果尚可就变得不值一提。${lead}把它明确告诉同伴，因为隐瞒代价只会让下一次计划建立在错误边界上，最终伤害同样的人。`,
    `短暂休整中，${lead}意识到自己真正需要面对的是“${story.storyGene.hiddenNeed}”。这不是靠一次领悟就能完成的角色弧，而是会在未来相似选择里反复被检验。今天能够做到的，只是在旧习惯出现时，比上一次更早看见它。`,
    `众人重新分配下一步责任。每个人只承担自己明确同意的部分，退出条件与求助信号也被说清。${sceneKit.relationship}仍然存在裂缝，但这种带着边界的合作比含混热血更可靠，也让彼此不必靠猜测维持同路。分工完成以后，最难的任务并没有自动落给最强的人，而是交给真正掌握必要信息并愿意承担的人。`,
    `复盘时，唯一无法归位的细节恰好指向“${plan.selected.novelty}”。此前它只是一个大胆设想，如今已经被两次独立变化支持。更重要的是，这个发现没有抹掉旧因果，而是解释了旧选择为何会在今天以不同形式回来。`,
    `${lead}设计了一次规模很小的二次验证，只改变无关紧要的变量，不拿无辜者测试猜想。结果在可接受的时间内出现，证明现有规则确实会对他们的行动作出反应，也暴露出规则无法覆盖的短暂空隙。`,
    `反应让局面再次升温。${sceneKit.pressure}同时压向团队，刚刚得到的阶段成果随时可能被夺回。${lead}没有执着守住所有东西，而是优先保留能重建行动链的核心，让一次被迫撤退仍然能够为下一次前进提供依据。`,
    `压力稍退后，最年轻的同伴问这一切是否值得。${lead}没有给出激昂答案，只说现在至少知道损失因何发生，也知道下一次可以怎样少付一点代价。人们继续前进，不是因为不再害怕，而是因为风险终于有了可以共同面对的形状。`,
    `回到暂时稳定的位置后，他们完成三件小事：确认彼此状态、保存阶段成果、写下尚未解决的问题。${lead}特意把反对意见也保留下来，避免未来只剩胜利者的版本。今天的答案有限，但任何后来者都能看见决定如何一步步成立。那份记录还标出了下一次必须复核的条件，防止阶段成功被误读成永久安全。`,
    `就在众人以为可以暂时休息时，先前那个反常细节再次出现，并准确回应了他们尚未公开的行动。新的变化说明对方或规则不只知道结果，还能观察某些过程；这里从一开始就不真正安全，下一章的时间窗口已经开始缩短。${lead}没有惊动众人，只先确认撤离方向仍然有效。`,
  ];
  const detailLayers = [
    `${lead}把这个微小变化记下来，因为真正能支撑长篇因果的细节，往往不是当下最惊人的那个。`,
    `为了避免被既有猜测带偏，${lead}同时保留另一种解释，并写下什么结果能够推翻自己。`,
    `记忆里一个停顿与今天的节奏完全重合，说明前后两章并非靠相似气氛勉强连接。`,
    `验证留下了可复查的结果，也让参与者清楚知道这一步究竟改变了什么。`,
    `争论没有立即结束，但最响亮的声音不再能够代替所有人的判断。`,
    `有人主动说出自己的底线，这让合作范围缩小，却也第一次变得可信。`,
    `规则变化有明确先后，说明阻力并非全知全能，仍然受制于时间和资源。`,
    `${lead}为这条路径留下退出方案，避免勇敢成为要求别人无条件冒险的借口。`,
    `两种选择都有人受益也有人受损，决定因此不能被包装成唯一正确答案。`,
    `决定公布后没有人欢呼，每个人只是确认自己需要承担的那一部分。`,
    `第二次调整来自现场而非预设大纲，人物判断因此真正参与了结果。`,
    `沉默者说完便退回人群，没有借一条信息夺走其他人的行动权。`,
    `阶段成果被写成可延续的状态，而不是一句“问题解决”草草收场。`,
    `${lead}没有隐瞒自身状态，避免同伴用错误边界规划下一次行动。`,
    `旧习惯仍在起作用，成长只体现在${lead}比过去更早意识到它。`,
    `分工里没有模糊的“见机行事”，何时求助与何时退出都被明确说出。`,
    `两次变化来自不同位置却指向同一结构，推断因此超出个人直觉。`,
    `验证不伤害无辜者，这是${lead}拒绝越过的边界，也是人物选择的一部分。`,
    `被迫放弃的部分同样被记录，未来若要找回，必须承认今天为何失去。`,
    `一杯水或一次沉默陪伴无法解决危机，却让承担代价的人仍被具体看见。`,
    `阶段记录分别交给不同的人保存，即使一处失守，也能重建主要因果。`,
    `${lead}没有立刻追向新变化，而是先让所有人看见它，避免下一章再次从信息差开始。`,
  ];
  const sourceParagraphs = isTerminalChapter ? terminalParagraphPool : paragraphPool;
  const sourceDetails = isTerminalChapter ? terminalDetailLayers : detailLayers;
  const paragraphs = sourceParagraphs.slice(0, plan.targetParagraphs);
  let characterCount = paragraphs.join("").replace(/\s/g, "").length;
  for (let index = 0; index < paragraphs.length && characterCount < plan.minCharacters; index += 1) {
    paragraphs[index] += sourceDetails[index];
    characterCount = paragraphs.join("").replace(/\s/g, "").length;
  }
  if (isTerminalChapter && characterCount < plan.minCharacters) {
    paragraphs[paragraphs.length - 1] += `终局核验完成以后，众人又按时间顺序复述了一遍核心因果：最初的目标如何形成，各卷选择怎样改变人物和规则，持续代价由谁承担，结局前置条件又分别在哪些行动中兑现。每一项都能在正史记录里找到来源，也能由不止一个参与者确认。${lead}因此知道，这个结束不会因一句漂亮话成立，也不会因往后的普通生活而失效；它已经成为所有人共同经历、共同承担且无法被轻易抹除的事实。`;
  }
  return {
    title,
    model: "platform-writer",
    paragraphs,
    endingResolution: isTerminalChapter ? {
      targetEndingSatisfied: true,
      targetEndingEvidence: paragraphs[3],
      satisfiedPrerequisiteIndices: story.endingContract.prerequisites.map((_, index) => index),
      prerequisiteEvidence: story.endingContract.prerequisites.map((_, prerequisiteIndex) => ({ prerequisiteIndex, evidence: paragraphs[3] })),
      noContinuationHook: true,
    } : undefined,
  };
}

export function validateGeneratedChapter(
  story: Story,
  generated: GeneratedChapter,
  plan: GenerationPlan,
  extracted?: ExtractedChapterState,
) {
  if (!generated.title.trim() || generated.paragraphs.length < 4) {
    throw new Error("章节未通过完整性校验，已阻止发布。");
  }
  if (Math.abs(generated.paragraphs.length - plan.targetParagraphs) > 1) {
    throw new Error(`章节长度为 ${generated.paragraphs.length} 段，偏离目标 ${plan.targetParagraphs} 段，已阻止发布。`);
  }
  const content = generated.paragraphs.join("\n");
  const characterCount = content.replace(/\s/g, "").length;
  if (characterCount < plan.minCharacters || characterCount > plan.maxCharacters) {
    throw new Error(`章节字数为 ${characterCount} 字，要求 ${plan.minCharacters}—${plan.maxCharacters} 字，已阻止发布。`);
  }
  const nextChapterNumber = (story.chapters.at(-1)?.number ?? 0) + 1;
  if (nextChapterNumber >= story.targetChapterCount && !endingContractSatisfied(story, content, generated.endingResolution ?? extracted?.endingResolution)) {
    throw new Error("目标章没有完整兑现结局契约与必要前置条件，已阻止完结。");
  }
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

export function endingContractSatisfied(story: Story, content: string, resolution?: EndingResolution): boolean {
  if (!resolution?.targetEndingSatisfied || !resolution.noContinuationHook) return false;
  const normalized = content.replace(/\s/g, "");
  const evidenceAppears = (evidence: string) => {
    const normalizedEvidence = evidence.replace(/\s/g, "");
    return normalizedEvidence.length >= 8 && normalized.includes(normalizedEvidence);
  };
  const satisfied = new Set(resolution.satisfiedPrerequisiteIndices);
  if (!story.endingContract.prerequisites.every((_, index) => satisfied.has(index))) return false;
  if (!evidenceAppears(resolution.targetEndingEvidence)) return false;
  if (!story.endingContract.prerequisites.every((_, index) => resolution.prerequisiteEvidence.some((item) => item.prerequisiteIndex === index && evidenceAppears(item.evidence)))) return false;
  return !/下一章|未完待续|故事才刚刚开始|新的冒险即将|更大的[^。！？]{0,20}等待|新的敌人[^。！？]{0,20}出现/.test(normalized);
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
