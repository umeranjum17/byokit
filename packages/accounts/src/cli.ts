import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { identity, roomOf, usage, type Identity, type PiProvider as UsagePiProvider, type Reading, type Room, type Source, type Usage } from '@byokit/usage';
import type { Keystore } from '@byokit/secrets';
import { clock, say } from './words.ts';
import { OPENCODE_GO_PLAN_ROUTE, deleteOpenCodePlanKey, openCodeWorkspace, openCodeWorkspaceEntry, readOpenCodePlanKey, readOpenCodeWorkspace, saveOpenCodePlanKey, saveOpenCodeWorkspace } from './opencode-go.ts';
import { launchEnv as cleanLaunchEnv } from './isolate.ts';
import type { AccountLike, UnknownReason } from './multi.ts';
import routes from './routes.json' with { type: 'json' };
export { remoteCliHost, remoteCliState, type RemoteCliHostOptions } from './remote-cli-host.ts';
export { poolPrepare, type PoolPrepareOptions } from './prepare.ts';

export type SignInMethod = 'subscription' | 'api_key' | 'other';
export type CliProvider = 'claude' | 'codex' | 'pi' | 'opencode' | 'kimi' | 'vibe' | 'cursor';
/** Published Pi subscription OAuth provider id, validated against the route catalogue. */
export type PiProvider = string;
/** Shared selection surface; the CLI entry remains Node-only. */
export type CliAccount = AccountLike & { provider: CliProvider; billing: 'subscription'; email?: string; plan?: string;
  /** How a signed-in Claude is signed in, as its own status command reports it: a Claude subscription, an API key, or another route
   *  (a cloud provider or token). Absent for the other CLIs and when the CLI does not say. */
  method?: SignInMethod; piProvider?: PiProvider; adoptedFrom?: string; why?: 'api_key' | 'unknown'; addedAt?: number;
  /** The CLI installed on this computer, signed in (or not) under the app's `env.HOME`: no folder of its own. */
  installed?: true;
  /** Why an installed row is not signed in, in plain words. */
  cause?: string;
  /** A failed Codex readiness probe, not a confirmed signed-out reply. Safe metadata only. */
  probeFailure?: Identity['probeFailure'];
  /** Only while `state` is 'unknown' (the status check gave no answer): why, and when to ask again. */
  reason?: UnknownReason; retryAfterMs?: number };
export type CliOptions = {
  stateDir: string;
  bins: Partial<Record<CliProvider, string>>;
  env: { PATH: string; HOME: string } & Record<string, string>;
  historyFrom?: Partial<Record<CliProvider, string>>;
  /** Explicit runtime-owned folders inside stateDir; never removed with roster bookkeeping. */
  managedFolders?: { claude?: string; codex?: string };
  prepare?: (folder: string, provider: CliProvider) => Promise<void>;
  /** Device-owned secrets backend for key-based providers (OpenCode, Vibe): `saveKey` writes the key
   * here, one entry per managed account, and `logout` deletes that account's entry. The key never
   * enters argv, env, or a log; OpenCode `launch` additionally writes it to the account folder's
   * `go.key` delivery copy (0600), which `logout` and `remove` delete. */
  keyStore?: Keystore;
  /** The app's own `@byokit/usage` reader for `pick`. Omitted, each `pick` uses an internal reader on
   * `stateDir`, so readings and the app's account roster stay in one root. */
  usage?: Usage;
  /** Claude's two app-passed headers for the managed-folder usage source (the kit never invents a
   * client identity). Without them, Claude room is unknown. */
  claudeHeaders?: { 'anthropic-beta': string; 'User-Agent': string };
  /** Reaches the OpenCode console when an OpenCode key saved without a workspace is launched (default: global fetch). */
  fetch?: typeof fetch;
  /** Also list each installed Claude, Codex and Cursor `bins` entry as it runs under `env.HOME` (id `installed-<provider>`),
   * read with the CLI's own status command. It launches with no folder variable; it cannot be renamed, rested or removed. */
  installed?: boolean;
};
export type CliLaunchResult =
  | { ok: true; account: CliAccount; set: Record<string, string>; unset: string[]; args?: string[] }
  | { ok: false; code: 'signed_out' | 'not_included' | 'resting' | 'unknown'; account: CliAccount; message: string };
export type CliRest = { until: number; why: string };
/** One managed row of a provider with its room reading, for `pick` and the `list` view of the same rows. */
export type CliPickRow = { account: CliAccount; room: Room; windows: Reading['windows']; readAt?: number };
export type CliPick =
  | { ok: true; account: CliAccount; room: Room; rows: CliPickRow[] }
  | { ok: false; code: 'none'; reason: string; rows: CliPickRow[] };
export type SignInCommand = { argv: string[]; env: Record<string, string>; completion: string; shell: string;
  /** Display in the TUI; never pass this as an initial model message. OpenCode and Vibe have no native
   * login to spawn: their instruction asks for a hidden key entry instead, and `saveKey` completes it. */
  instruction?: { words: 'cli.piLogin'; command: `/login ${string}` } | { words: 'cli.opencodeKey' } | { words: 'cli.vibeKey' };
};
/** Secrets route for managed Vibe API keys (`accounts.vibe:key.<accountId>`). */
export const VIBE_API_KEY_ROUTE = 'vibe:key';
export class CliAccountError extends Error {
  override name = 'CliAccountError';
  readonly code: 'unknown-account' | 'invalid-name' | 'kind-mismatch' | 'prepare-failed' | 'bad-option' | 'model-required';
  constructor(code: CliAccountError['code']) {
    super(code === 'model-required' ? 'Choose a model for Pi before starting it.' : say(({ 'unknown-account': 'cli.unknownAccount', 'invalid-name': 'cli.invalidName', 'kind-mismatch': 'cli.kindMismatch', 'prepare-failed': 'cli.prepareFailed', 'bad-option': 'cli.badOption' } as const)[code]));
    this.code = code;
  }
}
function piArgs(model?: string, provider?: string): string[] {
  if (typeof model !== 'string' || !model.trim() || /[\s\0]/.test(model) || model.startsWith('-') || !model.split(':')[0] || model.split(':')[0]!.endsWith('/')) throw new CliAccountError('model-required');
  return [...(provider ? ['--provider', provider] : []), '--model', model];
}
type Row = { id: string; provider: CliProvider; name: string; folder: string; found: boolean; piProvider?: PiProvider; adoptedFrom?: string; addedAt?: number; installed?: true };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
const providers: CliProvider[] = ['claude', 'codex', 'pi', 'opencode', 'kimi', 'vibe', 'cursor'];
/** The CLIs with one non-secret status command for their own login (Pi's is per provider; Kimi, OpenCode and Vibe have none). */
const installable: CliProvider[] = ['claude', 'codex', 'cursor'];
const piRoutes = routes.filter(r => r.upstream.surface === 'accounts' && r.billing === 'subscription' && r.upstream.flow === 'present' && (r.via === 'browser' || r.via === 'code'));
const validPiProvider = (p: unknown): p is PiProvider => text(p) && piRoutes.some(r => r.upstream.id === p);
/** The Pi provider ids a BYOKit-owned quota route reads the folder login for; every other Pi row stays unknown. */
const piRoomProvider = (p: unknown): p is UsagePiProvider => p === 'openai-codex' || p === 'kimi-coding';
const shed = {
  claude: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  pi: ['PI_CODING_AGENT_SESSION_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'],
  opencode: ['OPENCODE_API_KEY', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DB', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'],
  // Kimi Code stores OAuth under KIMI_CODE_HOME; unset key/path overrides so a host key cannot replace the managed login.
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_CODE_CREDENTIALS', 'KIMI_CREDENTIALS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'],
  vibe: ['MISTRAL_API_KEY'],
  // Cursor keeps its login in `$XDG_CONFIG_HOME/cursor/auth.json`; unset the key/token overrides so a host
  // value cannot replace the managed folder's own login.
  cursor: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'],
};
const folderVar = (p: CliProvider) => p === 'claude' ? 'CLAUDE_CONFIG_DIR' : p === 'pi' ? 'PI_CODING_AGENT_DIR' : p === 'opencode' ? 'OPENCODE_CONFIG_DIR' : p === 'kimi' ? 'KIMI_CODE_HOME' : p === 'vibe' ? 'VIBE_HOME' : p === 'cursor' ? 'XDG_CONFIG_HOME' : 'CODEX_HOME';
const keyRoute = (p: 'opencode' | 'vibe') => p === 'opencode' ? OPENCODE_GO_PLAN_ROUTE : VIBE_API_KEY_ROUTE;
const keyLabel = (p: 'opencode' | 'vibe') => p === 'opencode' ? 'OpenCode' : 'Vibe';
const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
const complete = (r: Row) => join(r.folder, '.byokit-signin-complete');
const pending = (r: Row) => join(r.folder, '.byokit-signin-pending');
const opencodeKeyPath = (folder: string) => join(folder, 'go.key');
const opencodeConfigPath = (folder: string) => join(folder, 'opencode.json');
/** Write the OpenCode folder's delivery copies: the plan key to `go.key` (0600) and the provider
 * config pointing at it, so the key reaches the process through `{file:}` substitution; a workspace
 * rides the same config as `x-opencode-org-id`, the header the desktop OpenCode login itself stores. */
function writeOpencodeLaunchFiles(folder: string, key: string, workspace?: string): void {
  chmodSync(folder, 0o700);
  const options = { apiKey: `{file:${opencodeKeyPath(folder)}}`, ...(workspace ? { headers: { 'x-opencode-org-id': workspace } } : {}) };
  const config = JSON.stringify({ provider: { 'opencode-go': { options } } });
  for (const [path, value] of [[opencodeKeyPath(folder), key], [opencodeConfigPath(folder), config]]) {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(tmp, value, { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
    finally { rmSync(tmp, { force: true }); }
  }
}
/** Delete the OpenCode folder's delivery copies; a missing copy is already gone, not a failure. */
function removeOpencodeLaunchFiles(folder: string): void {
  rmSync(opencodeKeyPath(folder), { force: true });
  rmSync(opencodeConfigPath(folder), { force: true });
}
/** Shared lock: the shell records its native child PID; the remote driver records its host PID. */
export function signInLock(folder: string): { lock: string; holder: string } {
  const lock = join(folder, '.byokit-signin-lock');
  return { lock, holder: join(lock, 'holder') };
}
export function holderAlive(holder: string): boolean {
  let pid: number;
  try { pid = Number(readFileSync(holder, 'utf8')); } catch { return true; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function signInHeld(folder: string): boolean {
  const { lock, holder } = signInLock(folder);
  return existsSync(lock) && holderAlive(holder);
}
function marker(file: string): boolean {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CliAccountError('bad-option');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
// A managed folder outlives its roster row, so an existing history link (or a real history directory) is kept.
function historyLink(source: string, link: string) {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try { stat = lstatSync(link); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (stat && (!stat.isSymbolicLink() || readlinkSync(link) === source)) return;
  if (stat) unlinkSync(link);
  symlinkSync(source, link, 'dir');
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
function folderAddedAt(folder: string): number | undefined {
  try {
    const s = lstatSync(folder);
    if (Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0) return Math.floor(s.birthtimeMs);
    const times = [s.ctimeMs, s.mtimeMs].filter((v) => Number.isFinite(v) && v > 0);
    return times.length ? Math.floor(Math.min(...times)) : undefined;
  } catch { return undefined; }
}
export type NativePiAccount = {
  kind: 'pi'; bin: string; args: string[];
  launch: { set: { PI_CODING_AGENT_DIR: string }; unset: string[] };
  resumeArgs(ref: { kind: 'id' | 'path'; value: string }): string[];
};
/** Read-only Pi launch descriptor; no grant reads, sign-in or readiness claim. */
export function nativePiAccount(options: { stateDir: string; folder: string; bin: string; home: string; model?: string }): NativePiAccount {
  const args = piArgs(options?.model);
  if (!record(options) || [options.stateDir, options.folder, options.bin, options.home].some(v => !text(v) || !isAbsolute(v))) throw new CliAccountError('bad-option');
  const stateDir = resolve(options.stateDir); const parent = join(stateDir, 'pi'); const folder = resolve(options.folder);
  for (const path of ['.claude', '.codex', '.pi', '.kimi-code']) {
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
    kind: 'pi', bin: options.bin, args,
    launch: { set: { PI_CODING_AGENT_DIR: folder }, unset: ['PI_CODING_AGENT_SESSION_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] },
    resumeArgs(ref) {
      if (!record(ref) || (ref.kind !== 'id' && ref.kind !== 'path') || !text(ref.value) || !ref.value || ref.value.startsWith('-')) throw new CliAccountError('kind-mismatch');
      return ['--session', ref.value];
    },
  };
}

/** The one usage source for a Pi row: the folder login read in process by `@byokit/usage`. */
function piRoomSource(r: Row): { provider: 'pi'; folder: string; piProvider: UsagePiProvider } | undefined {
  return piRoomProvider(r.piProvider) ? { provider: 'pi', folder: r.folder, piProvider: r.piProvider } : undefined;
}
/** Only app-managed folders and explicitly supplied absolute CLI binaries. */
export function cliAccounts(options: CliOptions) {
  if (!record(options) || !text(options.stateDir) || !isAbsolute(options.stateDir) || !record(options.bins) || !record(options.env) || !text(options.env.PATH) || !text(options.env.HOME) || !isAbsolute(options.env.HOME)) throw new CliAccountError('bad-option');
  if (Object.entries(options.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || !text(v))) throw new CliAccountError('bad-option');
  if (Object.entries(options.bins).some(([p, bin]) => !providers.includes(p as CliProvider) || !text(bin) || !isAbsolute(bin))) throw new CliAccountError('bad-option');
  if (options.historyFrom && (!record(options.historyFrom) || Object.entries(options.historyFrom).some(([p, path]) => !providers.includes(p as CliProvider) || !text(path) || !isAbsolute(path)))) throw new CliAccountError('bad-option');
  if (options.keyStore !== undefined && (!record(options.keyStore) || typeof (options.keyStore as Keystore).get !== 'function' || typeof (options.keyStore as Keystore).set !== 'function' || typeof (options.keyStore as Keystore).delete !== 'function')) throw new CliAccountError('bad-option');
  if (options.usage !== undefined && (!record(options.usage) || typeof (options.usage as Usage).read !== 'function' || typeof (options.usage as Usage).connected !== 'function')) throw new CliAccountError('bad-option');
  if (options.installed !== undefined && typeof options.installed !== 'boolean') throw new CliAccountError('bad-option');
  if (options.claudeHeaders !== undefined && (!record(options.claudeHeaders) || ['anthropic-beta', 'User-Agent'].some((key) => !text((options.claudeHeaders as Record<string, unknown>)[key]) || (options.claudeHeaders as Record<string, string>)[key].length > 1024))) throw new CliAccountError('bad-option');
  const stateDir = resolve(options.stateDir); const env = { ...options.env }; const bins = { ...options.bins }; const history = { ...options.historyFrom };
  const ownsDefaultLogin = (path: string) => ['.claude', '.codex', '.pi', '.kimi-code', '.vibe', '.config/cursor'].some((p) => { const own = join(resolve(env.HOME), p); return path === own || path.startsWith(own + '/'); });
  const managedFolders = Object.fromEntries(Object.entries(options.managedFolders ?? {}).filter(([, folder]) => folder !== undefined)) as { claude?: string; codex?: string };
  // The login files each native CLI keeps in its own folder; remove deletes these and keeps the folder.
  const managedLoginFiles: Partial<Record<CliProvider, string[]>> = { claude: ['.credentials.json', '.claude.json'], codex: ['auth.json'] };
  if (options.managedFolders && (!record(options.managedFolders) || Object.entries(managedFolders).some(([p, folder]) =>
    (p !== 'claude' && p !== 'codex') || !text(folder) || resolve(folder) !== folder || !folder.startsWith(stateDir + '/') || ownsDefaultLogin(folder)
    || !directory(dirname(folder)) || realpathSync(dirname(folder)) !== dirname(folder)))) throw new CliAccountError('bad-option');
  const managed = (r: Row) => (r.provider === 'claude' || r.provider === 'codex') && managedFolders[r.provider] === r.folder;
  const unknownRoom = (): Room => ({ left: 'unknown', freshness: 'unknown' });
  let reader: Usage | undefined;
  const roomReader = () => reader ??= options.usage ?? usage({ stateDir });
  // An installed Codex keeps its login where it would itself: the person's CODEX_HOME, else ~/.codex. Codex reads it, never the kit.
  const codexHome = (r: Row) => !r.installed ? r.folder : env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(env.HOME, '.codex');
  const codexSource = (r: Row) => ({ provider: 'codex' as const, bin: binary('codex'), home: codexHome(r), env: spawnEnv(r) });
  const installedRows = (): Row[] => options.installed ? installable.filter((p) => bins[p]).map((p) => ({ id: `installed-${p}`, provider: p, name: '', folder: '', found: false, installed: true })) : [];
  const installedRow = (id: string) => installedRows().find((r) => r.id === id);
  /** The one usage source for a ready row; a provider whose reader is a later lane stays unknown. */
  function roomSource(r: Row): Source | undefined {
    if (r.installed) return undefined;
    if (r.provider === 'codex') return codexSource(r);
    if (r.provider === 'cursor') return { provider: 'cursor', folder: r.folder };
    if (r.provider === 'pi') return piRoomSource(r);
    return r.provider === 'claude' && options.claudeHeaders ? { provider: 'claude', folder: r.folder, headers: options.claudeHeaders } : undefined;
  }
  // Never write kit bookkeeping into a default login: neither the state root itself nor a provider's
  // managed root below it may sit inside one, so `<stateDir>/cursor` cannot land in `~/.config/cursor`.
  if ([stateDir, ...providers.map((p) => join(stateDir, p))].some(ownsDefaultLogin)) throw new CliAccountError('bad-option');
  // Parents must already be app-owned. Never follow a state/provider/folder symlink.
  try { if (realpathSync(dirname(stateDir)) !== dirname(stateDir)) throw new CliAccountError('bad-option'); }
  catch { throw new CliAccountError('bad-option'); }
  if (!directory(stateDir, true)) throw new CliAccountError('bad-option');
  chmodSync(stateDir, 0o700);
  const file = join(stateDir, 'accounts-v1.json');
  const restsFile = join(stateDir, 'rests-v1.json');
  type RestRow = { id: string; until: number; why: string };
  const created = new Set<string>(); const operations = new Map<string, Promise<unknown>>();
  // Monotonic so two logins added in the same millisecond still come back with different `addedAt`.
  let lastAddedAt = 0;
  const stampAddedAt = () => { const now = Date.now(); lastAddedAt = now > lastAddedAt ? now : lastAddedAt + 1; return lastAddedAt; };
  const restWhy = (v: unknown): v is string => text(v) && !!v && v.length <= 64 && !/[\x00-\x1f\x7f]/.test(v);
  function parseRests(saved: unknown, nowMs: number): RestRow[] | undefined {
    if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.rests)) return undefined;
    const seen = new Set<string>(); const rows: RestRow[] = [];
    for (const candidate of saved.rests) {
      if (!record(candidate) || !text(candidate.id) || !candidate.id || candidate.id.length > 128 || seen.has(candidate.id)
        || typeof candidate.until !== 'number' || !Number.isSafeInteger(candidate.until) || candidate.until < 0 || !restWhy(candidate.why)) return undefined;
      seen.add(candidate.id);
      if (candidate.until > nowMs) rows.push({ id: candidate.id, until: candidate.until, why: candidate.why });
    }
    return rows;
  }
  function loadRests(nowMs = Date.now()): RestRow[] {
    if (!directory(stateDir) || realpathSync(stateDir) !== stateDir) throw new CliAccountError('bad-option');
    const saved = json(restsFile);
    if (saved === undefined) {
      try { if (lstatSync(restsFile).isFile()) { atomic(restsFile, { version: 1, rests: [] }); return []; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CliAccountError('prepare-failed'); }
      return [];
    }
    const rows = parseRests(saved, nowMs);
    if (rows === undefined) { atomic(restsFile, { version: 1, rests: [] }); return []; }
    return rows;
  }
  const saveRests = (rows: RestRow[], nowMs = Date.now()) =>
    atomic(restsFile, { version: 1, rests: rows.filter((r) => r.until > nowMs) });
  // `<tool> -> <id>`: the account the person's own `use` keeps for the pool. Only ids, never a secret.
  const preferFile = join(stateDir, 'prefer-v1.json');
  type PreferRecord = { version: 1; tools: Partial<Record<CliProvider, string>> };
  function parsePrefer(saved: unknown): PreferRecord['tools'] | undefined {
    if (!record(saved) || saved.version !== 1 || !record(saved.tools)) return undefined;
    const tools: PreferRecord['tools'] = {};
    for (const [tool, id] of Object.entries(saved.tools)) {
      if (!providers.includes(tool as CliProvider) || !text(id) || !id || id.length > 128) return undefined;
      tools[tool as CliProvider] = id;
    }
    return tools;
  }
  function loadPrefer(): PreferRecord['tools'] {
    if (!directory(stateDir) || realpathSync(stateDir) !== stateDir) throw new CliAccountError('bad-option');
    const saved = json(preferFile);
    return saved === undefined ? {} : parsePrefer(saved) ?? {};
  }
  const savePrefer = (tools: PreferRecord['tools']) => atomic(preferFile, { version: 1, tools });
  const activeRest = (id: string, nowMs = Date.now()) => loadRests(nowMs).find((r) => r.id === id);
  function safe(r: Row): boolean {
    const parent = join(stateDir, r.provider);
    return directory(stateDir) && realpathSync(stateDir) === stateDir && directory(r.folder)
      && (managed(r) ? realpathSync(r.folder) === r.folder : resolve(r.folder) === r.folder
        && r.folder.startsWith(parent + '/') && /^[a-f0-9]+$/.test(r.folder.slice(parent.length + 1)) && directory(parent));
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
        if (typeof candidate.addedAt === 'number' && Number.isSafeInteger(candidate.addedAt) && candidate.addedAt >= 0) r.addedAt = candidate.addedAt;
        if (r.provider === 'pi') {
          if (validPiProvider(candidate.piProvider)) r.piProvider = candidate.piProvider;
          else if (!r.found && !r.id.startsWith('found-')) continue;
          if (path === file && !r.found && !r.id.startsWith('found-')) continue;
        } else if (path !== file) continue;
        // Host-owned rows remain byte-compatible in the roster, without touching their folder.
        if (!r.found && !r.id.startsWith('found-') && !safe(r)) continue;
        if (!r.found && !r.id.startsWith('found-') && r.addedAt === undefined) r.addedAt = folderAddedAt(r.folder);
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
  const firstGo = (r: Row) => r.provider === 'opencode' && load().find(v => v.provider === 'opencode' && !v.found && !v.id.startsWith('found-'))?.id === r.id;
  const goLegacyClaimed = join(stateDir, 'opencode-legacy-claimed');
  async function settleLegacyGoKey(r: Row, discard = false): Promise<void> {
    if (!firstGo(r) || !options.keyStore || marker(goLegacyClaimed)) return;
    const own = await options.keyStore.get(`accounts.${OPENCODE_GO_PLAN_ROUTE}:${r.id}`)
      || await options.keyStore.get(`accounts.${OPENCODE_GO_PLAN_ROUTE}.${r.id}`);
    if (!own) {
      const legacy = await options.keyStore.get(`accounts.${OPENCODE_GO_PLAN_ROUTE}`);
      if (!legacy && !discard) return;
      if (legacy && !discard) {
        await saveOpenCodePlanKey(options.keyStore, legacy, OPENCODE_GO_PLAN_ROUTE, r.id);
        await deleteOpenCodePlanKey(options.keyStore);
      }
    }
    writeFileSync(goLegacyClaimed, '', { mode: 0o600, flag: 'wx' });
  }
  async function storedKey(r: Row): Promise<string> {
    await settleLegacyGoKey(r);
    return readOpenCodePlanKey(options.keyStore, keyRoute(r.provider as 'opencode' | 'vibe'), keyLabel(r.provider as 'opencode' | 'vibe'), r.id);
  }
  async function deleteStoredKey(r: Row): Promise<void> {
    await settleLegacyGoKey(r, true);
    await deleteOpenCodePlanKey(options.keyStore, keyRoute(r.provider as 'opencode' | 'vibe'), r.id);
  }
  function binary(p: CliProvider): string { const bin = bins[p]; if (!bin) throw new CliAccountError('bad-option'); return bin; }
  // A moved XDG_CONFIG_HOME also moves git's and gh's global files, and CURSOR_CONFIG_DIR is Cursor's other
  // config override, so both folder variables name the managed folder. GIT_CONFIG_GLOBAL replaces both of
  // git's own global files, so name the pool HOME's real one (`~/.gitconfig` wins where both exist) or none
  // at all: `git commit` keeps its identity, and an ambient folder cannot outlive the managed one. Paths only.
  function launch(r: Row): { set: Record<string, string>; unset: string[] } {
    // The installed CLI runs as the person runs it: no folder variable, only the per-use billing overrides removed.
    if (r.installed) return { set: {}, unset: [...shed[r.provider]] };
    // OpenCode keeps its sign-in store and database in the XDG roots (1.x auth.json, 2.x opencode.db): each account gets its own.
    if (r.provider === 'opencode') return { set: { [folderVar(r.provider)]: r.folder, XDG_DATA_HOME: join(r.folder, 'data'),
      XDG_STATE_HOME: join(r.folder, 'state'), XDG_CACHE_HOME: join(r.folder, 'cache') }, unset: [...shed.opencode] };
    if (r.provider !== 'cursor') return { set: { [folderVar(r.provider)]: r.folder }, unset: [...shed[r.provider]] };
    const gitGlobal = [join(env.HOME, '.gitconfig'), join(env.HOME, '.config', 'git', 'config')].find(existsSync);
    return {
      set: { [folderVar(r.provider)]: r.folder, CURSOR_CONFIG_DIR: r.folder, GH_CONFIG_DIR: join(env.HOME, '.config', 'gh'),
        ...(gitGlobal === undefined ? {} : { GIT_CONFIG_GLOBAL: gitGlobal }) },
      unset: [...shed.cursor, ...(gitGlobal === undefined ? ['GIT_CONFIG_GLOBAL'] : [])],
    };
  }
  function spawnEnv(r: Row) {
    return cleanLaunchEnv({ base: env, account: launch(r) }).env;
  }
  function command(r: Row, model?: string): SignInCommand {
    // OpenCode and Vibe have no native login to spawn: the app collects the key with hidden typing and
    // completes the sign-in with saveKey. The shell is a no-op; the key never enters argv or env.
    if (r.provider === 'opencode') return { argv: [], env: spawnEnv(r), completion: complete(r), shell: ':', instruction: { words: 'cli.opencodeKey' } };
    if (r.provider === 'vibe') return { argv: [], env: spawnEnv(r), completion: complete(r), shell: ':', instruction: { words: 'cli.vibeKey' } };
    // Kimi Code: public `kimi login` (no flags) writes OAuth under KIMI_CODE_HOME; completion on exit 0.
    // Cursor: public `cursor-agent login` writes the login under XDG_CONFIG_HOME; completion on exit 0.
    const argv = r.provider === 'pi' ? [binary('pi'), ...piArgs(model, r.piProvider)]
      : r.provider === 'claude' ? [binary(r.provider), 'auth', 'login', '--claudeai']
      : r.provider === 'kimi' || r.provider === 'cursor' ? [binary(r.provider), 'login']
      : [binary(r.provider), 'login', '--device-auth'];
    const passed = spawnEnv(r); const completion = complete(r); const { lock, holder } = signInLock(r.folder);
    const login = ['/usr/bin/env', '-i', ...Object.entries(passed).map(([k, v]) => `${k}=${v}`), ...argv].map(quote).join(' ');
    // Record the CLI, not its wrapper: a crashed shell must not make a still-running login reusable.
    const cleanup = `if [ -n "$byokit_pid" ]; then kill "$byokit_pid" 2>/dev/null; wait "$byokit_pid" 2>/dev/null; fi; /bin/rm -f ${quote(holder)}; /bin/rmdir ${quote(lock)}`;
    const shell = `(umask 077; /bin/mkdir ${quote(lock)} || exit 1; ${login} <&0 & byokit_pid=$!; printf '%s' "$byokit_pid" > ${quote(holder)}; trap ${quote(cleanup)} EXIT; wait "$byokit_pid"; byokit_status=$?; byokit_pid=; [ "$byokit_status" -eq 0 ]${r.provider === 'pi' ? '' : ` && (set -C; printf complete > ${quote(completion)})`})`;
    return { argv, env: passed, completion, shell, ...(r.provider === 'pi' ? { instruction: { words: 'cli.piLogin' as const, command: `/login ${r.piProvider}` as const } } : {}) };
  }
  function begin(r: Row, model?: string): SignInCommand {
    const result = command(r, model);
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
  type Probe = Identity & { method?: SignInMethod; why?: 'api_key' | 'unknown'; cause?: 'cli.installedSlow' | 'cli.installedStart' | 'cli.installedUnreadable' | 'cli.installedExit' | 'cli.installedRpc' | 'cli.installedWrite' };
  async function readIdentity(r: Row): Promise<Probe> {
    if (r.provider === 'codex') {
      const source = codexSource(r);
      let info = await identity(source);
      // Installed readiness only: one fresh app-server attempt for a transport/server failure, never a missing account.
      if (r.installed && info.probeFailure && info.probeFailure.code !== 'reply') info = await identity(source);
      const cause = info.probeFailure && ({ timeout: 'cli.installedSlow', start: 'cli.installedStart', exit: 'cli.installedExit',
        write: 'cli.installedWrite', rpc: 'cli.installedRpc', reply: 'cli.installedUnreadable' } as const)[info.probeFailure.code];
      return { ...info, ...(cause ? { cause } : {}) };
    }
    return new Promise((accept) => {
      // `cause` names a probe that gave no answer; only installed rows show it.
      const failed = (cause: NonNullable<Probe['cause']>): Probe => ({ signedIn: false, ...(r.provider === 'pi' ? { why: 'unknown' as const } : {}), cause });
      const argv = r.provider === 'pi' ? ['auth', 'check', '--provider', r.piProvider!, '--json', '--no-refresh']
        : r.provider === 'cursor' ? ['status', '--format', 'json']
        : ['auth', 'status'];
      const child = spawn(binary(r.provider), argv, { env: spawnEnv(r), stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = ''; let bytes = 0; let settled = false; let escalation: NodeJS.Timeout | undefined;
      const finish = (answer: Probe) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
        }
        accept(answer);
      };
      const timer = setTimeout(() => finish(failed('cli.installedSlow')), 15_000);
      child.once('error', () => finish(failed('cli.installedStart')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > (r.provider === 'pi' ? 64 : 256) * 1024) { finish(failed('cli.installedUnreadable')); return; }
        stdout += chunk;
      });
      child.once('close', () => {
        clearTimeout(escalation);
        if (settled) return;
        if (bytes > 64 * 1024) { finish(failed('cli.installedUnreadable')); return; }
        let raw: unknown; try { raw = JSON.parse(stdout); } catch { finish(failed('cli.installedUnreadable')); return; }
        if (r.provider === 'pi') {
          if (!record(raw) || raw.provider !== r.piProvider) { finish(failed('cli.installedUnreadable')); return; }
          if (child.exitCode === 0 && raw.status === 'ready' && raw.authType === 'oauth') finish({ signedIn: true });
          else if (child.exitCode === 0 && raw.status === 'ready' && raw.authType === 'api_key') finish({ signedIn: false, why: 'api_key' });
          else if (child.exitCode === 1 && raw.status === 'not_ready') finish({ signedIn: false });
          else finish(failed('cli.installedUnreadable'));
          return;
        }
        if (r.provider === 'cursor') {
          // `cursor-agent status` exits 0 even when signed out, so the JSON decides, never the exit code.
          finish(record(raw) && raw.isAuthenticated === true ? { signedIn: true } : record(raw) && raw.isAuthenticated === false ? { signedIn: false } : failed('cli.installedUnreadable'));
          return;
        }
        if (!record(raw) || raw.loggedIn !== true) { finish(record(raw) && raw.loggedIn === false ? { signedIn: false } : failed('cli.installedUnreadable')); return; }
        const email = typeof raw.email === 'string' && raw.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.email) ? raw.email : undefined;
        const plan = [raw.subscriptionType, raw.plan, raw.planName, raw.tier].find((v) => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9 _+-]{0,63}$/.test(v));
        const method = typeof raw.authMethod === 'string' ? raw.authMethod === 'claude.ai' ? 'subscription' : /api.?key/i.test(raw.authMethod) ? 'api_key' : 'other' : undefined;
        finish({ signedIn: true, ...(email ? { email } : {}), ...(typeof plan === 'string' ? { plan } : {}), ...(method && r.provider === 'claude' ? { method } : {}) });
      });
    });
  }
  function suggestName(email: string | undefined, provider: CliProvider): string {
    const first = email?.split('@')[0]?.split(/[._-]+/).find(Boolean);
    if (first) return (first[0].toUpperCase() + first.slice(1).toLowerCase()).slice(0, 64);
    return provider === 'claude' ? 'Claude' : provider === 'pi' ? 'Pi' : provider === 'opencode' ? 'OpenCode' : provider === 'kimi' ? 'Kimi' : provider === 'vibe' ? 'Vibe' : provider === 'cursor' ? 'Cursor' : 'Codex';
  }
  /** An installed row reads only its CLI's own answer: signed in, signed out, or no answer with the real cause. */
  /** A probe that gave no answer (timeout, start, exit, unreadable) is unknown: never a revoked login. */
  const unknownOf = (cause: NonNullable<Probe['cause']>, name: string) => ({ state: 'unknown' as const, why: 'unknown' as const,
    reason: ({ 'cli.installedSlow': 'timeout', 'cli.installedUnreadable': 'unreadable' } as const)[cause as 'cli.installedSlow'] ?? 'unavailable' as UnknownReason,
    retryAfterMs: 5_000, cause: say(cause, { name }) });
  async function installedStatus(r: Row): Promise<CliAccount> {
    const account = { id: r.id, provider: r.provider, name: suggestName(undefined, r.provider), billing: 'subscription' as const, installed: true as const };
    const info = await readIdentity(r);
    if (info.signedIn) return { ...account, name: suggestName(info.email, r.provider), state: 'ready', ...(info.email ? { email: info.email } : {}), ...(info.plan ? { plan: info.plan } : {}), ...(info.method ? { method: info.method } : {}) };
    return { ...account, ...(info.cause ? unknownOf(info.cause, account.name) : { state: 'signed_out' as const, cause: say('cli.installedSignedOut', { name: account.name }) }),
      ...(info.probeFailure ? { probeFailure: info.probeFailure } : {}) };
  }
  async function status(id: string): Promise<CliAccount> {
    const installed = installedRow(id);
    if (installed) return installedStatus(installed);
    return serial(id, async () => {
      const r = row(id);
      const account = { id: r.id, provider: r.provider, name: r.name.trim() || (r.provider === 'pi' ? piRoutes.find(v => v.upstream.id === r.piProvider)!.name : suggestName(undefined, r.provider)), billing: 'subscription' as const,
        ...(r.piProvider ? { piProvider: r.piProvider } : {}), ...(r.adoptedFrom ? { adoptedFrom: r.adoptedFrom } : {}), ...(r.addedAt !== undefined ? { addedAt: r.addedAt } : {}) };
      if (!bins[r.provider]) return { ...account, state: 'not_included' };
      const rest = activeRest(r.id);
      if (rest) return { ...account, state: 'resting', until: rest.until };
      if (r.provider === 'opencode' || r.provider === 'vibe') {
        // No native probe: readiness is this account's saved key. A missing or unreadable store
        // reads signed out, never a failure, and a saved key ends the pending cycle like a native login.
        let saved = false;
        try { await storedKey(r); saved = true; }
        catch { saved = false; }
        if (saved && marker(pending(r))) rmSync(pending(r), { force: true });
        const keySigning = marker(pending(r)) && !saved;
        return { ...account, name: r.name.trim() || suggestName(undefined, r.provider), state: saved ? 'ready' : keySigning ? 'signing' : 'signed_out' };
      }
      if (r.provider === 'kimi') {
        // No documented non-secret status command (kinds/herdr); `kimi login` exit 0 writes the
        // kit completion marker, and that marker is the signed-in signal. Never open credentials/.
        const signing = marker(pending(r)) && !marker(complete(r));
        if (signing) return { ...account, state: 'signing' };
        const signedIn = marker(complete(r));
        if (marker(pending(r)) && signedIn) rmSync(pending(r), { force: true });
        return { ...account, name: r.name.trim() || suggestName(undefined, r.provider), state: signedIn ? 'ready' : 'signed_out' };
      }
      const signing = marker(pending(r)) && !marker(complete(r));
      if (signing && r.provider !== 'pi') return { ...account, state: 'signing' };
      const info = await readIdentity(r);
      if (marker(pending(r)) && (r.provider !== 'pi' || info.signedIn)) rmSync(pending(r), { force: true });
      // Pre-existing roster rows have no kit marker; their native status remains authoritative.
      return { ...account, name: r.name.trim() || (r.provider === 'pi' ? account.name : suggestName(info.email, r.provider)), ...(info.signedIn ? { state: 'ready' as const } : signing && !info.why ? { state: 'signing' as const } : info.cause ? unknownOf(info.cause, account.name) : { state: 'signed_out' as const }), ...(info.why && !info.cause ? { why: info.why } : {}), ...(info.email ? { email: info.email } : {}), ...(info.plan ? { plan: info.plan } : {}), ...(info.method ? { method: info.method } : {}) };
    });
  }
  function discard(r: Row, login: boolean) {
    if (managed(r)) {
      rmSync(pending(r), { force: true }); rmSync(complete(r), { force: true });
      if (login) for (const file of managedLoginFiles[r.provider] ?? []) rmSync(join(r.folder, file), { force: true });
    } else rmSync(r.folder, { recursive: true, force: true });
  }
  async function drop(id: string, login: boolean) {
    return serial(id, async () => {
      const r = row(id);
      if (login && signInHeld(r.folder)) throw new CliAccountError('prepare-failed');
      // The key lives outside the folder, so delete it first: no orphaned secret survives the row.
      if (r.provider === 'opencode' || r.provider === 'vibe') await deleteStoredKey(r);
      discard(r, login); save(load().filter((v) => v.id !== id), r.provider); created.delete(id);
      saveRests(loadRests().filter((v) => v.id !== id));
    });
  }
  async function rest(id: string, opts: CliRest): Promise<CliAccount> {
    if (!record(opts) || typeof opts.until !== 'number' || !Number.isSafeInteger(opts.until) || opts.until < 0 || !restWhy(opts.why)) throw new CliAccountError('bad-option');
    await serial(id, async () => {
      row(id); // refuse unknown ids before writing
      const nowMs = Date.now();
      saveRests([...loadRests(nowMs).filter((v) => v.id !== id), { id, until: opts.until, why: opts.why }], nowMs);
    });
    return status(id);
  }
  async function unrest(id: string): Promise<CliAccount> {
    await serial(id, async () => {
      row(id);
      saveRests(loadRests().filter((v) => v.id !== id));
    });
    return status(id);
  }
  /** Save an OpenCode plan key or Vibe API key (collected with hidden typing) into the secrets store,
   * one entry per managed account. The key never enters argv, env, or a log; its only file is the
   * OpenCode folder delivery copy that `launch` writes and `logout`/`remove` delete. `o.workspace`
   * names the workspace a multi-workspace OpenCode login acts for (from `openCodeWorkspaces`); the
   * launch delivery config carries it as `x-opencode-org-id`. Without it, `launch` lists the key's workspaces:
   * one is stored, several throw the typed `KeyRouteError` `needs_workspace`, none keeps no header. */
  async function saveKey(id: string, key: string, o?: { workspace?: string }): Promise<CliAccount> {
    await serial(id, async () => {
      const r = row(id);
      if (r.provider !== 'opencode' && r.provider !== 'vibe') throw new CliAccountError('kind-mismatch');
      if (!options.keyStore || typeof key !== 'string' || !key.trim()) throw new CliAccountError('bad-option');
      try {
        await saveOpenCodePlanKey(options.keyStore, key, keyRoute(r.provider), r.id);
        if (r.provider === 'opencode') {
          const workspace = typeof o?.workspace === 'string' ? o.workspace.trim() : '';
          if (workspace.length > 256) throw new Error();
          if (workspace) await saveOpenCodeWorkspace(options.keyStore, workspace, keyRoute(r.provider), r.id);
          else await options.keyStore.delete(openCodeWorkspaceEntry(keyRoute(r.provider), r.id)).catch(() => {});
        }
      }
      catch { throw new CliAccountError('prepare-failed'); }
      rmSync(pending(r), { force: true });
    });
    return status(id);
  }
  /** Delete this account's stored key from the secrets store; the row stays signed out. */
  async function logout(id: string): Promise<CliAccount> {
    await serial(id, async () => {
      const r = row(id);
      if (r.provider !== 'opencode' && r.provider !== 'vibe') throw new CliAccountError('kind-mismatch');
      try { await deleteStoredKey(r); }
      catch { throw new CliAccountError('prepare-failed'); }
      if (r.provider === 'opencode') removeOpencodeLaunchFiles(r.folder);
      rmSync(pending(r), { force: true });
    });
    return status(id);
  }
  function remove(id: string) { return drop(id, true); }
  type Added = { account: CliAccount; signIn: SignInCommand };
  function add(provider: 'pi', metadata: { piProvider: PiProvider; model: string }): Promise<Added>;
  function add(provider: 'claude' | 'codex' | 'opencode' | 'kimi' | 'vibe' | 'cursor'): Promise<Added>;
  function add(provider: CliProvider, metadata?: { piProvider?: PiProvider; model?: string }): Promise<Added> { return addManaged(provider, metadata); }
  async function addManaged(provider: CliProvider, metadata?: { piProvider?: PiProvider; model?: string }, adopted?: Row): Promise<Added> {
    if (provider === 'pi') piArgs(metadata?.model, metadata?.piProvider);
    if (!providers.includes(provider) || (provider === 'pi' && !validPiProvider(metadata?.piProvider))) throw new CliAccountError('bad-option');
    binary(provider);
    const parent = join(stateDir, provider); if (!directory(stateDir) || !directory(parent, true)) throw new CliAccountError('bad-option');
    chmodSync(parent, 0o700);
    const r: Row = { id: `pa_${randomBytes(9).toString('hex')}`, provider, name: adopted?.name ?? '', folder: (provider === 'claude' || provider === 'codex') && managedFolders[provider] || join(parent, randomBytes(8).toString('hex')), found: false, addedAt: stampAddedAt(),
      ...(provider === 'pi' ? { piProvider: metadata!.piProvider } : {}), ...(adopted ? { adoptedFrom: adopted.id } : {}) };
    if (managed(r) && load().some(row => row.folder === r.folder)) throw new CliAccountError('prepare-failed');
    if (!directory(r.folder, true)) throw new CliAccountError('bad-option');
    try {
      if (history[provider]) historyLink(history[provider]!, join(r.folder, provider === 'claude' ? 'projects' : 'sessions'));
      const signIn = begin(r, metadata?.model);
      await options.prepare?.(r.folder, provider);
      if (!safe(r)) throw new CliAccountError('prepare-failed');
      save([...load(), r], provider); created.add(r.id);
      return { account: { id: r.id, provider, name: r.name || (provider === 'pi' ? piRoutes.find(v => v.upstream.id === r.piProvider)!.name : suggestName(undefined, provider)), billing: 'subscription', state: 'signing', ...(r.piProvider ? { piProvider: r.piProvider } : {}), ...(r.adoptedFrom ? { adoptedFrom: r.adoptedFrom } : {}), addedAt: r.addedAt }, signIn };
    } catch { discard(r, false); throw new CliAccountError('prepare-failed'); }
  }
  return {
    list: async (): Promise<CliAccount[]> => Promise.all([...load().filter((r) => !r.found && !r.id.startsWith('found-')), ...installedRows()].map((r) => status(r.id))),
    add,
    adopt: (foundId: string, metadata?: { piProvider?: PiProvider; model?: string }): Promise<Added> => serial(foundId, async () => {
      const rows = load();
      const found = rows.find(r => r.id === foundId && r.id.startsWith('found-'));
      if (!found) throw new CliAccountError('unknown-account');
      const adopted = rows.find(r => !r.found && !r.id.startsWith('found-') && r.adoptedFrom === foundId);
      if (adopted) {
        if (operations.has(adopted.id)) throw new CliAccountError('prepare-failed');
        const signIn = begin(adopted, metadata?.model);
        return { account: await status(adopted.id), signIn };
      }
      // Only metadata seeds a new empty folder; never inspect or copy the discovered source.
      return addManaged(found.provider, metadata, found);
    }),
    signInAgain: (id: string, model?: string): SignInCommand => {
      if (operations.has(id)) throw new CliAccountError('prepare-failed');
      return begin(row(id), model);
    },
    status,
    rest,
    unrest,
    saveKey,
    logout,
    async cancel(id: string): Promise<{ removed: boolean }> {
      if (created.has(id)) { await drop(id, false); return { removed: true }; }
      return serial(id, async () => { const r = row(id); rmSync(pending(r), { force: true }); return { removed: false }; });
    },
    async rename(id: string, name: string): Promise<CliAccount> {
      if (!text(name) || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new CliAccountError('invalid-name');
      await serial(id, async () => { const r = row(id); const rows = load(); rows.find((r) => r.id === id)!.name = name.trim(); save(rows, r.provider); });
      return status(id);
    },
    remove,
    async launch(id: string, model?: string): Promise<CliLaunchResult> {
      const selected = installedRow(id) ?? row(id);
      if (selected.provider === 'pi') piArgs(model, selected.piProvider);
      const account = await status(id);
      if (account.state === 'ready') {
        const r = installedRow(id) ?? row(id);
        const base = launch(r);
        if (r.provider !== 'opencode') return { ok: true, account, ...base, ...(r.provider === 'pi' ? { args: piArgs(model, r.piProvider) } : {}) };
        // The folder files are the delivery copy: the key reaches OpenCode through `{file:}`
        // substitution in the folder's opencode.json, never argv or env.
        return serial(id, async (): Promise<CliLaunchResult> => {
          const current = row(id);
          let key: string;
          try { key = await storedKey(current); }
          catch { return { ok: false, code: 'signed_out', account, message: say('cli.signedOut', { name: account.name }) }; }
          // A key saved without a workspace resolves it here, as every Go call does (several: typed `needs_workspace`).
          // ponytail: a key with no workspace saves no entry (the store refuses empty values), so each launch lists again.
          const workspace = await openCodeWorkspace(key, await readOpenCodeWorkspace(options.keyStore, keyRoute('opencode'), current.id) || undefined,
            async (w) => { if (w) await saveOpenCodeWorkspace(options.keyStore!, w, keyRoute('opencode'), current.id); }, options.fetch);
          try { writeOpencodeLaunchFiles(current.folder, key, workspace || undefined); }
          catch (cause) { throw new Error(say('cli.prepareFailed'), { cause }); }
          return { ok: true, account,
            set: { ...base.set, OPENCODE_CONFIG: opencodeConfigPath(current.folder) },
            unset: base.unset.filter((name) => name !== 'OPENCODE_CONFIG') };
        });
      }
      if (account.state === 'resting' && account.until) {
        return { ok: false, code: 'resting', account, message: say('status.resting', { name: account.name, until: clock(account.until) }) };
      }
      const code = account.state === 'not_included' ? 'not_included' : account.state === 'unknown' ? 'unknown' : 'signed_out';
      return { ok: false, code, account, message: account.cause ?? say(code === 'not_included' ? 'cli.notIncluded' : 'cli.signedOut', { name: account.name }) };
    },
    launchEnv: (id: string, model?: string) => {
      const r = installedRow(id) ?? row(id);
      const args = r.provider === 'pi' ? { args: piArgs(model, r.piProvider) } : {};
      return { ...launch(r), ...args };
    },
    /** The account a tool's stored `use` names, or undefined. */
    preferOf: (provider: CliProvider): string | undefined => {
      if (!providers.includes(provider)) throw new CliAccountError('bad-option');
      return loadPrefer()[provider];
    },
    /** Store the account `use <id>` prefers for a tool, or clear it with `use --clear <tool>`. A clear
     * for a tool with no entry succeeds and changes nothing. */
    setPrefer: (provider: CliProvider, id?: string): void => {
      if (!providers.includes(provider) || (id !== undefined && (!text(id) || !id || id.length > 128))) throw new CliAccountError('bad-option');
      const tools = { ...loadPrefer() };
      if (id === undefined && !(provider in tools)) return;
      if (id === undefined) delete tools[provider]; else tools[provider] = id;
      savePrefer(tools);
    },
    folderOf: (id: string): string => row(id).folder,
    /** Pi's own default model is never used: a Pi row launches only with the `model` the caller chose. */
    launchArgs: (id: string, model?: string): string[] => {
      const r = row(id);
      if (r.provider !== 'pi') return [];
      return piArgs(model, r.piProvider);
    },
    kinds: (provider: CliProvider): string[] => providers.includes(provider) ? [provider] : [],
    resumeArgs(kind: string, ref: { kind: 'id' | 'path'; value: string }): string[] {
      if (!record(ref) || !text(ref.value) || !ref.value || ref.value.startsWith('-') || !providers.includes(kind as CliProvider) || (ref.kind !== 'id' && (kind !== 'pi' || ref.kind !== 'path'))) throw new CliAccountError('kind-mismatch');
      // kinds.json: pi/opencode/kimi `--session`, claude/vibe/cursor `--resume`, codex `resume`.
      return kind === 'pi' || kind === 'opencode' || kind === 'kimi' ? ['--session', ref.value] : kind === 'claude' || kind === 'vibe' || kind === 'cursor' ? ['--resume', ref.value] : ['resume', ref.value];
    },
    async usageSource(id: string): Promise<{ provider: 'codex'; bin: string; home: string; env: Record<string, string> } | { provider: 'cursor'; folder: string } | { provider: 'opencode'; key: string } | { provider: 'pi'; folder: string; piProvider: UsagePiProvider } | undefined> {
      const r = row(id);
      if (r.provider === 'codex') return codexSource(r);
      if (r.provider === 'cursor') return { provider: 'cursor', folder: r.folder };
      if (r.provider === 'pi') return piRoomSource(r);
      if (r.provider === 'opencode') return serial(id, async () => {
        try { return { provider: 'opencode' as const, key: await storedKey(row(id)) }; }
        catch { return undefined; }
      });
      return undefined;
    },
    /** The account a run of this provider should use, and every row of that provider with its reading.
     * Candidates are `ready` and not resting; `prefer` wins while that account is ready; otherwise the
     * most room wins, an unknown reading ranks after a known one, and ties keep list order. */
    async pick(provider: CliProvider, options: { prefer?: string } = {}): Promise<CliPick> {
      if (!providers.includes(provider) || !record(options) || (options.prefer !== undefined && (!text(options.prefer) || !options.prefer))) throw new CliAccountError('bad-option');
      // The person's own `use` for this tool, unless the caller named an account explicitly.
      const prefer = options.prefer ?? loadPrefer()[provider];
      const rows: CliPickRow[] = [];
      for (const r of [...load().filter((v) => !v.found && !v.id.startsWith('found-')), ...installedRows()].filter((v) => v.provider === provider)) {
        const account = await status(r.id);
        // Read room only for an account this run could use; a signed-out or resting row carries no reading.
        const source = account.state === 'ready' ? roomSource(r) : undefined;
        if (!source) { rows.push({ account, room: unknownRoom(), windows: [] }); continue; }
        const nowMs = Date.now();
        const reading = await roomReader().read(source, { nowMs });
        rows.push({ account, room: roomOf(reading, nowMs), windows: reading.windows, ...(reading.at !== undefined ? { readAt: reading.at } : {}) });
      }
      const ready = rows.filter((r) => r.account.state === 'ready');
      const chosen = ready.find((r) => r.account.id === prefer)
        ?? ready.filter((r) => r.room.left !== 'unknown').sort((a, b) => Number(b.room.left) - Number(a.room.left))[0]
        ?? ready[0];
      if (!chosen) return { ok: false, code: 'none', reason: say('pick.none', { provider }), rows };
      return { ok: true, account: chosen.account, room: chosen.room, rows };
    },
    termsAcknowledged: (): boolean => { if (!directory(stateDir)) throw new CliAccountError('bad-option'); const saved = json(join(stateDir, 'auto-terms-v1.json')); return record(saved) && saved.acknowledged === true; },
    acknowledgeTerms: () => atomic(join(stateDir, 'auto-terms-v1.json'), { acknowledged: true }),
    suggestName,
  };
}
