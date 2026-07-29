import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationJob } from "../src/types";
import {
  appendGenerationFailure,
  classifyGenerationFailure,
  createGenerationFailureObservation,
  sanitizeGenerationFailureMessage,
  summarizeGenerationFailures,
} from "../server/failureTelemetry";
import { createSeedStore } from "../server/seed";
import { normalizeStore } from "../server/storage";

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: "job_failure_test",
    ownerId: "user_demo",
    storyId: "story_pending",
    storyTitle: "正在生成新故事",
    chapterNumber: 1,
    task: "opening",
    model: "writer-model",
    connectionId: "conn_test",
    promptVersion: "opening-v1",
    status: "running",
    tokens: 123,
    latencyMs: 456,
    cost: 0,
    createdAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  };
}

test("generation failures receive stable reason codes without retaining user content or secrets", () => {
  const error = new Error("正文泄露作者侧章节或剧情元数据。命中作者侧叙事原句：“联系 me@example.com，密钥 sk-secretvalue123”");
  assert.deepEqual(classifyGenerationFailure(error), {
    category: "quality",
    reasonCode: "narration_metadata",
    retryable: true,
  });
  const message = sanitizeGenerationFailureMessage(error);
  assert.doesNotMatch(message, /me@example\.com|sk-secretvalue123|联系/);
  assert.match(message, /REDACTED_CONTENT/);

  const observation = createGenerationFailureObservation(job(), error, {
    stage: "开篇正文质量校验",
    attempt: 2,
    terminal: true,
    now: () => new Date("2026-07-22T01:02:03.000Z"),
    id: "failure_fixed",
  });
  assert.equal(observation.reasonCode, "narration_metadata");
  assert.equal(observation.classifierVersion, "generation-failure-v2");
  assert.equal(observation.attempt, 2);
  assert.equal(observation.terminal, true);
  assert.equal(observation.fingerprint.length, 64);
  assert.equal(observation.createdAt, "2026-07-22T01:02:03.000Z");
});

test("real production-shaped failures are separated into actionable patterns", () => {
  const cases: Array<[string, string]> = [
    ["模型 deepseek 的流式响应无效：aborted。；故事未创建，可以安全重试。", "model_transport"],
    ["模型 deepseek 返回 503：System is too busy now. Please try again later。", "provider_overloaded"],
    ["章节字数为 3952 字，要求 2400—3400 字，已阻止发布。", "chapter_length"],
    ["所有剧情候选均违反硬正史，已阻止正文发布。", "canon_conflict"],
    ["候选 2 缺少完整的独立知识依赖审计。", "candidate_knowledge_audit"],
    ["规划模型未返回至少 3 个有效剧情胶囊。", "candidate_plan_invalid"],
    ["候选与上下文已接近 Token 上限，未启动正文调用。", "token_budget_exhausted"],
    ["正文违反“系统”体验的稳定结算与持续可用硬承诺，已阻止发布。", "system_invariant_broken"],
    ["阅读体验轴“诡谲”的正文证据不是有效原文引用。", "experience_quote_invalid"],
    ["阅读体验轴“诡谲”的证据原句没有实际兑现所申报模型信号。", "experience_signal_unrealized"],
    ["第一章前 15% 没有兑现真实系统交互。", "system_interaction_missing"],
    ["正文没有兑现由主角完成的“无敌”压倒性胜利。", "invincible_victory_missing"],
  ];
  for (const [message, reasonCode] of cases) {
    assert.equal(classifyGenerationFailure(new Error(message)).reasonCode, reasonCode, message);
  }
});

test("failure summaries distinguish terminal failures from jobs recovered after a rewrite", () => {
  const store = createSeedStore();
  store.generationFailures = [];
  const recoveredJob = job({ id: "job_recovered", status: "completed" });
  const failedJob = job({ id: "job_failed", status: "failed" });
  const sharedError = new Error("正文没有实际兑现阅读体验证据。");
  appendGenerationFailure(store, createGenerationFailureObservation(recoveredJob, sharedError, {
    stage: "章节质量校验",
    terminal: false,
    id: "failure_recovered",
  }));
  appendGenerationFailure(store, createGenerationFailureObservation(failedJob, sharedError, {
    stage: "章节质量校验",
    terminal: true,
    id: "failure_terminal",
  }));
  const [summary] = summarizeGenerationFailures(store.generationFailures, [recoveredJob, failedJob]);
  assert.equal(summary.reasonCode, "experience_quality_gate");
  assert.equal(summary.occurrences, 2);
  assert.equal(summary.affectedJobs, 2);
  assert.equal(summary.terminalFailures, 1);
  assert.equal(summary.recoveredJobs, 1);
});

test("legacy failed jobs are backfilled into structured failure observations once", () => {
  const store = createSeedStore();
  const failedJob = job({
    id: "job_legacy_failed",
    status: "failed",
    filterSummary: "正文泄露作者侧章节或剧情元数据，破坏沉浸感。",
  });
  store.jobs.unshift(failedJob);
  delete (store as Partial<typeof store>).generationFailures;
  normalizeStore(store);
  normalizeStore(store);
  const observations = store.generationFailures.filter((failure) => failure.jobId === failedJob.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].reasonCode, "narration_metadata");
  assert.equal(observations[0].terminal, true);
});

test("narration review state failures keep their explicit reason codes", () => {
  const fixtures = [
    ["narration_rewrite_exhausted", "quality"],
    ["narration_review_state_unavailable", "persistence"],
    ["narration_review_checkpoint_invalid", "quality"],
    ["narration_review_payload_expired", "interrupted"],
  ] as const;
  for (const [code, category] of fixtures) {
    const error = Object.assign(new Error("generic narration review failure"), { code });
    assert.deepEqual(classifyGenerationFailure(error), {
      category,
      reasonCode: code,
      retryable: true,
    });
    assert.equal(
      createGenerationFailureObservation(job(), error, {
        stage: "narration review",
        terminal: true,
      }).reasonCode,
      code,
    );
  }
});

test("editorial revision failures keep the concrete issue code without storing the manuscript", () => {
  const error = Object.assign(new Error("审核指出正文仍有需要退修的阅读体验问题（诗意）。"), {
    code: "chapter_editorial_revision_required",
    editorialIssues: [{
      code: "weak_experience_signal",
      reason: "原稿中的完整私密正文不应进入失败观测。",
    }],
  });
  assert.deepEqual(classifyGenerationFailure(error), {
    category: "quality",
    reasonCode: "weak_experience_signal",
    retryable: true,
  });
  const observation = createGenerationFailureObservation(job(), error, {
    stage: "章节质量校验",
    terminal: false,
  });
  assert.equal(observation.reasonCode, "weak_experience_signal");
  assert.doesNotMatch(observation.message, /完整私密正文/);
});


test("explicit protagonist defeat revisions retain their dedicated stable reason code", () => {
  const error = Object.assign(new Error("审核确认主角形成已经落地的最终失败。"), {
    code: "chapter_editorial_revision_required",
    editorialIssues: [{
      code: "explicit_protagonist_defeat",
      reason: "只用于当前退修的正文证据不进入长期观测。",
    }],
  });
  assert.deepEqual(classifyGenerationFailure(error), {
    category: "quality",
    reasonCode: "explicit_protagonist_defeat",
    retryable: true,
  });
});

test("minimum chapter length revisions keep a dedicated retryable reason code", () => {
  const error = Object.assign(new Error("章节字数低于最低要求，已退回 Writer 扩写。"), {
    code: "chapter_editorial_revision_required",
    editorialIssues: [{
      code: "chapter_too_short",
      reason: "原稿低于最低字数。",
    }],
  });
  assert.deepEqual(classifyGenerationFailure(error), {
    category: "quality",
    reasonCode: "chapter_too_short",
    retryable: true,
  });
});

test("continuation tier persistence failures keep a stable persistence reason code", () => {
  const error = Object.assign(new Error("退修预算档位未能保存，未启动下一稿。"), {
    code: "continuation_tier_persistence_failed",
  });
  assert.deepEqual(classifyGenerationFailure(error), {
    category: "persistence",
    reasonCode: "continuation_tier_persistence_failed",
    retryable: true,
  });
});

test("daily continuation tier admission failures remain distinct from provider throttling", () => {
  const error = Object.assign(new Error("已达到 24 小时生成预算上限。正史不受影响，请稍后再试。"), {
    status: 429,
  });
  assert.deepEqual(classifyGenerationFailure(error), {
    category: "budget",
    reasonCode: "daily_token_budget_limit",
    retryable: true,
  });
});
