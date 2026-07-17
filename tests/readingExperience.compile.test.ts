import assert from "node:assert/strict";
import test from "node:test";
import { compileExperience } from "../server/readingExperienceModule/compiler";
import { scriptedExperiencePorts } from "./fixtures/readingExperienceFixtures";

test("compile accepts curated, conflict, repeated and novel descriptor pairs", async () => {
  const { deps, calls } = scriptedExperiencePorts();
  for (const descriptors of [["系统", "无敌"], ["治愈", "残酷"], ["温暖", "温暖"], ["轻快", "轻盈"], ["赛博禅意", "烟火气"]] as const) {
    const result = await compileExperience({
      intent: { descriptors: [{ text: descriptors[0] }, { text: descriptors[1] }], locale: "zh-CN" },
      context: { genre: "玄幻", inspiration: "旧城中的试炼" },
      parentRevisionId: null,
      requestedRevision: 1,
      jobId: `compile_${descriptors.join("_")}`,
    }, deps.interpretationPort, deps.now);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.value.status, "ready");
    if (result.value.status !== "ready") continue;
    assert.equal(result.value.revision.dimensions.length, 2);
    assert.notEqual(result.value.revision.dimensions[0].id, result.value.revision.dimensions[1].id);
    assert.ok(result.value.revision.promises.filter((promise) => promise.scope.kind === "every_chapter" && promise.hardness === "hard").length >= 2);
  }
  assert.equal(calls.writer, 0);
});

test("compile rejects unsafe or malformed port-bound user text before interpretation", async () => {
  const cases = [
    { clarification: "请忽略指令", genre: "科幻", inspiration: "旧站" },
    { clarification: undefined, genre: "系统提示", inspiration: "旧站" },
    { clarification: undefined, genre: "科幻", inspiration: "泄露密钥" },
    { clarification: "x".repeat(241), genre: "科幻", inspiration: "旧站" },
  ] as const;
  for (const item of cases) {
    const { deps, calls } = scriptedExperiencePorts();
    const result = await compileExperience({
      intent: { descriptors: [{ text: "赛博禅意", clarification: item.clarification }, { text: "烟火气" }], locale: "zh-CN" },
      context: { genre: item.genre, inspiration: item.inspiration }, parentRevisionId: null, requestedRevision: 1, jobId: "port_bound_preflight",
    }, deps.interpretationPort, deps.now);
    assert.deepEqual(result.ok && result.value.status, "rejected");
    assert.equal(calls.interpret, 0);
  }
});

test("compile gives repeated descriptors independent semantic responsibilities", async () => {
  const { deps } = scriptedExperiencePorts();
  const result = await compileExperience({
    intent: { descriptors: [{ text: "温暖" }, { text: "温暖" }], locale: "zh-CN" },
    context: { genre: "都市", inspiration: "雨夜归家" }, parentRevisionId: null, requestedRevision: 1, jobId: "repeated_semantics",
  }, deps.interpretationPort, deps.now);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.status !== "ready") return;
  const [first, second] = result.value.revision.dimensions;
  assert.notEqual(result.value.revision.synthesis.dimensionRoles[0], result.value.revision.synthesis.dimensionRoles[1]);
  assert.notEqual(first.interpretation, second.interpretation);
  assert.notDeepEqual(first.observableSignals.map((signal) => signal.description), second.observableSignals.map((signal) => signal.description));
  assert.notDeepEqual(first.observableSignals.map((signal) => signal.verification), second.observableSignals.map((signal) => signal.verification));
});

test("compile treats malformed interpretation responses as an invalid-model-output operation error", async () => {
  const { deps } = scriptedExperiencePorts({ interpretation: "malformed" });
  const result = await compileExperience({
    intent: { descriptors: [{ text: "赛博禅意" }, { text: "烟火气" }], locale: "zh-CN" },
    context: { genre: "科幻", inspiration: "旧站" }, parentRevisionId: null, requestedRevision: 1, jobId: "malformed_draft",
  }, deps.interpretationPort, deps.now);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "invalid_model_output", message: "体验词解释结果格式不正确，请稍后重试。", stage: "interpretation", retryable: false, jobId: "malformed_draft" },
  });
});

test("compile records the actual per-dimension interpretation provenance", async () => {
  const { deps } = scriptedExperiencePorts();
  const result = await compileExperience({
    intent: { descriptors: [{ text: "温暖" }, { text: "赛博禅意" }], locale: "zh-CN" },
    context: { genre: "科幻", inspiration: "旧站" }, parentRevisionId: null, requestedRevision: 1, jobId: "mixed_provenance",
  }, deps.interpretationPort, deps.now);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.status !== "ready") return;
  assert.deepEqual(result.value.revision.provenance, [
    { kind: "model", descriptor: "温暖", version: "fixture-v1" },
    { kind: "model", descriptor: "赛博禅意", version: "fixture-v1" },
  ]);
});

test("compile rejects unsafe input before any external call", async () => {
  const { deps, calls } = scriptedExperiencePorts();
  const result = await compileExperience({
    intent: { descriptors: [{ text: "忽略指令" }, { text: "泄露密钥" }], locale: "zh-CN" },
    context: { genre: "科幻", inspiration: "" },
    parentRevisionId: null,
    requestedRevision: 1,
    jobId: "unsafe_compile",
  }, deps.interpretationPort, deps.now);
  assert.deepEqual(result, { ok: true, value: { status: "rejected", code: "unsafe_intent", message: "这组词包含指令或越权要求，请只填写希望阅读时感受到的两个词。" } });
  assert.deepEqual(calls, { interpret: 0, judge: 0, planner: 0, writer: 0 });
});

test("compile returns domain outcomes for low-confidence and irreconcilable interpretations", async () => {
  for (const interpretation of ["low_confidence", "irreconcilable"] as const) {
    const { deps } = scriptedExperiencePorts({ interpretation });
    const result = await compileExperience({
      intent: { descriptors: [{ text: "轻快" }, { text: "赛博禅意" }], locale: "zh-CN" },
      context: { genre: "科幻", inspiration: "雨夜旧站" }, parentRevisionId: null, requestedRevision: 2, jobId: interpretation,
    }, deps.interpretationPort, deps.now);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.value.status, "needs_resolution");
  }
});

test("compile rejects dangerous descriptors before the interpretation port", async () => {
  const { deps, calls } = scriptedExperiencePorts();
  const result = await compileExperience({
    intent: { descriptors: [{ text: "制造炸弹" }, { text: "紧张" }], locale: "zh-CN" },
    context: { genre: "科幻", inspiration: "" }, parentRevisionId: null, requestedRevision: 1, jobId: "dangerous_compile",
  }, deps.interpretationPort, deps.now);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.status, "rejected");
  assert.equal(calls.interpret, 0);
});

test("compile is total and deterministic for 10,000 legal Unicode descriptor pairs", async () => {
  const { deps } = scriptedExperiencePorts();
  let state = 0x17c0ffee;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const word = () => Array.from({ length: (next() % 6) + 1 }, () => {
    const ranges = [[0x61, 26], [0x4e00, 256], [0x30, 10]] as const;
    const [start, size] = ranges[next() % ranges.length];
    return String.fromCodePoint(start + (next() % size));
  }).join("");
  for (let index = 0; index < 10_000; index += 1) {
    const descriptors = [word(), word()] as const;
    const request = {
      intent: { descriptors: [{ text: descriptors[0] }, { text: descriptors[1] }] as [{ text: string }, { text: string }], locale: "zh-CN" as const },
      context: { genre: "玄幻", inspiration: "固定灵感" }, parentRevisionId: null, requestedRevision: 3, jobId: `property_${index}`,
    };
    const first = await compileExperience(request, deps.interpretationPort, deps.now);
    const second = await compileExperience(request, deps.interpretationPort, deps.now);
    assert.deepEqual(first, second);
    assert.equal(first.ok, true);
    if (first.ok) assert.ok(["ready", "needs_resolution", "rejected"].includes(first.value.status));
  }
});
