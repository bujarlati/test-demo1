export const OPENING_CHAPTER_MIN_CHARACTERS = 1_800;
export const OPENING_CHAPTER_TARGET_CHARACTERS = 2_800;

export function openingChapterCharacterCount(content: string): number {
  return content.replace(/\s/g, "").length;
}

export function openingChapterLengthIsAllowed(content: string): boolean {
  const characterCount = openingChapterCharacterCount(content);
  return characterCount >= OPENING_CHAPTER_MIN_CHARACTERS;
}
