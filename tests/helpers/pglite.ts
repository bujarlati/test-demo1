import {
  PGlite,
  type PGliteInterface,
  type Transaction,
} from "@electric-sql/pglite";
import type { DatabaseExecutor, QueryResult } from "../../server/database/types";

interface PGliteQueryable {
  query<Row>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}

export { PGlite };

export class PGliteExecutor implements DatabaseExecutor {
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
    return this.database.transaction((transaction: Transaction) => (
      work(new PGliteExecutor(this.database, transaction))
    ));
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}
