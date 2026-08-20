/**
 * The one thing a game holds: `Magicweave`.
 *
 * Behaviour E1 in practice — construct it with three values from the console,
 * and everything else (deployment layout, headers, tokens, retries, idempotency
 * keys, the offline queue) is handled below this line.
 */

import { MagicweaveConfigError } from "./errors.js";
import { RealtimeClient } from "./realtime.js";
import {
  AdsResource,
  AuthResource,
  CurrencyResource,
  DocumentsResource,
  GachaResource,
  GameResource,
  InventoryResource,
  LeaderboardResource,
  ProfileResource,
  ShopResource,
  SpinWheelResource,
  StatsResource,
  StreakResource,
  WalletResource,
} from "./resources/index.js";
import { Transport } from "./transport.js";
import type { MagicweaveConfig, QueueEvent, QueueEventName } from "./types.js";

export class Magicweave {
  readonly auth: AuthResource;
  readonly wallet: WalletResource;
  readonly currency: CurrencyResource;
  readonly inventory: InventoryResource;
  readonly shop: ShopResource;
  readonly leaderboards: LeaderboardResource;
  readonly game: GameResource;
  readonly stats: StatsResource;
  readonly profile: ProfileResource;
  readonly spinWheel: SpinWheelResource;
  readonly streak: StreakResource;
  readonly gacha: GachaResource;
  readonly documents: DocumentsResource;
  readonly ads: AdsResource;

  private readonly transport: Transport;
  private realtimeClient: RealtimeClient | null = null;

  constructor(private readonly config: MagicweaveConfig) {
    this.transport = new Transport(config);

    this.auth = new AuthResource(this.transport);
    this.wallet = new WalletResource(this.transport);
    this.currency = new CurrencyResource(this.transport);
    this.inventory = new InventoryResource(this.transport);
    this.shop = new ShopResource(this.transport);
    this.leaderboards = new LeaderboardResource(this.transport);
    this.game = new GameResource(this.transport);
    this.stats = new StatsResource(this.transport);
    this.profile = new ProfileResource(this.transport);
    this.spinWheel = new SpinWheelResource(this.transport);
    this.streak = new StreakResource(this.transport);
    this.gacha = new GachaResource(this.transport);
    this.documents = new DocumentsResource(this.transport);
    this.ads = new AdsResource(this.transport);
  }

  /**
   * Resolve the deployment layout, restore any stored session, and replay
   * writes left over from last time.
   *
   * Optional — every call works without it — but calling it once at boot means
   * the first real request does not pay for the `/healthz` probe, and a player
   * who closed the app offline gets their progress delivered before they
   * notice it was missing.
   */
  async init(): Promise<void> {
    await this.transport.root();
    await this.transport.session.load();
    await this.transport.flush();
  }

  /** True once a player is signed in on this device. */
  get isSignedIn(): boolean {
    return this.transport.session.isAuthenticated;
  }

  // ── the offline queue (E4) ────────────────────────────────────────────────

  /**
   * Writes waiting to be delivered.
   *
   * @example
   * ```ts
   * mw.onQueue("sent", ({ entry }) => toast(`${entry.path} delivered`));
   * mw.onQueue("failed", ({ entry, error }) => report(entry, error));
   * ```
   */
  onQueue(event: QueueEventName, listener: (payload: QueueEvent) => void): () => void {
    return this.transport.queue.on(event, listener);
  }

  /** How many writes are still undelivered. Useful for a "syncing…" indicator. */
  pendingWrites(): Promise<number> {
    return this.transport.queue.size();
  }

  /** Try to deliver everything queued. Call this when connectivity returns. */
  flush(): Promise<void> {
    return this.transport.flush();
  }

  // ── realtime (E6) ─────────────────────────────────────────────────────────

  /**
   * The shared JSON tree. Lazily connects on first subscribe.
   *
   * @example
   * ```ts
   * const stop = (await mw.realtime()).subscribe("lobby/room-1", (value) => {
   *   render(value);
   * });
   * ```
   */
  async realtime(): Promise<RealtimeClient> {
    if (this.realtimeClient) return this.realtimeClient;

    const socketCtor =
      this.config.webSocket ??
      (globalThis as { WebSocket?: unknown }).WebSocket as
        | MagicweaveConfig["webSocket"]
        | undefined;
    if (!socketCtor) {
      throw new MagicweaveConfigError(
        "no WebSocket implementation found — pass one via config.webSocket",
      );
    }

    const root = await this.transport.root();
    const query: Record<string, string> = {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    };
    const token = await this.transport.session.accessToken();
    if (token) query.access_token = token;
    if (this.config.mode === "external" && this.config.externalUserId) {
      query.external_user_id = this.config.externalUserId;
    }

    this.realtimeClient = new RealtimeClient({
      url: `${root.replace(/^http/, "ws")}/realtime/ws`,
      webSocket: socketCtor,
      logger: this.transport.logger,
      query,
    });
    return this.realtimeClient;
  }

  /** Close sockets. Call on shutdown or when the player signs out. */
  dispose(): void {
    this.realtimeClient?.close();
    this.realtimeClient = null;
  }
}

/** Construct and initialise in one step. */
export async function connect(config: MagicweaveConfig): Promise<Magicweave> {
  const client = new Magicweave(config);
  await client.init();
  return client;
}
