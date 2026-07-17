import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { applyExperienceLedgerPatch, createLedgerAuthorization } from "../server/readingExperienceModule/ledger";
import { scheduleExperience, signExperiencePlan, verifyExperienceStageTicket } from "../server/readingExperienceModule/scheduler";
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
      { dimensionId: "dimension_action", lastDeliveredChapter: 1, silentChapters: 0, deliveredSignalIds: ["dimension_action_mechanic"], persistentResults: [], debts: [] },
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

function ledgerDepsFor(plan: ReturnType<typeof scheduleExperience>) {
  const canon = request().canon;
  return { ...deps, authorization: createLedgerAuthorization(plan, canon, ["evidence-1"], secret), liveCanon: canon };
}

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
  const plan = scheduleExperience(request({ chapterNumber: 5, ledger: ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] }) }), deps);
  assert.deepEqual(plan.hardPresencePromiseIds, ["hard-action", "hard-voice"]);
  assert.deepEqual(plan.newDebts, [{ promiseId: "soft-rolling", dueByChapter: 6 }]);
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
  const patch = { ticket, expectedRevision: 3, nextRevision: 4, contractRevisionId: "contract-r1", activationId: "activation-r1", branchId: "branch-main", expectedCanonVersion: 7, chapterNumber: 2, deliveredSignalIdsByDimension: { dimension_action: ["dimension_action_relationship"], dimension_voice: ["dimension_voice_voice", "dimension_voice_pacing"] }, persistentResultsByDimension: {}, newDebtsByDimension: {}, deliveredPromiseIds: ["hard-action", "hard-voice", "soft-rolling"], evidenceIds: ["evidence-1"] };
  const trustedDeps = ledgerDepsFor(plan);
  const updated = applyExperienceLedgerPatch(ledger(), patch, trustedDeps);
  assert.equal(updated.revision, 4);
  assert.equal(Object.isFrozen(updated), true);
  assert.equal(updated.history.length, 1);
  assert.throws(() => applyExperienceLedgerPatch(updated, patch, trustedDeps), { code: "ticket_reused" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...patch, ticket: { ...ticket, branchId: "branch-other" } }, trustedDeps), { code: "ticket_tampered" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...patch, branchId: "branch-other" }, trustedDeps), { code: "branch_mismatch" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...patch, ticket: { ...ticket, expiresAt: "2026-07-16T00:00:00.000Z" } }, trustedDeps), { code: "ticket_tampered" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...patch, ticket: { ...ticket, expiresAt: "2026-07-16T00:00:00.000Z", signature: createHmac("sha256", secret).update([ticket.id, ticket.contractRevisionId, ticket.activationId, ticket.ledgerRevision, ticket.branchId, ticket.expectedCanonVersion, ticket.ruleGraphVersion, ticket.stage, ticket.artifactKind, ticket.jobId, ticket.attempt, "2026-07-16T00:00:00.000Z"].join("\u001f")).digest("base64url") } }, trustedDeps), { code: "ticket_expired" });
});

test("ledger patches are immutable CAS updates and only soft debts are stored", () => {
  const plan = scheduleExperience(request({ chapterNumber: 5, ledger: ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] }) }), deps);
  const patch = { ticket: plan.ticket, expectedRevision: 3, nextRevision: 4, contractRevisionId: "contract-r1", activationId: "activation-r1", branchId: "branch-main", expectedCanonVersion: 7, chapterNumber: 5, deliveredSignalIdsByDimension: { dimension_action: ["dimension_action_mechanic"], dimension_voice: ["dimension_voice_voice", "dimension_voice_pacing"] }, persistentResultsByDimension: {}, newDebtsByDimension: { dimension_action: plan.newDebts }, deliveredPromiseIds: ["hard-action", "hard-voice", "soft-rolling"], evidenceIds: ["evidence-1"] };
  const initial = ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }], history: [{ ticketId: "prior-ticket", expectedRevision: 2, nextRevision: 3, chapterNumber: 1, appliedAt: "2026-07-16T00:00:00.000Z" }] });
  const trustedDeps = ledgerDepsFor(plan);
  const updated = applyExperienceLedgerPatch(initial, patch, trustedDeps);
  assert.equal(initial.revision, 3);
  assert.equal(Object.isFrozen(initial.history[0]), false);
  assert.equal(updated.dimensions.flatMap((dimension) => dimension.debts).every((debt) => debt.promiseId === "soft-rolling"), true);
  assert.deepEqual(updated.promiseStates, [{ promiseId: "soft-rolling", deliveredChapters: [1, 5] }]);
  assert.deepEqual(updated.dimensions.find((dimension) => dimension.dimensionId === "dimension_action")?.debts, [{ promiseId: "soft-rolling", dueByChapter: 6 }]);
  assert.throws(() => applyExperienceLedgerPatch(initial, { ...patch, newDebtsByDimension: { dimension_action: [{ promiseId: "hard-action", dueByChapter: 6 }] } }, trustedDeps), { code: "unauthorized_delivery" });
  assert.throws(() => applyExperienceLedgerPatch(initial, { ...patch, expectedRevision: 2 }, trustedDeps), { code: "ledger_revision_mismatch" });
});

test("due soft promises raise the selected per-dimension minimum and overdue debt remains due", () => {
  const revised = contract();
  revised.promises.find((promise) => promise.id === "soft-rolling")!.minimumSignals = 2;
  const softPlan = scheduleExperience(request({ contract: revised }), deps);
  assert.equal(softPlan.promptProjection.dimensions.find((dimension) => dimension.id === "dimension_action")?.signalIds.length, 2);
  const insufficientPatch = {
    ticket: softPlan.ticket, expectedRevision: 3, nextRevision: 4, contractRevisionId: "contract-r1", activationId: "activation-r1", branchId: "branch-main", expectedCanonVersion: 7, chapterNumber: 2,
    deliveredSignalIdsByDimension: { dimension_action: ["dimension_action_relationship"], dimension_voice: ["dimension_voice_voice", "dimension_voice_pacing"] }, persistentResultsByDimension: {}, newDebtsByDimension: {}, deliveredPromiseIds: ["soft-rolling"], evidenceIds: [],
  };
  assert.throws(() => applyExperienceLedgerPatch(ledger(), insufficientPatch, { ...deps, contract: revised, authorization: createLedgerAuthorization(softPlan, request().canon, [], secret), liveCanon: request().canon }), { code: "unauthorized_delivery" });

  const carried = scheduleExperience(request({
    chapterNumber: 4,
    activation: { ...activation(), effectiveFromChapter: 1 },
    ledger: ledger({ dimensions: ledger().dimensions.map((dimension, index) => index === 0 ? { ...dimension, debts: [{ promiseId: "soft-rolling", dueByChapter: 1 }] } : dimension), promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1, 2] }] }),
  }), deps);
  assert.equal(carried.duePromiseIds.includes("soft-rolling"), true);
});

test("rolling windows start at activation and evaluate only after N active prior chapters", () => {
  const initial = ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] });
  const atNMinusOne = scheduleExperience(request({ chapterNumber: 4, ledger: initial }), deps);
  const atN = scheduleExperience(request({ chapterNumber: 5, ledger: initial }), deps);
  const atNPlusOne = scheduleExperience(request({ chapterNumber: 6, ledger: initial }), deps);
  assert.deepEqual(atNMinusOne.newDebts, []);
  assert.deepEqual(atN.newDebts, [{ promiseId: "soft-rolling", dueByChapter: 6 }]);
  assert.deepEqual(atNPlusOne.newDebts, [{ promiseId: "soft-rolling", dueByChapter: 7 }]);
});

test("supplied stage must agree with artifact, activation chapter, and retry state", () => {
  assert.equal(scheduleExperience(request({ stage: "blueprint", artifactKind: "blueprint", chapterNumber: 2 }), deps).stage, "blueprint");
  assert.equal(scheduleExperience(request({ stage: "retcon", artifactKind: "retcon_revision", chapterNumber: 2 }), deps).stage, "retcon");
  assert.equal(scheduleExperience(request({ stage: "rewrite", failedRuleIds: ["rule-1"] }), deps).stage, "rewrite");
  assert.equal(scheduleExperience(request({ stage: "continuation", activation: { ...activation(), effectiveFromChapter: 1 } }), deps).stage, "continuation");
  assert.throws(() => scheduleExperience(request({ stage: "opening", artifactKind: "blueprint" }), deps), { code: "invalid_stage" });
  assert.throws(() => scheduleExperience(request({ stage: "continuation", failedRuleIds: ["rule-1"] }), deps), { code: "invalid_stage" });
});

test("malformed voice or pacing dimensions without distribution evidence are rejected", () => {
  const revised = contract();
  revised.dimensions[1].observableSignals = revised.dimensions[1].observableSignals.map((signal) => ({ ...signal, verification: { kind: "event_slots", requiredSlots: ["actor"], minimumAnchors: 1 } }));
  assert.throws(() => scheduleExperience(request({ contract: revised }), deps), { code: "invalid_distribution" });
});

test("one shared hard promise cannot replace independent per-dimension presence", () => {
  const revised = contract();
  revised.promises = [
    { id: "hard-both", dimensionId: "both", scope: { kind: "every_chapter" }, hardness: "hard", minimumSignals: 1, carryRuleIds: [] },
    ...revised.promises.filter((promise) => promise.hardness === "soft"),
  ];
  assert.throws(() => scheduleExperience(request({ contract: revised }), deps), { code: "contract_mismatch" });
});

test("ledger applies only the trusted scheduled plan, selected signals, due promises, evidence and canon facts", () => {
  const plan = scheduleExperience(request(), deps);
  const authorization = createLedgerAuthorization(plan, request().canon, ["evidence-1"], secret);
  const safePatch = { ticket: plan.ticket, expectedRevision: 3, nextRevision: 4, contractRevisionId: "contract-r1", activationId: "activation-r1", branchId: "branch-main", expectedCanonVersion: 7, chapterNumber: 2, deliveredSignalIdsByDimension: { dimension_action: ["dimension_action_relationship"], dimension_voice: ["dimension_voice_voice", "dimension_voice_pacing"] }, persistentResultsByDimension: { dimension_action: [{ id: "canon-fact", revisionId: "chapter-1", kind: "mechanic" }] }, newDebtsByDimension: {}, deliveredPromiseIds: ["hard-action", "hard-voice", "soft-rolling"], evidenceIds: ["evidence-1"] };
  const trustedDeps = { ...deps, authorization, liveCanon: request().canon };
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...safePatch, chapterNumber: 999 }, trustedDeps), { code: "plan_mismatch" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...safePatch, deliveredSignalIdsByDimension: { dimension_action: ["invented-signal"], dimension_voice: [] } }, trustedDeps), { code: "unauthorized_delivery" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...safePatch, deliveredPromiseIds: ["not-scheduled"] }, trustedDeps), { code: "unauthorized_delivery" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...safePatch, persistentResultsByDimension: { dimension_action: [{ id: "stale-ledger-fact", revisionId: "old", kind: "mechanic" }] } }, trustedDeps), { code: "unauthorized_fact" });
  assert.throws(() => applyExperienceLedgerPatch(ledger(), { ...safePatch, evidenceIds: ["invented-evidence"] }, trustedDeps), { code: "unauthorized_delivery" });
});

test("authorization snapshots and scheduled plans are immutable and reject unauthentic inputs", () => {
  const plan = scheduleExperience(request(), deps);
  assert.equal(Object.isFrozen(plan), true);
  assert.throws(() => { plan.promptProjection.dimensions[0].signalIds.push("changed"); }, TypeError);
  const canon = request().canon;
  const evidenceIds = ["evidence-1"];
  const authorization = createLedgerAuthorization(plan, canon, evidenceIds, secret);
  canon.factReferences.length = 0;
  evidenceIds.push("changed");
  assert.deepEqual(authorization.canon.factReferences, [{ id: "canon-fact", revisionId: "chapter-1", kind: "mechanic" }]);
  assert.deepEqual(authorization.evidenceIds, ["evidence-1"]);
  assert.throws(() => { authorization.plan.chapterNumber = 9; }, TypeError);
});

test("successful patches require every scheduled obligation and the live canon", () => {
  const plan = scheduleExperience(request({ chapterNumber: 5, ledger: ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] }) }), deps);
  const authorization = createLedgerAuthorization(plan, request().canon, ["evidence-1"], secret);
  const trusted = { ...deps, authorization, liveCanon: request().canon };
  const base = { ticket: plan.ticket, expectedRevision: 3, nextRevision: 4, contractRevisionId: "contract-r1", activationId: "activation-r1", branchId: "branch-main", expectedCanonVersion: 7, chapterNumber: 5, deliveredSignalIdsByDimension: { dimension_action: ["dimension_action_mechanic"], dimension_voice: ["dimension_voice_voice", "dimension_voice_pacing"] }, persistentResultsByDimension: {}, newDebtsByDimension: { dimension_action: plan.newDebts }, deliveredPromiseIds: ["hard-action", "hard-voice", "soft-rolling"], evidenceIds: ["evidence-1"] };
  assert.throws(() => applyExperienceLedgerPatch(ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] }), { ...base, deliveredSignalIdsByDimension: { dimension_action: [], dimension_voice: [] } }, trusted), { code: "unauthorized_delivery" });
  assert.throws(() => applyExperienceLedgerPatch(ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] }), { ...base, evidenceIds: [] }, trusted), { code: "unauthorized_delivery" });
  assert.throws(() => applyExperienceLedgerPatch(ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] }), { ...base, newDebtsByDimension: {} }, trusted), { code: "unauthorized_delivery" });
  assert.throws(() => applyExperienceLedgerPatch(ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1] }] }), base, { ...trusted, liveCanon: { ...request().canon, canonVersion: 8 } }), { code: "canon_version_mismatch" });
});

test("scheduler rejects impossible or duplicate signal fulfillment and keeps non-chapter retries artifact-specific", () => {
  const impossible = contract();
  impossible.promises[0].minimumSignals = 3;
  assert.throws(() => scheduleExperience(request({ contract: impossible }), deps), { code: "insufficient_signals" });
  assert.equal(scheduleExperience(request({ artifactKind: "blueprint", failedRuleIds: ["retry"] }), deps).stage, "blueprint");
  assert.equal(scheduleExperience(request({ artifactKind: "retcon_revision", failedRuleIds: ["retry"] }), deps).stage, "retcon");
  assert.throws(() => scheduleExperience(request({ artifactKind: "blueprint", stage: "rewrite", failedRuleIds: ["retry"] }), deps), { code: "invalid_stage" });
});

test("authorization rejects fabricated plans and scheduling never freezes caller-owned data", () => {
  const mutableRequest = request();
  const plan = scheduleExperience(mutableRequest, deps);
  assert.equal(Object.isFrozen(mutableRequest.contract.dimensions[0].observableSignals[0].verification), false);
  assert.throws(() => createLedgerAuthorization({ ...plan, chapterNumber: 99 }, request().canon, ["evidence-1"], secret), { code: "plan_mismatch" });
  assert.doesNotThrow(() => createLedgerAuthorization(plan, request().canon, ["evidence-1"], secret));
});

test("satisfied soft promises do not block hard-only patches and debt comparison is dimension-safe", () => {
  const plan = scheduleExperience(request({ activation: { ...activation(), effectiveFromChapter: 1 }, chapterNumber: 4, ledger: ledger({ promiseStates: [{ promiseId: "soft-rolling", deliveredChapters: [1, 2] }] }) }), deps);
  assert.deepEqual(plan.dueSoftPromiseIds, []);
});

test("CAS rejects an authorization MACed with an attacker-chosen key", () => {
  const plan = scheduleExperience(request(), deps);
  const { authorizationMac: _ignored, ...unsignedPlan } = { ...plan, chapterNumber: 99 };
  const forgedPlan = { ...unsignedPlan, authorizationMac: signExperiencePlan(unsignedPlan, "attacker-key") };
  const forged = createLedgerAuthorization(forgedPlan, request().canon, ["evidence-1"], "attacker-key");
  const patch = { ticket: plan.ticket, expectedRevision: 3, nextRevision: 4, contractRevisionId: "contract-r1", activationId: "activation-r1", branchId: "branch-main", expectedCanonVersion: 7, chapterNumber: 2, deliveredSignalIdsByDimension: { dimension_action: ["dimension_action_relationship"], dimension_voice: ["dimension_voice_voice", "dimension_voice_pacing"] }, persistentResultsByDimension: {}, newDebtsByDimension: {}, deliveredPromiseIds: ["hard-action", "hard-voice", "soft-rolling"], evidenceIds: ["evidence-1"] };
  assert.throws(() => applyExperienceLedgerPatch(ledger(), patch, { ...deps, authorization: forged, liveCanon: request().canon }), { code: "plan_mismatch" });
});
