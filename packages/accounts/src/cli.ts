import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { identity, type Identity } from '@byokit/usage';
import { say } from './words.ts';
import { launchEnv as cleanLaunchEnv } from './isolate.ts';
import type { AccountLike } from './multi.ts';
import routes from './routes.json' with { type: 'json' };

export type CliProvider = 'claude' | 'codex' | 'pi';
/** Published Pi subscription OAuth provider id, validated against the route catalogue. */
export type PiProvider = string;
/** Shared selection surface; the CLI entry remains Node-only. */
export type CliAccount = AccountLike & { provider: CliProvider; billing: 'subscription'; email?: string; plan?: string; piProvider?: PiProvider; adoptedFrom?: string; why?: 'api_key' | 'unknown' };
export type CliOptions = {
  stateDir: string;
  bins: Partial<Record<CliProvider, string>>;
  env: { PATH: string; HOME: string } & Record<string, string>;
  historyFrom?: Partial<Record<CliProvider, string>>;
  prepare?: (folder: string, provider: CliProvider) => Promise<void>;
};
export type SignInCommand = { argv: string[]; env: Record<string, string>; completion: string; shell: string;
  /** Display in the TUI; never pass this as an initial model message. */
  instruction?: { words: 'cli.piLogin'; command: `/login ${string}` };
};
export class CliAccountError extends Error {
  override name = 'CliAccountError';
  readonly code: 'unknown-account' | 'invalid-name' | 'kind-mismatch' | 'prepare-failed' | 'bad-option';
  constructor(code: CliAccountError['code']) {
    super(say(({ 'unknown-account': 'cli.unknownAccount', 'invalid-name': 'cli.invalidName', 'kind-mismatch': 'cli.kindMismatch', 'prepare-failed': 'cli.prepareFailed', 'bad-option': 'cli.badOption' } as const)[code]));
    this.code = code;
  }
}
type Row = { id: string; provider: CliProvider; name: string; folder: string; found: boolean; piProvider?: PiProvider; adoptedFrom?: string };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
const providers: CliProvider[] = ['claude', 'codex', 'pi'];
const piRoutes = routes.filter(r => r.upstream.surface === 'accounts' && r.billing === 'subscription' && r.upstream.flow === 'present' && (r.via === 'browser' || r.via === 'code'));
const validPiProvider = (p: unknown): p is PiProvider => text(p) && piRoutes.some(r => r.upstream.id === p);
const shed = {
  claude: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  pi: ['PI_CODING_AGENT_SESSION_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'],
};
const folderVar = (p: CliProvider) => p === 'claude' ? 'CLAUDE_CONFIG_DIR' : p === 'pi' ? 'PI_CODING_AGENT_DIR' : 'CODEX_HOME';
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
export type NativePiAccount = {
  kind: 'pi'; bin: string;
  launch: { set: { PI_CODING_AGENT_DIR: string }; unset: string[] };
  resumeArgs(ref: { kind: 'id' | 'path'; value: string }): string[];
};
/** Read-only Pi 0.87.1 launch descriptor; no grant reads, sign-in or readiness claim. */
export function nativePiAccount(options: { stateDir: string; folder: string; bin: string; home: string }): NativePiAccount {
  if (!record(options) || [options.stateDir, options.folder, options.bin, options.home].some(v => !text(v) || !isAbsolute(v))) throw new CliAccountError('bad-option');
  const stateDir = resolve(options.stateDir); const parent = join(stateDir, 'pi'); const folder = resolve(options.folder);
  for (const path of ['.claude', '.codex', '.pi']) {
    const own = join(resolve(options.home), path);
    if (stateDir === own || stateDir.startsWith(own + '/')) throw new CliAccountError('bad-option');
  }
  if (!folder.startsWith(parent + '/') || !/^[a-f0-9]+$/.test(folder.slice(parent.length + 1))) throw new CliAccountError('bad-option');
  try {
    for (const path of [stateDir, parent, folder]) {
      if (!directory(path) || realpathSync(path) !== path) throw new CliAccountError('bad-option');
    }
  } catch { throw new CliAccountError('bad-option'); }
  return {
    kind: 'pi', bin: options.bin,
    launch: { set: { PI_CODING_AGENT_DIR: folder }, unset: ['PI_CODING_AGENT_SESSION_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] },
    resumeArgs(ref) {
      if (!record(ref) || (ref.kind !== 'id' && ref.kind !== 'path') || !text(ref.value) || !ref.value || ref.value.startsWith('-')) throw new CliAccountError('kind-mismatch');
      return ['--session', ref.value];
    },
  };
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
    const seen = new Set<string>(); const rows: Row[] = [];
    for (const path of [file, join(stateDir, 'pi-accounts-v1.json')]) {
      const saved = json(path); if (!record(saved) || !Array.isArray(saved.accounts)) continue;
      for (const candidate of saved.accounts) {
        if (!record(candidate) || !text(candidate.id) || !candidate.id || candidate.id.length > 128 || seen.has(candidate.id) || !providers.includes(candidate.provider as CliProvider) || !text(candidate.name) || candidate.name.length > 64 || !text(candidate.folder) || typeof candidate.found !== 'boolean') continue;
        const r: Row = { id: candidate.id, provider: candidate.provider as CliProvider, name: candidate.name, folder: candidate.folder, found: candidate.found };
        if (candidate.adoptedFrom !== undefined) {
          if (!text(candidate.adoptedFrom) || !candidate.adoptedFrom.startsWith('found-') || candidate.adoptedFrom.length > 128) continue;
          r.adoptedFrom = candidate.adoptedFrom;
        }
        if (r.provider === 'pi') {
          if (validPiProvider(candidate.piProvider)) r.piProvider = candidate.piProvider;
          else if (!r.found && !r.id.startsWith('found-')) continue;
          if (path === file && !r.found && !r.id.startsWith('found-')) continue;
        } else if (path !== file) continue;
        // Host-owned rows remain byte-compatible in the roster, without touching their folder.
        if (!r.found && !r.id.startsWith('found-') && !safe(r)) continue;
        seen.add(r.id); rows.push(r);
      }
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
  // Separate Pi roster keeps older Claude/Codex loaders from deleting managed Pi identities.
  const save = (rows: Row[], provider: CliProvider) => atomic(provider === 'pi' ? join(stateDir, 'pi-accounts-v1.json') : file,
    { version: 1, accounts: rows.filter(r => provider === 'pi' ? r.provider === 'pi' && !r.found && !r.id.startsWith('found-') : r.provider !== 'pi' || r.found || r.id.startsWith('found-')) });
  function row(id: string): Row {
    const r = load().find((r) => r.id === id && !r.found && !r.id.startsWith('found-'));
    if (!r) throw new CliAccountError('unknown-account');
    return r;
  }
  function binary(p: CliProvider): string { const bin = bins[p]; if (!bin) throw new CliAccountError('bad-option'); return bin; }
  function launch(r: Row) { return { set: { [folderVar(r.provider)]: r.folder }, unset: [...shed[r.provider]] }; }
  function spawnEnv(r: Row) {
    return cleanLaunchEnv({ base: env, account: launch(r) }).env;
  }
  function command(r: Row): SignInCommand {
    const argv = r.provider === 'pi' ? [binary('pi')] : r.provider === 'claude' ? [binary(r.provider), 'auth', 'login', '--claudeai'] : [binary(r.provider), 'login', '--device-auth'];
    const passed = spawnEnv(r); const completion = complete(r); const lock = join(r.folder, '.byokit-signin-lock');
    const login = ['/usr/bin/env', '-i', ...Object.entries(passed).map(([k, v]) => `${k}=${v}`), ...argv].map(quote).join(' ');
    // Cross-process guard: a native CLI owns any refresh transaction; the kit never copies or refreshes its grants.
    const shell = `(umask 077; /bin/mkdir ${quote(lock)} || exit 1; trap ${quote(`/bin/rmdir ${quote(lock)}`)} EXIT; ${login}${r.provider === 'pi' ? '' : ` && (set -C; printf complete > ${quote(completion)})`})`;
    return { argv, env: passed, completion, shell, ...(r.provider === 'pi' ? { instruction: { words: 'cli.piLogin' as const, command: `/login ${r.piProvider}` as const } } : {}) };
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
  async function readIdentity(r: Row): Promise<Identity & { why?: 'api_key' | 'unknown' }> {
    if (r.provider === 'codex') return identity({ provider: 'codex', bin: binary('codex'), home: r.folder, env: spawnEnv(r) });
    return new Promise((accept) => {
      const failed = { signedIn: false, ...(r.provider === 'pi' ? { why: 'unknown' as const } : {}) };
      const child = spawn(binary(r.provider), r.provider === 'pi' ? ['auth', 'check', '--provider', r.piProvider!, '--json', '--no-refresh'] : ['auth', 'status'], { env: spawnEnv(r), stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = ''; let bytes = 0; let settled = false; let escalation: NodeJS.Timeout | undefined;
      const finish = (answer: Identity & { why?: 'api_key' | 'unknown' }) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
        }
        accept(answer);
      };
      const timer = setTimeout(() => finish(failed), 15_000);
      child.once('error', () => finish(failed));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > (r.provider === 'pi' ? 64 : 256) * 1024) { finish(failed); return; }
        stdout += chunk;
      });
      child.once('close', () => {
        clearTimeout(escalation);
        if (settled) return;
        if (bytes > 64 * 1024) { finish(failed); return; }
        let raw: unknown; try { raw = JSON.parse(stdout); } catch { finish(failed); return; }
        if (r.provider === 'pi') {
          if (!record(raw) || raw.provider !== r.piProvider) { finish(failed); return; }
          if (child.exitCode === 0 && raw.status === 'ready' && raw.authType === 'oauth') finish({ signedIn: true });
          else if (child.exitCode === 0 && raw.status === 'ready' && raw.authType === 'api_key') finish({ signedIn: false, why: 'api_key' });
          else if (child.exitCode === 1 && raw.status === 'not_ready') finish({ signedIn: false });
          else finish(failed);
          return;
        }
        if (!record(raw) || raw.loggedIn !== true) { finish({ signedIn: false }); return; }
        const email = typeof raw.email === 'string' && raw.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.email) ? raw.email : undefined;
        const plan = [raw.subscriptionType, raw.plan, raw.planName, raw.tier].find((v) => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9 _+-]{0,63}$/.test(v));
        finish({ signedIn: true, ...(email ? { email } : {}), ...(typeof plan === 'string' ? { plan } : {}) });
      });
    });
  }
  function suggestName(email: string | undefined, provider: CliProvider): string {
    const first = email?.split('@')[0]?.split(/[._-]+/).find(Boolean);
    return first ? (first[0].toUpperCase() + first.slice(1).toLowerCase()).slice(0, 64) : provider === 'claude' ? 'Claude' : provider === 'pi' ? 'Pi' : 'Codex';
  }
  async function status(id: string): Promise<CliAccount> {
    return serial(id, async () => {
      const r = row(id);
      const account = { id: r.id, provider: r.provider, name: r.name.trim() || (r.provider === 'pi' ? piRoutes.find(v => v.upstream.id === r.piProvider)!.name : suggestName(undefined, r.provider)), billing: 'subscription' as const,
        ...(r.piProvider ? { piProvider: r.piProvider } : {}), ...(r.adoptedFrom ? { adoptedFrom: r.adoptedFrom } : {}) };
      if (!bins[r.provider]) return { ...account, state: 'not_included' };
      const signing = marker(pending(r)) && !marker(complete(r));
      if (signing && r.provider !== 'pi') return { ...account, state: 'signing' };
      const info = await readIdentity(r);
      if (marker(pending(r)) && (r.provider !== 'pi' || info.signedIn)) rmSync(pending(r), { force: true });
      // Pre-existing roster rows have no kit marker; their native status remains authoritative.
      return { ...account, name: r.name.trim() || (r.provider === 'pi' ? account.name : suggestName(info.email, r.provider)), state: info.signedIn ? 'ready' : signing && !info.why ? 'signing' : 'signed_out', ...(info.why ? { why: info.why } : {}), ...(info.email ? { email: info.email } : {}), ...(info.plan ? { plan: info.plan } : {}) };
    });
  }
  async function remove(id: string) {
    return serial(id, async () => { const r = row(id); rmSync(r.folder, { recursive: true, force: true }); save(load().filter((v) => v.id !== id), r.provider); created.delete(id); });
  }
  type Added = { account: CliAccount; signIn: SignInCommand };
  function add(provider: 'pi', metadata: { piProvider: PiProvider }): Promise<Added>;
  function add(provider: 'claude' | 'codex'): Promise<Added>;
  function add(provider: CliProvider, metadata?: { piProvider?: PiProvider }): Promise<Added> { return addManaged(provider, metadata); }
  async function addManaged(provider: CliProvider, metadata?: { piProvider?: PiProvider }, adopted?: Row): Promise<Added> {
    if (!providers.includes(provider) || (provider === 'pi' && !validPiProvider(metadata?.piProvider))) throw new CliAccountError('bad-option');
    binary(provider);
    const parent = join(stateDir, provider); if (!directory(stateDir) || !directory(parent, true)) throw new CliAccountError('bad-option');
    chmodSync(parent, 0o700);
    const r: Row = { id: `pa_${randomBytes(9).toString('hex')}`, provider, name: adopted?.name ?? '', folder: join(parent, randomBytes(8).toString('hex')), found: false,
      ...(provider === 'pi' ? { piProvider: metadata!.piProvider } : {}), ...(adopted ? { adoptedFrom: adopted.id } : {}) };
    mkdirSync(r.folder, { mode: 0o700 });
    try {
      if (history[provider]) symlinkSync(history[provider]!, join(r.folder, provider === 'claude' ? 'projects' : 'sessions'), 'dir');
      const signIn = begin(r);
      await options.prepare?.(r.folder, provider);
      if (!safe(r)) throw new CliAccountError('prepare-failed');
      save([...load(), r], provider); created.add(r.id);
      return { account: { id: r.id, provider, name: r.name || (provider === 'pi' ? piRoutes.find(v => v.upstream.id === r.piProvider)!.name : suggestName(undefined, provider)), billing: 'subscription', state: 'signing', ...(r.piProvider ? { piProvider: r.piProvider } : {}), ...(r.adoptedFrom ? { adoptedFrom: r.adoptedFrom } : {}) }, signIn };
    } catch { rmSync(r.folder, { recursive: true, force: true }); throw new CliAccountError('prepare-failed'); }
  }
  return {
    list: async (): Promise<CliAccount[]> => Promise.all(load().filter((r) => !r.found && !r.id.startsWith('found-')).map((r) => status(r.id))),
    add,
    adopt: (foundId: string, metadata?: { piProvider?: PiProvider }): Promise<Added> => serial(foundId, async () => {
      const rows = load();
      const found = rows.find(r => r.id === foundId && r.id.startsWith('found-'));
      if (!found) throw new CliAccountError('unknown-account');
      const adopted = rows.find(r => !r.found && !r.id.startsWith('found-') && r.adoptedFrom === foundId);
      if (adopted) {
        if (operations.has(adopted.id)) throw new CliAccountError('prepare-failed');
        const signIn = begin(adopted);
        return { account: await status(adopted.id), signIn };
      }
      // Only metadata seeds a new empty folder; never inspect or copy the discovered source.
      return addManaged(found.provider, metadata, found);
    }),
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
      await serial(id, async () => { const r = row(id); const rows = load(); rows.find((r) => r.id === id)!.name = name.trim(); save(rows, r.provider); });
      return status(id);
    },
    remove,
    launchEnv: (id: string) => launch(row(id)),
    launchArgs: (id: string): string[] => { const r = row(id); return r.provider === 'pi' ? ['--provider', r.piProvider!] : []; },
    kinds: (provider: CliProvider): string[] => providers.includes(provider) ? [provider] : [],
    resumeArgs(kind: string, ref: { kind: 'id' | 'path'; value: string }): string[] {
      if (!record(ref) || !text(ref.value) || !ref.value || ref.value.startsWith('-') || !providers.includes(kind as CliProvider) || (ref.kind !== 'id' && (kind !== 'pi' || ref.kind !== 'path'))) throw new CliAccountError('kind-mismatch');
      return kind === 'pi' ? ['--session', ref.value] : kind === 'claude' ? ['--resume', ref.value] : ['resume', ref.value];
    },
    usageSource(id: string): { provider: 'codex'; bin: string; home: string; env: Record<string, string> } | undefined {
      const r = row(id); return r.provider === 'codex' ? { provider: 'codex', bin: binary('codex'), home: r.folder, env: spawnEnv(r) } : undefined;
    },
    termsAcknowledged: (): boolean => { if (!directory(stateDir)) throw new CliAccountError('bad-option'); const saved = json(join(stateDir, 'auto-terms-v1.json')); return record(saved) && saved.acknowledged === true; },
    acknowledgeTerms: () => atomic(join(stateDir, 'auto-terms-v1.json'), { acknowledged: true }),
    suggestName,
  };
}
