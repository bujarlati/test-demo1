import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGenerationTokenBudget,
  assertModelCallTokenBudget,
  CHAPTER_EXTRACTION_ADMISSION_RESERVE,
  continuationGenerationBudgetIncrease,
  continuationGenerationTier,
  CONTINUATION_GENERATION_TIERS,
  CONTINUATION_JOB_TOKEN_BUDGET,
  estimateModelCallTokenBudget,
  OPENING_JOB_TOKEN_BUDGET,
} from "../server/generationBudget";
import type { GenerationJob } from "../src/types";

test("continuation editorial revisions use three fixed cumulative budget and timeout tiers", () => {
  assert.deepEqual(
    CONTINUATION_GENERATION_TIERS.map((tier) => ({
      attempt: tier.attempt,
      cumulativeTokenBudget: tier.cumulativeTokenBudget,
      writerIdleTimeoutMs: tier.writerIdleTimeoutMs,
    })),
    [
      { attempt: 1, cumulativeTokenBudget: 50_000, writerIdleTimeoutMs: 300_000 },
      { attempt: 2, cumulativeTokenBudget: 110_000, writerIdleTimeoutMs: 480_000 },
      { attempt: 3, cumulativeTokenBudget: 170_000, writerIdleTimeoutMs: 720_000 },
    ],
  );
  assert.equal(CONTINUATION_JOB_TOKEN_BUDGET, CONTINUATION_GENERATION_TIERS[0].cumulativeTokenBudget);
  assert.equal(continuationGenerationTier(3), CONTINUATION_GENERATION_TIERS[2]);
  assert.throws(() => continuationGenerationTier(4), /最多允许 3 稿/);
});

test("continuation tier admission reserves only the incremental running-job budget", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  const runningJob: GenerationJob = {
    id: "job_tiered_budget",
    ownerId: "user_budget",
    storyId: "story_budget",
    storyTitle: "阶梯预算",
    chapterNumber: 2,
    task: "chapter",
    model: "writer",
    connectionId: "connection",
    promptVersion: "story-v8",
    status: "running",
    tokens: 9_000,
    tokenBudget: 50_000,
    latencyMs: 0,
    cost: 0,
    createdAt: "2026-07-28T11:00:00.000Z",
  };
  const secondTier = continuationGenerationTier(2);
  const increase = continuationGenerationBudgetIncrease(runningJob.tokenBudget, secondTier);

  assert.equal(increase, 60_000);
  assert.doesNotThrow(() => assertGenerationTokenBudget({
    jobs: [runningJob],
    userId: runningJob.ownerId,
    storyId: runningJob.storyId,
    requestedBudget: increase,
    defaultRunningBudget: CONTINUATION_JOB_TOKEN_BUDGET,
    userLimit: 110_000,
    storyLimit: 110_000,
    now,
  }));
  assert.throws(() => assertGenerationTokenBudget({
    jobs: [runningJob],
    userId: runningJob.ownerId,
    storyId: runningJob.storyId,
    requestedBudget: secondTier.cumulativeTokenBudget,
    defaultRunningBudget: CONTINUATION_JOB_TOKEN_BUDGET,
    userLimit: 110_000,
    storyLimit: 110_000,
    now,
  }), /24 小时生成预算上限/);
});

test("completed and failed continuation jobs release unused tier reservations", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  const historicalJobs: GenerationJob[] = (["completed", "failed"] as const).map((status, index) => ({
    id: `job_${status}`,
    ownerId: "user_actual_usage",
    storyId: "story_actual_usage",
    storyTitle: "实际用量",
    chapterNumber: index + 1,
    task: "chapter",
    model: "writer",
    connectionId: "connection",
    promptVersion: "story-v8",
    status,
    tokens: 20_000,
    tokenBudget: 170_000,
    latencyMs: 1,
    cost: 0,
    createdAt: "2026-07-28T11:00:00.000Z",
  }));

  assert.doesNotThrow(() => assertGenerationTokenBudget({
    jobs: historicalJobs,
    userId: "user_actual_usage",
    storyId: "story_actual_usage",
    requestedBudget: 50_000,
    defaultRunningBudget: CONTINUATION_JOB_TOKEN_BUDGET,
    userLimit: 90_000,
    storyLimit: 90_000,
    now,
  }));
});

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
