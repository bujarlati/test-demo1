import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, ApiTransportError, api } from "../src/api";
import {
  deleteStoryWithReconciliation,
  StoryDeletionFailedError,
  StoryDeletionOutcomeUnknownError,
  storyDeletionTitleMatches,
} from "../src/storyDeletion";

function transportError(message = "fetch failed"): ApiTransportError {
  return new ApiTransportError(new TypeError(message));
}

async function withBrowserGlobals(
  fetchImpl: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchImpl,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => key === "xumo-auth-token" ? "test-token" : null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    await run();
  } finally {
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    else Reflect.deleteProperty(globalThis, "fetch");
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("title confirmation trims only outer whitespace and remains case-sensitive", () => {
  assert.equal(storyDeletionTitleMatches("故事 A", "  故事 A  "), true);
  assert.equal(storyDeletionTitleMatches("Story A", "story a"), false);
  assert.equal(storyDeletionTitleMatches("故事 A", "故事  A"), false);
  assert.equal(storyDeletionTitleMatches(" 故事 A ", "故事 A"), false);
});

test("an immediate deletion success does not probe", async () => {
  let probes = 0;
  await deleteStoryWithReconciliation({
    storyId: "story_a",
    confirmationTitle: "故事 A",
    deleteRequest: async () => undefined,
    probeStory: async () => { probes += 1; },
    probeDelaysMs: [0],
  });
  assert.equal(probes, 0);
});

test("a lost response is reconciled after delayed probes confirm 404", async () => {
  const delays: number[] = [];
  let probes = 0;
  await deleteStoryWithReconciliation({
    storyId: "story_a",
    confirmationTitle: "故事 A",
    deleteRequest: async () => { throw transportError(); },
    probeStory: async () => {
      probes += 1;
      if (probes < 3) return;
      throw new ApiError("故事不存在", 404, "story_not_found");
    },
    probeDelaysMs: [10, 20, 40],
    wait: async (milliseconds) => { delays.push(milliseconds); },
  });
  assert.equal(probes, 3);
  assert.deepEqual(delays, [10, 20, 40]);
});

test("a final existence probe reports a clear deletion failure", async () => {
  let probes = 0;
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw transportError(); },
      probeStory: async () => { probes += 1; },
      probeDelaysMs: [0, 0, 0],
      wait: async () => undefined,
    }),
    (error: unknown) => error instanceof StoryDeletionFailedError
      && error.message.includes("故事仍然存在"),
  );
  assert.equal(probes, 3);
});

test("transport loss through the final probe reports an unknown outcome", async () => {
  let probes = 0;
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw transportError("delete response lost"); },
      probeStory: async () => {
        probes += 1;
        throw transportError("probe unavailable");
      },
      probeDelaysMs: [0, 0, 0],
      wait: async () => undefined,
    }),
    (error: unknown) => error instanceof StoryDeletionOutcomeUnknownError
      && error.message.includes("无法确认故事是否已删除"),
  );
  assert.equal(probes, 3);
});

test("nonretry probe API errors are rethrown unchanged without further probes", async () => {
  for (const status of [401, 400]) {
    const apiError = new ApiError(`probe ${status}`, status, `probe_${status}`);
    let probes = 0;
    await assert.rejects(
      deleteStoryWithReconciliation({
        storyId: "story_a",
        confirmationTitle: "故事 A",
        deleteRequest: async () => { throw transportError(); },
        probeStory: async () => {
          probes += 1;
          throw apiError;
        },
        probeDelaysMs: [0, 0, 0],
        wait: async () => undefined,
      }),
      (error: unknown) => error === apiError,
    );
    assert.equal(probes, 1);
  }
});

test("a retryable API failure on the final probe is rethrown unchanged", async () => {
  const finalError = new ApiError("服务暂不可用", 503, "service_unavailable");
  let probes = 0;
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw transportError(); },
      probeStory: async () => {
        probes += 1;
        if (probes === 1) throw transportError("first probe unavailable");
        throw finalError;
      },
      probeDelaysMs: [0, 0],
      wait: async () => undefined,
    }),
    (error: unknown) => error === finalError,
  );
  assert.equal(probes, 2);
});

test("ordinary probe failures are rethrown unchanged", async () => {
  const programmingError = new Error("unexpected probe failure");
  let probes = 0;
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw transportError(); },
      probeStory: async () => {
        probes += 1;
        throw programmingError;
      },
      probeDelaysMs: [0, 0],
      wait: async () => undefined,
    }),
    (error: unknown) => error === programmingError,
  );
  assert.equal(probes, 1);
});

test("structured deletion API failures are rethrown without a probe", async () => {
  const apiError = new ApiError("任务仍在运行", 409, "story_delete_busy");
  let probes = 0;
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw apiError; },
      probeStory: async () => { probes += 1; },
    }),
    (error: unknown) => error === apiError,
  );
  assert.equal(probes, 0);
});

test("raw TypeError and programming deletion failures do not trigger probes", async () => {
  for (const clientError of [new TypeError("client bug"), new Error("programming bug")]) {
    let probes = 0;
    await assert.rejects(
      deleteStoryWithReconciliation({
        storyId: "story_a",
        confirmationTitle: "故事 A",
        deleteRequest: async () => { throw clientError; },
        probeStory: async () => { probes += 1; },
      }),
      (error: unknown) => error === clientError,
    );
    assert.equal(probes, 0);
  }
});

test("a final existence result is authoritative after earlier transport loss", async () => {
  let probes = 0;
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw transportError(); },
      probeStory: async () => {
        probes += 1;
        if (probes < 3) throw transportError("probe unavailable");
      },
      probeDelaysMs: [0, 0, 0],
      wait: async () => undefined,
    }),
    (error: unknown) => error instanceof StoryDeletionFailedError,
  );
  assert.equal(probes, 3);
});

test("a final transport loss makes an earlier existence result inconclusive", async () => {
  let probes = 0;
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw transportError(); },
      probeStory: async () => {
        probes += 1;
        if (probes > 1) throw transportError("probe unavailable");
      },
      probeDelaysMs: [0, 0, 0],
      wait: async () => undefined,
    }),
    (error: unknown) => error instanceof StoryDeletionOutcomeUnknownError,
  );
  assert.equal(probes, 3);
});

test("probe timeout is bounded even when the probe ignores AbortSignal", async () => {
  let probes = 0;
  let probeSignal: AbortSignal | undefined;
  await assert.rejects(
    deleteStoryWithReconciliation({
      storyId: "story_a",
      confirmationTitle: "故事 A",
      deleteRequest: async () => { throw transportError(); },
      probeStory: async (_storyId, signal) => {
        probes += 1;
        probeSignal = signal;
        return new Promise<never>(() => undefined);
      },
      probeDelaysMs: [0],
      probeTimeoutMs: 1,
      wait: async () => undefined,
    }),
    (error: unknown) => error instanceof StoryDeletionOutcomeUnknownError,
  );
  assert.equal(probes, 1);
  assert.equal(probeSignal?.aborted, true);
});

test("api.deleteStory sends encoded authenticated DELETE JSON and accepts 204", async () => {
  let calls = 0;
  await withBrowserGlobals(async (input, init) => {
    calls += 1;
    assert.equal(String(input), "/api/stories/story%2Fa%20%3F");
    assert.equal(init?.method, "DELETE");
    assert.deepEqual(JSON.parse(String(init?.body)), { confirmationTitle: "故事 A" });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer test-token");
    assert.equal(headers.get("Content-Type"), "application/json");
    return new Response(null, { status: 204 });
  }, async () => {
    assert.equal(await api.deleteStory("story/a ?", "故事 A"), undefined);
  });
  assert.equal(calls, 1);
});

test("api.deleteStory preserves structured API errors", async () => {
  await withBrowserGlobals(async () => new Response(JSON.stringify({
    message: "确认标题不匹配",
    code: "story_delete_confirmation_mismatch",
    details: { field: "confirmationTitle" },
  }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  }), async () => {
    await assert.rejects(
      api.deleteStory("story_a", "错标题"),
      (error: unknown) => error instanceof ApiError
        && error.status === 400
        && error.code === "story_delete_confirmation_mismatch"
        && error.message === "确认标题不匹配"
        && error.details?.field === "confirmationTitle",
    );
  });
});

test("shared API requests wrap fetch TypeError as ApiTransportError", async () => {
  const fetchError = new TypeError("fetch failed");
  await withBrowserGlobals(async () => { throw fetchError; }, async () => {
    await assert.rejects(
      api.deleteStory("story_a", "故事 A"),
      (error: unknown) => error instanceof ApiTransportError && error.cause === fetchError,
    );
  });
});

test("api.probeOwnedStory uses the encoded read-only state route and preserves 404", async () => {
  let calls = 0;
  await withBrowserGlobals(async (input, init) => {
    calls += 1;
    assert.equal(String(input), "/api/stories/story%2Fwith%20space/state");
    assert.equal(init?.method, undefined);
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
    if (calls === 1) {
      return new Response(JSON.stringify({ canonVersion: 3 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "故事不存在", code: "story_not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }, async () => {
    await api.probeOwnedStory("story/with space");
    await assert.rejects(
      api.probeOwnedStory("story/with space"),
      (error: unknown) => error instanceof ApiError
        && error.status === 404
        && error.code === "story_not_found",
    );
  });
  assert.equal(calls, 2);
});
