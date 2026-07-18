import type { AssessmentState, AssessmentStatePort, RepairTokenContext } from "../../server/readingExperienceModule/types";
import { canonicalAuthorizationPayload } from "../../server/readingExperienceModule/scheduler";

type TicketInput = Parameters<AssessmentStatePort["consumeTicket"]>[0];
type PermitInput = Parameters<AssessmentStatePort["consumePermit"]>[0];
type RepairInput = Parameters<AssessmentStatePort["consumeRepair"]>[0];
type BindInput = Parameters<NonNullable<AssessmentStatePort["bindArtifactDigest"]>>[0];

interface RegisteredState { jobId: string; state: AssessmentState }

const same = (left: unknown, right: unknown) => canonicalAuthorizationPayload(left) === canonicalAuthorizationPayload(right);
const uniqueSorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** A test double that performs the same compare-and-swap checks expected from persistent storage. */
export class StrictAssessmentStatePort implements AssessmentStatePort {
  private readonly states = new Map<string, RegisteredState>();
  private readonly consumedTickets = new Set<string>();
  private readonly consumedPermits = new Set<string>();
  private readonly consumedRepairs = new Set<string>();
  private readonly evidenceIds = new Set<string>();
  private readonly repairRecords = new Map<string, { tokenDigest: string; expected: RepairTokenContext }>();
  private readonly permitRecords = new Map<string, { permitDigest: string; context: PermitInput["context"] }>();

  register(ticketId: string, jobId: string, state: AssessmentState): void {
    if (this.states.has(ticketId)) throw new Error("duplicate ticket state");
    const snapshot = structuredClone(state);
    snapshot.consumedTicketIds.forEach((id) => this.consumedTickets.add(id));
    snapshot.consumedPermitIds.forEach((id) => this.consumedPermits.add(id));
    snapshot.consumedRepairIds.forEach((id) => this.consumedRepairs.add(id));
    snapshot.existingEvidenceIds.forEach((id) => this.evidenceIds.add(id));
    this.states.set(ticketId, { jobId, state: snapshot });
  }

  mutate(ticketId: string, values: Partial<Pick<AssessmentState, "activationId" | "branchId" | "canonVersion" | "ledgerRevision" | "attempt" | "chapterId" | "revisionId" | "artifactBindingId" | "expectedArtifactDigest">>): void {
    const registered = this.states.get(ticketId); if (!registered) throw new Error("unknown ticket state");
    Object.assign(registered.state, structuredClone(values));
  }

  private registered(ticketId: string): RegisteredState | undefined { return this.states.get(ticketId); }

  private current(state: AssessmentState): AssessmentState {
    return {
      ...structuredClone(state),
      consumedTicketIds: uniqueSorted(this.consumedTickets),
      consumedPermitIds: uniqueSorted(this.consumedPermits),
      consumedRepairIds: uniqueSorted(this.consumedRepairs),
      existingEvidenceIds: uniqueSorted(this.evidenceIds),
    };
  }

  read(input: { ticketId: string; jobId: string }): AssessmentState {
    const registered = this.registered(input.ticketId);
    if (!registered || registered.jobId !== input.jobId) throw new Error("state unavailable");
    return this.current(registered.state);
  }

  private ticketExpected(state: AssessmentState): TicketInput["expected"] {
    return {
      activationId: state.activationId,
      branchId: state.branchId,
      canonVersion: state.canonVersion,
      ledgerRevision: state.ledgerRevision,
      attempt: state.attempt,
      ...(state.chapterId ? { chapterId: state.chapterId } : {}),
      ...(state.revisionId ? { revisionId: state.revisionId } : {}),
      artifactBindingId: state.artifactBindingId,
      ...(state.expectedArtifactDigest ? { expectedArtifactDigest: state.expectedArtifactDigest } : {}),
      existingEvidenceIds: uniqueSorted(this.evidenceIds),
    };
  }

  consumeTicket(input: TicketInput): boolean {
    const registered = this.registered(input.ticketId); if (!registered) return false;
    const state = registered.state; const newEvidence = [...input.newEvidenceIds];
    if (!same(input.expected, this.ticketExpected(state)) || !state.expectedArtifactDigest || input.artifactHash !== state.expectedArtifactDigest || this.consumedTickets.has(input.ticketId) || !input.outcomeId || new Set(newEvidence).size !== newEvidence.length || newEvidence.some((id) => this.evidenceIds.has(id))) return false;
    const issued = input.issuedAuthorization;
    if (input.outcome === "accepted") {
      if (!issued || issued.kind !== "permit" || issued.permitId !== input.outcomeId || this.permitRecords.has(issued.permitId) || issued.context.ticketId !== input.ticketId || issued.context.artifactHash !== input.artifactHash || !same([...issued.context.evidenceIds].sort(), [...newEvidence].sort())) return false;
    } else if (input.outcome === "rewrite") {
      if (!issued || issued.kind !== "repair" || issued.repairId !== input.outcomeId || this.repairRecords.has(issued.repairId) || issued.context.ticketId !== input.ticketId || issued.context.artifactHash !== input.artifactHash || newEvidence.length) return false;
    } else if (issued) return false;
    if (input.repairAuthorization) {
      const known = this.repairRecords.get(input.repairAuthorization.repairId);
      if (!known || this.consumedRepairs.has(input.repairAuthorization.repairId) || input.repairAuthorization.tokenDigest !== known.tokenDigest || !same(input.repairAuthorization.expected, known.expected)) return false;
    }
    this.consumedTickets.add(input.ticketId);
    newEvidence.forEach((id) => this.evidenceIds.add(id));
    if (input.repairAuthorization) this.consumedRepairs.add(input.repairAuthorization.repairId);
    if (issued?.kind === "permit") this.permitRecords.set(issued.permitId, { permitDigest: issued.permitDigest, context: structuredClone(issued.context) });
    if (issued?.kind === "repair") this.repairRecords.set(issued.repairId, { tokenDigest: issued.tokenDigest, expected: structuredClone(issued.context) });
    return true;
  }

  consumePermit(input: PermitInput): boolean {
    const registered = this.registered(input.ticketId); if (!registered) return false;
    const state = registered.state;
    const expected = { activationId: state.activationId, branchId: state.branchId, canonVersion: state.canonVersion, ledgerRevision: state.ledgerRevision, attempt: state.attempt, chapterId: state.chapterId, revisionId: state.revisionId, artifactBindingId: state.artifactBindingId, expectedArtifactDigest: state.expectedArtifactDigest };
    const known = this.permitRecords.get(input.permitId);
    if (!state.chapterId || !state.revisionId || !state.expectedArtifactDigest || !same(input.expected, expected) || !this.consumedTickets.has(input.ticketId) || this.consumedPermits.has(input.permitId) || !known || known.permitDigest !== input.permitDigest || !same(known.context, input.context)) return false;
    this.consumedPermits.add(input.permitId);
    return true;
  }

  consumeRepair(input: RepairInput): boolean {
    const registered = this.registered(input.ticketId); if (!registered) return false;
    const state = registered.state; const known = this.repairRecords.get(input.repairId);
    const expected = { activationId: state.activationId, branchId: state.branchId, canonVersion: state.canonVersion, ledgerRevision: state.ledgerRevision, attempt: state.attempt, ...(state.chapterId ? { chapterId: state.chapterId } : {}), ...(state.revisionId ? { revisionId: state.revisionId } : {}), artifactBindingId: state.artifactBindingId, expectedArtifactDigest: state.expectedArtifactDigest };
    if (!state.expectedArtifactDigest || !known || !same(input.expected, expected) || input.tokenDigest !== known.tokenDigest || this.consumedRepairs.has(input.repairId)) return false;
    this.consumedRepairs.add(input.repairId);
    return true;
  }

  bindArtifactDigest(input: BindInput): boolean {
    const registered = this.registered(input.ticketId); if (!registered) return false;
    const state = registered.state;
    const expected = { activationId: state.activationId, branchId: state.branchId, canonVersion: state.canonVersion, ledgerRevision: state.ledgerRevision, attempt: state.attempt, ...(state.chapterId ? { chapterId: state.chapterId } : {}), ...(state.revisionId ? { revisionId: state.revisionId } : {}), expectedArtifactDigest: null };
    if (state.expectedArtifactDigest !== null || state.artifactBindingId !== input.artifactBindingId || !same(input.expected, expected) || !input.artifactHash) return false;
    state.expectedArtifactDigest = input.artifactHash;
    return true;
  }
}
