// One agent's sign-in methods as headless view state, the way an Agent tab shows them: every way the agent can run,
// each with how it is paid for and whether an account is connected on it, one account in use at a time, the agent's
// default model and an `N of M enabled` count. The app says which ways each agent runs on (the routes it passes
// `@byokit/accounts` as `AgentCapabilities`) and keeps the choice with `setDefaults(member, defaults, agentKind)`.
// Only plans are offered and counted; a pay-per-use way is listed apart, labelled, and never chosen for the person.
// Framework-free.
import WORDS from './words.json' with { type: 'json' };
import { accountRows, type Account, type ModelInfo } from './accounts.ts';
import { connectView, type ConnectRoute, type ConnectRow } from './connect.ts';

/** One agent kind as the app runs it: its `agentKind` name, the name a person knows, and the ways it can run on. */
export type AgentSpec = { kind: string; name: string; ways: readonly ConnectRoute[] };
/** An agent kind's saved choice, restated from `@byokit/accounts` `defaults(member, agentKind)`. */
export type AgentDefaults = { account?: string; model?: string };

export type AgentWayState = 'in_use' | 'connected' | 'sign_in' | 'unavailable';
/** One account connected on a way: its address (else its plain title), whether it can run now, whether this agent
 *  uses it, and that in words (`In use`, `Signed in`, or why it cannot run). */
export type AgentAccount = { id: string; name: string; ready: boolean; inUse: boolean; detail: string };
export type AgentWay = {
  row: ConnectRow;
  /** What the way is called on the agent: the plan's name, or `OpenAI API key` for a pasted per-use key. */
  title: string;
  /** `in_use` holds the agent's account; `connected` has a ready account to switch to; `sign_in` has none yet;
   *  `unavailable` cannot be used here (`row.status` says why). */
  state: AgentWayState;
  accounts: AgentAccount[];
};
export type AgentModel = { id: string; name: string; available: boolean; selected: boolean };
export type AgentView = {
  kind: string; name: string;
  /** Plans with a ready account, of all the plans listed: `1 of 3 enabled`. Pay-per-use ways are not counted. */
  enabled: number; total: number; count: string;
  /** `one at a time`: the agent runs on one account; choosing another replaces it. */
  rule: string;
  /** Plans, offered: the ways counted above. */
  ways: AgentWay[];
  /** Pay-per-use and other ways this agent can run on, listed only: never offered, counted or chosen by default. */
  perUse: { title: string; note: string; ways: AgentWay[] };
  /** The account in use, when the saved one is connected and ready; a saved account that is not ready is never
   *  replaced by another one: `note` says so and the agent stays unset, as the kit's pick refuses it. */
  inUse?: string;
  note: string;
  /** The in-use account's own live models, the saved one selected; an unsaved or no longer listed model selects none. */
  model: { label: string; options: AgentModel[]; value?: string; words: string; disabled: boolean };
};

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''));

/** An account belongs to a way when it is that way's provider at that way's billing: a plan's account never lands on
 *  the same company's pay-per-use key. */
const on = (way: ConnectRow, a: Account) => a.provider === way.provider && a.billing === way.billing;

/**
 * The agent's ways, its count, the account in use and its default model. `accounts` is the app's `list()`; `models`
 * is the in-use account's `models()`, read live by the app (omit it until it is read).
 */
export function agentView(agent: AgentSpec, accounts: readonly Account[], defaults: AgentDefaults = {}, models?: readonly ModelInfo[], now = Date.now()): AgentView {
  const rows = connectView(agent.ways).groups.flatMap((g) => g.rows);
  const titles = new Map(accountRows(accounts, () => ({ left: 'unknown' }), now).map((r) => [r.id, r] as const));
  const nameOf = (a: Account) => a.email || titles.get(a.id)!.title;
  const saved = defaults.account ? accounts.find((a) => a.id === defaults.account) : undefined;
  const savedReady = !!saved && titles.get(saved.id)?.state === 'ready' && rows.some((r) => r.ready && on(r, saved));
  const inUse = savedReady ? saved!.id : undefined;
  const wayOf = (row: ConnectRow): AgentWay => {
    const mine = row.ready ? accounts.filter((a) => on(row, a)) : [];
    const list = mine.map((a) => {
      const r = titles.get(a.id)!;
      const ready = r.state === 'ready';
      return { id: a.id, name: nameOf(a), ready, inUse: a.id === inUse, detail: a.id === inUse ? WORDS['agent.inUse'] : ready ? WORDS['agent.ready'] : r.detail };
    });
    const state: AgentWayState = !row.ready ? 'unavailable' : list.some((a) => a.inUse) ? 'in_use' : list.some((a) => a.ready) ? 'connected' : 'sign_in';
    const title = row.billing === 'api' && row.via === 'key' ? fill(WORDS['agent.way.key'], { name: row.name }) : row.name;
    return { row, title, state, accounts: list };
  };
  const ways = rows.filter((r) => r.group === 'plans').map(wayOf);
  const perUse = rows.filter((r) => r.group !== 'plans').map(wayOf);
  const enabled = ways.filter((w) => w.accounts.some((a) => a.ready)).length;
  const note = inUse ? fill(WORDS['agent.using'], { name: agent.name, account: nameOf(saved!) })
    : saved ? fill(WORDS['agent.saved.notReady'], { account: nameOf(saved) })
    : enabled ? fill(WORDS['agent.pick'], { name: agent.name })
    : ways.length ? WORDS['agent.signIn.first'] : WORDS['agent.perUseOnly'];
  const options = inUse ? (models ?? []).map((m) => ({ id: m.id, name: m.name, available: m.available, selected: m.id === defaults.model && m.available })) : [];
  const value = options.find((m) => m.selected)?.id;
  const words = !inUse ? WORDS['agent.model.noAccount'] : !models ? WORDS['agent.model.reading'] : !options.length ? WORDS['agent.model.none']
    : value ? fill(WORDS['agent.model.chosen'], { name: options.find((m) => m.id === value)!.name })
    : defaults.model ? WORDS['agent.model.gone'] : WORDS['agent.model.pick'];
  return {
    kind: agent.kind, name: agent.name, enabled, total: ways.length,
    count: ways.length ? fill(WORDS['agent.count'], { enabled, total: ways.length }) : WORDS['agent.count.none'],
    rule: WORDS['agent.rule'], ways, perUse: { title: WORDS['connect.perUse'], note: WORDS['agent.perUse.note'], ways: perUse },
    ...(inUse ? { inUse } : {}), note,
    model: { label: WORDS['agent.model'], options, ...(value ? { value } : {}), words, disabled: !options.some((m) => m.available) },
  };
}
