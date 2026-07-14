import type { Chapter } from "./types";

export function currentRevision(chapter: Chapter) {
  return (
    chapter.revisions.find((revision) => revision.id === chapter.currentRevisionId) ??
    chapter.revisions.at(-1)
  );
}
