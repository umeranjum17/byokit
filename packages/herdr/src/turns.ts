import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { HerdrKit } from './kit.ts';
import type { AgentRef, AgentTurnEnd, AgentTurnOptions, AgentTurnResult, AgentTurnResultPolicy } from './types.ts';
import { changedFiles, positiveLimit, scanFiles } from './turn-files.ts';
import { words } from './words.ts';

const fail = (code: string): Error & { code: string } => Object.assign(new Error(words('turn.failed')), { code });
const contains = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

async function readResult<T>(path: string, id: string, policy: AgentTurnResultPolicy<T>): Promise<AgentTurnResult<T>> {
  const maxBytes = positiveLimit(policy.maxBytes, 1024 * 1024);
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', reason: 'unsafe-file' };
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) return { state: 'invalid', reason: 'unsafe-file' };
    if (info.size > maxBytes) return { state: 'invalid', reason: 'too-large' };
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) return { state: 'invalid', reason: 'too-large' };
    const after = await file.stat();
    if (size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      return { state: 'invalid', reason: 'format' };
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))); }
    catch { return { state: 'invalid', reason: 'format' }; }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload) ||
      !('turnId' in payload) || payload.turnId !== id || !('result' in payload)) {
      return { state: 'invalid', reason: 'format' };
    }
    try {
      if (policy.validate(payload.result)) return { state: 'valid', value: payload.result };
    } catch { /* Validator diagnostics may contain private data; never log them. */ }
    return { state: 'invalid', reason: 'schema' };
  } finally { await file.close(); }
}

export function createTurns(kit: HerdrKit) {
  const panes = new Set<string>();
  const roots = new Set<string>();
  const pending = new Set<() => void>();
  const listeners = new Set<(end: AgentTurnEnd) => void>();

  async function runTurn<T>(target: AgentRef, o: AgentTurnOptions<T>): Promise<AgentTurnEnd<T>> {
    if (panes.has(target.paneId)) throw fail('turn-busy');
    if (!isAbsolute(o.cwd)) throw fail('turn-cwd');
    const timeoutMs = positiveLimit(o.timeoutMs, 300000);
    // Fail invalid configuration before delivering a prompt.
    positiveLimit(o.files?.maxFiles, 10000); positiveLimit(o.files?.maxBytes, 128 * 1024 * 1024);
    if (o.result) positiveLimit(o.result.maxBytes, 1024 * 1024);
    const schema = o.result ? JSON.stringify(o.result.schema) : undefined;
    const id = randomUUID();
    const resultName = `.byokit-turn-${id}.json`;
    let root: string | undefined;
    let ownsRoot = false;
    let failure: Error | undefined;
    let rejectFailure!: (e: Error) => void;
    const failed = new Promise<never>((_, reject) => { rejectFailure = reject; });
    void failed.catch(() => {});
    const abort = (code: string) => {
      if (failure) return;
      failure = fail(code); rejectFailure(failure);
    };
    const active = () => { if (failure) throw failure; };
    const gate = <V>(promise: Promise<V>): Promise<V> => Promise.race([promise, failed]);
    const cancelled = () => abort('turn-cancelled');
    const stopped = () => abort('turn-unavailable');
    panes.add(target.paneId); pending.add(stopped);
    const timer = setTimeout(() => abort('turn-timeout'), timeoutMs);
    o.signal?.addEventListener('abort', cancelled, { once: true });
    if (o.signal?.aborted) cancelled();
    let stopWatch: (() => void) | undefined;
    let offEvent: (() => void) | undefined;
    try {
      active();
      root = await gate(realpath(o.cwd));
      if ([...roots].some((held) => contains(held, root!) || contains(root!, held))) throw fail('turn-busy');
      roots.add(root); ownsRoot = true;
      let armed = false;
      let working = false;
      let ended = false;
      let resolveEnd!: (status: 'idle' | 'done') => void;
      const endSignal = new Promise<'idle' | 'done'>((resolve) => { resolveEnd = resolve; });
      const watch = kit.subscribe([{ type: 'pane.agent_status_changed', pane_id: target.paneId }], (e) => {
        if (!armed) {
          if (e.agent_status !== 'idle') abort('turn-busy');
          return;
        }
        if (ended) return;
        if (e.agent_status === 'working') working = true;
        else if (working && (e.agent_status === 'idle' || e.agent_status === 'done')) {
          ended = true; resolveEnd(e.agent_status);
        }
      }, () => abort('turn-watch-lost'));
      stopWatch = watch;
      watch.onDisconnect(() => abort('turn-watch-lost'));
      offEvent = kit.onEvent((e) => {
        const kind = e.type.replace(/_/g, '.');
        if (e.pane_id === target.paneId && ['pane.closed', 'pane.exited', 'pane.moved', 'pane.agent.detected'].includes(kind)) {
          abort('turn-unavailable');
        }
      });
      if (!await gate(watch.ready)) throw fail('turn-watch-lost');
      const beforeAgent = await gate(kit.call('agent.get', { target: target.paneId }));
      const agent = beforeAgent.agent;
      if (agent.agent_status !== 'idle' || agent.launch_pending === true) throw fail('turn-not-idle');
      if (target.name && agent.name !== target.name) throw fail('turn-unavailable');
      const cwd = agent.foreground_cwd ?? agent.cwd;
      if (typeof cwd !== 'string' || await gate(realpath(cwd)) !== root) throw fail('turn-cwd');
      const before = await gate(scanFiles(root, o.files, resultName, active));
      const prompt = o.result ? `${o.prompt}\n\nBefore finishing, write a UTF-8 JSON file at ${JSON.stringify(join(root, resultName))}. ` +
        `The file must contain {"turnId":${JSON.stringify(id)},"result":<your result>}. ` +
        `The result must satisfy this JSON Schema: ${schema}. Write the file completely before returning to idle.` : o.prompt;
      active(); armed = true;
      const receipt = await gate(kit.prompt(target, prompt));
      const status = await gate(endSignal);
      // Recheck the occupant/directory before reading an agent-created file.
      const afterAgent = (await gate(kit.call('agent.get', { target: target.paneId }))).agent;
      if (afterAgent.terminal_id !== receipt.terminalId || afterAgent.name !== agent.name ||
        afterAgent.agent !== agent.agent || !['idle', 'done'].includes(afterAgent.agent_status) ||
        await gate(realpath(afterAgent.foreground_cwd ?? afterAgent.cwd ?? '')) !== root) throw fail('turn-unavailable');
      const result: AgentTurnResult<T> = o.result
        ? await gate(readResult(join(root, resultName), id, o.result)) : { state: 'not-requested' };
      const after = await gate(scanFiles(root, o.files, resultName, active));
      active();
      const end: AgentTurnEnd<T> = { id, target: { ...target }, receipt, status, changedFiles: changedFiles(before, after), result };
      // App callbacks cannot turn a completed turn into a failed call, and never see unchecked bytes.
      for (const fn of [...listeners]) try { fn(end); } catch { /* host listener */ }
      try { o.onEnd?.(end); } catch { /* per-turn listener */ }
      return end;
    } catch (error) {
      if (failure) throw failure;
      const code = (error as { code?: string })?.code;
      if (code?.startsWith('turn-')) throw error;
      throw fail('turn-failed');
    } finally {
      clearTimeout(timer); o.signal?.removeEventListener('abort', cancelled);
      stopWatch?.(); offEvent?.(); pending.delete(stopped); panes.delete(target.paneId);
      if (ownsRoot && root) {
        // Unlink only the kit's unique output path; never recursively delete a directory or follow a link.
        if (o.result && await realpath(root).catch(() => undefined) === root) {
          await unlink(join(root, resultName)).catch(() => {});
        }
        roots.delete(root);
      }
    }
  }
  return {
    runTurn,
    onTurnEnd(fn: (end: AgentTurnEnd) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
    stop(): void { for (const cancel of [...pending]) cancel(); },
  };
}
