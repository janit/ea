/** Database adapter interface for SQLite. */

export type SQLParam = string | number | null | bigint | Uint8Array | boolean;

export interface RunResult {
  lastInsertId: number | bigint;
  changes: number;
}

export interface DbAdapter {
  /** Execute a query and return all matching rows. */
  query<T>(sql: string, ...params: SQLParam[]): Promise<T[]>;

  /** Execute a query and return the first row, or undefined. */
  queryOne<T>(sql: string, ...params: SQLParam[]): Promise<T | undefined>;

  /** Execute a statement (INSERT/UPDATE/DELETE) and return metadata. */
  run(sql: string, ...params: SQLParam[]): Promise<RunResult>;

  /** Execute raw SQL (DDL, multi-statement). No params. */
  exec(sql: string): Promise<void>;

  /** Run a function inside a transaction. Commits on success, rolls back on error. */
  transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T>;

  /** Check whether a column exists on a table. */
  columnExists(table: string, column: string): Promise<boolean>;

  /** Close the database connection. */
  close(): Promise<void>;
}
