import assert from "node:assert/strict";
import test from "node:test";
import { hashArtifact, groundClaim, sourceForArtifact } from "../server/readingExperienceModule/evidence";
import { scheduleExperience } from "../server/readingExperienceModule/scheduler";
import type { CompiledExperienceContractRevision, ExperienceContractActivation, ExperienceLedgerV2, ObservableSignalV2 } from "../src/types";

const now = () => new Date("2026-07-18T00:00:00.000Z");

test("artifact digest is structured and cannot collide at title/paragraph boundaries", () => {
  const left = { kind: "chapter" as const, chapterId: "c", revisionId: "r", title: "A\nB", paragraphs: ["C"] };
  const right = { kind: "chapter" as const, chapterId: "c", revisionId: "r", title: "A", paragraphs: ["B", "C"] };
  assert.equal(sourceForArtifact(left), sourceForArtifact(right));
  assert.notEqual(hashArtifact(left), hashArtifact(right));
});

test("distribution policies reject unknown local metric ids", () => {
  const source = "opening\nmiddle\nending";
  const signal = { id: "voice", dimensionId: "d", verification: { kind: "distribution", metricIds: ["totally_unknown"], minimumAnchors: 1, requireSemanticJudge: true, requiredRegions: ["opening"], regionSemantics: "paragraph", metricThresholds: { totally_unknown: 0 } } } as unknown as Pick<ObservableSignalV2, "id" | "dimensionId" | "verification">;
  const result = groundClaim(source, { version: 1, eventId: "voice-1", dimensionId: "d", signalId: "voice", supported: true, confidence: 1, anchors: [{ start: 0, end: 7, quote: "opening" }], slotAnchorIndices: {}, metrics: { totally_unknown: 1 } }, signal);
  assert.deepEqual(result, { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: "d" });
});

function contract(): CompiledExperienceContractRevision {
  const dimensions = ["d1", "d2"].map((id) => ({ id, descriptor: `raw-${id}`, interpretation: `compiled interpretation ${id}`, categories: ["mechanic"], observableSignals: [{ id: `${id}-s`, dimensionId: id, kind: "mechanic", description: "compiled observable event", verification: { kind: "event_slots", requiredSlots: ["actor", "action", "object", "outcome"], minimumAnchors: 1 }, persistence: "cross_chapter" }], prohibitions: [], confidence: 1 })) as unknown as CompiledExperienceContractRevision["dimensions"];
  return { id: "r", schemaVersion: 2, revision: 1, parentRevisionId: null, intent: { descriptors: [{ text: "raw-a" }, { text: "raw-b" }], locale: "zh-CN" }, dimensions, synthesis: { sharedCause: "compiled shared cause", dimensionRoles: ["cause role", "effect role"] }, promises: [{ id: "p1", dimensionId: "d1", scope: { kind: "every_chapter" }, hardness: "hard", minimumSignals: 1, carryRuleIds: [] }, { id: "p2", dimensionId: "d2", scope: { kind: "every_chapter" }, hardness: "hard", minimumSignals: 1, carryRuleIds: [] }], prohibitions: [], ruleGraphVersion: "g", provenance: [], createdAt: now().toISOString() };
}
const activation: ExperienceContractActivation = { id: "a", contractRevisionId: "r", branchId: "b", effectiveFromChapter: 1, effectiveFromCanonVersion: 1, effectiveThroughCanonVersion: null, activatedAt: now().toISOString() };
const ledger: ExperienceLedgerV2 = { contractRevisionId: "r", activationId: "a", revision: 1, branchId: "b", throughCanonVersion: 1, dimensions: [{ dimensionId: "d1", lastDeliveredChapter: 0, silentChapters: 0, deliveredSignalIds: [], persistentResults: [], debts: [] }, { dimensionId: "d2", lastDeliveredChapter: 0, silentChapters: 0, deliveredSignalIds: [], persistentResults: [], debts: [] }], evidenceIds: [], promiseStates: [], consumedTicketIds: [], history: [] };

test("scheduler signs trusted story roles and never guesses protagonist from signal slots", () => {
  const plan = scheduleExperience({ contract: contract(), activation, ledger, canon: { branchId: "b", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c", revisionId: "v", expectedArtifactDigest: "digest", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "j", attempt: 1 }, { now, ticketSecret: "s", ticketTtlMs: 60_000 });
  assert.deepEqual(plan.roleBindings, { protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: [], opponentIds: [] });
  assert.equal(plan.promptProjection.dimensions.every((dimension) => !("roleBindings" in dimension)), true);
});
