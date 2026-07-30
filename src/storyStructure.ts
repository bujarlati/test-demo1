export const VOLUME_TRANSITION_CHAPTER_COUNT = 3;

export interface StoryChapterPosition {
  chapterNumber: number;
  progress: number;
  volumeNumber: number;
  totalVolumes: number;
  chapterInVolume: number;
  volumeChapterCount: number;
  volumeProgress: number;
  finalVolume: boolean;
  transitionStep?: number;
}

export interface StoryChapterSection<TChapter> {
  key: string;
  kind: "volume" | "transition";
  label: string;
  volumeNumber: number;
  nextVolumeNumber?: number;
  chapters: TChapter[];
}

function positiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

export function plannedVolumeChapterCount(targetChapterCount: number): number {
  const safeTarget = positiveInteger(targetChapterCount);
  if (safeTarget <= 80) return 20;
  if (safeTarget <= 200) return 25;
  return 50;
}

export function storyChapterPosition(
  chapterNumber: number,
  targetChapterCount: number,
): StoryChapterPosition {
  const safeTarget = positiveInteger(targetChapterCount);
  const plannedVolumeSize = plannedVolumeChapterCount(safeTarget);
  const totalVolumes = Math.ceil(safeTarget / plannedVolumeSize);
  const safeChapterNumber = Math.min(safeTarget, positiveInteger(chapterNumber));
  const volumeNumber = Math.min(totalVolumes, Math.ceil(safeChapterNumber / plannedVolumeSize));
  const volumeStart = (volumeNumber - 1) * plannedVolumeSize + 1;
  const volumeEnd = Math.min(safeTarget, volumeNumber * plannedVolumeSize);
  const chapterInVolume = safeChapterNumber - volumeStart + 1;
  const volumeChapterCount = volumeEnd - volumeStart + 1;
  const finalVolume = volumeNumber === totalVolumes;
  const transitionStep = !finalVolume && chapterInVolume > volumeChapterCount - VOLUME_TRANSITION_CHAPTER_COUNT
    ? chapterInVolume - (volumeChapterCount - VOLUME_TRANSITION_CHAPTER_COUNT)
    : undefined;

  return {
    chapterNumber: safeChapterNumber,
    progress: Math.min(1, Math.max(0, safeChapterNumber / safeTarget)),
    volumeNumber,
    totalVolumes,
    chapterInVolume,
    volumeChapterCount,
    volumeProgress: chapterInVolume / volumeChapterCount,
    finalVolume,
    transitionStep,
  };
}

function chineseVolumeNumber(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;
  if (value <= 0 || value >= 100 || !Number.isInteger(value)) return String(value);
  if (value < 10) return digits[value];
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${tens === 1 ? "" : digits[tens]}十${ones === 0 ? "" : digits[ones]}`;
}

function volumeLabel(volumeNumber: number): string {
  return `第${chineseVolumeNumber(volumeNumber)}卷`;
}

export function buildStoryChapterSections<TChapter extends { number: number }>(
  chapters: readonly TChapter[],
  targetChapterCount: number,
): StoryChapterSection<TChapter>[] {
  const sections: StoryChapterSection<TChapter>[] = [];

  for (const chapter of chapters) {
    const position = storyChapterPosition(chapter.number, targetChapterCount);
    const transition = position.transitionStep !== undefined;
    const key = transition ? `transition-${position.volumeNumber}` : `volume-${position.volumeNumber}`;
    let section = sections.at(-1);

    if (section?.key !== key) {
      section = transition
        ? {
            key,
            kind: "transition",
            label: `卷间过渡 · ${volumeLabel(position.volumeNumber)} → ${volumeLabel(position.volumeNumber + 1)}`,
            volumeNumber: position.volumeNumber,
            nextVolumeNumber: position.volumeNumber + 1,
            chapters: [],
          }
        : {
            key,
            kind: "volume",
            label: volumeLabel(position.volumeNumber),
            volumeNumber: position.volumeNumber,
            chapters: [],
          };
      sections.push(section);
    }

    section.chapters.push(chapter);
  }

  return sections;
}
