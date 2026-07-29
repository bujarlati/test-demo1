import assert from "node:assert/strict";
import test from "node:test";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { PostgresDatabase } from "../server/database/postgres";
import type { DatabaseExecutor, QueryResult } from "../server/database/types";
import {
  beginStoryOpeningGeneration,
  resumeStoryOpeningGeneration,
  type OpeningGenerationContext,
  type OpeningModelCompleter,
} from "../server/modelGateway";
import { detectNarrationCandidates, narrationArtifactHash } from "../server/narrationPolicy";
import {
  OpeningJobService,
  type OpeningJobPersistence,
  type OpeningJobPipeline,
} from "../server/openingJobService";
import { runNarrationReviewSweep } from "../server/narrationReviewScheduler";
import {
  openNarrationReviewPayload,
  sealNarrationReviewExcerpt,
  sealNarrationReviewPayload,
} from "../server/narrationReviewState";
import { refineReadingExperienceContract } from "../server/readingExperience";
import { createSeedStore } from "../server/seed";
import type {
  AppStore,
  CreateStoryInput,
  ModelConnection,
  NarrationReviewDecisionInput,
  OpeningJobStatusPayload,
  UserAccount,
} from "../src/types";

interface PGliteQueryable {
  query<Row>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}

class PGliteExecutor implements DatabaseExecutor {
  constructor(
    private readonly database: PGliteInterface,
    private readonly queryable: PGliteQueryable = database,
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    parameters: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.queryable.query<Row>(sql, parameters);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async execute(sql: string): Promise<void> {
    await this.queryable.exec(sql);
  }

  async transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.database.transaction((transaction: Transaction) =>
      work(new PGliteExecutor(this.database, transaction))
    );
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}

type ReviewDecision = "allow" | "rewrite" | "ask_user";

const storyInput: CreateStoryInput = {
  genre: "都市",
  tone: "机械 · 奶爸",
  inspiration: "退役机甲师带女儿守住维修铺",
};

const plan = {
  title: "钢铁摇篮",
  subtitle: "退役机甲师与三岁女儿的旧城生活",
  leadName: "周砺",
  storyGene: {
    protagonistPosition: "独自照顾女儿的退役机甲师",
    visibleGoal: "守住维修铺和女儿的生活",
    hiddenNeed: "学会倾听女儿自己的选择",
    conflictEngine: "机甲冲突和育儿日常共同改变旧城关系",
    recurringCost: "每次公开实力都会扩大需要照料的社区范围",
    endingShape: "父女和伙伴共同重建旧城",
    creativeAxes: ["机械维修", "父女日常", "旧城守护"],
  },
  endingContract: {
    targetEnding: "旧城获得新生",
    characterArc: "从独自保护到共同生活",
    prerequisites: ["维修铺重开"],
  },
  worldBible: {
    organizations: ["维修协会"],
    locations: ["旧城维修铺"],
    abilityBoundaries: ["机甲需要能源"],
    pointOfView: "近距离第三人称",
    styleParameters: ["动作清楚"],
  },
  experienceAxes: [
    {
      word: "机械",
      interpretation: "机械必须作为可操作能力推动事件",
      observableSignals: [
        {
          description: "机械臂完成精确动作并挡住威胁",
          evidenceAnchors: ["机械臂", "完成精确动作", "挡住威胁"],
        },
        {
          description: "机械维修恢复资源并改变现场状态",
          evidenceAnchors: ["机械维修", "恢复资源", "改变现场状态"],
        },
      ],
      hardPromises: ["每章至少一次有效机械操作"],
      forbiddenShortcuts: ["只描写金属颜色"],
    },
    {
      word: "奶爸",
      interpretation: "奶爸的父亲照料和女儿回应共同推动关系",
      observableSignals: [
        {
          description: "奶爸周砺听见女儿说出自己的需要",
          evidenceAnchors: ["奶爸周砺", "听见女儿", "自己的需要"],
        },
        {
          description: "女儿作出选择后父亲调整方案",
          evidenceAnchors: ["女儿作出选择", "父亲", "调整方案"],
        },
      ],
      hardPromises: ["每章都有父女双向互动"],
      forbiddenShortcuts: ["把女儿当作被保护的道具"],
    },
  ],
  openingBeats: ["机械动作在首段出现", "父女关系在首个冲突中改变结果"],
};

const ordinaryParagraph = (
  "机械臂完成第1个精确动作，奶爸周砺同时听见女儿说出自己的需要。" +
  "周砺用当场完成的维修结果挡住逼近的威胁，女儿则指出被忽略的安全出口。" +
  "父女共同作出的选择改变了维修铺门前的冲突，围观者随即收起武器并调整立场，资源和关系都留下明确变化。"
).repeat(2);

function connectionFixture(ownerId: string): ModelConnection {
  return {
    id: "conn_contextual_review_integration",
    name: "Contextual narration integration",
    ownerScope: "user",
    ownerId,
    protocol: "openai_compatible",
    baseUrl: "https://example.test/v1",
    maskedKey: "sk••••test",
    secretRef: "vault://contextual-review-integration",
    secretVersion: 1,
    status: "active",
    routes: {
      planner: "planner-route",
      writer: "writer-route",
      extractor: "reviewer-route",
      embedding: "embedding-route",
    },
    fallbackPolicy: "none",
    capabilities: null,
    updatedAt: "2026-07-24T08:00:00.000Z",
  };
}

class FakeOpeningModel {
  readonly calls: string[] = [];
  writerCalls = 0;
  reviewerCalls = 0;
  private refinedContract: ReturnType<typeof refineReadingExperienceContract> | null = null;
  private readonly drafts: Array<{
    title: string;
    paragraphs: string[];
    candidates: ReturnType<typeof detectNarrationCandidates>;
  }>;

  constructor(
    firstSentence: string,
    private readonly decisions: ReviewDecision[],
    secondSentence = "周砺从旧箱底抽出母亲留下的第二张药方。",
  ) {
    this.drafts = [firstSentence, secondSentence].map((sentence, index) => {
      const title = `第一章 修好的机械臂${index + 1}`;
      const normalizedTitle = `修好的机械臂${index + 1}`;
      const paragraphs = Array.from({ length: 16 }, (_, paragraphIndex) =>
        paragraphIndex === 0 ? `${sentence}${ordinaryParagraph}` : ordinaryParagraph
      );
      const hash = narrationArtifactHash(normalizedTitle, paragraphs);
      const content = paragraphs.join("\n");
      return {
        title,
        paragraphs,
        candidates: [
          ...detectNarrationCandidates("title", normalizedTitle, hash),
          ...detectNarrationCandidates("body", content, hash),
        ],
      };
    });
    assert.ok(this.drafts[0].candidates.length > 0, "first draft must exercise the candidate gate");
  }

  get firstCandidateCount(): number {
    return this.drafts[0].candidates.length;
  }

  get totalCandidateCount(): number {
    return this.drafts.reduce((total, draft) => total + draft.candidates.length, 0);
  }

  prepare(context: OpeningGenerationContext): void {
    this.refinedContract = refineReadingExperienceContract(context.contract, plan.experienceAxes);
  }

  complete: OpeningModelCompleter = async ({ model }) => {
    this.calls.push(model);
    if (model === "planner-route") {
      return { value: plan, usageTokens: 100, usageEstimated: false };
    }
    if (model === "writer-route") {
      const draft = this.drafts[this.writerCalls] ?? this.drafts.at(-1)!;
      this.writerCalls += 1;
      return {
        value: { title: draft.title, paragraphs: draft.paragraphs },
        usageTokens: 200,
        usageEstimated: false,
      };
    }
    assert.ok(this.refinedContract, "pipeline context must be prepared before review");
    const draft = this.drafts[Math.max(0, this.writerCalls - 1)];
    const decision = this.decisions[this.reviewerCalls] ?? this.decisions.at(-1) ?? "allow";
    this.reviewerCalls += 1;
    const semanticFields = decision === "allow"
      ? { worldInternal: true, writingProcessReference: false, confidence: 0.96 }
      : decision === "rewrite"
        ? { worldInternal: false, writingProcessReference: true, confidence: 0.96 }
        : { worldInternal: true, writingProcessReference: true, confidence: 0.62 };
    return {
      value: {
        experienceEvidence: [
          {
            axisId: "primary",
            word: "机械",
            signalIds: this.refinedContract.axes[0].observableSignals.map((signal) => signal.id),
            quote: "机械臂完成第1个精确动作",
          },
          {
            axisId: "secondary",
            word: "奶爸",
            signalIds: this.refinedContract.axes[1].observableSignals.map((signal) => signal.id),
            quote: "奶爸周砺同时听见女儿说出自己的需要",
          },
        ],
        event: {
          title: "维修铺门前的交锋",
          cause: "维修协会试图收走铺面",
          outcome: "父女共同守住维修铺",
          location: "旧城维修铺",
          persistentFacts: [
            "机械臂完成第1个精确动作",
            "奶爸周砺同时听见女儿说出自己的需要",
          ],
        },
        narrationAssessments: draft.candidates.map((candidate) => ({
          candidateId: candidate.id,
          ...semanticFields,
          decision,
          reason: decision === "allow" ? "这是故事内物件。" : "需要处理这句话的语义。",
        })),
      },
      usageTokens: 300,
      usageEstimated: false,
    };
  };
}

function persistenceFor(
  database: PostgresDatabase,
  store: AppStore,
): OpeningJobPersistence {
  return {
    save: (rollback) => database.saveSnapshot(store, rollback),
    findStoryCreationRequest: (ownerId, key) => database.findStoryCreationRequest(ownerId, key),
    loadStory: (ownerId, storyId) => database.loadStory(ownerId, storyId),
    findJob: (ownerId, key) => database.findGenerationJobByIdempotencyKey(ownerId, key),
    reserveIdempotencyKey: (ownerId, key) => database.reserveIdempotencyKey(ownerId, key),
    releaseIdempotencyKey: (ownerId, key) => database.releaseIdempotencyKey(ownerId, key),
    pauseOpeningForNarrationReview: (job, review) =>
      database.pauseOpeningForNarrationReview(job, review),
    getNarrationReviewCaseForOwner: (ownerId, jobId) =>
      database.getNarrationReviewCaseForOwner(ownerId, jobId),
    getNarrationReviewCaseById: (caseId) => database.getNarrationReviewCaseById(caseId),
    claimNarrationReviewDecision: (claim) => database.claimNarrationReviewDecision(claim),
    replaceNarrationReviewCase: (oldCaseId, job, review, resolvedAt) =>
      database.replaceNarrationReviewCase(oldCaseId, job, review, resolvedAt),
    resolveNarrationReviewCase: (caseId, status, resolvedAt) =>
      database.resolveNarrationReviewCase(caseId, status, resolvedAt),
    failExpiredNarrationReviewCase: (caseId, now) =>
      database.failExpiredNarrationReviewCase(caseId, now),
    upsertNarrationReviewFeedback: (feedback) => database.upsertNarrationReviewFeedback(feedback),
  };
}

interface HarnessOptions {
  firstSentence: string;
  decisions: ReviewDecision[];
  secondSentence?: string;
  blockPublication?: boolean;
}

async function createHarness(options: HarnessOptions) {
  const pglite = new PGlite();
  const database = new PostgresDatabase(new PGliteExecutor(pglite));
  await database.migrate();
  let store = createSeedStore();
  store.stories = [];
  store.jobs = [];
  store.auditEvents = [];
  store.storyCreationRequests = [];
  store.idempotencyKeys = [];
  store.generationFailures = [];
  const initialOwner = store.users.find((user) => user.id === "user_demo")!;
  const connection = connectionFixture(initialOwner.id);
  store.connections.push(connection);
  initialOwner.defaultConnectionId = connection.id;
  await database.saveSnapshot(store);

  const model = new FakeOpeningModel(
    options.firstSentence,
    options.decisions,
    options.secondSentence,
  );
  const encryptionKey = Buffer.alloc(32, 29);
  const loadKey = async () => encryptionKey;
  let now = new Date("2026-07-24T12:00:00.000Z");
  let sequence = 0;
  let service: OpeningJobService;

  const buildService = (runtimeStore: AppStore): OpeningJobService => {
    const pipeline: OpeningJobPipeline = {
      begin: async (context, selectedConnection, observer) => {
        model.prepare(context);
        return beginStoryOpeningGeneration(
          context,
          selectedConnection,
          model.complete,
          undefined,
          observer,
        );
      },
      resume: (checkpoint, action, selectedConnection, observer) =>
        resumeStoryOpeningGeneration(
          checkpoint,
          action,
          selectedConnection,
          model.complete,
          observer,
        ),
    };
    return new OpeningJobService({
      store: runtimeStore,
      persistence: persistenceFor(database, runtimeStore),
      pipeline,
      resolveConnection: (owner, connectionId) => {
        const selected = runtimeStore.connections.find((candidate) =>
          candidate.id === connectionId &&
          (candidate.ownerScope === "platform" || candidate.ownerId === owner.id)
        );
        if (!selected) throw Object.assign(new Error("connection unavailable"), { status: 404 });
        return selected;
      },
      ...(options.blockPublication
        ? {
            publicationGate: () => {
              throw Object.assign(new Error("safety gate blocked publication"), { status: 422 });
            },
          }
        : {}),
      now: () => new Date(now),
      createId: (prefix) => `${prefix}_integration_${++sequence}`,
      sealPayload: (identity, payload) => sealNarrationReviewPayload(identity, payload, loadKey),
      openPayload: (identity, envelope) => openNarrationReviewPayload(identity, envelope, loadKey),
      sealExcerpt: (identity, candidates) => sealNarrationReviewExcerpt(identity, candidates, loadKey),
    });
  };
  service = buildService(store);

  return {
    database,
    pglite,
    model,
    get store() { return store; },
    get service() { return service; },
    get owner() { return store.users.find((user) => user.id === "user_demo")!; },
    get otherOwner() { return store.users.find((user) => user.id === "user_reader")!; },
    get connection() { return store.connections.find((item) => item.id === connection.id)!; },
    setNow(value: string) { now = new Date(value); },
    async restart() {
      store = await database.loadRuntimeStore();
      service = buildService(store);
    },
    async close() {
      await database.close();
    },
  };
}

async function startOpening(
  harness: Awaited<ReturnType<typeof createHarness>>,
  idempotencyKey: string,
) {
  return harness.service.start({
    owner: harness.owner,
    input: storyInput,
    connectionId: harness.connection.id,
    idempotencyKey,
  });
}

function awaitingResult(result: Awaited<ReturnType<typeof startOpening>>) {
  assert.equal(result.kind, "job");
  if (result.kind !== "job" || result.job.status !== "awaiting_user_review") {
    throw new Error("expected an awaiting narration review");
  }
  return result.job;
}

function decisionFor(
  job: Extract<OpeningJobStatusPayload, { status: "awaiting_user_review" }>,
  decision: "keep" | "rewrite",
  shareRedactedContext = false,
): NarrationReviewDecisionInput {
  return {
    caseId: job.review.id,
    caseVersion: job.review.version,
    contentHash: job.review.contentHash,
    candidateIds: job.review.candidates.map((candidate) => candidate.id),
    decision,
    shareRedactedContext,
  };
}

test("PGlite integration: semantic allow and automatic rewrite both commit exactly once", async (t) => {
  await t.test("world-internal phrase is allowed without a rewrite", async () => {
    const harness = await createHarness({
      firstSentence: "他从旧箱底抽出半本卷边残诗稿。",
      decisions: ["allow"],
    });
    try {
      const result = await startOpening(harness, "integration-allow-1");
      assert.equal(result.kind, "completed");
      assert.equal(harness.model.writerCalls, 1);
      assert.equal(harness.model.reviewerCalls, 1);
      assert.equal(harness.store.stories.length, 1);
      const metrics = await harness.database.listNarrationReviewMetrics(10);
      assert.equal(metrics[0]?.modelAllow, 1);
    } finally {
      await harness.close();
    }
  });

  await t.test("explicit author instruction is rewritten once", async () => {
    const harness = await createHarness({
      firstSentence: "本卷目标是推进角色弧。",
      decisions: ["rewrite", "allow"],
    });
    try {
      const result = await startOpening(harness, "integration-auto-rewrite-1");
      assert.equal(result.kind, "completed");
      assert.equal(harness.model.writerCalls, 2);
      assert.equal(harness.store.stories.length, 1);
      const metrics = await harness.database.listNarrationReviewMetrics(10);
      assert.equal(
        metrics.reduce((total, metric) => total + metric.modelRewrite, 0),
        harness.model.firstCandidateCount,
      );
      assert.equal(
        metrics.reduce((total, metric) => total + metric.rewriteSucceeded, 0),
        harness.model.firstCandidateCount,
      );
      const rows = await harness.pglite.query<{ payload: string }>(
        "SELECT row_to_json(feedback)::text AS payload FROM xumo_narration_review_feedback feedback",
      );
      assert.equal(rows.rows.some((row) => row.payload.includes("本卷目标是推进角色弧")), false);
    } finally {
      await harness.close();
    }
  });
});

test("PGlite integration: a failed second automatic rewrite is recorded without publishing", async () => {
  const harness = await createHarness({
    firstSentence: "本卷目标是推进角色弧。",
    secondSentence: "本章安排是让冲突进入下一阶段。",
    decisions: ["rewrite", "rewrite"],
  });
  try {
    await assert.rejects(
      startOpening(harness, "integration-auto-rewrite-failure-1"),
      (error: unknown) => error instanceof Error &&
        (error as Error & { code?: string }).code === "narration_rewrite_exhausted",
    );
    assert.equal(harness.model.writerCalls, 2);
    assert.equal(harness.store.stories.length, 0);
    const metrics = await harness.database.listNarrationReviewMetrics(10);
    assert.equal(
      metrics.reduce((total, metric) => total + metric.modelRewrite, 0),
      harness.model.totalCandidateCount,
    );
    assert.equal(metrics.reduce((total, metric) => total + metric.rewriteSucceeded, 0), 0);
    assert.equal(metrics.reduce((total, metric) => total + metric.finalJobsCompleted, 0), 0);
  } finally {
    await harness.close();
  }
});

test("PGlite integration: ask_user keep survives restart, owner isolation, and duplicate requests", async () => {
  const harness = await createHarness({
    firstSentence: "他从旧箱底抽出半本卷边残诗稿。",
    decisions: ["ask_user"],
  });
  try {
    const awaiting = awaitingResult(await startOpening(harness, "integration-keep-1"));
    const callsAtPause = harness.model.calls.length;
    const duplicateStart = await startOpening(harness, "integration-keep-1");
    assert.equal(duplicateStart.kind, "job");
    assert.equal(harness.model.calls.length, callsAtPause);

    await assert.rejects(
      harness.service.getStatus(harness.otherOwner.id, awaiting.jobId),
      (error: unknown) => error instanceof Error && (error as Error & { status?: number }).status === 404,
    );
    await assert.rejects(
      harness.service.decideNarrationReview(
        harness.otherOwner.id,
        awaiting.jobId,
        decisionFor(awaiting, "keep"),
      ),
      (error: unknown) => error instanceof Error && (error as Error & { status?: number }).status === 404,
    );

    await harness.restart();
    const restored = await harness.service.getStatus(harness.owner.id, awaiting.jobId);
    assert.equal(restored.status, "awaiting_user_review");
    const decision = decisionFor(awaiting, "keep");
    await Promise.all([
      harness.service.decideNarrationReview(harness.owner.id, awaiting.jobId, decision),
      harness.service.decideNarrationReview(harness.owner.id, awaiting.jobId, decision),
    ]);
    await harness.service.waitForIdle();

    assert.equal(
      (await harness.service.getStatus(harness.owner.id, awaiting.jobId)).status,
      "completed",
      JSON.stringify(harness.store.generationFailures),
    );
    assert.equal(harness.model.writerCalls, 1);
    assert.equal(harness.model.reviewerCalls, 1);
    const storyCount = await harness.pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_stories");
    assert.equal(storyCount.rows[0].count, "1");
    const feedback = await harness.pglite.query<{
      excerpt: unknown | null;
      candidateMetadata: string;
      assessmentMetadata: string;
    }>(
      `SELECT feedback.consented_excerpt_ciphertext AS excerpt,
              review.candidate_metadata::text AS "candidateMetadata",
              review.assessment_metadata::text AS "assessmentMetadata"
       FROM xumo_narration_review_feedback feedback
       JOIN xumo_narration_review_cases review ON review.id = feedback.case_id`,
    );
    assert.equal(feedback.rows[0].excerpt, null);
    assert.equal(JSON.stringify(feedback.rows).includes("半本卷边残诗稿"), false);
    assert.equal(JSON.stringify(feedback.rows).includes("需要处理这句话"), false);

    const completedDuplicate = await startOpening(harness, "integration-keep-1");
    assert.equal(completedDuplicate.kind, "completed");
    assert.equal(harness.model.calls.length, callsAtPause);
  } finally {
    await harness.close();
  }
});

test("PGlite integration: user rewrite stores only consented ciphertext and expires it", async () => {
  const harness = await createHarness({
    firstSentence: "本卷目标是推进角色弧。",
    decisions: ["ask_user", "allow"],
  });
  try {
    const awaiting = awaitingResult(await startOpening(harness, "integration-user-rewrite-1"));
    await harness.service.decideNarrationReview(
      harness.owner.id,
      awaiting.jobId,
      decisionFor(awaiting, "rewrite", true),
    );
    await harness.service.waitForIdle();
    assert.equal((await harness.service.getStatus(harness.owner.id, awaiting.jobId)).status, "completed");
    assert.equal(harness.model.writerCalls, 2);

    const before = await harness.pglite.query<{ excerpt: string | null; payload: string }>(
      `SELECT consented_excerpt_ciphertext::text AS excerpt,
              row_to_json(feedback)::text AS payload
       FROM xumo_narration_review_feedback feedback
       WHERE user_decision = 'rewrite'`,
    );
    assert.ok(before.rows[0].excerpt);
    assert.equal(before.rows[0].payload.includes("本卷目标是推进角色弧"), false);
    const cleanup = await harness.database.deleteExpiredNarrationReviewData("2026-10-23T12:00:00.000Z");
    assert.equal(cleanup.excerpts, harness.model.firstCandidateCount);
    const after = await harness.pglite.query<{ excerpt: unknown | null }>(
      "SELECT consented_excerpt_ciphertext AS excerpt FROM xumo_narration_review_feedback",
    );
    assert.equal(after.rows[0].excerpt, null);
  } finally {
    await harness.close();
  }
});

test("PGlite integration: a 90-second timeout claims rewrite and finishes without a browser", async () => {
  const harness = await createHarness({
    firstSentence: "本卷目标是推进角色弧。",
    decisions: ["ask_user", "allow"],
  });
  try {
    const awaiting = awaitingResult(await startOpening(harness, "integration-timeout-1"));
    harness.setNow("2026-07-24T12:01:31.000Z");
    const sweep = await runNarrationReviewSweep({
      now: new Date("2026-07-24T12:01:31.000Z"),
      repository: harness.database,
      resume: (caseId) => harness.service.resumeClaimedCase(caseId),
    });
    assert.equal(sweep.timedOut, 1);
    assert.equal((await harness.service.getStatus(harness.owner.id, awaiting.jobId)).status, "completed");
    assert.equal(harness.model.writerCalls, 2);
    const feedback = await harness.pglite.query<{ source: string; completed: boolean }>(
      `SELECT resolution_source AS source, job_completed AS completed
       FROM xumo_narration_review_feedback
       WHERE user_decision IS NULL`,
    );
    assert.deepEqual(feedback.rows[0], { source: "timeout", completed: true });
  } finally {
    await harness.close();
  }
});

test("PGlite integration: keeping a sentence does not bypass the publication safety gate", async () => {
  const harness = await createHarness({
    firstSentence: "他从旧箱底抽出半本卷边残诗稿。",
    decisions: ["ask_user"],
    blockPublication: true,
  });
  try {
    const awaiting = awaitingResult(await startOpening(harness, "integration-safety-1"));
    await harness.service.decideNarrationReview(
      harness.owner.id,
      awaiting.jobId,
      decisionFor(awaiting, "keep"),
    );
    await harness.service.waitForIdle();
    assert.equal((await harness.service.getStatus(harness.owner.id, awaiting.jobId)).status, "failed");
    assert.equal(harness.store.stories.length, 0);
    const storyCount = await harness.pglite.query<{ count: string }>("SELECT count(*)::text AS count FROM xumo_stories");
    assert.equal(storyCount.rows[0].count, "0");
  } finally {
    await harness.close();
  }
});
