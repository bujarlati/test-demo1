import type { ExperienceLedgerV2 } from "../../src/types";
import type { ExperienceLedgerPatch, LedgerDependencies } from "./types";
import { ExperienceSchedulingError, verifyExperienceStageTicket } from "./scheduler";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertPatchCompatibility(ledger: ExperienceLedgerV2, patch: ExperienceLedgerPatch, deps: LedgerDependencies): void {
  if (ledger.consumedTicketIds.includes(patch.ticket.id)) throw new ExperienceSchedulingError("ticket_reused");
  if (!verifyExperienceStageTicket(patch.ticket, deps)) throw new ExperienceSchedulingError("ticket_tampered");
  const expiresAt = new Date(patch.ticket.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) throw new ExperienceSchedulingError("ticket_tampered");
  if (expiresAt <= deps.now().getTime()) throw new ExperienceSchedulingError("ticket_expired");
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
  const existingDebtIds = new Set(ledger.dimensions.flatMap((dimension) => dimension.debts).map((debt) => debt.promiseId));
  if (Object.values(patch.newDebtsByDimension).flat().some((debt) => existingDebtIds.has(debt.promiseId))) throw new ExperienceSchedulingError("invalid_debt");
  if (patch.deliveredPromiseIds.some((promiseId) => !deps.contract.promises.some((promise) => promise.id === promiseId))) throw new ExperienceSchedulingError("contract_mismatch");
}

/**
 * Applies a successful assessment as a single immutable compare-and-swap transition.
 * The patch is intentionally data-only: persistent results are canon references, never prose.
 */
export function applyExperienceLedgerPatch(ledger: ExperienceLedgerV2, patch: ExperienceLedgerPatch, deps: LedgerDependencies): ExperienceLedgerV2 {
  assertPatchCompatibility(ledger, patch, deps);
  const dimensions = ledger.dimensions.map((dimension) => {
    const delivered = patch.deliveredSignalIdsByDimension[dimension.dimensionId] ?? [];
    const persistent = patch.persistentResultsByDimension[dimension.dimensionId];
    const additions = patch.newDebtsByDimension[dimension.dimensionId] ?? [];
    const debts = [
      ...dimension.debts.filter((debt) => !patch.deliveredPromiseIds.includes(debt.promiseId)),
      ...additions,
    ].filter((debt, index, collection) => collection.findIndex((candidate) => candidate.promiseId === debt.promiseId && candidate.dueByChapter === debt.dueByChapter) === index).map((debt) => ({ ...debt }));
    return {
      ...dimension,
      lastDeliveredChapter: delivered.length ? patch.chapterNumber : dimension.lastDeliveredChapter,
      silentChapters: delivered.length ? 0 : dimension.silentChapters + 1,
      deliveredSignalIds: Array.from(new Set([...dimension.deliveredSignalIds, ...delivered])),
      persistentResults: persistent ? persistent.map((fact) => ({ ...fact })) : dimension.persistentResults.map((fact) => ({ ...fact })),
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
    history: [...ledger.history, {
      ticketId: patch.ticket.id,
      expectedRevision: patch.expectedRevision,
      nextRevision: patch.nextRevision,
      chapterNumber: patch.chapterNumber,
      appliedAt: deps.now().toISOString(),
    }],
  });
}
