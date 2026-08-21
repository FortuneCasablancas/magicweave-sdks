/**
 * Resource wrappers — the typed naming layer over the transport.
 *
 * Deliberately thin. Every method is a path, a verb, and a decision about
 * whether the call is a *write* (durable, idempotent, queueable) or a read.
 * That `write: true` flag is the only judgment in this file, and it is the one
 * that matters: mark a mutating call as a read and it silently loses crash
 * safety and the offline queue.
 */

import type { Transport } from "../transport.js";
import type {
  ConsumeResult,
  CurrencyBalance,
  CurrencyBalances,
  InventoryItem,
  InventoryList,
  LeaderboardEntries,
  LeaderboardList,
  MyRank,
  Profile,
  PurchaseResult,
  ShopListing,
  ShopListings,
  PlayerStats,
  Wallet,
  WalletHistory,
} from "../generated/helpers.js";

export interface WriteOptions {
  /**
   * Reuse a key to make this call the *same* logical operation as an earlier
   * one — the server returns the first result instead of applying it twice.
   * Leave it unset and the SDK mints and persists one for you.
   */
  idempotencyKey?: string;
}

export class AuthResource {
  constructor(private readonly t: Transport) {}

  /** Email + password sign-up. The player still has to verify their email. */
  async signup(email: string, password: string): Promise<unknown> {
    return this.t.request({
      method: "POST",
      path: "/auth/signup",
      body: { email, password },
      anonymous: true,
    });
  }

  /** Email + password sign-in. Stores the returned tokens. */
  async login(email: string, password: string): Promise<void> {
    const tokens = await this.t.request<TokenResponse>({
      method: "POST",
      path: "/auth/login",
      body: { email, password },
      anonymous: true,
    });
    await this.store(tokens);
  }

  /** Send a one-time code to the player's email. */
  async requestOtp(email: string): Promise<void> {
    await this.t.request({
      method: "POST",
      path: "/auth/otp/request",
      body: { email },
      anonymous: true,
    });
  }

  /** Exchange the code for a session. */
  async verifyOtp(email: string, otp: string): Promise<void> {
    const tokens = await this.t.request<TokenResponse>({
      method: "POST",
      path: "/auth/otp/verify",
      body: { email, otp },
      anonymous: true,
    });
    await this.store(tokens);
  }

  async signInWithGoogle(idToken: string): Promise<void> {
    const tokens = await this.t.request<TokenResponse>({
      method: "POST",
      path: "/auth/google-signin",
      body: { id_token: idToken },
      anonymous: true,
    });
    await this.store(tokens);
  }

  async signInWithApple(identityToken: string): Promise<void> {
    const tokens = await this.t.request<TokenResponse>({
      method: "POST",
      path: "/auth/apple-signin",
      body: { identity_token: identityToken },
      anonymous: true,
    });
    await this.store(tokens);
  }

  /** Forget the session on this device. Does not revoke server-side. */
  async signOut(): Promise<void> {
    await this.t.session.clear();
  }

  get isSignedIn(): boolean {
    return this.t.session.isAuthenticated;
  }

  private async store(tokens: TokenResponse): Promise<void> {
    if (!tokens?.access_token) return;
    await this.t.session.set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    });
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
}

export class WalletResource {
  constructor(private readonly t: Transport) {}

  get(): Promise<Wallet> {
    return this.t.request({ method: "GET", path: "/wallet" });
  }

  history(limit?: number): Promise<WalletHistory> {
    return this.t.request({ method: "GET", path: "/wallet/history", query: { limit } });
  }
}

export class CurrencyResource {
  constructor(private readonly t: Transport) {}

  balances(): Promise<CurrencyBalances> {
    return this.t.request({ method: "GET", path: "/currency" });
  }

  balance(currencyKey: string): Promise<CurrencyBalance> {
    return this.t.request({ method: "GET", path: `/currency/${encode(currencyKey)}` });
  }

  history(currencyKey?: string, limit?: number): Promise<unknown> {
    return this.t.request({
      method: "GET",
      path: "/currency/history",
      query: { currency_key: currencyKey, limit },
    });
  }
}

export class InventoryResource {
  constructor(private readonly t: Transport) {}

  list(): Promise<InventoryList> {
    return this.t.request({ method: "GET", path: "/inventory" });
  }

  get(itemKey: string): Promise<InventoryItem> {
    return this.t.request({ method: "GET", path: `/inventory/${encode(itemKey)}` });
  }

  history(limit?: number): Promise<unknown> {
    return this.t.request({ method: "GET", path: "/inventory/history", query: { limit } });
  }

  consume(
    itemKey: string,
    input: { quantity?: number; instanceId?: number } = {},
    options: WriteOptions = {},
  ): Promise<ConsumeResult> {
    return this.t.write({
      method: "POST",
      path: `/inventory/${encode(itemKey)}/consume`,
      body: { quantity: input.quantity, instance_id: input.instanceId },
      idempotencyKey: options.idempotencyKey,
    });
  }

  equip(
    itemKey: string,
    instanceId: number,
    slot: string,
    options: WriteOptions = {},
  ): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: `/inventory/${encode(itemKey)}/${instanceId}/equip`,
      body: { slot },
      idempotencyKey: options.idempotencyKey,
    });
  }

  unequip(itemKey: string, instanceId: number, options: WriteOptions = {}): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: `/inventory/${encode(itemKey)}/${instanceId}/unequip`,
      idempotencyKey: options.idempotencyKey,
    });
  }
}

export class ShopResource {
  constructor(private readonly t: Transport) {}

  list(): Promise<ShopListings> {
    return this.t.request({ method: "GET", path: "/shop" });
  }

  get(listingKey: string): Promise<ShopListing> {
    return this.t.request({ method: "GET", path: `/shop/${encode(listingKey)}` });
  }

  history(listingKey: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/shop/${encode(listingKey)}/history` });
  }

  /** Spends in-game currency. Durable and idempotent — a retry cannot double-charge. */
  purchase(listingKey: string, options: WriteOptions = {}): Promise<PurchaseResult> {
    return this.t.write({
      method: "POST",
      path: `/shop/${encode(listingKey)}/purchase`,
      idempotencyKey: options.idempotencyKey,
    });
  }
}

export class LeaderboardResource {
  constructor(private readonly t: Transport) {}

  list(): Promise<LeaderboardList> {
    return this.t.request({ method: "GET", path: "/leaderboards" });
  }

  get(slug: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/leaderboards/${encode(slug)}` });
  }

  entries(slug: string, options: { limit?: number; offset?: number } = {}): Promise<LeaderboardEntries> {
    return this.t.request({
      method: "GET",
      path: `/leaderboards/${encode(slug)}/entries`,
      query: { limit: options.limit, offset: options.offset },
    });
  }

  /** The signed-in player's own rank. */
  me(slug: string): Promise<MyRank> {
    return this.t.request({ method: "GET", path: `/leaderboards/${encode(slug)}/me` });
  }

  /** Neighbours above and below the player — the "you are here" strip. */
  context(slug: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/leaderboards/${encode(slug)}/context` });
  }

  /** Board, entries and the player's rank in one round trip. */
  bundle(slug: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/leaderboards/${encode(slug)}/bundle` });
  }

  standings(slug: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/leaderboards/${encode(slug)}/standings` });
  }

  rewards(slug: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/leaderboards/${encode(slug)}/rewards` });
  }
}

/**
 * A play session: enter (paying any entry cost), record the outcome, or refund.
 *
 * These are the highest-stakes writes in the product — `record` is what moves a
 * score onto a leaderboard and pays out currency — so every one of them is
 * durable and idempotent. Note the idempotency key rides in the *body* here,
 * not the header; the transport handles that difference.
 */
export class GameResource {
  constructor(private readonly t: Transport) {}

  enter(manifestKey: string, options: WriteOptions = {}): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: "/game/enter",
      body: { manifest_key: manifestKey },
      idempotencyKey: options.idempotencyKey,
    });
  }

  enterAndStart(manifestKey: string, options: WriteOptions = {}): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: "/game/enter-and-start",
      body: { manifest_key: manifestKey },
      idempotencyKey: options.idempotencyKey,
    });
  }

  record(input: Record<string, unknown>, options: WriteOptions = {}): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: "/game/record",
      body: input,
      idempotencyKey: options.idempotencyKey,
    });
  }

  refund(input: Record<string, unknown>, options: WriteOptions = {}): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: "/game/refund",
      body: input,
      idempotencyKey: options.idempotencyKey,
    });
  }

  activeSession(): Promise<unknown> {
    return this.t.request({ method: "GET", path: "/game/session" });
  }

  abandonSession(input: Record<string, unknown> = {}): Promise<unknown> {
    return this.t.write({ method: "PUT", path: "/game/session", body: input });
  }
}

export class StatsResource {
  constructor(private readonly t: Transport) {}

  get(): Promise<PlayerStats> {
    return this.t.request({ method: "GET", path: "/stats" });
  }
}

export class ProfileResource {
  constructor(private readonly t: Transport) {}

  get(): Promise<Profile> {
    return this.t.request({ method: "GET", path: "/profile/" });
  }

  byUserId(userId: string | number): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/profile/${encode(String(userId))}` });
  }

  create(input: Record<string, unknown>): Promise<unknown> {
    return this.t.write({ method: "POST", path: "/profile/", body: input });
  }

  update(input: Record<string, unknown>): Promise<unknown> {
    return this.t.write({ method: "PATCH", path: "/profile/", body: input });
  }
}

export class SpinWheelResource {
  constructor(private readonly t: Transport) {}

  list(): Promise<unknown> {
    return this.t.request({ method: "GET", path: "/spin-wheel/wheels" });
  }

  get(keySlug: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/spin-wheel/wheels/by-key/${encode(keySlug)}` });
  }

  state(keySlug: string): Promise<unknown> {
    return this.t.request({
      method: "GET",
      path: `/spin-wheel/wheels/by-key/${encode(keySlug)}/state`,
    });
  }

  /** Preview the odds without consuming a spin. */
  drySpin(keySlug: string): Promise<unknown> {
    return this.t.request({
      method: "POST",
      path: `/spin-wheel/wheels/by-key/${encode(keySlug)}/dry-spin`,
    });
  }

  spin(keySlug: string, options: WriteOptions = {}): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: `/spin-wheel/wheels/by-key/${encode(keySlug)}/spin`,
      idempotencyKey: options.idempotencyKey,
    });
  }

  claim(keySlug: string, input: Record<string, unknown> = {}, options: WriteOptions = {}): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: `/spin-wheel/wheels/by-key/${encode(keySlug)}/claim-spin-reward`,
      body: input,
      idempotencyKey: options.idempotencyKey,
    });
  }
}

export class StreakResource {
  constructor(private readonly t: Transport) {}

  status(keySlug: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/streak/${encode(keySlug)}/status` });
  }

  history(keySlug: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/streak/${encode(keySlug)}/history` });
  }

  checkIn(keySlug: string, options: WriteOptions = {}): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: `/streak/${encode(keySlug)}/check-in`,
      idempotencyKey: options.idempotencyKey,
    });
  }
}

export class GachaResource {
  constructor(private readonly t: Transport) {}

  preview(keySlug: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/gacha-boxes/${encode(keySlug)}/preview` });
  }

  history(keySlug: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/gacha-boxes/${encode(keySlug)}/history` });
  }

  open(keySlug: string, options: WriteOptions = {}): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: `/gacha-boxes/${encode(keySlug)}/open`,
      idempotencyKey: options.idempotencyKey,
    });
  }
}

/**
 * Project-scoped JSON storage. Not player-isolated: any authenticated player
 * can read or write any path, so namespace by user id (`user/{id}/save`) and
 * enforce ownership in your own logic.
 */
export class DocumentsResource {
  constructor(private readonly t: Transport) {}

  get(path: string): Promise<unknown> {
    return this.t.request({ method: "GET", path: `/documents/docs/${encodePath(path)}` });
  }

  set(path: string, data: unknown): Promise<unknown> {
    return this.t.write({
      method: "PUT",
      path: `/documents/docs/${encodePath(path)}`,
      body: { data },
    });
  }

  merge(path: string, data: unknown): Promise<unknown> {
    return this.t.write({
      method: "PATCH",
      path: `/documents/docs/${encodePath(path)}`,
      body: { data },
    });
  }

  delete(path: string): Promise<unknown> {
    return this.t.write({ method: "DELETE", path: `/documents/docs/${encodePath(path)}` });
  }

  list(collection: string): Promise<unknown> {
    return this.t.request({
      method: "GET",
      path: `/documents/collections/${encode(collection)}`,
    });
  }

  add(collection: string, data: unknown): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: `/documents/collections/${encode(collection)}`,
      body: { data },
    });
  }
}

export class AdsResource {
  constructor(private readonly t: Transport) {}

  config(): Promise<unknown> {
    return this.t.request({ method: "GET", path: "/ads/config" });
  }

  /** Declare intent before showing an ad; the network's callback settles it. */
  createIntent(input: Record<string, unknown>): Promise<unknown> {
    return this.t.write({ method: "POST", path: "/ads/intent", body: input });
  }

  claim(input: Record<string, unknown>, options: WriteOptions = {}): Promise<unknown> {
    return this.t.write({
      method: "POST",
      path: "/ads/claim",
      body: input,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Report a fill / no-fill / display-only impression; may grant a no-fill fallback. */
  signal(input: Record<string, unknown>): Promise<unknown> {
    return this.t.write({ method: "POST", path: "/ads/signal", body: input });
  }
}

function encode(segment: string): string {
  return encodeURIComponent(segment);
}

/** Document and realtime paths are multi-segment, so slashes must survive. */
function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}
