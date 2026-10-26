import { readFileSync } from "node:fs";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import ts from "typescript";

// Opt in with a real public GA4 ID. No app server or database is used, and
// every third-party browser request is aborted or fulfilled locally.
const measurementId = process.env.MULTICA_GOOGLE_ANALYTICS_TEST_ID;
const origin = "https://ga-privacy.invalid";
const secret = "GA_TEST_SECRET_BIND";
let gtagSource: Buffer;

function compile(path: string) {
  return ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const configCode = compile("apps/web/config/google-analytics.ts");
const installerCode = compile("apps/web/lib/google-analytics.ts");

async function install(page: Page) {
  await page.evaluate(({ configCode, installerCode, measurementId }) => {
    const config = {};
    new Function("exports", configCode)(config);
    const installer: { installGoogleAnalytics?: (id: string) => void } = {};
    new Function("exports", "require", installerCode)(installer, () => config);
    installer.installGoogleAnalytics!(measurementId!);
  }, { configCode, installerCode, measurementId });
}

async function intercept(context: BrowserContext, delayScript = false) {
  const collected: string[] = [];
  const external: string[] = [];
  let releaseScript!: () => void;
  let scriptRequested!: () => void;
  const requested = new Promise<void>((resolve) => { scriptRequested = resolve; });
  const released = new Promise<void>((resolve) => { releaseScript = resolve; });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      external.push(request.url() + "\n" + (request.postData() ?? "") + "\n" + JSON.stringify(request.headers()));
    }
    if (url.origin === origin) {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head><title>Privacy regression</title></head><body></body></html>",
      });
    } else if (url.hostname === "www.googletagmanager.com" && url.pathname === "/gtag/js") {
      scriptRequested();
      if (delayScript) await released;
      await route.fulfill({ contentType: "application/javascript", body: gtagSource });
    } else {
      if (url.pathname.includes("/collect")) {
        collected.push(request.url() + "\n" + (request.postData() ?? ""));
      }
      await route.abort();
    }
  });

  return { collected, external, requested, releaseScript };
}

async function waitForTag(page: Page) {
  await page.waitForFunction((id) => Boolean(
    (window as unknown as { google_tag_manager?: Record<string, unknown> }).google_tag_manager?.[id!],
  ), measurementId);
}

test.describe("Google Analytics credential privacy", () => {
  test.skip(!measurementId, "Set MULTICA_GOOGLE_ANALYTICS_TEST_ID to run the live-tag privacy check");

  test.beforeAll(async ({ request }) => {
    expect(measurementId).toMatch(/^G-[A-Z0-9]+$/);
    const response = await request.get(
      `https://www.googletagmanager.com/gtag/js?id=${measurementId}`,
    );
    expect(response.ok()).toBe(true);
    gtagSource = await response.body();
  });

  test("does not leak delayed initialization through same-URL or consecutive history changes", async ({ page, context }) => {
    const traffic = await intercept(context, true);
    try {
      await page.goto(`${origin}/about`);
      await install(page);
      await traffic.requested;
      await page.evaluate((token) => history.pushState(null, "", `/wecom/bind?token=${token}`), secret);
      traffic.releaseScript();
      await waitForTag(page);
      await page.evaluate(() => {
        history.pushState(null, "", "/privacy");
        history.replaceState({ router: true }, "", "/privacy");
      });
      await page.waitForTimeout(1800);
      await page.evaluate(() => {
        history.pushState(null, "", "/download");
        history.pushState(null, "", "/about");
      });
      await page.waitForTimeout(1800);
      expect(traffic.external.join("\n")).not.toContain(secret);
    } finally {
      traffic.releaseScript();
    }
  });

  test("starts on a clean route after a sensitive landing", async ({ page, context }) => {
    const traffic = await intercept(context);
    await page.goto(`${origin}/wecom/bind?token=${secret}`);
    await install(page);
    expect(await page.locator('script[src*="/gtag/js"]').count()).toBe(0);
    await page.evaluate(() => history.pushState(null, "", "/about"));
    await waitForTag(page);
    await expect.poll(() => traffic.collected.length).toBeGreaterThan(0);
    expect(traffic.external.join("\n")).not.toContain(secret);
    expect(traffic.collected.some((hit) => new URL(hit.split("\n")[0]).searchParams.get("dl") === `${origin}/about`)).toBe(true);
  });

  test("blocks back navigation into a credential URL", async ({ page, context }) => {
    const traffic = await intercept(context);
    await page.goto(`${origin}/wecom/bind?token=${secret}`);
    await page.evaluate(() => history.pushState(null, "", "/about"));
    await install(page);
    await waitForTag(page);
    await expect.poll(() => traffic.collected.length).toBeGreaterThan(0);
    await page.goBack();
    await page.waitForTimeout(1800);
    expect(traffic.external.join("\n")).not.toContain(secret);
  });

  test("sanitizes the referrer on a full-page navigation", async ({ page, context }) => {
    const traffic = await intercept(context);
    await page.goto(`${origin}/about`, { referer: `${origin}/login?next=${secret}` });
    await install(page);
    await waitForTag(page);
    await expect.poll(() => traffic.collected.length).toBeGreaterThan(0);
    expect(traffic.external.join("\n")).not.toContain(secret);
  });
});
