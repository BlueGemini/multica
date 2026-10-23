import { expect, test, type Page } from "@playwright/test";
import { chatScrollScript } from "../packages/views/test/chat-scroll-bundle.mjs";

declare global {
  interface Window {
    chatScrollFixture: {
      render(): void;
      grow(px: number): void;
      append(): void;
      prepend(): void;
      pin(): void;
      landOldPin(): void;
      startStream(): void;
      stopStream(): void;
    };
  }
}

const position = (page: Page) => page.locator("#chat-scroll").evaluate((el) => el.scrollTop);
const distance = (page: Page) => page.locator("#chat-scroll").evaluate((el) =>
  el.scrollHeight - el.scrollTop - el.clientHeight);

for (const dpr of [1, 1.25, 2]) {
  test.describe(`chat scroll with real Virtuoso (DPR ${dpr})`, () => {
    test.use({ deviceScaleFactor: dpr });
    test.beforeEach(async ({ page }) => {
      await page.setContent('<!doctype html><html><body style="margin:0"><div id="mount"></div></body></html>');
      await page.addScriptTag({ content: chatScrollScript });
      await page.evaluate(() => window.chatScrollFixture.render());
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-ready", "true");
      await expect.poll(() => distance(page)).toBeLessThanOrEqual(4);
    });

    test("fractional wheels release during streaming and stay released through resize and append", async ({ page }) => {
      await page.evaluate(() => window.chatScrollFixture.startStream());
      await page.mouse.move(700, 300);
      for (let i = 0; i < 20; i++) {
        await page.mouse.wheel(0, -0.5);
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-follow-disabled", "true");
      await page.evaluate(async () => {
        window.chatScrollFixture.stopStream();
        // Drain the final chunk's measurement and the last native wheel.
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      const parked = await position(page);
      await page.evaluate(() => {
        window.chatScrollFixture.grow(120);
        window.chatScrollFixture.append();
        document.getElementById("chat-scroll")!.style.height = "500px";
      });
      // Cross both Virtuoso's 150ms retry window and its 1200ms request lifetime.
      await page.waitForTimeout(1300);
      expect(Math.abs(await position(page) - parked)).toBeLessThanOrEqual(1);
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "false");
    });

    test("a late bottom request preserves the reader's latest position", async ({ page }) => {
      await page.mouse.move(700, 300);
      await page.mouse.wheel(0, -200);
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "false");
      const first = await position(page);
      await page.mouse.wheel(0, -100);
      await expect.poll(() => position(page)).toBeLessThan(first - 90);
      const latest = await position(page);
      // The same public request used by Virtuoso's queued LAST retries.
      await page.evaluate(() => window.chatScrollFixture.landOldPin());
      await expect.poll(async () => Math.abs(await position(page) - latest)).toBeLessThanOrEqual(1);
      await page.waitForTimeout(300);
      expect(Math.abs(await position(page) - latest)).toBeLessThanOrEqual(1);
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "false");

      const anchor = await page.locator("#chat-scroll").evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const row = Array.from(el.querySelectorAll<HTMLElement>("[data-item-index]"))
          .find((item) => item.getBoundingClientRect().bottom > top)!;
        return { index: row.dataset.itemIndex!, top: row.getBoundingClientRect().top - top };
      });
      await page.evaluate(() => window.chatScrollFixture.prepend());
      // The virtualizer estimates unmeasured older rows, so scrollTop can
      // change again as it measures. The reader's row and offset must hold.
      await expect.poll(() => position(page)).toBeGreaterThan(latest + 1700);
      await page.evaluate(() => window.chatScrollFixture.landOldPin());
      await expect.poll(() => page.locator("#chat-scroll").evaluate((el, anchor) => {
        const row = el.querySelector<HTMLElement>(`[data-item-index="${anchor.index}"]`);
        return row ? Math.abs(row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top) : Infinity;
      }, anchor)).toBeLessThanOrEqual(1);
    });

    test("PageUp from a row button cancels an outstanding bottom request", async ({ page }) => {
      await page.evaluate(() => {
        window.chatScrollFixture.grow(21);
        window.chatScrollFixture.pin();
      });
      await page.locator("button").last().focus();
      const before = await position(page);
      await page.keyboard.press("PageUp");
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "false");
      // Let the native key's smooth scroll finish before checking stability.
      await page.waitForTimeout(350);
      const parked = await position(page);
      expect(parked).toBeLessThan(before - 300);
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.chatScrollFixture.grow(31));
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(1300);
      expect(Math.abs(await position(page) - parked)).toBeLessThanOrEqual(1);
      expect(await distance(page)).toBeGreaterThan(120);
    });

    test("nested scrolling, consumed keys and zoom input leave following enabled", async ({ page }) => {
      const code = page.locator("pre").last();
      await code.evaluate((el) => { el.scrollTop = 60; });
      await code.hover();
      await page.mouse.wheel(0, -30);
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "true");
      await code.evaluate((el) => { el.scrollTop = 0; });
      await page.mouse.wheel(0, -100);
      await page.locator("button").last().focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("Home");
      await page.locator("input").last().focus();
      await page.keyboard.press("Home");
      await page.keyboard.press("End");
      await page.mouse.move(700, 300);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -100);
      await page.keyboard.up("Control");
      await page.evaluate(() => window.chatScrollFixture.grow(75));
      await expect.poll(() => distance(page)).toBeLessThanOrEqual(4);
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "true");
    });

    test("only a reader return to the bottom resumes following", async ({ page }) => {
      await page.mouse.move(700, 300);
      await page.mouse.wheel(0, -200);
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "false");
      await page.locator("#chat-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(50);
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "false");
      await page.locator("button").last().focus();
      await page.keyboard.press("End");
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "true");
      await page.evaluate(() => window.chatScrollFixture.grow(80));
      await expect.poll(() => distance(page)).toBeLessThanOrEqual(4);
      await page.mouse.move(700, 300);
      await page.mouse.wheel(0, -80);
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "false");
      await page.mouse.wheel(0, 200);
      await expect(page.locator("#chat-scroll")).toHaveAttribute("data-following", "true");
    });
  });
}
