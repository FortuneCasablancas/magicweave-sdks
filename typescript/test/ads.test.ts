import { describe, expect, it, vi } from "vitest";

import { createAdsClient } from "../src/ads/runner.js";
import type { AdAdapter, AdsApi, AdShowStatus } from "../src/ads/types.js";

type MockApi = AdsApi & { signals: Array<Record<string, unknown>> };

function makeApi(over: Partial<AdsApi> = {}): MockApi {
  const signals: Array<Record<string, unknown>> = [];
  const api: MockApi = {
    config: vi.fn(async () => ({
      placements: [
        {
          key: "revive",
          name: "Revive",
          placement_type: "rewarded",
          waterfall: [
            { network: "admob", config: { rewarded_ad_unit_id: "u1" } },
            { network: "h5_games_ads", config: { web_property_code: "ca-pub" } },
          ],
        },
      ],
    })),
    createIntent: vi.fn(async (input: Record<string, unknown>) => ({
      intent_id: "i-" + String(input.network),
      token: "tok-" + String(input.network),
      verification_level: input.network === "h5_games_ads" ? "client_attested" : "network_ssv",
      min_watch_seconds: 5,
      expires_at: 0,
    })),
    claim: vi.fn(async () => ({
      status: "granted",
      rewards: [{ reward_type: "currency", currency_key: "coins", amount: 15 }],
    })),
    signal: vi.fn(async (input: Record<string, unknown>) => {
      signals.push(input);
      return { status: "recorded", rewards: [] };
    }),
    ...over,
    signals: [] as Array<Record<string, unknown>>,
  } as MockApi;
  api.signals = signals;
  return api;
}

function adapterReturning(seq: AdShowStatus[] | AdShowStatus): AdAdapter {
  const queue = Array.isArray(seq) ? [...seq] : null;
  return {
    showRewarded: vi.fn(async () => (queue ? (queue.shift() ?? "nofill") : (seq as AdShowStatus))),
  };
}

describe("showAdAtPlacement", () => {
  it("SSV network: earned → serverGranted, no claim, fill signalled", async () => {
    const api = makeApi();
    const client = createAdsClient({ api, adapter: adapterReturning("viewed") });
    const res = await client.showAdAtPlacement("revive");

    expect(res).toMatchObject({
      earned: true,
      reason: "earned",
      network: "admob",
      verification: "network_ssv",
      serverGranted: true,
      rewards: [],
    });
    expect(api.claim).not.toHaveBeenCalled();
    expect(api.signals).toEqual([{ placement: "revive", kind: "fill", network: "admob", token: "tok-admob" }]);
  });

  it("client-attested network: earned → claims and returns rewards", async () => {
    const api = makeApi();
    const client = createAdsClient({ api, adapter: adapterReturning(["nofill", "viewed"]) });
    const res = await client.showAdAtPlacement("revive");

    expect(res.earned).toBe(true);
    expect(res.verification).toBe("client_attested");
    expect(res.serverGranted).toBe(false);
    expect(res.rewards).toHaveLength(1);
    expect(api.claim).toHaveBeenCalledWith({ token: "tok-h5_games_ads", watched_seconds: 5 });
  });

  it("walks the waterfall in order on no-fill", async () => {
    const api = makeApi();
    const client = createAdsClient({ api, adapter: adapterReturning(["nofill", "viewed"]) });
    const res = await client.showAdAtPlacement("revive");
    expect(res.network).toBe("h5_games_ads");
    expect((api.createIntent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].network)).toEqual([
      "admob",
      "h5_games_ads",
    ]);
  });

  it("dismissed → stops, no reward", async () => {
    const api = makeApi();
    const client = createAdsClient({ api, adapter: adapterReturning("dismissed") });
    const res = await client.showAdAtPlacement("revive");
    expect(res).toMatchObject({ earned: false, reason: "dismissed", serverGranted: false });
    expect(api.claim).not.toHaveBeenCalled();
  });

  it("all tiers no-fill → nofill signal grants house fallback", async () => {
    const api = makeApi({
      signal: vi.fn(async (input: Record<string, unknown>) =>
        input.kind === "nofill"
          ? { status: "recorded", rewards: [{ reward_type: "currency", currency_key: "coins", amount: 5 }] }
          : { status: "recorded", rewards: [] },
      ),
    });
    const client = createAdsClient({ api, adapter: adapterReturning("nofill") });
    const res = await client.showAdAtPlacement("revive");
    expect(res.reason).toBe("nofill");
    expect(res.serverGranted).toBe(true);
    expect(res.rewards).toHaveLength(1);
    expect(api.signal).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "nofill", token: "tok-h5_games_ads" }),
    );
  });

  it("intent refused on every tier → nofill, no signal", async () => {
    const api = makeApi({
      createIntent: vi.fn(async () => {
        throw new Error("403 suppressed");
      }),
    });
    const client = createAdsClient({ api, adapter: adapterReturning("viewed") });
    const res = await client.showAdAtPlacement("revive");
    expect(res.reason).toBe("nofill");
    expect(res.serverGranted).toBe(false);
    expect(api.signal).not.toHaveBeenCalled();
  });

  it("unknown placement → nofill", async () => {
    const api = makeApi();
    const client = createAdsClient({ api, adapter: adapterReturning("viewed") });
    const res = await client.showAdAtPlacement("does-not-exist");
    expect(res.reason).toBe("nofill");
    expect(api.createIntent).not.toHaveBeenCalled();
  });
});

describe("showInterstitial", () => {
  it("records an impression and grants nothing", async () => {
    const api = makeApi({
      config: vi.fn(async () => ({
        placements: [
          {
            key: "gameover",
            name: "Game over",
            placement_type: "interstitial",
            waterfall: [{ network: "admob", config: {} }],
          },
        ],
      })),
    });
    const client = createAdsClient({ api, adapter: adapterReturning("viewed") });
    const res = await client.showInterstitial("gameover");
    expect(res).toMatchObject({ earned: false, reason: "shown", serverGranted: false });
    expect(api.claim).not.toHaveBeenCalled();
    expect(api.signals).toEqual([{ placement: "gameover", kind: "impression", network: "admob", token: "tok-admob" }]);
  });
});

describe("config cache", () => {
  it("caches config within the TTL", async () => {
    const api = makeApi();
    const client = createAdsClient({ api, adapter: adapterReturning("dismissed") });
    await client.showAdAtPlacement("revive");
    await client.showAdAtPlacement("revive");
    expect(api.config).toHaveBeenCalledTimes(1);
    client.refreshConfig();
    await client.showAdAtPlacement("revive");
    expect(api.config).toHaveBeenCalledTimes(2);
  });
});
