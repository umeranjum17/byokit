// The verify-byokit review-evidence capture: drives the real example apps (examples/pwa) in a real browser and writes
// every screen the change touches, in every theme and form factor the app has, before and after, plus one motion
// recording per changed interaction. The skill owns this file: a reviewer runs it, never hand-captures around it.
//
//   node .agents/skills/verify-byokit/capture/review-evidence.ts [--base <ref>] [--slug <name>] [--out <dir>] [--screens a,b]
//
// `--base` (default origin/main) is the "before" the change is measured against; each screen says how its before frame is
// reached: at that ref (`via: 'ref'`), or through the before route the screen itself ships (`via: 'url'`). A screen that
// does not exist at the base ref, a theme or form factor the app does not have, is recorded as a skip with its reason.
// Output is one stable, predictable folder (default `.verify-artifacts/review/<slug>`), gitignored, never committed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { mockOpenAI } from '@byokit/accounts/testing';
import { serve } from '../../../../examples/pwa/serve.ts';

const themes = ['light', 'dark'] as const;
type Theme = (typeof themes)[number];
/** A form factor is a width the app actually lays out for; the sizes are what `examples/pwa` and the Expo app target. */
const formFactors = { phone: { width: 390, height: 844, deviceScaleFactor: 2 }, desktop: { width: 1280, height: 800, deviceScaleFactor: 1 } } as const;
type FormFactor = keyof typeof formFactors;

type Drive = (page: Page) => Promise<void>;

type Screen = {
  /** File-name slug; also the folder name in the evidence set. */
  id: string;
  /** Path under the app's own server, or the before route when `before.via` is `'url'`. */
  path: string;
  /** In the app's words, so a reviewer knows what the frames show. */
  what: string;
  /** Themes the app has for this screen. */
  themes: Theme[];
  /** Why a theme the app does not have is not captured, one line each. */
  themeSkips?: Partial<Record<Theme, string>>;
  formFactors: FormFactor[];
  /** The interaction this change touches; recorded as motion on the head build. */
  interaction: string;
  /** How the before frame is reached: the base ref's build, or the before route the screen ships. */
  before: { via: 'ref' } | { via: 'url'; path: string };
  drive: Drive;
};

const part = (page: Page, key: string, name: string) => page.locator(`#${key} [data-${name}]`);

const SCREENS: Screen[] = [
  {
    id: 'signin',
    path: '',
    what: 'Sign in with ChatGPT by device code',
    themes: [...themes], // index.html ships both, through prefers-color-scheme
    formFactors: ['phone', 'desktop'],
    interaction: 'signin-code',
    before: { via: 'ref' },
    async drive(page) {
      await part(page, 'chatgpt', 'signin').click();
      await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).waitFor();
    },
  },
  {
    id: 'usage',
    path: 'usage.html',
    what: 'Plan usage view for a plan the person pays for',
    themes: ['light'],
    themeSkips: { dark: 'usage.html hardcodes its palette (#172c43 on #edf3f9) and has no prefers-color-scheme dark theme.' },
    formFactors: ['phone', 'desktop'], // its only breakpoint is the 700px max-width layout
    interaction: 'plan-switch',
    // The screen ships the old independent selectors behind `?before`, on the same ledger, so the pair is comparable.
    before: { via: 'url', path: 'usage.html?before' },
    async drive(page) {
      await page.locator('nav button', { hasText: 'Claude plan' }).click();
      await page.locator('h2').filter({ hasText: 'Claude plan' }).waitFor();
    },
  },
];

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const existsAt = (ref: string, path: string) => { try { git('cat-file', '-e', `${ref}:${path}`); return true; } catch { return false; } };

const base = arg('base', 'origin/main')!;
const slug = arg('slug', 'local')!;
const out = arg('out', `.verify-artifacts/review/${slug}`)!;
const wanted = arg('screens', SCREENS.map((s) => s.id).join(','))!.split(',').map((s) => s.trim()).filter(Boolean);
const screens = SCREENS.filter((s) => wanted.includes(s.id));
if (!screens.length) throw new Error(`no screens matched --screens ${wanted.join(',')}`);

mkdirSync(out, { recursive: true });
const scratch = mkdtempSync('.verify-artifacts/review-scratch.');
const written: string[] = [];
const skips: { screen: string; what: string; reason: string }[] = [];
const note = (screen: string, what: string, reason: string) => { skips.push({ screen, what, reason }); console.log(`skip  ${screen} ${what}: ${reason}`); };

// The "before" build: the example app exactly as the base ref has it, served from its own copy of the same files.
const baseDir = join(scratch, 'base');
if (screens.some((s) => s.before.via === 'ref')) {
  if (!existsAt(base, 'examples/pwa/serve.ts')) throw new Error(`base ref ${base} has no examples/pwa to serve`);
  mkdirSync(baseDir, { recursive: true });
  // The copy stays inside the worktree so bare `@byokit/*` imports resolve to this workspace, as serve.ts expects.
  // The fixture module the pwa entry imports is archived with it, or the base build cannot resolve it.
  const paths = ['examples/pwa', ...(existsAt(base, 'examples/usage-demo.ts') ? ['examples/usage-demo.ts'] : [])];
  execFileSync('sh', ['-c', `git archive ${base} ${paths.join(' ')} | tar -x -C ${JSON.stringify(baseDir)}`]);
}

const openai = await mockOpenAI();
const head = await serve(0, openai.base);
const baseServe = existsSync(baseDir) ? await (async () => {
  const module = await import(pathToFileURL(join(baseDir, 'examples/pwa/serve.ts')).href);
  return (module.serve as typeof serve)(0, openai.base);
})() : undefined;
console.log(`base ${base} -> ${baseServe?.url ?? '(not used)'}\nhead -> ${head.url}\nout  ${out}\n`);

const executablePath = existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath });
const shot = async (page: Page, name: string) => { await page.screenshot({ path: join(out, name) }); written.push(name); console.log(`frame ${name}`); };
const errors: string[] = [];

try {
  for (const screen of screens) {
    const dir = join(out, screen.id);
    mkdirSync(dir, { recursive: true });
    // Where the before frame comes from: the screen's own before route, or the same screen at the base ref.
    const atBase = screen.before.via === 'ref' && existsAt(base, `examples/pwa/${screen.path || 'index.html'}`);
    const beforeHref = screen.before.via === 'url' ? `${head.url}${screen.before.path}` : atBase ? `${baseServe!.url}${screen.path}` : undefined;
    if (!beforeHref) note(screen.id, 'before frames', `${screen.path || 'index.html'} did not exist at ${base}: the screen is new in this change.`);
    for (const theme of themes) {
      if (!screen.themes.includes(theme)) {
        note(screen.id, `${theme} theme`, screen.themeSkips?.[theme] ?? 'the screen has no such theme');
        continue;
      }
      for (const form of screen.formFactors) {
        const size = formFactors[form];
        const open = async (video?: boolean) => {
          const context = await browser.newContext({ colorScheme: theme, viewport: { width: size.width, height: size.height },
            deviceScaleFactor: video ? 1 : size.deviceScaleFactor, serviceWorkers: 'block', // a cached shell would serve a stale screen
            ...(video ? { recordVideo: { dir: join(scratch, 'video'), size } } : {}) });
          const page = await context.newPage();
          page.on('pageerror', (e) => errors.push(`${screen.id} ${theme} ${form}: ${e}`));
          return { context, page };
        };

        // Frames: the before state, then the same screen with the interaction done.
        if (beforeHref) {
          const frames = await open();
          await frames.page.goto(beforeHref, { waitUntil: 'load' });
          await frames.page.waitForTimeout(500); // the cards draw from IndexedDB and the sign-in status
          await shot(frames.page, join(screen.id, `before__${theme}__${form}.png`));
          await frames.context.close();
        }
        const after = await open();
        await after.page.goto(`${head.url}${screen.path}`, { waitUntil: 'load' });
        await screen.drive(after.page);
        await shot(after.page, join(screen.id, `after__${theme}__${form}.png`));
        await after.context.close();

        // Motion: the interaction itself, recorded from the running app.
        const motion = await open(true);
        await motion.page.goto(`${head.url}${screen.path}`, { waitUntil: 'load' });
        await screen.drive(motion.page);
        const video = motion.page.video();
        await motion.context.close();
        if (!video) throw new Error(`${screen.id} ${theme} ${form}: the browser recorded no motion`);
        const name = join(screen.id, `motion__${screen.interaction}__${theme}__${form}.webm`);
        await video.saveAs(join(out, name));
        written.push(name);
        console.log(`motion ${name}`);
      }
    }
  }
} finally {
  await browser.close();
  baseServe?.close();
  head.close();
  await openai.close();
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) console.error(`page errors:\n${errors.join('\n')}`);
const manifest = { base, head: 'worktree', out, screens: screens.map((s) => ({ id: s.id, what: s.what, interaction: s.interaction, themes: s.themes, formFactors: s.formFactors })), files: written, skips, pageErrors: errors };
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nEvidence: ${out}/manifest.json (${written.length} files, ${skips.length} skips, ${errors.length} page errors)`);
if (errors.length) process.exitCode = 1;