// The verify-byokit capture for the realtime voice pick screen on the real example server (no BYOKIT_EXAMPLE_FAKE): a
// phone-width browser records video while it opens the pick screen and chooses each provider the realtime kit lists,
// stopping on that provider's sign-in or key step — it never presses Sign in, pastes a key or calls a model, so nothing
// leaves the computer. The server runs in a throwaway HOME, so no real sign-in or keyring is ever read.
//
//   node .agents/skills/verify-byokit/capture/realtime-voice-pick.ts <evidence dir outside the repository>
//
// Writes `<state>-<provider>-<width>-<theme>.png` stills, one `pick-<theme>.webm` recording per theme, and `manifest.json`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { providers } from '../../../../packages/realtime/src/index.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: realtime-voice-pick.ts <evidence dir>');
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'voice-pick-home-'));
const server = spawn(process.execPath, [fileURLToPath(new URL('../../../../examples/realtime-voice/server.ts', import.meta.url))],
  { env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), TMPDIR: home }, stdio: ['ignore', 'pipe', 'inherit'] });
let said = '';
server.stdout.on('data', (b: Buffer) => { said += b.toString(); });
const executablePath = existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath });
const written: string[] = [];
try {
  for (let i = 0; i < 300 && !/Live demo: http:\/\/127\.0\.0\.1:\d+/.test(said); i++) await new Promise((r) => setTimeout(r, 50));
  const origin = said.match(/Live demo: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  if (!origin) throw new Error(`the real server never printed its live address; it said:\n${said}`);
  for (const theme of ['light', 'dark'] as const) for (const width of [390, 320]) {
    const record = width === 390; // one recording per theme at phone width; 320 adds stills only
    const video = record ? mkdtempSync(join(out, '.video-')) : undefined;
    const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, colorScheme: theme, ...(video ? { recordVideo: { dir: video, size: { width, height: 844 } } } : {}) });
    const page = await context.newPage();
    const shot = async (name: string) => { const file = `${name}-${width}-${theme}.png`; await page.screenshot({ path: join(out, file), fullPage: true }); written.push(file); };
    await page.goto(origin);
    await page.waitForFunction(() => document.getElementById('screen')?.dataset.state === 'pick');
    await shot('pick');
    for (const provider of providers) {
      if (record) await page.waitForTimeout(800); // the recording dwells on each screen
      await page.click(`[data-provider="${provider.id}"]`);
      const step = provider.planSignIn ? 'sign-in' : 'key';
      await page.waitForFunction((id) => !document.getElementById(`${id}-panel`)?.hidden, step);
      await shot(`${step}-${provider.id}`);
      if (record) await page.waitForTimeout(800);
      await page.click(provider.planSignIn ? '#back-sign-in' : '#back-key');
      await page.waitForFunction(() => document.getElementById('screen')?.dataset.state === 'pick');
    }
    await context.close();
    if (!video) continue;
    const [webm] = readdirSync(video);
    renameSync(join(video, webm!), join(out, `pick-${theme}.webm`)); written.push(`pick-${theme}.webm`);
    rmSync(video, { recursive: true, force: true });
  }
  const proof = await (await fetch(`${origin}/proof`)).json();
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ server: 'examples/realtime-voice/server.ts (live, no BYOKIT_EXAMPLE_FAKE)', providers: providers.map((p) => p.id), proof, files: written }, null, 2));
  console.log(`wrote ${written.length} files to ${out}; /proof ${JSON.stringify(proof)}`);
} finally {
  await browser.close(); server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  rmSync(home, { recursive: true, force: true });
}
