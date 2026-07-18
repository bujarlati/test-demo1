import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CanonFactReferenceV2, CompiledExperienceContractRevision, DeliveryPromiseV2, ExperienceDimension, ObservableSignalV2 } from "../../src/types";
import type {
  ExperienceSchedulingErrorCode,
  ExperienceStage,
  ExperienceStagePlan,
  ExperienceStageTicket,
  ScheduleExperienceRequest,
  ScheduledExperienceDebt,
  SchedulerDependencies,
  GenericRuleAdapterId,
  LedgerEvidenceBinding,
  ExperiencePublicationPermit,
  AssessmentContractProjection,
} from "./types";
import { isRuleAdapterId } from "./ruleAdapters";
import { normalizeRoleBindings, validTrustedRoleBindings } from "./roles";

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
  const active = new WeakSet<object>();
  const invalid = (): never => { throw new ExperienceSchedulingError("invalid_authorization_payload"); };
  const visit = (input: unknown): string => {
    if (input === null) return "null";
    if (typeof input === "boolean" || typeof input === "string") return JSON.stringify(input);
    if (typeof input === "number") return Number.isFinite(input) ? JSON.stringify(input) : invalid();
    if (typeof input !== "object") return invalid();
    if (active.has(input)) return invalid();
    active.add(input);
    try {
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) return invalid();
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string") || keys.length !== input.length + 1 || !Object.hasOwn(descriptors, "length")) return invalid();
      const values: string[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const key = String(index); const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.value === undefined) return invalid();
        values.push(visit(descriptor.value));
      }
      return `[${values.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return invalid();
    const keys = Object.keys(descriptors).sort();
    if (keys.length !== Reflect.ownKeys(descriptors).length || keys.some((key) => !("value" in descriptors[key]) || !descriptors[key].enumerable)) return invalid();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${visit(descriptors[key].value)}`).join(",")}}`;
    } finally { active.delete(input); }
  };
  try { return visit(value); } catch (error) { if (error instanceof ExperienceSchedulingError) throw error; throw new ExperienceSchedulingError("invalid_authorization_payload"); }
}

export function signExperiencePlan(plan: Omit<ExperienceStagePlan, "authorizationMac">, secret: string): string {
  return createHmac("sha256", secret).update(canonicalAuthorizationPayload(plan)).digest("base64url");
}

export function assessmentContractIdentity(value: Omit<AssessmentContractProjection, "identityHash">): string {
  return createHash("sha256").update("reading-experience:assessment-contract:v1").update("\u001f").update(canonicalAuthorizationPayload(value)).digest("base64url");
}

export function contractRevisionId(body: Omit<CompiledExperienceContractRevision, "id">): string {
  const digest = createHash("sha256").update("reading-experience:contract-revision:v2").update("\u001f").update(canonicalAuthorizationPayload(body)).digest("base64url").slice(0, 22);
  return `experience_revision_${body.revision}_${digest}`;
}

export function contractRevisionIdentityMatches(contract: CompiledExperienceContractRevision): boolean {
  try { const { id, ...body } = contract; return id === contractRevisionId(body); } catch { return false; }
}

export function signLedgerAuthorizationRoot(plan: ExperienceStagePlan, canon: { branchId: string; canonVersion: number; factReferences: CanonFactReferenceV2[] }, evidenceBindings: LedgerEvidenceBinding[], authorizedPatchHash: string, publicationPermit: ExperiencePublicationPermit, secret: string): string {
  return createHmac("sha256", secret).update(canonicalAuthorizationPayload({ plan, canon, evidenceBindings, authorizedPatchHash, publicationPermit })).digest("base64url");
}

export function sameMac(left: string, right: string): boolean {
  const a = Buffer.from(left, "base64url");
  const b = Buffer.from(right, "base64url");
  return a.length === b.length && timingSafeEqual(a, b);
}

function derivedStage(request: ScheduleExperienceRequest): ExperienceStage {
  if (request.repair) return "rewrite";
  if (request.artifactKind === "blueprint") return "blueprint";
  if (request.artifactKind === "retcon_revision") return "retcon";
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
  if ((contract.id.startsWith("experience_revision_") || contract.provenance.length > 0) && !contractRevisionIdentityMatches(contract)) throw new ExperienceSchedulingError("contract_mismatch");
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

function softDueAndDebts(request: ScheduleExperienceRequest, chapter: number): { due: DeliveryPromiseV2[]; debts: ScheduledExperienceDebt[]; carried: string[] } {
  const due: DeliveryPromiseV2[] = [];
  const debts: ScheduledExperienceDebt[] = [];
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
    if (canEvaluateCompletedWindow && delivered < promise.scope.minimumDeliveries) {
      const dimensionIds = promise.dimensionId === "both" ? request.contract.dimensions.map((dimension) => dimension.id) : [promise.dimensionId];
      for (const dimensionId of dimensionIds) {
        const alreadyOwed = request.ledger.dimensions.find((dimension) => dimension.dimensionId === dimensionId)?.debts.some((debt) => debt.promiseId === promise.id) ?? false;
        if (!alreadyOwed) debts.push({ dimensionId, promiseId: promise.id, dueByChapter: chapter + (promise.compensationWindow ?? 1) - 1 });
      }
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

function scheduleTrusted(request: ScheduleExperienceRequest, deps: SchedulerDependencies): ExperienceStagePlan {
  assertScheduleCompatibility(request);
  const roles = normalizeRoleBindings(request.roleBindings);
  if (request.roleBindings?.version !== undefined && request.roleBindings.version !== 1) throw new ExperienceSchedulingError("invalid_authorization_payload");
  if (!validTrustedRoleBindings(roles) || (request.artifactKind !== "blueprint" && (!request.chapterId?.trim() || !request.revisionId?.trim()))) throw new ExperienceSchedulingError("invalid_authorization_payload");
  const chapter = chapterNumber(request);
  const stage = stageFor(request);
  const hard = activeHardPresence(request, chapter);
  if (request.contract.dimensions.some((dimension) => !hard.some((promise) => promise.dimensionId === dimension.id))) {
    throw new ExperienceSchedulingError("contract_mismatch");
  }
  const soft = softDueAndDebts(request, chapter);
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
    ...(request.chapterId ? { chapterId: request.chapterId } : {}),
    ...(request.revisionId ? { revisionId: request.revisionId } : {}),
    ...(request.expectedArtifactDigest ? { expectedArtifactDigest: request.expectedArtifactDigest } : {}),
    artifactBindingId: request.artifactBindingId ?? `binding_${stableToken(canonicalAuthorizationPayload([request.contract.id, request.activation.id, request.canon.branchId, request.chapterId ?? "blueprint", request.revisionId ?? "blueprint", request.jobId, request.attempt]))}`,
    roleBindings: roles,
    stage,
    artifactKind: request.artifactKind,
    assessmentContract: (() => {
      const body: Omit<AssessmentContractProjection, "identityHash"> = {
        version: 1,
        schemaVersion: request.contract.schemaVersion,
        contractRevisionId: request.contract.id,
        ruleGraphVersion: request.contract.ruleGraphVersion,
        synthesis: structuredClone(request.contract.synthesis),
        dimensions: request.contract.dimensions.map((dimension) => ({
          id: dimension.id,
          interpretation: dimension.interpretation,
          observableSignals: dimension.observableSignals.map((signal) => ({ id: signal.id, dimensionId: signal.dimensionId, kind: signal.kind, description: signal.description, ...(signal.semanticSlots ? { semanticSlots: { ...signal.semanticSlots } } : {}), verification: structuredClone(signal.verification), persistence: signal.persistence })),
          prohibitions: dimension.prohibitions.map((prohibition) => ({ id: prohibition.id, dimensionId: prohibition.dimensionId, kind: prohibition.kind, description: prohibition.description, severity: prohibition.severity, ...(prohibition.ruleAdapterId ? { ruleAdapterId: prohibition.ruleAdapterId } : {}) })),
        })),
        promises: request.contract.promises.map((promise) => ({ id: promise.id, dimensionId: promise.dimensionId, scope: structuredClone(promise.scope), hardness: promise.hardness, minimumSignals: promise.minimumSignals, carryRuleIds: [...promise.carryRuleIds], ...(promise.compensationWindow !== undefined ? { compensationWindow: promise.compensationWindow } : {}) })),
        prohibitions: request.contract.prohibitions.map((prohibition) => ({ id: prohibition.id, dimensionId: prohibition.dimensionId, kind: prohibition.kind, description: prohibition.description, severity: prohibition.severity, ...(prohibition.ruleAdapterId ? { ruleAdapterId: prohibition.ruleAdapterId } : {}) })),
      };
      return { ...body, identityHash: assessmentContractIdentity(body) };
    })(),
    promptProjection: {
      dimensions: dimensions.map(({ selected, ...projection }) => projection),
      prohibitions: request.contract.prohibitions.map((prohibition) => prohibition.description),
    },
    evidenceSchema: dimensions.flatMap((dimension) => dimension.selected.map((signal) => signal.verification)),
    ruleAdapterIds: request.contract.prohibitions.flatMap((prohibition) => prohibition.ruleAdapterId && isRuleAdapterId(prohibition.ruleAdapterId) ? [prohibition.ruleAdapterId as GenericRuleAdapterId] : []),
    duePromiseIds: [...hard, ...soft.due].map((promise) => promise.id),
    hardPresencePromiseIds: hard.map((promise) => promise.id),
    softRollingPromiseIds: request.contract.promises.filter((promise) => promise.hardness === "soft" && promise.scope.kind === "rolling_window").map((promise) => promise.id),
    dueSoftPromiseIds: soft.due.map((promise) => promise.id),
    carriedDebtPromiseIds: soft.carried,
    newDebts: soft.debts,
    repairRuleIds: request.repair ? [...new Set(request.repair.token.failedRuleIds)].sort() : [],
    ...(request.repair ? { repairAuthorization: { token: structuredClone(request.repair.token), expected: structuredClone(request.repair.expected), tokenDigest: createHash("sha256").update(canonicalAuthorizationPayload(request.repair.token)).digest("hex") } } : {}),
    ticket: { ...unsigned, signature: signExperienceStageTicket(unsigned, deps.ticketSecret) },
  };
  return deepFreeze(structuredClone({ ...unsignedPlan, authorizationMac: signExperiencePlan(unsignedPlan, deps.ticketSecret) }));
}

export function repairContext(token: import("./types").ExperienceRepairToken): import("./types").RepairTokenContext {
  const common = { ticketId: token.ticketId, jobId: token.jobId, attempt: token.attempt, contractRevisionId: token.contractRevisionId, activationId: token.activationId, branchId: token.branchId, stage: token.stage, artifactKind: token.artifactKind, ruleGraphVersion: token.ruleGraphVersion, expectedCanonVersion: token.expectedCanonVersion, ledgerRevision: token.ledgerRevision, chapterNumber: token.chapterNumber, artifactBindingId: token.artifactBindingId, roleBindings: token.roleBindings, artifactHash: token.artifactHash, failedRuleIds: token.failedRuleIds };
  return token.artifactKind === "blueprint" ? common as import("./types").RepairTokenContext : { ...common, chapterId: token.chapterId!, revisionId: token.revisionId! } as import("./types").RepairTokenContext;
}

export function verifyRepairAuthorization(token: import("./types").ExperienceRepairToken, expected: import("./types").RepairTokenContext, secret: string, now: Date): boolean {
  try {
    const { signature, ...unsigned } = token;
    const expectedSignature = createHmac("sha256", secret).update("reading-experience:repair:v1").update("\u001f").update(canonicalAuthorizationPayload(unsigned)).digest("base64url");
    return sameMac(signature, expectedSignature) && Number.isFinite(Date.parse(token.expiresAt)) && Date.parse(token.expiresAt) > now.getTime() && canonicalAuthorizationPayload(expected) === canonicalAuthorizationPayload(repairContext(token));
  } catch { return false; }
}

function authorizeRepair(request: ScheduleExperienceRequest, deps: SchedulerDependencies): ExperienceStagePlan {
  const repair = request.repair!; const token = repair.token; const { signature, ...unsigned } = token;
  void signature; void unsigned;
  if (!verifyRepairAuthorization(token, repair.expected, deps.ticketSecret, deps.now())) throw new ExperienceSchedulingError("plan_mismatch");
  const requestRoles = normalizeRoleBindings(request.roleBindings);
  if (request.attempt !== token.attempt + 1 || request.jobId !== token.jobId || request.contract.id !== token.contractRevisionId || request.contract.ruleGraphVersion !== token.ruleGraphVersion || request.activation.id !== token.activationId || request.canon.branchId !== token.branchId || request.canon.canonVersion !== token.expectedCanonVersion || request.ledger.revision !== token.ledgerRevision || request.artifactKind !== token.artifactKind || chapterNumber(request) !== token.chapterNumber || canonicalAuthorizationPayload(requestRoles) !== canonicalAuthorizationPayload(token.roleBindings) || request.artifactBindingId === token.artifactBindingId || request.expectedArtifactDigest === token.artifactHash || (token.artifactKind !== "blueprint" && (request.chapterId !== token.chapterId || request.revisionId !== token.revisionId))) throw new ExperienceSchedulingError("plan_mismatch");
  // Scheduling is a pure synchronous operation.  The authorization is carried
  // by the signed plan and consumed in the assessment CAS.
  const plan = scheduleTrusted(request, deps);
  if (plan.artifactBindingId === token.artifactBindingId || plan.expectedArtifactDigest === token.artifactHash) throw new ExperienceSchedulingError("plan_mismatch");
  return plan;
}

export function scheduleExperience(request: ScheduleExperienceRequest, deps: SchedulerDependencies): ExperienceStagePlan {
  if (request.failedRuleIds !== undefined) {
    if (!Array.isArray(request.failedRuleIds) || request.failedRuleIds.some((id) => typeof id !== "string" || !id.trim())) throw new ExperienceSchedulingError("plan_mismatch");
    const canonical = [...new Set(request.failedRuleIds)].sort();
    if (canonicalAuthorizationPayload(request.failedRuleIds) !== canonicalAuthorizationPayload(canonical)) throw new ExperienceSchedulingError("plan_mismatch");
    if (!request.repair && canonical.length > 0) throw new ExperienceSchedulingError("plan_mismatch");
    if (request.repair && canonicalAuthorizationPayload(canonical) !== canonicalAuthorizationPayload([...new Set(request.repair.token.failedRuleIds)].sort())) throw new ExperienceSchedulingError("plan_mismatch");
  }
  if (request.repair) return authorizeRepair(request, deps);
  if (request.stage === "rewrite") throw new ExperienceSchedulingError("invalid_stage");
  return scheduleTrusted(request, deps);
}
