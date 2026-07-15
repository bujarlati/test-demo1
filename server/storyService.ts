import { createHash, randomUUID } from "node:crypto";
import type {
  CanonSummary,
  Chapter,
  CreateStoryInput,
  Story,
  StorySummary,
} from "../src/types";
import { getGenreOption, getStoryLengthOption } from "../src/storyConfig";
import {
  applyExtractedCharacterState,
  applyPlannedItemTransitions,
  assertStoryStateIntegrity,
  eventFromChapter,
  endingContractSatisfied,
  generateLocalChapter,
  type GeneratedChapter,
  type ExtractedChapterState,
  type GenerationPlan,
  validateGeneratedChapter,
} from "./narrativeEngine";
import { captureCanonState, deriveStateEffects } from "./canonState";
import { narrativeProfileForGenre, sceneKitForGenre } from "./genreProfiles";

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

export function finalizeStoryIfTargetReached(story: Story): boolean {
  if (story.chapters.length < Math.max(1, story.targetChapterCount)) return false;
  const chapter = story.chapters.at(-1);
  const revision = chapter?.revisions.find((item) => item.id === chapter.currentRevisionId);
  if (!revision || !endingContractSatisfied(story, revision.paragraphs.join("\n"), revision.endingResolution)) return false;
  if (story.status === "active" || story.status === "paused") {
    story.status = "completed";
    story.updatedAt = new Date().toISOString();
  }
  return true;
}

export function rebuildBranchSummaries(story: Story): void {
  const branch = story.branches.find((item) => item.id === story.activeBranchId);
  if (!branch) throw new Error("活动分支不存在，无法重建分层摘要。");
  const updatedAt = new Date().toISOString();
  const rows = story.chapters
    .map((chapter) => {
      const revisionId = branch.chapterRevisionIds[chapter.id] ?? chapter.currentRevisionId;
      const revision = chapter.revisions.find((item) => item.id === revisionId);
      return revision ? { chapter, revision } : null;
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((left, right) => left.chapter.number - right.chapter.number);
  const summaries: CanonSummary[] = [];
  for (const { chapter, revision } of rows) {
    const sceneText = `${revision.title}：${revision.paragraphs.at(-1) ?? revision.paragraphs[0] ?? ""}`.slice(0, 420);
    const chapterText = `${revision.title}：${revision.paragraphs[0] ?? ""} ${revision.paragraphs.at(-1) ?? ""}`.slice(0, 560);
    summaries.push(
      {
        id: `summary_${story.id}_${branch.id}_scene_${chapter.number}`,
        branchId: branch.id,
        layer: "scene",
        text: sceneText,
        fromChapter: chapter.number,
        toChapter: chapter.number,
        sourceRevisionIds: [revision.id],
        updatedAt,
      },
      {
        id: `summary_${story.id}_${branch.id}_chapter_${chapter.number}`,
        branchId: branch.id,
        layer: "chapter",
        text: chapterText,
        fromChapter: chapter.number,
        toChapter: chapter.number,
        sourceRevisionIds: [revision.id],
        updatedAt,
      },
    );
  }
  for (let index = 0; index < rows.length; index += 5) {
    const group = rows.slice(index, index + 5);
    if (!group.length) continue;
    summaries.push({
      id: `summary_${story.id}_${branch.id}_arc_${group[0].chapter.number}`,
      branchId: branch.id,
      layer: "arc",
      text: group.map(({ chapter, revision }) => `${chapter.number}.${revision.title}：${revision.paragraphs.at(-1) ?? ""}`).join(" ").slice(-1_000),
      fromChapter: group[0].chapter.number,
      toChapter: group.at(-1)!.chapter.number,
      sourceRevisionIds: group.map(({ revision }) => revision.id),
      updatedAt,
    });
  }
  if (rows.length) {
    summaries.push({
      id: `summary_${story.id}_${branch.id}_book`,
      branchId: branch.id,
      layer: "book",
      text: rows.map(({ chapter, revision }) => `${chapter.number}.${revision.title}：${revision.paragraphs.at(-1) ?? ""}`).join(" ").slice(-1_400),
      fromChapter: rows[0].chapter.number,
      toChapter: rows.at(-1)!.chapter.number,
      sourceRevisionIds: rows.slice(-12).map(({ revision }) => revision.id),
      updatedAt,
    });
  }
  story.summaries = [
    ...story.summaries.filter((summary) => summary.branchId !== branch.id),
    ...summaries,
  ];
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

function personalizedBlueprint(template: StoryTemplate, input: CreateStoryInput, id: string) {
  const profile = narrativeProfileForGenre(input.genre);
  const sceneKit = sceneKitForGenre(input.genre);
  const inspiration = input.inspiration?.trim() || template.subtitle;
  const tone = input.tone || "克制而有余韵";
  const seed = Number.parseInt(
    createHash("sha256").update(`${id}:${input.genre}:${tone}:${inspiration}`).digest("hex").slice(0, 8),
    16,
  );
  const openings = ["异象留下痕迹", "被提前写下的清晨", "来路不明的回信", "风向改变以前"];
  const titlePool = profile.titles;
  const namePool = profile.names;
  const title = titlePool[seed % titlePool.length];
  const lead = namePool[(seed >>> 3) % namePool.length];
  const firstTitle = openings[(seed >>> 6) % openings.length];
  const motif = inspiration.replace(/[。！？!?]/g, "").slice(0, 46);
  const paragraphs = [
    `${tone}的天光慢慢落下来，${sceneKit.setting}。${lead}原本准备照常完成今天的安排，却发现一个反常细节正与“${motif}”指向同一方向。它并不喧闹，只是让熟悉的节奏错开了半步，仿佛生活提前递来一项无法继续回避的选择。`,
    `${lead}并不是容易被一时情绪说服的人。作为${profile.protagonistPosition}，过去的经验早已教会自己先确认身体状态、周围环境和相关人物的反应，再判断眼前变化是否值得冒险。可这一次，自己的感受、既定安排与他人的说法只有两项能够同时成立，剩下那一项正在安静地改变今天的局面。`,
    `变化留下了可以触摸和复核的痕迹。${lead}没有急着给它命名，而是把发生前后的差异逐项记下，并用${sceneKit.action}的方式做了第一次验证。谨慎没有让事情变简单，它只是保证接下来失去某样东西时，至少还有一条清楚的路径，能够证明损失从何处开始。`,
    `第一位与此事有关的人坚称一切如常，转身时却准确说出了${lead}从未公开的细节。${lead}叫住对方，对方的神情先是茫然，继而像想起了某个不能提及的决定。那一瞬间的迟疑比完整解释更可靠，也把原本只属于个人的困惑推向了${sceneKit.pressure}。`,
    `追问没有得到答案，只换来一句含混的劝告：放下这件事，照既定安排继续走。对方离开后，一处被匆忙改动的细节恰好对应“${profile.creativeAxes[0]}”。${lead}把变化保存下来，第一次意识到，今天的转折不是偶然闯入生活，而是早已沿着某条看不见的路径寻找自己。`,
    `回到熟悉的地方后，${lead}把过往经历逐项核对。一次无人关注的失误、一个被匆忙撤回的决定，以及最近反复出现的相同模式，在此刻形成了清晰但危险的连线。若这条线成立，${profile.conflictEngine}，而原本以为牢固的秩序，其实一直有人在付出维持它的代价。`,
    `真正困难的是，继续向目标前进意味着主动走回那段最想避开的过去。${lead}曾经以为只要完成眼前的任务、守住有限的生活，就能与更大的冲突保持距离；然而“${motif}”已经把选择送到门前。退后当然安全，却会让另一个毫不知情的人替自己支付后果。`,
    `短暂的犹豫以后，${lead}给自己定下了第一个可验证的目标：${profile.visibleGoal}。目标被拆成三步，先确认变化从何处开始，再了解关键人物各自掌握什么，最后在既有规则反应以前完成一次无法被轻易否定的行动。每一步都不宏大，却比凭一腔冲动向前更接近真正的改变。`,
    `准备过程暴露出第一个阻碍。原本能够提供帮助的人突然改口，既定安排也在几分钟内被换成另一套版本，仿佛有人始终领先半步。${lead}没有争辩，只把前后差异逐项记下；越是急于掩饰的变化，越可能指向对方真正害怕失去的部分。`,
    `傍晚前，事情把${lead}带到压力最集中的场域。${sceneKit.setting}，而“${profile.creativeAxes[1]}”正在这里变成具体阻力。周围每个人都按自己的立场行动，没有谁愿意先承认局面已经改变；越是平静的表面，越能看出即将到来的碰撞。`,
    `能决定关键资源的人在那里等着，只提出一个看似公平的交换：停止追问，接受已经安排好的位置，今天的生活便可以恢复原样。${lead}听完条件，反而确认对方无法直接完成目的，否则便不必谈判。双方没有揭开底牌，沉默却让力量边界第一次显形。`,
    `${lead}故意提出一个只有真正参与者才会理解的问题。对方避开核心，却说出了尚未公开的细节，这个失误足以证明此前的判断。趁注意力被问题牵走，${lead}保留真实意图，只展示一套风险更低的表面方案。计划并不完美，但它争取到继续行动所需的第一段时间。`,
    `交换完成的瞬间，代价也随之落下。${profile.recurringCost}。变化并不轰烈，甚至没有人立刻察觉，只有${lead}知道某个原本自然存在的细节已经从生活里松动。想把它重新抓紧已经来不及；规则以最安静的方式证明，往后每一次推进都必须留下真实损失。`,
    `回程途中，那位先前改口的人再次出现，悄悄递来一段没有署名的消息。上面没有解释，只有三个可以立即核实的细节和一句“别相信第一次结果”。这份迟来的帮助并未消除怀疑，却说明对方也受制于某种压力。两个人尚未成为同盟，但至少在同一个困局里各自撬开了一条缝。`,
    `三个细节中的第一处与早晨留下的痕迹完全吻合，第二处却指向${lead}自己的过往，第三处只留下“${profile.creativeAxes[2]}”几个字。${lead}终于看见事件更深的一层：眼前的冲突不是为了争夺一次结果，而是为了阻止某个本应被规则淘汰的人继续拥有选择。这个人很可能正是自己。`,
    `恐惧没有消失，只是被更具体的问题压到一旁。${lead}想起自己真正缺少的并非更多勇气，而是${profile.hiddenNeed}。如果仍按过去的方式独自承担，所有关系最终都会变成阻碍合作的盲点。于是，${lead}第一次把完整计划和真实状态交给可信的人，并明确约定：一旦局面变化，不要等待允许，立刻按共同确认的边界行动。`,
    `夜色完全落下时，早晨留下的标记被人改动了，旁边却多出一道更清楚的新痕。对方来过，也知道${lead}没有接受交换。${sceneKit.consequence}已经开始显现，这不是单纯的威胁，而是一份倒计时。${lead}收好全部记录，明白下一次行动必须赶在局面彻底锁死以前。`,
    `回到仍愿意等待自己的人身边，${lead}第一次完整说出今天发生了什么。${sceneKit.relationship}没有因为坦白立刻变得牢固，反而暴露出新的分歧；但每个人终于能在同一组事实上作出选择。这样的共同承担，比毫无裂缝的表面一致更可靠，也让下一步不再只属于一个人。`,
    `${lead}随后再次尝试${sceneKit.action}。结果没有解决总目标，却证明“${profile.creativeAxes[3]}”能够被观察、被影响，也会留下反作用。${lead}把这次结果连同失败部分一起保存，不允许胜利的叙述删掉损失；一部长篇真正需要的，正是这些会在后来继续生长的后果。`,
    `熟悉的空间重新安静下来，早晨那场变化却以另一种形式再次出现。几秒以后，新的安排、消息或规则把矛头清楚指向${lead}，也带来一项尚未到来的考验。第一条可追溯的因果已经成立，真正的故事在这一刻开始向更远处生长。`,
  ];
  return {
    title,
    lead,
    firstTitle,
    paragraphs,
    subtitle: inspiration,
    gene: {
      protagonistPosition: `${profile.protagonistPosition}；故事起点由“${motif}”触发`,
      visibleGoal: profile.visibleGoal,
      hiddenNeed: profile.hiddenNeed,
      conflictEngine: `${profile.conflictEngine}；所有推进保持“${tone}”的叙事温度`,
      recurringCost: `${profile.recurringCost}；每次选择必须留下可追溯损失`,
      endingShape: profile.endingShape,
      creativeAxes: profile.creativeAxes,
    },
    ending: {
      targetEnding: `${profile.endingShape}；结局必须回应开篇意象“${motif}”`,
      characterArc: `从受困于既有处境，到真正理解“${profile.hiddenNeed}”`,
      prerequisites: [
        `${profile.creativeAxes[0]}至少完成一次可验证回收`,
        `${profile.creativeAxes[1]}对人物关系造成不可逆影响`,
        `开篇灵感“${motif}”在结局前获得因果解释`,
      ],
    },
  };
}

export function createStory(input: CreateStoryInput, ownerId: string): Story {
  const genreOption = getGenreOption(input.genre);
  const template = storyTemplates[genreOption.templateKey];
  const id = `story_${randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  const revisionId = `rev_${id}_1_1`;
  const chapterId = `chapter_${id}_1`;
  const characterId = `char_${id}_lead`;
  const branchId = `branch_${id}_main`;
  const threadId = `thread_${id}_main`;
  const lengthPlan = getStoryLengthOption(input.lengthPlan);
  const length = lengthPlan.label;
  const blueprint = personalizedBlueprint(template, input, id);
  const story: Story = {
    id,
    ownerId,
    title: blueprint.title,
    subtitle: blueprint.subtitle,
    genre: input.genre,
    tone: input.tone || "由故事决定",
    length,
    targetChapterCount: lengthPlan.chapterCount,
    inspiration: input.inspiration?.trim() || "",
    coverTheme: genreOption.coverTheme,
    status: "active",
    activeBranchId: branchId,
    branches: [{
      id: branchId,
      name: "主线",
      basedOnBranchId: null,
      baseCanonVersion: 1,
      headCanonVersion: 1,
      createdAt,
      status: "active",
      chapterRevisionIds: { [chapterId]: revisionId },
      baseEventSequence: 1,
    }],
    canonVersion: 1,
    summary: `${blueprint.subtitle}。${blueprint.gene.conflictEngine}`,
    latestExcerpt: blueprint.paragraphs.at(-1) ?? "故事已经开始。",
    updatedAt: createdAt,
    unreadCanonChanges: 0,
    readingProgress: { chapterId, scrollProgress: 0, updatedAt: createdAt, progressVersion: 1, activeBranchId: branchId, canonVersion: 1 },
    storyGene: { ...blueprint.gene, version: 1, createdAt },
    endingContract: {
      ...blueprint.ending,
      version: 1,
      status: "viable",
      lastEvaluatedAt: createdAt,
    },
    worldBible: {
      version: 1,
      organizations: ["开篇出现的本地秩序机构"],
      locations: ["故事起点"],
      abilityBoundaries: ["异常必须留下可追溯因果，不能无代价改写既有事实"],
      pointOfView: "近距离第三人称",
      styleParameters: [blueprint.gene.conflictEngine, input.tone || "克制而有余韵"],
      sourceRevisionIds: [revisionId],
    },
    summaries: (["scene", "chapter", "arc", "book"] as const).map((layer) => ({
      id: `summary_${id}_${layer}_1`,
      branchId,
      layer,
      text: `${blueprint.firstTitle}：${blueprint.paragraphs[0]} ${blueprint.paragraphs.at(-1) ?? ""}`.slice(0, 420),
      fromChapter: 1,
      toChapter: 1,
      sourceRevisionIds: [revisionId],
      updatedAt: createdAt,
    })),
    events: [
      {
        id: `event_${id}_1`,
        chapterNumber: 1,
        revisionId,
        type: "discovery",
        title: blueprint.firstTitle,
        cause: "主角第一次遇见故事核心异常",
        outcome: blueprint.paragraphs.at(-1) ?? "异常被确认存在",
        participantIds: [characterId],
        location: "故事起点",
        dependsOn: [],
        active: true,
        sequence: 1,
        storyTime: "第1章·场景1",
        branchId,
      },
    ],
    chapters: [
      {
        id: chapterId,
        number: 1,
        title: blueprint.firstTitle,
        currentRevisionId: revisionId,
        revisions: [
          {
            id: revisionId,
            parentRevisionId: null,
            title: blueprint.firstTitle,
            paragraphs: blueprint.paragraphs,
            reason: "故事基因、结局契约与第一章初始化",
            createdAt,
            modelName: "platform-writer",
            promptVersion: "story-v8",
            branchId,
          },
        ],
        estimatedMinutes: Math.max(10, Math.round(blueprint.paragraphs.join("").length / 260)),
      },
    ],
    characters: [
      {
        id: characterId,
        name: blueprint.lead,
        role: "主角",
        initials: blueprint.lead.slice(0, 1),
        status: "存活",
        lifecycle: "alive",
        location: "故事起点",
        goal: blueprint.gene.visibleGoal,
        knowledge: ["第一章中亲眼看到的异常"],
        knowledgeSources: [{ fact: "第一章中亲眼看到的异常", sourceChapter: 1, sourceRevisionId: revisionId }],
        inventoryItemIds: [],
        relationship: "尚未建立稳定同盟",
        protected: false,
        accent: "jade",
      },
    ],
    items: [{
      id: `item_${id}_anomaly`,
      name: "第一章的异常物",
      status: "available",
      location: "故事起点",
      sourceChapter: 1,
      sourceRevisionId: revisionId,
    }],
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
        branchId,
        threadId,
      },
    ],
    conversationThreads: [{ id: threadId, branchId, summary: null, summaries: [], parentThreadId: null }],
    proposals: [],
    retcons: [],
    modelConnectionId: null,
  };
  const initialState = captureCanonState(story);
  story.branches[0].baseStateSnapshot = structuredClone(initialState);
  story.branches[0].stateSnapshot = initialState;
  return story;
}

export function commitNextChapter(
  story: Story,
  plan: GenerationPlan,
  generated?: GeneratedChapter,
  extracted?: ExtractedChapterState,
): Chapter {
  const result = generated ?? generateLocalChapter(story, plan);
  validateGeneratedChapter(story, result, plan, extracted);
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
        branchId: story.activeBranchId,
        endingResolution: result.endingResolution ?? extracted?.endingResolution,
      },
    ],
    estimatedMinutes: Math.max(5, Math.round(result.paragraphs.join("").length / 160)),
  };
  story.chapters.push(nextChapter);
  const activeBranchBeforeCommit = story.branches.find((item) => item.id === story.activeBranchId);
  if (activeBranchBeforeCommit) activeBranchBeforeCommit.chapterRevisionIds[chapterId] = revisionId;
  const stateBefore = captureCanonState(story);
  const event = eventFromChapter(story, number, revisionId, plan, extracted?.events[0], result);
  story.events.push(event);
  applyPlannedItemTransitions(story, plan, result, { chapterNumber: number, revisionId });
  applyExtractedCharacterState(story, extracted, result, { chapterNumber: number, revisionId });
  event.stateEffects = deriveStateEffects(stateBefore, captureCanonState(story));
  story.canonVersion += 1;
  const branch = story.branches.find((item) => item.id === story.activeBranchId);
  if (branch) branch.headCanonVersion = story.canonVersion;
  story.updatedAt = createdAt;
  story.latestExcerpt = result.paragraphs.at(-1) ?? "";
  story.readingProgress = {
    chapterId,
    scrollProgress: 0,
    updatedAt: createdAt,
    progressVersion: story.readingProgress.progressVersion + 1,
    activeBranchId: story.activeBranchId,
    canonVersion: story.canonVersion,
  };
  story.endingContract.lastEvaluatedAt = createdAt;
  rebuildBranchSummaries(story);
  let thread = story.conversationThreads.find((item) => item.branchId === story.activeBranchId);
  if (!thread) {
    thread = { id: `thread_${randomUUID().slice(0, 8)}`, branchId: story.activeBranchId, summary: null, summaries: [], parentThreadId: null };
    story.conversationThreads.push(thread);
  }
  story.conversation.push({
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: "system",
    type: "progress",
    content: `第 ${number} 章《${result.title}》已通过 ${plan.candidates.length} 个短候选的正史门禁，并提交为正史 v${story.canonVersion}。`,
    createdAt,
    observedCanonVersion: story.canonVersion,
    branchId: story.activeBranchId,
    threadId: thread.id,
  });
  assertStoryStateIntegrity(story);
  const committedBranch = story.branches.find((item) => item.id === story.activeBranchId);
  if (committedBranch) {
    committedBranch.stateSnapshot = captureCanonState(story);
    committedBranch.baseStateSnapshot ??= structuredClone(committedBranch.stateSnapshot);
  }
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
