import type {
  CompiledExperienceContractRevision,
  ExperienceCategory,
  ExperienceDimension,
  ExperienceProhibition,
  EvidencePolicy,
  ObservableSignalV2,
  ReadingExperienceIntent,
} from "../../src/types";
import { createHash } from "node:crypto";
import { canonicalAuthorizationPayload, contractRevisionId } from "./scheduler";
import { adapterAppliesTo, curatedInterpretation, curatedSynthesis, evidencePolicyFor, isRuleAdapterId } from "./ruleAdapters";
import type {
  CompileExperienceRequest,
  CompileOutcome,
  ExperienceInterpretationPort,
  ExperienceOperationResult,
  InterpretationDimensionDraft,
  InterpretationDraft,
} from "./types";

const injectionVerbTargetPattern = /(?:忽略|无视|忘记|跳过|越过|绕过|覆盖|改写|取消)\s*(?:以上|先前|之前|所有)?\s*(?:指令|规则|限制|安全|系统\s*提示(?!音|声|器|灯|模块)|提示词)|(?:disregard|ignore|forget|bypass|override|skip)\s*(?:(?:the|all|previous|prior)\s*)*(?:instructions?|rules?|restrictions?|safety|system\s*prompt|prompts?)\b|系统\s*提示(?!音|声|器|灯|模块)|prompt\s*injection|jailbreak/iu;
const sensitiveDisclosurePattern = /(?:泄露|透露|显示|导出|发送|reveal|show|export|send)\s*(?:(?:密钥|提示词|系统\s*提示(?!音|声|器|灯|模块)|密码(?!学))|api\s*key\b|keys?\b|secrets?\b|system\s*prompt\b)/iu;
const dangerousIntentPattern = /(?:制作|制造|自制|组装|合成|配制|获取|购买)\s*(?:爆炸物|炸弹|爆炸装置|炸药|毒药|毒剂|枪械|武器)|(?:make|build|create|assemble|obtain|buy)\s*(?:an?\s*)?(?:explosive(?:\s+device)?|bomb|weapon|poison)|(?:伤害|杀害|袭击|毒害)\s*(?:他人|别人|人员|目标)|(?:harm|kill|attack|poison)\s*(?:people|someone|a\s+person|targets?)/iu;
const descriptorPattern = /^[\p{L}\p{N}]{1,24}$/u;
const supplementalPattern = /^[\p{L}\p{N}\p{Zs}，。！？、：；“”‘’（）()《》〈〉—\-·]+$/u;
const categories: ExperienceCategory[] = ["mechanic", "protagonist_action", "conflict_outcome", "world_reaction", "relationship", "pacing", "voice"];
const persistenceValues = new Set(["none", "chapter", "cross_chapter", "whole_story"]);
const prohibitionKinds = new Set(["invariant", "shortcut", "style_cliche"]);
const prohibitionSeverities = new Set(["block", "rewrite", "penalty"]);
const eventSlots = new Set(["actor", "action", "object", "outcome", "reaction"]);
const distributionMetricIds = new Set(["anchor_spread", "scene_coverage", "paragraph_consistency", "beat_density", "turn_position"]);
const requiredSlotsByCategory: Partial<Record<ExperienceCategory, string[]>> = {
  mechanic: ["actor", "action", "object", "outcome"],
  protagonist_action: ["actor", "action", "outcome"],
  conflict_outcome: ["actor", "action", "outcome"],
  world_reaction: ["actor", "reaction", "outcome"],
};

type RejectedOutcome = Extract<CompileOutcome, { status: "rejected" }>;
type NeedsResolutionOutcome = Extract<CompileOutcome, { status: "needs_resolution" }>;
type Provenance = CompiledExperienceContractRevision["provenance"];
type UnknownRecord = Record<string, unknown>;

type Preflight =
  | { ok: true; intent: ReadingExperienceIntent; context: CompileExperienceRequest["context"] }
  | { ok: false; outcome: RejectedOutcome };

type Validation =
  | { ok: true; dimensions: [InterpretationDimensionDraft, InterpretationDimensionDraft]; synthesis: InterpretationDraft["synthesis"] }
  | { ok: false; kind: "domain"; outcome: NeedsResolutionOutcome }
  | { ok: false; kind: "invalid_model_output" };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim();
}

function compactSafetyText(value: string): string {
  return normalizedText(value).replace(/[\p{Z}\s，,。.!！?？、:：;；“”"'‘’（）()《》〈〉—–\-·_]+/gu, "");
}

function isUnsafeIntentText(value: string): boolean {
  const normalized = normalizedText(value);
  const compact = compactSafetyText(normalized);
  return [normalized, compact].some((candidate) =>
    injectionVerbTargetPattern.test(candidate) || sensitiveDisclosurePattern.test(candidate) || dangerousIntentPattern.test(candidate),
  );
}

function unsafeOutcome(): RejectedOutcome {
  return { status: "rejected", code: "unsafe_intent", message: "这组词包含指令或越权要求，请只填写希望阅读时感受到的两个词。" };
}

function invalidOutcome(): RejectedOutcome {
  return { status: "rejected", code: "invalid_intent", message: "请填写格式正确的阅读体验词、说明、题材和灵感。" };
}

function normalizeSupplemental(value: unknown, maximumLength: number, allowEmpty = false): { ok: true; value: string } | { ok: false; outcome: RejectedOutcome } {
  if (typeof value !== "string") return { ok: false, outcome: invalidOutcome() };
  const normalized = normalizedText(value);
  if (isUnsafeIntentText(normalized)) return { ok: false, outcome: unsafeOutcome() };
  if ((!allowEmpty && !normalized) || normalized.length > maximumLength || (normalized && !supplementalPattern.test(normalized))) {
    return { ok: false, outcome: invalidOutcome() };
  }
  return { ok: true, value: normalized };
}

function preflightRequest(request: CompileExperienceRequest): Preflight {
  const intent = request?.intent;
  if (!isRecord(intent) || !Array.isArray(intent.descriptors) || intent.descriptors.length !== 2 || intent.locale !== "zh-CN") {
    return { ok: false, outcome: invalidOutcome() };
  }
  const descriptors = intent.descriptors.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.text !== "string") return { ok: false as const, outcome: invalidOutcome() };
    const text = normalizedText(candidate.text);
    if (isUnsafeIntentText(text)) return { ok: false as const, outcome: unsafeOutcome() };
    if (!descriptorPattern.test(text)) return { ok: false as const, outcome: invalidOutcome() };
    if (candidate.clarification === undefined) return { ok: true as const, value: { text } };
    const clarification = normalizeSupplemental(candidate.clarification, 240, true);
    if (!clarification.ok) return clarification;
    return { ok: true as const, value: clarification.value ? { text, clarification: clarification.value } : { text } };
  });
  if (!descriptors[0].ok) return { ok: false, outcome: descriptors[0].outcome };
  if (!descriptors[1].ok) return { ok: false, outcome: descriptors[1].outcome };
  if (!isRecord(request.context)) return { ok: false, outcome: invalidOutcome() };
  const genre = normalizeSupplemental(request.context.genre, 48);
  if (!genre.ok) return { ok: false, outcome: genre.outcome };
  const inspiration = normalizeSupplemental(request.context.inspiration, 600, true);
  if (!inspiration.ok) return { ok: false, outcome: inspiration.outcome };
  return {
    ok: true,
    intent: { descriptors: [descriptors[0].value, descriptors[1].value], locale: "zh-CN" },
    context: { genre: genre.value, inspiration: inspiration.value },
  };
}

function curatedDraft(intent: ReadingExperienceIntent): InterpretationDraft | undefined {
  const [left, right] = intent.descriptors.map((descriptor) => descriptor.text);
  const dimensions = [curatedInterpretation(left), curatedInterpretation(right)];
  const synthesis = curatedSynthesis(left, right);
  if (!dimensions[0] || !dimensions[1] || !synthesis) return undefined;
  return { dimensions: [dimensions[0], dimensions[1]], synthesis, provenanceVersion: "curated-v1" };
}

async function interpretationDraft(
  intent: ReadingExperienceIntent,
  context: CompileExperienceRequest["context"],
  port: ExperienceInterpretationPort,
  jobId: string,
): Promise<ExperienceOperationResult<{ draft: unknown; provenance: Provenance }>> {
  const local = curatedDraft(intent);
  if (local) {
    return {
      ok: true,
      value: {
        draft: local,
        provenance: intent.descriptors.map((descriptor) => ({ kind: "curated", descriptor: descriptor.text, version: local.provenanceVersion })),
      },
    };
  }
  try {
    const draft = await port.interpret({ intent, context });
    const version = isRecord(draft) && typeof draft.provenanceVersion === "string" ? normalizedText(draft.provenanceVersion) : "";
    return {
      ok: true,
      value: {
        draft,
        provenance: intent.descriptors.map((descriptor) => ({ kind: "model", descriptor: descriptor.text, version })),
      },
    };
  } catch {
    return { ok: false, error: { code: "model_unavailable", message: "无法理解这组体验词，请稍后重试。", stage: "interpretation", retryable: true, jobId } };
  }
}

function validVerification(value: unknown): value is EvidencePolicy {
  if (!isRecord(value) || typeof value.minimumAnchors !== "number" || !Number.isInteger(value.minimumAnchors) || value.minimumAnchors < 1 || value.minimumAnchors > 12) return false;
  if (value.kind === "event_slots") {
    return hasOnlyKeys(value, ["kind", "requiredSlots", "minimumAnchors"]) && Array.isArray(value.requiredSlots) && value.requiredSlots.length > 0 && value.requiredSlots.every((slot) => typeof slot === "string" && eventSlots.has(slot)) && new Set(value.requiredSlots).size === value.requiredSlots.length;
  }
  if (value.kind === "relationship_change") return hasOnlyKeys(value, ["kind", "requireReciprocalAction", "minimumAnchors"]) && value.requireReciprocalAction === true;
  if (value.kind === "distribution") {
    const regions = value.requiredRegions;
    const thresholds = value.metricThresholds;
    const metricIds = Array.isArray(value.metricIds) ? value.metricIds : [];
    return hasOnlyKeys(value, ["kind", "metricIds", "minimumAnchors", "requireSemanticJudge", "requiredRegions", "regionSemantics", "metricThresholds"]) && value.requireSemanticJudge === true && metricIds.length > 0 && metricIds.every((metric) => typeof metric === "string" && distributionMetricIds.has(metric)) && new Set(metricIds).size === metricIds.length && Array.isArray(regions) && regions.length > 0 && regions.every((region) => region === "opening" || region === "middle" || region === "ending") && new Set(regions).size === regions.length && (value.regionSemantics === "proportional" || value.regionSemantics === "paragraph") && isRecord(thresholds) && Object.keys(thresholds).length === metricIds.length && Object.entries(thresholds).every(([id, threshold]) => metricIds.includes(id) && typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0 && threshold <= 1);
  }
  return false;
}

function validSemanticSlots(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || Object.keys(value).some((key) => !eventSlots.has(key))) return false;
  return Object.values(value).every((slot) => typeof slot === "string" && normalizedText(slot).length > 0 && normalizedText(slot).length <= 80);
}

function validSignal(value: unknown): value is InterpretationDimensionDraft["observableSignals"][number] {
  if (!isRecord(value) || typeof value.description !== "string" || normalizedText(value.description).length < 6 || normalizedText(value.description).length > 300) return false;
  if (!hasOnlyKeys(value, ["description", "kind", "semanticSlots", "verification", "persistence"]) || typeof value.kind !== "string" || !categories.includes(value.kind as ExperienceCategory) || !validVerification(value.verification) || typeof value.persistence !== "string" || !persistenceValues.has(value.persistence) || !validSemanticSlots(value.semanticSlots)) return false;
  const kind = value.kind as ExperienceCategory; const verification = value.verification as EvidencePolicy;
  const canonicalPolicy = normalizedPolicy(evidencePolicyFor(kind));
  if (canonicalAuthorizationPayload(normalizedPolicy(verification)) !== canonicalAuthorizationPayload(canonicalPolicy)) return false;
  if (verification.kind !== "event_slots") return true;
  const required = requiredSlotsByCategory[kind];
  return !!required && [...verification.requiredSlots].sort().join("|") === [...required].sort().join("|");
}

function validProhibition(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["kind", "description", "severity", "ruleAdapterId"]) && typeof value.description === "string" && normalizedText(value.description).length >= 4 && normalizedText(value.description).length <= 300 && typeof value.kind === "string" && prohibitionKinds.has(value.kind) && typeof value.severity === "string" && prohibitionSeverities.has(value.severity) && (value.ruleAdapterId === undefined || typeof value.ruleAdapterId === "string" && isRuleAdapterId(value.ruleAdapterId));
}

function validStructuralDimension(value: unknown): value is InterpretationDimensionDraft {
  if (!isRecord(value) || typeof value.descriptor !== "string" || typeof value.interpretation !== "string" || !Array.isArray(value.categories) || !Array.isArray(value.observableSignals) || !Array.isArray(value.prohibitions) || typeof value.confidence !== "number") return false;
  if (!hasOnlyKeys(value, ["descriptor", "interpretation", "categories", "observableSignals", "prohibitions", "confidence"]) || value.categories.length < 1 || !value.categories.every((category) => typeof category === "string" && categories.includes(category as ExperienceCategory)) || new Set(value.categories).size !== value.categories.length || value.observableSignals.length < 2 || value.observableSignals.length > 6 || !value.observableSignals.every(validSignal) || value.prohibitions.length < 1 || !value.prohibitions.every(validProhibition)) return false;
  const dimensionCategories = value.categories as ExperienceCategory[];
  const observableSignals = value.observableSignals as InterpretationDimensionDraft["observableSignals"]; const prohibitions = value.prohibitions as InterpretationDimensionDraft["prohibitions"];
  return observableSignals.every((signal) => dimensionCategories.includes(signal.kind)) && dimensionCategories.every((category) => observableSignals.some((signal) => signal.kind === category)) && prohibitions.every((prohibition) => !prohibition.ruleAdapterId || dimensionCategories.some((category) => adapterAppliesTo(prohibition.ruleAdapterId!, category)));
}

function descriptorTainted(draft: InterpretationDraft, intent: ReadingExperienceIntent): boolean {
  const semanticValues: string[] = [draft.synthesis.sharedCause, ...draft.synthesis.dimensionRoles];
  for (const dimension of draft.dimensions) {
    semanticValues.push(dimension.interpretation, ...dimension.observableSignals.map((signal) => signal.description), ...dimension.prohibitions.map((prohibition) => prohibition.description));
    for (const signal of dimension.observableSignals) if (signal.semanticSlots) semanticValues.push(...Object.values(signal.semanticSlots).filter((value): value is string => typeof value === "string"));
  }
  const normalizedValues = semanticValues.map((value) => normalizedText(value).toLocaleLowerCase());
  return intent.descriptors.some((descriptor) => {
    const raw = normalizedText(descriptor.text).toLocaleLowerCase();
    const skeleton = raw.replace(/[\p{Cf}\p{Z}\p{P}\p{S}_]+/gu, "");
    return normalizedValues.some((value) => {
      const compact = value.replace(/[\p{Cf}\p{Z}\p{P}\p{S}_]+/gu, "");
      if (skeleton.length > 1) return compact.includes(skeleton);
      if (!skeleton) return false;
      if (compact === skeleton) return true;
      const labels = ["词语", "标签", "感觉", "维度", "描述词", "体验词", "word", "label", "feeling", "dimension"];
      for (let index = compact.indexOf(skeleton); index >= 0; index = compact.indexOf(skeleton, index + skeleton.length)) {
        const before = compact.slice(0, index); const after = compact.slice(index + skeleton.length);
        if (labels.some((label) => before.endsWith(label) || after.startsWith(label))) return true;
      }
      const visible = value.replace(/\p{Cf}+/gu, "");
      for (let index = visible.indexOf(raw); index >= 0; index = visible.indexOf(raw, index + raw.length)) {
        const before = index > 0 ? visible[index - 1] : ""; const after = visible[index + raw.length] ?? "";
        if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
      }
      return false;
    });
  });
}

function validateInterpretationDraft(draft: unknown, intent: ReadingExperienceIntent, adaptersAreCodeOwned: boolean): Validation {
  if (!isRecord(draft) || !hasOnlyKeys(draft, ["dimensions", "synthesis", "provenanceVersion"]) || !Array.isArray(draft.dimensions) || draft.dimensions.length !== 2 || !isRecord(draft.synthesis) || !hasOnlyKeys(draft.synthesis, ["sharedCause", "dimensionRoles"]) || typeof draft.provenanceVersion !== "string" || !normalizedText(draft.provenanceVersion) || normalizedText(draft.provenanceVersion).length > 80) {
    return { ok: false, kind: "invalid_model_output" };
  }
  if (!validStructuralDimension(draft.dimensions[0]) || !validStructuralDimension(draft.dimensions[1])) return { ok: false, kind: "invalid_model_output" };
  const dimensions = draft.dimensions as [InterpretationDimensionDraft, InterpretationDimensionDraft];
  if (!adaptersAreCodeOwned && dimensions.some((dimension) => dimension.prohibitions.some((prohibition) => prohibition.ruleAdapterId !== undefined))) return { ok: false, kind: "invalid_model_output" };
  const expected = intent.descriptors.map((descriptor) => descriptor.text);
  if (dimensions.some((dimension, index) => normalizedText(dimension.descriptor) !== expected[index] || !Number.isFinite(dimension.confidence) || dimension.confidence < 0 || dimension.confidence > 1)) {
    return { ok: false, kind: "invalid_model_output" };
  }
  if (descriptorTainted(draft as unknown as InterpretationDraft, intent)) return { ok: false, kind: "invalid_model_output" };
  if (dimensions.some((dimension) => normalizedText(dimension.interpretation).length < 8 || normalizedText(dimension.interpretation).length > 500 || dimension.confidence < 0.65)) {
    return { ok: false, kind: "domain", outcome: { status: "needs_resolution", code: "unknown_intent", message: "这组词的含义还不够明确，无法编译为可验证的阅读体验，请换一组词或补充说明。" } };
  }
  const roles = draft.synthesis.dimensionRoles;
  if (!Array.isArray(roles) || roles.length !== 2 || roles.some((role) => typeof role !== "string")) return { ok: false, kind: "invalid_model_output" };
  if (typeof draft.synthesis.sharedCause !== "string" || normalizedText(draft.synthesis.sharedCause).length < 8 || normalizedText(draft.synthesis.sharedCause).length > 500 || roles.some((role) => normalizedText(role).length < 3 || normalizedText(role).length > 240)) {
    return { ok: false, kind: "domain", outcome: { status: "needs_resolution", code: "irreconcilable_intent", message: "这两个体验词暂时无法在同一条故事因果中可靠成立，请换一组词。" } };
  }
  return { ok: true, dimensions, synthesis: { sharedCause: draft.synthesis.sharedCause, dimensionRoles: [roles[0], roles[1]] } };
}

function alternativeCategory(category: ExperienceCategory): ExperienceCategory {
  const alternatives: Record<ExperienceCategory, ExperienceCategory> = { mechanic: "world_reaction", protagonist_action: "conflict_outcome", conflict_outcome: "world_reaction", world_reaction: "protagonist_action", relationship: "protagonist_action", pacing: "voice", voice: "pacing" };
  return alternatives[category];
}

function cloneEvidencePolicy(policy: EvidencePolicy): EvidencePolicy {
  if (policy.kind === "event_slots") return { ...policy, requiredSlots: [...policy.requiredSlots] };
  if (policy.kind === "distribution") return { ...policy, metricIds: [...policy.metricIds], requiredRegions: [...policy.requiredRegions], metricThresholds: { ...policy.metricThresholds } };
  return { ...policy };
}

function cloneSemanticSlots(slots: InterpretationDimensionDraft["observableSignals"][number]["semanticSlots"]): InterpretationDimensionDraft["observableSignals"][number]["semanticSlots"] {
  return slots ? { ...slots } : undefined;
}

function shiftedAnchorCount(value: number): number {
  return value >= 12 ? value - 1 : value + 1;
}

function complementaryEvidencePolicy(_primary: EvidencePolicy, fallbackCategory: ExperienceCategory): EvidencePolicy {
  const policy = cloneEvidencePolicy(evidencePolicyFor(fallbackCategory));
  return { ...policy, minimumAnchors: shiftedAnchorCount(policy.minimumAnchors) };
}

function normalizedPolicy(policy: EvidencePolicy): EvidencePolicy {
  if (policy.kind === "event_slots") return { ...policy, requiredSlots: [...policy.requiredSlots].sort() as typeof policy.requiredSlots };
  if (policy.kind === "distribution") return { ...policy, metricIds: [...policy.metricIds].sort(), requiredRegions: [...policy.requiredRegions].sort() as typeof policy.requiredRegions, metricThresholds: Object.fromEntries(Object.entries(policy.metricThresholds).sort(([left], [right]) => left.localeCompare(right))) };
  return { ...policy };
}

function semanticSort<T>(values: T[]): T[] {
  return [...values].sort((left, right) => canonicalAuthorizationPayload(left).localeCompare(canonicalAuthorizationPayload(right)));
}

function splitAndNormalizeDimensions(
  drafts: [InterpretationDimensionDraft, InterpretationDimensionDraft],
  intent: ReadingExperienceIntent,
): [ExperienceDimension, ExperienceDimension] {
  const duplicate = intent.descriptors[0].text === intent.descriptors[1].text;
  const primaryPolicy = cloneEvidencePolicy(drafts[0].observableSignals[0].verification);
  return drafts.map((draft, index) => {
    const splitCategory = alternativeCategory(draft.categories[0]);
    const secondaryRepeatedDimension = duplicate && index === 1;
    const secondaryPolicy = complementaryEvidencePolicy(primaryPolicy, splitCategory);
    const signalBodies = semanticSort(secondaryRepeatedDimension
      ? [
        { kind: splitCategory, description: "当前行动造成的持续状态变化必须绑定具体人物、对象和结果。", verification: normalizedPolicy(secondaryPolicy), persistence: "cross_chapter" as const },
        { kind: splitCategory, description: "后续事件必须显示该状态如何改变人物选择、环境反应或冲突走向。", verification: normalizedPolicy(secondaryPolicy), persistence: "cross_chapter" as const },
      ]
      : draft.observableSignals.map((signal) => ({
        kind: signal.kind,
        description: normalizedText(signal.description),
        ...(signal.semanticSlots ? { semanticSlots: cloneSemanticSlots(signal.semanticSlots) } : {}),
        verification: normalizedPolicy(signal.verification),
        persistence: signal.persistence,
      })));
    const prohibitionBodies = draft.prohibitions.map((prohibition) => ({
      kind: prohibition.kind,
      description: normalizedText(prohibition.description),
      severity: prohibition.severity,
      ...(prohibition.ruleAdapterId ? { ruleAdapterId: prohibition.ruleAdapterId } : prohibition.kind === "shortcut" ? { ruleAdapterId: "contains-pasted-label" } : {}),
    }));
    if (secondaryRepeatedDimension) {
      prohibitionBodies.push({ kind: "shortcut", description: "不得把第一维已经采用的泛化叙述重复计为持续后果证据。", severity: "rewrite", ruleAdapterId: "contains-pasted-label" });
    }
    const interpretation = secondaryRepeatedDimension
      ? `${normalizedText(draft.interpretation)} 本维度专门验证行动留下的持续后果和次级变化，不重复计数当下的关系行动。`
      : duplicate
        ? `${normalizedText(draft.interpretation)} 本维度聚焦当前事件中人物之间立即发生的具体行动与回应。`
        : normalizedText(draft.interpretation);
    const dimensionBody = { index, interpretation, categories: (secondaryRepeatedDimension ? [splitCategory] : [...draft.categories]).sort(), observableSignals: signalBodies, prohibitions: semanticSort(prohibitionBodies) };
    const dimensionId = `dimension_${index + 1}_${stableToken(dimensionBody)}`;
    const signals: ObservableSignalV2[] = signalBodies.map((signal, signalIndex) => ({ id: `${dimensionId}_signal_${signalIndex + 1}`, dimensionId, ...signal }));
    const prohibitions: ExperienceProhibition[] = semanticSort(prohibitionBodies).map((prohibition, prohibitionIndex) => ({ id: `${dimensionId}_prohibition_${prohibitionIndex + 1}`, dimensionId, ...prohibition }));
    return {
      id: dimensionId,
      descriptor: intent.descriptors[index].text,
      interpretation,
      categories: (secondaryRepeatedDimension ? [splitCategory] : [...draft.categories]).sort() as ExperienceCategory[],
      observableSignals: signals,
      prohibitions,
      confidence: draft.confidence,
    };
  }) as [ExperienceDimension, ExperienceDimension];
}

function dimensionFingerprint(dimension: ExperienceDimension): string {
  return JSON.stringify({ interpretation: normalizedText(dimension.interpretation), categories: dimension.categories, signals: dimension.observableSignals.map((signal) => ({ description: normalizedText(signal.description), verification: signal.verification, persistence: signal.persistence })) });
}

function solveSynthesis(
  dimensions: [ExperienceDimension, ExperienceDimension],
  synthesis: InterpretationDraft["synthesis"],
): { ok: true; value: InterpretationDraft["synthesis"] } | { ok: false; message: string } {
  if (!normalizedText(synthesis.sharedCause) || dimensionFingerprint(dimensions[0]) === dimensionFingerprint(dimensions[1])) {
    return { ok: false, message: "两个体验维度没有形成独立且共同的因果要求。" };
  }
  if (dimensions[0].descriptor === dimensions[1].descriptor) {
    return {
      ok: true,
      value: {
        sharedCause: synthesis.sharedCause,
        dimensionRoles: ["在当前事件中以具体行动和回应兑现该体验", "让同一行动留下可验证的持续后果并影响后续选择"],
      },
    };
  }
  if (normalizedText(synthesis.dimensionRoles[0]) === normalizedText(synthesis.dimensionRoles[1])) {
    return { ok: false, message: "两个体验维度没有分配独立的故事职责。" };
  }
  return { ok: true, value: synthesis };
}

function stableToken(value: unknown): string {
  return createHash("sha256").update(canonicalAuthorizationPayload(value)).digest("base64url").slice(0, 22);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function freezeContractRevision(
  request: CompileExperienceRequest,
  intent: ReadingExperienceIntent,
  dimensions: [ExperienceDimension, ExperienceDimension],
  synthesis: InterpretationDraft["synthesis"],
  provenance: Provenance,
  createdAt: Date,
): CompiledExperienceContractRevision {
  const promises = dimensions.map((dimension) => ({
    id: `${dimension.id}_presence`,
    dimensionId: dimension.id,
    scope: { kind: "every_chapter" as const },
    hardness: "hard" as const,
    minimumSignals: 1,
    carryRuleIds: dimension.observableSignals.filter((signal) => signal.persistence === "cross_chapter" || signal.persistence === "whole_story").map((signal) => signal.id),
  }));
  const body: Omit<CompiledExperienceContractRevision, "id"> = {
    schemaVersion: 2,
    revision: request.requestedRevision,
    parentRevisionId: request.parentRevisionId,
    intent,
    dimensions,
    synthesis,
    promises,
    prohibitions: dimensions.flatMap((dimension) => dimension.prohibitions),
    ruleGraphVersion: "reading-experience-v2-rules-1",
    provenance,
    createdAt: createdAt.toISOString(),
  };
  return deepFreeze({ id: contractRevisionId(body), ...body });
}

export async function compileExperience(request: CompileExperienceRequest, port: ExperienceInterpretationPort, now: () => Date): Promise<ExperienceOperationResult<CompileOutcome>> {
  const preflight = preflightRequest(request);
  if (!preflight.ok) return { ok: true, value: preflight.outcome };
  const draft = await interpretationDraft(preflight.intent, preflight.context, port, request.jobId);
  if (!draft.ok) return draft;
  const validation = validateInterpretationDraft(draft.value.draft, preflight.intent, draft.value.provenance.every((item) => item.kind === "curated"));
  if (!validation.ok) {
    if (validation.kind === "invalid_model_output") {
      return { ok: false, error: { code: "invalid_model_output", message: "体验词解释结果格式不正确，请稍后重试。", stage: "interpretation", retryable: false, jobId: request.jobId } };
    }
    return { ok: true, value: validation.outcome };
  }
  const dimensions = splitAndNormalizeDimensions(validation.dimensions, preflight.intent);
  const synthesis = solveSynthesis(dimensions, validation.synthesis);
  if (!synthesis.ok) return { ok: true, value: { status: "needs_resolution", code: "irreconcilable_intent", message: synthesis.message } };
  const provenance = draft.value.provenance.map((item, index) => item.kind === "model" ? {
    ...item,
    interpretationDigest: `interpretation_${stableToken({ dimension: dimensions[index], dimensionRole: synthesis.value.dimensionRoles[index], sharedCause: synthesis.value.sharedCause })}`,
  } : item);
  return { ok: true, value: { status: "ready", revision: freezeContractRevision(request, preflight.intent, dimensions, synthesis.value, provenance, now()) } };
}
