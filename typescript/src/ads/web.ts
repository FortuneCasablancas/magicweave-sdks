// Web adapter — Google H5 Games Ads (AdSense Ad Placement API: adBreak/adConfig).
// The publisher client id comes from the tier's networkConfig.web_property_code.
// H5 has no SSV → the placement is client-attested and the runner claims after "viewed".

import type { AdAdapter, AdShowStatus, ShowInput } from "./types.js";

declare global {
  interface Window {
    adsbygoogle?: unknown[];
    adBreak?: (o: Record<string, unknown>) => void;
    adConfig?: (o: Record<string, unknown>) => void;
  }
}

export interface H5AdapterOptions {
  /** Render mock creatives without a live/enrolled AdSense account (staging). */
  testMode?: boolean;
  /** Safety-net timeout (ms) if the SDK never calls adBreakDone. Default 30_000. */
  timeoutMs?: number;
  /**
   * Timeout (ms) for loading adsbygoogle.js. A blocked/pending script (ad
   * blocker, network, CSP) fires neither onload nor onerror, so without this
   * the load — and the whole rewarded flow — hangs forever. Default 8_000.
   */
  loadTimeoutMs?: number;
}

function mapStatus(st: unknown): AdShowStatus {
  if (st === "viewed") return "viewed";
  if (st === "dismissed" || st === "ignored") return "dismissed";
  // noAdPreloaded | frequencyCapped | timeout | error | notReady | other
  return "nofill";
}

export function createH5Adapter(options: H5AdapterOptions = {}): AdAdapter {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const loadTimeoutMs = options.loadTimeoutMs ?? 8_000;
  let loaded: Promise<void> | null = null;

  function ensureLoaded(clientId: string): Promise<void> {
    if (loaded) return loaded;
    loaded = new Promise<void>((resolve, reject) => {
      if (!clientId) {
        reject(new Error("no ad client id"));
        return;
      }
      window.adsbygoogle = window.adsbygoogle || [];
      window.adBreak = window.adConfig = function (o: Record<string, unknown>) {
        window.adsbygoogle!.push(o);
      };
      const s = document.createElement("script");
      s.async = true;
      s.src =
        "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" +
        encodeURIComponent(clientId);
      s.crossOrigin = "anonymous";
      if (options.testMode) s.setAttribute("data-adbreak-test", "on");
      // A blocked/pending script never fires onload OR onerror — without this
      // timer ensureLoaded (and the whole rewarded flow) would hang forever.
      const loadTimer = setTimeout(() => {
        loaded = null; // allow a retry later
        reject(new Error("adsbygoogle load timed out"));
      }, loadTimeoutMs);
      s.onload = () => {
        clearTimeout(loadTimer);
        try {
          window.adConfig!({ preloadAdBreaks: "on", sound: "on", onReady() {} });
        } catch {
          /* adConfig is best-effort */
        }
        resolve();
      };
      s.onerror = () => {
        clearTimeout(loadTimer);
        loaded = null; // allow a retry later
        reject(new Error("adsbygoogle failed to load"));
      };
      document.head.appendChild(s);
    });
    return loaded;
  }

  async function showRewarded(input: ShowInput): Promise<AdShowStatus> {
    const clientId = String(
      (input.networkConfig?.web_property_code as string) ??
        (input.networkConfig?.client_id as string) ??
        "",
    );
    try {
      await ensureLoaded(clientId);
    } catch {
      return "nofill";
    }

    return new Promise<AdShowStatus>((resolve) => {
      if (typeof window.adBreak !== "function") {
        resolve("nofill");
        return;
      }
      let settled = false;
      const finish = (r: AdShowStatus) => {
        if (settled) return;
        settled = true;
        try {
          input.onResume?.();
        } catch {
          /* noop */
        }
        resolve(r);
      };
      try {
        window.adBreak({
          type: "reward",
          name: input.name || "reward-" + String(new Date().getTime()),
          beforeReward: (showAdFn: () => void) => {
            try {
              showAdFn();
            } catch {
              /* noop */
            }
          },
          beforeAd: () => {
            try {
              input.onPause?.();
            } catch {
              /* noop */
            }
          },
          adDismissed: () => {},
          adViewed: () => {},
          afterAd: () => {
            try {
              input.onResume?.();
            } catch {
              /* noop */
            }
          },
          adBreakDone: (info: { breakStatus?: string }) =>
            finish(mapStatus(info && info.breakStatus)),
        });
      } catch {
        finish("nofill");
      }
      setTimeout(() => finish("nofill"), timeoutMs);
    });
  }

  return { showRewarded };
}
