export type ReaderTheme = "paper" | "mist" | "night";

export interface ReaderSettings {
  theme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
  width: number;
}

export interface ReaderSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const READER_SETTINGS_STORAGE_KEY = "xumo-reader-settings";
export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  theme: "paper",
  fontSize: 20,
  lineHeight: 1.95,
  width: 720,
};

function browserStorage(): ReaderSettingsStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

export function normalizeReaderSettings(value: unknown): ReaderSettings {
  const candidate = record(value);
  const theme = candidate.theme === "paper" || candidate.theme === "mist" || candidate.theme === "night"
    ? candidate.theme
    : DEFAULT_READER_SETTINGS.theme;
  return {
    theme,
    fontSize: Math.round(boundedNumber(candidate.fontSize, DEFAULT_READER_SETTINGS.fontSize, 16, 26)),
    lineHeight: boundedNumber(candidate.lineHeight, DEFAULT_READER_SETTINGS.lineHeight, 1.6, 2.3),
    width: Math.round(boundedNumber(candidate.width, DEFAULT_READER_SETTINGS.width, 600, 820) / 20) * 20,
  };
}

export function loadReaderSettings(storage: ReaderSettingsStorage | null = browserStorage()): ReaderSettings {
  if (!storage) return { ...DEFAULT_READER_SETTINGS };
  try {
    return normalizeReaderSettings(JSON.parse(storage.getItem(READER_SETTINGS_STORAGE_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_READER_SETTINGS };
  }
}

export function saveReaderSettings(
  settings: ReaderSettings,
  storage: ReaderSettingsStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(READER_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeReaderSettings(settings)));
  } catch {
    // Reading preferences are best-effort and must never make a story unreadable.
  }
}
