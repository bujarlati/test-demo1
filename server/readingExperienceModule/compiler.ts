import type {
  CompiledExperienceContractRevision,
  ExperienceCategory,
  ExperienceDimension,
  ExperienceProhibition,
  EvidencePolicy,
  ObservableSignalV2,
  ReadingExperienceIntent,
} from "../../src/types";
import { curatedInterpretation, curatedSynthesis, evidencePolicyFor } from "./ruleAdapters";
import type {
  CompileExperienceRequest,
  CompileOutcome,
  ExperienceInterpretationPort,
  ExperienceOperationResult,
  InterpretationDimensionDraft,
  InterpretationDraft,
} from "./types";

const unsafeIntentPattern = /忽略(?:以上|先前|所有)?指令|泄露(?:密钥|密码|提示)|系统提示|越过(?:限制|安全)|绕过(?:限制|安全)|制造炸弹|自制炸弹|伤害他人|ignore\s+(?:all|previous|instructions?)|reveal\s+(?:key|secret|prompt)|jailbreak|prompt\s*injection/iu;
const descriptorPattern = /^[\p{L}\p{N}]{1,24}$/u;
const supplementalPattern = /^[\p{L}\p{N}\p{Zs}，。！？、：；“”‘’（）()《》〈〉—\-·]+$/u;
const categories: ExperienceCategory[] = ["mechanic", "protagonist_action", "conflict_outcome", "world_reaction", "relationship", "pacing", "voice"];
const persistenceValues = new Set(["none", "chapter", "cross_chapter", "whole_story"]);
const prohibitionKinds = new Set(["invariant", "shortcut", "style_cliche"]);
const prohibitionSeverities = new Set(["block", "rewrite", "penalty"]);
const eventSlots = new Set(["actor", "action", "object", "outcome", "reaction"]);

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

function unsafeOutcome(): RejectedOutcome {
  return { status: "rejected", code: "unsafe_intent", message: "这组词包含指令或越权要求，请只填写希望阅读时感受到的两个词。" };
}

function invalidOutcome(): RejectedOutcome {
  return { status: "rejected", code: "invalid_intent", message: "请填写格式正确的阅读体验词、说明、题材和灵感。" };
}

function normalizeSupplemental(value: unknown, maximumLength: number, allowEmpty = false): { ok: true; value: string } | { ok: false; outcome: RejectedOutcome } {
  if (typeof value !== "string") return { ok: false, outcome: invalidOutcome() };
  const normalized = normalizedText(value);
  if (unsafeIntentPattern.test(normalized)) return { ok: false, outcome: unsafeOutcome() };
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
    if (unsafeIntentPattern.test(text)) return { ok: false as const, outcome: unsafeOutcome() };
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
    return hasOnlyKeys(value, ["kind", "metricIds", "minimumAnchors", "requireSemanticJudge"]) && value.requireSemanticJudge === true && Array.isArray(value.metricIds) && value.metricIds.length > 0 && value.metricIds.every((metric) => typeof metric === "string" && normalizedText(metric).length > 0) && new Set(value.metricIds).size === value.metricIds.length;
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
  return hasOnlyKeys(value, ["description", "kind", "semanticSlots", "verification", "persistence"]) && typeof value.kind === "string" && categories.includes(value.kind as ExperienceCategory) && validVerification(value.verification) && typeof value.persistence === "string" && persistenceValues.has(value.persistence) && validSemanticSlots(value.semanticSlots);
}

function validProhibition(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["kind", "description", "severity"]) && typeof value.description === "string" && normalizedText(value.description).length >= 4 && normalizedText(value.description).length <= 300 && typeof value.kind === "string" && prohibitionKinds.has(value.kind) && typeof value.severity === "string" && prohibitionSeverities.has(value.severity);
}

function validStructuralDimension(value: unknown): value is InterpretationDimensionDraft {
  if (!isRecord(value) || typeof value.descriptor !== "string" || typeof value.interpretation !== "string" || !Array.isArray(value.categories) || !Array.isArray(value.observableSignals) || !Array.isArray(value.prohibitions) || typeof value.confidence !== "number") return false;
  return hasOnlyKeys(value, ["descriptor", "interpretation", "categories", "observableSignals", "prohibitions", "confidence"]) && value.categories.length > 0 && value.categories.every((category) => typeof category === "string" && categories.includes(category as ExperienceCategory)) && value.observableSignals.length >= 2 && value.observableSignals.length <= 6 && value.observableSignals.every(validSignal) && value.prohibitions.length > 0 && value.prohibitions.every(validProhibition);
}

function validateInterpretationDraft(draft: unknown, intent: ReadingExperienceIntent): Validation {
  if (!isRecord(draft) || !hasOnlyKeys(draft, ["dimensions", "synthesis", "provenanceVersion"]) || !Array.isArray(draft.dimensions) || draft.dimensions.length !== 2 || !isRecord(draft.synthesis) || !hasOnlyKeys(draft.synthesis, ["sharedCause", "dimensionRoles"]) || typeof draft.provenanceVersion !== "string" || !normalizedText(draft.provenanceVersion) || normalizedText(draft.provenanceVersion).length > 80) {
    return { ok: false, kind: "invalid_model_output" };
  }
  if (!validStructuralDimension(draft.dimensions[0]) || !validStructuralDimension(draft.dimensions[1])) return { ok: false, kind: "invalid_model_output" };
  const dimensions = draft.dimensions as [InterpretationDimensionDraft, InterpretationDimensionDraft];
  const expected = intent.descriptors.map((descriptor) => descriptor.text);
  if (dimensions.some((dimension, index) => normalizedText(dimension.descriptor) !== expected[index] || !Number.isFinite(dimension.confidence) || dimension.confidence < 0 || dimension.confidence > 1)) {
    return { ok: false, kind: "invalid_model_output" };
  }
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
  return categories[(categories.indexOf(category) + 1) % categories.length];
}

function cloneEvidencePolicy(policy: EvidencePolicy): EvidencePolicy {
  if (policy.kind === "event_slots") return { ...policy, requiredSlots: [...policy.requiredSlots] };
  if (policy.kind === "distribution") return { ...policy, metricIds: [...policy.metricIds] };
  return { ...policy };
}

function cloneSemanticSlots(slots: InterpretationDimensionDraft["observableSignals"][number]["semanticSlots"]): InterpretationDimensionDraft["observableSignals"][number]["semanticSlots"] {
  return slots ? { ...slots } : undefined;
}

function shiftedAnchorCount(value: number): number {
  return value >= 12 ? value - 1 : value + 1;
}

function complementaryEvidencePolicy(primary: EvidencePolicy, fallbackCategory: ExperienceCategory): EvidencePolicy {
  if (primary.kind === "event_slots") {
    return {
      kind: "event_slots",
      requiredSlots: Array.from(new Set([...primary.requiredSlots, "reaction", "object"])),
      minimumAnchors: shiftedAnchorCount(primary.minimumAnchors),
    };
  }
  if (primary.kind === "distribution") {
    return {
      kind: "distribution",
      metricIds: Array.from(new Set([...primary.metricIds, "repeated_dimension_continuity"])),
      minimumAnchors: shiftedAnchorCount(primary.minimumAnchors),
      requireSemanticJudge: true,
    };
  }
  const policy = evidencePolicyFor(fallbackCategory);
  if (policy.kind === "distribution") {
    return { ...policy, metricIds: [...policy.metricIds, "repeated_dimension_continuity"], minimumAnchors: shiftedAnchorCount(policy.minimumAnchors) };
  }
  if (policy.kind === "event_slots") {
    return { ...policy, requiredSlots: Array.from(new Set([...policy.requiredSlots, "reaction"])), minimumAnchors: shiftedAnchorCount(policy.minimumAnchors) };
  }
  return { kind: "event_slots", requiredSlots: ["actor", "action", "outcome", "reaction"], minimumAnchors: 3 };
}

function splitAndNormalizeDimensions(
  drafts: [InterpretationDimensionDraft, InterpretationDimensionDraft],
  intent: ReadingExperienceIntent,
): [ExperienceDimension, ExperienceDimension] {
  const duplicate = intent.descriptors[0].text === intent.descriptors[1].text;
  const primaryPolicy = cloneEvidencePolicy(drafts[0].observableSignals[0].verification);
  return drafts.map((draft, index) => {
    const dimensionId = `dimension_${index + 1}_${stableToken(`${index}:${intent.descriptors[index].text}`)}`;
    const splitCategory = alternativeCategory(draft.categories[0]);
    const secondaryRepeatedDimension = duplicate && index === 1;
    const secondaryPolicy = complementaryEvidencePolicy(primaryPolicy, splitCategory);
    const signals: ObservableSignalV2[] = secondaryRepeatedDimension
      ? [
        { id: `${dimensionId}_signal_1`, dimensionId, kind: splitCategory, description: "当前行动造成的持续状态变化必须绑定具体人物、对象和结果。", verification: cloneEvidencePolicy(secondaryPolicy), persistence: "cross_chapter" },
        { id: `${dimensionId}_signal_2`, dimensionId, kind: splitCategory, description: "后续事件必须显示该状态如何改变人物选择、环境反应或冲突走向。", verification: cloneEvidencePolicy(secondaryPolicy), persistence: "cross_chapter" },
      ]
      : draft.observableSignals.map((signal, signalIndex) => ({
        id: `${dimensionId}_signal_${signalIndex + 1}`,
        dimensionId,
        kind: signal.kind,
        description: normalizedText(signal.description),
        ...(signal.semanticSlots ? { semanticSlots: cloneSemanticSlots(signal.semanticSlots) } : {}),
        verification: cloneEvidencePolicy(signal.verification),
        persistence: signal.persistence,
      }));
    const prohibitions: ExperienceProhibition[] = draft.prohibitions.map((prohibition, prohibitionIndex) => ({
      id: `${dimensionId}_prohibition_${prohibitionIndex + 1}`,
      dimensionId,
      kind: prohibition.kind,
      description: normalizedText(prohibition.description),
      severity: prohibition.severity,
    }));
    if (secondaryRepeatedDimension) {
      prohibitions.push({ id: `${dimensionId}_prohibition_independence`, dimensionId, kind: "shortcut", description: "不得把第一维已经采用的泛化叙述重复计为持续后果证据。", severity: "rewrite" });
    }
    return {
      id: dimensionId,
      descriptor: intent.descriptors[index].text,
      interpretation: secondaryRepeatedDimension
        ? `${normalizedText(draft.interpretation)} 本维度专门验证行动留下的持续后果和次级变化，不重复计数当下的关系行动。`
        : duplicate
          ? `${normalizedText(draft.interpretation)} 本维度聚焦当前事件中人物之间立即发生的具体行动与回应。`
          : normalizedText(draft.interpretation),
      categories: secondaryRepeatedDimension ? [splitCategory] : [...draft.categories],
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

function stableToken(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
  return deepFreeze({
    id: `experience_revision_${request.requestedRevision}_${stableToken(intent.descriptors.map((descriptor) => descriptor.text).join("\u001f"))}`,
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
  });
}

export async function compileExperience(request: CompileExperienceRequest, port: ExperienceInterpretationPort, now: () => Date): Promise<ExperienceOperationResult<CompileOutcome>> {
  const preflight = preflightRequest(request);
  if (!preflight.ok) return { ok: true, value: preflight.outcome };
  const draft = await interpretationDraft(preflight.intent, preflight.context, port, request.jobId);
  if (!draft.ok) return draft;
  const validation = validateInterpretationDraft(draft.value.draft, preflight.intent);
  if (!validation.ok) {
    if (validation.kind === "invalid_model_output") {
      return { ok: false, error: { code: "invalid_model_output", message: "体验词解释结果格式不正确，请稍后重试。", stage: "interpretation", retryable: false, jobId: request.jobId } };
    }
    return { ok: true, value: validation.outcome };
  }
  const dimensions = splitAndNormalizeDimensions(validation.dimensions, preflight.intent);
  const synthesis = solveSynthesis(dimensions, validation.synthesis);
  if (!synthesis.ok) return { ok: true, value: { status: "needs_resolution", code: "irreconcilable_intent", message: synthesis.message } };
  return { ok: true, value: { status: "ready", revision: freezeContractRevision(request, preflight.intent, dimensions, synthesis.value, draft.value.provenance, now()) } };
}
