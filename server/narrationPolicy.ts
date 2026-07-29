import { createHash } from "node:crypto";

export const IMMERSIVE_NARRATION_PROMPT = [
  "小说正文与章名必须始终留在故事世界内部。",
  "不得出现上一章、下一章、本章、第一章、第几章、前一章、后一章、这一章、上一回、下一回、上一节、前一幕、前文、下文、前情回顾、章节、大纲、本书、叙事需要、小说主角、作者、读者、剧情发展、剧情奖励、角色弧、人物弧、终局核验、结局前置条件、必要前置条件、最初灵感、伏笔、契约、体验轴、信号、开篇、本卷、上一卷、全书、正史或未完待续等作者侧规划词。",
  "人物只能记得亲历事件、对话、物件与关系变化，不能知道自己位于小说或某一章中。",
].join("");

const authorFacingProseReplacements: Array<[RegExp, string]> = [
  [/(?:按照|依照|根据)(?:故事|剧情)?大纲/g, "按原定计划"],
  [/(?:预设|既定)?大纲/g, "原定计划"],
  [/(?:作为|身为)(?:这部|这本|一部)?(?:小说|故事)(?:里的|中的|的)?(?:主角|角色)/g, "身在局中的人"],
  [/(?:小说|故事)(?:里的|中的|的)(?:主角|角色)/g, "身在局中的人"],
  [/叙事(?:需要|要求|安排|迫使)/g, "局势迫使"],
  [/上一章/g, "此前"],
  [/下一章/g, "此后"],
  [/前一章/g, "此前"],
  [/后一章/g, "此后"],
  [/这一章/g, "这段经历"],
  [/上一回(?!合|头|身|家|来|去)/g, "此前"],
  [/下一回(?!合|头|身|家|来|去)/g, "此后"],
  [/(?:上一|前一)(?:节|幕|话)(?=(?:剧情|内容|往事|画面|经历|遭遇|发生|留下|的(?:记忆|经历|遭遇|内容|往事|画面|事情|一切)|会|将|中|里|讲述|写下|回顾))/g, "此前"],
  [/(?:下一|后一)(?:节|幕|话)(?=(?:剧情|内容|往事|画面|经历|遭遇|发生|留下|的(?:记忆|经历|遭遇|内容|往事|画面|事情|一切)|会|将|中|里|讲述|写下|回顾))/g, "此后"],
  [/上章(?=(?:发生|留下|的(?:记忆|经历|遭遇)|会|将|中|里|讲述|写下|回顾))/g, "此前"],
  [/前后两章/g, "前后两次经历"],
  [/跨过许多章节/g, "耗费很长时间"],
  [/一部长篇/g, "一段漫长旅程"],
  [/长篇因果/g, "长久因果"],
  [/角色弧/g, "内心转变"],
  [/人物弧/g, "内心转变"],
  [/终局核验/g, "最终结果确认"],
  [/结局前置条件/g, "此前必须完成的事情"],
  [/必要前置条件/g, "此前必须完成的事情"],
  [/最初灵感/g, "最初的念头"],
  [/(?:此前|先前|前面(?:的)?)(?:剧情|情节|故事)(?:里|中|留下的)?/g, "此前亲历的事情"],
  [/(?:这一|那一|前一|下一)段剧情/g, "这段经历"],
  [/(?:前面|此前|先前)(?:的)?桥段/g, "此前亲历的事情"],
  [/上回书说到/g, "此前"],
  [/欲知后事如何[^。！？\n]{0,16}(?:且看|请看)?下回分解/g, "事情仍在当下继续"],
  [/后续故事/g, "往后的道路"],
  [/开篇时/g, "最初"],
  [/开篇空间/g, "最初相遇的地方"],
  [/全书开篇/g, "最初经历"],
  [/开篇/g, "最初"],
  [/上一卷/g, "上一阶段"],
  [/本卷/g, "当前阶段"],
  [/卷首/g, "当前阶段"],
  [/各卷选择/g, "一路作出的选择"],
  [/各卷留下/g, "一路留下"],
  [/数卷积累/g, "多年积累"],
  [/多卷规划/g, "长期积累"],
  [/剧情奖励/g, "胜利的附赠品"],
  [/已经解决的主线/g, "已经解决的长期问题"],
  [/结局之后/g, "尘埃落定以后"],
  [/因此完结不是按章数强制贴上的标签/g, "因此眼前结果不是按期限强行宣布的答案"],
  [/故事停在这个完整的动作上/g, "这个完整的动作给漫长旅程画下句点"],
  [/结局契约/g, "最终承诺"],
  [/正史/g, "既有事实"],
];

const authorFacingNarrationPattern = /上一章|下一章|本章|(?:第\s*(?:\d+|[一二三四五六七八九十百千]+)\s*章)(?:讲述|写下|回顾|中|里|留下|会|将)|(?:前一|后一|这一)章|上一回(?!合|头|身|家|来|去)|下一回(?!合|头|身|家|来|去)|(?:前一|后一|这一)回(?!合|头|身|家|来|去)|(?:上一|下一|前一|后一)(?:节|幕|话)(?=(?:剧情|内容|往事|画面|经历|遭遇|发生|留下|的(?:记忆|经历|遭遇|内容|往事|画面|事情|一切)|会|将|中|里|讲述|写下|回顾))|上章(?=(?:发生|留下|的(?:记忆|经历|遭遇)|会|将|中|里|讲述|写下|回顾))|(?:此前|先前|前面(?:的)?)(?:剧情|情节|故事)[^。！？\n]{0,18}(?:记忆|回忆|留下|浮现|发生)|上回书说到|欲知后事如何[^。！？\n]{0,20}下回分解|前文|下文|前情(?:提要|回顾)|未完待续|前后两章|跨过许多章节|一部长篇|(?:小说|故事|本书)(?:的)?章节|章节(?:安排|规划|大纲|目标|进度|结构|开头|开篇|结尾|收尾|推进|发展)|(?:预设|既定)?大纲|(?<![一二两三四五六七八九十百千万几多每各某这那\d])本书(?:的|中(?:的)?|里(?:的)?)(?=(?:主角|角色|故事|剧情|章节|开篇|结局|叙事|作者|读者))|(?:角色|人物)弧|终局核验|(?:结局|必要)前置条件|最初灵感|后续故事|剧情胶囊|剧情奖励|故事停在(?:这里|此处|这个动作|这个完整的动作上)?|(?:作为|身为)(?:这部|这本|一部)?(?:小说|故事)(?:里的|中的|的)?(?:主角|角色)|(?:小说|故事)(?:里的|中的|的)(?:主角|角色)|(?:这一|本)(?:节|幕)(?:必须|需要|该|就此)[^。！？]{0,10}(?:结束|收尾)|叙事(?:需要|要求|安排|迫使)|剧情(?:发展|推进|走到|来到|至此)|故事(?:发展|推进|走到|来到)(?:这里|此处)?|(?:读|看)到这里|结局契约|正史\s*v?\d*|作者(?:在|把|将|让|安排|写|认为)|(?:作者|读者)(?:知道|看见|安排|期待)|(?:开篇|本卷|上一卷|全书)(?:时|中|阶段|开头|结尾|目标|展开|故事|后果|选择|进度)?/;
const chapterTimeMetaPattern = /(?:前|过去|头)(?:几|两|[一二三四五六七八九十百千\d]+)\s*章(?:留下|发生|写下|讲述|中|里|的事)?|(?:在\s*)?第\s*(?:\d+|[一二三四五六七八九十百千]+)\s*章(?:\s*[，,、：:；;。]|\s*(?:之后|以前|当时|那时))/;
const plotSegmentMetaPattern = /(?:这一|那一|前一|下一)段剧情|(?:前面|此前|先前)(?:的)?桥段/;
const chapterHeadingMetaPattern = /(?:^|\n)\s*第\s*(?:\d+|[一二三四五六七八九十百千]+)\s*章(?:\s+[^\n。！？]{1,30})?(?=\n|$)/;
const chapterOrdinalPrefixPattern = /^\s*第\s*(?:\d+|[一二三四五六七八九十百千]+)\s*章(?:\s*[：:、.．—-]\s*|\s+|$)/;

export type NarrationCandidateLocation = "title" | "body";

export interface NarrationCandidate {
  id: string;
  ruleId: string;
  ruleVersion: string;
  location: NarrationCandidateLocation;
  matchedText: string;
  matchStart: number;
  matchEnd: number;
  sentenceStart: number;
  sentence: string;
  previousSentence?: string;
  nextSentence?: string;
  contentHash: string;
}

interface NarrationCandidateRule {
  id: string;
  version: string;
  pattern: RegExp;
}

interface SentenceSpan {
  start: number;
  end: number;
  text: string;
}

export const NARRATION_CANDIDATE_RULE_VERSION = "narration-candidates-v1";

const narrationCandidateRules: readonly NarrationCandidateRule[] = [
  { id: "author_facing_narration", version: NARRATION_CANDIDATE_RULE_VERSION, pattern: authorFacingNarrationPattern },
  { id: "chapter_time_metadata", version: NARRATION_CANDIDATE_RULE_VERSION, pattern: chapterTimeMetaPattern },
  { id: "plot_segment_metadata", version: NARRATION_CANDIDATE_RULE_VERSION, pattern: plotSegmentMetaPattern },
];

const closingSentencePunctuation = new Set(["”", "’", "」", "』", "】", "》", "）", ")"]);

function appendSentenceSpan(spans: SentenceSpan[], text: string, rawStart: number, rawEnd: number): void {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  if (start < end) spans.push({ start, end, text: text.slice(start, end) });
}

function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let sentenceStart = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\r" || character === "\n") {
      appendSentenceSpan(spans, text, sentenceStart, index);
      index += character === "\r" && text[index + 1] === "\n" ? 2 : 1;
      sentenceStart = index;
      continue;
    }
    const isTerminal = character === "。" || character === "！" || character === "？" || character === "；";
    const isEllipsis = character === "…";
    if (!isTerminal && !isEllipsis) {
      index += 1;
      continue;
    }
    let end = index + 1;
    if (isEllipsis) {
      while (text[end] === "…") end += 1;
    }
    while (end < text.length && closingSentencePunctuation.has(text[end])) end += 1;
    appendSentenceSpan(spans, text, sentenceStart, end);
    sentenceStart = end;
    index = end;
  }
  appendSentenceSpan(spans, text, sentenceStart, text.length);
  return spans;
}

function globalPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
}

export function narrationArtifactHash(title: string, paragraphs: readonly string[]): string {
  const normalized = [title, ...paragraphs].map((value) => value.replace(/\r\n?/g, "\n"));
  return createHash("sha256")
    .update("narration-artifact-v1\u0000" + JSON.stringify(normalized), "utf8")
    .digest("hex");
}

export function detectNarrationCandidates(
  location: NarrationCandidateLocation,
  text: string,
  contentHash: string,
): NarrationCandidate[] {
  const spans = sentenceSpans(text);
  const matches = narrationCandidateRules.flatMap((rule) => {
    const pattern = globalPattern(rule.pattern);
    return [...text.matchAll(pattern)].flatMap((match) => {
      if (match.index === undefined || !match[0]) return [];
      return [{ rule, matchedText: match[0], start: match.index, end: match.index + match[0].length }];
    });
  }).sort((left, right) =>
    left.start - right.start ||
    (right.end - right.start) - (left.end - left.start) ||
    left.rule.id.localeCompare(right.rule.id)
  );

  const seenRanges = new Set<string>();
  const candidates: NarrationCandidate[] = [];
  for (const match of matches) {
    const rangeKey = [match.start, match.end].join(":");
    if (seenRanges.has(rangeKey)) continue;
    seenRanges.add(rangeKey);
    const sentenceIndex = spans.findIndex((span) => match.start >= span.start && match.start < span.end);
    const sentence = sentenceIndex >= 0
      ? spans[sentenceIndex]
      : { start: match.start, end: match.end, text: match.matchedText };
    const digest = createHash("sha256").update([
      match.rule.version,
      match.rule.id,
      location,
      String(match.start),
      String(match.end),
      contentHash,
    ].join("\u001f"), "utf8").digest("hex");
    candidates.push({
      id: "narration_candidate_" + digest.slice(0, 20),
      ruleId: match.rule.id,
      ruleVersion: match.rule.version,
      location,
      matchedText: match.matchedText,
      matchStart: match.start,
      matchEnd: match.end,
      sentenceStart: sentence.start,
      sentence: sentence.text,
      ...(sentenceIndex > 0 ? { previousSentence: spans[sentenceIndex - 1].text } : {}),
      ...(sentenceIndex >= 0 && sentenceIndex + 1 < spans.length ? { nextSentence: spans[sentenceIndex + 1].text } : {}),
      contentHash,
    });
  }
  return candidates;
}

export function normalizeChapterTitle(title: string): string {
  return title.replace(chapterOrdinalPrefixPattern, "").trim();
}

export function immerseAuthorFacingProse(text: string): string {
  return authorFacingProseReplacements.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}

export function assertOpeningNarrationStructure(title: string, body: string): void {
  if (!normalizeChapterTitle(title)) {
    throw new Error("正文模型只返回了章节序号，没有提供有效章名。");
  }
  const match = chapterHeadingMetaPattern.exec(body);
  if (!match || match.index === undefined) return;
  const snippet = match[0].replace(/\s+/g, " ").trim();
  throw new Error(`正文包含内嵌章节标题，已要求重写。命中结构原句：“${snippet}”`);
}

export function assertImmersiveNarration(content: string): void {
  const violation = [
    ["作者侧叙事", authorFacingNarrationPattern],
    ["章节时间元数据", chapterTimeMetaPattern],
    ["剧情分段元数据", plotSegmentMetaPattern],
    ["正文内章节标题", chapterHeadingMetaPattern],
  ].map(([kind, pattern]) => {
    const match = (pattern as RegExp).exec(content);
    if (!match || match.index === undefined) return undefined;
    const start = Math.max(0, match.index - 18);
    const end = Math.min(content.length, match.index + match[0].length + 28);
    return {
      kind: String(kind),
      snippet: content.slice(start, end).replace(/\s+/g, " ").trim(),
    };
  }).find(Boolean);
  if (violation) {
    throw new Error(`正文泄露作者侧章节或剧情元数据，破坏沉浸感，已阻止发布。命中${violation.kind}原句：“${violation.snippet}”`);
  }
}
