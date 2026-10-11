// The voice screen offline: server.ts with BYOKIT_EXAMPLE_FAKE=1 signs in through the stand-in and signals to the
// stand-in peer (stand-in.html) on its own loopback port, and headless Chromium with a fake microphone taps to talk
// twice: idle → connecting → listening → thinking → speaking → idle, then a blocked microphone shows the error state.
// /proof must read as a full call. BYOKIT_VOICE_STILLS=<dir outside the repo> saves stills at 390 and 320 px. Not a live pass.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
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
// A signed-in voice page that records every microphone capture; `slow` delays one capture so a mid-attach tap is reachable.
const openVoicePage = async (origin: string) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const seen = window as unknown as { tracks: MediaStreamTrack[]; captures: number; slow: number };
    seen.tracks = []; seen.captures = 0; seen.slow = 0;
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => { seen.captures++; if (seen.slow) await new Promise((resolve) => setTimeout(resolve, seen.slow)); const stream = await capture(constraints); seen.tracks.push(...stream.getTracks()); return stream; };
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.getElementById('screen')?.dataset.state === 'signed-out');
  await page.click('#sign-in');
  await Promise.all([context.waitForEvent('page'), page.click('#authorize')]);
  await page.waitForFunction(() => document.getElementById('screen')?.dataset.state === 'idle');
  return page;
};
const voiceTracks = (page: Page) => page.evaluate(() => (window as unknown as { tracks: MediaStreamTrack[] }).tracks.map((track) => `${track.kind}:${track.readyState}`));
const voiceEnded = (page: Page) => page.waitForFunction(() => { const tracks = (window as unknown as { tracks: MediaStreamTrack[] }).tracks; return tracks.length > 0 && tracks.every((track) => track.readyState === 'ended'); }, undefined, { timeout: 30000 });
const voiceState = (page: Page, state: string) => page.waitForFunction((want) => document.getElementById('screen')?.dataset.state === want, state, { timeout: 30000 });

test('offline voice: stand-in sign-in, tap to talk twice, then a blocked microphone', async () => {
  const origin = await start({ BYOKIT_EXAMPLE_FAKE: '1' });
  const proof = async () => (await fetch(`${origin}/proof`)).json() as Promise<Record<string, boolean | number>>;
  const errors: string[] = [];
  const until = async (ready: (p: Record<string, boolean | number>) => boolean) => {
    for (let i = 0; i < 300; i++) { const p = await proof(); if (ready(p)) return p; await new Promise((r) => setTimeout(r, 100)); }
    assert.fail(`proof never got there: ${JSON.stringify(await proof())}; page errors: ${JSON.stringify(errors)}`);
  };
  const stills = process.env.BYOKIT_VOICE_STILLS;
  if (stills) mkdirSync(stills, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.on('weberror', (e) => errors.push(String(e.error()))); // either page, the stand-in from its first script line
  const page = await context.newPage();
  // Records every screen state and every captured microphone track, from before the page's own script runs.
  await page.addInitScript(() => {
    const seen = window as unknown as { states: string[]; tracks: MediaStreamTrack[] };
    seen.states = []; seen.tracks = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => { const stream = await capture(constraints); seen.tracks.push(...stream.getTracks()); return stream; };
    document.addEventListener('DOMContentLoaded', () => {
      const screen = document.getElementById('screen')!;
      const note = () => { if (seen.states.at(-1) !== screen.dataset.state) seen.states.push(screen.dataset.state!); };
      note(); new MutationObserver(note).observe(screen, { attributes: true, attributeFilter: ['data-state'] });
    });
  });
  const words: Record<string, string> = {}, texts: string[] = [];
  const reach = async (state: string, width: number) => {
    await page.waitForFunction((s) => document.getElementById('screen')?.dataset.state === s, state, { timeout: 30000 });
    words[state] = await page.locator('#status').innerText();
    texts.push(await page.evaluate(() => `${document.title}\n${document.body.innerText}`));
    for (const colorScheme of stills ? ['light', 'dark'] as const : []) { // colour fades jump to their end
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: join(stills!, `${state}-${width}-${colorScheme}.png`), animations: 'disabled' });
    }
  };
  const turn = async (width: number) => {
    await page.setViewportSize({ width, height: 844 });
    await reach('idle', width);
    await page.click('#talk');
    if (width === 390) await reach('connecting', width);
    await reach('listening', width);
    await new Promise((r) => setTimeout(r, 1000)); // the stand-in hears a second of the fake microphone
    await page.click('#talk');
    await reach('thinking', width);
    await reach('speaking', width);
    await reach('idle', width);
  };
  await page.goto(origin);
  await reach('signed-out', 390);
  await page.setViewportSize({ width: 320, height: 844 });
  await reach('signed-out', 320);
  await page.click('#sign-in');
  // The stand-in sign-in opens where ChatGPT's approval page would, and becomes the voice peer.
  await Promise.all([context.waitForEvent('page'), page.click('#authorize')]);
  await turn(390);
  await turn(320);
  // Each release ended its microphone track: no live input remains while the call stays up.
  const tracks = await page.evaluate(() => (window as unknown as { tracks: MediaStreamTrack[] }).tracks.map((t) => `${t.kind}:${t.readyState}`));
  assert.deepEqual(tracks, ['audio:ended', 'audio:ended']);
  assert.equal(await page.locator('#transcript li').count(), 4);
  assert.match(await page.locator('#transcript').innerText(), /You\s+Hello from BYOKit\.[\s\S]*Assistant\s+Hello from BYOKit\./);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError')); });
  await page.click('#talk');
  await reach('error', 320);
  await page.setViewportSize({ width: 390, height: 844 });
  await reach('error', 390);
  const states = await page.evaluate(() => (window as unknown as { states: string[] }).states);
  const call = ['idle', 'listening', 'thinking', 'speaking', 'idle'];
  assert.deepEqual(states, ['signed-out', 'idle', 'connecting', ...call.slice(1), 'connecting', ...call.slice(1), 'connecting', 'error'].filter((s, i, all) => s !== all[i - 1]));
  assert.equal(new Set(Object.values(words)).size, Object.keys(words).length, `each state reads differently: ${JSON.stringify(words)}`);
  assert.equal(words.idle, 'Tap to talk');
  assert.match(texts.join('\n'), /ChatGPT plan/);
  assert.deepEqual(texts.join('\n').match(/gpt-|codex|realtime|webrtc|sdp/gi), null);
  const final = await until((p) => p.stopped === true);
  for (const key of ['signedIn', 'signalingAnswered', 'connected', 'microphone', 'stopped']) assert.equal(final[key], true, key);
  assert.equal(final.userTurns, 2); assert.equal(final.agentTurns, 2);
  assert.equal(final.error, false);
  assert.deepEqual(Object.values(final).filter((v) => typeof v === 'string'), [], '/proof keeps counts, never text');
  assert.deepEqual(errors, []);
});

test('a tap while connecting cancels before the microphone opens', async () => {
  const origin = await start({ BYOKIT_EXAMPLE_FAKE: '1' });
  const page = await openVoicePage(origin);
  // Both taps land in one task, before the peer can connect: the second is a cancel, not a drop.
  await page.evaluate(() => { const talk = document.getElementById('talk')!; talk.click(); talk.click(); });
  await voiceState(page, 'idle');
  assert.equal(await page.evaluate(() => (window as unknown as { captures: number }).captures), 0, 'the cancelled call never opened a microphone');
  assert.deepEqual(await voiceTracks(page), []);
  await page.click('#talk');
  await voiceState(page, 'listening');
  await page.click('#talk');
  await voiceEnded(page);
  assert.deepEqual(await voiceTracks(page), ['audio:ended']);
});

test('a tap while attaching releases the microphone once it resolves', async () => {
  const origin = await start({ BYOKIT_EXAMPLE_FAKE: '1' });
  const page = await openVoicePage(origin);
  await page.evaluate(() => { (window as unknown as { slow: number }).slow = 800; });
  await page.click('#talk');
  await page.waitForFunction(() => (window as unknown as { captures: number }).captures === 1);
  await page.click('#talk');
  await voiceEnded(page);
  await voiceState(page, 'idle');
  await page.evaluate(() => { (window as unknown as { slow: number }).slow = 0; });
  await page.click('#talk');
  await voiceState(page, 'listening');
  await page.click('#talk');
  await page.waitForFunction(() => { const tracks = (window as unknown as { tracks: MediaStreamTrack[] }).tracks; return tracks.length === 2 && tracks.every((track) => track.readyState === 'ended'); }, undefined, { timeout: 30000 });
  assert.deepEqual(await voiceTracks(page), ['audio:ended', 'audio:ended']);
});

test('without the flag the stand-in routes do not exist', async () => {
  const origin = await start({ BYOKIT_EXAMPLE_FAKE: '' });
  for (const [method, path] of [['GET', '/stand-in.html'], ['POST', '/stand-in/approve'], ['GET', '/stand-in/offer'], ['POST', '/stand-in/offer'], ['POST', '/stand-in/answer']]) {
    assert.equal((await fetch(`${origin}${path}`, { method, headers: { origin } })).status, 403, `${method} ${path}`);
  }
});
