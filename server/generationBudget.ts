import type { GenerationJob } from "../src/types";

export const CONTINUATION_JOB_TOKEN_BUDGET = 30_000;
export const OPENING_JOB_TOKEN_BUDGET = 120_000;
export const CHAPTER_EXTRACTION_ADMISSION_RESERVE = 14_000;
const MODEL_CALL_FRAMING_TOKEN_RESERVE = 32;

interface GenerationTokenBudgetInput {
  jobs: GenerationJob[];
  userId: string;
  storyId: string;
  requestedBudget: number;
  defaultRunningBudget: number;
  userLimit: number;
  storyLimit: number;
  now?: number;
}

interface ModelCallTokenBudgetInput {
  remainingTokens: number;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  stage: string;
}

export function estimateModelCallTokenBudget(
  input: Pick<ModelCallTokenBudgetInput, "system" | "prompt" | "maxOutputTokens">,
): number {
  // Routes may point at providers with unknown tokenizers. UTF-8 bytes are a
  // deliberately conservative admission upper bound for byte-fallback BPEs;
  // billing estimates can be looser, but a pre-call hard gate must not be.
  const inputTokens = Buffer.byteLength(`${input.system}${input.prompt}`, "utf8") +
    MODEL_CALL_FRAMING_TOKEN_RESERVE;
  const outputTokens = Number.isFinite(input.maxOutputTokens)
    ? Math.max(0, Math.ceil(input.maxOutputTokens))
    : 0;
  return Math.max(1, inputTokens + outputTokens);
}

export function assertModelCallTokenBudget(input: ModelCallTokenBudgetInput): void {
  const requiredTokens = estimateModelCallTokenBudget(input);
  const remainingTokens = Number.isFinite(input.remainingTokens)
    ? Math.max(0, Math.floor(input.remainingTokens))
    : input.remainingTokens === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : 0;
  if (requiredTokens <= remainingTokens) return;
  throw new Error(
    `剩余 Token ${remainingTokens} 不足以支付${input.stage}调用的完整输入与最大输出预算 ${requiredTokens}，未启动${input.stage}模型。`,
  );
}

export function assertGenerationTokenBudget(input: GenerationTokenBudgetInput): void {
  const cutoff = (input.now ?? Date.now()) - 24 * 60 * 60 * 1_000;
  const recent = input.jobs.filter((job) => Date.parse(job.createdAt) >= cutoff);
  const reserved = (job: GenerationJob) => job.status === "running"
    ? (job.tokenBudget ?? input.defaultRunningBudget)
    : job.tokens;
  const userTokens = recent
    .filter((job) => job.ownerId === input.userId)
    .reduce((total, job) => total + reserved(job), 0);
  const storyTokens = recent
    .filter((job) => job.storyId === input.storyId)
    .reduce((total, job) => total + reserved(job), 0);
  if (
    userTokens + input.requestedBudget > input.userLimit ||
    storyTokens + input.requestedBudget > input.storyLimit
  ) {
    const error = new Error("已达到 24 小时生成预算上限。正史不受影响，请稍后再试。");
    Object.assign(error, { status: 429 });
    throw error;
  }
}
