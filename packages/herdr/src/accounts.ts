// Account-specific CLI panes (D11/6.6). No credentials are read or copied. Moves follow
// the decided start-then-close order; only fake transports exercise this in tests.
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Call } from './agents.ts';
import type { AgentRef, Move, MoveResult, MoveToAccount, MoveToAccountResult, OpenSignInTab, StartAgent } from './types.ts';
import { words } from './words.ts';
import { accountKind } from './kinds.ts';

type Raw = Record<string, any>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createAccountPanes(ctx: { call: Call; startAgent(o: StartAgent): Promise<AgentRef> }) {
  const moving = new Set<string>();
  const call = ctx.call;

  async function close(paneId: string): Promise<boolean> {
    try { await call('pane.close', { pane_id: paneId }); return true; }
    catch { return false; }
  }

  // Env verification types nothing into the pane: every prep keystroke (unset lines,
  // echo probes) stays in the new pane's scrollback where users see it after a move. The
  // placement env rides `pane.split`, applied by the server before the shell is shown,
  // so `pane.get` proves the new shell's launch env: every set var exact, every unset
  // var absent. Fail closed: the split call cannot express removals, so a leaked
  // credential in the launch env refuses the move instead of running on it.
  // Limitation: a shell rc overriding placement env after launch is not visible here;
  // no pinned RPC reads shell-effective env without typing into the pane.
  async function verifyPaneEnv(paneId: string, set: Record<string, string>, unset: string[], timeout: number): Promise<boolean> {
    const entries = Object.entries(set);
    if ([...entries.map(([key]) => key), ...unset].some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      || entries.some(([, value]) => typeof value !== 'string' || /[\r\n\0]/.test(value))
      || unset.some((key) => key in set)) return false;
    try {
      const pane = (await call('pane.get', { pane_id: paneId }, timeout) as Raw)?.pane;
      const env = pane?.env;
      if (!pane || typeof env !== 'object' || env === null || Array.isArray(env)) return false;
      if (unset.some((key) => Object.hasOwn(env, key))) return false;
      return entries.every(([key, value]) => env[key] === value);
    } catch { return false; }
  }

  // The replacement keeps the conversation's user-visible name. The server rejects
  // duplicate agent names, so it starts unique while the source is still live, then
  // takes the source's name once that pane is closed. A failed rename keeps the
  // unique start name and never fails the move.
  function moveNames(sourceName: unknown, kind: string): { start: string; want: string } {
    const clean = (value: unknown): string | undefined => {
      const slug = String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[-_0-9]+/, '').slice(0, 32);
      return /^[a-z][a-z0-9_-]{0,31}$/.test(slug) ? slug : undefined;
    };
    const want = clean(sourceName) ?? clean(kind) ?? 'agent';
    return { start: `${want.slice(0, 25)}-${randomBytes(3).toString('hex')}`, want };
  }

  async function openSignInTab(o: OpenSignInTab): Promise<AgentRef> {
    const { workspaceId, label, folder, ...start } = o;
    try {
      if (folder !== undefined) {
        const variable = accountKind(start.kind)?.folderVar;
        if (!variable || !folder || /[\r\n\0]/.test(folder)) throw new Error('unsupported folder');
        const launch = start.env;
        start.env = launch && typeof launch.env === 'object' && Array.isArray(launch.unset)
          ? { env: { ...launch.env, [variable]: folder }, unset: launch.unset }
          : { ...launch as Record<string, string> | undefined, [variable]: folder };
      }
      return await ctx.startAgent({ ...start, place: { tab: 'new', workspaceId,
        ...(label === undefined ? {} : { label }) } });
    } catch {
      // A runtime error can contain account env. Never relay it to the sign-in screen.
      throw Object.assign(new Error(words('agent.notReady')), { code: 'sign_in_failed' });
    }
  }

  async function perform(target: AgentRef, o: MoveToAccount, request?: Move): Promise<MoveToAccountResult> {
    const failed = (code: Extract<MoveToAccountResult, { ok: false }>['code'], live: string | null = target.paneId): MoveToAccountResult =>
      ({ ok: false, code, message: words(`move.${code}`), ...(live === null ? {} : { live }) });
    if (moving.has(target.paneId)) return failed('busy');
    moving.add(target.paneId);
    try {
      let agent: Raw;
      try { agent = (await call('agent.get', { target: target.paneId }) as Raw)?.agent; }
      catch { return failed('too_early'); }
      const handoff = o.whenBusy;
      const optedIn = handoff?.busy === 'wait' || handoff?.busy === 'interrupt';
      let session = agent?.agent_session;
      if (!agent || agent.launch_pending === true || !session || typeof session.value !== 'string'
        || session.value.length === 0) return failed('too_early');
      if (agent.agent_status === 'blocked') return failed(optedIn ? 'blocked' : 'busy');
      if (!['idle', 'done'].includes(agent.agent_status) && !(optedIn && agent.agent_status === 'working')) return failed('busy');
      if (optedIn) {
        if (!handoff.confirmed || handoff.confirmed.session !== session.value
          || handoff.confirmed.terminalId !== agent.terminal_id) return failed('changed');
        if (typeof agent.terminal_id !== 'string' || agent.terminal_id.length === 0) return failed('unsupported');
        if (handoff.busy === 'interrupt') {
          if (handoff.confirmed.seq !== agent.state_change_seq) return failed('changed');
          return failed('interrupt_unsupported');
        }
        if (!Number.isFinite(handoff.waitMs) || handoff.waitMs <= 0 || handoff.waitMs > 300_000
          || !Number.isSafeInteger(agent.state_change_seq) || agent.state_change_seq < 0) return failed('unsupported');
        if (agent.agent_status === 'working') {
          try {
            await call('agent.wait', { target: target.paneId, until: ['idle', 'done', 'blocked'],
              timeout_ms: handoff.waitMs }, handoff.waitMs + 5000);
          } catch { return failed('busy'); }
          let current: Raw;
          try { current = (await call('agent.get', { target: target.paneId }) as Raw)?.agent; }
          catch { return failed('changed', null); }
          if (!current || current.launch_pending === true || current.agent !== agent.agent
            || current.terminal_id !== agent.terminal_id || current.agent_session?.agent !== session.agent
            || current.agent_session?.kind !== session.kind || current.agent_session?.value !== session.value) return failed('changed', null);
          if (current.agent_status === 'blocked') return failed('blocked');
          if (!['idle', 'done'].includes(current.agent_status)) return failed('busy');
          if (!Number.isSafeInteger(current.state_change_seq) || current.state_change_seq < 0) return failed('unsupported');
          agent = current;
          session = current.agent_session;
        }
      }
      const kind = agent.agent;
      const metadata = accountKind(o.provider);
      if (!metadata?.folderVar || !metadata.resume || kind !== metadata.kind
        || (request !== undefined && accountKind(request.kind)?.kind !== kind)
        || session.agent !== kind || !metadata.sessionKinds.includes(session.kind)) return failed('unsupported');
      if (/[\x00-\x1f\x7f]/.test(session.value) || session.value.length > (session.kind === 'path' ? 4096 : 512)
        || (session.kind === 'path' && !isAbsolute(session.value))) return failed('unsupported');
      const args = request?.args ?? metadata.resumeArgs?.map((arg) => arg.replace('{session}', () => session.value));
      if (args === undefined || !Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== 'string' || /[\r\n\0]/.test(a))) return failed('unsupported');
      if (!o.folder || /[\r\n\0]/.test(o.folder)) return failed('env_mismatch');
      const timeout = o.timeoutMs ?? 60_000;
      if (!Number.isFinite(timeout) || timeout <= 0) return failed('start_failed');
      const variable = metadata.folderVar;
      let paneId: string;
      let replacement: Raw;
      try {
        const split = await call('pane.split', { target_pane_id: target.paneId,
          direction: o.direction ?? 'right', focus: false,
          ...(typeof (agent.foreground_cwd ?? agent.cwd) === 'string' ? { cwd: agent.foreground_cwd ?? agent.cwd } : {}),
          env: { ...o.env, [variable]: o.folder } }, timeout) as Raw;
        if (typeof split?.pane?.pane_id !== 'string') return failed('start_failed');
        paneId = split.pane.pane_id;
      } catch { return failed('start_failed'); }
      const rollback = async (code: Extract<MoveToAccountResult, { ok: false }>['code']) =>
        failed(code, await close(paneId) ? target.paneId : paneId);
      try { request?.onStaged?.(paneId); }
      catch { return rollback('start_failed'); }
      if (request !== undefined) {
        if (!await verifyPaneEnv(paneId, request.set, request.unset ?? [], timeout)) return rollback('env_mismatch');
      } else if (!await verifyPaneEnv(paneId, { ...o.env, [variable]: o.folder }, [], timeout)) {
        return rollback('env_mismatch');
      }
      const names = moveNames(agent?.name, kind);
      try {
        await ctx.startAgent({ kind, cwd: agent.foreground_cwd ?? agent.cwd ?? '.',
          name: names.start, place: { pane: paneId }, args, timeoutMs: timeout });
        await call('agent.wait', { target: paneId, until: ['idle', 'done'], timeout_ms: timeout }, timeout + 5000);
        const deadline = Date.now() + timeout;
        for (;;) {
          const ready = (await call('agent.get', { target: paneId }, Math.max(1, deadline - Date.now())) as Raw)?.agent;
          if (ready && ready.launch_pending !== true && ['idle', 'done'].includes(ready.agent_status)
            && (request === undefined || ready.interactive_ready === true)
            && ready.agent === kind && ready.agent_session?.agent === kind
            && ready.agent_session?.kind === session.kind && typeof ready.agent_session?.value === 'string'
            && ready.agent_session.value.length > 0) { replacement = ready; break; }
          if (Date.now() >= deadline) throw new Error('not ready');
          await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
        }
      } catch {
        const cleaned = await close(paneId);
        return failed('start_failed', cleaned ? target.paneId : paneId);
      }
      // Compare identity, not revision: status changes can legitimately bump revision.
      const survives = async (id: string, expected: Raw): Promise<boolean> => {
        try {
          const current = (await call('agent.get', { target: id }, timeout) as Raw)?.agent;
          return !!current && current.agent === expected.agent && current.launch_pending !== true
            && ['idle', 'working', 'blocked', 'done'].includes(current.agent_status)
            && current.agent_session?.agent === expected.agent_session?.agent
            && current.agent_session?.kind === expected.agent_session?.kind
            && current.agent_session?.value === expected.agent_session?.value
            && (expected.terminal_id === undefined || current.terminal_id === expected.terminal_id)
            && (expected.name === undefined || current.name === expected.name);
        } catch { return false; } // unavailable is not proof of survival
      };
      let current: Raw;
      try { current = (await call('agent.get', { target: target.paneId }, timeout) as Raw)?.agent; }
      catch { current = {}; }
      if (!current || current.launch_pending === true || !['idle', 'done'].includes(current.agent_status)
        || current.agent_status !== agent.agent_status || current.agent !== agent.agent || current.terminal_id !== agent.terminal_id
        || current.agent_session?.agent !== session.agent || current.agent_session?.kind !== session.kind
        || current.agent_session?.value !== session.value
        || (agent.state_change_seq !== undefined && current.state_change_seq !== agent.state_change_seq)) {
        await close(paneId);
        const live = await survives(paneId, replacement) ? paneId
          : await survives(target.paneId, agent) ? target.paneId : null;
        return failed('changed', live);
      }
      // Published Herdr has no conditional close: the final observation is not atomic.
      if (!await close(target.paneId)) {
        // A lost ACK can mean the close already applied. Never destroy the ready
        // replacement unless a fresh read proves the original conversation survived.
        const replacementAlive = await survives(paneId, replacement);
        const sourceAlive = await survives(target.paneId, agent);
        if (sourceAlive && replacementAlive) await close(paneId);
        // Re-read after cleanup too: its ACK can also be lost, or another actor can
        // replace a pane. `live` is optional precisely when neither can be verified.
        const live = await survives(paneId, replacement) ? paneId
          : await survives(target.paneId, agent) ? target.paneId : null;
        return failed('close_failed', live);
      }
      // The source is closed: a notification failure cannot undo a successful move.
      // Take the conversation's name now that it is free; the unique start name stays
      // when the rename is refused, and a rename failure never undoes the move.
      if (names.want !== names.start) {
        try {
          await call('agent.rename', { target: paneId, name: names.want }, timeout);
          replacement.name = names.want;
        } catch { /* the unique start name stays; the move already succeeded */ }
      }
      try { request?.onReplaced?.(paneId); } catch { /* notification only */ }
      return { ok: true, session: paneId };
    } finally { moving.delete(target.paneId); }
  }

  async function move(o: Move): Promise<MoveResult> {
    const variable = accountKind(o.kind)?.folderVar;
    const result = await perform({ paneId: o.paneId }, {
      provider: o.kind, folder: variable === undefined ? '' : o.set[variable] ?? '',
      env: o.set, timeoutMs: o.timeoutMs, whenBusy: o.whenBusy,
    }, o);
    return result.ok ? { ok: true, paneId: result.session } : result;
  }

  return { openSignInTab, move, moveToAccount: (target: AgentRef, o: MoveToAccount) => perform(target, o) };
}
