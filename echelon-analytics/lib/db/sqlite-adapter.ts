/**
 * SQLite adapter wrapping `node:sqlite` DatabaseSync in the async DbAdapter interface.
 */
import { DatabaseSync } from "node:sqlite";
import type { DbAdapter, RunResult, SQLParam } from "./adapter.ts";

type SqliteValue = null | number | bigint | string | Uint8Array;

/** Convert SQLParam values to types accepted by node:sqlite. */
function toSqlite(params: SQLParam[]): SqliteValue[] {
  return params.map((p) =>
    typeof p === "boolean" ? (p ? 1 : 0) : (p as SqliteValue)
  );
}

export class SqliteAdapter implements DbAdapter {
  private db: DatabaseSync;
  private txQueue: Promise<unknown> = Promise.resolve();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  query<T>(sql: string, ...params: SQLParam[]): Promise<T[]> {
    return Promise.resolve(
      this.db.prepare(sql).all(...toSqlite(params)) as unknown as T[],
    );
  }

  queryOne<T>(sql: string, ...params: SQLParam[]): Promise<T | undefined> {
    return Promise.resolve(
      this.db.prepare(sql).get(...toSqlite(params)) as T | undefined,
    );
  }

  run(sql: string, ...params: SQLParam[]): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...toSqlite(params));
    return Promise.resolve({
      lastInsertId: result.lastInsertRowid,
      changes: Number(result.changes),
    });
  }

  exec(sql: string): Promise<void> {
    this.db.exec(sql);
    return Promise.resolve();
  }

  /**
   * Run `fn` inside a top-level transaction, serialized against every other
   * top-level transaction on this adapter.
   *
   * Nesting is expressed by *which object* you call this on, not by a shared
   * counter. Previously `if (this.txDepth > 0) return this._runTransaction(fn)`
   * skipped the queue whenever any transaction was in flight — and since a
   * transaction callback may await, an unrelated task calling
   * `db.transaction()` in that window silently joined the other transaction as
   * a savepoint. It resolved successfully to its own caller (BufferedWriter
   * then dropped those records as durable) and was discarded when the
   * *other* transaction rolled back.
   *
   * Only the handle passed into the callback can open a savepoint, so an
   * unrelated caller now always queues and gets its own BEGIN/COMMIT.
   */
  transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    const run = () => this._runTransaction(fn);
    const queued = this.txQueue.then(run, run);
    this.txQueue = queued.then(() => {}, () => {});
    return queued;
  }

  private async _runTransaction<T>(
    fn: (tx: DbAdapter) => Promise<T>,
  ): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await fn(new NestedTx(this, this.db, 1));
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  columnExists(table: string, column: string): Promise<boolean> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return Promise.resolve(cols.some((c) => c.name === column));
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

/**
 * The handle handed to a transaction callback.
 *
 * Delegates reads/writes to the same connection, but its `transaction()` opens
 * a SAVEPOINT instead of queueing — that is the only legitimate way to nest.
 * Because a caller can only obtain one of these from inside a callback,
 * nesting cannot be reached by an unrelated concurrent task.
 */
class NestedTx implements DbAdapter {
  constructor(
    private root: SqliteAdapter,
    private db: DatabaseSync,
    private depth: number,
  ) {}

  query<T>(sql: string, ...params: SQLParam[]): Promise<T[]> {
    return this.root.query<T>(sql, ...params);
  }

  queryOne<T>(sql: string, ...params: SQLParam[]): Promise<T | undefined> {
    return this.root.queryOne<T>(sql, ...params);
  }

  run(sql: string, ...params: SQLParam[]): Promise<RunResult> {
    return this.root.run(sql, ...params);
  }

  exec(sql: string): Promise<void> {
    return this.root.exec(sql);
  }

  columnExists(table: string, column: string): Promise<boolean> {
    return this.root.columnExists(table, column);
  }

  /** Closing the connection from inside a transaction is always a bug. */
  close(): Promise<void> {
    return Promise.reject(
      new Error("close() must not be called inside a transaction"),
    );
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    const savepoint = `sp_${this.depth}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(new NestedTx(this.root, this.db, this.depth + 1));
      this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${savepoint}`);
      throw e;
    }
  }
}
