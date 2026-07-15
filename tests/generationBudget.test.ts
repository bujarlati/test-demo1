import assert from "node:assert/strict";
import test from "node:test";
import {
  assertModelCallTokenBudget,
  estimateModelCallTokenBudget,
} from "../server/generationBudget";

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
