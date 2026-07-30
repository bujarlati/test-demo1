import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createInitialOpeningJobState,
  openingJobReducer,
  openingProgressPresentation,
} from "../src/openingJobState";
import type { OpeningJobProgress } from "../src/types";

const revisionProgress: OpeningJobProgress = {
  version: 1,
  seq: 5,
  stage: "reviewing",
  activity: "revising",
  draftNumber: 2,
  revisionSource: "quality",
  revisionReason: "experience_not_clear",
  stageStartedAt: "2026-07-30T03:43:34.000Z",
  updatedAt: "2026-07-30T03:43:34.000Z",
};

test("opening progress explains a quality rewrite without exposing raw model output", () => {
  assert.deepEqual(openingProgressPresentation(revisionProgress), {
    stepIndex: 2,
    title: "第一稿需要调整，正在修订第 2 稿",
    detail: "第一稿还没有充分呈现设定的阅读体验，正在加强人物行动与结果。",
  });
});

test("an older server snapshot cannot move recovered opening progress backwards", () => {
  let state = createInitialOpeningJobState("key_a");
  state = openingJobReducer(state, {
    type: "recover_job",
    jobId: "job_opening",
    progress: revisionProgress,
  });
  state = openingJobReducer(state, { type: "poll_started", requestId: 1 });
  state = openingJobReducer(state, {
    type: "status_received",
    requestId: 1,
    status: {
      jobId: "job_opening",
      status: "running",
      progress: {
        version: 1,
        seq: 4,
        stage: "drafting",
        activity: "writing",
        draftNumber: 1,
        stageStartedAt: "2026-07-30T03:36:06.000Z",
        updatedAt: "2026-07-30T03:40:00.000Z",
      },
    },
  });

  assert.deepEqual(state.progress, revisionProgress);
});

test("the creation dialog is driven by server progress and tells users they may leave", () => {
  const source = readFileSync(new URL("../src/pages/NewStoryPage.tsx", import.meta.url), "utf8");
  assert.match(source, /openingProgressPresentation\(openingJob\.progress\)/);
  assert.doesNotMatch(source, /setInterval\(\(\) => setStage/);
  assert.match(source, /你可以先回书架，生成会在后台继续/);
});
