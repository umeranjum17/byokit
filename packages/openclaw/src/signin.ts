// Sign-in: the kit drives OpenClaw's own setup wizard loop and holds the ChatGPT callback port during a browser
// sign-in; OAuth credentials stay in the engine/CLI. Explicit API keys go only to engine activation (D11).
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { authStatus } from './auth-status.ts';
import { signedInProviders } from './runs.ts';
import { words } from './words.ts';
import type { GatewayTransport, Member, SignInOptions, SignInView } from './types.ts';

export type SignInCtx = {
  request: GatewayTransport['request'];
  ensure(member: Member): Promise<{ agentId: string }>;
  callbackPort: number;
  onDisconnect?(fn: () => void): () => void;
};

// The pin's wizard contract (2026.8.1): steps arrive only from `wizard.next` (wizard.status answers {status, error}
// and never carries a step), and one session at a time holds the gateway's single setup admission.
const BUSY = /setup is already in progress|SETUP_ADMISSION_BUSY/i;
const START_MS = 60_000;
const PULL_MS = 120_000;
const STATUS_MS = 20_000;
const CANCEL_MS = 10_000;
const RECONFIRM_MS = 60_000;
const TURNS = 200;
const PASTE_MS = 15 * 60_000;

type DeviceCode = { code?: string; expires_in?: number | string; expiresInMinutes?: number; message?: string };
type Step = { id?: string; type?: string; sensitive?: boolean; message?: string; deviceCode?: DeviceCode; externalUrl?: string };

// Two of the pin's code routes print their code only into a note's text ("Code: X" with
// "Code expires in N minutes", or "enter the code X." with "Expires at: <ISO>"), never as `deviceCode`.
// Read it back so every code route reaches the caller in the one structured shape.
const noteCode = (step: Step): DeviceCode | undefined => {
  const text = step.type === 'note' ? step.message ?? '' : '';
  const code = /^Code: (\S+)$/m.exec(text)?.[1] ?? /enter the code (\S+?)\.?$/m.exec(text)?.[1];
  if (!code) return undefined;
  const minutes = /Code expires in (\d+) minutes/.exec(text)?.[1];
  const at = Date.parse(/Expires at: (\S+)/.exec(text)?.[1] ?? '');
  return { code, message: text, ...(minutes ? { expiresInMinutes: Number(minutes) }
    : Number.isFinite(at) ? { expires_in: Math.max(0, Math.floor((at - Date.now()) / 1_000)) } : {}) };
};
type Pull = { done?: boolean; status?: string; error?: string; step?: Step };

const cut = (value: unknown): string => (value instanceof Error ? value.message : String(value)).slice(0, 200);
const pullOptions = (signal: AbortSignal) => ({ timeoutMs: PULL_MS, signal });

/**
 * Drive the engine's provider-owned login. `on` sees every view the person watches; `done` resolves once, and
 * `paste` hands a returned browser address or sign-in token to a waiting wizard text step. Every exit short of done cancels this
 * session and its callback listener only.
 */
export function signIn(
  ctx: SignInCtx,
  member: Member,
  o: SignInOptions,
  on: (v: SignInView) => void,
): { paste(text: string): void; cancel(): void; done: Promise<SignInView> } {
  const via = o.via ?? 'browser';
  const owner = new AbortController();
  const { signal } = owner;
  const driveOwner = new AbortController();
  const wantsCallback = via === 'browser' && o.authChoice === 'openai';
  let server: Server | undefined;
  let sessionId = '';
  let starting: Promise<unknown> | undefined;
  let releasing: Promise<void> | undefined;
  let settleStart!: () => void;
  const startingSettled = new Promise<void>((resolve) => { settleStart = resolve; });
  let over = false;
  let recovering = false;
  let offDisconnect: (() => void) | undefined;
  let agentId: string | undefined;
  let before: Set<string> | undefined;
  // Only ChatGPT's OAuth routes are qualified for auth-reload recovery. No API-key fallback.
  const reconfirm = o.authChoice === 'openai' || o.authChoice === 'openai-device-code';
  // Pin models-auth-status: profiles carry {profileId, type, status, expiry: {at, remainingMs, label}}.
  // Older summaries are not credential proof; a refreshed pre-existing id cannot stand in for this login.
  const profiles = (status: unknown, usable = true): Set<string> | undefined => {
    const auth = status as { unavailable?: unknown; providers?: { provider?: string; profiles?: {
      profileId?: string; type?: string; status?: string; expiry?: { at?: number };
    }[] }[] };
    if (auth?.unavailable || !Array.isArray(auth?.providers) || auth.providers.some((row) =>
      !row || typeof row !== 'object' || typeof row.provider !== 'string' || !Array.isArray(row.profiles)
      || row.profiles.some((p) => !p || typeof p.profileId !== 'string' || typeof p.type !== 'string'))) return undefined;
    return new Set(auth.providers.filter((row) => row.provider === 'openai').flatMap((row) =>
      (row.profiles ?? []).filter((p) => p.type === 'oauth' && typeof p.profileId === 'string'
        && (!usable || ((p.status === 'ok' || p.status === 'expiring') && Number.isFinite(p.expiry?.at)
          && p.expiry!.at! > Date.now())))
        .map((p) => p.profileId!)));
  };
  let approval = false;
  let sawDeviceCode = false;
  let codeExpired = false;
  let codeTimer: NodeJS.Timeout | undefined;
  const stopApproval = (): void => {
    approval = false;
    if (codeTimer) clearTimeout(codeTimer);
    codeTimer = undefined;
  };
  const cancelled = (): SignInView => ({ state: 'failed', via, why: 'declined', error: words('signin.cancelled') });
  const expired = (): SignInView => ({ state: 'failed', via, why: 'expired', error: words('signin.expired') });
  let settle!: (view: SignInView) => void;
  let pasteIn: ((text: string) => void) | undefined;
  let returned: string | undefined;
  // Once a secret step is seen, no later gateway prose, link or code is safe to display.
  let sensitive = o.authChoice === 'setup-token' || o.authChoice === 'apiKey';
  const secretFailure = () => o.authChoice === 'apiKey' ? 'API key activation failed' : 'Sign-in failed. Try again.';

  const done = new Promise<SignInView>((resolve) => { settle = resolve; });
  const say = (v: Omit<SignInView, 'state' | 'via'>): void => {
    if (!over && !recovering && !signal.aborted) on({ state: 'waiting', via, ...(sensitive
      ? { ...(v.prompt ? { prompt: v.prompt } : {}), ...(v.error ? { error: secretFailure() } : {}) }
      : v) });
  };
  const closeCallback = async (): Promise<void> => {
    const held = server;
    server = undefined;
    if (held) await new Promise<void>((closed) => held.close(() => closed()));
  };
  const finish = async (view: SignInView): Promise<void> => {
    if (over) return;
    over = true;
    stopApproval();
    offDisconnect?.();
    o.signal?.removeEventListener('abort', cancel);
    owner.abort();
    returned = undefined;
    pasteIn = undefined;
    await closeCallback();
    if (sensitive && view.state === 'failed' && view.why === 'failed') view = { ...view, error: secretFailure() };
    on(view);
    settle(view);
  };
  const release = (): Promise<void> => {
    releasing ??= (async () => {
      // A cancel never goes out early: the pinned engine holds one setup admission per gateway and registers the
      // session only as `openclaw.setup.auth.start` settles, so a cancel sent sooner is answered `wizard not found`
      // and leaves the person locked out of signing in. Waiting for that settlement is what frees the admission.
      await startingSettled;
      if (sessionId) await Promise.resolve().then(() => ctx.request('wizard.cancel', { sessionId },
        { timeoutMs: CANCEL_MS })).catch(() => {});
    })();
    return releasing;
  };
  const paste = (text: string): void => {
    if (over) return;
    if (pasteIn) pasteIn(text);
    else returned = text; // the browser came back before the wizard asked; held for the text step
  };
  const cancel = (): void => {
    // Stop the drive now; the start itself is never aborted, and release waits for it to settle before cancelling,
    // so the gateway's one setup admission is freed by a cancel that the engine can actually find.
    if (signal.aborted) return;
    owner.abort();
    void (async () => { await release(); await finish(cancelled()); })();
  };

  o.signal?.addEventListener('abort', cancel, { once: true });
  if (o.signal?.aborted) cancel();

  /** Hold 127.0.0.1:<callbackPort> for the sign-in's life; a taken port is why the sign-in cannot start. */
  const holdCallback = (): Promise<Server> => {
    let took = false;
    const held = createServer((req, res) => {
      const host = req.headers.host ?? `localhost:${ctx.callbackPort}`;
      const address = `http://${host}${req.url ?? ''}`;
      let url: URL;
      try { url = new URL(address); } catch { url = new URL(`http://${host}/`); }
      // Only the provider's own callback is pasted: a favicon or any other local page is not a redirect back.
      if (took || req.method !== 'GET' || url.pathname !== '/auth/callback' || !url.searchParams.has('code')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Not found');
        return;
      }
      took = true;
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
    const signal = AbortSignal.any([owner.signal, driveOwner.signal]);
    if (wantsCallback) {
      server = await holdCallback().catch(() => undefined);
      if (!server) return { state: 'failed', via, why: 'busy' };
    }
    ({ agentId } = await ctx.ensure(member));
    if (reconfirm && ctx.onDisconnect) {
      before = profiles(await authStatus(ctx.request, agentId).catch(() => undefined), false);
      if (signal.aborted) return cancelled();
    }
    // Native login is completed by the person in unmodified Claude Code. The pin does not expose this
    // choice via auth.start; activation verifies the CLI route and persists it only after a live test succeeds.
    if (o.authChoice === 'anthropic-cli' || o.authChoice === 'apiKey') {
      settleStart();
      let apiKey: string | undefined;
      if (o.authChoice === 'anthropic-cli') {
        const detected = await ctx.request('openclaw.setup.detect', { agentId }, { timeoutMs: STATUS_MS }) as {
          candidates?: { kind?: string; credentials?: boolean }[];
        };
        if (!detected.candidates?.some((candidate) => candidate.kind === 'claude-cli' && candidate.credentials === true))
          return { state: 'failed', via, why: 'failed', error: 'Sign in with Claude Code on this machine in the kit’s isolated HOME, then try again. The login stays in Claude Code.' };
      } else {
        say({ prompt: 'API key (billed per use)' });
        apiKey = returned ?? await new Promise<string | undefined>((resolve) => {
          const stop = (value?: string) => { clearTimeout(timer); signal.removeEventListener('abort', abort); pasteIn = undefined; resolve(value); };
          const abort = () => stop();
          const timer = setTimeout(abort, PASTE_MS);
          pasteIn = stop;
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        returned = undefined;
        if (!apiKey) return { state: 'failed', via, why: signal.aborted ? 'declined' : 'expired' };
      }
      if (signal.aborted) return { state: 'failed', via, why: 'declined' };
      const result = await ctx.request('openclaw.setup.activate', {
        agentId, kind: apiKey === undefined ? 'claude-cli' : 'api-key',
        ...(apiKey === undefined ? {} : { authChoice: 'apiKey', apiKey }),
      }, { timeoutMs: PULL_MS, signal }) as { ok?: boolean; error?: string };
      // API secrets must never be echoed in a view, even if the gateway returns an error containing one.
      return result.ok ? { state: 'done', via } : { state: 'failed', via, why: 'failed',
        error: apiKey === undefined ? cut(result.error ?? 'Claude Code activation failed') : 'API key activation failed' };
    }
    // The client chooses the wizard id; cancellation waits for the engine to register it.
    sessionId = `byokit-${randomUUID()}`;
    let started: { done?: boolean };
    try {
      starting = ctx.request('openclaw.setup.auth.start',
        { sessionId, agentId, authChoice: o.authChoice }, { timeoutMs: START_MS });
      started = await starting as { done?: boolean };
    } finally {
      settleStart();
    }
    if (started.done) return { state: 'done', via };

    // wizard.next, never wizard.status: the status method answers {status, error} and carries no step.
    const options = () => approval ? { timeoutMs: null, signal } : pullOptions(signal);
    const pull = (): Promise<Pull> => ctx.request('wizard.next', { sessionId }, options()) as Promise<Pull>;
    const answer = (step: Step, value?: string): Promise<Pull> => ctx.request('wizard.next',
      { sessionId, answer: { stepId: step.id, ...(value === undefined ? {} : { value }) } }, options()) as Promise<Pull>;
    const waitForPaste = (): Promise<string | undefined> => new Promise((resolve) => {
      if (signal.aborted) { resolve(undefined); return; }
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
      if (current.type === 'text' && current.sensitive) sensitive = true;
      const deviceCode = current.type === 'text' ? undefined : current.deviceCode ?? noteCode(current);
      if (deviceCode) {
        stopApproval();
        approval = true;
        sawDeviceCode = true;
        // The pin converts its provider duration to minutes. Prefer exact seconds if the engine supplies them.
        const duration = deviceCode.expires_in !== undefined
          ? Number(deviceCode.expires_in) * 1_000
          : Number(deviceCode.expiresInMinutes) * 60_000;
        const timed = Number.isFinite(duration) && duration >= 0;
        if (timed) codeTimer = setTimeout(() => { codeExpired = true; owner.abort(); }, duration);
        const message = deviceCode.message ?? current.message;
        // The code is on the card; acknowledging it lets the engine poll the provider itself.
        say({ ...(deviceCode.code ? { code: deviceCode.code } : {}), ...(current.externalUrl ? { url: current.externalUrl } : {}),
          ...(timed ? { expiresAt: Date.now() + duration } : {}), ...(message ? { message } : {}) });
        const next = await answer(current);
        if (next.done) { terminal = next; break; }
        step = next.step;
        continue;
      }
      if (current.type !== 'progress') stopApproval();
      if (current.type === 'text') {
        if (current.sensitive) say({ prompt: 'Sign-in token' });
        const value = await waitForPaste();
        if (value === undefined) return signal.aborted ? cancelled() : expired();
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
    if (signal.aborted) return codeExpired ? expired() : cancelled();
    if (!terminal) return { state: 'failed', via, why: 'expired' };
    const error = String(terminal.error ?? (terminal.status === 'error' ? 'Sign-in failed' : ''));
    if (sawDeviceCode && /expired_token|code.*expired|device.*(?:expired|timed out)/i.test(error)) return expired();
    return error ? { state: 'failed', via, why: 'failed', error: cut(error) } : { state: 'done', via };
  };

  const disconnected = new Promise<undefined>((resolve) => {
    if (reconfirm) offDisconnect = ctx.onDisconnect?.(() => {
      recovering = true;
      resolve(undefined); // win the race before the old request's abort/close rejection propagates
      driveOwner.abort();
    });
  });
  const recover = async (): Promise<SignInView> => {
    const failed: SignInView = { state: 'failed', via, why: 'failed', error: 'Sign-in could not be confirmed after the gateway restarted. Try again.' };
    if (!agentId || !before) return failed;
    const recovery = new AbortController();
    const recoverySignal = AbortSignal.any([signal, recovery.signal]);
    let timer: NodeJS.Timeout | undefined;
    let abort!: () => void;
    const end = new Promise<SignInView>((resolve) => {
      abort = () => resolve(codeExpired ? expired() : cancelled());
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => resolve(failed), RECONFIRM_MS);
      if (signal.aborted) abort();
    });
    const readback = async (): Promise<SignInView> => {
      while (!recoverySignal.aborted && !over) {
        const status = await Promise.resolve().then(() => ctx.request('models.authStatus', { agentId, refresh: true },
          { timeoutMs: STATUS_MS, signal: recoverySignal })).catch(() => undefined);
        const after = profiles(status);
        if (!recoverySignal.aborted && after && [...after].some((p) => !before!.has(p))) return { state: 'done', via };
        await new Promise<void>((resolve) => {
          const stop = () => { clearTimeout(wait); recoverySignal.removeEventListener('abort', stop); resolve(); };
          const wait = setTimeout(stop, 1_000);
          recoverySignal.addEventListener('abort', stop, { once: true });
          if (recoverySignal.aborted) stop();
        });
      }
      return codeExpired ? expired() : cancelled();
    };
    try { return await Promise.race([readback(), end]); }
    finally { recovery.abort(); clearTimeout(timer); signal.removeEventListener('abort', abort); }
  };

  void (async () => {
    let view: SignInView;
    try {
      const driven = await Promise.race([drive(), disconnected]);
      view = driven ?? await recover();
      if (signal.aborted) view = codeExpired ? expired() : cancelled();
    }
    catch (error) {
      if (signal.aborted) view = codeExpired ? expired() : cancelled();
      else if (sawDeviceCode && /expired_token|code.*expired|device.*(?:expired|timed out)/i.test(cut(error))) view = expired();
      else if (BUSY.test(cut(error))) view = { state: 'failed', via, why: 'busy' };
      else view = { state: 'failed', via, why: 'failed', error: o.authChoice === 'apiKey' ? 'API key activation failed' : cut(error) };
    }
    settleStart();
    if (view.state !== 'done') await release();
    await finish(view);
  })();

  return { paste, cancel, done };
}

/** Usable provider profiles plus native Claude Code readiness reported by the engine. */
export async function providers(ctx: SignInCtx, member: Member, refresh?: boolean): Promise<string[]> {
  const { agentId } = await ctx.ensure(member);
  return signedInProviders(await authStatus(ctx.request, agentId, refresh, true)) ?? [];
}

export async function signOut(ctx: SignInCtx, member: Member, provider: string): Promise<void> {
  const { agentId } = await ctx.ensure(member);
  await ctx.request('models.authLogout', { provider, agentId }, { timeoutMs: STATUS_MS });
}
