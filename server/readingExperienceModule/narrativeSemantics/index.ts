import type { ExperienceCategory } from "../../../src/types";
import type { GenericRuleAdapterId } from "../types";

/**
 * Stable input to the deterministic narrative-semantics gate.  Callers provide
 * trusted slot values and evidence spans; tokenisation, scope and event binding
 * deliberately remain private to this module.
 */
export type RealizationSlot = "actor" | "action" | "object" | "feedback" | "outcome" | "reaction" | "reciprocalAction" | "relationshipChange" | "counterpart" | "opponent";

export interface RealizationBinding {
  actor?: string;
  action?: string;
  object?: string;
  feedback?: string;
  outcome?: string;
  reaction?: string;
  reciprocalAction?: string;
  relationshipChange?: string;
  counterpart?: string;
  opponent?: string;
  requiredSlots?: ReadonlyArray<RealizationSlot>;
}

export interface SourceSpan { start: number; end: number }

export interface NarrativeRealizationInput {
  source: string;
  binding: RealizationBinding;
  category?: ExperienceCategory;
  focus?: readonly SourceSpan[];
  slotEvidence?: Partial<Record<RealizationSlot, readonly SourceSpan[]>>;
  actorAliases?: readonly string[];
  counterpartAliases?: readonly string[];
  opponentAliases?: readonly string[];
}

export interface NarrativeInvariantContext {
  protagonistAliases?: readonly string[];
  assertionMode?: "narrative" | "blueprint";
}
export type NarrativeInvariantId = Extract<GenericRuleAdapterId, "curated-mechanic-unavailable" | "curated-outcome-weakened">;

type NarrativeFailureReason = "missing_binding" | "missing_mention" | "foreign_subject" | "indirect_object" | "nonactual" | "negated" | "disconnected_effect" | "ambiguous";
export type NarrativeRealizationResult =
  | { status: "realized"; witnesses: Partial<Record<RealizationSlot, SourceSpan>> }
  | { status: "not_realized"; reason: NarrativeFailureReason };

interface TextRange extends SourceSpan { text: string }
interface Occurrence extends SourceSpan { text: string }
interface SubjectResolution { kind: "expected" | "foreign" | "ambiguous"; text?: string }

const englishToken = /[A-Za-z][A-Za-z0-9]*(?:[’'-][A-Za-z0-9]+)*/gu;
const sentenceBoundary = /[.!?;。！？；\n]/gu;
const irregularGroups: ReadonlyArray<ReadonlyArray<string>> = [
  ["be", "am", "is", "are", "was", "were", "been", "being"],
  ["begin", "began", "begun"], ["break", "broke", "broken"], ["bring", "brought"],
  ["bind", "bound"], ["build", "built"],
  ["buy", "bought"], ["carry", "carried", "carries", "carrying"], ["catch", "caught"],
  ["choose", "chose", "chosen"], ["come", "came"], ["cut"], ["do", "did", "done", "does"],
  ["dig", "dug"], ["draw", "drew", "drawn"], ["drink", "drank", "drunk"], ["drive", "drove", "driven"],
  ["eat", "ate", "eaten"], ["fall", "fell", "fallen"], ["feel", "felt"], ["fight", "fought"],
  ["find", "found"], ["fly", "flew", "flown"], ["forget", "forgot", "forgotten"], ["freeze", "froze", "frozen"],
  ["get", "got", "gotten"], ["give", "gave", "given"], ["go", "went", "gone"], ["grow", "grew", "grown"],
  ["have", "had", "has"], ["hear", "heard"], ["hide", "hid", "hidden"], ["hold", "held"], ["keep", "kept"],
  ["know", "knew", "known"], ["lead", "led"], ["leave", "left"], ["lose", "lost"],
  ["make", "made"], ["meet", "met"], ["pay", "paid"], ["read"], ["ride", "rode", "ridden"],
  ["run", "ran"], ["say", "said", "says"], ["see", "saw", "seen"], ["sell", "sold"], ["send", "sent"],
  ["shake", "shook", "shaken"], ["shoot", "shot"], ["show", "showed", "shown"],
  ["sing", "sang", "sung"], ["sit", "sat"], ["sleep", "slept"], ["slay", "slew", "slain"],
  ["speak", "spoke", "spoken"], ["stand", "stood"], ["steal", "stole", "stolen"],
  ["strike", "struck", "stricken"], ["swim", "swam", "swum"], ["take", "took", "taken"],
  ["teach", "taught"], ["tear", "tore", "torn"], ["tell", "told"], ["think", "thought"],
  ["throw", "threw", "thrown"], ["understand", "understood"], ["wake", "woke", "woken"],
  ["wear", "wore", "worn"], ["win", "won", "winning"], ["write", "wrote", "written"],
];
const irregularLemma = new Map<string, string>(irregularGroups.flatMap((group) => group.map((word) => [word, group[0]!] as const)));

function wordLemmas(value: string): Set<string> {
  const word = value.normalize("NFKC").toLocaleLowerCase();
  const lemmas = new Set<string>([word, irregularLemma.get(word) ?? word]);
  if (word.endsWith("ies") && word.length > 3) lemmas.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ied") && word.length > 3) lemmas.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ing") && word.length > 4) {
    const base = word.slice(0, -3); lemmas.add(base); lemmas.add(`${base}e`);
    if (base.length > 2 && base.at(-1) === base.at(-2)) lemmas.add(base.slice(0, -1));
  }
  if (word.endsWith("ed") && word.length > 3) {
    const base = word.slice(0, -2); lemmas.add(base); lemmas.add(`${base}e`);
    // Do not invent an extra regular past tense for an irregular homograph:
    // "singed" is the past of "singe", not another form of "sing".
    if (irregularGroups.some((group) => group[0] === base && !group.includes(word))) lemmas.delete(base);
    if (base.length > 2 && base.at(-1) === base.at(-2)) lemmas.add(base.slice(0, -1));
  }
  if (word.endsWith("es") && word.length > 3) { lemmas.add(word.slice(0, -2)); lemmas.add(word.slice(0, -1)); }
  if (word.endsWith("s") && word.length > 2 && !word.endsWith("ss")) lemmas.add(word.slice(0, -1));
  // Only an observed irregular surface receives its irregular lemma.  A stem
  // produced by a regular rule must not be remapped a second time: otherwise
  // "founded" -> "found" -> "find" and unrelated verbs become identical.
  return lemmas;
}

function wordsEquivalent(left: string, right: string): boolean {
  const rightLemmas = wordLemmas(right);
  return [...wordLemmas(left)].some((lemma) => rightLemmas.has(lemma));
}

function termOccurrences(source: string, term: string): Occurrence[] {
  const expected = term.normalize("NFKC").trim();
  if (!expected) return [];
  if (!/[A-Za-z]/u.test(expected) || /[\p{Script=Han}]/u.test(expected)) {
    const found: Occurrence[] = []; let from = 0;
    while (from <= source.length) {
      const start = source.indexOf(expected, from); if (start < 0) break;
      found.push({ start, end: start + expected.length, text: source.slice(start, start + expected.length) });
      from = start + Math.max(1, expected.length);
    }
    return found;
  }
  const wanted = [...expected.matchAll(englishToken)].map((match) => match[0]);
  const tokens = [...source.matchAll(englishToken)].map((match) => ({ text: match[0], start: match.index!, end: match.index! + match[0].length }));
  const found: Occurrence[] = [];
  for (let index = 0; index + wanted.length <= tokens.length; index += 1) {
    const slice = tokens.slice(index, index + wanted.length);
    const contiguousPhrase = slice.slice(1).every((token, part) => /^[^\S\r\n]+$/u.test(source.slice(slice[part]!.end, token.start)));
    if (slice.every((token, part) => wordsEquivalent(token.text, wanted[part]!)) && contiguousPhrase) found.push({ start: slice[0]!.start, end: slice.at(-1)!.end, text: source.slice(slice[0]!.start, slice.at(-1)!.end) });
  }
  return found;
}

function sentenceRanges(source: string): TextRange[] {
  const ranges: TextRange[] = []; let start = 0;
  for (const match of source.matchAll(sentenceBoundary)) {
    if (match[0] === ".") {
      const before = source.slice(Math.max(0, match.index! - 12), match.index! + 1);
      const decimal = /\d\.$/u.test(before) && /\d/u.test(source[match.index! + 1] ?? "");
      const abbreviation = /\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St)\.$/iu.test(before);
      if (decimal || abbreviation) continue;
    }
    const end = match.index! + match[0].length;
    if (source.slice(start, end).trim()) ranges.push({ start, end, text: source.slice(start, end) });
    start = end;
  }
  if (source.slice(start).trim()) ranges.push({ start, end: source.length, text: source.slice(start) });
  return ranges;
}

function sentenceFor(ranges: readonly TextRange[], index: number): TextRange | undefined {
  let low = 0; let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle]!;
    if (index < range.start) high = middle - 1;
    else if (index >= range.end) low = middle + 1;
    else return range;
  }
  return undefined;
}

function overlaps(left: SourceSpan, right: SourceSpan): boolean { return left.start < right.end && right.start < left.end; }
function inEvidence(occurrence: Occurrence, spans: readonly SourceSpan[] | undefined): boolean { return !spans?.length || spans.some((span) => span.start <= occurrence.start && span.end >= occurrence.end); }
function inFocus(occurrence: Occurrence, focus: readonly SourceSpan[] | undefined, sentences: readonly TextRange[]): boolean {
  if (!focus?.length) return true;
  const sentence = sentenceFor(sentences, occurrence.start);
  return !!sentence && focus.some((span) => overlaps(sentence, span));
}

let quoteDepthSource = "";
let quoteDepthIndex: Uint16Array = new Uint16Array(1);
let dreamScopeSource = "";
let dreamScopeRangesByAlias = new Map<string, SourceSpan[]>();

function rebuildQuoteDepthIndex(source: string): Uint16Array {
  const depths = new Uint16Array(source.length + 1);
  const stack: string[] = []; let double = false; let single = false;
  const pairs: Record<string, string> = { "“": "”", "‘": "’", "「": "」", "『": "』" };
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at]!;
    const previous = source[at - 1] ?? ""; const next = source[at + 1] ?? "";
    const escaped = previous === "\\" && source[at - 2] !== "\\";
    const measurementMark = char === '"' && /\d/u.test(previous) && !/[\p{L}\p{N}]/u.test(next);
    if (char === '"' && !escaped && !measurementMark) double = !double;
    if (char === "'") {
      const apostropheInsideWord = /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next);
      const pluralPossessive = !single && /[sS]/u.test(previous) && !/[\p{L}\p{N}]/u.test(next);
      const leadingElision = !single && (/[0-9]/u.test(next) || /^(?:twas|tis|twere|cause|em|round|bout)\b/iu.test(source.slice(at + 1)));
      if (!escaped && !apostropheInsideWord && !pluralPossessive && !leadingElision) single = !single;
    }
    if (char !== "'" && pairs[char]) stack.push(pairs[char]!);
    else if (stack.at(-1) === char) stack.pop();
    depths[at + 1] = stack.length + Number(double) + Number(single);
  }
  return depths;
}

function quoteDepthAt(source: string, index: number): number {
  if (source !== quoteDepthSource) {
    quoteDepthSource = source;
    quoteDepthIndex = rebuildQuoteDepthIndex(source);
  }
  return quoteDepthIndex[Math.max(0, Math.min(source.length, index))] ?? 0;
}

const connector = /\b(?:and|or|but|then|instead|while|whereas|after|before|when|once|because|although|though)\b|(?:并且|并(?!非|未|不是)|或者|或|但|但是|却|反而|而是|然后|随后|接着|继而|与此同时|同时|当|因为|虽然)/giu;
function lastConnectorStart(text: string): number {
  let result = -1;
  for (const match of text.matchAll(connector)) result = match.index! + match[0].length;
  const comma = Math.max(text.lastIndexOf(","), text.lastIndexOf("，"), text.lastIndexOf(":"), text.lastIndexOf("："));
  return Math.max(result, comma >= 0 ? comma + 1 : -1);
}

function normalizedAliases(primary: string, aliases: readonly string[] | undefined): string[] {
  return [...new Set([primary, ...(aliases ?? [])].map((item) => item.trim()).filter(Boolean))].sort((left, right) => right.length - left.length);
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

function exactAliasOccurrences(source: string, alias: string): Occurrence[] {
  const expected = alias.trim();
  if (!expected) return [];
  const caseSensitive = /^[A-Z]/u.test(expected);
  const haystack = caseSensitive ? source : source.toLocaleLowerCase();
  const needle = caseSensitive ? expected : expected.toLocaleLowerCase();
  const found: Occurrence[] = []; let from = 0;
  while (from <= haystack.length) {
    const start = haystack.indexOf(needle, from); if (start < 0) break;
    const end = start + needle.length;
    const leftBounded = !/[A-Za-z0-9_-]/u.test(expected[0] ?? "") || !/[A-Za-z0-9_-]/u.test(source[start - 1] ?? "");
    const rightBounded = !/[A-Za-z0-9_-]/u.test(expected.at(-1) ?? "") || !/[A-Za-z0-9_-]/u.test(source[end] ?? "");
    const bounded = leftBounded && rightBounded;
    if (bounded) found.push({ start, end, text: source.slice(start, end) });
    from = start + Math.max(1, needle.length);
  }
  return found;
}

const subjectNoise = new Set("a an the this that these those with without by through using after before in on at under over near beside behind beyond for from to of and or but then instead actually again already also almost always bravely directly easily finally immediately instantly just merely now once personally quickly quietly simply slowly still suddenly together not never did does do had has have was were is are will would can could may might shall should".split(" "));
const personalForeign = /^(?:someone|somebody|anyone|anybody|another|warrior|helper|clone|twin|enemy|guard|he|she|they|we|you)$/iu;

function resolveEnglishSubject(source: string, sentence: TextRange, predicate: Occurrence, aliases: readonly string[]): SubjectResolution {
  const prefix = source.slice(sentence.start, predicate.start);
  const possessiveLead = aliases.find((alias) => {
    const match = new RegExp(`^\\s*${escapeRegex(alias)}[’']s\\s+([^,;.!?\\n]{1,96})(?:,\\s*)?$`, "iu").exec(prefix);
    if (!match) return false;
    const contentWords = [...match[1]!.matchAll(englishToken)].map((word) => word[0].toLocaleLowerCase());
    return contentWords.some((word) => !subjectNoise.has(word) && !/ly$/u.test(word));
  });
  if (possessiveLead) return { kind: "foreign", text: prefix.trim() };
  const explicitName = "(?:(?:Captain|Lady|Lord|Doctor|Dr\\.?|Sir)\\s+)?[A-Z][A-Za-z0-9'’-]*(?:\\s+[A-Z][A-Za-z0-9'’-]*)*";
  const assumedIdentity = aliases.find((alias) => new RegExp(`(?:\\b(?:clone|copy|double|impostor|namesake|puppet|avatar|decoy|lookalike|fake|false|another)\\b[^,;.!?]{0,32}\\b${escapeRegex(alias)}|\\b(?:named|called|known\\s+as)\\s+${escapeRegex(alias)})\\s*$`, "iu").test(prefix));
  if (assumedIdentity) return { kind: "foreign", text: assumedIdentity };
  const contrastive = /^\s*((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)(?:\s*,\s*|\s*[—–-]\s*)not\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)(?:\s*,\s*|\s*[—–-]\s*)$/u.exec(prefix);
  if (contrastive) return aliases.some((alias) => alias.toLocaleLowerCase() === contrastive[1]!.toLocaleLowerCase())
    ? { kind: "expected", text: contrastive[1] }
    : { kind: "foreign", text: contrastive[1] };
  const disguised = /^\s*((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)\s*,\s*(?:while\s+)?disguised\s+as\s+(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*\s*,\s*$/iu.exec(prefix)?.[1];
  if (disguised) return aliases.some((alias) => alias.toLocaleLowerCase() === disguised.toLocaleLowerCase())
    ? { kind: "expected", text: disguised }
    : { kind: "foreign", text: disguised };
  const inlineDisguised = new RegExp(`^\\s*(${explicitName})\\s+(?:while\\s+)?disguised\\s+as\\s+${explicitName}\\s*$`, "iu").exec(prefix)?.[1];
  if (inlineDisguised) return aliases.some((alias) => alias.toLocaleLowerCase() === inlineDisguised.toLocaleLowerCase())
    ? { kind: "expected", text: inlineDisguised }
    : { kind: "foreign", text: inlineDisguised };
  const sentenceLeadPronoun = /^\s*(?:he|she|they)\s*$/iu.test(prefix);
  if (sentenceLeadPronoun && sentence.start > 0) {
    // An assumed identity changes appearance, not discourse identity.  Resolve
    // this locally before the general discourse fallback sees both names and
    // (correctly, for ordinary clauses) marks the antecedent ambiguous.
    const nearbyHistory = source.slice(Math.max(0, sentence.start - 240), sentence.start);
    const previous = nearbyHistory.split(/[.!?;。！？；\n]/u).map((part) => part.trim()).filter(Boolean).at(-1) ?? "";
    const identity = new RegExp(`^\\s*(${explicitName})\\s+(?:(?:was|is)\\s+)?(?:disguised(?:\\s+(?:himself|herself|themself|themselves))?|masquerad(?:ed|es|ing)|pos(?:ed|es|ing)|pass(?:ed|es|ing)(?:\\s+(?:himself|herself|themself|themselves))?\\s+off)\\s+as\\s+${explicitName}\\s*$`, "iu").exec(previous)?.[1];
    if (identity) {
      const expected = aliases.some((alias) => exactAliasOccurrences(identity, alias).length > 0);
      return expected ? { kind: "expected", text: identity } : { kind: "foreign", text: identity };
    }
  }
  const delimitedMainSubject = new RegExp(`^\\s*(${explicitName})\\s*,\\s*(?:with|without|beside|near|alongside|despite|after|before|amid|among)\\b[^,]{1,96},\\s*$`, "iu").exec(prefix)?.[1];
  if (delimitedMainSubject) return aliases.some((alias) => alias.toLocaleLowerCase() === delimitedMainSubject.toLocaleLowerCase())
    ? { kind: "expected", text: delimitedMainSubject }
    : { kind: "foreign", text: delimitedMainSubject };
  // In "Bob, <open parenthetical>, opened ...", Bob remains the grammatical
  // subject even when the parenthetical contains a trusted name. Resolve the
  // bounded clause head before any alias-last fallback can borrow that name.
  const boundedParts = prefix.split(",");
  const boundedHeadPart = boundedParts.length >= 3 && !boundedParts.at(-1)!.trim()
    ? boundedParts.at(-3)!.trim()
    : "";
  const boundedClauseHead = new RegExp(`^${explicitName}$`, "u").exec(boundedHeadPart)?.[0];
  if (boundedClauseHead) return aliases.some((alias) => alias.toLocaleLowerCase() === boundedClauseHead.toLocaleLowerCase())
    ? { kind: "expected", text: boundedClauseHead }
    : { kind: "foreign", text: boundedClauseHead };
  // A bounded parenthetical can describe the clause-head actor, but its
  // open-vocabulary contents cannot replace that actor.
  const parentheticalActor = aliases.find((alias) => new RegExp(`^\\s*${escapeRegex(alias)}\\s*,\\s*[^,;.!?\\n]{1,96},\\s*$`, "iu").test(prefix));
  if (parentheticalActor) return { kind: "expected", text: parentheticalActor };
  // `as` is ambiguous between a role phrase and a finite subordinate clause,
  // so the shared connector scanner cannot treat every occurrence as a clause
  // boundary.  An overt subject immediately before this predicate makes the
  // boundary explicit and keeps an earlier relative-clause alias out of scope.
  const explicitAsSubject = [...prefix.matchAll(new RegExp(`\\bas\\s+(?=${explicitName}(?:\\s+[a-z][A-Za-z'’-]*ly){0,3}\\s*$)`, "giu"))].at(-1);
  const explicitAsStart = explicitAsSubject ? explicitAsSubject.index! + explicitAsSubject[0].length : -1;
  const localAt = Math.max(lastConnectorStart(prefix), explicitAsStart); const local = prefix.slice(Math.max(0, localAt)).trim();
  const aliasPattern = aliases.map(escapeRegex).join("|");
  const commonHead = "(?:(?:the|a|an|this|that)\\s+)(?:[a-z][a-z0-9'’-]*\\s+){0,4}[a-z][a-z0-9'’-]*";
  const relativeAliasIsEmbedded = (value: string): boolean => {
    if (!aliasPattern) return false;
    // A trusted name inside a restrictive relative clause is an argument of
    // that embedded clause, not the matrix subject which performs `predicate`.
    const overtRelative = new RegExp(`^${commonHead}\\s+(?:who|whom|whose|that|which)\\b[^.!?;]*\\b(?:${aliasPattern})\\b[^.!?;]*$`, "iu").test(value);
    const zeroRelative = new RegExp(`^${commonHead}\\s+(?:${aliasPattern})\\s+([A-Za-z][A-Za-z'’-]*)[^.!?;]*$`, "iu").exec(value);
    return overtRelative || !!(zeroRelative && englishFinite(zeroRelative[1]!));
  };
  if (relativeAliasIsEmbedded(local)) return { kind: "foreign", text: local };
  if (aliasPattern && new RegExp(`\\b(?:portrait|statue|image|painting|replica|clone|twin|enemy|guard|warrior)\\b[^.!?;]{0,32}(?:\\bof\\b|\\bdisguised\\s+as\\b|\\bresembling\\b)\\s+(?:${aliasPattern})\\s*$`, "iu").test(local)) {
    return { kind: "foreign", text: local };
  }
  const causedActor = /\b(?:had|let|made|got|gets?|ordered|asked|told|forced|persuaded|allowed)\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|him|her|them|someone|somebody|another\s+\w+)(?:\s+to)?\s*$/iu.exec(local)?.[1];
  if (causedActor) {
    const expected = aliases.some((alias) => alias.toLocaleLowerCase() === causedActor.toLocaleLowerCase());
    return expected ? { kind: "expected", text: causedActor } : { kind: "foreign", text: causedActor };
  }
  const inheritedFromPrevious = (): SubjectResolution | undefined => {
    if (localAt < 0) return undefined;
    const previous = prefix.slice(0, localAt)
      .replace(/,\s*(?:with|without|by|through|using|despite|after|before|amid|among)\b[^,;.!?\n]{1,64},/giu, " ")
      .replace(/\b(?:and|or|but|then|instead|while|whereas|after|before|when|once|because|although|though)\s*$/iu, "")
      .replace(/[,;\s]+$/u, "");
    const punctuationStart = Math.max(previous.lastIndexOf(","), previous.lastIndexOf(";"));
    const priorConnectorStart = lastConnectorStart(previous);
    const segment = previous.slice(Math.max(punctuationStart + 1, priorConnectorStart >= 0 ? priorConnectorStart : 0));
    if (relativeAliasIsEmbedded(segment.trim())) return { kind: "foreign", text: segment.trim() };
    const tokens = [...segment.matchAll(englishToken)].map((match) => ({ text: match[0], start: match.index!, end: match.index! + match[0].length }));
    const finiteAt = tokens.find((token) => /(?:ed|es)$/iu.test(token.text) || irregularLemma.has(token.text.toLocaleLowerCase()))?.start ?? segment.length;
    const alias = aliases.flatMap((name) => exactAliasOccurrences(segment, name)).filter((hit) => hit.start < finiteAt).sort((a, b) => b.start - a.start)[0];
    if (alias) return { kind: "expected", text: alias.text };
    const head = tokens.find((token) => token.start < finiteAt && !subjectNoise.has(token.text.toLocaleLowerCase()) && !(/ly$/iu.test(token.text) && !/^[A-Z]/u.test(token.text)));
    return head ? { kind: "foreign", text: head.text } : undefined;
  };
  const inspect = (segment: string, inherited = false): SubjectResolution | undefined => {
    const aliasHits = aliases.flatMap((alias) => exactAliasOccurrences(segment, alias).map((hit) => ({ ...hit, alias }))).sort((a, b) => a.start - b.start);
    const alias = aliasHits.at(-1);
    if (alias) {
      const before = segment.slice(Math.max(0, alias.start - 12), alias.start);
      const after = segment.slice(alias.end);
      if (/[’']s\s*$/iu.test(segment.slice(alias.start, alias.end + 2)) || /^\s*[’']s\s+(?:clone|twin|system|panel|ability|mechanic)\b/iu.test(after)) return { kind: "foreign", text: after.trim() };
      if (/\b(?:beside|near|with|to|by|for|from|behind|after|before)\s*$/iu.test(before)) return undefined;
      const afterTokens = [...after.matchAll(englishToken)].map((match) => match[0]);
      const governing = afterTokens.findIndex((token) => /(?:ed|ing)$/iu.test(token) || irregularLemma.has(token.toLocaleLowerCase()) && !["did", "had", "was", "were"].includes(token.toLocaleLowerCase()));
      if (governing >= 0) {
        const tail = afterTokens.slice(governing + 1).filter((token) => !subjectNoise.has(token.toLocaleLowerCase()));
        const candidate = tail.at(-1);
        if (candidate && !/^(?:to|the|a|an)$/iu.test(candidate)) return { kind: "foreign", text: candidate };
      }
      return { kind: "expected", text: alias.alias };
    }
    const tokens = [...segment.matchAll(englishToken)].map((match) => match[0]);
    const meaningful = tokens.filter((token) => !subjectNoise.has(token.toLocaleLowerCase()) && !(/ly$/iu.test(token) && !/^[A-Z]/u.test(token)) && !/^\d+$/u.test(token));
    if (!meaningful.length) return undefined;
    if (/^(?:he|she|they)$/iu.test(meaningful[0]!)) {
      const history = prefix.slice(0, Math.max(0, localAt));
      const matrixHead = new RegExp(`^\\s*(${explicitName})\\b`, "u").exec(history)?.[1];
      if (matrixHead) {
        const expectedHead = aliases.some((alias) => alias.toLocaleLowerCase() === matrixHead.toLocaleLowerCase());
        const tail = history.slice(history.indexOf(matrixHead) + matrixHead.length);
        const competingName = [...tail.matchAll(new RegExp(`\\b${explicitName}\\b`, "gu"))]
          .some((match) => !aliases.some((alias) => alias.toLocaleLowerCase() === match[0].toLocaleLowerCase()));
        if (!expectedHead || competingName) return { kind: "foreign", text: meaningful[0] };
        return { kind: "expected", text: meaningful[0] };
      }
      const latestAlias = aliases.flatMap((aliasName) => exactAliasOccurrences(history, aliasName)).sort((a, b) => b.end - a.end)[0];
      const latestNamed = [...history.matchAll(/\b[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*\b/gu)].at(-1);
      if (latestAlias && (!latestNamed || latestAlias.end >= latestNamed.index! + latestNamed[0].length)) return { kind: "expected", text: meaningful[0] };
      return { kind: "foreign", text: meaningful[0] };
    }
    if (personalForeign.test(meaningful[0]!) || /^[A-Z]/u.test(meaningful[0]!) || !inherited) return { kind: "foreign", text: meaningful[0] };
    return undefined;
  };
  const mannerOnly = /^(?:\s*(?:with|by|through|using)\b[^,]*)$/iu.test(local);
  const direct = mannerOnly ? undefined : inspect(local);
  if (direct) return direct;
  const inherited = inheritedFromPrevious();
  if (inherited) return inherited;
  const whole = inspect(prefix, true);
  return whole ?? { kind: "ambiguous" };
}

const chineseLeadingNoise = /^(?:(?:又|便|就|才|仍然|仍旧|仍|还是|依然|依旧|照样|一直|始终|还|已经|早已|已|最终|最后|终于|终究|到底|再次|再度|再一次|竟然|居然|彻底|完全|全然|自己|确实|的确|果不其然|果然|果真|但|但是|然而|事实上|实际(?:上)?|立刻|立即|马上|随即|径直|亲手|轻易|猛地|狠狠地|迅速|缓缓|果断地?|直接|从容|一脚|一剑|一拳|一掌|一刀|一枪|一把|按(?:照)?计划|无所不能地?|无坚不摧地?|战无不胜地?|不是没有|并非没有|绝非没有|未尝没有|没有不|未曾不|未尝不|不能说[^，。！？；]{0,20}没有|不能否认|并不是说[^，。！？；]{0,20}没有|不可能不|不得不|不得已|不由得|不禁|忍不住|按捺不住|情不自禁地?|迫不及待地?|不假思索地?|不慌不忙地?|不紧不慢地?|不卑不亢地?|不动声色地?|不约而同地?|不费吹灰之力|不露声色地?|不顾一切|不遗余力地?|不惜代价|毫不(?:犹豫|迟疑|费力|畏惧|在意|示弱|留情|客气)地?|反而|却|而是|当即|旋即|悍然|悄然|骤然|轰然|稳稳地?|轻松地?|成功地?|用力|奋力|抬手|挥手|没有|没能?|并未|未曾|不曾|不|未|以[^，。！？；]{1,12}(?:之势|方式)|凭[^，。！？；]{1,10}|在[^，。！？；]{1,10}之后))*\s*/u;
function resolveChineseSubject(source: string, sentence: TextRange, predicate: Occurrence, aliases: readonly string[]): SubjectResolution {
  const prefix = source.slice(sentence.start, predicate.start); const localAt = lastConnectorStart(prefix);
  const boundedParts = prefix.split(/[，,]/u);
  const boundedClauseHead = boundedParts.length >= 3 && !boundedParts.at(-1)!.trim()
    ? boundedParts.at(-3)!.trim()
    : "";
  if (/^[\p{Script=Han}]{1,12}$/u.test(boundedClauseHead)) {
    return aliases.includes(boundedClauseHead)
      ? { kind: "expected", text: boundedClauseHead }
      : { kind: "foreign", text: boundedClauseHead };
  }
  const relationalLead = aliases.find((alias) => new RegExp(`^\\s*${escapeRegex(alias)}[^\uff0c,\u3002\uff01\uff1f\uff1b]{0,24}的[^\uff0c,\u3002\uff01\uff1f\uff1b]{1,24}[\uff0c,]\\s*$`, "u").test(prefix));
  if (relationalLead) return { kind: "foreign", text: prefix.trim() };
  const inspect = (raw: string): SubjectResolution | undefined => {
    const segment = raw.trim().replace(chineseLeadingNoise, "");
    if (!segment) return undefined;
    for (const alias of aliases) {
      const at = segment.lastIndexOf(alias); if (at < 0) continue;
      const before = segment.slice(0, at).replace(chineseLeadingNoise, ""); const after = segment.slice(at + alias.length);
      if (after.startsWith("的") || /(?:旁边|身边|附近|身后|面前|之后|之前)$/u.test(before)) continue;
      if (before && !/^(?:在|当|待|等到|随着|经过)[^，。！？；]{0,20}$/u.test(before)) return { kind: "foreign", text: before };
      // The signed predicate occurrence is the right boundary of this subject
      // phrase.  Text between a trusted clause-head alias and that predicate is
      // therefore treated as an open-vocabulary modifier or oblique argument.
      // Only grammatical structures which install another actor invalidate the
      // binding; this avoids an ever-growing adverb whitelist.
      const causedActor = /(?:让|令|使|叫|要求|命令|派|迫使|允许|劝|请)([\p{Script=Han}]{1,12}|他|她|他们|她们)\s*$/u.exec(after)?.[1];
      if (causedActor && !aliases.includes(causedActor)) return { kind: "foreign", text: causedActor };
      const residue = after.replace(chineseLeadingNoise, "");
      const modifierOrOblique = /^(?:(?:[^，。！？；]{1,24}地)|(?:(?:在|于)[^，。！？；]{1,24}(?:中|里|内|外|上|下|前|后|旁|之间|之中|之下|之上))|(?:(?:向|对|朝|给|面向|把|将|用|凭|以)[^，。！？；]{1,24}))*$/u.test(residue);
      if (residue && !modifierOrOblique) return { kind: "foreign", text: residue };
      return { kind: "expected", text: alias };
    }
    return { kind: "foreign", text: segment };
  };
  const direct = inspect(prefix.slice(Math.max(0, localAt)));
  if (direct) return direct;
  if (localAt >= 0) {
    const whole = prefix.trim().replace(/^(?:在[^，。]{1,16}[，,]|当[^，。]{1,16}[，,])\s*/u, "");
    const inheritedAlias = aliases.find((alias) => whole.startsWith(alias));
    if (inheritedAlias) return { kind: "expected", text: inheritedAlias };
  }
  const inherited = inspect(prefix);
  return inherited ?? { kind: "ambiguous" };
}

function resolveSubject(source: string, sentence: TextRange, predicate: Occurrence, aliases: readonly string[]): SubjectResolution {
  return /[\p{Script=Han}]/u.test(predicate.text) || aliases.some((alias) => /[\p{Script=Han}]/u.test(alias))
    ? resolveChineseSubject(source, sentence, predicate, aliases)
    : resolveEnglishSubject(source, sentence, predicate, aliases);
}

function englishFinite(surface: string): boolean {
  const words = [...surface.toLocaleLowerCase().matchAll(englishToken)].map((match) => match[0]);
  return words.some((word) => /(?:ed|es|s)$/u.test(word) || irregularGroups.some((group) => group.slice(1).includes(word) || (group.length === 1 && group[0] === word)));
}

function hasActualPlanExecution(prefix: string): boolean {
  const actual = /(?:\b(?:followed|executed|completed|implemented|fulfilled|carried\s+out)\s+(?:the\s+)?plan\b|(?:按(?:照)?计划|执行了?(?:既定|原定|该)?计划|完成了?(?:既定|原定|该)?计划))/iu.exec(prefix);
  if (!actual) return false;
  const governor = prefix.slice(Math.max(0, actual.index - 40), actual.index);
  return !/(?:\b(?:almost|nearly|supposed|ordered|began|started|promised|refused|failed|tried|attempted|hoped|wished|discussed)\b|(?:差点|险些|本应|奉命|开始|答应|承诺|拒绝|未能|试图|尝试|希望|讨论))[^,，。！？；]{0,28}$/iu.test(governor);
}

function planOrAttemptScope(prefix: string, predicate: Occurrence): "intent" | "attempt" | undefined {
  const englishMatches = [...prefix.matchAll(/\b(plan(?:s|ned|ning)?|intend(?:s|ed|ing)?|want(?:s|ed|ing)?|hope(?:s|d|ing)?|wish(?:es|ed|ing)?|aim(?:s|ed|ing)?|prepare(?:s|d|ing)?|try|tries|tried|trying|attempt(?:s|ed|ing)?)\b/giu)].filter((candidate) => {
    const beforeCandidate = prefix.slice(Math.max(0, candidate.index! - 20), candidate.index!);
    if (/^plan$/iu.test(candidate[0])) {
      const afterCandidate = prefix.slice(candidate.index! + candidate[0].length);
      if (candidate[0] === "Plan" && /^\s+[A-Z][A-Za-z0-9_-]*/u.test(afterCandidate)) return false;
      return !/\b(?:floor|meal|breakfast|dinner)\s*$/iu.test(beforeCandidate);
    }
    if (/^aim$/iu.test(candidate[0])) return !/\b(?:the|a|an|her|his|their|our|my|your|corrected|adjusted)\s*$/iu.test(beforeCandidate);
    if (/^hope$/iu.test(candidate[0])) return !/\b(?:onto|held|the|a|an|her|his|their|our|my|your)\s*$/iu.test(beforeCandidate);
    return true;
  });
  const chineseMatches = [...prefix.matchAll(/(?:计划|打算|准备|想要|希望|意图|试图|试着|尝试|险些|差点)/gu)];
  const match = [...englishMatches, ...chineseMatches].sort((a, b) => a.index! - b.index!).at(-1);
  if (!match) return undefined;
  const kind: "intent" | "attempt" = /^(?:try|tries|tried|trying|attempt)/iu.test(match[0]) || /^(?:试图|试着|尝试|险些|差点)$/u.test(match[0]) ? "attempt" : "intent";
  const before = prefix.slice(Math.max(0, match.index! - 40), match.index!);
  if (/\b(?:abandoned|cancelled|canceled|dropped|discarded|scrapped|rejected)\s+(?:the\s+)?$/iu.test(before) || /(?:放弃|取消|抛弃|搁置|否决|打消|撤销)(?:了)?\s*$/u.test(before)) {
    const after = prefix.slice(match.index! + match[0].length);
    if (/[\p{Script=Han}]/u.test(match[0]) && !/^\s*(?:并|却|反而|而是)/u.test(after)) return kind;
    if (/^\s*to\b/iu.test(after) || /\b(?:in|within)\s+(?:it|which)\b|(?:其中|计划中)/iu.test(after) || !/(?:\band\b|并|却|反而|而是)/iu.test(after)) return kind;
    return undefined;
  }
  if (hasActualPlanExecution(prefix)) return undefined;
  const after = prefix.slice(match.index! + match[0].length);
  if (/^[\s\p{L}\p{N}'’_-]*[.。!?！？]/u.test(after)) return undefined;
  if (/[\p{Script=Han}]/u.test(match[0])) {
    if (/(?:放弃|取消|执行了?|完成了?)[^，。！？；]{0,24}(?:并|却|反而|而是)[^，。！？；]*$/u.test(prefix)) return undefined;
    if (kind === "attempt" && /(?:却|反而)[^，。！？；]*$/u.test(after)) return undefined;
    if (/(?:却|反而)[^，。！？；]*了[^，。！？；]*$/u.test(after)) return undefined;
    return kind;
  }
  const lastBreak = [...after.matchAll(/\b(?:but|instead|then)\b|[,]/giu)].at(-1);
  if (lastBreak) {
    const continuation = after.slice(lastBreak.index! + lastBreak[0].length);
    if (!/\b(?:also\s+)?to\s*$/iu.test(continuation) && englishFinite(predicate.text)) return undefined;
  }
  return kind;
}

function reportScope(prefix: string, sentenceText: string, predicate: Occurrence, subject: SubjectResolution): boolean {
  void sentenceText; void predicate; void subject;
  // A defeated rumour is a closure, not a reporting frame.  Test this before
  // the leading-rumour rule so the noun itself cannot reopen the scope.
  if (/^\s*(?:the\s+)?rumou?r\s+(?:collapsed|was\s+debunked|proved\s+false)|^\s*传闻不攻自破/u.test(prefix)) return false;
  if (/^\s*(?:rumou?r\s+says?|据说|传闻(?:称|说)|听说|据报道)/iu.test(prefix)) return true;
  if (/^\s*(?:(?:the|a|an)\s+)?(?:report|rumou?r|claim|account|testimony|history|story|novel|fiction|tale|fictional\s+(?:story|tale|world)|rehearsal|hypothetical\s+scenario)\b[^.!?;:]{0,40}:\s*[^.!?;]*$/iu.test(prefix)
    || /^\s*(?:history|the\s+record)\s+(?:says?|records?)\s+this\s*:\s*[^.!?;]*$/iu.test(prefix)) return true;

  const startsFreshFactualClause = (tail: string): boolean => (
    /(?:\b(?:and|but|instead|then|actually)\b|["”’」』]\s*,?\s*then\b)\s+(?:[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|he|she|they|the\s+\w+)\b[^.!?;]*$/iu.test(tail)
    || /(?:但|但是|却|反而|随后|然后)\s*[\p{Script=Han}]{1,10}[^。！？；]*$/u.test(tail)
  );
  const startsDelimitedFactualClause = (tail: string): boolean => (
    /(?:[,;]\s*(?:and|but|instead|then|actually)\s+|["”’」』]\s*,?\s*then\s+)(?:[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|he|she|they|the\s+\w+)\b[^.!?;]*$/iu.test(tail)
    || /[，；,;]\s*(?:但|但是|却|反而|随后|然后)\s*[\p{Script=Han}]{1,10}[^。！？；]*$/u.test(tail)
  );

  // Nonfactive speech and epistemic governors introduce possible, invented or
  // doubted content.  Keep them separate from factive governors such as
  // "revealed", "confirmed" and "knew", whose complements remain asserted.
  const nonfactiveFrames = [...prefix.matchAll(/\b(?:lie|lies|lied|lying|jok(?:e|es|ed|ing)|boast(?:s|ed|ing)?|suggest(?:s|ed|ing)?|doubt(?:s|ed|ing)?|speculat(?:e|es|ed|ing)|guess(?:es|ed|ing)?|wonder(?:s|ed|ing)?)\b|(?:谎称|撒谎说|开玩笑说|吹嘘(?:说)?|夸口(?:说)?|暗示|怀疑|推测|猜测|猜想|揣测|琢磨)/giu)];
  for (const frame of nonfactiveFrames) {
    const tail = prefix.slice(frame.index! + frame[0].length);
    if (startsDelimitedFactualClause(tail)) continue;
    const factiveReset = /\b(?:and|but|instead|then|actually)\s+(?:(?:[A-Z][A-Za-z0-9'’-]*|he|she|they)\s+)?(?:reveal(?:s|ed|ing)?|confirm(?:s|ed|ing)?|know|knows|knew|known|discover(?:s|ed|ing)?|learn(?:s|ed|ing)?|establish(?:es|ed|ing)?|prove(?:s|d|n|ing)?|verif(?:y|ies|ied|ying)|find|finds|found)\s+that\b[^.!?;]*$/iu.test(tail)
      || /(?:但|但是|却|反而|随后|然后)(?:[\p{Script=Han}]{1,10})?(?:揭示|确认|证实|知道|得知|发现)[^。！？；]*$/u.test(tail);
    if (factiveReset) continue;
    if (/[\p{Script=Han}]/u.test(frame[0])) {
      if (!/[。！？；]/u.test(tail)) return true;
      continue;
    }
    if (/^\s*(?:(?:to|with)\s+(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*\s+)?(?:that|whether|if)\b[^.!?;]*$/iu.test(tail)) return true;
    if (/^\s*(?:(?:the|a|an)\s+[A-Za-z][A-Za-z0-9'’-]*|[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|he|she|they|someone|somebody)\s+(?:\w+\s+){0,5}$/iu.test(tail)) return true;
  }

  // A referenced report remains non-factual even when a character dismisses
  // it: "dismissed the rumour that ..." still describes the rumour's content.
  if (/\b(?:rumou?r|report|claim|story|account)\b[^.!?;]{0,24}\bthat\b[^.!?;]*$/iu.test(prefix)
    || /(?:传闻|报道|说法|消息|故事)[^。！？；]{0,18}(?:称|说|内容是)[^。！？；]*$/u.test(prefix)) return true;

  const reports = [...prefix.matchAll(/\b(?:say|says|said|write|writes|wrote|written|record(?:s|ed|ing)|report(?:s|ed|ing)|announce(?:s|d|ing)|claim(?:s|ed|ing)|allege(?:s|d|ing)|testif(?:y|ies|ied|ying)|swear|swears|swore|sworn|deny|denies|denied|denying|insist(?:s|ed|ing)|assert(?:s|ed|ing)|contend(?:s|ed|ing)|maintain(?:s|ed|ing)|state(?:s|d|ing)|declare(?:s|d|ing)|recall(?:s|ed|ing)|recollect(?:s|ed|ing)|hear(?:s|d|ing))\b|(?:有人说|报道称|报道指出|报告称|声称|宣称|坚称|断言|否认|表示|指出|回忆|听说|作证)/giu)];
  for (const report of reports) {
    const tail = prefix.slice(report.index! + report[0].length);
    // Lexical/direct-object uses do not introduce a content clause.
    if (/^\s+(?:for\s+duty|(?:(?:the|a|an|her|his|their)\s+)?[a-z][a-z'’-]*(?:\s+[a-z][a-z'’-]*){0,3})\s+(?:and|but|then)\s*$/iu.test(tail)) continue;
    // Explicitly stepping out of speech into a fresh, named factual clause.
    if (startsFreshFactualClause(tail)) continue;
    if (/^\s*(?:that\b|[:,：]|["“‘「『])/iu.test(tail) || /\bthat\b/iu.test(tail)) return true;
    if (/^(?:有人说|报道称|报道指出|报告称|声称|宣称|坚称|断言|表示|指出|听说)/u.test(report[0])) return true;
    // English permits a bare finite complement: "Bob said Aria opened ...".
    if (/^\s*(?:(?:the|a|an)\s+[A-Za-z][A-Za-z0-9'’-]*|[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|he|she|they|someone|somebody)\s+(?:\w+\s+){0,5}$/iu.test(tail)) return true;
  }
  return false;
}

const englishNonActualContainerTerm = "dream|nightmare|simulation|hallucination|vision|illusion|imagination|fantasy|story|novel|fiction|tale|fictional\\s+(?:story|tale|world)|hypothetical\\s+(?:scenario|future|world)|rehearsal";
const chineseNonActualContainerTerm = "梦境|梦中|梦里|噩梦|模拟|推演|预演|演算|设想|假想场景|假想世界|假想未来|脑海|幻境|幻觉|想象|幻想|虚构世界|故事|小说|剧本|演练|假设情境";

function rebuildDreamScopeRanges(source: string, actorAliases: readonly string[]): SourceSpan[] {
  type ScopeFamily = "dream" | "simulation" | "hallucination" | "imagination" | "fiction" | "rehearsal" | "depiction";
  type ScopeEvent = {
    at: number;
    end: number;
    kind: "open" | "close" | "reset";
    family: ScopeFamily;
    embedded?: boolean;
  };
  type ScopeFrame = { family: ScopeFamily; at: number; embedded: boolean; previousSame?: number };
  const ranges: SourceSpan[] = [];
  const events: ScopeEvent[] = [];
  const hardBoundaries = sentenceRanges(source)
    .map((range) => range.end)
    .filter((end) => /[.!?;。！？；\n]/u.test(source[end - 1] ?? ""));
  const hasHardBoundary = (start: number, end: number): boolean => {
    let low = 0; let high = hardBoundaries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (hardBoundaries[middle]! <= start) low = middle + 1;
      else high = middle;
    }
    return low < hardBoundaries.length && hardBoundaries[low]! <= end;
  };
  const nextHardBoundary = (at: number): number | undefined => {
    let low = 0; let high = hardBoundaries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (hardBoundaries[middle]! <= at) low = middle + 1;
      else high = middle;
    }
    return hardBoundaries[low];
  };
  const addSentenceLocalClose = (at: number, family: ScopeFamily): void => {
    const boundary = nextHardBoundary(at);
    if (boundary !== undefined) events.push({ at: boundary, end: boundary, kind: "close", family });
  };
  const familyFor = (value: string): ScopeFamily => {
    const normalized = value.toLocaleLowerCase().replace(/\s+/gu, " ");
    if (/^(?:dream|nightmare|梦境|梦中|梦里|噩梦)$/u.test(normalized)) return "dream";
    if (/^(?:simulation|hypothetical scenario|模拟|假设情境)$/u.test(normalized)) return "simulation";
    if (/^(?:hallucination|vision|illusion|幻境|幻觉)$/u.test(normalized)) return "hallucination";
    if (/^(?:imagination|fantasy|想象|幻想)$/u.test(normalized)) return "imagination";
    if (/^(?:rehearsal|演练)$/u.test(normalized)) return "rehearsal";
    if (normalized === "depiction") return "depiction";
    return "fiction";
  };
  const opener = new RegExp(`\\b(?:only\\s+)?(?:in|inside|within|during)\\s+(?:(?:a|an|the|her|his|their|my|your|our)\\s+|(?:(?:Captain|Lady|Lord|Doctor|Dr\\.?|Sir)\\s+)?[A-Z][A-Za-z0-9'’-]*[’']s\\s+)?(${englishNonActualContainerTerm})\\b`, "giu");
  const chineseOpener = new RegExp(`(?:在\\s*(${chineseNonActualContainerTerm})(?:中|里|之中)?|(${chineseNonActualContainerTerm})(?:中|里|之中)|(梦中|梦里))`, "gu");
  const depictionOpener = /\b(on\s+(?:screen|the\s+screen|page|the\s+page))\b/giu;
  const verbOpener = /\b(dream(?:ed|t|s|ing)|imagin(?:ed|es|ing)|fantasi(?:ed|es|ing)|hallucinat(?:ed|es|ing)|simulat(?:ed|es|ing)|envision(?:ed|s|ing))\b(?:\s+(?:that|of|about|where|how))?/giu;
  const imperativeOpener = /(?:^|[.!?;]\s*)\b(imagine|suppose|picture|dream\s+of)\b(?:\s+that)?/giu;
  const chineseVerbOpener = /(?:梦见|梦到|梦着|做梦|想象(?:着|到)?|幻想(?:着|到)?|模拟(?:了|着)?|陷入(?:了)?(?:梦境|幻境|幻觉))/gu;
  const genericCloser = new RegExp(`\\b(?:the\\s+)?(${englishNonActualContainerTerm})\\s+(?:ended|stopped|collapsed|broke(?:\\s+apart)?|shattered|dissolved|faded|vanished|finished|closed)\\b`, "giu");
  const chineseCloser = new RegExp(`(${chineseNonActualContainerTerm})(?:结束|终止|破碎|消散|散去|退去|完结|落幕)`, "gu");
  const englishNamedActor = "(?:(?:Captain|Lady|Lord|Doctor|Dr\\.?|Sir)\\s+)?[A-Z][A-Za-z0-9'’-]*(?:\\s+[A-Z][A-Za-z0-9'’-]*)*";
  const englishWake = new RegExp(`\\b(?:[Tt]hen\\s+|[Aa]fterward(?:s)?\\s+)?(${englishNamedActor}|[Hh]e|[Ss]he|[Tt]hey)\\s+(?:(?:woke|awoke)(?:\\s+up)?(?:\\s+with\\s+(?:a\\s+)?start)?(?:\\s+from\\s+(?:the\\s+)?(dream|simulation))?|(?:jolted|jerked|snapped)\\s+awake|opened\\s+(?:her|his|their)\\s+eyes)(?=\\s*(?:[,.;!?]|\\b(?:and|but|then)\\b|$))`, "gu");
  const chineseAliases = actorAliases.filter((alias) => /[\p{Script=Han}]/u.test(alias)).map(escapeRegex).join("|");
  const chineseWake = new RegExp(`(?:随后|然后|接着|终于)?[，,]?\\s*(${chineseAliases || "[\\p{Script=Han}]{1,10}"}|他|她|他们|她们)(?:从)?(梦中|梦境|模拟)?(?:里|中)?(?:醒来|苏醒)`, "gu");
  const realityReset = /\b(?:back\s+(?:in|to)|return(?:ed|s|ing)?\s+to)\s+(?:the\s+)?(?:real\s+world|reality)\b|\bin\s+(?:(?:the\s+)?real\s+world|reality)\b|(?:回到|返回)(?:了)?现实(?:世界)?|现实(?:世界)?中/giu;

  for (const match of source.matchAll(opener)) {
    const before = source.slice(Math.max(0, match.index! - 16), match.index!);
    if (/(?:\bas\s+if|\blike)\s*$/iu.test(before)) continue;
    events.push({ at: match.index!, end: match.index! + match[0].length, kind: "open", family: familyFor(match[1]!) });
  }
  for (const match of source.matchAll(chineseOpener)) {
    const container = match[1] ?? match[2] ?? match[3];
    if (!container) continue;
    const after = source.slice(match.index! + match[0].length, match.index! + match[0].length + 8);
    if (/^(?:中|里)?(?:醒来|苏醒|结束|终止|破碎|消散|散去|退去)/u.test(after)) continue;
    events.push({ at: match.index!, end: match.index! + match[0].length, kind: "open", family: familyFor(container) });
  }
  for (const match of source.matchAll(depictionOpener)) events.push({ at: match.index!, end: match.index! + match[0].length, kind: "open", family: "depiction" });
  for (const match of source.matchAll(verbOpener)) {
    const family = /^(?:dream|梦)/iu.test(match[1]!) ? "dream"
      : /^simulat/iu.test(match[1]!) ? "simulation"
        : /^hallucinat/iu.test(match[1]!) ? "hallucination"
          : "imagination";
    events.push({ at: match.index!, end: match.index! + match[0].length, kind: "open", family, embedded: true });
    if (!/\b(?:that|where|how)\s*$/iu.test(match[0])) addSentenceLocalClose(match.index! + match[0].length, family);
  }
  for (const match of source.matchAll(imperativeOpener)) {
    const family: ScopeFamily = /^dream/iu.test(match[1]!) ? "dream" : "imagination";
    events.push({ at: match.index!, end: match.index! + match[0].length, kind: "open", family, embedded: true });
    if (!/\bthat\s*$/iu.test(match[0])) addSentenceLocalClose(match.index! + match[0].length, family);
  }
  for (const match of source.matchAll(chineseVerbOpener)) {
    const family: ScopeFamily = /梦/u.test(match[0]) ? "dream" : /模拟/u.test(match[0]) ? "simulation" : /幻/u.test(match[0]) ? "hallucination" : "imagination";
    events.push({ at: match.index!, end: match.index! + match[0].length, kind: "open", family, embedded: true });
    const following = source.slice(match.index! + match[0].length, match.index! + match[0].length + 12);
    if (!/^(?:[ \t]*(?:到|说|：|:)[ \t]*|[ \t]*\n)/u.test(following)) addSentenceLocalClose(match.index! + match[0].length, family);
  }
  for (const match of source.matchAll(genericCloser)) events.push({ at: match.index!, end: match.index! + match[0].length, kind: "close", family: familyFor(match[1]!) });
  for (const match of source.matchAll(chineseCloser)) events.push({ at: match.index!, end: match.index! + match[0].length, kind: "close", family: familyFor(match[1]!) });
  for (const match of source.matchAll(englishWake)) {
    const subject = match[1]!;
    const expected = !actorAliases.length
      || actorAliases.some((alias) => exactAliasOccurrences(subject, alias).length > 0)
      || (/^(?:he|she|they)$/iu.test(subject) && discourseSubjectBefore(source, match.index!, actorAliases).kind === "expected");
    if (expected) events.push({ at: match.index!, end: match.index! + match[0].length, kind: "close", family: match[2]?.toLocaleLowerCase() === "simulation" ? "simulation" : "dream" });
  }
  for (const match of source.matchAll(chineseWake)) {
    const subject = match[1]!;
    const expected = !actorAliases.length || actorAliases.some((alias) => alias === subject)
      || (/^(?:他|她|他们|她们)$/u.test(subject) && discourseSubjectBefore(source, match.index!, actorAliases).kind === "expected");
    if (expected) events.push({ at: match.index!, end: match.index! + match[0].length, kind: "close", family: match[2]?.startsWith("模拟") ? "simulation" : "dream" });
  }
  for (const match of source.matchAll(realityReset)) events.push({ at: match.index!, end: match.index! + match[0].length, kind: "reset", family: "fiction" });
  events.sort((left, right) => left.at - right.at || (left.kind === "reset" ? -2 : left.kind === "close" ? -1 : 1));

  const stack: ScopeFrame[] = [];
  const topByFamily = new Map<ScopeFamily, number>();
  let outerStart: number | undefined;
  for (const event of events) {
    if (event.kind === "open") {
      if (!stack.length) outerStart = event.end;
      const previousSame = topByFamily.get(event.family);
      stack.push({ family: event.family, at: event.at, embedded: !!event.embedded, previousSame });
      topByFamily.set(event.family, stack.length - 1);
      continue;
    }
    if (!stack.length) continue;
    if (event.kind === "reset") {
      ranges.push({ start: outerStart ?? 0, end: event.at });
      stack.length = 0;
      topByFamily.clear();
      outerStart = undefined;
      continue;
    }
    const matching = topByFamily.get(event.family);
    if (matching === undefined) continue;
    const matchedFrame = stack[matching]!;
    // A wake or ending narrated inside the same complement remains part of the
    // dream.  A hard sentence/newline boundary is the evidence that narration
    // has stepped back out to the framing reality.
    if (matchedFrame.embedded && !hasHardBoundary(matchedFrame.at, event.at)) continue;
    while (stack.length > matching) {
      const removed = stack.pop()!;
      if (removed.previousSame === undefined) topByFamily.delete(removed.family);
      else topByFamily.set(removed.family, removed.previousSame);
    }
    if (!stack.length && outerStart !== undefined) {
      ranges.push({ start: outerStart, end: event.at });
      outerStart = undefined;
    }
  }
  if (stack.length && outerStart !== undefined) ranges.push({ start: outerStart, end: source.length });
  return ranges;
}

function activeDreamContainer(source: string, at: number, actorAliases: readonly string[] = []): boolean {
  // Alias matching deliberately preserves case for proper names, so the cache
  // key must preserve it too. JSON encoding makes sequence boundaries
  // unambiguous while sorting keeps the caller's alias order irrelevant.
  const aliasKey = JSON.stringify([...actorAliases].sort());
  if (source !== dreamScopeSource) {
    dreamScopeSource = source;
    dreamScopeRangesByAlias = new Map<string, SourceSpan[]>();
  }
  let ranges = dreamScopeRangesByAlias.get(aliasKey);
  if (!ranges) {
    ranges = rebuildDreamScopeRanges(source, actorAliases);
    if (dreamScopeRangesByAlias.size >= 16) {
      const oldest = dreamScopeRangesByAlias.keys().next().value;
      if (oldest !== undefined) dreamScopeRangesByAlias.delete(oldest);
    }
    dreamScopeRangesByAlias.set(aliasKey, ranges);
  }
  let low = 0; let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle]!;
    if (at < range.start) high = middle - 1;
    else if (at >= range.end) low = middle + 1;
    else return true;
  }
  return false;
}

function postposedNonActualContainer(source: string, sentence: TextRange, occurrence: Occurrence): boolean {
  const suffix = source.slice(occurrence.end, sentence.end);
  const english = new RegExp(`\\b(?:only\\s+)?(?:in|inside|within|during)\\s+(?:(?:a|the|her|his|their|my|your|our)\\s+|(?:(?:Captain|Lady|Lord|Doctor|Dr\\.?|Sir)\\s+)?[A-Z][A-Za-z0-9'’-]*[’']s\\s+)?(?:${englishNonActualContainerTerm})\\b[^.!?;]*[.!?;]?\\s*$`, "iu").exec(suffix);
  const englishAt = english && !/(?:\bas\s+if|\blike)\s*$/iu.test(suffix.slice(0, english.index)) ? english.index : undefined;
  const dreaming = /\bwhile\s+(?:dreaming|hallucinating|imagining|simulating)\b[^.!?;]*[.!?;]?\s*$/iu.exec(suffix);
  const reported = /(?:[,，]?\s*(?:or\s+so|so)\s+|[,，]\s*)(?:(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|he|she|they)\s+(?:claim(?:s|ed)?|say|says|said|report(?:s|ed)?|allege(?:s|d)?|wrote|recorded)[.!?;]?\s*$|[,，]?\s*according\s+to\s+(?!(?:(?:the\s+)?(?:plan|rules|schedule|instructions?|protocol|procedure))\b)[^.!?;]{1,96}[.!?;]?\s*$|[,，]\s*(?:allegedly|reportedly|purportedly|ostensibly)[.!?;]?\s*$/iu.exec(suffix);
  const chinese = new RegExp(`(?:只|仅|只有)?在(?:${chineseNonActualContainerTerm})(?:中|里|之中)?[^。！？；]*[。！？；]?\\s*$|[,，]?\\s*据[^，。！？；]{0,32}(?:所说|所述|记载|报道)[。！？；]?\\s*$`, "u").exec(suffix);
  const containerAt = englishAt ?? dreaming?.index ?? reported?.index ?? chinese?.index;
  if (containerAt === undefined) return false;
  const bridge = suffix.slice(0, containerAt);
  return !/\b(?:but|instead|however|then|afterward|afterwards)\b|(?:但是|但|却|反而|然后|随后|接着)/iu.test(bridge);
}

function absorbedSurfaceModality(surface: string): "nonactual" | "negated" | undefined {
  const value = surface.normalize("NFKC").trim();
  if (!value) return "nonactual";
  if (/[A-Za-z]/u.test(value)) {
    const affirmative = /\bnot\s+only\b|\b(?:did\s+not|didn[’']t|never)\s+(?:fail|hesitate|flinch|pause|waver|wait)\s+to\b|\b(?:could\s+not|couldn[’']t)\s+(?:help|avoid)\b/iu.test(value);
    if (!affirmative && /\b(?:not|never|neither|nor|cannot|can[’']t|couldn[’']t|doesn[’']t|don[’']t|didn[’']t|won[’']t|without|unable\s+to)\b/iu.test(value)) return "negated";
    if (/^\s*(?:almost|nearly|all\s+but|merely|allegedly|reported(?:ly)?|purported(?:ly)?|ostensible|ostensibly|supposed(?:ly)?|apparent(?:ly)?|seeming(?:ly)?|perhaps|maybe|possible|possibly|probable|probably|potential(?:ly)?|hypothetical(?:ly)?|imaginary|imaginable)\b/iu.test(value)
      || /^\s*(?:would|might|may|could|should|must|will|shall)\b/iu.test(value)
      || /^\s*(?:(?:seem|appear)(?:s|ed|ing)?\s+to|(?:(?:am|is|are|was|were)\s+)?about\s+to|(?:claim|report|allege|purport)(?:s|ed|ing)?\s+to|(?:am|is|are|was|were)\s+(?:said|claimed|reported|alleged|purported)\s+to)\b/iu.test(value)
      || /^\s*(?:(?:am|is|are|was|were)\s+(?:on\s+the\s+verge\s+of|within\s+reach\s+of|close\s+to)|(?:come|comes|came)\s+close\s+to|(?:come|comes|came)\s+within\s+(?:an?\s+)?(?:inch|step|moment)\s+of)\b/iu.test(value)
      || /\b(?:tr(?:y|ies|ied|ying)|attempt(?:s|ed|ing)?|fail(?:s|ed|ing)?|plan(?:s|ned|ning)?|intend(?:s|ed|ing)?|hope(?:s|d|ing)?|wish(?:es|ed|ing)?|aim(?:s|ed|ing)?|expect(?:s|ed|ing)?)\b[^.!?;]{0,36}\bto\b/iu.test(value)
      || /\b(?:dream(?:s|ed|t|ing)?|imagin(?:e|es|ed|ing)?|simulat(?:e|es|ed|ing)?|pretend(?:s|ed|ing)?|predict(?:s|ed|ing)?|speculat(?:e|es|ed|ing)?|guess(?:es|ed|ing)?)\b\s+(?:that|whether|if|about|of|[A-Za-z][A-Za-z'’-]*ing\b)/iu.test(value)) return "nonactual";
    return undefined;
  }
  const affirmative = /(?:不是没有|并非没有|绝非没有|未尝没有|没有不|未曾不|未尝不|不得不|不得已|不能不|不会不|不可不|不由得|不禁|忍不住|迫不及待|不假思索|毫不(?:犹豫|迟疑))/u.test(value);
  if (!affirmative && /(?:^|[，,\s])(?:没能?|没有|未能?|并未|未曾|不曾|从未|无法|不能|不可能)(?=[^，。！？；]{1,32})/u.test(value)) return "negated";
  if (/(?:^|[，,\s])(?:差点|差一步|险些|几乎|也许|或许|可能|本可|据称|据说|疑似|貌似|看似|似乎|仿佛|眼看就要|试图|尝试|企图|计划|打算|准备|希望|想要|即将|将会|想象|幻想|梦见|模拟|预测|预言|假装)/u.test(value)) return "nonactual";
  return undefined;
}

function printedTextContainerScope(prefix: string): boolean {
  const container = "(?:banner|label|placard|sign|notice|caption|screen|interface|page|book|manual)";
  const text = "(?:words?|text|message|sentence|caption|notice|inscription)";
  return new RegExp(`^\\s*(?:on|upon|across|inside|within)\\s+(?:(?:a|an|the)\\s+)?${container}\\b[^.!?;]{0,80}\\b(?:were|are|was|is|appeared|appear|stood|stand)\\s+(?:(?:a|an|the)\\s+)?${text}\\b[^.!?;]*$`, "iu").test(prefix)
    || new RegExp(`^\\s*(?:(?:a|an|the)\\s+)?${container}\\b[^.!?;]{0,40}\\b(?:bore|bears?|carried|carries|contained|contains|displayed|displays|showed|shows|presented|presents|featured|features|had)\\s+(?:(?:a|an|the)\\s+)?${text}\\b[^.!?;]*$`, "iu").test(prefix)
    || new RegExp(`^\\s*(?:printed|written|painted|displayed|shown|inscribed|typed)\\s+(?:across|on|upon|inside|within)\\s+(?:(?:a|an|the)\\s+)?${container}\\b[^.!?;]*$`, "iu").test(prefix)
    || /^\s*(?:在)?(?:横幅|标签|标牌|告示|字幕|屏幕|界面|书页|书|手册)(?:上|中|里)?[^。！？；]{0,48}(?:印着|写着|写有|显示着?|载有|刻着|题着|呈现)[^。！？；]*$/u.test(prefix)
    || /^\s*(?:印|写|刻|显示|呈现)(?:在|于)(?:横幅|标签|标牌|告示|字幕|屏幕|界面|书页|书|手册)(?:上|中|里)?[^。！？；]*$/u.test(prefix);
}

function nonActualReason(source: string, sentence: TextRange, predicate: Occurrence, subject: SubjectResolution, actorAliases: readonly string[] = [], allowNonFinite = false): "nonactual" | "negated" | undefined {
  if (quoteDepthAt(source, predicate.start) > 0) return "nonactual";
  const absorbed = absorbedSurfaceModality(predicate.text);
  if (absorbed) return absorbed;
  const prefix = source.slice(sentence.start, predicate.start); const suffix = source.slice(predicate.end, sentence.end);
  const crossBoundaryPrefix = source.slice(Math.max(0, sentence.start - 120), predicate.start);
  const sentenceValue = sentence.text.trim();
  const actorPattern = actorAliases.map(escapeRegex).join("|");
  const factualBreak = subject.kind === "expected" && (
    (!!actorPattern && new RegExp(`(?:[,;]\\s*|\\b)(?:and|but|instead|then|actually)(?:\\s+(?:in\\s+fact|in\\s+reality))?\\s+(?:${actorPattern})\\b[^.!?;]*$`, "iu").test(prefix))
    || /(?:，|,)(?:但|但是|却|反而|随后|然后|事实上|实际(?:上)?)[，,]?[^。！？；]*$/u.test(prefix)
  );
  const epistemicComplement = /^\s*(?:(?:it|this|that)\s+(?:is|was|remains?|remained|seems?|seemed|appears?|appeared)\s+(?:still\s+)?(?:possible|uncertain|unknown|unclear|doubtful|questionable|unconfirmed|unverified|conceivable|plausible|unlikely|imaginable)\s+(?:that|whether|if)\b|there\s+(?:is|was|remains?|remained)\s+(?:(?:a|some)\s+)?(?:chance|possibility|doubt|uncertainty)\s+(?:that|whether|if|of)\b)[^.!?;]*$/iu.test(prefix)
    || /^\s*(?:nobody|no\s+one|none)\s+(?:(?:really\s+)?(?:knows?|knew|can\s+tell|could\s+tell|is\s+sure|was\s+sure))\s+(?:that|whether|if)\b[^.!?;]*$/iu.test(prefix)
    || /^\s*the\s+jury\s+(?:is|was|remains?|remained)\s+(?:still\s+)?out\s+(?:on|over)\s+(?:whether|if)\b[^.!?;]*$/iu.test(prefix)
    || /^\s*no\s+(?:witness(?:es)?|observer(?:s)?|source(?:s)?|record(?:s)?|account(?:s)?)\s+(?:(?:can|could|would)\s+)?(?:confirm(?:s|ed)?|verif(?:y|ies|ied)|establish(?:es|ed)?|prove(?:s|d)?)\s+(?:that|whether|if)\b[^.!?;]*$/iu.test(prefix)
    || /^\s*there\s+(?:is|was|remains?|remained)\s+no\s+(?:evidence|proof|confirmation)\s+(?:that|whether|if|of)\b[^.!?;]*$/iu.test(prefix)
    || /^\s*no\s+(?:evidence|proof|confirmation)\s+(?:exists?|existed|remains?|remained)\s+(?:that|whether|if|of)\b[^.!?;]*$/iu.test(prefix)
    || /^\s*it\s+(?:is|was|remains?|remained)\s+(?:still\s+)?(?:an?\s+)?open\s+question\s+(?:that|whether|if)\b[^.!?;]*$/iu.test(prefix)
    || /^\s*it\s+(?:has|had)\s+(?:still\s+)?yet\s+to\s+be\s+(?:confirmed|verified|established|proven)\s+(?:that|whether|if)\b[^.!?;]*$/iu.test(prefix)
    || /^\s*in\s+theory\b[^.!?;]*$/iu.test(prefix)
    || /^\s*(?:as\s+(?:a|an)\s+(?:hypothetical(?:\s+(?:example|scenario|case))?|hypothesis|thought\s+experiment)|for\s+the\s+sake\s+of\s+(?:argument|discussion))\s*[,，][^.!?;]*$/iu.test(prefix)
    || /^\s*word\s+has\s+it\s+that\b[^.!?;]*$/iu.test(prefix)
    || /^\s*either\s+(?!way\b)[^.!?;]*$/iu.test(prefix)
    || /^\s*(?:whether|if)\b[^.!?;]*(?:remains?|remained|is|was|seems?|seemed)\s+(?:unknown|uncertain|unclear|unconfirmed|unverified|unresolved|in\s+doubt)\b[^.!?;]*[.!?]?\s*$/iu.test(sentenceValue)
    || /\b(?:as\s+if|as\s+though|acted?\s+like)\b[^.!?;]*$/iu.test(prefix)
    || /^\s*(?:(?:有)?(?:可能|或许|也许|未必|不确定)(?:是|会)?|尚不清楚|无法确定)[，,]?[^。！？；]*$/u.test(prefix)
    || /^\s*(?:从理论上说|理论上(?:说)?|在(?:一场)?思想实验中)[，,]?[^。！？；]*$/u.test(prefix)
    || /^\s*(?:是否)[^。！？；]*(?:仍|尚|依然|还是)?(?:未知|不明|不确定|不清楚|无法确定)[。！？]?\s*$/u.test(sentenceValue)
    || /(?:仿佛|好像|宛如|如同)[^。！？；]*$/u.test(prefix);
  if (!factualBreak && epistemicComplement) return "nonactual";
  const postposedRetraction = /[,，]\s*(?:supposedly|allegedly|reportedly|purportedly|ostensibly|apparently|in\s+theory)\s*[.!?]?\s*$/iu.test(suffix)
    || /[,，]\s*(?:or\s+)?so\s+the\s+(?:story|tale|legend)\s+(?:goes|went)\s*[.!?]?\s*$/iu.test(suffix)
    || /[,，]\s*(?:(?:which|but\s+(?:this|that|it))\s+)?(?:never\s+happened|did\s+not\s+happen|didn[’']t\s+happen|was\s+not\s+true|wasn[’']t\s+true|remained\s+unconfirmed|was\s+only\s+(?:a\s+)?rumou?r)\s*[.!?]?\s*$/iu.test(suffix)
    || /[,，]\s*(?:其实|实际(?:上)?|事实上)?(?:并未|没有|从未)(?:真正)?发生[。！？]?\s*$/u.test(suffix)
    || /[,，]\s*(?:但|但是)?(?:这|那|此事)?(?:并)?不是真的[。！？]?\s*$/u.test(suffix)
    || /[,，]\s*(?:该|这条|这则)?(?:消息|说法|传闻)?(?:仍|尚|依然)?(?:未|没有)(?:得到)?(?:证实|确认)[。！？]?\s*$/u.test(suffix)
    || /[,，]\s*(?:这|那|此事)?只是(?:一则|一个)?(?:传闻|谣言|假设|设想)[。！？]?\s*$/u.test(suffix)
    || /[,，]\s*(?:或者|或是|还是)[^。！？；]{1,32}(?:做到了?|完成了?|实现了?|才是)[。！？]?\s*$/u.test(suffix)
    || /[,，]\s*(?:纯属|只是|仅是)?(?:虚构|杜撰|想象|设想)[。！？]?\s*$/u.test(suffix)
    || /[,，]\s*(?:只|仅)(?:存在|发生)于(?:剧本|故事|小说|推演|预演|演算|设想|脑海)(?:中|里)?[。！？]?\s*$/u.test(suffix)
    || /[,，]\s*(?:此事|这|那)?未必如此[。！？]?\s*$/u.test(suffix);
  if (postposedRetraction) return "nonactual";
  if (/[?？]\s*$/u.test(sentenceValue) || /^\s*(?:did|does|do|has|have|had|is|are|was|were|can|could|may|might|must|shall|should|will|would)\b/iu.test(sentenceValue)
    || /(?:吗|呢|是否)[^。！？；]*[？?]\s*$/u.test(sentenceValue)) return "nonactual";
  if (!factualBreak && (/^\s*(?:reportedly|supposedly|purportedly|ostensibly|allegedly|apparently|seemingly|perhaps|maybe|possibly|probably)\b[^.!?;]*$/iu.test(prefix)
    || /\b(?:was|were|is|are)\s+(?:rumou?red|reported|alleged|said|claimed|purported)\s+to\s+(?:have\s+)?$/iu.test(prefix)
    || /^(?:传闻|报道)(?:中|里)[，,]?[^。！？；]*$/u.test(prefix))) return "nonactual";
  const conditionalPrefix = /^\s*(?:if|unless|whenever|in\s+case|in\s+the\s+event\s+that|on\s+condition\s+that|subject\s+to|provided(?:\s+that)?|providing(?:\s+that)?|assuming(?:\s+that)?|supposing(?:\s+that)?|as\s+long\s+as|so\s+long\s+as|only\s+if)\b/iu.test(prefix)
    || /^(?:(?:如果|假如|若|若是|倘若|倘使|要是|除非|只要|每当|一旦)[^。！？；]*|在[^，。！？；]{1,48}(?:的)?(?:条件|前提)下[，,]?[^。！？；]*|只有[^。！？；]{1,48}[，,][^。！？；]{0,32}才[^。！？；]*)$/u.test(prefix);
  const englishConditionalSuffix = /\b(?:only\s+if|if|unless|whenever|in\s+case|in\s+the\s+event\s+that|on\s+condition\s+that|subject\s+to|provided(?:\s+that)?|providing(?:\s+that)?|assuming(?:\s+that)?|supposing(?:\s+that)?|as\s+long\s+as|so\s+long\s+as)\b[^.!?;]*[.!?;]?\s*$/iu.test(suffix)
    && !/\bas\s+if\b[^.!?;]*[.!?;]?\s*$/iu.test(suffix);
  const conditionalSuffix = englishConditionalSuffix
    || /(?:如果|假如|若|若是|倘若|倘使|要是|除非|只要|每当|一旦)[^。！？；]*[。！？；]?\s*$/u.test(suffix);
  if (conditionalPrefix || conditionalSuffix) return "nonactual";
  if (/\b(?:must|should|ought\s+to|has\s+to|have\s+to|had\s+to|needs?\s+to|required\s+to)\s*$/iu.test(prefix)
    || /(?:必须|应该|应当|需要|需|务必|理应)\s*$/u.test(prefix)) return "nonactual";
  const actualizingGovernor = /\b(?:do|does|did)\s*$|\b(?:did\s+not|didn[’']t|never)\s+(?:fail|hesitate|flinch|pause|waver|wait)\s+to\s*$|\b(?:could\s+not|couldn[’']t)\s+(?:help|avoid)\b[^.!?;]*$|\b(?:managed|succeeded)\s+(?:to|in)\s*$|\b(?:finish(?:es|ed)?|complet(?:e|es|ed))\s*$/iu.test(prefix);
  const progressiveGovernor = /(?:\b(?:am|is|are|was|were|kept|continued)\s*)$/iu.test(prefix) && /ing$/iu.test(predicate.text);
  const pluralBarePresent = !/(?:ing|ed|es|s)$/iu.test(predicate.text)
    && (/\b(?:I|we|you|they)\s*$/iu.test(prefix)
      || actorAliases.some((alias) => /(?:s|people|folk)$/iu.test(alias) && exactAliasOccurrences(prefix, alias).some((mention) => /^\s*$/u.test(prefix.slice(mention.end)))));
  if (!allowNonFinite && /[A-Za-z]/u.test(predicate.text) && !englishFinite(predicate.text) && !actualizingGovernor && !progressiveGovernor && !pluralBarePresent) return "nonactual";
  if (/(?:的)?(?:计划|提案|设想|假设)[^。！？；]{0,32}(?:被取消|被放弃|取消了?|放弃了?|只是设想|仅是设想|纯属假设)|(?:只是|仅是|纯属)(?:计划|设想|假设)/u.test(suffix)
    || /\b(?:was|were|is|are)\s+(?:only|merely)\s+(?:a\s+)?(?:plan|proposal|possibility|hypothesis)|\bwas\s+hypothetical\b/iu.test(suffix)) return "nonactual";
  if (!factualBreak && (printedTextContainerScope(prefix)
    || /(?:\b(?:placard|banner|label|sign|caption|notice|screen|interface|book|manual|sentence|passage|words?|text)\b[^.!?;]{0,56}\b(?:reads?|says?|shows?|showed|displays?|displayed|describes?|described|depicts?|depicted|contains?|contained)\b[^.!?;]*$|(?:标牌|横幅|标签|告示|屏幕|界面|书|手册|句子|段落|文字)(?:上|中|里)?[^。！？；]{0,36}(?:写着|显示|描述|描绘|记载|包含)[^。！？；]*$)/iu.test(prefix))) return "nonactual";
  if (!factualBreak && (/^\s*(?:the\s+)?(?:sentence|passage|words?|text)\b[^.!?;]*\b(?:appeared|was\s+(?:written|printed|shown|displayed|described))\b[^.!?;]*\b(?:book|label|placard|banner|manual|screen)\b/iu.test(sentence.text)
    || /^\s*(?:这)?(?:句话|句子|段落|文字)[^。！？；]*(?:出现|写|印|显示|记载)在[^。！？；]*(?:书|标签|标牌|横幅|手册|屏幕)/u.test(sentence.text))) return "nonactual";
  if (/^\s+[^.!?;]{0,96}\b(?:was|were|is|are)\s+(?:written|printed|shown|displayed|described)\s+(?:on|in)\s+(?:a|the)?\s*(?:label|placard|banner|book|manual|screen)\b/iu.test(suffix)
    || /^\s*[^。！？；]{0,72}(?:被)?(?:写|印|显示|记载)在(?:标签|标牌|横幅|书|手册|屏幕)(?:上|中|里)/u.test(suffix)) return "nonactual";
  if (/\b(?:cancelled|canceled|abandoned|dropped|discarded|scrapped)\s+(?:the\s+)?plan\b[^.!?。！？]{0,80}[;；.]\s*(?:in\s+it|in\s+which|within\s+it)\b[^.!?。！？]*$/iu.test(crossBoundaryPrefix) || /(?:放弃|取消|抛弃|搁置|撤销)(?:了)?计划[^。！？]{0,80}[；。]\s*(?:其中|计划中)[^。！？]*$/u.test(crossBoundaryPrefix)) return "nonactual";
  if (/(?:放弃|取消|抛弃|搁置|否决|打消|撤销)(?:了)?[^，。！？；]{0,36}$/u.test(prefix) && /^[^，。！？；]{0,36}的计划/u.test(suffix)) return "nonactual";
  if (/\b(?:wrote|described|recorded|drafted)\s+(?:the\s+)?plan\b[^.!?]{0,12}[.]\s*(?:step\s+(?:one|1)|first)\s*:/iu.test(crossBoundaryPrefix) || /(?:写下|描述|记录|起草)(?:了)?计划[^。！？]{0,12}。\s*(?:第一步|步骤一|首先)[:：]/u.test(crossBoundaryPrefix)) return "nonactual";
  if (!factualBreak && /(?:\b(?:banner|label|sign|placard|caption|manual|book|notice|interface|screen)\b[^.!?;]{0,28}\b(?:reads?|says?|shows?|describes?|displays?)\b[^.!?;]*$|(?:横幅|标签|标牌|字幕|手册|书|告示|界面|屏幕)(?:上)?(?:写着|显示|描述|声称)[^。！？；]*$)/iu.test(prefix)) return "nonactual";
  if (activeDreamContainer(source, predicate.start, actorAliases) || postposedNonActualContainer(source, sentence, predicate)) return "nonactual";
  if (/^\s*(?:if|unless|whenever|in\s+case|on\s+condition\s+that|provided(?:\s+that)?|providing(?:\s+that)?|assuming(?:\s+that)?|supposing(?:\s+that)?|as\s+long\s+as)\b[^.!?;]*$/iu.test(prefix)
    || /^(?:如果|假如|若|若是|倘若|除非|只要|每当|一旦)[^。！？；]*$/u.test(prefix)) return "nonactual";
  if (!factualBreak && (/^\s*(?:according\s+to\s+(?!(?:(?:the\s+)?(?:plan|rules|schedule|instructions?|protocol|procedure))\b)[^,，]{1,64}[,，]|(?:reportedly|supposedly|purportedly|ostensibly|allegedly)\b[,，]?)\s*[^.!?;]*$/iu.test(prefix)
    || /^(?:(?:据传|据悉|传言(?:称)?)[，,]?|(?:据|按照)[^，。！？；]{1,24}(?:说|所说|说法|记载|报告|报道|回忆)[，,]?)[^。！？；]*$/u.test(prefix))) return "nonactual";
  const belief = [...prefix.matchAll(/\b(?:believes?|believed|thinks?|thought|supposes?|supposed|assumes?|assumed|suspects?|suspected)\b|(?:相信|认为|以为|猜想|推测)/giu)].at(-1);
  if (belief) {
    const tail = prefix.slice(belief.index! + belief[0].length);
    const factualBreak = /(?:,\s*(?:but|instead|then|actually)\b|(?:，|,)(?:但|但是|却|反而|随后|然后|事实上|实际(?:上)?|尘埃散去))/iu.test(tail);
    if (!factualBreak) return "nonactual";
  }
  const nonSimileDreamPrefix = prefix.replace(/\b(?:as\s+if|like)\s+(?:in\s+)?(?:(?:a|the)\s+)?(?:dream|nightmare|simulation|hallucination|vision|illusion)\b/giu, "");
  if (/\b(?:dreamed|dreamt|imagined|predicted)\b[^.!?;]{0,40}\b(?:that|where)\b[^.!?;]*$/iu.test(nonSimileDreamPrefix)) return "nonactual";
  if (/\b(?:dream|simulation|prediction|prophecy)\b[^.!?;]{0,48}\b(?:that|where|in\s+which|of\s+how)\b[^.!?;]*$/iu.test(nonSimileDreamPrefix) || /(?:梦境|模拟|预测|预言)[^。！？；]{0,32}(?:中|里|称|说|内容)[^。！？；]*$/u.test(nonSimileDreamPrefix)) return "nonactual";
  if (/\b(?:dream(?:s|ed|t|ing)?|imagin(?:e|es|ed|ing)?|predict(?:s|ed|ing)?|pretend(?:s|ed|ing)?|simulate(?:s|d|ing)?)\b[^.!?;]*$|(?:做梦|梦见|想象|幻想|预测|预言|假装|模拟)[^。！？；]*$/iu.test(nonSimileDreamPrefix)) {
    const complement = /\b(?:dream(?:s|ed|t|ing)?|imagin(?:e|es|ed|ing)?|predict(?:s|ed|ing)?|simulate(?:s|d|ing)?)\b[^.!?;]{0,24}\b(?:that|where)\b/iu.exec(nonSimileDreamPrefix);
    if (complement) {
      const tail = nonSimileDreamPrefix.slice(complement.index + complement[0].length);
      const explicitClose = /\b(?:the\s+)?(?:dream|simulation|prediction)\s+(?:ended|stopped|collapsed|broke|dissolved|faded)\b/iu.test(tail)
        || actorAliases.some((alias) => new RegExp(`\\b${escapeRegex(alias)}\\s+(?:woke|awoke)\\s+from\\s+(?:the\\s+)?(?:dream|simulation)\\b`, "iu").test(tail));
      if (!explicitClose) return "nonactual";
    }
    const independentContinuation = /[,，]\s*(?:then|but|instead|actually|随后|然后|却|反而)[^.!?;。！？；]*$/iu.test(prefix) && (englishFinite(predicate.text) || /了/u.test(prefix.slice(Math.max(0, lastConnectorStart(prefix)))));
    if (!independentContinuation && !/(?:\b(?:dream|simulation)\s+(?:ended|stopped|dissolved|faded)\b|\b(?:woke|awoke)\s+from\b|(?:梦境|模拟)(?:结束|消散)|(?:醒来|苏醒))[^.!?;。！？；]*$/iu.test(prefix)) return "nonactual";
  }
  if (reportScope(prefix, sentence.text, predicate, subject)) return "nonactual";
  if (planOrAttemptScope(prefix, predicate)) return "nonactual";
  const controlledLocal = prefix.slice(Math.max(0, lastConnectorStart(prefix)));
  const failedControl = /(?:\b(?:failed|fails)\s+to|\b(?:was|were|is|are)\s+(?:forbidden|prevented|ordered|asked|told|allowed|scheduled|expected|about)\s+to|\b(?:avoided?|denied|considered?)\s+|\b(?:refrained?)\s+from\s+|\b(?:declined|promised)\s+to\s+|\b(?:began|started)\s+to|\bit\s+is\s+false\s+that\s+(?:[A-Z][\w'’-]*\s+)?)\s*$/iu.test(controlledLocal);
  if (failedControl && !/\b(?:did\s+not|didn[’']t|never)\s+fail\s+to\s*$/iu.test(controlledLocal)) return "nonactual";
  if (/\b(?:almost|nearly|all\s+but|merely|allegedly|reportedly|purportedly|ostensibly|supposedly|apparently|seemingly|perhaps|maybe|possibly|probably)\s*$/iu.test(prefix) || /(?:险些|差点|差一步|几乎|差一点|据称|据说|疑似|貌似|号称|看似|似乎|仿佛|本可|眼看就要)[^，。！？；]{0,12}$/u.test(prefix)) return "nonactual";
  if ((/\b(?:would|might|may|could|must|should)\s+(?:\w+\s+){0,2}$/iu.test(prefix) && !/\bcould\s+not\s+(?:avoid|help)\b[^.!?;]*$/iu.test(prefix)) || /(?:如果|假如|若是|倘若|只要|除非)[^，。！？；]*$/u.test(prefix)) return "nonactual";
  if (/\b(?:will|shall)\s+(?:\w+\s+){0,2}$/iu.test(prefix) || /\b(?:is|are|was|were)\s+going\s+to\s*$/iu.test(prefix) || /(?:将会?|即将|会)\s*$/u.test(prefix)) return "nonactual";
  const localStart = lastConnectorStart(prefix);
  const englishLocal = localStart >= 0 ? prefix.slice(localStart) : prefix;
  const englishPolarityPrefix = /\b(?:[A-Z][A-Za-z0-9'’-]*|he|she|they|we|I|you)\b/gu.test(englishLocal) ? englishLocal : prefix;
  if (englishNegationGoverns(englishPolarityPrefix, predicate.text) || chineseNegationGoverns(prefix)) return "negated";
  if (/^\s*(?:failed|fails|never\s+came|did\s+not\s+come|was\s+not\s+achieved|未能实现|并未到来)/iu.test(suffix)) return "negated";
  return undefined;
}

function englishNegationGoverns(prefix: string, surface: string): boolean {
  let local = prefix.slice(-140).toLocaleLowerCase();
  if (/\b[a-z][a-z0-9'’-]*(?:\s+[a-z][a-z0-9'’-]*)*(?:\s*,\s*|\s*[—–-]\s*)not\s+[a-z][a-z0-9'’-]*(?:\s+[a-z][a-z0-9'’-]*)*(?:\s*,\s*|\s*[—–-]\s*)$/u.test(local)) return false;
  if (/,\s*without\b[^,]{1,64},\s*$/u.test(local)) return false;
  if (/\bnot\s+only\b/u.test(local) || /\b(?:did\s+not|never)\s+fail\s+to\s*$/u.test(local) || /\b(?:could\s+not|couldn[’']t)\s+(?:help|avoid)\b[^,.;!?]*$/u.test(local) || /\bdid\s+not\s+(?:hesitate|flinch|pause|waver|wait)\s+to\s*$/u.test(local)) return false;
  const negations = [...local.matchAll(/\b(?:not|never|neither|nor|cannot|can[’']t|couldn[’']t|isn[’']t|aren[’']t|wasn[’']t|weren[’']t|doesn[’']t|don[’']t|didn[’']t|won[’']t|without|unable\s+to|refused\s+to)\b/gu)];
  if (!negations.length) return false;
  const last = negations.at(-1)!; const after = local.slice(last.index! + last[0].length);
  if (last[0] === "without" && /^[^,]{1,160},\s*(?:[a-z][a-z0-9'’-]*ly\s*)*$/u.test(after)) return false;
  if (/\b(?:but|instead|actually)\b/u.test(after)) return false;
  if (/\band\b/u.test(after) && englishFinite(surface)) return false;
  return true;
}

const affirmativeChineseNegation = /(?:不是没有|并非没有|绝非没有|未尝没有|没有不|未曾不|未尝不|不得不|不得已|不能不|不会不|不可不|不能说[^，。！？；]{0,24}没有|不能否认|并不是说[^，。！？；]{0,24}没有|不可能不|不由得|不禁|忍不住|按捺不住|情不自禁|迫不及待|不假思索|不慌不忙|不紧不慢|不卑不亢|不动声色|不约而同|不费吹灰之力|不露声色|不顾一切|不遗余力|不惜代价|毫不(?:犹豫|迟疑|费力|畏惧|在意|示弱|留情|客气)|战无不胜|无坚不摧|无所不能)/u;
function chineseNegationGoverns(prefix: string): boolean {
  const comma = Math.max(prefix.lastIndexOf("，"), prefix.lastIndexOf(","));
  const local = prefix.slice(comma >= 0 ? comma + 1 : Math.max(0, prefix.length - 120));
  if (affirmativeChineseNegation.test(local)) return false;
  const negations = [...local.matchAll(/(?:并非|并不是|绝非|不是|尚未|从未|未曾|不曾|未能|没有|并没|没能|没|未|不)/gu)];
  if (!negations.length) return false;
  const last = negations.at(-1)!; const after = local.slice(last.index! + last[0].length);
  if (/^[^，。！？；]{0,24}地\s*$/u.test(after)) return false;
  if (/(?:反而|而是|却)[^，。！？；]*$/u.test(after)) return false;
  if (/^(?:有)?[^，。！？；]{1,12}并[^，。！？；]{0,12}$/u.test(after) && !/^(?:能|能够)/u.test(after) && !/未能/u.test(last[0])) return false;
  return true;
}

function validDirectObject(source: string, sentence: TextRange, predicate: Occurrence, object: Occurrence): boolean {
  const compoundTail = (tail: string): boolean => {
    if (/[A-Za-z]/u.test(object.text)) {
      const next = /^\s+([A-Za-z][A-Za-z'’-]*)/u.exec(tail)?.[1];
      if (!next) return false;
      return !/^(?:and|or|but|then|so|therefore|thus|which|that|who|has|have|had|was|were|is|are|be|been|being|for|with|after|before|when|while|as|because|since|although|though|whereas|if|unless|secure(?:s|d|ing)?|achiev(?:e|es|ed|ing)|gain(?:s|ed|ing)?|earn(?:s|ed|ing)?|claim(?:s|ed|ing)?|win(?:s|ning)?|won|bring(?:s|ing)?|brought|ensure(?:s|d|ing)?|deliver(?:s|ed|ing)?|produce(?:s|d|ing)?|yield(?:s|ed|ing)?|lead(?:s|ing)?|led|cause(?:s|d|ing)?|result(?:s|ed|ing)?)$/iu.test(next);
    }
    const compact = tail.replace(/^\s+/u, "");
    if (!/^[\p{Script=Han}]/u.test(compact)) return false;
    return !/^(?:了|着|过)?(?:[，。！？；]|被|由|让|并|且|又|也|便|就|随后|然后|接着|继而|从而|因此|所以|于是|由此|因而|随即|终于|后|之后|取得|赢得|获得|迎来|实现|确保|带来|换来|达成|得到|收获|宣告|完成|拿下|导致|造成|引发|产生|使得|令)/u.test(compact);
  };
  if (object.start < predicate.start) {
    const beforeObject = source.slice(sentence.start, object.start);
    const between = source.slice(object.end, predicate.start);
    const compactBetween = between.trim();
    const chineseMannerBridge = !compactBetween
      || !compactBetween.replace(chineseLeadingNoise, "").trim()
      || /^(?:彻底|完全|充分|逐步|逐渐|渐渐|轻轻|重重|稳稳|慢慢|快速|飞快)$/u.test(compactBetween)
      || /^[^，。！？；]{1,12}地$/u.test(compactBetween);
    const disposal = /(?:把|将)[^，。！？；]{0,20}$/u.test(beforeObject)
      && chineseMannerBridge;
    if (disposal) return true;
    if (/[A-Za-z]/u.test(object.text)) {
      const subjectHead = "(?:(?:Captain|Lady|Lord|Doctor|Dr\\.?|Sir)\\s+)?[A-Z][A-Za-z0-9'’-]*(?:\\s+[A-Z][A-Za-z0-9'’-]*)*|he|she|they";
      const topicalized = /^\s*(?:(?:the|a|an|this|that)\s+)?$/iu.test(beforeObject)
        && new RegExp(`^\\s*,\\s*(?:${subjectHead})\\s*$`, "iu").test(between);
      const cleft = /^\s*(?:it|this|that)\s+(?:was|is)\s+(?:(?:the|a|an)\s+)?$/iu.test(beforeObject)
        && new RegExp(`^\\s+that\\s+(?:${subjectHead})\\s*$`, "iu").test(between);
      if (topicalized || cleft) return true;
    }
    if (compoundTail(between)) return false;
    if (/[A-Za-z]/u.test(predicate.text)) {
      const afterPredicate = source.slice(predicate.end, sentence.end);
      return /\b(?:(?:has|have|had)\s+been|am|is|are|was|were|be|been|being)\s+(?:[A-Za-z][A-Za-z'’-]*ly\s+){0,3}$/iu.test(between)
        && /^\s*(?:[A-Za-z][A-Za-z'’-]*ly\s+){0,3}by\s+(?:(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|her|him|them)\b/iu.test(afterPredicate)
        && !/[.!?;,]/u.test(beforeObject);
    }
    const passive = /^\s*(?:被|由)[^，。！？；]{1,24}\s*$/u.test(between);
    return passive;
  }
  const rawBetween = source.slice(predicate.end, object.start);
  const boundedParenthetical = /^\s*,\s*[^,;.!?\n]{1,64},\s*/u.exec(rawBetween);
  const between = boundedParenthetical ? rawBetween.slice(boundedParenthetical[0].length) : rawBetween;
  if (object.start - predicate.end > 96 || /[,;，；]/u.test(between)) return false;
  if (/\b(?:no|neither|nothing|something|anything)\b|\bother\s+than\b/iu.test(between)) return false;
  if (/\b(?:fake|false|counterfeit|mock|imitation|replica|model|supposed|alleged)\s+(?:(?:old|new|small|large|wooden|stone|metal)\s+)*$/iu.test(between)
    || /(?:假(?:的)?|虚假(?:的)?|伪造(?:的)?|仿制(?:的)?|模型(?:中的)?|所谓(?:的)?)\s*$/u.test(between)) return false;
  if (/\b(?:and|or|but|then|while|whereas|after|before|when|once|because|although|though|as|about|of|in|on|upon|inside|within|outside|against|through|at|to|into|onto|from|with|for|by|over|under|past|across|overlooking|beside|near|behind|beyond|around|toward|towards|depicting|showing|facing|containing|concealing|hiding|holding|bearing|blocking|shielding|obstructing|revealing|painted\s+with|next\s+to|in\s+front\s+of)\b|(?:并且|然后|随后|却|而|同时|当|因为|虽然|通过|通往|朝|向|对|从|在|给|为了|关于|描绘|绘有|画着|装着|含有|藏着|藏有|容纳|内有|刻着|写着|面对|旁边|附近|之后|之前|身后|周围|朝向)/iu.test(between)) return false;
  if (/\b(?:a|an|the|this|that|her|his|their)\s+[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,3}\s+(?:that|which|who)\b/iu.test(between)) return false;
  if (/\b(?:a|an|the|this|that|her|his|their)\s+(?:[A-Za-z][A-Za-z'’-]*\s+){1,4}[A-Za-z][A-Za-z'’-]*(?:ing|ed)\s+(?:(?:a|an|the)\s+)?$/iu.test(between)) return false;
  if (/[A-Za-z]/u.test(object.text) && !/^\s*(?:(?:[A-Za-z][A-Za-z'’-]*|\d+)\s+)*$/u.test(between)) return false;
  const afterObject = source.slice(object.end, Math.min(sentence.end, object.end + 36));
  if (compoundTail(afterObject)) return false;
  if (/[A-Za-z]/u.test(object.text) && /^\s+(?:model|replica|copy|portrait|image|picture|toy|miniature|facsimile)\b/iu.test(afterObject)) return false;
  if (/[\p{Script=Han}]/u.test(object.text)) {
    if (between.length > 28 || /(?:走|跑|喊|说|看|听|经过|穿过|越过|来到|靠近|阻挡|遮挡|藏着|位于|摆在)/u.test(between)) return false;
    const after = source.slice(object.end, Math.min(sentence.end, object.end + 24));
    if (/^(?:(?:旁|边|附近|周围|形状|样式|图案|外观|模型)?的[\p{Script=Han}]{1,12}|(?:的)?(?:模型|复制品|画像|画卷|书籍|雕像|玩具|照片|图案))/u.test(after)) return false;
  }
  return true;
}

function predicateSubject(source: string, sentence: TextRange, predicate: Occurrence, aliases: readonly string[]): SubjectResolution {
  if (/[A-Za-z]/u.test(predicate.text) && /\b(?:(?:has|have|had)\s+been|am|is|are|was|were|be|been|being)\s+(?:[A-Za-z][A-Za-z'’-]*ly\s+){0,3}$/iu.test(source.slice(sentence.start, predicate.start))) {
    const suffix = source.slice(predicate.end, sentence.end);
    const agentPronoun = /^\s*(?:[A-Za-z][A-Za-z'’-]*ly\s+){0,3}by\s+(her|him|them)\b/iu.exec(suffix);
    if (agentPronoun) return discourseSubjectBefore(source, sentence.start, aliases);
    const agent = /^\s*(?:[A-Za-z][A-Za-z'’-]*ly\s+){0,3}by\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)\b/iu.exec(suffix)?.[1];
    if (agent) return aliases.some((alias) => alias.toLocaleLowerCase() === agent.toLocaleLowerCase()) ? { kind: "expected", text: agent } : { kind: "foreign", text: agent };
  }
  if (/[\p{Script=Han}]/u.test(predicate.text)) {
    const passivePrefix = source.slice(sentence.start, predicate.start);
    if (!/(?:不由得|身不由己)\s*$/u.test(passivePrefix)) {
      const passiveAlias = aliases.find((alias) => new RegExp(`(?:被|由)\\s*${escapeRegex(alias)}(?:\\s*|(?:一脚|一剑|一拳|一掌|一刀|亲手|轻易|猛地|迅速|缓缓|果断地?)\\s*)*$`, "u").test(passivePrefix));
      if (passiveAlias) return { kind: "expected", text: passiveAlias };
      const passiveAgent = /(?:被|由)\s*([\p{Script=Han}]{1,12})(?:(?:一脚|一剑|一拳|一掌|一刀|亲手|轻易|猛地|迅速|缓缓|果断地?)\s*)*$/u.exec(passivePrefix)?.[1];
      if (passiveAgent) return { kind: "foreign", text: passiveAgent };
    }
  }
  const direct = resolveSubject(source, sentence, predicate, aliases);
  const localPrefix = source.slice(sentence.start, predicate.start).trim();
  if (direct.kind !== "expected" && (/^(?:he|she|they)$/iu.test(localPrefix) || /^(?:他|她|他们|她们)$/u.test(localPrefix)) && sentence.start > 0) {
    const discourse = discourseSubjectBefore(source, sentence.start, aliases);
    if (discourse.kind === "expected") return discourse;
  }
  if (direct.kind !== "expected") {
    const rawPrefix = source.slice(sentence.start, predicate.start);
    const localAt = lastConnectorStart(rawPrefix);
    const localPronoun = /(?:他|她|他们|她们)\s*$/u.exec(rawPrefix.slice(Math.max(0, localAt)));
    if (localPronoun) {
      const absolute = sentence.start + Math.max(0, localAt) + localPronoun.index;
      const discourse = discourseSubjectBefore(source, absolute, aliases);
      if (discourse.kind === "expected") return discourse;
    }
  }
  return direct;
}

function participantMentionNamesContainer(source: string, sentence: TextRange, mention: Occurrence): boolean {
  const before = source.slice(Math.max(sentence.start, mention.start - 72), mention.start);
  const after = source.slice(mention.end, Math.min(sentence.end, mention.end + 72));
  const englishContainer = "portrait|statue|image|painting|picture|replica|model|clone|copy|envoy|avatar|puppet|namesake|double|impersonator|impostor|proxy|delegate|shadow";
  return new RegExp(`\\b(?:${englishContainer})\\s+of\\s*$`, "iu").test(before)
    || new RegExp(`^\\s*[’']s\\s+(?:${englishContainer})\\b`, "iu").test(after)
    || /(?:画像|雕像|画卷|照片|模型|复制品|克隆体|分身|使者|使节|替身|傀儡|冒牌货|代理人)(?:中的|里的|上(?:的)?)?\s*$/u.test(before)
    || /^\s*的(?:画像|雕像|画卷|照片|模型|复制品|克隆体|分身|使者|使节|替身|傀儡|冒牌货|代理人)/u.test(after);
}

function opponentParticipatesInConflict(input: NarrativeRealizationInput, sentence: TextRange, predicate: Occurrence, opponent: Occurrence): boolean {
  if (opponent.start < sentence.start || opponent.start >= sentence.end
    || quoteDepthAt(input.source, opponent.start) > 0
    || participantMentionNamesContainer(input.source, sentence, opponent)) return false;
  if (opponent.start < predicate.start) {
    const relation = input.source.slice(Math.max(sentence.start, opponent.start - 32), predicate.start);
    return /\b(?:against|versus|facing|confronting)\b[^.!?;]{0,64}$/iu.test(relation) || /(?:对阵|迎战|面对|挑战)[^，。！？；]{0,36}$/u.test(relation);
  }
  const between = input.source.slice(predicate.end, opponent.start);
  if (/\b(?:against|versus)\s+(?:the\s+)?$/iu.test(between) || /(?:对阵|迎战|面对|挑战)[^，。！？；]{0,8}$/u.test(between)) return true;
  if (validDirectObject(input.source, sentence, predicate, opponent)) return true;
  const after = input.source.slice(opponent.end, Math.min(sentence.end, opponent.end + 64));
  if (/^[’']s\s+/u.test(after) && input.binding.object && termOccurrences(after, input.binding.object).some((mention) => mention.start < 48)) return true;
  if (/\b(?:controlled|commanded|summoned|sent|owned|led)\s+by\s*$/iu.test(between) || /(?:受|由)[^，。！？；]{0,8}(?:控制|指挥|召唤|派遣|率领)\s*$/u.test(between)) return true;
  return false;
}

function resultPredicateBefore(source: string, sentence: TextRange, action: Occurrence, effect: Occurrence): Occurrence | undefined {
  const start = Math.max(sentence.start, action.end);
  const segment = source.slice(start, effect.start);
  const english = [...segment.matchAll(englishToken)]
    .map((match) => ({ start: start + match.index!, end: start + match.index! + match[0].length, text: match[0] }))
    .filter((candidate) => /^(?:secure(?:s|d)?|securing|achiev(?:e|es|ed|ing)|gain(?:s|ed|ing)?|earn(?:s|ed|ing)?|claim(?:s|ed|ing)?|win(?:s|ning)?|won|bring(?:s|ing)?|brought|ensure(?:s|d|ing)?|deliver(?:s|ed|ing)?|produce(?:s|d|ing)?|yield(?:s|ed|ing)?|obtain(?:s|ed|ing)?|attain(?:s|ed|ing)?|receive(?:s|d|ing)?|grant(?:s|ed|ing)?|award(?:s|ed|ing)?|give(?:s|n|ing)?|gave|lead(?:s|ing)?|led|cause(?:s|d|ing)?|result(?:s|ed|ing)?)$/iu.test(candidate.text))
    .at(-1);
  if (english) return english;
  const chinese = [...segment.matchAll(/(?:取得|赢得|获得|迎来|实现|确保|带来|换来|达成|得到|收获|宣告|完成|拿下|发放|授予|颁发|送出|交付|提供|给予|给)/gu)].at(-1);
  return chinese ? { start: start + chinese.index!, end: start + chinese.index! + chinese[0].length, text: chinese[0] } : undefined;
}

function passiveOutcomeAgentMatches(source: string, sentence: TextRange, effect: Occurrence, actorAliases: readonly string[]): boolean | undefined {
  const suffix = source.slice(effect.end, sentence.end);
  const match = /^\s+(?:(?:has|have|had)\s+been|was|were|is|are)\s+(?:secure(?:d)?|achieved|gained|earned|claimed|won)\s+by\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|her|him|them)\b/iu.exec(suffix);
  if (!match) return undefined;
  const agent = match[1]!;
  if (actorAliases.some((alias) => alias.toLocaleLowerCase() === agent.toLocaleLowerCase())) return true;
  if (/^(?:her|him|them)$/iu.test(agent)) {
    return discourseSubjectBefore(source, sentence.start, actorAliases).kind === "expected";
  }
  return false;
}

type ActorGender = "feminine" | "masculine";

function inferredActorGender(actorAliases: readonly string[]): ActorGender | undefined {
  const aliases = actorAliases.map((alias) => alias.normalize("NFKC").trim().toLocaleLowerCase());
  if (aliases.some((alias) => /^(?:she|her|hers|herself)\b|\b(?:lady|dame|miss|mrs\.?|ms\.?)\b/u.test(alias))) return "feminine";
  if (aliases.some((alias) => /^(?:he|him|his|himself)\b|\b(?:lord|sir|mr\.?)\b/u.test(alias))) return "masculine";
  const personalNames = aliases.map((alias) => alias.replace(/^(?:captain|doctor|dr\.?)\s+/u, "").split(/\s+/u).at(-1) ?? "");
  if (personalNames.some((name) => /^(?:aria|mia|anna|emma|ella|sophia|olivia|ava|isabella|amelia|alice|clara|elena|luna|sara|sarah|nora|maya|maria)$/u.test(name))) return "feminine";
  if (personalNames.some((name) => /^(?:bob|alex|james|john|jack|william|henry|george|robert|michael|david|daniel|thomas|charles|edward|arthur|rook)$/u.test(name))) return "masculine";
  return undefined;
}

function genderedReferenceMatchesActor(reference: string, actorAliases: readonly string[]): boolean {
  const expected = /^(?:her|hers|herself)$/iu.test(reference) ? "feminine"
    : /^(?:his|him|himself)$/iu.test(reference) ? "masculine"
      : undefined;
  return expected === undefined || inferredActorGender(actorAliases) === expected;
}

function outcomeHasForeignBeneficiary(prefix: string, suffix: string, actorAliases: readonly string[]): boolean {
  const thirdPersonReflexive = /^(?:herself|himself)$/iu;
  const duration = /^\s+for\s+(?:good|years?|months?|weeks?|days?|hours?|the\s+first\s+time|a\s+moment)\b/iu.test(suffix);
  const patterns = duration ? [] : [
    /^\s+for\s+(?:(?:the|a|an)\s+)?((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Za-z][A-Za-z0-9'’-]*(?:\s+[A-Za-z][A-Za-z0-9'’-]*){0,3})\b/iu,
    /^\s+on\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Za-z][A-Za-z0-9'’-]*(?:\s+[A-Za-z][A-Za-z0-9'’-]*){0,2})[’']s\s+behalf\b/iu,
    /^\s+on\s+behalf\s+of\s+(?:(?:the|a|an)\s+)?((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Za-z][A-Za-z0-9'’-]*(?:\s+[A-Za-z][A-Za-z0-9'’-]*){0,3})\b/iu,
    /^\s+in\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Za-z][A-Za-z0-9'’-]*(?:\s+[A-Za-z][A-Za-z0-9'’-]*){0,2})[’']s\s+name\b/iu,
    /^\s+to\s+(?:(?:the|a|an)\s+)?((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Za-z][A-Za-z0-9'’-]*(?:\s+[A-Za-z][A-Za-z0-9'’-]*){0,3})\b/iu,
  ];
  const beneficiary = patterns.map((pattern) => pattern.exec(suffix)?.[1]).find((value): value is string => !!value);
  if (beneficiary && thirdPersonReflexive.test(beneficiary)) return !genderedReferenceMatchesActor(beneficiary, actorAliases);
  if (beneficiary && !actorAliases.some((alias) => alias.toLocaleLowerCase() === beneficiary.toLocaleLowerCase())) return true;
  if (/\b(?:my|your|our)\s*$/iu.test(prefix)) return true;
  const possessor = /\b((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|[a-z][a-z0-9'’-]*)[’']s\s*$/u.exec(prefix)?.[1]
    ?? /\b([a-z][a-z0-9'’-]*s)[’']\s*$/u.exec(prefix)?.[1];
  if (possessor && !actorAliases.some((alias) => alias.toLocaleLowerCase() === possessor.toLocaleLowerCase())) return true;
  const postOwner = /^\s+(?:of|belonging\s+to)\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)\b/iu.exec(suffix)?.[1];
  return !!postOwner && !actorAliases.some((alias) => alias.toLocaleLowerCase() === postOwner.toLocaleLowerCase());
}

function outcomeHasLaterForeignOwner(source: string, effect: Occurrence, actorAliases: readonly string[]): boolean {
  const tail = source.slice(effect.end, Math.min(source.length, effect.end + 240));
  const englishOwner = /(?:^|[.!?;]\s*)(?:(?:the|this|that)\s+)?victory\s+(?:(?:ultimately|eventually|finally|actually|instead)\s+)*(?:belongs?|belonged|went|accrued)\s+to\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)\b/iu.exec(tail)?.[1];
  if (englishOwner && !aliasIdentity(actorAliases, englishOwner)) return true;
  const chineseOwner = /(?:^|[。！？；]\s*)(?:(?:这场|该场|这次|该次)?胜利)\s*(?:(?:最终|后来|其实|反而|却)\s*)*(?:属于|归于?|归属|落到)\s*([\p{Script=Han}]{1,12}?)(?:所有)?(?=[，,。！？；]|$)/u.exec(tail)?.[1];
  return !!chineseOwner && !actorAliases.some((alias) => chineseOwner.endsWith(alias) || alias.endsWith(chineseOwner));
}

function actorOwnedMechanicEffect(source: string, sentence: TextRange, effect: Occurrence, actorAliases: readonly string[]): boolean {
  const rawPrefix = source.slice(sentence.start, effect.start);
  let prefix = rawPrefix;
  for (const alias of actorAliases) prefix = prefix.replace(new RegExp(escapeRegex(alias), "giu"), "ACTOR");
  const carrier = "(?:quest\\s+|status\\s+|skill\\s+)?(?:system|mechanic|mechanism|panel|interface|module|ability|device|artifact|relic|contract|protocol)";
  const transition = "(?:(?:as\\s+a\\s+result|therefore|thus|consequently|then|immediately)\\s*,?\\s*)?";
  const owned = new RegExp(`^\\s*${transition}(?:ACTOR[’']s|(her|his|their))\\s+${carrier}\\b[^.!?;]{0,72}$`, "iu").exec(prefix);
  if (owned) {
    const pronoun = owned[1];
    const gender = inferredActorGender(actorAliases);
    if (pronoun && gender && !genderedReferenceMatchesActor(pronoun, actorAliases)) return false;
    return true;
  }
  const causalCarrier = new RegExp(`^\\s*(?:(?:as\\s+a\\s+result|therefore|thus|consequently)\\s*,?\\s*(?:(?:the|a|an|this|that)\\s+)?${carrier}\\b|(?:this|that|doing\\s+so)\\s+(?:caused|made|prompted)\\s+(?:(?:the|a|an)\\s+)?${carrier}\\b)[^.!?;]{0,72}$`, "iu").test(prefix);
  if (causalCarrier) return true;

  const chineseCarrier = "(?:任务|状态|技能)?(?:系统|机制|面板|界面|模块|能力|装置|法器|契约|协议)";
  const chineseOwned = new RegExp(`^\\s*(?:(?:因此|所以|于是|由此|随即|随后|紧接着)[，,]?\\s*)?(?:ACTOR的|他(?:的)?|她(?:的)?|他们的|她们的)${chineseCarrier}[^。！？；]{0,48}$`, "u").test(prefix);
  if (chineseOwned) return true;
  return new RegExp(`^\\s*(?:(?:因此|所以|于是|由此|随即)[，,]?\\s*(?:该|这个|此)?${chineseCarrier}|(?:这|此举)(?:使|让|令|触发)了?(?:该|这个|此)?${chineseCarrier})[^。！？；]{0,48}$`, "u").test(prefix);
}

function mechanicEffectHasForeignRecipient(source: string, sentence: TextRange, effect: Occurrence, actorAliases: readonly string[]): boolean {
  const prefix = source.slice(sentence.start, effect.start);
  const suffix = source.slice(effect.end, sentence.end);
  const verbFrame = [...prefix.matchAll(/\b(?:reward(?:s|ed|ing)?|grant(?:s|ed|ing)?|award(?:s|ed|ing)?|give(?:s|n|ing)?|gave|deliver(?:s|ed|ing)?|issue(?:s|d|ing)?|provid(?:e|es|ed|ing))\s+/giu)].at(-1);
  const recipientTail = verbFrame ? prefix.slice(verbFrame.index! + verbFrame[0].length) : "";
  const englishRecipient = /^((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|[Hh]er|[Hh]im|[Tt]hem)\s+(?:with\s+)?(?:(?:a|an|the|this|that|one|some)\s+)?(?:[a-z][A-Za-z0-9'’-]*\s+){0,4}$/u.exec(recipientTail)?.[1];
  if (englishRecipient) {
    if (aliasIdentity(actorAliases, englishRecipient)) return false;
    if (/^(?:her|him)$/iu.test(englishRecipient)) return !genderedReferenceMatchesActor(englishRecipient, actorAliases);
    if (/^them$/iu.test(englishRecipient)) return !actorAliases.some((alias) => /^(?:they|them|their|theirs|themselves)$/iu.test(alias));
    return true;
  }
  const indirectRecipient = /^(.+?)\s+(?:with\s+)?(?:a|an|the|this|that|one|some|his|her|their|our|your|its)\s+(?:[a-z][A-Za-z0-9'’-]*\s+){0,4}$/u.exec(recipientTail)?.[1]?.trim();
  if (indirectRecipient) {
    if (aliasIdentity(actorAliases, indirectRecipient) || /^(?:the\s+)?(?:protagonist|hero|heroine|main\s+character)$/iu.test(indirectRecipient)) return false;
    return true;
  }
  const passiveRecipient = /^\s*(?:,\s*)?(?:(?:which|that)\s+)?(?:(?:has|have|had)\s+been|was|were|is|are)\s+(?:given|granted|awarded|delivered|issued|provided)\s+to\s+([^,.!?;。！？；]{1,48})/iu.exec(suffix)?.[1]?.trim();
  if (passiveRecipient) {
    if (aliasIdentity(actorAliases, passiveRecipient) || /^(?:the\s+)?(?:protagonist|hero|heroine|main\s+character)$/iu.test(passiveRecipient)) return false;
    if (/^(?:her|him)$/iu.test(passiveRecipient)) return !genderedReferenceMatchesActor(passiveRecipient, actorAliases);
    return true;
  }
  if (/^(?:reward(?:s|ed|ing)?|compensat(?:e|es|ed|ing)|benefit(?:s|ed|ing)?|paid|pays?|paying)$/iu.test(effect.text)) {
    const directRecipient = /^\s+(?:(?:the|a|an)\s+)?((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|her|him|them|(?:[a-z][a-z0-9'’-]*\s+){0,3}[a-z][a-z0-9'’-]*)\b/iu.exec(suffix)?.[1];
    if (directRecipient) {
      if (aliasIdentity(actorAliases, directRecipient) || /^(?:the\s+)?(?:protagonist|hero|heroine|main\s+character)$/iu.test(directRecipient)) return false;
      if (/^(?:her|him)$/iu.test(directRecipient)) return !genderedReferenceMatchesActor(directRecipient, actorAliases);
      if (/^them$/iu.test(directRecipient)) return !actorAliases.some((alias) => /^(?:they|them|their|theirs|themselves)$/iu.test(alias));
      return true;
    }
  }
  const chineseRecipient = /(?:(?:给(?!予)(?:了)?|向|为(?!了)|替)([\p{Script=Han}]{1,12}?))(?:(?:发放|授予|颁发|送出|交付|提供|给予)(?:了)?|(?:一份|一个|这份|该份)?)\s*$/u.exec(prefix)?.[1]
    ?? /(?:授予|颁发给|发放给|送给|交付给|提供给|给予)([\p{Script=Han}]{1,12}?)(?:一份|一个|这份|该份)?\s*$/u.exec(prefix)?.[1];
  if (!chineseRecipient) return false;
  if (actorAliases.some((alias) => chineseRecipient === alias || chineseRecipient.endsWith(alias) || alias.endsWith(chineseRecipient))) return false;
  if (/^(?:她|他)$/u.test(chineseRecipient)) {
    const reference = chineseRecipient === "她" ? "her" : "him";
    return !genderedReferenceMatchesActor(reference, actorAliases);
  }
  if (/^(?:他们|她们)$/u.test(chineseRecipient)) return !actorAliases.some((alias) => /^(?:他们|她们|they|them|their)$/iu.test(alias));
  return true;
}

function crossSentenceHasInterveningEvent(source: string, actionSentence: TextRange, action: Occurrence, actorAliases: readonly string[]): boolean {
  const tail = source.slice(action.end, actionSentence.end);
  const clause = /(?:[,;]|\b(?:and|but|then|while|whereas|afterward|afterwards|meanwhile)\b)\s*([^,;.!?。！？]*)/giu;
  for (const match of tail.matchAll(clause)) {
    const fragment = match[1] ?? "";
    const fragmentStart = action.end + match.index! + match[0].indexOf(fragment);
    for (const token of fragment.matchAll(englishToken)) {
      if (!englishFinite(token[0])) continue;
      const predicate = { start: fragmentStart + token.index!, end: fragmentStart + token.index! + token[0].length, text: token[0] };
      if (predicateSubject(source, actionSentence, predicate, actorAliases).kind !== "ambiguous") return true;
    }
  }
  return /(?:，|；|然后|随后|接着|而|但|却|并且|且)\s*(?:[\p{Script=Han}]{1,12})?(?:(?:又|也|便|就|立即|随即|迅速|缓缓)\s*)*(?:按下|打开|关闭|启动|停下|离开|进入|攻击|防守|说出|回答|转身|冲出|退后)/u.test(tail);
}

function effectHasForeignOwner(source: string, sentence: TextRange, action: Occurrence, effect: Occurrence, actorAliases: readonly string[], objectTerm?: string, category?: ExperienceCategory, knownActionSentence?: TextRange): boolean {
  if (action.start < sentence.start) {
    const actionSentence = knownActionSentence ?? sentenceFor(sentenceRanges(source), action.start);
    if (!actionSentence || actionSentence.end !== sentence.start) return true;
    if (crossSentenceHasInterveningEvent(source, actionSentence, action, actorAliases)) return true;
    if (category === "mechanic" && actorOwnedMechanicEffect(source, sentence, effect, actorAliases)) {
      return mechanicEffectHasForeignRecipient(source, sentence, effect, actorAliases);
    }
    const rawPrefix = source.slice(sentence.start, effect.start);
    const prefix = rawPrefix.trim();
    const suffix = source.slice(effect.end, sentence.end);
    const passiveOwner = passiveOutcomeAgentMatches(source, sentence, effect, actorAliases);
    if (passiveOwner !== undefined) return !passiveOwner;
    const explicitOwner = /^\s+(?:belongs?|belonged|accrued|went)\s+to\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)\b/iu.exec(suffix)?.[1];
    if (explicitOwner) return !actorAliases.some((alias) => alias.toLocaleLowerCase() === explicitOwner.toLocaleLowerCase());
    // Cross-sentence effects are accepted only through a small set of
    // explicit anaphoric/causal frames.  Arbitrary nearby words are not a
    // causal edge.
    let actorNormalizedPrefix = prefix;
    for (const alias of actorAliases) actorNormalizedPrefix = actorNormalizedPrefix.replace(new RegExp(escapeRegex(alias), "giu"), "ACTOR");
    const causalAssertion = /^(?:(?:therefore|thus|consequently|as\s+a\s+result|by\s+doing\s+so)\s*,?\s*)?(?:(?:ACTOR|he|she|they)\s+)?(?:secured|achieved|brought|ensured|delivered|produced)\s*$/iu.test(actorNormalizedPrefix)
      || /^(?:(?:because\s+of\s+that|because\s+of\s+this)\s*,?\s*)?(?:(?:ACTOR|he|she|they)\s+)?(?:gained|earned|claimed|won)\s*$/iu.test(actorNormalizedPrefix)
      || /^(?:(?:this|that|doing\s+so)\s+(?:led\s+to|brought|produced|yielded|resulted\s+in)|the\s+result\s+was)\s*$/iu.test(actorNormalizedPrefix)
      || /^(?:(?:因此|所以|于是|由此|结果|因而)[，,]?\s*)?(?:(?:ACTOR|他|她|他们|她们)\s*)?(?:确保|带来|赢得|取得|实现)(?:了)?\s*$/u.test(actorNormalizedPrefix)
      || /^(?:(?:这|此举)(?:导致|带来|赢得|取得|实现)|结果是)\s*$/u.test(actorNormalizedPrefix);
    const anaphoricPrefix = /^(?:their)\s*$/iu.test(prefix)
      || /^(?:as\s+a\s+result|therefore|thus|consequently|because\s+of\s+this)\s*,?\s*$/iu.test(prefix)
      || /^(?:this|that)\s+(?:secured|achieved|brought|ensured|delivered|produced)\s*$/iu.test(prefix)
      || /^(?:因此|所以|于是|由此|结果)[，,]?\s*$/u.test(prefix)
      || /^(?:这|此举)(?:确保|带来|赢得|取得|实现)\s*$/u.test(prefix);
    if (prefix && !anaphoricPrefix && !causalAssertion) return true;
    const reference = /\b(?:her|his|their|he|she|they)\b/iu.exec(rawPrefix) ?? /(?:他|她|他们|她们)/u.exec(rawPrefix);
    const causalSubjectPronoun = !!reference && causalAssertion && /^(?:he|she|they|他|她|他们|她们)$/iu.test(reference[0]);
    if (reference && !causalSubjectPronoun && discourseSubjectBefore(source, sentence.start + reference.index, actorAliases).kind !== "expected") return true;
    if ((/^(?:this|that)\s+(?:secured|achieved|brought|ensured|delivered|produced)\s*$/iu.test(prefix) || causalAssertion) && /^\s*[.!?;。！？；]?\s*$/u.test(suffix)) return false;
    return !/^\s+(?:(?:followed|came|arrived|resulted)(?:\s+(?:immediately|at\s+once|at\s+last|as\s+a\s+result))?|was\s+(?:achieved|secured|complete)|became\s+clear|did\s+not\s+come\s+(?:cheaply|without\s+sacrifice)|was\s+not\s+achieved\s+easily|never\s+came\s+into\s+question)\s*[.!?;。！？；]?\s*$/iu.test(suffix);
  }
  const resultPredicate = resultPredicateBefore(source, sentence, action, effect);
  if (resultPredicate) {
    let bridge = source.slice(action.end, resultPredicate.start);
    if (objectTerm?.trim()) bridge = bridge.replace(new RegExp(escapeRegex(objectTerm.trim()), "giu"), " ");
    for (const alias of actorAliases) bridge = bridge.replace(new RegExp(escapeRegex(alias), "giu"), " ");
    bridge = bridge
      .replace(/\bin\s+doing\s+so\b/giu, " ")
      .replace(/\b(?:a|an|the|and|or|but|then|therefore|thus|thereby|consequently|so|by|her|him|them)\b/giu, " ")
      .replace(/\b[A-Za-z][A-Za-z'’-]*ly\b/giu, " ")
      .replace(/(?:为了?|替)自己/gu, " ")
      .replace(/(?:并且|并|且|又|随后|然后|从而|因此|所以|于是|由此|因而|便|就|也|都|终于)/gu, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    const inheritedPronoun = /^(?:he|she|they|他|她|他们|她们)$/iu.test(bridge);
    const explicitActor = actorAliases.some((alias) => aliasIdentity([alias], bridge));
    if (bridge && !inheritedPronoun && !explicitActor && predicateSubject(source, sentence, resultPredicate, actorAliases).kind !== "expected") return true;
  }
  const afterAction = source.slice(action.end, effect.start);
  const localAt = lastConnectorStart(afterAction);
  let localPrefix = afterAction.slice(Math.max(0, localAt)).trim();
  if (objectTerm?.trim()) localPrefix = localPrefix.replace(objectTerm.trim(), "").trim();
  if (/[\p{Script=Han}]/u.test(localPrefix)) {
    let residue = localPrefix;
    for (const alias of actorAliases) residue = residue.replaceAll(alias, "");
    const mayUsePronoun = actorAliases.some((alias) => exactAliasOccurrences(source.slice(sentence.start, action.start), alias).length > 0);
    let prior = "";
    while (prior !== residue) {
      prior = residue;
      residue = residue.replace(/^[，,\s]*(?:(?:并|且|又|随后|然后|从而|因此|所以|于是|由此|因而|便|就|也|都|终于|轻易|成功|当即)[，,\s]*)*/u, "");
      residue = residue.replace(/^(?:为了?|替)自己/u, "");
      if (mayUsePronoun) residue = residue.replace(/^(?:他|她|他们|她们)/u, "");
    }
    // A Chinese result predicate may carry aspect, a classifier, or an
    // open-vocabulary premodifier before the configured outcome. Those words
    // are part of the result NP, not a replacement event owner.
    if (/^(?:取得|赢得|获得|迎来|实现|确保|带来|换来|达成|得到|收获|宣告|完成|拿下)(?:了|着|过)?[^，。！？；]{0,18}$/u.test(residue)) return false;
    residue = residue.replace(/(?:取得|赢得|获得|迎来|实现|确保|带来|换来|达成|得到|收获|宣告|完成|拿下)$/u, "");
    return /[\p{Script=Han}]/u.test(residue);
  }
  const foreignName = [...localPrefix.matchAll(/\b(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*\b/gu)].at(-1)?.[0];
  if (foreignName && !actorAliases.some((alias) => alias.toLocaleLowerCase() === foreignName.toLocaleLowerCase())) return true;
  if (/\b(?:someone|somebody|another\s+\w+|he|she|they)\b[^.!?;]{0,24}\b\w+(?:ed|s)\s*$/iu.test(localPrefix)) return true;
  if (/\b(?:the|a|an)\s+[a-z][a-z'’-]*(?:\s+[a-z][a-z'’-]*){0,2}\s+\w+(?:ed|s)\s*$/iu.test(localPrefix)) return true;
  return false;
}

function effectIsAsserted(source: string, sentence: TextRange, action: Occurrence, effect: Occurrence, slot: RealizationSlot, actorAliases: readonly string[], objectTerm?: string, category?: ExperienceCategory, actionSentence?: TextRange): boolean {
  if (effect.start < action.start) return false;
  if (absorbedSurfaceModality(effect.text)) return false;
  const prefix = source.slice(Math.max(sentence.start, effect.start - 72), effect.start);
  const sinceAction = source.slice(Math.max(action.end, effect.start - 1_024), effect.start);
  const suffix = source.slice(effect.end, sentence.end);
  if (quoteDepthAt(source, effect.start) > 0 || postposedNonActualContainer(source, sentence, effect)) return false;
  const effectPredicateUse = /[A-Za-z]/u.test(effect.text)
    ? englishFinite(effect.text) || /\b(?:do|does|did|will|would|can|could|may|might|shall|should|must|to)\s+$/iu.test(prefix)
    : /^(?:取得|赢得|获得|迎来|实现|确保|带来|换来|达成|得到|收获|宣告|完成|拿下|发放|授予|颁发|送出|交付|提供|给予|给)$/u.test(effect.text);
  if (effectPredicateUse && nonActualReason(source, sentence, effect, { kind: "expected" }, actorAliases, true)) return false;
  const factualResultPredicate = resultPredicateBefore(source, sentence, action, effect);
  if (factualResultPredicate && nonActualReason(source, sentence, factualResultPredicate, { kind: "expected" }, actorAliases, true)) return false;
  if (/[A-Za-z]/u.test(effect.text)) {
    // Slot terms are open vocabulary: reject epistemic qualifiers and terms
    // that merely modify a following noun, irrespective of the term itself.
    // A finite predicate is different: its following noun phrase is normally
    // its object ("the mechanism records her choice"), not part of a compound
    // label.  Auxiliary-governed base forms receive the same treatment.
    if (/\b(?:so[-\s]?called|apparent|supposed|alleged|ostensible|putative|purported|seeming|illusory|nominal|fake|false|counterfeit|mock|imaginary)\s+$/iu.test(prefix)) return false;
    const followingWord = /^\s+([A-Za-z][A-Za-z'’-]*)/u.exec(suffix)?.[1];
    const predicateUse = englishFinite(effect.text)
      || /\b(?:do|does|did|will|would|can|could|may|might|shall|should|must|to)\s+$/iu.test(prefix);
    const grammaticalContinuation = /^(?:and|or|but|then|so|therefore|thus|consequently|which|that|who|whom|whose|for|to|of|on|in|at|from|with|by|after|before|when|while|because|although|though|as|has|have|had|am|is|are|was|were|be|been|being|do|does|did|will|would|can|could|may|might|shall|should|must|not|never|still|already|finally|eventually|ultimately|immediately|itself|herself|himself|themselves|follow(?:s|ed|ing)?|came|come|arriv(?:e|es|ed|ing)|result(?:s|ed|ing)?|belongs?|belonged|belonging|accrued|went|became|failed|seemed|proved|remained|turned|materialized|occurred|happened|awarded|credited|assigned|granted)$/iu;
    const attributiveParticiple = /ing$/iu.test(effect.text.trim())
      && !!followingWord
      && !grammaticalContinuation.test(followingWord)
      && /\b(?:(?:a|an|the|this|that|her|his|their|my|your|our|its)|(?:with|of|in|on|by|through))\s+(?:(?:[A-Za-z][A-Za-z'’-]*ly)\s+)*$/iu.test(prefix);
    if (attributiveParticiple) return false;
    if (!predicateUse && followingWord && !grammaticalContinuation.test(followingWord)) return false;
  } else if (/[\p{Script=Han}]/u.test(effect.text)) {
    if (/(?:所谓(?:的)?|看似|貌似|疑似|表面(?:上)?(?:的)?|名义上(?:的)?|虚假(?:的)?|假(?:的)?)\s*$/u.test(prefix)) return false;
    const immediate = suffix.replace(/^\s+/u, "");
    if (/^[\p{Script=Han}]/u.test(immediate)
      && !/^(?:了|着|过)?(?:被|由|让|并|且|又|也|便|就|而|但|却|随后|然后|接着|继而|从而|因此|所以|于是|由此|因而|随即|终于|最终|立即|立刻|后|之后|属于|归于?|归属|落到|到来|实现|达成|完成|生效|显现|导致|造成|引发|产生|使得|令)/u.test(immediate)) return false;
  }
  if (/[\p{Script=Han}]/u.test(effect.text) ? chineseNegationGoverns(sinceAction) : englishNegationGoverns(sinceAction, effect.text)) return false;
  if (/\b(?:talk(?:s|ed|ing)?|discuss(?:es|ed|ing)?|mention(?:s|ed|ing)?|deny|denies|denied|denying|doubt(?:s|ed|ing)?|see|sees|saw|seen|read|reads|depict(?:s|ed|ing)?|paint(?:s|ed|ing)?|draw(?:s|n|ing)?|describe(?:s|d|ing)?)\b[^.!?;]{0,36}(?:\b(?:about|of)\b\s*)?$/iu.test(sinceAction)
    || /(?:谈论|讨论|提及|否认|怀疑|看见|看到|读到|描绘|画着|描述)[^。！？；]{0,28}$/u.test(sinceAction)
    || /\b(?:word|name|label|painting|portrait|picture|image|mural|story|novel)\b[^.!?;]{0,24}$/iu.test(prefix)
    || /(?:词语|字样|标签|画|画像|画卷|壁画|故事|小说)[^。！？；]{0,18}$/u.test(prefix)) return false;
  if (/\b(?:rumou?r|report(?:s|ed)?|claim(?:s|ed)?\s+that|said|says|dream(?:s|ed|t)?|imagin(?:e|es|ed)?|plan(?:s|ned)?|intend(?:s|ed)?|hope(?:s|d)?)\b[^.!?;]*$/iu.test(sinceAction) || /(?:据说|传闻|报道称|声称|梦见|想象|计划|打算|希望)[^。！？；]*$/u.test(sinceAction)) return false;
  if (/(?:\b(?:banner|label|sign|placard|caption|manual|book|notice)\b[^.!?;]{0,36}\b(?:reading|promising|about|describing)\s*|\b(?:hop(?:e|es|ed|ing)|aim(?:s|ed|ing)?|seek(?:s|ing)?|sought|wish(?:es|ed|ing)?|reach(?:es|ed|ing)?|prepar(?:e|es|ed|ing)|striv(?:e|es|ing)|strove)\s+(?:herself\s+|himself\s+|themselves\s+)?(?:for\s+)?|\b(?:(?:am|is|are|was|were|became|remained)\s+)?ready\s+for\s*|\b(?:in\s+pursuit\s+of|in\s+search\s+of|toward(?:s)?|chasing|for\s+a\s+chance\s+at)\s*|(?:横幅|标签|标牌|字幕|手册|书|告示)(?:上)?(?:写着|显示|描述|声称)[^。！？；]{0,24}|(?:为了|希望|期待|争取|目标是|追求|奔向))$/iu.test(prefix)) return false;
  const negativePostCondition = /^(?:[^.!?;]{0,24}\b(?:failed\s+to\s+(?:materialize|come)|did\s+not\s+come|would\s+never\s+come|never\s+came|was\s+not\s+(?:achieved|secured)|seemed\s+impossible|was\s+(?:merely\s+)?planned|was\s+only\s+(?:a\s+)?rumou?r)\b|[^。！？；]{0,24}(?:未能实现|并未到来|没有到来|只是计划|仅是传闻))/iu.test(suffix);
  if (negativePostCondition && !/\b(?:cheaply|easily|without\s+sacrifice|as\s+(?:a\s+)?surprise|into\s+question)\b/iu.test(suffix)) return false;
  if (/\b(?:without|unable\s+to)\s+(?:secur(?:e|ing)|achiev(?:e|ing)|claim(?:ing)?)\s*$/iu.test(prefix)) return false;
  if (/^\s+(?:for\s+[^.!?;]{0,24})?(?:did\s+not|never|was\s+not)\s+(?:come|arrive|occur|happen|materialize|be\s+achieved|be\s+secured|achieved|secured)\b/iu.test(suffix)) {
    if (!/\b(?:cheaply|easily|without\s+sacrifice|as\s+(?:a\s+)?surprise|into\s+question)\b/iu.test(suffix)) return false;
  }
  if (slot === "outcome") {
    if (category === "mechanic" && mechanicEffectHasForeignRecipient(source, sentence, effect, actorAliases)) return false;
    const genderedOwner = /\b(her|his|their)\s*$/iu.exec(prefix);
    if (genderedOwner) {
      const ownerAt = effect.start - (prefix.length - genderedOwner.index);
      if (!genderedReferenceMatchesActor(genderedOwner[1]!, actorAliases)
        || discourseSubjectBefore(source, ownerAt, actorAliases).kind !== "expected") return false;
    }
    const ownedAfter = /^\s*(?:(?:,\s*)?(?:which|that)\s+)?(?:(?:was|is)\s+)?(?:went|belongs?|belonged|belonging|accrued|awarded|credited|assigned|granted)(?:\s+to)?\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)\b/iu.exec(suffix)?.[1];
    if (ownedAfter && !actorAliases.some((alias) => alias.toLocaleLowerCase() === ownedAfter.toLocaleLowerCase())) return false;
    const chineseOwner = /^\s*(?:[，,]\s*)?(?:(?:而|但|却)\s*)?(?:(?:这场?胜利|胜利)\s*)?(?:属于|归于?|落到|归属)([\p{Script=Han}]{1,12})/u.exec(suffix)?.[1]?.replace(/所有$/u, "");
    if (chineseOwner && !actorAliases.some((alias) => chineseOwner.endsWith(alias) || alias.endsWith(chineseOwner))) return false;
    if (outcomeHasForeignBeneficiary(prefix, suffix, actorAliases)) return false;
    const chineseBeneficiary = /^\s*(?:为了?|替|代替|代表)([\p{Script=Han}]{1,12})/u.exec(suffix)?.[1];
    if (chineseBeneficiary && !actorAliases.includes(chineseBeneficiary)) return false;
    const chinesePostBeneficiary = /^(?:[^。！？；]{0,12})?(?:这是|是)?(?:为了?|替|代替|代表)([\p{Script=Han}]{1,12})(?:赢得|取得|获得)/u.exec(suffix)?.[1];
    if (chinesePostBeneficiary && !actorAliases.some((alias) => chinesePostBeneficiary.endsWith(alias))) return false;
    if (/^(?:[^。！？；]{0,16})?(?:而非|并非|不是)[^。！？；]{0,12}(?:她|他|主角|主人公)(?:自己)?的?(?:这场)?胜利/u.test(suffix)) return false;
    if (outcomeHasLaterForeignOwner(source, effect, actorAliases)) return false;
    if (/^\s+(?:followed|came\s+after|resulted\s+from)\s+(?!(?:immediately|at\s+once|at\s+last|as\s+a\s+result)\b)[^.!?;]+/iu.test(suffix)
      || /^\s*(?:紧随|源于|来自)[^。！？；]+/u.test(suffix)) return false;
  }
  if (slot !== "relationshipChange") {
    const predicateLike = /[A-Za-z]/u.test(effect.text) ? englishFinite(effect.text) : false;
    const resultPredicate = factualResultPredicate;
    const passiveResult = slot === "outcome" ? passiveOutcomeAgentMatches(source, sentence, effect, actorAliases) : undefined;
    if (passiveResult === false) return false;
    const nominalResultFrame = /^\s+(?:(?:followed|came|arrived|resulted)(?:\s+(?:immediately|at\s+once|at\s+last|as\s+a\s+result))?|was\s+(?:achieved|secured|complete)|belongs?|belonged|accrued|went\s+to|became\s+clear|did\s+not\s+come\s+(?:cheaply|without\s+sacrifice)|was\s+not\s+achieved\s+easily|never\s+came\s+into\s+question)\b/iu.test(suffix)
      || /^\s*(?:随即|随后|终于)?(?:到来|实现|达成|完成|生效|显现)/u.test(suffix)
      || /(?:\b(?:the\s+result\s+was|this\s+(?:led\s+to|brought|produced|yielded)|for)\s*$|(?:结果是|此举(?:导致|带来)|为了?)\s*$)/iu.test(prefix)
      || passiveResult === true
      || validDirectObject(source, sentence, action, effect);
    if (!predicateLike && !resultPredicate && !nominalResultFrame) return false;
  }
  if (slot !== "relationshipChange" && effectHasForeignOwner(source, sentence, action, effect, actorAliases, objectTerm, category, actionSentence)) return false;
  return slot !== "outcome" || !/\b(?:no\s+victory|victory\s+in\s+name\s+only)\b|(?:没有胜利|名义上的胜利)/iu.test(`${prefix} ${effect.text} ${suffix}`);
}

function occurrenceCandidates(input: NarrativeRealizationInput, slot: RealizationSlot, sentences: readonly TextRange[]): Occurrence[] {
  const term = input.binding[slot]; if (typeof term !== "string" || !term.trim()) return [];
  let occurrences: Occurrence[];
  if (slot === "reciprocalAction") {
    const aliases = normalizedAliases(input.binding.counterpart ?? "", input.counterpartAliases);
    const leading = aliases.find((alias) => term.toLocaleLowerCase().startsWith(`${alias.toLocaleLowerCase()} `));
    if (leading) {
      const predicateTerm = term.slice(leading.length).trim();
      const predicates = termOccurrences(input.source, predicateTerm);
      occurrences = exactAliasOccurrences(input.source, leading).flatMap((actor) => predicates
        .filter((predicate) => predicate.start >= actor.end && predicate.start - actor.end < 24 && /^\s+$/u.test(input.source.slice(actor.end, predicate.start)))
        .map((predicate) => ({ start: actor.start, end: predicate.end, text: input.source.slice(actor.start, predicate.end) })));
    } else occurrences = termOccurrences(input.source, term);
  } else occurrences = slot === "counterpart" || slot === "opponent" ? exactAliasOccurrences(input.source, term) : termOccurrences(input.source, term);
  return occurrences.filter((occurrence) => inEvidence(occurrence, input.slotEvidence?.[slot]) && inFocus(occurrence, input.focus, sentences));
}

function requiredSlots(input: NarrativeRealizationInput): RealizationSlot[] {
  const order: RealizationSlot[] = ["actor", "action", "object", "counterpart", "opponent", "reciprocalAction", "feedback", "outcome", "reaction", "relationshipChange"];
  const selected = input.binding.requiredSlots?.length
    ? new Set(input.binding.requiredSlots)
    : new Set(order.filter((slot) => typeof input.binding[slot] === "string" && !!input.binding[slot]?.trim()));
  return order.filter((slot) => selected.has(slot));
}

export function verifyNarrativeRealization(input: NarrativeRealizationInput): NarrativeRealizationResult {
  const required = requiredSlots(input);
  const predicateSlot: RealizationSlot = input.category === "world_reaction" ? "reaction" : input.binding.action ? "action" : "reaction";
  if (!input.source || !input.binding.actor?.trim() || !input.binding[predicateSlot]?.trim() || required.some((slot) => !input.binding[slot]?.trim())) return { status: "not_realized", reason: "missing_binding" };
  const sentences = sentenceRanges(input.source);
  const actorAliases = normalizedAliases(input.binding.actor, input.actorAliases);
  const sentenceIndexByStart = new Map(sentences.map((sentence, index) => [sentence.start, index] as const));
  const slotsToIndex = [...new Set([...required.filter((slot) => slot !== "actor"), predicateSlot])];
  const indexedOccurrences = new Map<RealizationSlot, Occurrence[]>();
  const occurrencesBySentence = new Map<RealizationSlot, Map<number, Occurrence[]>>();
  for (const slot of slotsToIndex) {
    const occurrences = occurrenceCandidates(input, slot, sentences);
    indexedOccurrences.set(slot, occurrences);
    const buckets = new Map<number, Occurrence[]>();
    for (const occurrence of occurrences) {
      const sentence = sentenceFor(sentences, occurrence.start); if (!sentence) continue;
      const bucket = buckets.get(sentence.start) ?? []; bucket.push(occurrence); buckets.set(sentence.start, bucket);
    }
    occurrencesBySentence.set(slot, buckets);
  }
  const actorOccurrences = actorAliases.flatMap((alias) => exactAliasOccurrences(input.source, alias))
    .sort((left, right) => left.start - right.start)
    .filter((mention) => inEvidence(mention, input.slotEvidence?.actor) && inFocus(mention, input.focus, sentences));
  const actorBySentence = new Map<number, Occurrence[]>();
  for (const mention of actorOccurrences) {
    const sentence = sentenceFor(sentences, mention.start); if (!sentence) continue;
    const bucket = actorBySentence.get(sentence.start) ?? []; bucket.push(mention); actorBySentence.set(sentence.start, bucket);
  }
  const candidates = indexedOccurrences.get(predicateSlot) ?? [];
  if (!candidates.length) return { status: "not_realized", reason: "missing_mention" };

  // A punctuation sentence may contain many independent comma-spliced events.
  // Bind each predicate to the text between the neighbouring occurrences of
  // the same predicate.  This both prevents an effect from drifting to another
  // event and keeps a run-on sentence from turning the matcher into an O(n²)
  // cross product.  Leading frames such as "According to Bob, ..." remain in
  // scope because there is no preceding predicate from which to cut them off.
  const clauseByPredicate = new Map<number, TextRange>();
  const lastPredicateStartBySentence = new Map<number, number>();
  for (let index = 0; index < candidates.length; index += 1) {
    const predicate = candidates[index]!;
    const containing = sentenceFor(sentences, predicate.start); if (!containing) continue;
    const previous = index > 0 && sentenceFor(sentences, candidates[index - 1]!.start)?.start === containing.start
      ? candidates[index - 1]
      : undefined;
    const following = index + 1 < candidates.length && sentenceFor(sentences, candidates[index + 1]!.start)?.start === containing.start
      ? candidates[index + 1]
      : undefined;
    let start = containing.start; let end = containing.end;
    if (previous) {
      const bridge = input.source.slice(previous.end, predicate.start);
      const comma = Math.max(bridge.lastIndexOf(","), bridge.lastIndexOf("，"));
      if (comma >= 0) start = previous.end + comma + 1;
    }
    if (following) {
      const bridge = input.source.slice(predicate.end, following.start);
      const comma = Math.max(bridge.lastIndexOf(","), bridge.lastIndexOf("，"));
      if (comma >= 0) end = predicate.end + comma;
    }
    clauseByPredicate.set(predicate.start, { start, end, text: input.source.slice(start, end) });
    lastPredicateStartBySentence.set(containing.start, predicate.start);
  }

  const occurrencesInRange = (items: readonly Occurrence[], start: number, end: number): Occurrence[] => {
    let low = 0; let high = items.length;
    while (low < high) { const middle = (low + high) >>> 1; if (items[middle]!.start < start) low = middle + 1; else high = middle; }
    const selected: Occurrence[] = [];
    for (let index = low; index < items.length && items[index]!.start < end; index += 1) selected.push(items[index]!);
    return selected;
  };
  const occurrenceContext = (slot: RealizationSlot, occurrence: Occurrence, sentence: TextRange): TextRange => {
    const items = occurrencesBySentence.get(slot)?.get(sentence.start) ?? [];
    let low = 0; let high = items.length;
    while (low < high) { const middle = (low + high) >>> 1; if (items[middle]!.start < occurrence.start) low = middle + 1; else high = middle; }
    const index = low < items.length && items[low]!.start === occurrence.start ? low : -1;
    if (index < 0) return sentence;
    const previous = index > 0 ? items[index - 1] : undefined;
    const following = index + 1 < items.length ? items[index + 1] : undefined;
    let start = sentence.start; let end = sentence.end;
    if (previous) {
      const bridge = input.source.slice(previous.end, occurrence.start);
      const comma = Math.max(bridge.lastIndexOf(","), bridge.lastIndexOf("，"));
      if (comma >= 0) start = previous.end + comma + 1;
    }
    if (following) {
      const bridge = input.source.slice(occurrence.end, following.start);
      const comma = Math.max(bridge.lastIndexOf(","), bridge.lastIndexOf("，"));
      if (comma >= 0) end = occurrence.end + comma;
    }
    return { start, end, text: input.source.slice(start, end) };
  };
  const nearbyOccurrences = (slot: RealizationSlot, sentence: TextRange, predicate: Occurrence): Occurrence[] => {
    const indexed = indexedOccurrences.get(slot) ?? [];
    if (slot === "counterpart" || slot === "opponent") {
      const minimum = predicate.start - 179; const maximum = predicate.start + 179;
      let low = 0; let high = indexed.length;
      while (low < high) { const middle = (low + high) >>> 1; if (indexed[middle]!.start < minimum) low = middle + 1; else high = middle; }
      const nearby: Occurrence[] = [];
      for (let index = low; index < indexed.length && indexed[index]!.start <= maximum; index += 1) nearby.push(indexed[index]!);
      return nearby;
    }
    const buckets = occurrencesBySentence.get(slot);
    const currentBucket = buckets?.get(sentence.start) ?? [];
    const clause = clauseByPredicate.get(predicate.start);
    const current = clause ? occurrencesInRange(currentBucket, clause.start, clause.end) : currentBucket;
    if (slot === "object" || slot === "action" && predicateSlot === "reaction") return current;
    const sentenceIndex = sentenceIndexByStart.get(sentence.start) ?? -1;
    const closestPredicate = lastPredicateStartBySentence.get(sentence.start) === predicate.start;
    const next = closestPredicate && sentenceIndex >= 0 ? sentences[sentenceIndex + 1] : undefined;
    const nextTwo = closestPredicate && slot === "relationshipChange" && sentenceIndex >= 0 ? sentences[sentenceIndex + 2] : undefined;
    return [...current, ...(next ? buckets?.get(next.start) ?? [] : []), ...(nextTwo ? buckets?.get(nextTwo.start) ?? [] : [])];
  };
  let strongest: NarrativeFailureReason = "ambiguous";
  for (const predicate of candidates) {
    const sentence = sentenceFor(sentences, predicate.start); if (!sentence) continue;
    const semanticSentence = clauseByPredicate.get(predicate.start) ?? sentence;
    if (/[A-Za-z]/u.test(predicate.text) && /\b(?:the|a|an|this|that|these|those)\s*$/iu.test(input.source.slice(semanticSentence.start, predicate.start))) { strongest = "foreign_subject"; continue; }
    const subject = predicateSubject(input.source, semanticSentence, predicate, actorAliases);
    if (subject.kind === "foreign") { strongest = "foreign_subject"; continue; }
    if (subject.kind === "ambiguous") { strongest = "ambiguous"; continue; }
    const factuality = nonActualReason(input.source, semanticSentence, predicate, subject, actorAliases);
    if (factuality) { strongest = factuality; continue; }
    const witnesses: Partial<Record<RealizationSlot, SourceSpan>> = { [predicateSlot]: { start: predicate.start, end: predicate.end } };
    const predicatePrefix = input.source.slice(semanticSentence.start, predicate.start).trim();
    const pronominalCarry = /^(?:he|she|they|他|她|他们|她们)$/iu.test(predicatePrefix);
    const passivePronounCarry = /^\s*(?:[A-Za-z][A-Za-z'’-]*ly\s+){0,3}by\s+(?:her|him|them)\b/iu.test(input.source.slice(predicate.end, sentence.end));
    const sameSentenceActor = (actorBySentence.get(sentence.start) ?? []).find((mention) => mention.end <= sentence.end);
    const sentenceIndex = sentenceIndexByStart.get(sentence.start) ?? -1;
    const priorSentence = sentenceIndex > 0 ? sentences[sentenceIndex - 1] : undefined;
    const priorActor = (pronominalCarry || passivePronounCarry) && priorSentence
      ? (actorBySentence.get(priorSentence.start) ?? []).filter((mention) => mention.end <= sentence.start && sentence.start - mention.end < 160).at(-1)
      : undefined;
    const actorMention = sameSentenceActor ?? priorActor;
    if (required.includes("actor") && !actorMention) { strongest = "missing_mention"; continue; }
    if (actorMention) witnesses.actor = { start: actorMention.start, end: actorMention.end };
    let failed: NarrativeFailureReason | undefined;
    for (const slot of required.filter((item) => item !== "actor" && item !== predicateSlot)) {
      const occurrences = nearbyOccurrences(slot, sentence, predicate);
      const accepted = occurrences.find((occurrence) => {
        const occurrenceSentence = sentenceFor(sentences, occurrence.start); if (!occurrenceSentence) return false;
        if (slot === "action" && predicateSlot === "reaction" && input.category === "world_reaction") {
          if (occurrenceSentence.start !== sentence.start || occurrence.start >= predicate.start) return false;
          const actionSubject = predicateSubject(input.source, occurrenceSentence, occurrence, actorAliases);
          return actionSubject.kind === "expected" && !nonActualReason(input.source, occurrenceSentence, occurrence, actionSubject, actorAliases);
        }
        if (slot === "object") return occurrenceSentence.start === sentence.start && validDirectObject(input.source, semanticSentence, predicate, occurrence);
        if (slot === "counterpart" || slot === "opponent") {
          if (Math.abs(occurrence.start - predicate.start) >= 180 || quoteDepthAt(input.source, occurrence.start) > 0) return false;
          if (slot === "opponent") return opponentParticipatesInConflict(input, sentence, predicate, occurrence);
          return !participantMentionNamesContainer(input.source, occurrenceSentence, occurrence);
        }
        if (slot === "reciprocalAction") {
          const aliases = normalizedAliases(input.binding.counterpart ?? "", input.counterpartAliases);
          if (!aliases.length) return false;
          const embeddedSubject = aliases.some((alias) => exactAliasOccurrences(occurrence.text, alias).some((mention) => mention.start === 0));
          const predicateOccurrence = embeddedSubject && /[A-Za-z]/u.test(occurrence.text)
            ? (() => { const tokens = [...occurrence.text.matchAll(englishToken)]; const token = tokens.at(-1)!; return { start: occurrence.start + token.index!, end: occurrence.start + token.index! + token[0].length, text: token[0] }; })()
            : occurrence;
          const directSubject = predicateSubject(input.source, occurrenceSentence, predicateOccurrence, aliases);
          const pronounCarry = /^(?:he|she|they|他|她|他们|她们)\b/iu.test(input.source.slice(occurrenceSentence.start, predicateOccurrence.start).trim())
            && occurrenceSentence.start === sentence.end
            && witnesses.counterpart !== undefined
            && witnesses.counterpart.start >= sentence.start
            && witnesses.counterpart.end <= sentence.end;
          const relativeCarry = aliases.some((alias) => new RegExp(`${escapeRegex(alias)}\\s*,?\\s*who\\s*$`, "iu").test(input.source.slice(occurrenceSentence.start, predicateOccurrence.start)));
          return (embeddedSubject || directSubject.kind === "expected" || pronounCarry || relativeCarry) && !nonActualReason(input.source, occurrenceSentence, predicateOccurrence, { kind: "expected" }, aliases);
        }
        if (slot === "relationshipChange") {
          if (!effectIsAsserted(input.source, occurrenceSentence, predicate, occurrence, slot, actorAliases, input.binding.object, input.category, sentence)) return false;
          const reciprocalWitness = witnesses.reciprocalAction;
          const actorIsResponse = /^(?:answer(?:s|ed|ing)?|respond(?:s|ed|ing)?|reply|replies|replied|replying|回应|回答|答复|回礼)/iu.test(predicate.text);
          const earlier = reciprocalWitness && reciprocalWitness.start < predicate.start ? reciprocalWitness : predicate;
          const earlierSentence = earlier ? sentenceFor(sentences, earlier.start) : undefined;
          const temporalOpener = earlierSentence ? /^\s*(before|after)\b/iu.exec(input.source.slice(earlierSentence.start, earlier.start))?.[1]?.toLocaleLowerCase() : undefined;
          const betweenActions = reciprocalWitness
            ? input.source.slice(Math.min(predicate.end, reciprocalWitness.end), Math.max(predicate.start, reciprocalWitness.start))
            : "";
          const medialTemporal = [...betweenActions.matchAll(/\b(before|after)\b/giu)].at(-1)?.[1]?.toLocaleLowerCase();
          const semanticActionBeforeReciprocal = reciprocalWitness === undefined ? false
            : medialTemporal === "before" ? predicate.start < reciprocalWitness.start
              : medialTemporal === "after" ? predicate.start > reciprocalWitness.start
                : temporalOpener === "before" ? earlier === reciprocalWitness
              : temporalOpener === "after" ? earlier === predicate
                : predicate.end <= reciprocalWitness.start;
          const orderedActions = reciprocalWitness !== undefined
            && predicate.end <= occurrence.start
            && reciprocalWitness.end <= occurrence.start
            && (semanticActionBeforeReciprocal || (actorIsResponse && !temporalOpener && reciprocalWitness.end <= predicate.start));
          if (!orderedActions) return false;
          const counterpartAliases = normalizedAliases(input.binding.counterpart ?? "", input.counterpartAliases);
          const beforeChange = input.source.slice(occurrenceSentence.start, occurrence.start);
          const punctuation = Math.max(beforeChange.lastIndexOf(","), beforeChange.lastIndexOf("，"), beforeChange.lastIndexOf(";"), beforeChange.lastIndexOf("；"));
          const localPair = beforeChange.slice(punctuation + 1);
          const actorHere = actorAliases.some((alias) => exactAliasOccurrences(localPair, alias).length > 0);
          const counterpartHere = counterpartAliases.some((alias) => exactAliasOccurrences(localPair, alias).length > 0);
          let explicitResidue = localPair;
          for (const alias of [...actorAliases, ...counterpartAliases]) explicitResidue = explicitResidue.replace(new RegExp(escapeRegex(alias), "giu"), " ");
          explicitResidue = explicitResidue.replace(/\b(?:and|with|both|then|together|also)\b|(?:和|与|及|跟|并|一起|共同|两人|双方)/giu, "").replace(/[^\p{L}\p{N}]+/gu, "");
          if (actorHere && counterpartHere && !explicitResidue) return true;
          const pairPivot = [...localPair.matchAll(/\b(?:and|then)\s+(?=(?:they|we|both)\b)/giu)].at(-1);
          const pairClause = pairPivot ? localPair.slice(pairPivot.index!) : localPair;
          const pairPronounGoverns = /^\s*(?:and\s+)?(?:(?:from\s+that\s+(?:day|moment)|thereafter|then|finally)\s*,?\s*)?(?:they|we|both)(?:\s+(?:choose|chose|decide(?:d)?|agree(?:d)?|resolve(?:d)?|begin|began|start(?:ed)?|continue(?:d)?)\s+to)?\s*$/iu.test(pairClause)
            || /^\s*(?:并(?:且)?\s*)?(?:(?:从那天起|从此|此后|随后|于是)[，,]?\s*)?(?:他们|她们|两人|双方)(?:(?:决定|选择|同意|约定|开始|继续)(?:要|一起|共同|并肩)?)?\s*$/u.test(pairClause);
          const latestActionAt = Math.max(predicate.start, reciprocalWitness.start);
          const latestActionSentence = sentenceFor(sentences, latestActionAt);
          const pairPronoun = [...beforeChange.matchAll(/\b(?:they|we|both)\b|(?:他们|她们|两人|双方)/giu)].at(-1);
          const currentSentenceLead = pairPronoun ? beforeChange.slice(0, pairPronoun.index!) : beforeChange;
          const connectiveOnlyLead = /^(?:(?:\s|[,，;；])+|\b(?:and|then|thereafter|afterward|afterwards|subsequently|finally|eventually|so|thus|therefore|from\s+that\s+(?:day|moment))\b|(?:并且|并|然后|随后|此后|从此|于是|因此|最终|终于|从那天起|从那一刻起))*$/iu.test(currentSentenceLead);
          const interveningEvent = !!latestActionSentence
            && latestActionSentence.start < occurrenceSentence.start
            && (!!input.source.slice(latestActionSentence.end, occurrenceSentence.start).trim() || !connectiveOnlyLead);
          return pairPronounGoverns
            && !interveningEvent
            && witnesses.counterpart !== undefined
            && witnesses.reciprocalAction !== undefined
            && witnesses.counterpart.start < occurrence.start
            && witnesses.reciprocalAction.start < occurrence.start
            && actorAliases.some((alias) => exactAliasOccurrences(input.source.slice(Math.max(0, predicate.start - 120), predicate.end), alias).length > 0);
        }
        const effectSentence = occurrenceSentence.start === sentence.start ? semanticSentence : occurrenceContext(slot, occurrence, occurrenceSentence);
        if (!effectIsAsserted(input.source, effectSentence, predicate, occurrence, slot, actorAliases, input.binding.object, input.category, sentence)) return false;
        return true;
      });
      if (!accepted) { failed = slot === "object" ? "indirect_object" : "disconnected_effect"; break; }
      witnesses[slot] = { start: accepted.start, end: accepted.end };
    }
    if (!failed && input.category === "relationship" && required.includes("counterpart") && required.includes("reciprocalAction")) {
      const counterpartOccurrences = occurrencesBySentence.get("counterpart")?.get(sentence.start) ?? [];
      const directlyAddressed = counterpartOccurrences.some((mention) => {
        if (mention.start <= predicate.end || mention.start - predicate.end >= 80 || sentenceFor(sentences, mention.start)?.start !== sentence.start
          || participantMentionNamesContainer(input.source, sentence, mention)) return false;
        const between = input.source.slice(predicate.end, mention.start);
        return /^\s*(?:[A-Za-z][A-Za-z'’-]*ly\s+){0,2}(?:to|toward(?:s)?|before|at|with)\s+(?:the\s+)?$/iu.test(between) || /^\s*(?:(?:轻轻|郑重|缓缓|深深)地?\s*)?(?:向|对|朝|给|面向)\s*$/u.test(between);
      });
      const addressedBefore = counterpartOccurrences.some((mention) => {
        if (mention.end > predicate.start || sentenceFor(sentences, mention.start)?.start !== sentence.start
          || participantMentionNamesContainer(input.source, sentence, mention)) return false;
        const before = input.source.slice(sentence.start, mention.start);
        const after = input.source.slice(mention.end, predicate.start);
        const englishFronted = /(?:^|[,;]\s*)(?:to|toward(?:s)?|before)\s+(?:the\s+)?$/iu.test(before)
          && actorAliases.some((alias) => exactAliasOccurrences(after, alias).length > 0)
          && !/[.!?;]/u.test(after);
        const chineseActor = actorAliases.some((alias) => {
          const actor = exactAliasOccurrences(before, alias).at(-1);
          return !!actor && /^(?:(?:轻轻|郑重|缓缓|深深)地?\s*)?(?:向|对|朝|给|面向)\s*$/u.test(before.slice(actor.end));
        });
        return englishFronted || chineseActor;
      });
      const reciprocalBeforeResponse = witnesses.reciprocalAction !== undefined
        && witnesses.reciprocalAction.start < predicate.start
        && sentenceFor(sentences, witnesses.reciprocalAction.start)?.start === sentence.start
        && counterpartOccurrences.some((mention) => mention.start <= witnesses.reciprocalAction!.start
          && sentenceFor(sentences, mention.start)?.start === sentence.start
          && !participantMentionNamesContainer(input.source, sentence, mention))
        && /\b(?:then|so|therefore|thus|in\s+response)\b|(?:于是|随即|作为回应|因此)/iu.test(input.source.slice(witnesses.reciprocalAction.end, predicate.start))
        && !/^\s*(?:[A-Za-z][A-Za-z'’-]*ly\s+){0,3}(?:(?:to|toward(?:s)?|at|before)\b|with\s+(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*\b)|^\s*(?:向|对|朝|给|面向)\b/u.test(input.source.slice(predicate.end, sentence.end));
      if (!directlyAddressed && !addressedBefore && !reciprocalBeforeResponse) failed = "disconnected_effect";
    }
    if (!failed) return { status: "realized", witnesses };
    strongest = failed;
  }
  return { status: "not_realized", reason: strongest };
}

function aliasIdentity(aliases: readonly string[], value: string): boolean {
  return aliases.some((alias) => alias.normalize("NFKC").toLocaleLowerCase() === value.normalize("NFKC").toLocaleLowerCase());
}

function discourseSubjectBefore(source: string, at: number, aliases: readonly string[]): SubjectResolution {
  const history = source.slice(Math.max(0, at - 360), at);
  const fragments = history.split(/[.!?;。！？；\n]/u).map((item) => item.trim()).filter(Boolean).slice(-3).reverse();
  for (const raw of fragments) {
    const wholeFragment = raw
      .replace(/^(?:later|then|afterward|afterwards|meanwhile|eventually|finally|therefore|thus|consequently|as\s+a\s+result|because\s+of\s+(?:that|this))\s*,?\s*/iu, "")
      .replace(/^(?:后来|随后|然后|与此同时|最终|终于|因此|于是|所以|由此|因而)[，,]?\s*/u, "")
      .replace(/(?:\b(?:and|or|but|then|while|whereas)\b|(?:并且|但|然后|而|却))[，,]?\s*$/iu, "")
      .trim();
    const pivots = [...wholeFragment.matchAll(/\b(?:but|then|instead|however)\b|[,，]/giu)];
    const lastPivot = pivots.at(-1);
    const fragment = lastPivot && wholeFragment.slice(lastPivot.index! + lastPivot[0].length).trim()
      ? wholeFragment.slice(lastPivot.index! + lastPivot[0].length).trim()
      : wholeFragment;
    if (!fragment) continue;
    const trusted = aliases.flatMap((alias) => exactAliasOccurrences(fragment, alias).map((mention) => ({ ...mention, alias }))).sort((a, b) => a.start - b.start)[0];
    const firstFinite = [...fragment.matchAll(englishToken)].find((token) => /(?:ed|es|s)$/iu.test(token[0]) || irregularLemma.has(token[0].toLocaleLowerCase()))?.index ?? fragment.length;
    if (trusted && !/[\p{Script=Han}]/u.test(trusted.alias) && trusted.start <= firstFinite && !/[’']s\s*$/u.test(fragment.slice(trusted.start, trusted.end + 2))) {
      const before = fragment.slice(0, trusted.start);
      const after = fragment.slice(trusted.end);
      const competingName = [...after.matchAll(/\b(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*\b/gu)]
        .some((match) => !aliasIdentity(aliases, match[0]));
      if (competingName) return { kind: "ambiguous" };
      if (!/\b(?:to|by|with|beside|near|behind|after|before|from)\s*$/iu.test(before)) return { kind: "expected", text: trusted.alias };
    }
    const englishLeader = /^(?:(?:the|a|an)\s+)?((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)\b/u.exec(fragment)?.[1];
    if (englishLeader && !/^(?:The|A|An|It|This|That|Later|Then|Afterward|Meanwhile|Eventually|Finally)$/u.test(englishLeader)) return aliasIdentity(aliases, englishLeader) ? { kind: "expected", text: englishLeader } : { kind: "foreign", text: englishLeader };
    const chineseTrusted = aliases.find((alias) => /[\p{Script=Han}]/u.test(alias) && fragment.startsWith(alias));
    if (chineseTrusted) {
      const tail = fragment.slice(chineseTrusted.length);
      if (/^的/u.test(tail)) return { kind: "foreign", text: tail };
      if (/^(?:和|与|及|跟)/u.test(tail)) return { kind: "ambiguous" };
      if (!tail || /^(?:(?:又|便|就|才|仍|还|已|正|正在|再次|随后|立即|立刻|终于|当即|径直|亲手|轻易|猛地|迅速|缓缓|奋力|果断地?)\s*)*(?:走|走进|进入|来到|到达|站|冲|跑|尝试|打开|关闭|击|打|奋战|战|面对|迎战|说|看|听|拿|挥|赢|获胜|退|投降|行动|抬|转|伸|抓|推|拉)/u.test(tail)) return { kind: "expected", text: chineseTrusted };
      if (/^[\p{Script=Han}](?:走|走进|进入|来到|到达|站|冲|跑|尝试|打开|关闭|击|打|战|面对|迎战|说|看|听|拿|挥|赢|获胜|退|投降|行动|抬|转|伸|抓|推|拉)/u.test(tail)) return { kind: "foreign", text: tail };
      return { kind: "ambiguous" };
    }
    if (/^(?:他|她|他们|她们|其)\b/u.test(fragment)) continue;
  }
  return { kind: "ambiguous" };
}

const invariantEnglishSubjectBridge = /^(?:\s+\b(?:ultimately|still|eventually|decisively|unexpectedly|finally|clearly|completely|soundly|utterly|inevitably|again|already)\b){1,4}\s*$/iu;

function resolveInvariantSubject(source: string, sentence: TextRange, occurrence: Occurrence, aliases: readonly string[]): SubjectResolution {
  const prefix = source.slice(sentence.start, occurrence.start);
  const explicitTail = aliases.flatMap((alias) => exactAliasOccurrences(prefix, alias).map((mention) => ({ ...mention, alias })))
    .filter((mention) => {
      const bridge = prefix.slice(mention.end);
      return /^\s*$/u.test(bridge)
        || (/[A-Za-z]/u.test(occurrence.text) && invariantEnglishSubjectBridge.test(bridge));
    })
    .sort((left, right) => right.end - left.end)[0];
  if (explicitTail) return { kind: "expected", text: explicitTail.alias };
  const localAt = lastConnectorStart(prefix);
  const local = prefix.slice(Math.max(0, localAt));
  const omittedCoordinatedSubject = /[A-Za-z]/u.test(occurrence.text)
    ? (!local.trim() || invariantEnglishSubjectBridge.test(` ${local.trim()}`))
    : !local.trim().replace(chineseLeadingNoise, "").trim();
  const coordinate = localAt >= 0
    ? /(?:\b(?:and|but)\b|(?:并且|但|但是|却|而))\s*$/iu.exec(prefix.slice(0, localAt))
    : undefined;
  if (coordinate && omittedCoordinatedSubject) {
    const inherited = discourseSubjectBefore(source, sentence.start + coordinate.index, aliases);
    if (inherited.kind !== "ambiguous") return inherited;
  }
  const englishPronoun = /\b(he|she|they)\s*$/iu.exec(local);
  if (englishPronoun) {
    const absolute = sentence.start + Math.max(0, localAt) + englishPronoun.index;
    return discourseSubjectBefore(source, absolute, aliases);
  }
  const chinesePronoun = /(他|她|他们|她们|其)\s*$/u.exec(local);
  if (chinesePronoun) {
    const absolute = sentence.start + Math.max(0, localAt) + chinesePronoun.index;
    return discourseSubjectBefore(source, absolute, aliases);
  }
  return resolveSubject(source, sentence, occurrence, aliases);
}

interface MechanicMention extends Occurrence { owner: string; generic: boolean }
interface MechanicStateEvent extends Occurrence { unavailable: boolean }

const mechanicTerm = /\b(?:system|mechanic|panel|ability)\b|(?:系统|机制|面板|能力)/giu;
const mechanicEnglishName = "(?:(?:Captain|Lady|Lord|Doctor|Dr\\.?|Sir)\\s+)?[A-Z][A-Za-z'’-]*(?:\\s+[A-Z][A-Za-z'’-]*)*";
const mechanicQualifier = "(?:quest|reward|level(?:ing)?|cultivation|combat|cheat|status|mission|inventory|magic|power|skill|progression|awakening|talent|shop|sign-in|upgrade|personal|private|backup|secondary)";
const protagonistMechanicKey = "\u0000protagonist-mechanic";

function ownerForMechanic(source: string, mention: Occurrence): { owner: string; generic: boolean } {
  const prefix = source.slice(Math.max(0, mention.start - 240), mention.start);
  const suffix = source.slice(mention.end, Math.min(source.length, mention.end + 160));
  const englishPossessive = new RegExp(`\\b(${mechanicEnglishName})[’']s\\s*(?:(?:${mechanicQualifier}|[A-Za-z][A-Za-z-]*)\\s+)*$`, "u").exec(prefix);
  if (englishPossessive) return { owner: englishPossessive[1]!.trim().toLocaleLowerCase(), generic: false };
  const owned = new RegExp(`\\b(${mechanicEnglishName})-owned\\s*$`, "u").exec(prefix);
  if (owned) return { owner: owned[1]!.trim().toLocaleLowerCase(), generic: false };
  const whose = new RegExp(`\\b(${mechanicEnglishName})\\s*,?\\s+whose\\s+(?:(?:${mechanicQualifier}|[A-Za-z][A-Za-z-]*)\\s+)*$`, "u").exec(prefix);
  if (whose) return { owner: whose[1]!.trim().toLocaleLowerCase(), generic: false };
  const governingOwner = new RegExp(`\\b(${mechanicEnglishName})\\s+(?:activates?|activated|uses?|used|summons?|summoned|owns?|owned|builds?|built|creates?|created|constructs?|constructed|checks?|checked|opens?|opened|access(?:es|ed)?)\\s+(?:(?:a|an|the|her|his|their|its)\\s+)?(?:(?:${mechanicQualifier})\\s+)*$`, "u").exec(prefix);
  if (governingOwner) return { owner: governingOwner[1]!.trim().toLocaleLowerCase(), generic: false };
  const pronoun = new RegExp(`\\b(her|his|their|my|your|our)\\s+(?:(?:${mechanicQualifier})\\s+)*$`, "iu").exec(prefix);
  if (pronoun) return { owner: `pronoun:${pronoun[1]!.toLocaleLowerCase()}`, generic: false };
  const distinct = new RegExp(`\\b(another|other|different|second|separate|backup|secondary|enemy)\\s+(?:(?:${mechanicQualifier})\\s+)*$`, "iu").exec(prefix);
  if (distinct) return { owner: `distinct:${distinct[1]!.toLocaleLowerCase()}`, generic: false };
  const chinesePronoun = /(他|她|他们|她们|其)的(?:专属|绑定|个人|独有|备用|奖励|任务|升级|另一套|第二套)?\s*$/u.exec(prefix);
  if (chinesePronoun) return { owner: `pronoun:${chinesePronoun[1]!}`, generic: false };
  if (/自己的(?:专属|绑定|个人|独有|备用|奖励|任务|升级)?\s*$/u.test(prefix)) return { owner: "pronoun:自己", generic: false };
  const chinese = /([\p{Script=Han}]{1,12})的(?:专属|绑定|个人|独有|备用|奖励|任务|升级|另一套|第二套|敌人)?\s*$/u.exec(prefix);
  if (chinese) {
    const owner = chinese[1]!.replace(/^(?:(?:突然|下一刻|战斗中|此时|后来|随后|然后|但是|同时|当时|于是|但|而|却))+/u, "");
    return { owner, generic: false };
  }
  const postposed = new RegExp(`^\\s+(?:serving|belonging\\s+to|bound\\s+to|assigned\\s+to|used\\s+by|operated\\s+by|owned\\s+by|for)\\s+(${mechanicEnglishName})\\b`, "u").exec(suffix);
  if (postposed) return { owner: postposed[1]!.trim().toLocaleLowerCase(), generic: false };
  return { owner: "generic", generic: true };
}

function mechanicMentions(source: string): MechanicMention[] {
  return [...source.matchAll(mechanicTerm)].flatMap((match) => {
    const occurrence = { start: match.index!, end: match.index! + match[0].length, text: match[0] };
    const prefix = source.slice(Math.max(0, occurrence.start - 96), occurrence.start);
    const suffix = source.slice(occurrence.end, Math.min(source.length, occurrence.end + 96));
    if (/^ability$/iu.test(match[0]) && (/^\s+to\s+[a-z][a-z'’-]*\b/iu.test(suffix) || /\b(?:acting|sleeping|walking|speaking|reading|writing|working|athletic|musical)\s*$/iu.test(prefix))) return [];
    if (/^mechanic$/iu.test(match[0]) && (!/\b(?:game|gameplay|story|narrative|power|skill|progression)\s*$/iu.test(prefix)
      || /\b(?:called|calls?|hired?|hire|asked?|asks?|wait(?:s|ed|ing)?\s+for|visit(?:s|ed|ing)?|meet(?:s|ing)?|met|repair(?:s|ed|ing)?|garage|car)\b/iu.test(`${prefix} ${suffix}`)
      || /^\s*,?\s*(?:who|whom|whose)\b/iu.test(suffix))) return [];
    if (/^panel$/iu.test(match[0]) && (/\b(?:solar|wall|control|instrument|electrical|breaker|door|display|roof)\s*$/iu.test(prefix)
      || /\b(?:solar|wall|control|instrument|electrical|breaker|door|display|roof)\s+panel\b[^.!?;]{0,80}[.!?;]\s*(?:the|this|that)?\s*$/iu.test(prefix))) return [];
    if (/^面板$/u.test(match[0]) && /(?:太阳能|墙面|墙上|控制|仪表|配电|门禁)\s*$/u.test(prefix)) return [];
    if (/^system$/iu.test(match[0]) && /\b(?:heating|cooling|digestive|circulatory|respiratory|nervous|endocrine|skeletal|muscular|renal|lymphatic|reproductive|communication|communications|traffic(?:\s+control)?|transport|operating|security|navigation|electrical|plumbing|immune|solar|computer|brake|sprinkler|school|educational|academic|banking|financial|payment|payroll|accounting)\s*$/iu.test(prefix)) return [];
    if (/^系统$/u.test(match[0]) && /(?:城市)?(?:供暖|制冷|消化|循环|呼吸|神经|内分泌|骨骼|肌肉|泌尿|淋巴|生殖|交通|通信|通讯|运输|操作|安防|导航|电力|供水|免疫|太阳能|电脑|计算机|学校|教育|教务|银行|金融|支付|薪资|会计)\s*$/u.test(prefix)) return [];
    return [{ ...occurrence, ...ownerForMechanic(source, occurrence) }];
  });
}

function mechanicFailureBelongsToMention(clause: string, mentionLength: number, failureAt: number): boolean {
  let bridge = clause.slice(Math.max(mentionLength, failureAt - 1024), failureAt);
  bridge = bridge.replace(/^\s*(?:serving|belonging\s+to|bound\s+to|assigned\s+to|used\s+by|operated\s+by|owned\s+by|for)\s+(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z'’-]*)*\s+/iu, " ");
  bridge = bridge.replace(/^\s*(?:that|which)\b[^,，]*$/iu, " ").replace(/,\s*(?:which|that|after|before|while|despite|although|though|having|without|with)\b[^,，]*[,，]\s*/giu, " ");
  const pivots = [...bridge.matchAll(/[,，]|\b(?:and|but|while|whereas|although|though|then|that)\b|(?:并且|但是|但|而|却|同时|当|然后|随后)/giu)];
  const local = bridge.slice(pivots.at(-1) ? pivots.at(-1)!.index! + pivots.at(-1)![0].length : 0).trim();
  if (/^(?:it|itself|它|其)$/iu.test(local)) return true;
  if (/^(?:will|shall)\s+(?:(?:be|become|remain)\s*|(?:permanently|irreversibly|forever|finally|eventually)\s*|(?:(?:at|by|in|before)\s+(?:(?:the|story[’']s)\s+)?(?:ending|end|finale|conclusion|final\s+chapter|last\s+chapter|climax))\s*)*$/iu.test(local)
    || /^(?:将会?|会)(?:(?:在|于)?(?:结局|终章|最终章|最后一章|大结局|收官)(?:时|中|前|后)?|永久|永远|不可逆|彻底|最终|最后|被|变得|变成|成为|处于)*$/u.test(local)) return true;
  if (!local || /^(?:(?:[a-z][a-z'’-]*ly|still|again)\s*)+$/u.test(local)
    || /^(?:(?:has|have|had)\s+been|am|is|are|was|were|be|been|being|became|becomes?|went|fell|remained|remains?|stayed|(?:will|shall)\s+(?:be|become|remain))?(?:\s+[A-Za-z][A-Za-z'’-]*ly)*$/iu.test(local)
    || /^(?:(?:已经|曾经|仍然|依然|突然|彻底|永久|始终|一直|将|会)\s*)*(?:变得|变成|陷入|处于|已经|仍然)?\s*$/u.test(local)) return true;
  if (/^(?:(?:the|a|an|this|that|another|other)\s+)?(?:[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|[a-z][a-z0-9'’-]*(?:\s+[a-z][a-z0-9'’-]*){0,3}|he|she|they|it)\s+(?:(?:has|have|had)\s+been|is|are|was|were|became|went|fell)?(?:\s+[A-Za-z][A-Za-z'’-]*ly)*$/iu.test(local)) return false;
  if (/^[\p{Script=Han}]{1,16}(?:(?:已经|曾经|仍然|突然|彻底|永久)\s*)*(?:变得|变成|陷入|处于|已经|仍然)?$/u.test(local)) return false;
  return false;
}

function mechanicRecoveryBelongsToMention(source: string, mention: MechanicMention, effect: Occurrence, searchStart: number): boolean {
  let local = source.slice(Math.max(mention.end, searchStart, effect.start - 1024), effect.start);
  const localAt = lastConnectorStart(local);
  local = local.slice(Math.max(0, localAt)).replace(/^[,，:\s]+|[,，:\s]+$/gu, "");
  if (/^(?:it|itself|它|其)$/iu.test(local)) return true;
  if (/^(?:(?:(?:has|have|had)\s+been|am|is|are|was|were|be|been|being|became|become|remained|stayed)\s*)?(?:(?:[A-Za-z][A-Za-z'’-]*ly|later|then|subsequently|eventually|afterwards?)\s*)*$/iu.test(local)
    || /^(?:(?:已经|终于|重新|再次|随即|随后|立即|立刻|恢复|变得|变成|后)\s*)*$/u.test(local)) return true;
  if (/^(?:崩溃|卡死|宕机|死机|瘫痪|故障|失灵|停摆|离线|掉线|报错)(?:后|之后)?(?:又|便|就|才|已|终于|随后|立即|重新|再次)*$/u.test(local)) return true;
  if (/^(?:feedback|reward)$/iu.test(effect.text)) {
    return /^(?:(?:it|它|其)\s+)?(?:granted|gave|awarded|issued|delivered|displayed|showed|provided|produced|with)\s+(?:a|an|the)?\s*$/iu.test(local)
      || /^(?:(?:它|其)\s*)?(?:发放|给予|授予|显示|弹出|提供|产生)(?:了)?(?:一份|一个)?\s*$/u.test(local);
  }
  return false;
}

const mechanicFailurePattern = /\b(?:unavailable|not\s+available|inaccessible|broken|broke|crash(?:es|ed)?|froze|frozen|vanished|disappeared|destroyed|disabled|malfunction(?:s|ed)?|fail(?:s|ed)?|glitch(?:es|ed)?|shut(?:s|ting)?\s+down|(?:became|becomes?|was|is)\s+unresponsive|unresponsive|out\s+of\s+service|(?:was|is|went)\s+offline|(?:was\s+)?unable\s+to\s+(?:activate|initialize|initialise|boot|load|start|respond|work|connect|log\s*in)|could\s+not\s+(?:activate|initialize|initialise|boot|load|start|respond|work|connect|log\s*in)|couldn[’']t\s+(?:activate|initialize|initialise|boot|load|start|respond|work|connect|log\s*in)|fail(?:s|ed)?\s+to\s+(?:activate|initialize|initialise|boot|load|start|respond|work|connect|log\s*in)|refused\s+to\s+(?:activate|initialize|initialise|boot|load|start|respond|work|connect|log\s*in)|(?:returned|produced)\s+(?:an\s+)?error|timed\s+out|lost\s+(?:its\s+)?connection|became\s+inaccessible|went\s+blank|fell\s+silent|cease(?:s|d)?\s+(?:functioning|to\s+(?:function|work|operate|respond))|stopped\s+(?:working|responding|functioning|(?:issuing|granting|awarding|giving|delivering|providing)\s+(?:rewards?|feedback))|no\s+longer\s+(?:works?|worked|function(?:s|ed)?|operat(?:e|es|ed)|respond(?:s|ed)?)|(?:became|becomes?|is|was)\s+(?:completely\s+)?(?:useless|nonfunctional|inoperative)|(?:grant(?:s|ed|ing)?|award(?:s|ed|ing)?|giv(?:e|es|en|ing)|gave|deliver(?:s|ed|ing)?|provid(?:e|es|ed|ing))\s+no\s+more\s+(?:rewards?|feedback)|locked\s+(?:her|him|them|the\s+protagonist)\s+out|produced\s+nothing|cannot\s+(?:activate|initialize|initialise|boot|load|start|respond|work|connect|log\s*in|be\s+used)|can[’']t\s+(?:activate|initialize|initialise|boot|load|start|respond|work|connect|log\s*in|be\s+used)|can\s+no\s+longer\s+(?:activate|initialize|initialise|boot|load|start|respond|work|connect|log\s*in|be\s+used)|never\s+(?:works?|available)|no\s+(?:feedback|rewards?))\b|(?:无法使用|无法启动|无法登录|无法连接|无法运行|无法工作|无法响应|无法再(?:使用|启动|登录|连接|运行|工作|响应|发放(?:奖励|反馈)|提供(?:奖励|反馈))|再也不能(?:使用|启动|登录|连接|运行|工作|响应|发放(?:奖励|反馈)|提供(?:奖励|反馈))|启动失败|初始化失败|加载失败|登录失败|连接失败|未能(?:启动|初始化|加载|登录|连接|运行)|拒绝(?:启动|响应|工作|连接)|不可用|永远不可用|永久失效|报废|崩溃|卡死|宕机|死机|瘫痪|报错|断开(?:了)?连接|拒绝响应|无法访问|消失|离线|掉线|故障|失灵|沉寂|停摆|停止(?:工作|运行|响应|(?:发放|给予|授予|提供)(?:任何)?(?:奖励|反馈))|不再(?:工作|运行|运作|响应|发放奖励|提供反馈)|变(?:成|得)?(?:毫无用处|无用)|不再(?:发放|给予|授予|提供)(?:任何)?奖励|无响应|变(?:成|得)?空白|黑屏|将(?:她|他|主角)拒之门外|没有任何产出|(?:彻底)?被(?:(?:永久|永远|彻底)(?:地)?)?(?:摧毁|禁用)|没有反馈|没有奖励)/giu;
const mechanicRecoveryPattern = /\b(?:came\s+back\s+online|returned\s+(?:online|to\s+service)|reconnected|was\s+restored|recovered|rebooted|restarted|resumed\s+(?:working|functioning|operation|operations?|(?:issuing|granting|awarding|giving|delivering|providing)(?:\s+(?:rewards?|feedback))?)|activates?|activated|works?|worked|available|feedback|reward)\b|(?:重新上线|恢复连接|恢复可用|恢复运行|恢复正常|恢复工作|恢复(?:发放|给予|授予|提供)(?:奖励|反馈)?|重新(?:发放|给予|授予|提供)(?:奖励|反馈)|重启|重新启动|启动|开启|生效|可用|反馈|奖励|弹出)/giu;

function mechanicEntityKey(source: string, mention: MechanicMention, aliases: readonly string[], previous: string | undefined, previousMention: MechanicMention | undefined): string {
  if (mention.generic) return previous ?? (aliases.length ? protagonistMechanicKey : "generic");
  if (mention.owner.startsWith("pronoun:")) {
    if (aliases.length && mention.owner === "pronoun:自己") {
      const local = source.slice(Math.max(0, mention.start - 120), mention.start);
      const reflexiveOwner = aliases.some((alias) => new RegExp(`${escapeRegex(alias)}(?:(?:又|便|就|才|已|正|正在|刚刚|随后|立即|立刻)?(?:发现|察觉|注意到|查看|检查|确认|意识到|得知|看到)(?:了|过)?)?自己(?:的)?(?:专属|绑定|个人|独有|备用|奖励|任务|升级)?\\s*$`, "u").test(local));
      if (reflexiveOwner) return protagonistMechanicKey;
    }
    if (!aliases.length && previousMention?.owner.startsWith("pronoun:") && previousMention.owner !== mention.owner) {
      return mention.owner;
    }
    if (previous && previousMention) {
      const between = source.slice(previousMention.end, mention.start);
      const interveningName = [...between.matchAll(new RegExp(`\\b(${mechanicEnglishName})\\b`, "gu"))]
        .map((match) => match[1]!)
        .filter((name) => !/^(?:The|A|An|It|Its|Her|His|Their|Then|Later|Afterward|Afterwards|Meanwhile|Eventually|Finally)$/u.test(name))
        .filter((name) => !aliasIdentity(aliases, name))
        .at(-1);
      if (interveningName) return `foreign:${interveningName.toLocaleLowerCase()}`;
      return previous;
    }
    if (aliases.length) {
      const history = source.slice(Math.max(0, mention.start - 360), mention.start);
      const latestAlias = aliases.flatMap((alias) => exactAliasOccurrences(history, alias).map((occurrence) => ({ ...occurrence, alias })))
        .sort((left, right) => right.end - left.end)[0];
      const latestForeign = [...history.matchAll(new RegExp(`\\b(${mechanicEnglishName})\\b`, "gu"))]
        .map((match) => ({ start: match.index!, name: match[1]! }))
        .filter(({ name }) => !/^(?:The|A|An|It|Its|Her|His|Their|Then|Later|Afterward|Afterwards|Meanwhile|Eventually|Finally)$/u.test(name))
        .filter(({ name }) => !aliasIdentity(aliases, name))
        .at(-1);
      if (latestAlias && (!latestForeign || latestAlias.end > latestForeign.start)) return protagonistMechanicKey;
      const resolution = discourseSubjectBefore(source, mention.start, aliases);
      if (resolution.kind === "expected") return protagonistMechanicKey;
      if (resolution.kind === "foreign" && !/^(?:the|a|an)\b/iu.test(resolution.text ?? "")) return `foreign:${resolution.text?.toLocaleLowerCase() ?? mention.owner}`;
    }
    return previous ?? mention.owner;
  }
  if (mention.owner.startsWith("distinct:")) return `foreign:${mention.owner}:${mention.start}`;
  if (aliases.length && aliasIdentity(aliases, mention.owner)) return protagonistMechanicKey;
  return aliases.length ? `foreign:${mention.owner}` : `owner:${mention.owner}`;
}

function mechanicFactualityWindow(source: string, sentence: TextRange, occurrence: Occurrence): TextRange {
  const start = Math.max(sentence.start, occurrence.start - 1024);
  const end = Math.min(sentence.end, occurrence.end + 512);
  return { start, end, text: source.slice(start, end) };
}

function mechanicFailureFactualityOccurrence(occurrence: Occurrence): Occurrence {
  // Reaching this point means the curated mechanic-failure matcher has already
  // identified an adverse state.  "Unable/could not initialize" does not
  // assert initialization, but it does assert the failure.  Preserve the real
  // span for report, dream, conditional and surrounding-negation checks while
  // using a neutral adverse head for the generic realization modality guard.
  return { ...occurrence, text: /[\p{Script=Han}]/u.test(occurrence.text) ? "故障" : "failed" };
}

function terminalPlannedMechanicFailure(source: string, sentence: TextRange, occurrence: Occurrence): boolean {
  const start = Math.max(sentence.start, occurrence.start - 192);
  const end = Math.min(sentence.end, occurrence.end + 192);
  const local = source.slice(start, end);
  const beforeOccurrence = source.slice(start, occurrence.start);
  const definiteFuture = /\b(?:will|shall)\b[^.!?;]{0,112}$/iu.test(beforeOccurrence)
    || /(?:将会?|会)[^。！？；]{0,56}$/u.test(beforeOccurrence);
  if (!definiteFuture) return false;
  return /\b(?:permanent(?:ly)?|irreversible|irreversibly|forever|for\s+good|(?:at|by|in|before)\s+(?:(?:the|story[’']s)\s+)?(?:ending|end|finale|conclusion|final\s+chapter|last\s+chapter|climax)|final\s+chapter|last\s+chapter)\b/iu.test(local)
    || /(?:永久|永远|不可逆|彻底|结局|终章|最终章|最后一章|大结局|收官)/u.test(local);
}

function maskTerminalPlanModal(source: string, sentence: TextRange, occurrence: Occurrence): string {
  const start = Math.max(sentence.start, occurrence.start - 192);
  const prefix = source.slice(start, occurrence.start);
  const modals = [...prefix.matchAll(/\b(?:will|shall)\b|(?:将|会)/giu)];
  const modal = modals.at(-1);
  if (!modal) return source;
  const absolute = start + modal.index!;
  return `${source.slice(0, absolute)}${" ".repeat(modal[0].length)}${source.slice(absolute + modal[0].length)}`;
}

function factualMechanicFailure(source: string, mention: MechanicMention, sentence: TextRange, clause: string, match: RegExpMatchArray, aliases: readonly string[]): MechanicStateEvent | undefined {
  if (!mechanicFailureBelongsToMention(clause, mention.text.length, match.index!)) return undefined;
  const occurrence = { start: mention.start + match.index!, end: mention.start + match.index! + match[0].length, text: match[0] };
  const prefix = source.slice(Math.max(sentence.start, occurrence.start - 96), occurrence.start);
  const explicitUnavailable = /^not\s+available$/iu.test(match[0]);
  if (!explicitUnavailable && (/\b(?:isn[’']t|aren[’']t|wasn[’']t|weren[’']t|not|never|did\s+not|didn[’']t)\s+(?:permanently\s+)?(?:become\s+)?$/iu.test(prefix)
    || /(?:从未|并非|不是|绝非|没有|并未)(?:永久)?\s*$/u.test(prefix))) return undefined;
  if (/(?:不是|并非)没有(?:反馈|奖励)\s*$/u.test(source.slice(Math.max(sentence.start, occurrence.start - 96), occurrence.end))) return undefined;
  const terminalPlan = terminalPlannedMechanicFailure(source, sentence, occurrence);
  const factualitySource = terminalPlan ? maskTerminalPlanModal(source, sentence, occurrence) : source;
  if (nonActualReason(factualitySource, mechanicFactualityWindow(factualitySource, sentence, occurrence), mechanicFailureFactualityOccurrence(occurrence), { kind: "expected" }, aliases, true)) return undefined;
  return { ...occurrence, unavailable: true };
}

function factualMechanicRecovery(source: string, mention: MechanicMention, sentence: TextRange, match: RegExpMatchArray, aliases: readonly string[]): MechanicStateEvent | undefined {
  const occurrence = { start: mention.start + match.index!, end: mention.start + match.index! + match[0].length, text: match[0] };
  if (!mechanicRecoveryBelongsToMention(source, mention, occurrence, mention.start)) return undefined;
  if (nonActualReason(source, mechanicFactualityWindow(source, sentence, occurrence), occurrence, { kind: "expected" }, aliases, true)) return undefined;
  const prefix = source.slice(Math.max(sentence.start, occurrence.start - 72), occurrence.start);
  const suffix = source.slice(occurrence.end, Math.min(sentence.end, occurrence.end + 256));
  if (/\b(?:almost|nearly|barely|hardly|scarcely|allegedly|supposedly|apparently|plans?|does\s+not|did\s+not|never|not)\b[^.!?;]{0,28}$/iu.test(prefix)
    || /(?:差点|险些|勉强|几乎不能|据称|号称|看似|似乎|计划|打算|并未|没有|不)[^，。！？；]{0,16}$/u.test(prefix)) return undefined;
  if (/^\s+only\s+(?:to|for)\s+(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z'’-]*/iu.test(suffix)
    || /^\s*(?:只|仅)(?:对|向|供)[\p{Script=Han}]{1,12}/u.test(suffix)) return undefined;
  if (/^\s+(?:only\s+)?in\s+(?:her|his|their|an?|the)?\s*(?:imagination|dream|nightmare|fantasy|vision|hallucination)\b/iu.test(suffix)
    || /^\s*(?:只)?(?:在)?(?:她|他|他们|阿丽雅|主角)?的?(?:想象|梦境|梦里|幻想|幻觉)(?:中|里)?/u.test(suffix)) return undefined;
  if (/\b(?:in\s+name\s+only|label|banner|placard|manual)\b|(?:名义上|标签|横幅|标牌|手册)/iu.test(`${prefix} ${suffix}`)) return undefined;
  if (/\b(?:dashboard|banner|label|placard|manual|notice|interface|screen)\b[^.!?;]{0,30}\b(?:declares?|reads?|says?|shows?|displays?|describes?)\b/iu.test(prefix)
    || /(?:仪表盘|横幅|标签|标牌|手册|告示|界面|屏幕)[^。！？；]{0,24}(?:宣称|写着|显示|描述)/u.test(prefix)) return undefined;
  if (/\bno\s+(?:feedback|reward)\b|(?:没有|无)(?:任何)?(?:反馈|奖励)/iu.test(suffix)) return undefined;
  return { ...occurrence, unavailable: false };
}

function mechanicStateEvents(source: string, mention: MechanicMention, sentence: TextRange, boundary: number, aliases: readonly string[]): MechanicStateEvent[] {
  const clause = source.slice(mention.start, Math.min(sentence.end, boundary));
  const events: MechanicStateEvent[] = [];
  for (const match of clause.matchAll(mechanicFailurePattern)) {
    const event = factualMechanicFailure(source, mention, sentence, clause, match, aliases);
    if (event && event.start < boundary) events.push(event);
  }
  for (const match of clause.matchAll(mechanicRecoveryPattern)) {
    const event = factualMechanicRecovery(source, mention, sentence, match, aliases);
    if (event && event.start < boundary) events.push(event);
  }
  return events.sort((left, right) => left.start - right.start || Number(left.unavailable) - Number(right.unavailable));
}

function violatesMechanicInvariant(source: string, context?: NarrativeInvariantContext): boolean {
  const sentences = sentenceRanges(source);
  const mentions = mechanicMentions(source);
  const suppliedAliases = context?.protagonistAliases?.filter((alias) => alias.trim()) ?? [];
  const aliases = suppliedAliases.length ? normalizedAliases("protagonist", ["the protagonist", "主角", "主人公", ...suppliedAliases]) : [];
  const finalState = new Map<string, boolean>();
  const leadingPronoun = /^\s*(?:(?:then|later|afterward|afterwards|subsequently|随后|然后|后来)[,，]?\s*)?(it|它|其)(?=\s|[,，:：]|$|随后|然后|后来|立即|立刻|重新|再次|恢复|崩溃|故障|失灵|宕机|死机|瘫痪)/iu;
  let mentionIndex = 0;
  let previousEntity: string | undefined;
  let previousMention: MechanicMention | undefined;

  const applyEvents = (mention: MechanicMention, sentence: TextRange, boundary: number, entity: string): void => {
    for (const event of mechanicStateEvents(source, mention, sentence, boundary, aliases)) finalState.set(entity, event.unavailable);
  };

  for (const sentence of sentences) {
    while (mentionIndex < mentions.length && mentions[mentionIndex]!.end <= sentence.start) mentionIndex += 1;
    const firstInSentence = mentionIndex;
    let afterSentence = firstInSentence;
    while (afterSentence < mentions.length && mentions[afterSentence]!.start < sentence.end) afterSentence += 1;
    const firstMention = mentions[firstInSentence];
    const pronoun = leadingPronoun.exec(sentence.text);
    if (pronoun && previousEntity && (!firstMention || firstMention.start >= sentence.end || sentence.start + pronoun.index < firstMention.start)) {
      const pronounStart = sentence.start + pronoun.index + pronoun[0].lastIndexOf(pronoun[1]!);
      const synthetic: MechanicMention = { start: pronounStart, end: pronounStart + pronoun[1]!.length, text: pronoun[1]!, owner: "generic", generic: true };
      applyEvents(synthetic, sentence, firstMention?.start ?? sentence.end, previousEntity);
    }
    for (let index = firstInSentence; index < afterSentence; index += 1) {
      const mention = mentions[index]!;
      const entity = mechanicEntityKey(source, mention, aliases, previousEntity, previousMention);
      const next = index + 1 < afterSentence ? mentions[index + 1]!.start : sentence.end;
      applyEvents(mention, sentence, next, entity);
      previousEntity = entity;
      previousMention = mention;
    }
    mentionIndex = afterSentence;
  }

  if (aliases.length) return finalState.get(protagonistMechanicKey) === true;
  return [...finalState.values()].some(Boolean);
}

function outcomeContextRange(source: string, sentence: TextRange, occurrence: Occurrence): TextRange {
  const start = Math.max(sentence.start, occurrence.start - 320);
  const end = Math.min(sentence.end, occurrence.end + 320);
  return { start, end, text: source.slice(start, end) };
}

function adverseOutcomeAt(source: string, occurrence: Occurrence, sentence: TextRange): boolean {
  const prefix = source.slice(sentence.start, occurrence.start); const suffix = source.slice(occurrence.end, sentence.end);
  if (quoteDepthAt(source, occurrence.start) > 0 || reportScope(prefix, sentence.text, occurrence, { kind: "expected" }) || activeDreamContainer(source, occurrence.start)) return false;
  if (/\b(?:thought|mistook|mistakenly\s+believed|seemed|appeared)\b[^.!?;]{0,36}$/iu.test(prefix) || /(?:误以为|以为|看似|仿佛|似乎)[^，。！？；]{0,24}$/u.test(prefix)) return false;
  if (/\b(?:not|never|wasn[’']t|didn[’']t|did\s+not)\s+(?:actually\s+)?$/iu.test(prefix) || /(?:从未|并非|不是|没有|未曾|不曾)[^，。！？；]{0,8}$/u.test(prefix)) return false;
  if (/\b(?:may|might|could|would|will|shall)\s+(?:\w+\s+){0,2}$/iu.test(prefix) || /(?:可能|也许|或许|将会?|会)\s*$/u.test(prefix)) return false;
  return !/^(?:\s+in\s+name\s+only|\s+according\s+to)/iu.test(suffix);
}

function perceivedAdverse(prefix: string): boolean {
  return /\b(?:thought|mistook|mistakenly\s+believed|seemed|appeared)\b[^.!?;]{0,36}$/iu.test(prefix) || /(?:误以为|以为|看似|仿佛|似乎)[^，。！？；]{0,24}$/u.test(prefix);
}

function recoveryPronounRefersToProtagonist(source: string, sentence: TextRange, occurrence: Occurrence, aliases: readonly string[]): boolean {
  const prefix = source.slice(sentence.start, occurrence.start);
  if (!/\b(?:he|she|they)\s*$/iu.test(prefix) && !/(?:他|她|他们|她们)\s*$/u.test(prefix)) return false;
  const historyStart = Math.max(0, occurrence.start - 420);
  const history = source.slice(historyStart, occurrence.start);
  const latestAlias = aliases.flatMap((alias) => exactAliasOccurrences(history, alias)).sort((left, right) => right.end - left.end)[0];
  if (!latestAlias) return false;
  const intervening = history.slice(latestAlias.end);
  const foreignEnglishName = [...intervening.matchAll(/\b(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*\b/gu)]
    .map((match) => match[0])
    .filter((name) => !/^(?:In|Then|Later|Afterward|Afterwards|Actually|Meanwhile|Eventually|Finally|The|A|An)$/u.test(name))
    .some((name) => !aliasIdentity(aliases, name));
  if (foreignEnglishName) return false;
  const foreignChineseSubject = [...intervening.matchAll(/(?:^|[。！？；])\s*([\p{Script=Han}]{1,8}?)(?=站|走|来到|出现|上前|开口|说道|说|宣布|赢|获胜|落败|退|投降)/gu)]
    .map((match) => match[1]!)
    .some((name) => !aliases.some((alias) => name.endsWith(alias)));
  return !foreignChineseSubject;
}

function actualOutcomeRecoveryStarts(source: string, sentences: readonly TextRange[], protagonistAliases: readonly string[]): number[] {
  const correctionSource = "\\b(?:(?:never|did\\s+not|didn[’']t|had\\s+not|hadn[’']t|has\\s+not|hasn[’']t)\\s+(?:actually\\s+)?(?:lose|lost)|(?:was\\s+not|wasn[’']t|never\\s+was)\\s+(?:actually\\s+)?(?:defeated|beaten|weakened|injured))\\b|(?:从未|并未|没有|未曾)(?:真正)?(?:落败|败北|输掉|战败|被击败)";
  const positiveSource = "\\b(?:(?:stood|remained|emerged)\\s+victorious|wins?|won|defeats?|defeated|victory|unharmed|prevails?|prevailed|maintains?\\s+(?:the\\s+)?advantage)\\b|(?:获胜|击败|制胜|胜利|毫发无损|保持优势)";
  const candidates = new RegExp(`(?:${correctionSource})|(?:${positiveSource})`, "giu");
  const correction = new RegExp(`^(?:${correctionSource})$`, "iu");
  const starts: number[] = [];

  for (const match of source.matchAll(candidates)) {
    const occurrence = { start: match.index!, end: match.index! + match[0].length, text: match[0] };
    const containingSentence = sentenceFor(sentences, occurrence.start); if (!containingSentence) continue;
    const sentence = outcomeContextRange(source, containingSentence, occurrence);
    const prefix = source.slice(sentence.start, occurrence.start); const suffix = source.slice(occurrence.end, sentence.end);
    if (correction.test(match[0])) {
      const resolution = resolveInvariantSubject(source, sentence, occurrence, protagonistAliases);
      const explicitPronoun = /\b(?:he|she|they)\s*$/iu.test(prefix) || /(?:他|她|他们|她们)\s*$/u.test(prefix);
      const factualReset = /\b(?:but|instead|actually|in\s+fact|when\s+the\s+dust\s+settled)\b|(?:但|却|反而|事实上|实际(?:上)?|真相大白|尘埃散去|随后|然后)/iu.test(prefix);
      const explicitResetPronoun = explicitPronoun && factualReset && recoveryPronounRefersToProtagonist(source, sentence, occurrence, protagonistAliases);
      if (resolution.kind === "foreign" && !explicitResetPronoun) continue;
      const factuality = nonActualReason(source, sentence, occurrence, resolution, protagonistAliases, true);
      if (factuality !== "nonactual" && (resolution.kind === "expected" || explicitResetPronoun)) starts.push(occurrence.start);
      continue;
    }

    const localAt = lastConnectorStart(prefix); const polarityPrefix = prefix.slice(Math.max(0, localAt));
    if (nonActualReason(source, sentence, occurrence, { kind: "expected" }, protagonistAliases, true)) continue;
    if (/\b(?:almost|nearly|allegedly|supposedly|apparently|plans?|intends?|hopes?|not|never|no)\b[^.!?;]{0,24}$/iu.test(polarityPrefix) || /(?:差点|险些|据称|号称|看似|似乎|计划|打算|希望|并未|没有|不)[^，。！？；]{0,12}$/u.test(polarityPrefix)) continue;
    if (/\b(?:no\s+victory|victory\s+in\s+name\s+only|without\s+(?:securing|achieving))\b|(?:没有胜利|名义上的胜利|未能获胜)/iu.test(`${prefix} ${match[0]} ${suffix}`)) continue;
    let explicitOutcomeOwner = false;
    if (/^victory$/iu.test(match[0])) {
      const owner = /^\s+(?:belongs?|belonged|accrued|went)\s+to\s+((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)\b/iu.exec(suffix)?.[1];
      if (owner) {
        if (!aliasIdentity(protagonistAliases, owner)) continue;
        explicitOutcomeOwner = true;
      }
      const resultPredicate = resultPredicateBefore(source, sentence, { start: sentence.start, end: sentence.start, text: "" }, occurrence);
      const assertedNominal = !!resultPredicate
        || /^\s+(?:followed|came|arrived|resulted|was\s+(?:achieved|secured)|belongs?|belonged|accrued|went\s+to)\b/iu.test(suffix)
        || /\b(?:secured|achieved|gained|earned|claimed|won)\s*$/iu.test(prefix);
      if (!assertedNominal) continue;
    }
    const resolution = resolveInvariantSubject(source, sentence, occurrence, protagonistAliases);
    if (resolution.kind === "expected" || explicitOutcomeOwner) { starts.push(occurrence.start); continue; }
    const explicitPronounRecovery = /\b(?:he|she|they)\s*$/iu.test(prefix) || /(?:他|她|他们|她们)\s*$/u.test(prefix);
    const factualReset = /\b(?:but|instead|actually|in\s+fact|when\s+the\s+dust\s+settled)\b|(?:但|却|反而|事实上|实际(?:上)?|真相大白|尘埃散去|随后|然后)/iu.test(prefix);
    if (explicitPronounRecovery && factualReset && recoveryPronounRefersToProtagonist(source, sentence, occurrence, protagonistAliases)) starts.push(occurrence.start);
  }
  return starts;
}

function hasActualOutcomeRecovery(after: number, recoveryStarts: readonly number[]): boolean {
  let low = 0; let high = recoveryStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (recoveryStarts[middle]! < after) low = middle + 1;
    else high = middle;
  }
  return low < recoveryStarts.length;
}

function hasOccurrenceBefore(at: number, occurrences: readonly Occurrence[]): boolean {
  let low = 0; let high = occurrences.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (occurrences[middle]!.end <= at) low = middle + 1;
    else high = middle;
  }
  return low > 0;
}

function embeddedWorkScope(source: string, sentence: TextRange, at: number): boolean {
  const prefix = source.slice(sentence.start, at);
  return /\b(?:novel|story|play|film|movie|book|performance)\b[^.!?;]{0,72}\b(?:where|in\s+which|whose|depict(?:s|ed|ing)?|show(?:s|ed|ing)?)\b[^.!?;]*$/iu.test(prefix)
    || /(?:小说|故事|戏剧|戏|剧|电影|书|演出)(?:里|中)的?(?:主角|人物)?[^。！？；]*$/u.test(prefix)
    || /(?:小说|故事|戏剧|电影|演出)[^。！？；]{0,48}(?:里|中|里的|中的|描写|描绘|讲述)[^。！？；]*$/u.test(prefix);
}

function abstractCaptureAgent(value: string): boolean {
  const phrase = value.trim();
  if (!phrase) return false;
  if (/[\p{Script=Han}]/u.test(phrase)) {
    return /(?:美丽|美景|景色|风光|晚霞|朝霞|霞光|月色|光芒|魅力|吸引力|旋律|音乐|歌声|钟声|笑容|温柔|诗意|氛围|情绪|感觉|想象|幻想|思想|念头|回忆|故事|文字|宁静)/u.test(phrase);
  }
  if (/^(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*$/u.test(phrase)) return false;
  return /\b(?:beauty|splendou?r|majesty|charm|allure|wonder|glow|light|dawn|sunset|music|melody|song|sound|silence|atmosphere|mood|emotion|feeling|imagination|idea|thought|memory|moment|scene|sight|view|landscape|smile|laughter|story|words?|poetry)\b/iu.test(phrase);
}

type AdverseDomainKind = "conflict" | "figurative" | "unknown";

function adverseDomainKind(value: string): AdverseDomainKind {
  const phrase = value.trim();
  if (!phrase) return "unknown";
  if (/[\p{Script=Han}]/u.test(phrase)) {
    if (/(?:敌人|敌军|强敌|仇敌|对手|敌手|竞争者|挑战者|冠军|山贼|刺客|怪物|妖兽|兽潮|军队|军团|攻势|攻击|袭击|突袭|进攻|围攻|围剿|战斗|决斗|决战|交锋|对决|擂台|比赛|竞赛|战役|战争)/u.test(phrase)) return "conflict";
    if (abstractCaptureAgent(phrase)
      || /(?:撒娇|卖萌|恳求|央求|请求|眼泪|泪水|可爱|甜言蜜语|善意|好意|爱意|爱情|感情|浪漫|亲情|友情|关心|厨艺|手艺|审美|品味|截止日期|期限|日程|排期|作业|家务|工作量|文书|会议|邮件|闹钟|懒惰|拖延|困意|睡意|无聊|尴尬|压力|习惯|脾气|食欲|诱惑)/u.test(phrase)) return "figurative";
    return "unknown";
  }
  if (/\b(?:enemy|opponent|rival|challenger|champion|raiders?|army|troops?|horde|assault|attack|offensive|siege|ambush|battle|duel|fight|match|contest|war|combat)\b/iu.test(phrase)) return "conflict";
  if (abstractCaptureAgent(phrase)
    || /\b(?:kindness|gentleness|tenderness|affection|love|romance|friendship|pleading|begging|cuteness|tears?|cooking|cuisine|deadline|schedule|paperwork|chores?|workload|meetings?|emails?|alarm|boredom|embarrassment|sleepiness|laziness|procrastination|pressure|habit|temper|appetite|temptation)\b/iu.test(phrase)) return "figurative";
  return "unknown";
}

function figurativeAdverseDomain(source: string, occurrence: Occurrence, sentence: TextRange): boolean {
  const surface = occurrence.text.toLocaleLowerCase();
  const prefix = source.slice(sentence.start, occurrence.start);
  const suffix = source.slice(occurrence.end, sentence.end);
  const domains: string[] = [];

  const chinesePassive = /被([^，。！？；]{1,32}?)(?:击败|打败|击溃)$/u.exec(occurrence.text);
  if (chinesePassive) domains.push(chinesePassive[1]!);
  if (/\b(?:defeated|beaten|bested|vanquished|overpowered|overwhelmed|routed|crushed)$/iu.test(surface)) {
    const englishAgent = /^\s+by\s+([^.!?;,]{1,96})/iu.exec(suffix)?.[1];
    if (englishAgent) domains.push(englishAgent);
  }

  if (/^(?:yielded\s+to|capitulated(?:\s+to)?|succumbed(?:\s+to)?|surrenders?|surrendered)$/iu.test(surface)) {
    const englishTarget = /\bto$/iu.test(surface)
      ? /^\s+([^.!?;,]{1,96})/iu.exec(suffix)?.[1]
      : /^\s+to\s+([^.!?;,]{1,96})/iu.exec(suffix)?.[1];
    if (englishTarget) domains.push(englishTarget);
  }

  const chinesePrefix = prefix.replace(/(?:(?:彻底|最终|终于|还是|只好|不得不|果断|干脆|当场|主动|再次|已经)\s*){1,3}$/u, "");
  const frontedChinese = /(?:面对|面临)([^，,。！？；]{1,40})[，,][^，,。！？；]{0,64}$/u.exec(chinesePrefix)?.[1];
  const chineseBefore = /在([^，。！？；]{1,32})面前$/u.exec(chinesePrefix)?.[1];
  const chineseTarget = /(?:向|对)([^，。！？；]{1,32})$/u.exec(chinesePrefix)?.[1];
  if (frontedChinese) domains.push(frontedChinese);
  if (chineseBefore) domains.push(chineseBefore);
  if (chineseTarget) domains.push(chineseTarget);

  const frontedEnglish = /\b(?:faced\s+with|facing)\s+([^,]{1,80}),[^,]{0,96}$/iu.exec(prefix)?.[1];
  if (frontedEnglish) domains.push(frontedEnglish);
  return domains.some((domain) => adverseDomainKind(domain) === "figurative");
}

function adverseSenseApplies(source: string, occurrence: Occurrence, sentence: TextRange): boolean {
  const surface = occurrence.text.toLocaleLowerCase();
  const suffix = source.slice(occurrence.end, sentence.end);
  if (figurativeAdverseDomain(source, occurrence, sentence)) return false;
  if (/^(?:输了|输给)/u.test(surface) && /[传运灌]$/u.test(source.slice(sentence.start, occurrence.start))) return false;
  if (/^fell\s+to\b/u.test(surface)) {
    return /^fell\s+to\s+(?:(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|the\s+(?:enemy|opponent|champion|rival))\b/u.test(occurrence.text);
  }
  if (/^(?:lost|loses?)$/u.test(surface)) {
    const manner = "(?:(?:[A-Za-z][A-Za-z'’-]*ly)\\s*){0,3}";
    const modifiers = "(?:[A-Za-z][A-Za-z'’-]*\\s+){0,3}";
    const outcomeNoun = "(?:duel|fight|match|battle|contest|war|game|championship|advantage|lead|goal|objective|mission|quest|resistance|powers?|abilities|strength|magic|cultivation)";
    const outcomeBoundary = "(?=\\s*(?:$|[.!?;,]|(?:to|against|versus|by|with|for|over|as|while|when|after|before|because|although|though)\\b))";
    return new RegExp(`^\\s*${manner}(?:(?:(?:the|a|an|her|his|their)\\s+)?${modifiers}${outcomeNoun}\\b${outcomeBoundary}|to\\b|[.!?;,]|but\\b|and\\s+(?:was|became)\\b)`, "iu").test(suffix);
  }
  if (/^(?:draws?|drew)$/u.test(surface)) return /^\s*(?:(?:the|a|an)\s+)?(?:duel|fight|match|battle|contest|game)\b/iu.test(suffix);
  if (/^(?:gave\s+up|gives?\s+up)$/u.test(surface)) return /^\s*(?:(?:the|a|an|her|his|their)\s+)?(?:goal|objective|mission|quest|fight|battle|contest|resistance|cause)\b/iu.test(suffix) || /^\s*[.!?;,]/u.test(suffix);
  if (/^surrenders?$/u.test(surface) || /^surrendered$/u.test(surface)) return /^\s*(?:(?:[A-Za-z][A-Za-z'’-]*ly)\s*){0,3}(?:to\b|[.!?;,])/iu.test(suffix);
  if (/^was\s+tied$/u.test(surface)) return !/^\s+up\s+with\s+(?:work|chores|paperwork|meetings?|tasks?|deadlines?)\b/iu.test(suffix);
  if (/^(?:died|dies)$/u.test(surface)) return !/^\s+(?:laughing|giggling|of\s+(?:laughter|embarrassment|shame|boredom)|from\s+(?:laughter|embarrassment|shame|boredom))\b/iu.test(suffix);
  if (/^(?:was|got)\s+captured$/u.test(surface)) {
    const agent = /^\s+by\s+([^.!?;,]{1,96})/u.exec(suffix)?.[1];
    return !agent || !abstractCaptureAgent(agent);
  }
  const chineseCapture = /^被([^，。！？；]{1,24}?)(?:俘虏|俘获|抓获)$/u.exec(occurrence.text);
  if (chineseCapture) return !abstractCaptureAgent(chineseCapture[1]!);
  return true;
}

function attributedSurrender(source: string, aliases: readonly string[]): boolean {
  for (const alias of aliases) {
    const escaped = escapeRegex(alias);
    const englishAfter = new RegExp(`["“][^"”]{0,48}\\bI\\s+(?:surrender|give\\s+up)\\b[^"”]{0,24}["”][^.!?;。！？；]{0,32}\\b${escaped}\\b\\s+(?:said|shouted|cried|yelled|declared)\\b`, "iu");
    const englishBefore = new RegExp(`\\b${escaped}\\b\\s+(?:said|shouted|cried|yelled|declared)[^.!?;。！？；]{0,24}[,，:]?\\s*["“][^"”]{0,48}\\bI\\s+(?:surrender|give\\s+up)\\b`, "iu");
    const chineseAfter = new RegExp(`[“「『][^”」』]{0,32}我(?:投降|认输|放弃)[^”」』]{0,16}[”」』][^。！？；]{0,24}${escaped}(?:喊道|说道|叫道|宣布|承认)`, "u");
    const chineseBefore = new RegExp(`${escaped}(?:喊道|说道|叫道|宣布|承认)[^。！？；]{0,16}[：:,，]?\\s*[“「『][^”」』]{0,32}我(?:投降|认输|放弃)`, "u");
    if (englishAfter.test(source) || englishBefore.test(source) || chineseAfter.test(source) || chineseBefore.test(source)) return true;
  }
  return false;
}

function protagonistPatientViolation(source: string, sentences: readonly TextRange[], aliases: readonly string[]): boolean {
  for (const alias of aliases) {
    for (const mention of exactAliasOccurrences(source, alias)) {
      const containingSentence = sentenceFor(sentences, mention.start); if (!containingSentence) continue;
      const sentence = outcomeContextRange(source, containingSentence, mention);
      if (quoteDepthAt(source, mention.start) > 0 || embeddedWorkScope(source, sentence, mention.start)) continue;
      const before = source.slice(sentence.start, mention.start);
      const after = source.slice(mention.end, sentence.end);
      const englishSelfHarm = /^\s+(?:(?:deliberately|intentionally|knowingly|accidentally|personally)\s+)*(killed|slew|slayed|injured|wounded|hurt|weakened|poisoned)\s+(?:herself|himself)\b/iu.exec(after)
        ?? /^\s+(?:(?:deliberately|intentionally|knowingly|accidentally|personally)\s+)*(knocked)\s+(?:herself|himself)\s+(?:out|unconscious)\b/iu.exec(after)
        ?? /^\s+(?:(?:deliberately|intentionally|knowingly|accidentally|personally)\s+)*(let|allowed)\s+(?:herself|himself)\s+(?:be\s+)?(?:defeated|beaten|killed|captured|injured)\b/iu.exec(after);
      const chineseSelfHarm = /^\s*(?:亲手|故意|有意|不慎)?\s*(杀死|击杀|杀害|打伤|击伤|削弱|毒伤|打晕|击昏)(?:了)?自己/u.exec(after);
      const selfHarm = englishSelfHarm ?? chineseSelfHarm;
      if (selfHarm) {
        const surface = selfHarm[1]!;
        const verbStart = mention.end + selfHarm.index + selfHarm[0].indexOf(surface);
        const verb = { start: verbStart, end: verbStart + surface.length, text: surface };
        if (!nonActualReason(source, sentence, verb, { kind: "expected" }, aliases, true)) return true;
      }
      if (/^[’']s\s+(?:power|strength|ability|magic)\s+(?:was|is)\s+(?:temporarily\s+)?(?:sealed|lost|removed|destroyed|stripped\s+away)\b/iu.test(after)
        || /^的(?:力量|能力|实力|修为)被(?:暂时)?(?:封印|夺走|废除|摧毁)/u.test(after)) return true;
      if (/^\s*[’']s\s+[A-Za-z][A-Za-z0-9'’-]*\b/u.test(after) || /^的[\p{Script=Han}]{1,12}/u.test(after)) continue;
      const englishDirect = /\b(defeated|beat|beaten|vanquished|routed|crushed|killed|slew|slain|annihilated|overpowered|overwhelmed|weakened|injured|wounded|hurt|captured|eliminated|incapacitated|rescued|saved)\s+(?:the\s+)?$/iu.exec(before);
      const englishForced = /\b(forced)\s+(?:the\s+)?$/iu.exec(before);
      const englishKnock = /\b(knocked)\s+(?:the\s+)?$/iu.exec(before);
      const chineseDirect = /(击败|打败|杀死|击杀|杀害|削弱|打伤|击伤|俘虏|抓获|打晕|击昏|救下|救出|救了|迫使)了?\s*$/u.exec(before);
      const direct = englishDirect ?? englishForced ?? englishKnock ?? chineseDirect;
      const directTail = englishForced ? /^\s+to\s+(?:retreat|surrender|give\s+up|concede)\b/iu.test(after) : englishKnock ? /^\s+(?:out|unconscious)\b/iu.test(after) : chineseDirect?.[1] === "迫使" ? /^\s*(?:撤退|投降|认输|放弃)/u.test(after) : true;
      const directSurface = direct?.[1] ?? "";
      const captureAgent = direct ? before.slice(0, before.length - direct[0].length) : "";
      const figurativeCapture = /^(?:captured|俘虏|俘获|抓获)$/iu.test(directSurface) && abstractCaptureAgent(captureAgent);
      if (direct && directTail && !figurativeCapture) {
        const verbStart = mention.start - direct[0].length;
        const verb = { start: verbStart, end: mention.start, text: direct[1] ?? direct[0] };
        if (!nonActualReason(source, sentence, verb, { kind: "expected" }, aliases, true)) return true;
      }
      if (/\b(?:stalemate|draw)\s+for\s*$/iu.test(before) || /(?:平局|平手)(?:属于|落到)?\s*$/u.test(before)) return true;
      const chinesePassive = /^\s*被([^，。！？；]{1,24}?)(击杀|杀死|击败|打败|削弱|打伤|击伤|迫使撤退)/u.exec(after);
      if (chinesePassive && adverseDomainKind(chinesePassive[1]!) !== "figurative") {
        const verbStart = mention.end + chinesePassive.index + chinesePassive[0].lastIndexOf(chinesePassive[2]!);
        const verb = { start: verbStart, end: verbStart + chinesePassive[2]!.length, text: chinesePassive[2]! };
        if (!nonActualReason(source, sentence, verb, { kind: "expected", text: alias }, aliases, true)) return true;
      }
      if (/^\s*与[^，。！？；]{1,16}打成平手/u.test(after)) return true;
      const aliasAsSubject = /^\s*$/u.test(before) || new RegExp(`(?:^|[,，])\\s*${escapeRegex(alias)}\\s*$`, "iu").test(before);
      if (aliasAsSubject && /^\s+needed\s+(?!(?:herself|himself|themselves)\b)[^.!?;]{1,40}\s+to\s+(?:save|rescue)\s+(?:her|him|them)\b/iu.test(after)) return true;
    }
  }
  const fronted = /^\s*(?:defeated|beaten|injured|weakened|overpowered)\s+by\s+[^,，]{1,40}[,，]\s*((?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*)\b/iu.exec(source)?.[1];
  return !!fronted && aliases.some((alias) => alias.toLocaleLowerCase() === fronted.toLocaleLowerCase());
}

function adverseFactualityOccurrence(occurrence: Occurrence): Occurrence {
  // "Failed/could not defeat" does not assert the embedded positive victory,
  // but it does assert the adverse inability itself.  Check the surrounding
  // factual scope with a neutral adverse head so the generic realization
  // modality guard cannot erase that distinction.
  if (/^(?:fail(?:s|ed)?\s+to\s+(?:defeat|beat|overcome|vanquish|win)|could\s+not\s+(?:defeat|beat|overcome|vanquish|win)|couldn[’']t\s+(?:defeat|beat|overcome|vanquish|win))$/iu.test(occurrence.text)) {
    return { ...occurrence, text: "failed" };
  }
  if (/^(?:未能|无法)(?:击败|打败|战胜|获胜)$/u.test(occurrence.text)) {
    return { ...occurrence, text: "落败" };
  }
  return occurrence;
}

function terminalBlueprintOutcomeAssertion(source: string, sentence: TextRange, occurrence: Occurrence, context?: NarrativeInvariantContext): boolean {
  if (context?.assertionMode !== "blueprint") return false;
  const local = source.slice(sentence.start, sentence.end);
  const definiteFuture = /\b(?:will|shall)\b/iu.test(occurrence.text) || /(?:将会?|会)/u.test(occurrence.text);
  if (!definiteFuture) return false;
  const uncertain = /\b(?:may|might|could|possibly|perhaps|maybe|probably|allegedly|reportedly)\b|(?:可能|也许|或许|未必|据说|据称)/iu.test(source.slice(sentence.start, occurrence.end));
  if (uncertain) return false;
  return /\b(?:permanent(?:ly)?|irreversible|irreversibly|forever|for\s+good|(?:at|by|in|before)\s+(?:(?:the|story[’']s)\s+)?(?:ending|end|finale|conclusion|final\s+chapter|last\s+chapter|climax)|final\s+chapter|last\s+chapter)\b/iu.test(local)
    || /(?:永久|永远|不可逆|彻底|结局|终章|最终章|最后一章|大结局|收官)/u.test(local);
}

function plannedOutcomeFactualityOccurrence(occurrence: Occurrence): Occurrence {
  return { ...occurrence, text: /[\p{Script=Han}]/u.test(occurrence.text) ? "落败" : "defeated" };
}

function violatesOutcomeInvariant(source: string, context?: NarrativeInvariantContext): boolean {
  const sentences = sentenceRanges(source);
  const protagonistAliases = normalizedAliases("protagonist", ["the protagonist", "主角", "主人公", ...(context?.protagonistAliases ?? [])]);
  if (attributedSurrender(source, protagonistAliases) || protagonistPatientViolation(source, sentences, protagonistAliases)) return true;
  const protagonistMentions = protagonistAliases.flatMap((alias) => exactAliasOccurrences(source, alias)).sort((a, b) => a.start - b.start);
  let recoveryStarts: number[] | undefined;
  const adverse = /\b(?:fail(?:s|ed)?\s+to\s+(?:defeat|beat|overcome|vanquish|win)|could\s+not\s+(?:defeat|beat|overcome|vanquish|win)|couldn[’']t\s+(?:defeat|beat|overcome|vanquish|win)|conceded\s+(?:the\s+)?defeat|yielded\s+to|capitulated(?:\s+to)?|succumbed(?:\s+to)?|lost|loses?|surrenders?|surrendered|draws?|drew|fled|fell\s+to\s+(?:(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|the\s+(?:enemy|opponent|champion|rival))(?:\s+in\s+(?:the\s+)?(?:duel|fight|battle|match|contest))?|died|dies|perished|was\s+(?:temporarily\s+)?weakened|was\s+(?:injured|wounded|slain|eliminated|captured|incapacitated)|was\s+(?:outmatched|overcome)\s+by\s+(?:(?:(?:Captain|Lady|Lord|Doctor|Dr\.?|Sir)\s+)?[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*|the\s+(?:enemy|opponent|champion|rival))|was\s+knocked\s+(?:out|unconscious)|was\s+(?:rendered|left)\s+unconscious|(?:became|fell)\s+unconscious|was\s+tied(?:\s+with\s+[^.!?;]+)?|was\s+(?:routed|crushed)(?:\s+by\s+[^.!?;]+)?|was\s+killed|was\s+annihilated|gave\s+up|gives?\s+up|was\s+(?:rescued|defeated|beaten|bested|overpowered|overwhelmed|forced\s+to\s+retreat)|got\s+(?:beaten|defeated|bested|captured|knocked\s+out)|suffered\s+(?:a\s+)?defeat|barely\s+survived)\b|(?:未能|无法)(?:击败|打败|战胜|获胜)|(?:(?<![传运])输了|(?<!腐)败了|(?<![传运])输给了?[^，。！？；]{1,24}|败在[^，。！？；]{1,24}(?:手下|手中)|承认失败|认输|惨败|战败|一败涂地|铩羽而归|战平|打成平手|失去(?:了)?(?:优势|力量|能力|实力|修为)|投降|放弃目标|败下阵来|败给[^，。！？；]*|败于[^，。！？；]*|不敌[^，。！？；]*|暂时被削弱|(?:身受重伤|负伤|受伤倒地)|(?:陷入)?昏迷|死亡|死在|被[^，。！？；]{0,16}(?:击溃|俘虏|俘获|抓获|打晕|击昏)|被打得毫无还手之力|被(?:人)?救场|被(?:击败|打败|迫使?撤退)|落败|败北|勉强(?:活下|生还))/giu;
  const tenseAndTerminalAdverse = /\b(?:(?:is|are|was|were)\s+(?:(?:permanently|irreversibly|decisively|finally|completely|utterly|soundly|clearly|temporarily)\s+){0,3}(?:defeated|beaten|bested|vanquished|overpowered|overwhelmed|routed|crushed)|(?:will|shall)\s+(?:(?:finally|eventually|permanently|irreversibly|decisively)\s+)*(?:(?:be\s+(?:(?:permanently|irreversibly|decisively|completely|utterly|soundly)\s+)*(?:defeated|beaten|bested|vanquished|overpowered|overwhelmed|routed|crushed))|surrender|lose|yield|capitulate))\b|(?:(?:最终|最后|彻底|永久|永远)?被[^，。！？；]{0,20}(?:击败|打败)|输掉(?:了)?[^，。！？；]{0,16}(?:决斗|决战|比赛|战斗|对决)|(?:将会?|会)[^，。！？；]{0,28}?(?:被[^，。！？；]{0,16}(?:击败|打败)|投降|认输|输掉(?:了)?[^，。！？；]{0,12}(?:决斗|决战|比赛|战斗|对决)))/giu;
  const perfectPassiveAdverse = /\b(?:(?:has|have|had)\s+(?:(?:ultimately|still|eventually|decisively|unexpectedly|finally|clearly|completely|soundly|utterly|inevitably|again|already)\s+){0,3}been|(?:will|shall)\s+(?:(?:ultimately|eventually|decisively|finally|permanently|irreversibly)\s+){0,3}have\s+(?:(?:ultimately|eventually|decisively|finally|permanently|irreversibly)\s+){0,3}been)\s+(?:(?:permanently|irreversibly|decisively|finally|completely|utterly|soundly|clearly)\s+){0,3}(?:defeated|beaten|bested|vanquished|overpowered|overwhelmed|routed|crushed)\b/giu;
  const adverseMatches = [...source.matchAll(adverse), ...source.matchAll(tenseAndTerminalAdverse), ...source.matchAll(perfectPassiveAdverse)]
    .sort((left, right) => left.index! - right.index! || right[0].length - left[0].length);
  const seen = new Set<string>();
  for (const match of adverseMatches) {
    const occurrence = { start: match.index!, end: match.index! + match[0].length, text: match[0] };
    const occurrenceKey = `${occurrence.start}:${occurrence.end}`; if (seen.has(occurrenceKey)) continue; seen.add(occurrenceKey);
    const containingSentence = sentenceFor(sentences, occurrence.start); if (!containingSentence) continue;
    const sentence = outcomeContextRange(source, containingSentence, occurrence);
    if (embeddedWorkScope(source, sentence, occurrence.start) || !adverseSenseApplies(source, occurrence, sentence)) continue;
    const before = source.slice(sentence.start, occurrence.start);
    const resolution = resolveInvariantSubject(source, sentence, occurrence, protagonistAliases);
    if (resolution.kind === "foreign") continue;
    if (resolution.kind === "ambiguous" && !hasOccurrenceBefore(occurrence.start, protagonistMentions)) continue;
    if (perceivedAdverse(before)) {
      recoveryStarts ??= actualOutcomeRecoveryStarts(source, sentences, protagonistAliases);
      if (!hasActualOutcomeRecovery(occurrence.end, recoveryStarts)) return true;
      continue;
    }
    const plannedAssertion = terminalBlueprintOutcomeAssertion(source, sentence, occurrence, context);
    const factualityOccurrence = plannedAssertion ? plannedOutcomeFactualityOccurrence(occurrence) : adverseFactualityOccurrence(occurrence);
    if (nonActualReason(source, sentence, factualityOccurrence, resolution, protagonistAliases, true)) continue;
    if (plannedAssertion || adverseOutcomeAt(source, occurrence, sentence)) return true;
  }
  return false;
}

export function violatesNarrativeInvariant(id: NarrativeInvariantId, source: string, context?: NarrativeInvariantContext): boolean {
  switch (id) {
    case "curated-mechanic-unavailable": return violatesMechanicInvariant(source, context);
    case "curated-outcome-weakened": return violatesOutcomeInvariant(source, context);
  }
}
