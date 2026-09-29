// Fake sandbox API server bench (docs/machine-kit.md M4): a loopback `node:http` server on
// `127.0.0.1:0` answering the 6.1 routes, a state machine per id, a request log, and
// command execution delegated to `fakeMachine()` — so this bench runs the same machine as
// the fake provider and the SSH bench (13.3).
//
// This server defines the fixture document both sides agree on (15.1, 6.1): field names
// here are fixture choices, and nothing committed names a provider or its host —
// fixtures use `http://sandbox.test`, mapped to the loopback port through the `fetch`
// option (M4). Fields:
//   GET /me -> { accountId }
//   POST /sandboxes { type, ttlSeconds, noEnv, snapshots } + Idempotency-Key -> { id, state }
//   GET /sandboxes/{id} -> { id, state, stopReason }
//   POST /sandboxes/{id}/resume { ttlSeconds } -> { state }
//   POST /sandboxes/{id}/stop -> {}
//   POST /named-snapshots { sandboxId, name } -> { name }
//   GET /named-snapshots/{name} -> { name, ready }
//   POST /sandboxes/{id}/fork { ttlSeconds } + Idempotency-Key -> { id, state }
//   DELETE /sandboxes/{id} + X-Delete-Confirmation: <id> -> { operationId }
//   GET /deletion-operations/{op} -> { done }
//   GET /named-snapshots -> { snapshots: [{ name }] }
//   DELETE /named-snapshots/{name} -> {}
//   POST /sandboxes/{id}/commands { command, timeoutSeconds, detached } -> { stdout, stderr, exitCode } | { id }
//   GET /sandboxes/{id}/commands/{pid} -> { done, stdout, stderr, exitCode }
//   PUT /sandboxes/{id}/files { path, content } -> {} (content is base64)
//   POST /sandboxes/{id}/host { port, public } -> { url }
//   GET /sandboxes/{id}/usage?since=<since> -> { seconds, dollars, running }
//   GET /limits -> { balance, trialActive, trialEndsAt, canStayOn, checkoutUrl }
//   GET /api-keys/current -> { expiresAt, scopes }
// Wire stop reasons: 'user' | 'idle' | 'balance' | 'trial' | anything else.
import http from 'node:http';
import { FakeMachine, fakeMachine, parseCommand } from './fake-machine.ts';

export type SandboxRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /** True when the connection was destroyed before answering (a dropped connection). */
  dropped?: true;
};

export type SandboxServerOptions = {
  key?: string;
  accountId?: string;
  trial?: boolean;
  balance?: number | null;
  trialEndsAt?: string | null;
  canStayOn?: boolean;
  checkoutUrl?: string | null;
  stopReason?: string | null;
  /** Resume leaves the machine provisioning for this many status reads (default 0). */
  slowWakeReads?: number;
  keyExpiresAt?: string | null;
  keyScopes?: readonly string[];
};

export type SandboxServer = {
  /** The API root, e.g. `http://127.0.0.1:1234/api/v1`. */
  url: string;
  requests: SandboxRequest[];
  machine: FakeMachine;
  /** Read or force a machine's raw provider state (6.2). */
  getState(id: string): string | null;
  setState(id: string, raw: string): void;
  setTrial(on: boolean): void;
  setBalance(n: number | null): void;
  setStopReason(r: string | null): void;
  setPlan(p: { trialEndsAt?: string | null; canStayOn?: boolean; checkoutUrl?: string | null }): void;
  /** Destroy the next n connections without answering (a dropped connection). */
  dropNext(n: number): void;
  /** Answer the next request(s) with these one-shot failures first. */
  failNext(failures: readonly { status: number; body?: unknown }[]): void;
  close(): Promise<void>;
};

type Sandbox = {
  id: string;
  raw: string;
  stopReason: string | null;
  wakeReads: number;
  commands: Map<string, { stdout: string; stderr: string; exitCode: number }>;
};

const fromBase64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'));

export async function startFakeSandboxServer(o: SandboxServerOptions = {}): Promise<SandboxServer> {
  const key = o.key ?? 'test-key';
  const accountId = o.accountId ?? 'acct-test';
  const machine = fakeMachine();
  const requests: SandboxRequest[] = [];
  const sandboxes = new Map<string, Sandbox>();
  const snapshots = new Map<string, string>();
  const createdByKey = new Map<string, string>();
  const forkedByKey = new Map<string, string>();
  const deletions = new Set<string>();
  let seq = 0;
  let opSeq = 0;
  let cmdSeq = 0;
  let trial = o.trial ?? false;
  let balance: number | null = o.balance ?? null;
  let trialEndsAt: string | null = o.trialEndsAt ?? null;
  let canStayOn = o.canStayOn ?? true;
  let checkoutUrl: string | null = o.checkoutUrl ?? null;
  let stopReason: string | null = o.stopReason ?? null;
  let slowWakeReads = o.slowWakeReads ?? 0;
  let drop = 0;
  const failures: { status: number; body?: unknown }[] = [];

  const send = (res: http.ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  // The 6.4 stdin wrapper verbatim (`<command> < <path>; r=$?; rm -f <path>; exit $r`):
  // the shell keeps `;` glued to the path token, so this is recognised here and the
  // remainder goes through `parseCommand` like every other command string (13.3).
  const runCommand = (s: string): { stdout: string; stderr: string; exitCode: number } => {
    let command = s;
    let input: Uint8Array | null = null;
    const staged = / < ([^ ]+); r=\$\?; rm -f \1; exit \$r$/.exec(s);
    if (staged !== null) {
      input = machine.readFile(staged[1]);
      command = s.slice(0, staged.index);
    }
    const parsed = parseCommand(command, (p) => machine.readFile(p));
    if (input === null) input = parsed.input;
    // The adapter's post-PUT `chmod <mode, octal> <path>` really applies the mode here.
    if (parsed.argv[0] === 'chmod' && parsed.argv.length === 3 && input === null) {
      const file = machine.files.get(parsed.argv[2]);
      const mode = Number.parseInt(parsed.argv[1], 8);
      if (file !== undefined && Number.isInteger(mode)) {
        machine.files.set(parsed.argv[2], { ...file, mode });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
    }
    const r = machine.run(
      parsed.argv,
      { root: parsed.root, ...(input !== null ? { input } : {}), ...(parsed.asUser !== null ? { asUser: parsed.asUser } : {}) },
    );
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
  };

  const server = http.createServer((req, res) => {
    if (drop > 0) {
      drop -= 1;
      const dropUrl = new URL(req.url ?? '/', 'http://sandbox.test');
      let dropPath = dropUrl.pathname;
      if (dropPath.startsWith('/api/v1')) dropPath = dropPath.slice('/api/v1'.length) || '/';
      const dropHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') dropHeaders[k] = k === 'authorization' ? '[redacted]' : v;
      }
      requests.push({ method: req.method ?? 'GET', path: dropPath + dropUrl.search, headers: dropHeaders, body: null, dropped: true });
      req.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawUrl = req.url ?? '/';
      const u = new URL(rawUrl, 'http://sandbox.test');
      let path = u.pathname;
      if (path.startsWith('/api/v1')) path = path.slice('/api/v1'.length) || '/';
      let body: unknown = null;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = k === 'authorization' ? '[redacted]' : v;
      }
      requests.push({ method: req.method ?? 'GET', path: path + u.search, headers, body });

      const fail = failures.shift();
      if (fail !== undefined) {
        send(res, fail.status, fail.body ?? { error: 'injected' });
        return;
      }
      if (req.headers.authorization !== `Bearer ${key}`) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      const route = `${req.method} ${path}`;
      const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
      const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
      const b = (body ?? {}) as Record<string, unknown>;

      if (route === 'GET /me') return send(res, 200, { accountId });

      if (route === 'POST /sandboxes') {
        if (b['noEnv'] !== true) return send(res, 400, { error: 'noEnv must be true' });
        const idem = req.headers['idempotency-key'];
        const idemKey = typeof idem === 'string' ? idem : '';
        if (idemKey !== '' && createdByKey.has(idemKey)) {
          const id = createdByKey.get(idemKey) as string;
          return send(res, 200, { id, state: sandboxes.get(id)?.raw ?? 'ready' });
        }
        if (trial && b['ttlSeconds'] === null) {
          return send(res, 422, { error: 'trial_auto_stop_required', message: 'the trial caps auto-stop at 2 hours' });
        }
        const id = `sb-${++seq}`;
        sandboxes.set(id, { id, raw: 'ready', stopReason: null, wakeReads: 0, commands: new Map() });
        if (idemKey !== '') createdByKey.set(idemKey, id);
        return send(res, 201, { id, state: 'ready' });
      }

      const sbMatch = /^\/sandboxes\/([^/]+)(\/.*)?$/.exec(path);
      if (sbMatch !== null) {
        const id = decodeURIComponent(sbMatch[1]);
        const rest = sbMatch[2] ?? '';
        const sb = sandboxes.get(id);
        if (rest === '' && req.method === 'GET') {
          if (sb === undefined) return send(res, 404, { error: 'not found' });
          if (sb.raw === 'provisioning' && sb.wakeReads > 0) {
            sb.wakeReads -= 1;
            if (sb.wakeReads === 0) sb.raw = 'ready';
          }
          return send(res, 200, { id, state: sb.raw, stopReason: sb.stopReason });
        }
        if (sb === undefined) return send(res, 404, { error: 'not found' });
        if (rest === '/resume' && req.method === 'POST') {
          if (trial && b['ttlSeconds'] === null) {
            return send(res, 422, { error: 'trial_auto_stop_required', message: 'the trial caps auto-stop at 2 hours' });
          }
          // No `noEnv` is accepted here: a resume is never a conversion (6.3).
          if ('noEnv' in b || 'env' in b) return send(res, 400, { error: 'noEnv and env are create-only' });
          sb.raw = slowWakeReads > 0 ? 'provisioning' : 'ready';
          sb.wakeReads = slowWakeReads;
          return send(res, 200, { state: sb.raw });
        }
        if (rest === '/stop' && req.method === 'POST') {
          sb.raw = 'archived';
          sb.stopReason = stopReason;
          return send(res, 200, {});
        }
        if (rest === '/fork' && req.method === 'POST') {
          if ('noEnv' in b || 'env' in b) return send(res, 400, { error: 'noEnv and env are create-only' });
          const idem = req.headers['idempotency-key'];
          const idemKey = typeof idem === 'string' ? idem : '';
          if (idemKey !== '' && forkedByKey.has(idemKey)) {
            return send(res, 200, { id: forkedByKey.get(idemKey) as string, state: 'ready' });
          }
          if (trial && b['ttlSeconds'] === null) {
            return send(res, 422, { error: 'trial_auto_stop_required', message: 'the trial caps auto-stop at 2 hours' });
          }
          const forkId = `sb-${++seq}`;
          sandboxes.set(forkId, { id: forkId, raw: 'ready', stopReason: null, wakeReads: 0, commands: new Map() });
          if (idemKey !== '') forkedByKey.set(idemKey, forkId);
          return send(res, 201, { id: forkId, state: 'ready' });
        }
        if (rest === '' && req.method === 'DELETE') {
          if (req.headers['x-delete-confirmation'] !== id) {
            return send(res, 400, { error: 'the delete-confirmation header must equal the id' });
          }
          sandboxes.delete(id);
          const op = `del-${++opSeq}`;
          deletions.add(op);
          return send(res, 202, { operationId: op });
        }
        if (rest === '/commands' && req.method === 'POST') {
          const command = str(b['command']);
          if (command === null) return send(res, 400, { error: 'command is required' });
          const result = runCommand(command);
          if (b['detached'] === true) {
            const pid = `cmd-${++cmdSeq}`;
            sb.commands.set(pid, result);
            return send(res, 202, { id: pid });
          }
          return send(res, 200, { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
        }
        const cmdMatch = /^\/commands\/([^/]+)$/.exec(rest);
        if (cmdMatch !== null && req.method === 'GET') {
          const pid = decodeURIComponent(cmdMatch[1]);
          const result = sb.commands.get(pid);
          if (result === undefined) return send(res, 404, { error: 'not found' });
          return send(res, 200, { done: true, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
        }
        if (rest === '/files' && req.method === 'PUT') {
          const filePath = str(b['path']);
          const content = str(b['content']);
          if (filePath === null || content === null) return send(res, 400, { error: 'path and content are required' });
          machine.writeFile(filePath, fromBase64(content), 0o600);
          return send(res, 200, {});
        }
        if (rest === '/host' && req.method === 'POST') {
          const port = num(b['port']);
          if (port === null) return send(res, 400, { error: 'port is required' });
          return send(res, 200, { url: `https://${id}-${port}.sandbox.test` });
        }
        if (rest === '/usage' && req.method === 'GET') {
          return send(res, 200, { seconds: 86400, dollars: 0.5, running: true });
        }
        return send(res, 404, { error: 'not found' });
      }

      if (route === 'POST /named-snapshots') {
        const sandboxId = str(b['sandboxId']);
        const name = str(b['name']);
        if (sandboxId === null || name === null) return send(res, 400, { error: 'sandboxId and name are required' });
        if (snapshots.size >= 10 && !snapshots.has(name)) {
          return send(res, 409, { error: 'at most 10 named snapshots per account' });
        }
        snapshots.set(name, sandboxId);
        return send(res, 201, { name });
      }
      const namedGet = /^\/named-snapshots\/([^/]+)$/.exec(path);
      if (namedGet !== null && req.method === 'GET') {
        const name = decodeURIComponent(namedGet[1]);
        if (!snapshots.has(name)) return send(res, 404, { error: 'not found' });
        return send(res, 200, { name, ready: true });
      }
      if (namedGet !== null && req.method === 'DELETE') {
        snapshots.delete(decodeURIComponent(namedGet[1]));
        return send(res, 200, {});
      }
      if (route === 'GET /named-snapshots') {
        return send(res, 200, { snapshots: [...snapshots.keys()].map((name) => ({ name })) });
      }

      const delMatch = /^\/deletion-operations\/([^/]+)$/.exec(path);
      if (delMatch !== null && req.method === 'GET') {
        if (!deletions.has(decodeURIComponent(delMatch[1]))) return send(res, 404, { error: 'not found' });
        return send(res, 200, { done: true });
      }

      if (route === 'GET /limits') {
        return send(res, 200, {
          balance,
          trialActive: trial,
          trialEndsAt,
          canStayOn,
          checkoutUrl,
        });
      }
      if (route === 'GET /api-keys/current') {
        return send(res, 200, { expiresAt: o.keyExpiresAt ?? null, scopes: [...(o.keyScopes ?? [])] });
      }
      return send(res, 404, { error: 'not found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    requests,
    machine,
    getState: (id) => sandboxes.get(id)?.raw ?? null,
    setState: (id, raw) => {
      const sb = sandboxes.get(id);
      if (sb !== undefined) sb.raw = raw;
    },
    setTrial: (on) => {
      trial = on;
    },
    setBalance: (n) => {
      balance = n;
    },
    setStopReason: (r) => {
      stopReason = r;
    },
    setPlan: (p) => {
      if (p.trialEndsAt !== undefined) trialEndsAt = p.trialEndsAt;
      if (p.canStayOn !== undefined) canStayOn = p.canStayOn;
      if (p.checkoutUrl !== undefined) checkoutUrl = p.checkoutUrl;
    },
    dropNext: (n) => {
      drop += n;
    },
    failNext: (list) => {
      failures.push(...list);
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((e) => (e !== undefined ? reject(e) : resolve()));
    }),
  };
}
