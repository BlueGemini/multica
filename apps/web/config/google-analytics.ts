type RuntimeEnv = Record<string, string | undefined>;

// GA4 Measurement IDs look like `G-RQVF209EHD`. The value is interpolated
// into an inline <script>, so anything that doesn't match this shape is
// rejected outright rather than escaped.
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;

/**
 * Resolve the Google Analytics (GA4) Measurement ID from the runtime env.
 *
 * Opt-in: returns undefined unless GOOGLE_ANALYTICS_ID is set to a valid
 * GA4 ID, so local dev and self-hosted images never load gtag.js. It is read
 * by the Next.js server per request (not a NEXT_PUBLIC_* build-time var), so
 * the published Docker images carry no ID and operators can toggle it without
 * a rebuild.
 */
export function resolveGoogleAnalyticsId(env: RuntimeEnv): string | undefined {
  const value = env.GOOGLE_ANALYTICS_ID?.trim().toUpperCase();
  if (!value || !MEASUREMENT_ID_PATTERN.test(value)) return undefined;
  return value;
}
