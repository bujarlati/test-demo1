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
  classifyReadingExperienceDelivery,
  endingContractSatisfied,
  generateLocalChapter,
  type GeneratedChapter,
  type ExtractedChapterState,
  type GenerationPlan,
  validateGeneratedChapter,
} from "./narrativeEngine";
import { captureCanonState, deriveStateEffects } from "./canonState";
import { narrativeProfileForGenre, sceneKitForGenre } from "./genreProfiles";
import {
  createReadingExperienceContract,
  isSystemInvincibleExperience,
  parseReadingExperienceWords,
  updateReadingExperienceDeliveryLedger,
} from "./readingExperience";
import { assertStoryHardConstraints } from "./storyCore";

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
  const experienceWords = parseReadingExperienceWords(input.tone, input.genre);
  const isSystemInvincible = isSystemInvincibleExperience(experienceWords);
  const defaultParagraphs = [
    `${sceneKit.setting}。${lead}原本准备照常完成今天的安排，一个具体变化却打断了手上的动作，并与“${motif}”指向同一方向。它已经改变眼前的人或资源，迫使${lead}立刻作出第一次选择。`,
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
    `${lead}随后再次尝试${sceneKit.action}。结果没有解决总目标，却证明“${profile.creativeAxes[3]}”能够被观察、被影响，也会留下反作用。${lead}把这次结果连同失败部分一起保存，不允许一次胜利掩盖损失；这些后果会继续影响后来的人、资源和选择。`,
    `熟悉的空间重新安静下来，早晨那场变化却以另一种形式再次出现。几秒以后，新的安排、消息或规则把矛头清楚指向${lead}，也带来一项即将面对的考验。第一条可追溯的因果已经成立，${lead}收好记录，立即朝最需要处理的方向走去。`,
  ];
  const systemInvincibleParagraphs = [
    `外门演武场的测灵碑在${lead}掌下裂成两半时，执事手里的逐出名册刚写完最后一笔。满场哄笑戛然而止，石屑还悬在半空，一道只有${lead}能够看见的金色界面已经横在眼前——【诸天至强系统绑定完成。宿主遭遇不公裁定，满足首次激活条件。】`,
    `${lead}没有发愣。界面上只有三行信息：境界可无限提升，已掌握功法可瞬间圆满，击破强敌或旧秩序便能解锁新的世界权限。最下方的新人奖励正在闪烁：【万法归一体】【十万年修为】【一次规则豁免】。他在心中确认领取，沉睡的经脉随即被一股浩瀚力量彻底贯通。`,
    `没有疼痛，也没有故弄玄虚的倒计时。系统反馈清清楚楚：奖励已经到账，力量已经属于他，任何人都无法撤回。${lead}抬眼看向高台，方才宣布他“灵根尽毁、终身不得入内门”的执事还保持着冷笑，却没发现自己腰间的验灵玉正在疯狂震颤，表面一连炸开了七道裂纹。`,
    `“测灵碑年久失修，与他无关。”执事厉声盖过骚动，抬手便是一记镇脉掌。那是专门惩戒外门弟子的玄阶武技，掌风压得前排弟子连退数步。${lead}站在原地，只伸出一根手指。掌印撞上指尖的一刻，所有劲力像撞进无底深渊，连他的衣角都没能掀动。`,
    `${lead}屈指轻弹。执事身前的护体灵光层层崩碎，整个人横飞十余丈，撞断高台石栏才停下。没有缠斗，没有险胜，更没有谁及时赶来救场；从执事出手到落地，不过一次呼吸。演武场上数百人同时噤声，终于看清这不是侥幸，而是无法用境界差距衡量的绝对差距。`,
    `【击溃外门执事，首次碾压完成。奖励：宗门功法库最高权限；奖励：修为提升至本界极限；奖励：宿主可指定一门功法，令在场友方共同掌握。】系统提示接连亮起，每一项奖励都立刻生效。${lead}随手翻开执事掉落的青木诀，只看一眼，整部功法便从入门推演到了从未有人抵达的第九重。`,
    `高台后的三口古钟无人敲击，却同时长鸣。内门长老、峰主乃至闭关多年的太上长老纷纷睁眼，神识越过山门落在${lead}身上。有人惊疑，有人贪婪，也有人已经开始计算如何抹去刚才的裁定。力量差距带来的第一个结果不是新的苦战，而是整个宗门的立场被迫重新排列。`,
    `执事挣扎着抬头，第一句话仍是威胁：“你敢在宗门伤人，执法堂——”${lead}走到他面前，把逐出名册从其手中抽走。他没有解释力量从何而来，只指着名册上被强占名额的十二个名字：“把他们的灵石、功勋和入门资格全部还回去。现在。”`,
    `执事还想拖延，系统界面已经替${lead}标出名册背后的灵力暗记：谁改过记录，赃物藏在何处，哪位内门管事从中分利，一目了然。${lead}抬手一划，暗记化作金光投在半空，所有人的名字与数目清晰可见。系统没有替他决定该怎么做，却把足以改变局势的信息和力量完整交到了他手里。`,
    `人群里先响起一声压抑的抽气，随后是越来越多的质问。那些被夺走名额的弟子不再只敢低头，负责维持秩序的杂役也停下了驱赶动作。${lead}的胜利第一次越过个人恩怨：他只是公开一份记录，外门多年默认的分配方式便失去了遮掩。`,
    `执法堂主带着十六名弟子御剑而来，剑阵在半空合成一条百丈青蛟。堂主没有询问缘由，开口便要废去${lead}修为，以宗规封住所有人的嘴。系统显示出剑阵的一百三十七处破绽，但${lead}没有逐一破解；他向前踏出一步，单凭释放的气息便让青蛟寸寸瓦解，十六柄飞剑齐齐坠地。`,
    `堂主脸色惨白，直到此刻才明白人数、阵法和境界都无法填平差距。${lead}没有追着弱者炫耀，只隔空按下一掌。执法堂象征权威的黑铁牌楼轰然陷入地面，唯独站在牌楼下的弟子毫发无伤。这份精准比毁灭更令人恐惧：他不仅能横推眼前的一切，也能决定力量落在哪里。`,
    `【连续改变两项宗门规则，世界权限解锁百分之一。新功能开放：势力面板。】金色界面展开，宗门各峰的资源、敌意和求援状态化为清晰条目。${lead}看见外门药田被私吞，看见矿脉里还有三十七名弟子被困，也看见山门之外，一艘来自上宗的云舟正以问罪之名逼近。`,
    `他没有因为新的敌人出现就怀疑自己能否获胜。系统给出的力量没有上限，眼前世界也没有能让他退让的对手。真正需要选择的是先救谁、先改哪一条规则，以及每一次轻易获胜之后，要让留下的人生活在怎样的秩序里。`,
    `${lead}把共同掌握功法的奖励指定给名册上的十二人。金光落下，他们堵塞多年的经脉同时贯通，有人当场突破，有人捂着脸失声痛哭。系统再次确认状态永久生效，不会因为离开宗门或得罪长老而消失。围观者望向${lead}的目光由震惊变成了第一次真实的期待。`,
    `太上长老的虚影终于在云端显现，语气比执法堂主客气，却仍想用首席弟子之位换取沉默。${lead}抬起那份名册：“我可以做首席，但不是接过你们的位置。我今天留下，是要把被拿走的东西一件件还回去。谁阻拦，谁就先从自己的位置上下来。”`,
    `云层深处传来一声冷哼，护山大阵随之开启，九座山峰的灵力尽数压向演武场。${lead}抬手握住阵法落下的光柱，像折断一根枯枝般将它从中掰开。反噬没有落到弟子身上，而是沿阵纹倒卷回九峰，所有掌阵者面前的令牌同时熄灭。`,
    `系统给出新的结算：【正面击破宗门最高防御，奖励诸天通行印；当前世界已无可对宿主构成威胁的力量。】${lead}收起界面，越过跪倒的执事与沉默的长老，朝矿脉方向走去。十二名刚刚获得功法的弟子跟在身后，脚步从迟疑变得整齐。`,
    `山门外的上宗云舟恰在此时压过峰顶，传令者扬声要求交出“扰乱秩序的罪徒”。太上长老们脸色再变，过去足以让全宗低头的威压却没能让${lead}停步。他甚至没有回头，只向天空挥了一下手。庞大云舟便被无形力量定在原处，再也前进不了半寸。`,
    `${lead}的第一天不再围绕如何证明自己有资格留下。他已经拥有随时横推宗门、上宗乃至此界的力量，也有一个会持续反馈、持续奖励并记录世界变化的系统。接下来要发生的，是他带着这份绝对优势走过诸天，把每个挡路的旧秩序正面击碎。`,
  ];
  const paragraphs = [...(isSystemInvincible ? systemInvincibleParagraphs : defaultParagraphs)];
  if (!isSystemInvincible && paragraphs.join("").length < 2_400) {
    paragraphs.splice(-1, 0,
      `真正动身以前，${lead}又沿着${sceneKit.setting}走了一遍。先前被忽略的声音、位置与时间差此刻都有了意义：有人在回避视线，有人悄悄护住关键物件，也有人因为资源已经改变而不得不提前行动。${lead}没有把这些反应当成猜测，而是逐项记下能够再次验证的部分，并据此调整了下一步的顺序。`,
    );
  }
  const experienceGene = isSystemInvincible ? {
    protagonistPosition: "绑定诸天至强系统、从激活起便拥有压倒性力量的主角",
    visibleGoal: "横推阻挡自己的势力，并用每次胜利重塑诸天秩序",
    hiddenNeed: "决定如何使用无需担心失败的力量，让胜利真正改变他人的处境",
    conflictEngine: "系统持续展示、量化并扩大主角的绝对优势；冲突关注胜利如何改变资源、身份与世界秩序",
    recurringCost: "胜利不会削弱主角，却会扩大他的影响范围、保护目标与必须作出的治理选择",
    endingShape: "主角保持不败走到诸天之巅，并建立不再依赖强者恩赐的新秩序",
    creativeAxes: ["系统交互", "即时奖励", "碾压胜利", "众生反应", "秩序重塑"],
  } : null;
  return {
    title,
    lead,
    firstTitle,
    paragraphs,
    subtitle: inspiration,
    gene: {
      protagonistPosition: experienceGene?.protagonistPosition ?? `${profile.protagonistPosition}；故事起点由“${motif}”触发`,
      visibleGoal: experienceGene?.visibleGoal ?? profile.visibleGoal,
      hiddenNeed: experienceGene?.hiddenNeed ?? profile.hiddenNeed,
      conflictEngine: experienceGene?.conflictEngine ?? `${profile.conflictEngine}；所有推进保持“${tone}”的叙事温度`,
      recurringCost: experienceGene?.recurringCost ?? `${profile.recurringCost}；每次选择必须留下可追溯损失`,
      endingShape: experienceGene?.endingShape ?? profile.endingShape,
      creativeAxes: experienceGene?.creativeAxes ?? profile.creativeAxes,
    },
    ending: {
      targetEnding: `${experienceGene?.endingShape ?? profile.endingShape}；结局必须回应开篇意象“${motif}”`,
      characterArc: `从受困于既有处境，到真正理解“${experienceGene?.hiddenNeed ?? profile.hiddenNeed}”`,
      prerequisites: [
        `${experienceGene?.creativeAxes[0] ?? profile.creativeAxes[0]}至少完成一次可验证回收`,
        `${experienceGene?.creativeAxes[1] ?? profile.creativeAxes[1]}对人物关系造成不可逆影响`,
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
  const readingExperience = createReadingExperienceContract({
    tone: input.tone,
    genre: input.genre,
    createdAt,
  });
  const initialKnowledge = isSystemInvincibleExperience(readingExperience.sourceWords)
    ? [
        "系统确认既有修为、能力、奖励与世界权限全部持续生效",
        `${blueprint.lead}已经在第一场正面对抗中以一击取得压倒性胜利`,
      ]
    : ["亲眼看到的起始异常仍然影响眼前选择"];
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
    readingExperience,
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
        knowledge: initialKnowledge,
        knowledgeSources: initialKnowledge.map((fact) => ({ fact, sourceChapter: 1, sourceRevisionId: revisionId })),
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
    constraints: [],
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
  const initialExperienceDelivery = classifyReadingExperienceDelivery(
    readingExperience,
    blueprint.paragraphs.join("\n"),
    { protagonistNames: [blueprint.lead], chapterNumber: 1 },
  );
  story.readingExperienceDeliveryLedger = updateReadingExperienceDeliveryLedger(
    readingExperience,
    undefined,
    1,
    initialExperienceDelivery,
  );
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
  const experienceEvidence = extracted?.experienceEvidence ?? result.experienceEvidence;
  const experienceDelivery = extracted?.experienceDelivery ?? result.experienceDelivery ?? [];
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
        experienceEvidence: experienceEvidence?.map((evidence) => ({ ...evidence, signalIds: [...evidence.signalIds] })),
        experienceDelivery: experienceDelivery.length
          ? experienceDelivery.map((observation) => ({ ...observation }))
          : undefined,
      },
    ],
    estimatedMinutes: Math.max(5, Math.round(result.paragraphs.join("").length / 160)),
  };
  story.chapters.push(nextChapter);
  const activeBranchBeforeCommit = story.branches.find((item) => item.id === story.activeBranchId);
  story.readingExperienceDeliveryLedger = updateReadingExperienceDeliveryLedger(
    story.readingExperience,
    story.readingExperienceDeliveryLedger,
    number,
    experienceDelivery,
  );
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
  assertStoryHardConstraints(story);
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
