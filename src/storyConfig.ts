import type { CoverTheme } from "./types";

export interface StoryGenreOption {
  label: string;
  note: string;
  previewTitle: string;
  coverTheme: CoverTheme;
  templateKey: "悬疑" | "科幻" | "奇幻" | "治愈";
}

export interface StoryLengthOption {
  id: string;
  label: string;
  name: string;
  chapterCount: number;
  note: string;
}

export type ChapterLengthMode = "compact" | "standard" | "immersive";

export interface ChapterLengthPreset {
  name: string;
  note: string;
  targetCharacters: number;
  minCharacters: number;
  maxCharacters: number;
  targetParagraphs: number;
}

export const STORY_GENRES = [
  { label: "玄幻", note: "血脉、宗门与逆命", previewTitle: "万象碑", coverTheme: "ember", templateKey: "奇幻" },
  { label: "仙侠", note: "问道、因果与飞升", previewTitle: "山门无月", coverTheme: "fog", templateKey: "奇幻" },
  { label: "武侠", note: "江湖、恩义与绝学", previewTitle: "旧剑照夜", coverTheme: "forest", templateKey: "奇幻" },
  { label: "都市", note: "现实、机遇与人心", previewTitle: "长街未眠", coverTheme: "tide", templateKey: "治愈" },
  { label: "都市异能", note: "现代秩序与超常能力", previewTitle: "霓虹之外", coverTheme: "moon", templateKey: "科幻" },
  { label: "言情", note: "相遇、选择与成长", previewTitle: "等风说完", coverTheme: "ember", templateKey: "治愈" },
  { label: "校园", note: "青春、友情与秘密", previewTitle: "晚自习以后", coverTheme: "forest", templateKey: "治愈" },
  { label: "职场", note: "专业、博弈与理想", previewTitle: "十二层灯火", coverTheme: "tide", templateKey: "悬疑" },
  { label: "悬疑", note: "秘密、证词与因果", previewTitle: "潮汐背面", coverTheme: "tide", templateKey: "悬疑" },
  { label: "科幻", note: "未来、技术与选择", previewTitle: "第七次日落", coverTheme: "moon", templateKey: "科幻" },
  { label: "奇幻", note: "异世界、规则与代价", previewTitle: "灯塔之外", coverTheme: "fog", templateKey: "奇幻" },
  { label: "历史", note: "时代、庙堂与众生", previewTitle: "长安无名帖", coverTheme: "ember", templateKey: "悬疑" },
  { label: "军事", note: "战场、谋略与袍泽", previewTitle: "烽线以北", coverTheme: "forest", templateKey: "悬疑" },
  { label: "末世", note: "灾变、生存与重建", previewTitle: "最后一座灯塔", coverTheme: "fog", templateKey: "科幻" },
  { label: "游戏", note: "副本、竞技与公会", previewTitle: "世界首杀", coverTheme: "moon", templateKey: "科幻" },
  { label: "体育", note: "赛场、团队与冠军", previewTitle: "终场哨响前", coverTheme: "forest", templateKey: "治愈" },
  { label: "无限流", note: "副本、规则与破局", previewTitle: "第零号房间", coverTheme: "tide", templateKey: "悬疑" },
  { label: "系统流", note: "任务、奖励与反制", previewTitle: "系统拒绝结算", coverTheme: "moon", templateKey: "科幻" },
  { label: "宫斗宅斗", note: "门第、权谋与自救", previewTitle: "深院见春", coverTheme: "ember", templateKey: "悬疑" },
  { label: "轻小说", note: "日常、冒险与羁绊", previewTitle: "放学后异世界", coverTheme: "fog", templateKey: "奇幻" },
  { label: "治愈", note: "日常、陪伴与新生", previewTitle: "风从面包房来", coverTheme: "ember", templateKey: "治愈" },
] as const satisfies readonly StoryGenreOption[];

export type StoryGenre = (typeof STORY_GENRES)[number]["label"];

export const STORY_LENGTH_OPTIONS = [
  { id: "starter", label: "新锐连载 · 预计 80 章", name: "新锐连载", chapterCount: 80, note: "约 1 部完整故事" },
  { id: "standard", label: "标准长篇 · 预计 200 章", name: "标准长篇", chapterCount: 200, note: "适合稳定追更" },
  { id: "epic", label: "大长篇 · 预计 500 章", name: "大长篇", chapterCount: 500, note: "多阶段世界线" },
  { id: "marathon", label: "超长连载 · 预计 1000 章", name: "超长连载", chapterCount: 1000, note: "长期成长与群像" },
] as const satisfies readonly StoryLengthOption[];

export type StoryLengthPlanId = (typeof STORY_LENGTH_OPTIONS)[number]["id"];

export const DEFAULT_STORY_LENGTH = STORY_LENGTH_OPTIONS[1];

export const CHAPTER_LENGTH_PRESETS: Record<ChapterLengthMode, ChapterLengthPreset> = {
  compact: { name: "轻快", note: "约 2000 字", targetCharacters: 2_000, minCharacters: 1_700, maxCharacters: 2_500, targetParagraphs: 12 },
  standard: { name: "标准", note: "约 2800 字", targetCharacters: 2_800, minCharacters: 2_400, maxCharacters: 3_400, targetParagraphs: 16 },
  immersive: { name: "沉浸", note: "约 3800 字", targetCharacters: 3_800, minCharacters: 3_300, maxCharacters: 4_600, targetParagraphs: 22 },
};

export function getGenreOption(label: StoryGenre): (typeof STORY_GENRES)[number] {
  return STORY_GENRES.find((option) => option.label === label) ?? STORY_GENRES.find((option) => option.label === "悬疑")!;
}

export function getStoryLengthOption(id: StoryLengthPlanId | undefined): (typeof STORY_LENGTH_OPTIONS)[number] {
  return STORY_LENGTH_OPTIONS.find((option) => option.id === id) ?? DEFAULT_STORY_LENGTH;
}
