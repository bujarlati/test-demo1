import type { ExperienceEvidenceV2, ExperienceLedgerV2 } from "../../src/types";
import type { ExperienceLedgerPatch, LedgerAuthorization, LedgerDependencies, LedgerEvidenceBinding } from "./types";
import { canonicalAuthorizationPayload, ExperienceSchedulingError, sameMac, signExperiencePlan, signLedgerAuthorizationRoot, verifyExperienceStageTicket } from "./scheduler";
import { canonFactCandidateId, cleanAuthorizationValue, evidenceBinding, ledgerPatchHash } from "./publication";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const authenticAuthorizations = new WeakSet<object>();

export function createLedgerAuthorization(
  plan: LedgerAuthorization["plan"],
  canon: LedgerAuthorization["canon"],
  evidence: ReadonlyArray<ExperienceEvidenceV2>,
  patch: ExperienceLedgerPatch,
  ticketSecret: string,
): LedgerAuthorization {
  try {
    const { authorizationMac, ...unsignedPlan } = plan;
    if (!sameMac(authorizationMac, signExperiencePlan(unsignedPlan, ticketSecret))) throw new ExperienceSchedulingError("plan_mismatch");
    if (!Array.isArray(evidence) || !validCandidates(patch.canonFactCandidates)) throw new ExperienceSchedulingError("invalid_authorization_payload");
    const evidenceById = new Map(evidence.map((item) => [item?.id, item]));
    if (evidenceById.size !== evidence.length || evidence.some((item) => !item || typeof item !== "object" || !item.id || !item.dimensionId || !item.signalId || !item.chapterRevisionId || !item.sourceHash)) throw new ExperienceSchedulingError("unauthorized_delivery");
    if (patch.canonFactCandidates.some((candidate) => { const source = evidenceById.get(candidate.evidenceId); return !source || candidate.revisionId !== source.chapterRevisionId || candidate.dimensionId !== source.dimensionId || candidate.signalId !== source.signalId || canonicalAuthorizationPayload(cleanAuthorizationValue(candidate.observation)) !== canonicalAuthorizationPayload(cleanAuthorizationValue(source.observation)) || canonicalAuthorizationPayload(candidate.anchors) !== canonicalAuthorizationPayload(source.anchors); })) throw new ExperienceSchedulingError("unauthorized_fact");
    const evidenceBindings = evidence.map(evidenceBinding).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    if (new Set(evidenceBindings.map((item) => item.evidenceId)).size !== evidenceBindings.length) throw new ExperienceSchedulingError("unauthorized_delivery");
    const authorizedPatchHash = ledgerPatchHash(patch);
    const snapshot = deepFreeze(structuredClone({ plan, canon, evidenceBindings, authorizedPatchHash, authorizationRootMac: signLedgerAuthorizationRoot(plan, canon, evidenceBindings, authorizedPatchHash, ticketSecret) })) as LedgerAuthorization;
    authenticAuthorizations.add(snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof ExperienceSchedulingError) throw error;
    throw new ExperienceSchedulingError("invalid_authorization_payload");
  }
}

function validCandidates(value: unknown): value is ExperienceLedgerPatch["canonFactCandidates"] {
  return Array.isArray(value) && value.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const item = candidate as Record<string, unknown>;
    if (Object.keys(item).sort().join("|") !== ["anchors", "dimensionId", "evidenceId", "id", "kind", "observation", "revisionId", "signalId"].sort().join("|")) return false;
    if ([item.id, item.evidenceId, item.revisionId, item.dimensionId, item.signalId].some((field) => typeof field !== "string" || !field) || !["mechanic", "relationship", "outcome"].includes(item.kind as string) || !item.observation || typeof item.observation !== "object" || Array.isArray(item.observation) || !Array.isArray(item.anchors)) return false;
    return item.anchors.length > 0 && item.anchors.every((anchor) => !!anchor && typeof anchor === "object" && !Array.isArray(anchor) && Number.isInteger((anchor as Record<string, unknown>).start) && Number.isInteger((anchor as Record<string, unknown>).end) && typeof (anchor as Record<string, unknown>).text === "string");
  });
}

function sameTicket(left: ExperienceLedgerPatch["ticket"], right: ExperienceLedgerPatch["ticket"]): boolean {
  return left.id === right.id
    && left.contractRevisionId === right.contractRevisionId
    && left.activationId === right.activationId
    && left.ledgerRevision === right.ledgerRevision
    && left.branchId === right.branchId
    && left.expectedCanonVersion === right.expectedCanonVersion
    && left.ruleGraphVersion === right.ruleGraphVersion
    && left.stage === right.stage
    && left.artifactKind === right.artifactKind
    && left.jobId === right.jobId
    && left.attempt === right.attempt
    && left.expiresAt === right.expiresAt
    && left.signature === right.signature;
}

function sameFact(left: { id: string; revisionId: string; kind: string }, right: { id: string; revisionId: string; kind: string }): boolean {
  return left.id === right.id && left.revisionId === right.revisionId && left.kind === right.kind;
}

function assertTrustedAuthorization(ledger: ExperienceLedgerV2, patch: ExperienceLedgerPatch, deps: LedgerDependencies): void {
  if (!patch.promiseEvidenceLinks || typeof patch.promiseEvidenceLinks !== "object" || Array.isArray(patch.promiseEvidenceLinks) || Object.values(patch.promiseEvidenceLinks).some((links) => !links || typeof links !== "object" || Array.isArray(links) || Object.values(links).some((ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== "string")))) throw new ExperienceSchedulingError("unauthorized_delivery");
  if (!validCandidates(patch.canonFactCandidates)) throw new ExperienceSchedulingError("invalid_authorization_payload");
  const { plan, canon, evidenceBindings, authorizedPatchHash } = deps.authorization;
  if (!authenticAuthorizations.has(deps.authorization)) throw new ExperienceSchedulingError("plan_mismatch");
  const { authorizationMac, ...unsignedPlan } = plan;
  if (!sameMac(authorizationMac, signExperiencePlan(unsignedPlan, deps.ticketSecret)) || !sameMac(deps.authorization.authorizationRootMac, signLedgerAuthorizationRoot(plan, canon, evidenceBindings, authorizedPatchHash, deps.ticketSecret)) || authorizedPatchHash !== ledgerPatchHash(patch)) throw new ExperienceSchedulingError("plan_mismatch");
  if (!sameTicket(plan.ticket, patch.ticket)
    || plan.chapterNumber !== patch.chapterNumber
    || plan.stage !== patch.ticket.stage
    || plan.artifactKind !== patch.ticket.artifactKind
    || canon.branchId !== ledger.branchId
    || canon.canonVersion !== ledger.throughCanonVersion) {
    throw new ExperienceSchedulingError("plan_mismatch");
  }
  if (deps.liveCanon.branchId !== ledger.branchId || deps.liveCanon.branchId !== patch.ticket.branchId || deps.liveCanon.canonVersion !== ledger.throughCanonVersion || deps.liveCanon.canonVersion !== patch.ticket.expectedCanonVersion) {
    throw new ExperienceSchedulingError("canon_version_mismatch");
  }
  const plannedDimensions = new Map(plan.promptProjection.dimensions.map((dimension) => [dimension.id, dimension]));
  const bindings = new Map(evidenceBindings.map((binding) => [binding.evidenceId, binding]));
  if (bindings.size !== evidenceBindings.length || evidenceBindings.some((binding) => !binding.evidenceId || !binding.dimensionId || !binding.signalId || !binding.chapterRevisionId || !binding.sourceHash || !/^[a-f\d]{64}$/i.test(binding.evidenceDigest) || binding.chapterRevisionId !== plan.revisionId || plan.expectedArtifactDigest !== undefined && binding.sourceHash !== plan.expectedArtifactDigest)) throw new ExperienceSchedulingError("unauthorized_delivery");
  const suppliedDimensionIds = new Set([
    ...Object.keys(patch.deliveredSignalIdsByDimension),
    ...Object.keys(patch.persistentResultsByDimension),
    ...Object.keys(patch.newDebtsByDimension),
  ]);
  if ([...suppliedDimensionIds].some((dimensionId) => !plannedDimensions.has(dimensionId))) throw new ExperienceSchedulingError("unauthorized_delivery");
  if ([...plannedDimensions.keys()].some((dimensionId) => !Object.hasOwn(patch.deliveredSignalIdsByDimension, dimensionId))) throw new ExperienceSchedulingError("unauthorized_delivery");
  for (const [dimensionId, signalIds] of Object.entries(patch.deliveredSignalIdsByDimension)) {
    const planned = plannedDimensions.get(dimensionId)!;
    if (new Set(signalIds).size !== signalIds.length || signalIds.length !== planned.signalIds.length || signalIds.some((signalId) => !planned.signalIds.includes(signalId))) throw new ExperienceSchedulingError("unauthorized_delivery");
  }
  if (new Set(patch.deliveredPromiseIds).size !== patch.deliveredPromiseIds.length || patch.deliveredPromiseIds.some((promiseId) => !plan.duePromiseIds.includes(promiseId)) || plan.hardPresencePromiseIds.some((promiseId) => !patch.deliveredPromiseIds.includes(promiseId))) throw new ExperienceSchedulingError("unauthorized_delivery");
  for (const promiseId of patch.deliveredPromiseIds) {
    const promise = deps.contract.promises.find((candidate) => candidate.id === promiseId)!;
    const relevantDimensions = promise.dimensionId === "both"
      ? deps.contract.dimensions.map((dimension) => dimension.id)
      : [promise.dimensionId];
    if (relevantDimensions.some((dimensionId) => (patch.deliveredSignalIdsByDimension[dimensionId] ?? []).length < promise.minimumSignals)) {
      throw new ExperienceSchedulingError("unauthorized_delivery");
    }
    const links = patch.promiseEvidenceLinks[promiseId];
    if (!links || Object.keys(links).sort().join("|") !== [...relevantDimensions].sort().join("|")) throw new ExperienceSchedulingError("unauthorized_delivery");
    const linked = relevantDimensions.flatMap((dimensionId) => links[dimensionId] ?? []);
    if (new Set(linked).size !== linked.length || linked.some((id) => !patch.evidenceIds.includes(id)) || relevantDimensions.some((dimensionId) => {
      const dimensionLinks = links[dimensionId] ?? []; const signalIds = dimensionLinks.map((id) => bindings.get(id)).filter((binding): binding is LedgerEvidenceBinding => !!binding && binding.dimensionId === dimensionId && (patch.deliveredSignalIdsByDimension[dimensionId] ?? []).includes(binding.signalId)).map((binding) => binding.signalId);
      return signalIds.length !== dimensionLinks.length || new Set(signalIds).size < promise.minimumSignals;
    })) throw new ExperienceSchedulingError("unauthorized_delivery");
  }
  if (Object.keys(patch.promiseEvidenceLinks).sort().join("|") !== [...patch.deliveredPromiseIds].sort().join("|")) throw new ExperienceSchedulingError("unauthorized_delivery");
  if (new Set(patch.evidenceIds).size !== patch.evidenceIds.length || patch.evidenceIds.length !== evidenceBindings.length || patch.evidenceIds.some((evidenceId) => !bindings.has(evidenceId))) throw new ExperienceSchedulingError("unauthorized_delivery");
  if (evidenceBindings.some((binding) => !plannedDimensions.get(binding.dimensionId)?.signalIds.includes(binding.signalId) || !(patch.deliveredSignalIdsByDimension[binding.dimensionId] ?? []).includes(binding.signalId))) throw new ExperienceSchedulingError("unauthorized_delivery");

  const candidateById = new Map(patch.canonFactCandidates.map((candidate) => [candidate.id, candidate]));
  if (candidateById.size !== patch.canonFactCandidates.length || patch.canonFactCandidates.some((candidate) => {
    const { id, ...unsigned } = candidate; const binding = bindings.get(candidate.evidenceId); const signal = deps.contract.dimensions.find((dimension) => dimension.id === candidate.dimensionId)?.observableSignals.find((item) => item.id === candidate.signalId);
    const expectedKind = signal?.kind === "mechanic" ? "mechanic" : signal?.kind === "relationship" ? "relationship" : "outcome";
    return !id || canonFactCandidateId(unsigned) !== id || !binding || binding.dimensionId !== candidate.dimensionId || binding.signalId !== candidate.signalId || binding.chapterRevisionId !== candidate.revisionId || candidate.revisionId !== plan.revisionId || !signal || !["cross_chapter", "whole_story"].includes(signal.persistence) || candidate.kind !== expectedKind || !Array.isArray(candidate.anchors) || !candidate.anchors.length || candidate.anchors.some((anchor) => !Number.isInteger(anchor.start) || !Number.isInteger(anchor.end) || anchor.start < 0 || anchor.end <= anchor.start || typeof anchor.text !== "string" || !anchor.text) || !(candidate.observation.outcome || candidate.observation.relationshipOrStateChange);
  })) throw new ExperienceSchedulingError("unauthorized_fact");
  const suppliedCandidateReferences = Object.entries(patch.persistentResultsByDimension).flatMap(([dimensionId, facts]) => facts.filter((fact) => candidateById.has(fact.id)).map((fact) => ({ dimensionId, fact })));
  if (suppliedCandidateReferences.length !== patch.canonFactCandidates.length || suppliedCandidateReferences.some(({ dimensionId, fact }) => { const candidate = candidateById.get(fact.id)!; return candidate.dimensionId !== dimensionId || !sameFact(candidate, fact); })) throw new ExperienceSchedulingError("unauthorized_fact");
  for (const [dimensionId, facts] of Object.entries(patch.persistentResultsByDimension)) {
    const planned = plannedDimensions.get(dimensionId)!;
    const hasCarrySignal = planned.signalIds.some((signalId) => deps.contract.dimensions.find((dimension) => dimension.id === dimensionId)?.observableSignals.some((signal) => signal.id === signalId && (signal.persistence === "cross_chapter" || signal.persistence === "whole_story")));
    if (new Set(facts.map((fact) => `${fact.id}:${fact.revisionId}:${fact.kind}`)).size !== facts.length || facts.length && !hasCarrySignal || facts.some((fact) => { const candidate = candidateById.get(fact.id); return candidate ? candidate.dimensionId !== dimensionId || !sameFact(candidate, fact) : !canon.factReferences.some((reference) => sameFact(reference, fact)) || !deps.liveCanon.factReferences.some((reference) => sameFact(reference, fact)); })) throw new ExperienceSchedulingError("unauthorized_fact");
  }
  for (const [dimensionId, debts] of Object.entries(patch.newDebtsByDimension)) {
    if (debts.some((debt) => !plan.newDebts.some((plannedDebt) => plannedDebt.promiseId === debt.promiseId && plannedDebt.dueByChapter === debt.dueByChapter))) {
      throw new ExperienceSchedulingError("unauthorized_delivery");
    }
    if (!plannedDimensions.has(dimensionId)) throw new ExperienceSchedulingError("unauthorized_delivery");
  }
  const compareText = (left: string, right: string) => left === right ? 0 : left < right ? -1 : 1;
  const compareDebt = (left: { dimensionId: string; promiseId: string; dueByChapter: number }, right: { dimensionId: string; promiseId: string; dueByChapter: number }) => compareText(left.dimensionId, right.dimensionId) || compareText(left.promiseId, right.promiseId) || left.dueByChapter - right.dueByChapter;
  const plannedDebts = plan.newDebts.map((debt) => ({ ...debt })).sort(compareDebt);
  const suppliedDebts = Object.entries(patch.newDebtsByDimension).flatMap(([dimensionId, debts]) => debts.map((debt) => ({ ...debt, dimensionId }))).sort(compareDebt);
  if (suppliedDebts.some((debt, index) => index > 0 && compareDebt(debt, suppliedDebts[index - 1]) === 0) || plannedDebts.length !== suppliedDebts.length || plannedDebts.some((debt, index) => compareDebt(debt, suppliedDebts[index]) !== 0)) throw new ExperienceSchedulingError("unauthorized_delivery");
  if (plan.dueSoftPromiseIds.some((promiseId) => !patch.deliveredPromiseIds.includes(promiseId) && !plan.newDebts.some((debt) => debt.promiseId === promiseId) && !plan.carriedDebtPromiseIds.includes(promiseId))) throw new ExperienceSchedulingError("unauthorized_delivery");
  if (ledger.dimensions.flatMap((dimension) => dimension.persistentResults).some((fact) => !deps.liveCanon.factReferences.some((reference) => sameFact(reference, fact)))) throw new ExperienceSchedulingError("unauthorized_fact");
}

function assertPatchCompatibility(ledger: ExperienceLedgerV2, patch: ExperienceLedgerPatch, deps: LedgerDependencies): void {
  if (ledger.consumedTicketIds.includes(patch.ticket.id)) throw new ExperienceSchedulingError("ticket_reused");
  if (!verifyExperienceStageTicket(patch.ticket, deps)) throw new ExperienceSchedulingError("ticket_tampered");
  const expiresAt = new Date(patch.ticket.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) throw new ExperienceSchedulingError("ticket_tampered");
  if (expiresAt <= deps.now().getTime()) throw new ExperienceSchedulingError("ticket_expired");
  assertTrustedAuthorization(ledger, patch, deps);
  if (patch.branchId !== ledger.branchId || patch.ticket.branchId !== ledger.branchId) throw new ExperienceSchedulingError("branch_mismatch");
  if (patch.contractRevisionId !== ledger.contractRevisionId || patch.ticket.contractRevisionId !== ledger.contractRevisionId) throw new ExperienceSchedulingError("contract_mismatch");
  if (deps.contract.id !== ledger.contractRevisionId || deps.contract.ruleGraphVersion !== patch.ticket.ruleGraphVersion) throw new ExperienceSchedulingError("contract_mismatch");
  if (patch.activationId !== ledger.activationId || patch.ticket.activationId !== ledger.activationId) throw new ExperienceSchedulingError("activation_mismatch");
  if (patch.expectedCanonVersion !== ledger.throughCanonVersion || patch.ticket.expectedCanonVersion !== ledger.throughCanonVersion) throw new ExperienceSchedulingError("canon_version_mismatch");
  if (patch.expectedRevision !== ledger.revision || patch.ticket.ledgerRevision !== ledger.revision || patch.nextRevision !== patch.expectedRevision + 1) {
    throw new ExperienceSchedulingError("ledger_revision_mismatch");
  }
  if (!Number.isInteger(patch.chapterNumber) || patch.chapterNumber < 1) throw new ExperienceSchedulingError("activation_not_effective");
  const softRolling = new Map(deps.contract.promises.filter((promise) => promise.hardness === "soft" && promise.scope.kind === "rolling_window").map((promise) => [promise.id, promise]));
  const invalidDebt = Object.entries(patch.newDebtsByDimension).some(([dimensionId, debts]) => debts.some((debt) => {
    const promise = softRolling.get(debt.promiseId);
    return !promise || (promise.dimensionId !== "both" && promise.dimensionId !== dimensionId) || !Number.isInteger(debt.dueByChapter) || debt.dueByChapter < patch.chapterNumber;
  }));
  if (invalidDebt) {
    throw new ExperienceSchedulingError("invalid_debt");
  }
  if (Object.entries(patch.newDebtsByDimension).some(([dimensionId, debts]) => debts.some((debt) =>
    ledger.dimensions.some((dimension) => dimension.dimensionId === dimensionId && dimension.debts.some((existing) => existing.promiseId === debt.promiseId)),
  ))) throw new ExperienceSchedulingError("invalid_debt");
  if (patch.deliveredPromiseIds.some((promiseId) => !deps.contract.promises.some((promise) => promise.id === promiseId))) throw new ExperienceSchedulingError("contract_mismatch");
}

/**
 * Applies a successful assessment as a single immutable compare-and-swap transition.
 * The patch is intentionally data-only: persistent results are canon references, never prose.
 */
function applyTrustedExperienceLedgerPatch(ledger: ExperienceLedgerV2, patch: ExperienceLedgerPatch, deps: LedgerDependencies): ExperienceLedgerV2 {
  assertPatchCompatibility(ledger, patch, deps);
  const dimensions = ledger.dimensions.map((dimension) => {
    const delivered = patch.deliveredSignalIdsByDimension[dimension.dimensionId] ?? [];
    const persistent = patch.persistentResultsByDimension[dimension.dimensionId];
    const additions = (patch.newDebtsByDimension[dimension.dimensionId] ?? []).map(({ promiseId, dueByChapter }) => ({ promiseId, dueByChapter }));
    const debts = [
      ...dimension.debts.filter((debt) => !patch.deliveredPromiseIds.includes(debt.promiseId)),
      ...additions,
    ].filter((debt, index, collection) => collection.findIndex((candidate) => candidate.promiseId === debt.promiseId && candidate.dueByChapter === debt.dueByChapter) === index).map((debt) => ({ ...debt }));
    return {
      ...dimension,
      lastDeliveredChapter: delivered.length ? patch.chapterNumber : dimension.lastDeliveredChapter,
      silentChapters: delivered.length ? 0 : dimension.silentChapters + 1,
      deliveredSignalIds: Array.from(new Set([...dimension.deliveredSignalIds, ...delivered])),
      persistentResults: [...dimension.persistentResults, ...(persistent ?? [])].filter((fact, index, collection) => collection.findIndex((candidate) => sameFact(candidate, fact)) === index).map((fact) => ({ ...fact })),
      debts,
    };
  });
  return deepFreeze({
    ...ledger,
    revision: patch.nextRevision,
    dimensions,
    evidenceIds: Array.from(new Set([...ledger.evidenceIds, ...patch.evidenceIds])),
    promiseStates: deps.contract.promises.filter((promise) => promise.hardness === "soft" && promise.scope.kind === "rolling_window").map((promise) => {
      const current = ledger.promiseStates.find((state) => state.promiseId === promise.id)?.deliveredChapters ?? [];
      return {
        promiseId: promise.id,
        deliveredChapters: patch.deliveredPromiseIds.includes(promise.id)
          ? Array.from(new Set([...current, patch.chapterNumber])).sort((left, right) => left - right)
          : [...current],
      };
    }),
    consumedTicketIds: [...ledger.consumedTicketIds, patch.ticket.id],
    history: [...ledger.history.map((entry) => ({ ...entry })), {
      ticketId: patch.ticket.id,
      expectedRevision: patch.expectedRevision,
      nextRevision: patch.nextRevision,
      chapterNumber: patch.chapterNumber,
      appliedAt: deps.now().toISOString(),
    }],
  });
}

export function applyExperienceLedgerPatch(ledger: ExperienceLedgerV2, patch: ExperienceLedgerPatch, deps: LedgerDependencies): ExperienceLedgerV2 {
  try { return applyTrustedExperienceLedgerPatch(ledger, patch, deps); }
  catch (error) {
    if (error instanceof ExperienceSchedulingError) throw error;
    throw new ExperienceSchedulingError("invalid_authorization_payload");
  }
}
