import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyNarrativeRealization,
  violatesNarrativeInvariant,
  type NarrativeRealizationInput,
  type RealizationBinding,
} from "../server/readingExperienceModule/narrativeSemantics/index";

type ExpectedCase = readonly [source: string, expected: boolean];

const englishBinding: RealizationBinding = {
  actor: "Aria",
  action: "open",
  object: "gate",
  outcome: "victory",
  requiredSlots: ["actor", "action", "object", "outcome"],
};

const chineseBinding: RealizationBinding = {
  actor: "阿丽雅",
  action: "打开",
  object: "城门",
  outcome: "胜利",
  requiredSlots: ["actor", "action", "object", "outcome"],
};

function realized(
  source: string,
  binding: RealizationBinding = englishBinding,
  extras: Partial<NarrativeRealizationInput> = {},
): boolean {
  return verifyNarrativeRealization({ source, binding, ...extras }).status === "realized";
}

function expectCases(cases: readonly ExpectedCase[], evaluate: (source: string) => boolean): void {
  const actual = cases.map(([source, expected]) => ({ source, actual: evaluate(source), expected }));
  const expected = cases.map(([source, value]) => ({ source, actual: value, expected: value }));
  assert.deepEqual(actual, expected);
}

test("postposed attribution, cognitive containers, and productive conditions stay nonactual", () => {
  expectCases([
    ["Aria opened the gate and secured victory, according to Bob.", false],
    ["Aria opened the gate and secured victory, Bob claimed.", false],
    ["Aria opened the gate and secured victory during a hallucination.", false],
    ["Subject to Bob agreeing, Aria opens the gate and secures victory.", false],
    ["The hallucination ended, and Aria opened the gate and secured victory.", true],
  ], realized);

  expectCases([
    ["阿丽雅打开城门并取得胜利，据李雷所说。", false],
    ["幻境消散，阿丽雅打开城门并取得胜利。", true],
  ], (source) => realized(source, chineseBinding));
});

test("protagonist mechanic failures remain bound through English and Chinese pronouns", () => {
  expectCases([
    ["Aria checked her system. It crashed.", true],
    ["Aria's system flickered, and then it crashed.", true],
    ["Aria's system crashed. It came back online.", false],
    ["Bob checked his system. It crashed.", false],
  ], (source) => violatesNarrativeInvariant(
    "curated-mechanic-unavailable",
    source,
    { protagonistAliases: ["Aria"] },
  ));

  expectCases([
    ["阿丽雅检查了自己的系统。它随后崩溃了。", true],
    ["阿丽雅的系统崩溃了。它随后恢复正常。", false],
    ["李雷检查了自己的系统。它随后崩溃了。", false],
  ], (source) => violatesNarrativeInvariant(
    "curated-mechanic-unavailable",
    source,
    { protagonistAliases: ["阿丽雅"] },
  ));
});

test("a perceived protagonist loss can only be corrected by the protagonist", () => {
  expectCases([
    ["Onlookers thought Aria lost the duel. In fact, Aria never lost.", false],
    ["Onlookers thought Aria lost the duel. In fact, Aria did not lose.", false],
    ["Onlookers thought Aria lost the duel. Bob stepped forward. In fact, he never lost.", true],
    ["Onlookers thought Bob lost the duel. In fact, Bob never lost.", false],
  ], (source) => violatesNarrativeInvariant(
    "curated-outcome-weakened",
    source,
    { protagonistAliases: ["Aria"] },
  ));

  expectCases([
    ["旁观者以为阿丽雅落败。事实上，阿丽雅从未落败。", false],
    ["旁观者以为阿丽雅落败。李雷站了出来。事实上，他从未落败。", true],
  ], (source) => violatesNarrativeInvariant(
    "curated-outcome-weakened",
    source,
    { protagonistAliases: ["阿丽雅"] },
  ));
});

test("relative and participial outcome ownership stays with the named beneficiary", () => {
  expectCases([
    ["Aria opened the gate and secured victory, which went to Bob.", false],
    ["Aria opened the gate and secured victory that accrued to Bob.", false],
    ["Aria opened the gate and secured a victory awarded to Bob.", false],
    ["Aria opened the gate and secured victory for herself.", true],
  ], realized);

  expectCases([
    ["阿丽雅打开城门并取得胜利，而胜利归于李雷。", false],
    ["阿丽雅打开城门并为自己取得胜利。", true],
  ], (source) => realized(source, chineseBinding));
});

test("relationship ordering interprets medial before and after clauses", () => {
  const relationship: RealizationBinding = {
    actor: "Aria",
    action: "bowed",
    counterpart: "Bob",
    reciprocalAction: "lowered",
    relationshipChange: "traveled together",
    requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"],
  };
  const extras: Partial<NarrativeRealizationInput> = {
    category: "relationship",
    counterpartAliases: ["Bob"],
  };

  expectCases([
    ["Aria bowed to Bob after Bob lowered his spear, and they traveled together.", false],
    ["Bob lowered his spear before Aria bowed to Bob, and they traveled together.", false],
    ["Aria bowed to Bob before Bob lowered his spear, and they traveled together.", true],
    ["Bob lowered his spear after Aria bowed to Bob, and they traveled together.", true],
  ], (source) => realized(source, relationship, extras));
});

test("mechanic recovery scans past unrelated recovery-shaped words", () => {
  expectCases([
    ["Aria's system crashed, Bob worked, but it came back online.", false],
    ["Aria's system crashed, Bob received a reward, but it recovered.", false],
    ["Aria's system crashed, Bob worked through the night.", true],
  ], (source) => violatesNarrativeInvariant(
    "curated-mechanic-unavailable",
    source,
    { protagonistAliases: ["Aria"] },
  ));

  expectCases([
    ["阿丽雅的系统崩溃了，李雷得到奖励，但它随后恢复正常。", false],
    ["阿丽雅的系统崩溃了，李雷得到奖励。", true],
  ], (source) => violatesNarrativeInvariant(
    "curated-mechanic-unavailable",
    source,
    { protagonistAliases: ["阿丽雅"] },
  ));
});

test("Chinese mechanic ownership is structural rather than a discourse-prefix whitelist", () => {
  expectCases([
    ["突然阿丽雅的系统崩溃了。", true],
    ["下一刻阿丽雅的系统崩溃了。", true],
    ["战斗中阿丽雅的系统突然崩溃了。", true],
    ["突然李雷的系统崩溃了。", false],
    ["此时，阿丽雅的系统恢复正常。", false],
  ], (source) => violatesNarrativeInvariant(
    "curated-mechanic-unavailable",
    source,
    { protagonistAliases: ["阿丽雅"] },
  ));
});

test("self-directed harm still violates the protagonist outcome invariant", () => {
  expectCases([
    ["Aria killed herself.", true],
    ["Aria injured herself.", true],
    ["Aria knocked herself unconscious.", true],
    ["Aria let herself be defeated.", true],
  ], (source) => violatesNarrativeInvariant(
    "curated-outcome-weakened",
    source,
    { protagonistAliases: ["Aria"] },
  ));

  expectCases([
    ["阿丽雅杀死自己。", true],
    ["阿丽雅打伤自己。", true],
  ], (source) => violatesNarrativeInvariant(
    "curated-outcome-weakened",
    source,
    { protagonistAliases: ["阿丽雅"] },
  ));
});

test("mechanic availability follows the final factual state", () => {
  expectCases([
    ["Aria's system crashed, came back online, then crashed again.", true],
    ["Aria's system crashed. It came back online. Then it crashed again.", true],
    ["Aria's system crashed. It was barely available.", true],
    ["Aria's system crashed. It was available only to Bob.", true],
    ["Aria's system crashed. It came back online in her imagination.", true],
    ["Aria's system crashed. It came back online for good.", false],
  ], (source) => violatesNarrativeInvariant(
    "curated-mechanic-unavailable",
    source,
    { protagonistAliases: ["Aria"] },
  ));
});

test("reported and imaginary frames cannot assert events or adverse outcomes", () => {
  const longDream = `Aria opened the gate and secured victory only in a dream filled with ${"distant echoes ".repeat(8)}.`;
  expectCases([
    ["In her imagination, Aria opened the gate and secured victory.", false],
    ["Reportedly, Aria opened the gate and secured victory.", false],
    ["Aria opened the gate and secured victory, or so they say.", false],
    [longDream, false],
    ["Aria opened the gate and secured victory as if in a dream.", true],
  ], realized);

  expectCases([
    ["传闻中，阿丽雅打开城门并取得胜利。", false],
    ["在虚构世界中，阿丽雅打开城门并取得胜利。", false],
  ], (source) => realized(source, chineseBinding));

  expectCases([
    ["In her imagination, Aria lost the duel.", false],
    ["Reportedly, Aria lost the duel.", false],
    ["Aria lost the duel, or so they say.", false],
    ["Aria was tied up with work.", false],
    ["Aria lost the duel as if in a dream.", true],
  ], (source) => violatesNarrativeInvariant(
    "curated-outcome-weakened",
    source,
    { protagonistAliases: ["Aria"] },
  ));

  assert.equal(
    violatesNarrativeInvariant(
      "curated-mechanic-unavailable",
      "Aria's system crashed as if in a dream.",
      { protagonistAliases: ["Aria"] },
    ),
    true,
  );
});

test("subject inheritance ignores adjunct mentions and preserves the real actor", () => {
  expectCases([
    ["Bob, with Aria beside him, opened the gate, and victory followed.", false],
    ["Aria, beside Bob, opened the gate, and victory followed.", true],
    ["Aria opened the gate because Bob ordered her, and victory followed.", true],
  ], (source) => realized(source, englishBinding, { actorAliases: ["Aria"] }));
});

test("identity labels cannot install a clone, impostor, namesake, or puppet as the protagonist", () => {
  for (const source of [
    "A clone named Aria opened the gate and secured victory.",
    "The impostor Aria opened the gate and secured victory.",
    "Fake Aria opened the gate and secured victory.",
    "Another Aria opened the gate and secured victory.",
    "Bob puppet Aria opened the gate and secured victory.",
    "A woman called Aria opened the gate and secured victory.",
  ]) assert.equal(realized(source, englishBinding, { actorAliases: ["Aria"] }), false, source);
});

test("a distant foreign owner does not become the protagonist through an unresolved pronoun", () => {
  const intervening = "The corridor remained quiet while the guards counted supplies. ".repeat(8);
  assert.equal(
    violatesNarrativeInvariant(
      "curated-mechanic-unavailable",
      `Mia checked her system. ${intervening}Her system crashed.`,
      { protagonistAliases: ["Aria"] },
    ),
    false,
  );
});

test("mechanic failures stay bound to the actual mechanic owner", () => {
  expectCases([
    ["Aria watched as Bob activated a quest system. It crashed.", false],
    ["Bob activated a quest system. It crashed while Aria watched.", false],
    ["Aria fought Bob, whose quest system crashed.", false],
    ["Aria activated a quest system. It crashed.", true],
  ], (source) => violatesNarrativeInvariant(
    "curated-mechanic-unavailable",
    source,
    { protagonistAliases: ["Aria"] },
  ));

  expectCases([
    ["阿丽雅的系统崩溃，但李雷的备用系统恢复正常。", true],
    ["阿丽雅的系统崩溃，但李雷的奖励系统恢复正常。", true],
    ["阿丽雅的系统崩溃，但李雷的另一套系统恢复正常。", true],
  ], (source) => violatesNarrativeInvariant(
    "curated-mechanic-unavailable",
    source,
    { protagonistAliases: ["阿丽雅"] },
  ));
});

test("outcome ownership covers possessives, of-phrases, and true reflexives", () => {
  expectCases([
    ["Aria opened the gate and secured my victory.", false],
    ["Aria opened the gate and secured your victory.", false],
    ["Aria opened the gate and secured the victory of Bob.", false],
    ["Aria opened the gate and secured victory belonging to Bob.", false],
    ["Aria opened the gate and secured victory for himself.", false],
    ["Aria opened the gate and secured victory for ourselves.", false],
    ["Aria opened the gate and secured her victory.", true],
    ["Aria opened the gate and secured victory for herself.", true],
  ], realized);
});

test("productive report frames never become factual event evidence", () => {
  for (const source of [
    "The report: Aria opened the gate and secured victory.",
    "The rumour: Aria opened the gate and secured victory.",
    "History says this: Aria opened the gate and secured victory.",
    "A witness testified: Aria opened the gate and secured victory.",
    "Bob swore that Aria opened the gate and secured victory.",
    "Aria reportedly opened the gate and secured victory.",
    "Aria purportedly opened the gate and secured victory.",
    "Aria ostensibly opened the gate and secured victory.",
  ]) assert.equal(realized(source), false, source);
});

test("possessive containers cannot impersonate opponents or relationship counterparts", () => {
  const conflict: RealizationBinding = {
    actor: "Aria",
    action: "defeat",
    opponent: "Rook",
    outcome: "victory",
    requiredSlots: ["actor", "action", "opponent", "outcome"],
  };
  for (const container of ["statue", "clone", "portrait", "envoy"]) {
    assert.equal(realized(
      `Aria defeated Rook's ${container} and claimed victory.`,
      conflict,
      { category: "conflict", opponentAliases: ["Rook"] },
    ), false, container);
  }

  const relationship: RealizationBinding = {
    actor: "Aria",
    action: "bowed",
    counterpart: "Rook",
    reciprocalAction: "lowered",
    relationshipChange: "traveled together",
    requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"],
  };
  for (const container of ["statue", "clone", "portrait"]) {
    assert.equal(realized(
      `Aria bowed to Rook's ${container}. Rook lowered his spear. Aria and Rook traveled together.`,
      relationship,
      { category: "relationship", counterpartAliases: ["Rook"] },
    ), false, container);
  }
});

test("relationship change pronouns require the established pair to remain salient", () => {
  const relationship: RealizationBinding = {
    actor: "Aria",
    action: "bowed",
    counterpart: "Bob",
    reciprocalAction: "lowered",
    relationshipChange: "traveled together",
    requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"],
  };
  const extras: Partial<NarrativeRealizationInput> = {
    category: "relationship",
    counterpartAliases: ["Bob"],
  };
  for (const source of [
    "Aria bowed to Bob. Bob lowered his spear. Mia arrived, and they traveled together.",
    "Aria bowed to Bob. Bob lowered his spear. Mia spoke to Aria, then they traveled together.",
    "Aria bowed to Bob. Bob lowered his spear. A bell rang, and they traveled together.",
  ]) assert.equal(realized(source, relationship, extras), false, source);
  assert.equal(
    realized("Aria bowed to Bob. Bob lowered his spear. Then they traveled together.", relationship, extras),
    true,
  );
});
