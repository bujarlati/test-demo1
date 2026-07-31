import type { BootstrapPayload } from "./types";

export interface StoryDeletionShelfReconciliation {
  storyId: string;
  chapterCount: number;
  countedInShelf: boolean;
}

export function reconcileStoryDeletionState(
  current: BootstrapPayload | null,
  input: StoryDeletionShelfReconciliation,
): BootstrapPayload | null {
  if (!current) return current;

  const stories = current.stories.filter((story) => story.id !== input.storyId);
  const pendingJobs = current.pendingJobs.filter((job) => job.storyId !== input.storyId);
  const recoverableJobs = current.recoverableJobs.filter((job) => job.storyId !== input.storyId);
  const activeStoryId = current.activeStoryId === input.storyId ? null : current.activeStoryId;
  const user = current.user.activeStoryId === input.storyId
    ? { ...current.user, activeStoryId: null }
    : current.user;
  const safeChapterCount = Number.isFinite(input.chapterCount)
    ? Math.max(0, Math.floor(input.chapterCount))
    : 0;
  const storyPage = input.countedInShelf
    ? {
        ...current.storyPage,
        totalStories: Math.max(0, current.storyPage.totalStories - 1),
        totalChapters: Math.max(0, current.storyPage.totalChapters - safeChapterCount),
      }
    : current.storyPage;

  return {
    ...current,
    user,
    stories: stories.length === current.stories.length ? current.stories : stories,
    storyPage,
    activeStoryId,
    pendingJobs: pendingJobs.length === current.pendingJobs.length ? current.pendingJobs : pendingJobs,
    recoverableJobs: recoverableJobs.length === current.recoverableJobs.length
      ? current.recoverableJobs
      : recoverableJobs,
  };
}
