import type { ExperienceCategory, EvidencePolicy } from "../../src/types";
import type { InterpretationDimensionDraft } from "./types";
import type { GenericRuleAdapterId } from "./types";
import { verifyNarrativeRealization, violatesNarrativeInvariant, type NarrativeInvariantContext, type RealizationBinding, type RealizationSlot } from "./narrativeSemantics/index";

export type { RealizationBinding, RealizationSlot } from "./narrativeSemantics/index";

interface CuratedRule {
  interpretation: string;
  category: ExperienceCategory;
  signals: [string, string];
  prohibition: string;
  persistence: InterpretationDimensionDraft["observableSignals"][number]["persistence"];
  role: string;
  tension?: "care" | "cost";
  adapterId?: GenericRuleAdapterId;
}

const eventVerificationByCategory: Record<"mechanic" | "protagonist_action" | "conflict_outcome" | "world_reaction", EvidencePolicy> = {
  mechanic: { kind: "event_slots", requiredSlots: ["actor", "action", "object", "outcome"], minimumAnchors: 2 },
  protagonist_action: { kind: "event_slots", requiredSlots: ["actor", "action", "outcome"], minimumAnchors: 2 },
  conflict_outcome: { kind: "event_slots", requiredSlots: ["actor", "action", "outcome"], minimumAnchors: 2 },
  world_reaction: { kind: "event_slots", requiredSlots: ["actor", "reaction", "outcome"], minimumAnchors: 2 },
};

const relationshipVerification: EvidencePolicy = {
  kind: "relationship_change",
  requireReciprocalAction: true,
  minimumAnchors: 2,
};

const curatedRules: Record<string, CuratedRule> = {
  系统: {
    interpretation: "可操作的机制反馈持续改变人物的选择、资源或处境。",
    category: "mechanic",
    signals: ["人物触发机制后获得可见反馈并据此行动", "机制的状态或结果在后续冲突中产生真实影响"],
    prohibition: "不得把核心机制写成比喻、旁白标签或长期不可用的摆设。",
    persistence: "cross_chapter",
    role: "提供可操作的因果杠杆",
    adapterId: "curated-mechanic-unavailable",
  },
  无敌: {
    interpretation: "主角在正面对抗中保持压倒性优势，悬念来自胜利造成的变化。",
    category: "conflict_outcome",
    signals: ["有意义的正面对抗以主角压倒性优势结束", "对手或秩序对力量差距作出可见反应"],
    prohibition: "不得以临时削弱、同级僵持或救场收回既定优势。",
    persistence: "whole_story",
    role: "让胜利改变外部局势",
    adapterId: "curated-outcome-weakened",
  },
  治愈: {
    interpretation: "困境被准确看见，并通过可持续的关系行动得到承接。",
    category: "relationship",
    signals: ["一方以具体行动回应另一方真实需求", "被照料者以选择或行动回应，关系发生可见变化"],
    prohibition: "不得用一句原谅或空泛安慰替代恢复过程。",
    persistence: "cross_chapter",
    role: "让人物在代价中彼此承接",
    tension: "care",
  },
  残酷: {
    interpretation: "错误选择和冲突留下明确且不能自动抹去的代价。",
    category: "conflict_outcome",
    signals: ["一次选择造成具体的资源、身体或关系损失", "损失持续影响之后的行动与结果"],
    prohibition: "不得让胜利自动消除已发生的代价，或以无意义虐待冒充后果。",
    persistence: "cross_chapter",
    role: "让外部规则保留真实代价",
    tension: "cost",
  },
  温暖: {
    interpretation: "人物以具体照料、理解或陪伴回应彼此的困境。",
    category: "relationship",
    signals: ["照料行动改变对方当下的处境", "对方的回应让关系位置发生可观察变化"],
    prohibition: "不得用空泛赞美或旁白宣告替代关系行动。",
    persistence: "cross_chapter",
    role: "让关系提供可感知的支持",
  },
  轻盈: {
    interpretation: "推进明快而有呼吸，压力不会长期停滞在同一处。",
    category: "pacing",
    signals: ["冲突后迅速出现新的动作、转机或小回报", "场景转换保持清晰目标和轻快节拍"],
    prohibition: "不得以连续沉重复盘或无目标停滞拖慢推进。",
    persistence: "chapter",
    role: "保持推进中的呼吸与回弹",
  },
};

function cloneEvidencePolicy(policy: EvidencePolicy): EvidencePolicy {
  if (policy.kind === "event_slots") return { ...policy, requiredSlots: [...policy.requiredSlots] };
  if (policy.kind === "distribution") return { ...policy, metricIds: [...policy.metricIds], requiredRegions: [...policy.requiredRegions], metricThresholds: { ...policy.metricThresholds } };
  return { ...policy };
}

function verificationFor(category: ExperienceCategory): EvidencePolicy {
  if (category === "relationship") return cloneEvidencePolicy(relationshipVerification);
  if (category === "voice") return { kind: "distribution", metricIds: ["anchor_spread", "scene_coverage", "paragraph_consistency", "abstraction_coverage", "sensory_coverage", "rhetoric_coverage"], minimumAnchors: 3, requireSemanticJudge: true, requiredRegions: ["opening", "middle", "ending"], regionSemantics: "paragraph", metricThresholds: { anchor_spread: 0.35, paragraph_consistency: 0.35, scene_coverage: 1, abstraction_coverage: 0.12, sensory_coverage: 0.12, rhetoric_coverage: 0.12 } };
  if (category === "pacing") return { kind: "distribution", metricIds: ["anchor_spread", "scene_coverage", "event_density", "pressure_window", "paragraph_length_density", "sentence_length_density", "turn_position"], minimumAnchors: 3, requireSemanticJudge: true, requiredRegions: ["opening", "middle", "ending"], regionSemantics: "paragraph", metricThresholds: { anchor_spread: 0.35, scene_coverage: 1, event_density: 0.15, pressure_window: 0.2, paragraph_length_density: 0.5, sentence_length_density: 0.5, turn_position: 0.55 } };
  return cloneEvidencePolicy(eventVerificationByCategory[category]);
}

/** The only production catalogue that contains concrete curated descriptor mappings. */
export function curatedInterpretation(descriptor: string): InterpretationDimensionDraft | undefined {
  const rule = curatedRules[descriptor];
  if (!rule) return undefined;
  return {
    descriptor,
    interpretation: rule.interpretation,
    categories: [rule.category],
    observableSignals: rule.signals.map((description) => ({
      description,
      kind: rule.category,
      verification: verificationFor(rule.category),
      persistence: rule.persistence,
    })),
    prohibitions: [{ kind: "invariant", description: rule.prohibition, severity: "block", ...(rule.adapterId ? { ruleAdapterId: rule.adapterId } : {}) }],
    confidence: 1,
  };
}

export function curatedSynthesis(left: string, right: string): { sharedCause: string; dimensionRoles: [string, string] } | undefined {
  const leftRule = curatedRules[left];
  const rightRule = curatedRules[right];
  if (!leftRule || !rightRule) return undefined;
  if (leftRule.tension === "care" && rightRule.tension === "cost" || leftRule.tension === "cost" && rightRule.tension === "care") {
    return {
      sharedCause: "同一场选择在严苛后果下推进，人物必须以可见行动承担代价并彼此回应。",
      dimensionRoles: [leftRule.role, rightRule.role],
    };
  }
  return {
    sharedCause: "同一条人物行动因果链同时改变处境、关系或局势，使两个体验维度都可被观察。",
    dimensionRoles: [leftRule.role, rightRule.role],
  };
}

export function evidencePolicyFor(category: ExperienceCategory): EvidencePolicy {
  return verificationFor(category);
}

/** Generic, data-selected deterministic shortcuts.  These are never keyed by a descriptor. */
const genericAdapters: Record<GenericRuleAdapterId, RegExp> = {
  "event-negated": /\b(?:not|never|neither|nor|cannot|can[’']t|couldn[’']t|shouldn[’']t|wouldn[’']t|won[’']t|doesn[’']t|don[’']t|didn[’']t|isn[’']t|aren[’']t|wasn[’']t|weren[’']t|hasn[’']t|haven[’']t|hadn[’']t)\b|(?:没有|未能|并未|未曾|不曾|无法|不能|不会|不愿|不肯|不要|绝不|从不|并不|不(?:启动|开启|生效|反馈|工作|运作|可用|获胜|击败|制胜|成功|保持))/i,
  "event-intent": /\b(?:plan(?:s|ned|ning)?|intend(?:s|ed|ing)?|prepar(?:e|es|ed|ing)|want(?:s|ed|ing)?|hop(?:e|es|ed|ing)|wish(?:es|ed|ing)|aim(?:s|ed|ing)?)\b|(?:计划|打算|准备|将要|想要|希望|意图|意欲)/i,
  "event-failed-attempt": /\b(?:attempt(?:s|ed|ing)?|tr(?:y|ies|ied|ying)|fail(?:s|ed|ing)?)\b|(?:试图|试着|尝试|险些|差点|失败)/i,
  "event-simulation": /\b(?:dream(?:s|ed|ing|t)?|simulat(?:e|es|ed|ing|ion)|predict(?:s|ed|ing|ion|ions)?|conditional|would|might|imagin(?:e|es|ed|ing|ation)|pretend(?:s|ed|ing)?|seem(?:s|ed|ing)?|apparently)\b|(?:梦境|做梦|模拟|预测|预言|如果|幻想|想象|假装|似乎|仿佛|看似)/i,
  "event-hearsay": /\b(?:hearsay|rumou?r|hear(?:s|d|ing)?|claim(?:s|ed|ing)?|report(?:s|ed|ing)?|say|says|said|announce(?:s|d|ing)?)\b|(?:据说|传闻|听说|据报道|报道称|有人说|声称)/i,
  "helper-substitution": /\bhelper\b|(?:他人代做|旁人替代)/i,
  "contains-pasted-label": /\b(?:label|descriptor)\b|(?:标签|描述词)/i,
  "curated-mechanic-unavailable": /(?:system|mechanic|panel|ability|系统|机制|面板|能力).{0,64}?(?:never\s+(?:available|works?)|unavailable|destroyed|cannot\s+(?:activate|use)|无法使用|无法启动|永远不可用|永久失效|被(?:彻底)?摧毁|只是比喻|没有反馈)/i,
  "curated-outcome-weakened": /(?:protagonist|主角|主人公).{0,24}?(?:rescued|draws?|defeated|los(?:e|es|t)|surrenders?|gives?\s+up|被救场|战平|惨败|失去优势|投降|放弃目标)/i,
};

const nonRealizationAdapterIds = ["event-negated", "event-intent", "event-failed-attempt", "event-simulation", "event-hearsay"] as const;
type NonRealizationAdapterId = typeof nonRealizationAdapterIds[number];
interface ModalityMatch { id: NonRealizationAdapterId; start: number; end: number; cancellationStart?: number; }
const realizationSlots = new Set<RealizationSlot>(["action", "object", "feedback", "outcome", "reaction", "reciprocalAction", "relationshipChange", "counterpart", "opponent"]);
const propositionBoundary = /\b(?:and|or|then|but|instead|actually|in\s+reality|after|before|while|whereas|when|once|because|although|though|as)\b|(?:并且|或者|然后|接着|继而|而后|反而|而是|随后|下一刻|紧接着|实际上|现实中|事实上|与此同时|同时|之后|以前|当|因为|虽然|并|或|也|却)/giu;
const realityBoundaries = new Set(["actually", "in reality", "实际上", "现实中", "事实上"]);
const localReversalBoundaries = new Set(["but", "instead", "actually", "in reality", "反而", "而是", "却", "实际上", "现实中", "事实上"]);
const affirmativeNegationIdiom = /(?:(?:不是|并非|绝非|未尝)(?:没有|没能?|未能?)|(?:没有|未曾|未尝)不|不得不|不得已|不能不|不会不|不可不|未尝不|何尝不|不由得|不禁|(?:忍|按捺)不住|情不自禁|迫不及待|不(?:假思索|慌不忙|紧不慢|卑不亢|知不觉|动声色|约而同|期而遇|谋而合|费吹灰之力|露声色|容分说|顾一切|甘示弱|遗余力|声不响|惜代价)|毫不(?:犹豫|迟疑|费力|畏惧|在意|示弱|留情|客气)|战无不胜|无坚不摧|无所不能|无不|没有(?:丝毫|半点|任何)?(?:犹豫|迟疑|停顿))/giu;

function realizationClauseRanges(source: string): Array<{ start: number; text: string }> {
  const ranges: Array<{ start: number; text: string }> = [];
  const boundary = /[,.!?;，。！？；]|\b(?:while|whereas)\b|(?:与此同时|同时|而后)/giu;
  let start = 0;
  for (const match of source.matchAll(boundary)) {
    const raw = source.slice(start, match.index!); const leading = raw.search(/\S/u);
    if (leading >= 0) ranges.push({ start: start + leading, text: raw.slice(leading).trimEnd() });
    start = match.index! + match[0].length;
  }
  const raw = source.slice(start); const leading = raw.search(/\S/u);
  if (leading >= 0) ranges.push({ start: start + leading, text: raw.slice(leading).trimEnd() });
  return ranges;
}

function isNotOnlyMatch(source: string, index: number): boolean {
  return /^(?:not\s+only\b|不仅|不但)/iu.test(source.slice(index));
}

function globalMatcher(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

function isInsideAffirmativeNegationIdiom(source: string, start: number): boolean {
  return [...source.matchAll(globalMatcher(affirmativeNegationIdiom))]
    .some((match) => start >= match.index! && start < match.index! + match[0].length);
}

function cancelledIntentStart(source: string, start: number): number | undefined {
  const prefix = source.slice(0, start);
  const immediate = /(?:\b(?:abandon(?:ed|s|ing)?|drop(?:ped|s|ping)?|discard(?:ed|s|ing)?|cancel(?:led|ed|s|ling|ing)?|scrap(?:ped|s|ping)?|reject(?:ed|s|ing)?|shelv(?:e|es|ed|ing)|ignor(?:e|es|ed|ing)|gave\s+up\s+on|give\s+up\s+on)\s+(?:the\s+)?|(?:放弃|取消|抛弃|搁置|否决|打消|撤销)(?:了)?[^，。！？；]{0,80}?(?:的)?\s*)$/iu.exec(prefix);
  return immediate ? immediate.index : undefined;
}

function isFulfilledIntent(source: string, start: number, end: number): boolean {
  const prefix = source.slice(Math.max(0, start - 64), start);
  const execution = /(?:\b(?:follow(?:ed|s|ing)?|execut(?:e|es|ed|ing)|complet(?:e|es|ed|ing)|implement(?:s|ed|ing)?|fulfill(?:s|ed|ing)?|carri(?:es|ed|ying)\s+out)\s+(?:the\s+)?|(?:按(?:照)?|执行|完成|落实|遵循|照着)(?:了)?\s*(?:既定|原定|该|这个)?\s*)$/iu.exec(prefix);
  if (!execution) return false;
  const governor = prefix.slice(0, execution.index);
  if (/(?:\b(?:refus(?:e|es|ed|ing)|declin(?:e|es|ed|ing)|fail(?:s|ed|ing)?|tr(?:y|ies|ied|ying)|attempt(?:s|ed|ing)?|hop(?:e|es|ed|ing)|wish(?:es|ed|ing)|discuss(?:es|ed|ing)?|consider(?:s|ed|ing)?|imagin(?:e|es|ed|ing))\b[^,.;!?，。！？；]{0,28}|(?:拒绝|未能|试图|尝试|希望|讨论|考虑|设想)[^，。！？；]{0,24})$/iu.test(governor)) return false;
  const suffix = source.slice(end, Math.min(source.length, end + 80));
  return !/^\s*(?:\b(?:not|never|merely\s+to\s+(?:try|attempt)|to\s+(?:try|attempt|fail))\b|(?:不|未|没有|只是试图|仅仅尝试|试图|尝试))/iu.test(suffix);
}

function isInsideQuotation(source: string, index: number): boolean {
  let straightDouble = false; let straightSingle = false; const stack: string[] = []; const closing: Record<string, string> = { "“": "”", "‘": "’", "「": "」", "『": "』" };
  for (let at = 0; at < Math.min(index, source.length); at += 1) {
    const char = source[at]!;
    if (char === '"') { straightDouble = !straightDouble; continue; }
    if (char === "'" && !(/[\p{L}\p{N}]/u.test(source[at - 1] ?? "") && /[\p{L}\p{N}]/u.test(source[at + 1] ?? ""))) { straightSingle = !straightSingle; continue; }
    if (closing[char]) { stack.push(closing[char]!); continue; }
    if (stack.at(-1) === char) stack.pop();
  }
  return straightDouble || straightSingle || stack.length > 0;
}

function isTerminatedReportMatch(id: GenericRuleAdapterId, source: string, start: number, end: number): boolean {
  if (id !== "event-simulation" && id !== "event-hearsay") return false;
  const matched = source.slice(start, end).normalize("NFKC").toLocaleLowerCase();
  const prefix = source.slice(Math.max(0, start - 48), start);
  const suffix = source.slice(end);
  const introducesContent = /^\s*(?:that|where|which|who|whose|in\s+which|of\s+how|about\s+how)\b/iu.test(suffix);
  const reportedClause = /^\s*(?:[:,]\s*["“「『]|(?:(?:the|a|an)\s+[^\s,.;!?]+|[A-Za-z][A-Za-z0-9_'’-]*|he|she|they|we|I|you|someone|somebody)\s+(?:(?!(?:and|or|but|then)\b)\w+\s+){0,2}(?:open(?:s|ed)?|win(?:s|ning)?|won|claim(?:s|ed)?|secur(?:e|es|ed)|activat(?:e|es|ed)|defeat(?:s|ed)?|work(?:s|ed)?|become|became|is|was)\b)/iu.test(suffix);
  if (!introducesContent && /(?:\b(?:dismiss(?:ed|es|ing)?|reject(?:ed|s|ing)?|debunk(?:ed|s|ing)?|ignor(?:ed|es|ing)?|woke\s+from|awoke\s+from)\s+(?:the\s+)?|(?:驳回|否定|无视|醒自|从.+醒来)\s*)$/iu.test(prefix)) return true;
  if (id === "event-hearsay" && /^hear/u.test(matched)) {
    if (/^\s+(?:that\b|about\b|from\b|a\s+rumou?r\b|the\s+rumou?r\b)/iu.test(suffix)) return false;
    const clausalSubject = /^\s+(?!(?:the|a|an)\b)(?:(?:[A-Z][A-Za-z0-9_'’-]*|he|she|they|we|I|you|someone|somebody)\s+|(?:his|her|their|our|my|your)\s+[^\s,.;!?]+\s+)(?:\w+\s+){0,2}(?:open(?:s|ed)?|win(?:s|ning)?|won|claim(?:s|ed)?|secur(?:e|es|ed)|activat(?:e|es|ed)|defeat(?:s|ed)?)\b/iu.test(suffix);
    return !clausalSubject;
  }
  if (id === "event-hearsay" && /^(?:claim|report|say|said|says|announce)/u.test(matched)) return !(introducesContent || reportedClause);
  return false;
}

function ignoredRuleMatch(id: GenericRuleAdapterId, source: string, start: number, end: number): boolean {
  if (id === "event-negated") return isNotOnlyMatch(source, start) || isInsideAffirmativeNegationIdiom(source, start);
  if (id === "event-intent") return isFulfilledIntent(source, start, end);
  if (isTerminatedReportMatch(id, source, start, end)) return true;
  return false;
}

function ruleMatches(id: GenericRuleAdapterId, source: string): Array<{ start: number; end: number }> {
  return [...source.matchAll(globalMatcher(genericAdapters[id]))]
    .filter((match) => !ignoredRuleMatch(id, source, match.index!, match.index! + match[0].length))
    .map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
}

function isNonRealizationAdapterId(id: GenericRuleAdapterId): id is NonRealizationAdapterId {
  return (nonRealizationAdapterIds as readonly GenericRuleAdapterId[]).includes(id);
}

function nonRealizationMatches(source: string, binding?: RealizationBinding): ModalityMatch[] {
  const matches = nonRealizationAdapterIds.flatMap((id) => {
    return ruleMatches(id, source).map((match) => ({ id, ...match, ...(id === "event-intent" ? { cancellationStart: cancelledIntentStart(source, match.start) } : {}) }));
  });
  if (binding) matches.push(...bindingAwareNegations(source, binding));
  return matches.filter((match, index, all) => all.findIndex((item) => item.id === match.id && item.start === match.start && item.end === match.end) === index).sort((left, right) => left.start - right.start || left.end - right.end);
}

export function isRuleAdapterId(id: string): id is GenericRuleAdapterId { return Object.hasOwn(genericAdapters, id); }

const eventCategories = new Set<ExperienceCategory>(["mechanic", "protagonist_action", "conflict_outcome", "world_reaction", "relationship"]);

/** Adapter/category compatibility is code-owned; model output cannot choose a harmless adapter. */
export function adapterAppliesTo(id: GenericRuleAdapterId, category: ExperienceCategory): boolean {
  if (id === "curated-mechanic-unavailable") return category === "mechanic";
  if (id === "curated-outcome-weakened") return category === "conflict_outcome";
  if (id === "helper-substitution") return category === "mechanic" || category === "protagonist_action" || category === "conflict_outcome";
  if (["event-negated", "event-intent", "event-failed-attempt", "event-simulation", "event-hearsay"].includes(id)) return eventCategories.has(category) || category === "pacing";
  if (id === "contains-pasted-label") return true;
  return eventCategories.has(category);
}

const reversalMarker = /(?:\b(?:but|instead|then|actually|in reality)\b|下一刻|随后|却|反而|而是|实际上|现实中|尘埃散去|紧接着)/i;
const realizedAfterReversal = /(?:\b(?:opened?|defeated?|won|succeeded?|activated?|responded?|confirmed?|acted?)\b|打开|开启|击败|获胜|制胜|成功|生效|反馈|奖励|弹出|记录|改变|确认|亲眼看见|毫发无损)/i;
function termStem(value: string): string {
  const normalized = value.normalize("NFKC").toLocaleLowerCase().trim();
  return /^[a-z]+$/u.test(normalized) ? normalized.replace(/(?:ing|ed|es|s)$/u, "") : normalized;
}

function termIndex(source: string, term: string): number {
  const expected = termStem(term); if (!expected) return -1;
  const normalized = source.normalize("NFKC").toLocaleLowerCase();
  if (!/^[a-z]+$/u.test(expected)) return normalized.indexOf(expected);
  const token = /[a-z]+/gu; for (const match of normalized.matchAll(token)) if (termStem(match[0]) === expected) return match.index!;
  return -1;
}

function termIndices(source: string, term: string): number[] {
  const expected = termStem(term); if (!expected) return [];
  const normalized = source.normalize("NFKC").toLocaleLowerCase();
  if (!/^[a-z]+$/u.test(expected)) { const indices: number[] = []; let from = 0; while (from <= normalized.length) { const index = normalized.indexOf(expected, from); if (index < 0) break; indices.push(index); from = index + Math.max(1, expected.length); } return indices; }
  const indices: number[] = []; const token = /[a-z]+/gu; for (const match of normalized.matchAll(token)) if (termStem(match[0]) === expected) indices.push(match.index!); return indices;
}

function bindingAwareNegations(source: string, binding: RealizationBinding): ModalityMatch[] {
  const scopedSlots: RealizationSlot[] = ["action", "object", "feedback", "outcome", "reaction", "reciprocalAction", "relationshipChange"];
  const terms = scopedSlots.flatMap((slot) => typeof binding[slot] === "string" && binding[slot]!.trim() ? [binding[slot]!.trim()] : []);
  const matches: ModalityMatch[] = [];
  for (const term of terms) {
    for (const termAt of termIndices(source, term)) {
      const start = Math.max(0, termAt - 64); const prefix = source.slice(start, termAt);
      const englishTerm = /^[a-z]+$/iu.test(termStem(term));
      const negation = englishTerm
        ? /(?:\b(?:without|unable\s+to|refus(?:e|es|ed|ing)\s+to)\s+|\bno\s+(?!(?:sooner|doubt|hesitation|difficulty|trouble|effort|delay)\b)(?:[a-z]+\s+){0,2})$/iu.exec(prefix)
        : /(?:(?:并非|并不是|绝非|不是|尚未|从未|未|不|没)(?:(?:再|曾|会|能|愿|肯|敢|想|要|准备|打算|取得|获得|赢得|赢下|实现|收获|真正|实际|成功|顺利|最终|确实|完全|直接)\s*){0,4}|(?:并)?没(?:能)?把[^，。！？；]{0,24})$/u.exec(prefix);
      if (negation) {
        const matchStart = start + negation.index;
        if (!isInsideAffirmativeNegationIdiom(source, matchStart)) matches.push({ id: "event-negated", start: matchStart, end: matchStart + negation[0].length });
      }
    }
  }
  return matches;
}

const irregularFinitePredicates = new Set("arose awoke became began bent bit blew broke brought built bought caught chose came dealt did drew drank drove ate fell fed felt fought found fled flew forgot forgave froze got gave went grew hung had heard held kept knew laid led left lent lay lost made meant met paid rode rang rose ran said saw sold sent shook shone shot showed sang sank sat slept slew spoke spent stood stole stuck struck swam took taught tore told thought threw understood woke wore won wrote".split(" "));
function hasFiniteAffirmativePredicate(source: string, start: number, termAt: number): boolean {
  const target = /^[a-z]+/iu.exec(source.slice(termAt))?.[0] ?? "";
  const segment = `${source.slice(start, termAt)}${target}`;
  const tokens = segment.toLocaleLowerCase().match(/[a-z]+/gu) ?? [];
  return tokens.some((token) => /(?:ed|es)$/u.test(token) || irregularFinitePredicates.has(token) || ["wins", "works", "opens", "acts", "claims", "secures", "responds", "confirms", "activates", "becomes"].includes(token));
}

function chineseNegationAllowsCoordinationBreak(source: string, modality: ModalityMatch): boolean {
  if (modality.id !== "event-negated") return false;
  return source.slice(modality.start).startsWith("没有");
}

function reportScopeTerminated(source: string, modality: ModalityMatch, termAt: number): boolean {
  if (modality.id !== "event-simulation" && modality.id !== "event-hearsay") return false;
  const span = source.slice(modality.start, termAt);
  const termination = /(?:\b(?:dream|simulation)\s+(?:ended|stopped|collapsed|broke|dissolved|faded)\b|\b(?:woke|awoke)\s+from\s+(?:the\s+)?(?:dream|simulation)\b|\b(?:dismissed|rejected|debunked|ignored)\s+(?:the\s+)?(?:rumou?r|prediction|hearsay)\b|(?:梦境|模拟)(?:结束|终止|破碎|消散|散去|退去)|(?:醒来|苏醒)|(?:驳回|否定|无视)(?:传闻|预测|预言)|传闻不攻自破)/giu;
  return [...span.matchAll(termination)].some((match) => !isInsideQuotation(source, modality.start + match.index!));
}

function modalityGovernsTerm(source: string, modality: ModalityMatch, termAt: number, actor: string): boolean {
  if (modality.start > termAt) {
    if (modality.cancellationStart !== undefined && termAt >= modality.cancellationStart) return true;
    if (modality.id !== "event-negated") return false;
    const between = source.slice(termAt, modality.start); const after = source.slice(modality.end, Math.min(source.length, modality.end + 40));
    return !/[,，.!?;。！？；]|\b(?:and|or|but|then|while|whereas|after|before)\b/u.test(between) && /^(?:\s+(?:did|does|do|has|have|had|was|were|is|are|would|could|should|will|can|may|might|shall))?\s*$/iu.test(between.replace(/^[\p{L}\p{N}_'’-]+/u, "")) && /^(?:\s+(?:come|came|arrive(?:s|d)?|occur(?:s|red)?|happen(?:s|ed)?|materializ(?:e|es|ed)|follow(?:s|ed)?|be|become|achiev(?:e|es|ed)|secur(?:e|es|ed)|won|win))\b/iu.test(after);
  }
  const between = source.slice(modality.end, termAt);
  if (modality.id === "event-negated" && /^(?:not|(?:don|doesn|didn)[’']t)\s+(?:hesitate|flinch|pause|waver|wait)\s+to\b/iu.test(source.slice(modality.start, termAt))) return false;
  if (modality.id === "event-simulation" || modality.id === "event-hearsay") {
    if (reportScopeTerminated(source, modality, termAt)) return false;
  } else {
    const cancelledReference = modality.cancellationStart !== undefined && /\b(?:in|within)\s+(?:it|which)\b|(?:其中|计划中)/iu.test(between);
    if (/[,，.!?;。！？；]/u.test(between) && !cancelledReference) return false;
  }
  for (const boundary of source.matchAll(propositionBoundary)) {
    if (boundary.index! < modality.end) continue;
    if (boundary.index! >= termAt) break;
    const normalized = boundary[0].normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ");
    if (modality.id === "event-simulation" || modality.id === "event-hearsay") continue;
    if (realityBoundaries.has(normalized) || localReversalBoundaries.has(normalized)) return false;
    const afterBoundary = boundary.index! + boundary[0].length;
    const englishTarget = /^[a-z]/iu.test(source.slice(termAt));
    if (modality.cancellationStart !== undefined) {
      const continuation = source.slice(afterBoundary, termAt);
      if (/\b(?:in|within)\s+it\b|(?:其中|计划中)/iu.test(continuation)) continue;
      const complementBeforeBoundary = source.slice(modality.end, boundary.index!).trim();
      if (["and", "并", "并且", "也"].includes(normalized) && (!complementBeforeBoundary || englishTarget && hasFiniteAffirmativePredicate(source, afterBoundary, termAt))) return false;
    }
    const actorRepeated = !!actor && termIndices(source.slice(afterBoundary, termAt), actor).length > 0;
    if (actorRepeated) return false;
    if (chineseNegationAllowsCoordinationBreak(source, modality)) return false;
    if (modality.id !== "event-intent" && englishTarget && hasFiniteAffirmativePredicate(source, afterBoundary, termAt)) return false;
  }
  return true;
}

function isUnmodalizedTerm(source: string, termAt: number, actor: string, modalities: ReadonlyArray<ModalityMatch>): boolean {
  return !modalities.some((modality) => modalityGovernsTerm(source, modality, termAt, actor));
}

function hasUnmodalizedPattern(source: string, pattern: RegExp): boolean {
  const modalities = nonRealizationMatches(source);
  return [...source.matchAll(globalMatcher(pattern))]
    .some((match) => isUnmodalizedTerm(source, match.index!, "", modalities));
}

function subjectDecision(prefix: string, actor: string, nearest = false): boolean | undefined {
  const value = prefix.normalize("NFKC").trim().replace(/^[\s,，:：-]+|[\s,，:：-]+$/gu, "");
  if (!value) return undefined;
  if (/^[\x00-\x7f]+$/u.test(value)) {
    const words = [...value.matchAll(/[A-Za-z][A-Za-z'’-]*/gu)];
    const actorFirst = actor.normalize("NFKC").match(/[A-Za-z]+/u)?.[0]?.toLocaleLowerCase();
    const nonSubjects = new Set(["with", "without", "by", "through", "using", "after", "before", "in", "on", "at", "under", "over", "near", "beside", "behind", "for", "from", "to", "of", "and", "or", "but", "then", "instead", "actually", "again", "already", "also", "almost", "directly", "easily", "finally", "immediately", "instantly", "just", "merely", "now", "once", "personally", "quickly", "quietly", "simply", "slowly", "still", "suddenly", "together", "did", "does", "do", "had", "has", "have", "was", "were", "is", "are", "not", "never", "only", "hesitate", "flinch", "pause", "waver", "wait", "watch", "retreat", "open", "win", "claim", "secure", "activate", "defeat", "stand", "arrive", "choose", "lower", "bow", "plan", "intend", "try", "attempt", "fail", "hope", "wish", "discuss", "consider", "imagine", "execute", "follow"]);
    const candidates = words.filter((match) => {
      const token = match[0].replace(/[’'].*/u, ""); const lower = token.toLocaleLowerCase();
      if (lower === actorFirst || /^[A-Z]/u.test(token) || ["he", "she", "they", "it", "we", "i", "you", "the", "a", "an", "this", "that", "her", "his", "their", "another", "someone", "somebody", "anyone", "anybody", "everyone", "everybody", "nobody"].includes(lower)) return true;
      return !nonSubjects.has(lower) && !/(?:ed|ing|es)$/u.test(lower) && !irregularFinitePredicates.has(lower);
    });
    const candidate = nearest ? candidates.at(-1) : candidates[0];
    if (!candidate) return undefined;
    const token = candidate[0].replace(/[’'].*/u, "").toLocaleLowerCase();
    if (token !== actorFirst) return false;
    const before = value.slice(0, candidate.index!).trimEnd(); const after = value.slice(candidate.index! + candidate[0].length);
    if (/[’']s$/iu.test(candidate[0]) || /^(?:[’']s)\b/iu.test(after) || /\b(?:beside|near|to|with|by|for|from|at|behind|before|after)\s*$/iu.test(before)) return false;
    return true;
  }
  const normalizedActor = actor.normalize("NFKC").trim(); const actorAt = value.indexOf(normalizedActor);
  const stripChineseModifiers = (input: string) => input.replace(/^(?:(?:又|便|就|才|仍|还|已|立刻|立即|马上|随即|径直|亲手|轻易|猛地|狠狠地|迅速|缓缓|果断地?|直接|从容|一剑|毫不迟疑地|反而|却|而是|终于|当即|旋即|悍然|悄然|骤然|轰然|稳稳地?|轻松地?|成功地?|用力|奋力|抬手|挥手|一把|没有|没能?|并未|未曾|不曾|不|未|以[^，。]{1,12}(?:之势|方式)))*\s*/u, "");
  if (actorAt >= 0) {
    const before = stripChineseModifiers(value.slice(0, actorAt)); const rawAfter = value.slice(actorAt + normalizedActor.length);
    if (rawAfter.startsWith("的")) return false;
    if (before) return false;
    const residueAfter = stripChineseModifiers(rawAfter);
    if (!residueAfter) return true;
    return !nearest && /^(?:放弃|取消|抛弃|搁置|否决|打消|撤销|计划|打算|准备|想要|希望|试图|试着|尝试|听说|声称|幻想|想象|假装|退后|后退|犹豫|等待|停下|打开|开启|击败|取得|获得|赢得|赢下|实现|收获|改变|回应|降低|放下|选择|确认|启动|生效|弹出|保持|完成|执行|行动|反击|制胜)/u.test(residueAfter);
  }
  const residue = stripChineseModifiers(value);
  if (/^(?:打开|开启|击败|取得|获得|赢得|赢下|实现|收获|改变|回应|降低|放下|选择|确认|启动|生效|弹出|保持|完成|执行|行动|反击|制胜)/u.test(residue)) return undefined;
  return residue ? false : undefined;
}

function actorBindsPredicate(source: string, predicateAt: number, actor: string, inheritedActor = false): boolean {
  const segments: string[] = []; let propositionStart = 0;
  for (const boundary of source.matchAll(propositionBoundary)) {
    if (boundary.index! >= predicateAt) break;
    segments.push(source.slice(propositionStart, boundary.index!));
    propositionStart = boundary.index! + boundary[0].length;
  }
  segments.push(source.slice(propositionStart, predicateAt));
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const decision = subjectDecision(segments[index]!, actor, index === segments.length - 1);
    if (decision !== undefined) return decision;
  }
  return inheritedActor;
}

function slotBelongsToPredicate(source: string, slotAt: number, predicateAt: number, subject: string, slot: RealizationSlot): boolean {
  if (slotAt === predicateAt) return true;
  const left = Math.min(slotAt, predicateAt); const right = Math.max(slotAt, predicateAt);
  const boundaries = [...source.matchAll(propositionBoundary)].filter((boundary) => boundary.index! > left && boundary.index! < right);
  if (slotAt < predicateAt) return boundaries.length === 0;
  if (slot === "object" && /\b(?:beside|near|after|before|behind|beyond|around|toward|towards|under|over|through)\b|(?:旁边|附近|之后|之前|身后|周围|朝向|越过)/iu.test(source.slice(predicateAt, slotAt))) return false;
  for (let index = 0; index < boundaries.length; index += 1) {
    const start = boundaries[index]!.index! + boundaries[index]![0].length;
    const end = boundaries[index + 1]?.index ?? slotAt;
    const decision = subjectDecision(source.slice(start, end), subject);
    if (decision === false) return false;
  }
  return true;
}

function assertedOutcome(source: string, outcomeAt: number): boolean {
  const prefix = source.slice(Math.max(0, outcomeAt - 48), outcomeAt);
  if (/(?:\b(?:hop(?:e|es|ed|ing)|aim(?:s|ed|ing)?|seek(?:s|ing)?|plan(?:s|ned|ning)?|wish(?:es|ed|ing)?|banner\s+reading|label(?:led)?|claim(?:s|ed|ing)?)\s+(?:for\s+)?|\b(?:in\s+pursuit\s+of|in\s+search\s+of|toward(?:s)?|chasing)\s+|(?:为了|希望|期待|争取|目标是|写着|标着|号称|追求|奔向))$/iu.test(prefix)) return false;
  return !/\b(?:not|never)\b.{0,32}\b(?:win|claim|secure|achieve)\w*\b.{0,16}\bfor\s*$/iu.test(prefix);
}

function clauseInheritsActor(tail: string, start: number, clause: string, actor: string): boolean {
  if (!start || !/^(?:(?:but|instead|then|actually|in\s+reality)\b|(?:反而|而是|却|随后|然后|接着|实际上|现实中|事实上))/iu.test(clause)) return false;
  const previousSentence = tail.slice(Math.max(0, Math.max(tail.lastIndexOf(".", start - 1), tail.lastIndexOf("。", start - 1), tail.lastIndexOf("!", start - 1), tail.lastIndexOf("！", start - 1), tail.lastIndexOf("?", start - 1), tail.lastIndexOf("？", start - 1), tail.lastIndexOf(";", start - 1), tail.lastIndexOf("；", start - 1)) + 1), start);
  return termIndices(previousSentence, actor).length > 0;
}

function boundRealizationInOneClause(tail: string, value: RealizationBinding): boolean {
  const predicate = value.action ?? value.reaction;
  if (!value.actor || !predicate) return false;
  const knownSlots = ["actor", "action", "object", "feedback", "outcome", "reaction", "reciprocalAction", "relationshipChange", "counterpart", "opponent"] as const;
  const requiredSlots = value.requiredSlots?.length ? [...new Set(value.requiredSlots)] : knownSlots.filter((slot) => typeof value[slot] === "string" && !!value[slot]?.trim());
  if (requiredSlots.some((slot) => typeof value[slot] !== "string" || !value[slot]?.trim())) return false;
  const modalities = nonRealizationMatches(tail, value);
  return realizationClauseRanges(tail).some(({ start, text: clause }) => {
    const inheritedActor = clauseInheritsActor(tail, start, clause, value.actor!);
    const predicateAt = termIndices(clause, predicate).find((index) => actorBindsPredicate(clause, index, value.actor!, inheritedActor) && isUnmodalizedTerm(tail, start + index, value.actor!, modalities));
    if (predicateAt === undefined || requiredSlots.some((slot) => slot === "actor" && inheritedActor ? false : termIndex(clause, value[slot]!) < 0)) return false;
    return requiredSlots.filter((slot) => realizationSlots.has(slot)).every((slot) => termIndices(clause, value[slot]!).some((index) => {
      if (!isUnmodalizedTerm(tail, start + index, value.actor!, modalities)) return false;
      if (slot === "outcome" && !assertedOutcome(clause, index)) return false;
      if (slot === "reciprocalAction") return typeof value.counterpart === "string" && actorBindsPredicate(clause, index, value.counterpart);
      const subjects = slot === "relationshipChange" || slot === "counterpart" ? [value.actor, value.counterpart] : [value.actor];
      return subjects.filter((subject): subject is string => typeof subject === "string" && !!subject.trim()).some((subject) => slotBelongsToPredicate(clause, index, predicateAt, subject, slot));
    }));
  });
}

function hasRealizedReversal(source: string, realization: readonly string[] | RealizationBinding = []): boolean {
  const marker = reversalMarker.exec(source);
  if (!marker) return false;
  const tail = source.slice(marker.index + marker[0].length);
  const binding: RealizationBinding = Array.isArray(realization) ? { actor: realization[0], action: realization[1], object: realization[2] } : realization as RealizationBinding;
  if (Object.values(binding).some((term) => typeof term === "string" && !!term.trim())) return boundRealizationInOneClause(tail, binding);
  return hasUnmodalizedPattern(tail, realizedAfterReversal);
}

export function runRuleAdapter(id: GenericRuleAdapterId, source: string, realization: readonly string[] | RealizationBinding = [], invariantContext?: NarrativeInvariantContext): boolean {
  const binding: RealizationBinding = Array.isArray(realization) ? { actor: realization[0], action: realization[1], object: realization[2] } : realization as RealizationBinding;
  if (id === "curated-mechanic-unavailable" || id === "curated-outcome-weakened") return violatesNarrativeInvariant(id, source, invariantContext);
  if (isNonRealizationAdapterId(id) && Object.values(binding).some((term) => typeof term === "string" && !!term.trim())) {
    return verifyNarrativeRealization({ source, binding }).status !== "realized";
  }
  const matches = ruleMatches(id, source);
  if (!matches.length) return false;
  // A rejected possibility followed by a directly narrated realization is not
  // evidence of non-realization.  The assessor still grounds the positive event.
  if (hasRealizedReversal(source, realization)) return false;
  return true;
}
