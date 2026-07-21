import assert from "node:assert/strict";
import test from "node:test";
import {
  hasIndependentSignalEvidenceAnchors,
  refineReadingExperienceContract,
} from "../server/readingExperience";
import { createStory } from "../server/storyService";

test("repairs malformed model evidence anchors from their grounded signal descriptions", () => {
  const base = createStory({ genre: "玄幻", tone: "热血 · 爽快" }, "user_test").readingExperience;

  const refined = refineReadingExperienceContract(base, [
    {
      word: "热血",
      interpretation: "主角面对强敌主动迎战，并以行动带动同伴共同守住目标",
      observableSignals: [
        {
          description: "主角迎着围攻冲上城墙并斩断敌军旗杆",
          evidenceAnchors: ["冲锋动作", "胜利结果"],
        },
        {
          description: "受伤同伴重新站起并跟随主角守住城门",
          evidenceAnchors: ["人物行动", "关系结果"],
        },
      ],
      hardPromises: ["主动迎战必须产生明确胜负与同伴响应"],
      forbiddenShortcuts: ["只喊口号却没有行动兑现"],
    },
    {
      word: "爽快",
      interpretation: "冲突迅速获得清晰回应，胜利马上转化成可见收益",
      observableSignals: [
        {
          description: "挑衅者当场败退并交出被夺走的令牌",
          evidenceAnchors: ["当场败退", "交出令牌"],
        },
        {
          description: "围观者改口称服并为主角让开通路",
          evidenceAnchors: ["改口称服", "让开通路"],
        },
      ],
      hardPromises: ["核心冲突与回报都在场景内清楚落地"],
      forbiddenShortcuts: ["用误会拖延已经建立的核心回报"],
    },
  ]);

  const repairedSignals = refined.axes[0].observableSignals.filter((signal) => signal.id.includes("_model_signal_"));
  assert.equal(repairedSignals.length, 2);
  for (const signal of repairedSignals) {
    assert.ok(signal.evidenceAnchors);
    assert.ok(signal.evidenceAnchors.length >= 2);
    assert.ok(signal.evidenceAnchors.length <= 6);
    assert.ok(signal.evidenceAnchors.every((anchor) => signal.description.includes(anchor)));
    assert.ok(hasIndependentSignalEvidenceAnchors(signal.evidenceAnchors));
  }
  assert.ok(repairedSignals[0].evidenceAnchors?.some((anchor) => anchor.includes("旗杆")));
  assert.ok(repairedSignals[1].evidenceAnchors?.some((anchor) => anchor.includes("城门")));

  const openingSignalIds = refined.openingRequirements[0].requiredSignalIds;
  for (const axis of refined.axes) {
    const requiredForAxis = openingSignalIds.filter((signalId) => signalId.startsWith(`${axis.id}_`));
    assert.ok(requiredForAxis.some((signalId) => signalId.includes("_model_signal_")));
    assert.ok(requiredForAxis.some((signalId) => !signalId.includes("_model_signal_")));
  }
});
