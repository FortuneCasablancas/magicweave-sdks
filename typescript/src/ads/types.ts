// Ad-monetization client types. Hand-written (the AdsResource endpoints return
// `unknown`), so this module is not gated on regenerating the OpenAPI snapshot.

export type AdKind = "fill" | "nofill" | "impression";
export type VerificationLevel = "client_attested" | "network_ssv";

/** How a rewarded flow ended, from the caller's point of view. */
export type AdReason = "earned" | "dismissed" | "nofill" | "shown" | "unavailable";

/** One tier of a placement's server-driven waterfall (from /ads/config). */
export interface WaterfallEntry {
  network: string;
  floor_ecpm?: number | null;
  geo?: string;
  /** Per-network ad-unit config (e.g. { rewarded_ad_unit_id } / { web_property_code }). */
  config?: Record<string, unknown>;
}

/** A placement as returned by /ads/config. */
export interface AdPlacementConfig {
  key: string;
  name: string;
  placement_type: string;
  reward_specs?: unknown[];
  caps?: Record<string, number>;
  networks?: Record<string, Record<string, unknown>>;
  waterfall?: WaterfallEntry[];
  test_mode?: boolean;
}

export interface IntentResult {
  intent_id: string;
  token: string;
  verification_level: VerificationLevel;
  min_watch_seconds: number;
  expires_at: number;
}

/**
 * The platform ad endpoints the runner drives — deliberately the exact shape of
 * `@magicweave/sdk`'s `AdsResource` (`mw.ads`), so `createAdsClient({ api: mw.ads })`
 * just works. A game with a hand-rolled client can pass a matching shim.
 */
export interface AdsApi {
  config(): Promise<unknown>;
  createIntent(input: Record<string, unknown>): Promise<unknown>;
  claim(input: Record<string, unknown>, options?: { idempotencyKey?: string }): Promise<unknown>;
  signal(input: Record<string, unknown>): Promise<unknown>;
}

export type AdShowStatus = "viewed" | "dismissed" | "nofill" | "unavailable";

export interface ShowInput {
  network: string;
  /** Intent token — passed to the network as SSV custom_data. */
  token: string;
  /** The tier's per-network config (ad-unit id, publisher code, …). */
  networkConfig?: Record<string, unknown>;
  name?: string;
  onPause?: () => void;
  onResume?: () => void;
}

/**
 * A network integration. `showRewarded` shows one ad for one network and reports
 * only how it ended — verification (SSV vs claim), waterfall order and signalling
 * are the runner's job. `showInterstitial` defaults to `showRewarded` when absent.
 */
export interface AdAdapter {
  /** Idempotent one-time setup (SDK load, consent). Optional. */
  init?(): Promise<void>;
  showRewarded(input: ShowInput): Promise<AdShowStatus>;
  showInterstitial?(input: ShowInput): Promise<AdShowStatus>;
}

export interface AdResult {
  earned: boolean;
  reason: AdReason;
  network?: string;
  verification?: VerificationLevel;
  /** Reward specs known client-side (claim path / house fallback). Empty for SSV. */
  rewards: unknown[];
  /**
   * True when the reward was credited server-side (SSV completion or house
   * fallback) — the host should refresh balances rather than read `rewards`.
   */
  serverGranted: boolean;
}
