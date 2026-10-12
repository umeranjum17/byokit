// The per-member account index (5.15, O14 step S5): `<root>/accounts/<member>.json` (0600, whole-file temp
// plus rename) is the only kit state: `{ v: 1, accounts: { [id]: { agent, name, route, addedAt, until?, model?,
// who? } }, defaults }`. No credential, token, email or engine line. Listing, rename, defaults and adding (O14
// step S6) live here; remove, models, room, pick and move arrive in later steps.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createLocks } from './locks.ts';
import { KEY_PREFIX, MEMBER_ID, NEW_MEMBER_ID, untilListed } from './members.ts';
import { routes, routeFor } from './routes.ts';
import { words } from './words.ts';
import type { Account, AccountId, Defaults, GatewayTransport, Member, SignInOptions, SignInState, SignInView } from './types.ts';

type IndexEntry = { agent: string; name: string; route: string; addedAt: number; until?: number; model?: string; who?: string };
type IndexFile = { v: 1; accounts: Record<string, IndexEntry>; defaults: Defaults };

type LiveProfile = { provider?: string; profileId?: string; type?: string; status?: string; who?: string };
const ACCOUNT_AGENT = /^[a-z][a-z0-9-]{0,31}--[0-9a-f]{6}$/;
const usable = (status: string | undefined): boolean => status === 'ok' || status === 'expiring' || status === 'static';
const IDENTITY = 'IDENTITY.md';

type AddOptions = { authChoice: string; via?: 'browser' | 'code'; name?: string; again?: AccountId };
type AccountSignIn = { id: AccountId; paste(text: string): void; cancel(): void; done: Promise<{ view: SignInView; id: AccountId }> };
type StartSignIn = (agentId: string, o: SignInOptions, on: (v: SignInView) => void, fresh: boolean) =>
  { paste(text: string): void; cancel(): void; done: Promise<SignInView> };

const named = (name: unknown, op: string): string => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 100 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`${op}: name is empty`);
  return trimmed;
};
const empty = (): IndexFile => ({ v: 1, accounts: {}, defaults: {} });
const validEntry = (v: unknown): v is IndexEntry => !!v && typeof v === 'object'
  && typeof (v as IndexEntry).agent === 'string' && typeof (v as IndexEntry).name === 'string'
  && typeof (v as IndexEntry).route === 'string' && Number.isFinite((v as IndexEntry).addedAt)
  && ((v as IndexEntry).until === undefined || Number.isFinite((v as IndexEntry).until))
  && ((v as IndexEntry).model === undefined || typeof (v as IndexEntry).model === 'string')
  && ((v as IndexEntry).who === undefined || typeof (v as IndexEntry).who === 'string');

export function createAccounts(ctx: {
  request: GatewayTransport['request'];
  root: string;
  ensure(member: Member): Promise<{ agentId: string; workspace: string }>;
  locks: ReturnType<typeof createLocks>;
  signIn: StartSignIn;
  log?: (line: string) => void;
}): {
  list(member: Member): Promise<Account[]>;
  add(member: Member, o: AddOptions, on: (v: SignInView) => void): Promise<AccountSignIn>;
  rename(member: Member, id: AccountId, name: string): Promise<Account>;
  defaults(member: Member): Promise<Defaults>;
  setDefaults(member: Member, d: Defaults): Promise<void>;
} {
  const path = (member: Member): string => join(ctx.root, 'accounts', `${member}.json`);
  // Accounts whose sign-in is running, as `<member>\n<id>`, counted per add: listed `signing` until the last one ends.
  const signing = new Map<string, number>();
  const check = (member: Member): void => {
    if (!MEMBER_ID.test(member) || member.startsWith(KEY_PREFIX)) throw new Error(`invalid member id: ${member}`);
  };
  const read = (member: Member): IndexFile => {
    let text: string;
    try { text = readFileSync(path(member), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error; }
    const file = JSON.parse(text) as Partial<IndexFile>;
    if (!file || typeof file !== 'object' || file.v !== 1) return empty();
    const accounts: Record<string, IndexEntry> = {};
    for (const [id, entry] of Object.entries(file.accounts ?? {})) if (validEntry(entry)) accounts[id] = entry;
    const raw = file.defaults && typeof file.defaults === 'object' ? file.defaults as Defaults : {};
    const defaults: Defaults = {};
    if (typeof raw.account === 'string') defaults.account = raw.account;
    if (typeof raw.model === 'string') defaults.model = raw.model;
    if (typeof raw.auto === 'boolean') defaults.auto = raw.auto;
    return { v: 1, accounts, defaults };
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
  const rosterOf = (): Promise<Set<string>> =>
    (ctx.request('agents.list') as Promise<{ agents: { id: string }[] }>)
      .then((r) => new Set(r.agents.map((a) => a.id)), () => new Set<string>());
  const profilesOf = (agentId: string): Promise<LiveProfile[]> =>
    (ctx.request('byokit.accounts', { action: 'list', agentId }) as Promise<{ profiles?: LiveProfile[] }>)
      .then((r) => Array.isArray(r.profiles) ? r.profiles : [], () => []);
  const stateOf = (route: string, status: string | undefined, until: number | undefined): SignInState => {
    if (!routes().some((r) => r.choice === route)) return 'not_included';
    if (until !== undefined && until > Date.now()) return 'resting';
    if (!status) return 'signed_out';
    return usable(status) ? 'ready' : status === 'expired' ? 'needs_again' : 'signed_out';
  };
  // Lock-free row builder over one snapshot: mutates `file` (synthesized entries, `who` backfill, dropped
  // dangling default) and reports whether it did. Callers own the locking.
  const build = async (member: Member, agentId: string, file: IndexFile, roster: Set<string>,
    memberProfiles: LiveProfile[]): Promise<{ rows: Account[]; dirty: boolean }> => {
    let dirty = false;
    const byProvider = new Map<string, LiveProfile[]>();
    for (const p of memberProfiles) {
      if (typeof p.provider !== 'string' || !p.provider) continue;
      byProvider.set(p.provider, [...(byProvider.get(p.provider) ?? []), p]);
    }
    const memberRows: Account[] = [];
    const seen = new Set<string>();
    for (const [provider, profiles] of [...byProvider.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
      let entry = file.accounts[provider];
      if (!entry || entry.agent !== agentId) {
        const route = entry?.agent === agentId && typeof entry.route === 'string' ? entry.route : synthesizedRoute(provider);
        const same = Object.values(file.accounts).filter((e) => e.agent === agentId).length;
        entry = { agent: agentId, name: `${metaOf(route).label} ${same + 1}`, route, addedAt: 0 };
        file.accounts[provider] = entry;
        dirty = true;
      }
      if (!entry.who && typeof profiles[0]?.who === 'string') { entry.who = profiles[0].who; dirty = true; }
      const meta = metaOf(entry.route);
      memberRows.push({ id: provider, provider, route: entry.route, name: entry.name, label: meta.label,
        billing: meta.billing, state: stateOf(entry.route, profiles[0]?.status, entry.until),
        ...(entry.until !== undefined ? { until: entry.until } : {}), addedAt: entry.addedAt });
      seen.add(provider);
    }
    for (const [id, entry] of Object.entries(file.accounts)) {
      if (entry.agent !== agentId || id.includes('.') || seen.has(id)) continue;
      const stale = metaOf(entry.route);
      memberRows.push({ id, provider: id, route: entry.route, name: entry.name, label: stale.label,
        billing: stale.billing, state: stateOf(entry.route, undefined, entry.until),
        ...(entry.until !== undefined ? { until: entry.until } : {}), addedAt: entry.addedAt });
    }
    // Account agents: only what the index names, with exactly `<member>--<hex6>` shape. An unindexed
    // agent of that shape is never listed, and an entry whose agent is gone is not listed either.
    const agentRows: Account[] = [];
    for (const [id, entry] of Object.entries(file.accounts)) {
      if (entry.agent === agentId || !ACCOUNT_AGENT.test(entry.agent) || !entry.agent.startsWith(`${member}--`)) continue;
      if (!roster.has(entry.agent)) continue;
      const provider = id.split('.')[0]!;
      const meta = metaOf(entry.route);
      const profiles = await profilesOf(entry.agent);
      agentRows.push({ id, provider, route: entry.route, name: entry.name, label: meta.label,
        billing: meta.billing, state: stateOf(entry.route, profiles[0]?.status, entry.until),
        ...(entry.until !== undefined ? { until: entry.until } : {}), addedAt: entry.addedAt });
    }
    memberRows.sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1));
    agentRows.sort((a, b) => a.addedAt - b.addedAt);
    const rows = [...memberRows, ...agentRows];
    for (const row of rows) if (signing.has(`${member}\n${row.id}`)) row.state = 'signing';
    if (file.defaults.account !== undefined && !rows.some((r) => r.id === file.defaults.account)) {
      delete file.defaults.account;
      dirty = true;
    }
    return { rows, dirty };
  };
  const gather = (agentId: string): Promise<[Set<string>, LiveProfile[]]> =>
    Promise.all([rosterOf(), profilesOf(agentId)]);
  const buildRows = async (member: Member, agentId: string) => {
    const file = read(member);
    const [roster, profiles] = await gather(agentId);
    return { ...(await build(member, agentId, file, roster, profiles)), file };
  };

  async function list(member: Member): Promise<Account[]> {
    check(member);
    const { agentId } = await ctx.ensure(member);
    const first = await ctx.locks.shared(agentId, () => buildRows(member, agentId));
    if (!first.dirty) return first.rows;
    // A write is needed (synthesized entry, `who` backfill or dropped default): redo it under the
    // exclusive lock so two first-lists cannot interleave their read-modify-write.
    return ctx.locks.exclusive([agentId], async () => {
      const { rows, dirty, file } = await buildRows(member, agentId);
      if (dirty) write(member, file);
      return rows;
    });
  }

  async function rename(member: Member, id: AccountId, name: string): Promise<Account> {
    check(member);
    const trimmed = named(name, 'renameAccount');
    const { agentId } = await ctx.ensure(member);
    if (!(await list(member)).some((r) => r.id === id)) throw new Error(`unknown account: ${id}`);
    await ctx.locks.exclusive([agentId], async () => {
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
    const { agentId } = await ctx.ensure(member);
    return ctx.locks.exclusive([agentId], async () => {
      const file = read(member);
      const next: Defaults = {};
      if (d.account !== undefined) next.account = d.account;
      if (d.model !== undefined) next.model = d.model;
      if (d.auto !== undefined) next.auto = d.auto;
      write(member, { ...file, defaults: next });
    });
  }

  // Index edits take the member agent's exclusive lock, as listing's own write does.
  const edit = (member: Member, agentId: string, fn: (file: IndexFile) => void): Promise<void> =>
    ctx.locks.exclusive([agentId], async () => { const file = read(member); fn(file); write(member, file); });
  const identityOf = async (agentId: string): Promise<string | undefined> => {
    const { file } = await ctx.request('agents.files.get', { agentId, name: IDENTITY }) as { file: { missing?: boolean; content?: string } };
    return file.missing ? undefined : file.content;
  };
  const restoreIdentity = async (memberAgent: string, before: string | undefined): Promise<void> => {
    if (before !== undefined && await identityOf(memberAgent) !== before)
      await ctx.request('agents.files.set', { agentId: memberAgent, name: IDENTITY, content: before });
  };
  const onGateway = (agent: string): Promise<boolean> => untilListed(ctx.request, agent)
    .then(() => true, () => (ctx.request('agents.list') as Promise<{ agents: { id: string }[] }>)
      .then((r) => r.agents.some((a) => a.id === agent)));
  // A new agent whose sign-in did not finish goes with its entry (5.15); the shared workspace stays. The entry is
  // dropped only once the agent's directory is gone, so a later removal can finish what this one could not.
  const discard = (member: Member, memberAgent: string, id: AccountId, agent: string, created: boolean): Promise<void> => (async () => {
    if (created) {
      await ctx.request('byokit.accounts', { action: 'clear', agentId: agent });
      await ctx.request('agents.delete', { agentId: agent, deleteFiles: false });
    }
    rmSync(join(ctx.root, 'state', 'agents', agent), { recursive: true, force: true });
    await edit(member, memberAgent, (file) => { delete file.accounts[id]; });
  })().catch((error: unknown) => ctx.log?.(`addAccount: ${agent} is not removed yet: ${error instanceof Error ? error.message : String(error)}`));

  async function add(member: Member, o: AddOptions, on: (v: SignInView) => void): Promise<AccountSignIn> {
    check(member);
    if (!NEW_MEMBER_ID.test(member)) throw new Error(words('account.legacyMember'));
    const route = routes().find((r) => r.choice === o?.authChoice && r.billing === 'subscription');
    if (!route) throw new Error(`addAccount: ${String(o?.authChoice)} is not a subscription sign-in`);
    const name = o.name === undefined ? undefined : named(o.name, 'addAccount');
    const provider = route.provider;
    const { agentId: memberAgent, workspace } = await ctx.ensure(member);
    if (o.again !== undefined && (!read(member).accounts[o.again] || o.again.split('.')[0] !== provider))
      throw new Error(`unknown account: ${o.again}`);
    // The member agent is the target only while it holds no local profile of the provider (5.15).
    const own = await ctx.request('byokit.accounts', { action: 'list', agentId: memberAgent }) as { ok?: boolean; profiles?: LiveProfile[] };
    if (!own.ok || !Array.isArray(own.profiles)) throw new Error('addAccount: the member\'s sign-ins could not be read');
    const fresh = o.again !== undefined || own.profiles.some((p) => p.provider === provider);
    const entryOf = (file: IndexFile, agent: string): IndexEntry => ({ agent, route: route.choice, addedAt: Date.now(),
      name: name ?? `${route.label} ${Object.values(file.accounts).filter((e) => e.route === route.choice).length + 1}` });
    let id: AccountId = provider;
    let agent = memberAgent;
    let added = false;
    if (!fresh) {
      await edit(member, memberAgent, (file) => { if (!file.accounts[id]) { file.accounts[id] = entryOf(file, agent); added = true; } });
    } else {
      // `<member>--<hex6>`, drawn again while that agent exists; its entry is written before the agent.
      const roster = new Set((await ctx.request('agents.list') as { agents: { id: string }[] }).agents.map((a) => a.id));
      await edit(member, memberAgent, (file) => {
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
          if (exists !== undefined) await discard(member, memberAgent, id, agent, exists);
          throw error;
        }
      });
    }

    const key = `${member}\n${id}`;
    signing.set(key, (signing.get(key) ?? 0) + 1);
    const handle = ctx.signIn(agent, { authChoice: route.choice, ...(o.via ? { via: o.via } : {}) },
      (v) => { if (v.state === 'waiting') on(v); }, fresh);
    // Sealed before the person sees done: the agent keeps only this sign-in, and its `who` goes to the index.
    const settle = async (view: SignInView): Promise<SignInView> => {
      if (view.state === 'done') {
        const sealed = await ctx.locks.exclusive([memberAgent, agent], async (): Promise<true | string> => {
          const answer = await ctx.request('byokit.accounts', { action: 'seal', agentId: agent, provider }) as { ok?: boolean; who?: string };
          if (!answer.ok) return 'Sign-in could not be saved. Try again.';
          const file = read(member);
          const entry = file.accounts[id];
          if (entry && answer.who) { entry.who = answer.who; write(member, file); }
          return true;
        }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200));
        if (sealed === true) return view;
        view = { state: 'failed', via: view.via, why: 'failed', error: sealed };
      }
      if (agent !== memberAgent) await discard(member, memberAgent, id, agent, true);
      else if (added) await edit(member, memberAgent, (file) => { delete file.accounts[id]; })
        .catch((error: unknown) => ctx.log?.(`addAccount: ${id} entry is kept: ${error instanceof Error ? error.message : String(error)}`));
      return view;
    };
    const done = handle.done.then(settle).finally(() => {
      const left = signing.get(key)! - 1;
      if (left) signing.set(key, left);
      else signing.delete(key);
    }).then((view) => {
      on(view);
      return { view, id };
    });
    return { id, paste: handle.paste, cancel: handle.cancel, done };
  }

  return { list, add, rename, defaults, setDefaults };
}
