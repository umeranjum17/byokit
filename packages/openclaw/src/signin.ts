// Sign-in: the kit drives OpenClaw's own setup wizard loop and holds the ChatGPT callback port during a browser
// sign-in; credentials never pass through kit or app (D11, 5.7).
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { words } from './words.ts';
import type { GatewayTransport, Member, SignInView } from './types.ts';

export type SignInCtx = {
  request: GatewayTransport['request'];
  ensure(member: Member): Promise<{ agentId: string }>;
  callbackPort: number;
};

// The pin's wizard contract (2026.8.1): steps arrive only from `wizard.next` (wizard.status answers {status, error}
// and never carries a step), and one session at a time holds the gateway's single setup admission.
const BUSY = /setup is already in progress|SETUP_ADMISSION_BUSY/i;
const START_MS = 60_000;
const PULL_MS = 120_000;
const STATUS_MS = 20_000;
const CANCEL_MS = 10_000;
const TURNS = 200;
const PASTE_MS = 15 * 60_000;

type Entry = string | { provider?: unknown };
type Step = { id?: string; type?: string; sensitive?: boolean; deviceCode?: { code?: string }; externalUrl?: string };
type Pull = { done?: boolean; status?: string; error?: string; step?: Step };

const cut = (value: unknown): string => (value instanceof Error ? value.message : String(value)).slice(0, 200);
const pullOptions = (signal: AbortSignal) => ({ timeoutMs: PULL_MS, signal });

/**
 * Drive the engine's provider-owned login. `on` sees every view the person watches; `done` resolves once, and
 * `paste` hands a returned browser address to a waiting wizard text step. Every exit short of done cancels this
 * session and its callback listener only.
 */
export function signIn(
  ctx: SignInCtx,
  member: Member,
  o: { authChoice: string; via?: 'browser' | 'code' },
  on: (v: SignInView) => void,
): { paste(text: string): void; cancel(): void; done: Promise<SignInView> } {
  const via = o.via ?? 'browser';
  const owner = new AbortController();
  const { signal } = owner;
  const wantsCallback = via === 'browser' && o.authChoice === 'openai';
  let server: Server | undefined;
  let sessionId = '';
  let released = false;
  let over = false;
  let settle!: (view: SignInView) => void;
  let pasteIn: ((text: string) => void) | undefined;
  let returned: string | undefined;

  const done = new Promise<SignInView>((resolve) => { settle = resolve; });
  const say = (v: Omit<SignInView, 'state' | 'via'>): void => on({ state: 'waiting', via, ...v });
  const closeCallback = async (): Promise<void> => {
    const held = server;
    server = undefined;
    if (held) await new Promise<void>((closed) => held.close(() => closed()));
  };
  const finish = async (view: SignInView): Promise<void> => {
    if (over) return;
    over = true;
    owner.abort();
    await closeCallback();
    on(view);
    settle(view);
  };
  const release = async (): Promise<void> => {
    if (released || !sessionId) return;
    released = true;
    // The person's exit, not the engine's: only this session is cancelled, so the admission frees for a retry.
    await ctx.request('wizard.cancel', { sessionId }, { timeoutMs: CANCEL_MS }).catch(() => {});
  };
  const paste = (text: string): void => {
    if (pasteIn) pasteIn(text);
    else returned = text; // the browser came back before the wizard asked; held for the text step
  };
  const cancel = (): void => {
    void (async () => { await release(); await finish({ state: 'failed', via, why: 'declined' }); })();
  };

  /** Hold 127.0.0.1:<callbackPort> for the sign-in's life; a taken port is why the sign-in cannot start. */
  const holdCallback = (): Promise<Server> => {
    const held = createServer((req, res) => {
      const address = `http://${req.headers.host ?? `localhost:${ctx.callbackPort}`}${req.url ?? ''}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
        `<title>Sign-in</title><body style="font:18px system-ui;margin:3em auto;max-width:26em;padding:0 1em;text-align:center">${words('signin.returned')}</body>`);
      paste(address);
    });
    return new Promise<Server>((open, refuse) => {
      held.once('error', refuse);
      held.listen(ctx.callbackPort, '127.0.0.1', () => { held.off('error', refuse); held.on('error', () => {}); open(held); });
    });
  };

  const drive = async (): Promise<SignInView> => {
    if (wantsCallback) {
      server = await holdCallback().catch(() => undefined);
      if (!server) return { state: 'failed', via, why: 'busy' };
    }
    const { agentId } = await ctx.ensure(member);
    const started = await ctx.request('openclaw.setup.auth.start',
      { sessionId: `byokit-${randomUUID()}`, agentId, authChoice: o.authChoice },
      { timeoutMs: START_MS, signal }) as { sessionId?: string; done?: boolean };
    sessionId = started.sessionId ?? '';
    if (started.done) return { state: 'done', via };

    // wizard.next, never wizard.status: the status method answers {status, error} and carries no step.
    const pull = (): Promise<Pull> => ctx.request('wizard.next', { sessionId }, pullOptions(signal)) as Promise<Pull>;
    const answer = (step: Step, value?: string): Promise<Pull> => ctx.request('wizard.next',
      { sessionId, answer: { stepId: step.id, ...(value === undefined ? {} : { value }) } }, pullOptions(signal)) as Promise<Pull>;
    const waitForPaste = (): Promise<string | undefined> => new Promise((resolve) => {
      if (returned !== undefined) { const text = returned; returned = undefined; resolve(text); return; }
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const stop = (text: string | undefined) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        pasteIn = undefined;
        resolve(text);
      };
      const onAbort = () => stop(undefined);
      timer = setTimeout(() => stop(undefined), PASTE_MS);
      pasteIn = (text) => stop(text);
      signal.addEventListener('abort', onAbort, { once: true });
    });

    let step: Step | undefined;
    let terminal: Pull | undefined;
    for (let turns = 0; turns < TURNS && !signal.aborted; turns++) {
      if (!step) {
        const next = await pull();
        if (next.done) { terminal = next; break; }
        step = next.step;
        continue;
      }
      const current = step;
      step = undefined;
      if (current.deviceCode) {
        // The code is on the card; acknowledging it lets the engine poll the provider itself.
        say({ ...(current.deviceCode.code ? { code: current.deviceCode.code } : {}), ...(current.externalUrl ? { url: current.externalUrl } : {}) });
        const next = await answer(current);
        if (next.done) { terminal = next; break; }
        step = next.step;
        continue;
      }
      if (current.type === 'text' && !current.sensitive) {
        const value = await waitForPaste();
        if (value === undefined) return { state: 'failed', via, why: signal.aborted ? 'declined' : 'expired' };
        const next = await answer(current, value);
        if (next.done) { terminal = next; break; }
        step = next.step;
        if (next.error) say({ error: cut(next.error) });
        continue;
      }
      if (current.type === 'note' || current.type === 'confirm' || current.type === 'select' || current.type === 'action') {
        if (current.externalUrl) say({ url: current.externalUrl });
        const next = await answer(current);
        if (next.done) { terminal = next; break; }
        step = next.step;
        if (next.error) say({ error: cut(next.error) });
        continue;
      }
      // progress and anything gateway-driven: it advances by itself
      const next = await pull();
      if (next.done) { terminal = next; break; }
      step = next.step;
    }
    if (signal.aborted) return { state: 'failed', via, why: 'declined' };
    if (!terminal) return { state: 'failed', via, why: 'expired' };
    const error = String(terminal.error ?? (terminal.status === 'error' ? 'Sign-in failed' : ''));
    return error ? { state: 'failed', via, why: 'failed', error: cut(error) } : { state: 'done', via };
  };

  void (async () => {
    let view: SignInView;
    try { view = await drive(); }
    catch (error) {
      if (signal.aborted) view = { state: 'failed', via, why: 'declined' };
      else if (BUSY.test(cut(error))) view = { state: 'failed', via, why: 'busy' };
      else view = { state: 'failed', via, why: 'failed', error: cut(error) };
    }
    if (view.state !== 'done') await release();
    await finish(view);
  })();

  return { paste, cancel, done };
}

/** The providers this member's engine reports as signed in, from `models.authStatus` (a string or `{ provider }`). */
export async function providers(ctx: SignInCtx, member: Member, refresh?: boolean): Promise<string[]> {
  const { agentId } = await ctx.ensure(member);
  const status = await ctx.request('models.authStatus', { agentId, ...(refresh ? { refresh: true } : {}) }, { timeoutMs: STATUS_MS }) as { providers?: Entry[] };
  const names = (status?.providers ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.provider));
  return [...new Set(names.filter((name): name is string => typeof name === 'string' && name !== ''))];
}

export async function signOut(ctx: SignInCtx, member: Member, provider: string): Promise<void> {
  const { agentId } = await ctx.ensure(member);
  await ctx.request('models.authLogout', { provider, agentId }, { timeoutMs: STATUS_MS });
}
