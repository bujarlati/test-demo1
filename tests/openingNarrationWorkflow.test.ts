import assert from "node:assert/strict";
import test from "node:test";
import {
  beginStoryOpeningGeneration,
  openingNarrationReviewsFromError,
  resumeStoryOpeningGeneration,
  type OpeningGenerationOutcome,
  type OpeningModelCompleter,
  type OpeningProgressUpdate,
} from "../server/modelGateway";
import { detectNarrationCandidates, narrationArtifactHash } from "../server/narrationPolicy";
import { applyGeneratedStoryOpening, prepareStoryOpening } from "../server/openingService";
import { refineReadingExperienceContract } from "../server/readingExperience";
import { createStory } from "../server/storyService";
import type { ModelConnection } from "../src/types";

type ReviewDecision = "allow" | "rewrite" | "ask_user";

function connectionFixture(): ModelConnection {
  return {
    id: "conn_opening_narration_workflow",
    name: "Opening narration workflow",
    ownerScope: "user",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://opening-narration-workflow",
    secretVersion: 1,
    status: "active",
    routes: {
      planner: "planner-route",
      writer: "writer-route",
      extractor: "reviewer-route",
      embedding: "embedding-route",
    },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: "2026-07-24T08:00:00.000Z",
  };
}

function workflowFixture(decisions: ReviewDecision[]) {
  const base = createStory({ genre: "都市", tone: "机械 · 奶爸" }, "user_test");
  const context = {
    input: {
      genre: "都市",
      tone: "机械 · 奶爸",
      inspiration: "退役机甲师带女儿守住维修铺",
    },
    contract: base.readingExperience,
    targetChapterCount: base.targetChapterCount,
  };
  const plan = {
    title: "钢铁摇篮",
    subtitle: "退役机甲师与三岁女儿的旧城生活",
    leadName: "周砺",
    storyGene: {
      protagonistPosition: "独自照顾女儿的退役机甲师",
      visibleGoal: "守住维修铺和女儿的生活",
      hiddenNeed: "学会倾听女儿自己的选择",
      conflictEngine: "机甲冲突和育儿日常共同改变旧城关系",
      recurringCost: "每次公开实力都会扩大需要照料的社区范围",
      endingShape: "父女和伙伴共同重建旧城",
      creativeAxes: ["机械维修", "父女日常", "旧城守护"],
    },
    endingContract: {
      targetEnding: "旧城获得新生",
      characterArc: "从独自保护到共同生活",
      prerequisites: ["维修铺重开"],
    },
    worldBible: {
      organizations: ["维修协会"],
      locations: ["旧城维修铺"],
      abilityBoundaries: ["机甲需要能源"],
      pointOfView: "近距离第三人称",
      styleParameters: ["动作清楚"],
    },
    experienceAxes: [
      {
        word: "机械",
        interpretation: "机械必须作为可操作能力推动事件",
        observableSignals: [
          {
            description: "机械臂完成精确动作并挡住威胁",
            evidenceAnchors: ["机械臂", "完成精确动作", "挡住威胁"],
          },
          {
            description: "机械维修恢复资源并改变现场状态",
            evidenceAnchors: ["机械维修", "恢复资源", "改变现场状态"],
          },
        ],
        hardPromises: ["每章至少一次有效机械操作"],
        forbiddenShortcuts: ["只描写金属颜色"],
      },
      {
        word: "奶爸",
        interpretation: "父亲照料和女儿回应共同推动关系",
        observableSignals: [
          {
            description: "奶爸周砺听见女儿说出自己的需要",
            evidenceAnchors: ["奶爸周砺", "听见女儿", "自己的需要"],
          },
          {
            description: "女儿作出选择后父亲调整方案",
            evidenceAnchors: ["女儿作出选择", "父亲", "调整方案"],
          },
        ],
        hardPromises: ["每章都有父女双向互动"],
        forbiddenShortcuts: ["把女儿当作被保护的道具"],
      },
    ],
    openingBeats: ["机械动作在首段出现", "父女关系在首个冲突中改变结果"],
  };
  plan.experienceAxes[1].interpretation = plan.experienceAxes[1].word + "\u7684" +
    plan.experienceAxes[1].interpretation;
  const refinedContract = refineReadingExperienceContract(context.contract, plan.experienceAxes);
  const ordinaryParagraph = (
    "机械臂完成第1个精确动作，奶爸周砺同时听见女儿说出自己的需要。" +
    "周砺用当场完成的维修结果挡住逼近的威胁，女儿则指出被忽略的安全出口。" +
    "父女共同作出的选择改变了维修铺门前的冲突，围观者随即收起武器并调整立场，资源和关系都留下明确变化。"
  ).repeat(2);
  const drafts = [1, 2].map((attempt) => {
    const paragraphs = Array.from({ length: 16 }, (_, index) => index === 0
      ? `他从旧箱底抽出半本卷边残诗稿，纸页间还夹着母亲留下的第${attempt}张药方。${ordinaryParagraph}`
      : ordinaryParagraph);
    const title = `第一章 修好的机械臂${attempt}`;
    const normalizedTitle = `修好的机械臂${attempt}`;
    const hash = narrationArtifactHash(normalizedTitle, paragraphs);
    const content = paragraphs.join("\n");
    const candidates = [
      ...detectNarrationCandidates("title", normalizedTitle, hash),
      ...detectNarrationCandidates("body", content, hash),
    ];
    assert.equal(candidates.length, 1);
    return { title, normalizedTitle, paragraphs, candidates };
  });
  const calls: string[] = [];
  let writerCalls = 0;
  let reviewerCalls = 0;
  const complete: OpeningModelCompleter = async ({ model }) => {
    calls.push(model);
    if (model === "planner-route") {
      return { value: plan, usageTokens: 100, usageEstimated: false };
    }
    if (model === "writer-route") {
      const draft = drafts[writerCalls] ?? drafts.at(-1)!;
      writerCalls += 1;
      return {
        value: { title: draft.title, paragraphs: draft.paragraphs },
        usageTokens: 200,
        usageEstimated: false,
      };
    }
    const draft = drafts[Math.max(0, writerCalls - 1)];
    const decision = decisions[reviewerCalls] ?? decisions.at(-1) ?? "allow";
    reviewerCalls += 1;
    const semanticFields = decision === "allow"
      ? { worldInternal: true, writingProcessReference: false, confidence: 0.96 }
      : decision === "rewrite"
        ? { worldInternal: false, writingProcessReference: true, confidence: 0.96 }
        : { worldInternal: true, writingProcessReference: true, confidence: 0.62 };
    return {
      value: {
        experienceEvidence: [
          {
            axisId: "primary",
            word: "机械",
            signalIds: refinedContract.axes[0].observableSignals.map((signal) => signal.id),
            quote: "机械臂完成第1个精确动作",
          },
          {
            axisId: "secondary",
            word: "奶爸",
            signalIds: refinedContract.axes[1].observableSignals.map((signal) => signal.id),
            quote: "奶爸周砺同时听见女儿说出自己的需要",
          },
        ],
        event: {
          title: "维修铺门前的交锋",
          cause: "维修协会试图收走铺面",
          outcome: "父女共同守住维修铺",
          location: "旧城维修铺",
          persistentFacts: [
            "机械臂完成第1个精确动作",
            "奶爸周砺同时听见女儿说出自己的需要",
          ],
        },
        narrationAssessments: draft.candidates.map((candidate) => ({
          candidateId: candidate.id,
          ...semanticFields,
          decision,
          reason: decision === "allow" ? "这是故事内物件。" : "需要处理这句话的语义。",
        })),
      },
      usageTokens: 300,
      usageEstimated: false,
    };
  };
  return {
    context,
    connection: connectionFixture(),
    complete,
    calls,
    get writerCalls() { return writerCalls; },
    get reviewerCalls() { return reviewerCalls; },
  };
}

function assertAwaiting(outcome: OpeningGenerationOutcome) {
  assert.equal(outcome.status, "awaiting_user_review");
  if (outcome.status !== "awaiting_user_review") throw new Error("expected awaiting outcome");
  return outcome;
}

test("semantic allow completes the same draft and automatic rewrite uses at most two writers", async () => {
  const allowed = workflowFixture(["allow"]);
  const allowedOutcome = await beginStoryOpeningGeneration(
    allowed.context,
    allowed.connection,
    allowed.complete,
  );
  assert.equal(allowedOutcome.status, "completed");
  assert.equal(allowed.writerCalls, 1);
  assert.equal(allowed.reviewerCalls, 1);
  if (allowedOutcome.status === "completed") {
    assert.equal(allowedOutcome.narrationPermit.decision, "semantic_allow");
    assert.equal(allowedOutcome.generated.usageTokens, 600);
    assert.deepEqual(
      allowedOutcome.narrationReviews?.map((review) => review.resolution.decision),
      ["allow"],
    );
  }

  const rewritten = workflowFixture(["rewrite", "allow"]);
  const rewrittenProgress: OpeningProgressUpdate[] = [];
  const rewrittenOutcome = await beginStoryOpeningGeneration(
    rewritten.context,
    rewritten.connection,
    rewritten.complete,
    undefined,
    undefined,
    (update) => rewrittenProgress.push(update),
  );
  assert.equal(rewrittenOutcome.status, "completed");
  assert.deepEqual(
    rewrittenProgress.map((progress) => progress.activity),
    ["writing", "checking", "revising", "checking"],
  );
  assert.equal(rewrittenProgress[2].stage, "reviewing");
  if (rewrittenProgress[2].activity === "revising") {
    assert.equal(rewrittenProgress[2].revisionReason, "narration_needs_polish");
  }
  assert.equal(rewritten.writerCalls, 2);
  assert.equal(rewritten.reviewerCalls, 2);
  assert.deepEqual(rewritten.calls, [
    "planner-route",
    "writer-route",
    "reviewer-route",
    "writer-route",
    "reviewer-route",
  ]);
  if (rewrittenOutcome.status === "completed") {
    assert.deepEqual(
      rewrittenOutcome.narrationReviews?.map((review) => review.resolution.decision),
      ["rewrite", "allow"],
    );
  }
});

test("a terminal automatic rewrite failure retains structured review traces", async () => {
  const fixture = workflowFixture(["rewrite", "rewrite"]);
  let failure: unknown;
  try {
    await beginStoryOpeningGeneration(
      fixture.context,
      fixture.connection,
      fixture.complete,
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal((failure as Error & { code?: string }).code, "narration_rewrite_exhausted");
  assert.deepEqual(
    openingNarrationReviewsFromError(failure).map((review) => review.resolution.decision),
    ["rewrite", "rewrite"],
  );
  assert.equal(fixture.writerCalls, 2);
});

test("ask_user pauses before a second writer and keep resumes with no model call", async () => {
  const fixture = workflowFixture(["ask_user"]);
  const awaiting = assertAwaiting(await beginStoryOpeningGeneration(
    fixture.context,
    fixture.connection,
    fixture.complete,
  ));
  assert.equal(fixture.writerCalls, 1);
  assert.equal(fixture.reviewerCalls, 1);
  assert.equal(awaiting.checkpoint.accumulatedTokens, 600);
  assert.equal(awaiting.review.candidates.length, 1);
  assert.deepEqual(awaiting.checkpoint.reviewTrace?.map((review) => review.resolution.decision), ["ask_user"]);
  const callsBeforeKeep = fixture.calls.length;
  const completed = await resumeStoryOpeningGeneration(
    awaiting.checkpoint,
    {
      kind: "keep",
      candidateIds: awaiting.review.candidates.map((candidate) => candidate.id),
      contentHash: awaiting.review.contentHash,
    },
    fixture.connection,
    fixture.complete,
  );
  assert.equal(completed.status, "completed");
  assert.equal(fixture.calls.length, callsBeforeKeep);
  if (completed.status === "completed") {
    assert.equal(completed.narrationPermit.decision, "user_keep");
    assert.equal(completed.generated.usageTokens, 600);
    assert.match(completed.generated.chapter.paragraphs[0], /半本卷边残诗稿/);
  }
});

test("ask_user rewrite resumes at attempt two without rerunning the planner", async () => {
  const fixture = workflowFixture(["ask_user", "allow"]);
  const awaiting = assertAwaiting(await beginStoryOpeningGeneration(
    fixture.context,
    fixture.connection,
    fixture.complete,
  ));
  const callsBeforeResume = fixture.calls.length;
  const resumedProgress: OpeningProgressUpdate[] = [];
  const completed = await resumeStoryOpeningGeneration(
    awaiting.checkpoint,
    { kind: "rewrite", source: "user" },
    fixture.connection,
    fixture.complete,
    undefined,
    (update) => resumedProgress.push(update),
  );
  assert.equal(completed.status, "completed");
  assert.equal(resumedProgress[0].activity, "revising");
  if (resumedProgress[0].activity === "revising") {
    assert.equal(resumedProgress[0].revisionSource, "user");
  }
  assert.deepEqual(fixture.calls.slice(callsBeforeResume), ["writer-route", "reviewer-route"]);
  assert.equal(fixture.writerCalls, 2);
  if (completed.status === "completed") {
    assert.equal(completed.generated.usageTokens, 1_100);
    assert.equal(completed.narrationPermit.attempt, 2);
  }
});

test("a second ambiguous draft can be kept but cannot consume a third writer", async () => {
  const fixture = workflowFixture(["rewrite", "ask_user"]);
  const awaiting = assertAwaiting(await beginStoryOpeningGeneration(
    fixture.context,
    fixture.connection,
    fixture.complete,
  ));
  assert.equal(awaiting.checkpoint.attempt, 2);
  assert.equal(awaiting.checkpoint.rewriteCount, 1);
  assert.equal(fixture.writerCalls, 2);
  const callsBeforeDecision = fixture.calls.length;
  const kept = await resumeStoryOpeningGeneration(
    awaiting.checkpoint,
    {
      kind: "keep",
      candidateIds: awaiting.review.candidates.map((candidate) => candidate.id),
      contentHash: awaiting.review.contentHash,
    },
    fixture.connection,
    fixture.complete,
  );
  assert.equal(kept.status, "completed");
  assert.equal(fixture.calls.length, callsBeforeDecision);

  await assert.rejects(
    () => resumeStoryOpeningGeneration(
      awaiting.checkpoint,
      { kind: "rewrite", source: "timeout" },
      fixture.connection,
      fixture.complete,
    ),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "narration_rewrite_exhausted",
  );
  assert.equal(fixture.writerCalls, 2);
  assert.equal(fixture.calls.length, callsBeforeDecision);
});

test("resume rejects stale connection bindings and stale candidate decisions", async () => {
  const fixture = workflowFixture(["ask_user"]);
  const awaiting = assertAwaiting(await beginStoryOpeningGeneration(
    fixture.context,
    fixture.connection,
    fixture.complete,
  ));
  await assert.rejects(
    () => resumeStoryOpeningGeneration(
      awaiting.checkpoint,
      {
        kind: "keep",
        candidateIds: awaiting.review.candidates.map((candidate) => candidate.id),
        contentHash: awaiting.review.contentHash,
      },
      { ...fixture.connection, updatedAt: "2026-07-24T09:00:00.000Z" },
      fixture.complete,
    ),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "narration_review_checkpoint_invalid",
  );
  await assert.rejects(
    () => resumeStoryOpeningGeneration(
      awaiting.checkpoint,
      {
        kind: "keep",
        candidateIds: ["stale_candidate"],
        contentHash: awaiting.review.contentHash,
      },
      fixture.connection,
      fixture.complete,
    ),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "narration_review_checkpoint_invalid",
  );
});
test("narration permits bypass only the semantic word gate and remain content-bound", async () => {
  const fixture = workflowFixture(["allow"]);
  const outcome = await beginStoryOpeningGeneration(
    fixture.context,
    fixture.connection,
    fixture.complete,
  );
  assert.equal(outcome.status, "completed");
  if (outcome.status !== "completed") throw new Error("expected completed outcome");

  const prepared = prepareStoryOpening(fixture.context.input, "user_test");
  const published = applyGeneratedStoryOpening(
    prepared.story,
    fixture.connection,
    structuredClone(outcome.generated),
    outcome.narrationPermit,
  );
  assert.equal(published.chapters[0].revisions[0].paragraphs[0], outcome.generated.chapter.paragraphs[0]);

  const tampered = structuredClone(outcome.generated);
  tampered.chapter.paragraphs[0] += "x";
  assert.throws(
    () => applyGeneratedStoryOpening(
      prepareStoryOpening(fixture.context.input, "user_test").story,
      fixture.connection,
      tampered,
      outcome.narrationPermit,
    ),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "narration_review_checkpoint_invalid",
  );

  const unsafe = structuredClone(outcome.generated);
  unsafe.title = "\u6740\u5149\u67d0\u6c11\u65cf";
  assert.throws(
    () => applyGeneratedStoryOpening(
      prepareStoryOpening(fixture.context.input, "user_test").story,
      fixture.connection,
      unsafe,
      outcome.narrationPermit,
    ),
    (error: unknown) => error instanceof Error &&
      (error as Error & { status?: number }).status === 422,
  );
});

test("reviewer outage pauses once and keep retries only the reviewer", async () => {
  const fixture = workflowFixture(["allow"]);
  let failed = false;
  const unreliable: OpeningModelCompleter = async (request) => {
    if (request.model === "reviewer-route" && !failed) {
      failed = true;
      throw new Error("reviewer timeout");
    }
    return fixture.complete(request);
  };

  const awaiting = assertAwaiting(await beginStoryOpeningGeneration(
    fixture.context,
    fixture.connection,
    unreliable,
  ));
  assert.equal(awaiting.review.baseReviewStatus, "unavailable");
  assert.equal(fixture.writerCalls, 1);

  const resumed = await resumeStoryOpeningGeneration(
    awaiting.checkpoint,
    {
      kind: "keep",
      candidateIds: awaiting.review.candidates.map((candidate) => candidate.id),
      contentHash: awaiting.review.contentHash,
    },
    fixture.connection,
    unreliable,
  );
  assert.equal(resumed.status, "completed");
  assert.equal(fixture.writerCalls, 1);
  if (resumed.status !== "completed") throw new Error("expected completed outcome");
  assert.equal(resumed.generated.usageTokens, 600);
});
