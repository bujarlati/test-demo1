import type { GenerationJob } from "./types";

export interface RecoveryNotice {
  kind: "opening" | "chapter";
  to: string;
  title: string;
  detail: string;
}

export function recoveryNoticeForJob(
  job: GenerationJob,
  availableStoryIds: ReadonlySet<string>,
): RecoveryNotice | null {
  if (job.status !== "failed" || !job.filterSummary?.includes("可以安全重试")) return null;
  if (job.task === "opening") {
    return {
      kind: "opening",
      to: "/new",
      title: "上次开书被中断",
      detail: "可以重新尝试创建第一章",
    };
  }
  if (job.task !== "chapter" || !availableStoryIds.has(job.storyId)) return null;
  return {
    kind: "chapter",
    to: `/story/${job.storyId}`,
    title: "上次续写被中断",
    detail: `${job.storyTitle} · 可安全重试`,
  };
}

function recoveryScope(job: GenerationJob): string | null {
  if (job.task === "opening") return "opening";
  if (job.task === "chapter") return `chapter:${job.storyId}`;
  return null;
}

export function recoverableGenerationJobs(
  newestFirstJobs: readonly GenerationJob[],
  availableStoryIds: ReadonlySet<string>,
): GenerationJob[] {
  const seenScopes = new Set<string>();
  const recoverable: GenerationJob[] = [];
  for (const job of newestFirstJobs) {
    const scope = recoveryScope(job);
    if (!scope || seenScopes.has(scope)) continue;
    seenScopes.add(scope);
    if (recoveryNoticeForJob(job, availableStoryIds)) recoverable.push(job);
  }
  return recoverable;
}
