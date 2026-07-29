import assert from "node:assert/strict";
import test from "node:test";
import { api, type GenerationStreamUpdate } from "../src/api";
import type { Story } from "../src/types";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("a transient Load failed stream error reconciles the original chapter job instead of reporting failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const baseStory = {
    id: "story_recovery",
    activeBranchId: "branch_main",
    canonVersion: 2,
    chapters: [{ number: 1 }, { number: 2 }],
  } as Story;
  const completedStory = {
    ...baseStory,
    canonVersion: 3,
    chapters: [...baseStory.chapters, { number: 3 }],
  } as Story;
  const updates: GenerationStreamUpdate[] = [];
  let statusRequests = 0;

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "test-token", setItem: () => undefined, removeItem: () => undefined },
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/chapters/generate")) {
      let readCount = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (readCount++ === 0) {
            controller.enqueue(new TextEncoder().encode('event: stage\ndata: {"stage":2}\n\n'));
          } else {
            controller.error(new TypeError("Load failed"));
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith("/chapters/generation-status")) {
      statusRequests += 1;
      assert.deepEqual(JSON.parse(String(init?.body)), { idempotencyKey: "recovery-key" });
      return statusRequests === 1
        ? jsonResponse({ status: "running", jobId: "job_recovery" })
        : jsonResponse({ status: "completed", jobId: "job_recovery", story: completedStory });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await api.generateChapter(baseStory, (update) => updates.push(update), {
      idempotencyKey: "recovery-key",
      recoveryPollIntervalMs: 0,
      recoveryTimeoutMs: 1_000,
    });
    assert.equal(result.story.canonVersion, 3);
    assert.equal(result.story.chapters.at(-1)?.number, 3);
    assert.equal(statusRequests, 2);
    assert.ok(updates.some((update) => update.event === "reconnecting"));
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
  }
});
test("an explicit server error remains a real generation failure and is not treated as a disconnect", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const story = {
    id: "story_server_failure",
    activeBranchId: "branch_main",
    canonVersion: 4,
  } as Story;
  let statusRequests = 0;

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "test-token", setItem: () => undefined, removeItem: () => undefined },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/chapters/generate")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: error\ndata: {"message":"后台明确拒绝了这次续写。"}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    statusRequests += 1;
    return jsonResponse({ status: "running", jobId: "job_should_not_be_polled" });
  };

  try {
    await assert.rejects(
      api.generateChapter(story, undefined, { idempotencyKey: "server-failure-key" }),
      (error: unknown) => error instanceof Error && error.message === "后台明确拒绝了这次续写。",
    );
    assert.equal(statusRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
  }
});
