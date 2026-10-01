import assert from "node:assert/strict";
import { test } from "node:test";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserType, BrowserContext, Page } from "playwright-core";
import { chromiumLauncher } from "../src/chromium.ts";
import { createBrowser } from "../src/index.ts";

test("production adapter isolates launch, resets HTML origin and captures only PNG pages/elements", async () => {
  const events: unknown[] = [];
  const bytes = new Uint8Array([137, 80, 78, 71]);
  let handleDisposed = 0;
  let closeCount = 0;
  const page = {
    on(event: string) { events.push(["on", event]); },
    async goto(url: string, options?: unknown) { events.push(["goto", url, options]); },
    async setContent(html: string, options: unknown) { events.push(["html", html, options]); },
    async setViewportSize(viewport: unknown) { events.push(["viewport", viewport]); },
    async waitForFunction(expression: string, arg: unknown, options: unknown) {
      events.push(["expression", expression, arg, options]);
      return { async dispose() { handleDisposed++; } };
    },
    locator(selector: string) {
      return {
        async waitFor(options: unknown) { events.push(["selector", selector, options]); },
        async screenshot(options: unknown) { events.push(["element-png", selector, options]); return bytes; },
      };
    },
    async screenshot(options: unknown) { events.push(["page-png", options]); return bytes; },
  } as unknown as Page;
  const context = {
    setDefaultTimeout(timeout: number) { events.push(["timeout", timeout]); },
    setDefaultNavigationTimeout(timeout: number) { events.push(["navigation-timeout", timeout]); },
    pages() { return [page]; },
    async close() { closeCount++; },
  } as unknown as BrowserContext;
  const launch = chromiumLauncher({
    async launchPersistentContext(profile, options) {
      assert.ok(profile.endsWith("/profile"));
      assert.equal(options!.executablePath, process.execPath);
      assert.equal(options!.chromiumSandbox, true);
      assert.equal(options!.acceptDownloads, false);
      assert.equal(options!.serviceWorkers, "block");
      assert.equal(options!.headless, true);
      assert.equal(options!.deviceScaleFactor, 2);
      assert.deepEqual(options!.viewport, { width: 900, height: 600 });
      assert.equal(options!.env!.HOME, profile.slice(0, -"/profile".length));
      return context;
    },
  } satisfies Pick<BrowserType, "launchPersistentContext">);
  const session = await createBrowser({ executablePath: process.execPath, deviceScaleFactor: 2,
    viewport: { width: 900, height: 600 }, timeoutMs: 1000 }, launch);
  try {
    await session.open({ url: "https://example.test" }, { waitUntil: "load" });
    await session.open({ html: "<main>Hello</main>" });
    await session.waitFor({ selector: "main", state: "attached" });
    await session.waitFor({ expression: "window.ready" });
    await session.waitFor({ fonts: true });
    await session.setViewport({ width: 390, height: 844 });
    assert.deepEqual(await session.screenshot({ fullPage: true }), bytes);
    assert.deepEqual(await session.screenshot({ selector: "main" }), bytes);
    assert.deepEqual(events, [
      ["timeout", 1000], ["navigation-timeout", 1000], ["on", "dialog"],
      ["goto", "https://example.test/", { waitUntil: "load" }],
      ["goto", "about:blank", undefined],
      ["html", "<main>Hello</main>", { waitUntil: "domcontentloaded" }],
      ["selector", "main", { state: "attached" }],
      ["expression", "window.ready", undefined, { timeout: 1000 }],
      ["expression", "document.fonts.ready.then(() => true)", undefined, { timeout: 1000 }],
      ["viewport", { width: 390, height: 844 }],
      ["page-png", { type: "png", timeout: 1000, animations: "disabled", fullPage: true }],
      ["element-png", "main", { type: "png", timeout: 1000, animations: "disabled" }],
    ]);
    assert.equal(handleDisposed, 2);
  } finally { await session.close(); }
  assert.equal(closeCount, 1);
});

test("production adapter closes a context when initial page setup fails", async () => {
  let closeCount = 0;
  const launch = chromiumLauncher({
    async launchPersistentContext() {
      return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, pages() { return []; },
        async newPage() { throw new Error("credential-canary"); },
        async close() { closeCount++; } } as unknown as BrowserContext;
    },
  });
  await assert.rejects(createBrowser({ executablePath: process.execPath }, launch), { code: "launch-failed" });
  assert.equal(closeCount, 1);
});

test("real driver starts only the app-named fake executable, with private profile and no host secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-process-test-"));
  const bin = join(root, "fake-chromium.cjs");
  const report = join(root, "launch.json");
  const previous = process.env.BROWSER_TEST_SECRET;
  process.env.BROWSER_TEST_SECRET = "host-credential-canary";
  try {
    await writeFile(bin, `#!${process.execPath}\n
const fs = require('node:fs');
fs.writeFileSync(process.env.BROWSER_TEST_REPORT, JSON.stringify({ args: process.argv.slice(2), env: process.env }));
process.stderr.write('browser-credential-canary');
process.exit(1);
`);
    await chmod(bin, 0o700);
    await assert.rejects(createBrowser({ executablePath: bin, env: { BROWSER_TEST_REPORT: report } }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "The browser could not start.");
      assert.ok(!String(error.stack).includes("credential-canary"));
      assert.equal(error.cause, undefined);
      return true;
    });
    const launched = JSON.parse(await readFile(report, "utf8")) as { args: string[]; env: Record<string, string> };
    const profile = launched.args.find(arg => arg.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    assert.equal(dirname(profile), launched.env.HOME);
    assert.equal(launched.env.BROWSER_TEST_SECRET, undefined);
    assert.ok(!launched.args.includes("--no-sandbox"));
    assert.ok(launched.args.includes("--remote-debugging-pipe"));
    await assert.rejects(access(dirname(profile)));
  } finally {
    if (previous === undefined) delete process.env.BROWSER_TEST_SECRET; else process.env.BROWSER_TEST_SECRET = previous;
    await rm(root, { recursive: true, force: true });
  }
});
