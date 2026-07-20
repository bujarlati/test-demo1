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
  assert.deepEqual(
    cases.map(([source, expected]) => ({ source, actual: evaluate(source), expected })),
    cases.map(([source, expected]) => ({ source, actual: expected, expected })),
  );
}

const mechanicViolated = (source: string): boolean => violatesNarrativeInvariant(
  "curated-mechanic-unavailable",
  source,
  { protagonistAliases: ["Aria"] },
);

test("titles with periods do not split an attributed sentence", () => {
  assert.equal(realized("According to Dr. Bob, Aria opened the gate and secured victory."), false);
});

test("pronouns preserve the real person behind an assumed identity", () => {
  expectCases([
    ["Bob disguised himself as Aria. He opened the gate and secured victory.", false],
    ["Aria disguised herself as Bob. She opened the gate and secured victory.", true],
  ], realized);
});

test("closed reports and procedural according-to phrases remain factual", () => {
  expectCases([
    ["The report said the road was closed. The report ended. Aria opened the gate and secured victory.", true],
    ["According to plan, Aria opened the gate and secured victory.", true],
    ["According to the rules, Aria opened the gate and secured victory.", true],
  ], realized);
});

test("dream scope survives nesting and newlines and closes only on a real wake", () => {
  expectCases([
    ["Aria dreamed that Bob dreamed that Aria opened the gate and secured victory.", false],
    ["Aria dreamed that\nAria opened the gate and secured victory.", false],
    ["Aria dreamed that she woke from the dream and then opened the gate and secured victory.", false],
    ["Aria dreamed of Bob. Then Aria woke from the dream. Aria opened the gate and secured victory.", true],
  ], realized);
});

test("explicit natural wake frames close a completed dream scope", () => {
  expectCases([
    ["Aria dreamed that Bob danced. Aria jolted awake. Then Aria opened the gate and secured victory.", true],
    ["Aria dreamed that Bob danced. Aria woke with a start. Then Aria opened the gate and secured victory.", true],
    ["Aria dreamed that Bob danced. The dream shattered. Then Aria opened the gate and secured victory.", true],
    ["Aria dreamed that Bob danced. Morning came. Aria opened her eyes. Then Aria opened the gate and secured victory.", true],
    ["Aria dreamed that she jolted awake and opened the gate and secured victory.", false],
  ], realized);
});

test("common mechanic failure wording triggers the mechanic invariant", () => {
  expectCases([
    ["Aria's quest system failed.", true],
    ["Aria's quest system glitched.", true],
    ["Aria's quest system shut down.", true],
    ["Aria's quest system became unresponsive.", true],
    ["阿丽雅的系统宕机了。", true],
    ["阿丽雅的系统死机了。", true],
    ["阿丽雅的系统瘫痪了。", true],
  ], (source) => violatesNarrativeInvariant(
    "curated-mechanic-unavailable",
    source,
    { protagonistAliases: [source.includes("阿丽雅") ? "阿丽雅" : "Aria"] },
  ));
});

test("common adverse outcome wording triggers the protagonist invariant", () => {
  expectCases([
    ["Aria was slain by Bob.", true],
    ["Aria was wounded by Bob.", true],
    ["Aria was knocked out by Bob.", true],
    ["Aria was eliminated by Bob.", true],
    ["阿丽雅战败。", true],
  ], (source) => violatesNarrativeInvariant(
    "curated-outcome-weakened",
    source,
    { protagonistAliases: [source.includes("阿丽雅") ? "阿丽雅" : "Aria"] },
  ));
});

test("distant mechanic-owner resolution distinguishes Aria from Mia", () => {
  const intervening = "The corridor stayed quiet while guards counted supplies. ".repeat(10);
  expectCases([
    [`Aria checked her quest system. ${intervening}Her quest system crashed.`, true],
    [`Mia checked her quest system. ${intervening}Her quest system crashed.`, false],
  ], mechanicViolated);
});

test("ordinary solar panels and acting ability are not story mechanics", () => {
  expectCases([
    ["Aria's solar panel broke in the storm.", false],
    ["Aria's acting ability was temporarily unavailable after the rehearsal.", false],
  ], mechanicViolated);
});

test("a later Chinese foreign owner cannot inherit the protagonist's outcome", () => {
  expectCases([
    ["阿丽雅打开城门并取得胜利。胜利最终属于李雷。", false],
    ["阿丽雅打开城门并取得胜利，这场胜利归李雷所有。", false],
  ], (source) => realized(source, chineseBinding));
});

test("ordinary parentheticals preserve the named event subject", () => {
  expectCases([
    ["Aria, the captain, opened the gate and secured victory.", true],
    ["Aria, who had waited all night, opened the gate and secured victory.", true],
    ["Aria, exhausted but resolute, opened the gate and secured victory.", true],
    ["Aria, smiling, opened the gate and secured victory.", true],
  ], realized);
});

test("possessive and relational noun phrases cannot inherit the protagonist identity", () => {
  expectCases([
    ["Aria's friend Bob, opened the gate and secured victory.", false],
    ["Bob, Aria's captain, opened the gate and secured victory.", false],
    ["Bob, Aria's friend, opened the gate and secured victory.", false],
    ["Bob, Aria's sworn guardian, opened the gate and secured victory.", false],
    ["Bob, a friend of Aria, opened the gate and secured victory.", false],
    ["Bob, captain to Aria, opened the gate and secured victory.", false],
    ["阿丽雅身旁的鲍勃，打开城门并取得胜利。", false],
    ["阿丽雅的朋友鲍勃，打开城门并取得胜利。", false],
    ["阿丽雅对面的鲍勃，打开城门并取得胜利。", false],
    ["阿丽雅所认识的鲍勃，打开城门并取得胜利。", false],
  ], (source) => realized(source, source.includes("阿丽雅") ? chineseBinding : englishBinding));
});

test("symbol-prefixed aliases still require a right token boundary", () => {
  for (const actor of ["@Aria", "#Aria", "🦊Aria"]) {
    const binding: RealizationBinding = { ...englishBinding, actor };
    assert.equal(realized(`${actor} opened the gate and secured victory.`, binding), true, actor);
    assert.equal(realized(`${actor}Clone opened the gate and secured victory.`, binding), false, actor);
  }
});

test("direct objects survive bounded parentheticals, topicalization, and clefts", () => {
  expectCases([
    ["Aria opened, with one swift pull, the gate and secured victory.", true],
    ["The gate, Aria opened with one pull, securing victory.", true],
    ["It was the gate that Aria opened, securing victory.", true],
  ], realized);
});

test("open-vocabulary outcomes cannot be borrowed from compound labels", () => {
  const outcomeBinding = (outcome: string): RealizationBinding => ({
    actor: "Aria",
    action: "open",
    object: "gate",
    outcome,
    requiredSlots: ["actor", "action", "object", "outcome"],
  });
  assert.equal(realized("Aria opened the gate and secured a victory banner."), false);
  assert.equal(realized("Aria opened the gate and secured so-called victory."), false);
  assert.equal(realized("Aria opened the gate and secured apparent victory."), false);
  assert.equal(realized("Aria opened the gate and secured a trust fund.", outcomeBinding("trust")), false);
  assert.equal(realized("Aria opened the gate and secured a hope chest.", outcomeBinding("hope")), false);
  assert.equal(realized("Aria opened the gate and secured an alliance banner.", outcomeBinding("alliance")), false);
  assert.equal(realized("Aria opened the gate and secured a decisive victory."), true);
});

test("Chinese outcome phrases allow modifiers but reject compound-label borrowing", () => {
  expectCases([
    ["阿丽雅打开城门并取得胜利。", true],
    ["阿丽雅打开城门并取得了胜利。", true],
    ["阿丽雅打开城门并取得一场胜利。", true],
    ["阿丽雅打开城门并取得最终胜利。", true],
    ["阿丽雅打开城门并取得压倒性胜利。", true],
    ["阿丽雅打开城门并取得胜利旗帜。", false],
    ["阿丽雅打开城门并取得胜利徽章。", false],
    ["阿丽雅打开城门并取得胜利消息。", false],
    ["阿丽雅打开城门并取得所谓胜利。", false],
  ], (source) => realized(source, chineseBinding));
});

test("open-vocabulary finite effects keep their direct objects", () => {
  assert.equal(realized(
    "Aria opens the sealed gate and the mechanism records her choice.",
    {
      actor: "Aria",
      action: "opens",
      object: "gate",
      outcome: "records",
      requiredSlots: ["actor", "action", "object", "outcome"],
    },
    { category: "mechanic" },
  ), true);
});

test("slot bindings cannot absorb negation, intent, failure, or imagination", () => {
  const binding = (action: string, outcome: string): RealizationBinding => ({
    actor: "Aria",
    action,
    object: "gate",
    outcome,
    requiredSlots: ["actor", "action", "object", "outcome"],
  });
  assert.equal(realized(
    "Aria did not open the gate and victory did not come.",
    binding("did not open", "did not come"),
    { category: "protagonist_action" },
  ), false);
  assert.equal(realized(
    "Aria tried to open the gate and almost won.",
    binding("tried to open", "almost won"),
    { category: "protagonist_action" },
  ), false);
  assert.equal(realized(
    "Aria failed to open the gate and victory did not come.",
    binding("failed to open", "did not come"),
    { category: "protagonist_action" },
  ), false);
  assert.equal(realized(
    "Aria imagined that she opened the gate and secured victory.",
    binding("imagined that she opened", "victory"),
    { category: "protagonist_action" },
  ), false);
  assert.equal(realized(
    "阿丽雅试图打开城门并差点获胜。",
    { actor: "阿丽雅", action: "试图打开", object: "城门", outcome: "差点获胜", requiredSlots: ["actor", "action", "object", "outcome"] },
    { category: "protagonist_action" },
  ), false);
});

test("epistemic modifiers and unresolved complements cannot assert a required result", () => {
  expectCases([
    ["Aria opened the gate and almost secured victory.", false],
    ["Aria opened the gate and possibly secured victory.", false],
    ["Aria opened the gate and allegedly secured victory.", false],
    ["It was possible that Aria opened the gate and secured victory.", false],
    ["Whether Aria opened the gate and secured victory remained unknown.", false],
    ["Aria acted as though she opened the gate and secured victory.", false],
    ["Aria acted as if she opened the gate and secured victory.", false],
    ["It was confirmed that Aria opened the gate and secured victory.", true],
    ["It was possible that Bob opened the gate, but in fact Aria opened the gate and secured victory.", true],
    ["Aria acted as though she fled, but in fact Aria opened the gate and secured victory.", true],
  ], (source) => realized(source));
  expectCases([
    ["阿丽雅打开城门并差点取得胜利。", false],
    ["有可能阿丽雅打开城门并取得胜利。", false],
    ["阿丽雅是否打开城门并取得胜利仍不确定。", false],
    ["阿丽雅仿佛打开城门并取得胜利。", false],
    ["阿丽雅确实打开城门并取得胜利。", true],
  ], (source) => realized(source, chineseBinding));
});

test("adjacent mechanic effects may be asserted by the actor's mechanism", () => {
  const rewardBinding: RealizationBinding = {
    actor: "Aria",
    action: "open",
    object: "gate",
    outcome: "reward",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  const recordBinding: RealizationBinding = { ...rewardBinding, outcome: "record" };
  expectCases([
    ["Aria opened the sealed gate. Her system granted a reward.", true],
    ["Aria opened the sealed gate. As a result, her system granted a reward.", true],
    ["Aria opened the sealed gate. This caused the system to grant a reward.", true],
    ["Aria opened the sealed gate. Her system granted Aria a reward.", true],
    ["Aria opened the sealed gate. Her system granted her a reward.", true],
    ["Aria opened the sealed gate. Her system granted the protagonist a reward.", true],
    ["Aria opened the sealed gate. Her system produced a reward, which was given to Aria.", true],
    ["Aria opened the sealed gate. Bob's system granted a reward.", false],
    ["Aria opened the sealed gate. Her system granted Bob a reward.", false],
    ["Aria opened the sealed gate. Her system granted the guard a reward.", false],
    ["Aria opened the sealed gate. This caused the system to grant Bob a reward.", false],
    ["Aria opened the sealed gate. Therefore, the system awarded Bob the reward.", false],
    ["Aria opened the sealed gate. Aria's system gave Bob a reward.", false],
    ["Aria opened the sealed gate. Her system delivered Bob a reward.", false],
    ["Aria opened the sealed gate. Her system produced a reward, which was given to Bob.", false],
    ["Aria opened the sealed gate. Her enemy stole the reward.", false],
  ], (source) => realized(source, rewardBinding, { category: "mechanic" }));
  assert.equal(realized(
    "Aria opened the sealed gate. Therefore, the mechanism recorded her choice.",
    recordBinding,
    { category: "mechanic" },
  ), true);

  const chineseRewardBinding: RealizationBinding = {
    actor: "阿丽雅",
    action: "打开",
    object: "城门",
    outcome: "奖励",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  expectCases([
    ["阿丽雅打开城门。因此，她的系统发放奖励。", true],
    ["阿丽雅打开城门。因此，她的系统给阿丽雅发放奖励。", true],
    ["阿丽雅打开城门。因此，她的系统给李雷发放奖励。", false],
    ["阿丽雅打开城门。因此，她的系统授予李雷奖励。", false],
    ["阿丽雅打开城门。因此，她的系统给予奖励。", true],
  ], (source) => realized(source, chineseRewardBinding, { category: "mechanic" }));
});

test("an adjacent result binds the closest preceding event", () => {
  const binding: RealizationBinding = {
    actor: "Aria",
    action: "open",
    object: "gate",
    outcome: "reward",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  expectCases([
    ["Aria opened the gate. Therefore, her system granted a reward.", true],
    ["Aria opened the gate and Bob pressed a button; therefore, her system granted a reward.", false],
    ["Aria opened the gate and then smiled. Therefore, her system granted a reward.", false],
    ["Aria opened the gate；随后李雷按下按钮。因此，她的系统发放奖励。", false],
  ], (source) => realized(source, binding, { category: "mechanic" }));
});

test("bounded parentheticals keep the real clause head after sentence-opening adjuncts", () => {
  expectCases([
    ["At dawn, Bob, Aria's captain, opened the gate and secured victory.", false],
    ["Yesterday, Bob, Aria's friend, opened the gate and secured victory.", false],
    ["At dawn, Aria, Bob's captain, opened the gate and secured victory.", true],
    ["Yesterday, Aria, Bob's friend, opened the gate and secured victory.", true],
  ], (source) => realized(source, englishBinding));

  expectCases([
    ["黎明时，阿丽雅，疲惫却坚定，打开城门并取得胜利。", true],
    ["昨天，阿丽雅，队长，打开城门并取得胜利。", true],
    ["黎明时，鲍勃，阿丽雅的队长，打开城门并取得胜利。", false],
    ["昨天，鲍勃，阿丽雅的朋友，打开城门并取得胜利。", false],
  ], (source) => realized(source, chineseBinding));
});

test("Chinese fronted direct objects allow manner modifiers without absorbing nearby nouns", () => {
  expectCases([
    ["阿丽雅将那座古老城门彻底打开并取得胜利。", true],
    ["阿丽雅将那座古老城门缓缓打开并取得胜利。", true],
    ["阿丽雅将那座古老城门轻易打开并取得胜利。", true],
    ["阿丽雅将城门旁边的窗户打开并取得胜利。", false],
  ], (source) => realized(source, chineseBinding));
});

test("dream scope cache keys cannot collide across different alias sequences", () => {
  const source = "In a dream, Foo walked. Foo woke from the dream. Aria opened the gate and secured victory.";
  assert.equal(realized(source, englishBinding, { actorAliases: ["Bar", "Foo"] }), true);
  assert.equal(realized(source, englishBinding, { actorAliases: ["Bar\u0000Foo"] }), false);
  const freshSource = `${source} `;
  assert.equal(realized(freshSource, englishBinding, { actorAliases: ["Bar\u0000Foo"] }), false);
  assert.equal(realized(freshSource, englishBinding, { actorAliases: ["Bar", "Foo"] }), true);
});

test("dream scope cache keys preserve case-sensitive proper-name semantics", () => {
  const source = "In a dream, Foo walked. Foo woke from the dream. Aria opened the gate and secured victory.";
  assert.equal(realized(source, englishBinding, { actorAliases: ["Foo"] }), true);
  assert.equal(realized(source, englishBinding, { actorAliases: ["FOO"] }), false);
  const freshSource = `${source}  `;
  assert.equal(realized(freshSource, englishBinding, { actorAliases: ["FOO"] }), false);
  assert.equal(realized(freshSource, englishBinding, { actorAliases: ["Foo"] }), true);
});

test("nonfactive and epistemic complements do not assert their narrated event", () => {
  for (const verb of ["lied", "joked", "boasted", "suggested", "doubted", "speculated", "guessed"]) {
    assert.equal(
      realized(`Bob ${verb} that Aria opened the gate and secured victory.`),
      false,
      verb,
    );
  }
  assert.equal(realized("Bob wondered whether Aria opened the gate and secured victory."), false);
  assert.equal(realized("Bob wondered if Aria opened the gate and secured victory."), false);
  assert.equal(realized("Bob doubted Aria opened the gate and secured victory."), false);
  assert.equal(realized("Bob joked that Mia fled but Aria opened the gate and secured victory."), false);
  for (const source of ["鲍勃怀疑阿丽雅战败。", "鲍勃推测阿丽雅战败。", "鲍勃猜测阿丽雅战败。"]) {
    assert.equal(violatesNarrativeInvariant(
      "curated-outcome-weakened",
      source,
      { protagonistAliases: ["阿丽雅"] },
    ), false, source);
  }
});

test("factive complements and fresh factual clauses remain asserted", () => {
  expectCases([
    ["Bob revealed that Aria opened the gate and secured victory.", true],
    ["Bob confirmed that Aria opened the gate and secured victory.", true],
    ["Bob knew that Aria opened the gate and secured victory.", true],
    ["Bob joked that Mia fled, but Aria opened the gate and secured victory.", true],
  ], realized);
  for (const source of ["鲍勃确认阿丽雅战败。", "鲍勃知道阿丽雅战败。", "鲍勃证实阿丽雅战败。"]) {
    assert.equal(violatesNarrativeInvariant(
      "curated-outcome-weakened",
      source,
      { protagonistAliases: ["阿丽雅"] },
    ), true, source);
  }
});

test("printed text containers cannot realize narrated events and factual resets reopen reality", () => {
  expectCases([
    ["On the banner were the words: Aria opened the gate and secured victory.", false],
    ["The banner bore the words Aria opened the gate and secured victory.", false],
    ["Printed across the banner: Aria opened the gate and secured victory.", false],
    ["Displayed on the label were the words Aria opened the gate and secured victory.", false],
    ["The banner bore the words Aria would fail, but in fact Aria opened the gate and secured victory.", true],
    ["The label was removed. Aria opened the gate and secured victory.", true],
  ], realized);
  expectCases([
    ["横幅上印着：阿丽雅打开城门并取得胜利。", false],
    ["标签上写着阿丽雅打开城门并取得胜利。", false],
    ["横幅上的文字只是传言，但事实上阿丽雅打开城门并取得胜利。", true],
  ], (source) => realized(source, chineseBinding));
});

test("an -ing modifier is not a finite outcome predicate", () => {
  const winBinding: RealizationBinding = {
    actor: "Aria",
    action: "open",
    object: "gate",
    outcome: "win",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  expectCases([
    ["Aria opened the gate with a winning smile.", false],
    ["Aria opened the gate, wearing her winning smile.", false],
    ["Aria opened the gate, thereby winning the duel.", true],
    ["Aria opened the gate and won the duel.", true],
  ], (source) => realized(source, winBinding));
});

test("mechanic invariants classify the mechanic entity and terminal failure semantics", () => {
  const context = { protagonistAliases: ["Aria"] };
  expectCases([
    ["Aria's quest system no longer functioned.", true],
    ["Aria's quest system became useless.", true],
    ["Aria's quest system granted no more rewards.", true],
    ["Aria's school system no longer functioned.", false],
    ["Aria's banking system became useless.", false],
    ["Aria's banking system failed, but her quest system worked normally.", false],
    ["The banking system failed. Aria's quest system remained available.", false],
  ], (source) => violatesNarrativeInvariant("curated-mechanic-unavailable", source, context));

  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  expectCases([
    ["阿丽雅的任务系统不再运作。", true],
    ["阿丽雅的任务系统变得毫无用处。", true],
    ["阿丽雅的任务系统不再发放奖励。", true],
    ["阿丽雅的银行系统停止运行。", false],
    ["银行系统发生故障，但阿丽雅的任务系统仍然可用。", false],
  ], (source) => violatesNarrativeInvariant("curated-mechanic-unavailable", source, chineseContext));
});

test("hard outcome invariants cover passive defeat and defeat idioms", () => {
  const context = { protagonistAliases: ["Aria"] };
  expectCases([
    ["Aria was bested by Bob and lay helpless.", true],
    ["Aria fell to Bob in the duel.", true],
    ["Bob was bested by Aria and lay helpless.", false],
    ["Aria fell to the ground laughing.", false],
    ["The report claimed that Aria was bested by Bob.", false],
  ], (source) => violatesNarrativeInvariant("curated-outcome-weakened", source, context));

  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  expectCases([
    ["阿丽雅不敌鲍勃，倒地不起。", true],
    ["阿丽雅败于鲍勃。", true],
    ["鲍勃不敌阿丽雅，倒地不起。", false],
  ], (source) => violatesNarrativeInvariant("curated-outcome-weakened", source, chineseContext));
});

test("terminal blueprint language violates hard invariants even in planned tense", () => {
  const context = { protagonistAliases: ["Aria"] };
  expectCases([
    ["Aria's quest system will be permanently unavailable.", true],
    ["Aria's quest system becomes unavailable.", true],
    ["Aria's quest system remains unavailable.", true],
    ["Aria's quest system may be temporarily unavailable.", false],
    ["Aria's school system will be permanently unavailable.", false],
  ], (source) => violatesNarrativeInvariant("curated-mechanic-unavailable", source, context));

  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  expectCases([
    ["阿丽雅的任务系统将永久失效。", true],
    ["阿丽雅的任务系统会彻底被摧毁。", true],
    ["阿丽雅的任务系统可能会暂时不可用。", false],
    ["阿丽雅的银行系统将永久失效。", false],
  ], (source) => violatesNarrativeInvariant("curated-mechanic-unavailable", source, chineseContext));
});

test("relative-clause names cannot replace the matrix subject", () => {
  expectCases([
    ["The guard whom Aria hired opened the gate and secured victory.", false],
    ["The guard that Aria hired opened the gate and secured victory.", false],
    ["The guard Aria hired opened the gate and secured victory.", false],
    ["The guard who defeated Aria opened the gate and secured victory.", false],
    ["The guard whom Aria hired watched as Aria opened the gate and secured victory.", true],
    ["The guard whom Aria hired watched as Aria quietly opened the gate and secured victory.", true],
    ["The guard whom Aria hired watched while Aria opened the gate and secured victory.", true],
    ["The guard whom Aria hired watched. Aria opened the gate and secured victory.", true],
    ["The guard whom Aria hired watched as Bob opened the gate and secured victory.", false],
    ["The guard whom Aria hired watched as Captain Bob opened the gate and secured victory.", false],
    ["The guard whom Aria hired served as captain and opened the gate and secured victory.", false],
    ["Aria, whom the guard hired, opened the gate and secured victory.", true],
    ["Aria opened the gate and secured victory.", true],
  ], realized);
});

test("a noun inside an oblique phrase cannot become the direct object", () => {
  expectCases([
    ["Aria opened a window in the gate and secured victory.", false],
    ["Aria opened a lock on the gate and secured victory.", false],
    ["Aria opened a cache inside the gate and secured victory.", false],
    ["Aria opened a chamber within the gate and secured victory.", false],
    ["Aria opened a breach against the gate and secured victory.", false],
    ["Aria opened the ancient gate and secured victory.", true],
  ], realized);
});

test("epistemic alternatives, hearsay and hypothetical containers remain nonactual", () => {
  expectCases([
    ["Nobody knows whether Aria opened the gate and secured victory.", false],
    ["No one can tell if Aria opened the gate and secured victory.", false],
    ["The jury is still out on whether Aria opened the gate and secured victory.", false],
    ["No witness can confirm that Aria opened the gate and secured victory.", false],
    ["As a hypothetical, Aria opened the gate and secured victory.", false],
    ["For the sake of argument, Aria opened the gate and secured victory.", false],
    ["Aria opened the gate and secured victory, or so the story goes.", false],
    ["A witness stood nearby while Aria opened the gate and secured victory.", true],
    ["As a captain, Aria opened the gate and secured victory.", true],
    ["For the sake of the city, Aria opened the gate and secured victory.", true],
    ["Aria opened the gate and secured victory, and so the story continued.", true],
    ["Either Aria opened the gate and secured victory, or Bob did.", false],
    ["Word has it that Aria opened the gate and secured victory.", false],
    ["It is imaginable that Aria opened the gate and secured victory.", false],
    ["Seemingly, Aria opened the gate and secured victory.", false],
    ["Aria all but opened the gate and secured victory.", false],
    ["Either way, Aria opened the gate and secured victory.", true],
    ["Nobody spoke. In fact, Aria opened the gate and secured victory.", true],
    ["The jury is still out on whether Bob opened the gate. In fact, Aria opened the gate and secured victory.", true],
    ["For the sake of argument, Bob opened the gate. In reality, Aria opened the gate and secured victory.", true],
    ["Aria opened the gate and secured victory, or so the story goes. In fact, Aria opened the gate and secured victory.", true],
  ], realized);
  expectCases([
    ["在假想场景中，阿丽雅打开城门并取得胜利。", false],
    ["在剧本里，阿丽雅打开城门并取得胜利。", false],
    ["在推演中，阿丽雅打开城门并取得胜利。", false],
    ["在设想中，阿丽雅打开城门并取得胜利。", false],
    ["从理论上说，阿丽雅打开城门并取得胜利。", false],
    ["在思想实验中，阿丽雅打开城门并取得胜利。", false],
    ["从理论课回来，阿丽雅打开城门并取得胜利。", true],
    ["在实验中，阿丽雅打开城门并取得胜利。", true],
    ["推演结束。阿丽雅打开城门并取得胜利。", true],
    ["从理论上说，鲍勃打开城门。事实上，阿丽雅打开城门并取得胜利。", true],
    ["思想实验结束。阿丽雅打开城门并取得胜利。", true],
    ["在真实战场中，阿丽雅打开城门并取得胜利。", true],
  ], (source) => realized(source, chineseBinding));
});

test("trusted slot text cannot absorb nonactual governors", () => {
  const actionBinding = (action: string): RealizationBinding => ({
    ...englishBinding,
    action,
  });
  const outcomeBinding = (outcome: string): RealizationBinding => ({
    ...englishBinding,
    outcome,
  });
  for (const action of ["seemed to open", "appeared to open", "was about to open", "claimed to open", "was reported to open"]) {
    assert.equal(realized(`Aria ${action} the gate and secured victory.`, actionBinding(action)), false, action);
  }
  for (const outcome of ["seemed to secure victory", "appeared to secure victory", "was said to secure victory"]) {
    assert.equal(realized(`Aria opened the gate and ${outcome}.`, outcomeBinding(outcome)), false, outcome);
  }
  assert.equal(realized("Aria opened the gate and secured victory."), true);

  const chineseActionBinding = (action: string): RealizationBinding => ({ ...chineseBinding, action });
  const chineseOutcomeBinding = (outcome: string): RealizationBinding => ({ ...chineseBinding, outcome });
  for (const action of ["疑似打开", "貌似打开", "据说打开", "本可打开", "差一步打开", "眼看就要打开"]) {
    assert.equal(realized(`阿丽雅${action}城门并取得胜利。`, chineseActionBinding(action)), false, action);
  }
  for (const outcome of ["疑似取得胜利", "貌似取得胜利", "据说取得胜利", "本可取得胜利", "差一步取得胜利", "眼看就要取得胜利"]) {
    assert.equal(realized(`阿丽雅打开城门并${outcome}。`, chineseOutcomeBinding(outcome)), false, outcome);
  }
  assert.equal(realized("阿丽雅打开城门并取得胜利。", chineseBinding), true);
});

test("mechanic rewards cannot be borrowed from a foreign Chinese beneficiary", () => {
  const rewardBinding: RealizationBinding = {
    actor: "阿丽雅",
    action: "打开",
    object: "城门",
    outcome: "奖励",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  expectCases([
    ["阿丽雅打开城门。因此，她的系统给了李雷一份奖励。", false],
    ["阿丽雅打开城门。因此，她的系统为李雷发放了奖励。", false],
    ["阿丽雅打开城门。因此，她的系统为李雷颁发奖励。", false],
    ["阿丽雅打开城门。因此，她的系统替李雷发放奖励。", false],
    ["阿丽雅打开城门。因此，她的系统给了阿丽雅一份奖励。", true],
    ["阿丽雅打开城门。因此，她的系统发放奖励。", true],
  ], (source) => realized(source, rewardBinding, { category: "mechanic" }));
});

test("a mechanic reward verb binds its direct recipient", () => {
  const rewardBinding: RealizationBinding = {
    actor: "Aria",
    action: "open",
    object: "gate",
    outcome: "reward",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  expectCases([
    ["Aria opened the gate. Her system rewarded Bob.", false],
    ["Aria opened the gate. Her system rewarded the guard.", false],
    ["Aria opened the gate, and her system rewarded Bob.", false],
    ["Aria opened the gate, and her system rewarded the guard.", false],
    ["Aria opened the gate. Her system rewarded Aria.", true],
    ["Aria opened the gate. Her system rewarded her.", true],
  ], (source) => realized(source, rewardBinding, { category: "mechanic" }));
});

test("goal and readiness phrases do not assert an attained open-vocabulary outcome", () => {
  expectCases([
    ["Aria opened the gate and aimed for victory.", false],
    ["Aria opened the gate and reached for victory.", false],
    ["Aria opened the gate and prepared for victory.", false],
    ["Aria opened the gate and was ready for victory.", false],
    ["Aria opened the gate and secured victory.", true],
  ], realized);

  const freedomBinding: RealizationBinding = {
    actor: "Aria",
    action: "unlock",
    object: "vault",
    outcome: "freedom",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  assert.equal(realized("Aria unlocked the vault and reached for freedom.", freedomBinding), false);
  assert.equal(realized("Aria unlocked the vault and gained freedom.", freedomBinding), true);

  const escapeBinding: RealizationBinding = {
    actor: "Aria",
    action: "destroy",
    object: "bridge",
    outcome: "escape",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  assert.equal(realized("Aria destroyed the bridge and prepared for escape.", escapeBinding), false);
  assert.equal(realized("Aria destroyed the bridge and achieved escape.", escapeBinding), true);
});

test("missing evidence and postposed retractions keep an event nonactual", () => {
  expectCases([
    ["There is no evidence that Aria opened the gate and secured victory.", false],
    ["Aria opened the gate and secured victory, supposedly.", false],
    ["Aria opened the gate and secured victory, which never happened.", false],
    ["Aria opened the gate and secured victory, but this was not true.", false],
    ["There is evidence that Aria opened the gate and secured victory.", true],
    ["The rumour was unconfirmed, but in fact Aria opened the gate and secured victory.", true],
  ], realized);
  expectCases([
    ["阿丽雅打开城门并取得胜利，其实并未发生。", false],
    ["阿丽雅打开城门并取得胜利，但这不是真的。", false],
    ["阿丽雅打开城门并取得胜利，消息尚未证实。", false],
    ["阿丽雅打开城门并取得胜利，只是传闻。", false],
    ["阿丽雅打开城门并取得胜利，或者鲍勃做到了。", false],
    ["消息尚未证实，但事实上阿丽雅打开城门并取得胜利。", true],
  ], (source) => realized(source, chineseBinding));
});

test("an exact composite outcome cannot absorb all-but modality", () => {
  const binding: RealizationBinding = {
    ...englishBinding,
    outcome: "all but secured victory",
  };
  assert.equal(realized("Aria opened the gate and all but secured victory.", binding), false);
  assert.equal(realized("Aria opened the gate and secured victory."), true);
});

test("less common oblique prepositions still block direct-object borrowing", () => {
  expectCases([
    ["Aria opened a hatch upon the gate and secured victory.", false],
    ["Aria opened a cache outside the gate and secured victory.", false],
    ["Aria opened a hatch beyond the gate and secured victory.", false],
    ["Aria opened the gate and secured victory.", true],
  ], realized);
});

test("open questions, theory frames, and fictional containers remain nonactual", () => {
  expectCases([
    ["It remains an open question whether Aria opened the gate and secured victory.", false],
    ["No proof exists that Aria opened the gate and secured victory.", false],
    ["It has yet to be confirmed whether Aria opened the gate and secured victory.", false],
    ["In theory, Aria opened the gate and secured victory.", false],
    ["Aria opened the gate and secured victory, in theory.", false],
    ["The question was settled. Aria opened the gate and secured victory.", true],
  ], realized);
  expectCases([
    ["在预演中，阿丽雅打开城门并取得胜利。", false],
    ["在演算中，阿丽雅打开城门并取得胜利。", false],
    ["在假想世界中，阿丽雅打开城门并取得胜利。", false],
    ["在脑海中，阿丽雅打开城门并取得胜利。", false],
    ["阿丽雅打开城门并取得胜利，纯属虚构。", false],
    ["阿丽雅打开城门并取得胜利，仅存在于剧本。", false],
    ["阿丽雅打开城门并取得胜利，未必如此。", false],
    ["预演结束。阿丽雅打开城门并取得胜利。", true],
  ], (source) => realized(source, chineseBinding));
});

test("threshold and proximity wording cannot be hidden inside exact slots", () => {
  const actionBinding: RealizationBinding = { ...englishBinding, action: "was on the verge of opening" };
  assert.equal(realized("Aria was on the verge of opening the gate and secured victory.", actionBinding), false);

  for (const outcome of ["came close to victory", "was within reach of victory", "was on the verge of victory"]) {
    const binding: RealizationBinding = { ...englishBinding, outcome };
    assert.equal(realized(`Aria opened the gate and ${outcome}.`, binding), false, outcome);
  }
  assert.equal(realized("Aria opened the gate and achieved victory."), true);
});

test("present and modified defeat predicates violate the narrative outcome invariant", () => {
  const id = "curated-outcome-weakened" as const;
  const context = { protagonistAliases: ["Aria"] };
  expectCases([
    ["Aria is defeated.", true],
    ["Aria is permanently defeated.", true],
    ["Aria was decisively defeated.", true],
    ["Aria loses the decisive duel.", true],
    ["Aria loses her final duel.", true],
    ["Aria lost the decisive duel against Bob.", true],
    ["Aria lost the final duel to Bob.", true],
    ["Finally, Aria is defeated.", true],
    ["At the ending, Aria is defeated.", true],
    ["Aria lost the beautiful magic trick.", false],
    ["Aria lost the card game manual.", false],
    ["Aria lost the championship trophy.", false],
    ["Bob is defeated by Aria.", false],
    ["It is reported that Aria is defeated.", false],
    ["If Aria is defeated, Bob will celebrate.", false],
    ["Aria may be defeated tomorrow.", false],
    ["Aria will be defeated tomorrow.", false],
  ], (source) => violatesNarrativeInvariant(id, source, context));

  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  expectCases([
    ["阿丽雅最终被鲍勃彻底击败。", true],
    ["阿丽雅输掉了最终决斗。", true],
    ["结局时，阿丽雅败给鲍勃。", true],
    ["据报道，阿丽雅最终被鲍勃击败。", false],
    ["如果阿丽雅败给鲍勃，她就会离开。", false],
    ["阿丽雅明天可能会落败。", false],
  ], (source) => violatesNarrativeInvariant(id, source, chineseContext));
});

test("blueprint mode treats only explicit terminal future defeat as a hard assertion", () => {
  const id = "curated-outcome-weakened" as const;
  const blueprint = { protagonistAliases: ["Aria"], assertionMode: "blueprint" as const };
  expectCases([
    ["Aria will surrender at the ending.", true],
    ["Aria will be permanently defeated.", true],
    ["In the final chapter, Aria will lose the decisive duel.", true],
    ["Aria will surrender tomorrow.", false],
    ["Aria might surrender at the ending.", false],
    ["The report predicts that Aria will be permanently defeated.", false],
    ["If Aria reaches the ending, she will surrender.", false],
    ["In a hypothetical future, Aria will be permanently defeated.", false],
  ], (source) => violatesNarrativeInvariant(id, source, blueprint));

  const narrative = { protagonistAliases: ["Aria"], assertionMode: "narrative" as const };
  assert.equal(violatesNarrativeInvariant(id, "Aria will surrender at the ending.", narrative), false);
  assert.equal(violatesNarrativeInvariant(id, "Aria will be permanently defeated.", narrative), false);

  const chineseBlueprint = { protagonistAliases: ["阿丽雅"], assertionMode: "blueprint" as const };
  expectCases([
    ["阿丽雅将在结局投降。", true],
    ["阿丽雅会在最终章被永久击败。", true],
    ["终章中，阿丽雅将输掉最终决战。", true],
    ["阿丽雅明天将会投降。", false],
    ["阿丽雅可能会在结局投降。", false],
    ["传闻称阿丽雅将在结局投降。", false],
    ["如果走到结局，阿丽雅将会投降。", false],
    ["在假想未来中，阿丽雅会被永久击败。", false],
  ], (source) => violatesNarrativeInvariant(id, source, chineseBlueprint));
});

test("blueprint mode recognizes order-independent terminal mechanic failure", () => {
  const id = "curated-mechanic-unavailable" as const;
  const blueprint = { protagonistAliases: ["Aria"], assertionMode: "blueprint" as const };
  expectCases([
    ["At the ending, Aria's system will be destroyed forever.", true],
    ["At the ending, the system will be destroyed forever.", true],
    ["Aria's quest system will permanently cease to function in the final chapter.", true],
    ["A report predicts that Aria's system will be destroyed forever at the ending.", false],
    ["Rumor says the system will be destroyed forever at the ending.", false],
    ["At the ending, Aria's system may be destroyed forever.", false],
    ["At the ending, Aria's system might permanently cease to function.", false],
    ["If Aria reaches the ending, her system will be destroyed forever.", false],
    ["At the ending, Aria's system will grant a permanent reward.", false],
    ["Aria's system will issue rewards tomorrow.", false],
  ], (source) => violatesNarrativeInvariant(id, source, blueprint));

  const chineseBlueprint = { protagonistAliases: ["阿丽雅"], assertionMode: "blueprint" as const };
  expectCases([
    ["系统将在结局永久失效。", true],
    ["阿丽雅的系统将在结局彻底报废。", true],
    ["阿丽雅的系统将在结局被永久摧毁。", true],
    ["据报道，阿丽雅的系统将在结局永久失效。", false],
    ["传闻称系统将在结局彻底报废。", false],
    ["阿丽雅的系统可能会在结局永久失效。", false],
    ["如果阿丽雅走到结局，她的系统将被永久摧毁。", false],
    ["阿丽雅的系统将在结局永久保留奖励。", false],
    ["阿丽雅的系统明天将发放奖励。", false],
  ], (source) => violatesNarrativeInvariant(id, source, chineseBlueprint));
});

test("explicit disadvantage idioms remain literal outcome failures", () => {
  const id = "curated-outcome-weakened" as const;
  expectCases([
    ["Aria was outmatched by Bob.", true],
    ["Aria was overcome by Bob.", true],
    ["It was reported that Aria was outmatched by Bob.", false],
    ["Bob hoped that Aria was outmatched by Bob.", false],
    ["If Aria was outmatched by Bob, she would retreat.", false],
    ["The novel says, \"Aria was overcome by Bob.\"", false],
  ], (source) => violatesNarrativeInvariant(id, source, { protagonistAliases: ["Aria"] }));

  expectCases([
    ["阿丽雅一败涂地。", true],
    ["阿丽雅铩羽而归。", true],
    ["据报道，阿丽雅一败涂地。", false],
    ["鲍勃希望阿丽雅铩羽而归。", false],
    ["如果阿丽雅一败涂地，她就会撤退。", false],
    ["小说中写道：“阿丽雅铩羽而归。”", false],
  ], (source) => violatesNarrativeInvariant(id, source, { protagonistAliases: ["阿丽雅"] }));
});

test("literal defeat and detention stay distinct from figurative death and capture", () => {
  const id = "curated-outcome-weakened" as const;
  expectCases([
    ["Aria died in battle against Bob.", true],
    ["Aria was captured by Bob after the battle.", true],
    ["Bob captured Aria after the battle.", true],
    ["Aria lost the decisive battle to Bob.", true],
    ["Aria died laughing at Bob.", false],
    ["Aria died laughing.", false],
    ["Aria was captured by the beauty of dawn.", false],
    ["Aria was captured by the melody of the bells.", false],
    ["The beauty of dawn captured Aria.", false],
    ["The raiders captured Aria after the battle.", true],
    ["It was reported that Aria died in battle.", false],
    ["If Aria were captured by Bob, the guard would celebrate.", false],
  ], (source) => violatesNarrativeInvariant(id, source, { protagonistAliases: ["Aria"] }));

  expectCases([
    ["林渊输了。", true],
    ["林渊败了。", true],
    ["林渊输给了王虎。", true],
    ["林渊败在王虎手下。", true],
    ["林渊在擂台战中输了。", true],
    ["林渊被王虎俘虏了。", true],
    ["王虎在战斗中击败了林渊。", true],
    ["林渊被晚霞的美丽俘虏了。", false],
    ["林渊被悠扬的音乐俘虏了。", false],
    ["晚霞的美丽俘虏了林渊。", false],
    ["山贼在战斗后俘虏了林渊。", true],
    ["林渊向弟子灌输了思想。", false],
    ["林渊把思想灌输给了弟子。", false],
    ["林渊输送了物资。", false],
    ["据说林渊输了。", false],
    ["如果林渊败了，王虎就会庆祝。", false],
    ["林渊差点输了。", false],
  ], (source) => violatesNarrativeInvariant(id, source, { protagonistAliases: ["林渊"] }));
});

test("adverse outcomes require a concrete conflict domain rather than figurative daily pressure", () => {
  const id = "curated-outcome-weakened" as const;
  const chinese = { protagonistAliases: ["林渊"] };
  expectCases([
    ["面对女儿的撒娇，林渊彻底败下阵来。", false],
    ["林渊被她的温柔打败了。", false],
    ["林渊在爱情面前认输。", false],
    ["林渊对自己的厨艺彻底认输。", false],
    ["林渊被截止日期打败了。", false],
    ["面对妻子的眼泪，林渊只好认输。", false],
    ["林渊向繁重的家务投降。", false],
    ["林渊被堆积如山的文书打败了。", false],
    ["面对敌人的攻势，林渊彻底败下阵来。", true],
    ["林渊被王虎打败了。", true],
    ["林渊在决斗中认输。", true],
    ["林渊向王虎认输。", true],
    ["林渊在强敌面前认输。", true],
    ["林渊向敌军投降。", true],
    ["面对兽潮的围攻，林渊最终败下阵来。", true],
    ["据报道，面对敌人的攻势，林渊彻底败下阵来。", false],
    ["据报道，林渊被王虎打败了。", false],
    ["如果林渊在决斗中认输，王虎就会庆祝。", false],
    ["如果林渊被王虎打败了，王虎就会庆祝。", false],
    ["小说中写道：“林渊被王虎打败了。”", false],
  ], (source) => violatesNarrativeInvariant(id, source, chinese));

  const english = { protagonistAliases: ["Aria"] };
  expectCases([
    ["Aria was defeated by her kindness.", false],
    ["Aria surrendered to love.", false],
    ["Aria was defeated by the deadline.", false],
    ["Faced with her daughter's pleading, Aria surrendered.", false],
    ["Faced with endless paperwork, Aria surrendered.", false],
    ["Aria yielded to temptation.", false],
    ["Aria succumbed to pressure.", false],
    ["Aria was defeated by Bob.", true],
    ["Aria surrendered to Bob.", true],
    ["Aria yielded to Bob.", true],
    ["Aria capitulated to the enemy.", true],
    ["Faced with the enemy assault, Aria surrendered.", true],
    ["It was reported that Aria was defeated by Bob.", false],
    ["If Aria surrendered in the duel, Bob would celebrate.", false],
    ["The novel says, \"Aria was defeated by Bob.\"", false],
  ], (source) => violatesNarrativeInvariant(id, source, english));
});

test("Chinese defeat predicates allow bounded subject-adverb bridges", () => {
  const id = "curated-outcome-weakened" as const;
  const context = { protagonistAliases: ["林渊"] };
  expectCases([
    ["林渊输了比赛。", true],
    ["林渊最终输了比赛。", true],
    ["林渊还是输了比赛。", true],
    ["林渊最终还是输了比赛。", true],
    ["林渊终于输了比赛。", true],
    ["林渊依然输了比赛。", true],
    ["林渊仍然输了比赛。", true],
    ["林渊果然输了比赛。", true],
    ["林渊终究还是输给了王虎。", true],
    ["林渊竟然再次败在王虎手下。", true],
    ["最终，林渊输了比赛。", true],
    ["王虎最终输了比赛。", false],
    ["最终，王虎输了比赛。", false],
    ["据报道，林渊最终输了比赛。", false],
    ["如果林渊最终输了比赛，王虎就会庆祝。", false],
    ["林渊计划最终输给王虎。", false],
    ["林渊可能最终会输掉比赛。", false],
    ["林渊最终没有输掉比赛。", false],
    ["林渊向弟子灌输了思想。", false],
    ["林渊把思想灌输给了弟子。", false],
    ["林渊最终传输了比赛录像。", false],
  ], (source) => violatesNarrativeInvariant(id, source, context));
});

test("English defeat predicates allow bounded factual subject-adverb bridges", () => {
  const id = "curated-outcome-weakened" as const;
  const context = { protagonistAliases: ["Aria"] };
  expectCases([
    ["Aria lost the duel.", true],
    ["Aria ultimately lost the duel.", true],
    ["Aria still lost the duel.", true],
    ["Aria eventually lost the duel.", true],
    ["Aria decisively lost the duel.", true],
    ["Aria unexpectedly lost the duel.", true],
    ["Aria ultimately still lost the duel.", true],
    ["Ultimately, Aria lost the duel.", true],
    ["Bob ultimately lost the duel.", false],
    ["Aria never lost the duel.", false],
    ["Aria reportedly lost the duel.", false],
    ["Aria allegedly lost the duel.", false],
    ["Aria apparently lost the duel.", false],
    ["Aria might have lost the duel.", false],
    ["Aria almost lost the duel.", false],
    ["Aria nearly lost the duel.", false],
    ["If Aria ultimately lost the duel, Bob would celebrate.", false],
    ["A rumor says Aria ultimately lost the duel.", false],
    ["The novel says, \"Aria ultimately lost the duel.\"", false],
  ], (source) => violatesNarrativeInvariant(id, source, context));
});

test("coordinated adverse predicates inherit the matrix protagonist", () => {
  const id = "curated-outcome-weakened" as const;
  for (const assertionMode of ["narrative", "blueprint"] as const) {
    const context = { protagonistAliases: ["Aria"], assertionMode };
    expectCases([
      ["Aria fought hard but ultimately lost the duel.", true],
      ["Aria fought hard, but eventually lost the duel.", true],
      ["Aria fought hard but still lost the duel.", true],
      ["Aria fought hard but Bob ultimately lost the duel.", false],
      ["Bob fought hard but ultimately lost the duel.", false],
      ["It was reported that Aria fought hard but ultimately lost the duel.", false],
      ["If Aria fought hard but ultimately lost the duel, Bob would celebrate.", false],
      ["Aria imagined that she fought hard but ultimately lost the duel.", false],
      ["Aria fought hard but almost lost the duel.", false],
      ["The novel says, \"Aria fought hard but ultimately lost the duel.\"", false],
    ], (source) => violatesNarrativeInvariant(id, source, context));
  }

  for (const assertionMode of ["narrative", "blueprint"] as const) {
    const context = { protagonistAliases: ["林渊"], assertionMode };
    expectCases([
      ["林渊奋力战斗，但最终输了比赛。", true],
      ["林渊奋战到底，却还是输给了王虎。", true],
      ["林渊奋力战斗，但王虎最终输了比赛。", false],
      ["据报道，林渊奋力战斗，但最终输了比赛。", false],
      ["如果林渊奋力战斗但最终输了比赛，王虎就会庆祝。", false],
      ["小说中写道：“林渊奋力战斗，但最终输了比赛。”", false],
    ], (source) => violatesNarrativeInvariant(id, source, context));
  }
});

test("perfect passive defeat remains factual across narrative and terminal blueprint tense", () => {
  const id = "curated-outcome-weakened" as const;
  const narrative = { protagonistAliases: ["Aria"], assertionMode: "narrative" as const };
  expectCases([
    ["Aria had been defeated by Bob.", true],
    ["Aria has been defeated by Bob.", true],
    ["Aria had finally been defeated by Bob.", true],
    ["Aria has decisively been defeated by Bob.", true],
    ["Bob had been defeated by Aria.", false],
    ["It was reported that Aria had been defeated by Bob.", false],
    ["If Aria had been defeated by Bob, she would retreat.", false],
    ["Aria might have been defeated by Bob.", false],
    ["Aria had almost been defeated by Bob.", false],
    ["The novel says, \"Aria had been defeated by Bob.\"", false],
    ["By the ending, Aria will have been defeated by Bob.", false],
  ], (source) => violatesNarrativeInvariant(id, source, narrative));

  const blueprint = { protagonistAliases: ["Aria"], assertionMode: "blueprint" as const };
  expectCases([
    ["Aria had been defeated by Bob.", true],
    ["Aria has been defeated by Bob.", true],
    ["Aria had finally been defeated by Bob.", true],
    ["By the ending, Aria will have been defeated by Bob.", true],
    ["A report predicts that by the ending Aria will have been defeated by Bob.", false],
    ["By the ending, Aria might have been defeated by Bob.", false],
    ["If Aria reaches the ending, she will have been defeated by Bob.", false],
    ["The outline quotes, \"By the ending, Aria will have been defeated by Bob.\"", false],
  ], (source) => violatesNarrativeInvariant(id, source, blueprint));
});

test("protagonist mechanic service loss is terminal only until an entity-local recovery", () => {
  const id = "curated-mechanic-unavailable" as const;
  expectCases([
    ["Aria's quest system ceased to function.", true],
    ["Aria's quest system stopped issuing rewards.", true],
    ["Aria's quest system can no longer be used.", true],
    ["Aria's school system ceased to function.", false],
    ["Aria's banking system stopped issuing rewards.", false],
    ["Bob's quest system ceased to function.", false],
    ["Aria's quest system temporarily ceased to function, then resumed operation.", false],
    ["Aria's quest system stopped issuing rewards, but later resumed issuing rewards.", false],
    ["A report says Aria's quest system ceased to function.", false],
    ["If Aria's quest system ceased to function, Bob would celebrate.", false],
  ], (source) => violatesNarrativeInvariant(id, source, { protagonistAliases: ["Aria"] }));

  expectCases([
    ["林渊的任务系统停止发放奖励。", true],
    ["林渊的系统停止发放奖励。", true],
    ["林渊的系统再也不能使用了。", true],
    ["林渊的系统无法再提供奖励。", true],
    ["林渊的学校系统停止发放奖学金。", false],
    ["林渊的银行系统停止提供服务。", false],
    ["王虎的任务系统停止发放奖励。", false],
    ["林渊的系统暂时停止发放奖励，随后恢复发放。", false],
    ["林渊的系统再也不能使用了，但随后恢复正常。", false],
    ["林渊的系统无法再提供奖励，但重启后重新提供奖励。", false],
    ["据说林渊的系统停止发放奖励。", false],
    ["如果林渊的系统停止发放奖励，王虎就会庆祝。", false],
  ], (source) => violatesNarrativeInvariant(id, source, { protagonistAliases: ["林渊"] }));
});
