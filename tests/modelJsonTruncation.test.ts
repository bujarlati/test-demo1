import assert from "node:assert/strict";
import test from "node:test";
import { completeJson, generateStoryOpeningWithConnection, type AiTraceEvent, type OpeningCompletionRequest } from "../server/modelGateway";
import { createStory } from "../server/storyService";
import type { ModelConnection } from "../src/types";

function arkPlannerConnection(id: string): ModelConnection {
  return {
    id,
    name: "Ark planner truncation regression",
    ownerScope: "personal",
    ownerId: "user_test",
    protocol: "openai_compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    maskedKey: "sk••••test",
    secretRef: "vault://" + id,
    secretVersion: 1,
    status: "active",
    routes: {
      planner: "doubao-seed-2-1-turbo-260628",
      writer: "doubao-seed-2-1-pro-260628",
      extractor: "doubao-seed-character-260628",
      embedding: "doubao-embedding-vision-251215",
    },
    fallbackPolicy: "none",
    capabilities: {
      completionApi: "chat_completions",
      streaming: true,
      jsonSchema: true,
      embedding: false,
      promptCache: false,
      toolCalling: true,
      maxContextTokens: null,
      testedAt: new Date().toISOString(),
      latencyMs: 1,
    },
    updatedAt: new Date().toISOString(),
  };
}

function streamedReply(content: string, finishReason: string, totalTokens: number): Response {
  return new Response([
    "data: " + JSON.stringify({ choices: [{ delta: { content } }] }),
    "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] }),
    "data: " + JSON.stringify({ choices: [], usage: { total_tokens: totalTokens } }),
    "data: [DONE]",
  ].join("\n\n"), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("opening generation configures the planner's full truncation token ladder", async () => {
  const connection = arkPlannerConnection("conn_opening_planner_tiers");
  const story = createStory({ genre: "都市", tone: "系统 · 无敌" }, "user_test");
  let plannerRequest: OpeningCompletionRequest | undefined;

  await assert.rejects(
    () => generateStoryOpeningWithConnection({
      input: { genre: "都市", tone: "系统 · 无敌", inspiration: "主角在任务结算后改变城市秩序" },
      contract: story.readingExperience,
      targetChapterCount: story.targetChapterCount,
    }, connection, async (request) => {
      plannerRequest = request;
      throw new Error("stop after planner request");
    }),
    /stop after planner request/,
  );

  assert.equal(plannerRequest?.maxTokens, 4_000);
  assert.deepEqual(plannerRequest?.truncationTokenTiers, [4_000, 6_000, 8_000]);
});

test("opening planner retries a length-truncated stream with larger output tiers", async () => {
  const connection = arkPlannerConnection("conn_ark_opening_planner_truncation");
  const requests: Array<Record<string, unknown>> = [];
  const events: AiTraceEvent[] = [];
  const replies = [
    { content: '{"experienceAxes":[{"word":"系统"}', finishReason: "length", tokens: 31 },
    { content: '{"experienceAxes":[{"word":"系统","hardPromises":["稳定结算"]}', finishReason: "length", tokens: 37 },
    { content: '{"ok":true}', finishReason: "stop", tokens: 43 },
  ];
  let calls = 0;

  const result = await completeJson<{ ok: boolean }>(
    connection,
    connection.routes.planner,
    "只返回开篇规划 JSON",
    "生成开篇规划",
    180_000,
    4_000,
    {
      overallTimeoutMs: 600_000,
      remainingTokens: 100_000,
      now: () => 0,
      stage: "开篇规划",
      truncationTokenTiers: [4_000, 6_000, 8_000],
      secretReader: async () => "test-key",
      retryDelay: async () => undefined,
      traceWriter: async (event) => { events.push(event); },
      modelFetcher: async (_connection, _apiKey, _pathname, init) => {
        requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        const reply = replies[calls] as (typeof replies)[number];
        calls += 1;
        return streamedReply(reply.content, reply.finishReason, reply.tokens);
      },
    },
  );

  assert.deepEqual(result, { value: { ok: true }, usageTokens: 111, usageEstimated: false });
  assert.deepEqual(requests.map((request) => request.max_tokens), [4_000, 6_000, 8_000]);
  assert.deepEqual(
    requests.map((request) => request.response_format),
    Array.from({ length: 3 }, () => ({ type: "json_object" })),
  );
  assert.deepEqual(
    requests.map((request) => (request.messages as Array<{ content: string }>)[1].content),
    ["生成开篇规划", "生成开篇规划", "生成开篇规划"],
  );
  const responseEvents = events.filter((event) => event.event === "response");
  assert.deepEqual(responseEvents.map((event) => event.finishReason), ["length", "length", "stop"]);
  assert.deepEqual(
    responseEvents.map((event) => event.responseCharacters),
    replies.map((reply) => reply.content.length),
  );
});

test("completeJson reports exhausted output tiers as truncation instead of JSON syntax failure", async () => {
  const connection = arkPlannerConnection("conn_json_truncation_exhausted");
  const partialContent = '{"experienceAxes":[{"word":"系统"}';
  let calls = 0;

  await assert.rejects(
    () => completeJson(
      connection,
      connection.routes.planner,
      "只返回 JSON",
      "生成开篇规划",
      180_000,
      4_000,
      {
        overallTimeoutMs: 600_000,
        remainingTokens: 100_000,
        now: () => 0,
        stage: "开篇规划",
        truncationTokenTiers: [4_000, 6_000, 8_000],
        secretReader: async () => "test-key",
        retryDelay: async () => undefined,
        traceWriter: async () => undefined,
        modelFetcher: async () => {
          calls += 1;
          return streamedReply(partialContent, "length", 50);
        },
      },
    ),
    (error: Error & { code?: string; usageTokens?: number }) => {
      assert.equal(error.code, "model_output_truncated");
      assert.equal(error.usageTokens, 150);
      assert.match(error.message, /输出达到 8000 Token 上限/);
      assert.doesNotMatch(error.message, /JSON 解析错误/);
      return true;
    },
  );
  assert.equal(calls, 3);
});
