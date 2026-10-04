import { chromium, type BrowserType } from "playwright-core";
import type { BrowserLauncher } from "./types.ts";

// Internal adapter seam lets ordinary tests exercise production mapping without a real browser.
export function chromiumLauncher(browser: Pick<BrowserType, "launchPersistentContext">): BrowserLauncher {
  return async (options) => {
    const context = await browser.launchPersistentContext(options.profileDir, {
      executablePath: options.executablePath,
      headless: true,
      chromiumSandbox: options.sandbox,
      viewport: options.viewport,
      deviceScaleFactor: options.deviceScaleFactor,
      reducedMotion: options.reducedMotion,
      timeout: options.timeoutMs,
      env: options.env,
      acceptDownloads: false,
      serviceWorkers: "block",
      args: ["--force-color-profile=srgb"],
    });
    try {
      context.setDefaultTimeout(options.timeoutMs);
      context.setDefaultNavigationTimeout(options.timeoutMs);
      const page = context.pages()[0] ?? await context.newPage();
      // Dialogs must never wedge a screenshot session.
      page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
      return {
        async openUrl(url, waitUntil) { await page.goto(url, { waitUntil }); },
        async openHtml(html, waitUntil) {
          // Remove the previous document's origin/base URL before loading local HTML.
          await page.goto("about:blank");
          await page.setContent(html, { waitUntil });
        },
        async setViewport(viewport) { await page.setViewportSize(viewport); },
        async waitFor(condition) {
          if ("selector" in condition) {
            await page.locator(condition.selector).waitFor({ state: condition.state ?? "visible" });
            return;
          }
          const expression = "fonts" in condition ?
            "document.fonts.ready.then(() => true)" : condition.expression;
          const handle = await page.waitForFunction(expression, undefined, { timeout: options.timeoutMs });
          await handle.dispose();
        },
        async screenshot(capture) {
          const settings = { type: "png" as const, timeout: options.timeoutMs, animations: "disabled" as const };
          if (capture.selector !== undefined) return page.locator(capture.selector).screenshot(settings);
          return page.screenshot({ ...settings, fullPage: capture.fullPage ?? false });
        },
        async close() { await context.close(); },
      };
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  };
}

export const launchChromium = chromiumLauncher(chromium);
