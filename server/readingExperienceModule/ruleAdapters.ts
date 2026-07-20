import type { ExperienceCategory, EvidencePolicy } from "../../src/types";
import type { InterpretationDimensionDraft } from "./types";
import type { GenericRuleAdapterId } from "./types";

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
  "event-negated": /\b(?:not|never|cannot|didn't)\b|(?:没有|未能|并未|未曾|不曾)/i,
  "event-intent": /\b(?:plan(?:s|ned)?|intend(?:s|ed)?|prepar(?:e|es|ed|ing))\b|(?:计划|打算|准备|将要)/i,
  "event-failed-attempt": /\b(?:attempt(?:s|ed)?|tr(?:y|ies|ied)|fail(?:s|ed)?)\b|(?:试图|尝试|险些|差点|失败)/i,
  "event-simulation": /\b(?:dream|simulation|predict(?:s|ed|ion)?|conditional|would|might|imagin(?:e|es|ed|ation))\b|(?:梦境|做梦|模拟|预测|预言|如果|幻想|想象)/i,
  "event-hearsay": /\b(?:hearsay|rumou?r|heard)\b|(?:据说|传闻|听说)/i,
  "helper-substitution": /\bhelper\b|(?:他人代做|旁人替代)/i,
  "contains-pasted-label": /\b(?:label|descriptor)\b|(?:标签|描述词)/i,
  "curated-mechanic-unavailable": /(?:system|mechanic|panel|ability|系统|机制|面板|能力).{0,24}?(?:never\s+(?:available|works?)|unavailable|destroyed|cannot\s+(?:activate|use)|无法使用|无法启动|永远不可用|永久失效|被(?:彻底)?摧毁|只是比喻|没有反馈)/i,
  "curated-outcome-weakened": /(?:protagonist|主角|主人公).{0,24}?(?:rescued|draws?|defeated|los(?:e|es|t)|surrenders?|gives?\s+up|被救场|战平|惨败|失去优势|投降|放弃目标)/i,
};

const nonRealizationAdapterIds = ["event-negated", "event-intent", "event-failed-attempt", "event-simulation", "event-hearsay"] as const;

function realizationClauses(source: string): string[] {
  return source.split(/[,.!?;，。！？；]|\b(?:while|whereas)\b|(?:与此同时|同时|而后)/iu).map((clause) => clause.trim()).filter(Boolean);
}

function hasNonRealizationModality(source: string): boolean {
  return nonRealizationAdapterIds.some((id) => {
    const pattern = genericAdapters[id];
    const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    return [...source.matchAll(matcher)].some((match) => id !== "event-negated" || !/^not\s+only\b/iu.test(source.slice(match.index!)));
  });
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

export type RealizationSlot = "actor" | "action" | "object" | "feedback" | "outcome" | "reaction" | "reciprocalAction" | "relationshipChange" | "counterpart" | "opponent";

export interface RealizationBinding {
  actor?: string;
  action?: string;
  object?: string;
  feedback?: string;
  outcome?: string;
  reaction?: string;
  reciprocalAction?: string;
  relationshipChange?: string;
  counterpart?: string;
  opponent?: string;
  requiredSlots?: ReadonlyArray<RealizationSlot>;
}

function termIndex(source: string, term: string): number {
  const expected = termStem(term); if (!expected) return -1;
  const normalized = source.normalize("NFKC").toLocaleLowerCase();
  if (!/^[a-z]+$/u.test(expected)) return normalized.indexOf(expected);
  const token = /[a-z]+/gu; for (const match of normalized.matchAll(token)) if (termStem(match[0]) === expected) return match.index!;
  return -1;
}

function boundRealizationInOneClause(tail: string, value: RealizationBinding): boolean {
  const predicate = value.action ?? value.reaction;
  if (!value.actor || !predicate) return false;
  const knownSlots = ["actor", "action", "object", "feedback", "outcome", "reaction", "reciprocalAction", "relationshipChange", "counterpart", "opponent"] as const;
  const requiredSlots = value.requiredSlots?.length ? [...new Set(value.requiredSlots)] : knownSlots.filter((slot) => typeof value[slot] === "string" && !!value[slot]?.trim());
  if (requiredSlots.some((slot) => typeof value[slot] !== "string" || !value[slot]?.trim())) return false;
  return realizationClauses(tail).some((clause) => {
    if (hasNonRealizationModality(clause)) return false;
    const predicateAt = termIndex(clause, predicate); const actorAt = termIndex(clause, value.actor!);
    return predicateAt >= 0 && actorAt >= 0 && actorAt < predicateAt && requiredSlots.every((slot) => termIndex(clause, value[slot]!) >= 0);
  });
}

function hasRealizedReversal(id: GenericRuleAdapterId, source: string, realization: readonly string[] | RealizationBinding = []): boolean {
  const marker = reversalMarker.exec(source);
  if (!marker) return false;
  const tail = source.slice(marker.index + marker[0].length);
  const realizedClauses = realizationClauses(tail).filter((clause) => !hasNonRealizationModality(clause));
  if (id === "curated-mechanic-unavailable") return realizedClauses.some((clause) => /(?:system|mechanic|panel|ability|系统|机制|面板|能力).{0,24}(?:works?|available|activat(?:e|es|ed)|feedback|reward|可用|启动|开启|生效|反馈|奖励|弹出)/i.test(clause));
  if (id === "curated-outcome-weakened") return realizedClauses.some((clause) => /(?:protagonist|主角|主人公|\b(?:he|she|they)\b|他|她).{0,24}(?:wins?|defeats?|victory|unharmed|获胜|击败|制胜|胜利|毫发无损|保持优势)/i.test(clause));
  const binding: RealizationBinding = Array.isArray(realization) ? { actor: realization[0], action: realization[1], object: realization[2] } : realization as RealizationBinding;
  if (Object.values(binding).some((term) => typeof term === "string" && !!term.trim())) return boundRealizationInOneClause(tail, binding);
  return realizedClauses.some((clause) => realizedAfterReversal.test(clause));
}

export function runRuleAdapter(id: GenericRuleAdapterId, source: string, realization: readonly string[] | RealizationBinding = []): boolean {
  const pattern = genericAdapters[id];
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const matches = [...source.matchAll(matcher)].filter((match) => id !== "event-negated" || !/^not\s+only\b/iu.test(source.slice(match.index!)));
  if (!matches.length) return false;
  if (id === "curated-mechanic-unavailable" || id === "curated-outcome-weakened") {
    return matches.some((match, index) => {
      if (id === "curated-outcome-weakened" && !/(?:误以为|以为|看似|仿佛|似乎|seem(?:s|ed)?|appear(?:s|ed)?|thought|mistook|mistaken)/iu.test(source.slice(Math.max(0, match.index! - 32), match.index!))) return true;
      const next = matches[index + 1]?.index ?? source.length;
      return !hasRealizedReversal(id, source.slice(match.index!, next), realization);
    });
  }
  // A rejected possibility followed by a directly narrated realization is not
  // evidence of non-realization.  The assessor still grounds the positive event.
  if (hasRealizedReversal(id, source, realization)) return false;
  return true;
}
