/**
 * Behaviour E6 — realtime that reconnects.
 *
 * `/realtime/ws` is outside OpenAPI, so none of this is generated. The server
 * sends `{event:"init", path, value}` on subscribe and `{event:"change", path,
 * value}` on every write beneath that path.
 *
 * Two properties of the underlying tree are worth knowing before you build on
 * it, because the SDK cannot paper over them:
 *
 * - **Writes are last-write-wins.** There is no compare-and-swap, increment, or
 *   multi-key transaction. Two clients patching one shared array will lose
 *   messages. Write each item under its own unique child key instead — which is
 *   why `pushChild()` exists and why there is no `append()`.
 * - **There is no presence and no TTL.** A disconnect drops the server-side
 *   subscription and nothing else; nodes a player "owned" stay exactly as they
 *   were. Presence is something you build, with your own heartbeat.
 */

import type { Logger, WebSocketConstructorLike, WebSocketLike } from "./types.js";

export interface RealtimeMessage {
  event: "init" | "change" | string;
  path: string;
  value: unknown;
}

export type RealtimeListener = (value: unknown, message: RealtimeMessage) => void;

export interface RealtimeOptions {
  url: string;
  webSocket: WebSocketConstructorLike;
  logger: Logger;
  /** Auth headers cannot ride on a browser WebSocket, so they go in the query. */
  query: Record<string, string>;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type ConnectionState = "idle" | "connecting" | "open" | "closed";

export class RealtimeClient {
  private socket: WebSocketLike | null = null;
  private state: ConnectionState = "idle";
  private readonly subscriptions = new Map<string, Set<RealtimeListener>>();
  private reconnectAttempt = 0;
  private closedByCaller = false;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RealtimeOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get connected(): boolean {
    return this.state === "open";
  }

  /**
   * Watch a path. Returns an unsubscribe function.
   *
   * Subscriptions are the SDK's own state, not the socket's — so they are
   * replayed automatically after a reconnect. A caller never has to notice that
   * the connection dropped.
   */
  subscribe(path: string, listener: RealtimeListener): () => void {
    const listeners = this.subscriptions.get(path) ?? new Set<RealtimeListener>();
    const isNewPath = listeners.size === 0;
    listeners.add(listener);
    this.subscriptions.set(path, listeners);

    if (this.state === "open" && isNewPath) this.sendSubscribe(path);
    if (this.state === "idle" || this.state === "closed") void this.connect();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.subscriptions.delete(path);
        if (this.state === "open") this.send({ action: "unsubscribe", path });
      }
    };
  }

  async connect(): Promise<void> {
    if (this.state === "connecting" || this.state === "open") return;
    this.closedByCaller = false;
    this.state = "connecting";

    const params = new URLSearchParams(this.options.query).toString();
    const url = params ? `${this.options.url}?${params}` : this.options.url;

    try {
      const socket = new this.options.webSocket(url);
      this.socket = socket;

      socket.onopen = () => {
        this.state = "open";
        this.reconnectAttempt = 0;
        this.options.logger.debug("realtime connected");
        // Replay every live subscription — the server holds none across a drop.
        for (const path of this.subscriptions.keys()) this.sendSubscribe(path);
      };

      socket.onmessage = (event) => this.handleMessage(event.data);

      socket.onerror = (error) => {
        this.options.logger.debug("realtime socket error", error);
      };

      socket.onclose = () => {
        const wasOpen = this.state === "open";
        this.state = "closed";
        this.socket = null;
        if (wasOpen) this.options.logger.debug("realtime disconnected");
        if (!this.closedByCaller && this.subscriptions.size > 0) {
          void this.scheduleReconnect();
        }
      };
    } catch (error) {
      this.state = "closed";
      this.options.logger.warn("realtime connect failed", error);
      if (!this.closedByCaller && this.subscriptions.size > 0) {
        void this.scheduleReconnect();
      }
    }
  }

  close(): void {
    this.closedByCaller = true;
    this.subscriptions.clear();
    this.socket?.close();
    this.socket = null;
    this.state = "closed";
  }

  private handleMessage(raw: unknown): void {
    let message: RealtimeMessage;
    try {
      message = typeof raw === "string" ? JSON.parse(raw) : (raw as RealtimeMessage);
    } catch {
      this.options.logger.warn("realtime message was not JSON, ignoring");
      return;
    }
    if (!message?.path) return;

    // A change under `/lobby/room-1/players` must also wake a listener on
    // `/lobby/room-1` — the server scopes events to a subtree, so we do too.
    for (const [path, listeners] of this.subscriptions) {
      if (message.path === path || message.path.startsWith(`${path}/`)) {
        for (const listener of listeners) {
          try {
            listener(message.value, message);
          } catch (error) {
            this.options.logger.warn("realtime listener threw", error);
          }
        }
      }
    }
  }

  private sendSubscribe(path: string): void {
    this.send({ action: "subscribe", path });
  }

  private send(payload: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch (error) {
      this.options.logger.debug("realtime send failed", error);
    }
  }

  private async scheduleReconnect(): Promise<void> {
    this.reconnectAttempt += 1;
    const base = this.options.reconnectBaseDelayMs ?? 500;
    const max = this.options.reconnectMaxDelayMs ?? 30_000;
    const delay = Math.min(base * 2 ** (this.reconnectAttempt - 1), max);
    const jittered = Math.round(delay * (1 + Math.random() * 0.3));
    this.options.logger.debug(`realtime reconnecting in ${jittered}ms`);
    await this.sleep(jittered);
    if (!this.closedByCaller) await this.connect();
  }
}
