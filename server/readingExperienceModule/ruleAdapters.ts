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

const eventVerification: EvidencePolicy = {
  kind: "event_slots",
  requiredSlots: ["actor", "action", "outcome"],
  minimumAnchors: 2,
};

const relationshipVerification: EvidencePolicy = {
  kind: "relationship_change",
  requireReciprocalAction: true,
  minimumAnchors: 2,
};

const distributionVerification: EvidencePolicy = {
  kind: "distribution",
  metricIds: ["anchor_spread", "scene_coverage"],
  minimumAnchors: 3,
  requireSemanticJudge: true,
  requiredRegions: ["opening", "middle", "ending"],
  regionSemantics: "paragraph",
  metricThresholds: { anchor_spread: 0.45, scene_coverage: 1 },
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
  if (category === "voice") return { kind: "distribution", metricIds: ["paragraph_consistency", "scene_coverage"], minimumAnchors: 3, requireSemanticJudge: true, requiredRegions: ["opening", "middle", "ending"], regionSemantics: "paragraph", metricThresholds: { paragraph_consistency: 0.35, scene_coverage: 1 } };
  if (category === "pacing") return { kind: "distribution", metricIds: ["beat_density", "turn_position"], minimumAnchors: 3, requireSemanticJudge: true, requiredRegions: ["middle", "ending"], regionSemantics: "paragraph", metricThresholds: { beat_density: 0.25, turn_position: 0.55 } };
  return cloneEvidencePolicy(eventVerification);
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
  "event-negated": /\b(?:not|never|cannot|didn't)\b|(?:没有|未能)/i,
  "event-intent": /\b(?:plan(?:s|ned)?|intend(?:s|ed)?)\b|(?:计划|打算)/i,
  "event-failed-attempt": /\b(?:attempt(?:s|ed)?|fail(?:s|ed)?)\b|(?:试图|失败)/i,
  "event-simulation": /\b(?:dream|simulation|prediction|conditional)\b|(?:梦境|模拟|预测|如果)/i,
  "event-hearsay": /\b(?:hearsay|rumou?r)\b|(?:据说|传闻)/i,
  "helper-substitution": /\bhelper\b|(?:他人代做|旁人替代)/i,
  "contains-pasted-label": /\b(?:label|descriptor)\b|(?:标签|描述词)/i,
  "curated-mechanic-unavailable": /(?:机制|面板|能力).{0,12}(?:无法使用|只是比喻|没有反馈)/i,
  "curated-outcome-weakened": /(?:主角|主人公).{0,12}(?:被救场|战平|惨败|失去优势)/i,
};

export function isRuleAdapterId(id: string): id is GenericRuleAdapterId { return Object.hasOwn(genericAdapters, id); }
export function runRuleAdapter(id: GenericRuleAdapterId, source: string): boolean {
  return genericAdapters[id].test(source);
}
