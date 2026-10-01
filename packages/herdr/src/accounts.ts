// Account-specific CLI panes (D11/6.6). No credentials are read or copied. Moves follow
// the decided start-then-close order; only fake transports exercise this in tests.
import { randomBytes } from 'node:crypto';
import type { Call } from './agents.ts';
import type { AgentRef, Move, MoveResult, MoveToAccount, MoveToAccountResult, OpenSignInTab, StartAgent } from './types.ts';
import { words } from './words.ts';

type Raw = Record<string, any>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createAccountPanes(ctx: { call: Call; startAgent(o: StartAgent): Promise<AgentRef> }) {
  const moving = new Set<string>();
  const call = ctx.call;

  async function close(paneId: string): Promise<boolean> {
    try { await call('pane.close', { pane_id: paneId }); return true; }
    catch { return false; }
  }

  // A shell rc can override placement env. Verify what the shell actually resolves, rather
  // than pane.get's launch env. The variable name is fixed by the provider, never caller text.
  async function checkEnv(paneId: string, variable: string, folder: string, timeout: number, absent = false): Promise<boolean> {
    const marker = `BYOKIT_ACCOUNT_${randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + timeout;
    const expansion = absent ? '${' + variable + '+x}' : '$' + variable;
    try {
      await call('pane.send_text', { pane_id: paneId, text: `echo ${marker}="${expansion}"\n` }, timeout);
      for (;;) {
        const result = await call('pane.read', { pane_id: paneId, source: 'recent_unwrapped', lines: 40,
          format: 'text', strip_ansi: true }, Math.max(1, deadline - Date.now())) as Raw;
        const readings = String(result?.read?.text ?? '').split('\n').map((line) => line.trim())
          .filter((line) => line.startsWith(`${marker}=`)).map((line) => line.slice(marker.length + 1));
        if (readings.length > 0) return readings.includes(folder);
        if (Date.now() >= deadline) return false;
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    } catch { return false; }
  }

  // agent.start has no env/unset/command field in the pinned protocol. Clear credentials in
  // the shell that launches it, then verify absence (never echo credential values).
  async function prepareEnv(paneId: string, set: Record<string, string>, unset: string[], variable: string, timeout: number): Promise<boolean> {
    const entries = Object.entries(set);
    if ([...entries.map(([key]) => key), ...unset].some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      || entries.some(([, value]) => typeof value !== 'string' || /[\r\n\0]/.test(value))
      || unset.some((key) => key in set)) return false;
    try {
      if (unset.length > 0) await call('pane.send_text', { pane_id: paneId, text: `unset ${unset.join(' ')}\n` }, timeout);
      if (!await checkEnv(paneId, variable, set[variable]!, timeout)) return false;
      for (const key of unset) if (!await checkEnv(paneId, key, '', timeout, true)) return false;
      return true;
    } catch { return false; }
  }

  async function openSignInTab(o: OpenSignInTab): Promise<AgentRef> {
    const { workspaceId, label, ...start } = o;
    try {
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
      const session = agent?.agent_session;
      if (!agent || agent.launch_pending === true || !session || typeof session.value !== 'string'
        || session.value.length === 0) return failed('too_early');
      if (!['idle', 'done'].includes(agent.agent_status)) return failed('busy');
      const kind = agent.agent;
      if (!['claude', 'codex'].includes(o.provider) || kind !== o.provider
        || (request !== undefined && request.kind !== kind)
        || session.agent !== kind || session.kind !== 'id') return failed('unsupported');
      const args = request?.args ?? (kind === 'claude' && session.kind === 'id' ? ['--resume', session.value]
        : kind === 'codex' && session.kind === 'id' ? ['resume', session.value] : undefined);
      if (args === undefined || !Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== 'string' || /[\r\n\0]/.test(a))) return failed('unsupported');
      if (!o.folder || /[\r\n\0]/.test(o.folder)) return failed('env_mismatch');
      const timeout = o.timeoutMs ?? 60_000;
      if (!Number.isFinite(timeout) || timeout <= 0) return failed('start_failed');
      const variable = o.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
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
      if (request !== undefined && !await prepareEnv(paneId, request.set, request.unset ?? [], variable, timeout)) {
        return rollback('env_mismatch');
      }
      if (request === undefined && !await checkEnv(paneId, variable, o.folder, timeout)) {
        return rollback('env_mismatch');
      }
      try {
        // Unique names avoid colliding with the still-live source agent.
        await ctx.startAgent({ kind, cwd: agent.foreground_cwd ?? agent.cwd ?? '.',
          name: `move-${randomBytes(8).toString('hex')}`, place: { pane: paneId }, args, timeoutMs: timeout });
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
      if (!await close(target.paneId)) {
        // A lost ACK can mean the close already applied. Never destroy the ready
        // replacement unless a fresh read proves the original conversation survived.
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
      try { request?.onReplaced?.(paneId); } catch { /* notification only */ }
      return { ok: true, session: paneId };
    } finally { moving.delete(target.paneId); }
  }

  async function move(o: Move): Promise<MoveResult> {
    const variable = o.kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    const result = await perform({ paneId: o.paneId }, {
      provider: o.kind === 'claude' ? 'claude' : 'codex', folder: o.set[variable] ?? '',
      env: o.set, timeoutMs: o.timeoutMs,
    }, o);
    return result.ok ? { ok: true, paneId: result.session } : result;
  }

  return { openSignInTab, move, moveToAccount: (target: AgentRef, o: MoveToAccount) => perform(target, o) };
}
