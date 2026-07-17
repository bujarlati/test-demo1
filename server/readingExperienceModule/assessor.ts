import { createHmac, timingSafeEqual } from "node:crypto";
import type { CanonFactReferenceV2, ObservableSignalV2 } from "../../src/types";
import { evidenceFromClaim, groundClaim, hashArtifact, sourceForArtifact, type EvidenceFinding, type GroundedClaim } from "./evidence";
import { canonicalAuthorizationPayload, sameMac, signExperiencePlan, verifyExperienceStageTicket } from "./scheduler";
import type { AssessExperienceRequest, AssessorDependencies, ExperienceAssessment, ExperienceLedgerPatch, ExperienceOperationResult, ExperiencePublicationPermit, ExperienceStagePlan, SemanticEvidenceClaim } from "./types";
import { runRuleAdapter } from "./ruleAdapters";

function assessment(result: ExperienceAssessment): ExperienceOperationResult<ExperienceAssessment> { return { ok: true, value: result }; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function nowIso(deps: AssessorDependencies, ttl: number): string { return new Date(deps.now().getTime() + ttl).toISOString(); }
function sign(value: unknown, secret: string): string { return createHmac("sha256", secret).update(canonicalAuthorizationPayload(value)).digest("base64url"); }
function token(request: AssessExperienceRequest, failedRuleIds: string[], deps: AssessorDependencies): string {
  const expiry = nowIso(deps, deps.repairTtlMs ?? 5 * 60_000);
  const payload = { version: 1, ticketId: request.plan.ticket.id, jobId: request.plan.ticket.jobId, attempt: request.plan.ticket.attempt, artifactHash: safeHash(request), failedRuleIds: [...failedRuleIds].sort(), expiresAt: expiry };
  return `${Buffer.from(canonicalAuthorizationPayload(payload)).toString("base64url")}.${sign(payload, deps.ticketSecret)}`;
}
function safeHash(request: AssessExperienceRequest): string { try { return hashArtifact(request.artifact); } catch { return "invalid-artifact"; } }
function rewrite(request: AssessExperienceRequest, findings: EvidenceFinding[] | string[], deps: AssessorDependencies): ExperienceAssessment {
  const ids = unique(findings.map((item) => typeof item === "string" ? item : item.ruleId));
  return { status: "rewrite", artifactKind: request.artifact.kind, failedRuleIds: ids, repairToken: token(request, ids, deps), message: "Evidence must be grounded in the submitted artifact." };
}
function rejected(request: AssessExperienceRequest, ruleId: string): ExperienceAssessment { return { status: "rejected", artifactKind: request.artifact.kind, failedRuleIds: [ruleId], message: "Assessment authorization is invalid." }; }

function expectedStage(kind: AssessExperienceRequest["artifact"]["kind"], stage: string): boolean {
  return kind === "blueprint" ? stage === "blueprint" : kind === "retcon_revision" ? stage === "retcon" : stage === "opening" || stage === "continuation" || stage === "rewrite";
}
function authenticate(request: AssessExperienceRequest, deps: AssessorDependencies): string | undefined {
  const { plan } = request;
  if (!verifyExperienceStageTicket(plan.ticket, deps)) return "ticket_tampered";
  const expires = Date.parse(plan.ticket.expiresAt);
  if (!Number.isFinite(expires)) return "ticket_tampered";
  if (expires <= deps.now().getTime()) return "ticket_expired";
  const { authorizationMac, ...unsigned } = plan;
  if (!sameMac(authorizationMac, signExperiencePlan(unsigned, deps.ticketSecret))) return "plan_mismatch";
  if (plan.stage !== plan.ticket.stage || plan.artifactKind !== plan.ticket.artifactKind || plan.artifactKind !== request.artifact.kind || !expectedStage(request.artifact.kind, plan.stage)) return "stage_mismatch";
  if (request.artifact.kind !== "blueprint" && (!plan.chapterId || plan.chapterId !== request.artifact.chapterId)) return "chapter_mismatch";
  if (plan.ticket.contractRevisionId !== deps.contract.id || plan.ticket.ruleGraphVersion !== deps.contract.ruleGraphVersion) return "contract_mismatch";
  if (!Number.isInteger(plan.chapterNumber) || plan.chapterNumber < 1 || plan.ticket.attempt < 0 || !plan.ticket.jobId) return "plan_mismatch";
  return undefined;
}
function signalsForPlan(plan: ExperienceStagePlan, deps: AssessorDependencies): ObservableSignalV2[] | undefined {
  const contractById = new Map(deps.contract.dimensions.flatMap((dimension) => dimension.observableSignals.map((signal) => [signal.id, signal] as const)));
  const out: ObservableSignalV2[] = [];
  for (const dimension of plan.promptProjection.dimensions) {
    for (const id of dimension.signalIds) {
      const signal = contractById.get(id);
      if (!signal || signal.dimensionId !== dimension.id || out.some((value) => value.id === signal.id)) return undefined;
      out.push(signal);
    }
  }
  return out.length && plan.evidenceSchema.length === out.length && plan.evidenceSchema.every((policy, index) => canonicalAuthorizationPayload(policy) === canonicalAuthorizationPayload(out[index].verification)) ? out : undefined;
}
const unrealized = /\b(?:not|never|no|cannot|can't|did not|didn't|plan(?:s|ned)?|intend(?:s|ed)?|attempt(?:s|ed)?|try|tries|dream(?:s|ed)?|simulation|predict(?:s|ed)?|would|could|might|hearsay|rumou?r|label|descriptor)\b|(?:不|未|没有|计划|打算|试图|梦境|模拟|预测|据说|标签|描述词)/i;
function claimText(source: string, grounded: GroundedClaim): string { return grounded.anchors.map((anchor) => source.slice(anchor.start, anchor.end)).join(" "); }
function localFinding(source: string, claim: SemanticEvidenceClaim, grounded: GroundedClaim, signal: ObservableSignalV2): EvidenceFinding | undefined {
  const text = claimText(source, grounded);
  if (unrealized.test(text)) return { ruleId: "evidence.not_realized", severity: "rewrite", dimensionId: signal.dimensionId };
  const slots = claim.slots ?? {};
  const present = (name: string): boolean => typeof slots[name as keyof typeof slots] === "string" && !!slots[name as keyof typeof slots]?.trim() && text.toLocaleLowerCase().includes((slots[name as keyof typeof slots] as string).toLocaleLowerCase());
  const categorySlots: Partial<Record<ObservableSignalV2["kind"], Array<"actor" | "action" | "outcome" | "reaction">>> = {
    mechanic: ["actor", "action", "outcome"], protagonist_action: ["actor", "action"], conflict_outcome: ["actor", "action", "outcome"], world_reaction: ["actor", "reaction"],
  };
  const required = signal.verification.kind === "event_slots" ? [...signal.verification.requiredSlots, ...(categorySlots[signal.kind] ?? [])] : [];
  if (required.some((slot) => !present(slot))) return { ruleId: "evidence.required_slot_missing", severity: "rewrite", dimensionId: signal.dimensionId };
  if (signal.semanticSlots && Object.entries(signal.semanticSlots).some(([slot, expected]) => slots[slot as keyof typeof slots] !== expected)) return { ruleId: "evidence.binding_mismatch", severity: "rewrite", dimensionId: signal.dimensionId };
  if (signal.kind === "relationship" && (!present("actor") || !present("action") || !present("reciprocalAction") || !present("relationshipChange"))) return { ruleId: "evidence.relationship_not_reciprocal", severity: "rewrite", dimensionId: signal.dimensionId };
  return undefined;
}
function adapterFindings(source: string, deps: AssessorDependencies): EvidenceFinding[] {
  return deps.contract.prohibitions.flatMap((prohibition) => prohibition.ruleAdapterId && runRuleAdapter(prohibition.ruleAdapterId, source) ? [{ ruleId: prohibition.id, severity: prohibition.severity === "block" ? "rejected" as const : "rewrite" as const }] : []);
}
function permit(request: AssessExperienceRequest, hash: string, deps: AssessorDependencies): ExperiencePublicationPermit {
  if (request.artifact.kind === "blueprint") throw new Error("blueprint has no permit");
  const expiresAt = nowIso(deps, deps.permitTtlMs ?? 10 * 60_000);
  const unsigned = { version: 1 as const, ticketId: request.plan.ticket.id, jobId: request.plan.ticket.jobId, attempt: request.plan.ticket.attempt, contractRevisionId: request.plan.ticket.contractRevisionId, activationId: request.plan.ticket.activationId, branchId: request.plan.ticket.branchId, chapterId: request.artifact.chapterId, revisionId: request.artifact.revisionId, artifactHash: hash, expiresAt };
  return { ...unsigned, signature: sign(unsigned, deps.ticketSecret) };
}
export function verifyPublicationPermit(value: ExperiencePublicationPermit, secret: string, now: Date): boolean {
  const { signature, ...unsigned } = value; const actual = Buffer.from(signature, "base64url"); const expected = Buffer.from(sign(unsigned, secret), "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected) && Date.parse(value.expiresAt) > now.getTime();
}
function patch(request: AssessExperienceRequest, signals: ObservableSignalV2[], evidence: ReturnType<typeof evidenceFromClaim>[], deps: AssessorDependencies): { ledgerPatch: ExperienceLedgerPatch; canonFactCandidates: CanonFactReferenceV2[] } {
  const deliveredSignalIdsByDimension: Record<string, string[]> = Object.fromEntries(request.plan.promptProjection.dimensions.map((dimension) => [dimension.id, dimension.signalIds.slice()]));
  const persistentResultsByDimension: Record<string, CanonFactReferenceV2[]> = {};
  for (const dimension of request.plan.promptProjection.dimensions) {
    const persistent = signals.filter((signal) => signal.dimensionId === dimension.id && (signal.kind === "mechanic" || signal.kind === "relationship") && (signal.persistence === "cross_chapter" || signal.persistence === "whole_story") && evidence.some((item) => item.signalId === signal.id));
    if (persistent.length) persistentResultsByDimension[dimension.id] = dimension.factReferences.map((fact) => ({ ...fact }));
  }
  const newDebtsByDimension: Record<string, { promiseId: string; dueByChapter: number }[]> = Object.fromEntries(request.plan.promptProjection.dimensions.map((dimension) => [dimension.id, request.plan.newDebts.filter((debt) => debt.dimensionId === dimension.id).map(({ promiseId, dueByChapter }) => ({ promiseId, dueByChapter }))]));
  return { ledgerPatch: { ticket: { ...request.plan.ticket }, expectedRevision: request.plan.ticket.ledgerRevision, nextRevision: request.plan.ticket.ledgerRevision + 1, contractRevisionId: request.plan.ticket.contractRevisionId, activationId: request.plan.ticket.activationId, branchId: request.plan.ticket.branchId, expectedCanonVersion: request.plan.ticket.expectedCanonVersion, chapterNumber: request.plan.chapterNumber, deliveredSignalIdsByDimension, persistentResultsByDimension, newDebtsByDimension, deliveredPromiseIds: request.plan.duePromiseIds.slice(), evidenceIds: evidence.map((item) => item.id) }, canonFactCandidates: Object.values(persistentResultsByDimension).flat() };
}

function hasValidVerdictShape(value: unknown): value is { version: 1; claims: SemanticEvidenceClaim[] } {
  if (!value || typeof value !== "object") return false;
  const verdict = value as Record<string, unknown>;
  if (verdict.version !== 1 || !Array.isArray(verdict.claims) || Object.keys(verdict).some((key) => key !== "version" && key !== "claims")) return false;
  return verdict.claims.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const claim = item as Record<string, unknown>;
    if (claim.version !== 1 || typeof claim.dimensionId !== "string" || typeof claim.signalId !== "string" || typeof claim.supported !== "boolean" || typeof claim.confidence !== "number" || !Number.isFinite(claim.confidence) || !Array.isArray(claim.anchors)) return false;
    if (Object.keys(claim).some((key) => !["version", "dimensionId", "signalId", "supported", "confidence", "anchors", "slots", "metrics"].includes(key))) return false;
    if (claim.slots !== undefined && (!claim.slots || typeof claim.slots !== "object" || Array.isArray(claim.slots) || Object.keys(claim.slots as Record<string, unknown>).some((key) => !["actor", "action", "object", "outcome", "reaction", "reciprocalAction", "relationshipChange"].includes(key)) || Object.values(claim.slots as Record<string, unknown>).some((slot) => typeof slot !== "string"))) return false;
    if (claim.metrics !== undefined && (!claim.metrics || typeof claim.metrics !== "object" || Array.isArray(claim.metrics) || Object.values(claim.metrics as Record<string, unknown>).some((metric) => typeof metric !== "number" || !Number.isFinite(metric)))) return false;
    return claim.anchors.every((anchor) => anchor && typeof anchor === "object" && !Array.isArray(anchor) && typeof (anchor as Record<string, unknown>).start === "number" && typeof (anchor as Record<string, unknown>).end === "number" && typeof (anchor as Record<string, unknown>).quote === "string" && Object.keys(anchor as Record<string, unknown>).every((key) => key === "start" || key === "end" || key === "quote"));
  });
}

export async function assessExperience(request: AssessExperienceRequest, deps: AssessorDependencies): Promise<ExperienceOperationResult<ExperienceAssessment>> {
  const auth = authenticate(request, deps); if (auth) return assessment(rejected(request, auth));
  const signals = signalsForPlan(request.plan, deps); if (!signals) return assessment(rejected(request, "plan_mismatch"));
  let source: string; let artifactHash: string;
  try { source = sourceForArtifact(request.artifact); artifactHash = hashArtifact(request.artifact); } catch { return assessment(rejected(request, "invalid_artifact")); }
  const deterministic = adapterFindings(source, deps); if (deterministic.length) return assessment(deterministic.some((item) => item.severity === "rejected") ? rejected(request, deterministic[0].ruleId) : rewrite(request, deterministic, deps));
  if (request.artifact.kind === "blueprint") return assessment({ status: "accepted", artifactKind: "blueprint", artifactHash });
  const artifact = request.artifact;
  let verdict;
  try { verdict = await deps.semanticJudgePort.judge({ version: 1, contractRevisionId: deps.contract.id, stage: request.plan.stage, artifactKind: request.artifact.kind, source, sourceHash: artifactHash, signals: signals.map((signal) => ({ dimensionId: signal.dimensionId, signalId: signal.id, kind: signal.kind, policy: signal.verification })) }); }
  catch (error) { return { ok: false, error: { code: "model_unavailable", message: error instanceof Error ? error.message : "semantic judge unavailable", stage: "assessment", retryable: true, jobId: request.plan.ticket.jobId } }; }
  if (!hasValidVerdictShape(verdict)) return { ok: false, error: { code: "invalid_model_output", message: "Semantic judge returned an invalid verdict.", stage: "assessment", retryable: false, jobId: request.plan.ticket.jobId } };
  const claimedIds = new Set<string>(); const findings: EvidenceFinding[] = []; const grounded: Array<{ signal: ObservableSignalV2; value: GroundedClaim }> = [];
  for (const claim of verdict.claims) {
    const signal = signals.find((candidate) => candidate.id === claim.signalId && candidate.dimensionId === claim.dimensionId);
    if (!signal || claimedIds.has(`${claim.dimensionId}:${claim.signalId}`)) { findings.push({ ruleId: "invalid_model_output", severity: "rewrite" }); continue; }
    claimedIds.add(`${claim.dimensionId}:${claim.signalId}`); if (!claim.supported) { findings.push({ ruleId: "evidence.judge_unsupported", severity: "rewrite", dimensionId: claim.dimensionId }); continue; }
    const value = groundClaim(source, claim, signal); if ("ruleId" in value) { findings.push(value); continue; }
    const local = localFinding(source, claim, value, signal); if (local) { findings.push(local); continue; }
    grounded.push({ signal, value });
  }
  if (claimedIds.size !== signals.length) findings.push({ ruleId: "evidence.missing_signal", severity: "rewrite" });
  const ownership = new Map<string, string>();
  for (const { signal, value } of grounded) for (const anchor of value.anchors) { const key = `${anchor.start}:${anchor.end}`; const prior = ownership.get(key); if (prior && prior !== signal.dimensionId) findings.push({ ruleId: "evidence.double_counted_span", severity: "rewrite", dimensionId: signal.dimensionId }); else ownership.set(key, signal.dimensionId); }
  if (findings.length) return assessment(rewrite(request, findings, deps));
  const evidence = grounded.map(({ signal, value }) => evidenceFromClaim({ id: deps.createEvidenceId?.({ ticketId: request.plan.ticket.id, signalId: signal.id, chapterId: artifact.chapterId, revisionId: artifact.revisionId }) ?? `${request.plan.ticket.id}:${signal.id}:${artifact.revisionId}`, contractRevisionId: request.plan.ticket.contractRevisionId, activationId: request.plan.ticket.activationId, branchId: request.plan.ticket.branchId, chapterId: artifact.chapterId, revisionId: artifact.revisionId, sourceHash: artifactHash, grounded: value }));
  const result = patch(request, signals, evidence, deps);
  return assessment({ status: "accepted", artifactKind: request.artifact.kind, artifactHash, permit: permit(request, artifactHash, deps), evidence, ...result });
}
