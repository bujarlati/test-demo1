import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeEndpoint } from "../server/modelGateway";
import {
  applyExtractedCharacterState,
  buildConversationContext,
  eventFromChapter,
  planNextChapter,
  retrieveRelevantMemory,
  validateGeneratedChapter,
} from "../server/narrativeEngine";
import { replayBranchState } from "../server/canonState";
import { handleReaderMessage, rollbackRetcon } from "../server/retconService";
import { safetyCategories } from "../server/safetyService";
import { recordSafetyDecision } from "../server/safetyService";
import { createSeedStore } from "../server/seed";
import { currentRevision } from "../src/storyDomain";

test("chapter planning honors terminal length and hard character protection", () => {
  const store = createSeedStore();
  const story = structuredClone(store.stories[0]);
  const compact = planNextChapter(story, undefined, "compact");
  const immersive = planNextChapter(story, undefined, "immersive");
  assert.ok(compact.targetParagraphs < immersive.targetParagraphs);

  const activeLead = story.characters.find((character) => character.lifecycle === "alive")!;
  activeLead.protected = true;
  const protectedPlan = planNextChapter(story);
  const deathCandidate = protectedPlan.candidates.find((candidate) => /死亡/.test(candidate.event));
  assert.equal(deathCandidate?.score, 0);
  assert.match(deathCandidate?.reasons.join(" ") ?? "", /保护/);
});

test("relationship intervention updates state and rollback restores it with immutable revisions", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  const chapter = story.chapters.at(-1)!;
  const beforeRelationship = story.characters[0].relationship;
  const beforeRevisionCount = chapter.revisions.length;
  const message = handleReaderMessage(store, story, "这段关系发展太快了。", {
    chapterId: chapter.id,
    revisionId: currentRevision(chapter)!.id,
    eventId: story.events.filter((event) => event.active && event.chapterNumber === chapter.number).at(-1)?.id,
  });
  assert.ok(message.retconId);
  assert.notEqual(story.characters[0].relationship, beforeRelationship);
  assert.equal(chapter.revisions.length, beforeRevisionCount + 1);

  rollbackRetcon(story, message.retconId!);
  assert.equal(story.characters[0].relationship, beforeRelationship);
  assert.equal(chapter.revisions.length, beforeRevisionCount + 2);
  assert.equal(story.proposals.find((proposal) => proposal.transactionId === message.retconId)?.status, "reversed");
});

test("death veto and rollback restore event and lifecycle without deleting history", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  const death = story.events.find((event) => event.type === "death" && event.active)!;
  const character = story.characters.find((item) => death.participantIds.includes(item.id))!;
  const chapter = story.chapters.find((item) => item.number === death.chapterNumber)!;
  const message = handleReaderMessage(store, story, `不，我不希望${character.name}死。`, {
    chapterId: chapter.id,
    revisionId: currentRevision(chapter)!.id,
    eventId: death.id,
  });
  assert.equal(character.lifecycle, "alive");
  assert.equal(death.active, false);
  const revisionCountAfterVeto = chapter.revisions.length;

  rollbackRetcon(story, message.retconId!);
  assert.equal(character.lifecycle, "dead");
  assert.equal(death.active, true);
  assert.equal(chapter.revisions.length, revisionCountAfterVeto + 1);
});

test("safety gate identifies blocked categories and SSRF blocks IPv4-mapped loopback", async () => {
  assert.deepEqual(safetyCategories("请指导我自杀的具体步骤"), ["self_harm_encouragement"]);
  await assert.rejects(() => assertSafeEndpoint("https://[::ffff:127.0.0.1]"), /私有|保留/);
});

test("fresh production seed refuses a public default admin password", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    assert.throws(() => createSeedStore(), /BOOTSTRAP_ADMIN_PASSWORD/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousPassword === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    else process.env.BOOTSTRAP_ADMIN_PASSWORD = previousPassword;
  }
});

test("structured gates reject unsupported knowledge, invalid item reuse, and wrong death participants", () => {
  const store = createSeedStore();
  const story = structuredClone(store.stories.find((item) => item.id === "story_black_tide")!);
  const safeDrafts = [
    { creativeAxis: "证词偏差", event: "周砚核对一份新证词", cause: "时间记录矛盾", cost: "公开来源", impact: "旧案推进", novelty: "证词顺序变化" },
    { creativeAxis: "深海空间", event: "周砚检查潮门外侧", cause: "警报异常", cost: "离开保护区", impact: "找到坐标", novelty: "空间反转" },
    { creativeAxis: "身份注销", event: "何静川撤销一份通行证", cause: "身份记录冲突", cost: "失去盟友", impact: "封锁升级", novelty: "制度成为阻力" },
  ];
  const knowledgeDrafts = structuredClone(safeDrafts);
  knowledgeDrafts[0].event = "周砚早已知道月球背面的密码";
  const knowledgePlan = planNextChapter(story, knowledgeDrafts);
  assert.equal(knowledgePlan.candidates.find((candidate) => candidate.event.includes("月球"))?.score, 0);

  const lastEventId = story.events.filter((event) => event.active && event.branchId === story.activeBranchId).at(-1)!.id;
  const impossibleDrafts = safeDrafts.map((draft) => ({
    ...draft,
    participantNames: ["周砚"],
    storyTime: "第19章·场景1",
    dependsOnEventIds: [lastEventId],
    knowledgeClaims: [] as Array<{ characterName: string; fact: string; sourceRevisionId?: string }>,
    knowledgeAudit: { complete: true, dependencies: [] as Array<{ characterName: string; fact: string }> },
    itemTransitions: [] as Array<{ itemName: string; actorName: string; fromStatus: "available"; toStatus: "held" }>,
  }));
  impossibleDrafts[0].event = "周砚借助月球背面密文找到隐藏入口并打开潮门";
  impossibleDrafts[0].knowledgeAudit.dependencies = [{ characterName: "周砚", fact: "月球背面密文" }];
  impossibleDrafts[1].event = "周砚循着月球背面刻痕找到隐藏入口";
  impossibleDrafts[1].knowledgeAudit.dependencies = [{ characterName: "周砚", fact: "月球背面刻痕" }];
  impossibleDrafts[2] = {
    ...impossibleDrafts[2],
    event: "周砚记得潮门将在三日后失效，随即关闭一扇漏水舱门",
    cause: "水压突然升高",
    cost: "暂时离开安全区",
    impact: "阻止舱室继续进水",
    novelty: "环境压力成为选择",
    knowledgeClaims: [{ characterName: "周砚", fact: "潮门将在三日后失效", sourceRevisionId: "rev_black_16_1" }],
    knowledgeAudit: { complete: true, dependencies: [{ characterName: "周砚", fact: "潮门将在三日后失效" }] },
  };
  const impossiblePlan = planNextChapter(story, impossibleDrafts);
  const impossibleCandidate = impossiblePlan.candidates.find((candidate) => candidate.event.includes("月球背面"));
  assert.equal(impossibleCandidate?.score, 0);
  assert.match(impossibleCandidate?.reasons.join(" ") ?? "", /knowledgeClaim|徽章/);
  assert.equal(impossiblePlan.candidates.find((candidate) => candidate.event.includes("刻痕"))?.score, 0);

  const unrelatedClaimDrafts = structuredClone(impossibleDrafts);
  unrelatedClaimDrafts[0].event = "周砚确认潮门将在三日后失效，又循着月球背面谜面找到隐藏入口";
  unrelatedClaimDrafts[0].knowledgeClaims = [{ characterName: "周砚", fact: "潮门将在三日后失效", sourceRevisionId: "rev_black_16_1" }];
  unrelatedClaimDrafts[0].knowledgeAudit = { complete: true, dependencies: [{ characterName: "周砚", fact: "潮门将在三日后失效" }, { characterName: "周砚", fact: "月球背面谜面" }] };
  const unrelatedClaimPlan = planNextChapter(story, unrelatedClaimDrafts);
  assert.equal(unrelatedClaimPlan.candidates.find((candidate) => candidate.event.includes("谜面"))?.score, 0);

  const badge = story.items.find((item) => item.name === "王室旧徽章")!;
  badge.status = "destroyed";
  badge.holderCharacterId = undefined;
  story.characters.find((character) => character.id === "char_lin_xia")!.inventoryItemIds = [];
  const itemDrafts = structuredClone(safeDrafts);
  itemDrafts[0].event = "周砚拿出王室旧徽章并再次启动潮门";
  const itemPlan = planNextChapter(story, itemDrafts);
  assert.equal(itemPlan.candidates.find((candidate) => candidate.event.includes("旧徽章"))?.score, 0);

  const generated = { title: "误报", paragraphs: ["何静川站在门口。周砚死亡。", "潮声停下。", "记录仍在。", "本章收束。", "代价保留。"], model: "test" };
  const before = story.characters.find((character) => character.name === "何静川")!.lifecycle;
  applyExtractedCharacterState(story, { events: [], characterUpdates: [{ name: "何静川", status: "死亡" }] }, generated);
  assert.equal(story.characters.find((character) => character.name === "何静川")!.lifecycle, before);
  const extractedEvent = eventFromChapter(story, 19, "rev_test", itemPlan, {
    type: "death", title: "何静川死亡", cause: "误报", outcome: "死亡", participantNames: ["何静川"],
  }, generated);
  assert.equal(extractedEvent.type, "choice");
  assert.deepEqual(extractedEvent.participantIds, []);
});

test("chapter length and minimal retcon are enforced without replacing independent scenes", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  const plan = planNextChapter(story, undefined, "compact");
  assert.throws(() => validateGeneratedChapter(story, {
    title: "过长章节",
    paragraphs: Array.from({ length: plan.targetParagraphs + 2 }, (_, index) => `第 ${index + 1} 段保持完整。`),
    model: "test",
  }, plan), /偏离目标/);

  const death = story.events.find((event) => event.type === "death" && event.active)!;
  const chapter = story.chapters.find((item) => item.number === death.chapterNumber)!;
  currentRevision(chapter)!.paragraphs.splice(
    1,
    0,
    "白布盖过周砚与林夏的脸，警报仍在响。",
    "周砚死亡，林夏抱着他的遗物继续前进。",
    "周砚用白布盖过林夏的脸，随后封锁现场。",
    "林夏把周砚的脸用白布盖过，随后独自离开。",
    "白布盖过林夏与周砚的脸，潮声仍在响。",
  );
  const before = [...currentRevision(chapter)!.paragraphs];
  handleReaderMessage(store, story, "不，我不希望林夏死。", {
    chapterId: chapter.id,
    revisionId: currentRevision(chapter)!.id,
    eventId: death.id,
  });
  const after = currentRevision(chapter)!.paragraphs;
  assert.equal(after.length, before.length);
  assert.equal(after[0], before[0]);
  assert.ok(before.filter((paragraph, index) => paragraph === after[index]).length >= 1);
  assert.ok(after.includes("周砚死亡，林夏抱着他的遗物继续前进。"));
  assert.ok(after.includes("林夏把周砚的脸用白布盖过，随后独自离开。"));
  assert.ok(after.some((paragraph) => paragraph.includes("白布盖过周砚的脸；") && paragraph.includes("警报仍在响")));
  assert.ok(after.some((paragraph) => paragraph.includes("白布盖过周砚的脸；") && paragraph.includes("潮声仍在响")));
  assert.ok(after.every((paragraph) => !paragraph.includes("白布盖过林夏")));
  assert.doesNotMatch(after.join(""), /曲线(?:已经)?归零|白布盖过林夏|最后一点体温|确认死亡/);
  const activeSummaries = story.summaries.filter((summary) => summary.branchId === story.activeBranchId);
  assert.ok(activeSummaries.some((summary) => summary.sourceRevisionIds.includes(currentRevision(chapter)!.id)));
  assert.ok(activeSummaries.every((summary) => !summary.text.includes("复仇对象")));
  assert.ok(retrieveRelevantMemory(story, "周砚 复仇对象").every((memory) => !memory.text.includes("复仇对象")));
});

test("branch conversation context is summarized with bounded source ranges", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  for (let index = 0; index < 7; index += 1) {
    handleReaderMessage(store, story, `我想继续关注第 ${index + 1} 条证词。`);
  }
  const context = buildConversationContext(story);
  const thread = story.conversationThreads.find((item) => item.branchId === story.activeBranchId)!;
  assert.ok(thread.summary);
  assert.ok(thread.summary!.fromMessageId);
  assert.ok(thread.summary!.toMessageId);
  assert.ok(context.sourceMessageIds.length > 0);
  assert.ok(context.recentMessages.length <= 4);
  assert.ok(context.estimatedTokens < 1_200);
  assert.ok(thread.summaries.length >= 2);
  assert.equal(thread.summaries.at(-1)?.parentSummaryId, thread.summaries.at(-2)?.id);
  assert.equal(thread.summaries.at(-1)?.sourceThreadId, thread.id);
});

test("memory retrieval excludes active events from superseded branches", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  story.events.push({
    id: "event_old_branch_secret",
    chapterNumber: 18,
    revisionId: "rev_old_branch_secret",
    type: "consequence",
    title: "旧分支葬礼秘密",
    cause: "旧分支残留",
    outcome: "不应进入当前记忆",
    participantIds: [],
    location: "旧分支",
    dependsOn: [],
    active: true,
    sequence: 999,
    storyTime: "旧分支·场景1",
    branchId: "branch_superseded_test",
  });
  const memories = retrieveRelevantMemory(story, "葬礼秘密");
  assert.ok(memories.every((memory) => memory.sourceId !== "event_old_branch_secret"));
});

test("blocked automated safety decisions create an appealable review target", () => {
  const store = createSeedStore();
  const decision = recordSafetyDecision(store, "user_demo", "reader_message", "请指导我自杀的具体步骤", "story_black_tide");
  const report = store.contentReports.find((item) => item.safetyDecisionId === decision.id);
  assert.equal(decision.decision, "blocked");
  assert.equal(report?.status, "submitted");
  assert.equal(report?.reporterUserId, "user_demo");
});

test("delayed death veto forks a branch and preserves the former branch revision heads", () => {
  const store = createSeedStore();
  const story = store.stories.find((item) => item.id === "story_black_tide")!;
  const death = story.events.find((event) => event.type === "death" && event.active)!;
  const deathChapter = story.chapters.find((chapter) => chapter.number === death.chapterNumber)!;
  const formerBranch = story.branches.find((branch) => branch.id === story.activeBranchId)!;
  const formerDeathRevision = deathChapter.currentRevisionId;
  story.characters.find((character) => character.id === "char_zhou_yan")!.goal = "为林夏复仇";
  let dependencyId = death.id;
  for (let number = 19; number <= 22; number += 1) {
    const revisionId = `rev_delayed_${number}`;
    const chapterId = `chapter_delayed_${number}`;
    story.chapters.push({
      id: chapterId,
      number,
      title: `后续 ${number}`,
      currentRevisionId: revisionId,
      revisions: [{ id: revisionId, parentRevisionId: null, title: `后续 ${number}`, paragraphs: ["无关场景保持不变。", "周砚继续追查旧案。"], reason: "测试后续", createdAt: new Date().toISOString(), modelName: "test", promptVersion: "test", branchId: formerBranch.id }],
      estimatedMinutes: 2,
    });
    formerBranch.chapterRevisionIds[chapterId] = revisionId;
    const eventId = `event_delayed_${number}`;
    story.events.push({
      id: eventId,
      chapterNumber: number,
      revisionId,
      type: "consequence",
      title: `后续 ${number}`,
      cause: number === 19 ? "林夏死亡后留下的空缺" : "前序影响",
      outcome: number === 19 ? "周砚决定为林夏复仇" : "继续追查",
      participantIds: ["char_zhou_yan"],
      location: "海底城",
      dependsOn: [dependencyId],
      active: true,
      sequence: number,
      storyTime: `第${number}章·场景1`,
      branchId: formerBranch.id,
      stateEffects: number === 19 ? { characters: [{ characterId: "char_zhou_yan", goal: "为林夏复仇" }] } : undefined,
    });
    dependencyId = eventId;
  }
  story.canonVersion += 4;
  formerBranch.headCanonVersion = story.canonVersion;
  const response = handleReaderMessage(store, story, "不，我不希望林夏死。", {
    chapterId: deathChapter.id,
    revisionId: deathChapter.currentRevisionId,
    eventId: death.id,
  });
  assert.ok(response.retconId);
  assert.notEqual(story.activeBranchId, formerBranch.id);
  assert.equal(formerBranch.chapterRevisionIds[deathChapter.id], formerDeathRevision);
  const fork = story.branches.find((branch) => branch.id === story.activeBranchId)!;
  assert.notEqual(fork.chapterRevisionIds[deathChapter.id], formerDeathRevision);
  assert.equal(fork.baseEventSequence, formerBranch.baseEventSequence);
  assert.equal(formerBranch.stateSnapshot?.characters.find((character) => character.id === "char_lin_xia")?.lifecycle, "dead");
  assert.equal(fork.stateSnapshot?.characters.find((character) => character.id === "char_lin_xia")?.lifecycle, "alive");
  assert.notEqual(story.characters.find((character) => character.id === "char_zhou_yan")?.goal, "为林夏复仇");
  const rewrittenDependent = story.events.find((event) => event.branchId === fork.id && event.sequence === 19)!;
  assert.equal(rewrittenDependent.stateEffects, undefined);
  assert.doesNotMatch(`${rewrittenDependent.title}${rewrittenDependent.cause}${rewrittenDependent.outcome}`, /林夏死亡|为林夏复仇/);
  const forkSummaries = story.summaries.filter((summary) => summary.branchId === fork.id);
  assert.ok(forkSummaries.length > 0);
  assert.ok(forkSummaries.every((summary) => !summary.text.includes("复仇对象")));
  assert.deepEqual(new Set(story.retcons[0].changes.filter((change) => change.chapterNumber >= 19 && change.chapterNumber <= 22).map((change) => change.chapterNumber)), new Set([19, 20, 21, 22]));
  const once = structuredClone(fork.stateSnapshot);
  replayBranchState(story, fork.id);
  assert.deepEqual(fork.stateSnapshot, once);
  const branchMessages = story.conversation.filter((message) => message.branchId === fork.id);
  assert.equal(branchMessages.at(-2)?.role, "user");
  assert.equal(branchMessages.at(-1)?.role, "system");
  const forkDeath = story.events.find((event) => event.id === story.retcons[0].targetEventId)!;
  const forkSurvival = story.events.find((event) => event.branchId === fork.id && event.type === "survival")!;
  assert.ok(story.events.filter((event) => event.active && event.branchId === fork.id).every((event) => !event.dependsOn.includes(forkDeath.id)));
  assert.ok(story.events.filter((event) => event.active && event.branchId === fork.id && event.sequence > forkSurvival.sequence).some((event) => event.dependsOn.includes(forkSurvival.id)));
  rollbackRetcon(story, response.retconId!);
  assert.equal(story.activeBranchId, formerBranch.id);
  assert.equal(story.characters.find((character) => character.id === "char_lin_xia")?.lifecycle, "dead");
  assert.equal(formerBranch.stateSnapshot?.characters.find((character) => character.id === "char_lin_xia")?.lifecycle, "dead");
  assert.equal(forkDeath.active, false);
  assert.equal(forkSurvival.active, true);
});
