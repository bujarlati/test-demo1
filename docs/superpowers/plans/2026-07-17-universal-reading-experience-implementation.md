# 通用阅读体验稳定兑现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任意格式合法的两个阅读体验词确定地编译为“接受、换词或拒绝”，并确保所有 V2 开篇、续章、重写和修史章节只有在当前 Revision 的双维度证据与账本补丁通过后才能发布。

**Architecture:** 新建深模块 `ReadingExperienceModule`，实例只暴露 `compile`、`schedule`、`assess`。`compile` 负责唯一原词理解，`schedule` 从不可变契约、激活记录、账本和正史投影阶段要求，`assess` 内部完成确定性预检、语义裁判、原文落锚并签发发布许可；应用层继续拥有模型路由、Token、流式输出和 CAS 提交事务。

**Tech Stack:** TypeScript 7、Node.js 22、tsx、node:test、Express 5、Zod 4、现有 OpenAI-compatible 模型网关；不增加运行时依赖。

## Global Constraints

- 每个被接受的词对必须编译为两个独立、同等重要、可同时成立的体验维度。
- 每个 V2 发布或重修章节必须有绑定当前 `chapterRevisionId`、`branchId` 和正文哈希的双维度证据；文风与节奏使用多锚点、全章指标和独立语义裁判。
- 安全、提示注入和格式拒绝必须发生在任何外部模型调用前；低置信或不可调和输入不得调用 planner/writer。
- `compile` 之外不得按具体体验词决定行为；只有 `readingExperienceModule/ruleAdapters.ts` 可保存策展词到白名单规则的静态数据映射，并且只有 compiler 可调用它。业务调用方不得出现 `sourceWords.includes(...)`、`word === ...` 或等价分支。
- 策展规则只定义语义不变量和证据政策，不定义正文逐字句式；删除固定开头骨架、固定段落池和第二章专用动作链。
- 本地正文与外部正文使用相同发布门禁；无法取得 `accepted` 许可时失败关闭，不以模板冒充成功。
- planner、writer、extractor/judge 使用故事已选连接及其既定路由；不得静默切换到未授权连接。
- 应用层提交必须比较 `expectedCanonVersion` 与 `ledgerRevision`，并原子写入章节、正史、证据和账本。
- V1 采用惰性迁移；旧章节保持可读且不伪造 V2 证据，新门禁从下一新章或受修订章生效。
- 保留当前工作树中已有模型兼容、预算、长度和叙事修复；不得用 reset/checkout 覆盖既有修改。
- 普通回归不得消耗真实模型 Token；真实评测必须显式指定连接并输出可复验 JSON 报告。

---

## File Structure

| 文件 | 单一职责 |
|---|---|
| `src/types.ts` | V1 兼容类型、V2 持久契约/激活/证据/账本及 Story 引用 |
| `server/readingExperienceModule/types.ts` | 三入口请求、结果、Port、票据和发布许可协议 |
| `server/readingExperienceModule/ruleAdapters.ts` | 策展目录、白名单不变量和证据政策；唯一允许具体词数据的生产文件 |
| `server/readingExperienceModule/compiler.ts` | 输入预检、解释稿校验、重复/近义拆分和冲突合成 |
| `server/readingExperienceModule/scheduler.ts` | blueprint/opening/continuation/rewrite/retcon 的确定性投影与票据 |
| `server/readingExperienceModule/evidence.ts` | 正文哈希、TextAnchor 落地、分布指标和双轴去重 |
| `server/readingExperienceModule/ledger.ts` | 初始账本、补丁、债务、检查点、失效和确定性重放 |
| `server/readingExperienceModule/assessor.ts` | 本地预检、Judge 调用、结果合并和发布许可 |
| `server/readingExperienceModule/index.ts` | `createReadingExperienceModule()`；返回对象只含三入口 |
| `server/readingExperienceModelAdapter.ts` | 把现有模型网关包装成解释与语义裁判 Port |
| `server/chapterPublication.ts` | 验证许可并把章节、证据、账本和正史补丁施加到 Story clone |
| `server/readingExperienceMigration.ts` | 可单测的 V1 惰性迁移和分支激活初始化 |
| `server/openingService.ts` | 编排 V2 开书，但不解释词或自行验收体验 |
| `server/modelGateway.ts` | 供应商协议、planner/writer/正史抽取；消费阶段投影 |
| `server/narrativeEngine.ts` | 通用叙事结构与正史完整性；不再拥有体验词特例 |
| `server/storyService.ts` | 预留章节 ID、创建 Story shell、施加已许可章节 |
| `server/retconService.ts` | 生成修史候选 Revision；发布由统一许可控制 |
| `server/index.ts` | HTTP、作业、Token、锁、CAS 和持久化事务 |
| `server/storage.ts` | JSON 规范化和 V1 可读兼容，不在加载时调用模型 |
| `server/app.ts` | 可注入 Store/模型依赖的 Express app，供 HTTP 事务测试 |
| `tests/fixtures/readingExperienceFixtures.ts` | 版本化解释稿、裁判结果、计数/故障 Port 与章节样本 |
| `tests/readingExperience.compile.test.ts` | compile、安全和 10,000 组 Unicode 性质测试 |
| `tests/readingExperience.schedule.test.ts` | 调度、票据、承诺、债务和 carry |
| `tests/readingExperience.assess.test.ts` | 七类证据策略、落锚、指标和共享因果 |
| `tests/readingExperience.pipeline.test.ts` | 开篇、续章、重写和原子提交 |
| `tests/readingExperience.storage.test.ts` | V1 迁移、分支与 JSON round-trip |
| `tests/readingExperience.retcon.test.ts` | 多 Revision、失效、重放、分支和回滚 |
| `tests/readingExperience.http.test.ts` | 错误码、幂等、stale canon 和失败零污染 |
| `tests/readingExperience.boundary.test.ts` | 三入口覆盖、词面分支和固定骨架静态门禁 |
| `evals/readingExperienceMatrix.ts` | quick/nightly/release/provider-smoke 固定矩阵与阈值 |
| `scripts/checkReadingExperienceBoundary.ts` | 可在 CI 单独运行的架构扫描 |
| `scripts/evaluateReadingExperience.ts` | 通过现有 HTTP API 生成两章并输出评测报告 |
| `tsconfig.tests.json` | 对 tests、scripts 和 evals 做独立严格类型检查 |

### Task 1: 建立 V2 持久类型、测试入口与通用编译器

**Files:**
- Modify: `package.json:6-13`
- Modify: `src/types.ts:250-314,387-424`
- Create: `server/readingExperienceModule/types.ts`
- Create: `server/readingExperienceModule/ruleAdapters.ts`
- Create: `server/readingExperienceModule/compiler.ts`
- Create: `tests/fixtures/readingExperienceFixtures.ts`
- Create: `tests/readingExperience.compile.test.ts`

**Interfaces:**
- Consumes: `CreateStoryInput.tone` 解析出的两个 descriptor、题材、灵感、所选连接的解释 Port。
- Produces: `compileExperience(request, port, now): Promise<ExperienceOperationResult<CompileOutcome>>`；持久化 `CompiledExperienceContractRevision`；完整 module factory 在 Task 3 三个入口齐备后建立。

- [ ] **Step 1: 写编译器失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { compileExperience } from "../server/readingExperienceModule/compiler";
import { scriptedExperiencePorts } from "./fixtures/readingExperienceFixtures";

test("compile accepts curated, conflict, repeated and novel descriptor pairs", async () => {
  const { deps, calls } = scriptedExperiencePorts();
  for (const descriptors of [["系统", "无敌"], ["治愈", "残酷"], ["温暖", "温暖"], ["赛博禅意", "烟火气"]] as const) {
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
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec tsx --test tests/readingExperience.compile.test.ts`

Expected: FAIL，提示 `server/readingExperienceModule/compiler` 或 `scriptedExperiencePorts` 不存在。

- [ ] **Step 3: 定义闭合的持久类型与三入口协议**

在 `src/types.ts` 保留现有 `ReadingExperienceContract` 作为 V1 兼容类型，新增以下持久类型，并先给 `Story` 增加可选 `readingExperienceV2?: ReadingExperienceStateV2`。Task 1–4 不把现有属性改成联合类型，保证旧调用点继续通过严格类型检查；Task 5 的迁移与 Task 6/7 的切流才开始写入 V2 aggregate。

```ts
export type ExperienceCategory = "mechanic" | "protagonist_action" | "conflict_outcome" | "world_reaction" | "relationship" | "pacing" | "voice";
export type EvidencePolicy =
  | { kind: "event_slots"; requiredSlots: Array<"actor" | "action" | "object" | "outcome" | "reaction">; minimumAnchors: number }
  | { kind: "relationship_change"; requireReciprocalAction: true; minimumAnchors: number }
  | { kind: "distribution"; metricIds: string[]; minimumAnchors: number; requireSemanticJudge: true };
export interface ExperienceDimension { id: string; descriptor: string; interpretation: string; categories: ExperienceCategory[]; observableSignals: ObservableSignalV2[]; prohibitions: ExperienceProhibition[]; confidence: number }
export interface ObservableSignalV2 { id: string; dimensionId: string; kind: ExperienceCategory; description: string; semanticSlots?: { actor?: string; action?: string; object?: string; outcome?: string; reaction?: string }; verification: EvidencePolicy; persistence: "none" | "chapter" | "cross_chapter" | "whole_story" }
export interface ExperienceProhibition { id: string; dimensionId: string | "both"; kind: "invariant" | "shortcut" | "style_cliche"; description: string; severity: "block" | "rewrite" | "penalty"; ruleAdapterId?: string }
export interface DeliveryPromiseV2 { id: string; dimensionId: string | "both"; scope: { kind: "chapter"; chapterNumber: number } | { kind: "every_chapter" } | { kind: "rolling_window"; chapters: number; minimumDeliveries: number } | { kind: "every_arc" } | { kind: "whole_story" }; hardness: "hard" | "soft"; minimumSignals: number; carryRuleIds: string[]; compensationWindow?: number }
export interface CompiledExperienceContractRevision { id: string; schemaVersion: 2; revision: number; parentRevisionId: string | null; intent: ReadingExperienceIntent; dimensions: [ExperienceDimension, ExperienceDimension]; synthesis: { sharedCause: string; dimensionRoles: [string, string] }; promises: DeliveryPromiseV2[]; prohibitions: ExperienceProhibition[]; ruleGraphVersion: string; provenance: Array<{ kind: "curated" | "model" | "migration"; descriptor: string; version: string }>; createdAt: string }
export interface ExperienceContractActivation { id: string; contractRevisionId: string; branchId: string; effectiveFromChapter: number; effectiveFromCanonVersion: number; effectiveThroughCanonVersion: number | null; activatedAt: string }
export interface ReadingExperienceStateV2 { schemaVersion: 2; activeActivationId: string; contractRevisions: CompiledExperienceContractRevision[]; activations: ExperienceContractActivation[]; ledgers: ExperienceLedgerV2[]; evidence: ExperienceEvidenceV2[]; checkpoints: ExperienceLedgerCheckpoint[]; compilerVersion: string; evaluatorVersion: string }
```

在 `server/readingExperienceModule/types.ts` 定义设计文档中的 `CompileExperienceRequest`、`CompileOutcome`、`ScheduleExperienceRequest`、`ExperienceStagePlan`、`AssessExperienceRequest`、`ExperienceAssessment`、`ExperienceOperationResult<T>`、`ExperienceInterpretationPort`、`ExperienceSemanticJudgePort`；实例接口必须严格为：

```ts
export interface ReadingExperienceModule {
  compile(request: CompileExperienceRequest): Promise<ExperienceOperationResult<CompileOutcome>>;
  schedule(request: ScheduleExperienceRequest): ExperienceStagePlan;
  assess(request: AssessExperienceRequest): Promise<ExperienceOperationResult<ExperienceAssessment>>;
}
```

- [ ] **Step 4: 实现预检、目录适配、解释稿编译与双维度合成**

`compiler.ts` 使用 `normalize("NFKC")`、Unicode 字母/数字规则和本地注入/危险规则先决策；目录未覆盖时才调用 `ExperienceInterpretationPort`。重复词把第二维拆为不同类别/证据政策，冲突词要求解释 Port 返回同一 `sharedCause` 的两个角色。核心决策代码固定为：

```ts
export async function compileExperience(request: CompileExperienceRequest, port: ExperienceInterpretationPort, now: () => Date): Promise<ExperienceOperationResult<CompileOutcome>> {
  const preflight = preflightIntent(request.intent);
  if (!preflight.ok) return { ok: true, value: preflight.outcome };
  const draft = await interpretationDraft(preflight.intent, request.context, port);
  if (!draft.ok) return draft;
  const validation = validateInterpretationDraft(draft.value, preflight.intent);
  if (!validation.ok) return { ok: true, value: validation.outcome };
  const dimensions = splitAndNormalizeDimensions(validation.dimensions, preflight.intent);
  const synthesis = solveSynthesis(dimensions, validation.synthesis);
  if (!synthesis.ok) return { ok: true, value: { status: "needs_resolution", code: "irreconcilable_intent", message: synthesis.message } };
  return { ok: true, value: { status: "ready", revision: freezeContractRevision(request, preflight.intent, dimensions, synthesis.value, now()) } };
}
```

- [ ] **Step 5: 扩展数据驱动测试并让全量测试发现新文件**

加入 `治愈·残酷`、`温暖·温暖`、`轻快·轻盈`、`赛博禅意·烟火气`、低置信、不可调和、提示注入和危险内容 fixture；用固定种子生成 10,000 组 1–6 个 Unicode 字母/数字，断言无崩溃、同输入同结果且状态只为三种。把 `package.json` 改为：

```json
"test": "tsx --test \"tests/*.test.ts\""
```

Run: `pnpm test`

Expected: 新编译测试与原 125 项全部 PASS。

- [ ] **Step 6: Commit**

```powershell
git add package.json src/types.ts server/readingExperienceModule tests/fixtures/readingExperienceFixtures.ts tests/readingExperience.compile.test.ts
git commit -m "feat: add V2 reading experience compiler"
```

### Task 2: 实现确定性调度、签名票据和体验账本 reducer

**Files:**
- Modify: `src/types.ts`
- Modify: `server/readingExperienceModule/types.ts`
- Create: `server/readingExperienceModule/scheduler.ts`
- Create: `server/readingExperienceModule/ledger.ts`
- Create: `tests/readingExperience.schedule.test.ts`

**Interfaces:**
- Consumes: `CompiledExperienceContractRevision`、`ExperienceContractActivation`、当前分支正史视图和账本。
- Produces: `schedule(request): ExperienceStagePlan`；`applyExperienceLedgerPatch(ledger, patch): ExperienceLedgerV2`。

- [ ] **Step 1: 写阶段与票据失败测试**

```ts
test("schedule binds stage, contract, branch, canon, ledger and attempt", () => {
  const deps = scriptedExperiencePorts().deps;
  const plan = scheduleExperience(openingScheduleRequest({ chapterNumber: 2, canonVersion: 7, ledgerRevision: 3 }), deps.scheduler);
  assert.equal(plan.stage, "continuation");
  assert.equal(plan.ticket.expectedCanonVersion, 7);
  assert.equal(plan.ticket.ledgerRevision, 3);
  assert.equal(plan.ticket.attempt, 1);
  assert.equal(plan.duePromiseIds.length >= 2, true);
  assert.equal(plan.promptProjection.dimensions.length, 2);
});

test("hard presence cannot become debt while soft rolling promises can", () => {
  const scheduled = scheduleFixtureWithDebt({ chapterNumber: 4, priorDeliveries: [1], compensationWindow: 2 });
  assert.equal(scheduled.hardPresencePromiseIds.length, 2);
  assert.deepEqual(scheduled.newDebts.map((debt) => debt.dueByChapter), [5]);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec tsx --test tests/readingExperience.schedule.test.ts`

Expected: FAIL，提示 scheduler/ledger 类型或函数不存在。

- [ ] **Step 3: 实现 HMAC 票据与阶段投影**

票据签名输入按固定字段排序，避免对象属性顺序影响结果：

```ts
function signTicket(unsigned: Omit<ExperienceStageTicket, "signature">, secret: string): string {
  const payload = [unsigned.id, unsigned.contractRevisionId, unsigned.activationId, unsigned.ledgerRevision, unsigned.branchId, unsigned.expectedCanonVersion, unsigned.ruleGraphVersion, unsigned.stage, unsigned.artifactKind, unsigned.jobId, unsigned.attempt, unsigned.expiresAt].join("\u001f");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function scheduleExperience(request: ScheduleExperienceRequest, deps: SchedulerDependencies): ExperienceStagePlan {
  assertActivationMatches(request.contract, request.activation, request.ledger, request.canon);
  const due = duePromises(request.contract.promises, request.ledger, request.chapterNumber);
  const selectedSignals = selectSignalsForStage(request.contract.dimensions, request.ledger, request.stage, due);
  const unsigned = createUnsignedTicket(request, deps.now(), deps.ticketTtlMs);
  return {
    stage: request.stage,
    artifactKind: request.artifactKind,
    promptProjection: projectPrompt(request, selectedSignals, due),
    evidenceSchema: selectedSignals.map((signal) => signal.verification),
    duePromiseIds: due.map((promise) => promise.id),
    ticket: { ...unsigned, signature: signTicket(unsigned, deps.ticketSecret) },
  };
}
```

开篇、续章、重写、蓝图和修史都调用同一选择器；`voice/pacing` 每章选择 `distribution`，机制/关系的跨章状态只能引用 `canon.factReferences`，不得由账本虚构事实。

- [ ] **Step 4: 实现账本补丁与边界测试**

`ExperienceLedgerV2` 按维度保存 `lastDeliveredChapter`、`deliveredSignalIds`、`persistentResults`、`debts`，按 promise 保存滚动窗口计数；补丁带 `expectedRevision` 和 `nextRevision`。覆盖 N-1/N/N+1、契约中途生效、hard 不转债、soft 到期、跨分支和旧 canon 票据。

Run: `pnpm exec tsx --test tests/readingExperience.schedule.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/types.ts server/readingExperienceModule tests/readingExperience.schedule.test.ts
git commit -m "feat: schedule V2 experience promises"
```

### Task 3: 实现类别化证据、语义裁判和发布许可

**Files:**
- Modify: `src/types.ts`
- Modify: `server/readingExperienceModule/types.ts`
- Create: `server/readingExperienceModule/evidence.ts`
- Create: `server/readingExperienceModule/assessor.ts`
- Create: `server/readingExperienceModule/index.ts`
- Create: `tests/readingExperience.assess.test.ts`

**Interfaces:**
- Consumes: 签名 `ExperienceStagePlan` 与 blueprint/chapter/retcon artifact；按需调用 `ExperienceSemanticJudgePort`。
- Produces: blueprint accepted hash，或 chapter/retcon 的 `ExperiencePublicationPermit`、`ExperienceEvidenceV2[]` 与 `ExperienceLedgerPatch`。

- [ ] **Step 1: 写七类证据与失败关闭测试**

```ts
test("voice and pacing require distributed anchors and metrics", async () => {
  const { module, request } = assessedChapterFixture({ pair: ["冷冽", "明快"], anchorRegions: ["opening", "middle", "ending"] });
  const result = await module.assess(request);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.status !== "accepted" || result.value.artifactKind !== "chapter") return;
  assert.equal(result.value.evidence.every((item) => item.anchors.length >= 3), true);
  assert.equal(result.value.evidence.every((item) => Object.keys(item.observation.distributionMetrics ?? {}).length > 0), true);
});

test("a fabricated judge quote never becomes evidence", async () => {
  const { module, request } = assessedChapterFixture({ judgeQuote: "正文中根本不存在的句子" });
  const result = await module.assess(request);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "rewrite");
  assert.ok(result.value.failedRuleIds.includes("evidence.anchor_not_grounded"));
});
```

再用表驱动测试覆盖机制、主角行动、冲突结果、世界反应、关系、节奏、文风，以及否定、计划、尝试失败、梦境、模拟、预测、他人代做、标签粘贴和同句重复计轴。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec tsx --test tests/readingExperience.assess.test.ts`

Expected: FAIL，提示 assessor/evidence 不存在。

- [ ] **Step 3: 实现原文落锚、分布指标和确定性预检**

`evidence.ts` 统一计算标题加正文的 SHA-256；TextAnchor 必须逐字匹配 `[start,end)`。文风/节奏至少覆盖前、中、后三个区域；关系必须出现双方行动、回应和关系/选择变化。核心落锚函数：

```ts
export function groundClaim(source: string, claim: SemanticEvidenceClaim): GroundedClaim | EvidenceFinding {
  const anchors = claim.anchors.map((anchor) => ({ ...anchor, quote: source.slice(anchor.start, anchor.end) }));
  if (anchors.some((anchor, index) => anchor.quote !== claim.anchors[index].quote)) {
    return { ruleId: "evidence.anchor_not_grounded", severity: "rewrite", dimensionId: claim.dimensionId };
  }
  if (!anchorsInRequiredRegions(source, anchors, claim.policy)) {
    return { ruleId: "evidence.distribution_insufficient", severity: "rewrite", dimensionId: claim.dimensionId };
  }
  return { ...claim, anchors };
}
```

把现有系统可用性、主角胜负等可靠正则迁入 `ruleAdapters.ts`，通过 `ruleAdapterId` 运行；assessor 不读取 descriptor。

- [ ] **Step 4: 实现 assess 内部 Port 流程与许可**

```ts
export async function assessExperience(request: AssessExperienceRequest, deps: AssessorDependencies): Promise<ExperienceOperationResult<ExperienceAssessment>> {
  const ticket = verifyPlanTicket(request.plan, deps.ticketSecret, deps.now());
  if (!ticket.ok) return { ok: true, value: rejectedAssessment(request, ticket.ruleId) };
  const artifactHash = hashArtifact(request.artifact);
  const deterministic = runDeterministicChecks(request.plan, request.artifact);
  if (deterministic.blocking.length > 0) return { ok: true, value: rewriteAssessment(request, deterministic.blocking, deps) };
  if (request.artifact.kind === "blueprint") return { ok: true, value: { status: "accepted", artifactKind: "blueprint", artifactHash } };
  const judged = await deps.semanticJudgePort.judge(buildSemanticCase(request.plan, request.artifact, deterministic.metrics));
  if (!judged.ok) return judged;
  const grounded = groundAndValidateVerdict(request, judged.value, artifactHash);
  if (!grounded.ok) return { ok: true, value: rewriteAssessment(request, grounded.findings, deps) };
  return { ok: true, value: acceptedChapterAssessment(request, grounded.evidence, artifactHash) };
}
```

`index.ts` 在三个实现都可用后一次性建立真实工厂，不保留未实现入口：

```ts
export function createReadingExperienceModule(deps: ReadingExperienceModuleDependencies): ReadingExperienceModule {
  return Object.freeze({
    compile: (request) => compileExperience(request, deps.interpretationPort, deps.now),
    schedule: (request) => scheduleExperience(request, { ticketSecret: deps.ticketSecret, ticketTtlMs: deps.ticketTtlMs, now: deps.now }),
    assess: (request) => assessExperience(request, { ticketSecret: deps.ticketSecret, semanticJudgePort: deps.semanticJudgePort, now: deps.now }),
  });
}
```

Judge 超时、429、畸形 JSON 和冲突结果返回稳定 `model_unavailable/invalid_model_output`，不得 accepted。运行测试与旧门禁回归：

Run: `pnpm exec tsx --test tests/readingExperience.assess.test.ts`

Run: `pnpm exec tsx --test --test-name-pattern "reading-experience|model-refined|actual realized" tests/narrative.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/types.ts server/readingExperienceModule tests/readingExperience.assess.test.ts
git commit -m "feat: assess category-specific experience evidence"
```

### Task 4: 接入 provider-neutral 解释与裁判 Adapter

**Files:**
- Create: `server/readingExperienceModelAdapter.ts`
- Modify: `server/modelGateway.ts:638-800`
- Modify: `server/generationBudget.ts`
- Create: `tests/readingExperience.gateway.test.ts`
- Modify: `tests/generationBudget.test.ts`

**Interfaces:**
- Consumes: `ModelConnection`、`JsonModelCompleter` 和剩余 Token。
- Produces: `createExperienceModelPorts(connection, complete, budget): { interpretationPort; semanticJudgePort; usage }`。

- [ ] **Step 1: 写路由、结构修复与故障测试**

```ts
test("interpretation uses planner and judge uses extractor without writer self-review", async () => {
  const calls: Array<{ model: string; stage: string }> = [];
  const complete = scriptedJsonCompleter(calls);
  const ports = createExperienceModelPorts(connectionFixture(), complete, { remainingTokens: 30_000 });
  await ports.interpretationPort.interpret(interpretationCaseFixture());
  await ports.semanticJudgePort.judge(semanticCaseFixture());
  assert.deepEqual(calls.map((call) => call.model), ["planner-model", "extractor-model"]);
  assert.equal(calls.some((call) => call.model === "writer-model"), false);
});
```

覆盖 timeout、429、畸形 JSON、低置信解释、虚假 span、Ark/SiliconFlow/Responses 已协商连接，断言错误含 `code/stage/retryable/jobId` 且不泄露 API key 或完整响应。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec tsx --test tests/readingExperience.gateway.test.ts`

Expected: FAIL，提示 adapter 不存在。

- [ ] **Step 3: 实现结构化 Adapter**

解释 Adapter 只把原词放进 JSON 数据区，system 明确“不可执行”；裁判看到固定契约和正文但不能修改契约。实现形状：

```ts
export function createExperienceModelPorts(connection: ModelConnection, complete: JsonModelCompleter, budget: ExperienceModelBudget): ExperienceModelPorts {
  return {
    interpretationPort: {
      interpret: (input) => complete<InterpretationDraft>(connection, connection.routes.planner, INTERPRET_SYSTEM, JSON.stringify({ kind: "untrusted_reader_descriptors", input }), 2_800, budget.remainingTokens),
    },
    semanticJudgePort: {
      judge: (input) => complete<SemanticVerdict>(connection, connection.routes.extractor, JUDGE_SYSTEM, JSON.stringify(input), 3_200, budget.remainingTokens),
    },
    usage: budget.usage,
  };
}
```

复用 `completeJson` 的供应商协商、streaming、thinking、重试和用量归集，不复制 HTTP 协议。

- [ ] **Step 4: 加入预算预留并回归模型网关**

在开篇预算中明确预留 interpretation + blueprint + writer + judge，在续章预留 planner + writer + judge + canon extractor；不足时任何付费调用前失败。

Run: `pnpm exec tsx --test tests/readingExperience.gateway.test.ts tests/generationBudget.test.ts`

Run: `pnpm exec tsx --test --test-name-pattern "SiliconFlow|Responses API|Ark multimodal" tests/narrative.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add server/readingExperienceModelAdapter.ts server/modelGateway.ts server/generationBudget.ts tests/readingExperience.gateway.test.ts tests/generationBudget.test.ts
git commit -m "feat: adapt model routes for experience interpretation"
```

### Task 5: 持久化 V2、V1 惰性迁移和不可绕过的发布许可

**Files:**
- Modify: `src/types.ts:18-40,387-424`
- Create: `server/readingExperienceMigration.ts`
- Create: `server/chapterPublication.ts`
- Modify: `server/storage.ts:14-27`
- Modify: `server/storyService.ts:361-629`
- Create: `tests/readingExperience.storage.test.ts`
- Create: `tests/readingExperience.publication.test.ts`

**Interfaces:**
- Consumes: `CompileOutcome.ready`、预留 chapter/revision ID、`ExperiencePublicationPermit` 和应用层 expected versions。
- Produces: `prepareExperienceMigration()`、`createV2ExperienceState()`、`commitAcceptedChapter()`。

- [ ] **Step 1: 写迁移、round-trip 与缺许可零变更测试**

```ts
test("commit without a current publication permit leaves the story byte-identical", () => {
  const story = v2StoryFixture();
  const before = JSON.stringify(story);
  assert.throws(() => commitAcceptedChapter(story, chapterCandidateFixture(), undefined), /发布许可/);
  assert.equal(JSON.stringify(story), before);
});

test("V1 migration starts enforcement at the next chapter without inventing history", async () => {
  const migrated = await prepareExperienceMigration(v1StoryFixture(), migrationModuleFixture());
  assert.equal(migrated.status, "ready");
  if (migrated.status !== "ready") return;
  assert.equal(migrated.state.activations[0].effectiveFromChapter, migrated.story.chapters.length + 1);
  assert.deepEqual(migrated.state.evidence, []);
});
```

覆盖正文哈希、revisionId、contractRevisionId、activationId、ledgerRevision、canonVersion 任一不匹配均拒绝；分支 fork 隔离账本；JSON round-trip 不丢 evidence/checkpoint。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec tsx --test tests/readingExperience.storage.test.ts tests/readingExperience.publication.test.ts`

Expected: FAIL，提示 migration/publication 模块不存在。

- [ ] **Step 3: 实现迁移纯函数和 V2 aggregate**

`normalizeStore` 只补齐 V1 可读结构，不调用模型。`prepareExperienceMigration` 在续章/修史作业内调用 `compile`，并明确区分 `legacyOriginEffectiveFrom` 与 `enforcementEffectiveFrom`。新 Story 从已编译 revision 创建 activation 和 revision-0 ledger。

`ChapterRevision` 新增：

```ts
experienceAssessment?: {
  contractRevisionId: string;
  activationId: string;
  ledgerRevision: number;
  artifactHash: string;
  evidenceIds: string[];
  evaluatorVersion: string;
};
```

- [ ] **Step 4: 实现许可校验和原子 Story clone patch**

```ts
export function commitAcceptedChapter(story: Story, candidate: ReservedChapterCandidate, permit: ExperiencePublicationPermit): Chapter {
  assertPermitMatchesCandidate(story, candidate, permit);
  const next = structuredClone(story);
  appendChapterAndCanon(next, candidate);
  applyExperienceLedgerPatch(activeLedger(next), permit.ledgerPatch);
  if (!next.readingExperienceV2) throw new Error("故事缺少 V2 阅读体验状态。");
  next.readingExperienceV2.evidence.push(...permit.evidence);
  bindAssessmentToRevision(next, candidate.revisionId, permit);
  assertStoryStateIntegrity(next);
  Object.assign(story, next);
  return story.chapters.find((chapter) => chapter.id === candidate.chapterId)!;
}
```

持久化失败仍由 `server/index.ts` 把 store 引用恢复为原 clone。运行：

Run: `pnpm exec tsx --test tests/readingExperience.storage.test.ts tests/readingExperience.publication.test.ts`

Run: `pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/types.ts server/readingExperienceMigration.ts server/chapterPublication.ts server/storage.ts server/storyService.ts tests/readingExperience.storage.test.ts tests/readingExperience.publication.test.ts
git commit -m "feat: persist V2 experience publication permits"
```

### Task 6: 把开书与第一章切到 compile/schedule/assess

**Files:**
- Modify: `server/index.ts:332-483`
- Modify: `server/openingService.ts:29-263`
- Modify: `server/modelGateway.ts:1032-1869`
- Modify: `server/storyService.ts:257-548`
- Modify: `tests/narrative.test.ts:498-1647`
- Create: `tests/readingExperience.pipeline.test.ts`

**Interfaces:**
- Consumes: Task 1–5 的 module、model ports、Story shell、阶段计划与许可。
- Produces: 只有完整 V2 契约/激活/第一章证据/账本/正史同时就绪的 Story。

- [ ] **Step 1: 写开书调用顺序与失败零调用测试**

```ts
test("V2 opening follows compile, blueprint schedule/assess, opening schedule/assess", async () => {
  const trace: string[] = [];
  const story = await createStoryWithOpening(openingInputFixture(), "user_1", connectionFixture(), openingRuntimeFixture(trace));
  assert.deepEqual(trace, ["compile", "schedule:blueprint", "planner", "assess:blueprint", "schedule:opening", "writer", "assess:chapter", "canon-extractor", "commit"]);
  assert.equal(story.readingExperienceV2?.schemaVersion, 2);
  assert.equal(story.readingExperienceV2?.evidence.length, 2);
});

test("non-ready compile spends no planner or writer tokens", async () => {
  const runtime = openingRuntimeFixture([], { compileStatus: "needs_resolution" });
  await assert.rejects(() => createStoryWithOpening(openingInputFixture(), "user_1", connectionFixture(), runtime), /换一组/);
  assert.deepEqual(runtime.calls, { interpret: 1, planner: 0, writer: 0, judge: 0 });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec tsx --test --test-name-pattern "V2 opening|non-ready compile" tests/readingExperience.pipeline.test.ts`

Expected: FAIL，当前开篇仍创建 V1 契约并由 planner 修改它。

- [ ] **Step 3: 重构开篇编排与提示投影**

`index.ts` 在创建作业后先构造 connection-scoped module；`openingService.ts` 预留 story/branch/chapter/revision ID，编译 revision，创建 activation/ledger，按顺序调度并验收 blueprint 和 chapter。`modelGateway.ts` 的 planner/writer 只接收：

```ts
export interface OpeningGenerationContextV2 {
  input: CreateStoryInput;
  blueprintPlan: ExperienceStagePlan;
  openingPlan: ExperienceStagePlan;
  reserved: { storyId: string; branchId: string; chapterId: string; revisionId: string; canonVersion: 1 };
  targetChapterCount: number;
}
```

删除 planner 对契约的改写、`sourceWords.includes` 分支、固定三句骨架和以 literal evidence anchors 强迫逐字写作；writer prompt 使用 `openingPlan.promptProjection` 的语义信号、窗口和禁忌。

- [ ] **Step 4: 许可后原子创建并回归旧能力**

第一章正文先 `assess`，正史 extractor 只抽事件/人物/物品；随后把 Story、Chapter Revision、Contract、Activation、Evidence、Ledger、Canon 一次交给外层持久事务。覆盖机制、关系、voice、pacing 四类 fixture；保留既有字数、安全、JSON 修复、Token 用量、Ark/SiliconFlow 路由测试。

Run: `pnpm exec tsx --test tests/readingExperience.pipeline.test.ts`

Run: `pnpm exec tsx --test --test-name-pattern "opening generation|story creation publishes" tests/narrative.test.ts`

Run: `pnpm build`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add server/index.ts server/openingService.ts server/modelGateway.ts server/storyService.ts tests/narrative.test.ts tests/readingExperience.pipeline.test.ts
git commit -m "feat: gate story openings with V2 experience"
```

### Task 7: 把续章、流式正文和自动重写切到统一计划

**Files:**
- Modify: `server/index.ts:502-895`
- Modify: `server/modelGateway.ts:1872-2355`
- Modify: `server/narrativeEngine.ts:1351-1947`
- Modify: `server/storyService.ts:551-629`
- Modify: `tests/readingExperience.pipeline.test.ts`
- Modify: `tests/narrative.test.ts:2999-3230,3384-4821`

**Interfaces:**
- Consumes: 活动 V2 contract/activation/ledger 和 `schedule(continuation|rewrite)`。
- Produces: 一个候选、writer、assessor 共享绑定版本的计划；只把 accepted permit 交给提交函数。

- [ ] **Step 1: 写续章、重写与失败零污染测试**

```ts
test("continuation shares one ticket and rewrites only failed rules", async () => {
  const runtime = continuationRuntimeFixture({ firstAssessment: { status: "rewrite", failedRuleIds: ["dimension.secondary.distribution"] } });
  const result = await generateChapterForTest(v2StoryFixture(), runtime);
  assert.equal(result.chapter.number, 2);
  assert.equal(runtime.plannerTickets[0], runtime.writerTickets[0]);
  assert.deepEqual(runtime.rewriteRequests[0].failedRuleIds, ["dimension.secondary.distribution"]);
});

test("two failed assessments publish nothing", async () => {
  const story = v2StoryFixture();
  const before = JSON.stringify(story);
  await assert.rejects(() => generateChapterForTest(story, continuationRuntimeFixture({ alwaysRewrite: true })), /delivery_unsatisfied/);
  assert.equal(JSON.stringify(story), before);
});
```

覆盖第二章从账本/carry 沿用机制和关系状态，voice/pacing 重新取得本章分布证据；本地和外部正文都必须许可；旧票据、并行 stale、响应丢失重试不重复记证据。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec tsx --test --test-name-pattern "continuation|failed assessments" tests/readingExperience.pipeline.test.ts`

Expected: FAIL，当前续章使用 V1 prompt、通用失败文案并允许本地旁路。

- [ ] **Step 3: 统一候选、writer 和 assess 数据流**

在 `generateChapter` clone 后、任何 planner 调用前完成 V1 惰性迁移并只计算一次 continuation plan。`generateCandidateDraftsWithConnection`、`planNextChapter`、`buildChapterPrompt`、非流式和流式 writer 都接收 `ExperienceStagePlan`，不读取 contract 原词。正史 extractor 与体验 judge 分开调用。

重写循环改成：

```ts
for (let attempt = 1; attempt <= 2; attempt += 1) {
  const plan = experience.schedule({ ...baseSchedule, stage: attempt === 1 ? "continuation" : "rewrite", failedRuleIds, attempt });
  const generated = await writeWithPlan(plan);
  const assessment = await experience.assess({ plan, artifact: reservedChapterArtifact(generated) });
  if (!assessment.ok) throw experienceInfrastructureError(assessment.error);
  if (assessment.value.status === "accepted" && assessment.value.artifactKind === "chapter") return commitWithPermit(assessment.value);
  if (assessment.value.status === "rejected") throw deliveryRejected(assessment.value);
  failedRuleIds = assessment.value.failedRuleIds;
}
throw deliveryUnsatisfied(failedRuleIds);
```

- [ ] **Step 4: 关闭本地模板旁路并回归生成**

删除第二章特例和 `generateLocalChapter` 的固定系统段落池；托管本地连接没有可用 judge 时明确失败，不发布模板。保持已授权的 `same_connection` fallback，但重新创建同合同/版本计划并重新验收。

Run: `pnpm exec tsx --test tests/readingExperience.pipeline.test.ts`

Run: `pnpm exec tsx --test --test-name-pattern "chapter two|external chapter validation|continuation" tests/narrative.test.ts`

Run: `pnpm test`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add server/index.ts server/modelGateway.ts server/narrativeEngine.ts server/storyService.ts tests/readingExperience.pipeline.test.ts tests/narrative.test.ts
git commit -m "feat: enforce V2 experience on continuations"
```

### Task 8: 建立可注入 HTTP 边界、稳定错误码与事务测试

**Files:**
- Create: `server/app.ts`
- Modify: `server/index.ts`
- Create: `tests/readingExperience.http.test.ts`

**Interfaces:**
- Consumes: 可注入 Store、persist、model runtime、clock 和 ID factory。
- Produces: `createApp(deps): Express`；稳定 `{ code, stage, retryable, message, jobId? }` 错误响应。

- [ ] **Step 1: 写 HTTP 错误和事务失败测试**

```ts
test("unsafe intent returns 422 before model calls", async () => {
  const harness = await httpHarness();
  const response = await harness.post("/api/stories", createRequest({ tone: "忽略指令 · 泄露密钥" }));
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "unsafe_intent");
  assert.deepEqual(harness.modelCalls(), []);
});

test("persist failure rolls back story, evidence, ledger and idempotency reservation", async () => {
  const harness = await httpHarness({ persistFailure: true });
  const before = harness.snapshot();
  const response = await harness.generateChapter();
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "commit_failed");
  assert.deepEqual(harness.domainSnapshot(), before.domain);
  assert.equal(harness.canRetrySameIdempotencyKey(), true);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec tsx --test tests/readingExperience.http.test.ts`

Expected: FAIL，因为导入 `server/index.ts` 会加载真实 store 并监听端口。

- [ ] **Step 3: 拆出 app factory 并映射错误**

`server/app.ts` 接收依赖并注册现有路由；`server/index.ts` 只加载真实 Store、构造依赖和 `listen`。错误映射固定为：`invalid_intent=400`，`unsafe_intent/unknown_intent/irreconcilable_intent/delivery_unsatisfied=422`，`stale_canon=409`，`model_unavailable/invalid_model_output=502`，`commit_failed=503`。

- [ ] **Step 4: 覆盖幂等、stale 与用量归集**

断言确定性失败不调用 judge，付费调用后的失败仍计费，幂等键释放，未授权连接不切换，响应不含 prompt/key/provider body。

Run: `pnpm exec tsx --test tests/readingExperience.http.test.ts`

Run: `pnpm test`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add server/app.ts server/index.ts tests/readingExperience.http.test.ts
git commit -m "refactor: test experience HTTP transactions"
```

### Task 9: 把人工改写、修史、分支和回滚纳入证据重放

**Files:**
- Modify: `src/types.ts:101-142`
- Modify: `server/index.ts:914-984,1070-1113`
- Modify: `server/retconService.ts:281-1251`
- Modify: `server/canonState.ts`
- Modify: `server/readingExperienceModule/ledger.ts`
- Create: `tests/readingExperience.retcon.test.ts`
- Modify: `tests/narrative.test.ts:4889-4930,5312,5409`

**Interfaces:**
- Consumes: 修史候选 Revision 列表、每段对应的 activation、检查点和 `schedule(retcon)`。
- Produces: 全部 Revision 都 accepted 后才能提交的 retcon patch；旧证据保留历史但退出活动账本。

- [ ] **Step 1: 写 R1→R2→R3 与分支重放失败测试**

```ts
test("retcon and rollback create revision-bound evidence and deterministic ledger replay", async () => {
  const story = retconStoryFixture();
  const r1Evidence = activeEvidenceIds(story);
  await applyRetconForTest(story, "删除死亡并改写后续", retconRuntimeFixture());
  const r2 = currentRevision(story.chapters[0])!;
  assert.equal(activeEvidence(story).every((item) => item.chapterRevisionId === r2.id), true);
  assert.equal(activeEvidenceIds(story).some((id) => r1Evidence.includes(id)), false);
  await rollbackRetconForTest(story, story.retcons[0].id, retconRuntimeFixture());
  const r3 = currentRevision(story.chapters[0])!;
  assert.notEqual(r3.id, r2.id);
  assert.equal(activeEvidence(story).every((item) => item.chapterRevisionId === r3.id), true);
  assert.deepEqual(replayActiveLedger(story), replayActiveLedger(story));
});
```

任一受影响 Revision 未通过时整个 clone 不提交；跨 activation segment 使用各自 contract；延迟死亡否决新分支不得污染旧分支。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec tsx --test tests/readingExperience.retcon.test.ts`

Expected: FAIL，当前 retcon/rollback 直接创建 Revision 且无体验门禁。

- [ ] **Step 3: 把 retconService 改为候选补丁生成器**

`handleReaderMessage`、`applyDeathVeto`、`applyLocalIntervention`、`rollbackRetcon` 在 clone 中生成候选 revisions 和 canon patch，但不直接标记提交完成。`index.ts` 为每个新 Revision 调用相应 activation 的 `schedule(retcon)+assess`；正文即使与 R1 相同，R3 仍生成新的 evidence ID 并绑定 R3。

- [ ] **Step 4: 实现证据失效、检查点重放与原子提交**

`ledger.ts` 从受影响章节前最近 checkpoint 开始，过滤旧 revision evidence，按章节号和 activation timeline 重放。CAS 或 judge 失败恢复 story/jobs/audit/idempotency；旧分支 state/evidence 保持不变。

Run: `pnpm exec tsx --test tests/readingExperience.retcon.test.ts`

Run: `pnpm exec tsx --test --test-name-pattern "retcon|rollback|delayed death veto" tests/narrative.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/types.ts server/index.ts server/retconService.ts server/canonState.ts server/readingExperienceModule/ledger.ts tests/readingExperience.retcon.test.ts tests/narrative.test.ts
git commit -m "feat: replay experience evidence through retcons"
```

### Task 10: 删除 V1 行为旁路，建立架构门禁与真实两章评测

**Files:**
- Delete or reduce to migration reader: `server/readingExperience.ts`
- Modify: `server/modelGateway.ts`
- Modify: `server/narrativeEngine.ts`
- Modify: `server/storyService.ts`
- Modify: `server/openingService.ts`
- Modify: `server/index.ts`
- Modify: `package.json`
- Create: `tsconfig.tests.json`
- Create: `tests/readingExperience.boundary.test.ts`
- Create: `evals/readingExperienceMatrix.ts`
- Create: `scripts/checkReadingExperienceBoundary.ts`
- Create: `scripts/evaluateReadingExperience.ts`

**Interfaces:**
- Consumes: 完整 V2 流水线和现有 HTTP API。
- Produces: CI 架构门禁、quick/nightly/release/provider-smoke 报告与最终可复验命令。

- [ ] **Step 1: 写静态边界失败测试**

```ts
test("production callers contain no descriptor-driven behavior or fixed prose skeleton", async () => {
  const violations = await scanReadingExperienceBoundary(process.cwd());
  assert.deepEqual(violations, []);
});
```

扫描 production 文件，除 `readingExperienceModule/ruleAdapters.ts` 和 `readingExperienceMigration.ts` 外禁止 `sourceWords.includes`、`axis.word ===`、`isSystemInvincibleExperience`、具体体验词条件分支、固定三句和 `systemInvincibleParagraphs`；行为 spy 证明 opening/continuation/rewrite/retcon 全部穿过 `schedule/assess`。

- [ ] **Step 2: 运行门禁并确认失败**

Run: `pnpm exec tsx --test tests/readingExperience.boundary.test.ts`

Expected: FAIL，并列出当前 `modelGateway.ts`、`narrativeEngine.ts`、`storyService.ts` 的词面分支和固定骨架。

- [ ] **Step 3: 删除旧路径并加入类型/架构脚本**

迁移旧细节测试到 V2 Interface 测试后删除重复规则；所有生成/修史路径只传 contract/activation/ledger/ticket。新增 scripts：

```json
"typecheck:tests": "tsc -p tsconfig.tests.json --noEmit",
"check:experience-boundary": "tsx scripts/checkReadingExperienceBoundary.ts",
"eval:experience": "tsx scripts/evaluateReadingExperience.ts"
```

- [ ] **Step 4: 实现固定矩阵和报告阈值**

`evals/readingExperienceMatrix.ts` 定义 24 个接受词对（设计中的 22 个加 `黑暗·温暖`、`荒诞·理性`）及拒绝集。`quick` 固定 6 对×2 题材×1 次×2 章；`nightly` 8×2×2×2；`release` 24×3×5×2；`provider-smoke` 3 对各两章。脚本通过 login → create story → generate chapter 2 → get story，检查 Revision、双轴证据、hash、ledger、路由和元叙事，输出 `output/evals/<timestamp>-<profile>-<connection>.json`，阈值失败退出非零。另用一个 6 章 fake-port 场景覆盖 rolling window、soft debt 到期、换契约、分支和修史重放；两章真实样本不代替这项生命周期测试。

指标分别计算：`job_success_rate`、`published_compliance_rate=100%`、`chapter_two_retention_rate>=90%`、文风/节奏盲判 `>=80%`、冲突共同因果 `>=80%`，并按词对/题材分桶。

- [ ] **Step 5: 跑确定性最终门禁**

Run: `pnpm test`

Run: `pnpm typecheck`

Run: `pnpm typecheck:tests`

Run: `pnpm check:experience-boundary`

Run: `pnpm build`

Expected: 全部退出码 0；硬规则、安全、事务和架构测试 100% 通过。

- [ ] **Step 6: 启动服务并跑当前连接的真实 quick 两章矩阵**

Run: `pnpm dev:api`

Run: `$env:XUMO_EVAL_BASE_URL="http://127.0.0.1:8787"; $env:XUMO_EVAL_EMAIL="admin@xumo.local"; pnpm eval:experience -- --profile quick --connection-id conn_176c8f07`

Expected: 报告生成；所有发布章节硬门禁 100%，每个 quick 词对/题材均成功生成两章且第二章双轴保持。失败样本保留安全摘要和阶段，不保留 key/完整 prompt。

- [ ] **Step 7: 跑发布矩阵与供应商兼容烟测**

Run: `$env:XUMO_EVAL_BASE_URL="http://127.0.0.1:8787"; pnpm eval:experience -- --profile release --connection-id conn_176c8f07`

Run: `$env:XUMO_EVAL_BASE_URL="http://127.0.0.1:8787"; pnpm eval:experience -- --profile provider-smoke --connection-id conn_1739ee19`

Expected: release 中每词对/题材至少 4/5 双轴成功、已发布合规率 100%、第二章保持率至少 90%；provider-smoke 的三个代表词对都生成两章。运行前确认 `conn_1739ee19` 仍为 active 且 baseUrl 为硅基流动；密钥不写入代码、命令或报告。

- [ ] **Step 8: Commit**

```powershell
git add package.json tsconfig.tests.json server src tests evals scripts docs/superpowers/specs/2026-07-17-universal-reading-experience-design.md CONTEXT.md
git commit -m "feat: enforce universal reading experience delivery"
```

## Self-Review Record

- Spec coverage: Task 1 覆盖任意输入三态、重复/冲突/新词；Task 2 覆盖同源调度、承诺、债务和票据；Task 3 覆盖七类证据与双轴；Task 4 覆盖 provider-neutral Ports；Task 5 覆盖持久化、许可、CAS 与 V1；Task 6/7 覆盖开篇、续章和重写；Task 8 覆盖错误与事务；Task 9 覆盖修史；Task 10 覆盖旁路删除、评测和完成门禁。
- Lifecycle consistency: compile revision 不绑定分支；activation/ledger 在应用事务创建；assessment 绑定预留 chapter/revision；提交比较 canon/ledger；retcon 创建新 Revision 和新证据。
- Three-entry consistency: 对外实例始终只有 `compile/schedule/assess`；抽取/裁判藏在 `assess` 内；迁移与提交是应用服务，不是第四个体验入口。
- Metric consistency: 作业成功率、已发布合规率和第二章保持率使用不同且固定的分母；两章评测不冒充滚动窗口验证，窗口/债务由六章确定性 fixture 覆盖。
- Placeholder scan: 所有任务均给出确切文件、接口、失败测试、实现形状、命令、预期和提交边界；没有待定步骤。
- Type consistency: `CompiledExperienceContractRevision`、`ExperienceContractActivation`、`ExperienceStagePlan`、`ExperiencePublicationPermit`、`ExperienceLedgerPatch` 在各任务中名称一致。
