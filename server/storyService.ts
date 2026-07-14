import { randomUUID } from "node:crypto";
import type {
  AppStore,
  Chapter,
  ConversationMessage,
  CreateStoryInput,
  Story,
  StorySummary,
} from "../src/types";

export function currentRevision(chapter: Chapter) {
  return (
    chapter.revisions.find((revision) => revision.id === chapter.currentRevisionId) ??
    chapter.revisions.at(-1)
  );
}

function progressTarget(story: Story): number {
  const explicit = Number(story.length.match(/\d+/)?.[0]);
  if (explicit) return explicit;
  if (story.length.includes("短")) return 12;
  if (story.length.includes("长")) return 60;
  return 24;
}

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
    coverTheme: story.coverTheme,
    status: story.status,
    canonVersion: story.canonVersion,
    latestExcerpt: story.latestExcerpt,
    updatedAt: story.updatedAt,
    unreadCanonChanges: story.unreadCanonChanges,
    currentChapterNumber: activeChapter?.number ?? latest?.number ?? 1,
    currentChapterTitle: activeChapter?.title ?? latest?.title ?? "第一章",
    chapterCount: story.chapters.length,
    progress: Math.min(1, (latest?.number ?? 1) / progressTarget(story)),
  };
}

const storyTemplates: Record<
  string,
  { title: string; subtitle: string; coverTheme: Story["coverTheme"]; firstTitle: string; paragraphs: string[] }
> = {
  悬疑: {
    title: "潮汐背面",
    subtitle: "一座只在退潮时出现的车站",
    coverTheme: "tide",
    firstTitle: "无声车站",
    paragraphs: [
      "列车在凌晨四点十七分停下，车门外没有站台，只有被潮水浸得发亮的铁轨。",
      "程野是唯一醒着的乘客。他隔着玻璃看见一块站牌，上面写着自己的名字。",
      "广播没有催促下车，只平静地念出一则发生在十二年前、从未公开的失踪案。",
      "当车门自行打开时，海风带进一张湿透的车票。目的地一栏，印着他明天的日期。",
    ],
  },
  科幻: {
    title: "第七次日落",
    subtitle: "太阳每天都会落下，但只有她记得前六次",
    coverTheme: "moon",
    firstTitle: "重复的黄昏",
    paragraphs: [
      "第七次日落发生时，城市仍在庆祝第一次。",
      "许澄把前六天的日期刻在手腕内侧。每道细线都在午夜消失，只有疼痛会留下。",
      "天文台说恒星运行一切正常。她却在望远镜里看见太阳背后，藏着一颗正在模仿地球的黑色行星。",
      "她拨通无人接听的号码。电话那端传来自己的声音：这一次，不要叫醒他们。",
    ],
  },
  奇幻: {
    title: "灯塔之外",
    subtitle: "海图终点住着一位替人保管影子的守灯人",
    coverTheme: "fog",
    firstTitle: "借来的影子",
    paragraphs: [
      "小镇上的孩子出生时都没有影子。等到七岁，父母才会带他们去灯塔领取一枚。",
      "顾遥领到的那枚会在夜里独自走动，还总是停在北窗前。",
      "守灯人拒绝更换，只给她一张没有海岸线的地图：“它不是你的影子，但它在等你。”",
      "当晚，灯塔熄灭了三十年来的第一盏灯。海面上出现了一条通往天空的路。",
    ],
  },
  治愈: {
    title: "风从面包房来",
    subtitle: "每个清晨，旧街都会收到一种刚好需要的香气",
    coverTheme: "ember",
    firstTitle: "凌晨五点的面团",
    paragraphs: [
      "苏禾接手面包房的第一天，烤箱里躺着一只她没有做过的面包。",
      "它闻起来像雨后晒过的被单，也像母亲在很久以前哼过的歌。",
      "门外站着一位失眠的老人。他没有买面包，只在闻到香气后安静地哭了一会儿。",
      "第二天，烤箱又提前亮了。门把手上挂着一张字条：请替今天最需要的人烤。",
    ],
  },
};

export function createStory(input: CreateStoryInput): Story {
  const template = storyTemplates[input.genre] ?? storyTemplates.悬疑;
  const id = `story_${randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  const revisionId = `rev_${id}_1_1`;
  const chapterId = `chapter_${id}_1`;
  return {
    id,
    title: template.title,
    subtitle: input.inspiration?.trim() || template.subtitle,
    genre: input.genre,
    tone: input.tone || "由故事决定",
    length: input.length || "中篇 · 预计 24 章",
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
            reason: "故事初始化",
            createdAt,
            modelName: "platform-writer",
            promptVersion: "story-v7",
          },
        ],
        estimatedMinutes: 6,
      },
    ],
    characters: [
      {
        id: `char_${id}_lead`,
        name: input.genre === "科幻" ? "许澄" : input.genre === "治愈" ? "苏禾" : input.genre === "奇幻" ? "顾遥" : "程野",
        role: "主角",
        initials: input.genre === "科幻" ? "许" : input.genre === "治愈" ? "苏" : input.genre === "奇幻" ? "顾" : "程",
        status: "存活",
        location: "故事起点",
        goal: "理解眼前发生的异常，并决定是否继续追查",
        knowledge: ["第一章中亲眼看到的异常"],
        relationship: "尚未建立稳定同盟",
        protected: false,
        accent: "jade",
      },
    ],
    rules: [
      {
        id: `rule_${id}_1`,
        title: "世界规则待验证",
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
        content: "故事基因与第一章已生成。你只需要阅读，故事会自行继续。",
        createdAt,
        observedCanonVersion: 1,
      },
    ],
    retcons: [],
    modelConnectionId: null,
  };
}

export function buildChapterPrompt(story: Story): string {
  const latest = story.chapters.at(-1);
  const latestRevision = latest ? currentRevision(latest) : null;
  const hardRules = story.rules
    .filter((rule) => rule.hardness === "hard")
    .map((rule) => rule.description)
    .join("；");
  const preferences = story.preferences
    .filter((preference) => preference.active)
    .map((preference) => preference.description)
    .join("；");
  return [
    `故事：《${story.title}》，题材：${story.genre}，氛围：${story.tone}。`,
    `当前正史版本：v${story.canonVersion}。`,
    `上一章：第${latest?.number ?? 0}章《${latest?.title ?? "序章"}》。`,
    `最近正文：${latestRevision?.paragraphs.slice(-2).join("\n") ?? "无"}`,
    `硬规则：${hardRules || "无"}`,
    `读者偏好：${preferences || "无"}`,
    "请自主写出合理而有新意的下一章，不向读者追问情节方案。",
  ].join("\n");
}

function localChapter(story: Story): { title: string; paragraphs: string[]; model: string } {
  const latest = story.chapters.at(-1);
  const lead = story.characters[0]?.name ?? "她";
  const titles = ["回声之后", "被改写的潮线", "无人的证词", "门外之门", "第二种代价"];
  const number = (latest?.number ?? 0) + 1;
  const title = titles[(number - 1) % titles.length];
  return {
    title,
    model: "platform-writer",
    paragraphs: [
      `清晨到来得比预计更早。${lead}醒来时，窗外那条熟悉的街道像被谁向左移动了一格。`,
      "昨夜留下的线索仍在桌上，但它的边缘多出一道细小刻痕。那不是文字，更像某种只完成了一半的坐标。",
      `第${number}章没有给${lead}喘息的时间。门外传来三下敲击，间隔恰好对应前一章里被忽略的三个时刻。`,
      "来客没有解释自己是谁，只递来一件属于旧事件的物品。它证明此前的判断并非错误，却只看见了因果的一面。",
      `${lead}最终没有选择最安全的路。那条尚未验证的线索被保留下来，也因此失去了一个可以立即离开的机会。`,
      "在门关上的最后一刻，远处的警报重新响起。故事并没有重复过去；它正在要求所有人为新的选择付出代价。",
    ],
  };
}

export function commitNextChapter(
  story: Story,
  generated?: { title: string; paragraphs: string[]; model: string },
): Chapter {
  const result = generated ?? localChapter(story);
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
        reason: "AI 自主续章",
        createdAt,
        modelName: result.model,
        promptVersion: "story-v7",
      },
    ],
    estimatedMinutes: Math.max(5, Math.round(result.paragraphs.join("").length / 160)),
  };
  story.chapters.push(nextChapter);
  story.canonVersion += 1;
  story.updatedAt = createdAt;
  story.latestExcerpt = result.paragraphs.at(-1) ?? "";
  story.readingProgress = { chapterId, scrollProgress: 0, updatedAt: createdAt };
  story.conversation.push({
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: "system",
    type: "progress",
    content: `第 ${number} 章《${result.title}》已完成，并提交为正史 v${story.canonVersion}。`,
    createdAt,
    observedCanonVersion: story.canonVersion,
  });
  return nextChapter;
}

function addMessage(story: Story, message: ConversationMessage) {
  story.conversation.push(message);
  story.updatedAt = message.createdAt;
}

function applyDeathVeto(store: AppStore, story: Story, sourceText: string): ConversationMessage {
  const alreadyApplied = story.retcons.some(
    (retcon) => retcon.status === "committed" && retcon.sourceText === sourceText,
  );
  if (alreadyApplied) {
    return {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: "这次死亡已经被撤销，当前正史中林夏仍然存活。",
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  }

  const deathChapter = story.chapters.find((item) => item.number === 18);
  const setupChapter = story.chapters.find((item) => item.number === 11);
  if (!deathChapter || !setupChapter) {
    return {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: "system",
      type: "answer",
      content: "当前章节里没有唯一可确认的死亡事件。请点选相关段落，我会只确认一次目标。",
      createdAt: new Date().toISOString(),
      observedCanonVersion: story.canonVersion,
    };
  }

  const createdAt = new Date().toISOString();
  const canonBefore = story.canonVersion;
  const deathParent = currentRevision(deathChapter);
  const setupParent = currentRevision(setupChapter);
  const deathRevisionId = `rev_black_18_${deathChapter.revisions.length + 1}`;
  const setupRevisionId = `rev_black_11_${setupChapter.revisions.length + 1}`;

  deathChapter.revisions.push({
    id: deathRevisionId,
    parentRevisionId: deathParent?.id ?? null,
    title: "氧气尽头",
    paragraphs: [
      "毒素进入血液的第九秒，林夏听见城市的泵站同时停了一拍。她跪在潮门前，掌心压着那枚已经发热的旧徽章。",
      "周砚冲过封锁线时，监测器上的曲线已经归零。审判官俯身确认她的瞳孔，却在白布落下前发现她腕上的旧疤正缓慢发红。",
      "白医生留下的代谢改造没有解毒，只把死亡拖成一段极窄的缝隙。林夏在缝隙里醒来，也听见审判官宣布她已经死亡。",
      "她没有立刻睁眼。若要活着离开，执法官林夏必须从此消失。周砚把白布盖好，第一次在众目睽睽下配合了王室的谎言。",
      "潮门开启时，黑水带走了她的徽章与身份。她仍然活着，却失去了回到上层穹顶的名字。",
      "那一夜，海底城所有钟表都慢了三分钟。周砚擦掉墙上的复仇名单，换成一张通往禁区的路线图。",
    ],
    reason: "读者否决林夏死亡；以永久失去执法身份替代死亡代价",
    createdAt,
    modelName: "retcon-reasoner",
    promptVersion: "retcon-v4",
    changeSummary: "林夏存活，但被官方宣布死亡并永久失去执法身份。",
  });
  deathChapter.currentRevisionId = deathRevisionId;
  deathChapter.hasUnreadRevision = true;

  setupChapter.revisions.push({
    id: setupRevisionId,
    parentRevisionId: setupParent?.id ?? null,
    title: setupChapter.title,
    paragraphs: [
      "白医生把针管对着灯，药液里漂着细小的银屑。林夏没有问那是什么，只看着自己的心率从一百二十降到四十。",
      "“你的代谢反应和档案不一致。”他说，“旧治疗会让你在极端情况下进入近似死亡的低耗状态，但它救不了你第二次。”",
      "林夏把袖口拉下来，盖住那圈环形疤痕。“那就别把它写进档案。”",
    ],
    reason: "为第 18 章存活补入最小前置依据",
    createdAt,
    modelName: "retcon-reasoner",
    promptVersion: "retcon-v4",
    changeSummary: "明确旧治疗可能造成可被误判为死亡的低代谢状态。",
  });
  setupChapter.currentRevisionId = setupRevisionId;
  setupChapter.hasUnreadRevision = true;

  story.canonVersion += 1;
  story.unreadCanonChanges += 2;
  story.latestExcerpt = "她仍然活着，却失去了回到上层穹顶的名字。";
  const lead = story.characters.find((character) => character.id === "char_lin_xia");
  if (lead) {
    lead.status = "存活 · 身份已注销";
    lead.location = "第七码头下层医疗舱";
    lead.role = "主角 · 前执法官";
  }
  const clue = story.clues.find((item) => item.id === "clue_scar");
  if (clue) clue.status = "resolved";

  const retconId = `retcon_${randomUUID().slice(0, 8)}`;
  story.retcons.unshift({
    id: retconId,
    title: "撤销林夏在第 18 章的死亡",
    sourceText,
    summary: "林夏因旧治疗进入极低代谢状态而被误判死亡；她存活，但永久失去执法身份。",
    createdAt,
    canonVersionBefore: canonBefore,
    canonVersionAfter: story.canonVersion,
    changes: [
      {
        chapterNumber: 18,
        chapterTitle: deathChapter.title,
        kind: "required",
        summary: "重写中毒结局；林夏存活并失去执法身份。",
        revisionId: deathRevisionId,
      },
      {
        chapterNumber: 11,
        chapterTitle: setupChapter.title,
        kind: "supporting",
        summary: "补入低代谢治疗可能导致死亡误判的前置依据。",
        revisionId: setupRevisionId,
      },
      {
        chapterNumber: 19,
        chapterTitle: "后续大纲",
        kind: "outline",
        summary: "恢复林夏支线，并把周砚的复仇动机替换为护送她进入禁区。",
      },
    ],
    cost: "L2 · 2 个章节 Revision",
    status: "committed",
  });
  story.conversation.forEach((message) => {
    if (message.observedCanonVersion < story.canonVersion) message.oldCanon = true;
  });
  store.jobs.unshift({
    id: `job_${randomUUID().slice(0, 6)}`,
    storyTitle: story.title,
    chapterNumber: 18,
    task: "retcon",
    model: "retcon-reasoner",
    status: "completed",
    tokens: 3910,
    latencyMs: 12840,
    cost: 0.29,
    createdAt,
  });
  return {
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: "system",
    type: "retcon_result",
    content: "已撤销林夏在第 18 章的死亡，并完成必要的前文修订。",
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
        ? `按当前正史 v${story.canonVersion}，${lead.name}的核心目标是“${lead.goal}”。相关依据来自人物状态和最近章节；这条回答不会改变故事。`
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

export function rollbackRetcon(story: Story, retconId: string) {
  const retcon = story.retcons.find((item) => item.id === retconId);
  if (!retcon || retcon.status !== "committed") throw new Error("该修史事务不可回滚。");
  for (const change of retcon.changes) {
    if (!change.revisionId) continue;
    const chapter = story.chapters.find((item) => item.number === change.chapterNumber);
    const revision = chapter?.revisions.find((item) => item.id === change.revisionId);
    if (chapter && revision?.parentRevisionId) {
      chapter.currentRevisionId = revision.parentRevisionId;
      chapter.hasUnreadRevision = true;
    }
  }
  retcon.status = "rolled_back";
  story.canonVersion += 1;
  story.unreadCanonChanges += 2;
  const lead = story.characters.find((character) => character.id === "char_lin_xia");
  if (lead) {
    lead.status = "确认死亡";
    lead.location = "第七码头潮门";
  }
  const createdAt = new Date().toISOString();
  story.conversation.push({
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: "system",
    type: "progress",
    content: `已创建回滚记录并恢复旧正史；当前版本为 v${story.canonVersion}。修史历史未被删除。`,
    createdAt,
    observedCanonVersion: story.canonVersion,
  });
  story.updatedAt = createdAt;
  return retcon;
}
