import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOpeningNarrationStructure,
  detectNarrationCandidates,
  narrationArtifactHash,
} from "../server/narrationPolicy";

test("known false positive is located with stable three-sentence context", () => {
  const body = "雨停了。老人递来半本卷边残诗稿，纸角还沾着泥。门外又响起脚步声。";
  const hash = narrationArtifactHash("旧稿", [body]);
  const [candidate] = detectNarrationCandidates("body", body, hash);

  assert.ok(candidate);
  assert.equal(candidate.matchedText, "本卷");
  assert.equal(candidate.sentence, "老人递来半本卷边残诗稿，纸角还沾着泥。");
  assert.equal(candidate.previousSentence, "雨停了。");
  assert.equal(candidate.nextSentence, "门外又响起脚步声。");
  assert.equal(candidate.contentHash, hash);
  assert.equal(body.slice(candidate.matchStart, candidate.matchEnd), candidate.matchedText);
  assert.equal(body.slice(candidate.sentenceStart, candidate.sentenceStart + candidate.sentence.length), candidate.sentence);
});

test("sentence boundaries include closing quotes and preserve absolute offsets", () => {
  const body = "他问：“这是本卷目标吗？”她摇头。\r\n灯灭了；走廊里，作者在这里安排转折……随后风停了。";
  const hash = narrationArtifactHash("边界", [body]);
  const candidates = detectNarrationCandidates("body", body, hash);
  const volume = candidates.find((candidate) => candidate.matchedText.startsWith("本卷"));
  const author = candidates.find((candidate) => candidate.matchedText.startsWith("作者"));

  assert.ok(volume);
  assert.equal(volume.sentence, "他问：“这是本卷目标吗？”");
  assert.equal(volume.nextSentence, "她摇头。");
  assert.ok(author);
  assert.equal(author.previousSentence, "灯灭了；");
  assert.equal(author.sentence, "走廊里，作者在这里安排转折……");
  for (const candidate of candidates) {
    assert.equal(body.slice(candidate.matchStart, candidate.matchEnd), candidate.matchedText);
  }
});

test("candidate detection retains ambiguous word-boundary cases for semantic review", () => {
  for (const sentence of [
    "他找到了这本卷边旧书。",
    "黑板上写着基本卷积运算。",
    "本卷目标是推进角色弧。",
    "作者在这里安排转折。",
  ]) {
    const hash = narrationArtifactHash("测试", [sentence]);
    assert.ok(detectNarrationCandidates("body", sentence, hash).length > 0, sentence);
  }
});

test("candidate IDs are deterministic and duplicate ranges are collapsed", () => {
  const body = "前面剧情留下的记忆再次浮现。";
  const hash = narrationArtifactHash("稳定", [body]);
  const first = detectNarrationCandidates("body", body, hash);
  const second = detectNarrationCandidates("body", body, hash);

  assert.deepEqual(second, first);
  assert.equal(new Set(first.map((candidate) => [candidate.matchStart, candidate.matchEnd].join(":"))).size, first.length);
  assert.notEqual(detectNarrationCandidates("title", body, hash)[0]?.id, first[0]?.id);
});

test("opening structure gate blocks embedded chapter headings without deciding semantic candidates", () => {
  assert.throws(
    () => assertOpeningNarrationStructure("雨夜旧稿", "门开了。\n第 1 章 真相\n脚步声逼近。"),
    /内嵌章节标题/,
  );
  assert.throws(() => assertOpeningNarrationStructure("第一章", "门开了。"), /有效章名/);
  assert.doesNotThrow(() => assertOpeningNarrationStructure("雨夜旧稿", "老人递来半本卷边残诗稿。"));
});
