import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyNarrativeRealization,
  violatesNarrativeInvariant,
  type NarrativeRealizationInput,
  type RealizationBinding,
} from "../server/readingExperienceModule/narrativeSemantics/index";

const eventBinding: RealizationBinding = {
  actor: "Aria",
  action: "open",
  object: "gate",
  outcome: "victory",
  requiredSlots: ["actor", "action", "object", "outcome"],
};

const chineseEventBinding: RealizationBinding = {
  actor: "阿丽雅",
  action: "打开",
  object: "城门",
  outcome: "胜利",
  requiredSlots: ["actor", "action", "object", "outcome"],
};

function realized(
  source: string,
  binding: RealizationBinding = eventBinding,
  extras: Partial<NarrativeRealizationInput> = {},
): boolean {
  return verifyNarrativeRealization({ source, binding, ...extras }).status === "realized";
}

const outcomeViolated = (source: string): boolean => violatesNarrativeInvariant(
  "curated-outcome-weakened",
  source,
  { protagonistAliases: ["Aria"] },
);

const chineseOutcomeViolated = (source: string): boolean => violatesNarrativeInvariant(
  "curated-outcome-weakened",
  source,
  { protagonistAliases: ["阿丽雅"] },
);

const mechanicViolated = (source: string): boolean => violatesNarrativeInvariant(
  "curated-mechanic-unavailable",
  source,
  { protagonistAliases: ["Aria"] },
);

const chineseMechanicViolated = (source: string): boolean => violatesNarrativeInvariant(
  "curated-mechanic-unavailable",
  source,
  { protagonistAliases: ["阿丽雅"] },
);

test("conditional and attributed clauses cannot become realized event evidence", () => {
  for (const source of [
    "Subject to Bob's approval, Aria opens the gate and secures victory.",
    "In the event that Bob agrees, Aria opens the gate and secures victory.",
    "So long as Bob agrees, Aria opens the gate and secures victory.",
    "Aria opened the gate and secured victory, according to Bob.",
  ]) assert.equal(realized(source), false, source);

  for (const source of [
    "要是李雷同意，阿丽雅就打开城门并取得胜利。",
    "倘使李雷同意，阿丽雅便打开城门并取得胜利。",
    "在李雷同意的前提下，阿丽雅打开城门并取得胜利。",
    "只有李雷同意，阿丽雅才打开城门并取得胜利。",
  ]) assert.equal(realized(source, chineseEventBinding), false, source);

  assert.equal(realized("Bob approved the plan. Aria opened the gate and secured victory."), true);
  assert.equal(realized("According to Bob, the road was clear. Later, Aria opened the gate and secured victory."), true);
});

test("a disguise preserves the real actor instead of installing the assumed identity", () => {
  assert.equal(realized("Bob, disguised as Aria, opened the gate and secured victory."), false);
  assert.equal(realized("Aria, disguised as Bob, opened the gate and secured victory."), true);
});

test("postnominal ownership binds an outcome to its actual beneficiary", () => {
  for (const source of [
    "Aria opened the gate and secured victory awarded to Bob.",
    "Aria opened the gate and secured victory credited to Bob.",
  ]) assert.equal(realized(source), false, source);

  for (const source of [
    "Aria opened the gate and secured victory awarded to Aria.",
    "Aria opened the gate and secured victory credited to Aria.",
  ]) assert.equal(realized(source), true, source);
});

test("common English and Chinese defeat predicates trigger the protagonist outcome invariant", () => {
  for (const source of [
    "Aria was routed by Bob.",
    "Aria was crushed by Bob.",
    "Aria capitulated to Bob.",
    "Aria succumbed to Bob.",
    "Aria failed to win against Bob.",
    "Aria could not win against Bob.",
    "Bob routed Aria.",
  ]) assert.equal(outcomeViolated(source), true, source);

  for (const source of [
    "阿丽雅败给李雷。",
    "阿丽雅被李雷击溃。",
    "阿丽雅未能获胜。",
  ]) assert.equal(chineseOutcomeViolated(source), true, source);

  assert.equal(outcomeViolated("Bob was routed by Aria."), false);
  assert.equal(chineseOutcomeViolated("李雷败给阿丽雅。"), false);
});

test("reported defeat remains nonactual in both languages", () => {
  assert.equal(outcomeViolated("According to Bob, Aria was routed."), false);
  assert.equal(chineseOutcomeViolated("据传阿丽雅败北。"), false);
  assert.equal(chineseOutcomeViolated("此时阿丽雅败北。"), true);
});

test("an actual protagonist victory repairs only a perceived adverse outcome", () => {
  for (const source of [
    "Onlookers thought Aria lost. Then Aria stood victorious.",
    "Onlookers thought Aria lost. The victory belonged to Aria.",
  ]) assert.equal(outcomeViolated(source), false, source);

  for (const source of [
    "Onlookers thought Aria lost. Then Bob stood victorious.",
    "Onlookers thought Aria lost. Bob said Aria stood victorious.",
  ]) assert.equal(outcomeViolated(source), true, source);
});

test("ordinary people and infrastructure are not a protagonist story mechanic", () => {
  for (const source of [
    "Aria's mechanic was unavailable today.",
    "Aria's brake system broke.",
    "Aria's sprinkler system was unavailable.",
  ]) assert.equal(mechanicViolated(source), false, source);

  assert.equal(mechanicViolated("Aria's quest system broke."), true);
  assert.equal(mechanicViolated("Aria's system was unavailable."), true);
});

test("mechanic failures and entity-local recovery include normal operational language", () => {
  for (const source of [
    "Aria's system was unable to initialize.",
    "Aria's system could not initialize.",
    "Aria's system cannot initialize.",
    "Aria's system failed to initialize.",
    "Aria's status panel went blank.",
  ]) assert.equal(mechanicViolated(source), true, source);

  for (const source of [
    "Bob reported that Aria's system was unable to initialize.",
    "In a dream, Aria's system could not initialize.",
    "If Aria's system failed to initialize, she would reboot it.",
    "Aria's system was not unable to initialize.",
  ]) assert.equal(mechanicViolated(source), false, source);

  for (const source of [
    "阿丽雅的系统无法启动。",
    "阿丽雅的系统未能初始化。",
  ]) assert.equal(chineseMechanicViolated(source), true, source);
  for (const source of [
    "据说阿丽雅的系统无法启动。",
    "如果阿丽雅的系统未能初始化，她会重试。",
  ]) assert.equal(chineseMechanicViolated(source), false, source);

  for (const source of [
    "Aria's system crashed, then rebooted.",
    "Aria's system crashed, then restarted.",
    "Aria's system crashed, then returned to service.",
    "Aria's system crashed. It restarted.",
  ]) assert.equal(mechanicViolated(source), false, source);

  for (const source of [
    "阿丽雅的系统崩溃后重启了。",
    "阿丽雅的系统崩溃，随后恢复工作。",
  ]) assert.equal(chineseMechanicViolated(source), false, source);

  assert.equal(mechanicViolated("Aria's system crashed, then Bob's server rebooted."), true);
});

test("an explicit causal result accepts only the protagonist's ownership", () => {
  assert.equal(realized("Aria opened the gate; therefore, the victory belonged to Aria."), true);
  assert.equal(realized("Aria opened the gate; therefore, the victory belonged to Bob."), false);
});
