// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  isSensitiveAnalyticsUrl,
  resolveGoogleAnalyticsId,
  sanitizeAnalyticsUrl,
} from "./google-analytics";

describe("isSensitiveAnalyticsUrl", () => {
  it("flags URLs carrying non-allowlisted params or capability segments", () => {
    expect(isSensitiveAnalyticsUrl("https://multica.ai/wecom/bind?token=t")).toBe(true);
    expect(isSensitiveAnalyticsUrl("https://multica.ai/auth/callback?code=c")).toBe(true);
    expect(isSensitiveAnalyticsUrl("https://multica.ai/invite/inv_123")).toBe(true);
    expect(isSensitiveAnalyticsUrl("not a url")).toBe(true);
  });

  it("does not flag clean URLs, campaign params, hashes or an empty referrer", () => {
    expect(isSensitiveAnalyticsUrl("https://multica.ai/acme/issues")).toBe(false);
    expect(isSensitiveAnalyticsUrl("https://multica.ai/?utm_source=x&gclid=g")).toBe(false);
    expect(isSensitiveAnalyticsUrl("https://multica.ai/docs#install")).toBe(false);
    expect(isSensitiveAnalyticsUrl("")).toBe(false);
  });
});

describe("sanitizeAnalyticsUrl", () => {
  it("drops credential-bearing query params from bind, auth and login URLs", () => {
    for (const [raw, expected] of [
      ["https://multica.ai/wecom/bind?token=secret-bind-token", "https://multica.ai/wecom/bind"],
      ["https://multica.ai/lark/bind?token=t&platform=x", "https://multica.ai/lark/bind"],
      ["https://multica.ai/auth/callback?code=abc&state=xyz", "https://multica.ai/auth/callback"],
      [
        "https://multica.ai/login?cli_callback=http%3A%2F%2Flocalhost%3A1&cli_state=s&next=%2Fw",
        "https://multica.ai/login",
      ],
      ["https://multica.ai/join?token=t#frag", "https://multica.ai/join"],
    ]) {
      expect(sanitizeAnalyticsUrl(raw)).toBe(expected);
    }
  });

  it("keeps campaign attribution params", () => {
    expect(
      sanitizeAnalyticsUrl(
        "https://multica.ai/?utm_source=x&token=t&utm_campaign=launch&gclid=g",
      ),
    ).toBe("https://multica.ai/?utm_source=x&utm_campaign=launch&gclid=g");
  });

  it("masks invitation ids in the path", () => {
    expect(sanitizeAnalyticsUrl("https://multica.ai/invite/inv_123?x=1")).toBe(
      "https://multica.ai/invite/[id]",
    );
  });

  it("returns empty for missing, unparseable or non-http input", () => {
    expect(sanitizeAnalyticsUrl("")).toBe("");
    expect(sanitizeAnalyticsUrl(undefined)).toBe("");
    expect(sanitizeAnalyticsUrl("not a url")).toBe("");
    expect(sanitizeAnalyticsUrl("javascript:alert(1)")).toBe("");
  });
});

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
