import assert from "node:assert/strict";
import test from "node:test";
import { scheduleExperience } from "../server/readingExperienceModule/scheduler";
import { assessExperience, consumePublicationPermit, verifyPublicationPermit } from "../server/readingExperienceModule/assessor";
import { hashArtifact, sourceForArtifact } from "../server/readingExperienceModule/evidence";
import { signExperiencePlan, signExperienceStageTicket } from "../server/readingExperienceModule/scheduler";
import { applyExperienceLedgerPatch, createLedgerAuthorization } from "../server/readingExperienceModule/ledger";
import type { CompiledExperienceContractRevision, ExperienceContractActivation, ExperienceLedgerV2 } from "../src/types";
import type { AssessExperienceRequest, SemanticVerdict } from "../server/readingExperienceModule/types";

const secret = "assessor-test-secret";
const now = () => new Date("2026-07-17T00:00:00.000Z");
const source = "Chapter title\nAria opens the sealed gate and the mechanism records her choice.\nThe city guard lowers his spear, then Aria answers with a bow and they choose to travel together.\nAt dusk Aria wins the duel, and the crowd opens the road.\nA spare, precise sentence keeps the scene moving.\nAt dawn the rhythm turns with a clear new action.\n旁观者讥笑面板没有反馈，下一刻面板弹出永久奖励。";

function contract(): CompiledExperienceContractRevision {
  const event = (id: string, kind: any, policy: any) => ({ id, dimensionId: "d1", kind, description: "opaque", semanticSlots: { actor: "Aria" }, verification: policy, persistence: kind === "mechanic" || kind === "relationship" ? "cross_chapter" : "chapter" });
  return {
    id: "r1", schemaVersion: 2, revision: 1, parentRevisionId: null,
    intent: { descriptors: [{ text: "opaque-a" }, { text: "opaque-b" }], locale: "zh-CN" },
    dimensions: [
      { id: "d1", descriptor: "opaque-a", interpretation: "opaque", categories: ["mechanic", "protagonist_action", "conflict_outcome", "world_reaction", "relationship"], observableSignals: [
        event("mechanic", "mechanic", { kind: "event_slots", requiredSlots: ["actor", "action", "outcome"], minimumAnchors: 1 }), event("action", "protagonist_action", { kind: "event_slots", requiredSlots: ["actor", "action"], minimumAnchors: 1 }), event("conflict", "conflict_outcome", { kind: "event_slots", requiredSlots: ["actor", "action", "outcome"], minimumAnchors: 1 }), event("world", "world_reaction", { kind: "event_slots", requiredSlots: ["actor", "reaction"], minimumAnchors: 1 }), event("relationship", "relationship", { kind: "relationship_change", requireReciprocalAction: true, minimumAnchors: 2 }),
      ], prohibitions: [], confidence: 1 },
      { id: "d2", descriptor: "opaque-b", interpretation: "opaque", categories: ["voice", "pacing"], observableSignals: [
        { id: "voice", dimensionId: "d2", kind: "voice", description: "opaque", verification: { kind: "distribution", metricIds: ["anchor_spread", "scene_coverage"], minimumAnchors: 3, requireSemanticJudge: true, requiredRegions: ["opening", "middle", "ending"], regionSemantics: "proportional", metricThresholds: { anchor_spread: .4, scene_coverage: 1 } }, persistence: "chapter" },
        { id: "pacing", dimensionId: "d2", kind: "pacing", description: "opaque", verification: { kind: "distribution", metricIds: ["anchor_spread", "scene_coverage"], minimumAnchors: 3, requireSemanticJudge: true, requiredRegions: ["opening", "middle", "ending"], regionSemantics: "proportional", metricThresholds: { anchor_spread: .4, scene_coverage: 1 } }, persistence: "chapter" },
      ], prohibitions: [], confidence: 1 },
    ],
    synthesis: { sharedCause: "opaque", dimensionRoles: ["a", "b"] }, promises: [
      { id: "p1", dimensionId: "d1", scope: { kind: "every_chapter" }, hardness: "hard", minimumSignals: 1, carryRuleIds: [] },
      { id: "p2", dimensionId: "d2", scope: { kind: "every_chapter" }, hardness: "hard", minimumSignals: 1, carryRuleIds: [] },
    ], prohibitions: [], ruleGraphVersion: "g1", provenance: [], createdAt: now().toISOString(),
  };
}
function activation(): ExperienceContractActivation { return { id: "a1", contractRevisionId: "r1", branchId: "main", effectiveFromChapter: 1, effectiveFromCanonVersion: 1, effectiveThroughCanonVersion: null, activatedAt: now().toISOString() }; }
function ledger(): ExperienceLedgerV2 { return { contractRevisionId: "r1", activationId: "a1", revision: 1, branchId: "main", throughCanonVersion: 1, dimensions: [{ dimensionId: "d1", lastDeliveredChapter: 0, silentChapters: 0, deliveredSignalIds: [], persistentResults: [], debts: [] }, { dimensionId: "d2", lastDeliveredChapter: 0, silentChapters: 0, deliveredSignalIds: [], persistentResults: [], debts: [] }], evidenceIds: [], promiseStates: [], consumedTicketIds: [], history: [] }; }
function anchor(text: string) { const start = source.indexOf(text); return { start, end: start + text.length, quote: text }; }
function verdict(overrides: Partial<SemanticVerdict> = {}): SemanticVerdict { const claims = [
  { version: 1 as const, eventId: "shared-event", dimensionId: "d1", signalId: "mechanic", supported: true, confidence: .9, anchors: [anchor("Aria opens the sealed gate and the mechanism records her choice.")], slotAnchorIndices: { actor: 0, action: 0, object: 0, outcome: 0 }, slots: { actor: "Aria", action: "opens", object: "gate", outcome: "records" } },
  { version: 1 as const, eventId: "shared-event", dimensionId: "d2", signalId: "voice", supported: true, confidence: .9, anchors: [anchor("Aria opens the sealed gate and the mechanism records her choice."), anchor("At dusk Aria wins the duel"), anchor("旁观者讥笑面板没有反馈，下一刻面板弹出永久奖励。")], slotAnchorIndices: {}, metrics: { anchor_spread: .8, scene_coverage: 1 } },
  { version: 1 as const, eventId: "pacing-event", dimensionId: "d2", signalId: "pacing", supported: true, confidence: .9, anchors: [anchor("Chapter title"), anchor("A spare, precise sentence"), anchor("At dawn the rhythm turns with a clear new action.")], slotAnchorIndices: {}, metrics: { anchor_spread: .8, scene_coverage: 1 } },
]; return { version: 1, claims, sharedCause: { eventId: "shared-event", supported: true, confidence: .9, anchors: [anchor("Aria opens the sealed gate and the mechanism records her choice.")], links: [{ dimensionId: "d1", signalId: "mechanic", claimAnchorIndex: 0, sharedAnchorIndex: 0 }, { dimensionId: "d2", signalId: "voice", claimAnchorIndex: 0, sharedAnchorIndex: 0 }] } as any, ...overrides }; }
function fixture(judge = async () => verdict(), configure: (value: CompiledExperienceContractRevision) => void = () => {}) { const c = contract(); configure(c); const artifact = { kind: "chapter" as const, chapterId: "c1", revisionId: "v1", title: "Chapter title", paragraphs: source.split("\n").slice(1) }; const digest = hashArtifact(artifact); const plan = scheduleExperience({ contract: c, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v1", expectedArtifactDigest: digest, roleBindings: { protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: ["guard-id"], opponentIds: ["duelist-id"] }, chapterNumber: 1, jobId: "j1", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t1" }); const state = { activationId: "a1", branchId: "main", canonVersion: 1, ledgerRevision: 1, attempt: 1, chapterId: "c1", revisionId: "v1", artifactBindingId: plan.artifactBindingId, expectedArtifactDigest: digest as string | null, consumedTicketIds: [] as string[], consumedPermitIds: [] as string[], consumedRepairIds: [] as string[], existingEvidenceIds: [] as string[] }; return { state, request: { plan, artifact } as AssessExperienceRequest, deps: { ticketSecret: secret, now, contract: c, semanticJudgePort: { judge }, statePort: { read: () => ({ ...state, consumedTicketIds: [...state.consumedTicketIds], consumedPermitIds: [...state.consumedPermitIds], consumedRepairIds: [...state.consumedRepairIds], existingEvidenceIds: [...state.existingEvidenceIds] }), bindArtifactDigest: ({ artifactBindingId, artifactHash }: any) => { if (state.artifactBindingId !== artifactBindingId || state.expectedArtifactDigest !== null) return false; state.expectedArtifactDigest = artifactHash; return true; }, consumeTicket: ({ ticketId, repairAuthorization }: any) => { if (state.consumedTicketIds.includes(ticketId) || repairAuthorization && state.consumedRepairIds.includes(repairAuthorization.repairId)) return false; state.consumedTicketIds.push(ticketId); if (repairAuthorization) state.consumedRepairIds.push(repairAuthorization.repairId); return true; }, consumePermit: ({ permitId }: any) => { if (state.consumedPermitIds.includes(permitId)) return false; state.consumedPermitIds.push(permitId); return true; }, consumeRepair: ({ repairId }: any) => { if (state.consumedRepairIds.includes(repairId)) return false; state.consumedRepairIds.push(repairId); return true; } } } }; }
function blueprintVerdict(plan: AssessExperienceRequest["plan"]): any { const signalIds = plan.promptProjection.dimensions.flatMap((dimension) => dimension.signalIds); return { version: 1, kind: "blueprint", signals: signalIds.map((signalId, index) => ({ dimensionId: plan.promptProjection.dimensions.find((dimension) => dimension.signalIds.includes(signalId))!.id, signalId, pointer: `/chapters/0/signalIds/${index}`, supported: true })), promises: plan.hardPresencePromiseIds.map((promiseId, index) => ({ promiseId, pointer: `/chapters/0/promiseIds/${index}`, supported: true })), ending: { targetPointer: "/endingContract/target", costPointer: "/endingContract/cost", supported: true, systemState: "available", protagonistOutcome: "fulfilled", hasRealCost: true }, sharedCause: { pointer: "/sharedCause/event", dimensionIds: plan.promptProjection.dimensions.map((dimension) => dimension.id), supported: true }, confidence: .9 }; }

test("voice and pacing require distributed anchors and metrics", async () => { const { request, deps } = fixture(); const result = await assessExperience(request, deps); assert.equal(result.ok, true); if (!result.ok || result.value.status !== "accepted" || result.value.artifactKind !== "chapter") return assert.fail(); const distributed = result.value.evidence.filter((item) => item.signalId === "voice" || item.signalId === "pacing"); assert.equal(distributed.every((item) => item.anchors.length >= 3), true); assert.equal(distributed.every((item) => Object.keys(item.observation.distributionMetrics ?? {}).length > 0), true); });
test("a fabricated judge quote never becomes evidence", async () => { const { request, deps } = fixture(async () => verdict({ claims: verdict().claims.map((claim, index) => index ? claim : { ...claim, anchors: [{ start: 0, end: 4, quote: "missing" }] }) })); const result = await assessExperience(request, deps); assert.equal(result.ok, true); if (!result.ok) return assert.fail(); assert.equal(result.value.status, "rewrite"); });
test("ticket and authorization failures fail closed before a judge call", async () => { let calls = 0; const { request, deps } = fixture(async () => { calls++; return verdict(); }); const altered = { ...request, plan: { ...request.plan, chapterNumber: 9 } }; const result = await assessExperience(altered, deps); assert.equal(result.ok, true); if (!result.ok) return assert.fail(); assert.equal(result.value.status, "rejected"); assert.equal(calls, 0); });
test("all categories demand their local realized evidence", async () => { for (const slots of [{}, { actor: "Aria", action: "opens", object: "gate", outcome: "records" }]) { const { request, deps } = fixture(async () => verdict({ claims: verdict().claims.map((claim, index) => index ? claim : { ...claim, slots }) })); const result = await assessExperience(request, deps); assert.equal(result.ok, true); if (!result.ok) return assert.fail(); assert.equal(result.value.status, slots.actor ? "accepted" : "rewrite"); } });

test("anchors, artifact hashes, blueprint and retcon bindings are deterministic", async () => {
  const chapter = { kind: "chapter" as const, chapterId: "c1", revisionId: "v1", title: "T", paragraphs: ["one", "two"] };
  assert.equal(sourceForArtifact(chapter), "T\none\ntwo"); assert.equal(hashArtifact(chapter).length, 64);
  const canonicalBlueprint = { kind: "blueprint" as const, value: { meta: { z: 1 }, a: [true] } }; assert.equal(sourceForArtifact(canonicalBlueprint), '{"a":[true],"meta":{"z":1}}');
  const { request, deps, state } = fixture(); const blueprintPlan = scheduleExperience({ contract: deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "blueprint", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "j-blue", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-blue" });
  const blueprintSignalIds = blueprintPlan.promptProjection.dimensions.flatMap((dimension) => dimension.signalIds); const blueprint = { kind: "blueprint" as const, value: { schemaVersion: 1, title: "Blueprint", protagonist: { id: "aria-id" }, axisSignalIds: blueprintSignalIds, hardPromiseIds: blueprintPlan.hardPresencePromiseIds, endingContract: { target: "The mechanism remains available and Aria fulfills the ending goal.", cost: "Aria permanently gives up the protected route." }, sharedCause: { event: "One costly choice changes both axes.", dimensionIds: blueprintPlan.promptProjection.dimensions.map((dimension) => dimension.id) }, chapters: [{ number: 1, signalIds: blueprintSignalIds, promiseIds: blueprintPlan.hardPresencePromiseIds, event: "Aria makes the costly choice.", cost: "The protected route is lost." }], meta: { prohibitionsSatisfied: true } } }; state.artifactBindingId = blueprintPlan.artifactBindingId; state.expectedArtifactDigest = null; const blueprintDeps = { ...deps, semanticJudgePort: { judge: async () => blueprintVerdict(blueprintPlan) } }; const acceptedBlueprint = await assessExperience({ plan: blueprintPlan, artifact: blueprint }, blueprintDeps); assert.equal(acceptedBlueprint.ok, true); if (!acceptedBlueprint.ok) return assert.fail(); assert.equal(acceptedBlueprint.value.status, "accepted");
  const retconArtifact = { ...request.artifact, kind: "retcon_revision" as const, revisionId: "v2" }; const retconDigest = hashArtifact(retconArtifact); const retconPlan = scheduleExperience({ contract: deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "retcon_revision", chapterId: "c1", revisionId: "v2", expectedArtifactDigest: retconDigest, roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "j-retcon", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-retcon" });
  state.revisionId = "v2"; state.artifactBindingId = retconPlan.artifactBindingId; state.expectedArtifactDigest = retconDigest; const retcon = await assessExperience({ plan: retconPlan, artifact: retconArtifact }, deps); assert.equal(retcon.ok, true); if (!retcon.ok || retcon.value.status !== "accepted" || retcon.value.artifactKind !== "retcon_revision") return assert.fail(); assert.equal(retcon.value.evidence.every((item) => item.chapterRevisionId === "v2"), true); assert.equal(retcon.value.permit.revisionId, "v2");
});

test("invalid schema, unavailable model, distribution failure, and stale tickets fail closed", async () => {
  const malformed = fixture(async () => ({ version: 2 } as any)); const malformedResult = await assessExperience(malformed.request, malformed.deps); assert.equal(malformedResult.ok, false); if (!malformedResult.ok) assert.equal(malformedResult.error.code, "invalid_model_output");
  const unavailable = fixture(async () => { throw new Error("429 timeout"); }); const unavailableResult = await assessExperience(unavailable.request, unavailable.deps); assert.equal(unavailableResult.ok, false); if (!unavailableResult.ok) assert.equal(unavailableResult.error.code, "model_unavailable");
  const distributed = fixture(async () => verdict({ claims: verdict().claims.map((claim) => claim.signalId === "voice" ? { ...claim, anchors: [claim.anchors[0], claim.anchors[1], claim.anchors[1]] } : claim) })); const distributedResult = await assessExperience(distributed.request, distributed.deps); assert.equal(distributedResult.ok, true); if (!distributedResult.ok) return assert.fail(); assert.equal(distributedResult.value.status, "rewrite");
  let calls = 0; const stale = fixture(async () => { calls++; return verdict(); }); const expired = { ...stale.request.plan.ticket, expiresAt: "2026-07-16T00:00:00.000Z" }; const signedExpired = { ...expired, signature: signExperienceStageTicket(expired, secret) }; const unsigned = { ...stale.request.plan, ticket: signedExpired }; const expiredPlan = { ...unsigned, authorizationMac: signExperiencePlan(unsigned, secret) }; const expiredResult = await assessExperience({ ...stale.request, plan: expiredPlan }, stale.deps); assert.equal(expiredResult.ok, true); if (!expiredResult.ok) return assert.fail(); assert.equal(expiredResult.value.status, "rejected"); assert.equal(calls, 0);
});

test("judge receives compiled semantics, shared cause and canon references without raw descriptors", async () => {
  let captured: any; const { request, deps } = fixture(async (input) => { captured = input; return verdict(); }); const result = await assessExperience(request, deps); assert.equal(result.ok, true); assert.equal(captured.synthesis.sharedCause, "opaque"); assert.equal(captured.signals[0].interpretation, "opaque"); assert.equal(captured.signals[0].description, "opaque"); assert.deepEqual(captured.signals[0].canonFactReferences, []); const wire = JSON.stringify(captured); assert.equal(wire.includes("opaque-a"), false); assert.equal(wire.includes("opaque-b"), false); assert.equal(Object.isFrozen(captured), true);
});

test("all five event categories are actually scheduled and locally verified", async () => {
  const rows: Array<[string, any, any, any[]]> = [
    ["mechanic", { kind: "event_slots", requiredSlots: ["actor", "action", "object", "outcome"], minimumAnchors: 1 }, { actor: "Aria", action: "opens", object: "gate", outcome: "records" }, [anchor("Aria opens the sealed gate and the mechanism records her choice.")]],
    ["protagonist_action", { kind: "event_slots", requiredSlots: ["actor", "action", "object", "outcome"], minimumAnchors: 1 }, { actor: "Aria", action: "opens", object: "gate", outcome: "records" }, [anchor("Aria opens the sealed gate and the mechanism records her choice.")]],
    ["conflict_outcome", { kind: "event_slots", requiredSlots: ["actor", "action", "object", "outcome"], minimumAnchors: 1 }, { actor: "Aria", action: "wins", object: "duel", opponent: "duel", opponentId: "duelist-id", outcome: "opens the road" }, [anchor("Aria wins"), anchor("the duel"), anchor("the crowd opens the road")]],
    ["world_reaction", { kind: "event_slots", requiredSlots: ["actor", "reaction", "outcome"], minimumAnchors: 1 }, { actor: "crowd", reaction: "opens", outcome: "road" }, [anchor("the crowd opens the road")]],
    ["relationship", { kind: "relationship_change", requireReciprocalAction: true, minimumAnchors: 2 }, { actor: "Aria", action: "answers", counterpart: "guard", counterpartId: "guard-id", reciprocalAction: "guard lowers", relationshipChange: "travel together" }, [anchor("The city guard lowers his spear"), anchor("then Aria answers with a bow and they choose to travel together")]],
  ];
  for (const [kind, policy, slots, anchors] of rows) {
    const id = `scheduled-${kind}`;
    const slotAnchorIndices = Object.fromEntries(Object.keys(slots).filter((slot) => !slot.endsWith("Id")).map((slot) => { const found = anchors.findIndex((item) => item.quote.includes(slots[slot].split(" ").at(-1))); return [slot, found < 0 ? 0 : found]; }));
    const claim = { version: 1 as const, eventId: "shared-event", dimensionId: "d1", signalId: id, supported: true, confidence: .9, anchors, slotAnchorIndices, slots };
    const judged = async () => {
      const base = verdict();
      base.sharedCause.anchors = [claim.anchors[0]]; (base.sharedCause as any).links[0] = { dimensionId: "d1", signalId: id, claimAnchorIndex: 0, sharedAnchorIndex: 0 };
      base.claims[1] = { ...base.claims[1], anchors: [claim.anchors[0], claim.anchors[0].start < source.length / 3 ? anchor("At dusk") : anchor("The city guard lowers his spear"), base.claims[1].anchors[2]] };
      if (kind === "relationship") {
        base.claims[2] = { ...base.claims[2], anchors: [base.claims[2].anchors[0], anchor("A spare, precise sentence"), base.claims[2].anchors[2]] };
      }
      return { ...base, claims: [claim, ...base.claims.slice(1)] };
    };
    const { request, deps } = fixture(judged, (c) => { c.dimensions[0].observableSignals = [{ id, dimensionId: "d1", kind: kind as any, description: "scheduled concrete event", semanticSlots: kind === "world_reaction" || kind === "relationship" ? undefined : { actor: "Aria" }, verification: policy, persistence: kind === "relationship" || kind === "mechanic" ? "cross_chapter" : "chapter" }]; });
    const result = await assessExperience(request, deps); assert.equal(result.ok, true, kind); if (!result.ok) continue; assert.equal(result.value.status, "accepted", `${kind}:${JSON.stringify(result.value)}`);
  }
});

test("ticket CAS permits only one concurrent assessment and permit context is exact and one-time", async () => {
  const { request, deps } = fixture(); const [left, right] = await Promise.all([assessExperience(request, deps), assessExperience(request, deps)]); const accepted = [left, right].filter((result) => result.ok && result.value.status === "accepted"); assert.equal(accepted.length, 1); const result = accepted[0]; if (!result.ok || result.value.status !== "accepted" || result.value.artifactKind !== "chapter") return assert.fail(); const value = result.value; const context = { ticketId: value.permit.ticketId, jobId: value.permit.jobId, attempt: value.permit.attempt, contractRevisionId: value.permit.contractRevisionId, activationId: value.permit.activationId, branchId: value.permit.branchId, stage: value.permit.stage, artifactKind: value.permit.artifactKind, ruleGraphVersion: value.permit.ruleGraphVersion, expectedCanonVersion: value.permit.expectedCanonVersion, ledgerRevision: value.permit.ledgerRevision, chapterId: value.permit.chapterId, revisionId: value.permit.revisionId, artifactHash: value.permit.artifactHash, evidenceIds: value.permit.evidenceIds, ledgerPatchHash: value.permit.ledgerPatchHash }; assert.equal(verifyPublicationPermit(value.permit, {} as any, secret, now()), false); assert.equal(verifyPublicationPermit(value.permit, context, secret, now()), true); assert.equal(await consumePublicationPermit(value.permit, context, deps), true); assert.equal(await consumePublicationPermit(value.permit, context, deps), false);
});

test("wrong digest and revision fail before judge", async () => { let calls = 0; const { request, deps } = fixture(async () => { calls++; return verdict(); }); const digest = await assessExperience({ ...request, plan: { ...request.plan, expectedArtifactDigest: "wrong" } }, deps); assert.equal(digest.ok, true); if (digest.ok) assert.equal(digest.value.status, "rejected"); const revision = await assessExperience({ ...request, artifact: { ...request.artifact, revisionId: "other" } }, deps); assert.equal(revision.ok, true); if (revision.ok) assert.equal(revision.value.status, "rejected"); assert.equal(calls, 0); });

test("an accepted assessment patch applies through the real ledger authorization gate", async () => { const { request, deps } = fixture(); const result = await assessExperience(request, deps); assert.equal(result.ok, true); if (!result.ok || result.value.status !== "accepted" || result.value.artifactKind !== "chapter") return assert.fail(); const canon = { branchId: "main", canonVersion: 1, factReferences: [] }; const authorization = createLedgerAuthorization(request.plan, canon, result.value.evidence.map((item) => item.id), secret); const updated = applyExperienceLedgerPatch(ledger(), result.value.ledgerPatch, { ticketSecret: secret, ticketTtlMs: 60_000, now, contract: deps.contract, authorization, liveCanon: canon }); assert.equal(updated.revision, 2); assert.equal(result.value.canonFactCandidates.every((item) => item.evidenceId && item.anchors.length), true); });

test("the final ticket CAS binds the live evidence collision set and catches port failures", async () => {
  const collision = fixture(); let sawEvidenceSet = false;
  collision.deps.statePort.consumeTicket = ((input: any) => {
    sawEvidenceSet = Array.isArray(input.expected.existingEvidenceIds) && input.expected.existingEvidenceIds.length === 0 && Array.isArray(input.newEvidenceIds) && input.newEvidenceIds.length > 0;
    collision.state.existingEvidenceIds.push(input.newEvidenceIds[0]);
    return false;
  }) as any;
  const collided = await assessExperience(collision.request, collision.deps);
  assert.equal(sawEvidenceSet, true);
  assert.equal(collided.ok, true); if (collided.ok) assert.equal(collided.value.status, "rejected");

  const exception = fixture(); exception.deps.statePort.consumeTicket = (() => { throw new Error("storage unavailable"); }) as any;
  const failedClosed = await assessExperience(exception.request, exception.deps);
  assert.equal(failedClosed.ok, true); if (failedClosed.ok) assert.equal(failedClosed.value.status, "rejected");
});

test("a both-dimension promise keeps independently auditable evidence links", async () => {
  const { request, deps } = fixture(async () => verdict(), (value) => {
    value.promises.push({ id: "both", dimensionId: "both", scope: { kind: "every_chapter" }, hardness: "hard", minimumSignals: 1, carryRuleIds: [] });
  });
  const result = await assessExperience(request, deps);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.status !== "accepted" || result.value.artifactKind !== "chapter") return assert.fail();
  assert.deepEqual(Object.keys(result.value.ledgerPatch.promiseEvidenceLinks.both).sort(), ["d1", "d2"]);
  assert.equal(result.value.ledgerPatch.promiseEvidenceLinks.both.d1.length, 1);
  assert.equal(result.value.ledgerPatch.promiseEvidenceLinks.both.d2.length, 2);
});

test("shared-cause pointers permit only the common anchor and require axis-local evidence", async () => {
  const legal = fixture();
  const accepted = await assessExperience(legal.request, legal.deps);
  assert.equal(accepted.ok, true); if (accepted.ok) assert.equal(accepted.value.status, "accepted");

  const disconnected = fixture(async () => {
    const value = verdict();
    value.claims[1] = { ...value.claims[1], anchors: [anchor("The city guard lowers his spear"), value.claims[1].anchors[1], value.claims[1].anchors[2]] };
    return value;
  });
  const rejected = await assessExperience(disconnected.request, disconnected.deps);
  assert.equal(rejected.ok, true); if (rejected.ok) assert.equal(rejected.value.status, "rewrite");

  const generic = fixture(async () => {
    const value = verdict(); const common = value.claims[0].anchors[0];
    value.claims[1] = { ...value.claims[1], anchors: [common, common, common] };
    return value;
  });
  const doubleCounted = await assessExperience(generic.request, generic.deps);
  assert.equal(doubleCounted.ok, true); if (doubleCounted.ok) assert.equal(doubleCounted.value.status, "rewrite");
});

test("every required slot has a grounded pointer and trusted story-role identity", async () => {
  const missingPointer = fixture(async () => {
    const value = verdict(); value.claims[0] = { ...value.claims[0], slotAnchorIndices: { actor: 0, action: 0, outcome: 0 } }; return value;
  });
  const missing = await assessExperience(missingPointer.request, missingPointer.deps);
  assert.equal(missing.ok, true); if (missing.ok) assert.equal(missing.value.status, "rewrite");

  const relationship = fixture(async () => {
    const value = verdict();
    value.claims[0] = { version: 1, eventId: "shared-event", dimensionId: "d1", signalId: "relationship", supported: true, confidence: .9, anchors: [anchor("The city guard lowers his spear"), anchor("then Aria answers with a bow and they choose to travel together")], slotAnchorIndices: { actor: 1, action: 1, reciprocalAction: 0, relationshipChange: 1, counterpartId: 0 } as any, slots: { actor: "Aria", action: "answers", reciprocalAction: "lowers", relationshipChange: "travel together", counterpartId: "stranger-id" } as any };
    value.sharedCause.anchors = [value.claims[0].anchors[0]]; (value.sharedCause as any).links[0] = { dimensionId: "d1", signalId: "relationship", claimAnchorIndex: 0, sharedAnchorIndex: 0 };
    value.claims[1] = { ...value.claims[1], anchors: [value.claims[0].anchors[0], value.claims[1].anchors[1], value.claims[1].anchors[2]] };
    return value;
  }, (value) => { value.dimensions[0].observableSignals = value.dimensions[0].observableSignals.filter((signal) => signal.id === "relationship"); });
  const untrusted = await assessExperience(relationship.request, relationship.deps);
  assert.equal(untrusted.ok, true); if (untrusted.ok) assert.equal(untrusted.value.status, "rewrite");
});

test("curated adapters inspect the claimed event, not unrelated source text", async () => {
  let calls = 0;
  const { request, deps } = fixture(async () => { calls++; return verdict(); }, (value) => {
    value.prohibitions = [{ id: "curated-local", dimensionId: "both", kind: "invariant", description: "compiled prohibition", severity: "rewrite", ruleAdapterId: "curated-mechanic-unavailable" } as any];
  });
  const result = await assessExperience(request, deps);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "accepted", JSON.stringify(result.value));
  assert.equal(calls, 1);
});

test("blueprint acceptance is semantic, pointer-grounded, and rejects a malicious ending", async () => {
  const { deps, state } = fixture();
  const plan = scheduleExperience({ contract: deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "blueprint", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "j-blue-mal", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-blue-mal" });
  const signalIds = plan.promptProjection.dimensions.flatMap((dimension) => dimension.signalIds);
  const artifact = { kind: "blueprint" as const, value: { schemaVersion: 1, title: "Malicious", protagonist: { id: "aria-id" }, axisSignalIds: signalIds, hardPromiseIds: plan.hardPresencePromiseIds, endingContract: { target: "系统永远不可用，主角最终惨败", cost: "Everything is lost." }, sharedCause: { event: "One event", dimensionIds: plan.promptProjection.dimensions.map((dimension) => dimension.id) }, chapters: [{ number: 1, signalIds, promiseIds: plan.hardPresencePromiseIds, event: "One event", cost: "Everything is lost." }], meta: { prohibitionsSatisfied: true } } };
  let calls = 0; state.consumedTicketIds.length = 0; state.artifactBindingId = plan.artifactBindingId; state.expectedArtifactDigest = null;
  const result = await assessExperience({ plan, artifact }, { ...deps, semanticJudgePort: { judge: async () => { calls++; return blueprintVerdict(plan); } } });
  assert.equal(calls, 1);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "rewrite");
  assert.deepEqual(state.consumedTicketIds, [plan.ticket.id]);
});

test("assessment atomically performs the first artifact binding and rejects binding drift", async () => {
  const first = fixture(); first.state.expectedArtifactDigest = null; let binds = 0;
  first.deps.statePort.bindArtifactDigest = ((input: any) => {
    assert.equal(input.artifactBindingId, first.request.plan.artifactBindingId); assert.equal(input.expected.expectedArtifactDigest, null);
    if (first.state.expectedArtifactDigest !== null) return false; binds++; first.state.expectedArtifactDigest = input.artifactHash; return true;
  }) as any;
  const accepted = await assessExperience(first.request, first.deps);
  assert.equal(accepted.ok, true); if (accepted.ok) assert.equal(accepted.value.status, "accepted"); assert.equal(binds, 1);

  let calls = 0; const drift = fixture(async () => { calls++; return verdict(); }); drift.state.expectedArtifactDigest = "different";
  const rejected = await assessExperience(drift.request, drift.deps);
  assert.equal(rejected.ok, true); if (rejected.ok) assert.equal(rejected.value.status, "rejected"); assert.equal(calls, 0);
});
