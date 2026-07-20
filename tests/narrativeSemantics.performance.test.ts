import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyNarrativeRealization,
  violatesNarrativeInvariant,
  type RealizationBinding,
} from "../server/readingExperienceModule/narrativeSemantics/index";

const SCALE_FACTOR = 4;
const MAX_GROWTH_RATIO = 7;
const TIMER_NOISE_FLOOR_MS = 40;
const ABSOLUTE_LARGE_CASE_BUDGET_MS = 2_000;
const CPU_SAMPLE_BATCH = 8;

function bestCpuMs(iterations: number, operation: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = process.cpuUsage();
    for (let sample = 0; sample < CPU_SAMPLE_BATCH; sample += 1) operation();
    const usage = process.cpuUsage(started);
    best = Math.min(best, (usage.user + usage.system) / 1_000 / CPU_SAMPLE_BATCH);
  }
  return best;
}

function assertSubquadraticScaling(options: {
  label: string;
  smallCount: number;
  makeSource: (count: number) => string;
  run: (source: string) => void;
}): void {
  const largeCount = options.smallCount * SCALE_FACTOR;
  const warmup = options.makeSource(Math.max(4, Math.floor(options.smallCount / 10)));
  const small = options.makeSource(options.smallCount);
  const large = options.makeSource(largeCount);

  options.run(warmup);
  // CPU time measures the algorithm itself and is stable when Node's test
  // runner executes this file beside other CPU-heavy suites. Wall-clock time
  // can otherwise report a false regression merely because this worker was
  // descheduled during both large-case samples.
  const smallMs = bestCpuMs(3, () => options.run(small));
  const largeMs = bestCpuMs(2, () => options.run(large));
  const ratioLimitMs = Math.max(TIMER_NOISE_FLOOR_MS, smallMs * MAX_GROWTH_RATIO);
  const diagnostic = `${options.label}: ${options.smallCount} items=${smallMs.toFixed(2)}ms, ${largeCount} items=${largeMs.toFixed(2)}ms`;

  assert.ok(largeMs <= ratioLimitMs, `${diagnostic}; fourfold input exceeded the ${MAX_GROWTH_RATIO}x growth allowance`);
  assert.ok(largeMs <= ABSOLUTE_LARGE_CASE_BUDGET_MS, `${diagnostic}; large case exceeded ${ABSOLUTE_LARGE_CASE_BUDGET_MS}ms`);
}

test("rejected realization candidates do not trigger quadratic rescanning", () => {
  const binding: RealizationBinding = {
    actor: "Aria",
    action: "open",
    object: "gate",
    outcome: "victory",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  assertSubquadraticScaling({
    label: "rejected realization candidates",
    smallCount: 100,
    makeSource: (count) => Array.from({ length: count }, () => "Aria opened the gate without securing victory.").join(" "),
    run: (source) => {
      assert.equal(verifyNarrativeRealization({ source, binding, category: "outcome" }).status, "not_realized");
    },
  });
});

test("recovered mechanic checks do not rescan every prior mention", () => {
  assertSubquadraticScaling({
    label: "recovered mechanic mentions",
    smallCount: 200,
    makeSource: (count) => Array.from({ length: count }, () => "Aria's system crashed but came back online.").join(" "),
    run: (source) => {
      assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", source, { protagonistAliases: ["Aria"] }), false);
    },
  });
});

test("perceived outcomes with factual recovery do not rescan the remaining story", () => {
  assertSubquadraticScaling({
    label: "recovered perceived outcomes",
    smallCount: 200,
    makeSource: (count) => Array.from({ length: count }, () => "Onlookers thought Aria lost the duel, but in fact she won.").join(" "),
    run: (source) => {
      assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", source, { protagonistAliases: ["Aria"] }), false);
    },
  });
});

test("a single comma-delimited realization sentence does not cross-scan every action and effect", () => {
  const binding: RealizationBinding = {
    actor: "Aria",
    action: "open",
    object: "gate",
    outcome: "victory",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  assertSubquadraticScaling({
    label: "single-sentence action/effect candidates",
    smallCount: 100,
    makeSource: (count) => `${Array.from({ length: count }, () => "Aria opened the gate without securing victory").join(", ")}.`,
    run: (source) => {
      assert.equal(verifyNarrativeRealization({ source, binding, category: "outcome" }).status, "not_realized");
    },
  });
});

test("many mechanic failures can share one final factual recovery without future rescans", () => {
  assertSubquadraticScaling({
    label: "many mechanic failures with a final recovery",
    smallCount: 100,
    makeSource: (count) => `${Array.from({ length: count }, () => "Aria's quest system crashed").join(". ")}. Aria's quest system came back online.`,
    run: (source) => {
      assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", source, { protagonistAliases: ["Aria"] }), false);
    },
  });
});

test("a single long perceived-outcome sentence reuses its factual recovery index", () => {
  assertSubquadraticScaling({
    label: "single-sentence perceived outcomes with a final recovery",
    smallCount: 100,
    makeSource: (count) => `${Array.from({ length: count }, () => "Onlookers thought Aria lost the duel").join(", ")}, but in fact she won.`,
    run: (source) => {
      assert.equal(violatesNarrativeInvariant("curated-outcome-weakened", source, { protagonistAliases: ["Aria"] }), false);
    },
  });
});

test("an unrelated dream word in a long paragraph does not reopen dream-scope scanning", () => {
  assertSubquadraticScaling({
    label: "unrelated dream word with recovered mechanics",
    smallCount: 100,
    makeSource: (count) => `The glossary preserves the unrelated word dream for etymology. ${Array.from({ length: count }, () => "Aria's quest system crashed but came back online.").join(" ")}`,
    run: (source) => {
      assert.equal(violatesNarrativeInvariant("curated-mechanic-unavailable", source, { protagonistAliases: ["Aria"] }), false);
    },
  });
});

test("many first-sentence actions do not cross-scan every second-sentence effect", () => {
  const binding: RealizationBinding = {
    actor: "Aria",
    action: "open",
    object: "gate",
    outcome: "victory",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  assertSubquadraticScaling({
    label: "two-bucket cross-sentence effects",
    smallCount: 40,
    makeSource: (count) => `${Array.from({ length: count }, () => "Aria opened the gate").join(", ")}. ${Array.from({ length: count }, () => "Victory did not come").join(", ")}.`,
    run: (source) => {
      assert.equal(verifyNarrativeRealization({ source, binding, category: "outcome" }).status, "not_realized");
    },
  });
});

test("alternating actions and foreign outcomes reuse the sentence index", () => {
  const binding: RealizationBinding = {
    actor: "Aria",
    action: "open",
    object: "gate",
    outcome: "victory",
    requiredSlots: ["actor", "action", "object", "outcome"],
  };
  assertSubquadraticScaling({
    label: "alternating action and foreign-outcome sentences",
    smallCount: 50,
    makeSource: (count) => Array.from({ length: count }, () => "Aria opened the gate. Bob secured victory.").join(" "),
    run: (source) => {
      assert.equal(verifyNarrativeRealization({ source, binding, category: "outcome" }).status, "not_realized");
    },
  });
});
