// The voice proof page offline: server.ts with BYOKIT_EXAMPLE_FAKE=1 signs in through the stand-in and signals to the
// stand-in peer (stand-in.html) on its own loopback port, and headless Chromium with a fake microphone goes
// sign in → Start voice → one user and one agent turn → Stop. /proof must read as a full call. This is not a live pass.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { trackChild } from '../../packages/test-support.ts';

const server = fileURLToPath(new URL('./server.ts', import.meta.url));
const started: ChildProcess[] = [];
const start = async (env: NodeJS.ProcessEnv) => {
  const child = trackChild(spawn(process.execPath, [server], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] }));
  started.push(child);
  let said = '';
  child.stdout.on('data', (b: Buffer) => { said += b.toString(); });
  for (let i = 0; i < 300 && !/http:\/\/127\.0\.0\.1:\d+/.test(said); i++) await new Promise((r) => setTimeout(r, 50));
  const url = said.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(url, `server never printed its address; it said:\n${said}`);
  return url;
};
// Playwright's own Chromium (CI installs it); else the system's, for a machine without Playwright's download.
const executablePath = existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
after(async () => { await browser.close(); for (const child of started) child.kill('SIGTERM'); });

test('offline voice: stand-in sign-in, a call with one turn each way, then stop', async () => {
  const origin = await start({ BYOKIT_EXAMPLE_FAKE: '1' });
  const proof = async () => (await fetch(`${origin}/proof`)).json() as Promise<Record<string, boolean | number>>;
  const errors: string[] = [];
  const until = async (ready: (p: Record<string, boolean | number>) => boolean) => {
    for (let i = 0; i < 300; i++) { const p = await proof(); if (ready(p)) return p; await new Promise((r) => setTimeout(r, 100)); }
    assert.fail(`proof never got there: ${JSON.stringify(await proof())}; page errors: ${JSON.stringify(errors)}`);
  };
  const context = await browser.newContext();
  context.on('weberror', (e) => errors.push(String(e.error()))); // either page, the stand-in from its first script line
  const page = await context.newPage();
  await page.goto(origin);
  await page.click('#sign-in');
  // The stand-in sign-in opens where ChatGPT's approval page would, and becomes the voice peer.
  await Promise.all([context.waitForEvent('page'), page.click('#authorize')]);
  await until((p) => p.signedIn === true);
  await page.click('#start');
  await until((p) => p.connected === true && (p.userTurns as number) >= 1 && (p.agentTurns as number) >= 1);
  await page.click('#stop');
  const final = await until((p) => p.stopped === true);
  for (const key of ['signedIn', 'signalingAnswered', 'connected', 'microphone', 'stopped']) assert.equal(final[key], true, key);
  assert.ok((final.userTurns as number) >= 1 && (final.agentTurns as number) >= 1);
  assert.equal(final.error, false);
  assert.deepEqual(errors, []);
});

test('without the flag the stand-in routes do not exist', async () => {
  const origin = await start({ BYOKIT_EXAMPLE_FAKE: '' });
  for (const [method, path] of [['GET', '/stand-in.html'], ['POST', '/stand-in/approve'], ['GET', '/stand-in/offer'], ['POST', '/stand-in/offer'], ['POST', '/stand-in/answer']]) {
    assert.equal((await fetch(`${origin}${path}`, { method, headers: { origin } })).status, 403, `${method} ${path}`);
  }
});
