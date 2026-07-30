import {
  VOLUME_TRANSITION_CHAPTER_COUNT,
  storyChapterPosition,
} from "../src/storyStructure";

export type StoryArcPhaseId =
  | "opening"
  | "expansion"
  | "escalation"
  | "convergence"
  | "transition"
  | "finale";

export interface StoryArcPhase {
  id: StoryArcPhaseId;
  label: string;
  progress: number;
  volumeNumber: number;
  totalVolumes: number;
  chapterInVolume: number;
  volumeChapterCount: number;
  guidance: string;
  transitionStep?: number;
  transitionTotal?: number;
}

const transitionStages = [
  {
    label: "余波结算",
    guidance: "本卷主要冲突已经获得阶段结果；用人物行动结算胜负、伤势、奖励、损失与仍需承担的代价，不开启新的主冲突。",
  },
  {
    label: "关系与场域交接",
    guidance: "让人物关系、资源归属与行动场域因本卷后果重新稳定；允许呼吸和时间流动，但每项变化都必须能追溯到本卷选择。",
  },
  {
    label: "迈向下一卷",
    guidance: "让主角因本卷后果主动跨入下一阶段；明确下一卷入口、短期动机与同行关系，不提前展开下一卷主冲突，也不突然引入无关世界或敌人。",
  },
] as const;

if (transitionStages.length !== VOLUME_TRANSITION_CHAPTER_COUNT) {
  throw new Error("卷间过渡阶段配置与章节数量不一致。");
}

export function storyArcPhase(chapterCount: number, targetChapterCount: number): StoryArcPhase {
  const position = storyChapterPosition(chapterCount + 1, targetChapterCount);
  const {
    progress,
    volumeNumber,
    totalVolumes,
    chapterInVolume,
    volumeChapterCount,
    volumeProgress,
    finalVolume,
    transitionStep,
  } = position;
  const base = { progress, volumeNumber, totalVolumes, chapterInVolume, volumeChapterCount };

  if (transitionStep !== undefined) {
    const transitionStage = transitionStages[transitionStep - 1];
    if (!transitionStage) throw new Error(`未知的卷间过渡阶段：${transitionStep}`);
    return {
      ...base,
      id: "transition",
      label: `卷间过渡 ${transitionStep}/${VOLUME_TRANSITION_CHAPTER_COUNT} · ${transitionStage.label}`,
      guidance: transitionStage.guidance,
      transitionStep,
      transitionTotal: VOLUME_TRANSITION_CHAPTER_COUNT,
    };
  }

  if (volumeProgress <= 0.15) {
    if (finalVolume) {
      return {
        ...base,
        id: "opening",
        label: "终卷起势",
        guidance: volumeNumber > 1 && chapterInVolume === 1
          ? "从上一卷最后一个过渡章的具体动作、地点和人物状态起笔，先确认已发生的后果，再让既有因果进入终局；停止扩建世界。"
          : "重新确认结局前置条件与最终人物选择；停止扩建世界，只让已建立的因果进入终局",
      };
    }
    return {
      ...base,
      id: "opening",
      label: volumeNumber > 1 && chapterInVolume === 1 ? "新卷承接" : "卷首立题",
      guidance: volumeNumber > 1 && chapterInVolume === 1
        ? "从上一卷最后一个过渡章的具体动作、地点和人物状态起笔；先承接上一卷已经发生的后果，再建立本卷阶段目标，禁止无说明地跳过关键迁移或突然开启无关冲突。"
        : "建立本卷阶段目标、核心关系与局部规则；承接上一卷后果，不重复全书开篇",
    };
  }
  if (volumeProgress <= 0.45) {
    return {
      ...base,
      id: finalVolume ? "escalation" : "expansion",
      label: finalVolume ? "终局升级" : "本卷展开",
      guidance: finalVolume
        ? "让主要支线汇入最终冲突，逐项满足结局前置条件，不再新增大型支线"
        : "扩展本卷人物、场域和次级目标，让当前选择形成可追溯后果",
    };
  }
  if (volumeProgress <= 0.78) {
    return {
      ...base,
      id: "escalation",
      label: finalVolume ? "终局合流" : "本卷升级",
      guidance: finalVolume
        ? "合并主要矛盾与角色弧，把长期代价推至不可回避的位置"
        : "兑现本卷早期伏笔、提高代价并形成阶段转折，同时保留后续卷的成长空间",
    };
  }
  if (!finalVolume) {
    return {
      ...base,
      id: "convergence",
      label: "卷末转折",
      guidance: "收束并完成本卷阶段目标的主要胜负；让高潮结果成为随后三个过渡章需要结算的事实，不提前开启下一卷主冲突",
    };
  }
  return {
    ...base,
    id: "finale",
    label: "终局兑现",
    guidance: "集中回应开篇因果、角色弧和结局契约；停止新增支线，在目标章完成可交付的正式结局",
  };
}
