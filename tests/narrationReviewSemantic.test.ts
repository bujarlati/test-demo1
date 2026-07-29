import assert from "node:assert/strict";
import test from "node:test";
import {
  narrationReviewConfidenceThreshold,
  narrationReviewerInstruction,
  resolveNarrationAssessments,
} from "../server/narrationReview";
import { detectNarrationCandidates, narrationArtifactHash } from "../server/narrationPolicy";

function candidatesFor(...sentences: string[]) {
  const body = sentences.join("。");
  return detectNarrationCandidates("body", body, narrationArtifactHash("测试", [body]));
}

test("semantic resolver allows world-internal text at the threshold", () => {
  const [candidate] = candidatesFor("老人递来半本卷边残诗稿");
  const result = resolveNarrationAssessments([candidate], [{
    candidateId: candidate.id,
    worldInternal: true,
    writingProcessReference: false,
    decision: "allow",
    confidence: 0.85,
    reason: "这里的卷边是旧纸张的物理状态。",
  }], 0.85);

  assert.equal(result.decision, "allow");
  assert.equal(result.protocolValid, true);
  assert.equal(result.assessments[0].decision, "allow");
});

test("semantic resolver rewrites clear writing-process references", () => {
  const [candidate] = candidatesFor("作者在这里安排转折");
  const result = resolveNarrationAssessments([candidate], [{
    candidateId: candidate.id,
    worldInternal: false,
    writingProcessReference: true,
    decision: "rewrite",
    confidence: 0.96,
    reason: "句子直接谈论作者安排。",
  }], 0.85);

  assert.equal(result.decision, "rewrite");
  assert.equal(result.protocolValid, true);
});

test("low confidence, contradictions, mismatches, and missing candidates ask the user", () => {
  const [first, second] = candidatesFor("半本卷边残诗稿", "作者在这里安排转折");
  const result = resolveNarrationAssessments([first, second], [{
    candidateId: first.id,
    worldInternal: true,
    writingProcessReference: false,
    decision: "allow",
    confidence: 0.4,
    reason: "信心不足。",
  }], 0.85);

  assert.equal(result.decision, "ask_user");
  assert.equal(result.protocolValid, false);
  assert.deepEqual(result.assessments.map((item) => item.decision), ["ask_user", "ask_user"]);

  const mismatch = resolveNarrationAssessments([first], [{
    candidateId: first.id,
    worldInternal: true,
    writingProcessReference: false,
    decision: "rewrite",
    confidence: 0.99,
    reason: "自报结论与字段矛盾。",
  }], 0.85);
  assert.equal(mismatch.decision, "ask_user");
  assert.equal(mismatch.protocolValid, false);
});

test("rewrite has priority over ask_user, which has priority over allow", () => {
  const [allowCandidate, rewriteCandidate] = candidatesFor("半本卷边残诗稿", "作者在这里安排转折");
  const result = resolveNarrationAssessments([allowCandidate, rewriteCandidate], [
    {
      candidateId: allowCandidate.id,
      worldInternal: true,
      writingProcessReference: false,
      decision: "allow",
      confidence: 0.99,
      reason: "故事内旧稿。",
    },
    {
      candidateId: rewriteCandidate.id,
      worldInternal: false,
      writingProcessReference: true,
      decision: "rewrite",
      confidence: 0.99,
      reason: "作者侧安排。",
    },
  ], 0.85);
  assert.equal(result.decision, "rewrite");
});

test("no candidates require no assessment payload and add no reviewer work", () => {
  const result = resolveNarrationAssessments([], undefined, 0.85);
  assert.deepEqual(result.assessments, []);
  assert.equal(result.decision, "allow");
  assert.match(narrationReviewerInstruction([]), /空数组/);
});

test("configured threshold is validated", () => {
  assert.equal(narrationReviewConfidenceThreshold(undefined), 0.85);
  assert.equal(narrationReviewConfidenceThreshold("0.9"), 0.9);
  assert.throws(() => narrationReviewConfidenceThreshold("1.2"), /0.5—0.99/);
});
