// Boat adapter (docs/cloud-kit.md section 6). Portable: no `node:*` import,
// so browsers and PWAs can bundle `.` (D-6); the adapter itself does not run from a web
// page (15.1), so setup happens from the phone app or a desktop app.
//
// Wire-field note: the public API document's exact route and field names arrive with the
// M4 brief (15.1); the loopback bench (`src/testing/fake-sandbox-server.ts`) defines the
// fixture document used here, and both sides agree on it. Boat is named under D-2;
// fixtures use the host `boat.test`, mapped to loopback.
import { MachineError } from './errors.ts';
import type {
  AsleepWhy,
  ExecResult,
  KeyInfo,
  MachineRef,
  MachineState,
  Plan,
  Price,
  Provider,
  Size,
  Usage,
} from './types.ts';

const SIZES: readonly Size[] = [
  { id: 'small', cpus: 2, memoryGb: 4, diskGb: 12 },
  { id: 'default', cpus: 4, memoryGb: 8, diskGb: 50 },
];

// The provider's trial error (15.1): during a trial auto-stop cannot be disabled, so a
// `ttlSeconds: null` request is refused and retried once with the 2-hour maximum (6.1).
const TRIAL_ERROR = 'trial_auto_stop_required';
const TRIAL_TTL_SECONDS = 7200;

// The provider's delete-confirmation header (6.1); its name comes from the API document
// and the fixture document fixes it here.
const DELETE_CONFIRM_HEADER = 'X-Delete-Confirmation';

const RETRY_WAITS_MS = [1000, 2000, 4000];
const POLL_EVERY_MS = 2000;
const EXEC_POLL_EVERY_MS = 1000;
const WAKE_TIMEOUT_MS = 5 * 60 * 1000;
const NON_DETACHED_LIMIT_MS = 590_000;
const STREAM_CAP = 8 * 1024 * 1024;
const ERROR_BODY_CAP = 200;

const randomBase36 = (n: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');
};

/** POSIX single-quote joining (6.4); NUL in any argument rejects `bad-recipe`. */
const quote = (argv: readonly string[]): string => {
  for (const a of argv) {
    if (a.includes('\0')) throw new MachineError('bad-recipe', 'argv: must not contain NUL');
  }
  return argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ');
};

const tail = (s: string): string => (s.length > STREAM_CAP ? s.slice(-STREAM_CAP) : s);

/** Portable base64 (no `node:*` import): `btoa` exists on Node, browsers and Hermes. */
const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type FetchFn = typeof fetch;

type WireBody = { body?: unknown; headers?: Record<string, string> };

export function boat(o: {
  baseUrl: string; label: string; prices: readonly Price[]; key: () => Promise<string>; fetch?: typeof fetch
}): Provider {
  const fetchFn: FetchFn = o.fetch ?? globalThis.fetch;
  const lastRaw = new Map<string, string>();
  const wakeFlight = new Set<string>();
  let accountCache: string | null = null;

  const send = async (method: string, path: string, wire?: WireBody): Promise<Response> => {
    const key = await o.key();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...wire?.headers,
    };
    const init: RequestInit = { method, headers };
    if (wire?.body !== undefined) init.body = JSON.stringify(wire.body);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchFn(`${o.baseUrl}${path}`, init);
      } catch {
        // A `fetch` rejection is a transport failure, never a provider answer.
        throw new MachineError('unreachable', 'the provider could not be reached');
      }
      if ((res.status === 429 || res.status >= 500) && attempt < RETRY_WAITS_MS.length) {
        await sleep(RETRY_WAITS_MS[attempt]);
        continue;
      }
      return res;
    }
  };

  const read = async (res: Response): Promise<{ text: string; json: unknown }> => {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { text, json };
  };

  const isTrial = (text: string): boolean => text.includes(TRIAL_ERROR);

  // Any other non-2xx is the provider's own failure; the message holds the provider's
  // own text capped at 200 characters, never the key.
  const fail = (status: number, text: string): never => {
    throw new MachineError('provider', `the provider answered ${status}: ${text.slice(0, ERROR_BODY_CAP)}`);
  };

  const checked = async (method: string, path: string, wire?: WireBody): Promise<{ status: number; text: string; json: unknown }> => {
    const res = await send(method, path, wire);
    const { text, json } = await read(res);
    if (res.status === 401 || res.status === 403) {
      throw new MachineError('unauthorized', 'the provider did not accept the key');
    }
    if (!((res.status >= 200 && res.status < 300) || res.status === 404)) fail(res.status, text);
    return { status: res.status, text, json };
  };

  const field = (json: unknown, name: string): unknown =>
    typeof json === 'object' && json !== null ? (json as Record<string, unknown>)[name] : undefined;

  const account = async (): Promise<string> => {
    if (accountCache === null) {
      const { json } = await checked('GET', '/me');
      const id = field(json, 'accountId');
      if (typeof id !== 'string' || id.length === 0) {
        throw new MachineError('provider', 'the provider answered /me without an accountId');
      }
      accountCache = id;
    }
    return accountCache;
  };

  const mapState = (id: string, raw: unknown): MachineState => {
    if (typeof raw !== 'string') {
      throw new MachineError('provider', 'the provider answered with an unknown machine state');
    }
    const prev = lastRaw.get(id);
    lastRaw.set(id, raw);
    switch (raw) {
      case 'ready':
      case 'idle':
      case 'running':
        return 'on';
      case 'archiving':
        return 'stopping';
      case 'archived':
        return 'asleep';
      case 'error':
        return 'failed';
      case 'cancelled':
        return 'gone';
      case 'init':
      case 'provisioning':
      case 'provisioned':
      case 'cloning':
        return prev === 'archived' || wakeFlight.has(id) ? 'waking' : 'creating';
      default:
        throw new MachineError('provider', `the provider answered with an unknown machine state ${JSON.stringify(raw).slice(0, 50)}`);
    }
  };

  // `ttlSeconds: null` disables auto-stop; during a trial the provider refuses it and the
  // adapter retries once with the 2-hour maximum and the same idempotency key (6.1 Trial).
  // Internal: the provider refused `ttlSeconds: null` with its trial error. Never
  // surfaces; `withTrial` turns it into the single 7200 retry (6.1 Trial).
  class TrialRefused extends Error {
    constructor() {
      super('the trial caps auto-stop at 2 hours');
    }
  }

  const withTrial = async <T>(run: (ttlSeconds: number | null) => Promise<T>): Promise<T> => {
    try {
      return await run(null);
    } catch (e) {
      if (e instanceof TrialRefused) return run(TRIAL_TTL_SECONDS);
      throw e;
    }
  };

  const trialOrFail = (status: number, text: string): never => {
    if (isTrial(text)) throw new TrialRefused();
    if (status === 401 || status === 403) {
      throw new MachineError('unauthorized', 'the provider did not accept the key');
    }
    throw new MachineError('provider', `the provider answered ${status}: ${text.slice(0, ERROR_BODY_CAP)}`);
  };

  const status = async (m: MachineRef): Promise<MachineState> => {
    let res: Response;
    try {
      res = await send('GET', `/sandboxes/${encodeURIComponent(m.id)}`);
    } catch (e) {
      if ((e as { code?: string }).code === 'unreachable') return 'unknown';
      throw e;
    }
    if (res.status === 404) return 'gone';
    const { text, json } = await read(res);
    if (res.status === 401 || res.status === 403) {
      throw new MachineError('unauthorized', 'the provider did not accept the key');
    }
    // A request that failed after retries leaves the state unknown, never failed (6.2).
    if (res.status === 429 || res.status >= 500) return 'unknown';
    if (res.status < 200 || res.status >= 300) fail(res.status, text);
    return mapState(m.id, field(json, 'state'));
  };

  const exec = async (
    m: MachineRef,
    argv: readonly string[],
    execOpts: { timeoutMs: number; root?: boolean; input?: Uint8Array },
  ): Promise<ExecResult> => {
    // The provider takes a shell string, not argv, and has no stdin (6.4).
    let command = quote(argv);
    const secs = Math.ceil(execOpts.timeoutMs / 1000);
    command = `timeout -k 10 ${secs} ${command}`;
    if (execOpts.root === true) command = `sudo -n ${command}`;
    if (execOpts.input !== undefined) {
      const stage = `/tmp/byokit-in-${randomBase36(16)}`;
      await write(m, stage, execOpts.input, 0o600);
      // The redirect is opened by the machine user's shell before any `sudo`, so root
      // never opens a path another user could have planted (6.4).
      command = `${command} < ${stage}; r=$?; rm -f ${stage}; exit $r`;
    }
    if (execOpts.timeoutMs > NON_DETACHED_LIMIT_MS) {
      const started = Date.now();
      const { json } = await checked('POST', `/sandboxes/${encodeURIComponent(m.id)}/commands`, {
        body: { command, detached: true },
      });
      const pid = field(json, 'id');
      if (typeof pid !== 'string') fail(200, 'the provider answered a command without an id');
      for (;;) {
        const polled = await checked('GET', `/sandboxes/${encodeURIComponent(m.id)}/commands/${encodeURIComponent(pid as string)}`);
        if (field(polled.json, 'done') === true) {
          return finish(polled.json);
        }
        if (Date.now() - started > execOpts.timeoutMs + 30_000) {
          throw new MachineError('timeout', 'the provider command ran too long');
        }
        await sleep(EXEC_POLL_EVERY_MS);
      }
    }
    const { json } = await checked('POST', `/sandboxes/${encodeURIComponent(m.id)}/commands`, {
      body: { command, timeoutSeconds: secs + 10, detached: false },
    });
    return finish(json);
  };

  const finish = (json: unknown): ExecResult => {
    const stdout = typeof field(json, 'stdout') === 'string' ? field(json, 'stdout') as string : '';
    const stderr = typeof field(json, 'stderr') === 'string' ? field(json, 'stderr') as string : '';
    const code = typeof field(json, 'exitCode') === 'number' ? field(json, 'exitCode') as number : 0;
    // Exit 124 or 137 from `timeout` resolves `timedOut: true` (6.4).
    return { code, stdout: tail(stdout), stderr: tail(stderr), timedOut: code === 124 || code === 137 };
  };

  const write = async (m: MachineRef, path: string, bytes: Uint8Array, mode: number): Promise<void> => {
    // Only paths under `/home/user/` or `/tmp/`; anything else rejects before any request.
    if (!(path.startsWith('/home/user/') || path.startsWith('/tmp/'))) {
      throw new MachineError('bad-recipe', `path: must be under /home/user/ or /tmp/, got ${JSON.stringify(path)}`);
    }
    await checked('PUT', `/sandboxes/${encodeURIComponent(m.id)}/files`, {
      body: { path, content: toBase64(bytes) },
    });
    // `Machine` writes files through `exec` with `input`, so root never reads a staged
    // path; only this 6.4 `input` path stages one.
    await exec(m, ['chmod', mode.toString(8), path], { timeoutMs: 30_000 });
  };

  const provider: Provider = {
    id: 'sandbox-api',
    label: o.label,
    account,
    sizes: () => SIZES,
    prices: () => o.prices,
    status,
    exec,
    write,

    create: async ({ name, size, keepCopies, idempotencyKey }) => {
      const acct = await account();
      const id = await withTrial(async (ttlSeconds) => {
        const res = await send('POST', '/sandboxes', {
          body: { type: size, ttlSeconds, noEnv: true, snapshots: keepCopies },
          headers: { 'Idempotency-Key': idempotencyKey },
        });
        const { text, json } = await read(res);
        if (res.status < 200 || res.status >= 300) trialOrFail(res.status, text);
        const created = field(json, 'id');
        if (typeof created !== 'string' || created.length === 0) fail(res.status, text);
        return created as string;
      });
      // It resolves once the returned id exists; it does not wait for `on` (6.1).
      return { provider: 'sandbox-api', account: acct, id, name, keepCopies };
    },

    wake: async (m: MachineRef) => {
      await withTrial(async (ttlSeconds) => {
        // No `noEnv` field: a resume is never a conversion (6.3).
        const res = await send('POST', `/sandboxes/${encodeURIComponent(m.id)}/resume`, {
          body: { ttlSeconds },
        });
        const { text } = await read(res);
        if (res.status < 200 || res.status >= 300) trialOrFail(res.status, text);
      });
      wakeFlight.add(m.id);
      try {
        const started = Date.now();
        for (;;) {
          const s = await status(m);
          if (s === 'on') return;
          if (s === 'failed' || s === 'gone') {
            throw new MachineError('provider', `the machine woke to ${s}`);
          }
          if (Date.now() - started > WAKE_TIMEOUT_MS) {
            throw new MachineError('timeout', 'the machine took too long to wake');
          }
          await sleep(POLL_EVERY_MS);
        }
      } finally {
        wakeFlight.delete(m.id);
      }
    },

    sleep: async (m: MachineRef) => {
      // The provider takes a final snapshot; if that fails the stop aborts and the
      // machine keeps running, reported as the `provider` error it returns (6.1).
      const { status: code, text } = await checked('POST', `/sandboxes/${encodeURIComponent(m.id)}/stop`);
      if (code < 200 || code >= 300) fail(code, text);
    },

    snapshot: async (m: MachineRef, name: string) => {
      const full = `byokit-${m.name}-${name}`;
      const { status: code, text, json } = await checked('POST', '/named-snapshots', {
        body: { sandboxId: m.id, name: full },
      });
      if (code < 200 || code >= 300) fail(code, text);
      void json;
      for (;;) {
        const polled = await checked('GET', `/named-snapshots/${encodeURIComponent(full)}`);
        if (field(polled.json, 'ready') === true) return { name: full };
        await sleep(POLL_EVERY_MS);
      }
    },

    fork: async (m: MachineRef, { name, idempotencyKey }) => {
      // A fork does not inherit the source's TTL, so it sends `ttlSeconds: null` (7200
      // during a trial); a fork of a no-env source is always no-env, so no `noEnv`
      // field (6.1, 6.3).
      const acct = await account();
      const id = await withTrial(async (ttlSeconds) => {
        const res = await send('POST', `/sandboxes/${encodeURIComponent(m.id)}/fork`, {
          body: { ttlSeconds },
          headers: { 'Idempotency-Key': idempotencyKey },
        });
        const { text, json } = await read(res);
        if (res.status < 200 || res.status >= 300) trialOrFail(res.status, text);
        const forked = field(json, 'id');
        if (typeof forked !== 'string' || forked.length === 0) fail(res.status, text);
        return forked as string;
      });
      return { provider: 'sandbox-api', account: acct, id, name, keepCopies: m.keepCopies };
    },

    remove: async (m: MachineRef, confirm: string) => {
      const prefix = `byokit-${m.name}-`;
      const res = await send('DELETE', `/sandboxes/${encodeURIComponent(m.id)}`, {
        headers: { [DELETE_CONFIRM_HEADER]: confirm },
      });
      if (res.status !== 404) {
        const { text, json } = await read(res);
        if (res.status < 200 || res.status >= 300) trialOrFail(res.status, text);
        const op = field(json, 'operationId');
        if (typeof op === 'string' && op.length > 0) {
          for (;;) {
            const polled = await send('GET', `/deletion-operations/${encodeURIComponent(op)}`);
            if (polled.status === 404) break;
            const body = await read(polled);
            if (polled.status < 200 || polled.status >= 300) trialOrFail(polled.status, body.text);
            if (field(body.json, 'done') === true) break;
            await sleep(POLL_EVERY_MS);
          }
        }
      }
      // Named snapshots survive a sandbox delete; without this step the sign-ins inside
      // them outlive it. A 404 on the sandbox still runs this step (6.1).
      const listed = await checked('GET', '/named-snapshots');
      const snaps = field(listed.json, 'snapshots');
      if (Array.isArray(snaps)) {
        for (const snap of snaps) {
          const snapName = typeof snap === 'object' && snap !== null
            ? (snap as Record<string, unknown>)['name']
            : undefined;
          if (typeof snapName === 'string' && snapName.startsWith(prefix)) {
            const deleted = await send('DELETE', `/named-snapshots/${encodeURIComponent(snapName)}`);
            if (deleted.status !== 404) {
              const body = await read(deleted);
              if (deleted.status < 200 || deleted.status >= 300) trialOrFail(deleted.status, body.text);
            }
          }
        }
      }
    },

    url: async (m: MachineRef, port: number) => {
      // The app's process must bind `0.0.0.0`; re-hosting the same port returns the
      // same URL (6.1).
      const { json } = await checked('POST', `/sandboxes/${encodeURIComponent(m.id)}/host`, {
        body: { port, public: true },
      });
      const url = field(json, 'url');
      return typeof url === 'string' ? url : null;
    },

    usage: async (m: MachineRef, since: string) => {
      const to = new Date().toISOString();
      const { json } = await checked('GET', `/sandboxes/${encodeURIComponent(m.id)}/usage?since=${encodeURIComponent(since)}`);
      const seconds = field(json, 'seconds');
      const dollars = field(json, 'dollars');
      if (typeof seconds !== 'number' || typeof dollars !== 'number') {
        throw new MachineError('provider', 'the provider answered usage without seconds and dollars');
      }
      // Then `GET /limits` for the balance (6.1).
      const limits = await checked('GET', '/limits');
      const balance = field(limits.json, 'balance');
      if (typeof balance === 'number' && balance <= 0) {
        throw new MachineError('balance', 'the account balance is spent');
      }
      return { from: since, to, hours: seconds / 3600, amount: dollars, currency: 'USD' as const };
    },

    key: async () => {
      const { json } = await checked('GET', '/api-keys/current');
      const expiresAt = field(json, 'expiresAt');
      const scopes = field(json, 'scopes');
      const info: KeyInfo = {
        expires: typeof expiresAt === 'string' ? expiresAt : null,
        scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [],
      };
      return info;
    },

    // G2: display only (5.7); no other call depends on it. Not cached.
    plan: async () => {
      const { json } = await checked('GET', '/limits');
      const trialActive = field(json, 'trialActive');
      const trialEndsAt = field(json, 'trialEndsAt');
      const canStayOn = field(json, 'canStayOn');
      const checkoutUrl = field(json, 'checkoutUrl');
      const plan: Plan = {
        inTrial: trialActive === true,
        trialEndsAt: typeof trialEndsAt === 'string' ? trialEndsAt : null,
        canStayOn: canStayOn !== false,
        checkoutUrl: typeof checkoutUrl === 'string' ? checkoutUrl : null,
      };
      return plan;
    },

    // G3: the fixture document carries a stop reason, so the method ships. A sandbox
    // without one resolves null and 5.7's fallbacks apply — the same outcome as absent.
    why: async (m: MachineRef) => {
      const res = await send('GET', `/sandboxes/${encodeURIComponent(m.id)}`);
      if (res.status === 404) return null;
      const { text, json } = await read(res);
      if (res.status === 401 || res.status === 403) {
        throw new MachineError('unauthorized', 'the provider did not accept the key');
      }
      if (res.status < 200 || res.status >= 300) fail(res.status, text);
      const reason = field(json, 'stopReason');
      if (reason === null || reason === undefined) return null;
      const why: Record<string, AsleepWhy> = {
        user: 'you',
        balance: 'out-of-credit',
        trial: 'trial-limit',
        idle: 'idle',
      };
      return typeof reason === 'string' && reason in why ? why[reason] : 'provider';
    },
  };

  return provider;
}
