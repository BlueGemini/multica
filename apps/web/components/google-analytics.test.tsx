import { render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GoogleAnalytics } from "./google-analytics";

const ID = "G-TEST1234";
const disabled = () => (window as unknown as Record<string, unknown>)[`ga-disable-${ID}`];
const gtagScripts = () =>
  document.querySelectorAll('script[src^="https://www.googletagmanager.com/gtag/js"]');

describe("GoogleAnalytics privacy gate", () => {
  // The component hooks history for the page's lifetime; undo between tests.
  let pushState: History["pushState"];
  let replaceState: History["replaceState"];
  beforeAll(() => {
    pushState = window.history.pushState;
    replaceState = window.history.replaceState;
  });

  afterEach(() => {
    window.history.pushState = pushState;
    window.history.replaceState = replaceState;
    const w = window as unknown as Record<string, unknown>;
    delete w.__multicaGoogleAnalytics;
    delete w[`ga-disable-${ID}`];
    delete w.dataLayer;
    delete w.gtag;
    gtagScripts().forEach((s) => s.remove());
    window.history.replaceState(null, "", "/");
  });

  it("does not load gtag.js on a URL carrying a credential, and loads it on the next clean page after that", () => {
    window.history.replaceState(null, "", "/wecom/bind?token=secret");
    render(<GoogleAnalytics measurementId={ID} />);
    expect(disabled()).toBe(true);
    expect(gtagScripts()).toHaveLength(0);

    // Leaving the secret URL is still blocked (GA would report it as referrer).
    window.history.pushState(null, "", "/acme/issues");
    expect(disabled()).toBe(true);
    expect(gtagScripts()).toHaveLength(0);

    window.history.pushState(null, "", "/acme/projects");
    expect(disabled()).toBe(false);
    expect(gtagScripts()).toHaveLength(1);
  });

  it("loads immediately on a clean URL and disables around secret URLs", () => {
    window.history.replaceState(null, "", "/about?utm_source=x");
    render(<GoogleAnalytics measurementId={ID} />);
    expect(disabled()).toBe(false);
    expect(gtagScripts()).toHaveLength(1);

    window.history.pushState(null, "", "/auth/callback?code=c&state=s");
    expect(disabled()).toBe(true);
    window.history.pushState(null, "", "/privacy");
    expect(disabled()).toBe(true);
    window.history.pushState(null, "", "/download");
    expect(disabled()).toBe(false);
    expect(gtagScripts()).toHaveLength(1);
  });

  it("installs once even if mounted again", () => {
    window.history.replaceState(null, "", "/about");
    render(<GoogleAnalytics measurementId={ID} />);
    render(<GoogleAnalytics measurementId={ID} />);
    expect(gtagScripts()).toHaveLength(1);
  });
});
