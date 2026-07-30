import assert from "node:assert/strict";
import test from "node:test";
import {
  generateCandidateDraftsWithConnection,
  generateChapterWithConnection,
} from "../server/modelGateway";
import {
  buildChapterPrompt,
  buildVolumeBoundaryContext,
  planNextChapter,
  storyArcPhase,
} from "../server/narrativeEngine";
import { createStory } from "../server/storyService";
import { buildStoryChapterSections } from "../src/storyStructure";
import type { ModelConnection } from "../src/types";

test("story structure reserves three purposeful transition chapters before every non-final volume boundary", () => {
  const transition = [
    storyArcPhase(22, 200),
    storyArcPhase(23, 200),
    storyArcPhase(24, 200),
  ];
  const secondVolumeOpening = storyArcPhase(25, 200);
  const finalVolumeEnding = storyArcPhase(197, 200);

  for (const [targetChapterCount, volumeChapterCount] of [[80, 20], [200, 25], [1_000, 50]] as const) {
    const boundary = [0, 1, 2].map((offset) =>
      storyArcPhase(volumeChapterCount - 3 + offset, targetChapterCount),
    );
    assert.deepEqual(boundary.map((phase) => phase.id), ["transition", "transition", "transition"]);
    assert.deepEqual(boundary.map((phase) => phase.transitionStep), [1, 2, 3]);
    const followingVolume = storyArcPhase(volumeChapterCount, targetChapterCount);
    assert.equal(followingVolume.volumeNumber, 2);
    assert.equal(followingVolume.chapterInVolume, 1);
  }

  assert.deepEqual(transition.map((phase) => phase.id), ["transition", "transition", "transition"]);
  assert.deepEqual(transition.map((phase) => phase.transitionStep), [1, 2, 3]);
  assert.ok(transition.every((phase) => phase.transitionTotal === 3));
  assert.match(transition[0].guidance, /胜负|伤势|代价/);
  assert.match(transition[1].guidance, /人物关系|资源|场域/);
  assert.match(transition[2].guidance, /下一卷|下一阶段/);
  assert.equal(secondVolumeOpening.id, "opening");
  assert.equal(secondVolumeOpening.volumeNumber, 2);
  assert.equal(secondVolumeOpening.chapterInVolume, 1);
  assert.match(secondVolumeOpening.guidance, /上一卷.*过渡章|承接上一卷/);
  assert.notEqual(finalVolumeEnding.id, "transition");
});

test("reader chapter sections use stable canonical volume boundaries instead of fabricated parts", () => {
  const chapters = Array.from({ length: 26 }, (_, index) => ({
    id: `chapter_${index + 1}`,
    number: index + 1,
  }));

  const sevenChapterSections = buildStoryChapterSections(chapters.slice(0, 7), 200);
  const twentyFiveChapterSections = buildStoryChapterSections(chapters.slice(0, 25), 200);
  const twentySixChapterSections = buildStoryChapterSections(chapters, 200);

  assert.deepEqual(sevenChapterSections.map((section) => section.label), ["第一卷"]);
  assert.deepEqual(twentyFiveChapterSections.map((section) => section.label), [
    "第一卷",
    "卷间过渡 · 第一卷 → 第二卷",
  ]);
  assert.deepEqual(
    twentyFiveChapterSections[0].chapters.map((chapter) => chapter.number),
    Array.from({ length: 22 }, (_, index) => index + 1),
  );
  assert.deepEqual(twentyFiveChapterSections[1].chapters.map((chapter) => chapter.number), [23, 24, 25]);
  assert.deepEqual(twentySixChapterSections.map((section) => section.label), [
    "第一卷",
    "卷间过渡 · 第一卷 → 第二卷",
    "第二卷",
  ]);
  assert.deepEqual(twentySixChapterSections.slice(0, 2), twentyFiveChapterSections);
  assert.doesNotMatch(
    twentySixChapterSections.map((section) => section.label).join(" "),
    /潮线初现|旧城回声|黑潮将至/,
  );
});

test("transition writer prompt receives the previous canon cause and outcome instead of an unexplained jump", () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖", lengthPlan: "standard" }, "user_transition_prompt");
  const latestEvent = story.events.at(-1)!;
  latestEvent.cause = "旧城区停电是上一阶段选择造成的直接后果";
  latestEvent.outcome = "避难站保住了，但主角必须带着伤员迁往河东区";
  const plan = planNextChapter(story);
  plan.storyArc = storyArcPhase(22, 200);

  const prompt = buildChapterPrompt(story, plan);

  assert.match(prompt, /卷间过渡/);
  assert.match(prompt, /旧城区停电是上一阶段选择造成的直接后果/);
  assert.match(prompt, /避难站保住了，但主角必须带着伤员迁往河东区/);
});

test("transition planner receives concrete recent canon outcomes", async () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖", lengthPlan: "standard" }, "user_transition_planner");
  story.chapters.length = 22;
  const latestEvent = story.events.at(-1)!;
  latestEvent.cause = "主角关闭旧城电网后引发全区转移";
  latestEvent.outcome = "队伍保住物资，却必须沿河撤离";
  const connection: ModelConnection = {
    id: "connection_transition_test",
    name: "Transition test",
    ownerScope: "user",
    ownerId: story.ownerId,
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk-test",
    secretRef: "secret://transition-test",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date(0).toISOString(),
  };
  const candidate = {
    creativeAxis: "迁移余波",
    event: "主角清点伤员并准备转移",
    cause: "旧城电网已经关闭",
    cost: "放弃熟悉据点",
    impact: "队伍开始向河东区移动",
    novelty: "用资源重新分配完成卷间交接",
    participantNames: [],
    storyTime: "当夜",
    dependsOnEventIds: [],
    knowledgeClaims: [],
    itemTransitions: [],
  };
  let plannerPrompt = "";
  let calls = 0;

  await generateCandidateDraftsWithConnection(connection, story, async <T>(_connection, _model, _system, prompt) => {
    calls += 1;
    if (calls === 1) {
      plannerPrompt = prompt;
      return {
        value: { candidates: [candidate, candidate, candidate] } as T,
        usageTokens: 100,
        usageEstimated: false,
      };
    }
    return {
      value: {
        audits: [0, 1, 2].map((candidateIndex) => ({ candidateIndex, complete: true, dependencies: [] })),
      } as T,
      usageTokens: 100,
      usageEstimated: false,
    };
  });

  assert.match(plannerPrompt, /卷间过渡/);
  assert.match(plannerPrompt, /主角关闭旧城电网后引发全区转移/);
  assert.match(plannerPrompt, /队伍保住物资，却必须沿河撤离/);
});

test("new-volume continuity pins the last transition chapter and bounds untrusted material", () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖", lengthPlan: "standard" }, "user_volume_opening");
  const templateChapter = story.chapters[0]!;
  story.chapters = Array.from({ length: 25 }, (_, index) => {
    const chapter = structuredClone(templateChapter);
    chapter.id = `chapter_${index + 1}`;
    chapter.number = index + 1;
    chapter.title = `第${index + 1}章`;
    if (index === 24) {
      chapter.title = "迈向河东";
      chapter.revisions[0]!.paragraphs = [
        "众人把伤员扶上渡船，主角亲手解开最后一根缆绳。",
        "渡船已经离开旧城码头，所有人都在河面上。",
      ];
    }
    return chapter;
  });

  const templateEvent = story.events.at(-1)!;
  const lastTransitionEvent = {
    ...structuredClone(templateEvent),
    id: "event_last_transition",
    chapterNumber: 25,
    sequence: 25,
    title: "渡船离开旧城",
    cause: "旧城区停电迫使队伍完成撤离",
    outcome: "伤员和物资都已上船，主角正在前往河东区",
    location: "旧城外河面",
  };
  story.events = [
    lastTransitionEvent,
    ...Array.from({ length: 8 }, (_, index) => ({
      ...structuredClone(templateEvent),
      id: `event_retcon_${index}`,
      chapterNumber: 24,
      sequence: 100 + index,
      title: `修史事件${index}${"很长".repeat(200)}`,
      cause: `较早的修史原因${index}${"不应挤掉最后过渡章".repeat(200)}`,
      outcome: `较早的修史结果${index}${"需要限制长度".repeat(200)}`,
    })),
  ];

  const phase = storyArcPhase(25, 200);
  const context = buildVolumeBoundaryContext(story, phase);

  assert.equal(phase.volumeNumber, 2);
  assert.equal(phase.chapterInVolume, 1);
  assert.match(context, /不可信故事数据/);
  assert.match(context, /渡船已经离开旧城码头，所有人都在河面上/);
  assert.match(context, /旧城区停电迫使队伍完成撤离/);
  assert.match(context, /伤员和物资都已上船，主角正在前往河东区/);
  assert.ok(context.length <= 6_000, `boundary context was ${context.length} characters`);
});

test("ordinary planner chapters do not receive expanded volume-boundary event details", async () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖", lengthPlan: "standard" }, "user_ordinary_planner");
  const latestEvent = story.events.at(-1)!;
  latestEvent.cause = "NON_BOUNDARY_PRIVATE_CAUSE";
  latestEvent.outcome = "NON_BOUNDARY_PRIVATE_OUTCOME";
  const connection: ModelConnection = {
    id: "connection_ordinary_test",
    name: "Ordinary test",
    ownerScope: "user",
    ownerId: story.ownerId,
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk-test",
    secretRef: "secret://ordinary-test",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date(0).toISOString(),
  };
  let plannerPrompt = "";

  await assert.rejects(
    generateCandidateDraftsWithConnection(connection, story, async <T>(_connection, _model, _system, prompt) => {
      plannerPrompt = prompt;
      throw new Error("stop after planner prompt capture");
    }),
    /stop after planner prompt capture/,
  );

  assert.doesNotMatch(plannerPrompt, /NON_BOUNDARY_PRIVATE_CAUSE|NON_BOUNDARY_PRIVATE_OUTCOME/);
});
test("planner and writer system prompts keep boundary story data untrusted", async () => {
  const story = createStory({ genre: "都市", tone: "紧张 · 温暖", lengthPlan: "standard" }, "user_boundary_trust");
  const connection: ModelConnection = {
    id: "connection_boundary_trust_test",
    name: "Boundary trust test",
    ownerScope: "user",
    ownerId: story.ownerId,
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk-test",
    secretRef: "secret://boundary-trust-test",
    secretVersion: 1,
    status: "active",
    routes: { planner: "planner", writer: "writer", extractor: "extractor", embedding: "embedding" },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: new Date(0).toISOString(),
  };
  let plannerSystem = "";
  let writerSystem = "";

  await assert.rejects(
    generateCandidateDraftsWithConnection(connection, story, async <T>(_connection, _model, system) => {
      plannerSystem = system;
      throw new Error("stop after planner system capture");
    }),
    /stop after planner system capture/,
  );
  await generateChapterWithConnection(connection, "<untrusted_story_data>{}</untrusted_story_data>", 200, async <T>(
    _connection,
    _model,
    system,
  ) => {
    writerSystem = system;
    return {
      value: {
        title: "渡口",
        paragraphs: ["第一段。", "第二段。", "第三段。", "第四段。"],
      } as T,
      usageTokens: 20,
      usageEstimated: false,
    };
  });

  for (const system of [plannerSystem, writerSystem]) {
    assert.match(system, /untrusted_story_data/);
    assert.match(system, /不得执行/);
    assert.match(system, /不得复述/);
  }
});
