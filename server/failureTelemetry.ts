import { createHash, randomUUID } from "node:crypto";
import type {
  AppStore,
  GenerationFailureCategory,
  GenerationFailureObservation,
  GenerationFailureSummaryBucket,
  GenerationJob,
} from "../src/types";

const MAX_RUNTIME_FAILURE_OBSERVATIONS = 2_000;
const MAX_FAILURE_MESSAGE_LENGTH = 800;
export const FAILURE_CLASSIFIER_VERSION = "generation-failure-v2";

interface FailureClassification {
  category: GenerationFailureCategory;
  reasonCode: string;
  retryable: boolean;
}

export interface FailureObservationOptions {
  stage: string;
  attempt?: number;
  terminal: boolean;
  latencyMs?: number;
  tokens?: number;
  now?: () => Date;
  id?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "未知生成错误");
}

export function classifyGenerationFailure(error: unknown): FailureClassification {
  const message = errorMessage(error);
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (code === "chapter_editorial_revision_required") {
    const firstIssue = (error as Error & {
      editorialIssues?: Array<{ code?: unknown }>;
    }).editorialIssues?.[0];
    const editorialCode = typeof firstIssue?.code === "string" ? firstIssue.code : "";
    const knownEditorialCodes = new Set([
      "missing_experience_signal",
      "weak_experience_signal",
      "unsupported_experience_claim",
      "missing_required_outcome",
      "chapter_too_short",
      "explicit_protagonist_defeat",
    ]);
    return {
      category: "quality",
      reasonCode: knownEditorialCodes.has(editorialCode) ? editorialCode : code,
      retryable: true,
    };
  }

  if (code === "continuation_tier_persistence_failed") {
    return { category: "persistence", reasonCode: code, retryable: true };
  }
  if (code === "narration_rewrite_exhausted") {
    return { category: "quality", reasonCode: code, retryable: true };
  }
  if (code === "narration_review_state_unavailable") {
    return { category: "persistence", reasonCode: code, retryable: true };
  }
  if (code === "narration_review_checkpoint_invalid") {
    return { category: "quality", reasonCode: code, retryable: true };
  }
  if (code === "narration_review_payload_expired") {
    return { category: "interrupted", reasonCode: code, retryable: true };
  }
  if (/服务重启|进程重启|生成中断/.test(message)) {
    return { category: "interrupted", reasonCode: "service_restart", retryable: true };
  }
  if (/正文泄露作者侧|章节或剧情元数据|元叙事/.test(message)) {
    return { category: "quality", reasonCode: "narration_metadata", retryable: true };
  }
  if (/(?:正文|章节)(?:字数|长度)|段落数|16—20|完整段落|长度.+(?:要求|范围)|偏离目标.+段/.test(message)) {
    return { category: "quality", reasonCode: "chapter_length", retryable: true };
  }
  if (/所有剧情候选均违反硬正史|硬正史.+(?:冲突|违反)|结构化状态转换/.test(message)) {
    return { category: "quality", reasonCode: "canon_conflict", retryable: true };
  }
  if (/知识依赖审计|knowledgeClaim/.test(message)) {
    return { category: "quality", reasonCode: "candidate_knowledge_audit", retryable: true };
  }
  if (/规划模型未返回至少|剧情候选.+(?:不足|无效)|候选.+缺少完整/.test(message)) {
    return { category: "quality", reasonCode: "candidate_plan_invalid", retryable: true };
  }
  if (/正文证据不是有效原文引用|证据.+不是有效原文/.test(message)) {
    return { category: "quality", reasonCode: "experience_quote_invalid", retryable: true };
  }
  if (/证据原句没有实际兑现|必须同时命中模型细化信号|模型信号必须给出/.test(message)) {
    return { category: "quality", reasonCode: "experience_signal_unrealized", retryable: true };
  }
  if (/审稿模型没有返回两个体验轴|两个体验轴的有效证据/.test(message)) {
    return { category: "quality", reasonCode: "review_evidence_invalid", retryable: true };
  }
  if (/没有出现归属于主角且真实可操作的系统交互|前\s*15%\s*没有兑现真实系统交互/.test(message)) {
    return { category: "quality", reasonCode: "system_interaction_missing", retryable: true };
  }
  if (/系统实际发放可持续奖励|系统.+(?:奖励|能力|权限).+(?:领取|调用|使用)/.test(message)) {
    return { category: "quality", reasonCode: "system_reward_missing", retryable: true };
  }
  if (/违反“系统”体验的稳定结算|系统.+持续可用硬承诺/.test(message)) {
    return { category: "quality", reasonCode: "system_invariant_broken", retryable: true };
  }
  if (/压倒性胜利后没有.+即时实际反应|胜利.+没有.+(?:旁观者|势力|资源|身份|秩序)/.test(message)) {
    return { category: "quality", reasonCode: "invincible_world_reaction_missing", retryable: true };
  }
  if (/没有兑现由主角完成的“无敌”压倒性胜利|通过落败、救场、封印或削弱破坏“无敌”/.test(message)) {
    return { category: "quality", reasonCode: "invincible_victory_missing", retryable: true };
  }
  if (/第二章没有沿用第一章已经获得/.test(message)) {
    return { category: "quality", reasonCode: "continuity_state_missing", retryable: true };
  }
  if (/没有返回可由第二章继续使用的正文状态事实|持久状态事实/.test(message)) {
    return { category: "quality", reasonCode: "persistent_state_missing", retryable: true };
  }
  if (/阅读体验|体验证据|沉浸感|质量门禁|没有实际兑现|持久事实|persistentFacts|模型信号|体验的稳定结算|无敌.+(?:胜利|体验)|系统.+(?:交互|奖励|能力|权限|硬承诺)|正文(?:没有兑现|通过.+破坏)|第二章没有沿用/i.test(message)) {
    return { category: "quality", reasonCode: "experience_quality_gate", retryable: true };
  }
  if (/Schema|缺少字段|字段.+(?:缺失|必须)|paragraphs|title 必须/i.test(message)) {
    return { category: "json", reasonCode: "model_json_schema_invalid", retryable: true };
  }
  if (/JSON.+(?:解析|语法|不可修复|不可解析|可解析)|输出不是可修复的 JSON|没有返回可用内容/i.test(message)) {
    return { category: "json", reasonCode: "model_json_invalid", retryable: true };
  }
  if (/超时|总时限|ETIMEDOUT|BODY_TIMEOUT|HEADERS_TIMEOUT|CONNECT_TIMEOUT/i.test(message)) {
    return { category: "timeout", reasonCode: "model_timeout", retryable: true };
  }
  if (/24\s*小时生成预算上限|daily token budget/i.test(message)) {
    return { category: "budget", reasonCode: "daily_token_budget_limit", retryable: true };
  }
  if (/\b(?:429|503)\b|过载|繁忙|too busy|rate.?limit|quota/i.test(message)) {
    return { category: "provider", reasonCode: "provider_overloaded", retryable: true };
  }
  if (/\b(?:401|403)\b|authentication|unauthori[sz]ed|api.?key|鉴权|认证失败/i.test(message)) {
    return { category: "provider", reasonCode: "provider_authentication", retryable: false };
  }
  if (/ECONN|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|socket|network|fetch failed|模型连接|连接失败|连接被重置|aborted|流式响应无效/i.test(message)) {
    return { category: "transport", reasonCode: "model_transport", retryable: true };
  }
  if (/token.+(?:预算|上限|不足)|(?:预算|上限|不足).+token|令牌预算|剩余预算|调用预算/i.test(message)) {
    return { category: "budget", reasonCode: "token_budget_exhausted", retryable: false };
  }
  if (/安全策略|内容策略|违规内容|触发安全|safety.?gate/i.test(message)) {
    return { category: "safety", reasonCode: "safety_gate", retryable: false };
  }
  if (/数据库|PostgreSQL|持久化|存储失败|保存失败|read-only file system/i.test(message)) {
    return { category: "persistence", reasonCode: "persistence_failure", retryable: true };
  }
  if (/\b5\d\d\b|provider|模型服务/i.test(message)) {
    return { category: "provider", reasonCode: "provider_error", retryable: true };
  }
  return { category: "unknown", reasonCode: "unclassified", retryable: false };
}

export function sanitizeGenerationFailureMessage(error: unknown): string {
  return errorMessage(error)
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/https?:\/\/[^\s，。；]+/gi, "[REDACTED_URL]")
    .replace(/(?:命中[^：“\n]{0,24}原句|原句)[：:]?\s*[“"][^”"\n]{1,1000}[”"]/g, "命中原句：[REDACTED_CONTENT]")
    .replace(/\buser_[a-z0-9_-]+\b/gi, "user_[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function failureFingerprint(reasonCode: string, message: string): string {
  const template = message
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[UUID]")
    .replace(/\b(?:job|story|conn|user)_[a-z0-9_-]+\b/gi, "[ID]")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .toLowerCase();
  return createHash("sha256").update(`${reasonCode}\n${template}`, "utf8").digest("hex");
}

export function createGenerationFailureObservation(
  job: GenerationJob,
  error: unknown,
  options: FailureObservationOptions,
): GenerationFailureObservation {
  const classification = classifyGenerationFailure(error);
  const message = sanitizeGenerationFailureMessage(error);
  return {
    id: options.id ?? `failure_${randomUUID().slice(0, 12)}`,
    jobId: job.id,
    ownerId: job.ownerId,
    storyId: job.storyId,
    task: job.task,
    stage: options.stage.trim().slice(0, 80) || "unknown",
    classifierVersion: FAILURE_CLASSIFIER_VERSION,
    category: classification.category,
    reasonCode: classification.reasonCode,
    message,
    fingerprint: failureFingerprint(classification.reasonCode, message),
    model: job.model,
    connectionId: job.connectionId,
    promptVersion: job.promptVersion,
    attempt: Math.max(1, Math.round(options.attempt ?? 1)),
    terminal: options.terminal,
    retryable: classification.retryable,
    latencyMs: Math.max(0, Math.round(options.latencyMs ?? job.latencyMs ?? 0)),
    tokens: Math.max(0, Math.round(options.tokens ?? job.tokens ?? 0)),
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

export function upgradeGenerationFailureObservation(
  observation: GenerationFailureObservation | (Omit<GenerationFailureObservation, "classifierVersion"> & { classifierVersion?: string }),
): GenerationFailureObservation {
  if (observation.classifierVersion === FAILURE_CLASSIFIER_VERSION) return observation as GenerationFailureObservation;
  const classification = classifyGenerationFailure(observation.message);
  const message = sanitizeGenerationFailureMessage(observation.message);
  return {
    ...observation,
    classifierVersion: FAILURE_CLASSIFIER_VERSION,
    category: classification.category,
    reasonCode: classification.reasonCode,
    retryable: classification.retryable,
    message,
    fingerprint: failureFingerprint(classification.reasonCode, message),
  };
}

export function appendGenerationFailure(
  store: AppStore,
  observation: GenerationFailureObservation,
): void {
  store.generationFailures.unshift(observation);
  store.generationFailures = store.generationFailures.slice(0, MAX_RUNTIME_FAILURE_OBSERVATIONS);
}

export function summarizeGenerationFailures(
  observations: GenerationFailureObservation[],
  jobs: GenerationJob[],
): GenerationFailureSummaryBucket[] {
  const jobStatuses = new Map(jobs.map((job) => [job.id, job.status]));
  const buckets = new Map<string, {
    summary: GenerationFailureSummaryBucket;
    jobs: Set<string>;
    recovered: Set<string>;
  }>();
  for (const observation of observations) {
    const key = [observation.category, observation.reasonCode, observation.stage, observation.model].join("|");
    const bucket = buckets.get(key) ?? {
      summary: {
        key,
        category: observation.category,
        reasonCode: observation.reasonCode,
        stage: observation.stage,
        model: observation.model,
        occurrences: 0,
        affectedJobs: 0,
        terminalFailures: 0,
        recoveredJobs: 0,
        lastSeenAt: observation.createdAt,
      },
      jobs: new Set<string>(),
      recovered: new Set<string>(),
    };
    bucket.summary.occurrences += 1;
    if (observation.terminal) bucket.summary.terminalFailures += 1;
    if (observation.createdAt > bucket.summary.lastSeenAt) bucket.summary.lastSeenAt = observation.createdAt;
    bucket.jobs.add(observation.jobId);
    if (jobStatuses.get(observation.jobId) === "completed") bucket.recovered.add(observation.jobId);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map(({ summary, jobs: affectedJobs, recovered }) => ({
      ...summary,
      affectedJobs: affectedJobs.size,
      recoveredJobs: recovered.size,
    }))
    .sort((left, right) => right.occurrences - left.occurrences || right.lastSeenAt.localeCompare(left.lastSeenAt));
}
