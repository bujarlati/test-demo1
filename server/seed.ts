import { createHash, randomBytes, scryptSync } from "node:crypto";
import type {
  AppStore,
  Chapter,
  ChapterRevision,
  CoverTheme,
  Story,
} from "../src/types";
import { captureCanonState } from "./canonState";
import { createReadingExperienceContract } from "./readingExperience";

const now = "2026-07-14T10:12:00+08:00";
const demoOwnerId = "user_demo";

function passwordRecord(password: string, identity: string) {
  // Seed-account salts only need to be unique, not secret. Deriving them avoids
  // random-number generation during hosted worker module initialization.
  const salt = createHash("sha256").update(`xumo-seed:${identity}:${password}`).digest("hex").slice(0, 32);
  return {
    passwordSalt: salt,
    passwordHash: scryptSync(password, salt, 64).toString("hex"),
  };
}

function storyMemory(title: string, genre: string, createdAt = now) {
  return {
    storyGene: {
      version: 1,
      protagonistPosition: `一位被卷入“${title}”核心异常的普通人`,
      visibleGoal: "查清眼前异常并保护仍可挽回的人",
      hiddenNeed: "学会为自己的选择承担代价，而不是只追求正确答案",
      conflictEngine: `${genre}谜团持续迫使主角在真相、关系与安全之间取舍`,
      recurringCost: "每次接近真相都会失去一部分原有身份或信任",
      endingShape: "主角主动选择一种有代价但不违背自我的结局",
      creativeAxes: ["错误证词", "关系代价", "空间误导", "旧物回声", "身份交换"],
      createdAt,
    },
    endingContract: {
      version: 1,
      targetEnding: "核心异常被解释，但解决方式要求主角主动支付贯穿全书的代价",
      characterArc: "从被动追查到主动定义何为值得保留的真相",
      prerequisites: ["至少一次因信任而失败", "核心异常留下三次可回溯前兆", "结局代价与开篇选择呼应"],
      status: "viable" as const,
      lastEvaluatedAt: createdAt,
    },
  };
}

function revision(
  id: string,
  title: string,
  paragraphs: string[],
  reason = "AI 自主续章",
): ChapterRevision {
  return {
    id,
    parentRevisionId: null,
    title,
    paragraphs,
    reason,
    createdAt: now,
    modelName: "platform-writer",
    promptVersion: "story-v7",
  };
}

function chapter(
  number: number,
  title: string,
  paragraphs: string[],
  estimatedMinutes = 8,
): Chapter {
  const currentRevision = revision(`rev_black_${number}_1`, title, paragraphs);
  return {
    id: `chapter_black_${number}`,
    number,
    title,
    currentRevisionId: currentRevision.id,
    revisions: [currentRevision],
    estimatedMinutes,
  };
}

function layeredSummaries(id: string, branchId: string, chapters: Chapter[], bookText: string) {
  const chapterSummaries = chapters.map((item) => ({
    id: `summary_${id}_chapter_${item.number}`,
    branchId,
    layer: "chapter" as const,
    text: `${item.title}：${item.revisions[0]?.paragraphs.at(-1) ?? ""}`.slice(0, 420),
    fromChapter: item.number,
    toChapter: item.number,
    sourceRevisionIds: [item.currentRevisionId],
    updatedAt: now,
  }));
  return [
    ...chapterSummaries,
    { id: `summary_${id}_scene_latest`, branchId, layer: "scene" as const, text: chapterSummaries.at(-1)?.text ?? bookText, fromChapter: chapters.at(-1)?.number ?? 1, toChapter: chapters.at(-1)?.number ?? 1, sourceRevisionIds: chapters.at(-1) ? [chapters.at(-1)!.currentRevisionId] : [], updatedAt: now },
    { id: `summary_${id}_arc`, branchId, layer: "arc" as const, text: chapterSummaries.slice(-5).map((item) => item.text).join(" ").slice(-900), fromChapter: Math.max(1, chapters.length - 4), toChapter: chapters.length, sourceRevisionIds: chapters.slice(-5).map((item) => item.currentRevisionId), updatedAt: now },
    { id: `summary_${id}_book`, branchId, layer: "book" as const, text: bookText, fromChapter: 1, toChapter: chapters.length, sourceRevisionIds: chapters.slice(-12).map((item) => item.currentRevisionId), updatedAt: now },
  ];
}

const blackTideTitles = [
  "沉入黎明之前",
  "无光海的钟声",
  "第七码头",
  "玻璃肺",
  "蓝鲸法庭",
  "陌生人的氧气",
  "旧城在下沉",
  "盐写的名字",
  "王室潜水员",
  "潮汐证词",
  "缓慢的代谢",
  "封锁线以内",
  "没有影子的鱼",
  "三分钟静默",
  "证据在呼吸",
  "禁区来信",
  "王冠与锈",
  "氧气尽头",
];

const blackTideSpecial: Record<number, string[]> = {
  1: [
    "海底城没有真正的黎明。清晨六点，穹顶只会把灯光调亮两度，提醒所有人黑暗仍在玻璃之外耐心等待。",
    "林夏在换气站的噪声里醒来，腕表上多了一条没有来源的讯息：别去第七码头。",
    "她删掉讯息，穿上执法局的深蓝外套。十分钟后，第七码头的警报响了。",
  ],
  11: [
    "白医生把针管对着灯，药液里漂着细小的银屑。林夏没有问那是什么，只看着自己的心率从一百二十降到四十。",
    "“你的代谢反应和档案不一致。”他说。",
    "林夏把袖口拉下来，盖住旧治疗留下的环形疤痕。“那就别把它写进档案。”",
  ],
  16: [
    "禁区的信封没有封口，里面只有一片干燥的海藻和六个字：你母亲没有离开。",
    "林夏把海藻贴在舷窗上。城外的黑潮正缓慢翻身，像一头从未睡着的兽。",
    "周砚站在她身后，没有问信里写了什么。他只是说，第七码头的潮门今晚会开。",
  ],
  17: [
    "王室的旧徽章在盐水里浮出锈红。林夏认得它——那是档案里早已被抹去的一支血脉。",
    "审判官把证据推到她面前：“签字，你仍然是执法官。不签，你就是共犯。”",
    "她拿起笔，却在最后一刻把纸翻了过来。背面是一张通往禁区的换气图。",
  ],
  18: [
    "毒素进入血液的第九秒，林夏听见城市的泵站同时停了一拍。她跪在潮门前，掌心压着那枚已经发热的旧徽章。",
    "周砚冲过封锁线时，监测器上的曲线已经归零。审判官俯身确认了她的瞳孔，又把白布盖过她的脸。",
    "潮门在他们身后打开。黑色海水涌入缓冲舱，带走了她最后一点体温，也带走了周砚原本准备说出口的话。",
    "那一夜，海底城所有钟表都慢了三分钟。周砚站在空荡的执法局里，把复仇对象的名字写在墙上。",
  ],
};

function earlyBlackTideParagraphs(number: number, title: string): string[] {
  return [
    `第${number}次潮汐警报越过穹顶时，林夏正在追查“${title}”留下的线索。城里的每一道门都比昨天更沉默。`,
    "她从旧档案与新证词之间找出一处细小矛盾：有人记得海水的颜色，却没人记得警报响起的时间。",
    "线索没有给她答案，只把她推向更深的一层城市。那里没有地图，只有仍在工作的呼吸管道。",
  ];
}

const blackTideChapters = blackTideTitles.map((title, index) => {
  const number = index + 1;
  return chapter(
    number,
    title,
    blackTideSpecial[number] ?? earlyBlackTideParagraphs(number, title),
    number === 18 ? 10 : 7,
  );
});

function compactStory(
  id: string,
  title: string,
  subtitle: string,
  genre: string,
  tone: string,
  coverTheme: CoverTheme,
  chapterTitles: string[],
  status: Story["status"],
  excerpt: string,
): Story {
  const chapters = chapterTitles.map((chapterTitle, index) => {
    const number = index + 1;
    const currentRevision = revision(
      `rev_${id}_${number}_1`,
      chapterTitle,
      [
        `${chapterTitle}发生在一个风向刚刚改变的清晨。主人公还不知道，这个细小变化会让所有熟悉的事情重新排列。`,
        "街道尽头传来一声短促的铃响。没有人回头，只有窗上的雾慢慢散开，露出昨天并不存在的一行字。",
        excerpt,
      ],
    );
    currentRevision.branchId = `branch_${id}_main`;
    return {
      id: `chapter_${id}_${number}`,
      number,
      title: chapterTitle,
      currentRevisionId: currentRevision.id,
      revisions: [currentRevision],
      estimatedMinutes: 6,
    };
  });

  return {
    id,
    ownerId: demoOwnerId,
    title,
    subtitle,
    genre,
    tone,
    length: "标准长篇 · 预计 200 章",
    targetChapterCount: 200,
    inspiration: "",
    coverTheme,
    status,
    activeBranchId: `branch_${id}_main`,
    branches: [{ id: `branch_${id}_main`, name: "主线", basedOnBranchId: null, baseCanonVersion: 1, headCanonVersion: chapterTitles.length, createdAt: now, status: "active", chapterRevisionIds: Object.fromEntries(chapters.map((item) => [item.id, item.currentRevisionId])), baseEventSequence: chapterTitles.length }],
    canonVersion: chapterTitles.length,
    summary: subtitle,
    latestExcerpt: excerpt,
    updatedAt: now,
    unreadCanonChanges: 0,
    readingProgress: {
      chapterId: chapters.at(-1)?.id ?? "",
      scrollProgress: status === "paused" ? 0.18 : 0.76,
      updatedAt: now,
      progressVersion: 1,
      activeBranchId: `branch_${id}_main`,
      canonVersion: chapterTitles.length,
    },
    readingExperience: createReadingExperienceContract({ tone, genre, createdAt: now }),
    ...storyMemory(title, genre),
    worldBible: {
      version: 1,
      organizations: ["故事中的本地秩序机构"],
      locations: ["故事当前场景"],
      abilityBoundaries: ["异常必须留下可追溯代价"],
      pointOfView: "近距离第三人称",
      styleParameters: [tone],
      sourceRevisionIds: chapters.slice(0, 1).map((item) => item.currentRevisionId),
    },
    summaries: layeredSummaries(id, `branch_${id}_main`, chapters, subtitle),
    events: chapters.map((item) => ({
      id: `event_${id}_${item.number}`,
      chapterNumber: item.number,
      revisionId: item.currentRevisionId,
      type: "discovery" as const,
      title: item.title,
      cause: item.number === 1 ? "主角遇见异常" : "尚未查明的异常痕迹仍在现场",
      outcome: "现场新增一条可继续追查的事实",
      participantIds: [],
      location: "故事当前场景",
      dependsOn: item.number === 1 ? [] : [`event_${id}_${item.number - 1}`],
      active: true,
      sequence: item.number,
      storyTime: `事件序列${item.number}·场景1`,
      branchId: `branch_${id}_main`,
    })),
    chapters,
    characters: [],
    items: [],
    rules: [],
    constraints: [],
    clues: [],
    preferences: [],
    conversation: [],
    conversationThreads: [{ id: `thread_${id}_main`, branchId: `branch_${id}_main`, summary: null, summaries: [], parentThreadId: null }],
    proposals: [],
    retcons: [],
    modelConnectionId: null,
  };
}

export function createSeedStore(): AppStore {
  const isProduction = process.env.NODE_ENV === "production";
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim() || (isProduction ? "" : "xumo2026");
  if (!adminPassword) {
    throw new Error("生产环境首次启动必须设置 BOOTSTRAP_ADMIN_PASSWORD，拒绝创建带公开默认密码的管理员。");
  }
  const readerPassword = process.env.BOOTSTRAP_READER_PASSWORD?.trim() || (isProduction ? randomBytes(24).toString("base64url") : "read2026");
  const blackTide: Story = {
    id: "story_black_tide",
    ownerId: demoOwnerId,
    title: "黑潮之下",
    subtitle: "海底城的第七码头",
    genre: "悬疑",
    tone: "冷冽 · 克制",
    length: "标准长篇 · 预计 200 章",
    targetChapterCount: 200,
    inspiration: "发生在海底城市，一封来自禁区的信改变了所有人的身份。",
    coverTheme: "tide",
    status: "active",
    activeBranchId: "branch_black_main",
    branches: [{ id: "branch_black_main", name: "主线", basedOnBranchId: null, baseCanonVersion: 1, headCanonVersion: 24, createdAt: now, status: "active", chapterRevisionIds: Object.fromEntries(blackTideChapters.map((item) => [item.id, item.currentRevisionId])), baseEventSequence: 17 }],
    canonVersion: 24,
    summary:
      "海底城执法官林夏追查一宗被王室删除的旧案，却发现自己的身世与城市赖以生存的潮门相连。",
    latestExcerpt:
      "潮门在他们身后打开。黑色海水涌入缓冲舱，带走了她最后一点体温。",
    updatedAt: "2026-07-14T09:42:00+08:00",
    unreadCanonChanges: 0,
    readingProgress: {
      chapterId: "chapter_black_18",
      scrollProgress: 0.42,
      updatedAt: "2026-07-14T09:42:00+08:00",
      progressVersion: 1,
      activeBranchId: "branch_black_main",
      canonVersion: 24,
    },
    readingExperience: createReadingExperienceContract({ tone: "冷冽 · 克制", genre: "悬疑", createdAt: now }),
    storyGene: {
      version: 3,
      protagonistPosition: "被王室抹去血统的海底城执法官",
      visibleGoal: "查明母亲失踪与旧城灾难的真相",
      hiddenNeed: "承认秩序并不天然等于正义，并选择愿意承担的身份",
      conflictEngine: "城市生存依赖潮门，揭露王室谎言可能让所有居民失去氧气",
      recurringCost: "每次取得证据，林夏都会失去一层合法身份与同盟信任",
      endingShape: "真相被公开，但林夏必须放弃回到旧秩序中的位置",
      creativeAxes: ["有限氧气", "证词偏差", "身份注销", "深海空间", "代谢时间差"],
      createdAt: now,
    },
    endingContract: {
      version: 2,
      targetEnding: "潮门真相公开，城市得到新的生存方案，林夏无法恢复原有身份",
      characterArc: "从秩序执行者转为愿意承担混乱后果的事实守护者",
      prerequisites: ["确认母亲去向", "解释慢三分钟的钟", "王室徽章承担潮门代价"],
      status: "viable",
      lastEvaluatedAt: now,
    },
    worldBible: {
      version: 3,
      organizations: ["海底城执法局", "王室审判庭"],
      locations: ["海底城", "第七码头潮门", "上层穹顶", "禁区"],
      abilityBoundaries: ["潮门开启必须由有效王室徽章承担能量代价", "不存在死者复生"],
      pointOfView: "近距离第三人称",
      styleParameters: ["冷冽", "克制", "不以旁白直接宣布善恶"],
      sourceRevisionIds: ["rev_black_5_1", "rev_black_14_1", "rev_black_18_1"],
    },
    summaries: layeredSummaries("story_black_tide", "branch_black_main", blackTideChapters, "林夏追查王室旧案，身份与潮门生存代价逐步绑定。"),
    events: blackTideChapters.map((item) => ({
      id: item.number === 18 ? "event_black_lin_death" : `event_black_${item.number}`,
      chapterNumber: item.number,
      revisionId: item.currentRevisionId,
      type: item.number === 18 ? "death" : item.number === 17 ? "relationship" : "discovery",
      title: item.number === 18 ? "林夏在潮门前死亡" : item.number === 17 ? "林夏与周砚在危机中仓促确认关系" : item.title,
      cause: item.number === 18 ? "毒素与潮门能量同时作用" : "旧案线索继续推进",
      outcome: item.number === 18 ? "林夏被确认死亡，周砚转向复仇" : item.number === 17 ? "两人在一次危机后直接确认亲密关系" : "获得新的可追溯事实",
      participantIds: item.number >= 17 ? ["char_lin_xia", "char_zhou_yan"] : ["char_lin_xia"],
      location: item.number === 18 ? "第七码头潮门" : "海底城",
      dependsOn: item.number === 1 ? [] : [item.number === 18 ? "event_black_17" : `event_black_${item.number - 1}`],
      active: true,
      sequence: item.number,
      storyTime: `事件序列${item.number}·场景1`,
      branchId: "branch_black_main",
    })),
    chapters: blackTideChapters,
    characters: [
      {
        id: "char_lin_xia",
        name: "林夏",
        role: "主角 · 前执法官",
        initials: "林",
        status: "确认死亡",
        lifecycle: "dead",
        location: "第七码头潮门",
        goal: "查明母亲失踪与王室旧案的关系",
        knowledge: ["潮门换气图", "王室旧徽章", "禁区入口"],
        knowledgeSources: [
          { fact: "潮门换气图", sourceChapter: 17, sourceRevisionId: "rev_black_17_1" },
          { fact: "王室旧徽章", sourceChapter: 17, sourceRevisionId: "rev_black_17_1" },
          { fact: "禁区入口", sourceChapter: 16, sourceRevisionId: "rev_black_16_1" },
        ],
        inventoryItemIds: ["item_royal_badge"],
        relationship: "与周砚互相信任，但仍隐瞒自己的治疗史",
        protected: false,
        accent: "jade",
      },
      {
        id: "char_zhou_yan",
        name: "周砚",
        role: "调查记者",
        initials: "周",
        status: "存活 · 被通缉",
        lifecycle: "alive",
        location: "旧执法局",
        goal: "公开王室对旧城灾难的掩盖",
        knowledge: ["林夏的王室血统", "潮门将在三日后失效"],
        knowledgeSources: [
          { fact: "林夏的王室血统", sourceChapter: 17, sourceRevisionId: "rev_black_17_1" },
          { fact: "潮门将在三日后失效", sourceChapter: 16, sourceRevisionId: "rev_black_16_1" },
        ],
        inventoryItemIds: [],
        relationship: "把林夏视为唯一仍可信任的人",
        protected: false,
        accent: "blue",
      },
      {
        id: "char_he_jing",
        name: "何静川",
        role: "王室审判官",
        initials: "何",
        status: "存活",
        lifecycle: "alive",
        location: "上层穹顶",
        goal: "维持城市秩序，阻止旧案公开",
        knowledge: ["旧城真实死亡人数", "林夏母亲的去向"],
        knowledgeSources: [
          { fact: "旧城真实死亡人数", sourceChapter: 5, sourceRevisionId: "rev_black_5_1" },
          { fact: "林夏母亲的去向", sourceChapter: 16, sourceRevisionId: "rev_black_16_1" },
        ],
        inventoryItemIds: [],
        relationship: "对林夏既警惕又抱有补偿心理",
        protected: false,
        accent: "rust",
      },
    ],
    items: [{
      id: "item_royal_badge",
      name: "王室旧徽章",
      status: "held",
      holderCharacterId: "char_lin_xia",
      location: "第七码头潮门",
      sourceChapter: 18,
      sourceRevisionId: "rev_black_18_1",
    }],
    rules: [
      {
        id: "rule_tide_gate",
        title: "潮门守恒",
        description: "潮门每次开启都必须由一枚有效王室徽章承担能量代价。",
        source: "第 5、14 章",
        hardness: "hard",
      },
      {
        id: "rule_no_resurrection",
        title: "不存在复活术",
        description: "本世界没有死者复生；生死误判必须有医学或视角依据。",
        source: "故事基因 v3",
        hardness: "hard",
      },
      {
        id: "rule_voice",
        title: "叙事温度",
        description: "近距离第三人称；克制，不用旁白直接宣布人物善恶。",
        source: "文风基线 v2",
        hardness: "soft",
      },
    ],
    constraints: [],
    clues: [
      {
        id: "clue_scar",
        title: "环形治疗疤痕",
        status: "planted",
        sourceChapter: 11,
        description: "林夏曾接受未记录在案的代谢治疗。",
        spoiler: false,
      },
      {
        id: "clue_three_minutes",
        title: "慢三分钟的钟",
        status: "strengthened",
        sourceChapter: 4,
        description: "全城钟表的误差与潮门能量波动同步。",
        spoiler: false,
      },
      {
        id: "clue_mother",
        title: "来自禁区的信",
        status: "planted",
        sourceChapter: 16,
        description: "有人声称林夏的母亲仍在禁区内。",
        spoiler: true,
      },
    ],
    preferences: [
      {
        id: "pref_pacing",
        label: "关系慢热",
        description: "重要关系至少经过共同选择与代价后再确认。",
        kind: "soft",
        confidence: 0.76,
        active: true,
      },
      {
        id: "pref_no_easy_redemption",
        label: "反派不轻易洗白",
        description: "理解动机不等于免除责任。",
        kind: "hard",
        confidence: 1,
        active: true,
      },
    ],
    conversation: [
      {
        id: "msg_restore_1",
        role: "system",
        type: "progress",
        content: "已恢复到第 18 章，上次正史版本为 v24。",
        createdAt: "2026-07-14T09:42:00+08:00",
        observedCanonVersion: 24,
        branchId: "branch_black_main",
        threadId: "thread_black_main",
      },
    ],
    conversationThreads: [{ id: "thread_black_main", branchId: "branch_black_main", summary: null, summaries: [], parentThreadId: null }],
    proposals: [],
    retcons: [],
    modelConnectionId: null,
  };

  const fogLetters = compactStory(
    "story_fog_letters",
    "雾港书简",
    "所有寄不出的信，都会在雾最浓时抵达",
    "奇幻",
    "温暖 · 轻盈",
    "fog",
    ["没有地址的信", "雨伞修理铺", "收信人已离开", "灯塔的回邮", "第十三枚邮戳", "雾散以前"],
    "active",
    "她把信塞进门缝，第二天却在自己的枕边看见了回信。",
  );

  const paperMoon = compactStory(
    "story_paper_moon",
    "纸月病房",
    "每位病人都梦见同一轮并不存在的月亮",
    "科幻",
    "静谧 · 诡谲",
    "moon",
    ["白色走廊", "共同梦境", "月光处方", "醒来的人"],
    "paused",
    "监护仪上没有异常，只有所有人的梦在同一秒翻了个身。",
  );

  // Demo snapshots deliberately stop before the only state-changing event so
  // delayed retcons can replay from a trustworthy boundary without old-branch residue.
  const blackCurrentState = captureCanonState(blackTide);
  const blackBaseState = structuredClone(blackCurrentState);
  const linBase = blackBaseState.characters.find((character) => character.id === "char_lin_xia");
  if (linBase) {
    linBase.status = "存活 · 中毒";
    linBase.lifecycle = "alive";
  }
  blackTide.branches[0].baseStateSnapshot = blackBaseState;
  blackTide.branches[0].stateSnapshot = blackCurrentState;
  const seededDeath = blackTide.events.find((event) => event.id === "event_black_lin_death");
  if (seededDeath) seededDeath.stateEffects = { characters: [{ characterId: "char_lin_xia", status: "确认死亡", lifecycle: "dead", location: "第七码头潮门" }] };
  for (const story of [fogLetters, paperMoon]) {
    const snapshot = captureCanonState(story);
    story.branches[0].baseStateSnapshot = structuredClone(snapshot);
    story.branches[0].stateSnapshot = snapshot;
  }

  return {
    users: [
      {
        id: demoOwnerId,
        email: "admin@xumo.local",
        name: "林默",
        initials: "默",
        role: "admin",
        activeStoryId: blackTide.id,
        defaultConnectionId: "conn_platform",
        publicPenName: null,
        ...passwordRecord(adminPassword, "admin@xumo.local"),
      },
      {
        id: "user_reader",
        email: "reader@xumo.local",
        name: "沈读",
        initials: "读",
        role: "reader",
        activeStoryId: null,
        defaultConnectionId: "conn_platform",
        publicPenName: null,
        ...passwordRecord(readerPassword, "reader@xumo.local"),
      },
    ],
    sessions: [],
    stories: [blackTide, fogLetters, paperMoon],
    connections: [
      {
        id: "conn_platform",
        name: "续墨托管模型",
        ownerScope: "platform",
        ownerId: null,
        protocol: "openai_compatible",
        baseUrl: "平台安全网关",
        maskedKey: "由平台托管",
        secretRef: "platform://managed/default",
        secretVersion: 0,
        status: "active",
        routes: {
          planner: "reasoning-small",
          writer: "novel-writer-v2",
          extractor: "json-fast",
          embedding: "embedding-large",
        },
        fallbackPolicy: "none",
        capabilities: {
          streaming: true,
          jsonSchema: true,
          embedding: true,
          promptCache: true,
          toolCalling: true,
          maxContextTokens: 128000,
          testedAt: "2026-07-14T08:00:00+08:00",
          latencyMs: 382,
        },
        updatedAt: "2026-07-14T08:00:00+08:00",
      },
    ],
      jobs: [
        {
          id: "job_2401",
          ownerId: demoOwnerId,
          storyId: blackTide.id,
          storyTitle: "黑潮之下",
        chapterNumber: 18,
        task: "chapter",
        model: "novel-writer-v2",
        connectionId: "conn_platform",
        promptVersion: "story-v7",
        status: "completed",
        tokens: 6840,
        usageEstimated: true,
        latencyMs: 18420,
        cost: 0.42,
        costEstimated: true,
        createdAt: "2026-07-14T09:36:00+08:00",
      },
        {
          id: "job_2398",
          ownerId: demoOwnerId,
          storyId: fogLetters.id,
          storyTitle: "雾港书简",
        chapterNumber: 6,
        task: "chapter",
        model: "novel-writer-v2",
        connectionId: "conn_platform",
        promptVersion: "story-v7",
        status: "completed",
        tokens: 5710,
        usageEstimated: true,
        latencyMs: 14980,
        cost: 0.35,
        costEstimated: true,
        createdAt: "2026-07-13T22:18:00+08:00",
      },
        {
          id: "job_2389",
          ownerId: demoOwnerId,
          storyId: paperMoon.id,
          storyTitle: "纸月病房",
        chapterNumber: 4,
        task: "extract",
        model: "json-fast",
        connectionId: "conn_platform",
        promptVersion: "extract-v3",
        status: "completed",
        tokens: 1280,
        usageEstimated: true,
        latencyMs: 2840,
        cost: 0.03,
        costEstimated: true,
        createdAt: "2026-07-13T17:05:00+08:00",
      },
    ],
      generationFailures: [],
      auditEvents: [],
      safetyDecisions: [],
      contentReports: [],
    idempotencyKeys: [],
    storyCreationRequests: [],
  };
}
