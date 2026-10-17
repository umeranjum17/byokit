// The verify-byokit review-evidence capture: drives the real example apps (examples/pwa) in a real browser and writes
// every screen the change touches, in every theme and form factor the app has, before and after, plus one motion
// recording per changed interaction. The skill owns this file: a reviewer runs it, never hand-captures around it.
//
//   node .agents/skills/verify-byokit/capture/review-evidence.ts [--base <ref>] [--slug <name>] [--out <dir>] [--screens a,b]
//       [--font-scale <n>]
//
// `--base` (default origin/main) is the "before" the change is measured against; each screen says how its before frame is
// reached: at that ref (`via: 'ref'`), or through the before route the screen itself ships (`via: 'url'`). A screen that
// does not exist at the base ref, a theme or form factor the app does not have, is recorded as a skip with its reason.
// `--font-scale` (default 1) sets the page's body text to `17 × n` px, for a larger-text capture in its own output dir.
// Output is one stable, predictable folder (default `.verify-artifacts/review/<slug>`), gitignored, never committed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { mockDevice, mockOpenAI } from '@byokit/accounts/testing';
import { serve } from '../../../../examples/pwa/serve.ts';

const themes = ['light', 'dark'] as const;
type Theme = (typeof themes)[number];
/** A form factor is a width the app actually lays out for; the sizes are what `examples/pwa` and the Expo app target. */
const formFactors = { phone: { width: 390, height: 844, deviceScaleFactor: 2 }, desktop: { width: 1280, height: 800, deviceScaleFactor: 1 },
  /** The narrowest phone still in use, for screens whose lines could wrap or clip. */
  narrow: { width: 320, height: 640, deviceScaleFactor: 2 } } as const;
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
  /**
   * Reach the screen's state on the before page too, by running the same `drive`. Off by default (the before frame is
   * the base app's initial paint). Screens whose state only exists after an interaction opt in, so before and after
   * compare one state instead of initial paint against driven.
   */
  beforeDrive?: boolean;
  drive: Drive;
};

const part = (page: Page, key: string, name: string) => page.locator(`#${key} [data-${name}]`);

/** Sign in one ChatGPT account through the card (Sign in for the first, Add another after) and the stand-in's page. */
async function connectChatGPT(page: Page, identity: { accountId: string; email: string; plan: string }, first: boolean) {
  Object.assign(openai.state, identity);
  const start = part(page, 'chatgpt', first ? 'signin' : 'add');
  await start.waitFor({ state: 'visible' });
  await start.click();
  const codeAt = part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ });
  await codeAt.waitFor();
  const code = (await codeAt.textContent())!;
  const [provider] = await Promise.all([page.context().waitForEvent('page'), part(page, 'chatgpt', 'open').click()]);
  await provider.fill('#code', code.trim());
  await provider.click('#continue');
  await provider.locator('#words').filter({ hasText: /Signed in/ }).waitFor(); // let the page land: closing mid-navigation wedges close(), which has no timeout
  await provider.close();
  await part(page, 'chatgpt', 'status').filter({ hasText: /is connected/ }).waitFor();
  await page.locator('#chatgpt [data-account]', { hasText: identity.email }).waitFor();
}

/** The stand-in does not serve ChatGPT's usage endpoint: answer it per account, so Auto has a room to rank. With
 *  `weekly`, the account reports a five-hour session window and a weekly one, as ChatGPT does; `down()` true answers 503. */
async function withRooms(page: Page, rooms: Record<string, { usedPercent: number; weekly?: number }>, down = () => false) {
  await page.route('**/wham/usage', (route) => {
    if (down()) return route.fulfill({ status: 503, body: '', headers: { 'access-control-allow-origin': '*' } });
    const id = route.request().headers()['chatgpt-account-id'];
    const room = id ? rooms[id] : undefined;
    const used = id ? room?.usedPercent ?? 100 : 0;
    const rate_limit = room?.weekly === undefined
      ? { primary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 3600 } }
      : { primary_window: { used_percent: used, limit_window_seconds: 18000, reset_after_seconds: 8400 },
        secondary_window: { used_percent: room.weekly, limit_window_seconds: 604800, reset_after_seconds: 302400 } };
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ rate_limit }) });
  });
}

/** Two ChatGPT plans reporting both windows; Work's address is the longest a row has to fit. */
const WINDOW_ROOMS = { 'umer-work': { usedPercent: 62, weekly: 41 }, 'umer-personal': { usedPercent: 12, weekly: 88 } };
async function connectWindows(page: Page) {
  await connectChatGPT(page, { accountId: 'umer-work', email: 'first.last.engineering.team@longest-company-name.example', plan: 'team' }, true);
  await connectChatGPT(page, { accountId: 'umer-personal', email: 'umer@example.com', plan: 'plus' }, false);
}

/** Answers go through the page's own `/fwd/chatgpt/` proxy; send them to the stand-in instead of the real endpoint. */
async function withAnswers(page: Page) {
  await page.route('**/fwd/chatgpt/backend-api/codex/responses', async (route) => {
    const h = route.request().headers();
    const up = await fetch(`${openai.base}/codex/responses`, { method: 'POST', body: route.request().postData() ?? '',
      headers: { 'content-type': 'application/json', authorization: h['authorization'] ?? '', 'chatgpt-account-id': h['chatgpt-account-id'] ?? '',
        'openai-beta': h['openai-beta'] ?? '', originator: h['originator'] ?? '' } });
    return route.fulfill({ status: up.status, contentType: up.headers.get('content-type') ?? 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: await up.text() });
  });
}

/** Pick Auto, ask, and wait for the answer (or the typed error the app shows for that ask). */
async function askAuto(page: Page, question: string, answer: string | RegExp = `You said: ${question}`) {
  await part(page, 'chatgpt', 'pick').selectOption('auto');
  await part(page, 'chatgpt', 'question').fill(question);
  await part(page, 'chatgpt', 'ask').click();
  await part(page, 'chatgpt', 'answer').filter({ hasText: answer }).waitFor();
}

const SCREENS: Screen[] = [
  {
    id: 'account-windows',
    path: '',
    what: 'Each ChatGPT plan row shows its session and weekly window, tightest first, each with its reset, and how old the reading is',
    themes: [...themes],
    formFactors: ['narrow', 'phone', 'desktop'],
    interaction: 'account-windows',
    before: { via: 'ref' },
    beforeDrive: true, // the base card with the same two plans, which drew only the tightest window
    async drive(page) {
      await withRooms(page, WINDOW_ROOMS);
      await connectWindows(page);
      await page.locator('#chatgpt [data-room]').filter({ hasText: /Team · 38% left this session/ }).waitFor();
      if (await page.locator('#chatgpt [data-window]').count()) {
        await page.locator('#chatgpt [data-age]').filter({ hasText: 'Read a moment ago' }).first().waitFor();
      }
      await page.locator('#chatgpt [data-accounts]').scrollIntoViewIfNeeded();
    },
  },
  {
    id: 'account-stale',
    path: '',
    what: 'A day later the quota cannot be read: each row keeps its last windows, says how old they are and that they are stale',
    themes: [...themes],
    formFactors: ['narrow', 'phone', 'desktop'],
    interaction: 'account-stale',
    before: { via: 'ref' },
    beforeDrive: true, // the base card a day later, which showed the last room without its age
    async drive(page) {
      let down = false;
      await withRooms(page, WINDOW_ROOMS, () => down);
      await connectWindows(page);
      await page.locator('#chatgpt [data-room]').filter({ hasText: /Team · 38% left this session/ }).waitFor();
      // The page's own clock from here on, so the reading can turn a day old without waiting a day.
      await page.clock.install();
      await page.reload();
      await page.locator('#chatgpt [data-room]').filter({ hasText: /Team · 38% left this session/ }).waitFor();
      down = true;
      await page.clock.setSystemTime(Date.now() + 25 * 3_600_000);
      await page.locator('#chatgpt [data-pick]').dispatchEvent('change');
      if (await page.locator('#chatgpt [data-window]').count()) {
        await page.locator('#chatgpt [data-age]').filter({ hasText: 'Read 1 day ago (stale)' }).nth(1).waitFor();
      } else await page.waitForTimeout(500); // the base card has no age to wait for; its repaint is one tick
      await page.locator('#chatgpt [data-accounts]').scrollIntoViewIfNeeded();
    },
  },
  ...(['code', 'connected', 'reloaded', 'signed-out'] as const).map((state): Screen => ({
    id: `grok-${state}`, path: '', what: `Grok local mockDevice journey: ${state}`,
    themes: [...themes], formFactors: ['phone', 'desktop'], interaction: `grok-${state}`,
    before: { via: 'ref' },
    async drive(page) {
      await part(page, 'grok', 'signin').click();
      const code = part(page, 'grok', 'code').filter({ hasText: /^FIXTURE-/ });
      await code.waitFor();
      if (state !== 'code') {
        device.state.dropPolls = 1;
        if (!device.approve((await code.textContent())!)) throw new Error('mockDevice refused its issued code');
        await part(page, 'grok', 'status').filter({ hasText: /is connected/ }).waitFor();
        if (device.state.dropPolls !== 0) throw new Error('dropped poll was not exercised');
        if (state !== 'connected') {
          await page.reload();
          await part(page, 'grok', 'status').filter({ hasText: /is connected/ }).waitFor();
          if (state === 'signed-out') {
            await part(page, 'grok', 'signout').click();
            await part(page, 'grok', 'signin').waitFor();
            if (await part(page, 'grok', 'sheet').isVisible()) throw new Error('code remains after sign-out');
          }
        }
      }
      await page.locator('#grok').scrollIntoViewIfNeeded();
    },
  })),

  {
    id: 'signin-list',
    path: '',
    what: 'Signed-out provider list with logos and plan/pay-per-use chips',
    themes: [...themes], // index.html ships both, through prefers-color-scheme
    formFactors: ['phone', 'desktop'],
    interaction: 'provider-list',
    before: { via: 'ref' },
    async drive(page) {
      await part(page, 'chatgpt', 'status').filter({ hasText: /isn't signed in/ }).waitFor();
    },
  },
  // The sheet is longer than a screen: its top (Plans first), the ChatGPT row this page can start, and rows it cannot.
  ...(['top', 'ready', 'unavailable'] as const).map((at): Screen => ({
    id: `add-sheet-${at}`, path: '',
    what: { top: 'Add an account: every route grouped by connectView, Plans first', ready: 'Add an account: the ChatGPT plan row, tappable, starts its card',
      unavailable: 'Add an account: a row needing the host says why and cannot be tapped' }[at],
    themes: [...themes],
    formFactors: ['narrow', 'phone', 'desktop'],
    interaction: `add-sheet-${at}`,
    before: { via: 'ref' }, // the base page has no Add button: its before frame is the signed-out list it showed instead
    async drive(page) {
      await part(page, 'chatgpt', 'status').filter({ hasText: /isn't signed in/ }).waitFor();
      if (!await page.locator('#add-open').count()) return;
      await page.locator('#add-open').click();
      if (at === 'top') await page.locator('#add-sheet').evaluate((e) => e.scrollIntoView({ block: 'start' }));
      else await page.locator(`[data-route="${at === 'ready' ? 'openai:code' : 'anthropic:paste'}"]`).evaluate((e) => e.scrollIntoView({ block: 'center' }));
    },
  })),
  {
    id: 'add-sheet-coming', path: '',
    what: 'Add an account: the Coming soon group opened, holding every row this page has no form for',
    themes: [...themes],
    formFactors: ['narrow', 'phone', 'desktop'],
    interaction: 'add-sheet-coming',
    before: { via: 'ref' }, // the base page has no Coming soon group: its before frame is the signed-out list it showed instead
    async drive(page) {
      await part(page, 'chatgpt', 'status').filter({ hasText: /isn't signed in/ }).waitFor();
      if (!await page.locator('#add-open').count()) return;
      await page.locator('#add-open').click();
      const toggle = page.locator('[data-coming-toggle]');
      if (!await toggle.count()) return; // the base sheet lists those rows where they were
      await toggle.click();
      await page.locator('[data-group="coming-soon"] [data-route]').first().waitFor({ state: 'visible' });
      await page.locator('[data-group="coming-soon"]').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    },
  },
  {
    id: 'add-sheet-go', path: '',
    what: 'Add an account: the OpenCode Go plan row, tappable in Plans with its paste-key form',
    themes: [...themes],
    formFactors: ['narrow', 'phone', 'desktop'],
    interaction: 'add-sheet-go',
    before: { via: 'ref' }, // the base sheet has no Go card: the row waits, disabled, in Coming soon
    beforeDrive: true, // the same drive opens Coming soon there, so both frames show the Go row
    async drive(page) {
      await part(page, 'chatgpt', 'status').filter({ hasText: /isn't signed in/ }).waitFor();
      if (!await page.locator('#add-open').count()) return;
      await page.locator('#add-open').click();
      const row = page.locator('[data-route="opencode:plan_key:opencode-go"]');
      await row.waitFor({ state: 'attached' });
      if (!await row.isVisible()) {
        await page.locator('[data-coming-toggle]').click();
        await row.waitFor({ state: 'visible' });
      }
      await row.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    },
  },
  {
    id: 'go-key', path: '',
    what: 'OpenCode Go card: the paste-key form the Add sheet row opens',
    themes: [...themes],
    formFactors: ['narrow', 'phone', 'desktop'],
    interaction: 'go-key',
    before: { via: 'ref' }, // the base page has no Go card: its before frame is the signed-out list it showed instead
    async drive(page) {
      await part(page, 'chatgpt', 'status').filter({ hasText: /isn't signed in/ }).waitFor();
      if (!await page.locator('#opencode').count()) return;
      await page.locator('#add-open').click();
      await page.locator('[data-route="opencode:plan_key:opencode-go"]').click();
      await part(page, 'opencode', 'paste').waitFor({ state: 'visible' });
      await page.locator('#opencode').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    },
  },
  {
    id: 'go-connected', path: '',
    what: 'OpenCode Go card: a pasted plan key connects, and the account lists ready with its room',
    themes: [...themes],
    formFactors: ['narrow', 'phone', 'desktop'],
    interaction: 'go-connected',
    before: { via: 'ref' }, // the base page has no Go card: its before frame is the signed-out list it showed instead
    async drive(page) {
      await part(page, 'chatgpt', 'status').filter({ hasText: /isn't signed in/ }).waitFor();
      if (!await page.locator('#opencode').count()) return;
      await page.locator('#add-open').click();
      await page.locator('[data-route="opencode:plan_key:opencode-go"]').click();
      await part(page, 'opencode', 'pasted').fill('plan-key');
      await part(page, 'opencode', 'connect').click();
      await part(page, 'opencode', 'status').filter({ hasText: /is connected/ }).waitFor();
      await page.locator('#opencode [data-room]').filter({ hasText: 'Room left unknown' }).waitFor();
      await page.locator('#opencode').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    },
  },
  {
    id: 'go-workspace', path: '',
    what: 'OpenCode Go: a key that acts for several workspaces shows the workspace pick on the paste box, the key held in memory only',
    themes: [...themes],
    formFactors: ['narrow', 'phone', 'desktop'],
    interaction: 'go-workspace',
    before: { via: 'ref' },
    beforeDrive: true, // the same drive on the base page: the box closes on a multi-workspace key and saves nothing
    async drive(page) {
      await page.route('**/fwd/opencode/console/api/orgs', (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify([{ id: 'wrk_01', name: 'Default' }, { id: 'wrk_02', name: 'Working' }]) }));
      await part(page, 'chatgpt', 'status').filter({ hasText: /isn't signed in/ }).waitFor();
      if (!await page.locator('#opencode').count()) return;
      await page.locator('#add-open').click();
      await page.locator('[data-route="opencode:plan_key:opencode-go"]').click();
      await part(page, 'opencode', 'paste').waitFor({ state: 'visible' });
      await part(page, 'opencode', 'pasted').fill('plan-key');
      await part(page, 'opencode', 'connect').click();
      // The candidate shows the pick; the base page silently closes the box instead.
      await part(page, 'opencode', 'workspaces').waitFor({ state: 'visible', timeout: 4_000 }).catch(() => {});
      await page.locator('#opencode').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    },
  },
  {
    id: 'go-usage', path: '',
    what: 'OpenCode Go connected for its one workspace: the row carries the live usage windows and the room meter',
    themes: [...themes],
    formFactors: ['narrow', 'phone', 'desktop'],
    interaction: 'go-usage',
    before: { via: 'ref' },
    beforeDrive: true, // the same connect ran on the base page: its row keeps the unknown room this change replaces
    async drive(page) {
      const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
      await page.route('**/fwd/opencode/console/api/orgs', (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify([{ id: 'wrk_01', name: 'Personal' }]) }));
      await page.route('**/fwd/opencode/zen/go/v1/usage', (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ usage: { rolling: { status: 'ok', percent: 20, resetsAt: soon(3_600_000) },
          weekly: { status: 'ok', percent: 58, resetsAt: soon(3 * 86_400_000) },
          monthly: { status: 'ok', percent: 34, resetsAt: soon(28 * 86_400_000) } } }) }));
      await part(page, 'chatgpt', 'status').filter({ hasText: /isn't signed in/ }).waitFor();
      if (!await page.locator('#opencode').count()) return;
      await page.locator('#add-open').click();
      await page.locator('[data-route="opencode:plan_key:opencode-go"]').click();
      await part(page, 'opencode', 'paste').waitFor({ state: 'visible' });
      await part(page, 'opencode', 'pasted').fill('plan-key');
      await part(page, 'opencode', 'connect').click();
      await part(page, 'opencode', 'status').filter({ hasText: /is connected/ }).waitFor();
      // The usage windows are this change's own: the base page keeps its unknown room here.
      await page.locator('#opencode [data-window]').filter({ hasText: 'Session: 80% left' }).waitFor({ timeout: 4_000 }).catch(() => {});
      await page.locator('#opencode').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    },
  },
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
    id: 'signin-connected',
    path: '',
    what: 'Connected card with plan badge and the two quiet bottom actions, kept apart',
    themes: [...themes],
    formFactors: ['phone', 'desktop'],
    interaction: 'signin-connect',
    beforeDrive: true, // the connected state exists only after signing in: drive the before page too, or it shows signed-out
    before: { via: 'ref' },
    async drive(page) {
      await part(page, 'chatgpt', 'signin').click();
      const code = (await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).textContent())!;
      const [provider] = await Promise.all([page.context().waitForEvent('page'), part(page, 'chatgpt', 'open').click()]);
      await provider.fill('#code', code.trim());
      await provider.click('#continue');
      await provider.locator('#words').filter({ hasText: /Signed in/ }).waitFor(); // let the page land: closing mid-navigation wedges close(), which has no timeout
      await provider.close();
      await part(page, 'chatgpt', 'status').filter({ hasText: /is connected/ }).waitFor();
      await part(page, 'chatgpt', 'badge').filter({ hasText: /ChatGPT/ }).waitFor();
    },
  },
  {
    id: 'signin-error',
    path: '',
    what: 'Error banner with a retry as the single primary',
    themes: [...themes],
    formFactors: ['phone', 'desktop'],
    interaction: 'signin-error',
    before: { via: 'ref' },
    async drive(page) {
      await part(page, 'chatgpt', 'signin').click();
      await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).waitFor();
      // The provider refuses the poll outright: a red banner, not an amber one.
      await page.route('**/api/accounts/deviceauth/token', (route) => route.fulfill({ status: 500,
        json: { error: { code: 'deviceauth_invalid' } }, headers: { 'access-control-allow-origin': '*' } }));
      await part(page, 'chatgpt', 'note').filter({ hasText: /didn't finish/i }).waitFor();
    },
  },
  {
    id: 'signin-expired',
    path: '',
    what: 'Expired code banner with a new sign-in as the single primary',
    themes: [...themes],
    formFactors: ['phone', 'desktop'],
    interaction: 'signin-expired',
    before: { via: 'ref' },
    async drive(page) {
      await part(page, 'chatgpt', 'signin').click();
      await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).waitFor();
      // The code is on the card; now the provider says it expired before it was typed there.
      await page.route('**/api/accounts/deviceauth/token', (route) => route.fulfill({ status: 400,
        json: { error: { code: 'deviceauth_expired' } }, headers: { 'access-control-allow-origin': '*' } }));
      await part(page, 'chatgpt', 'note').filter({ hasText: /expired/i }).waitFor();
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
  {
    id: 'ask-select-work',
    path: '',
    what: 'Auto names the roomier account (Work) and answers from that account, not the personal default',
    themes: [...themes],
    formFactors: ['phone', 'desktop'],
    interaction: 'ask-account-select',
    before: { via: 'ref' },
    async drive(page) {
      await withRooms(page, { 'umer-work': { usedPercent: 40 }, 'umer-personal': { usedPercent: 70 } });
      await withAnswers(page);
      await connectChatGPT(page, { accountId: 'umer-work', email: 'umer@work.example', plan: 'team' }, true);
      await connectChatGPT(page, { accountId: 'umer-personal', email: 'umer@example.com', plan: 'plus' }, false);
      await askAuto(page, 'Which account am I?');
      await part(page, 'chatgpt', 'picked').filter({ hasText: /Right now that's ChatGPT: 60% left this week/ }).waitFor();
    },
  },
  {
    id: 'ask-select-personal',
    path: '',
    what: 'After the picked account hits its limit, the next Auto moves to Personal and answers from it',
    themes: [...themes],
    formFactors: ['phone', 'desktop'],
    interaction: 'ask-account-rest',
    before: { via: 'ref' },
    async drive(page) {
      await withRooms(page, { 'umer-work': { usedPercent: 40 }, 'umer-personal': { usedPercent: 70 } });
      await withAnswers(page);
      await connectChatGPT(page, { accountId: 'umer-work', email: 'umer@work.example', plan: 'team' }, true);
      await connectChatGPT(page, { accountId: 'umer-personal', email: 'umer@example.com', plan: 'plus' }, false);
      await askAuto(page, 'Which account am I?');
      openai.state.fail = { status: 429, body: JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'You have hit your usage limit' } }) };
      await askAuto(page, 'Now hit the limit', /usage limit/i);
      await askAuto(page, 'Who answers now?');
      await part(page, 'chatgpt', 'picked').filter({ hasText: /Right now that's ChatGPT: 30% left this week/ }).waitFor();
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
const fontScale = Number(arg('font-scale', '1'));
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
const device = await mockDevice();
const head = await serve(0, openai.base, device.base);
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
          if (fontScale !== 1) await page.addInitScript((scale) => {
            document.addEventListener('DOMContentLoaded', () => { document.body.style.fontSize = `${17 * scale}px`; });
          }, fontScale);
          page.on('pageerror', (e) => errors.push(`${screen.id} ${theme} ${form}: ${e}`));
          return { context, page };
        };

        // Frames: the before state, then the same screen with the interaction done.
        if (beforeHref) {
          const frames = await open();
          await frames.page.goto(beforeHref, { waitUntil: 'load' });
          if (screen.beforeDrive) await screen.drive(frames.page); // one state on both sides, not initial paint vs driven
          else if (screen.path === '') {
            await part(frames.page, 'chatgpt', 'signin').waitFor();
            if (screen.id.startsWith('grok-')) await frames.page.locator('#grok').scrollIntoViewIfNeeded();
          } else {
            // The only non-app screen is usage.html; its own rendered plan view is the readiness, never a fixed delay.
            await frames.page.locator('#view h2').waitFor();
          }
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
  await device.close();
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) console.error(`page errors:\n${errors.join('\n')}`);
const manifest = { base, head: 'worktree', out, fontScale, screens: screens.map((s) => ({ id: s.id, what: s.what, interaction: s.interaction, themes: s.themes, formFactors: s.formFactors })), files: written, skips, pageErrors: errors };
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nEvidence: ${out}/manifest.json (${written.length} files, ${skips.length} skips, ${errors.length} page errors)`);
if (errors.length) process.exitCode = 1;