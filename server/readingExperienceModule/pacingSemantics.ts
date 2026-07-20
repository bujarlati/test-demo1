export interface PacingFacetBinding {
  anchorIndex: number;
  facets: readonly ("goal" | "pressure" | "beat" | "turn")[];
  text: string;
}

const propositionBoundary = /\n+|[.!?;。！？；—]+|\b(?:but|then|yet|instead|afterwards?|subsequently)\b|(?:但是|但|然后|接着|继而|而后|随后|下一刻|紧接着|却|反而|而是)/iu;
const nonActualModality = /\b(?:not|never|cannot|can[’']t|couldn[’']t|shouldn[’']t|wouldn[’']t|won[’']t|doesn[’']t|don[’']t|didn[’']t|isn[’']t|aren[’']t|wasn[’']t|weren[’']t|hasn[’']t|haven[’']t|hadn[’']t|plan(?:s|ned|ning)?|intend(?:s|ed|ing)?|prepar(?:e|es|ed|ing)|want(?:s|ed|ing)?|hop(?:e|es|ed|ing)?|wish(?:es|ed|ing)?|aim(?:s|ed|ing)?|attempt(?:s|ed|ing)?|tr(?:y|ies|ied|ying)|fail(?:s|ed|ing)?|almost|nearly|simulat(?:e|es|ed|ing|ion)|predict(?:s|ed|ing|ion|ions)?|dream(?:s|ed|ing|t)?|imagin(?:e|es|ed|ing|ation)|pretend(?:s|ed|ing)?|seem(?:s|ed|ing)?|apparently|conditional|if|would|might|may|could|should|perhaps|maybe|possibly|possible)\b|(?:没有|未能|并未|未曾|不曾|无法|不能|不会|不愿|不肯|绝不|从不|计划|打算|准备|将要|想要|希望|意图|意欲|试图|试着|尝试|险些|差点|失败|梦境|做梦|模拟|预测|预言|如果|幻想|想象|假装|似乎|仿佛|看似|可能|也许|或许|大概)/iu;
const affirmativeNegation = /\bnot\s+only\b|(?:没有|未曾|未尝)不|不得不|不能不|不会不|不可不|未尝不|何尝不|毫不(?:犹豫|迟疑|费力|畏惧|在意|示弱|留情|客气)|不(?:假思索|慌不忙|紧不慢|卑不亢|知不觉|动声色|约而同|期而遇|谋而合|费吹灰之力)/giu;

function propositions(text: string): string[] {
  return text.normalize("NFKC")
    .split(propositionBoundary)
    .map((part) => part.trim())
    .filter((part) => part.replace(/[^\p{L}\p{N}]+/gu, "").length >= 2);
}

/**
 * A pacing facet must use one atomic judge-selected anchor. Strong proposition
 * boundaries require the judge to return a smaller exact anchor, because the
 * current schema cannot identify which side owns the facet. Any nonactual modality
 * likewise requires a smaller exact anchor for the realized action; coordination
 * alone cannot prove that the action realizes the facet named by the judge.
 */
export function pacingFacetIsRealized(binding: PacingFacetBinding): boolean {
  const normalized = binding.text.normalize("NFKC");
  if (nonActualModality.test(normalized.replace(affirmativeNegation, " "))) return false;
  const scoped = propositions(normalized);
  if (scoped.length !== 1) return false;
  return true;
}
