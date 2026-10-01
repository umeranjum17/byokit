import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { launchChromium } from "./chromium.ts";
import type { BrowserLauncher, BrowserOptions, BrowserSession, Capture, Condition, Viewport } from "./types.ts";

export type { BrowserOptions, BrowserSession, Source, Capture, Condition, Viewport,
  BrowserLauncher, BrowserDriver, LaunchOptions, LoadState } from "./types.ts";

export type BrowserErrorCode = "invalid-input" | "browser-missing" | "launch-failed" |
  "operation-failed" | "url-denied" | "closed" | "close-failed";
const messages: Record<BrowserErrorCode, string> = {
  "invalid-input": "The screenshot settings are not valid.",
  "browser-missing": "Choose an installed browser to take screenshots.",
  "launch-failed": "The browser could not start.",
  "operation-failed": "The browser could not finish taking the screenshot.",
  "url-denied": "This page is not allowed by the app.",
  "closed": "This screenshot session has ended.",
  "close-failed": "The browser could not finish closing.",
};
/** Safe to display: never retains raw browser errors, URLs, HTML or environment values. */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  constructor(code: BrowserErrorCode) { super(messages[code]); this.name = "BrowserError"; this.code = code; }
}

function viewportValid(viewport: Viewport): boolean {
  return Number.isSafeInteger(viewport.width) && viewport.width > 0 &&
    Number.isSafeInteger(viewport.height) && viewport.height > 0;
}
function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }
async function executable(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
}

/** Checks only the app's explicit candidate list, in order. Never scans HOME, PATH or browser caches. */
export async function findChromium(candidates: readonly string[]): Promise<string | undefined> {
  for (const path of candidates) {
    if (!isAbsolute(path)) throw new BrowserError("invalid-input");
    if (await executable(path)) return path;
  }
  return undefined;
}

export async function createBrowser(options: BrowserOptions, launch: BrowserLauncher = launchChromium): Promise<BrowserSession> {
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  const deviceScaleFactor = options.deviceScaleFactor ?? 1;
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!viewportValid(viewport) || !positive(deviceScaleFactor) || !positive(timeoutMs) ||
      !isAbsolute(options.executablePath)) throw new BrowserError("invalid-input");
  if (!await executable(options.executablePath)) throw new BrowserError("browser-missing");
  // mkdtemp creates a private 0700 directory; no caller-supplied profile or browser attachment exists.
  const root = await mkdtemp(join(tmpdir(), "byokit-browser-")).catch(() => {
    throw new BrowserError("launch-failed");
  });
  const env = { ...options.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root, TMPDIR: root, TMP: root, TEMP: root };
  let driver;
  try {
    driver = await launch({ executablePath: options.executablePath, profileDir: join(root, "profile"),
      viewport: { ...viewport }, deviceScaleFactor, timeoutMs, sandbox: options.sandbox ?? true,
      reducedMotion: options.reducedMotion ?? "reduce", env });
  } catch {
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
      throw new BrowserError("launch-failed");
    });
    throw new BrowserError("launch-failed");
  }
  // One document per session. Queue captures and mutations so concurrent calls cannot race documents.
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new BrowserError("closed"));
    const result = chain.then(async () => {
      try { return await operation(); }
      catch (error) { throw new BrowserError(error instanceof BrowserError ? error.code : "operation-failed"); }
    });
    chain = result.catch(() => {});
    return result;
  }
  return {
    open(source, load = {}) {
      return run(async () => {
        const keys = ["url", "html", "file"].filter(key => key in source);
        const waitUntil = load.waitUntil ?? "domcontentloaded";
        if (keys.length !== 1 || !["load", "domcontentloaded", "networkidle"].includes(waitUntil)) {
          throw new BrowserError("invalid-input");
        }
        if (source.url !== undefined) {
          let url: URL;
          try { url = new URL(source.url); } catch { throw new BrowserError("invalid-input"); }
          if (!["http:", "https:"].includes(url.protocol)) throw new BrowserError("invalid-input");
          if (options.allowUrl && !await options.allowUrl(url)) throw new BrowserError("url-denied");
          await driver.openUrl(url.href, waitUntil);
          return;
        }
        if (source.file !== undefined) {
          if (!isAbsolute(source.file)) throw new BrowserError("invalid-input");
          await driver.openHtml(await readFile(source.file, "utf8"), waitUntil);
          return;
        }
        if (typeof source.html !== "string") throw new BrowserError("invalid-input");
        await driver.openHtml(source.html, waitUntil);
      });
    },
    setViewport(next) {
      return run(async () => {
        if (!viewportValid(next)) throw new BrowserError("invalid-input");
        await driver.setViewport({ ...next });
      });
    },
    waitFor(condition: Condition) {
      return run(async () => {
        const keys = ["selector", "expression", "fonts"].filter(key => key in condition);
        if (keys.length !== 1 || ("selector" in condition && !condition.selector.trim()) ||
            ("expression" in condition && !condition.expression.trim()) ||
            ("fonts" in condition && condition.fonts !== true)) throw new BrowserError("invalid-input");
        await driver.waitFor(condition);
      });
    },
    screenshot(capture: Capture = {}) {
      return run(async () => {
        if (capture.selector !== undefined && (!capture.selector.trim() || capture.fullPage !== undefined)) {
          throw new BrowserError("invalid-input");
        }
        return driver.screenshot(capture);
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = chain.then(async () => {
        try { await driver.close(); }
        catch { throw new BrowserError("close-failed"); }
        finally {
          await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
            throw new BrowserError("close-failed");
          });
        }
      });
      return closing;
    },
  };
}
