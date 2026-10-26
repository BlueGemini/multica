// @vitest-environment node
import { describe, expect, it } from "vitest";

import { resolveGoogleAnalyticsId } from "./google-analytics";

describe("resolveGoogleAnalyticsId", () => {
  it("is disabled when GOOGLE_ANALYTICS_ID is unset or blank", () => {
    expect(resolveGoogleAnalyticsId({})).toBeUndefined();
    expect(resolveGoogleAnalyticsId({ GOOGLE_ANALYTICS_ID: "" })).toBeUndefined();
    expect(resolveGoogleAnalyticsId({ GOOGLE_ANALYTICS_ID: "   " })).toBeUndefined();
  });

  it("returns a valid GA4 measurement ID", () => {
    expect(
      resolveGoogleAnalyticsId({ GOOGLE_ANALYTICS_ID: "G-RQVF209EHD" }),
    ).toBe("G-RQVF209EHD");
  });

  it("trims whitespace and normalizes case", () => {
    expect(
      resolveGoogleAnalyticsId({ GOOGLE_ANALYTICS_ID: "  g-rqvf209ehd \n" }),
    ).toBe("G-RQVF209EHD");
  });

  it("rejects values that are not GA4 measurement IDs", () => {
    for (const value of [
      "UA-12345-1",
      "RQVF209EHD",
      "G-",
      "G-ABC",
      "G-RQVF209EHD'); alert(1); //",
      "G-RQVF 209EHD",
    ]) {
      expect(resolveGoogleAnalyticsId({ GOOGLE_ANALYTICS_ID: value })).toBeUndefined();
    }
  });
});
