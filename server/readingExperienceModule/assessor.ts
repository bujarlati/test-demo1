import { createHmac, createHash } from "node:crypto";
import type { CanonFactCandidateV2, ExperienceEvidenceV2, ObservableSignalV2 } from "../../src/types";
import { bindPacingFacets, evidenceFromClaim, groundClaim, hashArtifact, sourceForArtifact, type EvidenceFinding, type GroundedClaim } from "./evidence";
import { assessmentContractIdentity, boundedAuthorizationSnapshot, canonicalAuthorizationPayload, repairContext, sameMac, signExperiencePlan, verifyExperienceStageTicket, verifyRepairAuthorization } from "./scheduler";
import type { AssessExperienceRequest, AssessmentContractProjection, AssessmentState, AssessorDependencies, ExperienceAssessment, ExperienceLedgerPatch, ExperienceOperationResult, ExperiencePublicationPermit, ExperienceRepairToken, ExperienceStagePlan, PublicationPermitContext, RepairTokenContext, SemanticBlueprintVerdict, SemanticEvidenceClaim } from "./types";
import { adapterAppliesTo, isRuleAdapterId, runRuleAdapter, type RealizationBinding, type RealizationSlot } from "./ruleAdapters";
import { verifyNarrativeRealization, violatesNarrativeInvariant, type SourceSpan } from "./narrativeSemantics/index";
import type { GenericRuleAdapterId } from "./types";
import { canonFactCandidateId, cleanAuthorizationValue, evidenceRootHash, issuePublicationPermit, ledgerPatchHash, publicationPermitContext, publicationPermitDigest, sortedEvidenceBindings, verifiedPublicationPermitSnapshot } from "./publication";
import { canonicalRoleKey, validTrustedRoleBindings } from "./roles";
import { pacingFacetIsRealized } from "./pacingSemantics";

export { verifyPublicationPermit } from "./publication";

const repairDomain = "reading-experience:repair:v1";
const invalidModel = (jobId: string): ExperienceOperationResult<never> => ({ ok: false, error: { code: "invalid_model_output", message: "Semantic judge returned an invalid verdict.", stage: "assessment", retryable: false, jobId } });
const unavailable = (jobId: string): ExperienceOperationResult<never> => ({ ok: false, error: { code: "model_unavailable", message: "Semantic judge is unavailable.", stage: "assessment", retryable: true, jobId } });
interface ValueBudget { maxDepth: number; maxNodes: number; maxArrayLength: number; maxObjectProperties: number; maxStringLength: number; maxTotalStringCharacters: number }
const ASSESSMENT_REQUEST_BUDGET: ValueBudget = Object.freeze({ maxDepth: 32, maxNodes: 100_000, maxArrayLength: 20_000, maxObjectProperties: 20_000, maxStringLength: 1_000_000, maxTotalStringCharacters: 2_000_000 });
const JUDGE_RESULT_BUDGET: ValueBudget = Object.freeze({ maxDepth: 16, maxNodes: 20_000, maxArrayLength: 4_096, maxObjectProperties: 64, maxStringLength: 262_144, maxTotalStringCharacters: 1_000_000 });
const MAX_SEMANTIC_CLAIMS = 64;
const MAX_EVIDENCE_ANCHORS_PER_CLAIM = 64;
const MAX_SHARED_CAUSE_ANCHORS = 64;
const MAX_SHARED_CAUSE_LINKS = 128;
const MAX_JUDGE_ID_LENGTH = 256;
const MAX_EVIDENCE_QUOTE_LENGTH = 65_536;
const MAX_SLOT_VALUE_LENGTH = 512;
const MAX_METRIC_KEYS = 32;
const MAX_BLUEPRINT_CHAPTERS = 2_048;
const MAX_BLUEPRINT_TITLE_LENGTH = 1_024;
const MAX_BLUEPRINT_NARRATIVE_FIELD_LENGTH = 32_768;
const MAX_BLUEPRINT_ID_LENGTH = 256;
const MAX_BLUEPRINT_IDS_PER_CHAPTER = 256;
const MAX_BLUEPRINT_POINTER_LENGTH = 512;
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) freeze(child); Object.freeze(value); } return value; };
const snapshot = <T>(value: T): T | undefined => { try { return freeze(structuredClone(value)); } catch { return undefined; } };
const sign = (domain: string, payload: unknown, secret: string): string => createHmac("sha256", secret).update(domain).update("\u001f").update(canonicalAuthorizationPayload(payload)).digest("base64url");
const artifactHashSafe = (request: AssessExperienceRequest): string => { try { return hashArtifact(request.artifact); } catch { return "invalid-artifact"; } };
const rejected = (artifactKind: AssessExperienceRequest["artifact"]["kind"], id: string): ExperienceOperationResult<ExperienceAssessment> => ({ ok: true, value: { status: "rejected", artifactKind, failedRuleIds: [id], message: "Assessment authorization is invalid." } });
const failure = (request: AssessExperienceRequest, id: string): ExperienceOperationResult<ExperienceAssessment> => rejected(request.artifact.kind, id);
const invalidInputFailure = (id: string): ExperienceOperationResult<ExperienceAssessment> => rejected("chapter", id);
const unique = (ids: string[]): string[] => [...new Set(ids)].sort();

function withinValueBudget(value: unknown, budget: ValueBudget): boolean {
  type Frame = { value: unknown; depth: number; leave?: object };
  try {
    const active = new WeakSet<object>(); const visited = new WeakSet<object>();
    const stack: Frame[] = [{ value, depth: 0 }]; let nodes = 0; let stringCharacters = 0;
    const countString = (input: string): boolean => {
      if (input.length > budget.maxStringLength) return false;
      stringCharacters += input.length;
      return stringCharacters <= budget.maxTotalStringCharacters;
    };
    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.leave) { active.delete(frame.leave); continue; }
      if (frame.depth > budget.maxDepth || ++nodes > budget.maxNodes) return false;
      const current = frame.value;
      if (current === null || typeof current === "boolean") continue;
      if (typeof current === "number") { if (!Number.isFinite(current)) return false; continue; }
      if (typeof current === "string") { if (!countString(current)) return false; continue; }
      if (typeof current !== "object") return false;
      const object = current as object;
      if (active.has(object)) return false;
      if (visited.has(object)) return false;
      visited.add(object); active.add(object); stack.push({ value: null, depth: frame.depth, leave: object });
      const descriptors = Object.getOwnPropertyDescriptors(object);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) return false;
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype || current.length > budget.maxArrayLength || keys.length !== current.length + 1 || !Object.hasOwn(descriptors, "length")) return false;
        for (let index = current.length - 1; index >= 0; index -= 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
          stack.push({ value: descriptor.value, depth: frame.depth + 1 });
        }
        continue;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null || keys.length > budget.maxObjectProperties) return false;
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index] as string; const descriptor = descriptors[key];
        if (!countString(key) || !descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
        stack.push({ value: descriptor.value, depth: frame.depth + 1 });
      }
    }
    return true;
  } catch { return false; }
}

const safeBoundedString = (value: unknown, maximum: number, requireContent = true): value is string => typeof value === "string" && value.length <= maximum && (!requireContent || !!value.trim());
const signalPairKey = (dimensionId: string, signalId: string): string => `${dimensionId.length}:${dimensionId}${signalId.length}:${signalId}`;

function validArtifact(value: unknown): value is AssessExperienceRequest["artifact"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.kind === "blueprint") return Object.keys(item).every((key) => key === "kind" || key === "value") && item.value !== null && typeof item.value === "object" && !Array.isArray(item.value) && Object.keys(item.value as object).length > 0;
  if (item.kind !== "chapter" && item.kind !== "retcon_revision") return false;
  if (Object.keys(item).some((key) => !["kind", "chapterId", "revisionId", "title", "paragraphs"].includes(key))) return false;
  return typeof item.chapterId === "string" && !!item.chapterId.trim() && typeof item.revisionId === "string" && !!item.revisionId.trim() && typeof item.title === "string" && !!item.title.trim() && Array.isArray(item.paragraphs) && item.paragraphs.length > 0 && item.paragraphs.every((paragraph) => typeof paragraph === "string" && paragraph.length > 0);
}
function stageMatches(plan: ExperienceStagePlan, artifact: AssessExperienceRequest["artifact"]): boolean {
  if (artifact.kind === "blueprint") return plan.stage === "blueprint" || plan.stage === "rewrite";
  if (artifact.kind === "retcon_revision") return plan.stage === "retcon" || plan.stage === "rewrite";
  return plan.stage === "opening" || plan.stage === "continuation" || plan.stage === "rewrite";
}
function stateMatches(plan: ExperienceStagePlan, state: AssessmentState): boolean {
  return plan.ticket.activationId === state.activationId && plan.ticket.branchId === state.branchId && plan.ticket.expectedCanonVersion === state.canonVersion && plan.ticket.ledgerRevision === state.ledgerRevision && plan.ticket.attempt === state.attempt && plan.artifactBindingId === state.artifactBindingId && !state.consumedTicketIds.includes(plan.ticket.id);
}
function validAssessmentContract(plan: ExperienceStagePlan): plan is ExperienceStagePlan & { assessmentContract: AssessmentContractProjection } {
  const value = plan.assessmentContract as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const projection = value as Record<string, unknown>;
  if (Object.keys(projection).sort().join("|") !== ["contractRevisionId", "dimensions", "identityHash", "prohibitions", "promises", "ruleGraphVersion", "schemaVersion", "synthesis", "version"].sort().join("|")) return false;
  if (projection.version !== 1 || projection.schemaVersion !== 2 || projection.contractRevisionId !== plan.ticket.contractRevisionId || projection.ruleGraphVersion !== plan.ticket.ruleGraphVersion || typeof projection.identityHash !== "string") return false;
  if (!projection.synthesis || typeof projection.synthesis !== "object" || Array.isArray(projection.synthesis) || Object.keys(projection.synthesis).sort().join("|") !== "dimensionRoles|sharedCause") return false;
  const synthesis = projection.synthesis as Record<string, unknown>;
  if (typeof synthesis.sharedCause !== "string" || !synthesis.sharedCause.trim() || !Array.isArray(synthesis.dimensionRoles) || synthesis.dimensionRoles.length !== 2 || synthesis.dimensionRoles.some((role) => typeof role !== "string" || !role.trim())) return false;
  if (!Array.isArray(projection.dimensions) || !projection.dimensions.length || !Array.isArray(projection.promises) || !Array.isArray(projection.prohibitions)) return false;
  if (!projection.dimensions.every((dimension) => !!dimension && typeof dimension === "object" && !Array.isArray(dimension) && Object.keys(dimension).sort().join("|") === "id|interpretation|observableSignals|prohibitions" && typeof (dimension as Record<string, unknown>).id === "string" && !!((dimension as Record<string, unknown>).id as string).trim() && typeof (dimension as Record<string, unknown>).interpretation === "string" && Array.isArray((dimension as Record<string, unknown>).observableSignals) && Array.isArray((dimension as Record<string, unknown>).prohibitions))) return false;
  const dimensionIds = (projection.dimensions as Array<{ id: string }>).map((dimension) => dimension.id);
  if (new Set(dimensionIds).size !== dimensionIds.length) return false;
  try {
    const { identityHash, ...body } = projection as unknown as AssessmentContractProjection;
    return sameMac(identityHash, assessmentContractIdentity(body));
  } catch { return false; }
}
function validState(value: unknown): value is AssessmentState { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const state = value as Record<string, unknown>; const allowed = ["activationId", "branchId", "canonVersion", "ledgerRevision", "attempt", "consumedTicketIds", "consumedPermitIds", "consumedRepairIds", "existingEvidenceIds", "chapterId", "revisionId", "artifactBindingId", "expectedArtifactDigest"]; if (Object.keys(state).some((key) => !allowed.includes(key))) return false; return typeof state.activationId === "string" && !!state.activationId && typeof state.branchId === "string" && !!state.branchId && typeof state.artifactBindingId === "string" && !!state.artifactBindingId && (state.expectedArtifactDigest === null || typeof state.expectedArtifactDigest === "string" && !!state.expectedArtifactDigest) && Number.isInteger(state.canonVersion) && Number.isInteger(state.ledgerRevision) && Number.isInteger(state.attempt) && [state.consumedTicketIds, state.consumedPermitIds, state.consumedRepairIds, state.existingEvidenceIds].every((list) => Array.isArray(list) && list.every((item) => typeof item === "string")); }
function authenticate(request: AssessExperienceRequest, deps: AssessorDependencies, state: AssessmentState): string | undefined {
  if (!validArtifact(request.artifact)) return "invalid_artifact";
  const plan = request.plan;
  if (!validTrustedRoleBindings(plan.roleBindings)) return "plan_mismatch";
  if (!verifyExperienceStageTicket(plan.ticket, deps) || !Number.isFinite(Date.parse(plan.ticket.expiresAt))) return "ticket_tampered";
  if (Date.parse(plan.ticket.expiresAt) <= deps.now().getTime()) return "ticket_expired";
  const { authorizationMac, ...unsigned } = plan;
  if (!sameMac(authorizationMac, signExperiencePlan(unsigned, deps.ticketSecret))) return "plan_mismatch";
  if (!validAssessmentContract(plan)) return "plan_mismatch";
  if (plan.stage !== plan.ticket.stage || plan.artifactKind !== plan.ticket.artifactKind || plan.artifactKind !== request.artifact.kind || !stageMatches(plan, request.artifact)) return "stage_mismatch";
  if (!stateMatches(plan, state)) return "state_mismatch";
  if (request.artifact.kind !== "blueprint" && (!plan.chapterId || !plan.revisionId || plan.chapterId !== request.artifact.chapterId || plan.revisionId !== request.artifact.revisionId || state.chapterId !== request.artifact.chapterId || state.revisionId !== request.artifact.revisionId)) return "artifact_binding_mismatch";
  if (plan.stage === "rewrite") {
    const authorization = plan.repairAuthorization; if (!authorization || !verifyRepairAuthorization(authorization.token, authorization.expected, deps.ticketSecret, deps.now()) || authorization.tokenDigest !== createHash("sha256").update(canonicalAuthorizationPayload(authorization.token)).digest("hex") || state.consumedRepairIds.includes(authorization.token.repairId)) return "repair_authorization_invalid";
    const token = authorization.token;
    if (plan.ticket.attempt !== token.attempt + 1 || plan.ticket.jobId !== token.jobId || plan.ticket.contractRevisionId !== token.contractRevisionId || plan.ticket.activationId !== token.activationId || plan.ticket.branchId !== token.branchId || plan.ticket.expectedCanonVersion !== token.expectedCanonVersion || plan.ticket.ledgerRevision !== token.ledgerRevision || plan.ticket.ruleGraphVersion !== token.ruleGraphVersion || plan.artifactKind !== token.artifactKind || plan.chapterNumber !== token.chapterNumber || plan.artifactBindingId === token.artifactBindingId || canonicalAuthorizationPayload(plan.roleBindings) !== canonicalAuthorizationPayload(token.roleBindings) || canonicalAuthorizationPayload(plan.repairRuleIds) !== canonicalAuthorizationPayload([...new Set(token.failedRuleIds)].sort()) || (token.artifactKind !== "blueprint" && (plan.chapterId !== token.chapterId || plan.revisionId !== token.revisionId))) return "repair_authorization_invalid";
  } else if (plan.repairAuthorization || plan.repairRuleIds.length) return "repair_authorization_invalid";
  return undefined;
}
function selectedSignals(plan: ExperienceStagePlan): ObservableSignalV2[] | undefined {
  const contract = plan.assessmentContract;
  const map = new Map(contract.dimensions.flatMap((dimension) => dimension.observableSignals.map((signal) => [signal.id, signal] as const)));
  const signals: ObservableSignalV2[] = [];
  for (const dimension of plan.promptProjection.dimensions) {
    const trustedDimension = contract.dimensions.find((item) => item.id === dimension.id); if (!trustedDimension || trustedDimension.interpretation !== dimension.interpretation) return undefined;
    for (const id of dimension.signalIds) { const signal = map.get(id); if (!signal || signal.dimensionId !== dimension.id || signals.some((candidate) => candidate.id === id)) return undefined; signals.push(signal); }
  }
  if (!signals.length || plan.evidenceSchema.length !== signals.length || plan.ruleAdapterIds.some((id) => !isRuleAdapterId(id))) return undefined;
  const expectedAdapters = contract.prohibitions.flatMap((item) => item.ruleAdapterId && isRuleAdapterId(item.ruleAdapterId) ? [item.ruleAdapterId] : []).sort(); if ([...plan.ruleAdapterIds].sort().join("|") !== expectedAdapters.join("|")) return undefined;
  if (canonicalAuthorizationPayload(plan.promptProjection.prohibitions) !== canonicalAuthorizationPayload(contract.prohibitions.map((item) => item.description))) return undefined;
  return plan.evidenceSchema.every((policy, index) => canonicalAuthorizationPayload(policy) === canonicalAuthorizationPayload(signals[index].verification)) ? signals : undefined;
}
function containingClause(source: string, start: number, end: number): string {
  const range = containingClauseRange(source, start, end);
  return source.slice(range.start, range.end);
}
function containingClauseRange(source: string, start: number, end: number): SourceSpan {
  const boundary = (value: string) => /[\n。！？；.!?;]/u.test(value);
  let clauseStart = start; while (clauseStart > 0 && !boundary(source[clauseStart - 1])) clauseStart -= 1;
  let clauseEnd = end; while (clauseEnd < source.length && !boundary(source[clauseEnd])) clauseEnd += 1;
  return { start: clauseStart, end: clauseEnd < source.length ? clauseEnd + 1 : clauseEnd };
}
function localFinding(source: string, claim: SemanticEvidenceClaim, grounded: GroundedClaim, signal: ObservableSignalV2, roles: ExperienceStagePlan["roleBindings"], configuredAdapters: GenericRuleAdapterId[]): EvidenceFinding | undefined {
  const focus = grounded.anchors.map((anchor) => containingClauseRange(source, anchor.start, anchor.end));
  const text = grounded.anchors.map((anchor) => {
    if (signal.verification.kind !== "distribution") return containingClause(source, anchor.start, anchor.end);
    const start = source.lastIndexOf("\n", Math.max(0, anchor.start - 1)) + 1; const next = source.indexOf("\n", anchor.end);
    return source.slice(start, next < 0 ? source.length : next);
  }).join(" "); const slots = claim.slots ?? {};
  const supplied = (slot: RealizationSlot) => typeof slots[slot as keyof typeof slots] === "string" && !!slots[slot as keyof typeof slots]?.trim();
  const required: Record<string, string[]> = { mechanic: ["actor", "action", "object", "outcome"], protagonist_action: ["actor", "action", "outcome"], conflict_outcome: ["actor", "action", "opponent", "outcome"], world_reaction: ["actor", "reaction", "outcome"], relationship: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"] };
  const policyRequired = signal.verification.kind === "event_slots" ? signal.verification.requiredSlots : [];
  const narrativeSlots: RealizationSlot[] = ["actor", "action", "object", "feedback", "outcome", "reaction", "reciprocalAction", "relationshipChange", "counterpart", "opponent"];
  const suppliedSlots = narrativeSlots.filter(supplied);
  const requiredSlots = unique([...policyRequired, ...(required[signal.kind] ?? []), ...suppliedSlots]) as RealizationSlot[];
  const realization: RealizationBinding = { actor: slots.actor, action: slots.action, object: slots.object, feedback: slots.feedback, outcome: slots.outcome, reaction: slots.reaction, reciprocalAction: slots.reciprocalAction, relationshipChange: slots.relationshipChange, counterpart: slots.counterpart, opponent: slots.opponent, requiredSlots };
  if (requiredSlots.some((slot) => !supplied(slot))) return { ruleId: "evidence.required_slot_missing", severity: "rewrite", dimensionId: signal.dimensionId };
  if (["protagonist_action", "conflict_outcome", "mechanic", "relationship"].includes(signal.kind) && (!roles.protagonistId || !roles.aliases.some((alias) => canonicalRoleKey(alias) === canonicalRoleKey(slots.actor ?? "")))) return { ruleId: "evidence.helper_substitution", severity: "rewrite", dimensionId: signal.dimensionId };
  if (signal.kind === "relationship") { const counterpart = roles.counterparts.find((item) => item.id === slots.counterpartId); if (!counterpart || !slots.counterpart || !counterpart.aliases.some((alias) => canonicalRoleKey(alias) === canonicalRoleKey(slots.counterpart!))) return { ruleId: "evidence.counterpart_untrusted", severity: "rewrite", dimensionId: signal.dimensionId }; }
  if (signal.kind === "conflict_outcome") { const opponent = roles.opponents.find((item) => item.id === slots.opponentId); if (!opponent || !slots.opponent || !opponent.aliases.some((alias) => canonicalRoleKey(alias) === canonicalRoleKey(slots.opponent!))) return { ruleId: "evidence.opponent_untrusted", severity: "rewrite", dimensionId: signal.dimensionId }; }
  if (requiredSlots.some((slot) => !Number.isInteger(claim.slotAnchorIndices[slot as keyof typeof claim.slotAnchorIndices]))) return { ruleId: "evidence.slot_anchor_not_grounded", severity: "rewrite", dimensionId: signal.dimensionId };
  if (Object.entries(claim.slotAnchorIndices).some(([slot, index]) => !Number.isInteger(index) || index! < 0 || index! >= grounded.anchors.length || !slots[slot as keyof typeof slots])) return { ruleId: "evidence.slot_anchor_not_grounded", severity: "rewrite", dimensionId: signal.dimensionId };
  if (signal.semanticSlots && Object.entries(signal.semanticSlots).some(([name, expected]) => slots[name as keyof typeof slots] !== expected)) return { ruleId: "evidence.binding_mismatch", severity: "rewrite", dimensionId: signal.dimensionId };
  if (signal.verification.kind === "distribution") {
    if (suppliedSlots.length || Object.keys(claim.slotAnchorIndices).length) return { ruleId: "evidence.distribution_slots_forbidden", severity: "rewrite", dimensionId: signal.dimensionId };
    if (signal.kind === "pacing" && bindPacingFacets(claim, grounded.anchors).some((binding) => !pacingFacetIsRealized(binding))) return { ruleId: "evidence.not_realized", severity: "rewrite", dimensionId: signal.dimensionId };
    const distributionAdapters = (unique(configuredAdapters) as GenericRuleAdapterId[]).filter((id) => !id.startsWith("event-"));
    if (distributionAdapters.some((id) => adapterAppliesTo(id, signal.kind) && runRuleAdapter(id, text))) return { ruleId: "evidence.not_realized", severity: "rewrite", dimensionId: signal.dimensionId };
    return undefined;
  }
  const slotEvidence = Object.fromEntries(Object.entries(claim.slotAnchorIndices).flatMap(([slot, index]) => Number.isInteger(index) && grounded.anchors[index!] ? [[slot, [{ start: grounded.anchors[index!]!.start, end: grounded.anchors[index!]!.end }]]] : [])) as Partial<Record<RealizationSlot, SourceSpan[]>>;
  const counterpart = roles.counterparts.find((item) => item.id === slots.counterpartId);
  const opponent = roles.opponents.find((item) => item.id === slots.opponentId);
  const protagonistBound = ["protagonist_action", "conflict_outcome", "mechanic", "relationship"].includes(signal.kind);
  const realizationResult = verifyNarrativeRealization({ source, binding: realization, category: signal.kind, focus, slotEvidence, actorAliases: protagonistBound ? roles.aliases : slots.actor ? [slots.actor] : undefined, counterpartAliases: counterpart?.aliases, opponentAliases: opponent?.aliases });
  if (realizationResult.status !== "realized") return { ruleId: realizationResult.reason === "foreign_subject" ? "evidence.helper_substitution" : realizationResult.reason === "ambiguous" ? "evidence.semantic_indeterminate" : "evidence.not_realized", severity: "rewrite", dimensionId: signal.dimensionId };
  const localAdapters = (unique(configuredAdapters) as GenericRuleAdapterId[])
    .filter((id) => !id.startsWith("event-") && id !== "curated-mechanic-unavailable" && id !== "curated-outcome-weakened");
  if (localAdapters.some((id) => adapterAppliesTo(id, signal.kind) && runRuleAdapter(id, text, realization))) return { ruleId: "evidence.not_realized", severity: "rewrite", dimensionId: signal.dimensionId };
  return undefined;
}
function validVerdict(value: unknown, expectedSignals: readonly ObservableSignalV2[]): value is { version: 1; claims: SemanticEvidenceClaim[]; sharedCause: { eventId: string; supported: boolean; confidence: number; anchors: Array<{ start: number; end: number; quote: string }>; links: Array<{ dimensionId: string; signalId: string; claimAnchorIndex: number; sharedAnchorIndex: number }> } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.claims) || record.claims.length !== expectedSignals.length || record.claims.length > MAX_SEMANTIC_CLAIMS || Object.keys(record).some((key) => !["version", "claims", "sharedCause"].includes(key))) return false;
  const shared = record.sharedCause as Record<string, unknown> | undefined;
  if (!shared || !safeBoundedString(shared.eventId, MAX_JUDGE_ID_LENGTH) || typeof shared.supported !== "boolean" || typeof shared.confidence !== "number" || !Number.isFinite(shared.confidence) || !Array.isArray(shared.anchors) || shared.anchors.length > MAX_SHARED_CAUSE_ANCHORS || !Array.isArray(shared.links) || shared.links.length > MAX_SHARED_CAUSE_LINKS || Object.keys(shared).some((key) => !["eventId", "supported", "confidence", "anchors", "links"].includes(key))) return false;
  const sharedAnchors = shared.anchors as unknown[]; const sharedLinks = shared.links as unknown[];
  const anchorValid = (anchor: unknown) => {
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return false;
    const item = anchor as Record<string, unknown>;
    return Number.isInteger(item.start) && Number.isInteger(item.end) && safeBoundedString(item.quote, MAX_EVIDENCE_QUOTE_LENGTH, false) && sameStringMultiset(Object.keys(item), ["start", "end", "quote"]);
  };
  if (!sharedAnchors.every(anchorValid)) return false;
  const sharedSpanKeys = new Set<string>();
  for (const anchor of sharedAnchors as Array<{ start: number; end: number }>) {
    const key = `${anchor.start}:${anchor.end}`; if (sharedSpanKeys.has(key)) return false; sharedSpanKeys.add(key);
  }
  if (!sharedLinks.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const link = candidate as Record<string, unknown>;
    return sameStringMultiset(Object.keys(link), ["claimAnchorIndex", "dimensionId", "sharedAnchorIndex", "signalId"])
      && safeBoundedString(link.dimensionId, MAX_JUDGE_ID_LENGTH) && safeBoundedString(link.signalId, MAX_JUDGE_ID_LENGTH)
      && Number.isInteger(link.claimAnchorIndex) && (link.claimAnchorIndex as number) >= 0
      && Number.isInteger(link.sharedAnchorIndex) && (link.sharedAnchorIndex as number) >= 0 && (link.sharedAnchorIndex as number) < sharedAnchors.length;
  })) return false;
  const claimKeys = ["version", "eventId", "dimensionId", "signalId", "supported", "confidence", "anchors", "slotAnchorIndices", "slots", "metrics", "distributionAnchorIndices"];
  if (!record.claims.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const claim = candidate as Record<string, unknown>;
    if (Object.keys(claim).some((key) => !claimKeys.includes(key)) || claim.version !== 1 || !safeBoundedString(claim.eventId, MAX_JUDGE_ID_LENGTH) || !safeBoundedString(claim.dimensionId, MAX_JUDGE_ID_LENGTH) || !safeBoundedString(claim.signalId, MAX_JUDGE_ID_LENGTH) || typeof claim.supported !== "boolean" || typeof claim.confidence !== "number" || !Number.isFinite(claim.confidence) || !Array.isArray(claim.anchors) || claim.anchors.length > MAX_EVIDENCE_ANCHORS_PER_CLAIM || !claim.slotAnchorIndices || typeof claim.slotAnchorIndices !== "object" || Array.isArray(claim.slotAnchorIndices)) return false;
    const claimAnchors = claim.anchors as unknown[];
    const slotIndices = claim.slotAnchorIndices as Record<string, unknown>;
    if (Object.keys(slotIndices).length > 16 || Object.values(slotIndices).some((index) => !Number.isInteger(index) || (index as number) < 0 || (index as number) >= claimAnchors.length)) return false;
    if (claim.metrics !== undefined && (!claim.metrics || typeof claim.metrics !== "object" || Array.isArray(claim.metrics) || Object.keys(claim.metrics as Record<string, unknown>).length > MAX_METRIC_KEYS || Object.values(claim.metrics as Record<string, unknown>).some((metric) => typeof metric !== "number" || !Number.isFinite(metric)))) return false;
    if (claim.distributionAnchorIndices !== undefined && (!claim.distributionAnchorIndices || typeof claim.distributionAnchorIndices !== "object" || Array.isArray(claim.distributionAnchorIndices) || Object.keys(claim.distributionAnchorIndices as Record<string, unknown>).some((key) => !["goal", "pressure", "beat", "turn", "abstraction", "sensory", "rhetoric"].includes(key)) || Object.values(claim.distributionAnchorIndices as Record<string, unknown>).some((indices) => !Array.isArray(indices) || indices.length > MAX_EVIDENCE_ANCHORS_PER_CLAIM || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= claimAnchors.length)))) return false;
    if (claim.slots !== undefined && (!claim.slots || typeof claim.slots !== "object" || Array.isArray(claim.slots) || Object.keys(claim.slots as Record<string, unknown>).some((key) => !["actor", "action", "object", "feedback", "outcome", "reaction", "reciprocalAction", "relationshipChange", "counterpart", "counterpartId", "opponent", "opponentId"].includes(key)) || Object.values(claim.slots as Record<string, unknown>).some((slot) => !safeBoundedString(slot, MAX_SLOT_VALUE_LENGTH, false)))) return false;
    return claimAnchors.every(anchorValid);
  })) return false;
  const claims = record.claims as SemanticEvidenceClaim[];
  const compare = (left: { dimensionId: string; signalId: string }, right: { dimensionId: string; signalId: string }) => left.dimensionId.localeCompare(right.dimensionId) || left.signalId.localeCompare(right.signalId);
  const suppliedPairs = claims.map(({ dimensionId, signalId }) => ({ dimensionId, signalId })).sort(compare);
  const expectedPairs = expectedSignals.map(({ dimensionId, id }) => ({ dimensionId, signalId: id })).sort(compare);
  if (!suppliedPairs.every((pair, index) => pair.dimensionId === expectedPairs[index]?.dimensionId && pair.signalId === expectedPairs[index]?.signalId)) return false;
  const claimByPair = new Map(claims.map((claim) => [signalPairKey(claim.dimensionId, claim.signalId), claim]));
  const linkTuples = new Set<string>(); const linkedClaimAnchors = new Set<string>();
  for (const link of shared.links as Array<{ dimensionId: string; signalId: string; claimAnchorIndex: number; sharedAnchorIndex: number }>) {
    const pair = signalPairKey(link.dimensionId, link.signalId); const claim = claimByPair.get(pair);
    if (!claim || link.claimAnchorIndex >= claim.anchors.length) return false;
    const tuple = `${pair}:${link.claimAnchorIndex}:${link.sharedAnchorIndex}`; const claimAnchor = `${pair}:${link.claimAnchorIndex}`;
    if (linkTuples.has(tuple) || linkedClaimAnchors.has(claimAnchor)) return false;
    linkTuples.add(tuple); linkedClaimAnchors.add(claimAnchor);
  }
  return true;
}
type CheckedVerdict = ReturnType<typeof snapshot> extends infer _ ? { version: 1; claims: SemanticEvidenceClaim[]; sharedCause: { eventId: string; supported: boolean; confidence: number; anchors: Array<{ start: number; end: number; quote: string }>; links: Array<{ dimensionId: string; signalId: string; claimAnchorIndex: number; sharedAnchorIndex: number }> } } : never;
const sameAnchor = (left: { start: number; end: number }, right: { start: number; end: number }): boolean => left.start === right.start && left.end === right.end;
function sharedCauseFinding(source: string, verdict: CheckedVerdict, plan: ExperienceStagePlan, signals: ObservableSignalV2[]): EvidenceFinding | undefined {
  const shared = verdict.sharedCause;
  if (!shared.supported || shared.confidence < .65 || shared.confidence > 1 || !shared.anchors.length || shared.anchors.some((anchor) => anchor.start < 0 || anchor.end > source.length || anchor.end <= anchor.start || source.slice(anchor.start, anchor.end) !== anchor.quote)) return { ruleId: "evidence.shared_cause_unsupported", severity: "rewrite" };
  const expectedDimensions = plan.promptProjection.dimensions.map((dimension) => dimension.id);
  const semanticIds = unique([...expectedDimensions, ...plan.promptProjection.dimensions.flatMap((dimension) => dimension.signalIds), ...plan.duePromiseIds]);
  const substantiveBridge = (quote: string): boolean => {
    if (/(?:信号|承诺|维度|标签|事件\s*(?:id|编号)|令牌)|\b(?:signal|promise|dimension|label|event\s*id|token)s?\b/iu.test(quote)) return false;
    let remainder = quote.normalize("NFKC").toLocaleLowerCase();
    for (const id of [...semanticIds].sort((left, right) => right.length - left.length)) remainder = remainder.split(id.normalize("NFKC").toLocaleLowerCase()).join(" ");
    return remainder.replace(/[^\p{L}\p{N}]+/gu, "").length >= 6;
  };
  if (shared.anchors.some((anchor) => !substantiveBridge(anchor.quote))) return { ruleId: "evidence.shared_cause_unsupported", severity: "rewrite" };
  const claimByPair = new Map(verdict.claims.map((claim) => [signalPairKey(claim.dimensionId, claim.signalId), claim]));
  const signalByPair = new Map(signals.map((signal) => [signalPairKey(signal.dimensionId, signal.id), signal]));
  const linkedIndicesByPair = new Map<string, Set<number>>();
  const dimensionsBySharedAnchor = shared.anchors.map(() => new Set<string>());
  for (const link of shared.links) {
    const pair = signalPairKey(link.dimensionId, link.signalId);
    const indices = linkedIndicesByPair.get(pair) ?? new Set<number>(); indices.add(link.claimAnchorIndex); linkedIndicesByPair.set(pair, indices);
    dimensionsBySharedAnchor[link.sharedAnchorIndex]?.add(link.dimensionId);
  }
  const sharedSpanKeys = new Set(shared.anchors.map((anchor) => `${anchor.start}:${anchor.end}`));
  const linkedClaims = new Map<string, SemanticEvidenceClaim>();
  for (const link of shared.links) {
    const pair = signalPairKey(link.dimensionId, link.signalId);
    const claim = claimByPair.get(pair); const signal = signalByPair.get(pair);
    const claimAnchor = claim?.anchors[link.claimAnchorIndex]; const sharedAnchor = shared.anchors[link.sharedAnchorIndex];
    if (!claim || claim.eventId !== shared.eventId || !signal || !claimAnchor || !sharedAnchor || !sameAnchor(claimAnchor, sharedAnchor) || claimAnchor.quote !== sharedAnchor.quote) return { ruleId: "evidence.shared_cause_unsupported", severity: "rewrite" };
    const linkedIndices = linkedIndicesByPair.get(pair)!;
    if (signal.verification.kind === "distribution") {
      if (!claim.anchors.some((anchor, index) => !linkedIndices.has(index) && !sharedSpanKeys.has(`${anchor.start}:${anchor.end}`))) return { ruleId: "evidence.shared_cause_unsupported", severity: "rewrite" };
    } else {
      const effectSlots: Record<string, string[]> = { mechanic: ["feedback", "outcome"], protagonist_action: ["outcome"], conflict_outcome: ["outcome"], world_reaction: ["reaction", "outcome"], relationship: ["reciprocalAction", "relationshipChange"] };
      const linkedEffect = (effectSlots[signal.kind] ?? []).find((slot) => claim.slotAnchorIndices[slot as keyof typeof claim.slotAnchorIndices] === link.claimAnchorIndex);
      if (!linkedEffect || !claim.slots?.[linkedEffect as keyof NonNullable<SemanticEvidenceClaim["slots"]>] || !claimAnchor.quote.includes(claim.slots[linkedEffect as keyof NonNullable<SemanticEvidenceClaim["slots"]>]!)) return { ruleId: "evidence.shared_cause_unsupported", severity: "rewrite" };
    }
    linkedClaims.set(pair, claim);
  }
  if (!sameStringMultiset([...new Set(shared.links.map((link) => link.dimensionId))], expectedDimensions) || dimensionsBySharedAnchor.some((dimensions) => !sameStringMultiset([...dimensions], expectedDimensions))) return { ruleId: "evidence.shared_cause_unsupported", severity: "rewrite" };
  const dimensionsByAnchorSignature = new Map<string, string>();
  for (const claim of linkedClaims.values()) {
    const signature = claim.anchors.map((anchor) => `${anchor.start}:${anchor.end}`).sort().join("|"); const priorDimension = dimensionsByAnchorSignature.get(signature);
    if (priorDimension !== undefined && priorDimension !== claim.dimensionId) return { ruleId: "evidence.shared_cause_unsupported", severity: "rewrite" };
    dimensionsByAnchorSignature.set(signature, claim.dimensionId);
  }
  return undefined;
}
function sharedAnchorIndexFor(verdict: CheckedVerdict, claim: SemanticEvidenceClaim, claimAnchorIndex: number): number | undefined {
  return verdict.sharedCause.links.find((link) => link.dimensionId === claim.dimensionId && link.signalId === claim.signalId && link.claimAnchorIndex === claimAnchorIndex)?.sharedAnchorIndex;
}
function permit(request: AssessExperienceRequest, artifactHash: string, evidence: ExperienceEvidenceV2[], patch: ExperienceLedgerPatch, deps: AssessorDependencies): ExperiencePublicationPermit {
  const artifact = request.artifact; if (artifact.kind === "blueprint") throw new Error("invalid permit artifact"); const expiresAt = new Date(deps.now().getTime() + (deps.permitTtlMs ?? 600_000)).toISOString();
  const bindings = sortedEvidenceBindings(evidence);
  const context: PublicationPermitContext = { ticketId: request.plan.ticket.id, jobId: request.plan.ticket.jobId, attempt: request.plan.ticket.attempt, contractRevisionId: request.plan.ticket.contractRevisionId, activationId: request.plan.ticket.activationId, branchId: request.plan.ticket.branchId, chapterId: artifact.chapterId, revisionId: artifact.revisionId, artifactBindingId: request.plan.artifactBindingId, artifactHash, stage: request.plan.stage, artifactKind: request.plan.artifactKind, ruleGraphVersion: request.plan.ticket.ruleGraphVersion, expectedCanonVersion: request.plan.ticket.expectedCanonVersion, ledgerRevision: request.plan.ticket.ledgerRevision, evidenceIds: bindings.map((binding) => binding.evidenceId).sort(), evidenceBindings: bindings.map((binding) => ({ ...binding })), evidenceRootHash: evidenceRootHash(bindings), ledgerPatchHash: ledgerPatchHash(patch) };
  const permitId = `permit_${createHash("sha256").update(canonicalAuthorizationPayload({ ticketId: request.plan.ticket.id, artifactHash, evidenceRootHash: context.evidenceRootHash, expiresAt })).digest("base64url")}`;
  return issuePublicationPermit(context, permitId, expiresAt, deps.ticketSecret);
}
export async function consumePublicationPermit(value: unknown, context: PublicationPermitContext, deps: AssessorDependencies): Promise<boolean> {
  try {
    const verified = verifiedPublicationPermitSnapshot(value, context, deps.ticketSecret, deps.now());
    if (!verified) return false;
    const { permit, context: safeContext } = verified;
    const read = deps.statePort?.read?.bind(deps.statePort); const consumePermit = deps.statePort?.consumePermit?.bind(deps.statePort);
    if (!read || !consumePermit) return false;
    const state = boundedAuthorizationSnapshot(await read({ ticketId: permit.ticketId, jobId: permit.jobId }));
    if (!validState(state) || state.consumedPermitIds.includes(permit.permitId) || !state.consumedTicketIds.includes(permit.ticketId) || state.activationId !== permit.activationId || state.branchId !== permit.branchId || state.canonVersion !== permit.expectedCanonVersion || state.ledgerRevision !== permit.ledgerRevision || state.attempt !== permit.attempt || state.chapterId !== permit.chapterId || state.revisionId !== permit.revisionId || state.artifactBindingId !== permit.artifactBindingId || state.expectedArtifactDigest !== permit.artifactHash) return false;
    return !!await consumePermit({ permitId: permit.permitId, ticketId: permit.ticketId, permitDigest: publicationPermitDigest(permit), context: structuredClone(safeContext), expected: { activationId: permit.activationId, branchId: permit.branchId, canonVersion: permit.expectedCanonVersion, ledgerRevision: permit.ledgerRevision, attempt: permit.attempt, chapterId: permit.chapterId, revisionId: permit.revisionId, artifactBindingId: permit.artifactBindingId, expectedArtifactDigest: permit.artifactHash } });
  } catch { return false; }
}
function repair(request: AssessExperienceRequest, ids: string[], deps: AssessorDependencies): ExperienceRepairToken { const artifact = request.artifact; const expiresAt = new Date(deps.now().getTime() + (deps.repairTtlMs ?? 300_000)).toISOString(); const unsigned = { version: 1 as const, repairId: `repair_${createHash("sha256").update(`${request.plan.ticket.id}\u001f${artifactHashSafe(request)}\u001f${expiresAt}`).digest("base64url")}`, ticketId: request.plan.ticket.id, jobId: request.plan.ticket.jobId, attempt: request.plan.ticket.attempt, contractRevisionId: request.plan.ticket.contractRevisionId, activationId: request.plan.ticket.activationId, branchId: request.plan.ticket.branchId, stage: request.plan.stage, artifactKind: request.plan.artifactKind, ruleGraphVersion: request.plan.ticket.ruleGraphVersion, expectedCanonVersion: request.plan.ticket.expectedCanonVersion, ledgerRevision: request.plan.ticket.ledgerRevision, chapterNumber: request.plan.chapterNumber, ...(artifact.kind === "blueprint" ? {} : { chapterId: artifact.chapterId, revisionId: artifact.revisionId }), artifactBindingId: request.plan.artifactBindingId, roleBindings: structuredClone(request.plan.roleBindings), artifactHash: artifactHashSafe(request), failedRuleIds: unique(ids), expiresAt }; return { ...unsigned, signature: sign(repairDomain, unsigned, deps.ticketSecret) }; }
export function verifyRepairToken(value: unknown, context: RepairTokenContext, secret: string, now: Date): boolean { return !!value && typeof value === "object" && !Array.isArray(value) && verifyRepairAuthorization(value as ExperienceRepairToken, context, secret, now); }
function rewrite(request: AssessExperienceRequest, findings: EvidenceFinding[], deps: AssessorDependencies): ExperienceOperationResult<ExperienceAssessment> { const blocking = findings.find((finding) => finding.severity === "rejected"); if (blocking) return failure(request, blocking.ruleId); const ids = unique(findings.map((finding) => finding.ruleId)); return { ok: true, value: { status: "rewrite", artifactKind: request.artifact.kind, failedRuleIds: ids, repairToken: repair(request, ids, deps), message: "Evidence must be grounded in the submitted artifact." } }; }
function casInput(request: AssessExperienceRequest, state: AssessmentState, artifactHash: string, outcomeId: string, outcome: "accepted" | "rewrite" | "rejected" | "blueprint", newEvidenceIds: readonly string[] = [], issuedAuthorization?: NonNullable<Parameters<AssessorDependencies["statePort"]["consumeTicket"]>[0]["issuedAuthorization"]>): Parameters<AssessorDependencies["statePort"]["consumeTicket"]>[0] { const repairAuthorization = request.plan.repairAuthorization; return { ticketId: request.plan.ticket.id, artifactHash, outcomeId, outcome, newEvidenceIds: [...newEvidenceIds].sort(), ...(issuedAuthorization ? { issuedAuthorization: structuredClone(issuedAuthorization) } : {}), ...(repairAuthorization ? { repairAuthorization: { repairId: repairAuthorization.token.repairId, tokenDigest: repairAuthorization.tokenDigest, expected: structuredClone(repairAuthorization.expected) } } : {}), expected: { activationId: request.plan.ticket.activationId, branchId: request.plan.ticket.branchId, canonVersion: request.plan.ticket.expectedCanonVersion, ledgerRevision: request.plan.ticket.ledgerRevision, attempt: request.plan.ticket.attempt, ...(request.plan.chapterId ? { chapterId: request.plan.chapterId } : {}), ...(request.plan.revisionId ? { revisionId: request.plan.revisionId } : {}), artifactBindingId: request.plan.artifactBindingId, expectedArtifactDigest: artifactHash, existingEvidenceIds: [...state.existingEvidenceIds].sort() } }; }
async function consumeTicketSafely(consume: AssessorDependencies["statePort"]["consumeTicket"], input: Parameters<AssessorDependencies["statePort"]["consumeTicket"]>[0]): Promise<boolean> { try { return !!await consume(input); } catch { return false; } }
async function issueRewrite(request: AssessExperienceRequest, findings: EvidenceFinding[], deps: AssessorDependencies, consume: AssessorDependencies["statePort"]["consumeTicket"], state: AssessmentState, artifactHash: string): Promise<ExperienceOperationResult<ExperienceAssessment>> { const result = rewrite(request, findings, deps); let outcomeId = `blocked_${findings.map((finding) => finding.ruleId).join("_")}`; let outcome: "rewrite" | "rejected" = "rejected"; let issuedAuthorization: NonNullable<Parameters<AssessorDependencies["statePort"]["consumeTicket"]>[0]["issuedAuthorization"]> | undefined; if (result.ok && result.value.status === "rewrite") { const token = result.value.repairToken; outcomeId = token.repairId; outcome = "rewrite"; issuedAuthorization = { kind: "repair", repairId: token.repairId, tokenDigest: createHash("sha256").update(canonicalAuthorizationPayload(token)).digest("hex"), context: repairContext(token) }; } if (!await consumeTicketSafely(consume, casInput(request, state, artifactHash, outcomeId, outcome, [], issuedAuthorization))) return failure(request, "ticket_reused"); return result; }
const blueprintEndingNarrativeKeys = ["target", "cost"] as const;
const blueprintSharedNarrativeKeys = ["event"] as const;
const blueprintChapterNarrativeKeys = ["event", "cause", "outcome", "cost"] as const;
function sameStringMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort(); const orderedRight = [...right].sort();
  return orderedLeft.every((value, index) => value === orderedRight[index]);
}
function validBlueprint(value: Record<string, unknown>, plan: ExperienceStagePlan): boolean {
  const allowed = ["axisSignalIds", "chapters", "endingContract", "hardPromiseIds", "meta", "protagonist", "schemaVersion", "sharedCause", "title"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  const exactObject = (candidate: unknown, allowedKeys: readonly string[], requiredKeys: readonly string[] = allowedKeys): candidate is Record<string, unknown> => !!candidate && typeof candidate === "object" && !Array.isArray(candidate) && Object.getPrototypeOf(candidate) === Object.prototype && Object.keys(candidate).every((key) => allowedKeys.includes(key)) && requiredKeys.every((key) => Object.hasOwn(candidate, key));
  if (!exactObject(value.protagonist, ["id"]) || !exactObject(value.endingContract, blueprintEndingNarrativeKeys, ["target"]) || !exactObject(value.sharedCause, [...blueprintSharedNarrativeKeys, "dimensionIds"]) || value.meta !== undefined && !exactObject(value.meta, ["prohibitionsSatisfied"])) return false;
  const protagonist = value.protagonist; const ending = value.endingContract; const shared = value.sharedCause;
  if (value.meta !== undefined && value.meta.prohibitionsSatisfied !== true) return false;
  const expectedSignals = plan.promptProjection.dimensions.flatMap((dimension) => dimension.signalIds); const suppliedSignals = Array.isArray(value.axisSignalIds) ? value.axisSignalIds : [];
  const expectedPromises = [...plan.hardPresencePromiseIds]; const suppliedPromises = Array.isArray(value.hardPromiseIds) ? value.hardPromiseIds : [];
  const safeId = (candidate: unknown): candidate is string => safeBoundedString(candidate, MAX_BLUEPRINT_ID_LENGTH);
  const safeNarrative = (candidate: unknown, allowEmpty = false): candidate is string => safeBoundedString(candidate, MAX_BLUEPRINT_NARRATIVE_FIELD_LENGTH, !allowEmpty);
  if (value.schemaVersion !== 1 || !safeBoundedString(value.title, MAX_BLUEPRINT_TITLE_LENGTH) || !safeId(protagonist.id) || protagonist.id !== plan.roleBindings.protagonistId || !safeNarrative(ending.target) || (ending.cost !== undefined && !safeNarrative(ending.cost, true))) return false;
  if (expectedSignals.some((id) => !safeId(id)) || expectedPromises.some((id) => !safeId(id)) || suppliedSignals.some((id) => !safeId(id)) || suppliedPromises.some((id) => !safeId(id))) return false;
  if (!sameStringMultiset(suppliedSignals as string[], expectedSignals) || !sameStringMultiset(suppliedPromises as string[], expectedPromises)) return false;
  const expectedDimensions = plan.promptProjection.dimensions.map((dimension) => dimension.id);
  if (!safeNarrative(shared.event) || !Array.isArray(shared.dimensionIds) || shared.dimensionIds.some((id) => !safeId(id)) || !sameStringMultiset(shared.dimensionIds as string[], expectedDimensions)) return false;
  if (!Array.isArray(value.chapters) || !value.chapters.length || value.chapters.length > MAX_BLUEPRINT_CHAPTERS) return false;
  const expectedSignalSet = new Set(expectedSignals); const expectedPromiseSet = new Set(expectedPromises);
  if (expectedSignalSet.size !== expectedSignals.length || expectedPromiseSet.size !== expectedPromises.length) return false;
  const chapterNumbers = new Set<number>(); const assignedSignals = new Set<string>(); const assignedPromises = new Set<string>();
  const chapterKeys = ["number", "signalIds", "promiseIds", ...blueprintChapterNarrativeKeys];
  for (const chapter of value.chapters) {
    if (!chapter || typeof chapter !== "object" || Array.isArray(chapter)) return false;
    const record = chapter as Record<string, unknown>;
    if (!sameStringMultiset(Object.keys(record), chapterKeys) || !Number.isSafeInteger(record.number) || (record.number as number) <= 0 || chapterNumbers.has(record.number as number)) return false;
    chapterNumbers.add(record.number as number);
    if (!Array.isArray(record.signalIds) || record.signalIds.length > MAX_BLUEPRINT_IDS_PER_CHAPTER || !Array.isArray(record.promiseIds) || record.promiseIds.length > MAX_BLUEPRINT_IDS_PER_CHAPTER) return false;
    const signalIds = record.signalIds as unknown[]; const promiseIds = record.promiseIds as unknown[];
    if (signalIds.length === 0 && promiseIds.length === 0) return false;
    if (signalIds.some((id) => !safeId(id)) || promiseIds.some((id) => !safeId(id))) return false;
    if (new Set(signalIds as string[]).size !== signalIds.length || new Set(promiseIds as string[]).size !== promiseIds.length) return false;
    for (const id of signalIds as string[]) { if (!expectedSignalSet.has(id) || assignedSignals.has(id)) return false; assignedSignals.add(id); }
    for (const id of promiseIds as string[]) { if (!expectedPromiseSet.has(id) || assignedPromises.has(id)) return false; assignedPromises.add(id); }
    if (blueprintChapterNarrativeKeys.some((key) => !safeNarrative(record[key]))) return false;
  }
  return assignedSignals.size === expectedSignalSet.size && assignedPromises.size === expectedPromiseSet.size;
}
function canonicalBlueprintNarrative(value: Record<string, unknown>): { chronology: string; fields: string[] } {
  const ending = value.endingContract as Record<string, unknown>; const shared = value.sharedCause as Record<string, unknown>; const chapters = value.chapters as Array<Record<string, unknown>>;
  const orderedChapters = chapters.map((chapter, index) => ({ chapter, index })).sort((left, right) => Number(left.chapter.number) - Number(right.chapter.number) || left.index - right.index);
  const fields = [value.title, ...blueprintSharedNarrativeKeys.map((key) => shared[key]), ...orderedChapters.flatMap(({ chapter }) => blueprintChapterNarrativeKeys.map((key) => chapter[key])), ...blueprintEndingNarrativeKeys.map((key) => ending[key])]
    .filter((field): field is string => typeof field === "string");
  return { chronology: fields.join("\n"), fields };
}
function irreversibleBlueprintAssertion(field: string): boolean {
  return /\b(?:permanent(?:ly)?|irreversible|irreversibly|forever|never\s+again|beyond\s+repair|for\s+good)\b|(?:永久|永远|从此|再也|不可逆|无法(?:恢复|修复)|彻底(?:摧毁|毁灭|禁用|失效))/iu.test(field);
}
function blueprintPointer(root: unknown, pointer: string): unknown {
  if (pointer.length > MAX_BLUEPRINT_POINTER_LENGTH) return undefined;
  if (pointer === "") return root; if (!pointer.startsWith("/")) return undefined;
  let current: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) { if (!/^(?:0|[1-9]\d*)$/.test(key)) return undefined; current = current[Number(key)]; }
    else if (current && typeof current === "object" && Object.hasOwn(current, key)) current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
}
function validBlueprintVerdict(value: unknown, plan: ExperienceStagePlan): value is SemanticBlueprintVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false; const verdict = value as Record<string, unknown>;
  const expectedSignalCount = plan.promptProjection.dimensions.reduce((count, dimension) => count + dimension.signalIds.length, 0);
  const expectedPromiseCount = plan.hardPresencePromiseIds.length; const expectedDimensionCount = plan.promptProjection.dimensions.length;
  if (!sameStringMultiset(Object.keys(verdict), ["confidence", "ending", "kind", "promises", "sharedCause", "signals", "version"]) || verdict.version !== 1 || verdict.kind !== "blueprint" || typeof verdict.confidence !== "number" || !Number.isFinite(verdict.confidence) || verdict.confidence < 0 || verdict.confidence > 1 || !Array.isArray(verdict.signals) || verdict.signals.length !== expectedSignalCount || verdict.signals.length > MAX_SEMANTIC_CLAIMS || !Array.isArray(verdict.promises) || verdict.promises.length !== expectedPromiseCount || verdict.promises.length > MAX_BLUEPRINT_IDS_PER_CHAPTER) return false;
  const exact = (item: unknown, keys: string[]): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item) && sameStringMultiset(Object.keys(item), keys);
  if (!verdict.signals.every((item) => exact(item, ["dimensionId", "signalId", "pointer", "supported"]) && safeBoundedString(item.dimensionId, MAX_BLUEPRINT_ID_LENGTH) && safeBoundedString(item.signalId, MAX_BLUEPRINT_ID_LENGTH) && safeBoundedString(item.pointer, MAX_BLUEPRINT_POINTER_LENGTH) && typeof item.supported === "boolean")) return false;
  if (!verdict.promises.every((item) => exact(item, ["promiseId", "pointer", "supported"]) && safeBoundedString(item.promiseId, MAX_BLUEPRINT_ID_LENGTH) && safeBoundedString(item.pointer, MAX_BLUEPRINT_POINTER_LENGTH) && typeof item.supported === "boolean")) return false;
  const ending = verdict.ending; const shared = verdict.sharedCause;
  return exact(ending, ["targetPointer", "costPointer", "supported", "systemState", "protagonistOutcome", "hasRealCost"]) && safeBoundedString(ending.targetPointer, MAX_BLUEPRINT_POINTER_LENGTH) && safeBoundedString(ending.costPointer, MAX_BLUEPRINT_POINTER_LENGTH, false) && typeof ending.supported === "boolean" && ["available", "unavailable", "not_applicable"].includes(ending.systemState as string) && ["fulfilled", "defeated", "unresolved"].includes(ending.protagonistOutcome as string) && typeof ending.hasRealCost === "boolean" && exact(shared, ["pointer", "dimensionIds", "supported"]) && safeBoundedString(shared.pointer, MAX_BLUEPRINT_POINTER_LENGTH) && Array.isArray(shared.dimensionIds) && shared.dimensionIds.length === expectedDimensionCount && shared.dimensionIds.every((id) => safeBoundedString(id, MAX_BLUEPRINT_ID_LENGTH)) && typeof shared.supported === "boolean";
}
function validateBlueprintSemantics(value: Record<string, unknown>, verdict: SemanticBlueprintVerdict, plan: ExperienceStagePlan, signals: ObservableSignalV2[]): EvidenceFinding | undefined {
  if (verdict.confidence < .65) return { ruleId: "blueprint.confidence_insufficient", severity: "rewrite" };
  const ids = unique([...plan.promptProjection.dimensions.flatMap((dimension) => [dimension.id, ...dimension.signalIds]), ...plan.hardPresencePromiseIds]);
  const substantive = (candidate: unknown): candidate is string => {
    if (typeof candidate !== "string" || candidate.trim().length < 8) return false;
    if (/(?:本章|信号|承诺|维度|标签|读者|作者|体验词)|\b(?:chapter|signal|promise|dimension|label|reader|author|descriptor)s?\b/iu.test(candidate)) return false;
    let remainder = candidate.normalize("NFKC").toLocaleLowerCase();
    for (const id of [...ids].sort((left, right) => right.length - left.length)) remainder = remainder.split(id.normalize("NFKC").toLocaleLowerCase()).join(" ");
    for (const description of signals.map((signal) => signal.description.normalize("NFKC").toLocaleLowerCase().trim()).filter((text) => text.length >= 4).sort((left, right) => right.length - left.length)) remainder = remainder.split(description).join(" ");
    return remainder.replace(/[^\p{L}\p{N}]+/gu, "").length >= 6;
  };
  const chapterAt = (pointer: string): Record<string, unknown> | undefined => {
    const match = /^\/chapters\/(0|[1-9]\d*)\/event$/.exec(pointer); if (!match) return undefined;
    const chapter = (value.chapters as unknown[])[Number(match[1])]; return chapter && typeof chapter === "object" && !Array.isArray(chapter) ? chapter as Record<string, unknown> : undefined;
  };
  const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const compareSignal = (left: { dimensionId: string; signalId: string }, right: { dimensionId: string; signalId: string }) => compareText(left.dimensionId, right.dimensionId) || compareText(left.signalId, right.signalId);
  const expectedSignals = plan.promptProjection.dimensions.flatMap((dimension) => dimension.signalIds.map((signalId) => ({ dimensionId: dimension.id, signalId }))).sort(compareSignal);
  const suppliedSignals = verdict.signals.map(({ dimensionId, signalId }) => ({ dimensionId, signalId })).sort(compareSignal);
  const sameSignals = suppliedSignals.length === expectedSignals.length && suppliedSignals.every((item, index) => item.dimensionId === expectedSignals[index]?.dimensionId && item.signalId === expectedSignals[index]?.signalId);
  if (!sameSignals || verdict.signals.some((item) => { const chapter = chapterAt(item.pointer); return !item.supported || !chapter || !substantive(blueprintPointer(value, item.pointer)) || !Array.isArray(chapter.signalIds) || !chapter.signalIds.includes(item.signalId); })) return { ruleId: "blueprint.signal_unsupported", severity: "rewrite" };
  const expectedPromises = [...plan.hardPresencePromiseIds]; const suppliedPromises = verdict.promises.map((item) => item.promiseId);
  if (!sameStringMultiset(suppliedPromises, expectedPromises) || verdict.promises.some((item) => { const chapter = chapterAt(item.pointer); return !item.supported || !chapter || !substantive(blueprintPointer(value, item.pointer)) || !Array.isArray(chapter.promiseIds) || !chapter.promiseIds.includes(item.promiseId); })) return { ruleId: "blueprint.promise_unsupported", severity: "rewrite" };
  const target = blueprintPointer(value, verdict.ending.targetPointer); const cost = blueprintPointer(value, verdict.ending.costPointer);
  const canonicalEnding = value.endingContract as Record<string, unknown>; const canonicalShared = value.sharedCause as Record<string, unknown>; const chapters = value.chapters as Array<Record<string, unknown>>;
  const canonicalTarget = canonicalEnding.target; const canonicalCost = canonicalEnding.cost;
  const mechanicGuarantee = plan.ruleAdapterIds.includes("curated-mechanic-unavailable"); const outcomeGuarantee = plan.ruleAdapterIds.includes("curated-outcome-weakened");
  const canonicalNarrative = canonicalBlueprintNarrative(value);
  const violatedGuarantee = plan.ruleAdapterIds.some((id) => (id === "curated-mechanic-unavailable" || id === "curated-outcome-weakened") && (
    violatesNarrativeInvariant(id, canonicalNarrative.chronology, { protagonistAliases: plan.roleBindings.aliases, assertionMode: "blueprint" })
    || canonicalNarrative.fields.some((field) => irreversibleBlueprintAssertion(field) && violatesNarrativeInvariant(id, field, { protagonistAliases: plan.roleBindings.aliases, assertionMode: "blueprint" }))
  ));
  const noCostContract = (canonicalCost === undefined || typeof canonicalCost === "string" && !canonicalCost.trim()) && (verdict.ending.costPointer === "" || verdict.ending.costPointer === "/endingContract/cost");
  const costContract = verdict.ending.hasRealCost
    ? verdict.ending.costPointer === "/endingContract/cost" && substantive(canonicalCost) && substantive(cost)
    : noCostContract;
  if (!verdict.ending.supported || verdict.ending.targetPointer !== "/endingContract/target" || !substantive(canonicalTarget) || !substantive(target) || !costContract || (mechanicGuarantee && verdict.ending.systemState !== "available") || (outcomeGuarantee && verdict.ending.protagonistOutcome !== "fulfilled") || violatedGuarantee) return { ruleId: "blueprint.ending_unsupported", severity: "rewrite" };
  const expectedDimensions = plan.promptProjection.dimensions.map((dimension) => dimension.id); const shared = blueprintPointer(value, verdict.sharedCause.pointer);
  const sharedChapterPointer = unique(verdict.signals.map((item) => item.pointer)).find((pointer) => {
    if (!chapterAt(pointer)) return false;
    const linkedDimensions = unique(verdict.signals.filter((item) => item.pointer === pointer).map((item) => item.dimensionId));
    return sameStringMultiset(linkedDimensions, expectedDimensions);
  });
  if (!verdict.sharedCause.supported || verdict.sharedCause.pointer !== "/sharedCause/event" || !substantive(canonicalShared.event) || !substantive(shared) || !sameStringMultiset(verdict.sharedCause.dimensionIds, expectedDimensions) || !sharedChapterPointer) return { ruleId: "blueprint.shared_cause_unsupported", severity: "rewrite" };
  return undefined;
}
function patch(request: AssessExperienceRequest, signals: ObservableSignalV2[], evidence: ReturnType<typeof evidenceFromClaim>[], contract: AssessmentContractProjection): { patch: ExperienceLedgerPatch; candidates: CanonFactCandidateV2[]; missingPromises: string[] } {
  const deliveredSignalIdsByDimension = Object.fromEntries(request.plan.promptProjection.dimensions.map((dimension) => [dimension.id, evidence.filter((item) => item.dimensionId === dimension.id).map((item) => item.signalId)]));
  const candidates = evidence.flatMap((item) => { const signal = signals.find((candidate) => candidate.id === item.signalId)!; if (!(["cross_chapter", "whole_story"] as string[]).includes(signal.persistence) || !(item.observation.outcome || item.observation.relationshipOrStateChange)) return []; const kind: CanonFactCandidateV2["kind"] = signal.kind === "mechanic" ? "mechanic" : signal.kind === "relationship" ? "relationship" : "outcome"; const unsigned = cleanAuthorizationValue({ evidenceId: item.id, revisionId: item.chapterRevisionId, dimensionId: item.dimensionId, signalId: item.signalId, kind, observation: structuredClone(item.observation), anchors: item.anchors.map((anchor) => ({ ...anchor })) }); return [{ id: canonFactCandidateId(unsigned), ...unsigned }]; });
  const persistentResultsByDimension = Object.fromEntries(request.plan.promptProjection.dimensions.map((dimension) => [dimension.id, candidates.filter((candidate) => candidate.dimensionId === dimension.id).map(({ id, revisionId, kind }) => ({ id, revisionId, kind }))]));
  const promiseEvidenceLinks: Record<string, Record<string, string[]>> = {}; const missingPromises: string[] = [];
  for (const promiseId of request.plan.duePromiseIds) {
    const promise = contract.promises.find((item) => item.id === promiseId);
    if (!promise) { missingPromises.push(promiseId); continue; }
    const dimensions = promise.dimensionId === "both" ? contract.dimensions.map((dimension) => dimension.id) : [promise.dimensionId];
    const links: Record<string, string[]> = {};
    let complete = true;
    for (const dimensionId of dimensions) {
      const relevant = evidence.filter((item) => item.dimensionId === dimensionId);
      if (new Set(relevant.map((item) => item.signalId)).size < promise.minimumSignals) { complete = false; break; }
      links[dimensionId] = relevant.map((item) => item.id).sort();
    }
    if (!complete) missingPromises.push(promiseId); else promiseEvidenceLinks[promiseId] = links;
  }
  const newDebtsByDimension = Object.fromEntries(request.plan.promptProjection.dimensions.map((dimension) => [dimension.id, request.plan.newDebts.filter((debt) => debt.dimensionId === dimension.id).map(({ promiseId, dueByChapter }) => ({ promiseId, dueByChapter }))]));
  return { patch: { ticket: { ...request.plan.ticket }, expectedRevision: request.plan.ticket.ledgerRevision, nextRevision: request.plan.ticket.ledgerRevision + 1, contractRevisionId: request.plan.ticket.contractRevisionId, activationId: request.plan.ticket.activationId, branchId: request.plan.ticket.branchId, expectedCanonVersion: request.plan.ticket.expectedCanonVersion, chapterNumber: request.plan.chapterNumber, deliveredSignalIdsByDimension, persistentResultsByDimension, newDebtsByDimension, deliveredPromiseIds: Object.keys(promiseEvidenceLinks), evidenceIds: evidence.map((item) => item.id), canonFactCandidates: candidates.map((candidate) => structuredClone(candidate)), promiseEvidenceLinks }, candidates, missingPromises };
}

export async function assessExperience(input: AssessExperienceRequest, inputDeps: AssessorDependencies): Promise<ExperienceOperationResult<ExperienceAssessment>> {
  const ticketSecret = `${inputDeps.ticketSecret}`; const now = inputDeps.now.bind(inputDeps); const judge = inputDeps.semanticJudgePort?.judge?.bind(inputDeps.semanticJudgePort); const judgeTimeoutMs = inputDeps.judgeTimeoutMs ?? 15_000;
  if (!withinValueBudget(input, ASSESSMENT_REQUEST_BUDGET)) return invalidInputFailure("invalid_artifact");
  const request = snapshot(input); if (!request || !validArtifact(request.artifact)) return invalidInputFailure("invalid_artifact");
  const deps = { ...inputDeps, ticketSecret, now }; const read = inputDeps.statePort?.read?.bind(inputDeps.statePort); const consumeTicket = inputDeps.statePort?.consumeTicket?.bind(inputDeps.statePort); const bindArtifact = inputDeps.statePort?.bindArtifactDigest?.bind(inputDeps.statePort); if (!read || !consumeTicket || !judge) return failure(request, "state_unavailable");
  let before: AssessmentState; try { const value = snapshot(await read({ ticketId: request.plan.ticket.id, jobId: request.plan.ticket.jobId })); if (!validState(value)) return failure(request, "state_unavailable"); before = freeze(value); } catch { return failure(request, "state_unavailable"); }
  let auth: string | undefined; try { auth = authenticate(request, deps, before); } catch { return failure(request, "plan_mismatch"); } if (auth) return failure(request, auth); const contract = request.plan.assessmentContract; const signals = selectedSignals(request.plan); if (!signals) return failure(request, "plan_mismatch");
  let source: string; let artifactHash: string; try { source = sourceForArtifact(request.artifact); artifactHash = hashArtifact(request.artifact); } catch { return failure(request, "invalid_artifact"); }
  if (request.plan.expectedArtifactDigest && request.plan.expectedArtifactDigest !== artifactHash) return failure(request, "artifact_digest_mismatch");
  if (before.expectedArtifactDigest === null) {
    if (!bindArtifact) return failure(request, "state_unavailable");
    let bound = false; try { bound = !!await bindArtifact({ ticketId: request.plan.ticket.id, artifactBindingId: request.plan.artifactBindingId, artifactHash, expected: { activationId: request.plan.ticket.activationId, branchId: request.plan.ticket.branchId, canonVersion: request.plan.ticket.expectedCanonVersion, ledgerRevision: request.plan.ticket.ledgerRevision, attempt: request.plan.ticket.attempt, ...(request.plan.chapterId ? { chapterId: request.plan.chapterId } : {}), ...(request.plan.revisionId ? { revisionId: request.plan.revisionId } : {}), expectedArtifactDigest: null } }); } catch { return failure(request, "state_unavailable"); }
    if (!bound) return failure(request, "artifact_binding_conflict");
    let rebound: AssessmentState; try { const value = snapshot(await read({ ticketId: request.plan.ticket.id, jobId: request.plan.ticket.jobId })); if (!validState(value)) return failure(request, "state_unavailable"); rebound = freeze(value); } catch { return failure(request, "state_unavailable"); }
    if (!stateMatches(request.plan, rebound) || rebound.expectedArtifactDigest !== artifactHash || canonicalAuthorizationPayload({ ...before, expectedArtifactDigest: artifactHash }) !== canonicalAuthorizationPayload(rebound)) return failure(request, "state_changed");
    before = rebound;
  } else if (before.expectedArtifactDigest !== artifactHash) return failure(request, "artifact_digest_mismatch");
  if (request.artifact.kind === "blueprint") {
    const blueprint = request.artifact.value as Record<string, unknown>;
    if (!validBlueprint(blueprint, request.plan)) return issueRewrite(request, [{ ruleId: "blueprint.invalid_manifest", severity: "rewrite" }], deps, consumeTicket, before, artifactHash);
    const blueprintCase = freeze(snapshot({ version: 1 as const, contractRevisionId: contract.contractRevisionId, stage: request.plan.stage, artifactKind: request.artifact.kind, source, sourceHash: artifactHash, synthesis: snapshot(contract.synthesis)!, signals: signals.map((signal) => { const dimension = contract.dimensions.find((item) => item.id === signal.dimensionId)!; const projection = request.plan.promptProjection.dimensions.find((item) => item.id === signal.dimensionId)!; return { dimensionId: signal.dimensionId, signalId: signal.id, kind: signal.kind, interpretation: dimension.interpretation, description: signal.description, semanticSlots: signal.semanticSlots ? { ...signal.semanticSlots } : undefined, policy: snapshot(signal.verification)!, canonFactReferences: projection.factReferences.map((fact) => ({ ...fact })), prohibitions: [...dimension.prohibitions, ...contract.prohibitions.filter((item) => item.dimensionId === "both")].map(({ id, kind, description, severity, ruleAdapterId }) => ({ id, kind, description, severity, ...(ruleAdapterId ? { ruleAdapterId } : {}) })) }; }) }))!;
    let blueprintResult: unknown; const blueprintController = new AbortController(); let blueprintTimer: ReturnType<typeof setTimeout> | undefined;
    try { const deadline = new Promise<never>((_, reject) => { blueprintTimer = setTimeout(() => { blueprintController.abort(); reject(new Error("timeout")); }, judgeTimeoutMs); }); blueprintResult = await Promise.race([judge(blueprintCase, { signal: blueprintController.signal }), deadline]); }
    catch { return unavailable(request.plan.ticket.jobId); } finally { if (blueprintTimer) clearTimeout(blueprintTimer); }
    if (!withinValueBudget(blueprintResult, JUDGE_RESULT_BUDGET)) return invalidModel(request.plan.ticket.jobId);
    blueprintResult = snapshot(blueprintResult); if (!validBlueprintVerdict(blueprintResult, request.plan)) return invalidModel(request.plan.ticket.jobId); freeze(blueprintResult);
    const blueprintFinding = validateBlueprintSemantics(blueprint, blueprintResult, request.plan, signals); if (blueprintFinding) return issueRewrite(request, [blueprintFinding], deps, consumeTicket, before, artifactHash);
    let current: AssessmentState; try { const value = snapshot(await read({ ticketId: request.plan.ticket.id, jobId: request.plan.ticket.jobId })); if (!validState(value)) return failure(request, "state_unavailable"); current = freeze(value); } catch { return failure(request, "state_unavailable"); }
    if (!stateMatches(request.plan, current) || canonicalAuthorizationPayload(before) !== canonicalAuthorizationPayload(current)) return failure(request, "state_changed");
    if (!await consumeTicketSafely(consumeTicket, casInput(request, current, artifactHash, `blueprint_${artifactHash}`, "blueprint"))) return failure(request, "ticket_reused");
    return { ok: true, value: { status: "accepted", artifactKind: "blueprint", artifactHash } };
  }
  const allProhibitions = [...contract.prohibitions, ...contract.dimensions.flatMap((dimension) => dimension.prohibitions)]; const unknownAdapter = allProhibitions.find((prohibition) => prohibition.ruleAdapterId && !isRuleAdapterId(prohibition.ruleAdapterId)); if (unknownAdapter) return failure(request, "plan_mismatch");
  const globalAdapterFinding = request.plan.ruleAdapterIds.find((id) => (id === "curated-mechanic-unavailable" || id === "curated-outcome-weakened") && violatesNarrativeInvariant(id, source, { protagonistAliases: request.plan.roleBindings.aliases }));
  if (globalAdapterFinding) return issueRewrite(request, [{ ruleId: `prohibition.${globalAdapterFinding}`, severity: "rewrite" }], deps, consumeTicket, before, artifactHash);
  const judgeCase = freeze(snapshot({ version: 1 as const, contractRevisionId: contract.contractRevisionId, stage: request.plan.stage, artifactKind: request.artifact.kind, source, sourceHash: artifactHash, synthesis: snapshot(contract.synthesis)!, signals: signals.map((signal) => { const dimension = contract.dimensions.find((item) => item.id === signal.dimensionId)!; const projection = request.plan.promptProjection.dimensions.find((item) => item.id === signal.dimensionId)!; return { dimensionId: signal.dimensionId, signalId: signal.id, kind: signal.kind, interpretation: dimension.interpretation, description: signal.description, semanticSlots: signal.semanticSlots ? { ...signal.semanticSlots } : undefined, policy: snapshot(signal.verification)!, canonFactReferences: projection.factReferences.map((fact) => ({ ...fact })), prohibitions: [...dimension.prohibitions, ...contract.prohibitions.filter((item) => item.dimensionId === "both")].map(({ id, kind, description, severity, ruleAdapterId }) => ({ id, kind, description, severity, ...(ruleAdapterId ? { ruleAdapterId } : {}) })) }; }) }))!;
  let verdict: unknown; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; try { const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, judgeTimeoutMs); }); verdict = await Promise.race([judge(judgeCase, { signal: controller.signal }), deadline]); } catch { return unavailable(request.plan.ticket.jobId); } finally { if (timer) clearTimeout(timer); }
  if (!withinValueBudget(verdict, JUDGE_RESULT_BUDGET)) return invalidModel(request.plan.ticket.jobId);
  verdict = snapshot(verdict); if (!validVerdict(verdict, signals)) return invalidModel(request.plan.ticket.jobId); freeze(verdict);
  const sharedFinding = sharedCauseFinding(source, verdict, request.plan, signals); if (sharedFinding) return issueRewrite(request, [sharedFinding], deps, consumeTicket, before, artifactHash);
  let after: AssessmentState; try { const value = snapshot(await read({ ticketId: request.plan.ticket.id, jobId: request.plan.ticket.jobId })); if (!validState(value)) return failure(request, "state_unavailable"); after = freeze(value); } catch { return failure(request, "state_unavailable"); } if (!stateMatches(request.plan, after) || canonicalAuthorizationPayload(before) !== canonicalAuthorizationPayload(after)) return failure(request, "state_changed");
  const artifact = request.artifact;
  const bodyStart = artifact.title.length + 1;
  const claims = verdict.claims;
  const findings: EvidenceFinding[] = []; const grounded: Array<{ signal: ObservableSignalV2; value: GroundedClaim }> = []; const spans: Array<{ dimensionId: string; signalId: string; start: number; end: number; sharedAnchorIndex?: number }> = [];
  for (const claim of claims) { const signal = signals.find((candidate) => candidate.id === claim.signalId && candidate.dimensionId === claim.dimensionId); if (!signal) return invalidModel(request.plan.ticket.jobId); if (!claim.supported || claim.confidence < .65) { findings.push({ ruleId: "evidence.judge_unsupported", severity: "rewrite" }); continue; } const value = groundClaim(source, claim, signal, { bodyStart }); if ("ruleId" in value) { if (value.ruleId === "invalid_model_output") return invalidModel(request.plan.ticket.jobId); findings.push(value); continue; } const configuredAdapters = allProhibitions.filter((prohibition) => (prohibition.dimensionId === "both" || prohibition.dimensionId === signal.dimensionId) && prohibition.ruleAdapterId && isRuleAdapterId(prohibition.ruleAdapterId)).map((prohibition) => prohibition.ruleAdapterId as GenericRuleAdapterId); const local = localFinding(source, claim, value, signal, request.plan.roleBindings, configuredAdapters); if (local) { findings.push(local); continue; } for (const [anchorIndex, anchor] of value.anchors.entries()) { const sharedAnchorIndex = sharedAnchorIndexFor(verdict, claim, anchorIndex); const collision = spans.find((span) => anchor.start < span.end && span.start < anchor.end && !(span.dimensionId !== signal.dimensionId && span.start === anchor.start && span.end === anchor.end && span.sharedAnchorIndex !== undefined && span.sharedAnchorIndex === sharedAnchorIndex)); if (collision) findings.push({ ruleId: "evidence.double_counted_span", severity: "rewrite" }); spans.push({ dimensionId: signal.dimensionId, signalId: signal.id, start: anchor.start, end: anchor.end, ...(sharedAnchorIndex !== undefined ? { sharedAnchorIndex } : {}) }); } grounded.push({ signal, value }); }
  if (findings.length) return issueRewrite(request, findings, deps, consumeTicket, after, artifactHash);
  const evidence = grounded.map(({ signal, value }) => evidenceFromClaim({ id: createHash("sha256").update(canonicalAuthorizationPayload([request.plan.ticket.id, request.plan.ticket.jobId, request.plan.ticket.attempt, request.plan.ticket.contractRevisionId, request.plan.ticket.activationId, request.plan.ticket.branchId, request.plan.stage, artifact.kind, artifact.chapterId, artifact.revisionId, artifactHash, signal.dimensionId, signal.id, value.claim.eventId])).digest("base64url"), contractRevisionId: request.plan.ticket.contractRevisionId, activationId: request.plan.ticket.activationId, branchId: request.plan.ticket.branchId, chapterId: artifact.chapterId, revisionId: artifact.revisionId, sourceHash: artifactHash, ticketId: request.plan.ticket.id, jobId: request.plan.ticket.jobId, attempt: request.plan.ticket.attempt, stage: request.plan.stage, artifactKind: artifact.kind, ruleGraphVersion: request.plan.ticket.ruleGraphVersion, expectedCanonVersion: request.plan.ticket.expectedCanonVersion, ledgerRevision: request.plan.ticket.ledgerRevision, grounded: value }));
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length || evidence.some((item) => before.existingEvidenceIds.includes(item.id))) return failure(request, "evidence_id_collision"); const built = patch(request, signals, evidence, contract); if (built.missingPromises.length) return issueRewrite(request, built.missingPromises.map((id) => ({ ruleId: `promise.${id}.insufficient_evidence`, severity: "rewrite" })), deps, consumeTicket, after, artifactHash); const ledgerPatch = built.patch; const issued = permit(request, artifactHash, evidence, ledgerPatch, deps); const issuedAuthorization = { kind: "permit" as const, permitId: issued.permitId, permitDigest: publicationPermitDigest(issued), context: publicationPermitContext(issued) }; if (!await consumeTicketSafely(consumeTicket, casInput(request, after, artifactHash, issued.permitId, "accepted", evidence.map((item) => item.id), issuedAuthorization))) return failure(request, "ticket_reused");
  return { ok: true, value: { status: "accepted", artifactKind: request.artifact.kind, artifactHash, permit: issued, evidence, ledgerPatch, canonFactCandidates: built.candidates } };
}
