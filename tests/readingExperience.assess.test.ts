import assert from "node:assert/strict";
import test from "node:test";
import { scheduleExperience } from "../server/readingExperienceModule/scheduler";
import { assessExperience } from "../server/readingExperienceModule/assessor";
import { hashArtifact, sourceForArtifact } from "../server/readingExperienceModule/evidence";
import { signExperiencePlan, signExperienceStageTicket } from "../server/readingExperienceModule/scheduler";
import type { CompiledExperienceContractRevision, ExperienceContractActivation, ExperienceLedgerV2 } from "../src/types";
import type { AssessExperienceRequest, SemanticVerdict } from "../server/readingExperienceModule/types";

const secret = "assessor-test-secret";
const now = () => new Date("2026-07-17T00:00:00.000Z");
const source = "Chapter title\nAria opens the sealed gate and the mechanism records her choice.\nThe city guard lowers his spear, then Aria answers with a bow and they choose to travel together.\nAt dusk Aria wins the duel, and the crowd opens the road.\nA spare, precise sentence keeps the scene moving.\nAt dawn the rhythm turns with a clear new action.";

function contract(): CompiledExperienceContractRevision {
  const event = (id: string, kind: any, policy: any) => ({ id, dimensionId: "d1", kind, description: "opaque", verification: policy, persistence: kind === "mechanic" || kind === "relationship" ? "cross_chapter" : "chapter" });
  return {
    id: "r1", schemaVersion: 2, revision: 1, parentRevisionId: null,
    intent: { descriptors: [{ text: "opaque-a" }, { text: "opaque-b" }], locale: "zh-CN" },
    dimensions: [
      { id: "d1", descriptor: "opaque-a", interpretation: "opaque", categories: ["mechanic", "protagonist_action", "conflict_outcome", "world_reaction", "relationship"], observableSignals: [
        event("mechanic", "mechanic", { kind: "event_slots", requiredSlots: ["actor", "action", "outcome"], minimumAnchors: 1 }), event("action", "protagonist_action", { kind: "event_slots", requiredSlots: ["actor", "action"], minimumAnchors: 1 }), event("conflict", "conflict_outcome", { kind: "event_slots", requiredSlots: ["actor", "action", "outcome"], minimumAnchors: 1 }), event("world", "world_reaction", { kind: "event_slots", requiredSlots: ["actor", "reaction"], minimumAnchors: 1 }), event("relationship", "relationship", { kind: "relationship_change", requireReciprocalAction: true, minimumAnchors: 2 }),
      ], prohibitions: [], confidence: 1 },
      { id: "d2", descriptor: "opaque-b", interpretation: "opaque", categories: ["voice", "pacing"], observableSignals: [
        { id: "voice", dimensionId: "d2", kind: "voice", description: "opaque", verification: { kind: "distribution", metricIds: ["anchor_spread", "scene_coverage"], minimumAnchors: 3, requireSemanticJudge: true }, persistence: "chapter" },
        { id: "pacing", dimensionId: "d2", kind: "pacing", description: "opaque", verification: { kind: "distribution", metricIds: ["anchor_spread", "scene_coverage"], minimumAnchors: 3, requireSemanticJudge: true }, persistence: "chapter" },
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
  { version: 1 as const, dimensionId: "d1", signalId: "mechanic", supported: true, confidence: .9, anchors: [anchor("Aria opens the sealed gate and the mechanism records her choice.")], slots: { actor: "Aria", action: "opens", outcome: "records" } },
  { version: 1 as const, dimensionId: "d2", signalId: "voice", supported: true, confidence: .9, anchors: [anchor("The city guard lowers his spear, then Aria answers with a bow and they choose to travel together."), anchor("At dusk Aria wins the duel, and the crowd opens the road."), anchor("At dawn the rhythm turns with a clear new action.")], metrics: { anchor_spread: .8, scene_coverage: 1 } },
  { version: 1 as const, dimensionId: "d2", signalId: "pacing", supported: true, confidence: .9, anchors: [anchor("The city guard lowers his spear, then Aria answers with a bow and they choose to travel together."), anchor("At dusk Aria wins the duel, and the crowd opens the road."), anchor("At dawn the rhythm turns with a clear new action.")], metrics: { anchor_spread: .8, scene_coverage: 1 } },
]; return { version: 1, claims, ...overrides }; }
function fixture(judge = async () => verdict()) { const c = contract(); const plan = scheduleExperience({ contract: c, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c1", chapterNumber: 1, jobId: "j1", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t1" }); return { request: { plan, artifact: { kind: "chapter", chapterId: "c1", revisionId: "v1", title: "Chapter title", paragraphs: source.split("\n").slice(1) } } as AssessExperienceRequest, deps: { ticketSecret: secret, now, contract: c, semanticJudgePort: { judge }, createEvidenceId: ({ signalId, revisionId }: any) => `${signalId}-${revisionId}` } }; }

test("voice and pacing require distributed anchors and metrics", async () => { const { request, deps } = fixture(); const result = await assessExperience(request, deps); assert.equal(result.ok, true); if (!result.ok || result.value.status !== "accepted" || result.value.artifactKind !== "chapter") return assert.fail(); const distributed = result.value.evidence.filter((item) => item.signalId === "voice" || item.signalId === "pacing"); assert.equal(distributed.every((item) => item.anchors.length >= 3), true); assert.equal(distributed.every((item) => Object.keys(item.observation.distributionMetrics ?? {}).length > 0), true); });
test("a fabricated judge quote never becomes evidence", async () => { const { request, deps } = fixture(async () => verdict({ claims: [{ ...verdict().claims[0], anchors: [{ start: 0, end: 4, quote: "missing" }] }] })); const result = await assessExperience(request, deps); assert.equal(result.ok, true); if (!result.ok) return assert.fail(); assert.equal(result.value.status, "rewrite"); if (result.value.status === "rewrite") assert.ok(result.value.failedRuleIds.includes("evidence.anchor_not_grounded")); });
test("ticket and authorization failures fail closed before a judge call", async () => { let calls = 0; const { request, deps } = fixture(async () => { calls++; return verdict(); }); const altered = { ...request, plan: { ...request.plan, chapterNumber: 9 } }; const result = await assessExperience(altered, deps); assert.equal(result.ok, true); if (!result.ok) return assert.fail(); assert.equal(result.value.status, "rejected"); assert.equal(calls, 0); });
test("all categories demand their local realized evidence", async () => { for (const [signalId, slots] of [["mechanic", {}], ["action", {}], ["conflict", {}], ["world", {}], ["relationship", { actor: "Aria", action: "bows" }]] as const) { const { request, deps } = fixture(async () => verdict({ claims: [{ ...verdict().claims[0], signalId, slots }] })); const result = await assessExperience(request, deps); assert.equal(result.ok, true); if (!result.ok) return assert.fail(); assert.equal(result.value.status, "rewrite", signalId); } });

test("anchors, artifact hashes, blueprint and retcon bindings are deterministic", async () => {
  const chapter = { kind: "chapter" as const, chapterId: "c1", revisionId: "v1", title: "T", paragraphs: ["one", "two"] };
  assert.equal(sourceForArtifact(chapter), "T\none\ntwo"); assert.equal(hashArtifact(chapter).length, 64);
  const blueprint = { kind: "blueprint" as const, value: { z: 1, a: [true] } }; assert.equal(sourceForArtifact(blueprint), '{"a":[true],"z":1}');
  const { request, deps } = fixture(); const blueprintPlan = scheduleExperience({ contract: deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "blueprint", chapterNumber: 1, jobId: "j-blue", attempt: 1 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-blue" });
  const acceptedBlueprint = await assessExperience({ plan: blueprintPlan, artifact: blueprint }, deps); assert.equal(acceptedBlueprint.ok, true); if (!acceptedBlueprint.ok) return assert.fail(); assert.equal(acceptedBlueprint.value.status, "accepted");
  const retconPlan = scheduleExperience({ contract: deps.contract, activation: activation(), ledger: ledger(), canon: { branchId: "main", canonVersion: 1, factReferences: [] }, artifactKind: "retcon_revision", chapterId: "c1", chapterNumber: 1, jobId: "j-retcon", attempt: 2 }, { ticketSecret: secret, ticketTtlMs: 60_000, now, createTicketId: () => "t-retcon" });
  const retcon = await assessExperience({ plan: retconPlan, artifact: { ...request.artifact, kind: "retcon_revision", revisionId: "v2" } }, deps); assert.equal(retcon.ok, true); if (!retcon.ok || retcon.value.status !== "accepted" || retcon.value.artifactKind !== "retcon_revision") return assert.fail(); assert.equal(retcon.value.evidence.every((item) => item.chapterRevisionId === "v2"), true); assert.equal(retcon.value.permit.revisionId, "v2");
});

test("invalid schema, unavailable model, distribution failure, and stale tickets fail closed", async () => {
  const malformed = fixture(async () => ({ version: 2 } as any)); const malformedResult = await assessExperience(malformed.request, malformed.deps); assert.equal(malformedResult.ok, false); if (!malformedResult.ok) assert.equal(malformedResult.error.code, "invalid_model_output");
  const unavailable = fixture(async () => { throw new Error("429 timeout"); }); const unavailableResult = await assessExperience(unavailable.request, unavailable.deps); assert.equal(unavailableResult.ok, false); if (!unavailableResult.ok) assert.equal(unavailableResult.error.code, "model_unavailable");
  const distributed = fixture(async () => verdict({ claims: verdict().claims.map((claim) => claim.signalId === "voice" ? { ...claim, anchors: [claim.anchors[0], claim.anchors[1], claim.anchors[1]] } : claim) })); const distributedResult = await assessExperience(distributed.request, distributed.deps); assert.equal(distributedResult.ok, true); if (!distributedResult.ok) return assert.fail(); assert.equal(distributedResult.value.status, "rewrite");
  let calls = 0; const stale = fixture(async () => { calls++; return verdict(); }); const expired = { ...stale.request.plan.ticket, expiresAt: "2026-07-16T00:00:00.000Z" }; const signedExpired = { ...expired, signature: signExperienceStageTicket(expired, secret) }; const unsigned = { ...stale.request.plan, ticket: signedExpired }; const expiredPlan = { ...unsigned, authorizationMac: signExperiencePlan(unsigned, secret) }; const expiredResult = await assessExperience({ ...stale.request, plan: expiredPlan }, stale.deps); assert.equal(expiredResult.ok, true); if (!expiredResult.ok) return assert.fail(); assert.equal(expiredResult.value.status, "rejected"); assert.equal(calls, 0);
});
