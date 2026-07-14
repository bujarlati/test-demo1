import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppStore } from "../src/types";
import { createSeedStore } from "./seed";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
export const dataDirectory = path.join(currentDirectory, "data");
const storePath = path.join(dataDirectory, "store.json");
let saveQueue = Promise.resolve();

export async function loadStore(): Promise<AppStore> {
  await mkdir(dataDirectory, { recursive: true });
  try {
    const contents = await readFile(storePath, "utf8");
    return JSON.parse(contents) as AppStore;
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

export async function saveStore(store: AppStore): Promise<void> {
  const snapshot = JSON.stringify(store, null, 2);
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, snapshot, "utf8");
    await rename(temporaryPath, storePath);
  });
  await saveQueue;
}
