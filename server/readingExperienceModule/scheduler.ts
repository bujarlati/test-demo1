import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CanonFactReferenceV2, DeliveryPromiseV2, ExperienceDebtV2, ExperienceDimension, ObservableSignalV2 } from "../../src/types";
import type {
  ExperienceSchedulingErrorCode,
  ExperienceStage,
  ExperienceStagePlan,
  ExperienceStageTicket,
  ScheduleExperienceRequest,
  SchedulerDependencies,
} from "./types";

const ticketSeparator = "\u001f";

export class ExperienceSchedulingError extends Error {
  constructor(public readonly code: ExperienceSchedulingErrorCode) {
    super(code);
    this.name = "ExperienceSchedulingError";
  }
}

function ticketPayload(ticket: Omit<ExperienceStageTicket, "signature">): string {
  return [
    ticket.id,
    ticket.contractRevisionId,
    ticket.activationId,
    ticket.ledgerRevision,
    ticket.branchId,
    ticket.expectedCanonVersion,
    ticket.ruleGraphVersion,
    ticket.stage,
    ticket.artifactKind,
    ticket.jobId,
    ticket.attempt,
    ticket.expiresAt,
  ].join(ticketSeparator);
}

export function signExperienceStageTicket(ticket: Omit<ExperienceStageTicket, "signature">, secret: string): string {
  return createHmac("sha256", secret).update(ticketPayload(ticket)).digest("base64url");
}

export function verifyExperienceStageTicket(ticket: ExperienceStageTicket, deps: Pick<SchedulerDependencies, "ticketSecret">): boolean {
  const expected = signExperienceStageTicket(ticket, deps.ticketSecret);
  const supplied = Buffer.from(ticket.signature);
  const actual = Buffer.from(expected);
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

function stableToken(value: string): string { return createHash("sha256").update(value).digest("base64url"); }

export function canonicalAuthorizationPayload(value: unknown): string {
  const seen = new WeakSet<object>();
  const invalid = (): never => { throw new ExperienceSchedulingError("invalid_authorization_payload"); };
  const visit = (input: unknown): string => {
    if (input === null) return "null";
    if (typeof input === "boolean" || typeof input === "string") return JSON.stringify(input);
    if (typeof input === "number") return Number.isFinite(input) ? JSON.stringify(input) : invalid();
    if (typeof input !== "object") return invalid();
    if (seen.has(input)) return invalid();
    seen.add(input);
    if (Array.isArray(input)) {
      if (Object.keys(input).some((key) => !/^(0|[1-9][0-9]*)$/.test(key)) || input.length !== Object.keys(input).length) return invalid();
      return `[${Array.from({ length: input.length }, (_, index) => visit(input[index])).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.keys(descriptors).sort();
    if (keys.some((key) => !("value" in descriptors[key]) || !descriptors[key].enumerable)) return invalid();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${visit(descriptors[key].value)}`).join(",")}}`;
  };
  try { return visit(value); } catch (error) { if (error instanceof ExperienceSchedulingError) throw error; throw new ExperienceSchedulingError("invalid_authorization_payload"); }
}

export function signExperiencePlan(plan: Omit<ExperienceStagePlan, "authorizationMac">, secret: string): string {
  return createHmac("sha256", secret).update(canonicalAuthorizationPayload(plan)).digest("base64url");
}

export function signLedgerAuthorizationRoot(plan: ExperienceStagePlan, canon: { branchId: string; canonVersion: number; factReferences: CanonFactReferenceV2[] }, evidenceIds: string[], secret: string): string {
  return createHmac("sha256", secret).update(canonicalAuthorizationPayload({ plan, canon, evidenceIds })).digest("base64url");
}

export function sameMac(left: string, right: string): boolean {
  const a = Buffer.from(left, "base64url");
  const b = Buffer.from(right, "base64url");
  return a.length === b.length && timingSafeEqual(a, b);
}

function derivedStage(request: ScheduleExperienceRequest): ExperienceStage {
  if (request.artifactKind === "blueprint") return "blueprint";
  if (request.artifactKind === "retcon_revision") return "retcon";
  if (request.failedRuleIds?.length) return "rewrite";
  return request.chapterNumber === request.activation.effectiveFromChapter ? "opening" : "continuation";
}

function stageFor(request: ScheduleExperienceRequest): ExperienceStage {
  const expected = derivedStage(request);
  if (request.stage !== undefined && request.stage !== expected) throw new ExperienceSchedulingError("invalid_stage");
  return expected;
}

function chapterNumber(request: ScheduleExperienceRequest): number {
  const value = request.chapterNumber ?? request.activation.effectiveFromChapter;
  if (!Number.isInteger(value) || value < 1) throw new ExperienceSchedulingError("activation_not_effective");
  return value;
}

/** Validate only versioned identities; no narrative text participates in compatibility decisions. */
export function assertScheduleCompatibility(request: ScheduleExperienceRequest): void {
  const chapter = chapterNumber(request);
  const { activation, contract, ledger, canon } = request;
  if (activation.contractRevisionId !== contract.id || ledger.contractRevisionId !== contract.id) throw new ExperienceSchedulingError("contract_mismatch");
  if (ledger.activationId !== activation.id) throw new ExperienceSchedulingError("activation_mismatch");
  if (activation.branchId !== ledger.branchId || canon.branchId !== activation.branchId) throw new ExperienceSchedulingError("branch_mismatch");
  if (chapter < activation.effectiveFromChapter) throw new ExperienceSchedulingError("activation_not_effective");
  if (canon.canonVersion < activation.effectiveFromCanonVersion || (activation.effectiveThroughCanonVersion !== null && canon.canonVersion > activation.effectiveThroughCanonVersion)) {
    throw new ExperienceSchedulingError("canon_version_mismatch");
  }
  if (canon.canonVersion !== ledger.throughCanonVersion) throw new ExperienceSchedulingError("stale_ledger");
  if (canon.canonVersion !== activation.effectiveFromCanonVersion && activation.effectiveThroughCanonVersion === activation.effectiveFromCanonVersion) {
    throw new ExperienceSchedulingError("canon_version_mismatch");
  }
}

function matchesDimension(promise: DeliveryPromiseV2, dimensionId: string): boolean {
  return promise.dimensionId === "both" || promise.dimensionId === dimensionId;
}

function isChapterDue(promise: DeliveryPromiseV2, chapter: number): boolean {
  return promise.scope.kind === "every_chapter" || (promise.scope.kind === "chapter" && promise.scope.chapterNumber === chapter);
}

function activeHardPresence(request: ScheduleExperienceRequest, chapter: number): DeliveryPromiseV2[] {
  return request.contract.promises.filter((promise) => promise.hardness === "hard" && isChapterDue(promise, chapter));
}

function priorDeliveries(request: ScheduleExperienceRequest, promiseId: string): number[] {
  return request.ledger.promiseStates.find((state) => state.promiseId === promiseId)?.deliveredChapters ?? [];
}

function softDueAndDebts(request: ScheduleExperienceRequest, chapter: number): { due: DeliveryPromiseV2[]; debts: ExperienceDebtV2[]; carried: string[] } {
  const existing = new Set(request.ledger.dimensions.flatMap((dimension) => dimension.debts).map((debt) => debt.promiseId));
  const due: DeliveryPromiseV2[] = [];
  const debts: ExperienceDebtV2[] = [];
  const carried: string[] = [];
  for (const promise of request.contract.promises) {
    if (promise.hardness !== "soft") continue;
    if (promise.scope.kind !== "rolling_window") {
      if (isChapterDue(promise, chapter)) due.push(promise);
      continue;
    }
    const lower = Math.max(request.activation.effectiveFromChapter, chapter - promise.scope.chapters);
    const delivered = priorDeliveries(request, promise.id).filter((deliveredChapter) => deliveredChapter >= lower && deliveredChapter < chapter).length;
    const canEvaluateCompletedWindow = chapter >= request.activation.effectiveFromChapter + promise.scope.chapters;
    const carriedDebt = request.ledger.dimensions.flatMap((dimension) => dimension.debts).some((debt) => debt.promiseId === promise.id);
    if (carriedDebt) carried.push(promise.id);
    if (delivered < promise.scope.minimumDeliveries || carriedDebt) due.push(promise);
    if (canEvaluateCompletedWindow && delivered < promise.scope.minimumDeliveries && !existing.has(promise.id)) {
      debts.push({ promiseId: promise.id, dueByChapter: chapter + (promise.compensationWindow ?? 1) - 1 });
    }
  }
  return { due, debts, carried };
}

function rotatedSignals(signals: ObservableSignalV2[], chapter: number): ObservableSignalV2[] {
  if (!signals.length) return [];
  const offset = (chapter - 1) % signals.length;
  return [...signals.slice(offset), ...signals.slice(0, offset)];
}

function selectForDimension(dimension: ExperienceDimension, hard: DeliveryPromiseV2[], chapter: number): ObservableSignalV2[] {
  const selected = new Map<string, ObservableSignalV2>();
  // Distribution is a per-chapter obligation for voice and pacing, regardless of rotation.
  for (const signal of dimension.observableSignals) {
    if ((signal.kind === "voice" || signal.kind === "pacing") && signal.verification.kind === "distribution") selected.set(signal.id, signal);
  }
  const minimum = Math.max(1, ...hard.filter((promise) => matchesDimension(promise, dimension.id)).map((promise) => promise.minimumSignals));
  for (const signal of rotatedSignals(dimension.observableSignals, chapter)) {
    if (selected.size >= minimum) break;
    selected.set(signal.id, signal);
  }
  return [...selected.values()];
}

function assertDistributionRequirements(dimension: ExperienceDimension): void {
  for (const category of dimension.categories) {
    if ((category === "voice" || category === "pacing") && !dimension.observableSignals.some((signal) => signal.kind === category && signal.verification.kind === "distribution")) {
      throw new ExperienceSchedulingError("invalid_distribution");
    }
  }
}

function canonFactsFor(selected: ObservableSignalV2[], facts: CanonFactReferenceV2[]): CanonFactReferenceV2[] {
  const needsCarry = selected.some((signal) => (signal.kind === "mechanic" || signal.kind === "relationship") && (signal.persistence === "cross_chapter" || signal.persistence === "whole_story"));
  // The ledger contains delivery metadata, never source facts. Persistent prompts only receive current canon references.
  return needsCarry ? facts.map((fact) => ({ ...fact })) : [];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function scheduleExperience(request: ScheduleExperienceRequest, deps: SchedulerDependencies): ExperienceStagePlan {
  assertScheduleCompatibility(request);
  const chapter = chapterNumber(request);
  const stage = stageFor(request);
  const hard = activeHardPresence(request, chapter);
  if (request.contract.dimensions.some((dimension) => !hard.some((promise) => promise.dimensionId === dimension.id))) {
    throw new ExperienceSchedulingError("contract_mismatch");
  }
  const soft = softDueAndDebts(request, chapter);
  if (request.contract.promises.some((promise) => promise.hardness === "soft" && promise.scope.kind === "rolling_window" && promise.dimensionId === "both")) {
    throw new ExperienceSchedulingError("contract_mismatch");
  }
  const dimensions = request.contract.dimensions.map((dimension) => {
    assertDistributionRequirements(dimension);
    const selected = selectForDimension(dimension, [...hard, ...soft.due], chapter);
    return {
      id: dimension.id,
      interpretation: dimension.interpretation,
      signalIds: selected.map((signal) => signal.id),
      factReferences: canonFactsFor(selected, request.canon.factReferences),
      selected,
    };
  });
  for (const promise of [...hard, ...soft.due]) {
    const relevant = promise.dimensionId === "both" ? request.contract.dimensions.map((dimension) => dimension.id) : [promise.dimensionId];
    if (relevant.some((dimensionId) => new Set(dimensions.find((dimension) => dimension.id === dimensionId)?.signalIds ?? []).size < promise.minimumSignals)) {
      throw new ExperienceSchedulingError("insufficient_signals");
    }
  }
  const expiresAt = new Date(deps.now().getTime() + deps.ticketTtlMs).toISOString();
  const ticketId = deps.createTicketId?.(request) ?? `ticket_${stableToken(canonicalAuthorizationPayload([request.contract.id, request.activation.id, request.ledger.revision, request.canon.branchId, request.canon.canonVersion, stage, request.artifactKind, request.jobId, request.attempt]))}`;
  const unsigned: Omit<ExperienceStageTicket, "signature"> = {
    id: ticketId,
    contractRevisionId: request.contract.id,
    activationId: request.activation.id,
    ledgerRevision: request.ledger.revision,
    branchId: request.canon.branchId,
    expectedCanonVersion: request.canon.canonVersion,
    ruleGraphVersion: request.contract.ruleGraphVersion,
    stage,
    artifactKind: request.artifactKind,
    jobId: request.jobId,
    attempt: request.attempt,
    expiresAt,
  };
  const unsignedPlan: Omit<ExperienceStagePlan, "authorizationMac"> = {
    chapterNumber: chapter,
    stage,
    artifactKind: request.artifactKind,
    promptProjection: {
      dimensions: dimensions.map(({ selected, ...projection }) => projection),
      prohibitions: request.contract.prohibitions.map((prohibition) => prohibition.description),
    },
    evidenceSchema: dimensions.flatMap((dimension) => dimension.selected.map((signal) => signal.verification)),
    duePromiseIds: [...hard, ...soft.due].map((promise) => promise.id),
    hardPresencePromiseIds: hard.map((promise) => promise.id),
    softRollingPromiseIds: request.contract.promises.filter((promise) => promise.hardness === "soft" && promise.scope.kind === "rolling_window").map((promise) => promise.id),
    dueSoftPromiseIds: soft.due.map((promise) => promise.id),
    carriedDebtPromiseIds: soft.carried,
    newDebts: soft.debts,
    ticket: { ...unsigned, signature: signExperienceStageTicket(unsigned, deps.ticketSecret) },
  };
  return deepFreeze(structuredClone({ ...unsignedPlan, authorizationMac: signExperiencePlan(unsignedPlan, deps.ticketSecret) }));
}
