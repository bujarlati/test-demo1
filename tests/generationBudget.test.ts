import assert from "node:assert/strict";
import test from "node:test";
import {
  assertModelCallTokenBudget,
  CHAPTER_EXTRACTION_ADMISSION_RESERVE,
  CONTINUATION_JOB_TOKEN_BUDGET,
  estimateModelCallTokenBudget,
  OPENING_JOB_TOKEN_BUDGET,
} from "../server/generationBudget";

test("opening budget covers the measured reasoning planner plus one full draft rewrite", () => {
  const measuredPlannerTokens = 14_848;
  const twoReasoningWriterAllowances = 2 * 30_000;
  const repairAndReviewAllowance = 25_000;

  assert.ok(
    OPENING_JOB_TOKEN_BUDGET >= measuredPlannerTokens + twoReasoningWriterAllowances + repairAndReviewAllowance,
    `opening budget ${OPENING_JOB_TOKEN_BUDGET} cannot cover the observed reasoning-heavy pipeline`,
  );
});

test("continuation budget admits measured planning, conservative writer input, full draft, and extraction", () => {
  const measuredPlannerAndAuditTokens = 4_750;
  const conservativeWriterInputTokens = 13_062;
  const fullWriterOutputTokens = 6_500;

  assert.ok(
    CONTINUATION_JOB_TOKEN_BUDGET >= measuredPlannerAndAuditTokens + conservativeWriterInputTokens + fullWriterOutputTokens + CHAPTER_EXTRACTION_ADMISSION_RESERVE,
    `continuation budget ${CONTINUATION_JOB_TOKEN_BUDGET} cannot admit the measured Ark pipeline`,
  );
});

test("Han-heavy model calls reserve a UTF-8 byte upper bound", () => {
  const prompt = "汉".repeat(10_000);

  assert.throws(
    () => assertModelCallTokenBudget({
      remainingTokens: 6_000,
      system: "",
      prompt,
      maxOutputTokens: 1_000,
      stage: "正文",
    }),
    /完整输入与最大输出预算 31032/,
  );
});

test("mixed input includes UTF-8 bytes, output allowance, and message framing", () => {
  assert.equal(
    estimateModelCallTokenBudget({
      system: "你好AB",
      prompt: "世界CD",
      maxOutputTokens: 7,
    }),
    55,
  );
});

test("emoji and random-looking ASCII cannot slip through the admission upper bound", () => {
  assert.throws(() => assertModelCallTokenBudget({
    remainingTokens: 4_500,
    system: "",
    prompt: "🙂".repeat(1_000),
    maxOutputTokens: 500,
    stage: "正文",
  }), /完整输入与最大输出预算 4532/);

  assert.throws(() => assertModelCallTokenBudget({
    remainingTokens: 8_500,
    system: "A9_z-7Qp".repeat(1_000),
    prompt: "",
    maxOutputTokens: 500,
    stage: "正文",
  }), /完整输入与最大输出预算 8532/);
});
