/**
 * Behaviours E3 + E4 — crash-safe writes and the offline queue.
 *
 * These are one mechanism, not two. Every write is written to durable storage
 * *before* it is sent, carrying the idempotency key it will use. That single
 * ordering buys both properties:
 *
 * - crash safety — the process can die between persisting and sending, and the
 *   replay on next launch reuses the same key, so the server applies the
 *   operation once (E3);
 * - offline — a send that never leaves the device simply stays in the queue and
 *   drains on reconnect, again with the same key (E4).
 *
 * The whole thing is only safe because the API guarantees idempotent replay.
 * Without that guarantee a retry queue is a double-spend generator.
 */

import type { Logger, QueueEvent, QueueEventName, QueuedWrite, Storage } from "./types.js";

const QUEUE_KEY = "write_queue";

export type QueueListener = (event: QueueEvent) => void;

/** Sends one entry. Resolves with the API result, or throws. */
export type QueueSender = (entry: QueuedWrite) => Promise<unknown>;

/** Decides whether a failure means "try again later" or "this will never work". */
export type RetryDecider = (error: unknown) => boolean;

export class WriteQueue {
  private entries: QueuedWrite[] = [];
  private loaded = false;
  private draining = false;
  private readonly listeners = new Map<QueueEventName, Set<QueueListener>>();

  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
    private readonly logger: Logger,
    private readonly sender: QueueSender,
    private readonly shouldRetry: RetryDecider,
    /** Drop an entry after this many failed attempts. 0 means never drop. */
    private readonly maxAttempts = 0,
  ) {}

  private get key(): string {
    return `${this.namespace}:${QUEUE_KEY}`;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.storage.get(this.key);
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        this.entries = Array.isArray(parsed) ? (parsed as QueuedWrite[]) : [];
      } catch {
        // A corrupt queue is worse than an empty one: replaying garbage could
        // send malformed writes forever. Drop it loudly and move on.
        this.logger.error("write queue was corrupt and has been discarded");
        this.entries = [];
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (this.entries.length === 0) {
      await this.storage.remove(this.key);
      return;
    }
    await this.storage.set(this.key, JSON.stringify(this.entries));
  }

  on(event: QueueEventName, listener: QueueListener): () => void {
    const set = this.listeners.get(event) ?? new Set<QueueListener>();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  private emit(event: QueueEventName, payload: QueueEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        // A listener throwing must not abort the drain.
        this.logger.warn("queue listener threw", error);
      }
    }
  }

  /** Persist an entry before any attempt to send it. */
  async enqueue(entry: QueuedWrite): Promise<void> {
    await this.load();
    this.entries.push(entry);
    await this.persist();
    this.emit("enqueued", { entry });
  }

  async remove(id: string): Promise<void> {
    await this.load();
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.persist();
  }

  async pending(): Promise<QueuedWrite[]> {
    await this.load();
    return [...this.entries];
  }

  async size(): Promise<number> {
    await this.load();
    return this.entries.length;
  }

  /** Forget everything queued. Signing out, or a player wiping their save. */
  async clear(): Promise<void> {
    this.entries = [];
    this.loaded = true;
    await this.persist();
  }

  /**
   * Attempt every pending entry, oldest first.
   *
   * Stops at the first entry that fails retryably — order matters for a game
   * economy (a purchase that spends the coins a later grant provides must not
   * jump the queue), and if the network is down for one entry it is down for
   * the next. Entries that fail *permanently* are dropped, because replaying a
   * 422 forever would wedge the queue behind a request that can never succeed.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.load();
      while (this.entries.length > 0) {
        const entry = this.entries[0] as QueuedWrite;
        entry.attempts += 1;
        try {
          const result = await this.sender(entry);
          this.entries.shift();
          await this.persist();
          this.emit("sent", { entry, result });
        } catch (error) {
          entry.lastError = error instanceof Error ? error.message : String(error);

          const permanent = !this.shouldRetry(error);
          const exhausted =
            this.maxAttempts > 0 && entry.attempts >= this.maxAttempts;

          if (permanent || exhausted) {
            this.entries.shift();
            await this.persist();
            this.logger.warn(
              `dropping queued write ${entry.method} ${entry.path} after ` +
                `${entry.attempts} attempt(s): ${entry.lastError}`,
            );
            this.emit("failed", { entry, error });
            continue;
          }

          await this.persist();
          this.logger.debug(
            `queued write ${entry.method} ${entry.path} still pending: ${entry.lastError}`,
          );
          return;
        }
      }
      this.emit("drained", { entry: undefined as unknown as QueuedWrite });
    } finally {
      this.draining = false;
    }
  }
}
