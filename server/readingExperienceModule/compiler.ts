import type {
  CompiledExperienceContractRevision,
  ExperienceCategory,
  ExperienceDimension,
  ExperienceProhibition,
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
const categories: ExperienceCategory[] = ["mechanic", "protagonist_action", "conflict_outcome", "world_reaction", "relationship", "pacing", "voice"];

type Preflight =
  | { ok: true; intent: ReadingExperienceIntent }
  | { ok: false; outcome: Extract<CompileOutcome, { status: "rejected" }> };

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim();
}

function preflightIntent(intent: ReadingExperienceIntent): Preflight {
  if (!intent || !Array.isArray(intent.descriptors) || intent.descriptors.length !== 2 || intent.locale !== "zh-CN") {
    return { ok: false, outcome: { status: "rejected", code: "invalid_intent", message: "请填写两个简短的阅读体验词。" } };
  }
  const descriptors = intent.descriptors.map((descriptor) => ({
    text: typeof descriptor?.text === "string" ? normalizedText(descriptor.text) : "",
    ...(typeof descriptor?.clarification === "string" && normalizedText(descriptor.clarification)
      ? { clarification: normalizedText(descriptor.clarification) }
      : {}),
  }));
  if (descriptors.some((descriptor) => unsafeIntentPattern.test(descriptor.text))) {
    return { ok: false, outcome: { status: "rejected", code: "unsafe_intent", message: "这组词包含指令或越权要求，请只填写希望阅读时感受到的两个词。" } };
  }
  if (descriptors.some((descriptor) => !descriptorPattern.test(descriptor.text))) {
    return { ok: false, outcome: { status: "rejected", code: "invalid_intent", message: "请填写两个由字母或数字组成、长度不超过 24 个字符的体验词。" } };
  }
  return { ok: true, intent: { descriptors: [descriptors[0], descriptors[1]], locale: "zh-CN" } };
}

function curatedDraft(intent: ReadingExperienceIntent): InterpretationDraft | undefined {
  const [left, right] = intent.descriptors.map((descriptor) => descriptor.text);
  const dimensions = [curatedInterpretation(left), curatedInterpretation(right)];
  const synthesis = curatedSynthesis(left, right);
  if (!dimensions[0] || !dimensions[1] || !synthesis) return undefined;
  return {
    dimensions: [dimensions[0], dimensions[1]],
    synthesis,
    provenanceVersion: "curated-v1",
  };
}

async function interpretationDraft(
  intent: ReadingExperienceIntent,
  context: CompileExperienceRequest["context"],
  port: ExperienceInterpretationPort,
  jobId: string,
): Promise<ExperienceOperationResult<InterpretationDraft>> {
  const local = curatedDraft(intent);
  if (local) return { ok: true, value: local };
  try {
    return { ok: true, value: await port.interpret({ intent, context }) };
  } catch {
    return {
      ok: false,
      error: { code: "model_unavailable", message: "无法理解这组体验词，请稍后重试。", stage: "interpretation", retryable: true, jobId },
    };
  }
}

type Validation =
  | { ok: true; dimensions: [InterpretationDimensionDraft, InterpretationDimensionDraft]; synthesis: InterpretationDraft["synthesis"] }
  | { ok: false; outcome: Extract<CompileOutcome, { status: "needs_resolution" }> };

function validSignal(signal: InterpretationDimensionDraft["observableSignals"][number]): boolean {
  return Boolean(
    signal && typeof signal.description === "string" && normalizedText(signal.description).length >= 6 &&
    categories.includes(signal.kind) && signal.verification && signal.persistence,
  );
}

function validateInterpretationDraft(draft: InterpretationDraft, intent: ReadingExperienceIntent): Validation {
  if (!draft || !Array.isArray(draft.dimensions) || draft.dimensions.length !== 2) {
    return { ok: false, outcome: { status: "needs_resolution", code: "unknown_intent", message: "这组词暂时无法形成两个可验证的阅读体验维度，请换一组更明确的词。" } };
  }
  const expected = intent.descriptors.map((descriptor) => descriptor.text);
  const dimensions = draft.dimensions;
  const invalid = dimensions.some((dimension, index) =>
    !dimension || normalizedText(dimension.descriptor) !== expected[index] ||
    typeof dimension.interpretation !== "string" || normalizedText(dimension.interpretation).length < 8 ||
    !Array.isArray(dimension.categories) || dimension.categories.length === 0 || dimension.categories.some((category) => !categories.includes(category)) ||
    !Array.isArray(dimension.observableSignals) || dimension.observableSignals.length < 2 || dimension.observableSignals.some((signal) => !validSignal(signal)) ||
    !Array.isArray(dimension.prohibitions) || dimension.prohibitions.some((prohibition) => !normalizedText(prohibition.description) || !prohibition.kind || !prohibition.severity) ||
    typeof dimension.confidence !== "number" || dimension.confidence < 0.65 || dimension.confidence > 1,
  );
  if (invalid) {
    return { ok: false, outcome: { status: "needs_resolution", code: "unknown_intent", message: "这组词的含义还不够明确，无法编译为可验证的阅读体验，请换一组词或补充说明。" } };
  }
  if (!draft.synthesis || normalizedText(draft.synthesis.sharedCause).length < 8 || draft.synthesis.dimensionRoles.some((role) => normalizedText(role).length < 3)) {
    return { ok: false, outcome: { status: "needs_resolution", code: "irreconcilable_intent", message: "这两个体验词暂时无法在同一条故事因果中可靠成立，请换一组词。" } };
  }
  return { ok: true, dimensions, synthesis: draft.synthesis };
}

function alternativeCategory(category: ExperienceCategory): ExperienceCategory {
  return categories[(categories.indexOf(category) + 1) % categories.length];
}

function splitAndNormalizeDimensions(
  dimensions: [InterpretationDimensionDraft, InterpretationDimensionDraft],
  intent: ReadingExperienceIntent,
): [ExperienceDimension, ExperienceDimension] {
  const duplicate = intent.descriptors[0].text === intent.descriptors[1].text;
  return dimensions.map((draft, index) => {
    const dimensionId = `dimension_${index + 1}_${stableToken(intent.descriptors[index].text)}`;
    const splitCategory = duplicate && index === 1 ? alternativeCategory(draft.categories[0]) : draft.categories[0];
    const signals: ObservableSignalV2[] = draft.observableSignals.map((signal, signalIndex) => ({
      id: `${dimensionId}_signal_${signalIndex + 1}`,
      dimensionId,
      kind: duplicate && index === 1 && signalIndex === 0 ? splitCategory : signal.kind,
      description: normalizedText(signal.description),
      ...(signal.semanticSlots ? { semanticSlots: signal.semanticSlots } : {}),
      verification: duplicate && index === 1 && signalIndex === 0 ? evidencePolicyFor(splitCategory) : signal.verification,
      persistence: signal.persistence,
    }));
    const prohibitions: ExperienceProhibition[] = draft.prohibitions.map((prohibition, prohibitionIndex) => ({
      id: `${dimensionId}_prohibition_${prohibitionIndex + 1}`,
      dimensionId,
      kind: prohibition.kind,
      description: normalizedText(prohibition.description),
      severity: prohibition.severity,
    }));
    return {
      id: dimensionId,
      descriptor: intent.descriptors[index].text,
      interpretation: normalizedText(draft.interpretation),
      categories: duplicate && index === 1 ? [splitCategory, ...draft.categories.filter((category) => category !== splitCategory)] : [...draft.categories],
      observableSignals: signals,
      prohibitions,
      confidence: draft.confidence,
    };
  }) as [ExperienceDimension, ExperienceDimension];
}

function solveSynthesis(
  dimensions: [ExperienceDimension, ExperienceDimension],
  synthesis: InterpretationDraft["synthesis"],
): { ok: true; value: InterpretationDraft["synthesis"] } | { ok: false; message: string } {
  if (dimensions[0].id === dimensions[1].id || !normalizedText(synthesis.sharedCause)) {
    return { ok: false, message: "两个体验维度没有形成独立且共同的因果要求。" };
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

function freezeContractRevision(
  request: CompileExperienceRequest,
  intent: ReadingExperienceIntent,
  dimensions: [ExperienceDimension, ExperienceDimension],
  synthesis: InterpretationDraft["synthesis"],
  createdAt: Date,
): CompiledExperienceContractRevision {
  const promises = dimensions.map((dimension, index) => ({
    id: `${dimension.id}_presence`,
    dimensionId: dimension.id,
    scope: { kind: "every_chapter" as const },
    hardness: "hard" as const,
    minimumSignals: 1,
    carryRuleIds: dimension.observableSignals.filter((signal) => signal.persistence === "cross_chapter" || signal.persistence === "whole_story").map((signal) => signal.id),
    ...(index === 0 ? {} : {}),
  }));
  const provenance = intent.descriptors.map((descriptor) => ({
    kind: curatedInterpretation(descriptor.text) ? "curated" as const : "model" as const,
    descriptor: descriptor.text,
    version: curatedInterpretation(descriptor.text) ? "curated-v1" : "interpretation-v1",
  }));
  return {
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
  };
}

export async function compileExperience(request: CompileExperienceRequest, port: ExperienceInterpretationPort, now: () => Date): Promise<ExperienceOperationResult<CompileOutcome>> {
  const preflight = preflightIntent(request.intent);
  if (!preflight.ok) return { ok: true, value: preflight.outcome };
  const draft = await interpretationDraft(preflight.intent, request.context, port, request.jobId);
  if (!draft.ok) return draft;
  const validation = validateInterpretationDraft(draft.value, preflight.intent);
  if (!validation.ok) return { ok: true, value: validation.outcome };
  const dimensions = splitAndNormalizeDimensions(validation.dimensions, preflight.intent);
  const synthesis = solveSynthesis(dimensions, validation.synthesis);
  if (!synthesis.ok) return { ok: true, value: { status: "needs_resolution", code: "irreconcilable_intent", message: synthesis.message } };
  return { ok: true, value: { status: "ready", revision: freezeContractRevision(request, preflight.intent, dimensions, synthesis.value, now()) } };
}
