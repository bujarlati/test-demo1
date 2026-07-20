import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { hashArtifact, groundClaim, sourceForArtifact } from "../server/readingExperienceModule/evidence";
import { canonicalAuthorizationPayload, contractRevisionIdentity, scheduleExperience, verifyRepairAuthorization } from "../server/readingExperienceModule/scheduler";
import { consumePublicationPermit, verifyPublicationPermit } from "../server/readingExperienceModule/assessor";
import { evidenceRootHash, issuePublicationPermit, verifyPublicationPermitSignature } from "../server/readingExperienceModule/publication";
import type { ExperienceRepairToken, PublicationPermitContext } from "../server/readingExperienceModule/types";
import type { CompiledExperienceContractRevision, ExperienceContractActivation, ExperienceLedgerV2, ObservableSignalV2 } from "../src/types";
import { adapterAppliesTo, evidencePolicyFor, runRuleAdapter } from "../server/readingExperienceModule/ruleAdapters";
import { pacingFacetIsRealized } from "../server/readingExperienceModule/pacingSemantics";

const now = () => new Date("2026-07-18T00:00:00.000Z");

test("artifact digest is structured and cannot collide at title/paragraph boundaries", () => {
  const left = { kind: "chapter" as const, chapterId: "c", revisionId: "r", title: "A\nB", paragraphs: ["C"] };
  const right = { kind: "chapter" as const, chapterId: "c", revisionId: "r", title: "A", paragraphs: ["B", "C"] };
  assert.equal(sourceForArtifact(left), sourceForArtifact(right));
  assert.notEqual(hashArtifact(left), hashArtifact(right));
});

test("text anchors use UTF-16 offsets and reject code-point indexing across surrogate pairs", () => {
  const source = "序😀门打开。"; const quote = "😀门"; const start = source.indexOf(quote); const end = start + quote.length;
  const signal: Pick<ObservableSignalV2, "id" | "dimensionId" | "verification"> = { id: "unicode", dimensionId: "d", verification: { kind: "event_slots", requiredSlots: ["actor"], minimumAnchors: 1 } };
  const claim = { version: 1 as const, eventId: "unicode", dimensionId: "d", signalId: "unicode", supported: true, confidence: 1, anchors: [{ start, end, quote }], slotAnchorIndices: {} };
  const grounded = groundClaim(source, claim, signal);
  assert.equal("ruleId" in grounded, false);
  const codePointEnd = start + Array.from(quote).length;
  assert.deepEqual(groundClaim(source, { ...claim, anchors: [{ start, end: codePointEnd, quote }] }, signal), { ruleId: "evidence.anchor_not_grounded", severity: "rewrite", dimensionId: "d" });
});

test("distribution policies reject unknown local metric ids", () => {
  const source = "opening\nmiddle\nending";
  const signal = { id: "voice", dimensionId: "d", verification: { kind: "distribution", metricIds: ["totally_unknown"], minimumAnchors: 1, requireSemanticJudge: true, requiredRegions: ["opening"], regionSemantics: "paragraph", metricThresholds: { totally_unknown: 0 } } } as unknown as Pick<ObservableSignalV2, "id" | "dimensionId" | "verification">;
  const result = groundClaim(source, { version: 1, eventId: "voice-1", dimensionId: "d", signalId: "voice", supported: true, confidence: 1, anchors: [{ start: 0, end: 7, quote: "opening" }], slotAnchorIndices: {}, metrics: { totally_unknown: 1 } }, signal);
  assert.deepEqual(result, { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: "d" });
});

function contract(): CompiledExperienceContractRevision {
  const dimensions = ["d1", "d2"].map((id) => ({ id, descriptor: `raw-${id}`, interpretation: `compiled interpretation ${id}`, categories: ["mechanic"], observableSignals: [{ id: `${id}-s`, dimensionId: id, kind: "mechanic", description: "compiled observable event", verification: { kind: "event_slots", requiredSlots: ["actor", "action", "object", "outcome"], minimumAnchors: 1 }, persistence: "cross_chapter" }], prohibitions: [], confidence: 1 })) as unknown as CompiledExperienceContractRevision["dimensions"];
  const unsigned: Omit<CompiledExperienceContractRevision, "identity"> = { id: "r", schemaVersion: 2, revision: 1, parentRevisionId: null, intent: { descriptors: [{ text: "raw-a" }, { text: "raw-b" }], locale: "zh-CN" }, dimensions, synthesis: { sharedCause: "compiled shared cause", dimensionRoles: ["cause role", "effect role"] }, promises: [{ id: "p1", dimensionId: "d1", scope: { kind: "every_chapter" }, hardness: "hard", minimumSignals: 1, carryRuleIds: [] }, { id: "p2", dimensionId: "d2", scope: { kind: "every_chapter" }, hardness: "hard", minimumSignals: 1, carryRuleIds: [] }], prohibitions: [], ruleGraphVersion: "g", provenance: [], createdAt: now().toISOString() };
  return { ...unsigned, identity: contractRevisionIdentity(unsigned) };
}
const activation: ExperienceContractActivation = { id: "a", contractRevisionId: "r", branchId: "b", effectiveFromChapter: 1, effectiveFromCanonVersion: 1, effectiveThroughCanonVersion: null, activatedAt: now().toISOString() };
const ledger: ExperienceLedgerV2 = { contractRevisionId: "r", activationId: "a", revision: 1, branchId: "b", throughCanonVersion: 1, dimensions: [{ dimensionId: "d1", lastDeliveredChapter: 0, silentChapters: 0, deliveredSignalIds: [], persistentResults: [], debts: [] }, { dimensionId: "d2", lastDeliveredChapter: 0, silentChapters: 0, deliveredSignalIds: [], persistentResults: [], debts: [] }], evidenceIds: [], promiseStates: [], consumedTicketIds: [], history: [] };

test("scheduler signs trusted story roles and never guesses protagonist from signal slots", () => {
  const plan = scheduleExperience({ contract: contract(), activation, ledger, canon: { branchId: "b", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c", revisionId: "v", expectedArtifactDigest: "digest", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "j", attempt: 1 }, { now, ticketSecret: "s", ticketTtlMs: 60_000 });
  assert.deepEqual(plan.roleBindings, { version: 1, protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: [], opponentIds: [], counterparts: [], opponents: [] });
  assert.equal(plan.promptProjection.dimensions.every((dimension) => !("roleBindings" in dimension)), true);
});

function signedRepair(): ExperienceRepairToken {
  const unsigned = { version: 1 as const, repairId: "repair-1", ticketId: "old-ticket", jobId: "j", attempt: 1, contractRevisionId: "r", activationId: "a", branchId: "b", stage: "opening" as const, artifactKind: "chapter" as const, ruleGraphVersion: "g", expectedCanonVersion: 1, ledgerRevision: 1, chapterNumber: 1, chapterId: "c", revisionId: "v", artifactBindingId: "old-binding", roleBindings: { version: 1 as const, protagonistId: "aria-id", aliases: ["Aria"], counterpartIds: [], opponentIds: [], counterparts: [], opponents: [] }, artifactHash: "digest", failedRuleIds: ["evidence.not_realized"], expiresAt: "2026-07-18T00:05:00.000Z" };
  const signature = createHmac("sha256", "s").update("reading-experience:repair:v1").update("\u001f").update(canonicalAuthorizationPayload(unsigned)).digest("base64url");
  return { ...unsigned, signature };
}

test("rewrite scheduling carries a valid repair token into a fresh synchronous plan", async () => {
  const consumed = new Set<string>(); let consumes = 0;
  const token = signedRepair(); const expected = { ticketId: token.ticketId, jobId: token.jobId, attempt: token.attempt, contractRevisionId: token.contractRevisionId, activationId: token.activationId, branchId: token.branchId, stage: token.stage, artifactKind: token.artifactKind, ruleGraphVersion: (token as any).ruleGraphVersion, expectedCanonVersion: token.expectedCanonVersion, ledgerRevision: token.ledgerRevision, chapterNumber: (token as any).chapterNumber, chapterId: token.chapterId!, revisionId: token.revisionId!, artifactBindingId: (token as any).artifactBindingId, roleBindings: (token as any).roleBindings, artifactHash: token.artifactHash, failedRuleIds: token.failedRuleIds };
  const request = { contract: contract(), activation, ledger, canon: { branchId: "b", canonVersion: 1, factReferences: [] }, artifactKind: "chapter" as const, chapterId: "c", revisionId: "v", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, jobId: "j", attempt: 2, repair: { token, expected } };
  const deps: any = { now, ticketSecret: "s", ticketTtlMs: 60_000, statePort: { consumeRepair: async ({ repairId }: any) => { consumes++; if (consumed.has(repairId)) return false; consumed.add(repairId); return true; } } };
  const plan = scheduleExperience(request, deps); assert.equal(plan.stage, "rewrite"); assert.equal(plan.ticket.attempt, 2); assert.equal(plan.expectedArtifactDigest, undefined); assert.notEqual(plan.artifactBindingId, (token as any).artifactBindingId); assert.deepEqual((plan as any).repairRuleIds, token.failedRuleIds); assert.equal(consumes, 0);
  assert.equal(scheduleExperience(request, deps).repairAuthorization?.token.repairId, token.repairId);
  assert.throws(() => scheduleExperience({ ...request, attempt: 3 }, deps), { code: "plan_mismatch" });
  assert.throws(() => scheduleExperience({ ...request, repair: { token: { ...token, failedRuleIds: ["forged"] }, expected } }, deps), { code: "plan_mismatch" });

  let prematureConsumes = 0;
  const freshDeps: any = { ...deps, statePort: { consumeRepair: () => { prematureConsumes++; return true; } } };
  assert.throws(() => scheduleExperience({ ...request, stage: "opening" }, freshDeps), { code: "invalid_stage" });
  assert.equal(prematureConsumes, 0);
});

test("failedRuleIds is a compatibility assertion, never a rewrite authorization", () => {
  assert.throws(() => scheduleExperience({ contract: contract(), activation, ledger, canon: { branchId: "b", canonVersion: 1, factReferences: [] }, artifactKind: "chapter", chapterId: "c", revisionId: "v", expectedArtifactDigest: "digest", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, failedRuleIds: ["evidence.not_realized"], jobId: "j", attempt: 1 }, { now, ticketSecret: "s", ticketTtlMs: 60_000 }), { code: "repair_authorization_required" });

  const token = signedRepair();
  const expected = { ticketId: token.ticketId, jobId: token.jobId, attempt: token.attempt, contractRevisionId: token.contractRevisionId, activationId: token.activationId, branchId: token.branchId, stage: token.stage, artifactKind: token.artifactKind, ruleGraphVersion: token.ruleGraphVersion, expectedCanonVersion: token.expectedCanonVersion, ledgerRevision: token.ledgerRevision, chapterNumber: token.chapterNumber, chapterId: token.chapterId!, revisionId: token.revisionId!, artifactBindingId: token.artifactBindingId, roleBindings: token.roleBindings, artifactHash: token.artifactHash, failedRuleIds: token.failedRuleIds };
  const base = { contract: contract(), activation, ledger, canon: { branchId: "b", canonVersion: 1, factReferences: [] }, artifactKind: "chapter" as const, chapterId: "c", revisionId: "v", artifactBindingId: "new-binding", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, repair: { token, expected }, jobId: "j", attempt: 2 };
  const deps = { now, ticketSecret: "s", ticketTtlMs: 60_000 };
  assert.deepEqual(scheduleExperience({ ...base, failedRuleIds: ["evidence.not_realized"] }, deps).repairRuleIds, ["evidence.not_realized"]);
  assert.throws(() => scheduleExperience({ ...base, failedRuleIds: ["different-rule"] }, deps), { code: "plan_mismatch" });
  assert.throws(() => scheduleExperience({ ...base, failedRuleIds: ["evidence.not_realized", "evidence.not_realized"] }, deps), { code: "plan_mismatch" });
});

function publicationFixture() {
  const context: PublicationPermitContext = {
    ticketId: "publication-ticket", jobId: "publication-job", attempt: 1, contractRevisionId: "r", activationId: "a", branchId: "b",
    stage: "opening", artifactKind: "chapter", ruleGraphVersion: "g", expectedCanonVersion: 1, ledgerRevision: 1,
    chapterId: "c", revisionId: "v", artifactBindingId: "publication-binding", artifactHash: "artifact-digest",
    evidenceIds: [], evidenceBindings: [], evidenceRootHash: evidenceRootHash([]), ledgerPatchHash: "a".repeat(64),
  };
  const permit = issuePublicationPermit(context, "publication-permit", "2026-07-18T00:05:00.000Z", "s");
  const state = {
    activationId: "a", branchId: "b", canonVersion: 1, ledgerRevision: 1, attempt: 1,
    consumedTicketIds: ["publication-ticket"], consumedPermitIds: [], consumedRepairIds: [], existingEvidenceIds: [],
    chapterId: "c", revisionId: "v", artifactBindingId: "publication-binding", expectedArtifactDigest: "artifact-digest",
  };
  return { context, permit, state };
}

test("publication verification rejects accessors without executing them", () => {
  const { context, permit } = publicationFixture(); let getterReads = 0;
  const accessorPermit = { ...permit } as typeof permit;
  Object.defineProperty(accessorPermit, "expiresAt", { enumerable: true, configurable: true, get: () => { getterReads += 1; return permit.expiresAt; } });
  assert.equal(verifyPublicationPermitSignature(accessorPermit, context, "s"), false);
  assert.equal(verifyPublicationPermit(accessorPermit, context, "s", now()), false);
  assert.equal(getterReads, 0);
});

test("publication verification and consumption snapshot proxies once and never use raw getters", async () => {
  const { context, permit, state } = publicationFixture(); let rawGets = 0; let reads = 0; let consumes = 0;
  const tracked = <T extends object>(value: T): T => new Proxy(value, { get(target, key, receiver) { rawGets += 1; return Reflect.get(target, key, receiver); } });
  const proxiedPermit = tracked(permit); const proxiedContext = tracked(context);
  assert.equal(verifyPublicationPermit(proxiedPermit, proxiedContext, "s", now()), true);
  assert.equal(rawGets, 0);
  const deps: any = {
    now, ticketSecret: "s",
    statePort: {
      read: async () => { reads += 1; permit.ticketId = "raw-drift"; context.ticketId = "raw-drift"; return state; },
      consumePermit: async (input: any) => { consumes += 1; assert.equal(input.permitId, permit.permitId); assert.equal(input.ticketId, "publication-ticket"); assert.equal(input.context.ticketId, "publication-ticket"); return true; },
    },
  };
  assert.equal(await consumePublicationPermit(proxiedPermit, proxiedContext, deps), true);
  assert.equal(rawGets, 0); assert.equal(reads, 1); assert.equal(consumes, 1);
});

test("invalid publication accessors and throwing snapshots fail closed before state ports", async () => {
  const { context, permit, state } = publicationFixture(); let getterReads = 0; let reads = 0; let consumes = 0;
  const accessorPermit = { ...permit } as typeof permit;
  Object.defineProperty(accessorPermit, "ticketId", { enumerable: true, configurable: true, get: () => { getterReads += 1; return permit.ticketId; } });
  const deps: any = {
    now, ticketSecret: "s",
    statePort: {
      read: async () => { reads += 1; return state; },
      consumePermit: async () => { consumes += 1; return true; },
    },
  };
  assert.equal(await consumePublicationPermit(accessorPermit, context, deps), false);
  assert.equal(getterReads, 0); assert.equal(reads, 0); assert.equal(consumes, 0);

  const oversizedPermit = { ...permit, permitId: "p".repeat(1_000_001) };
  assert.equal(await consumePublicationPermit(oversizedPermit, context, deps), false);
  assert.equal(reads, 0); assert.equal(consumes, 0);

  const throwing = new Proxy(permit, { ownKeys: () => { throw new Error("snapshot failure"); } });
  assert.equal(await consumePublicationPermit(throwing, context, deps), false);
  assert.equal(reads, 0); assert.equal(consumes, 0);

  const accessorState = { ...state };
  Object.defineProperty(accessorState, "activationId", { enumerable: true, configurable: true, get: () => { getterReads += 1; return state.activationId; } });
  const stateDeps: any = { ...deps, statePort: { read: async () => { reads += 1; return accessorState; }, consumePermit: async () => { consumes += 1; return true; } } };
  assert.equal(await consumePublicationPermit(permit, context, stateDeps), false);
  assert.equal(getterReads, 0); assert.equal(reads, 1); assert.equal(consumes, 0);
});

test("repair scheduling snapshots request and token proxies and rejects accessors without execution", () => {
  const token = signedRepair(); const expected = { ticketId: token.ticketId, jobId: token.jobId, attempt: token.attempt, contractRevisionId: token.contractRevisionId, activationId: token.activationId, branchId: token.branchId, stage: token.stage, artifactKind: token.artifactKind, ruleGraphVersion: token.ruleGraphVersion, expectedCanonVersion: token.expectedCanonVersion, ledgerRevision: token.ledgerRevision, chapterNumber: token.chapterNumber, chapterId: token.chapterId!, revisionId: token.revisionId!, artifactBindingId: token.artifactBindingId, roleBindings: token.roleBindings, artifactHash: token.artifactHash, failedRuleIds: token.failedRuleIds };
  const base = { contract: contract(), activation, ledger, canon: { branchId: "b", canonVersion: 1, factReferences: [] }, artifactKind: "chapter" as const, chapterId: "c", revisionId: "v", artifactBindingId: "new-binding", roleBindings: { protagonistId: "aria-id", aliases: ["Aria"] }, chapterNumber: 1, repair: { token, expected }, jobId: "j", attempt: 2 };
  let rawGets = 0;
  const trackedToken = new Proxy(token, { get(target, key, receiver) { rawGets += 1; return Reflect.get(target, key, receiver); } });
  const trackedExpected = new Proxy(expected, { get(target, key, receiver) { rawGets += 1; return Reflect.get(target, key, receiver); } });
  assert.equal(verifyRepairAuthorization(trackedToken, trackedExpected, "s", now()), true);
  assert.equal(rawGets, 0);
  const trackedRequest = new Proxy({ ...base, repair: { token: trackedToken, expected: trackedExpected } }, { get(target, key, receiver) { rawGets += 1; return Reflect.get(target, key, receiver); } });
  assert.equal(scheduleExperience(trackedRequest, { now, ticketSecret: "s", ticketTtlMs: 60_000 }).stage, "rewrite");
  assert.equal(rawGets, 0);

  let getterReads = 0; let nowCalls = 0;
  const accessorToken = { ...token } as ExperienceRepairToken;
  Object.defineProperty(accessorToken, "expiresAt", { enumerable: true, configurable: true, get: () => { getterReads += 1; return token.expiresAt; } });
  assert.equal(verifyRepairAuthorization(accessorToken, expected, "s", now()), false);
  assert.equal(getterReads, 0);
  assert.throws(() => scheduleExperience({ ...base, repair: { token: accessorToken, expected } }, { now: () => { nowCalls += 1; return now(); }, ticketSecret: "s", ticketTtlMs: 60_000 }), { code: "invalid_authorization_payload" });
  assert.equal(getterReads, 0); assert.equal(nowCalls, 0);

  const shared = { payload: "x".repeat(600_000) }; let amplifiedNowCalls = 0; let ticketIdCalls = 0;
  const amplified = { ...base, amplification: Array.from({ length: 20 }, () => shared) } as typeof base;
  assert.throws(() => scheduleExperience(amplified, { now: () => { amplifiedNowCalls += 1; return now(); }, ticketSecret: "s", ticketTtlMs: 60_000, createTicketId: () => { ticketIdCalls += 1; return "unexpected"; } }), { code: "invalid_authorization_payload" });
  assert.equal(amplifiedNowCalls, 0); assert.equal(ticketIdCalls, 0);
});

test("deterministic modality adapters reject unrealized events but allow explicit realization reversals", () => {
  const unrealized: Array<[any, string]> = [
    ["event-negated", "Aria did not open the gate."],
    ["event-intent", "Aria plans to open the gate tomorrow."],
    ["event-failed-attempt", "Aria attempted and failed to open the gate."],
    ["event-simulation", "In a dream simulation Aria opened the gate."],
    ["event-simulation", "The oracle predicted Aria would open the gate."],
    ["event-hearsay", "Rumour says Aria opened the gate."],
    ["helper-substitution", "A helper opened it for Aria."],
    ["contains-pasted-label", "The descriptor label says she is invincible."],
  ];
  for (const [id, text] of unrealized) assert.equal(runRuleAdapter(id, text), true, `${id}:${text}`);
  assert.equal(runRuleAdapter("event-negated", "他没有退后，反而击败了守卫。"), false);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "敌人讥笑面板没有反馈，下一刻面板弹出永久奖励。"), false);
  assert.equal(runRuleAdapter("curated-outcome-weakened", "旁观者误以为主角惨败，尘埃散去他毫发无损并一击制胜。"), false);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "The enemy said the system was unavailable, but Aria did not hesitate and the system became available with a reward."), false);
  assert.equal(runRuleAdapter("curated-outcome-weakened", "Onlookers thought the protagonist lost, but Aria did not hesitate and she won the victory.", [], { protagonistAliases: ["Aria"] }), false);
  assert.equal(runRuleAdapter("curated-outcome-weakened", "Onlookers thought Mira lost, but Mira won the victory.", [], { protagonistAliases: ["Mira"] }), false);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "The enemy said the system was unavailable, but the system is not available."), true);
  assert.equal(runRuleAdapter("curated-outcome-weakened", "Onlookers thought the protagonist lost, but she did not win the victory."), true);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "The system was unavailable, but the system plans and activates."), true);
  assert.equal(runRuleAdapter("curated-outcome-weakened", "Onlookers thought the protagonist lost, but she plans and wins the victory."), true);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "The system was unavailable, but the system does not activate and work."), true);
  assert.equal(runRuleAdapter("curated-outcome-weakened", "Onlookers thought the protagonist lost, but she does not recover and win the victory."), true);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "The system was unavailable, but in a dream the system recovered and activated."), true);
  assert.equal(runRuleAdapter("curated-outcome-weakened", "Onlookers thought the protagonist lost, but in a dream she recovered and won the victory."), true);
  assert.equal(runRuleAdapter("curated-outcome-weakened", "Onlookers thought the protagonist lost, but in a dream she recovered and she won the victory."), true);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "The system is permanently unavailable, but in a dream the system remains dark but the system activates with a reward."), true);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "Aria's system is permanently unavailable, but Bob's system activates with a reward."), true);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "主角的系统永久失效，却敌人的系统启动并发放奖励。"), true);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "Aria's system is permanently unavailable, but the system activates with a reward."), false);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "面板没有反馈，随后阿丽雅打开窗户。"), true);
  assert.equal(runRuleAdapter("curated-outcome-weakened", "主角惨败，随后阿丽雅打开窗户。"), true);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "面板没有反馈，下一刻面板弹出奖励；后来系统永久失效。"), true);
  assert.equal(runRuleAdapter("event-negated", "Aria did not open the gate, but Bob opened the gate.", ["Aria", "open", "gate"]), true);
  assert.equal(runRuleAdapter("event-negated", "Aria did not open the gate, but Bob opened the gate while Aria watched.", ["Aria", "open", "gate"]), true);
  assert.equal(runRuleAdapter("event-negated", "Aria did not open the gate, but Aria opened the window.", ["Aria", "open", "gate"]), true);
  assert.equal(runRuleAdapter("event-negated", "Aria did not open the gate, but Aria opened the gate.", ["Aria", "open", "gate"]), false);
  const completeBinding = { actor: "Aria", action: "open", object: "gate", outcome: "victory", requiredSlots: ["actor", "action", "object", "outcome"] } as const;
  const negatedTail = "Aria planned to open the gate and claim victory, but Aria did not open the gate or claim victory.";
  assert.equal(runRuleAdapter("event-intent", negatedTail, completeBinding as any), true);
  assert.equal(runRuleAdapter("event-negated", negatedTail, completeBinding as any), true);
  for (const contractedTail of [
    "Aria planned to open the gate and claim victory, but Aria doesn't open the gate or claim victory.",
    "Aria planned to open the gate and claim victory, but Aria won't open the gate or claim victory.",
    "Aria planned to retreat, but Aria will not retreat and open the gate or claim victory.",
    "Aria planned to retreat, but Aria did not retreat and open the gate or claim victory.",
  ]) {
    assert.equal(runRuleAdapter("event-intent", contractedTail, completeBinding as any), true);
    assert.equal(runRuleAdapter("event-negated", contractedTail, completeBinding as any), true);
  }
  const chineseBinding = { actor: "阿丽雅", action: "打开", object: "城门", outcome: "胜利", requiredSlots: ["actor", "action", "object", "outcome"] } as const;
  const chineseNegatedTail = "阿丽雅计划打开城门并取得胜利，却阿丽雅不打开城门也不取得胜利。";
  assert.equal(runRuleAdapter("event-intent", chineseNegatedTail, chineseBinding as any), true);
  assert.equal(runRuleAdapter("event-negated", chineseNegatedTail, chineseBinding as any), true);
  assert.equal(runRuleAdapter("event-negated", "阿丽雅不退后并打开城门，也不取得胜利。", chineseBinding as any), true);
  for (const affirmativeIdiom of [
    "阿丽雅不得不打开城门并取得胜利。",
    "阿丽雅不由得打开城门并取得胜利。",
    "阿丽雅毫不犹豫地打开城门并取得胜利。",
    "阿丽雅战无不胜，随后打开城门并取得胜利。",
  ]) assert.equal(runRuleAdapter("event-negated", affirmativeIdiom, chineseBinding as any), false, affirmativeIdiom);
  for (const unrealizedTail of [
    "Aria planned to retreat, but Aria plans to open the gate for victory.",
    "Aria planned to retreat, but Aria attempted to open the gate for victory.",
    "Aria planned to retreat, but in a dream Aria opened the gate for victory.",
    "Aria planned to retreat, but rumour says Aria opened the gate for victory.",
  ]) assert.equal(runRuleAdapter("event-intent", unrealizedTail, completeBinding as any), true, unrealizedTail);
  for (const cancelledOnly of [
    "Aria abandoned the plan to open the gate and claim victory.",
    "Aria cancelled the plan to open the gate and claim victory.",
    "Aria dropped the plan to open the gate and claim victory.",
    "Aria abandoned the plan to retreat or open the gate and claim victory.",
    "Aria abandoned the plan to retreat and open the gate and claim victory.",
  ]) assert.equal(runRuleAdapter("event-intent", cancelledOnly, completeBinding as any), true, cancelledOnly);
  assert.equal(runRuleAdapter("event-intent", "阿丽雅放弃了计划打开城门并取得胜利。", chineseBinding as any), true);
  assert.equal(runRuleAdapter("event-intent", "阿丽雅放弃了计划退后并打开城门并取得胜利。", chineseBinding as any), true);
  assert.equal(runRuleAdapter("event-intent", "阿丽雅放弃了退后并打开城门并取得胜利的计划。", chineseBinding as any), true);
  assert.equal(runRuleAdapter("event-intent", "Aria cancelled the plan and in it Aria opened the gate for victory.", completeBinding as any), true);
  assert.equal(runRuleAdapter("event-intent", "阿丽雅放弃计划并打开城门并取得胜利。", chineseBinding as any), false);
  assert.equal(runRuleAdapter("event-negated", "阿丽雅没有退后并打开城门并取得胜利。", chineseBinding as any), false);
  assert.equal(runRuleAdapter("event-negated", "阿丽雅没有打开城门并取得胜利。", chineseBinding as any), true);
  assert.equal(runRuleAdapter("event-negated", "阿丽雅未能退后并打开城门并取得胜利。", chineseBinding as any), true);
  for (const [id, unrealizedCoordination] of [
    ["event-simulation", "In a dream Aria retreated and opened the gate for victory."],
    ["event-simulation", "In a dream Aria retreated and Aria opened the gate for victory."],
    ["event-simulation", "The oracle predicted Aria retreated and opened the gate for victory."],
    ["event-hearsay", "Rumour says Aria retreated and opened the gate for victory."],
    ["event-hearsay", "Rumour says Aria retreated and Aria opened the gate for victory."],
    ["event-simulation", "In a dream Aria retreated then Aria opened the gate for victory."],
    ["event-simulation", "In a dream: Aria retreated; Aria opened the gate for victory."],
    ["event-hearsay", "Rumour says Aria retreated but Aria opened the gate for victory."],
    ["event-hearsay", "据说阿丽雅先退后，然后阿丽雅打开城门并取得胜利。"],
  ] as const) assert.equal(runRuleAdapter(id, unrealizedCoordination, completeBinding as any), true, unrealizedCoordination);
  for (const actualAfterReport of [
    "Aria heard the alarm and opened the gate for victory.",
    "Aria dismissed the rumour and opened the gate for victory.",
    "The dream ended and Aria opened the gate for victory.",
    "Aria woke from the dream and opened the gate for victory.",
    "Aria rejected the prediction and opened the gate for victory.",
  ]) assert.equal(runRuleAdapter(actualAfterReport.includes("rumour") || actualAfterReport.includes("heard") ? "event-hearsay" : "event-simulation", actualAfterReport, completeBinding as any), false, actualAfterReport);
  for (const foreignActor of [
    "Aria did not open the gate and Bob opened the gate for victory.",
    "Aria did not open the gate or Bob opened the gate for victory.",
    "Aria did not open the gate but Bob opened the gate for victory.",
    "Aria did not open the gate and the gate opened itself for victory.",
    "Aria did not open the gate and Holly opened the gate for victory.",
    "Aria did not open the gate and after Bob arrived Bob opened the gate for victory.",
    "Aria did not open the gate and Bob stood beside Aria and opened the gate for victory.",
    "Aria did not open the gate, but Aria's clone opened the gate for victory.",
    "Aria did not hesitate to watch Bob open the gate for victory.",
  ]) assert.equal(runRuleAdapter("event-negated", foreignActor, completeBinding as any), true, foreignActor);
  for (const foreignEffect of [
    "Aria planned to retreat, but Aria opened the gate and Bob claimed victory.",
    "Aria did not open the gate and Aria opened the gate but Bob claimed victory.",
    "Aria abandoned the plan to open the gate and opened the window for victory.",
    "Aria planned to retreat, but Aria opened the gate beside a banner reading victory.",
    "Aria did not win and opened the gate hoping for victory.",
  ]) assert.equal(runRuleAdapter(foreignEffect.includes("did not") ? "event-negated" : "event-intent", foreignEffect, completeBinding as any), true, foreignEffect);
  const relationshipBinding = { actor: "Aria", action: "bowed", counterpart: "guard", reciprocalAction: "lowered", relationshipChange: "travel together", requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"] } as const;
  assert.equal(runRuleAdapter("event-intent", "Aria planned to leave, but Aria bowed to the guard and Bob lowered his spear and Bob chose to travel together.", relationshipBinding as any), true);
  assert.equal(runRuleAdapter("event-negated", "阿丽雅没有打开城门并鲍勃打开城门取得胜利。", chineseBinding as any), true);
  for (const affirmativeExpression of [
    "阿丽雅忍不住打开城门并取得胜利。",
    "阿丽雅情不自禁地打开城门并取得胜利。",
    "阿丽雅迫不及待地打开城门并取得胜利。",
    "阿丽雅不假思索地打开城门并取得胜利。",
    "阿丽雅毫不费力地打开城门并取得胜利。",
    "阿丽雅不慌不忙地打开城门并取得胜利。",
    "阿丽雅不费吹灰之力打开城门并取得胜利。",
    "阿丽雅不露声色地打开城门并取得胜利。",
    "阿丽雅不顾一切打开城门并取得胜利。",
    "阿丽雅不遗余力地打开城门并取得胜利。",
    "阿丽雅不得已打开城门并取得胜利。",
    "阿丽雅不惜代价打开城门并取得胜利。",
    "阿丽雅以无坚不摧之势打开城门并取得胜利。",
    "阿丽雅无所不能地打开城门并取得胜利。",
  ]) assert.equal(runRuleAdapter("event-negated", affirmativeExpression, chineseBinding as any), false, affirmativeExpression);
  for (const [action, object, realized] of [
    ["struck", "guard", "Aria did not hesitate and struck the guard for victory."],
    ["slew", "beast", "Aria did not hesitate and slew the beast for victory."],
    ["cut", "rope", "Aria did not hesitate and Aria cut the rope for victory."],
    ["broke", "seal", "Aria did not hesitate and broke the seal for victory."],
    ["ran", "gauntlet", "Aria did not hesitate and ran the gauntlet for victory."],
  ] as const) {
    const genericBinding = { actor: "Aria", action, object, outcome: "victory", requiredSlots: ["actor", "action", "object", "outcome"] } as const;
    assert.equal(runRuleAdapter("event-negated", realized, genericBinding as any), false, realized);
  }
  for (const [action, object, realized] of [
    ["struck", "guard", "Aria did not retreat and struck the guard for victory."],
    ["slew", "beast", "Aria never retreated and slew the beast for victory."],
    ["broke", "seal", "Aria never retreated and broke the seal for victory."],
    ["ran", "gauntlet", "Aria did not retreat and ran the gauntlet for victory."],
  ] as const) assert.equal(runRuleAdapter("event-negated", realized, { actor: "Aria", action, object, outcome: "victory", requiredSlots: ["actor", "action", "object", "outcome"] } as any), false, realized);
  assert.equal(runRuleAdapter("event-negated", "Aria did not wait or open the gate for victory.", completeBinding as any), true);
  assert.equal(runRuleAdapter("event-negated", "Aria did not hesitate and open the gate for victory.", completeBinding as any), true);
  assert.equal(runRuleAdapter("event-negated", "Aria did not hesitate to open the gate for victory.", completeBinding as any), false);
  for (const fulfilledPlan of [
    "Aria followed the plan and opened the gate for victory.",
    "Aria executed the plan and opened the gate for victory.",
    "Aria completed the plan and opened the gate for victory.",
  ]) assert.equal(runRuleAdapter("event-intent", fulfilledPlan, completeBinding as any), false, fulfilledPlan);
  assert.equal(runRuleAdapter("event-failed-attempt", "她险些打开门。"), true);
  assert.equal(runRuleAdapter("event-negated", "他没有退后，而是迎面击败守卫。"), false);
  assert.equal(runRuleAdapter("event-negated", "Aria not only opened the gate but also crossed it."), false);
  assert.equal(runRuleAdapter("curated-outcome-weakened", "主角惨败，随后他在复赛获胜。"), true);
  for (const [id, text] of [["event-negated", "她并未打开门。"], ["event-intent", "她准备明日行动。"], ["event-failed-attempt", "她尝试打开门。"], ["event-simulation", "她幻想自己已经获胜。"], ["event-hearsay", "听说她打开了门。"]] as const) assert.equal(runRuleAdapter(id, text), true, `${id}:${text}`);
});

test("deterministic modality adapters resist nested reports, identity swaps, and lexical scope evasions", () => {
  const binding = { actor: "Aria", action: "open", object: "gate", outcome: "victory", requiredSlots: ["actor", "action", "object", "outcome"] } as const;
  const chineseBinding = { actor: "阿丽雅", action: "打开", object: "城门", outcome: "胜利", requiredSlots: ["actor", "action", "object", "outcome"] } as const;

  for (const nestedReport of [
    'Rumour says: "Aria retreated. Aria opened the gate for victory."',
    'In a dream: "Aria retreated. Aria opened the gate for victory."',
    'The oracle predicted: "Aria retreated. Aria opened the gate for victory."',
  ]) assert.equal(runRuleAdapter(nestedReport.startsWith("Rumour") ? "event-hearsay" : "event-simulation", nestedReport, binding as any), true, nestedReport);
  for (const nestedMechanic of [
    'The system is permanently unavailable, but in a dream: "The system stayed dark. The system activates with a reward."',
    'The system is permanently unavailable, but rumour says: "The system stayed dark. The system activates with a reward."',
    "The system is permanently unavailable, but in a dream: 'The dream ended. The system activates with a reward.'",
    "The system is permanently unavailable, but in a dream the narrator said actually the system activates with a reward.",
  ]) assert.equal(runRuleAdapter("curated-mechanic-unavailable", nestedMechanic), true, nestedMechanic);

  for (const ownerSwap of [
    "Her system is permanently unavailable, but his system activates with a reward.",
    "The system serving Aria is permanently unavailable, but the system serving Bob activates with a reward.",
    "The system belonging to Aria is permanently unavailable, but the system belonging to Bob activates with a reward.",
    "The system was permanently unavailable, but another system activates with a reward.",
    "The system was permanently unavailable, but Bob claimed the system activates with a reward.",
    "The system was permanently unavailable, but a banner reads system available.",
  ]) assert.equal(runRuleAdapter("curated-mechanic-unavailable", ownerSwap), true, ownerSwap);
  assert.equal(runRuleAdapter("curated-mechanic-unavailable", "Aria's system is permanently unavailable, but her system activates with a reward."), false);

  for (const [id, unrealizedWording] of [
    ["event-intent", "阿丽雅想要打开城门并取得胜利。"],
    ["event-failed-attempt", "阿丽雅试着打开城门并取得胜利。"],
    ["event-simulation", "阿丽雅似乎打开城门并取得胜利。"],
    ["event-hearsay", "据报道阿丽雅打开城门并取得胜利。"],
    ["event-intent", "Aria wanted to open the gate for victory."],
    ["event-simulation", "Aria pretended to open the gate for victory."],
    ["event-hearsay", "Bob said Aria opened the gate for victory."],
  ] as const) assert.equal(runRuleAdapter(id, unrealizedWording, id.startsWith("event-") ? (unrealizedWording.includes("阿丽雅") ? chineseBinding : binding) as any : undefined), true, unrealizedWording);

  for (const hearsay of [
    "Aria heard Aria opened the gate for victory.",
    "Aria dismissed the rumour that Aria opened the gate for victory.",
  ]) assert.equal(runRuleAdapter("event-hearsay", hearsay, binding as any), true, hearsay);
  for (const actualAfterDirectSpeech of [
    "Aria said the password and opened the gate for victory.",
    "Aria reported for duty and opened the gate for victory.",
    "Aria claimed the prize and opened the gate for victory.",
  ]) assert.equal(runRuleAdapter("event-hearsay", actualAfterDirectSpeech, binding as any), false, actualAfterDirectSpeech);
  for (const simulation of [
    "Aria dreamed she opened the gate for victory.",
    "Aria dreamt she opened the gate for victory.",
    "In a dream Aria retreated. Aria opened the gate for victory.",
    "Aria rejected the prediction that Aria opened the gate for victory.",
    "Aria woke from the dream where Aria opened the gate for victory.",
  ]) assert.equal(runRuleAdapter("event-simulation", simulation, binding as any), true, simulation);

  for (const cancelledReference of [
    "Aria cancelled the plan, in which Aria opened the gate for victory.",
    "Aria cancelled the plan; in it Aria opened the gate for victory.",
  ]) assert.equal(runRuleAdapter("event-intent", cancelledReference, binding as any), true, cancelledReference);
  for (const unrealizedExecution of [
    "Aria refused to execute the plan to open the gate for victory.",
    "Aria discussed how to execute the plan to open the gate for victory.",
    "Aria hoped to execute the plan to open the gate for victory.",
    "Aria executed the plan not to open the gate for victory.",
    "Aria followed the plan merely to try to open the gate for victory.",
  ]) assert.equal(runRuleAdapter("event-intent", unrealizedExecution, binding as any), true, unrealizedExecution);

  for (const foreignActor of [
    "Aria did not retreat and her twin opened the gate for victory.",
    "Aria did not retreat and another warrior opened the gate for victory.",
    "Aria did not retreat and somebody opened the gate for victory.",
    "Aria did not retreat and bob opened the gate for victory.",
  ]) assert.equal(runRuleAdapter("event-negated", foreignActor, binding as any), true, foreignActor);
  assert.equal(runRuleAdapter("event-negated", "阿丽雅没有打开城门，却阿丽雅娜打开城门并取得胜利。", chineseBinding as any), true);
  for (const foreignSlot of [
    "Aria planned to retreat, but Aria opened the gate and someone secured victory.",
    "Aria planned to retreat, but Aria opened the window beside the gate for victory.",
    "Aria planned to retreat, but Aria opened the gate after Bob secured victory.",
  ]) assert.equal(runRuleAdapter("event-intent", foreignSlot, binding as any), true, foreignSlot);
  const relationship = { actor: "Aria", action: "bowed", counterpart: "Rook", reciprocalAction: "lowered", relationshipChange: "travel together", requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"] } as const;
  assert.equal(runRuleAdapter("event-intent", "Aria planned to leave, but Aria bowed to Rook and someone lowered his spear and someone chose to travel together.", relationship as any), true);
  const guardRelationship = { ...relationship, counterpart: "guard" } as const;
  assert.equal(runRuleAdapter("event-intent", "Aria planned to leave, but Aria bowed to the guard and lowered her own spear and chose to travel together.", guardRelationship as any), true);

  const cutBinding = { actor: "Aria", action: "cut", object: "rope", outcome: "victory", requiredSlots: ["actor", "action", "object", "outcome"] } as const;
  for (const homographicComplement of [
    ["event-negated", "Aria did not retreat or cut the rope for victory."],
    ["event-failed-attempt", "Aria tried to retreat and cut the rope for victory."],
    ["event-intent", "Aria abandoned the plan to retreat and cut the rope for victory."],
  ] as const) assert.equal(runRuleAdapter(homographicComplement[0], homographicComplement[1], cutBinding as any), true, homographicComplement[1]);
  for (const sharedNegation of [
    "Aria neither opened the gate nor secured victory.",
    "Neither did Aria open the gate nor secure victory.",
    "Aria did not retreat, nor did Aria open the gate or secure victory.",
  ]) assert.equal(runRuleAdapter("event-negated", sharedNegation, binding as any), true, sharedNegation);

  for (const negatedChinese of [
    "阿丽雅未打开城门并取得胜利。",
    "阿丽雅没把城门打开并取得胜利。",
    "阿丽雅并没把城门打开并取得胜利。",
    "阿丽雅压根没能真正打开城门并取得胜利。",
    "阿丽雅从未真正打开城门并取得胜利。",
    "阿丽雅并非打开城门，而是绕过城门取得胜利。",
    "阿丽雅不是打开城门，而是绕过城门取得胜利。",
  ]) assert.equal(runRuleAdapter("event-negated", negatedChinese, chineseBinding as any), true, negatedChinese);
  for (const doubleNegative of [
    "阿丽雅不是没有打开城门并取得胜利。",
    "阿丽雅并非没有打开城门并取得胜利。",
    "阿丽雅绝非没有打开城门并取得胜利。",
    "阿丽雅没有不打开城门并取得胜利。",
    "阿丽雅未尝没有打开城门并取得胜利。",
  ]) assert.equal(runRuleAdapter("event-negated", doubleNegative, chineseBinding as any), false, doubleNegative);

  assert.equal(runRuleAdapter("event-intent", "Aria planned to retreat but opened the gate for victory.", binding as any), false);
  assert.equal(runRuleAdapter("event-failed-attempt", "阿丽雅试图退后，却打开城门取得胜利。", chineseBinding as any), false);
  assert.equal(runRuleAdapter("event-negated", "阿丽雅没有退后，反而打开城门并取得胜利。", chineseBinding as any), false);
  assert.equal(runRuleAdapter("event-negated", "阿丽雅未曾退后，反而打开城门并取得胜利。", chineseBinding as any), false);
  for (const negatedOutcome of [
    "Aria opened the gate but victory never came.",
    "Aria opened the gate but victory did not come.",
    "Aria opened the gate but victory would never come.",
    "Aria opened the gate but victory was not achieved.",
    "Aria did not hesitate and opened the gate in pursuit of victory.",
  ]) assert.equal(runRuleAdapter("event-negated", negatedOutcome, binding as any), true, negatedOutcome);
  for (const fulfilledChinesePlan of [
    "阿丽雅按计划打开城门并取得胜利。",
    "阿丽雅执行了既定计划，打开城门并取得胜利。",
  ]) assert.equal(runRuleAdapter("event-intent", fulfilledChinesePlan, chineseBinding as any), false, fulfilledChinesePlan);
  assert.equal(runRuleAdapter("event-simulation", "梦境消散，阿丽雅打开城门并取得胜利。", chineseBinding as any), false);
  assert.equal(runRuleAdapter("event-hearsay", "传闻不攻自破，阿丽雅打开城门并取得胜利。", chineseBinding as any), false);
});

test("adapter applicability is closed by narrative category", () => {
  assert.equal(adapterAppliesTo("curated-mechanic-unavailable", "mechanic"), true);
  assert.equal(adapterAppliesTo("curated-mechanic-unavailable", "voice"), false);
  assert.equal(adapterAppliesTo("curated-outcome-weakened", "conflict_outcome"), true);
  assert.equal(adapterAppliesTo("helper-substitution", "relationship"), false);
  assert.equal(adapterAppliesTo("event-simulation", "relationship"), true);
  assert.equal(adapterAppliesTo("event-intent", "pacing"), true);
});

test("distribution metrics bind delivery geometry to signal anchors and pacing to typed facets", () => {
  const source = "Opening goal is concrete.\nPressure rises at the gate.\nA short reply.\nA measured response changes the route.\nAnother consequence follows.\nThe rhythm turns decisively.\nThe ending records the consequence.";
  const voicePolicy = { kind: "distribution" as const, metricIds: ["anchor_spread", "scene_coverage", "paragraph_consistency"] as any, minimumAnchors: 3, requireSemanticJudge: true as const, requiredRegions: ["opening"] as const, regionSemantics: "paragraph" as const, metricThresholds: { anchor_spread: .01, scene_coverage: .01, paragraph_consistency: .01 } };
  const voice = { id: "distribution", dimensionId: "d", verification: voicePolicy } as any;
  const makeAnchor = (quote: string) => ({ start: source.indexOf(quote), end: source.indexOf(quote) + quote.length, quote });
  const claim = (quotes: string[]) => ({ version: 1 as const, eventId: "e", dimensionId: "d", signalId: "distribution", supported: true, confidence: 1, anchors: quotes.map(makeAnchor), slotAnchorIndices: {}, metrics: { anchor_spread: 0, scene_coverage: 0, paragraph_consistency: 0 } });
  const left = groundClaim(source, claim(["Opening goal", "A measured response", "The ending records the consequence."]), voice);
  const right = groundClaim(source, claim(["Opening goal", "Pressure rises", "A short reply"]), voice);
  assert.equal("ruleId" in left, false); assert.equal("ruleId" in right, false);
  if (!("ruleId" in left) && !("ruleId" in right)) {
    assert.notEqual(left.metrics?.anchor_spread, right.metrics?.anchor_spread);
    assert.equal(left.metrics?.paragraph_consistency, right.metrics?.paragraph_consistency);
  }
  const delimiterCollision = groundClaim(source, {
    ...claim(["Opening goal", "A measured response", "The ending records the consequence."]),
    metrics: { ["anchor_spread\u001fscene_coverage\u001fparagraph_consistency"]: 1 },
  }, voice);
  assert.deepEqual(delimiterCollision, { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: "d" });

  const pacingPolicy = { kind: "distribution" as const, metricIds: ["anchor_spread", "scene_coverage", "beat_density", "turn_position"] as any, minimumAnchors: 3, requireSemanticJudge: true as const, requiredRegions: ["opening", "middle", "ending"] as const, regionSemantics: "paragraph" as const, metricThresholds: { anchor_spread: .01, scene_coverage: .01, beat_density: .01, turn_position: .01 } };
  const pacing = { id: "pacing", dimensionId: "d", verification: pacingPolicy } as any;
  const pacingClaim: any = { ...claim(["Opening goal", "A measured response", "The rhythm turns decisively."]), signalId: "pacing", metrics: { anchor_spread: 0, scene_coverage: 0, beat_density: 0, turn_position: 0 }, distributionAnchorIndices: { goal: [0], pressure: [1], beat: [1, 2], turn: [2] } };
  const paced = groundClaim(source, pacingClaim, pacing); assert.equal("ruleId" in paced, false);
  const unsorted = groundClaim(source, { ...pacingClaim, anchors: [...pacingClaim.anchors].reverse() }, pacing);
  assert.deepEqual(unsorted, { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: "d" });
  const untyped = groundClaim(source, { ...pacingClaim, distributionAnchorIndices: undefined }, pacing);
  assert.deepEqual(untyped, { ruleId: "invalid_model_output", severity: "rewrite", dimensionId: "d" });
  const collapsed = groundClaim(source, { ...pacingClaim, distributionAnchorIndices: { goal: [2], pressure: [2], beat: [2], turn: [2] } }, pacing);
  assert.deepEqual(collapsed, { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: "d" });
});

test("pacing facet semantics fail closed on any modal anchor and accept exact realized sub-anchors", () => {
  const realized = (text: string) => pacingFacetIsRealized({ anchorIndex: 0, facets: ["beat"], text });
  for (const laundering of [
    "Aria plans to cross the bridge, but a bell rang.",
    "The oracle predicts pressure will rise, then rain fell.",
    "A simulated ambush would close the road; a raven landed.",
    "The route might turn, but the crowd shouted.",
    "Aria plans to cross the bridge and darkness.",
    "Aria plans to cross the sealed bridge and opens a notebook.",
    "The oracle predicts that the pursuit will tighten and opens the archive.",
    "A simulated ambush would force Aria back and opens the gate.",
    "The route might turn and takes water.",
    "阿璃计划穿过封桥并打开笔记本。",
    "先知预测追兵会逼近并打开档案。",
    "模拟伏击会迫使阿璃后退并打开大门。",
    "路线可能转向并取走清水。",
    "Aria did not slow down and crossed the courtyard.",
    "Aria tried the northern route and reached the tower.",
    "Aria hoped for a clear road and crossed the bridge.",
    "阿璃试图走北路并抵达高塔。",
    "阿璃并未放慢脚步且穿过庭院。",
  ]) assert.equal(realized(laundering), false, laundering);
  for (const atomic of [
    "The guard said the road was sealed.",
    "reached the tower",
    "crossed the courtyard",
    "抵达高塔",
    "穿过庭院",
  ]) assert.equal(realized(atomic), true, atomic);
  assert.equal(realized("Aria tried the northern route, then reached the tower."), false, "ambiguous multi-proposition anchors require an exact sub-anchor");
});

test("long prose does not rescue voice anchors clustered at the opening", () => {
  const source = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} keeps the same structure.`).join("\n");
  const quote = (index: number) => `Paragraph ${index}`; const anchor = (index: number) => ({ start: source.indexOf(quote(index)), end: source.indexOf(quote(index)) + quote(index).length, quote: quote(index) });
  const signal = { id: "voice", dimensionId: "d", verification: { kind: "distribution", metricIds: ["anchor_spread", "scene_coverage", "paragraph_consistency"], minimumAnchors: 3, requireSemanticJudge: true, requiredRegions: ["opening", "middle", "ending"], regionSemantics: "paragraph", metricThresholds: { anchor_spread: .35, scene_coverage: 1, paragraph_consistency: .1 } } } as any;
  const result = groundClaim(source, { version: 1, eventId: "voice", dimensionId: "d", signalId: "voice", supported: true, confidence: 1, anchors: [anchor(0), anchor(1), anchor(2)], slotAnchorIndices: {}, metrics: { anchor_spread: 1, scene_coverage: 1, paragraph_consistency: 1 } }, signal);
  assert.deepEqual(result, { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: "d" });
});

test("voice evidence requires body-wide abstraction, sensory, and rhetoric facets and never counts the title", () => {
  const title = "Abstract sensory rhetoric title";
  const paragraphs = [
    "A concrete choice establishes the opening idea.",
    "The corridor keeps a measured narrative cadence.",
    "Cold iron bites her palm and smoke stings her eyes.",
    "The consequence becomes a question of duty and cost.",
    "A repeated image returns with deliberate contrast.",
    "What was a locked door becomes a verdict on the city.",
  ];
  const source = `${title}\n${paragraphs.join("\n")}`; const bodyStart = title.length + 1;
  const at = (quote: string) => ({ start: source.indexOf(quote), end: source.indexOf(quote) + quote.length, quote });
  const policy = evidencePolicyFor("voice"); const signal = { id: "voice", dimensionId: "d", verification: policy } as any;
  const anchors = [at(paragraphs[0]), at(paragraphs[2]), at(paragraphs[5])];
  const claim: any = { version: 1, eventId: "voice", dimensionId: "d", signalId: "voice", supported: true, confidence: 1, anchors, slotAnchorIndices: {}, metrics: Object.fromEntries(policy.kind === "distribution" ? policy.metricIds.map((id) => [id, 1]) : []), distributionAnchorIndices: { abstraction: [0], sensory: [1], rhetoric: [2] } };
  assert.equal("ruleId" in groundClaim(source, claim, signal, { bodyStart }), false);
  const titleAttack = { ...claim, anchors: [at(title), anchors[1], anchors[2]], distributionAnchorIndices: { abstraction: [0], sensory: [1], rhetoric: [2] } };
  assert.deepEqual(groundClaim(source, titleAttack, signal, { bodyStart }), { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: "d" });
  const padded = `${source}\n${Array.from({ length: 18 }, (_, index) => `Neutral padding paragraph ${index} repeats an unrelated statement.`).join("\n")}`;
  assert.deepEqual(groundClaim(padded, claim, signal, { bodyStart }), { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: "d" });
});

test("pacing evidence uses whole-body event density, pressure window, and length density", () => {
  const title = "Fast title";
  const paragraphs = [
    "Aria names the gate as her immediate goal.",
    "A warning bell answers from the lower hall.",
    "Pressure closes the eastern route.",
    "She cuts the first chain and the guard reacts.",
    "The floor gives way beneath the second step.",
    "She catches the rail and changes direction.",
    "The rival blocks the final stair.",
    "Aria turns the trap back on him and opens the road.",
  ];
  const source = `${title}\n${paragraphs.join("\n")}`; const bodyStart = title.length + 1;
  const at = (index: number) => ({ start: source.indexOf(paragraphs[index]), end: source.indexOf(paragraphs[index]) + paragraphs[index].length, quote: paragraphs[index] });
  const policy = evidencePolicyFor("pacing"); const signal = { id: "pacing", dimensionId: "d", verification: policy } as any;
  const claim: any = { version: 1, eventId: "pace", dimensionId: "d", signalId: "pacing", supported: true, confidence: 1, anchors: [at(0), at(2), at(3), at(5), at(7)], slotAnchorIndices: {}, metrics: Object.fromEntries(policy.kind === "distribution" ? policy.metricIds.map((id) => [id, 1]) : []), distributionAnchorIndices: { goal: [0], pressure: [1], beat: [2, 3], turn: [4] } };
  assert.equal("ruleId" in groundClaim(source, claim, signal, { bodyStart }), false);
  const sparseParagraphs = Array.from({ length: 32 }, (_, index) => `Neutral explanation ${index} continues without another concrete event.`);
  for (const [index, paragraph] of [[0, paragraphs[0]], [8, paragraphs[2]], [12, paragraphs[3]], [20, paragraphs[5]], [31, paragraphs[7]]] as const) sparseParagraphs[index] = paragraph;
  const sparse = `${title}\n${sparseParagraphs.join("\n")}`;
  const sparseAt = (index: number) => ({ start: sparse.indexOf(sparseParagraphs[index]), end: sparse.indexOf(sparseParagraphs[index]) + sparseParagraphs[index].length, quote: sparseParagraphs[index] });
  const sparseClaim = { ...claim, anchors: [sparseAt(0), sparseAt(8), sparseAt(12), sparseAt(20), sparseAt(31)] };
  assert.deepEqual(groundClaim(sparse, sparseClaim, signal, { bodyStart }), { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: "d" });

  const longParagraphs = paragraphs.map((paragraph, index) => index < 5 ? `${paragraph.replace(/\.$/u, "")} ${"extended explanation ".repeat(24)}.` : paragraph);
  const longSource = `${title}\n${longParagraphs.join("\n")}`;
  const longAt = (index: number) => ({ start: longSource.indexOf(longParagraphs[index]), end: longSource.indexOf(longParagraphs[index]) + longParagraphs[index].length, quote: longParagraphs[index] });
  const longClaim = { ...claim, anchors: [longAt(0), longAt(2), longAt(3), longAt(5), longAt(7)] };
  assert.deepEqual(groundClaim(longSource, longClaim, signal, { bodyStart }), { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: "d" });
});
