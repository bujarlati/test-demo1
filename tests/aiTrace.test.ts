import assert from "node:assert/strict";
import test from "node:test";
import { completeJson, streamChapterWithConnection, type AiTraceEvent } from "../server/modelGateway";
import type { ModelConnection } from "../src/types";

const connection: ModelConnection = {
  id: "conn_trace_test",
  name: "Trace test",
  ownerScope: "personal",
  ownerId: "user_test",
  protocol: "openai_compatible",
  baseUrl: "https://example.test/v1",
  maskedKey: "sk••••test",
  secretRef: "vault://trace-test",
  secretVersion: 1,
  status: "active",
  routes: { planner: "planner-model", writer: "writer-model", extractor: "extractor-model", embedding: "embedding-model" },
  fallbackPolicy: "none",
  capabilities: null,
  updatedAt: new Date().toISOString(),
};

test("completeJson traces the exact AI request, raw response, parsed value, and never the API key", async () => {
  const events: AiTraceEvent[] = [];
  const result = await completeJson<{ answer: string }>(
    connection,
    connection.routes.planner,
    "system asks for JSON",
    "user asks a question",
    1_000,
    100,
    {
      stage: "trace regression",
      secretReader: async () => "sk-super-secret-value",
      modelFetcher: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"answer":"模型原始回答"}' } }],
        usage: { total_tokens: 42 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
      traceWriter: async (event) => { events.push(event); },
    },
  );

  assert.deepEqual(result.value, { answer: "模型原始回答" });
  assert.deepEqual(events.map((event) => event.event), ["request", "response", "parsed"]);
  assert.equal(events[0].system, "system asks for JSON");
  assert.equal(events[0].prompt, "user asks a question");
  assert.equal(events[1].rawContent, '{"answer":"模型原始回答"}');
  assert.deepEqual(events[2].parsedValue, { answer: "模型原始回答" });
  assert.doesNotMatch(JSON.stringify(events), /sk-super-secret-value/);
});

test("streaming chapter generation traces its complete raw answer and parsed chapter", async () => {
  const events: AiTraceEvent[] = [];
  const rawContent = JSON.stringify({ title: "流式章名", paragraphs: ["第一段正文", "第二段正文", "第三段正文", "第四段正文"] });
  const streamBody = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: rawContent } }], usage: { total_tokens: 64 } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");

  const chapter = await streamChapterWithConnection(
    connection,
    "续写用户提示",
    () => undefined,
    100,
    {
      secretReader: async () => "sk-stream-secret-value",
      modelFetcher: async () => new Response(streamBody, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      traceWriter: async (event) => { events.push(event); },
    },
    Number.POSITIVE_INFINITY,
  );

  assert.equal(chapter.title, "流式章名");
  assert.deepEqual(events.map((event) => event.event), ["request", "response", "parsed"]);
  assert.equal(events[0].prompt, "续写用户提示");
  assert.equal(events[1].rawContent, rawContent);
  assert.deepEqual(events[2].parsedValue, { title: "流式章名", paragraphs: ["第一段正文", "第二段正文", "第三段正文", "第四段正文"] });
  assert.doesNotMatch(JSON.stringify(events), /sk-stream-secret-value/);
});
