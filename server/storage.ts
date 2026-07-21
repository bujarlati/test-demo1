import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppStore } from "../src/types";
import { createSeedStore } from "./seed";
import { captureCanonState } from "./canonState";
import { createLegacyExperienceContract } from "./readingExperience";

export const dataDirectory = path.join(process.cwd(), "server", "data");
const storePath = path.join(dataDirectory, "store.json");

export function createStoreSaveQueue(writeSnapshot: (snapshot: string) => Promise<void>) {
  let queue = Promise.resolve();
  return async (store: AppStore, rollbackOnFailure?: () => void): Promise<void> => {
    // Capture before yielding to the queue. Otherwise a later request can mutate the
    // shared store and leak its uncommitted state into an earlier successful write.
    const snapshot = JSON.stringify(store, null, 2);
    queue = queue.catch(() => undefined).then(async () => {
      try {
        await writeSnapshot(snapshot);
      } catch (error) {
        rollbackOnFailure?.();
        throw error;
      }
    });
    await queue;
  };
}

export function createStoreMutationGate() {
  let tail = Promise.resolve();
  return async (): Promise<() => void> => {
    const predecessor = tail.catch(() => undefined);
    let releaseSlot!: () => void;
    const slot = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    tail = predecessor.then(() => slot);
    await predecessor;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
  };
}

export function shouldAbandonQueuedRequest(
  request: { aborted: boolean; destroyed: boolean },
  response: { writableEnded: boolean },
): boolean {
  // A fully consumed JSON request can be marked destroyed even though the
  // client did not abort. Only the explicit aborted signal is authoritative.
  return request.aborted || response.writableEnded;
}

const enqueueStoreSave = createStoreSaveQueue(async (snapshot) => {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, snapshot, "utf8");
  await rename(temporaryPath, storePath);
});

function normalizeStore(store: AppStore): AppStore {
  store.safetyDecisions ??= [];
  store.contentReports ??= [];
  store.idempotencyKeys ??= [];
  store.storyCreationRequests ??= [];
  store.jobs ??= [];
  for (const story of store.stories ?? []) {
    story.readingExperience ??= createLegacyExperienceContract({
      tone: story.tone,
      genre: story.genre,
      effectiveFromChapter: story.chapters.length + 1,
      createdAt: story.updatedAt,
    });
    story.proposals ??= [];
    story.items ??= [];
    story.constraints ??= [];
    story.worldBible ??= {
      version: 1,
      organizations: [],
      locations: [...new Set((story.characters ?? []).map((character) => character.location).filter(Boolean))],
      abilityBoundaries: (story.rules ?? []).filter((rule) => rule.hardness === "hard").map((rule) => rule.description),
      pointOfView: "近距离第三人称",
      styleParameters: [story.tone],
      sourceRevisionIds: story.chapters.slice(0, 3).map((chapter) => chapter.currentRevisionId),
    };
    story.summaries ??= [
      ...story.chapters.map((chapter) => ({
        id: `summary_${story.id}_chapter_${chapter.number}`,
        branchId: story.activeBranchId,
        layer: "chapter" as const,
        text: `${chapter.title}：${chapter.revisions.find((revision) => revision.id === chapter.currentRevisionId)?.paragraphs.at(-1) ?? ""}`.slice(0, 420),
        fromChapter: chapter.number,
        toChapter: chapter.number,
        sourceRevisionIds: [chapter.currentRevisionId],
        updatedAt: story.updatedAt,
      })),
      { id: `summary_${story.id}_book`, branchId: story.activeBranchId, layer: "book" as const, text: story.summary, fromChapter: 1, toChapter: story.chapters.length, sourceRevisionIds: story.chapters.slice(-12).map((chapter) => chapter.currentRevisionId), updatedAt: story.updatedAt },
    ];
    for (const summary of story.summaries) summary.branchId ??= story.activeBranchId;
    story.branches ??= [{
      id: story.activeBranchId,
      name: "迁移后的主线",
      basedOnBranchId: null,
      baseCanonVersion: 1,
      headCanonVersion: story.canonVersion,
      createdAt: story.updatedAt,
      status: "active",
      chapterRevisionIds: Object.fromEntries(story.chapters.map((chapter) => [chapter.id, chapter.currentRevisionId])),
      baseEventSequence: story.events?.length ?? 0,
    }];
    for (const branch of story.branches) {
      branch.chapterRevisionIds ??= Object.fromEntries(story.chapters.map((chapter) => [chapter.id, chapter.currentRevisionId]));
      branch.baseEventSequence ??= Math.max(0, ...(story.events ?? []).filter((event) => event.branchId === branch.id).map((event) => event.sequence ?? 0));
    }
    story.readingProgress.progressVersion ??= 1;
    story.readingProgress.activeBranchId ??= story.activeBranchId;
    story.readingProgress.canonVersion ??= story.canonVersion;
    story.conversationThreads ??= [{ id: `thread_${story.id}_main`, branchId: story.activeBranchId, summary: null, summaries: [], parentThreadId: null }];
    if (story.conversationThreads.length === 0) story.conversationThreads.push({ id: `thread_${story.id}_main`, branchId: story.activeBranchId, summary: null, summaries: [], parentThreadId: null });
    for (const thread of story.conversationThreads) {
      thread.summaries ??= thread.summary ? [thread.summary] : [];
      thread.parentThreadId ??= null;
      for (const [index, summary] of thread.summaries.entries()) {
        summary.version ??= index + 1;
        summary.parentSummaryId ??= index > 0 ? thread.summaries[index - 1].id : null;
        summary.sourceThreadId ??= thread.id;
      }
      if (thread.summary) {
        thread.summary.version ??= thread.summaries.length || 1;
        thread.summary.parentSummaryId ??= thread.summaries.length > 1 ? thread.summaries.at(-2)?.id ?? null : null;
        thread.summary.sourceThreadId ??= thread.id;
      }
    }
    const defaultThread = story.conversationThreads.find((thread) => thread.branchId === story.activeBranchId) ?? story.conversationThreads[0];
    for (const message of story.conversation ?? []) {
      message.branchId ??= story.activeBranchId;
      message.threadId ??= defaultThread.id;
    }
    for (const character of story.characters ?? []) {
      character.lifecycle ??= /死亡|死去/.test(character.status)
        ? "dead"
        : /失踪/.test(character.status)
          ? "missing"
          : "alive";
      character.knowledgeSources ??= character.knowledge.map((fact) => ({
        fact,
        sourceChapter: 1,
        sourceRevisionId: story.chapters[0]?.currentRevisionId ?? "migration_unknown",
      }));
      character.inventoryItemIds ??= [];
    }
    for (const [index, event] of (story.events ?? []).entries()) {
      event.sequence ??= index + 1;
      if (event.cause === "上一章留下的未解线索") event.cause = "尚未查明的异常痕迹仍在现场";
      if (/^第\s*\d+\s*章产生一条可继续追查的事实$/.test(event.outcome)) event.outcome = "现场新增一条可继续追查的事实";
      event.storyTime ??= `事件序列${event.sequence}·场景1`;
      event.storyTime = event.storyTime.replace(/^第\d+章·场景/, `事件序列${event.sequence}·场景`);
      event.branchId ??= story.activeBranchId;
    }
    for (const chapter of story.chapters ?? []) {
      for (const revision of chapter.revisions ?? []) revision.branchId ??= story.activeBranchId;
    }
    const migratedState = captureCanonState(story);
    for (const branch of story.branches) {
      branch.stateSnapshot ??= structuredClone(migratedState);
      branch.baseStateSnapshot ??= structuredClone(migratedState);
    }
    for (const retcon of story.retcons ?? []) {
      for (const snapshot of retcon.characterSnapshots ?? []) {
        const relationship = story.characters.find((character) => character.id === snapshot.characterId)?.relationship ?? "未记录";
        snapshot.before.relationship ??= relationship;
        snapshot.after.relationship ??= relationship;
      }
    }
  }
  for (const job of store.jobs) {
    const story = store.stories.find((item) => item.id === job.storyId) ?? store.stories.find((item) => item.title === job.storyTitle);
    job.storyId ??= story?.id ?? "story_unknown";
    job.ownerId ??= story?.ownerId ?? "system";
  }
  for (const connection of store.connections ?? []) {
    connection.secretVersion ??= connection.secretRef.startsWith("platform://") ? 0 : 1;
    if (connection.capabilities) {
      connection.capabilities.toolCalling ??= false;
      connection.capabilities.maxContextTokens ??= null;
    }
  }
  return store;
}

export async function loadStore(): Promise<AppStore> {
  await mkdir(dataDirectory, { recursive: true });
  try {
    const contents = await readFile(storePath, "utf8");
    return normalizeStore(JSON.parse(contents) as AppStore);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) {
      throw error;
    }
    const store = createSeedStore();
    await saveStore(store);
    return store;
  }
}

export async function saveStore(store: AppStore, rollbackOnFailure?: () => void): Promise<void> {
  await enqueueStoreSave(store, rollbackOnFailure);
}
