import { createHash, randomUUID } from "node:crypto";
import type { AppStore, ContentReport, SafetyDecision, SafetySurface } from "../src/types";

const safetyRules = [
  { category: "sexual_minors", pattern: /(?:未成年|儿童|小学生|幼童).{0,18}(?:色情|性行为|裸照|性描写)/i },
  { category: "self_harm_encouragement", pattern: /(?:教我|指导|步骤|方法).{0,18}(?:自杀|自残|结束生命)/i },
  { category: "targeted_hate", pattern: /(?:杀光|清除|灭绝).{0,12}(?:族|人种|民族|宗教|同性恋|残疾人)/i },
  { category: "personal_data_abuse", pattern: /(?:开盒|人肉搜索|泄露住址|公布身份证)/i },
];

export function safetyCategories(text: string) {
  return safetyRules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.category);
}

export function recordSafetyDecision(
  store: AppStore,
  actorUserId: string,
  surface: SafetySurface,
  text: string,
  storyId?: string,
): SafetyDecision {
  const categories = safetyCategories(text);
  const decision: SafetyDecision = {
    id: `safety_${randomUUID().slice(0, 10)}`,
    actorUserId,
    storyId,
    surface,
    decision: categories.length ? "blocked" : "allowed",
    categories,
    contentHash: createHash("sha256").update(text).digest("hex"),
    createdAt: new Date().toISOString(),
  };
  store.safetyDecisions.unshift(decision);
  store.safetyDecisions = store.safetyDecisions.slice(0, 1_000);
  if (decision.decision === "blocked") {
    const report: ContentReport = {
      id: `report_${randomUUID().slice(0, 10)}`,
      reporterUserId: actorUserId,
      storyId,
      safetyDecisionId: decision.id,
      reason: `自动安全阻断复核：${categories.join(", ")}`,
      status: "submitted",
      createdAt: decision.createdAt,
      updatedAt: decision.createdAt,
    };
    store.contentReports.unshift(report);
  }
  return decision;
}

export function assertSafetyAllowed(decision: SafetyDecision) {
  if (decision.decision === "allowed") return;
  const error = new Error("内容触发安全策略，未写入故事。你可以修改表达，或通过举报/申诉流程请求复核。");
  Object.assign(error, { status: 422, safetyDecisionId: decision.id });
  throw error;
}
