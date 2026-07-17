import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { applyExperienceLedgerPatch } from "../server/readingExperienceModule/ledger";
import { scheduleExperience, verifyExperienceStageTicket } from "../server/readingExperienceModule/scheduler";
import type { CompiledExperienceContractRevision, ExperienceContractActivation, ExperienceLedgerV2 } from "../src/types";

const secret = "schedule-test-secret";
const now = () => new Date("2026-07-17T00:00:00.000Z");

function contract(): CompiledExperienceContractRevision {
  const dimensions = ["dimension_action", "dimension_voice"].map((id, index) => ({
    id,
    descriptor: `descriptor-${index}`,
    interpretation: `interpretation-${index}`,
    categories: index === 0 ? ["mechanic", "relationship"] : ["voice", "pacing"],
    observableSignals: index === 0
      ? [
          { id: `${id}_mechanic`, dimensionId: id, kind: "mechanic" as const, description: "A concrete consequence changes a later choice.", verification: { kind: "event_slots" as const, requiredSlots: ["actor", "action", "outcome"], minimumAnchors: 2 }, persistence: "cross_chapter" as const },
          { id: `${id}_relationship`, dimensionId: id, kind: "relationship" as const, description: "A reciprocal action changes the relationship.", verification: { kind: "relationship_change" as const, requireReciprocalAction: true, minimumAnchors: 2 }, persistence: "cross_chapter" as const },
        ]
      : [
          { id: `${id}_voice`, dimensionId: id, kind: "voice" as const, description: "Voice is distributed through the chapter.", verification: { kind: "distribution" as const, metricIds: ["coverage"], minimumAnchors: 2, requireSemanticJudge: true }, persistence: "chapter" as const },
          { id: `${id}_pacing`, dimensionId: id, kind: "pacing" as const, description: "Pacing is distributed through the chapter.", verification: { kind: "distribution" as const, metricIds: ["beats"], minimumAnchors: 2, requireSemanticJudge: true }, persistence: "chapter" as const },
        ],
    prohibitions: [],
    confidence: 0.9,
  })) as unknown as CompiledExperienceContractRevision["dimensions"];
  return {
    id: "contract-r1", schemaVersion: 2, revision: 1, parentRevisionId: null,
    intent: { descriptors: [{ text: "alpha" }, { text: "beta" }], locale: "zh-CN" }, dimensions,
    synthesis: { sharedCause: "A shared cause grounds both dimensions.", dimensionRoles: ["action", "voice"] },
    promises: [
      { id: "hard-action", dimensionId: "dimension_action", scope: { kind: "every_chapter" }, hardness: "hard", minimumSignals: 1, carryRuleIds: [] },
      { id: "hard-voice", dimensionId: "dimension_voice", scope: { kind: "every_chapter" }, hardness: "hard", minimumSignals: 1, carryRuleIds: [] },
      { id: "soft-rolling", dimensionId: "dimension_action", scope: { kind: "rolling_window", chapters: 3, minimumDeliveries: 2 }, hardness: "soft", minimumSignals: 1, carryRuleIds: [], compensationWindow: 2 },
    ],
    prohibitions: [], ruleGraphVersion: "rules-v1", provenance: [], createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function activation(): ExperienceContractActivation {
  return { id: "activation-r1", contractRevisionId: "contract-r1", branchId: "branch-main", effectiveFromChapter: 2, effectiveFromCanonVersion: 7, effectiveThroughCanonVersion: null, activatedAt: "2026-07-01T00:00:00.000Z" };
}

function ledger(overrides: Partial<ExperienceLedgerV2> = {}): ExperienceLedgerV2 {
  return {
    contractRevisionId: "contract-r1", activationId: "activation-r1", revision: 3, branchId: "branch-main", throughCanonVersion: 7,
    dimensions: [
      { dimensionId: "dimension_action", lastDeliveredChapter: 1, silentChapters: 0, deliveredSignalIds: ["dimension_action_mechanic"], persistentResults: [{ id: "stale-ledger-fact", revisionId: "old", kind: "mechanic" }], debts: [] },
      { dimensionId: "dimension_voice", lastDeliveredChapter: 1, silentChapters: 0, deliveredSignalIds: ["dimension_voice_voice"], persistentResults: [], debts: [] },
    ],
    evidenceIds: [], promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }], consumedTicketIds: [], history: [],
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    contract: contract(), activation: activation(), ledger: ledger(),
    canon: { branchId: "branch-main", canonVersion: 7, factReferences: [{ id: "canon-fact", revisionId: "chapter-1", kind: "mechanic" }] },
    artifactKind: "chapter" as const, chapterNumber: 2, jobId: "job-1", attempt: 1,
    ...overrides,
  };
}

const deps = { now, ticketSecret: secret, ticketTtlMs: 60_000, createTicketId: () => "ticket-1", contract: contract() };

test("schedule binds stage, contract, branch, canon, ledger and attempt", () => {
  const plan = scheduleExperience(request(), deps);
  assert.equal(plan.stage, "opening");
  assert.equal(plan.ticket.expectedCanonVersion, 7);
  assert.equal(plan.ticket.ledgerRevision, 3);
  assert.equal(plan.ticket.attempt, 1);
  assert.equal(plan.duePromiseIds.length >= 2, true);
  assert.equal(plan.promptProjection.dimensions.length, 2);
  assert.deepEqual(plan.promptProjection.dimensions[0].factReferences, [{ id: "canon-fact", revisionId: "chapter-1", kind: "mechanic" }]);
  assert.equal(plan.evidenceSchema.filter((policy) => policy.kind === "distribution").length >= 2, true);
});

test("hard presence cannot become debt while soft rolling promises can", () => {
  const plan = scheduleExperience(request({ chapterNumber: 4, ledger: ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] }) }), deps);
  assert.deepEqual(plan.hardPresencePromiseIds, ["hard-action", "hard-voice"]);
  assert.deepEqual(plan.newDebts, [{ promiseId: "soft-rolling", dueByChapter: 5 }]);
});

test("stage selection and rolling boundaries are deterministic at N-1, N and N+1", () => {
  const before = scheduleExperience(request({ chapterNumber: 1, activation: { ...activation(), effectiveFromChapter: 1 }, ledger: ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1, 2] }] }) }), deps);
  const at = scheduleExperience(request({ chapterNumber: 2, activation: { ...activation(), effectiveFromChapter: 1 }, ledger: ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1, 2] }] }) }), deps);
  const after = scheduleExperience(request({ chapterNumber: 3, activation: { ...activation(), effectiveFromChapter: 1 }, ledger: ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1, 2] }] }) }), deps);
  assert.deepEqual([before.stage, at.stage, after.stage], ["opening", "continuation", "continuation"]);
  assert.deepEqual([before.newDebts, at.newDebts, after.newDebts], [[], [], []]);
});

test("scheduler rejects activation, branch, canon, and stale-ledger incompatibilities", () => {
  for (const [code, overrides] of [
    ["activation_not_effective", { chapterNumber: 1 }],
    ["branch_mismatch", { canon: { branchId: "branch-other", canonVersion: 7, factReferences: [] } }],
    ["canon_version_mismatch", { canon: { branchId: "branch-main", canonVersion: 6, factReferences: [] } }],
    ["stale_ledger", { ledger: ledger({ throughCanonVersion: 6 }) }],
    ["contract_mismatch", { ledger: ledger({ contractRevisionId: "contract-other" }) }],
    ["activation_mismatch", { ledger: ledger({ activationId: "activation-other" }) }],
  ] as const) {
    assert.throws(() => scheduleExperience(request(overrides), deps), { code });
  }
});

test("tickets use canonical fixed-field signing and reject tamper, expiry, reuse and cross-branch patches", () => {
  const plan = scheduleExperience(request(), deps);
  const ticket = plan.ticket;
  const payload = [ticket.id, ticket.contractRevisionId, ticket.activationId, ticket.ledgerRevision, ticket.branchId, ticket.expectedCanonVersion, ticket.ruleGraphVersion, ticket.stage, ticket.artifactKind, ticket.jobId, ticket.attempt, ticket.expiresAt].join("\u001f");
  assert.equal(ticket.signature, createHmac("sha256", secret).update(payload).digest("base64url"));
  assert.equal(verifyExperienceStageTicket(ticket, deps), true);
  const patch = { ticket, expectedRevision: 3, nextRevision: 4, contractRevisionId: "contract-r1", activationId: "activation-r1", branchId: "branch-main", expectedCanonVersion: 7, chapterNumber: 2, deliveredSignalIdsByDimension: { dimension_action: ["dimension_action_mechanic"], dimension_voice: ["dimension_voice_voice"] }, persistentResultsByDimension: { dimension_action: [{ id: "canon-fact", revisionId: "chapter-1", kind: "mechanic" }] }, newDebtsByDimension: {}, deliveredPromiseIds: ["soft-rolling"], evidenceIds: ["evidence-1"] };
  const updated = applyExperienceLedgerPatch(ledger(), patch, deps);
  assert.equal(updated.revision, 4);
  assert.equal(Object.isFrozen(updated), true);
  assert.equal(updated.history.length, 1);
  assert.throws(() => applyExperienceLedgerPatch(updated, patch, deps), { code: "ticket_reused" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...patch, ticket: { ...ticket, branchId: "branch-other" } }, deps), { code: "ticket_tampered" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...patch, branchId: "branch-other" }, deps), { code: "branch_mismatch" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...patch, ticket: { ...ticket, expiresAt: "2026-07-16T00:00:00.000Z" } }, deps), { code: "ticket_tampered" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...patch, ticket: { ...ticket, expiresAt: "2026-07-16T00:00:00.000Z", signature: createHmac("sha256", secret).update([ticket.id, ticket.contractRevisionId, ticket.activationId, ticket.ledgerRevision, ticket.branchId, ticket.expectedCanonVersion, ticket.ruleGraphVersion, ticket.stage, ticket.artifactKind, ticket.jobId, ticket.attempt, "2026-07-16T00:00:00.000Z"].join("\u001f")).digest("base64url") } }, deps), { code: "ticket_expired" });
});

test("ledger patches are immutable CAS updates and only soft debts are stored", () => {
  const plan = scheduleExperience(request({ chapterNumber: 4, ledger: ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] }) }), deps);
  const patch = { ticket: plan.ticket, expectedRevision: 3, nextRevision: 4, contractRevisionId: "contract-r1", activationId: "activation-r1", branchId: "branch-main", expectedCanonVersion: 7, chapterNumber: 4, deliveredSignalIdsByDimension: { dimension_action: ["dimension_action_mechanic"], dimension_voice: ["dimension_voice_voice"] }, persistentResultsByDimension: {}, newDebtsByDimension: { dimension_action: plan.newDebts }, deliveredPromiseIds: ["soft-rolling"], evidenceIds: [] };
  const initial = ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] });
  const updated = applyExperienceLedgerPatch(initial, patch, deps);
  assert.equal(initial.revision, 3);
  assert.equal(updated.dimensions.flatMap((dimension) => dimension.debts).every((debt) => debt.promiseId === "soft-rolling"), true);
  assert.deepEqual(updated.promiseStates, [{ promiseId: "soft-rolling", deliveredChapters: [1, 4] }]);
  assert.deepEqual(updated.dimensions.find((dimension) => dimension.dimensionId === "dimension_action")?.debts, [{ promiseId: "soft-rolling", dueByChapter: 5 }]);
  assert.throws(() => applyExperienceLedgerPatch(initial, { ...patch, newDebtsByDimension: { dimension_action: [{ promiseId: "hard-action", dueByChapter: 5 }] } }, deps), { code: "invalid_debt" });
  assert.throws(() => applyExperienceLedgerPatch(initial, { ...patch, expectedRevision: 2 }, deps), { code: "ledger_revision_mismatch" });
});
