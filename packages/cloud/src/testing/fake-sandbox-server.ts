// Fake sandbox API server bench (docs/cloud-kit.md M4): a loopback `node:http` server on
// `127.0.0.1:0` answering the public boat-v1 routes, a state machine per id, a request log,
// and command execution delegated to `fakeMachine()` — so this bench runs the same machine as
// the fake provider and the SSH bench (13.3).
//
// This server serves the public boat-v1 API document (`docs.boat.dev/openapi/boat-v1.yaml`)
// so the adapter and this bench agree on the real wire shapes (15.1, 6.1) — every response
// nests its sandbox/operation/snapshot object and uses the document's field names. Routes:
//   GET /me -> { ok, type: user.info, user: { id } }
//   POST /sandboxes { type, ttlSeconds, noEnv, snapshots } + Idempotency-Key -> { ok, type, status, ttlSeconds, sandbox: { id, state } }
//   GET /sandboxes/{id} -> { ok, type: sandbox.info, sandbox: { id, state } }
//   POST /sandboxes/{id}/resume { ttlSeconds } -> { ok, type, id, status, sandbox: { id, state } }
//   POST /sandboxes/{id}/stop -> { ok, type, id, status, sandbox: { id, state } }
//   POST /named-snapshots { sandboxId, name } -> { ok, type, status, snapshot: { name } }
//   GET /named-snapshots/{name} -> { ok, type, snapshot: { name, status } }
//   POST /sandboxes/{id}/fork { ttlSeconds } + Idempotency-Key -> { ok, type, id, status, sandbox: { id, state } }
//   DELETE /sandboxes/{id} + X-Ascii-Confirm-Delete: <id> -> { ok, type, operation: { id, status } }
//   GET /deletion-operations/{op} -> { ok, type, operation: { id, status } }
//   GET /named-snapshots -> { ok, type, snapshots: [{ name }] }
//   DELETE /named-snapshots/{name} -> { ok, type, name, status }
//   POST /sandboxes/{id}/commands { command, timeoutSeconds, detached } -> { ok, type, exitCode, stdout, stderr, timedOut } | { ok, type, processId, pid, ... }
//   GET /sandboxes/{id}/commands/{processId} -> { ok, type, processId, running, status, exitCode, stdout, stderr }
//   PUT /sandboxes/{id}/files { path, content, encoding } -> { ok, type, path, encoding, size } (content base64 when encoding=base64)
//   POST /sandboxes/{id}/host { port, public } -> { ok, type, port, url }
//   GET /sandboxes/{id}/usage?since=<since> -> { ok, type, seconds, dollars, running }
//   GET /limits -> { ok, type, canStart, activeSandboxes, maxActiveSandboxes, billingStatus, creditBalanceSeconds, packBalanceSeconds, packBalanceDollars, unlimited, sandboxPlanKey, subscriptionTrialEndsAt }
// Sandbox states are the document's enum; there is no stop-reason field, so `why` is absent.
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
  /** Remaining `creditBalanceSeconds`; null (default) means a funded account. */
  balance?: number | null;
  trialEndsAt?: string | null;
  planKey?: string;
  canStart?: boolean;
  unlimited?: boolean;
  /** Resume leaves the machine provisioning for this many status reads (default 0). */
  slowWakeReads?: number;
  /** Create leaves the machine provisioning for this many status reads (default 0). */
  slowCreateReads?: number;
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
  setPlan(p: { planKey?: string; subscriptionTrialEndsAt?: string | null; canStart?: boolean }): void;
  /** Destroy the next n connections without answering (a dropped connection). */
  dropNext(n: number): void;
  /** Answer the next request(s) with these one-shot failures first. */
  failNext(failures: readonly { status: number; body?: unknown }[]): void;
  /** Make the next detached command's status read report a lost command. */
  loseNextCommand(): void;
  close(): Promise<void>;
};

type Sandbox = {
  id: string;
  raw: string;
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
  const deletions = new Map<string, 'processing' | 'completed'>();
  let seq = 0;
  let opSeq = 0;
  let cmdSeq = 0;
  let trial = o.trial ?? false;
  let creditBalanceSeconds = o.balance === undefined || o.balance === null ? 7200 : o.balance;
  let packBalanceSeconds = 0;
  let unlimited = o.unlimited ?? false;
  let canStart = o.canStart ?? true;
  let planKey = o.planKey ?? (trial ? 'trial' : 'box_20');
  let subscriptionTrialEndsAt: string | null = o.trialEndsAt ?? null;
  let slowWakeReads = o.slowWakeReads ?? 0;
  let drop = 0;
  let loseCommand = false;
  const failures: { status: number; body?: unknown }[] = [];

  const send = (res: http.ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  const sandboxBody = (sb: Sandbox, name: string): Record<string, unknown> => ({ id: sb.id, name, state: sb.raw });

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
      const dropUrl = new URL(req.url ?? '/', 'http://boat.test');
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
      const u = new URL(rawUrl, 'http://boat.test');
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

      if (route === 'GET /me') return send(res, 200, { ok: true, type: 'user.info', user: { id: accountId } });

      if (route === 'POST /sandboxes') {
        if (b['noEnv'] !== true) return send(res, 400, { error: 'noEnv must be true' });
        const idem = req.headers['idempotency-key'];
        const idemKey = typeof idem === 'string' ? idem : '';
        if (idemKey !== '' && createdByKey.has(idemKey)) {
          const id = createdByKey.get(idemKey) as string;
          const sb = sandboxes.get(id) as Sandbox;
          return send(res, 202, { ok: true, type: 'sandbox.created', status: 'ready', ttlSeconds: b['ttlSeconds'] ?? null, sandbox: sandboxBody(sb, 'Sandbox') });
        }
        if (trial && b['ttlSeconds'] === null) {
          return send(res, 422, { error: 'trial_auto_stop_required', message: 'the trial caps auto-stop at 2 hours' });
        }
        const id = `sb-${++seq}`;
        const slow = o.slowCreateReads ?? 0;
        const sb: Sandbox = { id, raw: slow > 0 ? 'provisioning' : 'ready', wakeReads: slow, commands: new Map() };
        sandboxes.set(id, sb);
        if (idemKey !== '') createdByKey.set(idemKey, id);
        return send(res, 202, { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: b['ttlSeconds'] ?? null, sandbox: sandboxBody(sb, 'Sandbox') });
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
          if (sb.raw === 'archiving') {
            const archiving = sandboxBody(sb, 'Sandbox');
            sb.raw = 'archived';
            return send(res, 200, { ok: true, type: 'sandbox.info', sandbox: archiving });
          }
          return send(res, 200, { ok: true, type: 'sandbox.info', sandbox: sandboxBody(sb, 'Sandbox') });
        }
        if (sb === undefined) return send(res, 404, { error: 'not found' });
        if (rest === '/resume' && req.method === 'POST') {
          if (trial && b['ttlSeconds'] === null) {
            return send(res, 422, { error: 'trial_auto_stop_required', message: 'the trial caps auto-stop at 2 hours' });
          }
          // No `noEnv` is accepted here: a resume is never a conversion (6.3).
          if ('noEnv' in b || 'env' in b) return send(res, 400, { error: 'noEnv and env are create-only' });
          // Every resume is a cold boot (6.5): enabled units start again.
          machine.reboot();
          sb.raw = slowWakeReads > 0 ? 'provisioning' : 'ready';
          sb.wakeReads = slowWakeReads;
          return send(res, 202, { ok: true, type: 'sandbox.resuming', id, status: 'resuming', sandbox: sandboxBody(sb, 'Sandbox') });
        }
        if (rest === '/stop' && req.method === 'POST') {
          sb.raw = 'archiving';
          return send(res, 202, { ok: true, type: 'sandbox.stopping', id, status: 'archiving', sandbox: sandboxBody(sb, 'Sandbox') });
        }
        if (rest === '/fork' && req.method === 'POST') {
          if ('noEnv' in b || 'env' in b) return send(res, 400, { error: 'noEnv and env are create-only' });
          const idem = req.headers['idempotency-key'];
          const idemKey = typeof idem === 'string' ? idem : '';
          if (idemKey !== '' && forkedByKey.has(idemKey)) {
            const forkId = forkedByKey.get(idemKey) as string;
            const forked = sandboxes.get(forkId) as Sandbox;
            return send(res, 202, { ok: true, type: 'sandbox.forking', id: forkId, status: 'forking', sandbox: sandboxBody(forked, 'Fork') });
          }
          if (trial && b['ttlSeconds'] === null) {
            return send(res, 422, { error: 'trial_auto_stop_required', message: 'the trial caps auto-stop at 2 hours' });
          }
          const forkId = `sb-${++seq}`;
          const forked: Sandbox = { id: forkId, raw: 'ready', wakeReads: 0, commands: new Map() };
          sandboxes.set(forkId, forked);
          if (idemKey !== '') forkedByKey.set(idemKey, forkId);
          return send(res, 202, { ok: true, type: 'sandbox.forking', id: forkId, status: 'forking', sandbox: sandboxBody(forked, 'Fork') });
        }
        if (rest === '' && req.method === 'DELETE') {
          if (req.headers['x-ascii-confirm-delete'] !== id) {
            return send(res, 409, { error: 'the delete-confirmation header must equal the id' });
          }
          sandboxes.delete(id);
          const op = `bdop_${(++opSeq).toString(16).padStart(32, '0')}`;
          deletions.set(op, 'completed');
          return send(res, 202, { ok: true, type: 'sandbox.deleting', operation: { id: op, kind: 'sandbox', targetId: id, reason: 'explicit', status: 'processing', attemptCount: 0, requestedAt: new Date().toISOString(), completedAt: null } });
        }
        if (rest === '/commands' && req.method === 'POST') {
          const command = str(b['command']);
          if (command === null) return send(res, 400, { error: 'command is required' });
          const result = runCommand(command);
          if (b['detached'] === true) {
            const pid = ++cmdSeq;
            sb.commands.set(String(pid), result);
            return send(res, 200, { ok: true, type: 'command.started', success: true, processId: pid, pid, command, cwd: '/home/user', startedAt: new Date().toISOString() });
          }
          return send(res, 200, { ok: true, type: 'command.finished', success: result.exitCode === 0, commandId: `cmd-${++cmdSeq}`, exitCode: result.exitCode, signal: null, oomKilled: false, stdout: result.stdout, stderr: result.stderr, stdoutTruncated: false, stderrTruncated: false, timedOut: result.exitCode === 124 || result.exitCode === 137, cwd: '/home/user', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
        }
        const cmdMatch = /^\/commands\/([^/]+)$/.exec(rest);
        if (cmdMatch !== null && req.method === 'GET') {
          const pidStr = decodeURIComponent(cmdMatch[1]);
          const result = sb.commands.get(pidStr);
          if (result === undefined) return send(res, 404, { error: 'not found' });
          const pid = Number.parseInt(pidStr, 10);
          if (loseCommand) {
            loseCommand = false;
            return send(res, 200, { ok: true, type: 'command.status', success: false, processId: pid, pid, status: 'lost', known: false, running: false, exitCode: null, signal: null, oomKilled: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false });
          }
          return send(res, 200, { ok: true, type: 'command.status', success: true, processId: pid, pid, status: 'exited', known: true, running: false, exitCode: result.exitCode, signal: null, oomKilled: false, stdout: result.stdout, stderr: result.stderr, stdoutTruncated: false, stderrTruncated: false });
        }
        if (rest === '/files' && req.method === 'PUT') {
          const filePath = str(b['path']);
          const content = str(b['content']);
          if (filePath === null || content === null) return send(res, 400, { error: 'path and content are required' });
          const encoding = str(b['encoding']) ?? 'utf8';
          const bytes = encoding === 'base64' ? fromBase64(content) : new TextEncoder().encode(content);
          machine.writeFile(filePath, bytes, 0o600);
          return send(res, 200, { ok: true, type: 'file.written', success: true, path: filePath, encoding, size: bytes.length });
        }
        if (rest === '/host' && req.method === 'POST') {
          const port = num(b['port']);
          if (port === null) return send(res, 400, { error: 'port is required' });
          return send(res, 200, { ok: true, type: 'port.hosted', success: true, port, url: `https://${id}-${port}.boat.test`, isProtected: false, access: 'public' });
        }
        if (rest === '/usage' && req.method === 'GET') {
          return send(res, 200, { ok: true, type: 'sandbox.usage', sandboxId: id, sandboxType: 'small', billingMultiplier: 0.5, since: u.searchParams.get('since'), until: new Date().toISOString(), seconds: 86400, dollars: 0.5, secondsPerDollar: 100000, running: true });
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
        return send(res, 202, { ok: true, type: 'snapshot.named.saving', status: 'saving', snapshot: { name, status: 'saving', sourceSandboxId: sandboxId, createdAt: new Date().toISOString() } });
      }
      const namedGet = /^\/named-snapshots\/([^/]+)$/.exec(path);
      if (namedGet !== null && req.method === 'GET') {
        const name = decodeURIComponent(namedGet[1]);
        if (!snapshots.has(name)) return send(res, 404, { error: 'not found' });
        return send(res, 200, { ok: true, type: 'snapshot.named.info', snapshot: { name, status: 'ready', sourceSandboxId: snapshots.get(name), createdAt: new Date().toISOString() } });
      }
      if (namedGet !== null && req.method === 'DELETE') {
        const name = decodeURIComponent(namedGet[1]);
        snapshots.delete(name);
        return send(res, 200, { ok: true, type: 'snapshot.named.deleted', name, status: 'deleted' });
      }
      if (route === 'GET /named-snapshots') {
        return send(res, 200, { ok: true, type: 'snapshot.named.list', snapshots: [...snapshots.keys()].map((name) => ({ name, status: 'ready' })) });
      }

      const delMatch = /^\/deletion-operations\/([^/]+)$/.exec(path);
      if (delMatch !== null && req.method === 'GET') {
        const op = decodeURIComponent(delMatch[1]);
        if (!deletions.has(op)) return send(res, 404, { error: 'not found' });
        return send(res, 200, { ok: true, type: 'deletion.operation', operation: { id: op, kind: 'sandbox', targetId: '', reason: 'explicit', status: deletions.get(op), attemptCount: 1, requestedAt: new Date().toISOString(), completedAt: deletions.get(op) === 'completed' ? new Date().toISOString() : null } });
      }

      if (route === 'GET /limits') {
        return send(res, 200, {
          ok: true,
          type: 'limits.info',
          canStart,
          activeSandboxes: sandboxes.size,
          maxActiveSandboxes: 100,
          billingStatus: 'active',
          creditBalanceSeconds,
          packBalanceSeconds,
          packBalanceDollars: 0,
          unlimited,
          sandboxPlanKey: planKey,
          subscriptionTrialEndsAt,
        });
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
      planKey = on ? 'trial' : 'box_20';
    },
    setBalance: (n) => {
      creditBalanceSeconds = n === null ? 7200 : n;
      packBalanceSeconds = 0;
    },
    setPlan: (p) => {
      if (p.planKey !== undefined) planKey = p.planKey;
      if (p.subscriptionTrialEndsAt !== undefined) subscriptionTrialEndsAt = p.subscriptionTrialEndsAt;
      if (p.canStart !== undefined) canStart = p.canStart;
    },
    dropNext: (n) => {
      drop += n;
    },
    failNext: (list) => {
      failures.push(...list);
    },
    loseNextCommand: () => {
      loseCommand = true;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((e) => (e !== undefined ? reject(e) : resolve()));
    }),
  };
}
