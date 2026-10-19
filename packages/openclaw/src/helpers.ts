// Helpers (5.8.3): a member's personas on one account the member already signed in. A helper is its own session
// namespace `agent:<member>:h-<helper>:` run on the agent holding that account, with its own persona as the run's system
// text: the pin shares no sign-in between agents (a shared agentDir is refused, authInheritance is global), so no agent
// is made and nothing is copied. Its record is a kit-owned file; the engine is never asked.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadIndex, type Binding } from './accounts.ts';
import { KEY_PREFIX, MEMBER_ID } from './members.ts';
import type { Account, AccountId, Helper, Member } from './types.ts';

export const HELPER_ID: RegExp = /^[a-z][a-z0-9-]{0,15}$/;
/** A session key tail of some helper: only a run naming that helper speaks there. */
export const HELPER_TAIL: RegExp = /^h-[a-z][a-z0-9-]{0,15}:/;
const PERSONA_MAX = 8192;

export type HelperErrorCode = 'invalid' | 'unknown_account' | 'bound' | 'unknown_helper' | 'session';
/** A refused helper request, before any run: `code` says which rule refused it. */
export class HelperError extends Error {
  readonly code: HelperErrorCode;
  constructor(code: HelperErrorCode, message: string) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
  }
}

type Saved = { v: 1; account: AccountId; agent: string; persona: string };

export function createHelpers(ctx: { root: string; list(member: Member): Promise<Account[]> }): {
  ensure(member: Member, helper: string, o: { account: AccountId; persona: string }): Promise<Helper>;
  resolve(member: Member, helper: string): { account: AccountId; agentId: string; binding: Binding; persona: string };
} {
  const valid = (member: unknown, helper: unknown): boolean => typeof member === 'string' && MEMBER_ID.test(member)
    && !member.startsWith(KEY_PREFIX) && typeof helper === 'string' && HELPER_ID.test(helper);
  const path = (member: Member, helper: string): string => join(ctx.root, 'helpers', member, `${helper}.json`);
  const read = (member: Member, helper: string): Saved | undefined => {
    try {
      const saved = JSON.parse(readFileSync(path(member, helper), 'utf8')) as Saved;
      return saved?.v === 1 && typeof saved.account === 'string' && typeof saved.agent === 'string'
        && typeof saved.persona === 'string' ? saved : undefined;
    } catch { return undefined; }
  };
  const view = (member: Member, helper: string, saved: Saved): Helper =>
    ({ member, helper, account: saved.account, agentId: saved.agent, sessionPrefix: `agent:${member}:h-${helper}:` });
  return {
    async ensure(member, helper, o) {
      const persona = o?.persona;
      // The persona is the helper's whole system text: bounded, plain text (newlines and tabs only).
      if (!valid(member, helper) || typeof persona !== 'string' || !persona.trim() || persona.length > PERSONA_MAX
        || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(persona))
        throw new HelperError('invalid', `invalid helper: ${String(member)}/${String(helper)}`);
      if (!(await ctx.list(member)).some((row) => row.id === o.account))
        throw new HelperError('unknown_account', `unknown account: ${String(o.account)}`);
      const agent = loadIndex(ctx.root, member).file.accounts[o.account]?.agent;
      if (!agent) throw new HelperError('unknown_account', `unknown account: ${o.account}`);
      const before = read(member, helper);
      if (before && (before.account !== o.account || before.agent !== agent))
        throw new HelperError('bound', `helper ${helper} uses another account`);
      const saved: Saved = { v: 1, account: o.account, agent, persona };
      const file = path(member, helper);
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      return view(member, helper, saved);
    },
    // A run's helper, fail closed: ensured by this kit, on an account the member's index still names on the same agent.
    // A removed account leaves the helper unusable; it never moves to another sign-in.
    resolve(member, helper) {
      const saved = valid(member, helper) ? read(member, helper) : undefined;
      const entry = saved && loadIndex(ctx.root, member).file.accounts[saved.account];
      if (!saved || entry?.agent !== saved.agent) throw new HelperError('unknown_helper', `unknown helper: ${String(helper)}`);
      return { account: saved.account, agentId: saved.agent, persona: saved.persona,
        binding: saved.agent === member ? { agentId: member } : { agentId: saved.agent, id: saved.account } };
    },
  };
}
