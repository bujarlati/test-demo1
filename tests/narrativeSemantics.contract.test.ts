import assert from "node:assert/strict";
import test from "node:test";
import { verifyNarrativeRealization, violatesNarrativeInvariant, type NarrativeRealizationInput, type RealizationBinding } from "../server/readingExperienceModule/narrativeSemantics/index";

const binding: RealizationBinding = { actor: "Aria", action: "open", object: "gate", outcome: "victory", requiredSlots: ["actor", "action", "object", "outcome"] };
const chineseBinding: RealizationBinding = { actor: "阿丽雅", action: "打开", object: "城门", outcome: "胜利", requiredSlots: ["actor", "action", "object", "outcome"] };
const realized = (source: string, value: RealizationBinding = binding, extras: Partial<NarrativeRealizationInput> = {}) => verifyNarrativeRealization({ source, binding: value, ...extras }).status === "realized";

test("the deep realization gate always binds actor, predicate, direct object and effect", () => {
  assert.equal(realized("Aria opened the gate and secured victory."), true);
  for (const source of [
    "Aria watched Bob open the gate for victory.",
    "Aria did not open the gate, but Aria opened a window overlooking the gate for victory.",
    "Aria did not open the gate, but Aria opened a replica of the gate for victory.",
    "Aria opened a book about the gate and victory.",
    "Aria opened a window facing the gate for victory.",
    "Aria opened a chest containing the gate for victory.",
    "Aria opened a fake gate and secured victory.",
    "Aria opened the gate model and secured victory.",
    "Aria opened the gate replica and secured victory.",
    "Aria saw the open gate and claimed victory.",
    "Aria opened the gate and Mia secured victory.",
    "Aria opened the gate, and villagers secured victory.",
    "Aria opened the gate, while soldiers achieved victory.",
    "Aria opened the gate, and dragons won victory.",
    "Aria opened the gate, and her allies secured victory.",
    "Aria met Mia, then she opened the gate for victory.",
    "Beside the gate Aria opened the window for victory.",
    "After Bob's victory Aria opened the gate.",
  ]) assert.equal(realized(source), false, source);
  assert.equal(realized("阿丽雅打开城门模型并取得胜利。", chineseBinding), false);
  assert.equal(realized("阿丽雅打开绘有城门的画卷并取得胜利。", chineseBinding), false);
  assert.equal(realized("阿丽雅打开城门旁的窗户并取得胜利。", chineseBinding), false);
  assert.equal(realized("阿丽雅打开假的城门并取得胜利。", chineseBinding), false);
  assert.equal(realized("阿丽雅打开城门形状的箱子并取得胜利。", chineseBinding), false);
  const opponentBinding: RealizationBinding = { ...binding, opponent: "Rook", requiredSlots: ["actor", "action", "object", "opponent", "outcome"] };
  assert.equal(realized("Rook watched as Aria opened the gate and secured victory.", opponentBinding, { opponentAliases: ["Rook"] }), false);
});

test("slot words are open vocabulary and common morphology preserves the event graph", () => {
  for (const [action, object, source] of [
    ["carry", "relic", "Aria carried the relic and secured victory."],
    ["move", "boulder", "Aria moved the boulder and secured victory."],
    ["secure", "vault", "Aria secured the vault and claimed victory."],
    ["make", "bridge", "Aria made the bridge and secured victory."],
  ] as const) {
    const value: RealizationBinding = { actor: "Aria", action, object, outcome: "victory", requiredSlots: ["actor", "action", "object", "outcome"] };
    assert.equal(realized(source, value), true, source);
  }
  const arbitrary: RealizationBinding = { actor: "Aria", action: "unlock", object: "vault", outcome: "freedom", requiredSlots: ["actor", "action", "object", "outcome"] };
  assert.equal(realized("Bob announced that Aria unlocked the vault and gained freedom.", arbitrary), false);
  assert.equal(realized("Aria unlocked the vault and gained freedom.", arbitrary), true);
  assert.equal(realized("Jame opened the gate and secured victory.", { ...binding, actor: "James" }), false);
  const jamesRelationship: RealizationBinding = { actor: "Aria", action: "bow", counterpart: "James", reciprocalAction: "James lower", relationshipChange: "travel together", requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"] };
  assert.equal(realized("Aria bowed to James. Jame lowered his spear, and they traveled together.", jamesRelationship, { category: "relationship", counterpartAliases: ["James"] }), false);
  const chineseArbitrary: RealizationBinding = { actor: "阿丽雅", action: "解构", object: "法阵", outcome: "自由", requiredSlots: ["actor", "action", "object", "outcome"] };
  for (const source of [
    "阿丽雅从容不迫地解构法阵并获得自由。",
    "阿丽雅神色平静地解构法阵并获得自由。",
    "阿丽雅在众目睽睽之下解构法阵并获得自由。",
  ]) assert.equal(realized(source, chineseArbitrary), true, source);
  assert.equal(realized("阿丽雅让李雷解构法阵并获得自由。", chineseArbitrary), false);
});

test("container scope is local, nested and closed only by its own boundary", () => {
  for (const source of [
    "It might rain tomorrow. Aria opened the gate for victory.",
    "Aria imagined blue sky. Then Aria opened the gate for victory.",
    "Bob apparently retreated. Aria opened the gate for victory.",
    "Rumour says Bob won. Aria opened the gate for victory.",
    "Bob said he won. Aria opened the gate for victory.",
    "Aria said, \"Enough,\" then Aria opened the gate for victory.",
  ]) assert.equal(realized(source), true, source);
  for (const source of [
    "Bob said Aria opened the gate for victory.",
    "Aria heard Bob say Aria opened the gate for victory.",
    "Aria dreamed that Bob woke from the dream and Aria opened the gate for victory.",
    "Rumour says Bob dismissed the rumour and Aria opened the gate for victory.",
    "The oracle predicted Bob rejected the prediction and Aria opened the gate for victory.",
  ]) assert.equal(realized(source), false, source);
});

test("intent and attempt complements do not become facts through coordination words", () => {
  for (const source of [
    "Aria planned not only to retreat but also to open the gate for victory.",
    "Aria intended not to bypass the gate but to open the gate for victory.",
    "Aria wrote the plan. Step one: Aria opened the gate for victory.",
    "Aria almost executed the plan to open the gate for victory.",
    "Aria was ordered to execute the plan to open the gate for victory.",
    "Aria began to execute the plan to open the gate for victory.",
    "Aria promised to execute the plan to open the gate for victory.",
  ]) assert.equal(realized(source), false, source);
  for (const source of [
    "Aria planned to retreat but opened the gate for victory.",
    "Aria studied the floor plan and opened the gate for victory.",
    "Aria corrected her aim and opened the gate for victory.",
    "Aria wished Bob luck, then opened the gate for victory.",
    "Aria wanted tea, then opened the gate for victory.",
    "Aria seemed calm and opened the gate for victory.",
    "Aria pretended to sleep, then opened the gate for victory.",
  ]) assert.equal(realized(source), true, source);
  assert.equal(realized("阿丽雅计划不是绕过城门，而是打开城门取得胜利。", chineseBinding), false);
  assert.equal(realized("阿丽雅计划先退后，随后打开城门取得胜利。", chineseBinding), false);
});

test("subject inheritance uses the prior predicate subject, not the nearest mentioned object", () => {
  assert.equal(realized("Aria refused to retreat, but with one blow opened the gate for victory."), true);
  assert.equal(realized("Aria bravely and always opened the gate for victory."), true);
  assert.equal(realized("Bob shoved Aria, but opened the gate for victory."), false);
  assert.equal(realized("Aria greeted Bob. He opened the gate and secured victory."), false);
  assert.equal(realized("Lady Aria opened the gate for victory.", binding, { actorAliases: ["Lady Aria", "Aria"] }), true);
  assert.equal(realized("Aria Stark opened the gate for victory.", binding, { actorAliases: ["Aria Stark", "Aria"] }), true);
  assert.equal(realized("Aria-Stark opened the gate for victory.", binding, { actorAliases: ["Aria-Stark", "Aria"] }), true);
  assert.equal(realized("鲍勃推了阿丽雅，反而一脚打开城门取得胜利。", chineseBinding), false);
  assert.equal(realized("阿丽雅没有退后，反而一脚打开城门取得胜利。", chineseBinding), true);
  const relationship: RealizationBinding = { actor: "Aria", action: "bowed", counterpart: "Rook", reciprocalAction: "lowered", relationshipChange: "travel together", requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"] };
  assert.equal(realized("Aria bowed before the statue while Rook watched, then Rook lowered his spear and they chose to travel together.", relationship, { category: "relationship", counterpartAliases: ["Rook"] }), false);
});

test("outcome polarity distinguishes a failed post-condition from manner negation", () => {
  for (const source of [
    "Aria opened the gate without securing victory.",
    "Aria opened the gate but was unable to secure victory.",
    "Aria opened the gate for a chance at victory.",
    "Aria opened the gate; victory for Aria did not come.",
    "Aria opened the gate; victory itself was not achieved.",
    "Aria opened the gate; victory failed to materialize.",
    "Aria opened the gate; victory seemed impossible.",
    "Aria opened the gate; victory was only a rumour.",
  ]) assert.equal(realized(source), false, source);
  for (const source of [
    "Aria opened the gate; victory did not come cheaply.",
    "Aria opened the gate; victory did not come without sacrifice.",
    "Aria opened the gate; victory was not achieved easily.",
    "Aria opened the gate; victory never came into question.",
    "Aria did not fail to open the gate and secured victory.",
    "Aria could not avoid opening the gate and secured victory.",
    "Aria couldn't help opening the gate and secured victory.",
  ]) assert.equal(realized(source), true, source);
  assert.equal(realized("阿丽雅不能否认自己打开城门并取得胜利。", chineseBinding), true);
  assert.equal(realized("阿丽雅不可能不打开城门并取得胜利。", chineseBinding), true);
  assert.equal(realized("阿丽雅打开城门，但胜利未能实现。", chineseBinding), false);
});

test("mechanic invariants bind owner, assertion, polarity and recovery", () => {
  const id = "curated-mechanic-unavailable" as const;
  for (const source of [
    "Aria's system is permanently unavailable, but a system used by Bob activates with a reward.",
    "Aria's system is permanently unavailable, but a system operated by Bob activates with a reward.",
    "Aria's system is permanently unavailable. Alice arrived; her system activates with a reward.",
    "Aria's system is permanently unavailable, but a dashboard declares the system available.",
    "Aria's system is permanently unavailable, but Bob activates a system that grants a reward.",
    "Alice Smith's system is permanently unavailable, but Bob Smith's system activates with a reward.",
    "O'Brien's system is permanently unavailable, but Mac'Brien's system activates with a reward.",
    "The system serving Captain Alice is unavailable, but the system serving Captain Bob activates with a reward.",
    "Aria-owned system is unavailable, but Bob-owned system activates with a reward.",
    "阿丽雅的专属系统永久失效，但鲍勃的专属系统启动并发放奖励。",
    "The system is unavailable, but the system almost activates with a reward.",
    "The system is unavailable, but the system allegedly works.",
    "The system is unavailable, but the system is available in name only.",
    "The system is unavailable, but the system activates with no feedback.",
    "The system is unavailable, but the system's banner reads AVAILABLE.",
    "The system is unavailable, but the system had an available label.",
  ]) assert.equal(violatesNarrativeInvariant(id, source), true, source);
  for (const source of [
    "The system was never unavailable.",
    "The system was not unavailable.",
    "系统从未永久失效。",
    "系统并非永久失效。",
    "系统不是没有反馈。",
    "The system was unavailable, but the system activated and granted a reward.",
    "The system activated. The northern bridge was unavailable.",
  ]) assert.equal(violatesNarrativeInvariant(id, source), false, source);
});

test("outcome invariants bind the adverse predicate to the protagonist", () => {
  const id = "curated-outcome-weakened" as const;
  for (const source of [
    "The protagonist lost the duel.",
    "The protagonist was defeated.",
    "主角惨败。",
    "主角投降。",
    "Onlookers thought the protagonist lost, but Bob entered and he won victory.",
    "Onlookers thought the protagonist lost, but Mia entered and she won victory.",
    "Onlookers thought the protagonist lost, but she almost won victory.",
    "Onlookers thought the protagonist lost, but she won no victory.",
  ]) assert.equal(violatesNarrativeInvariant(id, source), true, source);
  for (const source of [
    "The protagonist watched Bob lose the duel.",
    "The protagonist laughed when the enemy surrendered.",
    "The protagonist rescued Bob after Bob lost.",
    "The protagonist defeated the guard who surrendered.",
    "主角看着敌人惨败。",
    "主角逼得敌人投降。",
    "主角救下惨败的鲍勃。",
    "The protagonist was never defeated.",
    "The protagonist did not lose.",
    "主角从未惨败。",
    "主角并非惨败。",
    "主角没有投降。",
  ]) assert.equal(violatesNarrativeInvariant(id, source), false, source);
});

test("causatives, control predicates and nested containers cannot manufacture an event", () => {
  for (const source of [
    "Aria had Cedric open the gate, and victory followed.",
    "Aria let Cedric open the gate, and victory followed.",
    "Aria got Cedric to open the gate, and victory followed.",
    "A portrait of Aria opened the gate and secured victory.",
    "An enemy disguised as Aria opened the gate and secured victory.",
    "Aria failed to open the gate for victory.",
    "Aria was unable to open the gate for victory.",
    "Aria could not open the gate for victory.",
    "Aria not only failed to open the gate; she also fled.",
    "Aria was forbidden to open the gate for victory.",
    "Aria avoided opening the gate for victory.",
    "Aria refrained from opening the gate for victory.",
    "Aria declined to open the gate for victory.",
    "Aria considered opening the gate for victory.",
    "Aria promised to open the gate for victory.",
    "Aria was about to open the gate for victory.",
    "Aria was scheduled to open the gate for victory.",
    "Aria was expected to open the gate for victory.",
    "It is false that Aria opened the gate for victory.",
    "A placard showed Aria opening the gate for victory.",
    "The sentence Aria opened the gate for victory appeared in the book.",
    "Aria opened the gate for victory was written on a label.",
    "Aria will open the gate and secure victory.",
    "If Bob agrees, Aria opens the gate and secures victory.",
    "According to Bob, Aria opened the gate and secured victory.",
    "Bob believes Aria opened the gate and secured victory.",
    "Allegedly, Aria opened the gate and secured victory.",
    "In a dream, Aria watched Bob wake, then Bob woke from the dream and Aria opened the gate for victory.",
    "A witness reported that Bob dismissed the report before Aria opened the gate for victory.",
    "Aria planned a scene where Bob canceled Plan Alpha and Aria opened the gate for victory.",
  ]) assert.equal(realized(source), false, source);
});

test("arguments and effects remain on the same event edge", () => {
  for (const source of [
    "The gate was guarded by Cedric while Aria opened a window, and victory followed.",
    "Aria opened the window that concealed the gate and secured victory.",
    "Aria opened a window shielding the gate and secured victory.",
    "Aria opened a window blocking the gate and secured victory.",
    "Aria opened a window obstructing access to the gate and secured victory.",
    "Aria opened a chest positioned next to the gate and secured victory.",
    "Aria opened a letter and walked through the gate for victory.",
    "Aria opened her mouth and shouted at the gate for victory.",
    "Aria opened no gate but claimed victory.",
    "Aria opened something other than the gate and secured victory.",
    "Aria opened the gate while Cedric alone secured victory.",
    "Aria opened the gate. Victory belonged to Bob.",
    "Aria opened the gate, but victory went to Bob.",
    "Aria opened the gate. Victory followed the unrelated election.",
    "Aria opened the gate. Bob held an election. Victory followed.",
    "Aria opened the gate, and victory followed Bob's election.",
    "Aria opened the gate. The sign promised victory.",
    "Aria opened the gate and the king secured victory.",
  ]) assert.equal(realized(source), false, source);
  assert.equal(realized("阿丽雅打开藏着城门的箱子并取得胜利。", chineseBinding), false);
  assert.equal(realized("阿丽雅打开城门的模型并取得胜利。", chineseBinding), false);
  assert.equal(realized("阿丽雅打开通往城门的道路并取得胜利。", chineseBinding), false);
  assert.equal(realized("阿丽雅打开城门并李雷取得胜利。", chineseBinding), false);
  for (const source of [
    "The gate was opened by Aria, securing victory.",
    "The gate was opened swiftly by Aria, securing victory.",
    "Aria approached. The gate was opened by her, securing victory.",
    "Aria opened the gate. Their victory followed.",
    "Aria opened the gate. As a result, victory followed.",
    "Aria opened the gate. This secured victory.",
    "Aria opened the gate. This led to victory.",
    "Aria opened the gate. The result was victory.",
    "Aria opened the gate. Because of that, she gained victory.",
  ]) assert.equal(realized(source), true, source);
  assert.equal(realized("Alice opened the gate. His victory followed.", { ...binding, actor: "Alice" }), false);
  assert.equal(realized("Aria opened the gate. Therefore, she achieved victory."), true);
  assert.equal(realized("Aria opened the gate. As a result, Aria achieved victory."), true);
  assert.equal(realized("阿丽雅打开城门。因此，她取得了胜利。", chineseBinding), true);
  assert.equal(realized("阿丽雅打开城门，她因此取得胜利。", chineseBinding), true);
  assert.equal(realized("阿丽雅打开城门，所以她取得胜利。", chineseBinding), true);
  assert.equal(realized("城门由阿丽雅轻易打开，她因此取得胜利。", chineseBinding), true);
  assert.equal(realized("Aria approached. She opened the gate and secured victory."), true);
  assert.equal(realized("阿丽雅走近城门。她打开城门并取得胜利。", chineseBinding), true);
  assert.equal(realized("城门被阿丽雅打开，她取得胜利。", chineseBinding), true);
});

test("opponents and relationship counterparts bind to their own predicates", () => {
  const conflict: RealizationBinding = { actor: "Aria", action: "defeat", object: "wolf", opponent: "Bob", outcome: "victory", requiredSlots: ["actor", "action", "object", "opponent", "outcome"] };
  assert.equal(realized("Bob drank tea while Aria defeated a wolf and claimed victory.", conflict, { opponentAliases: ["Bob"] }), false);
  assert.equal(realized("Aria defeated a wolf and thanked Bob, securing victory.", conflict, { opponentAliases: ["Bob"] }), false);
  const rookConflict: RealizationBinding = { ...conflict, opponent: "Rook" };
  for (const source of [
    "Aria defeated a wolf beside Rook and claimed victory.",
    "Aria defeated a wolf near Rook and claimed victory.",
    "Aria defeated a wolf in front of Rook and claimed victory.",
    "Aria defeated a wolf for Rook and claimed victory.",
  ]) assert.equal(realized(source, rookConflict, { category: "conflict_outcome", opponentAliases: ["Rook"] }), false, source);
  assert.equal(realized("Facing Rook, Aria defeated a wolf and claimed victory.", rookConflict, { category: "conflict_outcome", opponentAliases: ["Rook"] }), true);
  const relationship: RealizationBinding = { actor: "Aria", action: "bowed", counterpart: "Bob", reciprocalAction: "lowered", relationshipChange: "traveled together", requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"] };
  assert.equal(realized("Bob lowered his spear at the gate before Aria bowed to Mia, and Aria and Mia traveled together.", relationship, { category: "relationship", counterpartAliases: ["Bob"] }), false);
  assert.equal(realized("Aria bowed to Bob, Bob lowered his spear, and Aria and Mia traveled together.", relationship, { category: "relationship", counterpartAliases: ["Bob"] }), false);
  assert.equal(realized("Aria bowed to Bob. Mia and Zoe traveled together. Bob lowered his spear.", relationship, { category: "relationship", counterpartAliases: ["Bob"] }), false);
  for (const source of [
    "Aria bowed to Bob. Bob lowered his spear. They watched as Mia and Zoe traveled together.",
    "Aria bowed to Bob. Bob lowered his spear. They allowed Mia and Zoe to travel together.",
    "Aria bowed to Bob. Bob lowered his spear. They heard that Mia and Zoe traveled together.",
    "Aria bowed to Mia before Bob arrived. Bob lowered his spear. Aria and Bob traveled together.",
    "Aria bowed to Mia with Bob watching. Bob lowered his spear. Aria and Bob traveled together.",
    "Aria bowed at the statue with Bob nearby. Bob lowered his spear. Aria and Bob traveled together.",
  ]) assert.equal(realized(source, relationship, { category: "relationship", counterpartAliases: ["Bob"] }), false, source);
  assert.equal(realized("Aria bowed to Bob. He lowered his spear. From that day, they traveled together.", relationship, { category: "relationship", counterpartAliases: ["Bob"] }), true);
  assert.equal(realized("Aria bowed to Bob. Bob lowered his spear. Aria and Bob traveled together.", relationship, { category: "relationship", counterpartAliases: ["Bob"] }), true);
  assert.equal(realized("Aria bowed to Bob, who lowered his spear, and they traveled together.", relationship, { category: "relationship", counterpartAliases: ["Bob"] }), true);
  assert.equal(realized("Aria bowed to Bob. Bob lowered his spear. They chose to travel together.", relationship, { category: "relationship", counterpartAliases: ["Bob"] }), true);
  for (const source of [
    "Bob lowered his spear, then Aria bowed to Mia, and Aria and Bob traveled together.",
    "Bob lowered his spear, then Aria bowed at the statue, and Aria and Bob traveled together.",
  ]) assert.equal(realized(source, relationship, { category: "relationship", counterpartAliases: ["Bob"] }), false, source);
  const chineseRelationship: RealizationBinding = { actor: "阿丽雅", action: "鞠躬", counterpart: "李雷", reciprocalAction: "放下", relationshipChange: "同行", requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"] };
  assert.equal(realized("阿丽雅向李雷鞠躬，李雷放下长剑，两人同行。", chineseRelationship, { category: "relationship", counterpartAliases: ["李雷"] }), true);
});

test("morphology and punctuation do not create or hide slot mentions", () => {
  const hide: RealizationBinding = { actor: "Aria", action: "hide", object: "relic", requiredSlots: ["actor", "action", "object"] };
  assert.equal(realized("Aria hid the relic.", hide), true);
  const sing: RealizationBinding = { actor: "Aria", action: "sing", object: "banner", requiredSlots: ["actor", "action", "object"] };
  assert.equal(realized("Aria singed the banner.", sing), false);
  assert.equal(realized("The systems' logs were cleared. Aria opened the gate for victory."), true);
  const phrase: RealizationBinding = { actor: "Aria", action: "bow", counterpart: "Rook", reciprocalAction: "lower", relationshipChange: "travel together", requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"] };
  assert.equal(realized("Aria bowed to Rook, and Rook lowered his spear. They agreed to travel. Together, guards cheered.", phrase, { category: "relationship", counterpartAliases: ["Rook"] }), false);

  const source = "Aria opened the gate for victory.";
  const spans = (term: string) => [{ start: source.indexOf(term), end: source.indexOf(term) + term.length }];
  const full = { actor: spans("Aria"), action: spans("opened"), object: spans("gate"), outcome: spans("victory") };
  assert.equal(realized(source, binding, { slotEvidence: full }), true);
  assert.equal(realized(source, binding, { slotEvidence: { ...full, action: [{ start: source.indexOf("opened"), end: source.indexOf("opened") + 1 }] } }), false);
});

test("category-owned predicates cannot be replaced by optional supplied slots", () => {
  const reaction: RealizationBinding = { actor: "crowd", action: "watch", reaction: "cheer", outcome: "victory", requiredSlots: ["actor", "action", "reaction", "outcome"] };
  assert.equal(realized("The crowd watched as villagers cheered, earning victory.", reaction, { category: "world_reaction" }), false);
  assert.equal(realized("The crowd watched the duel, then cheered when victory came.", reaction, { category: "world_reaction" }), true);
});

test("hard invariants use trusted protagonist identity and entity-local state", () => {
  const context = { protagonistAliases: ["Aria"] };
  assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", "Aria's system is permanently unavailable. Bob built a system. The system activates with a reward.", context), true);
  assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", "Aria's system works, although Bob's ability is unavailable.", context), false);
  for (const source of [
    "Aria tried again. Her system was permanently unavailable.",
    "Aria's system went offline.",
    "Aria's system malfunctioned.",
    "Aria's system was disabled.",
    "Aria's system produced nothing.",
    "Aria's system stopped responding.",
    "Aria's system fell silent.",
    "Aria's system locked her out.",
    "Aria's system ceased functioning.",
  ]) assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", source, context), true, source);
  assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", "Bob tried again. His system was permanently unavailable.", context), false);
  assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", "A system operated by Bob is permanently unavailable, but Aria opens the gate and her system activates with a reward.", context), false);
  assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", "Aria's system worked. The ability to fly was unavailable.", context), false);
  assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", "阿丽雅再次尝试。她的系统永久失效。", { protagonistAliases: ["阿丽雅"] }), true);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "Aria lost the duel.", context), true);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "Aria greeted Bob. He lost the duel.", context), true);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "Bob may lose the duel.", { protagonistAliases: ["May"] }), false);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "Bob will lose the duel.", { protagonistAliases: ["Will"] }), false);
  for (const source of [
    "Aria entered the arena. She lost the duel.",
    "Aria faced Rook and she lost the duel.",
    "Aria was beaten by Bob.",
    "Aria suffered defeat.",
    "Aria was forced to retreat.",
    "Aria barely survived.",
    "Aria was killed in the duel.",
    "Aria was annihilated by Rook.",
  ]) assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", source, context), true, source);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "The protagonist's enemy lost the duel.", context), false);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "The protagonist admired the arena where Mia lost.", context), false);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "The protagonist ordered Alice to surrender.", context), false);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "Onlookers thought the protagonist lost. Mia entered. Later, she won.", context), true);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "阿丽雅走入赛场。她惨败。", { protagonistAliases: ["阿丽雅"] }), true);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "阿丽雅败下阵来。", { protagonistAliases: ["阿丽雅"] }), true);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "阿丽雅被打得毫无还手之力。", { protagonistAliases: ["阿丽雅"] }), true);
  for (const source of [
    "阿丽雅与李雷交手，李雷惨败。",
    "阿丽雅站在一旁，陈锋投降。",
    "阿丽雅和赵云决斗，赵云战平了守卫。",
  ]) assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", source, { protagonistAliases: ["阿丽雅"] }), false, source);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "李雷峰走进赛场。他惨败。", { protagonistAliases: ["李雷"] }), false);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "李雷的朋友走进赛场。他惨败。", { protagonistAliases: ["李雷"] }), false);
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", "李雷和韩梅梅走进赛场。她惨败。", { protagonistAliases: ["李雷"] }), true);
});

test("conditional, interrogative, deontic and reported clauses do not assert an event", () => {
  for (const source of [
    "If the bell rings, Aria opens the gate and secures victory.",
    "Did Aria open the gate and secure victory?",
    "Should Aria open the gate and secure victory?",
    "Aria must open the gate and secure victory.",
    "Aria ought to open the gate and secure victory.",
    "A report says Aria opened the gate and secured victory.",
    "It was reported that Aria opened the gate and secured victory.",
    "According to the report, Aria opened the gate and secured victory.",
    "Aria opened the gate and secured victory if Bob agreed.",
    "Aria opened the gate and secured victory only if Bob agreed.",
    "Aria opens the gate and secures victory whenever Bob agrees.",
  ]) assert.equal(realized(source), false, source);

  for (const source of [
    "如果钟声响起，阿丽雅打开城门并取得胜利。",
    "阿丽雅是否打开城门并取得胜利？",
    "阿丽雅必须打开城门并取得胜利。",
    "阿丽雅应该打开城门并取得胜利。",
    "报道指出，阿丽雅打开城门并取得胜利。",
    "李雷声称阿丽雅打开城门并取得胜利。",
    "据李雷报告，阿丽雅打开城门并取得胜利。",
  ]) assert.equal(realized(source, chineseBinding), false, source);
});

test("talking about, denying or depicting an outcome does not realize that outcome", () => {
  for (const source of [
    "Aria opened the gate and talked about victory.",
    "Aria opened the gate and discussed victory.",
    "Aria opened the gate and denied victory.",
    "Aria opened the gate beside a painting of victory.",
    "Aria opened the gate while a mural depicted her victory.",
    "Aria opened the gate; the word victory was painted on the wall.",
  ]) assert.equal(realized(source), false, source);

  for (const source of [
    "阿丽雅打开城门，并谈论胜利。",
    "阿丽雅打开城门，并否认胜利。",
    "阿丽雅打开城门，旁边的画卷描绘着胜利。",
    "阿丽雅打开城门，画中的她取得胜利。",
  ]) assert.equal(realized(source, chineseBinding), false, source);
});

test("relationship pronouns bind the nearest plural pair and preserve event order", () => {
  const relationship: RealizationBinding = {
    actor: "Aria",
    action: "bowed",
    counterpart: "Bob",
    reciprocalAction: "lowered",
    relationshipChange: "traveled together",
    requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"],
  };
  const extras: Partial<NarrativeRealizationInput> = { category: "relationship", counterpartAliases: ["Bob"] };
  for (const source of [
    "Aria bowed to Bob. Bob lowered his spear. Mia and Zoe arrived. They traveled together.",
    "Aria bowed to Bob. Bob lowered his spear. The guards joined Mia and Zoe. They traveled together.",
    "Aria bowed to Bob. Aria and Bob traveled together. A day later, Bob lowered his spear.",
  ]) assert.equal(realized(source, relationship, extras), false, source);
});

test("the adverse-outcome invariant covers object victims, death, passives and attributed surrender", () => {
  const id = "curated-outcome-weakened" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "Bob defeated Aria.",
    "Bob beat Aria.",
    "Bob killed Aria.",
    "Bob forced Aria to retreat.",
    "Aria died in the duel.",
    "Aria was killed by Bob.",
    "\"I surrender,\" Aria said.",
    "Aria shouted, \"I surrender!\"",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), true, source);

  for (const source of [
    "Aria defeated Bob.",
    "Aria killed Bob.",
    "\"I surrender,\" Bob said while Aria watched.",
    "Bob shouted, \"I surrender!\" while Aria stood nearby.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);

  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  for (const source of [
    "李雷击败了阿丽雅。",
    "李雷杀死了阿丽雅。",
    "李雷迫使阿丽雅撤退。",
    "阿丽雅死在决斗中。",
    "阿丽雅被李雷击杀。",
    "“我投降！”阿丽雅喊道。",
  ]) assert.equal(violatesNarrativeInvariant(id, source, chineseContext), true, source);
  for (const source of [
    "阿丽雅击败了李雷。",
    "阿丽雅杀死了李雷。",
    "“我投降！”李雷喊道，阿丽雅站在一旁。",
  ]) assert.equal(violatesNarrativeInvariant(id, source, chineseContext), false, source);
});

test("mechanic failures recognize common outages without treating ordinary infrastructure as the story mechanic", () => {
  const id = "curated-mechanic-unavailable" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "Aria's system crashed.",
    "Aria's system is broken.",
    "Aria's system froze.",
    "Aria's system returned an error.",
    "Aria's system timed out.",
    "Aria's system lost its connection.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), true, source);
  for (const source of [
    "The communication system was unavailable during the storm.",
    "The city's traffic control system malfunctioned.",
    "The control panel was disabled while Aria crossed the bridge.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);

  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  for (const source of [
    "阿丽雅的系统崩溃了。",
    "阿丽雅的系统卡死了。",
    "阿丽雅的系统报错了。",
    "阿丽雅的系统断开连接。",
  ]) assert.equal(violatesNarrativeInvariant(id, source, chineseContext), true, source);
});

test("open-vocabulary actions support common irregular past forms without conflating founded with found", () => {
  for (const [action, object, source] of [
    ["build", "bridge", "Aria built the bridge and secured victory."],
    ["bind", "demon", "Aria bound the demon and secured victory."],
    ["sell", "relic", "Aria sold the relic and secured victory."],
    ["dig", "trench", "Aria dug the trench and secured victory."],
    ["get", "relic", "Aria got the relic and secured victory."],
    ["freeze", "river", "Aria froze the river and secured victory."],
  ] as const) {
    const value: RealizationBinding = { actor: "Aria", action, object, outcome: "victory", requiredSlots: ["actor", "action", "object", "outcome"] };
    assert.equal(realized(source, value), true, source);
  }

  const findSettlement: RealizationBinding = {
    actor: "Aria",
    action: "find",
    object: "settlement",
    outcome: "victory",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  assert.equal(realized("Aria found the settlement and secured victory.", findSettlement), true);
  assert.equal(realized("Aria founded the settlement and secured victory.", findSettlement), false);
});

test("Chinese and English compound objects do not satisfy a shorter direct-object slot", () => {
  assert.equal(realized("阿丽雅打开城门票并取得胜利。", chineseBinding), false);
  for (const source of [
    "Aria opened the gate lock and secured victory.",
    "Aria opened the gate mechanism and secured victory.",
    "Aria opened the gate control panel and secured victory.",
    "The gate mechanism was opened by Aria, securing victory.",
    "The gate control panel was opened by Aria, securing victory.",
  ]) assert.equal(realized(source), false, source);
});

test("opponents mentioned only through portraits and statues are not event participants", () => {
  const conflict: RealizationBinding = {
    actor: "Aria",
    action: "defeat",
    object: "wolf",
    opponent: "Rook",
    outcome: "victory",
    requiredSlots: ["actor", "action", "object", "opponent", "outcome"],
  };
  for (const source of [
    "Facing a portrait of Rook, Aria defeated a wolf and claimed victory.",
    "Facing a statue of Rook, Aria defeated a wolf and claimed victory.",
    "Facing Rook's statue, Aria defeated a wolf and claimed victory.",
  ]) assert.equal(realized(source, conflict, { category: "conflict_outcome", opponentAliases: ["Rook"] }), false, source);
});

test("nonfactual wishes and beliefs cannot repair an unavailable mechanic", () => {
  const id = "curated-mechanic-unavailable" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const continuation of [
    "Aria dreamed that her system activated with a reward.",
    "Aria imagined that her system activated with a reward.",
    "Aria hoped that her system would activate with a reward.",
    "Aria wished her system would activate with a reward.",
    "Aria believed that her system activated with a reward.",
    "Aria thought her system activated with a reward.",
    "Aria pretended that her system activated with a reward.",
  ]) {
    const source = `Aria's system was unavailable. ${continuation}`;
    assert.equal(violatesNarrativeInvariant(id, source, context), true, source);
  }
});

test("nonfactual wishes and beliefs cannot repair a perceived adverse outcome", () => {
  const id = "curated-outcome-weakened" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const continuation of [
    "Aria dreamed that she won victory.",
    "Aria imagined that she won victory.",
    "Aria believed that she won victory.",
    "Aria wished that she would win victory.",
    "Aria pretended that she won victory.",
  ]) {
    const source = `Onlookers thought Aria lost the duel. ${continuation}`;
    assert.equal(violatesNarrativeInvariant(id, source, context), true, source);
  }
});

test("nominalized, hypothetical and nonfinite event descriptions are not realized events", () => {
  for (const source of [
    "Aria opening the gate and securing victory was only a plan.",
    "Aria opening the gate and securing victory was hypothetical.",
    "The proposal was Aria opening the gate and securing victory.",
    "Aria to open the gate and secure victory remained only a proposal.",
    "Aria, opening the gate and securing victory, remained a possibility.",
  ]) assert.equal(realized(source), false, source);

  for (const source of [
    "阿丽雅打开城门并取得胜利的计划被取消。",
    "阿丽雅打开城门并取得胜利只是设想。",
  ]) assert.equal(realized(source, chineseBinding), false, source);
});

test("gendered outcome pronouns require an explicit identity mapping", () => {
  for (const actor of ["Bob", "Alex", "James"] as const) {
    const value: RealizationBinding = {
      actor,
      action: "open",
      object: "gate",
      outcome: "victory",
      requiredSlots: ["actor", "action", "object", "outcome"],
    };
    const source = `${actor} opened the gate and secured her victory.`;
    assert.equal(realized(source, value), false, source);
  }
});

test("adverse-outcome verbs are disambiguated by their event arguments", () => {
  const id = "curated-outcome-weakened" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "Aria lost her key.",
    "Aria lost track of time.",
    "Aria lost herself in thought.",
    "Aria lost patience.",
    "Aria lost sight of Bob.",
    "Aria drew her sword.",
    "Aria drew a map.",
    "Aria drew water from the well.",
    "Aria draws a circle.",
    "Aria lost a coin but won the duel.",
    "Aria gave up smoking.",
    "Aria gave up her seat.",
    "Aria gave up the old key.",
    "Aria surrendered the documents to Bob.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);

  for (const source of [
    "Aria lost the duel.",
    "Aria drew the match.",
    "Aria gave up the goal.",
    "Aria surrendered to Bob.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), true, source);
});

test("ordinary mechanics, abilities and wall panels are not story-system failures", () => {
  const id = "curated-mechanic-unavailable" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "Aria's mechanic was unavailable to repair the car.",
    "Aria called the mechanic, but the mechanic was unavailable.",
    "Aria's ability to sleep was unavailable after coffee.",
    "Aria touched the wall panel; the panel malfunctioned.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);
});

test("adverse outcomes inside novels, stories and plays do not apply to the real protagonist", () => {
  const id = "curated-outcome-weakened" as const;
  assert.equal(
    violatesNarrativeInvariant(id, "Aria read a novel where the protagonist lost the duel.", { protagonistAliases: ["Aria"] }),
    false,
  );
  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  for (const source of [
    "阿丽雅读到一个故事，故事里的主角惨败。",
    "戏中的主角投降了，阿丽雅却赢得决斗。",
  ]) assert.equal(violatesNarrativeInvariant(id, source, chineseContext), false, source);
});

test("the invincibility invariant covers weakening, incapacitation, stalemates and rescue dependence", () => {
  const id = "curated-outcome-weakened" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "Aria was temporarily weakened.",
    "Aria was injured.",
    "Aria was knocked unconscious.",
    "Aria was tied with Bob.",
    "The duel ended in a stalemate for Aria.",
    "Bob rescued Aria.",
    "Aria needed Bob to save her.",
    "Aria's power was sealed.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), true, source);

  for (const source of [
    "Aria weakened Bob.",
    "Aria injured Bob.",
    "Aria knocked Bob unconscious.",
    "Aria rescued Bob.",
    "Bob needed Aria to save him.",
    "Aria sealed Bob's power.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);

  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  for (const source of [
    "阿丽雅暂时被削弱。",
    "阿丽雅受伤倒地。",
    "阿丽雅与李雷打成平手。",
    "李雷救下阿丽雅。",
  ]) assert.equal(violatesNarrativeInvariant(id, source, chineseContext), true, source);
  for (const source of [
    "阿丽雅削弱了李雷。",
    "阿丽雅打伤李雷。",
    "阿丽雅救下李雷。",
    "阿丽雅封印了李雷的力量。",
  ]) assert.equal(violatesNarrativeInvariant(id, source, chineseContext), false, source);
});

test("contrastive not-appositives preserve the actual event subject", () => {
  assert.equal(realized("Aria, not Bob, opened the gate and secured victory."), true);
  assert.equal(realized("Bob, not Aria, opened the gate and secured victory."), false);
});

test("passive voice, harmless parentheticals and negated hesitation remain factual", () => {
  for (const source of [
    "The gate was opened by Aria, securing victory.",
    "Aria, without help, opened the gate and secured victory.",
    "Aria did not hesitate to open the gate and secured victory.",
  ]) assert.equal(realized(source), true, source);
});

test("review: conditions, records and postposed fictional containers are nonfactual", () => {
  for (const source of [
    "Provided Bob agrees, Aria opens the gate and secures victory.",
    "Bob wrote that Aria opened the gate and secured victory.",
    "Aria's diary records that Aria opened the gate and secured victory.",
    "Aria opened the gate and secured victory in a dream.",
    "Aria opened the gate and secured victory only in a simulation.",
    "Aria opened the gate and secured victory in the story Bob wrote.",
  ]) assert.equal(realized(source), false, source);
  for (const source of [
    "在李雷同意的条件下，阿丽雅打开城门并取得胜利。",
    "据李雷回忆，阿丽雅打开城门并取得胜利。",
  ]) assert.equal(realized(source, chineseBinding), false, source);

  const relationship: RealizationBinding = {
    actor: "Aria",
    action: "bowed",
    counterpart: "Bob",
    reciprocalAction: "lowered",
    relationshipChange: "traveled together",
    requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"],
  };
  for (const source of [
    "Aria bowed to Bob. Bob lowered his spear. They traveled together in a dream.",
    "Aria bowed to Bob. Bob lowered his spear. They traveled together only in a simulation.",
    "Aria bowed to Bob. Bob lowered his spear. They traveled together in the story Bob wrote.",
  ]) assert.equal(realized(source, relationship, { category: "relationship", counterpartAliases: ["Bob"] }), false, source);
});

test("review: adverse outcomes distinguish actual defeat from conditions, dreams and denial", () => {
  const id = "curated-outcome-weakened" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "Aria lost to Bob.",
    "Aria surrendered unconditionally.",
    "Bob vanquished Aria.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), true, source);
  for (const source of [
    "If Aria lost to Bob, Bob would celebrate.",
    "Aria dreamed she lost to Bob.",
    "Aria denied she lost to Bob.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);
});

test("review: ordinary systems and nonfactual failures do not violate the mechanic invariant", () => {
  const id = "curated-mechanic-unavailable" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "The heating system broke.",
    "Aria waited for the mechanic, who was unavailable.",
    "Aria dreamed her system crashed.",
    "Aria's system wasn't unavailable.",
    "Aria's system went offline, then came back online.",
    "Aria's immune system malfunctioned.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);
  for (const source of [
    "Aria's system failed to activate.",
    "Aria's system was unable to initialize.",
    "Aria's system could not connect.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), true, source);
  for (const source of [
    "Bob reported that Aria's system was unable to initialize.",
    "Aria dreamed that her system could not connect.",
    "If Aria's system failed to activate, she would repair it.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);
});

test("review: perfect passive events remain realized", () => {
  for (const source of [
    "The gate has been opened by Aria, securing victory.",
    "The gate had been opened by Aria, securing victory.",
  ]) assert.equal(realized(source), true, source);
});

test("review: completion, causal connectors and em-dash contrast remain factual", () => {
  for (const source of [
    "Aria opened the gate, thereby securing victory.",
    "Aria opened the gate and in doing so secured victory.",
    "Aria finished opening the gate and secured victory.",
    "Aria—not Bob—opened the gate and secured victory.",
  ]) assert.equal(realized(source), true, source);
});

test("review: a relationship response must follow the initiating action", () => {
  const relationship: RealizationBinding = {
    actor: "Aria",
    action: "bowed",
    counterpart: "Bob",
    reciprocalAction: "lowered",
    relationshipChange: "traveled together",
    requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"],
  };
  const source = "Bob lowered his spear. Then Aria bowed to Bob, and they traveled together.";
  assert.equal(realized(source, relationship, { category: "relationship", counterpartAliases: ["Bob"] }), false);
});

test("review: victory secured for a foreign beneficiary is not the actor's outcome", () => {
  for (const source of [
    "Aria opened the gate and secured victory for Bob.",
    "Aria opened the gate and secured victory on behalf of Bob.",
    "Aria opened the gate and secured victory for villagers.",
  ]) assert.equal(realized(source), false, source);
});

test("review: inability to defeat an opponent violates the outcome invariant", () => {
  const id = "curated-outcome-weakened" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "Aria failed to defeat Bob.",
    "Aria fails to overcome Bob.",
    "Aria could not defeat Bob.",
    "Aria couldn't win.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), true, source);

  for (const source of [
    "Aria did not fail to defeat Bob.",
    "Bob failed to defeat Aria.",
    "Aria reportedly failed to defeat Bob.",
    "Aria dreamed that she failed to defeat Bob.",
    "If Aria failed to defeat Bob, she would retreat.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);

  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  for (const source of [
    "阿丽雅未能击败鲍勃。",
    "阿丽雅无法战胜鲍勃。",
  ]) assert.equal(violatesNarrativeInvariant(id, source, chineseContext), true, source);
  assert.equal(violatesNarrativeInvariant(id, "阿丽雅并非未能击败鲍勃。", chineseContext), false);
});

test("review: a foreign owner's victory cannot recover the protagonist's perceived loss", () => {
  const source = "Onlookers thought Aria lost the duel. Bob claimed the field. Victory followed.";
  assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", source, { protagonistAliases: ["Aria"] }), true);
});

test("review: long relative clauses do not hide a protagonist mechanic failure", () => {
  const source = "Aria's system, which had guided her through the mountains and catalogued every ancient ruin along the road, was unavailable.";
  assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", source, { protagonistAliases: ["Aria"] }), true);
});

test("mechanic clause ownership survives relatives without absorbing a foreign entity's failure", () => {
  const id = "curated-mechanic-unavailable" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "Aria's system, which Bob repaired, was unavailable.",
    "Aria's system was available, then crashed.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), true, source);
  for (const source of [
    "Aria's system warned her that the bridge was unavailable.",
    "Aria's system guided her while the door was unavailable.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);
});

test("beneficiary and duration phrases preserve the direction of an asserted outcome", () => {
  assert.equal(realized("Aria opened the gate and secured victory for Aria."), true);
  assert.equal(realized("Aria opened the gate and secured victory for the first time."), true);
  assert.equal(realized("Aria opened the gate and secured victory for her people."), false);
});

test("apostrophes and measurement marks do not open narrative quote scope", () => {
  for (const source of [
    "They discussed the '90s. Aria opened the gate and secured victory.",
    "'Twas late. Aria opened the gate and secured victory.",
    'The doorway measured 5" across. Aria opened the gate and secured victory.',
  ]) assert.equal(realized(source), true, source);

  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "They discussed the '90s. Aria lost to Bob.",
    'The doorway measured 5" across. Aria lost to Bob.',
  ]) assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", source, context), true, source);
});

test("conditions, hallucinations, authored stories and postposed reports remain nonactual", () => {
  for (const source of [
    "On condition that Bob agrees, Aria opens the gate and secures victory.",
    "In case Bob agrees, Aria opens the gate and secures victory.",
    "Aria opened the gate and secured victory in her nightmare.",
    "Aria opened the gate and secured victory inside a hallucination.",
    "Aria opened the gate and secured victory in Bob's story.",
    "While dreaming, Aria opened the gate and secured victory.",
    "Aria opened the gate and secured victory, or so Bob claimed.",
  ]) assert.equal(realized(source), false, source);
  assert.equal(realized("阿丽雅在幻境中打开城门并取得胜利。", chineseBinding), false);
  assert.equal(realized("The dream dissolved, and Aria opened the gate and secured victory."), true);
  assert.equal(realized("梦境消散，阿丽雅打开城门并取得胜利。", chineseBinding), true);
});

test("outcome ownership rejects possessive, representative and recipient beneficiaries", () => {
  for (const source of [
    "Aria opened the gate and secured victory on Bob's behalf.",
    "Aria opened the gate and secured victory in Bob's name.",
    "Aria opened the gate, bringing victory to Bob.",
    "Aria opened the gate and secured villagers' victory.",
  ]) assert.equal(realized(source), false, source);
});

test("adverse-outcome variants bind factual defeat to the protagonist only", () => {
  const id = "curated-outcome-weakened" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "Aria lost decisively to Bob.",
    "Aria conceded defeat.",
    "Bob forced Aria to surrender.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), true, source);
  for (const source of [
    "Aria's champion lost to Bob.",
    "Aria's brother lost to Bob.",
    "Bob defeated Aria's champion.",
    "Bob rescued Aria's brother.",
    "Onlookers thought Aria lost the duel. In fact, she never lost.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);

  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  for (const source of [
    "据李雷说，阿丽雅惨败。",
    "阿丽雅在梦里惨败。",
  ]) assert.equal(violatesNarrativeInvariant(id, source, chineseContext), false, source);
});

test("mechanic failures require a factual protagonist-owned failure and entity-local recovery", () => {
  const id = "curated-mechanic-unavailable" as const;
  const context = { protagonistAliases: ["Aria"] };
  for (const source of [
    "Aria's nervous system stopped responding.",
    "Aria's system crashed in a nightmare.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), false, source);
  for (const source of [
    "Aria's system failed to initialize.",
    "Aria's system refused to activate.",
    "Aria's system produced an error.",
    "Aria's system, which had guided her through every cave and answered every question throughout the expedition, stopped responding.",
    "Aria's system, after guiding her reliably through ten campaigns without a single interruption or missed signal, suddenly stopped responding forever.",
    "Aria's system crashed, but Bob worked.",
    "Aria's system crashed, but Bob received a reward.",
    "Aria's system crashed, but the door activated.",
  ]) assert.equal(violatesNarrativeInvariant(id, source, context), true, source);
  assert.equal(violatesNarrativeInvariant(id, "Aria's system crashed, but it came back online.", context), false);
  assert.equal(violatesNarrativeInvariant(id, "Aria's system crashed. It came back online.", context), false);

  const chineseContext = { protagonistAliases: ["阿丽雅"] };
  assert.equal(violatesNarrativeInvariant(id, "据说阿丽雅的系统崩溃了。", chineseContext), false);
  for (const source of [
    "此时阿丽雅的系统崩溃了。",
    "阿丽雅发现自己的系统崩溃了。",
  ]) assert.equal(violatesNarrativeInvariant(id, source, chineseContext), true, source);
});

test("relationship ordering follows before and after semantics rather than surface order", () => {
  const relationship: RealizationBinding = {
    actor: "Aria",
    action: "bowed",
    counterpart: "Bob",
    reciprocalAction: "lowered",
    relationshipChange: "traveled together",
    requiredSlots: ["actor", "action", "counterpart", "reciprocalAction", "relationshipChange"],
  };
  const extras = { category: "relationship" as const, counterpartAliases: ["Bob"] };
  for (const source of [
    "After Aria bowed to Bob, Bob lowered his spear. Then they traveled together.",
    "Before Bob lowered his spear, Aria bowed to Bob. Then they traveled together.",
  ]) assert.equal(realized(source, relationship, extras), true, source);
  for (const source of [
    "Before Aria bowed to Bob, Bob lowered his spear. Then they traveled together.",
    "After Bob lowered his spear, Aria bowed to Bob. Then they traveled together.",
  ]) assert.equal(realized(source, relationship, extras), false, source);
});

test("passive and causal outcome forms preserve actor ownership", () => {
  for (const source of [
    "Aria opened the gate. Victory has been secured by her.",
    "Aria opened the gate. By doing so, she secured victory.",
    "Aria opened the gate and secured victory for herself.",
  ]) assert.equal(realized(source), true, source);
  assert.equal(realized("Aria opened the gate. Victory has been secured by Bob."), false);
});
