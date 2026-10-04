export interface Viewport { width: number; height: number }

export type Source = { url: string; html?: never; file?: never } |
  { html: string; url?: never; file?: never } | { file: string; url?: never; html?: never };
export type Condition = { selector: string; state?: "attached" | "visible" | "hidden" | "detached" } |
  { expression: string } | { fonts: true };
export type Capture = { fullPage?: boolean; selector?: never } | { selector: string; fullPage?: never };
export type LoadState = "load" | "domcontentloaded" | "networkidle";

export interface BrowserOptions {
  /** Absolute path to an installed Chromium/Chrome. Never inferred or downloaded. */
  executablePath: string;
  viewport?: Viewport;
  deviceScaleFactor?: number;
  /** Finite positive deadline per operation, in milliseconds; default 20 seconds. */
  timeoutMs?: number;
  /** Default true. Disable only in an app-owned sandbox/container. */
  sandbox?: boolean;
  reducedMotion?: "reduce" | "no-preference";
  /** Environment built from nothing plus these values; profile/home directories stay kit-owned. */
  env?: Record<string, string>;
  /** Authorizes explicit open() targets. Subresources and in-page navigations are not covered. */
  allowUrl?: (url: URL) => boolean | Promise<boolean>;
}

export interface BrowserSession {
  open(source: Source, options?: { waitUntil?: LoadState }): Promise<void>;
  setViewport(viewport: Viewport): Promise<void>;
  waitFor(condition: Condition): Promise<void>;
  /** Returns PNG bytes; writes no screenshot file. */
  screenshot(options?: Capture): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Small injection seam for offline fakes; no browser-library types in the public API. */
export interface BrowserDriver {
  openUrl(url: string, waitUntil: LoadState): Promise<void>;
  openHtml(html: string, waitUntil: LoadState): Promise<void>;
  setViewport(viewport: Viewport): Promise<void>;
  waitFor(condition: Condition): Promise<void>;
  screenshot(options: Capture): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface LaunchOptions {
  executablePath: string;
  profileDir: string;
  viewport: Viewport;
  deviceScaleFactor: number;
  timeoutMs: number;
  sandbox: boolean;
  reducedMotion: "reduce" | "no-preference";
  env: Record<string, string>;
}
export type BrowserLauncher = (options: LaunchOptions) => Promise<BrowserDriver>;
