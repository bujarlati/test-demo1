import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPostgresDatabase } from "../server/database/postgres";
import { loadLegacyStoreFromFile } from "../server/storage";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("db:import-json 需要 DATABASE_URL。");

const sourceArgument = process.argv.find((argument) => argument.startsWith("--source="));
const sourcePath = sourceArgument
  ? path.resolve(sourceArgument.slice("--source=".length))
  : path.join(
      path.resolve(process.env.XUMO_DATA_DIRECTORY?.trim() || path.join(process.cwd(), "server", "data")),
      "store.json",
    );
const raw = await readFile(sourcePath);
const sourceFingerprint = createHash("sha256").update(raw).digest("hex");
const database = createPostgresDatabase(connectionString);

try {
  await database.migrate();
  if (await database.hasLegacyImport(sourceFingerprint)) {
    console.log(`已导入过相同快照，安全跳过：${sourcePath}`);
    process.exitCode = 0;
  } else {
    const store = await loadLegacyStoreFromFile(sourcePath);
    const expected = {
      users: store.users.length,
      stories: store.stories.length,
      chapters: store.stories.reduce((total, story) => total + story.chapters.length, 0),
      revisions: store.stories.reduce(
        (total, story) => total + story.chapters.reduce((chapterTotal, chapter) => chapterTotal + chapter.revisions.length, 0),
        0,
      ),
    };
    await database.saveSnapshot(store);
    const actual = await database.counts();
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (actual[key] < expected[key]) {
        throw new Error(`导入校验失败：${key} 期望至少 ${expected[key]}，数据库只有 ${actual[key]}。旧 JSON 未被修改。`);
      }
    }
    await database.recordLegacyImport(sourceFingerprint, sourcePath, expected);
    console.log(`旧 JSON 已复制并校验：${expected.users} 用户，${expected.stories} 故事，${expected.chapters} 章节，${expected.revisions} Revision。`);
    console.log(`原文件保留在 ${sourcePath}`);
  }
} finally {
  await database.close();
}
