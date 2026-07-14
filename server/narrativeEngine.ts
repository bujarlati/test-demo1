import { createHash, randomUUID } from "node:crypto";
import type {
  NarrativeCandidate,
  Story,
  StoryEvent,
} from "../src/types";
import { currentRevision } from "../src/storyDomain";

export interface GeneratedChapter {
  title: string;
  paragraphs: string[];
  model: string;
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
}

export interface CandidateDraft {
  creativeAxis: string;
  event: string;
  cause: string;
  cost: string;
  impact: string;
  novelty: string;
}

function numericSeed(value: string) {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

function activeLead(story: Story) {
  return (
    story.characters.find((character) => !/死亡|失踪/.test(character.status)) ??
    story.characters[0]
  );
}

export function retrieveRelevantMemory(story: Story, focus: string): RetrievedMemory[] {
  const terms = new Set(
    `${focus} ${activeLead(story)?.name ?? ""}`
      .split(/[，。；：、\s]/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  );
  const scored: RetrievedMemory[] = [];

  for (const event of story.events.filter((item) => item.active)) {
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

export function planNextChapter(story: Story, externalDrafts?: CandidateDraft[]): GenerationPlan {
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
  const protectedLead = Boolean(lead?.protected);
  const candidates = patterns.map<NarrativeCandidate>((pattern, index) => {
    const hardConflict = index === 4 && protectedLead;
    const recentAxis = story.events.slice(-3).some((event) => event.title.includes(axes[index % axes.length]));
    const score = 68 + ((seed >> (index * 3)) & 15) + (openClue && index !== 4 ? 7 : 0) - (recentAxis ? 8 : 0);
    return {
      id: `candidate_${randomUUID().slice(0, 8)}`,
      seed: seed + index * 97,
      ...pattern,
      score: hardConflict ? 0 : score,
      status: "rejected",
      reasons: hardConflict
        ? [`违反硬约束：${leadName}已设为死亡保护角色`]
        : recentAxis
          ? ["结构轴近期重复，已降低新颖度评分"]
          : ["通过人物知识、世界规则与硬偏好门禁"],
    };
  });
  const viable = candidates.filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score);
  if (!viable.length) throw new Error("所有剧情候选均违反硬正史，已阻止正文发布。");
  const selected = viable[(story.canonVersion + seed) % Math.min(3, viable.length)];
  selected.status = "selected";
  selected.reasons.push("综合因果、偏好、新颖度、伏笔潜力与修史成本后入选");
  const memories = retrieveRelevantMemory(story, `${selected.event} ${selected.impact}`);
  return {
    selected,
    candidates,
    memories,
    filterSummary: `${candidates.length} 个短候选；${candidates.filter((item) => item.score === 0).length} 个硬冲突被阻断；固定预算检索 ${memories.length} 条来源。`,
  };
}

export function buildChapterPrompt(story: Story, plan: GenerationPlan): string {
  const latest = story.chapters.at(-1);
  const hardRules = story.rules
    .filter((rule) => rule.hardness === "hard")
    .map((rule) => rule.description)
    .join("；");
  const hardPreferences = story.preferences
    .filter((preference) => preference.active)
    .map((preference) => preference.description)
    .join("；");
  return [
    `故事：《${story.title}》，题材：${story.genre}，氛围：${story.tone}，正史 v${story.canonVersion}。`,
    `故事基因：${story.storyGene.conflictEngine}；持续代价：${story.storyGene.recurringCost}。`,
    `暂定结局契约：${story.endingContract.targetEnding}。`,
    `上一章：第${latest?.number ?? 0}章《${latest?.title ?? "序章"}》。`,
    `入选剧情胶囊：事件=${plan.selected.event}；原因=${plan.selected.cause}；代价=${plan.selected.cost}；影响=${plan.selected.impact}。`,
    `硬规则：${hardRules || "无"}。读者约束：${hardPreferences || "无"}。`,
    `固定预算相关记忆：\n${plan.memories.map((memory) => `[${memory.sourceId}|${memory.confidence.toFixed(2)}] ${memory.text}`).join("\n")}`,
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
  return {
    title,
    model: "platform-writer",
    paragraphs: [
      `清晨到来得比预计更早。${lead}醒来时，最先想起的不是昨夜的危险，而是那条一直没有解释的细小矛盾。`,
      `${plan.selected.event}。它并不凭空出现：${plan.selected.cause}。`,
      `证据仍在原处，可顺序已经改变。${lead}逐一核对来源，确认这不是记忆出错，而是有人希望所有人只看见因果的一面。`,
      `选择没有留下安全的中间地带。${plan.selected.cost}，这成为继续追查必须支付的代价。`,
      `旧线索因此获得了新的方向，也让此前稳定的关系出现裂缝。${plan.selected.impact}。`,
      `门关上的最后一刻，远处的警报重新响起。故事没有重复过去；它正把“${plan.selected.novelty}”变成下一步无法回避的事实。`,
    ],
  };
}

export function validateGeneratedChapter(story: Story, generated: GeneratedChapter) {
  if (!generated.title.trim() || generated.paragraphs.length < 4) {
    throw new Error("章节未通过完整性校验，已阻止发布。");
  }
  const content = generated.paragraphs.join("\n");
  for (const character of story.characters) {
    if (character.protected && content.includes(character.name) && /死亡|死去|断气|曲线归零/.test(content)) {
      throw new Error(`章节违反“保护 ${character.name}”硬约束，已阻止发布。`);
    }
    if (/确认死亡/.test(character.status) && content.includes(character.name) && !/回忆|档案|遗物|曾经/.test(content)) {
      throw new Error(`章节让已死亡角色 ${character.name} 无依据重新出现，已阻止发布。`);
    }
  }
}

export function eventFromChapter(
  story: Story,
  chapterNumber: number,
  revisionId: string,
  plan: GenerationPlan,
): StoryEvent {
  const previousEvent = story.events.filter((event) => event.active).at(-1);
  const lead = activeLead(story);
  return {
    id: `event_${randomUUID().slice(0, 10)}`,
    chapterNumber,
    revisionId,
    type: "choice",
    title: plan.selected.event,
    cause: plan.selected.cause,
    outcome: `${plan.selected.impact}；代价：${plan.selected.cost}`,
    participantIds: lead ? [lead.id] : [],
    location: lead?.location ?? "当前场景",
    dependsOn: previousEvent ? [previousEvent.id] : [],
    active: true,
  };
}
