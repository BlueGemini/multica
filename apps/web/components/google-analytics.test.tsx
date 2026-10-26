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

  it("waits for a clean URL before first loading the tag", () => {
    window.history.replaceState(null, "", "/wecom/bind?token=secret");
    render(<GoogleAnalytics measurementId={ID} />);
    expect(disabled()).toBe(true);
    expect(gtagScripts()).toHaveLength(0);

    // The tag has not observed the sensitive landing URL. It starts only after
    // history has updated location, and receives a sanitized document referrer.
    window.history.pushState(null, "", "/acme/issues");
    expect(disabled()).toBe(false);
    expect(gtagScripts()).toHaveLength(1);
    const queued = (window as unknown as { dataLayer: ArrayLike<unknown>[] }).dataLayer;
    expect(Array.from(queued[1] ?? [])).toEqual([
      "config", ID,
      expect.objectContaining({ page_location: expect.stringContaining("/acme/issues") }),
    ]);

    window.history.pushState(null, "", "/acme/projects");
    expect(disabled()).toBe(false);
    expect(gtagScripts()).toHaveLength(1);
  });

  it("never re-enables after a sensitive URL, including same-URL history updates", () => {
    window.history.replaceState(null, "", "/about?utm_source=x");
    render(<GoogleAnalytics measurementId={ID} />);
    expect(disabled()).toBe(false);
    expect(gtagScripts()).toHaveLength(1);

    window.history.pushState(null, "", "/auth/callback?code=c&state=s");
    expect(disabled()).toBe(true);
    window.history.pushState(null, "", "/privacy");
    expect(disabled()).toBe(true);
    window.history.replaceState({ router: true }, "", "/privacy");
    expect(disabled()).toBe(true);
    window.history.pushState(null, "", "/download");
    window.history.pushState(null, "", "/about");
    expect(disabled()).toBe(true);
    expect(gtagScripts()).toHaveLength(1);
  });

  it("continues tracking across clean history changes", () => {
    window.history.replaceState(null, "", "/about");
    render(<GoogleAnalytics measurementId={ID} />);
    window.history.pushState(null, "", "/privacy");
    window.history.replaceState({ router: true }, "", "/privacy");
    expect(disabled()).toBe(false);
    expect(gtagScripts()).toHaveLength(1);
  });

  const clickLink = (href: string, init: MouseEventInit = {}, type = "click") => {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "";
    // jsdom cannot navigate; the guard runs in the capture phase regardless.
    anchor.addEventListener("click", (e) => e.preventDefault());
    const child = document.createElement("span");
    anchor.appendChild(child);
    document.body.appendChild(anchor);
    // Dispatch from a descendant: the guard must find the enclosing link.
    child.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    anchor.remove();
  };

  it("stops before a credential-bearing link click without a URL change", () => {
    window.history.replaceState(null, "", "/acme/issues");
    render(<GoogleAnalytics measurementId={ID} />);
    expect(disabled()).toBe(false);

    clickLink("https://cdn.example.invalid/report.pdf?Signature=s&Key-Pair-Id=k");
    expect(disabled()).toBe(true);
    expect(window.location.pathname).toBe("/acme/issues");

    // Stays stopped for the document, including later clean navigation.
    window.history.pushState(null, "", "/acme/projects");
    expect(disabled()).toBe(true);
  });

  it("treats middle-click, same-origin capability and invite links as sensitive", () => {
    for (const [href, type] of [
      ["https://cdn.example.invalid/a.pdf?X-Amz-Signature=s", "auxclick"],
      ["/api/attachments/1/signed-download?sig=s", "click"],
      ["/invite/abc", "click"],
    ] as const) {
      window.history.replaceState(null, "", "/about");
      render(<GoogleAnalytics measurementId={ID} />);
      expect(disabled()).toBe(false);
      clickLink(href, { button: type === "auxclick" ? 1 : 0 }, type);
      expect(disabled(), href).toBe(true);
      delete (window as unknown as Record<string, unknown>).__multicaGoogleAnalytics;
    }
  });

  it("keeps tracking clean links and object-URL exports", () => {
    window.history.replaceState(null, "", "/about");
    render(<GoogleAnalytics measurementId={ID} />);
    clickLink("https://github.com/multica-ai/multica");
    clickLink("/acme/issues?utm_source=x#top");
    clickLink("blob:https://app.example.invalid/2b0c-uuid");
    expect(disabled()).toBe(false);
  });

  it("stops before submitting a form to a credential-bearing action", () => {
    window.history.replaceState(null, "", "/about");
    render(<GoogleAnalytics measurementId={ID} />);
    const form = document.createElement("form");
    form.action = "https://idp.example.invalid/authorize?state=secret";
    document.body.appendChild(form);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.remove();
    expect(disabled()).toBe(true);
  });

  it("installs once even if mounted again", () => {
    window.history.replaceState(null, "", "/about");
    render(<GoogleAnalytics measurementId={ID} />);
    render(<GoogleAnalytics measurementId={ID} />);
    expect(gtagScripts()).toHaveLength(1);
  });
});
