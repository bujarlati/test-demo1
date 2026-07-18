import type { ExperienceInterpretationPort, InterpretationDraft } from "../../server/readingExperienceModule/types";

export interface ExperienceFixtureCalls { interpret: number; judge: number; planner: number; writer: number }

export function scriptedExperiencePorts(options: { interpretation?: "ready" | "low_confidence" | "irreconcilable" | "malformed" } = {}) {
  const calls: ExperienceFixtureCalls = { interpret: 0, judge: 0, planner: 0, writer: 0 };
  const interpretationPort: ExperienceInterpretationPort = {
    async interpret(input) {
      calls.interpret += 1;
      const [first, second] = input.intent.descriptors.map((descriptor) => descriptor.text);
      const draft = interpretationDraft(first, second);
      if (options.interpretation === "low_confidence") {
        draft.dimensions[0].confidence = 0.4;
      }
      if (options.interpretation === "irreconcilable") {
        draft.synthesis = { sharedCause: "", dimensionRoles: ["", ""] };
      }
      if (options.interpretation === "malformed") {
        return { dimensions: [{ descriptor: first }] } as unknown as InterpretationDraft;
      }
      return draft;
    },
  };
  return {
    deps: { interpretationPort, now: () => new Date("2026-07-17T00:00:00.000Z") },
    calls,
  };
}

function interpretationDraft(first: string, second: string): InterpretationDraft {
  return {
    dimensions: [dimension(first, "protagonist_action"), dimension(second, "voice")],
    synthesis: {
      sharedCause: "人物为了处理同一处变化而行动，行动结果同时改变故事的关系、节奏和外部处境。",
      dimensionRoles: ["推动人物作出可观察选择", "让叙述呈现不同的感受层次"],
    },
    provenanceVersion: "fixture-v1",
  };
}

function dimension(descriptor: string, kind: "protagonist_action" | "voice"): InterpretationDraft["dimensions"][number] {
  const distribution = kind === "voice";
  return {
    descriptor,
    interpretation: `“${descriptor}”通过人物选择、场景结果和叙述组织形成可观察的阅读体验。`,
    categories: [kind],
    observableSignals: [
      {
        description: "人物在具体压力下作出改变局势的选择，并留下可验证的结果。",
        kind,
        verification: distribution
          ? { kind: "distribution", metricIds: ["paragraph_consistency", "scene_coverage"], minimumAnchors: 3, requireSemanticJudge: true, requiredRegions: ["opening", "middle", "ending"], regionSemantics: "paragraph", metricThresholds: { paragraph_consistency: 0.3, scene_coverage: 1 } }
          : { kind: "event_slots", requiredSlots: ["actor", "action", "outcome"], minimumAnchors: 2 },
        persistence: "chapter",
      },
      {
        description: "选择引发他人或环境的可见反应，使新的处境延续到后续事件。",
        kind,
        verification: distribution
          ? { kind: "distribution", metricIds: ["paragraph_consistency", "scene_coverage"], minimumAnchors: 3, requireSemanticJudge: true, requiredRegions: ["opening", "middle", "ending"], regionSemantics: "paragraph", metricThresholds: { paragraph_consistency: 0.3, scene_coverage: 1 } }
          : { kind: "event_slots", requiredSlots: ["actor", "action", "reaction"], minimumAnchors: 2 },
        persistence: "cross_chapter",
      },
    ],
    prohibitions: [{ kind: "shortcut", description: "不得用旁白标签替代已经发生的行动和结果。", severity: "rewrite" }],
    confidence: 0.85,
  };
}
