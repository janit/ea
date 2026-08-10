// Echelon Analytics — Generic Buffered Writer
//
// Batches records in memory and flushes them periodically via a provided
// insert callback. Used by both the view and event writers.

import type { DbAdapter } from "./db/adapter.ts";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
// After this many back-to-back flush cycles fail, escalate to CRITICAL
// so health checks and logs make the degradation obvious.
const CRITICAL_CYCLE_THRESHOLD = 3;
// Backstop so a steady arrival rate during shutdown cannot loop forever.
const MAX_DRAIN_ROUNDS = 100;

export class BufferedWriter<T> {
  private buffer: T[] = [];
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<boolean> | null = null;
  private dropped = 0;
  private consecutiveFailedCycles = 0;

  constructor(
    private readonly insert: (db: DbAdapter, batch: T[]) => Promise<void>,
    private readonly maxBuffer: number,
    private readonly flushMs: number,
    private readonly label: string,
  ) {}

  get size(): number {
    return this.buffer.length;
  }

  /** Number of back-to-back flush cycles that have fully failed. Zero when healthy. */
  get failedCycles(): number {
    return this.consecutiveFailedCycles;
  }

  /** Records dropped because the buffer was full (per-process total). */
  get droppedCount(): number {
    return this.dropped;
  }

  push(record: T): void {
    if (this.buffer.length < this.maxBuffer) {
      this.buffer.push(record);
    } else {
      this.dropped++;
      if (this.dropped === 1 || this.dropped % 1000 === 0) {
        console.warn(
          `[echelon] ${this.label} buffer full (${this.maxBuffer}) — ${this.dropped} records dropped`,
        );
      }
    }
  }

  start(db: DbAdapter): void {
    if (this.timer || this.startTimer) return;
    const jitter = Math.floor(Math.random() * 5_000);
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.flush(db);
      this.timer = setInterval(() => this.flush(db), this.flushMs);
    }, jitter);
    console.log(
      `[echelon] ${this.label} writer started (flush every ${
        this.flushMs / 1000
      }s)`,
    );
  }

  async stop(db: DbAdapter): Promise<void> {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Drain on an explicit success signal, not on buffer length. Length was a
    // proxy for "did the flush work", and push() keeps running during shutdown
    // as in-flight requests land — so a *successful* flush that was outpaced by
    // new arrivals was misread as a failure and the whole buffer discarded.
    let rounds = 0;
    while (this.buffer.length > 0) {
      if (++rounds > MAX_DRAIN_ROUNDS) {
        console.error(
          `[echelon] CRITICAL: ${this.label} shutdown still draining after ` +
            `${MAX_DRAIN_ROUNDS} rounds — ${this.buffer.length} records LOST`,
        );
        this.buffer.length = 0;
        break;
      }
      if (!await this.flushOnce(db)) {
        console.error(
          `[echelon] CRITICAL: ${this.label} shutdown failed to flush ${this.buffer.length} records — DATA LOST`,
        );
        this.buffer.length = 0;
        break;
      }
    }
  }

  /** Timer-driven flush. Errors are already logged inside flushWithRetry. */
  private flush(db: DbAdapter): Promise<void> {
    return this.flushOnce(db).then(() => {});
  }

  /** Flush one batch. Resolves true if it was written, false if it failed. */
  private flushOnce(db: DbAdapter): Promise<boolean> {
    if (this.flushing) return this.flushing;
    const count = this.buffer.length;
    if (count === 0) return Promise.resolve(true);
    // Snapshot the batch but keep in buffer until insert confirms
    const batch = this.buffer.slice(0, count);
    this.flushing = this.flushWithRetry(db, batch, count)
      .then(() => true, () => false)
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  private async flushWithRetry(
    db: DbAdapter,
    batch: T[],
    count: number,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.insert(db, batch);
        // Only remove records after successful insert
        this.buffer.splice(0, count);
        if (this.consecutiveFailedCycles > 0) {
          console.log(
            `[echelon] ${this.label} flush recovered after ${this.consecutiveFailedCycles} failed cycles`,
          );
          this.consecutiveFailedCycles = 0;
        }
        return;
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          console.warn(
            `[echelon] ${this.label} flush attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${
              RETRY_DELAY_MS * attempt
            }ms...`,
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
        } else {
          this.consecutiveFailedCycles++;
          const severity =
            this.consecutiveFailedCycles >= CRITICAL_CYCLE_THRESHOLD
              ? "CRITICAL: "
              : "";
          console.error(
            `[echelon] ${severity}${this.label} flush failed after ${MAX_RETRIES} attempts ` +
              `(${this.consecutiveFailedCycles} consecutive failed cycles) — ${count} records remain in buffer:`,
            e,
          );
          throw e;
        }
      }
    }
  }
}
