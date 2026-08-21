// React Native adapter — AdMob rewarded ads via react-native-google-mobile-ads.
// AdMob is server-side verified (SSV): the token rides as customData, the server
// credits out-of-band, and the runner refreshes balances after "viewed".
//
// The native module is lazy-`require`d (declared an optional peerDependency) so a
// web bundle never pulls it and Expo Go / ads-off builds still run.

import type { AdAdapter, AdShowStatus, ShowInput } from "./types.js";

// Metro provides `require` at runtime; declare it for the TS compiler.
declare const require: (name: string) => any;

export interface AdMobAdapterOptions {
  /** Gate: only attempt ads when true (mirror EXPO_PUBLIC_ADS_ENABLED). */
  enabled?: boolean;
  /** Use Google's platform test ad unit instead of the tier's real unit. */
  testMode?: boolean;
  /** Safety-net timeout (ms). Default 30_000. */
  timeoutMs?: number;
}

export function createAdMobAdapter(options: AdMobAdapterOptions = {}): AdAdapter {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const enabled = options.enabled ?? true;

  let _mod: any; // undefined = not tried, null = unavailable, object = loaded
  let _initStarted = false;

  function mod(): any {
    if (_mod !== undefined) return _mod;
    try {
      _mod = require("react-native-google-mobile-ads");
    } catch {
      _mod = null; // native module not in this build (e.g. Expo Go)
    }
    return _mod;
  }

  function available(): boolean {
    return enabled && !!mod();
  }

  async function init(): Promise<void> {
    if (!available() || _initStarted) return;
    _initStarted = true;
    const m = mod();
    try {
      const { AdsConsent } = m;
      if (AdsConsent) {
        try {
          const info = await AdsConsent.requestInfoUpdate();
          if (info?.isConsentFormAvailable && AdsConsent.loadAndShowConsentFormIfRequired) {
            await AdsConsent.loadAndShowConsentFormIfRequired();
          }
        } catch {
          /* consent flow failed → continue; personalized ads just won't serve */
        }
      }
      const mobileAds = m.default;
      const { MaxAdContentRating } = m;
      await mobileAds().setRequestConfiguration({
        maxAdContentRating: MaxAdContentRating ? MaxAdContentRating.T : undefined,
        tagForChildDirectedTreatment: false,
        tagForUnderAgeOfConsent: false,
      });
      await mobileAds().initialize();
    } catch {
      /* leave un-initialized; showRewarded reports unavailable/nofill */
    }
  }

  function showRewarded(input: ShowInput): Promise<AdShowStatus> {
    return new Promise<AdShowStatus>((resolve) => {
      const m = mod();
      if (!available() || !m) return resolve("unavailable");
      const { RewardedAd, RewardedAdEventType, AdEventType, TestIds } = m;
      const unitId = options.testMode
        ? TestIds.REWARDED
        : (input.networkConfig?.rewarded_ad_unit_id as string) ||
          (input.networkConfig?.ad_unit_id as string) ||
          TestIds.REWARDED;

      let earned = false;
      let settled = false;
      const subs: Array<() => void> = [];
      const done = (status: AdShowStatus) => {
        if (settled) return;
        settled = true;
        subs.forEach((u) => {
          try {
            u();
          } catch {
            /* noop */
          }
        });
        try {
          input.onResume?.();
        } catch {
          /* noop */
        }
        resolve(status);
      };

      try {
        input.onPause?.();
      } catch {
        /* noop */
      }

      try {
        const ad = RewardedAd.createForAdRequest(unitId, {
          serverSideVerificationOptions: { customData: input.token || "" },
        });
        subs.push(
          ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
            try {
              ad.show();
            } catch {
              done("nofill");
            }
          }),
        );
        subs.push(
          ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
            earned = true;
          }),
        );
        subs.push(
          ad.addAdEventListener(AdEventType.CLOSED, () => done(earned ? "viewed" : "dismissed")),
        );
        subs.push(ad.addAdEventListener(AdEventType.ERROR, () => done("nofill")));
        ad.load();
        setTimeout(() => done(earned ? "viewed" : "nofill"), timeoutMs);
      } catch {
        done("nofill");
      }
    });
  }

  return { init, showRewarded };
}
