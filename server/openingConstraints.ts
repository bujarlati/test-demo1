export const OPENING_CHAPTER_MIN_CHARACTERS = 1_800;
export const OPENING_CHAPTER_MAX_CHARACTERS = 6_000;

export function openingChapterCharacterCount(content: string): number {
  return content.replace(/\s/g, "").length;
}

export function openingChapterLengthIsAllowed(content: string): boolean {
  const characterCount = openingChapterCharacterCount(content);
  return characterCount >= OPENING_CHAPTER_MIN_CHARACTERS &&
    characterCount <= OPENING_CHAPTER_MAX_CHARACTERS;
}
