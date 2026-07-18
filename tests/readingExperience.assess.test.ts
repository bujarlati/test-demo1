import assert from "node:assert/strict";
import test from "node:test";
import { canonicalAuthorizationPayload, repairContext, scheduleExperience } from "../server/readingExperienceModule/scheduler";
import { assessExperience, consumePublicationPermit, verifyPublicationPermit } from "../server/readingExperienceModule/assessor";
import { createReadingExperienceModule } from "../server/readingExperienceModule";
import { hashArtifact, sourceForArtifact } from "../server/readingExperienceModule/evidence";
import { signExperiencePlan, signExperienceStageTicket } from "../server/readingExperienceModule/scheduler";
import { applyExperienceLedgerPatch, createLedgerAuthorization } from "../server/readingExperienceModule/ledger";
import { sortedEvidenceBindings } from "../server/readingExperienceModule/publication";
import type { CompiledExperienceContractRevision, ExperienceContractActivation, ExperienceLedgerV2, ObservableSignalV2 } from "../src/types";
import type { AssessExperienceRequest, AssessorDependencies, SemanticVerdict } from "../server/readingExperienceModule/types";
import { StrictAssessmentStatePort } from "./fixtures/strictAssessmentStatePort";

const secret = "assessor-test-secret";
const now = () => new Date("2026-07-17T00:00:00.000Z");
const source = "Chapter title\nAria opens the sealed gate and the mechanism records her choice.\nThe city guard lowers his spear, then Aria answers with a bow and they choose to travel together.\nAt dusk Aria wins the duel, and the crowd opens the road.\nA spare, precise sentence keeps the scene moving.\nAt dawn the rhythm turns with a clear new action.\n旁观者讥笑面板没有反馈，下一刻面板弹出永久奖励。";

function contract(): CompiledExperienceContractRevision {
  const event = (id: string, kind: any, policy: any): ObservableSignalV2 => ({ id, dimensionId: "d1", kind, description: "opaque", semanticSlots: { actor: "Aria" }, verification: policy, persistence: kind === "mechanic" || kind === "relationship" ? "cross_chapter" : "chapter" });
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
  { version: 1 as const, eventId: "pacing-event", dimensionId: "d2", signalId: "pacing", supported: true, confidence: .9, anchors: [anchor("The city guard lowers his spear"), anchor("A spare, precise sentence"), anchor("At dawn the rhythm turns with a clear new action.")], slotAnchorIndices: {}, metrics: { anchor_spread: .8, scene_coverage: 1 } },
]; return { version: 1, claims, sharedCause: { eventId: "shared-event", supported: true, confidence: .9, anchors: [anchor("Aria opens the sealed gate and the mechanism records her choice.")], links: [{ dimensionId: "d1", signalId: "mechanic", claimAnchorIndex: 0, sharedAnchorIndex: 0 }, { dimensionId: "d2", signalId: "voice", claimAnchorIndex: 0, sharedAnchorIndex: 0 }] } as any, ...overrides }; }
function fixture(judge: AssessorDependencies["semanticJudgePort"]["judge"] = async () => verdict(), configure: (value: CompiledExperienceContractRevision) => void = () => {}) { const c = contract(); configure(c); const artifact = { kind: "chapter" as const, chapterId: "c1", revisionId: "v1", title: "Chapter title", paragraphs: source.split("\n").slice(1) }; const digest = hashArtifact(artifact); const plan = scheduleExperience({ contract: c, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v1", expectedArtifactDigest: digest, roleBindings: { protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: ["guard-id"], opponentIds: ["duelist-id"], counterparts: [{ id: "guard-id", aliases: ["guard"] }], opponents: [{ id: "duelist-id", aliases: ["duel"] }] }, chapterNumber: 1, jobId: "j1", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t1" }); const state = { activationId: "a1", branchId: "main", canonVersion: 1, ledgerRevision: 1, attempt: 1, chapterId: "c1", revisionId: "v1", artifactBindingId: plan.artifactBindingId, expectedArtifactDigest: digest as string | null, consumedTicketIds: [] as string[], consumedPermitIds: [] as string[], consumedRepairIds: [] as string[], existingEvidenceIds: [] as string[] }; return { state, request: { plan, artifact } as AssessExperienceRequest, deps: { ticketSecret: secret, now, contract: c, semanticJudgePort: { judge }, statePort: { read: () => ({ ...state, consumedTicketIds: [...state.consumedTicketIds], consumedPermitIds: [...state.consumedPermitIds], consumedRepairIds: [...state.consumedRepairIds], existingEvidenceIds: [...state.existingEvidenceIds] }), bindArtifactDigest: ({ artifactBindingId, artifactHash }: any) => { if (state.artifactBindingId !== artifactBindingId || state.expectedArtifactDigest !== null) return false; state.expectedArtifactDigest = artifactHash; return true; }, consumeTicket: ({ ticketId, repairAuthorization }: any) => { if (state.consumedTicketIds.includes(ticketId) || repairAuthorization && state.consumedRepairIds.includes(repairAuthorization.repairId)) return false; state.consumedTicketIds.push(ticketId); if (repairAuthorization) state.consumedRepairIds.push(repairAuthorization.repairId); return true; }, consumePermit: ({ permitId }: any) => { if (state.consumedPermitIds.includes(permitId)) return false; state.consumedPermitIds.push(permitId); return true; }, consumeRepair: ({ repairId }: any) => { if (state.consumedRepairIds.includes(repairId)) return false; state.consumedRepairIds.push(repairId); return true; } } } }; }
function blueprintVerdict(plan: AssessExperienceRequest["plan"]): any {
  const deliveries = plan.promptProjection.dimensions.flatMap((dimension) => dimension.signalIds.map((signalId) => ({ dimensionId: dimension.id, signalId })));
  return {
    version: 1,
    kind: "blueprint",
    signals: deliveries.map(({ dimensionId, signalId }) => ({ dimensionId, signalId, pointer: "/chapters/0/event", supported: true })),
    promises: plan.hardPresencePromiseIds.map((promiseId) => ({ promiseId, pointer: "/chapters/0/event", supported: true })),
    ending: { targetPointer: "/endingContract/target", costPointer: "/endingContract/cost", supported: true, systemState: "available", protagonistOutcome: "fulfilled", hasRealCost: true },
    sharedCause: { pointer: "/chapters/0/event", dimensionIds: plan.promptProjection.dimensions.map((dimension) => dimension.id), supported: true },
    confidence: .9,
  };
}

function blueprintValue(plan: AssessExperienceRequest["plan"], endingTarget = "The mechanism remains available and Aria fulfills the ending goal."): Record<string, unknown> {
  const deliveries = plan.promptProjection.dimensions.flatMap((dimension) => dimension.signalIds.map((signalId) => ({ dimensionId: dimension.id, signalId, action: `A concrete action realizes ${signalId}.`, outcome: `The action changes the situation for ${dimension.id}.` })));
  return {
    schemaVersion: 1,
    title: "Blueprint",
    protagonist: { id: "aria-id" },
    axisSignalIds: deliveries.map((item) => item.signalId),
    hardPromiseIds: plan.hardPresencePromiseIds,
    endingContract: { target: endingTarget, cost: "Aria permanently gives up the protected route." },
    sharedCause: { event: "One costly choice changes both axes.", dimensionIds: plan.promptProjection.dimensions.map((dimension) => dimension.id) },
    chapters: [{ number: 1, signalIds: deliveries.map((item) => item.signalId), promiseIds: plan.hardPresencePromiseIds, event: "Opening the sealed gate forces concrete changes in the city and in Aria's relationships.", cause: "Opening the sealed gate forces both consequences.", outcome: "The city and Aria's relationships both change.", cost: "The protected route is lost." }],
    meta: { prohibitionsSatisfied: true },
  };
}

test("voice and pacing require distributed anchors and metrics", async () => { const { request, deps } = fixture(); const result = await assessExperience(request, deps); assert.equal(result.ok, true); if (!result.ok || result.value.status !== "accepted" || result.value.artifactKind !== "chapter") return assert.fail(); const distributed = result.value.evidence.filter((item) => item.signalId === "voice" || item.signalId === "pacing"); assert.equal(distributed.every((item) => item.anchors.length >= 3), true); assert.equal(distributed.every((item) => Object.keys(item.observation.distributionMetrics ?? {}).length > 0), true); });
test("planned, negated, simulated and predicted prose cannot qualify as pacing", async () => {
  const c = contract();
  const distribution = (id: string, kind: "voice" | "pacing", metricIds: any[]) => ({ id, dimensionId: kind === "voice" ? "d1" : "d2", kind, description: "compiled distribution target", verification: { kind: "distribution" as const, metricIds, minimumAnchors: 3, requireSemanticJudge: true as const, requiredRegions: ["opening", "middle", "ending"] as any, regionSemantics: "paragraph" as const, metricThresholds: Object.fromEntries(metricIds.map((metric) => [metric, .01])) }, persistence: "chapter" as const });
  c.dimensions[0] = { ...c.dimensions[0], categories: ["voice"], observableSignals: [distribution("voice-only", "voice", ["anchor_spread", "scene_coverage", "paragraph_consistency"])] };
  c.dimensions[1] = { ...c.dimensions[1], categories: ["pacing"], observableSignals: [distribution("pacing-only", "pacing", ["anchor_spread", "scene_coverage", "beat_density", "turn_position"])] };
  const artifact = { kind: "chapter" as const, chapterId: "c1", revisionId: "v-plan", title: "Plan-only chapter", paragraphs: ["Aria plans a decisive action at dawn.", "She has not opened the gate.", "The oracle predicts pressure will rise.", "A simulated attack would change the route.", "They intend to respond tomorrow.", "Rumour says a turn might happen.", "The ending only predicts victory."] };
  const prose = sourceForArtifact(artifact); const at = (quote: string) => ({ start: prose.indexOf(quote), end: prose.indexOf(quote) + quote.length, quote });
  const common = at(artifact.paragraphs[0]);
  const claims: any[] = [
    { version: 1, eventId: "unrealized", dimensionId: "d1", signalId: "voice-only", supported: true, confidence: .9, anchors: [common, at(artifact.paragraphs[2]), at(artifact.paragraphs[5])], slotAnchorIndices: {}, metrics: { anchor_spread: 1, scene_coverage: 1, paragraph_consistency: 1 } },
    { version: 1, eventId: "unrealized", dimensionId: "d2", signalId: "pacing-only", supported: true, confidence: .9, anchors: [common, at(artifact.paragraphs[3]), at(artifact.paragraphs[6])], slotAnchorIndices: {}, metrics: { anchor_spread: 1, scene_coverage: 1, beat_density: 1, turn_position: 1 }, distributionAnchorIndices: { goal: [0], pressure: [1], beat: [1], turn: [2] } },
  ];
  const semantic: any = { version: 1, claims, sharedCause: { eventId: "unrealized", supported: true, confidence: .9, anchors: [common], links: [{ dimensionId: "d1", signalId: "voice-only", claimAnchorIndex: 0, sharedAnchorIndex: 0 }, { dimensionId: "d2", signalId: "pacing-only", claimAnchorIndex: 0, sharedAnchorIndex: 0 }] } };
  const digest = hashArtifact(artifact); const plan = scheduleExperience({ contract: c, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v-plan", expectedArtifactDigest: digest, roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "j-plan-pacing", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-plan-pacing" });
  const base = fixture(); base.state.consumedTicketIds.length = 0; base.state.revisionId = "v-plan"; base.state.artifactBindingId = plan.artifactBindingId; base.state.expectedArtifactDigest = digest;
  const result = await assessExperience({ plan, artifact }, { ...base.deps, contract: c, semanticJudgePort: { judge: async () => semantic } });
  assert.equal(result.ok, true, JSON.stringify(result)); if (result.ok) { assert.equal(result.value.status, "rewrite"); if (result.value.status === "rewrite") assert.equal(result.value.failedRuleIds.includes("evidence.not_realized"), true, JSON.stringify(result.value.failedRuleIds)); }
});
test("event modality checks the containing clause even when judge anchors crop out the negation", async () => {
  const base = fixture();
  const artifact = { ...base.request.artifact, revisionId: "v-cropped", paragraphs: [...(base.request.artifact as Extract<AssessExperienceRequest["artifact"], { kind: "chapter" }>).paragraphs] } as Extract<AssessExperienceRequest["artifact"], { kind: "chapter" }>;
  artifact.paragraphs[0] = "Aria did not open the sealed gate and the mechanism records her choice.";
  const prose = sourceForArtifact(artifact); const at = (quote: string) => ({ start: prose.indexOf(quote), end: prose.indexOf(quote) + quote.length, quote });
  const action = at("open the sealed gate and the mechanism records her choice.");
  const semantic: SemanticVerdict = { version: 1, claims: [
    { version: 1, eventId: "cropped", dimensionId: "d1", signalId: "mechanic", supported: true, confidence: .9, anchors: [at("Aria"), action], slotAnchorIndices: { actor: 0, action: 1, object: 1, outcome: 1 }, slots: { actor: "Aria", action: "open", object: "gate", outcome: "records" } },
    { version: 1, eventId: "cropped", dimensionId: "d2", signalId: "voice", supported: true, confidence: .9, anchors: [action, at("At dusk Aria wins the duel"), at("旁观者讥笑面板没有反馈，下一刻面板弹出永久奖励。")], slotAnchorIndices: {}, metrics: { anchor_spread: .8, scene_coverage: 1 } },
    { version: 1, eventId: "pace", dimensionId: "d2", signalId: "pacing", supported: true, confidence: .9, anchors: [at("The city guard lowers his spear"), at("A spare, precise sentence"), at("At dawn the rhythm turns with a clear new action.")], slotAnchorIndices: {}, metrics: { anchor_spread: .8, scene_coverage: 1 } },
  ], sharedCause: { eventId: "cropped", supported: true, confidence: .9, anchors: [action], links: [{ dimensionId: "d1", signalId: "mechanic", claimAnchorIndex: 1, sharedAnchorIndex: 0 }, { dimensionId: "d2", signalId: "voice", claimAnchorIndex: 0, sharedAnchorIndex: 0 }] } };
  const digest = hashArtifact(artifact);
  const plan = scheduleExperience({ contract: base.deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v-cropped", expectedArtifactDigest: digest, roleBindings: { protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: ["guard-id"], opponentIds: ["duelist-id"], counterparts: [{ id: "guard-id", aliases: ["guard"] }], opponents: [{ id: "duelist-id", aliases: ["duel"] }] }, chapterNumber: 1, jobId: "j-cropped", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-cropped" });
  base.state.consumedTicketIds.length = 0; base.state.revisionId = "v-cropped"; base.state.artifactBindingId = plan.artifactBindingId; base.state.expectedArtifactDigest = digest;
  const result = await assessExperience({ plan, artifact }, { ...base.deps, semanticJudgePort: { judge: async () => semantic } });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) { assert.equal(result.value.status, "rewrite"); if (result.value.status === "rewrite") assert.equal(result.value.failedRuleIds.includes("evidence.not_realized"), true); }
});
test("one whole-sentence anchor cannot assign another actor's realization to every slot", async () => {
  const sentence = "Aria did not open the gate, but Bob opened the gate while Aria watched.";
  const customSource = source.replace("Aria opens the sealed gate and the mechanism records her choice.", sentence);
  const locate = (text: string) => { const start = customSource.indexOf(text); return { start, end: start + text.length, quote: text }; };
  const base = fixture(async () => {
    const judged = verdict();
    judged.claims[0] = { ...judged.claims[0], anchors: [locate(sentence)], slotAnchorIndices: { actor: 0, action: 0, object: 0, outcome: 0 }, slots: { actor: "Aria", action: "opened", object: "gate", outcome: "opened" } };
    judged.claims[1] = { ...judged.claims[1], anchors: [locate(sentence), locate("At dusk Aria wins the duel"), locate("旁观者讥笑面板没有反馈，下一刻面板弹出永久奖励。")] };
    judged.claims[2] = { ...judged.claims[2], anchors: [locate("The city guard lowers his spear"), locate("A spare, precise sentence"), locate("At dawn the rhythm turns with a clear new action.")] };
    judged.sharedCause.anchors = [locate(sentence)];
    return judged;
  }, (value) => { value.dimensions[0].observableSignals = value.dimensions[0].observableSignals.filter((signal) => signal.id === "mechanic"); });
  const artifact = { kind: "chapter" as const, chapterId: "c1", revisionId: "v1", title: "Chapter title", paragraphs: customSource.split("\n").slice(1) };
  const digest = hashArtifact(artifact);
  const plan = scheduleExperience({ contract: base.deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v1", expectedArtifactDigest: digest, roleBindings: { protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: ["guard-id"], opponentIds: ["duelist-id"], counterparts: [{ id: "guard-id", aliases: ["guard"] }], opponents: [{ id: "duelist-id", aliases: ["duel"] }] }, chapterNumber: 1, jobId: "j-proposition-binding", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-proposition-binding" });
  base.state.consumedTicketIds.length = 0; base.state.artifactBindingId = plan.artifactBindingId; base.state.expectedArtifactDigest = digest;
  const result = await assessExperience({ plan, artifact }, base.deps);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "rewrite");
});

test("voice structure metrics cannot override a target-opposed semantic judgement", async () => {
  const opposed = fixture(async () => verdict({ claims: verdict().claims.map((claim) => claim.signalId === "voice" ? { ...claim, supported: false, metrics: { ...claim.metrics, anchor_spread: 1, scene_coverage: 1 } } : claim) }));
  const result = await assessExperience(opposed.request, opposed.deps);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "rewrite");
});
test("zero-confidence claims and shared causes never produce evidence", async () => {
  for (const semantic of [
    () => verdict({ claims: verdict().claims.map((claim, index) => index === 0 ? { ...claim, confidence: 0 } : claim) }),
    () => { const value = verdict(); value.sharedCause.confidence = 0; return value; },
  ]) {
    const input = fixture(async () => semantic()); const result = await assessExperience(input.request, input.deps);
    assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "rewrite");
  }
});
test("a generic shared action cannot bridge unrelated dimension effects", async () => {
  const generic = anchor("Aria opens the sealed gate");
  const consequence = anchor("the mechanism records her choice");
  const input = fixture(async () => {
    const value = verdict();
    value.claims[0] = { ...value.claims[0], anchors: [generic, consequence], slotAnchorIndices: { actor: 0, action: 0, object: 0, outcome: 1 } };
    value.claims[1] = { ...value.claims[1], anchors: [generic, anchor("At dusk Aria wins the duel"), anchor("旁观者讥笑面板没有反馈，下一刻面板弹出永久奖励。")] };
    value.sharedCause = { eventId: "shared-event", supported: true, confidence: .9, anchors: [generic], links: [{ dimensionId: "d1", signalId: "mechanic", claimAnchorIndex: 0, sharedAnchorIndex: 0 }, { dimensionId: "d2", signalId: "voice", claimAnchorIndex: 0, sharedAnchorIndex: 0 }] };
    return value;
  });
  const result = await assessExperience(input.request, input.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) { assert.equal(result.value.status, "rewrite"); if (result.value.status === "rewrite") assert.equal(result.value.failedRuleIds.includes("evidence.shared_cause_unsupported"), true); }
});
test("a fabricated judge quote never becomes evidence", async () => { const { request, deps } = fixture(async () => verdict({ claims: verdict().claims.map((claim, index) => index ? claim : { ...claim, anchors: [{ start: 0, end: 4, quote: "missing" }] }) })); const result = await assessExperience(request, deps); assert.equal(result.ok, true); if (!result.ok) return assert.fail(); assert.equal(result.value.status, "rewrite"); });
test("ticket and authorization failures fail closed before a judge call", async () => { let calls = 0; const { request, deps } = fixture(async () => { calls++; return verdict(); }); const altered = { ...request, plan: { ...request.plan, chapterNumber: 9 } }; const result = await assessExperience(altered, deps); assert.equal(result.ok, true); if (!result.ok) return assert.fail(); assert.equal(result.value.status, "rejected"); assert.equal(calls, 0); });
test("malformed or pre-versioned signed role payloads fail closed without invoking the judge", async () => {
  for (const mutate of [
    (roles: any) => { delete roles.counterparts; },
    (roles: any) => { delete roles.version; },
    (roles: any) => { roles.counterpartIds = [roles.protagonistId]; roles.counterparts = [{ id: roles.protagonistId, aliases: ["Guard"] }]; },
    (roles: any) => { roles.counterparts[0].aliases = [" ＡRIA "]; },
    (roles: any) => { roles.opponentIds = [roles.counterpartIds[0]]; roles.opponents = [{ id: roles.counterpartIds[0], aliases: ["Duelist"] }]; },
  ]) {
    let calls = 0; const base = fixture(async () => { calls += 1; return verdict(); }); const unsigned = structuredClone(base.request.plan) as any; delete unsigned.authorizationMac; mutate(unsigned.roleBindings); const plan = { ...unsigned, authorizationMac: signExperiencePlan(unsigned, secret) };
    const result = await assessExperience({ ...base.request, plan }, base.deps);
    assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "rejected"); assert.equal(calls, 0);
  }
});
test("all categories demand their local realized evidence", async () => { for (const slots of [{}, { actor: "Aria", action: "opens", object: "gate", outcome: "records" }]) { const { request, deps } = fixture(async () => verdict({ claims: verdict().claims.map((claim, index) => index ? claim : { ...claim, slots }) })); const result = await assessExperience(request, deps); assert.equal(result.ok, true); if (!result.ok) return assert.fail(); assert.equal(result.value.status, slots.actor ? "accepted" : "rewrite"); } });

test("anchors, artifact hashes, blueprint and retcon bindings are deterministic", async () => {
  const chapter = { kind: "chapter" as const, chapterId: "c1", revisionId: "v1", title: "T", paragraphs: ["one", "two"] };
  assert.equal(sourceForArtifact(chapter), "T\none\ntwo"); assert.equal(hashArtifact(chapter).length, 64);
  const canonicalBlueprint = { kind: "blueprint" as const, value: { meta: { z: 1 }, a: [true] } }; assert.equal(sourceForArtifact(canonicalBlueprint), '{"a":[true],"meta":{"z":1}}');
  const { request, deps, state } = fixture(); const blueprintPlan = scheduleExperience({ contract: deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "blueprint", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "j-blue", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-blue" });
  const blueprint = { kind: "blueprint" as const, value: blueprintValue(blueprintPlan) }; state.artifactBindingId = blueprintPlan.artifactBindingId; state.expectedArtifactDigest = null; const blueprintDeps = { ...deps, semanticJudgePort: { judge: async () => blueprintVerdict(blueprintPlan) } }; const acceptedBlueprint = await assessExperience({ plan: blueprintPlan, artifact: blueprint }, blueprintDeps); assert.equal(acceptedBlueprint.ok, true); if (!acceptedBlueprint.ok) return assert.fail(); assert.equal(acceptedBlueprint.value.status, "accepted");
  const chapterArtifact = request.artifact as Extract<AssessExperienceRequest["artifact"], { kind: "chapter" }>; const retconArtifact = { ...chapterArtifact, kind: "retcon_revision" as const, revisionId: "v2" }; const retconDigest = hashArtifact(retconArtifact); const retconPlan = scheduleExperience({ contract: deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "retcon_revision", chapterId: "c1", revisionId: "v2", expectedArtifactDigest: retconDigest, roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "j-retcon", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-retcon" });
  state.revisionId = "v2"; state.artifactBindingId = retconPlan.artifactBindingId; state.expectedArtifactDigest = retconDigest; const retcon = await assessExperience({ plan: retconPlan, artifact: retconArtifact }, deps); assert.equal(retcon.ok, true); if (!retcon.ok || retcon.value.status !== "accepted" || retcon.value.artifactKind !== "retcon_revision") return assert.fail(); assert.equal(retcon.value.evidence.every((item) => item.chapterRevisionId === "v2"), true); assert.equal(retcon.value.permit.revisionId, "v2");
});

test("invalid schema, unavailable model, distribution failure, and stale tickets fail closed", async () => {
  const malformed = fixture(async () => ({ version: 2 } as any)); const malformedResult = await assessExperience(malformed.request, malformed.deps); assert.equal(malformedResult.ok, false); if (!malformedResult.ok) assert.equal(malformedResult.error.code, "invalid_model_output");
  const unavailable = fixture(async () => { throw new Error("429 timeout"); }); const unavailableResult = await assessExperience(unavailable.request, unavailable.deps); assert.equal(unavailableResult.ok, false); if (!unavailableResult.ok) assert.equal(unavailableResult.error.code, "model_unavailable");
  const distributed = fixture(async () => verdict({ claims: verdict().claims.map((claim) => claim.signalId === "voice" ? { ...claim, anchors: [claim.anchors[0], claim.anchors[1], claim.anchors[1]] } : claim) })); const distributedResult = await assessExperience(distributed.request, distributed.deps); assert.equal(distributedResult.ok, true); if (!distributedResult.ok) return assert.fail(); assert.equal(distributedResult.value.status, "rewrite");
  let calls = 0; const stale = fixture(async () => { calls++; return verdict(); }); const expired = { ...stale.request.plan.ticket, expiresAt: "2026-07-16T00:00:00.000Z" }; const signedExpired = { ...expired, signature: signExperienceStageTicket(expired, secret) }; const unsigned = { ...stale.request.plan, ticket: signedExpired }; const expiredPlan = { ...unsigned, authorizationMac: signExperiencePlan(unsigned, secret) }; const expiredResult = await assessExperience({ ...stale.request, plan: expiredPlan }, stale.deps); assert.equal(expiredResult.ok, true); if (!expiredResult.ok) return assert.fail(); assert.equal(expiredResult.value.status, "rejected"); assert.equal(calls, 0);
});

test("real chapter and blueprint deadlines abort a pending judge once without consuming authorization", async () => {
  for (const artifactKind of ["chapter", "blueprint"] as const) {
    let aborts = 0; let initiallyAborted: boolean | undefined; let capturedSignal: AbortSignal | undefined;
    const pendingJudge: AssessorDependencies["semanticJudgePort"]["judge"] = async (_input, options) => new Promise((_resolve) => {
      capturedSignal = options?.signal;
      initiallyAborted = options?.signal.aborted;
      options?.signal.addEventListener("abort", () => { aborts += 1; }, { once: true });
    });
    const base = fixture(pendingJudge); let request = base.request;
    if (artifactKind === "blueprint") {
      const plan = scheduleExperience({ contract: base.deps.contract!, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "blueprint", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "deadline-blueprint", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "deadline-blueprint-ticket" });
      request = { plan, artifact: { kind: "blueprint", value: blueprintValue(plan) } };
      base.state.consumedTicketIds.length = 0; base.state.artifactBindingId = plan.artifactBindingId; base.state.expectedArtifactDigest = null;
    }
    const started = Date.now(); const result = await assessExperience(request, { ...base.deps, judgeTimeoutMs: 25 }); const elapsed = Date.now() - started;
    assert.equal(result.ok, false, artifactKind); if (!result.ok) assert.equal(result.error.code, "model_unavailable");
    assert.equal(initiallyAborted, false, artifactKind); assert.equal(capturedSignal?.aborted, true, artifactKind); assert.equal(aborts, 1, artifactKind); assert.equal(elapsed >= 15 && elapsed < 1_000, true, `${artifactKind}:${elapsed}`);
    assert.deepEqual(base.state.consumedTicketIds, []); assert.deepEqual(base.state.existingEvidenceIds, []);
  }
});

test("judge receives compiled semantics, shared cause and canon references without raw descriptors", async () => {
  let captured: any; const { request, deps } = fixture(async (input) => { captured = input; return verdict(); }); const result = await assessExperience(request, deps); assert.equal(result.ok, true); assert.equal(captured.synthesis.sharedCause, "opaque"); assert.equal(captured.signals[0].interpretation, "opaque"); assert.equal(captured.signals[0].description, "opaque"); assert.deepEqual(captured.signals[0].canonFactReferences, []); const wire = JSON.stringify(captured); assert.equal(wire.includes("opaque-a"), false); assert.equal(wire.includes("opaque-b"), false); assert.equal(Object.isFrozen(captured), true);
});

test("all five event categories cover positive, exact-confidence boundary, and negative evidence", async () => {
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
    const negativeSlots = { ...slots }; let negativeRule = "evidence.required_slot_missing";
    if (kind === "mechanic") delete negativeSlots.object;
    else if (kind === "protagonist_action") delete negativeSlots.action;
    else if (kind === "conflict_outcome") { negativeSlots.opponentId = "unknown-opponent"; negativeRule = "evidence.opponent_untrusted"; }
    else if (kind === "world_reaction") delete negativeSlots.outcome;
    else { negativeSlots.counterpartId = "unknown-counterpart"; negativeRule = "evidence.counterpart_untrusted"; }
    for (const [caseName, confidence, caseSlots, expectedStatus] of [["positive", .9, slots, "accepted"], ["boundary", .65, slots, "accepted"], ["negative", .9, negativeSlots, "rewrite"]] as const) {
      const claim = { version: 1 as const, eventId: "shared-event", dimensionId: "d1", signalId: id, supported: true, confidence, anchors, slotAnchorIndices, slots: caseSlots };
      const judged = async () => {
        const base = verdict();
        const effectSlot = kind === "relationship" ? "reciprocalAction" : kind === "world_reaction" ? "reaction" : "outcome";
        const sharedIndex = (claim.slotAnchorIndices as Record<string, number>)[effectSlot] ?? 0;
        const sharedAnchor = claim.anchors[sharedIndex];
        base.sharedCause.anchors = [sharedAnchor]; (base.sharedCause as any).links[0] = { dimensionId: "d1", signalId: id, claimAnchorIndex: sharedIndex, sharedAnchorIndex: 0 };
        base.claims[1] = { ...base.claims[1], anchors: [sharedAnchor, sharedAnchor.start < source.length / 3 ? anchor("At dusk") : anchor("Aria opens the sealed gate"), base.claims[1].anchors[2]] };
        if (kind === "relationship") base.claims[2] = { ...base.claims[2], anchors: [anchor("Aria opens the sealed gate"), anchor("A spare, precise sentence"), base.claims[2].anchors[2]] };
        return { ...base, claims: [claim, ...base.claims.slice(1)] };
      };
      const { request, deps } = fixture(judged, (c) => { c.dimensions[0].observableSignals = [{ id, dimensionId: "d1", kind: kind as any, description: "scheduled concrete event", semanticSlots: kind === "world_reaction" || kind === "relationship" ? undefined : { actor: "Aria" }, verification: policy, persistence: kind === "relationship" || kind === "mechanic" ? "cross_chapter" : "chapter" }]; });
      const result = await assessExperience(request, deps); assert.equal(result.ok, true, `${kind}:${caseName}`); if (!result.ok) continue; assert.equal(result.value.status, expectedStatus, `${kind}:${caseName}:${JSON.stringify(result.value)}`);
      if (caseName === "negative" && result.value.status === "rewrite") assert.deepEqual(result.value.failedRuleIds, [negativeRule], kind);
    }
  }
});

test("voice and pacing cover positive, exact-confidence boundary, and negative evidence", async () => {
  for (const signalId of ["voice", "pacing"] as const) for (const [caseName, confidence, expectedStatus] of [["positive", .9, "accepted"], ["boundary", .65, "accepted"], ["negative", .649, "rewrite"]] as const) {
    const input = fixture(async () => { const value = verdict(); value.claims = value.claims.map((claim) => claim.signalId === signalId ? { ...claim, confidence } : claim); return value; });
    const result = await assessExperience(input.request, input.deps);
    assert.equal(result.ok, true, `${signalId}:${caseName}`); if (result.ok) { assert.equal(result.value.status, expectedStatus, `${signalId}:${caseName}:${JSON.stringify(result.value)}`); if (caseName === "negative" && result.value.status === "rewrite") assert.deepEqual(result.value.failedRuleIds, ["evidence.judge_unsupported"]); }
  }
});

test("ticket CAS permits only one concurrent assessment and permit context is exact and one-time", async () => {
  const { request, deps } = fixture(); const [left, right] = await Promise.all([assessExperience(request, deps), assessExperience(request, deps)]); const accepted = [left, right].filter((result) => result.ok && result.value.status === "accepted"); assert.equal(accepted.length, 1); const result = accepted[0]; if (!result.ok || result.value.status !== "accepted" || result.value.artifactKind !== "chapter") return assert.fail(); const value = result.value; const context = { ticketId: value.permit.ticketId, jobId: value.permit.jobId, attempt: value.permit.attempt, contractRevisionId: value.permit.contractRevisionId, activationId: value.permit.activationId, branchId: value.permit.branchId, stage: value.permit.stage, artifactKind: value.permit.artifactKind, ruleGraphVersion: value.permit.ruleGraphVersion, expectedCanonVersion: value.permit.expectedCanonVersion, ledgerRevision: value.permit.ledgerRevision, chapterId: value.permit.chapterId, revisionId: value.permit.revisionId, artifactBindingId: value.permit.artifactBindingId, artifactHash: value.permit.artifactHash, evidenceIds: value.permit.evidenceIds, evidenceBindings: value.permit.evidenceBindings, evidenceRootHash: value.permit.evidenceRootHash, ledgerPatchHash: value.permit.ledgerPatchHash }; assert.equal(verifyPublicationPermit(value.permit, {} as any, secret, now()), false); assert.equal(verifyPublicationPermit(value.permit, { ...context, artifactBindingId: "other-binding" }, secret, now()), false); assert.equal(verifyPublicationPermit(value.permit, context, secret, now()), true); assert.equal(await consumePublicationPermit(value.permit, context, deps), true); assert.equal(await consumePublicationPermit(value.permit, context, deps), false);
});

test("wrong digest and revision fail before judge", async () => { let calls = 0; const { request, deps } = fixture(async () => { calls++; return verdict(); }); const digest = await assessExperience({ ...request, plan: { ...request.plan, expectedArtifactDigest: "wrong" } }, deps); assert.equal(digest.ok, true); if (digest.ok) assert.equal(digest.value.status, "rejected"); const chapterArtifact = request.artifact as Extract<AssessExperienceRequest["artifact"], { kind: "chapter" }>; const revision = await assessExperience({ ...request, artifact: { ...chapterArtifact, revisionId: "other" } }, deps); assert.equal(revision.ok, true); if (revision.ok) assert.equal(revision.value.status, "rejected"); assert.equal(calls, 0); });

test("an accepted assessment patch applies prospective canon facts through the real ledger authorization gate", async () => {
  const { request, deps } = fixture(); const result = await assessExperience(request, deps); assert.equal(result.ok, true);
  if (!result.ok || result.value.status !== "accepted" || result.value.artifactKind !== "chapter") return assert.fail();
  const accepted = result.value;
  const oldFact = { id: "older-canon-fact", revisionId: "v0", kind: "mechanic" };
  const canon = { branchId: "main", canonVersion: 1, factReferences: [oldFact] };
  const authorization = createLedgerAuthorization(request.plan, canon, accepted.evidence, accepted.ledgerPatch, secret, accepted.permit);
  const initial = ledger(); initial.dimensions[0].persistentResults = [oldFact];
  const updated = applyExperienceLedgerPatch(initial, accepted.ledgerPatch, { ticketSecret: secret, ticketTtlMs: 60_000, now, contract: deps.contract, authorization, liveCanon: canon });
  assert.equal(updated.revision, 2); assert.equal(accepted.canonFactCandidates.every((item) => item.evidenceId && item.anchors.length), true);
  const stored = updated.dimensions.flatMap((dimension) => dimension.persistentResults);
  assert.deepEqual(stored.map((item) => item.id).sort(), [oldFact.id, ...accepted.canonFactCandidates.map((item) => item.id)].sort());
  assert.deepEqual(accepted.ledgerPatch.canonFactCandidates, accepted.canonFactCandidates);
  assert.deepEqual(accepted.permit.evidenceBindings, sortedEvidenceBindings(accepted.evidence));

  const replacedEvidence = structuredClone(accepted.evidence);
  const replaceable = replacedEvidence.find((item) => item.signalId === "voice");
  assert.ok(replaceable);
  replaceable.observation.distributionMetrics = { ...(replaceable.observation.distributionMetrics ?? {}), anchor_spread: 0.999 };
  assert.throws(() => createLedgerAuthorization(request.plan, canon, replacedEvidence, accepted.ledgerPatch, secret, accepted.permit), { code: "unauthorized_delivery" });

  const tampered = structuredClone(accepted.ledgerPatch); tampered.canonFactCandidates[0].observation.outcome = "forged outcome";
  assert.throws(() => createLedgerAuthorization(request.plan, canon, accepted.evidence, tampered, secret, accepted.permit), { code: "unauthorized_fact" });
  assert.throws(() => applyExperienceLedgerPatch(initial, tampered, { ticketSecret: secret, ticketTtlMs: 60_000, now, contract: deps.contract, authorization, liveCanon: canon }), { code: "plan_mismatch" });
  const malformed = { ...structuredClone(accepted.ledgerPatch), canonFactCandidates: [null] } as any;
  assert.throws(() => applyExperienceLedgerPatch(initial, malformed, { ticketSecret: secret, ticketTtlMs: 60_000, now, contract: deps.contract, authorization, liveCanon: canon }), { code: "invalid_authorization_payload" });
});

test("the final ticket CAS binds the live evidence collision set and catches port failures", async () => {
  const collision = fixture(); let sawEvidenceSet = false;
  collision.deps.statePort.consumeTicket = ((input: any) => {
    sawEvidenceSet = input.expected.artifactBindingId === collision.request.plan.artifactBindingId && input.expected.expectedArtifactDigest === hashArtifact(collision.request.artifact) && Array.isArray(input.expected.existingEvidenceIds) && input.expected.existingEvidenceIds.length === 0 && Array.isArray(input.newEvidenceIds) && input.newEvidenceIds.length > 0;
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

  const actorOnly = fixture(async () => {
    const value = verdict(); const actor = anchor("Aria"); const event = anchor("opens the sealed gate and the mechanism records her choice.");
    value.claims[0] = { ...value.claims[0], anchors: [actor, event], slotAnchorIndices: { actor: 0, action: 1, object: 1, outcome: 1 } };
    value.claims[1] = { ...value.claims[1], anchors: [actor, value.claims[1].anchors[1], value.claims[1].anchors[2]] };
    value.sharedCause.anchors = [actor];
    return value;
  });
  const actorRejected = await assessExperience(actorOnly.request, actorOnly.deps);
  assert.equal(actorRejected.ok, true); if (actorRejected.ok) assert.equal(actorRejected.value.status, "rewrite");
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

  const wrongAlias = fixture(async () => {
    const value = verdict(); const common = anchor("The city guard lowers his spear");
    value.claims[0] = { version: 1, eventId: "shared-event", dimensionId: "d1", signalId: "relationship", supported: true, confidence: .9, anchors: [common, anchor("then Aria answers with a bow and they choose to travel together")], slotAnchorIndices: { actor: 1, action: 1, counterpart: 0, reciprocalAction: 0, relationshipChange: 1 } as any, slots: { actor: "Aria", action: "answers", counterpart: "city", counterpartId: "guard-id", reciprocalAction: "lowers", relationshipChange: "travel together" } as any };
    value.claims[1] = { ...value.claims[1], anchors: [common, anchor("At dusk"), value.claims[1].anchors[2]] };
    value.sharedCause.anchors = [common]; (value.sharedCause as any).links[0] = { dimensionId: "d1", signalId: "relationship", claimAnchorIndex: 0, sharedAnchorIndex: 0 };
    return value;
  }, (value) => { value.dimensions[0].observableSignals = value.dimensions[0].observableSignals.filter((signal) => signal.id === "relationship"); });
  const aliasResult = await assessExperience(wrongAlias.request, wrongAlias.deps);
  assert.equal(aliasResult.ok, true); if (aliasResult.ok) assert.equal(aliasResult.value.status, "rewrite");

  const wrongActor = fixture(async () => {
    const value = verdict(); const common = anchor("The city guard lowers his spear");
    value.claims[0] = { version: 1, eventId: "shared-event", dimensionId: "d1", signalId: "relationship", supported: true, confidence: .9, anchors: [common, anchor("then Aria answers with a bow and they choose to travel together")], slotAnchorIndices: { actor: 0, action: 0, counterpart: 0, reciprocalAction: 1, relationshipChange: 1 } as any, slots: { actor: "guard", action: "lowers", counterpart: "guard", counterpartId: "guard-id", reciprocalAction: "answers", relationshipChange: "travel together" } as any };
    value.claims[1] = { ...value.claims[1], anchors: [common, anchor("At dusk"), value.claims[1].anchors[2]] };
    value.sharedCause.anchors = [common]; (value.sharedCause as any).links[0] = { dimensionId: "d1", signalId: "relationship", claimAnchorIndex: 0, sharedAnchorIndex: 0 };
    return value;
  }, (value) => { value.dimensions[0].observableSignals = value.dimensions[0].observableSignals.filter((signal) => signal.id === "relationship"); delete value.dimensions[0].observableSignals[0].semanticSlots; });
  const actorResult = await assessExperience(wrongActor.request, wrongActor.deps);
  assert.equal(actorResult.ok, true); if (actorResult.ok) assert.equal(actorResult.value.status, "rewrite");
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

test("hard curated invariants scan the whole artifact before semantic judging", async () => {
  let calls = 0;
  const base = fixture(async () => { calls++; return verdict(); }, (value) => {
    value.prohibitions.push(
      { id: "mechanic-global", dimensionId: "both", kind: "invariant", description: "The compiled mechanism remains available.", severity: "block", ruleAdapterId: "curated-mechanic-unavailable" } as any,
      { id: "outcome-global", dimensionId: "both", kind: "invariant", description: "The compiled protagonist outcome remains fulfilled.", severity: "block", ruleAdapterId: "curated-outcome-weakened" } as any,
    );
  });
  const chapterArtifact = base.request.artifact as Extract<AssessExperienceRequest["artifact"], { kind: "chapter" }>; const artifact = { ...chapterArtifact, paragraphs: [...chapterArtifact.paragraphs, "Later the system is permanently unavailable and the protagonist surrenders."] };
  const digest = hashArtifact(artifact);
  const plan = scheduleExperience({ contract: base.deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v1", expectedArtifactDigest: digest, roleBindings: { protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: ["guard-id"], opponentIds: ["duelist-id"], counterparts: [{ id: "guard-id", aliases: ["guard"] }], opponents: [{ id: "duelist-id", aliases: ["duel"] }] }, chapterNumber: 1, jobId: "j-global-invariant", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-global-invariant" });
  base.state.consumedTicketIds.length = 0; base.state.artifactBindingId = plan.artifactBindingId; base.state.expectedArtifactDigest = digest;
  const result = await assessExperience({ plan, artifact }, base.deps);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "rewrite");
  assert.equal(calls, 0);
});

test("blueprint acceptance is semantic, pointer-grounded, and rejects a malicious ending", async () => {
  const { deps, state } = fixture();
  deps.contract.prohibitions.push(
    { id: "mechanic-ending", dimensionId: "both", kind: "invariant", description: "The compiled mechanic must remain usable.", severity: "block", ruleAdapterId: "curated-mechanic-unavailable" },
    { id: "outcome-ending", dimensionId: "both", kind: "invariant", description: "The compiled protagonist advantage must remain fulfilled.", severity: "block", ruleAdapterId: "curated-outcome-weakened" },
  );
  const plan = scheduleExperience({ contract: deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "blueprint", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "j-blue-mal", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-blue-mal" });
  const artifact = { kind: "blueprint" as const, value: blueprintValue(plan, "系统在结局前被彻底摧毁，从此再也无法启动；Aria 放弃目标并向对手投降。") };
  let calls = 0; state.consumedTicketIds.length = 0; state.artifactBindingId = plan.artifactBindingId; state.expectedArtifactDigest = null;
  const result = await assessExperience({ plan, artifact }, { ...deps, semanticJudgePort: { judge: async () => { calls++; return blueprintVerdict(plan); } } });
  assert.equal(calls, 1);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "rewrite");
  assert.deepEqual(state.consumedTicketIds, [plan.ticket.id]);
});

test("blueprint hard invariants scan canonical fields and judge pointers cannot redirect them", async () => {
  const violation = "The system is permanently unavailable and the protagonist surrenders.";
  const attacks: Array<{ name: string; mutate: (value: any, judged: any) => void }> = [
    { name: "ending target redirect", mutate: (value, judged) => { value.endingContract.target = violation; judged.ending.targetPointer = "/chapters/0/event"; } },
    { name: "ending cost redirect", mutate: (value, judged) => { value.endingContract.cost = violation; judged.ending.costPointer = "/chapters/0/cost"; } },
    { name: "chapter event", mutate: (value) => { value.chapters[0].event = violation; } },
    { name: "chapter outcome", mutate: (value) => { value.chapters[0].outcome = violation; } },
    { name: "chapter cost", mutate: (value) => { value.chapters[0].cost = violation; } },
    { name: "chapter cause", mutate: (value) => { value.chapters[0].cause = violation; } },
    { name: "shared cause", mutate: (value) => { value.sharedCause.event = violation; } },
  ];
  for (const attack of attacks) {
    const base = fixture();
    base.deps.contract.prohibitions.push(
      { id: "mechanic-canonical", dimensionId: "both", kind: "invariant", description: "The compiled mechanic must remain usable.", severity: "block", ruleAdapterId: "curated-mechanic-unavailable" },
      { id: "outcome-canonical", dimensionId: "both", kind: "invariant", description: "The protagonist outcome must remain fulfilled.", severity: "block", ruleAdapterId: "curated-outcome-weakened" },
    );
    const plan = scheduleExperience({ contract: base.deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "blueprint", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: `j-blue-${attack.name}`, attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => `t-blue-${attack.name}` });
    const value = blueprintValue(plan) as any; const judged = blueprintVerdict(plan); attack.mutate(value, judged);
    base.state.consumedTicketIds.length = 0; base.state.artifactBindingId = plan.artifactBindingId; base.state.expectedArtifactDigest = null;
    const result = await assessExperience({ plan, artifact: { kind: "blueprint", value } }, { ...base.deps, semanticJudgePort: { judge: async () => judged } });
    assert.equal(result.ok, true, attack.name); if (result.ok) assert.equal(result.value.status, "rewrite", attack.name);
  }
});

test("blueprint labels cannot masquerade as semantic delivery and confidence is non-vacuous", async () => {
  const make = (jobId: string) => {
    const base = fixture();
    const plan = scheduleExperience({ contract: base.deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "blueprint", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId, attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => `t-${jobId}` });
    base.state.consumedTicketIds.length = 0; base.state.artifactBindingId = plan.artifactBindingId; base.state.expectedArtifactDigest = null;
    return { ...base, plan };
  };

  const labels = make("blue-labels");
  const labelsValue = blueprintValue(labels.plan) as any;
  labelsValue.chapters[0].event = [...labelsValue.chapters[0].signalIds, ...labelsValue.chapters[0].promiseIds].join(" ");
  labelsValue.chapters[0].cause = labels.plan.promptProjection.dimensions.map((item) => item.id).join(" ");
  const labelsResult = await assessExperience({ plan: labels.plan, artifact: { kind: "blueprint", value: labelsValue } }, { ...labels.deps, semanticJudgePort: { judge: async () => blueprintVerdict(labels.plan) } });
  assert.equal(labelsResult.ok, true); if (labelsResult.ok) assert.equal(labelsResult.value.status, "rewrite");

  const meta = make("blue-meta"); const metaValue = blueprintValue(meta.plan) as any; metaValue.chapters[0].event = "本章成功兑现全部信号和承诺，两个维度均已满足。";
  const metaResult = await assessExperience({ plan: meta.plan, artifact: { kind: "blueprint", value: metaValue } }, { ...meta.deps, semanticJudgePort: { judge: async () => blueprintVerdict(meta.plan) } });
  assert.equal(metaResult.ok, true); if (metaResult.ok) assert.equal(metaResult.value.status, "rewrite");

  const pasted = make("blue-description-paste"); const pastedValue = blueprintValue(pasted.plan) as any;
  pastedValue.chapters[0].event = pasted.deps.contract.dimensions.flatMap((dimension) => dimension.observableSignals.map((signal) => signal.description)).join(" ");
  const pastedResult = await assessExperience({ plan: pasted.plan, artifact: { kind: "blueprint", value: pastedValue } }, { ...pasted.deps, semanticJudgePort: { judge: async () => blueprintVerdict(pasted.plan) } });
  assert.equal(pastedResult.ok, true); if (pastedResult.ok) assert.equal(pastedResult.value.status, "rewrite");

  const zero = make("blue-zero"); const zeroVerdict = blueprintVerdict(zero.plan); zeroVerdict.confidence = 0;
  const zeroResult = await assessExperience({ plan: zero.plan, artifact: { kind: "blueprint", value: blueprintValue(zero.plan) } }, { ...zero.deps, semanticJudgePort: { judge: async () => zeroVerdict } });
  assert.equal(zeroResult.ok, true); if (zeroResult.ok) assert.equal(zeroResult.value.status, "rewrite");

  const irrelevant = make("blue-irrelevant"); const irrelevantVerdict = blueprintVerdict(irrelevant.plan); irrelevantVerdict.sharedCause.supported = false;
  const irrelevantResult = await assessExperience({ plan: irrelevant.plan, artifact: { kind: "blueprint", value: blueprintValue(irrelevant.plan) } }, { ...irrelevant.deps, semanticJudgePort: { judge: async () => irrelevantVerdict } });
  assert.equal(irrelevantResult.ok, true); if (irrelevantResult.ok) assert.equal(irrelevantResult.value.status, "rewrite");
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

test("adapterless compiled rules remain available through the descriptor-free assessment projection", async () => {
  let captured: any; const adapterless = fixture(async (input) => { captured = input; return verdict(); }, (value) => { value.dimensions[0].prohibitions.push({ id: "semantic-only", dimensionId: "d1", kind: "invariant", description: "A concrete irreversible cost must remain after the choice.", severity: "rewrite" }); value.prohibitions.push(value.dimensions[0].prohibitions.at(-1)!); });
  const accepted = await assessExperience(adapterless.request, adapterless.deps);
  assert.equal(accepted.ok, true); if (accepted.ok) assert.equal(accepted.value.status, "accepted");
  assert.equal(captured.signals.find((item: any) => item.dimensionId === "d1").prohibitions.some((item: any) => item.id === "semantic-only"), true);
  assert.equal(captured.signals.find((item: any) => item.dimensionId === "d1").prohibitions.find((item: any) => item.id === "semantic-only").description, "A concrete irreversible cost must remain after the choice.");
});

test("strict state storage rejects double binding and evidence collisions", () => {
  const base = fixture();
  const digest = hashArtifact(base.request.artifact);
  const bindingPort = new StrictAssessmentStatePort();
  bindingPort.register("strict-bind", "strict-job", { ...base.state, artifactBindingId: "binding-strict", expectedArtifactDigest: null, consumedTicketIds: [], consumedPermitIds: [], consumedRepairIds: [], existingEvidenceIds: [] });
  const bindInput = { ticketId: "strict-bind", artifactBindingId: "binding-strict", artifactHash: digest, expected: { activationId: "a1", branchId: "main", canonVersion: 1, ledgerRevision: 1, attempt: 1, chapterId: "c1", revisionId: "v1", expectedArtifactDigest: null as null } };
  assert.equal(bindingPort.bindArtifactDigest!(bindInput), true);
  assert.equal(bindingPort.bindArtifactDigest!(bindInput), false);

  const collisionPort = new StrictAssessmentStatePort();
  collisionPort.register("strict-collision", "strict-job", { ...base.state, artifactBindingId: "binding-collision", expectedArtifactDigest: digest, consumedTicketIds: [], consumedPermitIds: [], consumedRepairIds: [], existingEvidenceIds: ["evidence-existing"] });
  assert.equal(collisionPort.consumeTicket({ ticketId: "strict-collision", artifactHash: digest, outcomeId: "accepted-outcome", outcome: "accepted", newEvidenceIds: ["evidence-existing"], expected: { activationId: "a1", branchId: "main", canonVersion: 1, ledgerRevision: 1, attempt: 1, chapterId: "c1", revisionId: "v1", artifactBindingId: "binding-collision", expectedArtifactDigest: digest, existingEvidenceIds: ["evidence-existing"] } }), false);
});

test("module scheduling and assessment perform first binding while permit consumption binds digest and identity", async () => {
  const base = fixture(); const statePort = new StrictAssessmentStatePort();
  const moduleDeps = { ...base.deps, statePort, interpretationPort: { interpret: async () => { throw new Error("unused"); } }, ticketTtlMs: 60_000, createTicketId: () => "strict-module-ticket" };
  const module = createReadingExperienceModule(moduleDeps);
  const artifact = base.request.artifact;
  const plan = module.schedule({ contract: base.deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v1", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: ["guard-id"], opponentIds: ["duelist-id"], counterparts: [{ id: "guard-id", aliases: ["guard"] }], opponents: [{ id: "duelist-id", aliases: ["duel"] }] }, chapterNumber: 1, jobId: "strict-module-job", attempt: 1 });
  statePort.register(plan.ticket.id, plan.ticket.jobId, { activationId: "a1", branchId: "main", canonVersion: 1, ledgerRevision: 1, attempt: 1, chapterId: "c1", revisionId: "v1", artifactBindingId: plan.artifactBindingId, expectedArtifactDigest: null, consumedTicketIds: [], consumedPermitIds: [], consumedRepairIds: [], existingEvidenceIds: [] });
  const assessed = await module.assess({ plan, artifact });
  assert.equal(assessed.ok, true, JSON.stringify(assessed));
  if (!assessed.ok || assessed.value.status !== "accepted" || assessed.value.artifactKind === "blueprint") return assert.fail();
  const publication = assessed.value;
  const { version: _version, permitId: _permitId, expiresAt: _expiresAt, signature: _signature, ...context } = publication.permit;
  statePort.mutate(plan.ticket.id, { artifactBindingId: "binding-drift" });
  assert.equal(await consumePublicationPermit(publication.permit, context, moduleDeps), false);
  statePort.mutate(plan.ticket.id, { artifactBindingId: plan.artifactBindingId });
  assert.equal(await consumePublicationPermit(publication.permit, context, moduleDeps), true);
  assert.equal(await consumePublicationPermit(publication.permit, context, moduleDeps), false);
});

test("one module can schedule and assess contract B without reading factory contract A descriptors", async () => {
  const base = fixture(); const statePort = new StrictAssessmentStatePort();
  const decoy = contract();
  Object.defineProperty(decoy.intent, "descriptors", { enumerable: true, configurable: true, get: () => { throw new Error("raw descriptors must remain compile-only"); } });
  const module = createReadingExperienceModule({ ...base.deps, contract: decoy, statePort, interpretationPort: { interpret: async () => { throw new Error("unused"); } }, ticketTtlMs: 60_000, createTicketId: () => "contract-b-ticket" });
  const plan = module.schedule({ contract: base.deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v1", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: ["guard-id"], opponentIds: ["duelist-id"], counterparts: [{ id: "guard-id", aliases: ["guard"] }], opponents: [{ id: "duelist-id", aliases: ["duel"] }] }, chapterNumber: 1, jobId: "contract-b-job", attempt: 1 });
  assert.equal(JSON.stringify(plan.assessmentContract).includes("opaque-a"), false);
  assert.equal(JSON.stringify(plan.assessmentContract).includes("opaque-b"), false);
  statePort.register(plan.ticket.id, plan.ticket.jobId, { activationId: "a1", branchId: "main", canonVersion: 1, ledgerRevision: 1, attempt: 1, chapterId: "c1", revisionId: "v1", artifactBindingId: plan.artifactBindingId, expectedArtifactDigest: null, consumedTicketIds: [], consumedPermitIds: [], consumedRepairIds: [], existingEvidenceIds: [] });
  const result = await module.assess({ plan, artifact: base.request.artifact });
  assert.equal(result.ok, true, JSON.stringify(result)); if (result.ok) assert.equal(result.value.status, "accepted", JSON.stringify(result.value));
});

test("a re-signed assessment projection with a stale immutable identity fails before judging", async () => {
  let calls = 0; const base = fixture(async () => { calls += 1; return verdict(); });
  const unsigned = structuredClone(base.request.plan) as any; delete unsigned.authorizationMac;
  unsigned.assessmentContract.dimensions[0].observableSignals[0].description = "forged assessment semantics";
  const plan = { ...unsigned, authorizationMac: signExperiencePlan(unsigned, secret) };
  const result = await assessExperience({ ...base.request, plan }, base.deps);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "rejected"); assert.equal(calls, 0);
});

test("a full repair uses a new draft binding and atomically prevents repair-token replay", async () => {
  let judgeCalls = 0;
  const base = fixture(async () => verdict()); const statePort = new StrictAssessmentStatePort();
  const moduleDeps = { ...base.deps, statePort, semanticJudgePort: { judge: async () => { judgeCalls += 1; const value = verdict(); if (judgeCalls === 1) value.claims[0].supported = false; return value; } }, interpretationPort: { interpret: async () => { throw new Error("unused"); } }, ticketTtlMs: 60_000, createTicketId: (request: any) => `repair-ticket-${request.artifactBindingId ?? request.attempt}` };
  const module = createReadingExperienceModule(moduleDeps);
  const roles = { protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: ["guard-id"], opponentIds: ["duelist-id"], counterparts: [{ id: "guard-id", aliases: ["guard"] }], opponents: [{ id: "duelist-id", aliases: ["duel"] }] };
  const firstPlan = module.schedule({ contract: base.deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v1", roleBindings: roles, chapterNumber: 1, jobId: "repair-job", attempt: 1 });
  statePort.register(firstPlan.ticket.id, firstPlan.ticket.jobId, { activationId: "a1", branchId: "main", canonVersion: 1, ledgerRevision: 1, attempt: 1, chapterId: "c1", revisionId: "v1", artifactBindingId: firstPlan.artifactBindingId, expectedArtifactDigest: null, consumedTicketIds: [], consumedPermitIds: [], consumedRepairIds: [], existingEvidenceIds: [] });
  const failed = await module.assess({ plan: firstPlan, artifact: base.request.artifact });
  assert.equal(failed.ok, true, JSON.stringify(failed)); if (!failed.ok || failed.value.status !== "rewrite") return assert.fail();
  const token = failed.value.repairToken; const expected = repairContext(token);
  const newArtifact = { ...base.request.artifact, paragraphs: [...(base.request.artifact as Extract<AssessExperienceRequest["artifact"], { kind: "chapter" }>).paragraphs, "x"] } as Extract<AssessExperienceRequest["artifact"], { kind: "chapter" }>;
  assert.notEqual(hashArtifact(newArtifact), token.artifactHash);
  const secondPlan = module.schedule({ contract: base.deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v1", artifactBindingId: "repair-binding-new", roleBindings: roles, chapterNumber: 1, repair: { token, expected }, jobId: "repair-job", attempt: 2 });
  assert.notEqual(secondPlan.artifactBindingId, token.artifactBindingId);
  statePort.register(secondPlan.ticket.id, secondPlan.ticket.jobId, { activationId: "a1", branchId: "main", canonVersion: 1, ledgerRevision: 1, attempt: 2, chapterId: "c1", revisionId: "v1", artifactBindingId: secondPlan.artifactBindingId, expectedArtifactDigest: null, consumedTicketIds: [], consumedPermitIds: [], consumedRepairIds: [], existingEvidenceIds: [] });
  const repaired = await module.assess({ plan: secondPlan, artifact: newArtifact });
  assert.equal(repaired.ok, true, JSON.stringify(repaired)); if (repaired.ok) assert.equal(repaired.value.status, "accepted", JSON.stringify(repaired.value));

  const replayPlan = module.schedule({ contract: base.deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", revisionId: "v1", artifactBindingId: "repair-binding-replay", roleBindings: roles, chapterNumber: 1, repair: { token, expected }, jobId: "repair-job", attempt: 2 });
  statePort.register(replayPlan.ticket.id, replayPlan.ticket.jobId, { activationId: "a1", branchId: "main", canonVersion: 1, ledgerRevision: 1, attempt: 2, chapterId: "c1", revisionId: "v1", artifactBindingId: replayPlan.artifactBindingId, expectedArtifactDigest: null, consumedTicketIds: [], consumedPermitIds: [], consumedRepairIds: [], existingEvidenceIds: [] });
  const callsBeforeReplay = judgeCalls; const replayed = await module.assess({ plan: replayPlan, artifact: newArtifact });
  assert.equal(replayed.ok, true); if (replayed.ok) assert.equal(replayed.value.status, "rejected"); assert.equal(judgeCalls, callsBeforeReplay);
});
