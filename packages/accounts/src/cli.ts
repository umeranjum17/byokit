import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { identity, type Identity } from '@byokit/usage';
import { say } from './words.ts';

export type CliProvider = 'claude' | 'codex';
/** Structural AccountLike surface; the CLI entry remains Node-only. */
export type CliAccount = { id: string; provider: CliProvider; name: string; state: 'ready' | 'signing' | 'resting' | 'signed_out' | 'needs_again' | 'not_included'; billing: 'subscription'; until?: number; email?: string; plan?: string };
export type CliOptions = {
  stateDir: string;
  bins: Partial<Record<CliProvider, string>>;
  env: { PATH: string; HOME: string } & Record<string, string>;
  historyFrom?: Partial<Record<CliProvider, string>>;
  prepare?: (folder: string, provider: CliProvider) => Promise<void>;
};
export type SignInCommand = { argv: string[]; env: Record<string, string>; completion: string; shell: string };
export class CliAccountError extends Error {
  override name = 'CliAccountError';
  readonly code: 'unknown-account' | 'invalid-name' | 'kind-mismatch' | 'prepare-failed' | 'bad-option';
  constructor(code: CliAccountError['code']) {
    super(say(({ 'unknown-account': 'cli.unknownAccount', 'invalid-name': 'cli.invalidName', 'kind-mismatch': 'cli.kindMismatch', 'prepare-failed': 'cli.prepareFailed', 'bad-option': 'cli.badOption' } as const)[code]));
    this.code = code;
  }
}
type Row = { id: string; provider: CliProvider; name: string; folder: string; found: boolean };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
const providers: CliProvider[] = ['claude', 'codex'];
const shed = {
  claude: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
};
const folderVar = (p: CliProvider) => p === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
const complete = (r: Row) => join(r.folder, '.byokit-signin-complete');
const pending = (r: Row) => join(r.folder, '.byokit-signin-pending');
function marker(file: string): boolean {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CliAccountError('bad-option');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function json(file: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024) return undefined;
    const data = Buffer.alloc(256 * 1024 + 1);
    let n = 0;
    while (n < data.length) { const count = readSync(fd, data, n, data.length - n, null); if (!count) break; n += count; }
    return n < data.length ? JSON.parse(data.subarray(0, n).toString('utf8')) : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
function directory(path: string, create = false): boolean {
  try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); }
  catch (error) {
    if (create && (error as NodeJS.ErrnoException).code === 'ENOENT') { mkdirSync(path, { mode: 0o700 }); return true; }
    return false;
  }
}
/** Only app-managed folders and explicitly supplied absolute CLI binaries. */
export function cliAccounts(options: CliOptions) {
  if (!record(options) || !text(options.stateDir) || !isAbsolute(options.stateDir) || !record(options.bins) || !record(options.env) || !text(options.env.PATH) || !text(options.env.HOME) || !isAbsolute(options.env.HOME)) throw new CliAccountError('bad-option');
  if (Object.entries(options.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || !text(v))) throw new CliAccountError('bad-option');
  if (Object.entries(options.bins).some(([p, bin]) => !providers.includes(p as CliProvider) || !text(bin) || !isAbsolute(bin))) throw new CliAccountError('bad-option');
  if (options.historyFrom && (!record(options.historyFrom) || Object.entries(options.historyFrom).some(([p, path]) => !providers.includes(p as CliProvider) || !text(path) || !isAbsolute(path)))) throw new CliAccountError('bad-option');
  const stateDir = resolve(options.stateDir); const env = { ...options.env }; const bins = { ...options.bins }; const history = { ...options.historyFrom };
  for (const path of ['.claude', '.codex', '.pi']) {
    const own = join(resolve(env.HOME), path);
    if (stateDir === own || stateDir.startsWith(own + '/')) throw new CliAccountError('bad-option');
  }
  // Parents must already be app-owned. Never follow a state/provider/folder symlink.
  try { if (realpathSync(dirname(stateDir)) !== dirname(stateDir)) throw new CliAccountError('bad-option'); }
  catch { throw new CliAccountError('bad-option'); }
  if (!directory(stateDir, true)) throw new CliAccountError('bad-option');
  chmodSync(stateDir, 0o700);
  const file = join(stateDir, 'accounts-v1.json');
  const created = new Set<string>(); const operations = new Map<string, Promise<unknown>>();
  function safe(r: Row): boolean {
    const parent = join(stateDir, r.provider);
    return resolve(r.folder) === r.folder && r.folder.startsWith(parent + '/') && /^[a-f0-9]+$/.test(r.folder.slice(parent.length + 1)) && directory(stateDir) && realpathSync(stateDir) === stateDir && directory(parent) && directory(r.folder);
  }
  function load(): Row[] {
    if (!directory(stateDir) || realpathSync(stateDir) !== stateDir) throw new CliAccountError('bad-option');
    const saved = json(file); if (!record(saved) || !Array.isArray(saved.accounts)) return [];
    const seen = new Set<string>(); const rows: Row[] = [];
    for (const candidate of saved.accounts) {
      if (!record(candidate) || !text(candidate.id) || !candidate.id || candidate.id.length > 128 || seen.has(candidate.id) || !providers.includes(candidate.provider as CliProvider) || !text(candidate.name) || candidate.name.length > 64 || !text(candidate.folder) || typeof candidate.found !== 'boolean') continue;
      const r: Row = { id: candidate.id, provider: candidate.provider as CliProvider, name: candidate.name, folder: candidate.folder, found: candidate.found };
      // Host-owned rows remain byte-compatible in the roster, without touching their folder.
      if (!r.found && !r.id.startsWith('found-') && !safe(r)) continue;
      seen.add(r.id); rows.push(r);
    }
    return rows;
  }
  function atomic(path: string, value: unknown) {
    if (!directory(stateDir) || realpathSync(stateDir) !== stateDir) throw new CliAccountError('bad-option');
    const tmp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
    catch { throw new CliAccountError('prepare-failed'); }
    finally { rmSync(tmp, { force: true }); }
  }
  const save = (rows: Row[]) => atomic(file, { version: 1, accounts: rows });
  function row(id: string): Row {
    const r = load().find((r) => r.id === id && !r.found && !r.id.startsWith('found-'));
    if (!r) throw new CliAccountError('unknown-account');
    return r;
  }
  function binary(p: CliProvider): string { const bin = bins[p]; if (!bin) throw new CliAccountError('bad-option'); return bin; }
  function launch(r: Row) { return { set: { [folderVar(r.provider)]: r.folder }, unset: [...shed[r.provider]] }; }
  function spawnEnv(r: Row) {
    const out = { ...env };
    for (const key of shed[r.provider]) delete out[key];
    delete out.CLAUDE_CONFIG_DIR; delete out.CODEX_HOME;
    return { ...out, ...launch(r).set };
  }
  function command(r: Row): SignInCommand {
    const argv = r.provider === 'claude' ? [binary(r.provider), 'auth', 'login', '--claudeai'] : [binary(r.provider), 'login', '--device-auth'];
    const passed = spawnEnv(r); const completion = complete(r); const lock = join(r.folder, '.byokit-signin-lock');
    const login = ['/usr/bin/env', '-i', ...Object.entries(passed).map(([k, v]) => `${k}=${v}`), ...argv].map(quote).join(' ');
    // Cross-process guard: a native CLI owns any refresh transaction; the kit never copies or refreshes its grants.
    const shell = `(umask 077; /bin/mkdir ${quote(lock)} || exit 1; trap ${quote(`/bin/rmdir ${quote(lock)}`)} EXIT; ${login} && (set -C; printf complete > ${quote(completion)}))`;
    return { argv, env: passed, completion, shell };
  }
  function begin(r: Row): SignInCommand {
    const result = command(r);
    // Refuse overlapping sign-in starts; reuse the pending command until completion or cancel.
    if (!marker(pending(r)) || marker(complete(r))) {
      rmSync(complete(r), { force: true });
      if (!marker(pending(r))) writeFileSync(pending(r), '', { mode: 0o600, flag: 'wx' });
    }
    return result;
  }
  function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const task = (operations.get(id) ?? Promise.resolve()).then(action, action);
    operations.set(id, task);
    return task.finally(() => { if (operations.get(id) === task) operations.delete(id); });
  }
  async function readIdentity(r: Row): Promise<Identity> {
    if (r.provider === 'codex') return identity({ provider: 'codex', bin: binary('codex'), home: r.folder, env: spawnEnv(r) });
    return new Promise((accept) => {
      const child = spawn(binary('claude'), ['auth', 'status'], { env: spawnEnv(r), stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = ''; let bytes = 0; let settled = false; let escalation: NodeJS.Timeout | undefined;
      const finish = (answer: Identity) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
        }
        accept(answer);
      };
      const timer = setTimeout(() => finish({ signedIn: false }), 15_000);
      child.once('error', () => finish({ signedIn: false }));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256 * 1024) { finish({ signedIn: false }); return; }
        stdout += chunk;
      });
      child.once('close', () => {
        clearTimeout(escalation);
        if (settled) return;
        if (bytes > 64 * 1024) { finish({ signedIn: false }); return; }
        let raw: unknown; try { raw = JSON.parse(stdout); } catch { finish({ signedIn: false }); return; }
        if (!record(raw) || raw.loggedIn !== true) { finish({ signedIn: false }); return; }
        const email = typeof raw.email === 'string' && raw.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.email) ? raw.email : undefined;
        const plan = [raw.subscriptionType, raw.plan, raw.planName, raw.tier].find((v) => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9 _+-]{0,63}$/.test(v));
        finish({ signedIn: true, ...(email ? { email } : {}), ...(typeof plan === 'string' ? { plan } : {}) });
      });
    });
  }
  function suggestName(email: string | undefined, provider: CliProvider): string {
    const first = email?.split('@')[0]?.split(/[._-]+/).find(Boolean);
    return first ? (first[0].toUpperCase() + first.slice(1).toLowerCase()).slice(0, 64) : provider === 'claude' ? 'Claude' : 'Codex';
  }
  async function status(id: string): Promise<CliAccount> {
    return serial(id, async () => {
      const r = row(id);
      const signing = marker(pending(r)) && !marker(complete(r));
      if (signing) return { id: r.id, provider: r.provider, name: r.name.trim() || suggestName(undefined, r.provider), billing: 'subscription', state: 'signing' };
      const info = await readIdentity(r);
      if (marker(pending(r))) rmSync(pending(r), { force: true });
      // Pre-existing roster rows have no kit marker; their native status remains authoritative.
      return { id: r.id, provider: r.provider, name: r.name.trim() || suggestName(info.email, r.provider), billing: 'subscription', state: info.signedIn ? 'ready' : 'signed_out', ...(info.email ? { email: info.email } : {}), ...(info.plan ? { plan: info.plan } : {}) };
    });
  }
  async function remove(id: string) {
    return serial(id, async () => { const r = row(id); rmSync(r.folder, { recursive: true, force: true }); save(load().filter((v) => v.id !== id)); created.delete(id); });
  }
  return {
    list: async (): Promise<CliAccount[]> => Promise.all(load().filter((r) => !r.found && !r.id.startsWith('found-')).map((r) => status(r.id))),
    async add(provider: CliProvider): Promise<{ account: CliAccount; signIn: SignInCommand }> {
      if (!providers.includes(provider)) throw new CliAccountError('bad-option');
      binary(provider);
      const parent = join(stateDir, provider); if (!directory(stateDir) || !directory(parent, true)) throw new CliAccountError('bad-option');
      chmodSync(parent, 0o700);
      const r: Row = { id: `pa_${randomBytes(9).toString('hex')}`, provider, name: '', folder: join(parent, randomBytes(8).toString('hex')), found: false };
      mkdirSync(r.folder, { mode: 0o700 });
      try {
        if (history[provider]) symlinkSync(history[provider]!, join(r.folder, provider === 'claude' ? 'projects' : 'sessions'), 'dir');
        const signIn = begin(r);
        await options.prepare?.(r.folder, provider);
        if (!safe(r)) throw new CliAccountError('prepare-failed');
        save([...load(), r]); created.add(r.id);
        return { account: { id: r.id, provider, name: suggestName(undefined, provider), billing: 'subscription', state: 'signing' }, signIn };
      } catch { rmSync(r.folder, { recursive: true, force: true }); throw new CliAccountError('prepare-failed'); }
    },
    signInAgain: (id: string): SignInCommand => {
      if (operations.has(id)) throw new CliAccountError('prepare-failed');
      return begin(row(id));
    },
    status,
    async cancel(id: string): Promise<{ removed: boolean }> {
      if (created.has(id)) { await remove(id); return { removed: true }; }
      return serial(id, async () => { const r = row(id); rmSync(pending(r), { force: true }); return { removed: false }; });
    },
    async rename(id: string, name: string): Promise<CliAccount> {
      if (!text(name) || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new CliAccountError('invalid-name');
      await serial(id, async () => { row(id); const rows = load(); rows.find((r) => r.id === id)!.name = name.trim(); save(rows); });
      return status(id);
    },
    remove,
    launchEnv: (id: string) => launch(row(id)),
    kinds: (provider: CliProvider): string[] => providers.includes(provider) ? [provider] : [],
    resumeArgs(kind: string, ref: { kind: 'id' | 'path'; value: string }): string[] {
      if (!text(ref.value) || !ref.value || (kind !== 'claude' && kind !== 'codex') || (kind === 'claude' && ref.kind !== 'id') || (kind === 'codex' && ref.kind !== 'id')) throw new CliAccountError('kind-mismatch');
      return kind === 'claude' ? ['--resume', ref.value] : ['resume', ref.value];
    },
    usageSource(id: string): { provider: 'codex'; bin: string; home: string; env: Record<string, string> } | undefined {
      const r = row(id); return r.provider === 'codex' ? { provider: 'codex', bin: binary('codex'), home: r.folder, env: spawnEnv(r) } : undefined;
    },
    termsAcknowledged: (): boolean => { if (!directory(stateDir)) throw new CliAccountError('bad-option'); const saved = json(join(stateDir, 'auto-terms-v1.json')); return record(saved) && saved.acknowledged === true; },
    acknowledgeTerms: () => atomic(join(stateDir, 'auto-terms-v1.json'), { acknowledged: true }),
    suggestName,
  };
}
