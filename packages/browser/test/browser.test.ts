import assert from "node:assert/strict";
import { test } from "node:test";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrowserError, createBrowser, findChromium, type BrowserLauncher, type LaunchOptions } from "../src/index.ts";
import { fakeBrowser } from "../src/testing.ts";

test("captures URL, local HTML and a named file with scale, readiness and viewport settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-test-"));
  const file = join(root, "page.html");
  await writeFile(file, '<main id="screen">Local file</main>');
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const fake = fakeBrowser(png);
  const session = await createBrowser({ executablePath: process.execPath, deviceScaleFactor: 2,
    viewport: { width: 900, height: 600 }, timeoutMs: 3500 }, fake.launch);
  try {
    await session.open({ url: "http://127.0.0.1:3000" });
    await session.waitFor({ selector: "html[data-rendered='1']" });
    await session.waitFor({ fonts: true });
    assert.deepEqual(await session.screenshot({ fullPage: true }), png);
    await session.setViewport({ width: 390, height: 844 });
    await session.open({ html: '<main id="screen">Inline</main>' }, { waitUntil: "networkidle" });
    await session.waitFor({ expression: "window.ready === true" });
    assert.deepEqual(await session.screenshot({ selector: "#screen" }), png);
    await session.open({ file });
    assert.deepEqual(fake.calls, [
      { operation: "openUrl", url: "http://127.0.0.1:3000/", waitUntil: "domcontentloaded" },
      { operation: "waitFor", condition: { selector: "html[data-rendered='1']" } },
      { operation: "waitFor", condition: { fonts: true } },
      { operation: "screenshot", capture: { fullPage: true } },
      { operation: "setViewport", viewport: { width: 390, height: 844 } },
      { operation: "openHtml", html: '<main id="screen">Inline</main>', waitUntil: "networkidle" },
      { operation: "waitFor", condition: { expression: "window.ready === true" } },
      { operation: "screenshot", capture: { selector: "#screen" } },
      { operation: "openHtml", html: await readFile(file, "utf8"), waitUntil: "domcontentloaded" },
    ]);
    assert.equal(fake.launches[0].deviceScaleFactor, 2);
    assert.equal(fake.launches[0].timeoutMs, 3500);
    assert.deepEqual(fake.launches[0].viewport, { width: 900, height: 600 });
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test("discovery checks only explicit candidates, never runs them or falls back to a download", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-find-"));
  try {
    const script = join(root, "fake-chrome");
    await writeFile(script, "#!/bin/sh\nexit 1\n");
    await chmod(script, 0o700);
    assert.equal(await findChromium([join(root, "missing"), root, script]), script);
    assert.equal(await findChromium([]), undefined);
    assert.equal(await findChromium([join(root, "missing")]), undefined);
    await assert.rejects(findChromium(["chrome"]), { code: "invalid-input" });
    await assert.rejects(createBrowser({ executablePath: join(root, "missing") }), { code: "browser-missing" });
    await assert.rejects(createBrowser({ executablePath: "chrome" }), { code: "invalid-input" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("every session owns a private profile and child HOME, without inherited credentials", async () => {
  const before = process.env.BROWSER_TEST_SECRET;
  process.env.BROWSER_TEST_SECRET = "credential-canary";
  const first = fakeBrowser();
  const second = fakeBrowser();
  const a = await createBrowser({ executablePath: process.execPath, env: { LANG: "C", HOME: "/unowned", XDG_CONFIG_HOME: "/unowned" } }, first.launch);
  const b = await createBrowser({ executablePath: process.execPath }, second.launch);
  try {
    const launch = first.launches[0];
    assert.notEqual(launch.profileDir, second.launches[0].profileDir);
    assert.equal(launch.env.HOME, dirname(launch.profileDir));
    assert.equal(launch.env.XDG_CONFIG_HOME, launch.env.HOME);
    assert.equal(launch.env.LANG, "C");
    assert.equal(launch.env.BROWSER_TEST_SECRET, undefined);
    assert.equal((await stat(dirname(launch.profileDir))).mode & 0o777, 0o700);
    assert.equal(launch.sandbox, true);
    assert.equal(launch.reducedMotion, "reduce");
  } finally {
    await Promise.all([a.close(), b.close()]);
    if (before === undefined) delete process.env.BROWSER_TEST_SECRET; else process.env.BROWSER_TEST_SECRET = before;
  }
  await assert.rejects(access(dirname(first.launches[0].profileDir)));
  await assert.rejects(access(dirname(second.launches[0].profileDir)));
});

test("host URL policy rejects before browser navigation and errors cannot expose content", async () => {
  const fake = fakeBrowser();
  const session = await createBrowser({ executablePath: process.execPath, allowUrl: url => url.hostname === "127.0.0.1" }, fake.launch);
  try {
    await assert.rejects(session.open({ url: "https://example.test/?token=credential-canary" }), error => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, "url-denied");
      assert.ok(!String(error.stack).includes("credential-canary"));
      return true;
    });
    assert.deepEqual(fake.calls, []);
    await session.open({ url: "http://127.0.0.1:3000" });
  } finally { await session.close(); }
});

test("validation rejects invalid dimensions, scales, deadlines, sources and captures", async () => {
  for (const extra of [{ viewport: { width: 0, height: 1 } }, { deviceScaleFactor: Infinity }, { deviceScaleFactor: 0 }, { timeoutMs: 0 }]) {
    await assert.rejects(createBrowser({ executablePath: process.execPath, ...extra }, fakeBrowser().launch), { code: "invalid-input" });
  }
  const session = await createBrowser({ executablePath: process.execPath }, fakeBrowser().launch);
  try {
    await assert.rejects(session.open({ url: "file:///private/page.html" }), { code: "invalid-input" });
    await assert.rejects(session.open({ url: "javascript:alert(1)" }), { code: "invalid-input" });
    await assert.rejects(session.open({ file: "relative.html" }), { code: "invalid-input" });
    // Runtime JS callers must obey the same mutually exclusive options as TypeScript callers.
    // @ts-expect-error deliberately ambiguous source
    await assert.rejects(session.open({ html: "x", url: "https://example.test" }), { code: "invalid-input" });
    // @ts-expect-error deliberately ambiguous capture
    await assert.rejects(session.screenshot({ selector: "main", fullPage: true }), { code: "invalid-input" });
    await assert.rejects(session.waitFor({ expression: " " }), { code: "invalid-input" });
    await assert.rejects(session.setViewport({ width: 2.5, height: 3 }), { code: "invalid-input" });
  } finally { await session.close(); }
});

test("failed startup and failed close remove the private profile and suppress raw errors", async () => {
  let launchOptions: LaunchOptions | undefined;
  const failing: BrowserLauncher = async options => { launchOptions = options; throw new Error("credential-canary"); };
  await assert.rejects(createBrowser({ executablePath: process.execPath }, failing), { code: "launch-failed" });
  await assert.rejects(access(dirname(launchOptions!.profileDir)));
  const fake = fakeBrowser();
  const session = await createBrowser({ executablePath: process.execPath }, async options => {
    const driver = await fake.launch(options);
    return { ...driver, async screenshot() { throw new Error("credential-canary"); }, async close() { throw new Error("credential-canary"); } };
  });
  await assert.rejects(session.screenshot(), error => {
    assert.ok(error instanceof BrowserError);
    assert.equal(error.code, "operation-failed");
    assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes("credential-canary"));
    return true;
  });
  await assert.rejects(session.close(), { code: "close-failed" });
  await assert.rejects(access(dirname(fake.launches[0].profileDir)));
});

test("an unavailable temporary folder reports a plain startup failure without exposing its path", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-temp-test-"));
  const before = process.env.TMPDIR;
  const fake = fakeBrowser();
  process.env.TMPDIR = join(root, "private-path-canary");
  try {
    await assert.rejects(createBrowser({ executablePath: process.execPath }, fake.launch), error => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, "launch-failed");
      assert.ok(!String(error.stack).includes("private-path-canary"));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(fake.launches.length, 0);
  } finally {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    await rm(root, { recursive: true, force: true });
  }
});

test("queued operations retain document order; close drains them once and refuses new work", async () => {
  const fake = fakeBrowser();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const session = await createBrowser({ executablePath: process.execPath }, async options => {
    const driver = await fake.launch(options);
    return { ...driver, async openHtml(html, waitUntil) { await pending; await driver.openHtml(html, waitUntil); } };
  });
  const opening = session.open({ html: "first" });
  const screenshot = session.screenshot();
  const closing = session.close();
  assert.equal(session.close(), closing);
  await assert.rejects(session.open({ html: "too late" }), { code: "closed" });
  assert.equal(fake.calls.length, 0);
  release();
  await Promise.all([opening, screenshot, closing]);
  assert.deepEqual(fake.calls.map(call => call.operation), ["openHtml", "screenshot", "close"]);
});
