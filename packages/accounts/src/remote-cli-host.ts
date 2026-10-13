// The computer side of remote agent-CLI sign-in: spawn the agent CLI's own login here, relay only
// the verification URL, the user code and the expiry to the phone, and report success or one plain
// failure. Reuses `cliAccounts()`: the same managed rows, the same status reads, no second account
// system. The credential is written only by the CLI on this computer; this module never reads,
// forwards or logs credentials, codes or CLI output beyond the display payload.
//
// Flows and billing, honestly labelled: Codex exposes its own device-code login (`login
// --device-auth`, a ChatGPT subscription); Claude exposes a link-and-paste-code login
// (`auth login --claudeai`, a Claude subscription: the phone opens the link, the person pastes the
// page's code back). Pi has no headless login, so it reports `unsupported` ("not supported here")
// while its read-only state still works. The `--console` API-billed Claude login is never started.
//
// Compose `remoteCliHost(...).handle` into the pair `Host`'s `handle` (behind `allow`); the phone
// uses `remoteCliDevice(link)` from `./remote-cli.ts`.
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CliAccountError, cliAccounts, signInLock } from './cli.ts';
import {
  REMOTE_CLI_OPS,
  REMOTE_CLI_PROVIDERS,
  REMOTE_CLI_WORDS,
  isRemoteCliProvider,
  type RemoteCliDisplay,
  type RemoteCliFailure,
  type RemoteCliProblem,
  type RemoteCliProvider,
  type RemoteCliReply,
  type RemoteCliResult,
  type RemoteCliStart,
  type RemoteCliState,
} from './remote-cli.ts';

type Kit = ReturnType<typeof cliAccounts>;

export type RemoteCliHostOptions = {
  /** The managed-CLI kit this host signs in with (same `stateDir`, `bins` and `env` as the app). */
  cli: Kit;
  /** The same absolute binaries the app passed to `cliAccounts`: needed to report `installed`. */
  bins: Partial<Record<RemoteCliProvider, string>>;
  /** How long to wait for the CLI to print its code or link. Default 30 s. */
  parseMs?: number;
  /** Upper bound for one sign-in wait. Default 15 min (the Codex code lifetime). */
  waitCapMs?: number;
  /** The clock, for tests. */
  now?: () => number;
};

type Session = {
  id: string;
  provider: RemoteCliProvider;
  child: ChildProcess;
  /** Resolves once the native child has exited (one promise per session, shared by every waiter). */
  exit: Promise<void>;
  /** Resolves with the terminal result once the row is settled and the sign-in lock is released. */
  settled: Promise<RemoteCliResult>;
  /** Set when `settled` has finished: the lock is free and the row is no longer in flight. */
  done?: true;
  completion: string;
  display: RemoteCliDisplay;
  startedAt: number;
  /** CLI output after the display payload: only failure sniffing reads it, never a reply or a log. */
  late: string;
  exited?: number | null;
  result?: RemoteCliResult;
};

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[mGKH]/g, '');
const cleanUrl = (s: string) => s.replace(/['".,;)\\\]]+$/, '');
const DEFAULT_PARSE_MS = 30_000;
const DEFAULT_WAIT_CAP_MS = 15 * 60_000;
const MAX_OUTPUT = 256 * 1024;
const MAX_LATE = 8 * 1024;

/** Read-only signed-in state, one row per CLI. Spawns only each CLI's own status read; it never
 *  starts a login, refreshes, rotates or writes anything. */
export async function remoteCliState(kit: Kit, bins: Partial<Record<RemoteCliProvider, string>>): Promise<RemoteCliState[]> {
  const rows = await kit.list();
  return REMOTE_CLI_PROVIDERS.map((provider) => {
    let installed = false;
    const bin = bins[provider];
    if (typeof bin === 'string' && bin) {
      try { accessSync(bin, constants.X_OK); installed = true; } catch { installed = false; }
    }
    const ready = rows.find((r) => r.provider === provider && r.state === 'ready');
    const state: RemoteCliState = { provider, billing: 'subscription', installed,
      signedIn: installed && ready !== undefined, supported: provider !== 'pi' };
    const label = ready?.email || (ready?.name.trim() ? ready.name : undefined);
    if (label && label.length <= 320) state.label = label;
    if (ready?.plan) state.plan = ready.plan;
    return state;
  });
}

function parseDisplay(provider: RemoteCliProvider, output: string): Omit<RemoteCliDisplay, 'id' | 'provider'> | undefined {
  const plain = stripAnsi(output);
  if (provider === 'codex') {
    const url = cleanUrl(plain.match(/https:\/\/\S+/)?.[0] ?? '');
    const code = plain.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/)?.[0];
    const expiry = plain.match(/expires in (\d+)\s*(seconds?|minutes?)/i);
    if (!url.startsWith('https://') || !code) return undefined;
    const seconds = expiry ? Number(expiry[1]) * (expiry[2].toLowerCase().startsWith('minute') ? 60 : 1) : 15 * 60;
    const display: Omit<RemoteCliDisplay, 'id' | 'provider'> = { verificationUri: url, userCode: code };
    if (Number.isSafeInteger(seconds) && seconds > 0) display.expiresInSeconds = Math.min(seconds, 24 * 3600);
    return display;
  }
  if (provider === 'claude') {
    const url = cleanUrl(plain.match(/visit:\s*(https:\/\/\S+)/i)?.[1] ?? '');
    if (!url.startsWith('https://')) return undefined;
    return { verificationUri: url };
  }
  return undefined;
}

const fail = (provider: RemoteCliProvider, error: RemoteCliFailure['error']): RemoteCliFailure => {
  const words = (() => {
    switch (error) {
      case 'unsupported': return REMOTE_CLI_WORDS.unsupported(provider);
      case 'missing': return REMOTE_CLI_WORDS.missing(provider);
      case 'busy': return REMOTE_CLI_WORDS.busy(provider);
      case 'already': return REMOTE_CLI_WORDS.already(provider);
      case 'expired': return REMOTE_CLI_WORDS.expired();
      case 'denied': return REMOTE_CLI_WORDS.denied(provider);
      case 'failed': return REMOTE_CLI_WORDS.failed(provider);
      case 'cancelled': return REMOTE_CLI_WORDS.cancelled();
      case 'unknown': return REMOTE_CLI_WORDS.unknown();
    }
  })();
  return { ok: false, error, words };
};

function holderAlive(holder: string): boolean {
  let pid: number;
  try { pid = Number(readFileSync(holder, 'utf8')); } catch { return true; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function claimSignIn(folder: string): (() => void) | undefined {
  const { lock, holder } = signInLock(folder);
  const take = () => { try { mkdirSync(lock, { mode: 0o700 }); return true; } catch { return false; } };
  if (!take()) {
    if (holderAlive(holder)) return undefined;
    rmSync(holder, { force: true });
    try { rmdirSync(lock); } catch { return undefined; }
    if (!take()) return undefined;
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    rmSync(holder, { force: true });
    try { rmdirSync(lock); } catch {}
  };
}

export function remoteCliHost(options: RemoteCliHostOptions): {
  state(): Promise<RemoteCliState[]>;
  close(): Promise<void>;
  start(provider: RemoteCliProvider, opts?: { signal?: AbortSignal }): Promise<RemoteCliStart>;
  wait(id: string, opts?: { timeoutMs?: number }): Promise<RemoteCliResult>;
  paste(id: string, pasteText: string): Promise<void>;
  cancel(id: string): Promise<void>;
  handle(req: { op: string; args?: unknown }): Promise<RemoteCliReply>;
} {
  if (!record(options) || !options.cli || !record(options.bins)) throw new CliAccountError('bad-option');
  const { cli, bins } = options;
  const now = options.now ?? Date.now;
  const parseMs = options.parseMs ?? DEFAULT_PARSE_MS;
  const waitCapMs = options.waitCapMs ?? DEFAULT_WAIT_CAP_MS;
  if (!(parseMs > 0 && parseMs <= 2 ** 31 - 1) || !(waitCapMs > 0 && waitCapMs <= 2 ** 31 - 1)) throw new CliAccountError('bad-option');
  const sessions = new Map<string, Session>();
  const starting = new Set<RemoteCliProvider>();
  const pendingStarts = new Set<Promise<RemoteCliStart>>();
  const lifetime = new AbortController();

  const sweep = () => {
    if (sessions.size < 50) return;
    for (const [id, s] of sessions) {
      if (s.result && now() - s.startedAt > 3600_000) sessions.delete(id);
      if (sessions.size < 50) return;
    }
  };
  const kill = (s: Session) => {
    try {
      if (s.exited === undefined && s.child.exitCode === null) {
        s.child.kill('SIGTERM');
        setTimeout(() => { try { if (s.child.exitCode === null) s.child.kill('SIGKILL'); } catch {} }, 1000).unref?.();
      }
    } catch {}
  };
  const stop = (s: Session, failure: RemoteCliFailure): Promise<RemoteCliResult> => {
    s.result ??= failure;
    kill(s);
    return s.settled;
  };

  async function state(): Promise<RemoteCliState[]> {
    return remoteCliState(cli, bins);
  }

  async function start(provider: RemoteCliProvider, opts?: { signal?: AbortSignal }): Promise<RemoteCliStart> {
    if (starting.has(provider)) return fail(provider, 'busy');
    starting.add(provider);
    const task = startLogin(provider, opts?.signal ? AbortSignal.any([lifetime.signal, opts.signal]) : lifetime.signal);
    pendingStarts.add(task);
    try { return await task; }
    finally { starting.delete(provider); pendingStarts.delete(task); }
  }

  async function startLogin(provider: RemoteCliProvider, signal?: AbortSignal): Promise<RemoteCliStart> {
    if (!isRemoteCliProvider(provider)) throw new Error('accounts.cli.signin.start needs { provider: claude|codex|pi }');
    if (provider === 'pi') return fail(provider, 'unsupported');
    if (signal?.aborted) return fail(provider, 'cancelled');
    sweep();
    for (const s of sessions.values()) {
      if (s.provider === provider && !s.done) return fail(provider, 'busy');
    }
    const rows = await cli.list();
    if (rows.some((r) => r.provider === provider && r.state === 'ready')) return fail(provider, 'already');
    let id: string;
    let signIn: { argv: string[]; env: Record<string, string>; completion: string };
    let unlock: (() => void) | undefined;
    try {
      const reuse = rows.find((r) => r.provider === provider && (r.state === 'signed_out' || r.state === 'signing'));
      if (reuse) {
        unlock = claimSignIn(cli.folderOf(reuse.id));
        if (!unlock) return fail(provider, 'busy');
        id = reuse.id;
        signIn = cli.signInAgain(id);
      } else {
        const added = provider === 'claude' ? await cli.add('claude') : await cli.add('codex');
        id = added.account.id;
        signIn = added.signIn;
        unlock = claimSignIn(dirname(signIn.completion));
        if (!unlock) { await cli.cancel(id); return fail(provider, 'busy'); }
      }
    } catch (e) {
      unlock?.();
      if (e instanceof CliAccountError && e.code === 'bad-option') return fail(provider, 'missing');
      if (e instanceof CliAccountError && e.code === 'prepare-failed') return fail(provider, 'busy');
      throw e;
    }
    if (signal?.aborted) { unlock?.(); await cli.cancel(id); return fail(provider, 'cancelled'); }
    const child = spawn(signIn.argv[0], signIn.argv.slice(1), { env: signIn.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const holder = signInLock(dirname(signIn.completion)).holder;
    // Supervision is attached before the holder is recorded. Once the child exits its holder is
    // removed, so a settling lock reads busy; the lock is released only after `settle` has run.
    const exit = new Promise<void>((resolve) => {
      child.once('exit', (code) => { session.exited = code; rmSync(holder, { force: true }); resolve(); });
      child.once('error', () => { session.exited ??= null; rmSync(holder, { force: true }); resolve(); });
    });
    const settled = exit.then(() => settle(session)).finally(() => { session.done = true; unlock?.(); });
    const session: Session = { id, provider, child, exit, settled, completion: signIn.completion,
      display: { id, provider, verificationUri: '' }, startedAt: now(), late: '' };
    try {
      if (child.pid) writeFileSync(holder, String(child.pid));
    } catch {
      await stop(session, fail(provider, 'failed'));
      return fail(provider, 'failed');
    }
    const abort = () => { void stop(session, fail(provider, 'cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
    let output = '';
    let found: Omit<RemoteCliDisplay, 'id' | 'provider'> | undefined;
    let shown = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const append = (chunk: string) => {
      if (output.length < MAX_OUTPUT) output += chunk.slice(0, MAX_OUTPUT - output.length);
      if (shown && session.late.length < MAX_LATE) session.late += chunk.slice(0, MAX_LATE - session.late.length);
      if (!found) found = parseDisplay(provider, output);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const deadline = now() + parseMs;
    for (;;) {
      if (found || signal?.aborted) break;
      if (session.exited !== undefined) break;
      if (now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    signal?.removeEventListener('abort', abort);
    if (!found || signal?.aborted) {
      const failure = fail(provider, signal?.aborted ? 'cancelled' : 'failed');
      await stop(session, failure);
      return failure;
    }
    shown = true;
    session.display = { id, provider, ...found };
    sessions.set(id, session);
    return { ok: true, signIn: session.display };
  }

  // Runs once the child has exited, with or without a phone waiter. A stop (cancel, expiry, failed
  // start) sets its result before the kill, so it never writes the completion marker.
  async function settle(session: Session): Promise<RemoteCliResult> {
    // The kit reads a managed row as ready only after the CLI's own login completed AND the
    // completion marker exists, so claim it first and let `status` (the CLI's own status read)
    // verify: a login that did not really sign in keeps nothing.
    if (!session.result && session.exited === 0) {
      try {
        writeFileSync(session.completion, 'complete', { mode: 0o600, flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') session.result = fail(session.provider, 'failed');
      }
      if (!session.result) {
        const account = await cli.status(session.id).catch(() => undefined);
        if (account?.state === 'ready') session.result ??= { ok: true, provider: session.provider };
        else rmSync(session.completion, { force: true });
      }
    }
    if (!session.result) {
      const late = session.late;
      if (/denied|cancelled by|declined|not approved|access_denied/i.test(late)) session.result = fail(session.provider, 'denied');
      else if (/expir|timed out/i.test(late)) session.result = fail(session.provider, 'expired');
      else session.result = fail(session.provider, 'failed');
    }
    if (!session.result.ok) await cli.cancel(session.id).catch(() => {});
    return session.result;
  }

  async function wait(id: string, opts?: { timeoutMs?: number }): Promise<RemoteCliResult> {
    if (typeof id !== 'string' || !id || id.length > 128) throw new Error('accounts.cli.signin.wait needs { id }');
    const timeoutMs = opts?.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1)) {
      throw new Error('accounts.cli.signin.wait needs a positive timeoutMs');
    }
    const session = sessions.get(id);
    if (!session) return fail('codex', 'unknown') as RemoteCliResult;
    const budget = Math.min(session.display.expiresInSeconds ? session.display.expiresInSeconds * 1000 : waitCapMs, waitCapMs);
    const deadline = Math.min(session.startedAt + budget, timeoutMs === undefined ? Number.POSITIVE_INFINITY : now() + timeoutMs);
    for (;;) {
      if (session.result || session.exited !== undefined) return session.settled;
      if (now() >= deadline) return stop(session, fail(session.provider, 'expired'));
      await Promise.race([session.exit, new Promise((r) => setTimeout(r, 250))]);
    }
  }

  async function paste(id: string, pasteText: string): Promise<void> {
    if (typeof id !== 'string' || !id || id.length > 128) throw new Error('accounts.cli.signin.paste needs { id, text }');
    if (typeof pasteText !== 'string' || !pasteText || pasteText.includes('\0') || pasteText.length > 2000) {
      throw new Error('accounts.cli.signin.paste needs { id, text }');
    }
    const stripped = pasteText.endsWith('\n') ? pasteText.slice(0, -1) : pasteText;
    if (!stripped || stripped.includes('\n')) throw new Error('accounts.cli.signin.paste needs { id, text }');
    const session = sessions.get(id);
    if (!session || session.result || session.exited !== undefined) {
      throw Object.assign(new Error(REMOTE_CLI_WORDS.unknown()), { remoteCliProblem: 'unknown' as RemoteCliProblem });
    }
    const line = stripped + '\n';
    try {
      await new Promise<void>((resolve, reject) => {
        session.child.stdin!.write(line, (e) => (e ? reject(e) : resolve()));
      });
    } catch {
      throw Object.assign(new Error(REMOTE_CLI_WORDS.failed(session.provider)), { remoteCliProblem: 'failed' as RemoteCliProblem });
    }
  }

  async function cancel(id: string): Promise<void> {
    if (typeof id !== 'string' || !id || id.length > 128) throw new Error('accounts.cli.signin.cancel needs { id }');
    const session = sessions.get(id);
    if (!session) throw Object.assign(new Error(REMOTE_CLI_WORDS.unknown()), { remoteCliProblem: 'unknown' as RemoteCliProblem });
    await stop(session, fail(session.provider, 'cancelled'));
  }

  const problemOf = (e: unknown): RemoteCliProblem | undefined =>
    e instanceof Error && 'remoteCliProblem' in e && typeof (e as { remoteCliProblem: unknown }).remoteCliProblem === 'string'
      ? (e as { remoteCliProblem: RemoteCliProblem }).remoteCliProblem : undefined;

  async function handle(req: { op: string; args?: unknown }): Promise<RemoteCliReply> {
    if (!record(req) || typeof req.op !== 'string' || (req.args !== undefined && !record(req.args))) {
      throw new Error('unknown request');
    }
    const args = (req.args ?? {}) as Record<string, unknown>;
    const problemReply = (provider: RemoteCliProvider, error: RemoteCliProblem): RemoteCliReply => {
      const words = fail(provider, error).words;
      return { v: 1, ok: false, error, words };
    };
    try {
      switch (req.op) {
        case REMOTE_CLI_OPS.state: {
          if (args.v !== 1) throw new Error('accounts.cli.state needs { v: 1 }');
          return { v: 1, ok: true, value: await state() };
        }
        case REMOTE_CLI_OPS.start: {
          if (args.v !== 1 || !isRemoteCliProvider(args.provider)) throw new Error('accounts.cli.signin.start needs { provider }');
          // Typed start outcomes (unsupported, missing, busy, already, failed) are values, not
          // transport errors: the phone shows them as states.
          return { v: 1, ok: true, value: await start(args.provider) };
        }
        case REMOTE_CLI_OPS.wait: {
          if (args.v !== 1 || typeof args.id !== 'string') throw new Error('accounts.cli.signin.wait needs { id }');
          if (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || (args.timeoutMs as number) <= 0)) {
            throw new Error('accounts.cli.signin.wait needs a positive timeoutMs');
          }
          // A finished wait (success, denial, expiry) is a value; only malformed calls throw.
          return { v: 1, ok: true, value: await wait(args.id, args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs as number }) };
        }
        case REMOTE_CLI_OPS.paste: {
          if (args.v !== 1 || typeof args.id !== 'string' || typeof args.text !== 'string') {
            throw new Error('accounts.cli.signin.paste needs { id, text }');
          }
          await paste(args.id, args.text);
          return { v: 1, ok: true, value: null };
        }
        case REMOTE_CLI_OPS.cancel: {
          if (args.v !== 1 || typeof args.id !== 'string') throw new Error('accounts.cli.signin.cancel needs { id }');
          await cancel(args.id);
          return { v: 1, ok: true, value: null };
        }
        default:
          throw new Error('unknown request');
      }
    } catch (e) {
      const problem = problemOf(e);
      if (problem) {
        const provider = [...sessions.values()].find((s) => s.id === (args.id as string))?.provider ?? 'codex';
        return problemReply(provider, problem);
      }
      throw e;
    }
  }

  async function close(): Promise<void> {
    lifetime.abort();
    await Promise.allSettled([...pendingStarts]);
    await Promise.all([...sessions.values()].filter(session => !session.result).map(session => cancel(session.id)));
  }

  return { state, start, wait, paste, cancel, close, handle };
}
