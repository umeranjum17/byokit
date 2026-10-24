// The done-done-verify-byokit review-evidence capture: drives the real example apps (examples/pwa) in a real browser and writes
// every screen the change touches, in every theme and form factor the app has, before and after, plus one motion
// recording per changed interaction. The skill owns this file: a reviewer runs it, never hand-captures around it.
//
//   node .agents/skills/done-done-verify-byokit/capture/review-evidence.ts [--base <ref>] [--slug <name>] [--out <dir>] [--screens a,b]
//       [--font-scale <n>]
//
// `--base` (default origin/main) is the "before" the change is measured against; each screen says how its before frame is
// reached: at that ref (`via: 'ref'`), or through the before route the screen itself ships (`via: 'url'`). A screen that
// does not exist at the base ref, a theme or form factor the app does not have, is recorded as a skip with its reason.
// `--font-scale` (default 1) sets the page's body text to `17 × n` px, for a larger-text capture in its own output dir.
// Output is one stable, predictable folder (default `.verify-artifacts/review/<slug>`), gitignored, never committed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
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

/** ChatGPT's model list goes through the page's own `/fwd/chatgpt/` proxy; answer it from the stand-in's list. */
async function withModels(page: Page) {
  await page.route('**/fwd/chatgpt/backend-api/codex/models', async (route) => {
    const h = route.request().headers();
    const up = await fetch(`${openai.base}/codex/models`, { headers: { authorization: h['authorization'] ?? '', 'chatgpt-account-id': h['chatgpt-account-id'] ?? '' } });
    return route.fulfill({ status: up.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await up.text() });
  });
}

/** Codex signed in from its own row: the ChatGPT card's code typed on the stand-in's page, then back on the agents. */
async function codexInUse(page: Page) {
  Object.assign(openai.state, { accountId: 'umer-personal', email: 'umer@example.com', plan: 'plus' });
  await withModels(page);
  await page.locator('[data-agent="codex"] > summary').click();
  await page.locator('[data-agent="codex"] [data-signin]').click();
  const codeAt = part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ });
  await codeAt.waitFor();
  const code = (await codeAt.textContent())!;
  const [provider] = await Promise.all([page.context().waitForEvent('page'), part(page, 'chatgpt', 'open').click()]);
  await provider.fill('#code', code.trim());
  await provider.click('#continue');
  await provider.locator('#words').filter({ hasText: /Signed in/ }).waitFor();
  await provider.close();
  await page.locator('[data-agent="codex"] [data-account][data-in-use]').waitFor();
}
/** Back to the agents list, its heading at the top, so the frame shows what a person scrolls back to. */
const toAgents = (page: Page) => page.evaluate(() => window.scrollTo(0, document.getElementById('agents-title')!.offsetTop - 16));

const SCREENS: Screen[] = [
  {
    id: 'home-footer', path: '',
    what: 'The foot of the home page: the @byokit/accounts version this build runs (dev build when changes are unreleased)',
    themes: [...themes], formFactors: ['phone', 'desktop'], interaction: 'home-scroll-to-foot',
    before: { via: 'ref' }, beforeDrive: true, // the base home, scrolled to its foot, which had no version
    async drive(page) {
      await part(page, 'chatgpt', 'signin').waitFor();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    },
  },
  {
    id: 'agents-list', path: '',
    what: 'Agents: each agent with its plan sign-ins counted as "N of M enabled", before anything is connected',
    themes: [...themes], formFactors: ['phone', 'desktop'], interaction: 'agents-open',
    before: { via: 'ref' }, // the base home: provider cards only, no agents
    async drive(page) {
      await page.locator('[data-agent="codex"] [data-count]').filter({ hasText: '0 of 1 enabled' }).waitFor();
    },
  },
  {
    id: 'agents-codex', path: '',
    what: 'Codex signed in from its own row: the account in use (one at a time), its default model, pay-per-use listed apart',
    themes: [...themes], formFactors: ['phone', 'desktop'], interaction: 'agents-codex-signin',
    before: { via: 'ref' }, // the base home has no agent rows to drive
    async drive(page) {
      await codexInUse(page);
      await page.locator('[data-agent="codex"] [data-model]').selectOption('gpt-6-sol');
      await page.locator('[data-agent="codex"] [data-model-words]').filter({ hasText: 'New runs use GPT-6 Sol.' }).waitFor();
      await page.locator('[data-agent="codex"] .per-use > summary').click();
      await page.reload(); // the choice is the kit's, kept per agent kind: it survives a reload
      await page.locator('[data-agent="codex"] > summary').click();
      await page.locator('[data-agent="codex"] [data-model]').and(page.locator(':enabled')).waitFor();
      await page.locator('[data-agent="codex"] [data-model-words]').filter({ hasText: 'New runs use GPT-6 Sol.' }).waitFor();
      await page.locator('[data-agent="codex"] .per-use > summary').click();
      await toAgents(page);
    },
  },
  {
    id: 'agents-pi', path: '',
    what: 'Pi on the same ChatGPT account: signed in but not yet chosen, the other plans to sign in, nothing picked for the person',
    themes: [...themes], formFactors: ['phone', 'desktop'], interaction: 'agents-pi-use',
    before: { via: 'ref' },
    async drive(page) {
      await codexInUse(page);
      await page.locator('[data-agent="codex"] > summary').click(); // closed again
      await page.locator('[data-agent="pi"] > summary').click();
      await page.locator('[data-agent="pi"] [data-note]').filter({ hasText: 'Pick the account Pi uses.' }).waitFor();
      await toAgents(page);
    },
  },
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

// ---- The headless views, rendered in a real browser from the built package --------------------------
// A kit that ships view state and no screen of its own (the ui package) still has a look a person can review:
// the capture writes a small page that renders the built package's own output, in a real browser, in every theme
// and form factor. The page is the capture's, not the product's: the words, the rows and the states are the
// package's, and the page only draws them.
type Render = {
  /** File-name slug; the frames are written flat in the output folder, one per theme and form factor. */
  id: string;
  /** In the app's words, so a reviewer knows what the frames show. */
  what: string;
  /** The state the page shows. */
  state: 'list' | 'search' | 'empty' | 'loading' | 'error' | 'waking' | 'answered' | 'asleep';
  themes: Theme[];
  formFactors: FormFactor[];
};

const RENDER_SCREENS: Render[] = [
  { id: 'cloud-list', state: 'list', what: "Your cloud computers: each machine's name, what it is doing, its newest copy, what it costs and the one action it offers",
    themes: [...themes], formFactors: ['phone', 'desktop'] },
  { id: 'cloud-search', state: 'search', what: 'A search narrows the list to the one machine that matches, and the person can pick it',
    themes: [...themes], formFactors: ['phone', 'desktop'] },
  { id: 'cloud-empty', state: 'empty', what: 'No cloud computers yet',
    themes: [...themes], formFactors: ['phone', 'desktop'] },
  { id: 'cloud-loading', state: 'loading', what: 'The list is being read',
    themes: [...themes], formFactors: ['phone', 'desktop'] },
  { id: 'cloud-error', state: 'error', what: "The host could not answer: the plain line, then the host's own words",
    themes: [...themes], formFactors: ['phone', 'desktop'] },
  { id: 'cloud-waking', state: 'waking', what: 'The person asked the host to wake a machine: the row says so until the host answers',
    themes: [...themes], formFactors: ['phone', 'desktop'] },
  { id: 'cloud-answered', state: 'answered', what: 'The host answered: the row says the machine is awake',
    themes: [...themes], formFactors: ['phone', 'desktop'] },
  { id: 'cloud-asleep', state: 'asleep', what: 'An asleep machine offers the one action that helps: wake it',
    themes: [...themes], formFactors: ['phone', 'desktop'] },
];

/** The page the capture serves for a headless view: the built package's output, drawn plainly. */
const RENDER_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your cloud computers</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f6f8; --fg: #15181c; --muted: #59616d; --card: #ffffff; --line: #e2e5ea; --accent: #1c5ad4; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1216; --fg: #eef1f5; --muted: #98a2b0; --card: #181c22; --line: #262c35; --accent: #7fa8ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 40px; }
  h1 { font-size: 22px; margin: 0; }
  .sub { color: var(--muted); margin: 2px 0 18px; }
  .search { width: 100%; padding: 11px 13px; font-size: 16px; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
  .headline { color: var(--muted); margin: 16px 2px 10px; }
  .search { margin-bottom: 20px; }
  .error { color: #a8201a; margin: 4px 2px 0; }
  @media (prefers-color-scheme: dark) { .error { color: #ffb4ab; } }
  .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  .row { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
  .row.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .row h2 { font-size: 17px; margin: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 12px; row-gap: 2px; }
  .account { font-size: 13px; font-weight: 400; color: var(--muted); }
  .state { display: flex; align-items: center; gap: 8px; margin: 6px 0 0; font-weight: 600; }
  .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--dot); }
  .on { --dot: #1a7f37; } .asleep { --dot: #59616d; } .waking { --dot: #9a6700; }
  @media (prefers-color-scheme: dark) { .on { --dot: #56d364; } .asleep { --dot: #98a2b0; } .waking { --dot: #e3b341; } }
  .line { margin: 4px 0 0; color: var(--muted); }
  .ack { color: var(--fg); }
  .action { display: inline-block; margin-top: 12px; padding: 9px 14px; font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 10px; }
  .action[disabled] { color: var(--muted); opacity: .6; }
</style></head>
<body><main id="app"></main><script type="module" src="./view.js"></script></body></html>
`;

/** The page's script: the built package's own view, drawn. */
const RENDER_ENTRY = `
import { cloudView, type CloudState } from '@byokit/ui/kits';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const cost = { perMonth: 5, spent: 0.5, currency: 'USD' };
const desk = { id: 'sb-1', name: 'desk', state: 'on' as const, account: 'Umer', snapshot: { id: 'byokit-desk-today', at: hoursAgo(2) }, cost };
const lab = { id: 'sb-2', name: 'lab', state: 'asleep' as const, account: 'Umer', snapshot: { id: 'byokit-lab-today', at: hoursAgo(5) }, cost };
const ready = { phase: 'ready' as const, actions: ['wake', 'sleep'], search: '' };
const states: Record<string, CloudState> = {
  list: { ...ready, machines: [desk, lab] },
  search: { ...ready, machines: [desk, lab], search: 'lab', selected: 'sb-2' },
  empty: { ...ready, machines: [] },
  loading: { phase: 'loading', machines: [], actions: ['wake', 'sleep'], search: '' },
  error: { phase: 'failed', machines: [], actions: [], search: '', error: "Test didn't accept your key. Make a new one and try again." },
  waking: { ...ready, machines: [lab], pending: { id: 'sb-2', action: 'wake' } },
  answered: { ...ready, machines: [{ ...lab, state: 'on' }], ack: { id: 'sb-2', ok: true, words: "It's awake." } },
  asleep: { ...ready, machines: [lab] },
};
const state = states[new URLSearchParams(location.search).get('state') ?? 'list'] ?? states.list;
const view = cloudView(state, { now: Date.now() });
const el = (tag: string, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const app = document.getElementById('app');
app.append(el('h1', undefined, 'Your cloud computers'));
app.append(el('p', 'sub', 'The computers your app rents for you'));
const search = el('input', 'search');
search.setAttribute('type', 'search');
search.setAttribute('placeholder', 'Search your cloud computers');
search.setAttribute('aria-label', 'Search your cloud computers');
search.value = state.search;
app.append(search);
if (view.headline) app.append(el('p', 'headline', view.headline));
if (view.error) app.append(el('p', 'error', view.error));
const rows = el('ul', 'rows');
for (const row of view.rows) {
  const li = el('li', row.selected ? 'row selected' : 'row');
  const h2 = el('h2', 'head');
  h2.append(el('span', undefined, (row.selected ? '✓ ' : '') + row.title));
  if (row.account) h2.append(el('span', 'account', row.account));
  li.append(h2);
  const status = el('p', 'state');
  status.append(el('span', 'dot ' + (!row.pending && (row.state === 'on' || row.state === 'asleep') ? row.state : 'waking')), document.createTextNode(row.stateWords));
  li.append(status);
  if (row.copy) li.append(el('p', 'line', row.copy));
  if (row.cost) li.append(el('p', 'line', row.cost));
  if (row.ack) li.append(el('p', 'line ack', row.ack));
  if (row.actionWords) {
    const button = el('button', 'action', row.actionWords);
    button.setAttribute('type', 'button');
    if (row.pending) button.setAttribute('disabled', '');
    li.append(button);
  }
  rows.append(li);
}
app.append(rows);
`;

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
const wanted = arg('screens', [...SCREENS, ...RENDER_SCREENS].map((s) => s.id).join(','))!.split(',').map((s) => s.trim()).filter(Boolean);
const screens = SCREENS.filter((s) => wanted.includes(s.id));
const renderScreens = RENDER_SCREENS.filter((s) => wanted.includes(s.id));
if (!screens.length && !renderScreens.length) throw new Error(`no screens matched --screens ${wanted.join(',')}`);

mkdirSync(out, { recursive: true });
mkdirSync('.verify-artifacts', { recursive: true });
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

// The headless views: one page the capture writes, serving the built package's own output.
const renderServe = renderScreens.length ? await (async () => {
  const entry = join(scratch, 'view-entry.ts');
  writeFileSync(entry, RENDER_ENTRY);
  // The built package, bundled for the browser as any web build would; the scratch folder is inside the worktree,
  // so the bare `@byokit/*` import resolves to this workspace.
  const bundle = await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent' });
  const js = bundle.outputFiles[0].text;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/' || path === '/index.html') res.writeHead(200, { 'content-type': 'text/html' }).end(RENDER_PAGE);
    else if (path === '/view.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
})() : undefined;

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

  // The headless views: the built package's own output, drawn, in every theme and form factor.
  for (const screen of renderScreens) {
    note(screen.id, 'before frames', 'the view is new in this change: the base ref has no screen of it to compare with');
    note(screen.id, 'motion', 'the change adds no interaction and no motion: the view is state, drawn');
    for (const theme of themes) {
      if (!screen.themes.includes(theme)) {
        note(screen.id, `${theme} theme`, 'the view has no such theme');
        continue;
      }
      for (const form of screen.formFactors) {
        const size = formFactors[form];
        const context = await browser.newContext({ colorScheme: theme, viewport: { width: size.width, height: size.height },
          deviceScaleFactor: size.deviceScaleFactor, serviceWorkers: 'block' });
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(`${screen.id} ${theme} ${form}: ${e}`));
        await page.goto(`${renderServe!.url}?state=${screen.state}`, { waitUntil: 'load' });
        await page.locator('#app h1').waitFor();
        // Two frames: the page has painted before the browser is asked for its picture.
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
        await shot(page, `${screen.id}__${theme}__${form}.png`);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  baseServe?.close();
  renderServe?.close();
  head.close();
  await openai.close();
  await device.close();
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) console.error(`page errors:\n${errors.join('\n')}`);
const manifest = { base, head: 'worktree', out, fontScale, screens: [...screens.map((s) => ({ id: s.id, what: s.what, interaction: s.interaction, themes: s.themes, formFactors: s.formFactors })),
  ...renderScreens.map((s) => ({ id: s.id, what: s.what, interaction: 'none', themes: s.themes, formFactors: s.formFactors }))], files: written, skips, pageErrors: errors };
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nEvidence: ${out}/manifest.json (${written.length} files, ${skips.length} skips, ${errors.length} page errors)`);
if (errors.length) process.exitCode = 1;