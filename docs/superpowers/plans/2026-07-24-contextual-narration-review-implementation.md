# 上下文语义叙事门禁与用户反馈闭环 Implementation Plan

> **实施前提：** 以已确认的设计文档 `docs/superpowers/specs/2026-07-24-contextual-narration-review-design.md` 为唯一产品约束。按任务顺序实施，每一步先写失败测试，再写最小实现；普通测试不得调用真实模型。

**Goal:** 把开篇正文的作者侧元叙事规则从“命中即失败”改为“规则定位、现有审稿模型裁决、歧义交给故事所有者”，并让用户保留、用户重写、90 秒超时重写、服务重启恢复和隐私反馈全部确定地收敛。

**Architecture:** 保留现有 `planner -> writer -> extractor/reviewer` 三角色与最多两稿流程。规则输出带偏移和三句上下文的候选；现有 reviewer 在同一次调用中追加候选判断。明显元叙事自动消耗唯一一次整章重写，明显故事内表达继续发布，只有歧义稿被加密写入 PostgreSQL 并把作业切到 `awaiting_user_review`。用户或超时通过数据库 CAS 抢占一次决议，随后从加密检查点继续，而不是重跑 planner。长期反馈只存结构化字段；正文上下文仅在明确同意时以脱敏、加密、90 天 TTL 的形式保存。

**Tech Stack:** TypeScript 7、Node.js 22 `crypto`、Express 5、Zod 4、React 19、PostgreSQL / PGlite、tsx、node:test；不增加运行时依赖，不增加模型路由或模型调用角色。

## Current Integration Facts

- `server/modelGateway.ts` 当前在 writer 返回正文后先调用 `assertImmersiveNarration`，再调用现有 extractor/reviewer；元叙事语义判断必须移到这一次 reviewer 调用中。
- `server/openingService.ts` 在应用生成结果前会再次调用沉浸门禁；新流程必须携带绑定正文哈希的内部许可，避免这里重新按词面误杀。
- `POST /api/stories` 当前同步等待正常开篇。正常成功可继续返回 `201`；只有出现歧义时返回 `202` 作业状态，之后通过作业查询与决议接口恢复，不把 HTTP 请求挂 90 秒。
- `GenerationJob.status` 当前只有 `running/completed/failed`；预算、启动恢复、bootstrap 和观察台都显式判断了 `running`，必须一起更新。
- 生产持久化是 PostgreSQL；文件/内存模式不具备跨进程 CAS。功能开关在生产启用时必须要求 PostgreSQL。未启用时保留旧硬门禁作为回滚路径。
- 当前工作树已有用户修改。实施时不得 reset/checkout；提交前对已脏的跟踪文件只暂存本任务新增 hunks，新文件可显式暂存。

## Global Invariants

- 规则只产生候选，不得根据词面直接产生 `allow/rewrite`；正文内嵌章节标题等确定性结构错误仍可直接要求重写。
- 聚合优先级固定为 `rewrite > ask_user > allow`。阈值初始为 `0.85`，`confidence >= threshold` 才能自动裁决。
- 一次开篇最多调用 writer 两次；暂停与恢复不得重跑 planner，不得重置 Token 计数，不得静默切换连接。
- `keep` 只豁免当前 `contentHash + candidateIds + caseVersion` 对应的歧义候选；安全、隐私、体验证据、持久事实、正史与发布门禁继续失败关闭。
- reviewer 正常返回时不增加任何模型调用：无候选与有候选都仍使用同一次开篇 reviewer 请求。
- 待确认检查点只保存规范化的运行状态，不保存 API Key、模型原始响应、完整提示词或连接 secret；检查点必须 AES-256-GCM 加密并在案例结束后清空。
- 未同意时，长期表中不得出现命中句、相邻句、标题、灵感、完整正文或自由文本 reviewer reason。
- 用户决议与超时决议通过相同 CAS；任何网络重试、重复点击、双实例扫描都只能触发一次恢复。
- 功能开关关闭后，新作业走旧门禁；已经存在的待确认案例仍由恢复器处理到终态。

## State Machine

```text
running attempt=1
  -> all allow -------------------------------> completed
  -> rewrite ---------------------------------> running attempt=2
  -> ask_user --------------------------------> awaiting_user_review(case A)

case A --keep--> running/resume current draft -> completed | failed by other hard gate
case A --rewrite/timeout--> running attempt=2 -> completed | awaiting_user_review(case B) | failed

case B --keep--> running/resume current draft -> completed | failed by other hard gate
case B --rewrite/timeout----------------------> failed(rewrite_exhausted)
```

案例状态使用设计中已确认的 `pending -> kept | rewrite_requested | timeout_rewrite -> resolved`；`failed` 用于检查点损坏或 24 小时临时数据到期。动作状态本身是可恢复状态，只有后续故事/失败结果已持久化后才清空密文并标记 `resolved`。

## File Map

| 文件 | 职责 |
|---|---|
| `server/narrationPolicy.ts` | 规则表、中文句界、候选定位、旧硬门禁与结构门禁 |
| `server/narrationReview.ts` | reviewer 子协议、结果归一化、阈值与聚合决策 |
| `server/appEncryption.ts` | 复用 `APP_ENCRYPTION_KEY` 的主密钥加载与用途隔离派生 |
| `server/narrationReviewState.ts` | 检查点封装/解封、AAD、同意上下文脱敏与限长 |
| `server/database/migrations/003_contextual_narration_reviews.sql` | 案例、反馈、CAS/TTL 索引 |
| `server/database/types.ts` / `postgres.ts` | 原子暂停、决议抢占、恢复扫描、清理和聚合 |
| `server/modelGateway.ts` | 在现有 reviewer 中评估候选，产出可暂停/可恢复结果 |
| `server/openingService.ts` | 分离 story shell 与 apply，校验正文哈希许可 |
| `server/openingJobService.ts` | 初次生成、暂停、恢复、最终提交与幂等编排 |
| `server/narrationReviewScheduler.ts` | 90 秒超时、启动恢复、24 小时/90 天清理 |
| `server/index.ts` | HTTP 鉴权、状态查询、用户决议和服务启动接线 |
| `src/types.ts` / `src/api.ts` | 公共作业、案例与决议 DTO |
| `src/openingJobState.ts` | 可单测的客户端轮询/决议状态 reducer |
| `src/pages/NewStoryPage.tsx` | 待确认卡片、倒计时、保留/重写与同意项 |
| `src/components/AppShell.tsx` | 等待用户判断的可恢复入口 |
| `src/pages/OpsPage.tsx` | 仅展示聚合反馈，不展示上下文 |

---

### Task 1: 把词面硬门禁拆成候选检测与结构门禁

**Files:**
- Modify: `server/narrationPolicy.ts`
- Modify: `tests/narrative.test.ts`
- Create: `tests/narrationReview.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export interface NarrationCandidate {
  id: string;
  ruleId: string;
  ruleVersion: string;
  location: "title" | "body";
  matchedText: string;
  matchStart: number;
  matchEnd: number;
  sentenceStart: number;
  sentence: string;
  previousSentence?: string;
  nextSentence?: string;
  contentHash: string;
}

export function narrationArtifactHash(title: string, paragraphs: readonly string[]): string;
export function detectNarrationCandidates(location: "title" | "body", text: string, contentHash: string): NarrationCandidate[];
export function assertOpeningNarrationStructure(title: string, body: string): void;
```

- [ ] **Step 1: 写候选定位与句界失败测试**

覆盖以下断言：

```ts
test("known false positive is located with stable three-sentence context", () => {
  const body = "雨停了。老人递来半本卷边残诗稿，纸角还沾着泥。门外又响起脚步声。";
  const hash = narrationArtifactHash("旧稿", [body]);
  const [candidate] = detectNarrationCandidates("body", body, hash);
  assert.equal(candidate.matchedText, "本卷");
  assert.equal(candidate.sentence, "老人递来半本卷边残诗稿，纸角还沾着泥。");
  assert.equal(candidate.previousSentence, "雨停了。");
  assert.equal(candidate.nextSentence, "门外又响起脚步声。");
  assert.equal(candidate.contentHash, hash);
});

test("sentence boundaries include closing quotes and preserve absolute offsets", () => {
  const body = "他问：“这是本卷目标吗？”她摇头。\n灯灭了；走廊安静下来。";
  // 问号、闭引号、换行、分号和省略号分别加 fixture；用 slice(matchStart, matchEnd) 校验偏移。
});
```

同时加入“这本卷边旧书”“基本卷积运算”“本卷目标是推进角色弧”“作者在这里安排转折”、正文内 `第 1 章 标题`、重复/重叠规则和相同输入 ID 稳定性测试。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/narrationReview.test.ts`

Expected: FAIL，提示 `detectNarrationCandidates`、`narrationArtifactHash` 尚不存在。

- [ ] **Step 3: 实现规则表、句界扫描与稳定候选 ID**

把现有四个正则改成带 `ruleId/ruleVersion/kind/pattern` 的只读规则表。对每条规则使用全局副本扫描，按 `matchStart -> 长匹配优先 -> ruleId` 排序，并去除相同范围的重复候选。ID 使用 `sha256(ruleVersion, ruleId, location, matchStart, matchEnd, contentHash)`，不写入原句。

句界扫描器必须：

- 把 `。！？；\n` 与成对省略号视为边界；
- 当终止标点后紧跟 `”’」』】` 时把闭引号纳入当前句；
- 返回原文绝对 offset，不先 trim 再计算；
- 上下文只取命中句及前后各一句；
- 标题和正文分别检测，但共享整个草稿的 `contentHash`。

保留 `assertImmersiveNarration` 给续章与功能开关关闭时使用。新增 `assertOpeningNarrationStructure` 只处理正文内嵌章节标题、空标题等确定性结构问题，不根据作者侧词面做语义结论。

- [ ] **Step 4: 更新旧测试，证明续章旧行为与开篇候选行为并存**

`tests/narrative.test.ts` 中续章的 `assertImmersiveNarration` 断言继续通过；新测试只断言开篇候选被定位，不再断言“半本卷边”抛错。把新测试文件加入 `package.json` 的 `test` 脚本。

Run: `pnpm exec tsx --test tests/narrationReview.test.ts tests/narrative.test.ts`

Expected: PASS，且不发生网络请求。

- [ ] **Step 5: Commit**

只暂存本任务 hunks：`feat: detect contextual narration candidates`

---

### Task 2: 在现有 reviewer 调用中加入语义裁决

**Files:**
- Create: `server/narrationReview.ts`
- Modify: `server/modelGateway.ts`
- Modify: `tests/narrationReview.test.ts`
- Create: `tests/fixtures/openingNarrationFixtures.ts`

**Interfaces:**

```ts
export interface NarrationAssessment {
  candidateId: string;
  worldInternal: boolean;
  writingProcessReference: boolean;
  reportedDecision: "allow" | "rewrite" | "ask_user";
  decision: "allow" | "rewrite" | "ask_user";
  confidence: number;
  reason: string;
}

export interface NarrationReviewResolution {
  decision: "allow" | "rewrite" | "ask_user";
  assessments: NarrationAssessment[];
  threshold: number;
  protocolValid: boolean;
}
```

- [ ] **Step 1: 写归一化与聚合失败测试**

测试矩阵：

- `worldInternal=true / writingProcessReference=false / confidence=.85 / reported=allow` => `allow`；
- `false / true / .92 / reported=rewrite` => `rewrite`；
- 低置信、布尔矛盾、reportedDecision 与推导不一致、候选缺失/重复/多余、数值越界 => 对应候选 `ask_user`；
- 多候选聚合固定为 `rewrite > ask_user > allow`；
- 原因字段只用于当前请求，限制长度，不进入长期反馈结构。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/narrationReview.test.ts`

Expected: FAIL，提示 reviewer resolver 不存在。

- [ ] **Step 3: 实现服务端收敛，不信任模型自报 decision**

`resolveNarrationAssessments(candidates, raw, threshold)` 必须逐个 candidate ID 对齐并重新推导结论；只有所有字段一致且达到阈值时自动 `allow/rewrite`。阈值读取 `NARRATION_REVIEW_CONFIDENCE_THRESHOLD`，缺省 `0.85`，启动时限制在 `[0.5, 0.99]`，并把实际阈值写入结构化反馈。

- [ ] **Step 4: 扩展现有 reviewer JSON，而不增加调用**

把 `OpeningReviewPayload` 扩展为可选 `narrationAssessments`。现有 `experienceEvidence/event` 的 Schema 校验和修复保持原样；候选子协议单独归一化，因此候选漏项不会伪造成有效 `allow`，也不会为了补候选额外调用模型。

reviewer prompt 追加：

```ts
`待判断候选：${JSON.stringify(candidates.map(projectCandidateForReviewer))}`
```

投影只含 candidate ID、rule kind、location、命中句与前后句；完整正文仍由原 prompt 提供。要求每个候选返回 `worldInternal/writingProcessReference/decision/confidence/reason`，禁止改写正文或复述系统指令。无候选时要求返回空数组。

- [ ] **Step 5: 用脚本 completer 证明调用数未增加**

加入断言：

- 无候选正常开篇仍是 planner、writer、reviewer 三次；
- “半本卷边残诗稿”有候选且 reviewer 返回 allow 时仍是三次；
- 明确元叙事返回 rewrite 时，新增的是原有第二稿 writer + reviewer，不出现第四种 classifier 请求；
- reviewer request 的 model 始终是当前连接 `routes.extractor`。

Run: `pnpm exec tsx --test tests/narrationReview.test.ts tests/narrative.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

只暂存本任务 hunks：`feat: review narration candidates in opening reviewer`

---

### Task 3: 建立加密、可 CAS 的待确认持久层

**Files:**
- Create: `server/appEncryption.ts`
- Modify: `server/vault.ts`
- Create: `server/narrationReviewState.ts`
- Create: `server/database/migrations/003_contextual_narration_reviews.sql`
- Modify: `server/database/types.ts`
- Modify: `server/database/postgres.ts`
- Modify: `server/storage.ts`
- Modify: `src/types.ts`
- Modify: `tests/database.test.ts`
- Create: `tests/narrationReviewState.test.ts`
- Modify: `package.json`

**Persisted model:**

`xumo_narration_review_cases` 保存可恢复的业务状态：`id/job_id/owner_id/content_hash/attempt/rewrite_count/status/version/deadline_at/payload_expires_at/decision_source/created_at/resolved_at`、不含文本的 `candidate_metadata/assessment_metadata`，以及可空 `encrypted_payload`。

`xumo_narration_review_feedback` 保存长期结构化行：规则/模型/阈值/自动结论/用户或超时结论/重写次数/最终结果/耗时/内容哈希；用户同意的三句上下文放在独立可空 `consented_excerpt_ciphertext` 与 `excerpt_expires_at` 中。数据库约束禁止未知状态和未知决议来源；索引覆盖 `(status, deadline_at)`、`payload_expires_at`、`excerpt_expires_at`、`(rule_id, rule_version, created_at)`。

- [ ] **Step 1: 写迁移、密文与 CAS 失败测试**

使用 PGlite 测试：

- migration 可重复执行；
- 暂停操作在同一事务写入 case 并把 job 更新为 `awaiting_user_review`；
- 数据库全文/JSON 中找不到测试正文“半本卷边残诗稿”；
- 用错误 AAD、错误 owner、错误 contentHash、错误 version 解密/决议失败；
- 两个并发决议只有一个 `rowCount=1`；
- `get...ForOwner` 不能读取其他用户案例；
- resolve 后 `encrypted_payload IS NULL`，结构化 metadata 仍可聚合。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/narrationReviewState.test.ts tests/database.test.ts`

Expected: FAIL，提示 migration、cipher 和数据库方法不存在。

- [ ] **Step 3: 抽取应用主密钥并做用途隔离**

把 `server/vault.ts` 中 `APP_ENCRYPTION_KEY` 解析与开发主密钥加载抽到 `server/appEncryption.ts`，保证现有模型凭据格式不变。用 HKDF-SHA256 从主密钥派生 `xumo:narration-review:v1` 子密钥；检查点使用 AES-256-GCM，随机 12 字节 IV，AAD 固定为：

```text
narration-review:v1:<caseId>:<jobId>:<ownerId>:<contentHash>
```

`EncryptedEnvelopeV1` 只保存 `version/iv/tag/ciphertext`。生产缺少合法 `APP_ENCRYPTION_KEY` 时沿用现有失败关闭；不得把 key、AAD 或解密后的 payload 写日志。

- [ ] **Step 4: 定义临时 payload 与公共 DTO 的边界**

临时密文包含：规范化 story shell、`OpeningGenerationContext`、已校验 plan/contract、当前 `GeneratedStoryOpening` 或可重建它的 base review、writer attempt、rewrite count、累计 Token、usage estimated、连接 ID/`updatedAt`/路由绑定。明确排除 secret、原始模型响应、完整 prompt 和 AI trace。

`src/types.ts` 只暴露：

```ts
export type GenerationJobStatus = "completed" | "running" | "awaiting_user_review" | "failed";
export interface PendingNarrationReviewView {
  id: string;
  version: number;
  jobId: string;
  contentHash: string;
  deadlineAt: string;
  candidates: Array<{
    id: string;
    ruleId: string;
    location: "title" | "body";
    matchedText: string;
    sentence: string;
    previousSentence?: string;
    nextSentence?: string;
    highlightStart: number;
    highlightEnd: number;
  }>;
}
```

公共 DTO 不含 reviewer reason、checkpoint、ownerId、路由内部信息或反馈表 ID。

- [ ] **Step 5: 实现 PostgreSQL 原子操作**

在 `PersistenceDatabase` / `PostgresDatabase` 增加以下能力（名称可按现有风格微调，语义不可削弱）：

- `pauseOpeningForNarrationReview(job, caseRecord)`：事务内 upsert job + insert case；
- `getNarrationReviewCaseForOwner(ownerId, jobId)`；
- `claimNarrationReviewDecision(expected...)`：`WHERE status='pending' AND version=? AND content_hash=?`；
- `claimExpiredNarrationReviews(now, limit)`：`FOR UPDATE SKIP LOCKED` 或等价条件更新；
- `listRecoverableNarrationReviews()`：返回 `kept/rewrite_requested/timeout_rewrite` 与仍 pending 的案例；
- `replaceNarrationReviewCase(oldId, newCase, job)`：第二稿再次歧义时原子清理旧 case 并暂停到新 case；
- `resolveNarrationReviewCase(id, finalStatus)`、`failExpiredNarrationReviewCase(id)`；
- best-effort `upsertNarrationReviewFeedback` 与 TTL 删除。

`server/storage.ts` 只做薄委托。生产功能开关开启但非 PostgreSQL 时启动失败；测试通过注入 PGlite repository，不用真实数据库。

- [ ] **Step 6: 运行测试并检查迁移内容**

Run: `pnpm exec tsx --test tests/narrationReviewState.test.ts tests/database.test.ts`

Expected: PASS；决议竞态测试每轮恰好一个 winner；明文扫描为零。

- [ ] **Step 7: Commit**

只暂存本任务 hunks：`feat: persist encrypted narration review state`

---

### Task 4: 把开篇生成改造成可暂停、可恢复的两稿状态机

**Files:**
- Modify: `server/modelGateway.ts`
- Modify: `server/openingService.ts`
- Create: `tests/openingNarrationWorkflow.test.ts`
- Modify: `tests/narrative.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export type OpeningGenerationOutcome =
  | { status: "completed"; generated: GeneratedStoryOpening; narrationPermit: NarrationPermit }
  | { status: "awaiting_user_review"; checkpoint: OpeningGenerationCheckpoint; review: PendingNarrationReviewDraft };

export type NarrationReviewAction =
  | { kind: "keep"; candidateIds: string[]; contentHash: string }
  | { kind: "rewrite"; source: "user" | "timeout" };

export async function beginStoryOpeningGeneration(...): Promise<OpeningGenerationOutcome>;
export async function resumeStoryOpeningGeneration(checkpoint: OpeningGenerationCheckpoint, action: NarrationReviewAction, ...): Promise<OpeningGenerationOutcome>;
```

- [ ] **Step 1: 写状态机失败测试**

脚本 completer 固定 plan/writer/reviewer 输出，覆盖：

1. `allow`：完成，同一稿发布；
2. 首稿 `rewrite`：只生成第二稿，第二稿 allow 后完成；
3. 首稿 `ask_user`：返回 checkpoint，不调用第二稿；
4. `ask_user -> keep`：base review 有效时新增模型调用数为 0；
5. `ask_user -> rewrite`：从 attempt 2 继续，不重跑 planner；
6. 第二稿 `ask_user -> keep`：允许继续其他门禁；
7. 第二稿 `ask_user -> rewrite/timeout`：`narration_rewrite_exhausted`，不调用第三次 writer；
8. checkpoint 连接 `id/updatedAt/routes` 不匹配：失败，不切换连接；
9. 恢复后的总 Token 等于暂停前累计 + 恢复后调用，且仍受 `OPENING_JOB_TOKEN_BUDGET` 约束。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/openingNarrationWorkflow.test.ts`

Expected: FAIL，提示 begin/resume outcome 尚不存在。

- [ ] **Step 3: 分离 story shell、生成与应用**

在 `openingService.ts` 提取：

```ts
prepareStoryOpening(input, ownerId): { story: Story; context: OpeningGenerationContext }
applyGeneratedStoryOpening(story, connection, generated, narrationPermit, publicationGate): Story
```

保留 `createStoryWithOpening` 作为兼容 wrapper，供旧测试和功能开关关闭路径使用。`applyGeneratedStoryOpening` 重算标题+段落 hash，并校验 permit 的 contentHash、候选 ID 与决议已经收敛；不得再次用旧词面规则否决已语义放行的稿件。确定性结构门禁、体验证据与 publication safety 仍执行。

- [ ] **Step 4: 把 modelGateway writer loop 显式化为检查点状态**

planner 完成后冻结规范化 plan/contract；每稿流程固定为：

```text
writer -> 长度/结构/体验内容预检 -> detect candidates
       -> existing reviewer(base evidence + narration assessments)
       -> ground evidence/persistent facts
       -> resolve rewrite/ask_user/allow
```

`rewrite` 在 attempt 1 继续现有第二稿；attempt 2 终止。`ask_user` 返回已归一化 checkpoint。恢复 keep 时验证 candidate 集合和 hash 后签发仅对该稿有效的 permit；恢复 rewrite 时丢弃当前稿并进入 attempt 2。

若 reviewer 整体超时或 base Schema 最终不可用，仍按设计生成 `ask_user`，但 checkpoint 标记 `baseReviewStatus="unavailable"`。用户 keep 后只能在现有 reviewer 重试预算内恢复原 reviewer 阶段；若体验证据仍不可得则质量失败，绝不把用户对元叙事的选择当成体验证据许可。该重试属于原 reviewer 职责，不新增分类角色。

- [ ] **Step 5: 保持失败观测和 Token 语义**

暂停不是失败，不写 terminal failure；provider/reviewer 的真实异常仍写非终态观测。只有重写额度耗尽、检查点无效或其他硬门禁失败才结束 job。`observeOpening` 在暂停前也要拿到已消费 usage，确保作业页面不会显示 0 Token。

Run: `pnpm exec tsx --test tests/openingNarrationWorkflow.test.ts tests/narrative.test.ts tests/generationBudget.test.ts`

Expected: PASS；任一测试中的 writer 调用不超过 2。

- [ ] **Step 6: Commit**

只暂存本任务 hunks：`feat: pause and resume opening narration review`

---

### Task 5: 接入开篇作业服务、HTTP 状态与所有者鉴权

**Files:**
- Create: `server/openingJobService.ts`
- Modify: `server/index.ts`
- Modify: `server/generationBudget.ts`
- Modify: `src/types.ts`
- Modify: `tests/generationBudget.test.ts`
- Create: `tests/openingJobService.test.ts`
- Modify: `package.json`

**HTTP contract:**

```ts
export type CreateStoryResult =
  | { kind: "completed"; story: Story }
  | { kind: "job"; job: OpeningJobStatusPayload };

export type OpeningJobStatusPayload =
  | { jobId: string; status: "running" }
  | { jobId: string; status: "awaiting_user_review"; review: PendingNarrationReviewView }
  | { jobId: string; status: "completed"; storyId: string }
  | { jobId: string; status: "failed"; message: string; retryable: boolean };
```

- [ ] **Step 1: 写服务级失败测试**

用内存 AppStore + PGlite repository + fake opening pipeline 测试：正常 `201 completed`、歧义 `202 job`、同一幂等键返回同一 job、他人查询 404、错误 hash/version 409、重复决议不重复恢复、完成只创建一个 story/creationRequest/audit、失败释放幂等键。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/openingJobService.test.ts`

Expected: FAIL，提示 `openingJobService` 不存在。

- [ ] **Step 3: 把现有 `/api/stories` try/catch 移入可注入服务**

`openingJobService` 负责现有 job 创建、usage、失败观测、story 最终提交与回滚。正常开篇仍可在当前请求内完成并返回 `201`；一旦 pipeline 返回 awaiting，必须先调用数据库原子暂停，再返回 `202`。不能先把状态只改在内存中。

同一 idempotency key 的处理顺序：

1. 已有 `storyCreationRequest` => 返回 completed；
2. 内存/数据库已有同 owner + key 的 running/awaiting/failed job => 返回它的当前状态；
3. 否则才 reserve 并创建新 job。

用户明确发起一次新的终态失败重试时，客户端必须换新 key；服务端不会用同一 key 重复消费 Token。

- [ ] **Step 4: 增加所有者限定的状态与决议接口**

```text
GET  /api/generation-jobs/:jobId
POST /api/generation-jobs/:jobId/narration-review
```

决议 body 使用严格 Zod Schema：

```ts
{
  caseId: string;
  caseVersion: number;
  contentHash: string;
  candidateIds: string[]; // 必须恰好等于当前 ask_user 候选集合
  decision: "keep" | "rewrite";
  shareRedactedContext: boolean; // 默认 false
}
```

POST 只负责校验 owner、解密并核对候选集合、CAS 抢占，然后返回 `202`；恢复工作交给同一 job service 的后台执行器。返回体永远不含密文、模型 reason、prompt 或其他用户信息。

- [ ] **Step 5: 更新作业状态的所有显式分支**

- `GenerationJob.status` 加 `awaiting_user_review`；
- `assertGenerationTokenBudget` 对 `running` 和 `awaiting_user_review` 都按剩余作业预算保留额度；
- PostgreSQL runtime load 显式加载两种活动状态；
- bootstrap `pendingJobs` 包含两种状态；
- `recoverableJobs` 只处理真正 failed，不把等待用户的 job 当中断；
- 启动时只把无可恢复 review action 的 `running` 标成服务中断；等待/已抢占案例交给 Task 6 恢复器。

Run: `pnpm exec tsx --test tests/openingJobService.test.ts tests/generationBudget.test.ts tests/jobRecovery.test.ts tests/database.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

只暂存本任务 hunks：`feat: expose resumable opening review jobs`

---

### Task 6: 实现 90 秒超时、重启恢复、隐私清理与 exactly-once

**Files:**
- Create: `server/narrationReviewScheduler.ts`
- Modify: `server/narrationReviewState.ts`
- Modify: `server/openingJobService.ts`
- Modify: `server/index.ts`
- Modify: `server/failureTelemetry.ts`
- Modify: `tests/narrationReviewState.test.ts`
- Modify: `tests/openingJobService.test.ts`
- Modify: `tests/failureTelemetry.test.ts`

- [ ] **Step 1: 写确定性 sweep 与竞态失败测试**

不启动真实 timer，直接给 `runSweep(now)` 注入时钟，覆盖：

- deadline 前不动作；deadline 相等时 claim `timeout_rewrite`；
- 用户 keep 与 timeout `Promise.all` 时恰好一个 winner、一次 resume；
- 第一次超时进入第二稿，第二稿超时因额度耗尽失败；
- 进程在 `kept/rewrite_requested/timeout_rewrite` 后崩溃，启动扫描可继续；
- job 已 completed 但 case 未清理时只补做 resolve，不再创建故事；
- payload 24 小时到期后密文清空、case/job 失败并释放幂等键；
- 同意 excerpt 到 90 天删除，未同意从未写入 excerpt 列。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/narrationReviewState.test.ts tests/openingJobService.test.ts`

Expected: FAIL，提示 scheduler/sweep 不存在。

- [ ] **Step 3: 实现可单次调用的 sweep 与轻量定时器**

核心逻辑放在 `runNarrationReviewSweep({now, repository, resume})`；生产 wrapper 启动时立即执行一次，随后每 5 秒扫描小批量到期项并 `unref()`。每次 claim 后把 case ID 交给 job service；job service 另有 process-local active set 防止同进程重复运行，数据库状态负责跨实例正确性。

启动恢复顺序：

1. 加载 store 与数据库；
2. 对 completed/failed job 的残留 action case 做幂等清理；
3. 重新排队 `kept/rewrite_requested/timeout_rewrite`；
4. claim 已过期 pending；
5. 最后才把没有 review checkpoint 的遗留 running job 标为 interrupted。

- [ ] **Step 4: 实现同意上下文脱敏与 TTL**

只从候选的 `previousSentence/sentence/nextSentence` 构造文本，去重后总计最多 600 个 Unicode 字符；替换 email、URL、Bearer、`sk-`/常见 API key、UUID、`user_/conn_/job_/story_` 标识。脱敏结果仍使用派生子密钥加密。checkbox=false 时不调用 excerpt 加密函数，数据库列保持 NULL。

- [ ] **Step 5: 明确反馈与发布的失败边界**

- case 暂停/claim/解密失败会阻止继续，因为无法安全恢复；
- story/job 最终提交成功后，结构化 feedback upsert 失败只写不含正文的运维错误，不回滚已发布故事；
- 任何错误消息先过 `sanitizeGenerationFailureMessage`，不得包含候选句；
- 新增稳定 reason codes：`narration_rewrite_exhausted`、`narration_review_state_unavailable`、`narration_review_checkpoint_invalid`、`narration_review_payload_expired`，放在泛化 `narration_metadata` 分类之前。

Run: `pnpm exec tsx --test tests/narrationReviewState.test.ts tests/openingJobService.test.ts tests/failureTelemetry.test.ts`

Expected: PASS；竞态循环多次仍恰好一次恢复。

- [ ] **Step 6: Commit**

只暂存本任务 hunks：`feat: recover and expire narration reviews`

---

### Task 7: 实现用户确认卡片、倒计时与刷新恢复

**Files:**
- Create: `src/openingJobState.ts`
- Modify: `src/api.ts`
- Modify: `src/pages/NewStoryPage.tsx`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/context/AppContext.tsx`
- Modify: `src/styles.css`
- Create: `tests/openingJobState.test.ts`
- Modify: `package.json`

- [ ] **Step 1: 写客户端 reducer 失败测试**

测试 `started -> polling -> awaiting -> submitting_decision -> polling -> completed/failed`，以及：旧轮询响应不能覆盖新 case、deadline 由服务端时间计算、409 后刷新、terminal failure 后生成新 idempotency key、页面恢复时接管 bootstrap 中最新 opening pending job。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/openingJobState.test.ts`

Expected: FAIL，提示 reducer 不存在。

- [ ] **Step 3: 扩展 API client 与轮询**

`api.createStory` 解析 `CreateStoryResult`；新增 `api.generationJob(jobId)` 与 `api.decideNarrationReview(...)`。正常 `completed` 继续刷新并跳转；`job` 结果每 2 秒轮询。组件卸载时取消 timer/忽略过期 promise；浏览器关闭不影响服务端 scheduler。

首次渲染从 `bootstrap.pendingJobs` 找最新 opening job，若为 awaiting 或 URL 带 `?job=` 则立即读取详情。决议提交后继续轮询；若后台已超时返回 409，直接刷新状态，不显示“提交失败后再点一次”。

- [ ] **Step 4: 渲染安全、可访问的确认界面**

每个歧义候选展示前句、命中句、后句；用 React 文本节点按 `highlightStart/highlightEnd` 切片，不用 `dangerouslySetInnerHTML`。界面包含：

- 固定说明“系统无法确定这是故事内描述还是写作安排”；
- “保留原文并继续”与“让 AI 重写”两个按钮；
- 由 `deadlineAt` 推导的 90 秒倒计时和“超时后自动重写”；
- 默认关闭且每个新 case 重置的匿名脱敏上下文同意 checkbox；
- 提交期间按钮禁用、错误用 `role=alert`、状态用 `aria-live=polite`；
- 不显示 reviewer reason、模型提示、蓝图、契约或内部规则表达式。

若一个 case 有多个歧义候选，UI 显示全部，但两个主操作是整稿级；提交时为全部当前候选填同一选择。任何 candidate ID 变化都要求重新读取，不复用旧选择。

- [ ] **Step 5: 更新全局 pending 提示**

`AppShell` 对 awaiting job 显示“有一句话等你判断”，链接 `/new?job=<id>`；running 仍显示旋转生成状态。普通读者无需管理员权限即可处理自己的案例，模型设置入口权限保持不变。

Run: `pnpm exec tsx --test tests/openingJobState.test.ts`

Run: `pnpm typecheck`

Expected: PASS。

- [ ] **Step 6: Commit**

只暂存本任务 hunks：`feat: let story owners resolve narration ambiguity`

---

### Task 8: 建立只含聚合数据的运营反馈视图

**Files:**
- Modify: `src/types.ts`
- Modify: `server/database/types.ts`
- Modify: `server/database/postgres.ts`
- Modify: `server/storage.ts`
- Modify: `server/index.ts`
- Modify: `src/api.ts`
- Modify: `src/pages/OpsPage.tsx`
- Modify: `tests/database.test.ts`

**Interfaces:**

```ts
export interface NarrationReviewMetricBucket {
  key: string;
  ruleId: string;
  ruleVersion: string;
  candidates: number;
  modelAllow: number;
  modelRewrite: number;
  modelAskUser: number;
  userKeep: number;
  userRewrite: number;
  timeoutRewrite: number;
  rewriteSucceeded: number;
  finalJobsCompleted: number;
  lastSeenAt: string;
}
```

- [ ] **Step 1: 写聚合查询失败测试**

插入自动 allow、用户 keep、用户 rewrite、timeout rewrite、第二稿成功/失败样本；断言按 rule version 聚合、分歧率可由计数计算、其他 owner 数据只能在 admin 聚合中出现，查询结果与序列化 JSON 不含测试原句或 excerpt ciphertext。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/database.test.ts`

Expected: FAIL，提示 metrics query 不存在。

- [ ] **Step 3: 实现数据库聚合与 admin API 投影**

`GET /api/ops` 追加 `narrationReviewMetrics`，仅 `requireAdmin` 可读。SQL 只 select 结构化列与计数，绝不 select/decrypt consent excerpt。无 PostgreSQL或无数据时返回空数组，不让观察台失败。

- [ ] **Step 4: 在观察台增加规则质量表**

展示规则版本、候选数、模型三种决定、用户保留/重写、超时、重写成功、最终成功；明确标注“保留率是误报近似信号”。不提供原句展开、下载或跨用户明细入口。现有作业状态把 `awaiting_user_review` 显示为“等待用户判断”。

Run: `pnpm exec tsx --test tests/database.test.ts`

Run: `pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: Commit**

只暂存本任务 hunks：`feat: aggregate narration review feedback`

---

### Task 9: 端到端回归、功能开关与发布/回滚校验

**Files:**
- Create: `tests/contextualNarrationReview.integration.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: 写跨层集成测试**

使用 PGlite、fake clock、fake completer 和真实 job service/repository，完整跑通：

- “半本卷边残诗稿” reviewer allow 后一次成功；
- “本卷目标是推进角色弧”自动重写，第二稿成功；
- `ask_user -> keep`；
- `ask_user -> rewrite`；
- `ask_user -> timeout`；
- 等待期间重建 service 实例后恢复；
- owner B 读取/决议 owner A 案例失败；
- 安全门禁在 keep 后仍能阻止发布；
- 重复 start/status/decision 不重复 Token、不重复 story、不重复 rewrite；
- checkbox false 的长期数据库明文为零，true 只产生可过期密文。

- [ ] **Step 2: 增加配置与启动保护**

`.env.example` / README 记录：

```dotenv
CONTEXTUAL_NARRATION_REVIEW_ENABLED=false
NARRATION_REVIEW_CONFIDENCE_THRESHOLD=0.85
# 继续使用现有 APP_ENCRYPTION_KEY；生产开启本功能时必须配置 PostgreSQL DATABASE_URL。
```

开关只决定新作业走哪套门禁。resume/scheduler 根据已有 case 运行，不因开关关闭而遗弃案例。阈值变化只影响新 assessment；反馈记录实际阈值。

- [ ] **Step 3: 运行完整自动验证**

Run: `pnpm exec tsx --test tests/contextualNarrationReview.integration.test.ts`

Expected: PASS，无真实网络调用。

Run: `pnpm test`

Expected: 全部 PASS。

Run: `pnpm typecheck`

Expected: PASS。

Run: `pnpm build`

Expected: TypeScript、Vite 与 Sites bundle 全部成功。

- [ ] **Step 4: 做静态隐私与调用边界检查**

检查项：

- 新反馈 SQL 不持久化 `sentence/previousSentence/nextSentence/matchedText/reason/prompt` 明文；
- public projector 不含 `encryptedPayload/checkpoint/ownerId`；
- reviewer 候选逻辑没有新的 `complete(...)` 调用点；
- writer 循环上限仍为 2；
- `awaiting_user_review` 被预算、bootstrap、数据库加载、启动恢复和 Ops 全部识别；
- 功能开关关闭时旧 `assertImmersiveNarration` 回归仍通过。

- [ ] **Step 5: 发布与回滚演练**

1. 先部署代码与 `003` migration，开关保持 false；
2. 确认 `APP_ENCRYPTION_KEY` 和 `DATABASE_URL` 稳定，运行 PGlite/生产 migration health check；
3. 小流量打开开关，观察 ask_user 占比、保留率、超时率、重写成功率、pending 最老年龄；
4. 验证“半本卷边残诗稿”进入 allow，而明确元叙事仍重写；
5. 若状态恢复或隐私指标异常，关闭新作业开关；保留 scheduler 让已有 case 按 90 秒策略收敛，不回滚/删除 migration。

- [ ] **Step 6: Commit**

只暂存本任务 hunks：`test: verify contextual narration review workflow`

## Definition of Done

- 已知误报句不再产生终态 `narration_metadata` 失败。
- 明确元叙事不会因用户接口而绕过；最多重写一次。
- 所有 pending case 在用户决定、90 秒 timeout 或 24 小时清理后到达终态。
- 服务重启后，pending 与已抢占 action 均可继续，且 story 创建恰好一次。
- happy path 没有新增模型调用，planner/writer/extractor 路由与用户所选连接绑定。
- 未同意的长期明文上下文数量为 0；同意上下文脱敏、加密并在 90 天删除。
- 普通用户只处理自己的案例；管理员观察台只看聚合。
- `pnpm test`、`pnpm typecheck`、`pnpm build` 全部通过。

## Commit Hygiene for This Dirty Worktree

实施前先记录 `git status --short`。对本计划创建的新文件可直接 `git add <new-file>`；对当前已经修改的 `.env.example`、`README.md`、`package.json`、`server/index.ts`、`server/modelGateway.ts`、`server/narrationPolicy.ts`、`server/storage.ts`、`src/api.ts`、`src/pages/OpsPage.tsx`、`src/styles.css`、`src/types.ts`、`tests/narrative.test.ts` 等文件，只暂存本功能的新增 hunks。每次 commit 前运行：

```powershell
git diff --cached --check
git diff --cached --stat
```

若无法把本功能 hunks 与用户原修改安全分离，停止提交但保留实现与测试结果，向用户说明具体重叠文件；不得用 reset、checkout 或覆盖文件来制造干净工作树。
