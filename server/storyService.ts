import { randomUUID } from "node:crypto";
import type {
  Chapter,
  CreateStoryInput,
  Story,
  StorySummary,
} from "../src/types";
import {
  eventFromChapter,
  generateLocalChapter,
  type GeneratedChapter,
  type GenerationPlan,
  validateGeneratedChapter,
} from "./narrativeEngine";

export function summarizeStory(story: Story): StorySummary {
  const activeChapter =
    story.chapters.find((chapter) => chapter.id === story.readingProgress.chapterId) ??
    story.chapters.at(-1);
  const latest = story.chapters.at(-1);
  return {
    id: story.id,
    title: story.title,
    subtitle: story.subtitle,
    genre: story.genre,
    tone: story.tone,
    length: story.length,
    targetChapterCount: story.targetChapterCount,
    coverTheme: story.coverTheme,
    status: story.status,
    canonVersion: story.canonVersion,
    latestExcerpt: story.latestExcerpt,
    updatedAt: story.updatedAt,
    unreadCanonChanges: story.unreadCanonChanges,
    currentChapterNumber: activeChapter?.number ?? latest?.number ?? 1,
    currentChapterTitle: activeChapter?.title ?? latest?.title ?? "第一章",
    chapterCount: story.chapters.length,
    progress: Math.min(1, (latest?.number ?? 1) / story.targetChapterCount),
  };
}

interface StoryTemplate {
  title: string;
  subtitle: string;
  coverTheme: Story["coverTheme"];
  firstTitle: string;
  lead: string;
  paragraphs: string[];
  gene: Omit<Story["storyGene"], "version" | "createdAt">;
  ending: Omit<Story["endingContract"], "version" | "lastEvaluatedAt" | "status">;
}

const storyTemplates: Record<string, StoryTemplate> = {
  悬疑: {
    title: "潮汐背面",
    subtitle: "一座只在退潮时出现的车站",
    coverTheme: "tide",
    firstTitle: "无声车站",
    lead: "程野",
    paragraphs: [
      "列车在凌晨四点十七分停下，车门外没有站台，只有被潮水浸得发亮的铁轨。",
      "程野是唯一醒着的乘客。他隔着玻璃看见一块站牌，上面写着自己的名字。",
      "广播没有催促下车，只平静地念出一则发生在十二年前、从未公开的失踪案。",
      "当车门自行打开时，海风带进一张湿透的车票。目的地一栏，印着他明天的日期。",
    ],
    gene: {
      protagonistPosition: "知道一桩旧失踪案，却一直否认自己是目击者的通勤者",
      visibleGoal: "离开不存在的车站并查明车票来源",
      hiddenNeed: "承认沉默也是十二年前失踪案的一部分",
      conflictEngine: "每次列车停靠都会交换一段乘客记忆与一条现实证据",
      recurringCost: "越接近真相，现实中的身份记录越模糊",
      endingShape: "主角选择保留真相或保留自己被所有人记得的资格",
      creativeAxes: ["错误证词", "空间误导", "旧物回声", "时间票据", "身份交换"],
    },
    ending: {
      targetEnding: "失踪者被找回，但程野必须成为车站新的无名证人",
      characterArc: "从否认目击者身份到主动承担作证代价",
      prerequisites: ["车票日期出现三次", "失踪案证词互相矛盾", "程野主动说出被删掉的名字"],
    },
  },
  科幻: {
    title: "第七次日落",
    subtitle: "太阳每天都会落下，但只有她记得前六次",
    coverTheme: "moon",
    firstTitle: "重复的黄昏",
    lead: "许澄",
    paragraphs: [
      "第七次日落发生时，城市仍在庆祝第一次。",
      "许澄把前六天的日期刻在手腕内侧。每道细线都在午夜消失，只有疼痛会留下。",
      "天文台说恒星运行一切正常。她却在望远镜里看见太阳背后，藏着一颗正在模仿地球的黑色行星。",
      "她拨通无人接听的号码。电话那端传来自己的声音：这一次，不要叫醒他们。",
    ],
    gene: {
      protagonistPosition: "唯一保留时间重置记忆的天文台维修员",
      visibleGoal: "阻止第八次日落并查明黑色行星",
      hiddenNeed: "接受无法同时拯救每一个版本的人",
      conflictEngine: "每次重置保留一种身体代价，却抹除一段公共事实",
      recurringCost: "记忆越完整，身体越接近无法随世界重置",
      endingShape: "主角决定终止循环，同时告别只有自己记得的人",
      creativeAxes: ["时间误差", "身体证据", "双重观测", "关系代价", "身份交换"],
    },
    ending: {
      targetEnding: "循环停止在一个不完美但真实的清晨",
      characterArc: "从执着复原所有版本到选择一个可承担的现实",
      prerequisites: ["黑色行星可被两种仪器观测", "身体刻痕失效一次", "电话另一端身份被确认"],
    },
  },
  奇幻: {
    title: "灯塔之外",
    subtitle: "海图终点住着一位替人保管影子的守灯人",
    coverTheme: "fog",
    firstTitle: "借来的影子",
    lead: "顾遥",
    paragraphs: [
      "小镇上的孩子出生时都没有影子。等到七岁，父母才会带他们去灯塔领取一枚。",
      "顾遥领到的那枚会在夜里独自走动，还总是停在北窗前。",
      "守灯人拒绝更换，只给她一张没有海岸线的地图：“它不是你的影子，但它在等你。”",
      "当晚，灯塔熄灭了三十年来的第一盏灯。海面上出现了一条通往天空的路。",
    ],
    gene: {
      protagonistPosition: "拿错影子的制图学徒",
      visibleGoal: "把影子归还真正主人并让灯塔重新点亮",
      hiddenNeed: "承认归属来自选择而不是出生安排",
      conflictEngine: "影子会替主人承担一个愿望，也会取走一段自我",
      recurringCost: "每次使用影子的力量都会忘记一种熟悉的感觉",
      endingShape: "主角重新定义影子的归属，并保留一道无法恢复的空白",
      creativeAxes: ["旧物回声", "地图缺口", "关系代价", "身份交换", "规则反噬"],
    },
    ending: {
      targetEnding: "灯塔重新点亮，顾遥与影子以自愿契约共存",
      characterArc: "从寻找唯一正确归属到接受共同创造的身份",
      prerequisites: ["影子替她完成一次选择", "地图出现海岸线", "守灯人承认一次谎言"],
    },
  },
  治愈: {
    title: "风从面包房来",
    subtitle: "每个清晨，旧街都会收到一种刚好需要的香气",
    coverTheme: "ember",
    firstTitle: "凌晨五点的面团",
    lead: "苏禾",
    paragraphs: [
      "苏禾接手面包房的第一天，烤箱里躺着一只她没有做过的面包。",
      "它闻起来像雨后晒过的被单，也像母亲在很久以前哼过的歌。",
      "门外站着一位失眠的老人。他没有买面包，只在闻到香气后安静地哭了一会儿。",
      "第二天，烤箱又提前亮了。门把手上挂着一张字条：请替今天最需要的人烤。",
    ],
    gene: {
      protagonistPosition: "不愿继承家业却独自守着旧面包房的女儿",
      visibleGoal: "找到每天提前开机的烤箱是谁控制的",
      hiddenNeed: "允许自己哀悼，而不是只照顾别人的需要",
      conflictEngine: "面包会唤起一种被压下的记忆，但不能替人解决选择",
      recurringCost: "帮助一个人就会短暂失去一种与母亲有关的香气记忆",
      endingShape: "面包房留下，但奇迹停止，人与人开始直接说出需要",
      creativeAxes: ["气味记忆", "关系代价", "旧物回声", "日常误会", "角色镜像"],
    },
    ending: {
      targetEnding: "苏禾烤出最后一炉没有魔法的面包，并决定继续营业",
      characterArc: "从替所有人疗愈到允许别人陪自己承受失去",
      prerequisites: ["母亲的歌被完整记起", "至少一位客人拒绝奇迹", "烤箱在清晨保持安静"],
    },
  },
};

function targetChapterCount(length: string | undefined) {
  if (length?.includes("短")) return 12;
  if (length?.includes("长")) return 60;
  return Number(length?.match(/\d+/)?.[0]) || 24;
}

export function createStory(input: CreateStoryInput, ownerId: string): Story {
  const template = storyTemplates[input.genre] ?? storyTemplates.悬疑;
  const id = `story_${randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  const revisionId = `rev_${id}_1_1`;
  const chapterId = `chapter_${id}_1`;
  const characterId = `char_${id}_lead`;
  const length = input.length || "中篇 · 预计 24 章";
  return {
    id,
    ownerId,
    title: template.title,
    subtitle: input.inspiration?.trim() || template.subtitle,
    genre: input.genre,
    tone: input.tone || "由故事决定",
    length,
    targetChapterCount: targetChapterCount(length),
    inspiration: input.inspiration?.trim() || "",
    coverTheme: template.coverTheme,
    status: "active",
    activeBranchId: `branch_${id}_main`,
    canonVersion: 1,
    summary: input.inspiration?.trim() || template.subtitle,
    latestExcerpt: template.paragraphs.at(-1) ?? "故事已经开始。",
    updatedAt: createdAt,
    unreadCanonChanges: 0,
    readingProgress: { chapterId, scrollProgress: 0, updatedAt: createdAt },
    storyGene: { ...template.gene, version: 1, createdAt },
    endingContract: {
      ...template.ending,
      version: 1,
      status: "viable",
      lastEvaluatedAt: createdAt,
    },
    events: [
      {
        id: `event_${id}_1`,
        chapterNumber: 1,
        revisionId,
        type: "discovery",
        title: template.firstTitle,
        cause: "主角第一次遇见故事核心异常",
        outcome: template.paragraphs.at(-1) ?? "异常被确认存在",
        participantIds: [characterId],
        location: "故事起点",
        dependsOn: [],
        active: true,
      },
    ],
    chapters: [
      {
        id: chapterId,
        number: 1,
        title: template.firstTitle,
        currentRevisionId: revisionId,
        revisions: [
          {
            id: revisionId,
            parentRevisionId: null,
            title: template.firstTitle,
            paragraphs: template.paragraphs,
            reason: "故事基因、结局契约与第一章初始化",
            createdAt,
            modelName: "platform-writer",
            promptVersion: "story-v8",
          },
        ],
        estimatedMinutes: 6,
      },
    ],
    characters: [
      {
        id: characterId,
        name: template.lead,
        role: "主角",
        initials: template.lead.slice(0, 1),
        status: "存活",
        location: "故事起点",
        goal: template.gene.visibleGoal,
        knowledge: ["第一章中亲眼看到的异常"],
        relationship: "尚未建立稳定同盟",
        protected: false,
        accent: "jade",
      },
    ],
    rules: [
      {
        id: `rule_${id}_1`,
        title: "因果不可抹除",
        description: "异常必须留下可追溯的因果，不以梦境抹除已发生事件。",
        source: "故事基因 v1",
        hardness: "hard",
      },
    ],
    clues: [
      {
        id: `clue_${id}_1`,
        title: "第一章的异常物",
        status: "planted",
        sourceChapter: 1,
        description: "它会在后续章节提供方向，但不会立刻解释全部谜底。",
        spoiler: false,
      },
    ],
    preferences: [],
    conversation: [
      {
        id: `msg_${randomUUID().slice(0, 8)}`,
        role: "system",
        type: "progress",
        content: "故事基因、暂定结局契约与第一章已生成。你只需要阅读，故事会自行继续。",
        createdAt,
        observedCanonVersion: 1,
      },
    ],
    retcons: [],
    modelConnectionId: null,
  };
}

export function commitNextChapter(
  story: Story,
  plan: GenerationPlan,
  generated?: GeneratedChapter,
): Chapter {
  const result = generated ?? generateLocalChapter(story, plan);
  validateGeneratedChapter(story, result);
  const number = (story.chapters.at(-1)?.number ?? 0) + 1;
  const createdAt = new Date().toISOString();
  const chapterId = `chapter_${story.id}_${number}`;
  const revisionId = `rev_${story.id}_${number}_1`;
  const nextChapter: Chapter = {
    id: chapterId,
    number,
    title: result.title,
    currentRevisionId: revisionId,
    revisions: [
      {
        id: revisionId,
        parentRevisionId: null,
        title: result.title,
        paragraphs: result.paragraphs,
        reason: `AI 自主续章 · 候选 ${plan.selected.id}`,
        createdAt,
        modelName: result.model,
        promptVersion: "story-v8",
      },
    ],
    estimatedMinutes: Math.max(5, Math.round(result.paragraphs.join("").length / 160)),
  };
  story.chapters.push(nextChapter);
  story.events.push(eventFromChapter(story, number, revisionId, plan));
  story.canonVersion += 1;
  story.updatedAt = createdAt;
  story.latestExcerpt = result.paragraphs.at(-1) ?? "";
  story.readingProgress = { chapterId, scrollProgress: 0, updatedAt: createdAt };
  story.endingContract.lastEvaluatedAt = createdAt;
  story.conversation.push({
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: "system",
    type: "progress",
    content: `第 ${number} 章《${result.title}》已通过 ${plan.candidates.length} 个短候选的正史门禁，并提交为正史 v${story.canonVersion}。`,
    createdAt,
    observedCanonVersion: story.canonVersion,
  });
  return nextChapter;
}

export function toggleCharacterProtection(story: Story, characterId: string) {
  const character = story.characters.find((item) => item.id === characterId);
  if (!character) throw new Error("角色不存在。");
  character.protected = !character.protected;
  const existing = story.preferences.find((preference) => preference.id === `protect_${characterId}`);
  if (existing) {
    existing.active = character.protected;
  } else if (character.protected) {
    story.preferences.unshift({
      id: `protect_${characterId}`,
      label: `保护 ${character.name}`,
      description: "禁止死亡；仍允许受伤、失败、离开与关系破裂。",
      kind: "hard",
      confidence: 1,
      active: true,
    });
  }
  story.updatedAt = new Date().toISOString();
  return character;
}
