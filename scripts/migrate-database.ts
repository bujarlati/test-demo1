import { createPostgresDatabase } from "../server/database/postgres";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("db:migrate 需要 DATABASE_URL。\n示例：postgresql://user:password@host:5432/xumo");

const database = createPostgresDatabase(connectionString);
try {
  await database.migrate();
  await database.health();
  console.log("PostgreSQL schema migration 完成，连接检查通过。");
} finally {
  await database.close();
}
