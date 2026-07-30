# Story Permanent Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让故事所有者在故事档案页通过输入完整标题永久删除故事，并原子清除私人正文、公开链接、读者进度和内容关联数据，同时只保留不可还原故事内容的脱敏模型统计与审计。

**Architecture:** 删除规则集中在服务端 `storyDeletion` 领域模块；Express 路由只做认证、Zod 校验和进程内互斥，存储层统一协调 PostgreSQL 与 JSON。PostgreSQL 在单个事务中锁定故事、检查活动任务、清理内容、脱敏统计并删除故事；进程级删除墓碑阻止并发旧快照把已删除内容重新写回。前端使用专用确认对话框，并在删除响应丢失时通过私人详情接口确认最终状态。

**Tech Stack:** TypeScript 7、Express 5、Zod 4、React 19、PostgreSQL / PGlite、tsx、node:test、Vite；不增加运行时依赖，不新增数据库 migration。

---

## Confirmed Specification

实施必须以 `docs/superpowers/specs/2026-07-30-permanent-story-deletion-design.md` 为产品约束，并保持以下不变量：

- 删除不可恢复，入口只在故事档案页。
- 服务端必须复核所有权和完整标题，不能信任前端禁用状态。
- `running`、`awaiting_user_review` 或持有 `storyMutationLocks` 的故事返回 `409 story_delete_busy`。
- 成功删除返回 `204 No Content`；私人地址和公开分享地址随后均不可读。
- 章节、修订、发布记录、公共进度、内容举报、安全决策和含内容审核 case 必须删除。
- 模型、Token、成本、耗时和结构化原因码可以保留，但标题、故事 ID、候选文本、上下文、提示词、原错误消息、原内容哈希和摘录密文不得保留。
- PostgreSQL 与 JSON 存储行为一致；任何失败必须完整回滚。
- 已删除故事不得被并发捕获的旧 `saveSnapshot` 重新插入。
- 两个用户自有文件 `demo-test1-source-20260721-113811.zip` 与 `structure.txt` 不得暂存、修改或删除。

## File Map

| 文件 | 职责 |
|---|---|
| `server/storyDeletion.ts` | 错误码、忙碌判断、任务/失败/审计脱敏、运行时 Store 删除与回滚 |
| `server/storyDeletionRoutes.ts` | 经认证的 `DELETE /api/stories/:storyId` 薄路由与进程内锁 |
| `server/database/types.ts` | 暴露数据库永久删除命令与结果 |
| `server/database/postgres.ts` | PostgreSQL 事务删除、内容清理、脱敏和旧快照墓碑防护 |
| `server/storage.ts` | PostgreSQL / JSON 统一删除协调器 |
| `server/index.ts` | 挂载删除路由并向客户端返回稳定错误码 |
| `src/storyDeletion.ts` | 标题匹配和网络响应丢失后的结果确认 |
| `src/components/StoryDeletionDialog.tsx` | 可访问的标题确认对话框 |
| `src/storyDeletion.css` | 危险操作区和删除对话框样式 |
| `src/api.ts` | 删除 API 调用 |
| `src/pages/ArchivePage.tsx` | 唯一删除入口、状态协调、成功导航 |
| `tests/storyDeletion.test.ts` | 纯领域、JSON 删除、脱敏和回滚测试 |
| `tests/storyDeletion.database.test.ts` | PGlite 事务、级联、脱敏、回滚与旧快照测试 |
| `tests/storyDeletionRoutes.test.ts` | HTTP 授权、校验、锁和状态码测试 |
| `tests/storyDeletionClient.test.ts` | 标题确认与断线结果确认测试 |
| `package.json` | 默认测试脚本纳入全部删除测试 |
| `README.md` | 用户可见生命周期说明 |
| `docs/runbooks/public-story-sharing-release.md` | 永久删除发布、备份和不可逆回滚说明 |

## Stable Types and Codes

以下名称在所有任务中保持一致：

```ts
export const DELETED_STORY_PLACEHOLDER = "deleted";
export const DELETED_STORY_TITLE = "已删除故事";

export type StoryDeletionErrorCode =
  | "story_not_found"
  | "story_delete_confirmation_mismatch"
  | "story_delete_busy";

export interface PersistStoryDeletionInput {
  ownerId: string;
  storyId: string;
  confirmationTitle: string;
  auditId: string;
  deletedAt: string;
}

export interface StoryDeletionResult {
  wasCurrentStory: boolean;
  wasPublished: boolean;
  hadChapters: boolean;
}
```

### Task 1: Build the deletion domain and JSON-safe mutation

**Files:**
- Create: `server/storyDeletion.ts`
- Create: `tests/storyDeletion.test.ts`

- [ ] **Step 1: Write failing domain tests**

Create `tests/storyDeletion.test.ts` with focused fixtures. The test must put private sentinels in every field that the retained operational records could otherwise expose:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createAuditEvent } from "../server/auth";
import { createGenerationFailureObservation } from "../server/failureTelemetry";
import {
  DELETED_STORY_PLACEHOLDER,
  DELETED_STORY_TITLE,
  applyStoryDeletionToStore,
  assertStoryDeletionTitle,
  createStoryDeletionAudit,
  hasActiveStoryWork,
  sanitizeGenerationFailureAfterStoryDeletion,
  sanitizeGenerationJobAfterStoryDeletion,
} from "../server/storyDeletion";
import { createSeedStore } from "../server/seed";

test("story deletion requires the exact trimmed title", () => {
  assert.doesNotThrow(() => assertStoryDeletionTitle("潮汐背面", "  潮汐背面  "));
  assert.throws(
    () => assertStoryDeletionTitle("Story A", "story a"),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "story_delete_confirmation_mismatch",
  );
});

test("story deletion detects running and awaiting-review work", () => {
  const store = createSeedStore();
  const storyId = store.stories[0]!.id;
  const baseJob = store.jobs[0]!;
  store.jobs.push({ ...baseJob, id: "job_running_delete", storyId, status: "running" });
  assert.equal(hasActiveStoryWork(store, storyId), true);
  store.jobs.at(-1)!.status = "awaiting_user_review";
  assert.equal(hasActiveStoryWork(store, storyId), true);
  store.jobs.at(-1)!.status = "completed";
  assert.equal(hasActiveStoryWork(store, storyId), false);
});

test("retained generation records contain statistics but no story content", () => {
  const base = createSeedStore().jobs[0]!;
  const job = {
    ...base,
    storyId: "story_private",
    storyTitle: "PRIVATE_TITLE_SENTINEL",
    idempotencyKey: "PRIVATE_IDEMPOTENCY_SENTINEL",
    candidateTrace: [{
      id: "candidate_private",
      seed: 1,
      creativeAxis: "PRIVATE_AXIS_SENTINEL",
      event: "PRIVATE_EVENT_SENTINEL",
      cause: "PRIVATE_CAUSE_SENTINEL",
      cost: "PRIVATE_COST_SENTINEL",
      impact: "PRIVATE_IMPACT_SENTINEL",
      novelty: "PRIVATE_NOVELTY_SENTINEL",
      score: 1,
      status: "selected" as const,
      reasons: ["PRIVATE_REASON_SENTINEL"],
    }],
    filterSummary: "PRIVATE_FILTER_SENTINEL",
    contextTrace: [{ component: "canon" as const, sourceIds: ["PRIVATE_SOURCE_SENTINEL"], estimatedTokens: 20 }],
    retconId: "PRIVATE_RETCON_SENTINEL",
    targetEventId: "PRIVATE_EVENT_ID_SENTINEL",
  };
  const failure = createGenerationFailureObservation(
    job,
    new Error("PRIVATE_FAILURE_MESSAGE_SENTINEL"),
    { id: "failure_private", stage: "writer", terminal: true },
  );
  const scrubbedJob = sanitizeGenerationJobAfterStoryDeletion(job);
  const scrubbedFailure = sanitizeGenerationFailureAfterStoryDeletion(failure);
  const serialized = JSON.stringify([scrubbedJob, scrubbedFailure]);
  assert.equal(scrubbedJob.storyId, DELETED_STORY_PLACEHOLDER);
  assert.equal(scrubbedJob.storyTitle, DELETED_STORY_TITLE);
  assert.equal(scrubbedJob.chapterNumber, 0);
  for (const sentinel of ["PRIVATE_TITLE", "PRIVATE_IDEMPOTENCY", "PRIVATE_AXIS", "PRIVATE_EVENT", "PRIVATE_CAUSE", "PRIVATE_FILTER", "PRIVATE_SOURCE", "PRIVATE_RETCON", "PRIVATE_FAILURE_MESSAGE"]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
  assert.equal(scrubbedJob.model, job.model);
  assert.equal(scrubbedFailure.reasonCode, failure.reasonCode);
  assert.notEqual(scrubbedFailure.fingerprint, failure.fingerprint);
  assert.equal(scrubbedFailure.tokens, failure.tokens);
});

test("store deletion removes content, sanitizes operations, and supports rollback", () => {
  const store = createSeedStore();
  const story = store.stories[0]!;
  const owner = store.users.find((user) => user.id === story.ownerId)!;
  owner.activeStoryId = story.id;
  const baseJob = store.jobs[0]!;
  const job = { ...baseJob, id: "job_delete", storyId: story.id, storyTitle: story.title, status: "completed" as const };
  store.jobs.push(job);
  store.generationFailures.push(createGenerationFailureObservation(job, new Error("PRIVATE_FAILURE"), {
    id: "failure_delete",
    stage: "writer",
    terminal: true,
  }));
  store.safetyDecisions.push({
    id: "safety_delete",
    actorUserId: owner.id,
    storyId: story.id,
    surface: "chapter_output",
    decision: "allowed",
    categories: [],
    contentHash: "private_hash",
    createdAt: story.updatedAt,
  });
  store.contentReports.push({
    id: "report_delete",
    reporterUserId: owner.id,
    storyId: story.id,
    reason: "PRIVATE_REPORT_REASON",
    status: "submitted",
    createdAt: story.updatedAt,
    updatedAt: story.updatedAt,
  });
  store.storyCreationRequests.push({ userId: owner.id, storyId: story.id, idempotencyKey: "create_delete", createdAt: story.updatedAt });
  store.auditEvents.unshift(createAuditEvent(owner.id, "story.updated", "story", story.id, { privateField: "PRIVATE_AUDIT" }));
  store.auditEvents.unshift(createAuditEvent(owner.id, "generation.failed", "generation", job.id, {
    storyId: story.id,
    reason: "PRIVATE_GENERATION_REASON",
  }));
  const before = structuredClone(store);

  const audit = createStoryDeletionAudit(owner.id, "audit_delete", story.updatedAt, {
    wasCurrentStory: true,
    wasPublished: false,
    hadChapters: story.chapters.length > 0,
  });
  const rollback = applyStoryDeletionToStore(store, owner.id, story.id, audit);
  assert.equal(store.stories.some((candidate) => candidate.id === story.id), false);
  assert.equal(owner.activeStoryId, null);
  assert.equal(store.safetyDecisions.some((item) => item.storyId === story.id), false);
  assert.equal(store.contentReports.some((item) => item.storyId === story.id), false);
  assert.equal(store.storyCreationRequests.some((item) => item.storyId === story.id), false);
  assert.equal(JSON.stringify(store).includes("PRIVATE_AUDIT"), false);
  assert.equal(JSON.stringify(store).includes("PRIVATE_GENERATION_REASON"), false);
  assert.equal(store.auditEvents[0]?.action, "story.deleted");

  rollback();
  assert.deepEqual(store, before);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletion.test.ts
```

Expected: FAIL with `Cannot find module '../server/storyDeletion'`.

- [ ] **Step 3: Implement the domain module**

Create `server/storyDeletion.ts` with the complete public surface below. Keep optional operational fields only when they are explicitly allowed; do not spread the original job or failure into the returned value.

```ts
import { createHash } from "node:crypto";
import type {
  AppStore,
  AuditEvent,
  GenerationFailureObservation,
  GenerationJob,
} from "../src/types";

export const DELETED_STORY_PLACEHOLDER = "deleted";
export const DELETED_STORY_TITLE = "已删除故事";
export const DELETED_FAILURE_MESSAGE = "故事已删除；仅保留脱敏失败统计。";

export type StoryDeletionErrorCode =
  | "story_not_found"
  | "story_delete_confirmation_mismatch"
  | "story_delete_busy";

export interface PersistStoryDeletionInput {
  ownerId: string;
  storyId: string;
  confirmationTitle: string;
  auditId: string;
  deletedAt: string;
}

export interface StoryDeletionResult {
  wasCurrentStory: boolean;
  wasPublished: boolean;
  hadChapters: boolean;
}

export class StoryDeletionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: StoryDeletionErrorCode,
  ) {
    super(message);
    this.name = "StoryDeletionError";
  }
}

export function storyNotFoundError(): StoryDeletionError {
  return new StoryDeletionError("故事不存在或不属于当前账号。", 404, "story_not_found");
}

export function storyDeletionBusyError(): StoryDeletionError {
  return new StoryDeletionError("故事正在续写、修史、保存或等待审核；任务完成后再删除。", 409, "story_delete_busy");
}

export function assertStoryDeletionTitle(title: string, confirmationTitle: string): void {
  if (confirmationTitle.trim() !== title) {
    throw new StoryDeletionError("输入的故事标题不一致，未执行删除。", 400, "story_delete_confirmation_mismatch");
  }
}

export function hasActiveStoryWork(store: AppStore, storyId: string): boolean {
  return store.jobs.some((job) => job.storyId === storyId
    && (job.status === "running" || job.status === "awaiting_user_review"));
}

export function sanitizeGenerationJobAfterStoryDeletion(job: GenerationJob): GenerationJob {
  return {
    id: job.id,
    ownerId: job.ownerId,
    storyId: DELETED_STORY_PLACEHOLDER,
    storyTitle: DELETED_STORY_TITLE,
    chapterNumber: 0,
    task: job.task,
    model: job.model,
    connectionId: job.connectionId,
    promptVersion: job.promptVersion,
    status: job.status,
    tokens: job.tokens,
    ...(job.tokenBudget === undefined ? {} : { tokenBudget: job.tokenBudget }),
    ...(job.usageEstimated === undefined ? {} : { usageEstimated: job.usageEstimated }),
    ...(job.budgetDegraded === undefined ? {} : { budgetDegraded: job.budgetDegraded }),
    latencyMs: job.latencyMs,
    ...(job.firstTokenMs === undefined ? {} : { firstTokenMs: job.firstTokenMs }),
    cost: job.cost,
    ...(job.costEstimated === undefined ? {} : { costEstimated: job.costEstimated }),
    createdAt: job.createdAt,
    ...(job.acceptedAt ? { acceptedAt: job.acceptedAt } : {}),
    ...(job.rejectedAt ? { rejectedAt: job.rejectedAt } : {}),
    ...(job.acceptanceSignal ? { acceptanceSignal: job.acceptanceSignal } : {}),
  };
}

export function sanitizeGenerationFailureAfterStoryDeletion(
  failure: GenerationFailureObservation,
): GenerationFailureObservation {
  return {
    id: failure.id,
    jobId: failure.jobId,
    ownerId: failure.ownerId,
    storyId: DELETED_STORY_PLACEHOLDER,
    task: failure.task,
    stage: failure.stage,
    classifierVersion: failure.classifierVersion,
    category: failure.category,
    reasonCode: failure.reasonCode,
    message: DELETED_FAILURE_MESSAGE,
    fingerprint: createHash("sha256")
      .update([failure.classifierVersion, failure.category, failure.reasonCode, failure.stage].join("\u0000"))
      .digest("hex"),
    model: failure.model,
    connectionId: failure.connectionId,
    promptVersion: failure.promptVersion,
    attempt: failure.attempt,
    terminal: failure.terminal,
    retryable: failure.retryable,
    latencyMs: failure.latencyMs,
    tokens: failure.tokens,
    createdAt: failure.createdAt,
  };
}

export function sanitizeStoryAuditAfterDeletion(event: AuditEvent, storyId: string): AuditEvent {
  const referencesStory = event.targetId === storyId || event.metadata?.storyId === storyId;
  if (!referencesStory) return event;
  return { ...event, targetId: DELETED_STORY_PLACEHOLDER, metadata: { storyDeleted: true } };
}

export function createStoryDeletionAudit(
  ownerId: string,
  auditId: string,
  deletedAt: string,
  result: StoryDeletionResult,
): AuditEvent {
  return {
    id: auditId,
    actorUserId: ownerId,
    action: "story.deleted",
    targetType: "story",
    targetId: DELETED_STORY_PLACEHOLDER,
    createdAt: deletedAt,
    metadata: {
      storyDeleted: true,
      wasCurrentStory: result.wasCurrentStory,
      wasPublished: result.wasPublished,
      hadChapters: result.hadChapters,
    },
  };
}

export function applyStoryDeletionToStore(
  store: AppStore,
  ownerId: string,
  storyId: string,
  deletionAudit: AuditEvent,
): () => void {
  const before = structuredClone(store);
  store.stories = store.stories.filter((story) => story.id !== storyId || story.ownerId !== ownerId);
  for (const user of store.users) {
    if (user.activeStoryId === storyId) user.activeStoryId = null;
  }
  store.jobs = store.jobs.map((job) => job.storyId === storyId
    ? sanitizeGenerationJobAfterStoryDeletion(job)
    : job);
  store.generationFailures = store.generationFailures.map((failure) => failure.storyId === storyId
    ? sanitizeGenerationFailureAfterStoryDeletion(failure)
    : failure);
  store.safetyDecisions = store.safetyDecisions.filter((decision) => decision.storyId !== storyId);
  store.contentReports = store.contentReports.filter((report) => report.storyId !== storyId);
  store.storyCreationRequests = store.storyCreationRequests.filter((request) => request.storyId !== storyId);
  store.auditEvents = [
    deletionAudit,
    ...store.auditEvents.map((event) => sanitizeStoryAuditAfterDeletion(event, storyId)),
  ].slice(0, 500);
  return () => Object.assign(store, before);
}
```

- [ ] **Step 4: Run the domain tests and verify GREEN**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletion.test.ts
```

Expected: all four tests PASS, zero failures.

- [ ] **Step 5: Commit the domain unit**

```powershell
git add -- server/storyDeletion.ts tests/storyDeletion.test.ts
git commit -m "feat(story): define permanent deletion domain"
```

### Task 2: Implement atomic PostgreSQL deletion and stale-snapshot protection

**Files:**
- Create: `tests/storyDeletion.database.test.ts`
- Modify: `server/database/types.ts`
- Modify: `server/database/postgres.ts`

- [ ] **Step 1: Write a failing PostgreSQL integration test**

Create `tests/storyDeletion.database.test.ts`. Seed a dedicated target story and content-bearing linked rows, call `database.deleteOwnedStory`, then query every table directly:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createGenerationFailureObservation } from "../server/failureTelemetry";
import { PostgresDatabase } from "../server/database/postgres";
import { createSeedStore } from "../server/seed";
import { DELETED_STORY_PLACEHOLDER } from "../server/storyDeletion";
import { PGlite, PGliteExecutor } from "./helpers/pglite";

test("PostgreSQL permanently deletes content and retains only scrubbed operations", async () => {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  try {
    await database.migrate();
    const seed = createSeedStore();
    const story = seed.stories.find((candidate) => candidate.chapters.length > 0)!;
    const owner = seed.users.find((user) => user.id === story.ownerId)!;
    const reader = seed.users.find((user) => user.id !== owner.id)!;
    owner.activeStoryId = story.id;
    reader.activeStoryId = story.id;
    const job = {
      ...seed.jobs[0]!,
      id: "job_story_delete_db",
      ownerId: owner.id,
      storyId: story.id,
      storyTitle: "PRIVATE_TITLE_SENTINEL",
      status: "completed" as const,
      candidateTrace: [{
        id: "candidate_delete",
        seed: 1,
        creativeAxis: "PRIVATE_AXIS_SENTINEL",
        event: "PRIVATE_EVENT_SENTINEL",
        cause: "PRIVATE_CAUSE_SENTINEL",
        cost: "PRIVATE_COST_SENTINEL",
        impact: "PRIVATE_IMPACT_SENTINEL",
        novelty: "PRIVATE_NOVELTY_SENTINEL",
        score: 1,
        status: "selected" as const,
        reasons: ["PRIVATE_REASON_SENTINEL"],
      }],
      filterSummary: "PRIVATE_FILTER_SENTINEL",
    };
    seed.jobs.push(job);
    const failure = createGenerationFailureObservation(
      job,
      new Error("PRIVATE_FAILURE_SENTINEL"),
      { id: "failure_story_delete_db", stage: "writer", terminal: true },
    );
    seed.generationFailures.push(failure);
    seed.safetyDecisions.push({
      id: "safety_story_delete_db",
      actorUserId: owner.id,
      storyId: story.id,
      surface: "chapter_output",
      decision: "allowed",
      categories: [],
      contentHash: "PRIVATE_SAFETY_HASH",
      createdAt: story.updatedAt,
    });
    seed.contentReports.push({
      id: "report_story_delete_db",
      reporterUserId: reader.id,
      storyId: story.id,
      reason: "PRIVATE_REPORT_SENTINEL",
      status: "submitted",
      createdAt: story.updatedAt,
      updatedAt: story.updatedAt,
    });
    seed.storyCreationRequests.push({
      userId: owner.id,
      idempotencyKey: "create_story_delete_db",
      storyId: story.id,
      createdAt: story.updatedAt,
    });
    seed.auditEvents.unshift({
      id: "audit_story_reference_db", actorUserId: owner.id, action: "generation.failed",
      targetType: "generation", targetId: job.id, createdAt: story.updatedAt,
      metadata: { storyId: story.id, reason: "PRIVATE_AUDIT_REASON_SENTINEL" },
    });

    await database.saveSnapshot(seed);

    await pglite.query(
      `INSERT INTO xumo_story_publications(story_id, owner_id, status, first_published_at, status_updated_at)
       VALUES ($1, $2, 'active', now(), now())`,
      [story.id, owner.id],
    );
    await pglite.query(
      `INSERT INTO xumo_public_reading_progress(
         reader_user_id, story_id, chapter_id, chapter_number, scroll_progress, progress_version, updated_at
       ) VALUES ($1, $2, $3, 1, 0.5, 1, now())`,
      [reader.id, story.id, story.chapters[0]!.id],
    );
    await pglite.query(
      `INSERT INTO xumo_narration_review_cases(
         id, job_id, owner_id, content_hash, attempt, rewrite_count, status, version,
         deadline_at, payload_expires_at, candidate_metadata, assessment_metadata,
         encrypted_payload, created_at, resolved_at
       ) VALUES (
         'case_story_delete_db', $1, $2, repeat('a', 64), 1, 0, 'resolved', 1,
         now(), now(), '[]'::jsonb, '[]'::jsonb,
         '{"version":1,"iv":"PRIVATE_IV","tag":"PRIVATE_TAG","ciphertext":"PRIVATE_CIPHERTEXT"}'::jsonb,
         now(), now()
       )`,
      [job.id, owner.id],
    );
    await pglite.query(
      `INSERT INTO xumo_narration_review_feedback(
         id, case_id, job_id, owner_id, candidate_id, rule_id, rule_version, location, model,
         reported_decision, decision, confidence, threshold, resolution_source, user_decision,
         rewrite_count, rewrite_succeeded, job_completed, latency_ms, content_hash,
         consented_excerpt_ciphertext, excerpt_expires_at, created_at, updated_at
       ) VALUES (
         'feedback_story_delete_db', 'case_story_delete_db', $1, $2, 'candidate', 'rule', 'v1', 'body', 'model',
         'allow', 'allow', 0.9, 0.85, 'user', 'keep', 0, true, true, 12, repeat('b', 64),
         '{"version":1,"iv":"PRIVATE_IV","tag":"PRIVATE_TAG","ciphertext":"PRIVATE_EXCERPT"}'::jsonb,
         now(), now(), now()
       )`,
      [job.id, owner.id],
    );

    const hasDeletionCode = (expected: string) => (error: unknown) =>
      error instanceof Error && "code" in error && error.code === expected;
    await assert.rejects(
      database.deleteOwnedStory({
        ownerId: reader.id,
        storyId: story.id,
        confirmationTitle: story.title,
        auditId: "audit_wrong_owner",
        deletedAt: "2026-07-30T09:57:00.000Z",
      }),
      hasDeletionCode("story_not_found"),
    );
    await assert.rejects(
      database.deleteOwnedStory({
        ownerId: owner.id,
        storyId: story.id,
        confirmationTitle: "错误标题",
        auditId: "audit_wrong_title",
        deletedAt: "2026-07-30T09:58:00.000Z",
      }),
      hasDeletionCode("story_delete_confirmation_mismatch"),
    );
    await pglite.query("UPDATE xumo_generation_jobs SET status = 'running' WHERE id = $1", [job.id]);
    await assert.rejects(
      database.deleteOwnedStory({
        ownerId: owner.id,
        storyId: story.id,
        confirmationTitle: story.title,
        auditId: "audit_busy_story",
        deletedAt: "2026-07-30T09:59:00.000Z",
      }),
      hasDeletionCode("story_delete_busy"),
    );
    await pglite.query("UPDATE xumo_generation_jobs SET status = 'completed' WHERE id = $1", [job.id]);

    const result = await database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: "audit_story_delete_db",
      deletedAt: "2026-07-30T10:00:00.000Z",
    });
    assert.deepEqual(result, { wasCurrentStory: true, wasPublished: true, hadChapters: true });

    const requiredDeletedCounts = await Promise.all([
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_stories WHERE id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_chapters WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_chapter_revisions WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_story_publications WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_public_reading_progress WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_story_creation_requests WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_safety_decisions WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_content_reports WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_narration_review_cases WHERE id = 'case_story_delete_db'"),
    ]);
    assert.deepEqual(
      requiredDeletedCounts.map((query) => Number(query.rows[0]?.count ?? 0)),
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    const savedJob = await pglite.query<{ story_id: string; payload: unknown }>(
      "SELECT story_id, payload FROM xumo_generation_jobs WHERE id = $1",
      [job.id],
    );
    const savedFailure = await pglite.query<{ story_id: string; fingerprint: string; payload: unknown }>(
      "SELECT story_id, fingerprint, payload FROM xumo_generation_failure_observations WHERE id = $1",
      ["failure_story_delete_db"],
    );
    const retained = JSON.stringify([savedJob.rows[0], savedFailure.rows[0]]);
    assert.equal(savedJob.rows[0]?.story_id, DELETED_STORY_PLACEHOLDER);
    assert.equal(savedFailure.rows[0]?.story_id, DELETED_STORY_PLACEHOLDER);
    assert.notEqual(savedFailure.rows[0]?.fingerprint, failure.fingerprint);
    assert.equal(JSON.stringify(savedFailure.rows[0]).includes(failure.fingerprint), false);
    for (const sentinel of ["PRIVATE_TITLE", "PRIVATE_AXIS", "PRIVATE_EVENT", "PRIVATE_FILTER", "PRIVATE_FAILURE"]) {
      assert.equal(retained.includes(sentinel), false, sentinel);
    }
    const feedback = await pglite.query<{ case_id: string | null; content_hash: string; consented_excerpt_ciphertext: unknown }>(
      "SELECT case_id, content_hash, consented_excerpt_ciphertext FROM xumo_narration_review_feedback WHERE id = 'feedback_story_delete_db'",
    );
    assert.equal(feedback.rows[0]?.case_id, null);
    assert.equal(feedback.rows[0]?.consented_excerpt_ciphertext, null);
    assert.match(feedback.rows[0]?.content_hash ?? "", /^[0-9a-f]{64}$/u);
    assert.notEqual(feedback.rows[0]?.content_hash, "b".repeat(64));
    const users = await pglite.query<{ id: string; active_story_id: string | null }>(
      "SELECT id, active_story_id FROM xumo_users WHERE id IN ($1, $2) ORDER BY id",
      [owner.id, reader.id],
    );
    assert.equal(users.rows.length, 2);
    assert.equal(users.rows.every((row) => row.active_story_id === null), true);
    const audit = await pglite.query<{ action: string; target_id: string; payload: unknown }>(
      "SELECT action, target_id, payload FROM xumo_audit_events WHERE id = 'audit_story_delete_db'",
    );
    assert.equal(audit.rows[0]?.action, "story.deleted");
    assert.equal(audit.rows[0]?.target_id, DELETED_STORY_PLACEHOLDER);
    assert.equal(JSON.stringify(audit.rows[0]).includes(story.title), false);
    const existingAudit = await pglite.query<{ target_id: string; payload: unknown }>(
      "SELECT target_id, payload FROM xumo_audit_events WHERE id = 'audit_story_reference_db'",
    );
    assert.equal(existingAudit.rows[0]?.target_id, DELETED_STORY_PLACEHOLDER);
    const existingAuditJson = JSON.stringify(existingAudit.rows[0]);
    assert.equal(existingAuditJson.includes("PRIVATE_AUDIT_REASON_SENTINEL"), false);
    assert.equal(existingAuditJson.includes(story.id), false);
  } finally {
    await database.close();
  }
});
```

- [ ] **Step 2: Add explicit rollback and stale-snapshot tests**

In the same file, add a controllable executor wrapper. It must delegate migrations and normal saves, then throw only when armed and the deletion transaction reaches `DELETE FROM xumo_stories`:

```ts
import type { DatabaseExecutor, QueryResult } from "../server/database/types";

interface FailureState { armed: boolean; }

class ArmedFailingExecutor implements DatabaseExecutor {
  constructor(
    private readonly inner: DatabaseExecutor,
    readonly failureState: FailureState = { armed: false },
  ) {}
  query<Row = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<QueryResult<Row>> {
    if (this.failureState.armed && /DELETE FROM xumo_stories/u.test(sql)) {
      throw new Error("injected story deletion failure");
    }
    return this.inner.query<Row>(sql, parameters);
  }
  execute(sql: string): Promise<void> { return this.inner.execute(sql); }
  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.inner.transaction((executor) => work(new ArmedFailingExecutor(executor, this.failureState)));
  }
  close(): Promise<void> { return this.inner.close(); }
}
```

Use the wrapper in this complete rollback test:

```ts
test("PostgreSQL deletion rolls back every earlier write when story deletion fails", async () => {
  const pglite = new PGlite();
  const failing = new ArmedFailingExecutor(new PGliteExecutor(pglite));
  const database = new PostgresDatabase(failing);
  try {
    await database.migrate();
    const seed = createSeedStore();
    const story = seed.stories.find((candidate) => candidate.chapters.length > 0)!;
    const owner = seed.users.find((user) => user.id === story.ownerId)!;
    const reader = seed.users.find((user) => user.id !== owner.id)!;
    const job = {
      ...seed.jobs[0]!,
      id: "job_delete_rollback",
      ownerId: owner.id,
      storyId: story.id,
      storyTitle: "PRIVATE_TITLE_SENTINEL",
      status: "completed" as const,
    };
    seed.jobs.push(job);
    await database.saveSnapshot(seed);
    await pglite.query(
      `INSERT INTO xumo_story_publications(story_id, owner_id, status, first_published_at, status_updated_at)
       VALUES ($1, $2, 'active', now(), now())`,
      [story.id, owner.id],
    );
    await pglite.query(
      `INSERT INTO xumo_public_reading_progress(
         reader_user_id, story_id, chapter_id, chapter_number, scroll_progress, progress_version, updated_at
       ) VALUES ($1, $2, $3, 1, 0.5, 1, now())`,
      [reader.id, story.id, story.chapters[0]!.id],
    );
    const chapterCountBefore = story.chapters.length;
    failing.failureState.armed = true;

    await assert.rejects(
      database.deleteOwnedStory({
        ownerId: owner.id,
        storyId: story.id,
        confirmationTitle: story.title,
        auditId: "audit_delete_rollback",
        deletedAt: "2026-07-30T10:00:00.000Z",
      }),
      /injected story deletion failure/u,
    );

    const remaining = await Promise.all([
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_stories WHERE id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_chapters WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_story_publications WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_public_reading_progress WHERE story_id = $1", [story.id]),
    ]);
    assert.deepEqual(
      remaining.map((query) => Number(query.rows[0]?.count ?? 0)),
      [1, chapterCountBefore, 1, 1],
    );
    const retainedJob = await pglite.query<{ payload: unknown }>(
      "SELECT payload FROM xumo_generation_jobs WHERE id = $1",
      [job.id],
    );
    assert.equal(JSON.stringify(retainedJob.rows[0]).includes("PRIVATE_TITLE_SENTINEL"), true);
  } finally {
    await database.close();
  }
});
```

The failure is injected at the final story `DELETE`, after the earlier cleanup statements have run. The unchanged story, job, publication and progress rows therefore prove transaction-wide rollback rather than an early validation failure.

For the stale-snapshot test, add this deferred executor. The shared state must be passed into transaction children exactly as shown:

```ts
interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface DeleteGateState {
  reached: Deferred;
  release: Deferred;
  blocked: boolean;
}

class StoryDeleteGateExecutor implements DatabaseExecutor {
  constructor(
    private readonly inner: DatabaseExecutor,
    readonly gate: DeleteGateState = {
      reached: deferred(),
      release: deferred(),
      blocked: false,
    },
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row>> {
    if (!this.gate.blocked && /DELETE FROM xumo_stories/u.test(sql)) {
      this.gate.blocked = true;
      this.gate.reached.resolve();
      await this.gate.release.promise;
    }
    return this.inner.query<Row>(sql, parameters);
  }

  execute(sql: string): Promise<void> { return this.inner.execute(sql); }
  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.inner.transaction((executor) => work(new StoryDeleteGateExecutor(executor, this.gate)));
  }
  close(): Promise<void> { return this.inner.close(); }
}
```

Add the complete deterministic stale-snapshot test below. It covers every story-linked collection that `saveSnapshot` can otherwise reinsert:

```ts
test("a stale snapshot queued during deletion cannot reinsert private story data", async () => {
  const pglite = new PGlite();
  const gateExecutor = new StoryDeleteGateExecutor(new PGliteExecutor(pglite));
  const database = new PostgresDatabase(gateExecutor);
  try {
    await database.migrate();
    const seed = createSeedStore();
    const story = seed.stories.find((candidate) => candidate.chapters.length > 0)!;
    const owner = seed.users.find((user) => user.id === story.ownerId)!;
    const reader = seed.users.find((user) => user.id !== owner.id)!;
    owner.activeStoryId = story.id;
    const job = {
      ...seed.jobs[0]!,
      id: "job_stale_story_delete",
      ownerId: owner.id,
      storyId: story.id,
      storyTitle: "PRIVATE_STALE_TITLE_SENTINEL",
      status: "completed" as const,
      filterSummary: "PRIVATE_STALE_FILTER_SENTINEL",
    };
    seed.jobs.push(job);
    seed.generationFailures.push(createGenerationFailureObservation(
      job,
      new Error("PRIVATE_STALE_FAILURE_SENTINEL"),
      { id: "failure_stale_story_delete", stage: "writer", terminal: true },
    ));
    seed.safetyDecisions.push({
      id: "safety_stale_story_delete",
      actorUserId: owner.id,
      storyId: story.id,
      surface: "chapter_output",
      decision: "allowed",
      categories: [],
      contentHash: "PRIVATE_STALE_HASH_SENTINEL",
      createdAt: story.updatedAt,
    });
    seed.contentReports.push({
      id: "report_stale_story_delete",
      reporterUserId: reader.id,
      storyId: story.id,
      reason: "PRIVATE_STALE_REPORT_SENTINEL",
      status: "submitted",
      createdAt: story.updatedAt,
      updatedAt: story.updatedAt,
    });
    seed.storyCreationRequests.push({
      userId: owner.id,
      storyId: story.id,
      idempotencyKey: "PRIVATE_STALE_REQUEST_SENTINEL",
      createdAt: story.updatedAt,
    });
    seed.auditEvents.unshift({
      id: "audit_stale_story_reference",
      actorUserId: owner.id,
      action: "generation.failed",
      targetType: "generation",
      targetId: job.id,
      createdAt: story.updatedAt,
      metadata: { storyId: story.id, reason: "PRIVATE_STALE_AUDIT_SENTINEL" },
    });
    await database.saveSnapshot(seed);

    const deletion = database.deleteOwnedStory({
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
      auditId: "audit_stale_snapshot_delete",
      deletedAt: "2026-07-30T10:00:00.000Z",
    });
    await gateExecutor.gate.reached.promise;
    const staleSave = database.saveSnapshot(structuredClone(seed));
    gateExecutor.gate.release.resolve();
    await Promise.all([deletion, staleSave]);

    const forbiddenCounts = await Promise.all([
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_stories WHERE id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_safety_decisions WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_content_reports WHERE story_id = $1", [story.id]),
      pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_story_creation_requests WHERE story_id = $1", [story.id]),
    ]);
    assert.deepEqual(
      forbiddenCounts.map((query) => Number(query.rows[0]?.count ?? 0)),
      [0, 0, 0, 0],
    );
    const retainedJob = await pglite.query<{ story_id: string; payload: unknown }>(
      "SELECT story_id, payload FROM xumo_generation_jobs WHERE id = $1",
      [job.id],
    );
    const retainedFailure = await pglite.query<{ story_id: string; payload: unknown }>(
      "SELECT story_id, payload FROM xumo_generation_failure_observations WHERE id = 'failure_stale_story_delete'",
    );
    const retainedAudit = await pglite.query<{ target_id: string; payload: unknown }>(
      "SELECT target_id, payload FROM xumo_audit_events WHERE id = 'audit_stale_story_reference'",
    );
    const savedOwner = await pglite.query<{ active_story_id: string | null }>(
      "SELECT active_story_id FROM xumo_users WHERE id = $1",
      [owner.id],
    );
    const retained = JSON.stringify([retainedJob.rows[0], retainedFailure.rows[0], retainedAudit.rows[0]]);
    assert.equal(retainedJob.rows[0]?.story_id, DELETED_STORY_PLACEHOLDER);
    assert.equal(retainedFailure.rows[0]?.story_id, DELETED_STORY_PLACEHOLDER);
    assert.equal(retainedAudit.rows[0]?.target_id, DELETED_STORY_PLACEHOLDER);
    assert.equal(savedOwner.rows[0]?.active_story_id, null);
    assert.equal(retained.includes("PRIVATE_STALE_"), false);
    assert.equal(retained.includes(story.id), false);
  } finally {
    gateExecutor.gate.release.resolve();
    await database.close();
  }
});
```

Do not use timers or catch-and-default query results: waiting on `gate.reached.promise` proves the snapshot is captured while the delete transaction is paused, and every SQL/query failure must fail the test.

- [ ] **Step 3: Run the database tests and verify RED**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletion.database.test.ts
```

Expected: FAIL because `PersistenceDatabase` and `PostgresDatabase` do not yet expose `deleteOwnedStory`.

- [ ] **Step 4: Extend the database interface**

In `server/database/types.ts`, import the two deletion types and add the method:

```ts
import type { PersistStoryDeletionInput, StoryDeletionResult } from "../storyDeletion";

export interface PersistenceDatabase {
  // existing methods remain unchanged
  deleteOwnedStory(input: PersistStoryDeletionInput): Promise<StoryDeletionResult>;
}
```

- [ ] **Step 5: Add queue and tombstone guards to PostgreSQL**

In `PostgresDatabase`, add a persistent process-level tombstone set and a value-returning queue helper:

```ts
private readonly deletedStoryIds = new Set<string>();

private async enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
  let result!: T;
  const task = this.saveQueue.catch(() => undefined).then(async () => {
    result = await work();
  });
  this.saveQueue = task;
  await task;
  return result;
}
```

At execution time inside `saveSnapshot`, guard stale snapshots with `deletedStoryIds`:

```ts
const persistedUser = user.activeStoryId && this.deletedStoryIds.has(user.activeStoryId)
  ? { ...user, activeStoryId: null }
  : user;

if (this.deletedStoryIds.has(story.id)) continue;

const persistedJob = this.deletedStoryIds.has(job.storyId)
  ? sanitizeGenerationJobAfterStoryDeletion(job)
  : job;

const persistedFailure = this.deletedStoryIds.has(failure.storyId)
  ? sanitizeGenerationFailureAfterStoryDeletion(failure)
  : failure;

if (decision.storyId && this.deletedStoryIds.has(decision.storyId)) continue;
if (report.storyId && this.deletedStoryIds.has(report.storyId)) continue;
if (this.deletedStoryIds.has(request.storyId)) continue;

const persistedAudit = [...this.deletedStoryIds].reduce(
  (current, deletedStoryId) => sanitizeStoryAuditAfterDeletion(current, deletedStoryId),
  event,
);
```

Use each `persisted*` value for the SQL payload and `marks`, not the stale original. This is required even when the stale snapshot was captured before deletion but executes afterward.

- [ ] **Step 6: Implement the PostgreSQL deletion transaction**

Add `deleteOwnedStory` to `PostgresDatabase`. Use parameterized SQL and the shared scrubbers; never perform JSONB key subtraction alone because a newly added private field could escape the denylist.

```ts
async deleteOwnedStory(input: PersistStoryDeletionInput): Promise<StoryDeletionResult> {
  const result = await this.enqueueMutation(async () => {
    this.deletedStoryIds.add(input.storyId);
    try {
      return await this.executor.transaction(async (transaction) => {
        const storyRows = await transaction.query<{
          title: string;
          chapter_count: number;
          was_current: boolean;
          was_published: boolean;
        }>(
          `SELECT s.title, s.chapter_count,
                  (u.active_story_id = s.id) AS was_current,
                  EXISTS (
                    SELECT 1 FROM xumo_story_publications p
                    WHERE p.story_id = s.id AND p.status = 'active'
                  ) AS was_published
           FROM xumo_stories s
           JOIN xumo_users u ON u.id = s.owner_id
           WHERE s.id = $1 AND s.owner_id = $2
           FOR UPDATE OF s, u`,
          [input.storyId, input.ownerId],
        );
        const row = storyRows.rows[0];
        if (!row) throw storyNotFoundError();
        assertStoryDeletionTitle(row.title, input.confirmationTitle);

        const busy = await transaction.query(
          `SELECT 1 FROM xumo_generation_jobs
           WHERE story_id = $1 AND status IN ('running', 'awaiting_user_review')
           LIMIT 1`,
          [input.storyId],
        );
        if (busy.rowCount > 0) throw storyDeletionBusyError();

        const feedbackRows = await transaction.query<{ id: string }>(
          `SELECT id FROM xumo_narration_review_feedback
           WHERE job_id IN (SELECT id FROM xumo_generation_jobs WHERE story_id = $1)`,
          [input.storyId],
        );
        for (const feedbackRow of feedbackRows.rows) {
          await transaction.query(
            `UPDATE xumo_narration_review_feedback
             SET content_hash = $2, consented_excerpt_ciphertext = NULL, excerpt_expires_at = NULL WHERE id = $1`,
            [feedbackRow.id, fingerprint({ deletedNarrationFeedbackId: feedbackRow.id })],
          );
        }
        await transaction.query(
          `DELETE FROM xumo_narration_review_cases
           WHERE job_id IN (SELECT id FROM xumo_generation_jobs WHERE story_id = $1)`,
          [input.storyId],
        );

        const jobs = await transaction.query<{ id: string; payload: unknown }>(
          "SELECT id, payload FROM xumo_generation_jobs WHERE story_id = $1",
          [input.storyId],
        );
        for (const jobRow of jobs.rows) {
          const job = sanitizeGenerationJobAfterStoryDeletion(parseJson<GenerationJob>(jobRow.payload));
          await transaction.query(
            "UPDATE xumo_generation_jobs SET story_id = $2, payload = $3::jsonb WHERE id = $1",
            [jobRow.id, DELETED_STORY_PLACEHOLDER, stableJson(job)],
          );
        }

        const failures = await transaction.query<{ id: string; payload: unknown }>(
          "SELECT id, payload FROM xumo_generation_failure_observations WHERE story_id = $1",
          [input.storyId],
        );
        for (const failureRow of failures.rows) {
          const failure = sanitizeGenerationFailureAfterStoryDeletion(
            parseJson<GenerationFailureObservation>(failureRow.payload),
          );
          await transaction.query(
            `UPDATE xumo_generation_failure_observations
             SET story_id = $2, fingerprint = $3, payload = $4::jsonb WHERE id = $1`,
            [failureRow.id, DELETED_STORY_PLACEHOLDER, failure.fingerprint, stableJson(failure)],
          );
        }

        await transaction.query("DELETE FROM xumo_safety_decisions WHERE story_id = $1", [input.storyId]);
        await transaction.query("DELETE FROM xumo_content_reports WHERE story_id = $1", [input.storyId]);
        const affectedAudits = await transaction.query<AuditRow>(
          `SELECT id, actor_user_id, action, target_type, target_id, created_at, payload
           FROM xumo_audit_events
           WHERE target_id = $1
              OR payload #>> '{metadata,storyId}' = $1
              OR payload ->> 'storyId' = $1`,
          [input.storyId],
        );
        for (const auditRow of affectedAudits.rows) {
          const event = sanitizeStoryAuditAfterDeletion(toAuditEvent(auditRow), input.storyId);
          await transaction.query(
            "UPDATE xumo_audit_events SET target_id = $2, payload = $3::jsonb WHERE id = $1",
            [auditRow.id, event.targetId, stableJson(event)],
          );
        }
        await transaction.query(
          "UPDATE xumo_users SET active_story_id = NULL WHERE active_story_id = $1",
          [input.storyId],
        );
        await transaction.query(
          "DELETE FROM xumo_stories WHERE id = $1 AND owner_id = $2",
          [input.storyId, input.ownerId],
        );

        const deletionResult: StoryDeletionResult = {
          wasCurrentStory: row.was_current,
          wasPublished: row.was_published,
          hadChapters: row.chapter_count > 0,
        };
        await this.upsertAudit(
          transaction,
          createStoryDeletionAudit(input.ownerId, input.auditId, input.deletedAt, deletionResult),
        );
        return deletionResult;
      });
    } catch (error) {
      this.deletedStoryIds.delete(input.storyId);
      throw error;
    }
  });
  this.fingerprints.delete(`story:${input.storyId}`);
  return result;
}
```

Import every referenced type and helper explicitly. Keep the tombstone after success for the process lifetime; do not remove it after the transaction commits.

- [ ] **Step 7: Run PostgreSQL deletion and existing database tests**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletion.database.test.ts tests/database.test.ts tests/publicStorySharing.database.test.ts
```

Expected: all tests PASS; no migration checksum changes.

- [ ] **Step 8: Commit the PostgreSQL unit**

```powershell
git add -- server/database/types.ts server/database/postgres.ts tests/storyDeletion.database.test.ts
git commit -m "feat(story): delete stories transactionally"
```

### Task 3: Wire storage orchestration and JSON rollback

**Files:**
- Modify: `server/storage.ts`
- Modify: `tests/storyDeletion.test.ts`

- [ ] **Step 1: Add failing storage-orchestration tests**

Extend `tests/storyDeletion.test.ts` with a save callback harness. Test success and injected file-write failure without touching the real `server/data/store.json`:

```ts
test("JSON deletion rollback restores the full pre-delete store after persistence failure", async () => {
  const store = createSeedStore();
  const story = store.stories[0]!;
  const owner = store.users.find((user) => user.id === story.ownerId)!;
  owner.activeStoryId = story.id;
  const before = structuredClone(store);
  const deleteStory = createStoryDeletionStorage({
    getDatabase: () => null,
    save: createStoreSaveQueue(async () => {
      throw new Error("injected JSON persistence failure");
    }),
    now: () => "2026-07-30T10:00:00.000Z",
    createAuditId: () => "audit_json_rollback",
  });

  await assert.rejects(
    deleteStory(store, {
      ownerId: owner.id,
      storyId: story.id,
      confirmationTitle: story.title,
    }),
    /injected JSON persistence failure/u,
  );
  assert.deepEqual(store, before);
});
```

Import `createStoryDeletionStorage` and `createStoreSaveQueue` from `server/storage`, then add the success-path isolation test:

```ts
test("JSON deletion preserves unrelated records and persists only scrubbed target operations", async () => {
  const store = createSeedStore();
  const story = store.stories[0]!;
  const owner = store.users.find((user) => user.id === story.ownerId)!;
  owner.activeStoryId = story.id;
  const targetJob = {
    ...store.jobs[0]!,
    id: "job_json_delete",
    ownerId: owner.id,
    storyId: story.id,
    storyTitle: "PRIVATE_JSON_TITLE_SENTINEL",
    status: "completed" as const,
  };
  store.jobs.push(targetJob);

  type Store = ReturnType<typeof createSeedStore>;
  const unaffectedState = (candidate: Store) => ({
    users: candidate.users.filter((user) => user.activeStoryId !== story.id),
    sessions: candidate.sessions,
    stories: candidate.stories.filter((item) => item.id !== story.id),
    connections: candidate.connections,
    jobs: candidate.jobs.filter((job) => job.storyId !== story.id && job.id !== targetJob.id),
    generationFailures: candidate.generationFailures.filter((failure) => failure.storyId !== story.id),
    auditEvents: candidate.auditEvents.filter(
      (event) => event.targetId !== story.id && event.metadata?.storyId !== story.id,
    ),
    safetyDecisions: candidate.safetyDecisions.filter((decision) => decision.storyId !== story.id),
    contentReports: candidate.contentReports.filter((report) => report.storyId !== story.id),
    idempotencyKeys: candidate.idempotencyKeys,
    storyCreationRequests: candidate.storyCreationRequests.filter((request) => request.storyId !== story.id),
  });
  const before = structuredClone(unaffectedState(store));
  let persistedSnapshot: Store | null = null;
  const deleteStory = createStoryDeletionStorage({
    getDatabase: () => null,
    save: createStoreSaveQueue(async (snapshot) => {
      persistedSnapshot = JSON.parse(snapshot) as Store;
    }),
    now: () => "2026-07-30T10:00:00.000Z",
    createAuditId: () => "audit_json_success",
  });

  await deleteStory(store, {
    ownerId: owner.id,
    storyId: story.id,
    confirmationTitle: story.title,
  });

  assert.ok(persistedSnapshot);
  assert.deepEqual(unaffectedState(store), before);
  assert.deepEqual(unaffectedState(persistedSnapshot), before);
  for (const candidateStore of [store, persistedSnapshot]) {
    assert.equal(candidateStore.stories.some((item) => item.id === story.id), false);
    const savedJob = candidateStore.jobs.find((job) => job.id === targetJob.id);
    assert.equal(savedJob?.storyId, DELETED_STORY_PLACEHOLDER);
    assert.equal(JSON.stringify(savedJob).includes("PRIVATE_JSON_TITLE_SENTINEL"), false);
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletion.test.ts
```

Expected: the existing domain tests pass; the new orchestration test fails until storage exposes the final coordinator and rollback wiring.

- [ ] **Step 3: Implement the unified storage coordinator**

Add this exported function to `server/storage.ts`. Generate the audit ID and timestamp once so PostgreSQL and runtime memory receive the same deletion event.

```ts
import { createHash, randomUUID } from "node:crypto";
import {
  applyStoryDeletionToStore,
  assertStoryDeletionTitle,
  createStoryDeletionAudit,
  hasActiveStoryWork,
  storyDeletionBusyError,
  storyNotFoundError,
  type PersistStoryDeletionInput,
  type StoryDeletionResult,
} from "./storyDeletion";

type StoryDeletionCommand =
  Pick<PersistStoryDeletionInput, "ownerId" | "storyId" | "confirmationTitle">;

interface StoryDeletionStorageDependencies {
  getDatabase(): PersistenceDatabase | null;
  save(store: AppStore, rollbackOnFailure?: () => void): Promise<void>;
  now(): string;
  createAuditId(): string;
}

export function createStoryDeletionStorage(dependencies: StoryDeletionStorageDependencies) {
  return async (
    store: AppStore,
    input: StoryDeletionCommand,
  ): Promise<StoryDeletionResult> => {
    const persistence = dependencies.getDatabase();
    const cachedStory = store.stories.find(
      (story) => story.id === input.storyId && story.ownerId === input.ownerId,
    );
    const story = cachedStory
      ?? (persistence ? await persistence.loadStory(input.ownerId, input.storyId) : null);
    if (!story) throw storyNotFoundError();
    assertStoryDeletionTitle(story.title, input.confirmationTitle);
    if (hasActiveStoryWork(store, input.storyId)) throw storyDeletionBusyError();

    const persistenceInput: PersistStoryDeletionInput = {
      ...input,
      auditId: dependencies.createAuditId(),
      deletedAt: dependencies.now(),
    };

    if (persistence) {
      const result = await persistence.deleteOwnedStory(persistenceInput);
      applyStoryDeletionToStore(
        store,
        input.ownerId,
        input.storyId,
        createStoryDeletionAudit(input.ownerId, persistenceInput.auditId, persistenceInput.deletedAt, result),
      );
      return result;
    }

    const owner = store.users.find((user) => user.id === input.ownerId);
    const result: StoryDeletionResult = {
      wasCurrentStory: owner?.activeStoryId === input.storyId,
      wasPublished: false,
      hadChapters: story.chapters.length > 0,
    };
    const rollback = applyStoryDeletionToStore(
      store,
      input.ownerId,
      input.storyId,
      createStoryDeletionAudit(input.ownerId, persistenceInput.auditId, persistenceInput.deletedAt, result),
    );
    await dependencies.save(store, rollback);
    return result;
  };
}

export const deleteOwnedStory = createStoryDeletionStorage({
  getDatabase: () => database,
  save: saveStore,
  now: () => new Date().toISOString(),
  createAuditId: () => `audit_${randomUUID().slice(0, 10)}`,
});
```

Do not call `saveStore` after the PostgreSQL transaction; the database method has already committed all SQL changes, and the runtime mutation only aligns the in-process cache.

- [ ] **Step 4: Run storage and database tests**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletion.test.ts tests/storyDeletion.database.test.ts tests/database.test.ts
```

Expected: PASS with zero writes to the real JSON store.

- [ ] **Step 5: Commit the storage coordinator**

```powershell
git add -- server/storage.ts tests/storyDeletion.test.ts
git commit -m "feat(story): coordinate permanent deletion storage"
```

### Task 4: Add the authenticated deletion route

**Files:**
- Create: `server/storyDeletionRoutes.ts`
- Create: `tests/storyDeletionRoutes.test.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Write failing HTTP route tests**

Create `tests/storyDeletionRoutes.test.ts` with the complete isolated Express harness and cases below:

```ts
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createReaderAccount } from "../server/auth";
import {
  createStoryDeletionRouter,
  type StoryDeletionRouterOptions,
} from "../server/storyDeletionRoutes";
import {
  assertStoryDeletionTitle,
  storyNotFoundError,
} from "../server/storyDeletion";
import type { UserAccount } from "../src/types";

const owner: UserAccount = {
  ...createReaderAccount("owner@example.com", "correct-horse-battery", "作者"),
  id: "user_owner",
};

interface DeletionHarness {
  baseUrl: string;
  close(): Promise<void>;
}

async function startDeletionHarness(options: {
  user?: UserAccount | null;
  storyMutationLocks?: Set<string>;
  deleteStory?: StoryDeletionRouterOptions["deleteStory"];
} = {}): Promise<DeletionHarness> {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use((_request, response, next) => {
    if (options.user !== null) response.locals.user = options.user ?? owner;
    next();
  });
  app.use("/api", createStoryDeletionRouter({
    storyMutationLocks: options.storyMutationLocks ?? new Set<string>(),
    deleteStory: options.deleteStory ?? (async () => undefined),
  }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "提交内容不完整或格式不正确。" });
      return;
    }
    const status = error instanceof Error
      && "status" in error
      && typeof error.status === "number"
      ? error.status
      : 500;
    const code = error instanceof Error
      && "code" in error
      && typeof error.code === "string"
      ? error.code
      : undefined;
    response.status(status).json({
      message: error instanceof Error ? error.message : "服务器处理失败。",
      ...(code ? { code } : {}),
    });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function requestDelete(
  harness: DeletionHarness,
  storyId: string,
  confirmationTitle: string,
): Promise<globalThis.Response> {
  return fetch(`${harness.baseUrl}/api/stories/${encodeURIComponent(storyId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmationTitle }),
  });
}

test("DELETE /api/stories/:id requires authentication", async () => {
  const harness = await startDeletionHarness({ user: null });
  try {
    const response = await fetch(`${harness.baseUrl}/api/stories/story_a`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationTitle: "故事 A" }),
    });
    assert.equal(response.status, 401);
  } finally { await harness.close(); }
});

test("DELETE validates title, maps stable codes, and returns 204", async () => {
  const calls: unknown[] = [];
  const harness = await startDeletionHarness({
    deleteStory: async (input) => {
      assertStoryDeletionTitle("故事 A", input.confirmationTitle);
      calls.push(input);
    },
  });
  try {
    const invalid = await requestDelete(harness, "story_a", "");
    assert.equal(invalid.status, 400);
    const mismatch = await requestDelete(harness, "story_a", "故事 B");
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).code, "story_delete_confirmation_mismatch");
    const success = await requestDelete(harness, "story_a", "故事 A");
    assert.equal(success.status, 204);
    assert.equal(await success.text(), "");
    assert.deepEqual(calls, [{ ownerId: "user_owner", storyId: "story_a", confirmationTitle: "故事 A" }]);
  } finally { await harness.close(); }
});

test("DELETE rejects an in-process busy story and always releases its lock", async () => {
  const locks = new Set(["story_a"]);
  const busyHarness = await startDeletionHarness({ storyMutationLocks: locks });
  try {
    const busy = await requestDelete(busyHarness, "story_a", "故事 A");
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, "story_delete_busy");
  } finally { await busyHarness.close(); }

  const failingLocks = new Set<string>();
  const failingHarness = await startDeletionHarness({
    storyMutationLocks: failingLocks,
    deleteStory: async () => { throw storyNotFoundError(); },
  });
  try {
    const missing = await requestDelete(failingHarness, "story_a", "故事 A");
    assert.equal(missing.status, 404);
    assert.equal(failingLocks.has("story_a"), false);
  } finally { await failingHarness.close(); }
});
```

Import `assertStoryDeletionTitle` and `storyNotFoundError` from `server/storyDeletion`. The harness error middleware must serialize `{ message, code }`, matching production.

- [ ] **Step 2: Run the route tests and verify RED**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletionRoutes.test.ts
```

Expected: FAIL because `server/storyDeletionRoutes.ts` does not exist.

- [ ] **Step 3: Implement the thin router**

Create `server/storyDeletionRoutes.ts`:

```ts
import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { UserAccount } from "../src/types";
import { storyDeletionBusyError, type PersistStoryDeletionInput } from "./storyDeletion";

type DeleteStoryCommand = Pick<PersistStoryDeletionInput, "ownerId" | "storyId" | "confirmationTitle">;

export interface StoryDeletionRouterOptions {
  storyMutationLocks: Set<string>;
  deleteStory(input: DeleteStoryCommand): Promise<void>;
}

const paramsSchema = z.object({ storyId: z.string().trim().min(1).max(200) });
const bodySchema = z.object({ confirmationTitle: z.string().trim().min(1).max(200) }).strict();

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function currentUser(response: Response): UserAccount {
  const user = (response.locals as { user?: UserAccount }).user;
  if (!user) throw Object.assign(new Error("请登录后继续。"), { status: 401, code: "authentication_required" });
  return user;
}

export function createStoryDeletionRouter(options: StoryDeletionRouterOptions): Router {
  const router = Router();
  router.delete("/stories/:storyId", asyncRoute(async (request, response) => {
    const user = currentUser(response);
    const { storyId } = paramsSchema.parse(request.params);
    const { confirmationTitle } = bodySchema.parse(request.body);
    if (options.storyMutationLocks.has(storyId)) throw storyDeletionBusyError();
    options.storyMutationLocks.add(storyId);
    try {
      await options.deleteStory({ ownerId: user.id, storyId, confirmationTitle });
      response.status(204).end();
    } finally {
      options.storyMutationLocks.delete(storyId);
    }
  }));
  return router;
}
```

- [ ] **Step 4: Mount the router and expose stable error codes**

In `server/index.ts`, import `deleteOwnedStory` and `createStoryDeletionRouter`, then mount after authentication and before `app.param("storyId")`:

```ts
app.use("/api", createStoryDeletionRouter({
  storyMutationLocks,
  deleteStory: (input) => deleteOwnedStory(store, input).then(() => undefined),
}));
```

Extend the existing final error middleware without returning arbitrary object fields:

```ts
const code = error instanceof Error
  && "code" in error
  && typeof error.code === "string"
  ? error.code
  : undefined;

response.status(status).json({
  message,
  ...(code ? { code } : {}),
  ...(safetyDecisionId ? { safetyDecisionId } : {}),
});
```

- [ ] **Step 5: Run route and storage tests**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletionRoutes.test.ts tests/storyDeletion.test.ts tests/storyDeletion.database.test.ts
```

Expected: PASS; route tests observe `401`, `400`, `404`, `409` and `204` exactly.

- [ ] **Step 6: Commit the HTTP unit**

```powershell
git add -- server/storyDeletionRoutes.ts server/index.ts tests/storyDeletionRoutes.test.ts
git commit -m "feat(api): expose permanent story deletion"
```

### Task 5: Add client deletion and network-result reconciliation

**Files:**
- Create: `src/storyDeletion.ts`
- Create: `tests/storyDeletionClient.test.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: Write failing client tests**

Create `tests/storyDeletionClient.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/api";
import { deleteStoryWithReconciliation, storyDeletionTitleMatches } from "../src/storyDeletion";

test("title confirmation trims only outer whitespace and remains case-sensitive", () => {
  assert.equal(storyDeletionTitleMatches("故事 A", "  故事 A  "), true);
  assert.equal(storyDeletionTitleMatches("Story A", "story a"), false);
  assert.equal(storyDeletionTitleMatches("故事 A", "故事  A"), false);
});

test("network loss is success only when the story is confirmed absent", async () => {
  let probes = 0;
  await deleteStoryWithReconciliation({
    storyId: "story_a",
    confirmationTitle: "故事 A",
    deleteRequest: async () => { throw new TypeError("fetch failed"); },
    loadStory: async () => { probes += 1; throw new ApiError("不存在", 404); },
  });
  assert.equal(probes, 1);
});

test("network loss rethrows when the story still exists", async () => {
  const networkError = new TypeError("fetch failed");
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw networkError; },
      loadStory: async () => ({ id: "story_a" }),
    }),
    (error: unknown) => error === networkError,
  );
});

test("structured API failures are shown directly without an existence probe", async () => {
  let probed = false;
  const apiError = new ApiError("任务仍在运行", 409, "story_delete_busy");
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw apiError; },
      loadStory: async () => { probed = true; return {}; },
    }),
    (error: unknown) => error === apiError,
  );
  assert.equal(probed, false);
});
test("non-network client failures are rethrown without an existence probe", async () => {
  let probed = false;
  const programmingError = new Error("unexpected client failure");
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw programmingError; },
      loadStory: async () => { probed = true; return {}; },
    }),
    (error: unknown) => error === programmingError,
  );
  assert.equal(probed, false);
});

```

- [ ] **Step 2: Run the client tests and verify RED**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletionClient.test.ts
```

Expected: FAIL because `src/storyDeletion.ts` does not exist.

- [ ] **Step 3: Implement the client coordinator**

Create `src/storyDeletion.ts`:

```ts
import { ApiError } from "./api";

export function storyDeletionTitleMatches(storyTitle: string, confirmationTitle: string): boolean {
  return confirmationTitle.trim() === storyTitle;
}

interface DeleteStoryWithReconciliationOptions {
  storyId: string;
  confirmationTitle: string;
  deleteRequest(storyId: string, confirmationTitle: string): Promise<void>;
  loadStory(storyId: string): Promise<unknown>;
}

export async function deleteStoryWithReconciliation(
  options: DeleteStoryWithReconciliationOptions,
): Promise<void> {
  try {
    await options.deleteRequest(options.storyId, options.confirmationTitle);
    return;
  } catch (error) {
    if (error instanceof ApiError || !(error instanceof TypeError)) throw error;
    try {
      await options.loadStory(options.storyId);
    } catch (probeError) {
      if (probeError instanceof ApiError && probeError.status === 404) return;
      throw probeError;
    }
    throw error;
  }
}
```

- [ ] **Step 4: Add the API method**

In `src/api.ts`, add:

```ts
deleteStory: (storyId: string, confirmationTitle: string) =>
  request<void>(`/api/stories/${encodeURIComponent(storyId)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmationTitle }),
  }),
```

Do not interpret `404` inside `api.deleteStory`; only the network-error reconciliation helper may treat a subsequent private-detail `404` as proof of success.

- [ ] **Step 5: Run the client tests and typecheck**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletionClient.test.ts
npm.cmd run typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the client unit**

```powershell
git add -- src/storyDeletion.ts src/api.ts tests/storyDeletionClient.test.ts
git commit -m "feat(client): reconcile permanent story deletion"
```

### Task 6: Build the accessible confirmation dialog and archive-page entry

**Files:**
- Create: `src/components/StoryDeletionDialog.tsx`
- Create: `src/storyDeletion.css`
- Modify: `src/pages/ArchivePage.tsx`

- [ ] **Step 1: Implement the dedicated dialog**

Create `src/components/StoryDeletionDialog.tsx`. It must reset the input on every open, restore previous focus, prevent backdrop/Esc closing while busy, and trap Tab within the dialog:

```tsx
import { LoaderCircle, ShieldAlert, Trash2, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { storyDeletionTitleMatches } from "../storyDeletion";
import "../storyDeletion.css";

interface StoryDeletionDialogProps {
  open: boolean;
  storyTitle: string;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onConfirm(confirmationTitle: string): Promise<void>;
}

function trapFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  ));
  const first = elements[0];
  const last = elements.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function StoryDeletionDialog({
  open,
  storyTitle,
  busy,
  error,
  onClose,
  onConfirm,
}: StoryDeletionDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [confirmationTitle, setConfirmationTitle] = useState("");

  useLayoutEffect(() => {
    if (!open) {
      setConfirmationTitle("");
      return;
    }
    setConfirmationTitle("");
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    queueMicrotask(() => inputRef.current?.focus());
    return () => {
      document.body.style.overflow = overflow;
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  const matches = storyDeletionTitleMatches(storyTitle, confirmationTitle);

  return createPortal(
    <div
      className="modal-backdrop story-deletion-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="story-deletion-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby="story-deletion-title"
        aria-describedby="story-deletion-description"
        onKeyDown={(event) => {
          trapFocus(event);
          if (event.key === "Escape" && !busy) onClose();
        }}
      >
        <header>
          <span className="story-deletion-dialog__icon"><ShieldAlert size={22} /></span>
          <div>
            <span className="eyebrow">危险操作</span>
            <h2 id="story-deletion-title">永久删除故事</h2>
          </div>
          <button type="button" aria-label="关闭永久删除确认" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="story-deletion-dialog__body">
          <p id="story-deletion-description">正文、全部版本历史、公开链接和所有读者进度都会永久删除，无法恢复。</p>
          <label htmlFor="story-deletion-confirmation">
            <span>请输入完整故事标题以确认</span>
            <strong>{storyTitle}</strong>
            <input
              ref={inputRef}
              id="story-deletion-confirmation"
              value={confirmationTitle}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setConfirmationTitle(event.target.value)}
            />
          </label>
          {error && <p className="story-deletion-dialog__error" role="alert">{error}</p>}
        </div>
        <footer>
          <button className="button button--secondary" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button
            className="button button--danger"
            type="button"
            disabled={busy || !matches}
            onClick={() => void onConfirm(confirmationTitle.trim())}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
            {busy ? "正在删除…" : "永久删除"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Add scoped responsive styles**

Create `src/storyDeletion.css` with no global input overrides:

```css
.story-danger-zone { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-top:28px; padding:22px 24px; border:1px solid rgba(166,75,55,.28); border-radius:16px; background:#fbf2ed; }
.story-danger-zone h2 { margin:0 0 6px; color:var(--rust); font-family:var(--serif); font-size:20px; }
.story-danger-zone p { margin:0; color:var(--muted); font-size:14px; line-height:1.7; }
.story-deletion-backdrop { z-index:280; }
.story-deletion-dialog { width:min(500px,100%); overflow:hidden; border:1px solid rgba(255,255,255,.55); border-radius:20px; background:#fffdf8; box-shadow:0 28px 90px rgba(35,18,15,.38); }
.story-deletion-dialog > header { display:grid; grid-template-columns:auto 1fr auto; align-items:start; gap:14px; padding:24px 26px 20px; border-bottom:1px solid #eadbd4; }
.story-deletion-dialog > header h2 { margin:5px 0 0; color:var(--ink); font-family:var(--serif); font-size:25px; }
.story-deletion-dialog > header > button { display:grid; width:34px; height:34px; place-items:center; border:0; border-radius:50%; color:var(--muted); background:#f2ebe6; cursor:pointer; }
.story-deletion-dialog__icon { display:grid; width:42px; height:42px; place-items:center; border-radius:50%; color:var(--rust); background:#f5dfd5; }
.story-deletion-dialog__body { display:grid; gap:18px; padding:24px 26px; }
.story-deletion-dialog__body > p { margin:0; color:var(--ink-2); font-size:14px; line-height:1.8; }
.story-deletion-dialog label { display:grid; gap:7px; color:var(--ink); font-size:13px; font-weight:700; }
.story-deletion-dialog label strong { overflow-wrap:anywhere; color:var(--rust); font-size:15px; }
.story-deletion-dialog input { width:100%; height:43px; padding:0 12px; border:1px solid #d8c7bf; border-radius:10px; color:var(--ink); background:#fff; }
.story-deletion-dialog input:focus { border-color:var(--rust); outline:3px solid rgba(166,75,55,.11); }
.story-deletion-dialog__error { padding:10px 12px; border-radius:9px; color:var(--rust)!important; background:#fae8df; }
.story-deletion-dialog > footer { display:flex; justify-content:flex-end; gap:10px; padding:16px 26px; border-top:1px solid #eadbd4; background:#faf6f1; }
@media (max-width:640px) { .story-danger-zone { align-items:stretch; flex-direction:column; } .story-deletion-backdrop { padding:12px; } .story-deletion-dialog > header,.story-deletion-dialog__body { padding-right:18px; padding-left:18px; } .story-deletion-dialog > footer { padding-right:18px; padding-left:18px; } .story-deletion-dialog > footer .button { flex:1; } }
```

- [ ] **Step 3: Wire ArchivePage state and reconciliation**

In `src/pages/ArchivePage.tsx`, import the dialog and coordinator, then add state and handler:

```tsx
import { StoryDeletionDialog } from "../components/StoryDeletionDialog";
import { deleteStoryWithReconciliation } from "../storyDeletion";

const [deletionOpen, setDeletionOpen] = useState(false);
const [deleting, setDeleting] = useState(false);
const [deletionError, setDeletionError] = useState<string | null>(null);

const deleteStory = async (confirmationTitle: string) => {
  setDeleting(true);
  setDeletionError(null);
  try {
    await deleteStoryWithReconciliation({
      storyId: story.id,
      confirmationTitle,
      deleteRequest: api.deleteStory,
      loadStory: api.story,
    });
    setDeletionOpen(false);
    navigate("/", { replace: true });
    try {
      await refresh();
      toast("故事已永久删除。");
    } catch {
      toast("故事已永久删除，但书架刷新暂时失败；重新加载页面即可同步。");
    }
  } catch (requestError) {
    setDeletionError(requestError instanceof Error ? requestError.message : "故事删除失败，请重试。");
  } finally {
    setDeleting(false);
  }
};
```

Add the only visible entry after the existing archive layout and render the dialog at page root:

```tsx
<section className="story-danger-zone" aria-labelledby="story-danger-title">
  <div>
    <span className="eyebrow">危险操作</span>
    <h2 id="story-danger-title">永久删除这个故事</h2>
    <p>与“移出书架”不同，永久删除会清除正文、版本、分享链接和读者进度。</p>
  </div>
  <button
    className="button button--danger"
    type="button"
    onClick={() => { setDeletionError(null); setDeletionOpen(true); }}
  >
    <Trash2 size={16} /> 永久删除故事
  </button>
</section>

<StoryDeletionDialog
  open={deletionOpen}
  storyTitle={story.title}
  busy={deleting}
  error={deletionError}
  onClose={() => { if (!deleting) setDeletionOpen(false); }}
  onConfirm={deleteStory}
/>
```

Do not add a delete button to `LibraryPage`, `ReaderPage`, `PublicReaderPage` or `PublicStoryCard`.

- [ ] **Step 4: Run focused tests, typecheck and production build**

Run:

```powershell
npm.cmd exec -- tsx --test --test-concurrency=1 tests/storyDeletionClient.test.ts
npm.cmd run typecheck
npm.cmd run build
```

Expected: all commands PASS; Vite emits a production bundle and the archive page compiles without unsafe non-null assertions.

- [ ] **Step 5: Verify the interaction in a browser**

Start the local app, sign in with a disposable account, and verify with keyboard-only navigation:

1. The permanent-delete entry exists on ArchivePage and is absent from the home cards, public library, private reader and public reader.
2. Focus moves into the empty title field; Tab remains inside the dialog; Esc and the close/cancel controls work only before submission.
3. A partial, case-changed or internally spaced title keeps the destructive button disabled; the exact title enables it.
4. During an intentionally delayed request, repeated clicks do not create a second request and backdrop/Esc/close/cancel cannot dismiss the dialog.
5. A server `409` leaves the entered title and real message visible; a successful delete navigates home and removes both private and public reads.

- [ ] **Step 6: Commit the UI unit**

```powershell
git add -- src/components/StoryDeletionDialog.tsx src/storyDeletion.css src/pages/ArchivePage.tsx
git commit -m "feat(story): add permanent deletion dialog"
```

### Task 7: Add default regression coverage and release documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/runbooks/public-story-sharing-release.md`

- [ ] **Step 1: Add every new test to the default test command**

Insert these files into the existing `scripts.test` command before the broad narrative suite:

```text
tests/storyDeletion.test.ts
tests/storyDeletion.database.test.ts
tests/storyDeletionRoutes.test.ts
tests/storyDeletionClient.test.ts
```

Do not remove or reorder existing stateful tests except where necessary to keep database tests sequential under `--test-concurrency=1`.

- [ ] **Step 2: Document user behavior and irreversible rollback**

Add this lifecycle bullet to `README.md`:

```markdown
- 故事档案页支持输入完整标题后永久删除；删除会同步移除正文、版本历史、公开链接和读者进度，只保留不含故事内容的脱敏模型统计与审计
```

Add a “永久删除发布验证” subsection to `docs/runbooks/public-story-sharing-release.md`:

```markdown
### 永久删除发布验证

1. 发布前运行并校验 `/usr/local/sbin/xumo-backup` 生成的 PostgreSQL 自定义格式备份。
2. 仅使用专用测试故事验证标题不匹配、活动任务阻止、已公开故事删除和分享链接立即不可读。
3. 删除后确认章节、Revision、发布记录、公共进度、举报、安全决策和审核 case 均为零。
4. 确认生成与失败汇总数量仍存在，但数据库 JSON 和 `/api/ops` 不包含测试标题、正文、候选文本、上下文或原错误消息。
5. 代码回滚不会恢复已经永久删除的数据；只有生产事故时才允许管理员从部署前整库备份恢复，不能提供单本故事自助恢复。
```

- [ ] **Step 3: Run the complete release verification**

Run:

```powershell
npm.cmd run verify:release
git diff --check
git status --short
```

Expected:

- TypeScript typecheck PASS.
- All existing and new tests PASS with zero failures.
- Vite production build PASS.
- `git diff --check` prints no whitespace errors.
- `git status --short` lists only intended task files plus the two preserved user files.

- [ ] **Step 4: Perform privacy sentinel scans**

Run:

```powershell
Select-String -Path 'dist\assets\*.js' -Pattern 'PRIVATE_TITLE_SENTINEL|PRIVATE_EVENT_SENTINEL|PRIVATE_FAILURE_SENTINEL'
Select-String -Path 'server\database\migrations\*.sql' -Pattern 'story.deleted|story_delete_busy'
```

Expected: both commands return no matches. Test sentinels must not enter the browser bundle, and the feature must not modify migration files.

- [ ] **Step 5: Commit regression and documentation changes**

```powershell
git add -- package.json README.md docs/runbooks/public-story-sharing-release.md
git commit -m "docs(story): document permanent deletion release"
```

### Task 8: Review, push, back up production, and deploy

**Files:**
- No source changes expected
- Verify: all files listed in the File Map

- [ ] **Step 1: Review the complete branch before any external write**

Run:

```powershell
git status --short
git log --oneline --decorate -8
git diff 62207ef..HEAD --stat
git diff 62207ef..HEAD --check
```

Expected: only permanent deletion implementation commits follow the design commit; the two user files remain untracked and untouched.

- [ ] **Step 2: Run targeted security and behavior review**

Confirm from the diff that:

- route ownership failures are indistinguishable `404`;
- title comparison is repeated inside the PostgreSQL transaction;
- `storyMutationLocks` release in `finally`;
- active jobs block deletion;
- all SQL is parameterized;
- retained job/failure payloads are allowlisted, not copied and key-subtracted;
- review excerpts, safety decisions and content reports are removed;
- stale `saveSnapshot` cannot reinsert the story or private records;
- no frontend route other than ArchivePage renders the delete button.

- [ ] **Step 3: Push only after explicit user authorization**

Run after the user confirms the final commit SHA and branch:

```powershell
git push origin codex/story-engine-phase-2
```

Expected: GitHub branch points at the reviewed permanent deletion commit.

- [ ] **Step 4: Create and validate the production backup**

Run on `root@139.196.161.228` after deployment authorization:

```bash
BACKUP_BEFORE="$(find /var/backups/xumo -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)"
systemctl start xumo-backup.service
systemctl show xumo-backup.service -p Result -p ExecMainStatus --no-pager
journalctl -u xumo-backup.service -n 8 --no-pager -o cat
BACKUP_DIR="$(find /var/backups/xumo -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
test -n "$BACKUP_DIR"
test "$BACKUP_DIR" != "$BACKUP_BEFORE"
cd -- "$BACKUP_DIR"
sha256sum --check SHA256SUMS
pg_restore --list xumo.pgdump >/dev/null
```

Expected: `Result=success`, `ExecMainStatus=0`, `BACKUP_DIR` differs from the previous latest directory, every checksum is `OK`, and `pg_restore --list` exits zero. Stop deployment immediately if any command exits non-zero.

- [ ] **Step 5: Deploy by immutable release directory**

Run the following from the reviewed workspace in one PowerShell session. The configured SSH agent/key for `root@139.196.161.228` is used; do not copy a private key into the repository:

```powershell
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$deploySha = (git rev-parse HEAD).Trim()
$deployShort = (git rev-parse --short=12 HEAD).Trim()
$deployStamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$releaseName = "$deployStamp-$deployShort"
$artifactPath = "C:\tmp\xumo-$releaseName.tar.gz"
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "production build failed" }
tar.exe -czf $artifactPath dist
if ($LASTEXITCODE -ne 0) { throw "artifact creation failed" }
$artifactHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
$previousRelease = (ssh root@139.196.161.228 "readlink -f /opt/xumo/current").Trim()
if (-not $previousRelease.StartsWith("/opt/xumo/releases/")) {
  throw "current release is outside /opt/xumo/releases: $previousRelease"
}
ssh root@139.196.161.228 "install -d -m 755 '/opt/xumo/releases/$releaseName'"
scp $artifactPath "root@139.196.161.228:/tmp/xumo-$releaseName.tar.gz"
ssh root@139.196.161.228 "printf '%s  %s\n' '$artifactHash' '/tmp/xumo-$releaseName.tar.gz' | sha256sum --check -"
ssh root@139.196.161.228 "tar -xzf '/tmp/xumo-$releaseName.tar.gz' -C '/opt/xumo/releases/$releaseName'"
ssh root@139.196.161.228 "printf '%s\n' '$deploySha' > '/opt/xumo/releases/$releaseName/release.txt'"
ssh root@139.196.161.228 "node --check '/opt/xumo/releases/$releaseName/dist/node/server.js'"
ssh root@139.196.161.228 "ln -sfn '/opt/xumo/releases/$releaseName' /opt/xumo/current.next"
ssh root@139.196.161.228 "mv -Tf /opt/xumo/current.next /opt/xumo/current"
Write-Output "previous=$previousRelease"
Write-Output "current=/opt/xumo/releases/$releaseName"
```

Every command must exit zero. The artifact contains only the reviewed `dist` directory, the release directory name is derived from UTC time and the reviewed commit, and the previous release path remains unchanged for rollback.

Restart and verify:

```powershell
try {
  ssh root@139.196.161.228 "systemctl restart xumo.service"
  if ($LASTEXITCODE -ne 0) { throw "service restart failed" }
  $serviceState = (ssh root@139.196.161.228 "systemctl is-active xumo.service").Trim()
  if ($serviceState -ne "active") { throw "service state is $serviceState" }
  $loopbackHealthText = ssh root@139.196.161.228 "curl --fail --silent --show-error http://127.0.0.1:8787/api/health"
  if ($LASTEXITCODE -ne 0) { throw "loopback health check failed" }
  $publicHealthText = curl.exe --fail --silent --show-error https://idel.fun/api/health
  if ($LASTEXITCODE -ne 0) { throw "public health check failed" }
  $loopbackHealth = $loopbackHealthText | ConvertFrom-Json
  $publicHealth = $publicHealthText | ConvertFrom-Json
  foreach ($health in @($loopbackHealth, $publicHealth)) {
    if ($health.storage -ne "postgresql" -or -not $health.persistent) {
      throw "health response does not report persistent PostgreSQL"
    }
  }
  $warningLog = [string](ssh root@139.196.161.228 "journalctl -q -u xumo.service --since=-10min -p warning --no-pager -o cat")
  $warningLog = $warningLog.Trim()
  if ($warningLog) { throw "new warning log entries: $warningLog" }
} catch {
  ssh root@139.196.161.228 "ln -sfn '$previousRelease' /opt/xumo/current.next"
  ssh root@139.196.161.228 "mv -Tf /opt/xumo/current.next /opt/xumo/current"
  ssh root@139.196.161.228 "systemctl restart xumo.service"
  throw
}
```

Expected: service is `active`; both parsed health responses report `storage: "postgresql"` and `persistent: true`; the warning log is empty. Any failure atomically restores `$previousRelease`, restarts the previous version, and fails the deployment.

- [ ] **Step 6: Run a disposable-story production smoke test**

Use a dedicated account and disposable story, never a real user story:

1. Publish the story and save reader progress from a second account.
2. Verify the wrong title cannot delete it.
3. Start a controlled generation and verify deletion returns the busy message; wait for completion.
4. Enter the exact title and delete.
5. Confirm private URL and public URL are unavailable and the library totals decrease.
6. Query database counts for that test story and confirm core/public/content rows are gone.
7. Confirm `/api/ops` still aggregates the model job but contains none of the disposable title or sentinel content.

## Definition of Done

- Permanent delete appears only in the story archive page and requires the exact trimmed title.
- Ownership and title are revalidated in the PostgreSQL transaction.
- Active generation or mutation returns `409 story_delete_busy` without cancelling work.
- Successful deletion returns `204`; private and public reads become unavailable immediately.
- Story, chapters, revisions, creation requests, publication, public progress, reports, safety decisions and content-bearing review cases are removed atomically.
- Retained jobs, failures, feedback and audits contain only approved non-content fields.
- JSON write failure and SQL transaction failure restore the complete pre-delete state.
- A stale concurrent PostgreSQL snapshot cannot reinsert deleted content.
- Network response loss is reconciled by a private detail probe and does not falsely report failure.
- Default tests, typecheck, build, privacy scans, backup validation and production health checks all pass.
- The previous production release and validated PostgreSQL backup remain available for incident recovery.

## Commit Hygiene

- Never run `git reset --hard`, `git checkout --` or broad staging commands.
- Stage only the exact files named in each task.
- Run `git status --short` before and after every commit.
- Keep domain, database, storage, HTTP, client, UI and documentation commits separate.
- Never stage `demo-test1-source-20260721-113811.zip` or `structure.txt`.
