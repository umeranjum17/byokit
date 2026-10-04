import type { BrowserDriver, BrowserLauncher, Capture, Condition, LaunchOptions, LoadState, Viewport } from "./types.ts";

export type BrowserCall = { operation: "openUrl"; url: string; waitUntil: LoadState } |
  { operation: "openHtml"; html: string; waitUntil: LoadState } |
  { operation: "setViewport"; viewport: Viewport } | { operation: "waitFor"; condition: Condition } |
  { operation: "screenshot"; capture: Capture } | { operation: "close" };

/** Offline driver. The bytes are app-supplied; this fake never renders or starts a process. */
export function fakeBrowser(png: Uint8Array = new Uint8Array()): {
  launch: BrowserLauncher; launches: LaunchOptions[]; calls: BrowserCall[];
} {
  const launches: LaunchOptions[] = [];
  const calls: BrowserCall[] = [];
  const driver: BrowserDriver = {
    async openUrl(url, waitUntil) { calls.push({ operation: "openUrl", url, waitUntil }); },
    async openHtml(html, waitUntil) { calls.push({ operation: "openHtml", html, waitUntil }); },
    async setViewport(viewport) { calls.push({ operation: "setViewport", viewport }); },
    async waitFor(condition) { calls.push({ operation: "waitFor", condition }); },
    async screenshot(capture) { calls.push({ operation: "screenshot", capture }); return png.slice(); },
    async close() { calls.push({ operation: "close" }); },
  };
  return { launches, calls, async launch(options) { launches.push(options); return driver; } };
}
