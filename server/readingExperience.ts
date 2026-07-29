import type {
  ReadingExperienceAxisDeliveryPolicy,
  ReadingExperienceDeliveryLedgerEntry,
  ReadingExperienceDeliveryObservation,
  ReadingExperienceAxisContract,
  ReadingExperienceAxisId,
  ReadingExperienceContract,
  ReadingExperienceSignalKind,
} from "../src/types";
import { IMMERSIVE_NARRATION_PROMPT } from "./narrationPolicy";

interface AxisDefinition {
  interpretation: string;
  kind: ReadingExperienceSignalKind;
  signals: [string, string, ...string[]];
  promise: string;
  forbidden: string[];
  delivery?: Omit<ReadingExperienceAxisDeliveryPolicy, "axisId">;
}

function definition(
  interpretation: string,
  kind: ReadingExperienceSignalKind,
  signals: [string, string, ...string[]],
  promise: string,
  forbidden: string[] = [],
  delivery?: Omit<ReadingExperienceAxisDeliveryPolicy, "axisId">,
): AxisDefinition {
  return { interpretation, kind, signals, promise, forbidden, delivery };
}

const curatedDefinitions: Record<string, AxisDefinition> = {
  系统: definition(
    "主角拥有真实、持续且可操作的系统机制，系统反馈必须改变行动与资源状态",
    "mechanic",
    [
      "正文展示一次完整的触发条件 → 系统反馈 → 奖励或状态变化",
      "主角主动利用面板、任务、能力、奖励或权限信息作出行动",
      "系统状态、奖励或权限跨章节持续存在并产生剧情效果",
    ],
    "第一章前 15% 内出现真实系统交互，此后每章至少有一次系统交互或既有系统能力的有效结果",
    ["把系统写成比喻或旁白形容", "默认故障、拒绝结算、奖励撤回或长期权限不足", "把系统藏到数章后才揭晓"],
  ),
  无敌: definition(
    "主角在关键正面对抗的最终结果中保持不败，过程可以势均力敌，主旋律来自压倒性胜利如何改变世界",
    "conflict_outcome",
    [
      "第一场有意义的对抗由主角压倒性获胜",
      "对手、旁观者或既有秩序对力量差距作出实际反应",
      "胜利带来资源、身份、声望或局势的清晰变化",
    ],
    "主角不能形成已经落地的最终失败；压倒性胜利作为跨章主旋律持续回归",
    ["靠临时救援保住主角", "以封印或失忆收回能力"],
    { mode: "soft_window", targetWindowChapters: 3, targetMaxOpenConflictChapters: 1 },
  ),
  冷冽: definition("叙述判断清晰利落，环境与关系保持锋利距离", "voice", ["句式克制而有明确动作结果", "人物关系通过边界、拒绝或代价体现距离"], "每章至少有一次冷静果断的决定"),
  克制: definition("情绪通过动作、停顿和选择显露，不由旁白替人物宣布", "voice", ["关键情绪落在可观察动作上", "高潮避免连续口号和解释性煽情"], "情绪强烈时仍保持人物行为可信"),
  温暖: definition("人物在具体困境中给予可感知的照料、理解或陪伴", "relationship", ["至少一个具体照料行动改变人物状态", "善意需要回应人物真实需求而非空泛安慰"], "温暖必须由关系行动兑现"),
  轻盈: definition("推进明快，压力不长期滞留，场景保有呼吸和灵动反差", "pacing", ["冲突后快速产生新动作或小回报", "对话和场景转换保持轻快节奏"], "避免连续多段沉重复盘"),
  诡谲: definition("熟悉事物呈现可追溯但反常的规则，让读者持续修正判断", "mechanic", ["反常现象具有具体感官细节", "新发现改变对既有事实的理解"], "每章至少推进一个可验证的反常规则"),
  梦境: definition("现实与梦境边界产生有意义的感官和因果错位", "mechanic", ["梦境细节影响醒后的现实行动", "边界错位遵循可追踪规则"], "梦境不得抹除已经发生的因果"),
  明快: definition("目标清楚、动作迅速、结果及时反馈", "pacing", ["场景很快进入具体目标", "行动在本章内得到明确反馈"], "避免长时间调查、犹豫和背景说明"),
  冒险: definition("人物主动进入未知环境并以选择探索新规则", "protagonist_action", ["主角主动踏入新场域或接触新规则", "探索带来能力、关系或世界认知变化"], "每章都要有推进未知边界的行动"),
  热血: definition("人物为明确目标主动迎战，以行动和共同信念推高情绪", "protagonist_action", ["主角在压力下主动迎上冲突", "行动激起同伴或群体的可见响应"], "高潮必须有行动兑现，不能只靠口号"),
  激昂: definition("节奏持续上扬，关键动作与结果形成强烈情绪释放", "pacing", ["冲突节拍逐级加速", "高潮结果带来明确而强烈的现场反应"], "每章提供一次可感知的情绪峰值"),
  沉郁: definition("人物长期承受的矛盾在环境、关系和选择中积压", "voice", ["压力通过具体生活后果持续存在", "人物选择保留无法轻易化解的余味"], "沉重必须来自因果而非形容词堆积"),
  厚重: definition("个人选择与历史、群体或长期后果彼此勾连", "world_reaction", ["行动影响超过眼前胜负", "过去的选择持续改变资源、制度或关系"], "每个阶段都要留下可延续的世界变化"),
  浪漫: definition("吸引与亲密通过专属关注、共同选择和关系风险推进", "relationship", ["人物注意到只属于对方的具体细节", "双方作出改变关系位置的选择"], "关系必须双向推进，不能只靠外貌描写"),
  细腻: definition("细微感官、动作和未说出口的反应承载人物变化", "voice", ["场景使用具体而不重复的感官细节", "微小动作改变对话或关系含义"], "避免用抽象心理总结替代现场"),
  轻松: definition("压力可控，人物有余裕以机智、反差或日常回应困境", "pacing", ["冲突中出现自然的反差或松弛瞬间", "问题得到及时的小回报而非持续受挫"], "不能靠贬低角色智力制造轻松"),
  幽默: definition("笑点来自人物性格、信息差或行动后果，而非生硬段子", "voice", ["人物反应形成符合性格的反差", "笑点同时推动关系或事件"], "避免网络梗堆砌和旁白解释笑点"),
  紧张: definition("明确的时间、资源或行动窗口不断收窄", "pacing", ["风险具有具体倒计时或触发条件", "人物必须在不完整信息下作出行动"], "压力必须改变选择，不能只靠反复警告"),
  压迫: definition("权力、环境或规则持续限制人物可用选择", "world_reaction", ["限制通过具体资源、空间或制度落地", "反抗会引发可见的秩序回应"], "不能只用阴暗景物宣称压迫"),
  苍凉: definition("失去与时代变迁留在空缺、旧物和无法复原的关系中", "voice", ["场景呈现具体且不可逆的缺席", "人物承认无法挽回之物并继续行动"], "避免泛化悲叹"),
  史诗: definition("个人行动推动大尺度世界、群体和时代变化", "world_reaction", ["行动牵动多个群体或地域", "胜负改变长期秩序而非单次结果"], "宏大必须由具体人物行动支撑"),
  治愈: definition("创伤或困境通过安全、理解和可持续的小改变得到承接", "relationship", ["人物需求被准确看见并获得具体回应", "恢复通过可持续行动而非一句顿悟发生"], "不能用原谅强迫受伤者立即释怀"),
  日常: definition("衣食住行与重复习惯成为关系和变化的主要载体", "relationship", ["场景包含有功能的生活细节", "日常动作显露人物关系变化"], "日常不等于无事件或流水账"),
  黑暗: definition("人物面对真实恶意、失序或道德困境，后果不可被轻易美化", "world_reaction", ["威胁造成具体且持续的后果", "人物选择暴露制度或人性的阴影"], "避免仅靠光线和颜色营造黑暗"),
  残酷: definition("规则和冲突让错误选择付出明确、不可撤销的代价", "conflict_outcome", ["代价落到具体身体、资源或关系", "胜利不能自动抹去损失"], "残酷不得等同无意义虐待"),
  诗意: definition("意象与人物处境和行动形成内在对应", "voice", ["核心意象随人物选择改变含义", "语言具节奏但仍保持事件清晰"], "禁止用感觉词直接修饰天光、晨雾或暮色"),
  空灵: definition("场景留白、感官距离与超现实细节共同制造轻微失重感", "voice", ["留白建立在清楚场景之上", "超现实细节与人物感受或规则相连"], "不能牺牲因果清晰度换取空泛意境"),
  理性: definition("人物依据证据、目标和边界作出可解释的判断", "protagonist_action", ["行动前明确区分事实与推测", "新证据会真正修正方案"], "理性不能写成机械复盘或研究报告"),
  冷静: definition("高压下仍能抓住关键变量并立即行动", "protagonist_action", ["危险中出现精准判断", "判断直接转化为有效动作"], "避免反复逐项记录拖慢情节"),
  爽快: definition("冲突建立和解决都直接有力，回报及时且清晰", "conflict_outcome", ["挑衅或阻碍在本章内获得明确回应", "胜利带来立刻可见的收益或地位变化"], "禁止拖延核心回报或用误会续命"),
  逆袭: definition("受压位置通过能力、策略和结果发生可见翻转", "conflict_outcome", ["主角打破此前限制自己的具体规则", "轻视者或旧秩序必须对翻转作出反应"], "逆袭不能只由旁白宣布"),
  疯狂: definition("人物以极端但内在一致的选择突破常规边界", "protagonist_action", ["行动超出常规预期但符合人物欲望", "极端选择引发连锁世界反应"], "不能用随机行为冒充疯狂"),
  荒诞: definition("规则、身份或因果发生逻辑自洽的错位并揭示现实矛盾", "world_reaction", ["荒谬规则被人物认真执行并产生后果", "反差暴露更深层秩序问题"], "不能用无因果拼贴冒充荒诞"),
};

function normalizeWord(value: string): string {
  return Array.from(value.trim()).slice(0, 12).join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function usesExperienceWordAsLiteralLabel(text: string, word: string): boolean {
  const escapedWord = escapeRegExp(word.trim());
  if (!escapedWord) return false;
  const deliveryVerb = "(?:写(?:着|有|下|出)?|印(?:着|有|上|出)?|刻(?:着|有|下|出)?|贴(?:着|有|上|出)?|挂(?:着|有|上|出)?|标(?:着|有|注|示|记)?|显示|展示|念出|读出|播报|喊出|题为|命名为|提到)";
  const visibleContainer = "(?:屏幕|面板|门牌|杯子|物品|纸张|纸上|墙面|墙上|横幅|字幕|标题|标签|扩音器|广播)";
  const literalNoun = "(?:二字|两字|两个字|这个词|一词|几个字|字样|标签|标记|文字)";
  const labelBoundary = "(?=$|[\\s，,。！？；;、：:）)】》]|(?:后|之后|以前|当时|随即|然后|便|就|再))";
  return new RegExp(
    `(?:${visibleContainer}[^。！？\\n]{0,14}(?:${deliveryVerb})?[^。！？\\n]{0,10}[“『「]?${escapedWord}[”』」]?(?:的)?${literalNoun}|${visibleContainer}[^。！？\\n]{0,14}(?:${deliveryVerb})?[^。！？\\n]{0,10}[“『「]${escapedWord}[”』」]|${visibleContainer}[^。！？\\n]{0,14}(?:${deliveryVerb})?[^。！？\\n]{0,10}${escapedWord}${labelBoundary}|${deliveryVerb}[^。！？\\n]{0,12}[“『「]${escapedWord}[”』」]|${deliveryVerb}[^。！？\\n]{0,12}${escapedWord}(?:的)?${literalNoun}|[“『「]?${escapedWord}[”』」]?(?:的)?${literalNoun})`,
  ).test(text);
}

export function parseReadingExperienceWords(tone: string | undefined, genre = "故事"): [string, string] {
  const parts = (tone ?? "")
    .split(/[·・、,，/|]/)
    .map(normalizeWord)
    .filter(Boolean);
  if (parts.length >= 2) return [parts[0], parts[1]];
  if (parts.length === 1) return [parts[0], normalizeWord(genre)];
  return ["沉浸", "成长"];
}

export function isSystemInvincibleExperience(sourceWords: readonly string[]): boolean {
  return sourceWords.includes("系统") && sourceWords.includes("无敌");
}

function defaultAxisDeliveryPolicy(axisId: ReadingExperienceAxisId): ReadingExperienceAxisDeliveryPolicy {
  return {
    axisId,
    mode: "hard_every_chapter",
    targetWindowChapters: 1,
    targetMaxOpenConflictChapters: 0,
  };
}

function compiledAxisDeliveryPolicy(
  axis: Pick<ReadingExperienceAxisContract, "id" | "word">,
): ReadingExperienceAxisDeliveryPolicy {
  const configured = curatedDefinitions[axis.word]?.delivery;
  return configured
    ? { axisId: axis.id, ...configured }
    : defaultAxisDeliveryPolicy(axis.id);
}

export function readingExperienceAxisDeliveryPolicy(
  contract: ReadingExperienceContract,
  axisId: ReadingExperienceAxisId,
): ReadingExperienceAxisDeliveryPolicy {
  const stored = contract.delivery?.axisPolicies?.find((policy) => policy.axisId === axisId);
  if (
    stored &&
    (stored.mode === "hard_every_chapter" || stored.mode === "soft_window") &&
    Number.isInteger(stored.targetWindowChapters) && stored.targetWindowChapters > 0 &&
    Number.isInteger(stored.targetMaxOpenConflictChapters) && stored.targetMaxOpenConflictChapters >= 0
  ) {
    return { ...stored };
  }
  const axis = contract.axes.find((candidate) => candidate.id === axisId);
  return axis ? compiledAxisDeliveryPolicy(axis) : defaultAxisDeliveryPolicy(axisId);
}

export function readingExperienceAxisUsesSoftWindow(
  contract: ReadingExperienceContract,
  axisId: ReadingExperienceAxisId,
): boolean {
  return readingExperienceAxisDeliveryPolicy(contract, axisId).mode === "soft_window";
}

function buildAxis(word: string, id: ReadingExperienceAxisId): ReadingExperienceAxisContract {
  const known = curatedDefinitions[word];
  const definition = known ?? {
    interpretation: `把“${word}”解释成可由人物行动、冲突结果和场景节奏直接感受到的阅读体验`,
    kind: "protagonist_action" as const,
    signals: [
      `至少一个人物行动具体体现“${word}”，不能只出现这个词`,
      `冲突结果或世界反应让“${word}”产生可观察后果`,
    ] as [string, string],
    promise: `每章都用事件、人物选择或语言节奏兑现“${word}”，不允许只用旁白贴标签`,
    forbidden: [`直接写“这很${word}”`, `把“${word}”拼接到天光、晨雾或暮色`],
  };
  const prefix = `${id}_${word}`;
  return {
    id,
    word,
    interpretation: definition.interpretation,
    observableSignals: definition.signals.map((description, index) => ({
      id: `${prefix}_signal_${index + 1}`,
      kind: definition.kind,
      description,
    })),
    hardPromises: [{
      id: `${prefix}_promise_1`,
      description: definition.promise,
      scope: "every_chapter",
    }],
    forbiddenShortcuts: definition.forbidden,
  };
}

function buildOpeningRequirements(
  axes: ReadingExperienceContract["axes"],
  policies: ReadingExperienceAxisDeliveryPolicy[] = axes.map(compiledAxisDeliveryPolicy),
): ReadingExperienceContract["openingRequirements"] {
  const hardAxes = axes.filter((axis) =>
    policies.find((policy) => policy.axisId === axis.id)?.mode !== "soft_window",
  );
  const firstChapterSignals = (axis: ReadingExperienceAxisContract) => {
    const modelSignal = axis.observableSignals.find((signal) => signal.id.includes("_model_signal_"));
    const baselineSignal = axis.observableSignals.find((signal) => !signal.id.includes("_model_signal_"));
    return modelSignal && baselineSignal
      ? [modelSignal.id, baselineSignal.id]
      : axis.observableSignals.slice(0, 2).map((signal) => signal.id);
  };
  return [
    {
      chapterOffset: 0,
      requiredSignalIds: hardAxes.flatMap(firstChapterSignals),
      mustHappen: hardAxes.map((axis) => `第一章必须直接兑现“${axis.word}”：${axis.hardPromises[0].description}`),
    },
    {
      chapterOffset: 1,
      requiredSignalIds: hardAxes.map((axis) => axis.observableSignals.at(-1)!.id),
      mustHappen: hardAxes.map((axis) => `第二章延续并升级“${axis.word}”已经造成的状态变化`),
    },
  ];
}

export function createReadingExperienceContract(options: {
  tone?: string;
  genre?: string;
  createdAt?: string;
  effectiveFromChapter?: number;
  provenance?: ReadingExperienceContract["provenance"];
}): ReadingExperienceContract {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const sourceWords = parseReadingExperienceWords(options.tone, options.genre);
  const axes: ReadingExperienceContract["axes"] = [
    buildAxis(sourceWords[0], "primary"),
    buildAxis(sourceWords[1], "secondary"),
  ];
  const axisPolicies = axes.map(compiledAxisDeliveryPolicy);
  const known = sourceWords.every((word) => Boolean(curatedDefinitions[word]));
  return {
    schemaVersion: 1,
    sourceTone: options.tone?.trim() || sourceWords.join(" · "),
    sourceWords,
    axes,
    synthesis: `“${sourceWords[0]}”与“${sourceWords[1]}”作为全书长期方向共同存在，并按各自交付节奏兑现。`,
    globalHardPromises: [{
      id: "experience_both_axes",
      description: "整部故事持续保留两个体验轴，软窗口体验允许阶段性留白但不能被最终结果推翻",
      scope: "whole_story",
    }],
    forbiddenCliches: [
      "把感觉词直接拼到天光、晨雾或暮色上",
      "旁白宣布感觉而事件与人物行动没有改变",
      "第一章只做异常调查、逐项记录和谨慎验证",
      "用上一章、下一章、章节、角色弧或读者等作者侧概念叙述",
    ],
    openingRequirements: buildOpeningRequirements(axes, axisPolicies),
    delivery: { minSignalsPerAxisPerChapter: 1, maxSilentChapters: 0, combinedSignalEveryChapters: 1, axisPolicies },
    effectiveFromChapter: options.effectiveFromChapter ?? 1,
    provenance: options.provenance ?? (known ? "curated" : "fallback"),
    createdAt,
  };
}

export function normalizeReadingExperienceContract(
  contract: ReadingExperienceContract,
): ReadingExperienceContract {
  const axisPolicies = contract.axes.map((axis) => {
    const configured = curatedDefinitions[axis.word]?.delivery;
    return configured
      ? { axisId: axis.id, ...configured }
      : readingExperienceAxisDeliveryPolicy(contract, axis.id);
  });
  const policyByAxis = new Map(axisPolicies.map((policy) => [policy.axisId, policy]));
  const axes = contract.axes.map((axis) => {
    const policy = policyByAxis.get(axis.id);
    if (policy?.mode !== "soft_window") return { ...axis };
    const curated = curatedDefinitions[axis.word];
    return {
      ...axis,
      hardPromises: [{
        id: axis.hardPromises[0]?.id ?? `${axis.id}_${axis.word}_promise_1`,
        description: curated?.promise ?? "该体验不能被已经落地的最终结果推翻",
        scope: "every_chapter" as const,
      }],
      forbiddenShortcuts: axis.forbiddenShortcuts.filter((shortcut) =>
        !/(?:五五开|势均力敌|不分胜负)/.test(shortcut),
      ),
    };
  }) as ReadingExperienceContract["axes"];
  const hasSoftWindow = axisPolicies.some((policy) => policy.mode === "soft_window");
  return {
    ...contract,
    axes,
    synthesis: hasSoftWindow
      ? `“${axes[0].word}”与“${axes[1].word}”作为全书长期方向共同存在，并按各自交付节奏兑现。`
      : contract.synthesis,
    globalHardPromises: hasSoftWindow
      ? [{
          id: "experience_both_axes",
          description: "整部故事持续保留两个体验轴，软窗口体验允许阶段性留白但不能被最终结果推翻",
          scope: "whole_story",
        }]
      : contract.globalHardPromises,
    openingRequirements: buildOpeningRequirements(axes, axisPolicies),
    delivery: {
      minSignalsPerAxisPerChapter: contract.delivery?.minSignalsPerAxisPerChapter ?? 1,
      maxSilentChapters: contract.delivery?.maxSilentChapters ?? 0,
      combinedSignalEveryChapters: contract.delivery?.combinedSignalEveryChapters ?? 1,
      axisPolicies,
    },
  };
}
export interface ReadingExperienceCadenceState {
  axisId: ReadingExperienceAxisId;
  word: string;
  status: "normal" | "due" | "debt";
  silentChapters: number;
  targetWindowChapters: number;
  openConflictChapters: number;
  debtOpen: boolean;
}

function softWindowAxes(contract: ReadingExperienceContract) {
  return contract.axes.filter((axis) => readingExperienceAxisUsesSoftWindow(contract, axis.id));
}

export function normalizeReadingExperienceDeliveryLedger(
  contract: ReadingExperienceContract,
  ledger: ReadingExperienceDeliveryLedgerEntry[] | undefined,
  currentChapterNumber: number,
): ReadingExperienceDeliveryLedgerEntry[] {
  const baselineChapter = Math.max(0, Math.floor(currentChapterNumber));
  return softWindowAxes(contract).map((axis) => {
    const stored = ledger?.find((entry) => entry.axisId === axis.id);
    const storedLastEvaluated = stored && Number.isInteger(stored.lastEvaluatedChapter)
      ? Math.max(0, stored.lastEvaluatedChapter)
      : baselineChapter;
    const lastEvaluatedChapter = Math.max(storedLastEvaluated, baselineChapter);
    const lastDeliveredChapter = stored && Number.isInteger(stored.lastDeliveredChapter) &&
      stored.lastDeliveredChapter! >= 0 &&
      stored.lastDeliveredChapter! <= lastEvaluatedChapter
      ? stored.lastDeliveredChapter
      : undefined;
    const openConflictSinceChapter = stored && Number.isInteger(stored.openConflictSinceChapter) &&
      stored.openConflictSinceChapter! >= 0 &&
      stored.openConflictSinceChapter! <= lastEvaluatedChapter
      ? stored.openConflictSinceChapter
      : undefined;
    return {
      axisId: axis.id,
      lastEvaluatedChapter,
      ...(lastDeliveredChapter === undefined ? {} : { lastDeliveredChapter }),
      silentChapters: stored && Number.isInteger(stored.silentChapters)
        ? Math.max(0, stored.silentChapters)
        : 0,
      debtOpen: Boolean(stored?.debtOpen),
      ...(openConflictSinceChapter === undefined ? {} : { openConflictSinceChapter }),
    };
  });
}

export function updateReadingExperienceDeliveryLedger(
  contract: ReadingExperienceContract,
  ledger: ReadingExperienceDeliveryLedgerEntry[] | undefined,
  chapterNumber: number,
  observations: ReadingExperienceDeliveryObservation[] | undefined,
): ReadingExperienceDeliveryLedgerEntry[] {
  const safeChapterNumber = Math.max(1, Math.floor(chapterNumber));
  const normalized = normalizeReadingExperienceDeliveryLedger(contract, ledger, safeChapterNumber - 1);
  return normalized.map((entry) => {
    if (entry.lastEvaluatedChapter >= safeChapterNumber) return { ...entry };
    const policy = readingExperienceAxisDeliveryPolicy(contract, entry.axisId);
    const observation = observations?.find((candidate) => candidate.axisId === entry.axisId);
    const state = observation?.state ?? "no_conflict";
    if (state === "dominant_victory") {
      return {
        axisId: entry.axisId,
        lastEvaluatedChapter: safeChapterNumber,
        lastDeliveredChapter: safeChapterNumber,
        silentChapters: 0,
        debtOpen: false,
      };
    }

    const silentChapters = entry.silentChapters + (safeChapterNumber - entry.lastEvaluatedChapter);
    const openConflictSinceChapter = state === "open_parity"
      ? entry.openConflictSinceChapter ?? safeChapterNumber
      : entry.openConflictSinceChapter;
    return {
      ...entry,
      lastEvaluatedChapter: safeChapterNumber,
      silentChapters,
      debtOpen: silentChapters >= policy.targetWindowChapters,
      ...(openConflictSinceChapter === undefined ? {} : { openConflictSinceChapter }),
    };
  });
}
export type ReadingExperienceCadenceAuditCode =
  | "experience_cadence_silent"
  | "experience_debt_opened"
  | "open_conflict_carried";

export interface ReadingExperienceCadenceAuditEvent {
  code: ReadingExperienceCadenceAuditCode;
  axisId: ReadingExperienceAxisId;
  state: ReadingExperienceDeliveryObservation["state"];
  silentChapters: number;
  debtOpen: boolean;
  lastDeliveredChapter?: number;
}

export function readingExperienceCadenceAuditEvents(
  contract: ReadingExperienceContract,
  before: ReadingExperienceDeliveryLedgerEntry[] | undefined,
  after: ReadingExperienceDeliveryLedgerEntry[] | undefined,
  observations: ReadingExperienceDeliveryObservation[] | undefined,
): ReadingExperienceCadenceAuditEvent[] {
  const priorByAxis = new Map((before ?? []).map((entry) => [entry.axisId, entry]));
  const afterByAxis = new Map((after ?? []).map((entry) => [entry.axisId, entry]));
  const events: ReadingExperienceCadenceAuditEvent[] = [];
  for (const axis of softWindowAxes(contract)) {
    const entry = afterByAxis.get(axis.id);
    if (!entry) continue;
    const state = observations?.find((observation) => observation.axisId === axis.id)?.state ?? "no_conflict";
    const eventBase = {
      axisId: axis.id,
      state,
      silentChapters: entry.silentChapters,
      debtOpen: entry.debtOpen,
      ...(entry.lastDeliveredChapter === undefined ? {} : { lastDeliveredChapter: entry.lastDeliveredChapter }),
    };
    if (state === "open_parity") {
      events.push({ code: "open_conflict_carried", ...eventBase });
    } else if (state === "no_conflict") {
      events.push({ code: "experience_cadence_silent", ...eventBase });
    }
    if (!priorByAxis.get(axis.id)?.debtOpen && entry.debtOpen) {
      events.push({ code: "experience_debt_opened", ...eventBase });
    }
  }
  return events;
}


export function readingExperienceCadenceState(
  contract: ReadingExperienceContract,
  ledger: ReadingExperienceDeliveryLedgerEntry[] | undefined,
  nextChapterNumber: number,
): ReadingExperienceCadenceState[] {
  const safeNextChapter = Math.max(1, Math.floor(nextChapterNumber));
  const normalized = normalizeReadingExperienceDeliveryLedger(contract, ledger, safeNextChapter - 1);
  return normalized.map((entry) => {
    const axis = contract.axes.find((candidate) => candidate.id === entry.axisId)!;
    const policy = readingExperienceAxisDeliveryPolicy(contract, entry.axisId);
    const openConflictChapters = entry.openConflictSinceChapter === undefined
      ? 0
      : Math.max(0, safeNextChapter - entry.openConflictSinceChapter);
    const due = entry.silentChapters >= Math.max(0, policy.targetWindowChapters - 1) ||
      (entry.openConflictSinceChapter !== undefined &&
        openConflictChapters >= policy.targetMaxOpenConflictChapters);
    return {
      axisId: entry.axisId,
      word: axis.word,
      status: entry.debtOpen ? "debt" : due ? "due" : "normal",
      silentChapters: entry.silentChapters,
      targetWindowChapters: policy.targetWindowChapters,
      openConflictChapters,
      debtOpen: entry.debtOpen,
    };
  });
}

export function formatReadingExperienceCadenceForPrompt(
  contract: ReadingExperienceContract,
  ledger: ReadingExperienceDeliveryLedgerEntry[] | undefined,
  nextChapterNumber: number,
): string {
  const states = readingExperienceCadenceState(contract, ledger, nextChapterNumber);
  if (states.length === 0) return "";
  return states.map((state) => {
    if (state.status === "debt") {
      return `“${state.word}”体验债务已打开：已经连续 ${state.silentChapters} 章没有压倒性胜利。本章规划应优先安排主角完成决定性胜利并改变现实状态；这是强规划优先级，仍不是发布门禁，不能仅因本章未胜而拒绝或重写正文。`;
    }
    if (state.status === "due") {
      const parity = state.openConflictChapters > 0
        ? `，且未决对抗已延续 ${state.openConflictChapters} 章`
        : "";
      return `“${state.word}”进入优先兑现期：已经连续 ${state.silentChapters} 章没有压倒性胜利${parity}。本章候选优先通过系统任务、能力兑现或局势反转形成决定性胜利；这是软性节奏目标，不是逐章校验条件。`;
    }
    return `“${state.word}”处于正常节奏：目标约每 ${state.targetWindowChapters} 章出现一次压倒性胜利；本章可铺垫、暂时五五开或保持冲突未决。`;
  }).join("\n");
}

export function createLegacyExperienceContract(options: {
  tone?: string;
  genre?: string;
  effectiveFromChapter: number;
  createdAt: string;
}): ReadingExperienceContract {
  return createReadingExperienceContract({ ...options, provenance: "legacy" });
}

export interface ModelExperienceSignalDraft {
  description: string;
  evidenceAnchors?: string[];
}

export interface ModelExperienceAxisDraft {
  word: string;
  interpretation: string;
  observableSignals: Array<string | ModelExperienceSignalDraft>;
  hardPromises: string[];
  forbiddenShortcuts: string[];
}

const evidenceAnchorStopPhrases = [
  "阅读体验", "体验轴", "体验词", "可观察信号", "硬承诺", "人物行动", "主角行动", "冲突结果", "世界反应",
  "每一章", "每章", "至少一个", "至少一次", "必须", "需要", "应该", "不能只", "不允许", "通过", "对应",
  "体现", "表达", "兑现", "展示", "产生", "改变", "真实", "具体", "人物", "主角", "行动", "结果",
  "关系", "体验", "信号", "能力", "场景", "语义", "阅读", "一个", "一次",
  "父亲", "母亲", "孩子", "女儿", "儿子", "年轻人", "少年", "少女", "同伴", "朋友", "敌人", "对手",
  "随后", "然后", "接着", "立刻", "当场", "开始", "进行", "发生", "看着", "看到", "走进", "走出", "转身",
];

const genericEvidenceAnchors = new Set([
  "人物", "主角", "父亲", "母亲", "孩子", "女儿", "儿子", "同伴", "朋友", "敌人", "对手", "行动", "动作",
  "结果", "关系", "体验", "信号", "能力", "场景", "完成", "改变", "发生", "随后", "然后", "当场", "具体", "真实",
]);

export function deriveSignalEvidenceAnchors(description: string, axisWord: string): string[] {
  let normalized = description.normalize("NFKC").toLowerCase();
  const normalizedWord = axisWord.normalize("NFKC").toLowerCase();
  if (normalizedWord) normalized = normalized.replaceAll(normalizedWord, "|");
  for (const phrase of [...evidenceAnchorStopPhrases].sort((left, right) => right.length - left.length)) {
    normalized = normalized.replaceAll(phrase, "|");
  }
  const candidates = new Set<string>();
  const shortCandidates = new Set<string>();
  for (const segment of normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    for (const run of segment.match(/[\p{Script=Han}]+/gu) ?? []) {
      const characters = Array.from(run);
      for (const size of [4, 3]) {
        for (let index = 0; index <= characters.length - size; index += 1) {
          const anchor = characters.slice(index, index + size).join("");
          if (!genericEvidenceAnchors.has(anchor)) candidates.add(anchor);
        }
      }
      for (let index = 0; index < characters.length - 1; index += 1) {
        const anchor = characters.slice(index, index + 2).join("");
        if (!genericEvidenceAnchors.has(anchor)) shortCandidates.add(anchor);
      }
    }
    for (const term of segment.match(/[a-z0-9]{3,}/g) ?? []) candidates.add(term);
  }
  if (candidates.size < 2) {
    for (const candidate of shortCandidates) candidates.add(candidate);
  }
  return [...candidates];
}

export function hasIndependentSignalEvidenceAnchors(anchors: readonly string[]): boolean {
  const normalized = Array.from(new Set(anchors.map((anchor) => anchor.normalize("NFKC").toLowerCase()).filter(Boolean)));
  return normalized.some((left, leftIndex) => normalized.slice(leftIndex + 1).some((right) => {
    if (left.includes(right) || right.includes(left)) return false;
    const leftCharacters = new Set(Array.from(left));
    const rightCharacters = new Set(Array.from(right));
    const shared = [...leftCharacters].filter((character) => rightCharacters.has(character)).length;
    return shared / Math.min(leftCharacters.size, rightCharacters.size) < 0.75;
  }));
}

function normalizedModelSignal(value: string | ModelExperienceSignalDraft): ModelExperienceSignalDraft | undefined {
  if (typeof value === "string") {
    const description = value.trim();
    return description ? { description } : undefined;
  }
  if (!value || typeof value.description !== "string") return undefined;
  const description = value.description.trim();
  return description ? { description, evidenceAnchors: value.evidenceAnchors } : undefined;
}

function groundedEvidenceAnchorsFromDescription(description: string, axisWord: string): string[] | undefined {
  const candidates = deriveSignalEvidenceAnchors(description, axisWord);
  let independentPair: [string, string] | undefined;
  let widestSeparation = -1;
  const normalizedDescription = description.normalize("NFKC").toLowerCase();
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const pair: [string, string] = [candidates[leftIndex], candidates[rightIndex]];
      if (!hasIndependentSignalEvidenceAnchors(pair)) continue;
      const separation = Math.abs(
        normalizedDescription.indexOf(pair[0]) - normalizedDescription.indexOf(pair[1]),
      );
      if (separation <= widestSeparation) continue;
      independentPair = pair;
      widestSeparation = separation;
    }
  }
  if (!independentPair) return undefined;
  return independentPair.sort((left, right) =>
    normalizedDescription.indexOf(left) - normalizedDescription.indexOf(right));
}

function validatedEvidenceAnchors(
  signal: ModelExperienceSignalDraft,
  axisWord: string,
): string[] {
  if (signal.evidenceAnchors === undefined) {
    const derived = groundedEvidenceAnchorsFromDescription(signal.description, axisWord);
    if (!derived) {
      throw new Error(`“${axisWord}”的模型信号缺少可核验的具体动作、对象或结果短语。`);
    }
    return derived;
  }
  if (!Array.isArray(signal.evidenceAnchors)) {
    throw new Error(`“${axisWord}”的模型信号 evidenceAnchors 必须是短语数组。`);
  }
  const anchors = Array.from(new Set(signal.evidenceAnchors
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.normalize("NFKC").trim())
    .filter(Boolean)));
  if (
    anchors.length < 2 || anchors.length > 6 ||
    anchors.some((anchor) => Array.from(anchor).length < 2 || Array.from(anchor).length > 16) ||
    anchors.some((anchor) => anchor === axisWord || genericEvidenceAnchors.has(anchor) || !signal.description.includes(anchor)) ||
    !hasIndependentSignalEvidenceAnchors(anchors)
  ) {
    const derived = groundedEvidenceAnchorsFromDescription(signal.description, axisWord);
    if (derived) return derived;
    throw new Error(`“${axisWord}”的模型信号必须给出 2—6 个来自描述本身、分别绑定具体动作与对象或结果的证据短语。`);
  }
  return anchors;
}

export function refineReadingExperienceContract(
  base: ReadingExperienceContract,
  drafts: ModelExperienceAxisDraft[],
): ReadingExperienceContract {
  if (!Array.isArray(drafts) || drafts.length !== 2) {
    throw new Error("规划模型必须分别解释两个阅读体验词。");
  }
  const axes = base.axes.map((axis, axisIndex) => {
    const draft = drafts[axisIndex];
    if (draft?.word?.trim() !== axis.word) throw new Error(`规划模型改变了阅读体验词“${axis.word}”。`);
    if (
      typeof draft.interpretation !== "string" || draft.interpretation.trim().length < 8 ||
      !Array.isArray(draft.observableSignals) || draft.observableSignals.length < 2 ||
      !Array.isArray(draft.hardPromises) || draft.hardPromises.length < 1 ||
      !draft.hardPromises.every((value) => typeof value === "string" && value.trim().length >= 6) ||
      !Array.isArray(draft.forbiddenShortcuts) ||
      !draft.forbiddenShortcuts.every((value) => typeof value === "string" && value.trim().length >= 4)
    ) {
      throw new Error(`规划模型没有为“${axis.word}”返回足够具体的可观察承诺。`);
    }
    const modelSignals = draft.observableSignals
      .map(normalizedModelSignal)
      .filter((signal): signal is ModelExperienceSignalDraft => Boolean(signal));
    if (
      modelSignals.length !== draft.observableSignals.length ||
      modelSignals.some((signal) => signal.description.length < 6)
    ) {
      throw new Error(`规划模型没有为“${axis.word}”返回足够具体的可观察信号。`);
    }
    const isCurated = Boolean(curatedDefinitions[axis.word]);
    const semanticDraftText = [
      draft.interpretation,
      ...modelSignals.map((signal) => signal.description),
      ...draft.hardPromises,
    ].join("\n");
    if (!isCurated && !semanticDraftText.includes(axis.word)) {
      throw new Error(`规划模型没有把体验词“${axis.word}”绑定到解释、信号或硬承诺。`);
    }
    if (!isCurated) {
      const observableSemanticBinding = [draft.interpretation, ...modelSignals.map((signal) => signal.description), ...draft.hardPromises].some((value) =>
        value.includes(axis.word) && /行动|选择|关系|照料|保护|冲突|结果|机制|节奏|反应|决定|改变|影响|使用|完成|承担|拿起|放回|关门/.test(value),
      );
      if (usesExperienceWordAsLiteralLabel(semanticDraftText, axis.word) || !observableSemanticBinding) {
        throw new Error(`规划模型把体验词“${axis.word}”当成文字标签，没有绑定人物行动或结果语义。`);
      }
    }
    const usesSpecializedDeterministicGate = axis.word === "系统" || axis.word === "无敌";
    if (isCurated && usesSpecializedDeterministicGate) {
      return {
        ...axis,
        forbiddenShortcuts: Array.from(new Set([
          ...axis.forbiddenShortcuts,
          ...draft.forbiddenShortcuts.map((value) => value.trim().slice(0, 180)),
        ])).slice(0, 8),
      };
    }
    const signalKind = axis.observableSignals[0]?.kind ?? "protagonist_action";
    const modelBackedSignals = modelSignals.slice(0, 4).map((signal, index) => {
      const storedSignal = { ...signal, description: signal.description.slice(0, 240) };
      return {
        id: `${axis.id}_${axis.word}_model_signal_${index + 1}`,
        kind: signalKind,
        description: storedSignal.description,
        evidenceAnchors: validatedEvidenceAnchors(storedSignal, axis.word),
      };
    });
    if (isCurated) {
      return {
        ...axis,
        observableSignals: [...modelBackedSignals, ...axis.observableSignals].slice(0, 6),
        forbiddenShortcuts: Array.from(new Set([
          ...axis.forbiddenShortcuts,
          ...draft.forbiddenShortcuts.map((value) => value.trim().slice(0, 180)),
        ])).slice(0, 8),
      };
    }
    return {
      ...axis,
      interpretation: draft.interpretation.trim().slice(0, 300),
      observableSignals: [
        ...modelBackedSignals,
        ...axis.observableSignals,
      ].slice(0, 6),
      hardPromises: [
        ...draft.hardPromises.slice(0, 3).map((description, index) => ({
          id: `${axis.id}_${axis.word}_promise_${index + 1}`,
          description: description.trim().slice(0, 260),
          scope: "every_chapter" as const,
        })),
        ...axis.hardPromises,
      ].slice(0, 4),
      forbiddenShortcuts: Array.from(new Set([
        ...axis.forbiddenShortcuts,
        ...draft.forbiddenShortcuts.map((value) => value.trim().slice(0, 180)),
      ])).slice(0, 8),
    };
  }) as ReadingExperienceContract["axes"];
  return normalizeReadingExperienceContract({
    ...base,
    axes,
    synthesis: `“${axes[0].word}”和“${axes[1].word}”必须由同一条人物行动与冲突结果共同兑现。`,
    openingRequirements: buildOpeningRequirements(axes),
    provenance: "model",
  });
}

export function formatReadingExperienceForPrompt(contract: ReadingExperienceContract, chapterNumber: number): string {
  const normalized = normalizeReadingExperienceContract(contract);
  const openingOffset = chapterNumber - normalized.effectiveFromChapter;
  const opening = normalized.openingRequirements.find((requirement) => requirement.chapterOffset === openingOffset);
  const hardAxes = normalized.axes.filter((axis) => !readingExperienceAxisUsesSoftWindow(normalized, axis.id));
  return [
    `阅读体验总方向：${normalized.synthesis}`,
    ...normalized.axes.map((axis) => {
      const policy = readingExperienceAxisDeliveryPolicy(normalized, axis.id);
      const formattedSignals = axis.observableSignals.map((signal) => {
        const evidenceAnchors = signal.evidenceAnchors?.length
          ? signal.evidenceAnchors
          : signal.id.includes("_model_signal_")
            ? deriveSignalEvidenceAnchors(signal.description, axis.word)
            : [];
        return `${signal.id}=${signal.description}${evidenceAnchors.length ? `【语义识别参考：${evidenceAnchors.join("、")}】` : ""}`;
      });
      return [
        `体验轴“${axis.word}”：${axis.interpretation}`,
        `可观察信号：${formattedSignals.join("；")}`,
        policy.mode === "soft_window"
          ? `主旋律节奏目标：约每 ${policy.targetWindowChapters} 章出现一次压倒性胜利；本章允许铺垫、暂时五五开或冲突未决，只要不形成主角已经落地的最终失败。缺少本章胜利不会触发拒绝或重写。`
          : `硬承诺：${axis.hardPromises.map((promise) => promise.description).join("；")}`,
        axis.observableSignals.some((signal) => signal.id.includes("_model_signal_"))
          ? `语义证据：正文不必出现“${axis.word}”这个词，也不要求逐字复制参考短语；须用人物、动作、对象、结果或感官变化自然兑现信号，由审稿模型按大意判断，并从正文逐字引用证据。禁止贴标签或拼到景物描写上。`
          : "",
        `禁止捷径：${axis.forbiddenShortcuts.join("；") || "无"}`,
      ].join("\n");
    }),
    opening && opening.requiredSignalIds.length
      ? `本章开篇硬性兑现要求：${opening.mustHappen.join("；")}；必须覆盖信号 ${opening.requiredSignalIds.join("、")}`
      : hardAxes.length
        ? `本章硬性要求：${hardAxes.map((axis) => `“${axis.word}”至少出现一个可观察信号`).join("；")}。软窗口体验按跨章节奏推进。`
        : "本章体验轴均按跨章节奏推进，不要求逐章同时兑现。",
    `通用禁忌：${normalized.forbiddenCliches.join("；")}`,
    `这些是后台约束。${IMMERSIVE_NARRATION_PROMPT}`,
  ].join("\n");
}
