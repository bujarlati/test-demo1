import assert from "node:assert/strict";
import test from "node:test";
import { recoverableGenerationJobs, recoveryNoticeForJob } from "../src/jobRecovery";
import type { GenerationJob } from "../src/types";

function failedJob(overrides: Partial<GenerationJob>): GenerationJob {
  return {
    id: "job_failed",
    ownerId: "user_demo",
    storyId: "story_existing",
    storyTitle: "现有故事",
    chapterNumber: 2,
    task: "chapter",
    model: "writer-model",
    connectionId: "connection_test",
    promptVersion: "test",
    status: "failed",
    tokens: 0,
    latencyMs: 0,
    cost: 0,
    filterSummary: "生成被中断；可以安全重试。",
    ...overrides,
  };
}

test("failed opening jobs recover through new-story flow instead of a missing story route", () => {
  const notice = recoveryNoticeForJob(failedJob({
    task: "opening",
    storyId: "opening_pending_deadbeef",
    storyTitle: "正在生成新故事",
    chapterNumber: 1,
  }), new Set(["story_existing"]));

  assert.deepEqual(notice, {
    kind: "opening",
    to: "/new",
    title: "上次开书被中断",
    detail: "可以重新尝试创建第一章",
  });
});

test("failed chapter jobs only link to an existing story", () => {
  const existing = recoveryNoticeForJob(failedJob({}), new Set(["story_existing"]));
  const missing = recoveryNoticeForJob(failedJob({ storyId: "story_missing" }), new Set(["story_existing"]));

  assert.equal(existing?.to, "/story/story_existing");
  assert.equal(missing, null);
});

test("a successful opening supersedes older interrupted opening notices", () => {
  const interrupted = failedJob({
    id: "job_opening_failed",
    task: "opening",
    storyId: "opening_pending_deadbeef",
    storyTitle: "正在生成新故事",
    chapterNumber: 1,
  });
  const completed = failedJob({
    id: "job_opening_completed",
    task: "opening",
    storyId: "story_new",
    storyTitle: "新故事",
    chapterNumber: 1,
    status: "completed",
    filterSummary: "规划、正文与双体验证据检查均已通过。",
  });

  assert.deepEqual(
    recoverableGenerationJobs([completed, interrupted], new Set(["story_new"])),
    [],
  );
  assert.deepEqual(
    recoverableGenerationJobs([interrupted], new Set(["story_new"])),
    [interrupted],
  );
});
