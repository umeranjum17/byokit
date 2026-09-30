// Account-specific CLI panes (D11/6.6). No credentials are read or copied. Moves follow
// the decided start-then-close order; only fake transports exercise this in tests.
import { randomBytes } from 'node:crypto';
import type { Call } from './agents.ts';
import type { AgentRef, MoveResult, MoveToAccount, OpenSignInTab, StartAgent } from './types.ts';
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
  async function checkEnv(paneId: string, variable: string, folder: string, timeout: number): Promise<boolean> {
    const marker = `BYOKIT_ACCOUNT_${randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + timeout;
    try {
      await call('pane.send_text', { pane_id: paneId, text: `echo ${marker}="$${variable}"\n` }, timeout);
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

  async function moveToAccount(target: AgentRef, o: MoveToAccount): Promise<MoveResult> {
    const failed = (code: Extract<MoveResult, { ok: false }>['code'], live = target.paneId): MoveResult =>
      ({ ok: false, code, message: words(`move.${code}`), live });
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
      if (!['claude', 'codex'].includes(o.provider) || ![o.provider, 'pi'].includes(kind)
        || session.agent !== kind) return failed('unsupported');
      const args = kind === 'pi' && session.kind === 'path' ? ['--session', session.value]
        : kind === 'claude' && session.kind === 'id' ? ['--resume', session.value]
        : kind === 'codex' && session.kind === 'id' ? ['resume', session.value] : undefined;
      if (args === undefined) return failed('unsupported');
      if (!o.folder || /[\r\n\0]/.test(o.folder)) return failed('env_mismatch');
      const timeout = o.timeoutMs ?? 15_000;
      if (!Number.isFinite(timeout) || timeout <= 0) return failed('start_failed');
      const variable = o.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
      let paneId: string;
      try {
        const split = await call('pane.split', { target_pane_id: target.paneId,
          direction: o.direction ?? 'right', focus: false,
          ...(typeof (agent.foreground_cwd ?? agent.cwd) === 'string' ? { cwd: agent.foreground_cwd ?? agent.cwd } : {}),
          env: { ...o.env, [variable]: o.folder } }, timeout) as Raw;
        if (typeof split?.pane?.pane_id !== 'string') return failed('start_failed');
        paneId = split.pane.pane_id;
      } catch { return failed('start_failed'); }
      if (!await checkEnv(paneId, variable, o.folder, timeout)) {
        await close(paneId);
        return failed('env_mismatch');
      }
      try {
        // Unique names avoid colliding with the still-live source agent.
        await ctx.startAgent({ kind, cwd: agent.foreground_cwd ?? agent.cwd ?? '.',
          name: `move-${randomBytes(8).toString('hex')}`, place: { pane: paneId }, args, timeoutMs: timeout });
        await call('agent.wait', { target: paneId, until: ['idle', 'done'], timeout_ms: timeout }, timeout + 5000);
        const ready = (await call('agent.get', { target: paneId }) as Raw)?.agent;
        if (!ready || ready.launch_pending === true || !['idle', 'done'].includes(ready.agent_status)
          || ready.agent !== kind || ready.agent_session?.agent !== kind
          || ready.agent_session?.kind !== session.kind || typeof ready.agent_session?.value !== 'string'
          || ready.agent_session.value.length === 0) throw new Error('not ready');
      } catch {
        const cleaned = await close(paneId);
        return failed('start_failed', cleaned ? target.paneId : paneId);
      }
      if (!await close(target.paneId)) {
        const cleaned = await close(paneId);
        return failed('close_failed', cleaned ? target.paneId : paneId);
      }
      return { ok: true, session: paneId };
    } finally { moving.delete(target.paneId); }
  }

  return { openSignInTab, moveToAccount };
}
