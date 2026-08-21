import type {
  AdAdapter,
  AdPlacementConfig,
  AdResult,
  AdsApi,
  IntentResult,
  ShowInput,
  WaterfallEntry,
} from "./types.js";

export interface AdsClientOptions {
  /** The platform ad endpoints — `mw.ads` satisfies this, or pass a shim. */
  api: AdsApi;
  /** The network integration for this platform (H5 web / AdMob RN). */
  adapter: AdAdapter;
  /** Muted/paused around every ad. */
  hooks?: { onPause?: () => void; onResume?: () => void };
  /** /ads/config cache TTL (ms). Default 60_000. Set 0 to disable. */
  configTtlMs?: number;
}

export interface AdsClient {
  /** Rewarded flow: walk the placement's waterfall, show, grant (claim or SSV). */
  showAdAtPlacement(key: string): Promise<AdResult>;
  /** Display-only interstitial: show the top tier, record an impression, no reward. */
  showInterstitial(key: string): Promise<AdResult>;
  /** Drop the cached /ads/config (e.g. after a config change). */
  refreshConfig(): void;
}

const NOFILL = (): AdResult => ({
  earned: false,
  reason: "nofill",
  rewards: [],
  serverGranted: false,
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function placementsOf(config: unknown): AdPlacementConfig[] {
  if (Array.isArray(config)) return config as AdPlacementConfig[];
  const list = asRecord(config).placements;
  return Array.isArray(list) ? (list as AdPlacementConfig[]) : [];
}

function intentOf(raw: unknown): IntentResult {
  const r = asRecord(raw);
  return {
    intent_id: String(r.intent_id ?? ""),
    token: String(r.token ?? ""),
    verification_level:
      r.verification_level === "client_attested" ? "client_attested" : "network_ssv",
    min_watch_seconds: Number(r.min_watch_seconds ?? 0),
    expires_at: Number(r.expires_at ?? 0),
  };
}

function rewardsOf(raw: unknown): unknown[] {
  const r = asRecord(raw).rewards;
  return Array.isArray(r) ? r : [];
}

export function createAdsClient(opts: AdsClientOptions): AdsClient {
  const { api, adapter } = opts;
  const ttl = opts.configTtlMs ?? 60_000;
  let cache: { at: number; data: AdPlacementConfig[] } | null = null;

  async function placements(): Promise<AdPlacementConfig[]> {
    if (ttl > 0 && cache && Date.now() - cache.at < ttl) return cache.data;
    const data = placementsOf(await api.config());
    cache = { at: Date.now(), data };
    return data;
  }

  async function find(key: string): Promise<AdPlacementConfig | null> {
    return (await placements()).find((p) => p.key === key) ?? null;
  }

  // Explicit waterfall if present, else derive an implicit order from the
  // placement's own network map (mirrors the backend's effective_waterfall).
  function tiers(p: AdPlacementConfig): WaterfallEntry[] {
    if (p.waterfall && p.waterfall.length) return p.waterfall;
    return Object.entries(p.networks ?? {}).map(([network, config]) => ({ network, config }));
  }

  function showInput(key: string, tier: WaterfallEntry, token: string): ShowInput {
    return {
      network: tier.network,
      token,
      networkConfig: tier.config,
      name: `${key}-${tier.network}`,
      onPause: opts.hooks?.onPause,
      onResume: opts.hooks?.onResume,
    };
  }

  async function ensureInit(): Promise<void> {
    if (adapter.init) {
      try {
        await adapter.init();
      } catch {
        /* init is best-effort; showRewarded reports unavailable/nofill */
      }
    }
  }

  async function safeSignal(
    placement: string,
    kind: "fill" | "nofill" | "impression",
    network: string | undefined,
    token: string,
  ): Promise<unknown> {
    try {
      return await api.signal({ placement, kind, network, token });
    } catch {
      return null;
    }
  }

  async function showAdAtPlacement(key: string): Promise<AdResult> {
    const p = await find(key);
    if (!p) return NOFILL();
    await ensureInit();

    let lastToken: string | null = null;
    for (const tier of tiers(p)) {
      let intent: IntentResult;
      try {
        intent = intentOf(await api.createIntent({ placement: key, network: tier.network }));
      } catch {
        // Intent refused for this network (not connected / suppressed / paced) —
        // try the next tier. If they all refuse we fall through to no-fill.
        continue;
      }
      lastToken = intent.token;

      const status = await adapter.showRewarded(showInput(key, tier, intent.token));

      if (status === "viewed") {
        await safeSignal(key, "fill", tier.network, intent.token);
        if (intent.verification_level === "client_attested") {
          // Web (H5) etc.: no SSV — the server-attested claim grants + returns it.
          const res = await api.claim({
            token: intent.token,
            watched_seconds: intent.min_watch_seconds,
          });
          return {
            earned: true,
            reason: "earned",
            network: tier.network,
            verification: "client_attested",
            rewards: rewardsOf(res),
            serverGranted: false,
          };
        }
        // SSV: the network verifies + the server credits out-of-band → refresh balances.
        return {
          earned: true,
          reason: "earned",
          network: tier.network,
          verification: "network_ssv",
          rewards: [],
          serverGranted: true,
        };
      }

      if (status === "dismissed") {
        return {
          earned: false,
          reason: "dismissed",
          network: tier.network,
          rewards: [],
          serverGranted: false,
        };
      }
      // nofill | unavailable → next tier
    }

    // Every tier failed to fill. Report no-fill; if we minted at least one intent,
    // the signal may grant the placement's house fallback (bound to that intent).
    if (lastToken) {
      const rewards = rewardsOf(await safeSignal(key, "nofill", undefined, lastToken));
      return { earned: false, reason: "nofill", rewards, serverGranted: rewards.length > 0 };
    }
    return NOFILL();
  }

  async function showInterstitial(key: string): Promise<AdResult> {
    const p = await find(key);
    if (!p) return NOFILL();
    await ensureInit();

    const tier = tiers(p)[0];
    if (!tier) return NOFILL();

    let intent: IntentResult;
    try {
      // A lightweight intent still runs caps/pacing for the interstitial.
      intent = intentOf(await api.createIntent({ placement: key, network: tier.network }));
    } catch {
      return NOFILL();
    }

    const show = adapter.showInterstitial ?? adapter.showRewarded;
    const status = await show.call(adapter, showInput(key, tier, intent.token));

    // Display-only: record an impression, grant nothing.
    await safeSignal(key, "impression", tier.network, intent.token);

    const reason = status === "viewed" ? "shown" : status === "dismissed" ? "dismissed" : "nofill";
    return { earned: false, reason, network: tier.network, rewards: [], serverGranted: false };
  }

  return {
    showAdAtPlacement,
    showInterstitial,
    refreshConfig() {
      cache = null;
    },
  };
}
