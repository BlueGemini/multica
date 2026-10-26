"use client";

import { useEffect } from "react";
import { isSensitiveAnalyticsUrl, sanitizeAnalyticsUrl } from "@/config/google-analytics";

type Gtag = (...args: unknown[]) => void;
type GaWindow = Window & {
  dataLayer?: unknown[];
  gtag?: Gtag;
  __multicaGoogleAnalytics?: string;
  [disableKey: `ga-disable-${string}`]: boolean | undefined;
};

/**
 * Google tag (gtag.js) for GA4. Rendered only when the root layout resolved a
 * Measurement ID from GOOGLE_ANALYTICS_ID (config/google-analytics.ts).
 *
 * Privacy gate: several routes carry live credentials in the URL (IM bind
 * tokens, OAuth code/state, CLI login state, invitation ids), and GA records
 * the full page URL and referrer — including on the history-change page views
 * of enhanced measurement, which read location directly and can't be
 * sanitized from code. So instead of rewriting URLs we hold GA's documented
 * per-property kill switch, `window['ga-disable-<ID>']`, on whenever the
 * current URL, the URL being left, or the landing referrer is sensitive. It
 * is flipped inside our pushState/replaceState/popstate hooks, which are
 * installed before gtag.js loads, so the flag is already set by the time
 * gtag observes the navigation. Cost: the first clean page after a sensitive
 * one is not counted.
 */
export function GoogleAnalytics({ measurementId }: { measurementId: string }) {
  useEffect(() => {
    const w = window as unknown as GaWindow;
    // Install once per page: the root layout never unmounts, and StrictMode /
    // Fast Refresh re-runs must not stack history hooks or reload gtag.js.
    if (w.__multicaGoogleAnalytics === measurementId) return;
    w.__multicaGoogleAnalytics = measurementId;
    const disableKey = `ga-disable-${measurementId}` as const;
    let lastUrl = w.location.href;

    let loaded = false;
    const load = () => {
      loaded = true;
      w.dataLayer = w.dataLayer || [];
      w.gtag = function gtag() {
        // gtag.js consumes the `arguments` objects queued here (Google's shim).
        // eslint-disable-next-line prefer-rest-params
        w.dataLayer!.push(arguments);
      };
      w.gtag("js", new Date());
      // The landing referrer may be a same-origin secret URL (full-page hop
      // off /login?cli_state=…); pin a sanitized copy instead.
      w.gtag("config", measurementId, {
        page_referrer: sanitizeAnalyticsUrl(document.referrer),
      });

      const script = document.createElement("script");
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
      document.head.appendChild(script);
    };

    const gate = (fromUrl: string, toUrl: string) => {
      const blocked = isSensitiveAnalyticsUrl(fromUrl) || isSensitiveAnalyticsUrl(toUrl);
      w[disableKey] = blocked;
      // gtag.js stays silent for the whole page if it configures while
      // disabled, so it is first loaded on the first clean URL instead.
      // Its config-time page_view then reads that clean location.
      if (!blocked && !loaded) load();
    };

    gate("", lastUrl);

    const originalPush = w.history.pushState;
    const originalReplace = w.history.replaceState;
    const wrap =
      (original: History["pushState"]): History["pushState"] =>
      function (this: History, data, unused, url) {
        const target = url == null ? w.location.href : new URL(String(url), w.location.href).href;
        gate(lastUrl, target);
        lastUrl = target;
        return original.call(this, data, unused, url);
      };
    w.history.pushState = wrap(originalPush);
    w.history.replaceState = wrap(originalReplace);

    // Capture phase, registered before gtag.js: runs ahead of gtag's listener.
    const onPopState = () => {
      gate(lastUrl, w.location.href);
      lastUrl = w.location.href;
    };
    w.addEventListener("popstate", onPopState, true);

  }, [measurementId]);

  return null;
}
