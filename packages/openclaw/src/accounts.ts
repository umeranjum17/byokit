// The per-member account index (5.15, O14 step S5): `<root>/accounts/<member>.json` (0600, whole-file temp
// plus rename) is the only kit state: `{ v: 1, accounts: { [id]: { agent, name, route, addedAt, until?, model?,
// who?, priorModel? } }, defaults, gone?, dropped? }`, where `priorModel` is the member agent's primary before a
// member-agent sign-in pinned it (empty when none), `gone` names account-agent dirs a removal left for the orphan
// sweep, and `dropped` names providers removed from the member agent so a late refresh cannot restore them. No
// credential, token, email or engine line. Listing, rename, defaults, models, room, adding with its identity merge
// (O14 steps S6, S7), the start-of-run pick (S10), session binding (S11), moving a conversation (S12) and removal
// with its orphan sweep (S8) live here.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocks } from './locks.ts';
import { detection } from './auth-status.ts';
import { indeterminate, reasonOf, RETRY_AFTER_MS, type Detector } from './detect.ts';
import { providerOf, resolveSelection } from './pick.ts';
import { agentOf, memberOf as baseMemberOf } from './attribution.ts';
import { KEY_PREFIX, MEMBER_ID, NEW_MEMBER_ID, keyAgentId, untilListed, untilUnlisted } from './members.ts';
import { routes, routeFor, type RouteView } from './routes.ts';
import { words } from './words.ts';
import type { Account, AccountContext, AccountId, AccountPick, AccountStatus, Defaults, GatewayTransport, Member, ModelInfo, MoveResult, Room, RoomSpan, RunSelection, SignInOptions, SignInState, SignInView, UnknownReason } from './types.ts';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// A provider-local engine model id as the kit's `provider/model` reference; an id already prefixed with its own
// provider is left alone.
export const kitId = (provider: string, id: string): string =>
  providerOf(id) === provider.toLowerCase() ? id : `${provider}/${id}`;
// The id the pinned engine keeps for a catalog row: it rewrites a row id when it writes the config. A Google
// preview id becomes the id Google calls it (`google/gemini-3.1-flash-lite-preview` becomes
// `google/gemini-3.1-flash-lite`), and a bare id of a provider that names it carries that provider. The kit names
// every row by the id the engine keeps, so the engine's list and the kit's never disagree, and two rows the engine
// would keep under one id are one row: a list with both is refused ("Ambiguous duplicate ID").
const googlePreviewIds: Record<string, string> = {
  'gemini-3-pro': 'gemini-3.1-pro-preview',
  'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3.1-flash': 'gemini-3-flash-preview',
  'gemini-3.1-flash-preview': 'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite',
  'gemma-4-26b': 'gemma-4-26b-a4b-it',
};
/** The id the engine keeps for a row of `provider` (5.6): a Google preview id (a row of a provider that carries
 *  Google's models) and a bare id of a provider that names it. Every other id is the vendor's own, kept as it is. */
export const engineModelId = (provider: string, id: string): string => {
  const at = id.indexOf('/');
  const maker = at < 0 ? '' : id.slice(0, at);
  const model = at < 0 ? id : id.slice(at + 1);
  if (maker === 'google') {
    const kept = googlePreviewIds[model] ?? model;
    return kept === model ? id : `${maker}/${kept}`;
  }
  if (provider === 'openrouter' && at < 0) return `${provider}/${id}`;
  return id;
};
// The engine's provider-local id for a kit `provider/model` reference, resolved against that provider's rows.
export const engineId = (provider: string, model: string, rows: readonly unknown[] | undefined): string => {
  for (const row of rows ?? []) {
    if (!record(row) || typeof row.id !== 'string') continue;
    if (row.provider !== undefined && String(row.provider).toLowerCase() !== provider.toLowerCase()) continue;
    if (kitId(provider, row.id) === model) return row.id;
  }
  return model.slice(model.indexOf('/') + 1);
};
// `models.list { agentId, view: 'all' }` rows of the account's provider, mapped to `provider/model`. The pin
// reports no per-plan availability, so `why: 'plan'` only comes from a run ending `plan`, never from here.
export const modelsOf = (provider: string, answer: unknown): ModelInfo[] => {
  const rows = record(answer) && Array.isArray(answer.models) ? answer.models : [];
  const out: ModelInfo[] = [];
  for (const candidate of rows) {
    if (!record(candidate) || typeof candidate.provider !== 'string'
      || candidate.provider.toLowerCase() !== provider.toLowerCase()) continue;
    if (typeof candidate.id !== 'string' || !candidate.id || typeof candidate.name !== 'string') continue;
    const id = kitId(candidate.provider, candidate.id);
    if (providerOf(id) !== provider.toLowerCase()) continue;
    const available = candidate.available === undefined
      ? candidate.unavailableReason === undefined : candidate.available === true;
    const info: ModelInfo = { id, name: candidate.name, available };
    if ((candidate.tier === 'strong' || candidate.tier === 'fast')) info.tier = candidate.tier;
    if (!available) {
      if (candidate.unavailableReason === 'missing-auth' || candidate.unavailableReason === 'auth-failed')
        info.why = 'signed_out';
      else if (candidate.unavailableReason === 'cooldown') {
        info.why = 'resting';
        if (typeof candidate.unavailableUntil === 'number' && Number.isFinite(candidate.unavailableUntil))
          info.until = candidate.unavailableUntil;
      }
    }
    out.push(info);
  }
  return out;
};

// The account's models: its provider's rows, plus the Codex CLI route's rows when the account is ready. The pin reports
// those as missing-auth (no auth reaches the Codex route from the ChatGPT login), so the kit, which holds the login, is the
// signal for them.
export const modelsOfAccount = (row: Pick<Account, 'provider' | 'state'>, answer: unknown): ModelInfo[] => {
  const own = modelsOf(row.provider, answer);
  if (row.provider !== 'openai' || row.state !== 'ready') return own;
  const codex = modelsOf('openai-codex', answer).map(({ why: _why, ...m }) => ({ ...m, available: true }));
  return [...own, ...codex];
};

/** K1: the durable, non-secret link from an account entry to its managed native CLI row (a folder the CLI owns). Allocated once at creation. */
export type NativeBinding = { kind: 'native-cli'; cliAccountId: string; cli: 'claude' };
type IndexEntry = { agent: string; name: string; route: string; addedAt: number; until?: number; model?: string; who?: string;
  priorModel?: string; unavailable?: 'identity_mismatch'; native?: NativeBinding };
type IndexFile = { v: 1; accounts: Record<string, IndexEntry>; defaults: Defaults; gone?: string[]; dropped?: string[] };

type LiveProfile = { provider?: string; profileId?: string; type?: string; status?: string; who?: string };
const ACCOUNT_AGENT = /^[a-z][a-z0-9-]{0,31}--[0-9a-f]{6}$/;
const usable = (status: string | undefined): boolean => status === 'ok' || status === 'expiring' || status === 'static';
const IDENTITY = 'IDENTITY.md';

/** The agent a session lives on (5.15 Runs step 1); `id` absent: the member agent, which may hold several accounts. */
export type Binding = { agentId: string; id?: AccountId };
type AddOptions = { authChoice: string; via?: 'browser' | 'code'; name?: string; again?: AccountId;
  credentialPolicy?: 'in-place' };
type AccountSignIn = { id: AccountId; paste(text: string): void; cancel(): void; done: Promise<{ view: SignInView; id: AccountId }> };
type StartSignIn = (agentId: string, o: SignInOptions, on: (v: SignInView) => void, fresh: boolean, native?: { cliAccountId: string; reauth: boolean }) =>
  { paste(text: string): void; cancel(): void; done: Promise<SignInView> };

const named = (name: unknown, op: string): string => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 100 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`${op}: name is empty`);
  return trimmed;
};
const empty = (): IndexFile => ({ v: 1, accounts: {}, defaults: {} });
const validBinding = (v: unknown): v is NativeBinding => !!v && typeof v === 'object' && (v as NativeBinding).kind === 'native-cli'
  && (v as NativeBinding).cli === 'claude' && typeof (v as NativeBinding).cliAccountId === 'string' && /^pa_[0-9a-f]{18}$/.test((v as NativeBinding).cliAccountId);
const validEntry = (v: unknown): v is IndexEntry => !!v && typeof v === 'object'
  && typeof (v as IndexEntry).agent === 'string' && typeof (v as IndexEntry).name === 'string'
  && typeof (v as IndexEntry).route === 'string' && Number.isFinite((v as IndexEntry).addedAt)
  && ((v as IndexEntry).until === undefined || Number.isFinite((v as IndexEntry).until))
  && ((v as IndexEntry).model === undefined || typeof (v as IndexEntry).model === 'string')
  && ((v as IndexEntry).who === undefined || typeof (v as IndexEntry).who === 'string')
  && ((v as IndexEntry).priorModel === undefined || typeof (v as IndexEntry).priorModel === 'string')
  && ((v as IndexEntry).unavailable === undefined || (v as IndexEntry).unavailable === 'identity_mismatch')
  && ((v as IndexEntry).native === undefined || validBinding((v as IndexEntry).native));
/** The member agent's primary as a durable index string; empty when there was none (or it is not a string primary). */
const priorOf = (model: unknown): string => {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object' && typeof (model as { primary?: unknown }).primary === 'string')
    return (model as { primary: string }).primary;
  return '';
};

const indexPath = (root: string, member: Member): string => join(root, 'accounts', `${member}.json`);
const normalizeIndex = (file: Partial<IndexFile>): IndexFile => {
  if (!file || typeof file !== 'object' || file.v !== 1) return empty();
  const accounts: Record<string, IndexEntry> = {};
  for (const [id, entry] of Object.entries(file.accounts ?? {})) if (validEntry(entry)) accounts[id] = entry;
  const raw = file.defaults && typeof file.defaults === 'object' ? file.defaults as Defaults : {};
  const defaults: Defaults = {};
  if (typeof raw.account === 'string') defaults.account = raw.account;
  if (typeof raw.model === 'string') defaults.model = raw.model;
  if (typeof raw.auto === 'boolean') defaults.auto = raw.auto;
  const gone = Array.isArray(file.gone) ? file.gone.filter((a): a is string => typeof a === 'string' && ACCOUNT_AGENT.test(a)) : [];
  const dropped = Array.isArray(file.dropped)
    ? file.dropped.filter((p): p is string => typeof p === 'string' && !!p && !p.includes('.')) : [];
  return { v: 1, accounts, defaults, ...(gone.length ? { gone } : {}), ...(dropped.length ? { dropped } : {}) };
};
/** Load one member's index. `damaged` means the file exists but is not JSON; the bytes are left alone for repair. */
export function loadIndex(root: string, member: Member): { file: IndexFile; damaged: boolean } {
  let text: string;
  try { text = readFileSync(indexPath(root, member), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: empty(), damaged: false }; throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { file: empty(), damaged: true }; }
  return { file: normalizeIndex(parsed as Partial<IndexFile>), damaged: false };
}
const readIndex = (root: string, member: Member): IndexFile => {
  const loaded = loadIndex(root, member);
  if (loaded.damaged) throw new Error(words('account.indexDamaged', { member }));
  return loaded.file;
};
/** True when `agent` is the member agent or an `<member>--<hex6>` account agent of a damaged index. */
export function heldBackAgent(agent: string, damaged: ReadonlySet<string>): boolean {
  if (damaged.has(agent)) return true;
  if (!ACCOUNT_AGENT.test(agent)) return false;
  return damaged.has(agent.slice(0, agent.lastIndexOf('--')));
}

// Attribution (5.15, O14m): the member an agent id or `agent:<agent>:<tail>` session key belongs to. A member agent is its
// own, and so is an agent whose workspace the kit created for it (a legacy member id may end in `--<hex6>`); any other
// agent, an `<member>--<hex6>` account agent included, maps only while the index names it under that member. Account
// agents share their member's workspace, so an unindexed account-shaped agent maps nowhere and stays unreachable.
export function memberOfAccount(root: string, ref: string): Member | undefined {
  const agent = agentOf(ref);
  if (agent === undefined) return undefined;
  const member = baseMemberOf(agent);
  if (member === undefined || agent === member) return member;
  if (MEMBER_ID.test(agent) && existsSync(join(root, 'workspaces', agent))) return agent;
  try {
    return Object.values(readIndex(root, member).accounts).some((e) => e.agent === agent) ? member : undefined;
  } catch {
    return undefined;
  }
}

// Every agent any readable member's index names. An unreadable `accounts/<member>.json` quarantines only that
// member (held back: not restored, not swept, not resealed away); other members keep restoring, starting and
// persisting. The damaged file is never deleted — re-add rewrites a good index.
function indexedAgents(root: string): { named: Set<string>; gone: Set<string>; damaged: Set<string> } {
  const named = new Set<string>();
  const gone = new Set<string>();
  const damaged = new Set<string>();
  let files: string[];
  try { files = readdirSync(join(root, 'accounts')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { named, gone, damaged }; throw error; }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const member = file.slice(0, -'.json'.length);
    let text: string;
    try { text = readFileSync(join(root, 'accounts', file), 'utf8'); }
    catch { if (MEMBER_ID.test(member)) damaged.add(member); continue; }
    let parsed: Partial<IndexFile>;
    try { parsed = JSON.parse(text) as Partial<IndexFile>; }
    catch {
      if (MEMBER_ID.test(member)) damaged.add(member);
      continue;
    }
    for (const entry of Object.values(parsed.accounts ?? {})) if (typeof entry?.agent === 'string') named.add(entry.agent);
    for (const agent of Array.isArray(parsed.gone) ? parsed.gone : []) if (typeof agent === 'string') gone.add(agent);
  }
  return { named, gone, damaged };
}

/** Members whose `accounts/<member>.json` exists but is not readable JSON. */
export function damagedAccountMembers(root: string): Set<string> {
  return indexedAgents(root).damaged;
}

// Durable removal tombstones, except ids an index now names again. Shared by the live and sealed-store sweeps.
// A damaged member contributes no tombstones and never expands the blast radius of another member's removal.
export function removedAccountAgents(root: string): Set<string> {
  const { named, gone, damaged } = indexedAgents(root);
  return new Set([...gone].filter((agent) => ACCOUNT_AGENT.test(agent) && !named.has(agent) && !heldBackAgent(agent, damaged)));
}

// Providers a removal recorded as dropped from the member agent, except ones an index entry on that member agent names
// again. Parallel to `gone` for account-agent directories: only an intentional removeAccount tombstone is swept, so a
// live subscription that listing synthesizes from the store is never cleared just because the index omitted it.
// Damaged members contribute no tombstones.
function droppedMemberProviders(root: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const { damaged } = indexedAgents(root);
  let files: string[];
  try { files = readdirSync(join(root, 'accounts')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out; throw error; }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const member = file.slice(0, -'.json'.length);
    if (damaged.has(member)) continue;
    let parsed: Partial<IndexFile>;
    try { parsed = JSON.parse(readFileSync(join(root, 'accounts', file), 'utf8')) as Partial<IndexFile>; }
    catch { continue; }
    const named = new Set<string>();
    for (const [id, entry] of Object.entries(parsed.accounts ?? {})) {
      if (typeof entry?.agent !== 'string' || entry.agent !== member || !id) continue;
      named.add(id.split('.')[0]!);
    }
    const drop = new Set<string>();
    for (const provider of Array.isArray(parsed.dropped) ? parsed.dropped : []) {
      if (typeof provider !== 'string' || !provider || provider.includes('.') || named.has(provider)) continue;
      drop.add(provider);
    }
    if (drop.size) out.set(member, drop);
  }
  return out;
}

type MemberAuthStore = {
  profiles?: Record<string, { provider?: string } & Record<string, unknown>>;
  order?: Record<string, unknown>;
  lastGood?: Record<string, unknown>;
};

function dropProviders(store: MemberAuthStore, drop: Set<string>): boolean {
  let changed = false;
  const profiles = store.profiles && typeof store.profiles === 'object' ? store.profiles : {};
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (typeof profile?.provider === 'string' && !drop.has(profile.provider)) continue;
    delete profiles[profileId];
    changed = true;
  }
  store.profiles = profiles;
  if (store.order && typeof store.order === 'object') {
    for (const provider of Object.keys(store.order)) {
      if (!drop.has(provider)) continue;
      delete store.order[provider];
      changed = true;
    }
  }
  if (store.lastGood && typeof store.lastGood === 'object') {
    for (const provider of Object.keys(store.lastGood)) {
      if (!drop.has(provider)) continue;
      delete store.lastGood[provider];
      changed = true;
    }
  }
  return changed;
}

function putAuthProfilesJson(path: string, store: MemberAuthStore): void {
  const staging = `${path}.staging-${process.pid}`;
  writeFileSync(staging, JSON.stringify(store), { mode: 0o600 });
  renameSync(staging, path);
  try { chmodSync(path, 0o600); } catch { /* best-effort mode */ }
}

function sweepMemberAuthProfiles(root: string): void {
  for (const [member, drop] of droppedMemberProviders(root)) {
    const agentDir = join(root, 'state', 'agents', member, 'agent');
    const jsonPath = join(agentDir, 'auth-profiles.json');
    if (existsSync(jsonPath)) {
      try {
        const store = JSON.parse(readFileSync(jsonPath, 'utf8')) as MemberAuthStore;
        if (store && typeof store === 'object' && dropProviders(store, drop)) putAuthProfilesJson(jsonPath, store);
      } catch { /* leave an unreadable store alone; prepare must still finish */ }
    }
    const dbPath = join(agentDir, 'openclaw-agent.sqlite');
    if (!existsSync(dbPath)) continue;
    try {
      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare('SELECT store_json FROM auth_profile_store').get() as { store_json?: string } | undefined;
        if (typeof row?.store_json !== 'string') continue;
        const store = JSON.parse(row.store_json) as MemberAuthStore;
        if (!store || typeof store !== 'object' || !dropProviders(store, drop)) continue;
        db.prepare('UPDATE auth_profile_store SET store_json = ?').run(JSON.stringify(store));
      } finally { db.close(); }
    } catch { /* leave an unreadable native store alone */ }
  }
}

// Removes each `<root>/state/agents/<member>--<hex6>` directory that a removal recorded as gone and no index names,
// and drops member-agent auth profiles a removal recorded as `dropped`. Only recorded directories go: a legacy member's
// own directory is never recorded, so it stays. The directories are listed before the index is read: each listed one was
// created after its entry was written. Damaged members' agents are never swept (their gone/dropped lists are unknown);
// `log` reports each damaged index once.
export function sweepOrphans(root: string, log?: (line: string) => void): void {
  const { damaged } = indexedAgents(root);
  for (const member of damaged) log?.(words('account.indexDamaged', { member }));
  let dirs: string[] = [];
  try { dirs = readdirSync(join(root, 'state', 'agents')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const gone = removedAccountAgents(root);
  for (const dir of dirs) {
    if (!gone.has(dir)) continue;
    rmSync(join(root, 'state', 'agents', dir), { recursive: true, force: true });
  }
  sweepMemberAuthProfiles(root);
}

export function createAccounts(ctx: {
  request: GatewayTransport['request'];
  root: string;
  ensure(member: Member): Promise<{ agentId: string; workspace: string }>;
  locks: ReturnType<typeof createLocks>;
  signIn: StartSignIn;
  // K1: the managed native CLI rows account entries bind to (host-provided; absent where no native login can run).
  native?: { allocate(): Promise<string>; status(id: string): Promise<{ state: string; reason?: UnknownReason }>; remove(id: string): Promise<void> };
  routes: ReadonlyMap<string, { session: string }>; // the runs' map: the caller's key -> the account session its live run uses
  log?: (line: string) => void;
  reseal?: () => Promise<void>; // re-seal the live credential store after a removal (no-op without a seal or a live engine)
  detect?: Detector; // the shared setup detection (one probe per agent, reused briefly)
  catalog?: (provider: string) => ModelInfo[]; // the catalog rows the kit registered for that provider (the live list)
}): {
  list(member: Member): Promise<Account[]>;
  status(member: Member, id: AccountId, o?: { fresh?: boolean }): Promise<AccountStatus>;
  add(member: Member, o: AddOptions, on: (v: SignInView) => void): Promise<AccountSignIn>;
  context(member: Member, id: AccountId): Promise<AccountContext>;
  rename(member: Member, id: AccountId, name: string): Promise<Account>;
  defaults(member: Member): Promise<Defaults>;
  setDefaults(member: Member, d: Defaults): Promise<void>;
  models(member: Member, id: AccountId): Promise<ModelInfo[]>;
  room(member: Member, id: AccountId, demand?: string[]): Promise<Room>;
  bind(member: Member, sessionKey: string): Promise<Binding | undefined>;
  keyRefusal(member: Member, binding: Binding): Promise<string | undefined>;
  key(member: Member, route: Pick<RouteView, 'choice' | 'provider' | 'label'>): Promise<void>;
  unkey(member: Member, provider?: string): Promise<void>;
  backfill(member: Member, found: Pick<RouteView, 'choice' | 'provider' | 'label'>[]): Promise<void>;
  pick(member: Member, sel: RunSelection, skip?: readonly AccountId[], binding?: Binding): Promise<{ pick: AccountPick; agent?: string }>;
  rest(member: Member, id: AccountId, until: number): Promise<void>;
  move(member: Member, sessionKey: string, to: AccountId, intoTail?: string): Promise<MoveResult>;
  remove(member: Member, id: AccountId): Promise<void>;
} {
  const path = (member: Member): string => indexPath(ctx.root, member);
  const read = (member: Member): IndexFile => {
    const loaded = loadIndex(ctx.root, member);
    if (loaded.damaged) {
      const message = words('account.indexDamaged', { member });
      ctx.log?.(message);
      throw new Error(message);
    }
    return loaded.file;
  };
  // Accounts whose sign-in is running, as `<member>\n<id>`, counted per add: listed `signing` until the last one ends.
  const signing = new Map<string, number>();
  // The index file's own lock, apart from any agent's: a run's shared hold on the member agent never blocks an edit.
  const indexLock = (member: Member): string => `${member}#index`;
  const check = (member: Member): void => {
    if (!MEMBER_ID.test(member) || member.startsWith(KEY_PREFIX)) throw new Error(`invalid member id: ${member}`);
  };
  const dropEntry = (file: IndexFile, id: AccountId): void => {
    delete file.accounts[id];
    if (file.defaults.account === id) delete file.defaults.account;
  };
  const markGone = (file: IndexFile, agent: string): void => { if (!file.gone?.includes(agent)) file.gone = [...(file.gone ?? []), agent]; };
  const markDropped = (file: IndexFile, provider: string): void => {
    if (!file.dropped?.includes(provider)) file.dropped = [...(file.dropped ?? []), provider];
  };
  const clearDropped = (file: IndexFile, provider: string): void => {
    if (!file.dropped?.includes(provider)) return;
    file.dropped = file.dropped.filter((p) => p !== provider);
    if (!file.dropped.length) delete file.dropped;
  };
  const write = (member: Member, file: IndexFile): void => {
    mkdirSync(join(ctx.root, 'accounts'), { recursive: true, mode: 0o700 });
    const tmp = `${path(member)}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
    chmodSync(tmp, 0o600);
    try { renameSync(tmp, path(member)); chmodSync(path(member), 0o600); }
    finally { rmSync(tmp, { force: true }); }
  };
  const metaOf = (choice: string): { label: string; billing: 'subscription' | 'api' } => {
    const row = routes().find((r) => r.choice === choice);
    if (row && (row.billing === 'subscription' || row.billing === 'api')) return { label: row.label, billing: row.billing };
    return { label: choice, billing: 'subscription' };
  };
  const synthesizedRoute = (provider: string): string =>
    routeFor(provider, 'browser')?.choice
    ?? routes().find((r) => r.provider === provider && r.billing === 'subscription')?.choice
    ?? provider;
  const agentRoster = (): Promise<Set<string>> =>
    (ctx.request('agents.list') as Promise<{ agents: { id: string }[] }>).then((r) => new Set(r.agents.map((a) => a.id)));
  const rosterOf = (): Promise<Set<string>> => agentRoster().catch(() => new Set<string>());
  // Undefined: the agent's profiles could not be read (a failed request or an unreadable store), which says nothing about
  // its sign-ins; an empty list is a real answer.
  const profilesOf = (agentId: string): Promise<LiveProfile[] | undefined> =>
    (ctx.request('byokit.accounts', { action: 'list', agentId }) as Promise<{ profiles?: LiveProfile[] }>)
      .then((r) => Array.isArray(r.profiles) ? r.profiles : undefined, () => undefined);
  // `unread`: why this account's sign-in could not be checked. A missing profile is then unknown, never signed out.
  const stateOf = (route: string, status: string | undefined, until: number | undefined, unread?: UnknownReason): SignInState => {
    if (!routes().some((r) => r.choice === route)) return 'not_included';
    if (until !== undefined && until > Date.now()) return 'resting';
    if (!status) return unread ? 'unknown' : 'signed_out';
    return usable(status) ? 'ready' : status === 'expired' ? 'needs_again' : 'signed_out';
  };
  // One list row. A row whose re-sign-in was another principal reads needs_again whatever its store holds (never run as the new one).
  const rowOf = (id: AccountId, provider: string, entry: IndexEntry, status: string | undefined, origin: 'managed' | 'installed', unread?: UnknownReason): Account => {
    const meta = metaOf(entry.route);
    return { id, provider, route: entry.route, name: entry.name, label: meta.label, billing: meta.billing,
      state: entry.unavailable ? 'needs_again' : stateOf(entry.route, status, entry.until, unread),
      ...(entry.until !== undefined ? { until: entry.until } : {}), addedAt: entry.addedAt,
      ...(entry.unavailable ? { unavailable: entry.unavailable } : {}),
      origin, capabilities: origin === 'installed' ? ['rename'] : ['rename', 'remove', 'reauth'] };
  };
  // A bound account is read through its binding: the native CLI's own status, never the engine's profile store.
  const nativeOf = async (b: NativeBinding): Promise<{ status?: string; unread?: UnknownReason }> => {
    const live = await ctx.native?.status(b.cliAccountId).catch(() => undefined);
    if (!live) return { unread: 'unavailable' };
    return live.state === 'ready' ? { status: 'ok' } : live.state === 'unknown' ? { unread: live.reason ?? 'unavailable' } : {};
  };
  // Lock-free row builder over one snapshot: mutates `file` (synthesized entries, `who` backfill, dropped
  // dangling default) and reports whether it did. Callers own the locking.
  const build = async (member: Member, agentId: string, file: IndexFile, roster: Set<string>,
    memberProfiles: LiveProfile[], memberUnread: (id: string) => UnknownReason | undefined = () => undefined,
  ): Promise<{ rows: Account[]; dirty: boolean }> => {
    let dirty = false;
    const unread = new Map<string, UnknownReason>();
    const byProvider = new Map<string, LiveProfile[]>();
    for (const p of memberProfiles) {
      if (typeof p.provider !== 'string' || !p.provider) continue;
      byProvider.set(p.provider, [...(byProvider.get(p.provider) ?? []), p]);
    }
    const memberRows: Account[] = [];
    const seen = new Set<string>();
    for (const [provider, profiles] of [...byProvider.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
      // A removeAccount tombstone wins until the person signs in again: do not synthesize the removed row back.
      if (file.dropped?.includes(provider)) continue;
      let entry = file.accounts[provider];
      if (!entry || entry.agent !== agentId) {
        const route = entry?.agent === agentId && typeof entry.route === 'string' ? entry.route : synthesizedRoute(provider);
        const same = Object.values(file.accounts).filter((e) => e.agent === agentId).length;
        entry = { agent: agentId, name: `${metaOf(route).label} ${same + 1}`, route, addedAt: 0 };
        file.accounts[provider] = entry;
        dirty = true;
      }
      // Not while the member agent's own sign-in runs: settle decides whose that `who` is (it may be adopted away).
      if (typeof profiles[0]?.who === 'string' && entry.who !== profiles[0].who && !entry.unavailable && !signing.has(`${member}\n${provider}`)) { entry.who = profiles[0].who; dirty = true; }
      memberRows.push(rowOf(provider, provider, entry, profiles[0]?.status, profiles[0]?.profileId === undefined ? 'installed' : 'managed'));
      seen.add(provider);
    }
    for (const [id, entry] of Object.entries(file.accounts)) {
      if (entry.agent !== agentId || id.includes('.') || seen.has(id)) continue;
      const why = memberUnread(id);
      if (why) unread.set(id, why);
      memberRows.push(rowOf(id, id, entry, undefined, 'managed', why));
    }
    // Account agents: only what the index names, with exactly `<member>--<hex6>` shape. An unindexed
    // agent of that shape is never listed, and an entry whose agent is gone is not listed either.
    const agentRows: Account[] = [];
    for (const [id, entry] of Object.entries(file.accounts)) {
      if (entry.agent === agentId || !ACCOUNT_AGENT.test(entry.agent) || !entry.agent.startsWith(`${member}--`)) continue;
      if (!roster.has(entry.agent)) continue;
      const provider = id.split('.')[0]!;
      if (entry.native) {
        const live = await nativeOf(entry.native);
        if (live.unread) unread.set(id, live.unread);
        agentRows.push(rowOf(id, provider, entry, live.status, 'managed', live.unread));
        continue;
      }
      const profiles = await profilesOf(entry.agent);
      const who = profiles?.find((p) => p.provider === provider)?.who;
      if (!profiles) unread.set(id, 'unavailable');
      if (!entry.who && typeof who === 'string' && !signing.has(`${member}\n${id}`)) { entry.who = who; dirty = true; }
      agentRows.push(rowOf(id, provider, entry, profiles?.[0]?.status, 'managed', unread.get(id)));
    }
    memberRows.sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1));
    agentRows.sort((a, b) => a.addedAt - b.addedAt);
    // The API-key lane: the member's single key agent, indexed once as `<provider>.key`. Only what the index
    // names is listed; a key agent the index does not name holds no account.
    const keyRows: Account[] = [];
    for (const [id, entry] of Object.entries(file.accounts)) {
      if (entry.agent !== keyAgentId(member) || !roster.has(entry.agent)) continue;
      const provider = id.split('.')[0]!;
      const profiles = await profilesOf(entry.agent);
      const who = profiles?.find((p) => p.provider === provider)?.who;
      if (!profiles) unread.set(id, 'unavailable');
      if (!entry.who && typeof who === 'string' && !signing.has(`${member}\n${id}`)) { entry.who = who; dirty = true; }
      keyRows.push(rowOf(id, provider, entry, profiles?.[0]?.status, 'managed', unread.get(id)));
    }
    keyRows.sort((a, b) => a.addedAt - b.addedAt);
    const rows = [...memberRows, ...agentRows, ...keyRows];
    for (const row of rows) {
      if (signing.has(`${member}\n${row.id}`)) row.state = 'signing';
      else if (row.state === 'unknown') { row.reason = unread.get(row.id)!; row.retryAfterMs = RETRY_AFTER_MS; }
    }
    if (file.defaults.account !== undefined && !rows.some((r) => r.id === file.defaults.account)) {
      delete file.defaults.account;
      dirty = true;
    }
    return { rows, dirty };
  };
  // A detected Claude Code login has no profile in the kit: it stays in Claude Code. The engine's detection says whether
  // it is there, and a detected one is the member's signed-in claude-cli profile for this read. The shared detection
  // answers it for every reader (one probe per agent, reused briefly), so a listing and a readiness read cost one probe.
  // A failed or indeterminate probe is a reason, not a login: it reads unknown, never as Claude Code being signed out.
  const claudeDetected = (agentId: string): Promise<boolean | UnknownReason> =>
    detection(ctx.request, agentId, ctx.detect)
      .then((r) => indeterminate(r) ? 'unreadable' : r.candidates?.some((c) => c.kind === 'claude-cli' && c.credentials === true) === true, reasonOf);
  const gather = async (agentId: string): Promise<[Set<string>, LiveProfile[], (id: string) => UnknownReason | undefined]> => {
    const [roster, listed, claude] = await Promise.all([rosterOf(), profilesOf(agentId), claudeDetected(agentId)]);
    const profiles = listed ?? [];
    const unread = (id: string): UnknownReason | undefined =>
      listed === undefined ? 'unavailable' : id === 'claude-cli' && typeof claude === 'string' ? claude : undefined;
    return [roster, claude === true && !profiles.some((p) => p.provider === 'claude-cli') ? [...profiles, { provider: 'claude-cli', status: 'ok' }] : profiles, unread];
  };
  const buildRows = async (member: Member, agentId: string) => {
    const file = read(member);
    const [roster, profiles, unread] = await gather(agentId);
    return { ...(await build(member, agentId, file, roster, profiles, unread)), file };
  };
  // The account's index entry, only when `list` names it: an unindexed agent is never reachable, whatever the
  // file holds.
  const entryOf = async (member: Member, id: AccountId): Promise<{ row: Account; entry: IndexEntry }> => {
    const row = (await list(member)).find((r) => r.id === id);
    const entry = read(member).accounts[id];
    if (!row || !entry) throw new Error(`unknown account: ${id}`);
    return { row, entry };
  };
  const spanOf = (label: string): RoomSpan => {
    const lower = label.toLowerCase();
    if (lower === 'session') return 'session';
    if (lower === 'weekly') return 'week';
    if (lower === 'monthly') return 'month';
    return 'tightest';
  };
  // The `models.authStatus { agentId }` row for the account's provider: of its `usage.windows` entries the one
  // with the highest numeric `usedPercent` gives `left`, `resetsAt` and `span`. A window applies to every model
  // unless the engine scopes it to models; the pin's rows carry no scope, so the demand never narrows them today
  // (the tightest known). A window without a numeric `usedPercent` is skipped, never read as unused. `at` is left
  // out: the pin exposes no reading age, so the kit never stamps receipt time as reading time. The kit adds no
  // cache: every call reads live.
  const roomOf = (provider: string, answer: unknown): Room => {
    const unknown: Room = { left: 'unknown' };
    const rows = record(answer) && Array.isArray(answer.providers) ? answer.providers : undefined;
    if (!rows) return unknown;
    const row = rows.find((r) => record(r) && typeof r.provider === 'string'
      && r.provider.toLowerCase() === provider.toLowerCase());
    if (!row || !record(row)) return unknown;
    const windows = record(row.usage) && Array.isArray(row.usage.windows) ? row.usage.windows : undefined;
    if (!windows) return unknown;
    let best: { used: number; resetAt?: number; span: RoomSpan } | undefined;
    for (const candidate of windows) {
      if (!record(candidate)) continue;
      if (typeof candidate.usedPercent !== 'number' || !Number.isFinite(candidate.usedPercent)) continue;
      const span = spanOf(typeof candidate.label === 'string' ? candidate.label : '');
      const resetAt = typeof candidate.resetAt === 'number' && Number.isFinite(candidate.resetAt)
        ? candidate.resetAt : undefined;
      if (!best || candidate.usedPercent > best.used)
        best = { used: candidate.usedPercent, ...(resetAt !== undefined ? { resetAt } : {}), span };
    }
    if (!best) return unknown;
    return { left: 100 - best.used, span: best.span, ...(best.resetAt !== undefined ? { resetsAt: best.resetAt } : {}) };
  };

  async function list(member: Member): Promise<Account[]> {
    check(member);
    const { agentId } = await ctx.ensure(member);
    const first = await ctx.locks.shared(indexLock(member), () => buildRows(member, agentId));
    if (!first.dirty) return first.rows;
    // A write is needed (synthesized entry, `who` backfill or dropped default): redo it under the
    // exclusive lock so two first-lists cannot interleave their read-modify-write.
    return ctx.locks.exclusive([indexLock(member)], async () => {
      const { rows, dirty, file } = await buildRows(member, agentId);
      if (dirty) write(member, file);
      return rows;
    });
  }

  // One account's sign-in. `fresh` drops only that account's earlier probe; its siblings keep theirs. A limit rest is
  // still signed in, so it reads ready here (`list` says resting).
  async function status(member: Member, id: AccountId, o?: { fresh?: boolean }): Promise<AccountStatus> {
    check(member);
    const { agentId } = await ctx.ensure(member);
    if (o?.fresh) ctx.detect?.invalidate(read(member).accounts[id]?.agent ?? agentId);
    const row = (await list(member)).find((r) => r.id === id);
    if (!row) throw new Error(`unknown account: ${id}`);
    const checkedAt = Date.now();
    if (row.state === 'unknown') return { state: 'unknown', checkedAt, reason: row.reason ?? 'unavailable', retryAfterMs: row.retryAfterMs ?? RETRY_AFTER_MS };
    return { state: row.state === 'ready' || row.state === 'resting' ? 'ready' : 'signed_out', checkedAt };
  }

  async function rename(member: Member, id: AccountId, name: string): Promise<Account> {
    check(member);
    const trimmed = named(name, 'renameAccount');
    if (!(await list(member)).some((r) => r.id === id)) throw new Error(`unknown account: ${id}`);
    await ctx.locks.exclusive([indexLock(member)], async () => {
      const file = read(member);
      const entry = file.accounts[id];
      if (!entry) throw new Error(`unknown account: ${id}`);
      entry.name = trimmed;
      write(member, file);
    });
    const done = (await list(member)).find((r) => r.id === id);
    if (!done) throw new Error(`unknown account: ${id}`);
    return done;
  }

  async function defaults(member: Member): Promise<Defaults> {
    await list(member);
    return read(member).defaults;
  }

  async function setDefaults(member: Member, d: Defaults): Promise<void> {
    check(member);
    if (!d || typeof d !== 'object') throw new Error('setDefaults: defaults are invalid');
    if (d.account !== undefined && typeof d.account !== 'string') throw new Error('setDefaults: defaults are invalid');
    if (d.model !== undefined && typeof d.model !== 'string') throw new Error('setDefaults: defaults are invalid');
    if (d.auto !== undefined && typeof d.auto !== 'boolean') throw new Error('setDefaults: defaults are invalid');
    await ctx.ensure(member);
    return ctx.locks.exclusive([indexLock(member)], async () => {
      const file = read(member);
      const next: Defaults = {};
      if (d.account !== undefined) next.account = d.account;
      if (d.model !== undefined) next.model = d.model;
      if (d.auto !== undefined) next.auto = d.auto;
      write(member, { ...file, defaults: next });
    });
  }

  async function models(member: Member, id: AccountId): Promise<ModelInfo[]> {
    check(member);
    await ctx.ensure(member);
    const { row, entry } = await entryOf(member, id);
    return readModels(row, entry);
  }
  // The account's models: the engine's own rows, joined with the catalog rows the kit registered for that provider
  // (the provider's live list). The engine's list can lag the registration, and a model the picker offered must
  // stay pickable: the kit registered it, so the engine can run it. The engine's own row wins where both name it.
  const withCatalog = (row: Account, own: ModelInfo[]): ModelInfo[] => {
    const registered = ctx.catalog?.(row.provider) ?? [];
    if (!registered.length) return own;
    const byId = new Map(own.map((m) => [m.id, m]));
    for (const model of registered) if (!byId.has(model.id)) byId.set(model.id, model);
    return [...byId.values()];
  };
  // 9.33's bootstrap catalog omits CLI/provider rows. Prepare once per agent/config, not once per pick.
  // Keep only completion/pending work: every later read still gets fresh native availability. Reconnect recreates us.
  // ponytail: whole-config witness; narrow it if unrelated hot config writes make discovery expensive.
  const preparedModels = new Map<string, { stamp: string; pending?: Promise<unknown> }>();
  // The shared hold covers the read, so no kit read of the agent is in flight while it is removed.
  const readModels = (row: Account, entry: IndexEntry): Promise<ModelInfo[]> => ctx.locks.shared(entry.agent, async () => {
    let stamp: string | undefined;
    try {
      const s = statSync(join(ctx.root, 'openclaw.json'), { bigint: true });
      stamp = [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
    } catch { /* an unreadable witness never reuses preparation */ }
    let prepared = stamp === undefined ? undefined : preparedModels.get(entry.agent);
    let answer: unknown;
    if (!prepared || prepared.stamp !== stamp) {
      const pending = ctx.request('models.list', { agentId: entry.agent, view: 'all', refresh: true }, { timeoutMs: 120_000 });
      prepared = { stamp: stamp ?? '', pending };
      if (stamp !== undefined) preparedModels.set(entry.agent, prepared);
      try {
        answer = await pending;
        if (!record(answer) || answer.refreshFailed === true) {
          if (preparedModels.get(entry.agent) === prepared) preparedModels.delete(entry.agent);
        } else delete prepared.pending;
      } catch (error) {
        if (preparedModels.get(entry.agent) === prepared) preparedModels.delete(entry.agent);
        throw error;
      }
    } else answer = await (prepared.pending ?? ctx.request('models.list', { agentId: entry.agent, view: 'all' }));
    return withCatalog(row, modelsOfAccount(row, answer));
  });

  async function room(member: Member, id: AccountId, demand?: string[]): Promise<Room> {
    check(member);
    await ctx.ensure(member);
    const { row, entry } = await entryOf(member, id);
    return readRoom(row, entry);
  }
  // An API-key account is used only when chosen, never by Auto: its room is always unknown, with no read. A demand
  // never narrows the windows (see `roomOf`), so the read takes none.
  const readRoom = (row: Account, entry: IndexEntry): Promise<Room> => row.billing === 'api'
    ? Promise.resolve({ left: 'unknown' })
    : ctx.locks.shared(entry.agent, async () => {
      let answer: unknown;
      try {
        answer = await ctx.request('models.authStatus', { agentId: entry.agent }, { timeoutMs: 20_000 });
      } catch {
        return { left: 'unknown' } as Room;
      }
      return roomOf(row.provider, answer);
    });

  // Runs step 2 reads the index alone: the index-only refusal makes no request, and a cold index adds one account
  // listing (the pick's late check after `list`; `keyRefusal` lists unless the binding is the key lane). This
  // gives the accounts a binding holds, in list order, and the name a refusal shows (`account.another` when it holds none).
  const boundOf = (file: IndexFile, binding: Binding): AccountId[] => binding.id !== undefined ? [binding.id]
    : Object.entries(file.accounts).filter(([, e]) => e.agent === binding.agentId)
      .sort(([a, x], [b, y]) => x.addedAt - y.addedAt || (a < b ? -1 : 1)).map(([id]) => id);
  const nameOf = (file: IndexFile, ids: AccountId[]): string => {
    const first = ids[0] === undefined ? undefined : file.accounts[ids[0]];
    return first?.name ?? words('account.another');
  };
  // A pick's refusal: `bound` names an id outside the binding's accounts, `paid` an id other than an API-billed
  // binding's own. A named id the index does not hold is left to the pick, which reports it as unknown.
  const refusalOf = (file: IndexFile, binding: Binding, sel: RunSelection): { code: 'bound' | 'paid'; name: string } | undefined => {
    const named = sel.account === 'auto' || sel.account === 'default' ? undefined : sel.account;
    if (named !== undefined && file.accounts[named] === undefined) return undefined;
    const ids = boundOf(file, binding);
    const held = binding.id === undefined ? undefined : file.accounts[binding.id];
    if (held && metaOf(held.route).billing === 'api' && named !== binding.id) return { code: 'paid', name: held.name };
    if (named !== undefined && !ids.includes(named)) return { code: 'bound', name: nameOf(file, ids) };
    return undefined;
  };
  // An API-key run (Runs step 2): its key continues its own lane's conversation whatever the key bills (a
  // plan key bills subscription), and any other binding is refused.
  const keyRefusal = async (member: Member, binding: Binding): Promise<string | undefined> => {
    if (binding.agentId === keyAgentId(member)) return undefined;
    await list(member);
    const file = read(member);
    return words('account.bound', { name: nameOf(file, boundOf(file, binding)) });
  };

  // Runs step 1 (5.15): a key `agent:<member>--<hex6>:<tail>` of an indexed account agent is bound to that account. A key
  // `agent:<member>:<tail>` is bound to whichever of the member's agents holds `agent:<that agent>:<tail>` (member agent
  // first, then the key lane, whose account is its `<provider>.key`, then the account agents), else unbound. Any other key
  // is not the member's. With no account agent and no indexed lane, the member agent and an unbound key run alike, so
  // nothing is asked.
  async function bind(member: Member, sessionKey: string): Promise<Binding | undefined> {
    check(member);
    const file = read(member);
    const agents = new Map(Object.entries(file.accounts)
      .filter(([, e]) => ACCOUNT_AGENT.test(e.agent) && e.agent.startsWith(`${member}--`)).map(([id, e]) => [e.agent, id]));
    const lane = keyAgentId(member);
    const laneId = Object.entries(file.accounts).find(([, e]) => e.agent === lane)?.[0];
    if (!sessionKey.startsWith(`agent:${member}:`)) {
      const agent = /^agent:([^:]+):/.exec(sessionKey)?.[1];
      const id = agent === undefined ? undefined : agents.get(agent);
      if (id === undefined) throw new Error(`refused: "${sessionKey}" is not a session of member "${member}"`);
      return { agentId: agent!, id };
    }
    if (!agents.size && laneId === undefined) return undefined;
    const tail = sessionKey.slice(`agent:${member}:`.length);
    const { agentId } = await ctx.ensure(member);
    const roster = new Set((await ctx.request('agents.list') as { agents: { id: string }[] }).agents.map((a) => a.id));
    const laneProbe = laneId === undefined ? [] : [[lane, laneId] as const];
    for (const [agent, id] of [[agentId, undefined] as const, ...laneProbe, ...agents]) {
      if (agent !== agentId && !roster.has(agent)) continue;
      // The pin answers a found session with its canonical `key` and a missing one with `{ ok: false }`.
      const found = await ctx.request('sessions.resolve', { key: `agent:${agent}:${tail}`, agentId: agent, allowMissing: true }) as { key?: string };
      if (found.key !== undefined) return id === undefined ? { agentId: agent } : { agentId: agent, id };
    }
    return undefined;
  }

  // Choosing (5.15): every pick input's room and models are read live once (unnamed key lanes are excluded),
  // then the pure `resolveSelection` decides. A binding narrows it (Runs step 2): a key bound to an account agent resolves 'auto', 'default' and no id to
  // that account; a key bound to the key lane resolves to its `<provider>.key` account; a key bound to the member agent
  // chooses only among its own accounts. A refusal (`bound`, `paid`) is decided from the index, after the account
  // listing when the index is cold, and so has no `considered` rows.
  // An unknown id stays the caller bug it always was. `agent` is the picked account's engine agent. A model unavailable
  // only because the account is signed out or resting is still in its plan: the account's state and the run's ready
  // check judge that.
  // The pinned engine may hold no prepared model catalog for an agent added since it started, and refuses its models; that
  // row's models are then unknown (`undefined`), and `resolveSelection` host-validates its membership by provider.
  async function pick(member: Member, sel: RunSelection, skip: readonly AccountId[] = [], binding?: Binding): Promise<{ pick: AccountPick; agent?: string }> {
    check(member);
    const refused = (refusal: { code: 'bound' | 'paid'; name: string }): { pick: AccountPick } => ({ pick: { ok: false, code: refusal.code,
      reason: words(`account.${refusal.code}`, { name: refusal.name }), considered: [] } });
    const early = binding?.id !== undefined ? refusalOf(read(member), binding, sel) : undefined;
    if (early) return refused(early);
    const listed = await list(member);
    const file = read(member);
    const late = binding && refusalOf(file, binding, sel);
    if (late) return refused(late);
    if (binding?.id !== undefined && !listed.some((r) => r.id === binding.id))
      return { pick: { ok: false, code: 'none', reason: words('auto.noneBound'), considered: [] } };
    const rows = listed.filter((r) => !skip.includes(r.id));
    const named = sel.account === 'auto' || sel.account === 'default' ? undefined : sel.account;
    const known = named === undefined || listed.some((r) => r.id === named);
    if (binding?.id !== undefined && known) sel = { ...sel, account: binding.id };
    const bound = binding && known ? boundOf(file, binding) : undefined;
    // The key lane is reached only by naming it (or the saved default): an unnamed lane row is not a pick input, so
    // Auto and a default fallback see exactly the accounts they saw before the lane was indexed.
    const lanes = new Set(Object.entries(file.accounts).filter(([, e]) => e.agent === keyAgentId(member)).map(([id]) => id));
    const pickRows = rows.filter((r) => !lanes.has(r.id) || sel.account === r.id ||
      (sel.account === 'default' && file.defaults.account === r.id));
    const reads = new Map(await Promise.all(pickRows.map(async (row) => {
      const entry = file.accounts[row.id]!;
      const models = await readModels(row, entry).then((ms) => ms.map((m) => (m.why ? { ...m, available: true } : m)), () => undefined);
      return [row.id, { room: await readRoom(row, entry), models }] as const;
    })));
    const chosen = resolveSelection(pickRows, file.defaults, sel, (a) => reads.get(a.id)!.room, Date.now(),
      (a) => reads.get(a.id)!.models, bound);
    return { pick: chosen, ...(chosen.ok ? { agent: file.accounts[chosen.account.id]!.agent } : {}) };
  }

  // Moving a conversation (5.15, O14 step S12): the key binds as a run's does (with no account agent binding asks
  // nothing, and the member agent holds it if anything does), and its `sessions.list` row decides unsupported and busy
  // before any lock. Same agent: nothing moves, the next run names the account. Otherwise, under both agents' locks and
  // on the row read again there, the source's whole transcript forks into `agent:<target>:<tail>` (never `chat.history`
  // plus `chat.inject`, which drop tool rows), then the source is deleted only if it is still the session read. A
  // refused fork leaves the source untouched; a refused delete leaves both, the new key live. `intoTail` (a helper's
  // adoption, 5.8.3) forks it under another tail on the target, the same agent included.
  async function move(member: Member, sessionKey: string, to: AccountId, intoTail?: string): Promise<MoveResult> {
    check(member);
    const failed = (code: Extract<MoveResult, { ok: false }>['code'], message: string, live?: string): MoveResult =>
      ({ ok: false, code, message, ...(live === undefined ? {} : { live }) });
    const { agentId: memberAgent } = await ctx.ensure(member);
    const { agentId: source } = await bind(member, sessionKey) ?? { agentId: memberAgent };
    const { row, entry } = await entryOf(member, to);
    const tail = sessionKey.slice(sessionKey.indexOf(':', 'agent:'.length) + 1);
    const from = `agent:${source}:${tail}`;
    const into = `agent:${entry.agent}:${intoTail ?? tail}`;
    const read = async (): Promise<{ refused: MoveResult } | { found: Record<string, unknown> }> => {
      const listed = await ctx.request('sessions.list', { agentId: source, search: from }) as { sessions?: unknown[] };
      const found = (Array.isArray(listed.sessions) ? listed.sessions : [])
        .find((r): r is Record<string, unknown> => record(r) && typeof r.key === 'string' && r.key.toLowerCase() === from.toLowerCase());
      if (!found) return { refused: failed('unsupported', words('move.unsupported')) };
      const live = found.hasActiveRun === true || [...ctx.routes].some(([key, route]) => key === sessionKey || route.session === from);
      return live ? { refused: failed('busy', words('move.busy')) } : { found };
    };
    const first = await read();
    if ('refused' in first) return first.refused;
    if (row.state !== 'ready') return failed('start_failed', words('move.notReady', { name: row.name }));
    if (into === from) return { ok: true, session: into };
    return ctx.locks.exclusive([source, entry.agent], async () => {
      const again = await read();
      if ('refused' in again) return again.refused;
      const session = again.found;
      // A conversation already under the target key is never overwritten: the move is refused, the source untouched.
      const taken = await ctx.request('sessions.resolve', { key: into, agentId: entry.agent, allowMissing: true }) as { key?: string };
      if (taken.key !== undefined) return failed('start_failed', words('move.taken', { name: row.name }));
      // The session's model when the target lists it, else the target's first available; the read takes no shared
      // hold (this move holds the target exclusively). With no answer the fork keeps the parent's own selection.
      const answer = await ctx.request('models.list', { agentId: entry.agent, view: 'all' }).catch(() => undefined);
      const models = answer === undefined ? [] : modelsOfAccount(row, answer);
      const sessionProvider = typeof session.modelProvider === 'string' ? session.modelProvider.toLowerCase() : undefined;
      const current = typeof session.model !== 'string' ? undefined
        : (sessionProvider === undefined ? session.model : kitId(sessionProvider, session.model)).toLowerCase();
      const model = models.find((m) => m.id.toLowerCase() === current)?.id ?? models.find((m) => m.available)?.id;
      const rows = record(answer) && Array.isArray(answer.models) ? answer.models : [];
      const local = model === undefined ? undefined : engineId(row.provider, model, rows);
      const ref = model === undefined || local === undefined ? undefined
        : providerOf(model) === row.provider ? `${row.provider}/${local}` : model;
      try {
        await ctx.request('sessions.create', { agentId: entry.agent, key: into, parentSessionKey: from, fork: true, ...(ref ? { model: ref } : {}) });
      } catch (error) {
        return failed('start_failed', (error instanceof Error ? error.message : String(error)).slice(0, 200));
      }
      const closed = await ctx.request('sessions.delete', { key: from, agentId: source, deleteTranscript: true,
        ...(typeof session.sessionId === 'string' ? { expectedSessionId: session.sessionId } : {}),
        ...(typeof session.updatedAt === 'number' ? { expectedSessionUpdatedAt: session.updatedAt } : {}) })
        .then((answer) => record(answer) && answer.deleted === true, (error: unknown) => {
          ctx.log?.(`move: ${from} is kept: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        });
      if (!closed) return failed('close_failed', words('move.closeFailed', { name: row.name }), into);
      return { ok: true, session: into };
    });
  }

  // A run on the account ended resting: Auto skips it until `until` (its state reads `resting` until then).
  const rest = (member: Member, id: AccountId, until: number): Promise<void> =>
    edit(member, (file) => { const entry = file.accounts[id]; if (entry) entry.until = until; });

  const agentDir = (agent: string): string => join(ctx.root, 'state', 'agents', agent);

  const laneEntry = (member: Member, route: Pick<RouteView, 'choice' | 'label'>, addedAt: number): IndexEntry =>
    ({ agent: keyAgentId(member), name: route.label, route: route.choice, addedAt });
  // The API-key lane's index entry (5.15): one per member, `<provider>.key` on the `byokit-key-<member>` agent.
  // A new key replaces the old one: whatever lane entry the member holds is dropped first, keeping its `addedAt`.
  // The key itself is never stored: only the agent, the route choice and the name.
  async function key(member: Member, route: Pick<RouteView, 'choice' | 'provider' | 'label'>): Promise<void> {
    check(member);
    const lane = keyAgentId(member);
    return ctx.locks.exclusive([indexLock(member)], async () => {
      const loaded = loadIndex(ctx.root, member);
      if (loaded.damaged) { ctx.log?.(words('account.indexDamaged', { member })); return; }
      const file = loaded.file;
      const kept = Object.values(file.accounts).find((e) => e.agent === lane)?.addedAt;
      for (const [other, e] of Object.entries(file.accounts)) if (e.agent === lane) delete file.accounts[other];
      file.accounts[`${route.provider}.key`] = laneEntry(member, route, kept ?? Date.now());
      write(member, file);
    });
  }

  // The removal's counterpart to `key`: drop the lane's index entry, so `list` stops naming the removed key.
  // `provider` scopes it to that provider's entry (a scoped removal that kept another provider's key keeps its
  // entry too); without one every lane entry goes. A damaged index is left alone, like `key` leaves it.
  async function unkey(member: Member, provider?: string): Promise<void> {
    check(member);
    const lane = keyAgentId(member);
    return ctx.locks.exclusive([indexLock(member)], async () => {
      const loaded = loadIndex(ctx.root, member);
      if (loaded.damaged) { ctx.log?.(words('account.indexDamaged', { member })); return; }
      const file = loaded.file;
      for (const [id, e] of Object.entries(file.accounts)) {
        if (e.agent !== lane || (provider !== undefined && id.split('.')[0] !== provider)) continue;
        dropEntry(file, id);
      }
      write(member, file);
    });
  }

  // The connect sweep's backfill: a lane that holds no entry is indexed under the one route its model's provider has;
  // any other count is logged and left unindexed. A lane that holds an entry is never touched, nor a damaged index.
  async function backfill(member: Member, found: Pick<RouteView, 'choice' | 'provider' | 'label'>[]): Promise<void> {
    check(member);
    const lane = keyAgentId(member);
    return ctx.locks.exclusive([indexLock(member)], async () => {
      const loaded = loadIndex(ctx.root, member);
      if (loaded.damaged) { ctx.log?.(words('account.indexDamaged', { member })); return; }
      if (Object.values(loaded.file.accounts).some((e) => e.agent === lane)) return;
      if (found.length !== 1) {
        ctx.log?.(`key lane ${member}: its provider has no single key route, so it is not indexed; add the key again to index it`);
        return;
      }
      loaded.file.accounts[`${found[0]!.provider}.key`] = laneEntry(member, found[0]!, Date.now());
      write(member, loaded.file);
    });
  }

  // Index edits take the index lock, as listing's own write does. A damaged index starts empty and is rewritten
  // (re-add's repair path); the bad bytes are replaced, never left as the live index after a successful write.
  const edit = (member: Member, fn: (file: IndexFile) => void): Promise<void> =>
    ctx.locks.exclusive([indexLock(member)], async () => {
      const loaded = loadIndex(ctx.root, member);
      if (loaded.damaged) ctx.log?.(words('account.indexDamaged', { member }));
      const file = loaded.damaged ? empty() : loaded.file;
      fn(file);
      write(member, file);
    });
  // An index edit by a caller already holding the index lock.
  const editHeld = (member: Member, fn: (file: IndexFile) => void): void => { const file = read(member); fn(file); write(member, file); };
  const identityOf = async (agentId: string): Promise<string | undefined> => {
    const { file } = await ctx.request('agents.files.get', { agentId, name: IDENTITY }) as { file: { missing?: boolean; content?: string } };
    return file.missing ? undefined : file.content;
  };
  const restoreIdentity = async (memberAgent: string, before: string | undefined): Promise<void> => {
    if (before !== undefined && await identityOf(memberAgent) !== before)
      await ctx.request('agents.files.set', { agentId: memberAgent, name: IDENTITY, content: before });
  };
  const readModel = async (agentId: string): Promise<unknown> => {
    const got = await ctx.request('config.get') as { config?: { agents?: { entries?: Record<string, { model?: unknown }> } } };
    return got.config?.agents?.entries?.[agentId]?.model;
  };
  // A merge patch cannot delete a key: with no prior primary, `agents.update { model: null }` clears the pin so the
  // engine default applies. A write that lands between the read and the patch moves the hash: try once more.
  const restoreModel = async (memberAgent: string, model: unknown): Promise<void> => {
    const clear = async (): Promise<void> => {
      await ctx.request('agents.update', { agentId: memberAgent, model: null });
    };
    const patch = async (): Promise<void> => {
      const { hash } = await ctx.request('config.get') as { hash: string };
      await ctx.request('config.patch', { raw: JSON.stringify({ agents: { entries: { [memberAgent]: { model } } } }), baseHash: hash });
    };
    try {
      if (model === undefined || model === null) { await clear().catch(() => clear()); return; }
      await patch().catch(() => patch());
    } catch (error) {
      // A damaged prior must not leave the removed provider's pin: fall back to clearing.
      if (model !== undefined && model !== null) {
        try { await clear().catch(() => clear()); }
        catch (clearError) {
          ctx.log?.(`addAccount: ${memberAgent} model pin is not cleared: ${clearError instanceof Error ? clearError.message : String(clearError)}`);
        }
      }
      ctx.log?.(`addAccount: ${memberAgent} model is not restored: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Removing (5.15): a member-agent account goes through `models.authLogout` with its sealed profileIds, restores or
  // clears the member primary from `priorModel`, then drops its entry. An account agent goes through `clear`, an
  // empty `list`, `agents.delete` with `deleteFiles: false`, removal of its state dir, then the entry is dropped.
  // Refused `busy` while a run holds the agent; the member agent stays ready (only the named provider is logged out
  // or cleared).
  const providerProfileIds = async (agentId: string, provider: string): Promise<string[]> => {
    const listed = await ctx.request('byokit.accounts', { action: 'list', agentId }) as { ok?: boolean; profiles?: { profileId?: string; provider?: string }[] };
    if (listed.ok !== true || !Array.isArray(listed.profiles)) throw new Error('removeAccount: the sign-ins could not be read');
    return listed.profiles.filter((p) => p.provider === provider && typeof p.profileId === 'string' && p.profileId).map((p) => p.profileId!);
  };
  async function remove(member: Member, id: AccountId): Promise<void> {
    check(member);
    const { agentId: memberAgent } = await ctx.ensure(member);
    const entry = read(member).accounts[id];
    if (entry?.agent === keyAgentId(member))
      throw new Error(`removeAccount: ${id} is a key lane; use removeKey`);
    if (!entry || (entry.agent !== memberAgent && !(ACCOUNT_AGENT.test(entry.agent) && entry.agent.startsWith(`${member}--`))))
      throw new Error(`unknown account: ${id}`);
    const agent = entry.agent;
    const provider = id.split('.')[0]!;
    if (ctx.locks.live(agent) || signing.has(`${member}\n${id}`)) throw new Error('removeAccount: busy');
    if (agent === memberAgent) {
      await ctx.locks.exclusive([agent, indexLock(member)], async () => {
        const profileIds = await providerProfileIds(agent, provider);
        if (profileIds.length) await ctx.request('models.authLogout', { provider, agentId: agent, profileIds });
        if ((await providerProfileIds(agent, provider)).length) throw new Error('removeAccount: the account is still signing in');
        const file = read(member);
        const prior = file.accounts[id]?.priorModel;
        // Restore the pre-sign-in primary (or clear the pin) before dropping the entry; failure must not block removal.
        await restoreModel(memberAgent, typeof prior === 'string' && prior ? prior : undefined);
        dropEntry(file, id);
        markDropped(file, provider);
        write(member, file);
        // The live store changed: re-seal at once so the sealed copy stops holding the removed profile.
        await ctx.reseal?.();
      });
      return;
    }
    await ctx.locks.exclusive([agent, indexLock(member)], async () => {
      // Native logout goes through the binding: this row's folder only, before the entry that names it is dropped.
      if (entry.native) await ctx.native?.remove(entry.native.cliAccountId);
      const roster = await agentRoster();
      if (roster.has(agent)) {
        await ctx.request('byokit.accounts', { action: 'clear', agentId: agent });
        const listed = await ctx.request('byokit.accounts', { action: 'list', agentId: agent }) as { ok?: boolean; profiles?: unknown[] };
        if (listed.ok !== true || !Array.isArray(listed.profiles)) throw new Error('removeAccount: the sign-ins could not be read');
        if (listed.profiles.length) throw new Error('removeAccount: the account is still signing in');
        await ctx.request('agents.delete', { agentId: agent, deleteFiles: false });
        // The roster hot-reload applies a beat after the delete answer: wait until the agent is gone, so a
        // roster read right after the removal no longer sees it.
        await untilUnlisted(ctx.request, agent);
      }
      rmSync(agentDir(agent), { recursive: true, force: true });
      // Already holding the index lock: write directly instead of `edit`, which would wait on itself.
      const file = read(member);
      dropEntry(file, id);
      markGone(file, agent);
      write(member, file);
      // The live store changed: re-seal at once so the sealed copy stops holding the removed profile.
      await ctx.reseal?.();
    });
  }
  const onGateway = (agent: string): Promise<boolean> => untilListed(ctx.request, agent)
    .then(() => true, () => (ctx.request('agents.list') as Promise<{ agents: { id: string }[] }>)
      .then((r) => r.agents.some((a) => a.id === agent)));
  // A new agent whose sign-in did not finish goes with its entry (5.15); the shared workspace stays. The entry is
  // dropped only once the agent's directory is gone, so a later removal can finish what this one could not.
  const discard = (member: Member, id: AccountId, agent: string, created: boolean): Promise<void> => (async () => {
    if (created) {
      await ctx.request('byokit.accounts', { action: 'clear', agentId: agent });
      await ctx.request('agents.delete', { agentId: agent, deleteFiles: false });
      // The roster hot-reload applies a beat after the delete answer: `done` resolves only once the agent is
      // gone, so a roster read right after a cancelled sign-in no longer sees it.
      await untilUnlisted(ctx.request, agent);
    }
    rmSync(agentDir(agent), { recursive: true, force: true });
    const native = read(member).accounts[id]?.native;
    if (native) await ctx.native?.remove(native.cliAccountId);
    await edit(member, (file) => { delete file.accounts[id]; });
  })().catch((error: unknown) => ctx.log?.(`addAccount: ${agent} is not removed yet: ${error instanceof Error ? error.message : String(error)}`));

  // Member-agent adds of one provider take turns from the sign-in's start to its settle, so a cleanup clears only the
  // profile its own add activated, and the next add's read sees what the earlier one left.
  const holdAdd = (member: Member, provider: string): Promise<() => void> => new Promise((held) => {
    void ctx.locks.exclusive([`add:${member}:${provider}`], () => new Promise<void>((release) => held(release)));
  });

  // In-place adds of one member and provider run one at a time: a second one answers busy at once, never sharing a callback.
  const placing = new Set<string>();

  async function add(member: Member, o: AddOptions, on: (v: SignInView) => void): Promise<AccountSignIn> {
    check(member);
    if (o && typeof o === 'object' && o.credentialPolicy !== undefined && o.credentialPolicy !== 'in-place')
      throw new Error(`addAccount: unknown credentialPolicy ${String(o.credentialPolicy)}`);
    if (o && typeof o === 'object' && 'key' in o) throw new Error('addAccount: keys are host-only');
    if (!NEW_MEMBER_ID.test(member)) throw new Error(words('account.legacyMember'));
    const choice = o?.authChoice === 'openai-codex' ? 'openai' : o?.authChoice;
    const route = routes().find((r) => r.choice === choice && r.billing === 'subscription');
    if (!route) throw new Error(`addAccount: ${String(o?.authChoice)} is not a subscription sign-in`);
    const name = o.name === undefined ? undefined : named(o.name, 'addAccount');
    const provider = route.provider;
    // Native Claude Code is bound to a managed CLI row (K1); it is never sealed as an engine profile, so only in place.
    const nativeRoute = route.choice === 'anthropic-cli';
    if (nativeRoute && (o.credentialPolicy !== 'in-place' || !ctx.native)) throw new Error('addAccount: anthropic-cli needs credentialPolicy in-place and a native login');
    const { agentId: memberAgent, workspace } = await ctx.ensure(member);
    if (o.again !== undefined && (!read(member).accounts[o.again] || o.again.split('.')[0] !== provider))
      throw new Error(`unknown account: ${o.again}`);
    const inPlace = o.credentialPolicy === 'in-place';
    // Re-auth under the policy signs in on the account's own agent and store; nothing is created or moved.
    const reauth = inPlace && o.again !== undefined ? read(member).accounts[o.again] : undefined;
    if (reauth && reauth.agent === keyAgentId(member))
      throw new Error(`addAccount: ${o.again} cannot sign in again in place`);
    const placeKey = `${member}\n${provider}`;
    if (inPlace) {
      if (placing.has(placeKey)) {
        const busy: SignInView = { state: 'failed', via: o.via ?? 'browser', why: 'busy' };
        const same = o.again ?? provider;
        return { id: same, paste: () => {}, cancel: () => {}, done: Promise.resolve({ view: busy, id: same }).then((r) => { on(r.view); return r; }) };
      }
      placing.add(placeKey);
    }
    let releaseAdd = (): void => { if (inPlace) placing.delete(placeKey); };
    try {
      // The member agent is the target only while it holds no local profile of the provider (5.15).
      const holdsProvider = async (): Promise<boolean> => {
        const own = await ctx.request('byokit.accounts', { action: 'list', agentId: memberAgent }) as { ok?: boolean; profiles?: LiveProfile[] };
        if (!own.ok || !Array.isArray(own.profiles)) throw new Error('addAccount: the member\'s sign-ins could not be read');
        return own.profiles.some((p) => p.provider === provider);
      };
      let fresh = inPlace ? !reauth : o.again !== undefined || await holdsProvider();
      // Only the member-agent path clears a profile it did not create, so only it takes the provider's add lock, held to
      // settle. The read repeats under the lock: the add that held it may have sealed its sign-in on the member agent.
      if (!fresh && !inPlace) {
        releaseAdd = await holdAdd(member, provider);
        fresh = await holdsProvider();
        if (fresh) releaseAdd();
      }
      // The member agent's primary before this sign-in or any merge on it: restored when its profile moves away or
      // the member-agent account is removed. Durable on the member entry as `priorModel` (empty when none).
      const memberModel = await readModel(memberAgent);
      const binding: NativeBinding | undefined = nativeRoute && !reauth
        ? { kind: 'native-cli', cliAccountId: await ctx.native!.allocate(), cli: 'claude' } : undefined;
      const entryOf = (file: IndexFile, agent: string, prior?: string): IndexEntry => ({ agent, route: route.choice, addedAt: Date.now(),
        ...(binding ? { native: binding } : {}),
        name: name ?? `${route.label} ${Object.values(file.accounts).filter((e) => e.route === route.choice).length + 1}`,
        ...(prior !== undefined ? { priorModel: prior } : {}) });
      let id: AccountId = provider;
      let agent = memberAgent;
      let added = false;
      if (reauth) { id = o.again!; agent = reauth.agent; }
      else if (!fresh) {
        const prior = priorOf(memberModel);
        await edit(member, (file) => {
          if (!file.accounts[id]) { file.accounts[id] = entryOf(file, agent, prior); added = true; }
          // Keep the first pre-sign-in primary across a later re-sign-in of the same member row.
          else if (file.accounts[id]!.priorModel === undefined) file.accounts[id]!.priorModel = prior;
          clearDropped(file, provider);
        });
      } else {
        // `<member>--<hex6>`, drawn again while that agent exists; its entry is written before the agent.
        const roster = new Set((await ctx.request('agents.list') as { agents: { id: string }[] }).agents.map((a) => a.id));
        await edit(member, (file) => {
          const taken = new Set([...roster, ...Object.values(file.accounts).map((e) => e.agent)]);
          do { const hex = randomBytes(3).toString('hex'); id = `${provider}.${hex}`; agent = `${member}--${hex}`; }
          while (taken.has(agent) || file.accounts[id]);
          file.accounts[id] = entryOf(file, agent);
        });
        added = true;
        let created = false;
        // The pin rewrites the shared workspace's IDENTITY.md Name line on create, so the create window is one lock per member.
        await ctx.locks.exclusive([`${member}#identity`], async () => {
          let before: string | undefined;
          try {
            before = await identityOf(memberAgent);
            const made = await ctx.request('agents.create', { name: agent, workspace }) as { agentId?: string };
            created = true;
            if (made.agentId !== agent) throw new Error(`addAccount: agents.create answered ${String(made.agentId)}, not ${agent}`);
            await untilListed(ctx.request, agent);
            await restoreIdentity(memberAgent, before);
          } catch (error) {
            await restoreIdentity(memberAgent, before)
              .catch((restoreError: unknown) => ctx.log?.(`addAccount: IDENTITY.md is not restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`));
            const exists = created || await onGateway(agent).catch((listError: unknown) => {
              ctx.log?.(`addAccount: ${agent} is not removed yet: ${listError instanceof Error ? listError.message : String(listError)}`);
              return undefined;
            });
            if (exists !== undefined) await discard(member, id, agent, exists);
            throw error;
          }
        });
      }

      const key = `${member}\n${id}`;
      signing.set(key, (signing.get(key) ?? 0) + 1);
      const handle = ctx.signIn(agent, { authChoice: route.choice, ...(o.via ? { via: o.via } : {}) },
        (v) => { if (v.state === 'waiting') on(v); }, fresh,
        (binding ?? reauth?.native) && { cliAccountId: (binding ?? reauth!.native!).cliAccountId, reauth: !binding });
      // Moves the profile `who` names from `from` into `to`, under both agents' locks; refused, nothing changes.
      const profilesOf = (agent: string): Promise<LiveProfile[] | undefined> => (ctx.request('byokit.accounts', { action: 'list', agentId: agent }) as Promise<{ ok?: boolean; profiles?: LiveProfile[] }>)
        .then((r) => (r.ok === true && Array.isArray(r.profiles) ? r.profiles : undefined), () => undefined);
      const profileIdOf = (profiles: LiveProfile[] | undefined, who: string): string | undefined =>
        profiles?.find((p) => p.provider === provider && p.who === who)?.profileId;
      const moveTo = (from: string, to: string, who: string): Promise<boolean> => ctx.locks.exclusive([memberAgent, from, to], async () => {
        const sent = profileIdOf(await profilesOf(from), who);
        const answer = await (ctx.request('byokit.accounts', { action: 'adopt', from, to, provider, who }) as Promise<{ ok?: boolean }>)
          .catch(async (error: unknown) => {
            ctx.log?.(`addAccount: adopt has no answer: ${error instanceof Error ? error.message : String(error)}`);
            // A lost reply can follow a committed move: the destination holding the sign-in's own profile means it moved.
            const landed = sent !== undefined && profileIdOf(await profilesOf(to), who) === sent;
            return { ok: landed };
          });
        if (!answer.ok) return false;
        if (from === memberAgent) await restoreModel(memberAgent, memberModel);
        return true;
      }).catch(() => false);
      // `adopt` moves the sign-in into X's agent and clears it from the target; refused, the sign-in stays a new
      // account and keeps its `who`.
      const adopt = (who: string, to: string): Promise<boolean> => moveTo(agent, to, who).then(async (ok) => {
        if (ok) return true;
        await edit(member, (file) => { const own = file.accounts[id]; if (own) own.who = who; });
        return false;
      }).catch(() => false);
      const removeEntry = (): Promise<void> => agent !== memberAgent ? discard(member, id, agent, true)
        : edit(member, (file) => { delete file.accounts[id]; })
          .catch((error: unknown) => ctx.log?.(`addAccount: ${id} entry is kept: ${error instanceof Error ? error.message : String(error)}`));
      const drop = (): Promise<void> => agent !== memberAgent || added ? removeEntry() : Promise.resolve();
      // A live account holding the same `who` merges into the earliest one before the sign-in does. When the earliest is
      // the sign-in's own row, the duplicate is discarded so the sign-in's credential survives; otherwise its profile is
      // moved into the earliest one, then an account agent is removed and the member agent's entry dropped. A refused
      // move keeps that duplicate, logged.
      const collapse = async (dup: [AccountId, IndexEntry], keep: [AccountId, IndexEntry], who: string): Promise<void> => {
        if (keep[0] === id) {
          if (dup[1].agent !== memberAgent) { await discard(member, dup[0], dup[1].agent, true); return; }
          ctx.log?.(`addAccount: ${dup[0]} is kept: the member agent's profile is not cleared alone`);
          return;
        }
        if (!await moveTo(dup[1].agent, keep[1].agent, who)) { ctx.log?.(`addAccount: ${dup[0]} is kept: its sign-in is not moved`); return; }
        if (dup[1].agent !== memberAgent) { await discard(member, dup[0], dup[1].agent, true); return; }
        await edit(member, (file) => { delete file.accounts[dup[0]]; })
          .catch((error: unknown) => ctx.log?.(`addAccount: ${dup[0]} entry is kept: ${error instanceof Error ? error.message : String(error)}`));
      };
      // A row holds the identity only while its agent holds it: the member's row while the member holds that `who`, an
      // account while its agent is on the roster (a removal that stopped partway leaves an entry whose agent is gone).
      const liveEntry = (roster: Set<string>, memberHolds: boolean, e: IndexEntry): boolean => e.agent === memberAgent ? memberHolds
        : ACCOUNT_AGENT.test(e.agent) && e.agent.startsWith(`${member}--`) && roster.has(e.agent);
      // Sealed before the person sees done: the agent keeps only this sign-in. Done only when sealed; anything else leaves
      // nothing behind. Identity is its `who`, compared only
      // within this member and provider: the live accounts holding it (the target's own included; several only from
      // before O14) merge into the earliest `addedAt`, whatever `again` names; no `who` never merges. The email never decides.
      // credentialPolicy 'in-place': the sign-in wrote only its own store. A duplicate principal discards that new store
      // alone and answers the existing id; a re-sign-in whose principal is not the recorded one marks the account
      // unavailable. No credential is moved or copied, no member is rebound, and the earlier account is never rewritten.
      const settleInPlace = async (view: SignInView): Promise<{ view: SignInView; id: AccountId }> => {
        if (view.state !== 'done') { if (!reauth) await drop(); return { view, id }; }
        // The drive saw the bound row's own CLI read ready: nothing to seal, no engine profile or principal to compare yet.
        if (binding ?? reauth?.native) return { view, id };
        const failed = (error: string): { view: SignInView; id: AccountId } => ({ view: { state: 'failed', via: view.via, why: 'failed', error }, id });
        const verdict = await ctx.locks.exclusive([agent, indexLock(member)], async (): Promise<{ who?: string } | { existing: AccountId } | { mismatch: true } | string> => {
          const now = await (ctx.request('byokit.accounts', { action: 'ready', agentId: agent, provider }) as Promise<{ ok?: boolean; who?: string }>);
          if (!now.ok) return 'Sign-in could not be saved. Try again.';
          if (reauth) {
            if (reauth.who !== undefined && now.who !== reauth.who) {
              editHeld(member, (file) => { const own = file.accounts[id]; if (own) own.unavailable = 'identity_mismatch'; });
              return { mismatch: true };
            }
            const sealed = await ctx.request('byokit.accounts', { action: 'seal', agentId: agent, provider }) as { ok?: boolean };
            if (!sealed.ok) return 'Sign-in could not be saved. Try again.';
            editHeld(member, (file) => { const own = file.accounts[id]; if (own) { delete own.unavailable; if (now.who) own.who = now.who; } });
            return {};
          }
          const roster = await (ctx.request('agents.list') as Promise<{ agents: { id: string }[] }>).then((r) => new Set(r.agents.map((a) => a.id)), () => undefined);
          const held = await profilesOf(memberAgent);
          if (now.who && !(roster && held)) return 'Existing sign-ins could not be read. Try again.';
          const memberHolds = (held ?? []).some((p) => p.provider === provider && p.who === now.who);
          const file = read(member);
          if (roster && held && (await build(member, memberAgent, file, roster, held)).dirty) write(member, file);
          const twin = now.who && roster ? Object.entries(file.accounts)
            .filter(([other, e]) => other !== id && other.split('.')[0] === provider && e.who === now.who && liveEntry(roster, memberHolds, e))
            .sort(([, a], [, b]) => a.addedAt - b.addedAt)[0] : undefined;
          if (twin) return { existing: twin[0] };
          const sealed = await ctx.request('byokit.accounts', { action: 'seal', agentId: agent, provider }) as { ok?: boolean };
          if (!sealed.ok) return 'Sign-in could not be saved. Try again.';
          editHeld(member, (f) => { const own = f.accounts[id]; if (own) { if (now.who) own.who = now.who; else delete own.who; } });
          return now.who ? { who: now.who } : {};
        }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200));
        if (typeof verdict === 'string') { if (!reauth) await drop(); return failed(verdict); }
        if ('mismatch' in verdict) return { view: { state: 'failed', via: view.via, why: 'identity_mismatch', existing: id,
          error: words('account.identityMismatch') }, id };
        if ('existing' in verdict) {
          await drop();
          return { view: { state: 'failed', via: view.via, why: 'duplicate', existing: verdict.existing }, id };
        }
        return { view, id };
      };
      const settle = async (view: SignInView): Promise<{ view: SignInView; id: AccountId }> => {
        if (inPlace) return settleInPlace(view);
        if (view.state === 'done') {
          const sealed = await ctx.locks.exclusive([memberAgent, agent, indexLock(member)], async (): Promise<{ who?: string; keep?: [AccountId, IndexEntry]; dups: [AccountId, IndexEntry][] } | string> => {
            const answer = await ctx.request('byokit.accounts', { action: 'seal', agentId: agent, provider,
              ...(route.keyEntry ? { planKey: true } : {}) }) as { ok?: boolean; who?: string };
            if (!answer.ok) return 'Sign-in could not be saved. Try again.';
            const roster = await (ctx.request('agents.list') as Promise<{ agents: { id: string }[] }>)
              .then((r) => new Set(r.agents.map((a) => a.id)), () => undefined);
            const held = await (ctx.request('byokit.accounts', { action: 'list', agentId: memberAgent }) as Promise<{ ok?: boolean; profiles?: LiveProfile[] }>)
              .catch(() => undefined);
            const mergeable = roster !== undefined && held?.ok === true && Array.isArray(held.profiles);
            if (!mergeable) ctx.log?.(`addAccount: the roster or ${memberAgent} profiles are unreadable; the sign-in is kept as its own row`);
            const memberHolds = (held?.profiles ?? []).some((p) => p.provider === provider && p.who === answer.who);
            const file = read(member);
            if (roster && mergeable && (await build(member, memberAgent, file, roster, held?.profiles ?? [])).dirty) write(member, file);
            const own = file.accounts[id];
            const sharing = answer.who && roster && mergeable ? Object.entries(file.accounts)
              .filter(([other, e]) => other.split('.')[0] === provider && e.who === answer.who && liveEntry(roster, memberHolds, e))
              .sort(([, a], [, b]) => a.addedAt - b.addedAt) : [];
            const keep = sharing[0];
            const dups = sharing.slice(1).filter(([other]) => other !== id);
            if (!(keep && keep[0] !== id) && own) { if (answer.who) own.who = answer.who; else delete own.who; write(member, file); }
            return { ...(answer.who ? { who: answer.who } : {}), ...(keep ? { keep } : {}), dups };
          }).catch((error: unknown) => route.keyEntry ? 'Sign-in could not be saved. Try again.'
            : (error instanceof Error ? error.message : String(error)).slice(0, 200));
          if (typeof sealed === 'string') {
            let error = sealed;
            // A seal failure on the member agent (the non-fresh path) leaves its new credential with no index entry,
            // so listing hides it but runs could use it. Clear only this provider: the bare clear wipes every profile.
            if (agent === memberAgent) {
              const cleared = await ctx.request('byokit.accounts', { action: 'clear', agentId: memberAgent, provider })
                .then((answer) => (answer as { ok?: boolean } | undefined)?.ok === true, () => false);
              if (!cleared) {
                ctx.log?.(`addAccount: ${memberAgent} ${provider} is not cleared`);
                error = `${sealed} Its credential is still on the member agent: remove this account.`;
              }
            }
            await drop();
            return { view: { state: 'failed', via: view.via, why: 'failed', error }, id };
          }
          for (const dup of sealed.dups) await collapse(dup, sealed.keep!, sealed.who!);
          const into = sealed.keep?.[0] !== id ? sealed.keep : undefined;
          if (!into || !await adopt(sealed.who!, into[1].agent)) return { view, id };
          await removeEntry();
          return { view, id: into[0] };
        }
        // A member agent held no profile of this provider before a non-fresh add, so clearing the provider removes only this one.
        if (agent === memberAgent) await ctx.request('byokit.accounts', { action: 'clear', agentId: memberAgent, provider })
          .catch((error: unknown) => ctx.log?.(`addAccount: ${provider} is not cleared yet: ${error instanceof Error ? error.message : String(error)}`));
        await drop();
        return { view, id };
      };
      const done = handle.done.then(settle).finally(() => {
        releaseAdd();
        const left = signing.get(key)! - 1;
        if (left) signing.set(key, left);
        else signing.delete(key);
      }).then((result) => {
        on(result.view);
        return result;
      });
      return { id, paste: handle.paste, cancel: handle.cancel, done };
    } catch (error) {
      releaseAdd();
      throw error;
    }
  }

  // Safe routing metadata: the row and the engine agent holding its sign-in, only for an account this member lists.
  const context = async (member: Member, id: AccountId): Promise<AccountContext> => {
    check(member);
    const { row, entry } = await entryOf(member, id);
    return { account: row, agentId: entry.agent };
  };

  return { list, status, add, context, rename, defaults, setDefaults, models, room, bind, keyRefusal, key, unkey, backfill, pick, rest, move, remove };
}
