import Script from "next/script";

/**
 * Google tag (gtag.js) for GA4. Rendered only when the root layout resolved a
 * Measurement ID from GOOGLE_ANALYTICS_ID — see config/google-analytics.ts,
 * which also validates the ID before it reaches the inline script below.
 *
 * Client-side navigations are tracked by GA4's enhanced measurement
 * ("page changes based on browser history events", on by default), so no
 * router hook is needed here.
 */
export function GoogleAnalytics({ measurementId }: { measurementId: string }) {
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', ${JSON.stringify(measurementId)});`}
      </Script>
    </>
  );
}
