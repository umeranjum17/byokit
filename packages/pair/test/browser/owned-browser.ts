// The kit's test browser. One documented key selects Chromium; shutdown closes only the processes
// this helper spawned, over their own private CDP pipe, and never signals a process group.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

/** The single documented config key for the test browser: an absolute path or a PATH name.
 * Unset, the first Chromium on PATH is used; when none is found the browser journey is skipped. */
export const TEST_BROWSER_KEY = 'BYOKIT_CHROME';
const CANDIDATES = ['chromium', 'google-chrome', 'google-chrome-stable', 'chromium-browser'];
function preflight(candidate: string): boolean {
  if (candidate.includes('/')) { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } }
  return spawnSync('which', [candidate], { stdio: 'ignore' }).status === 0;
}

/** Resolve the one key, then the safe default. Nothing found means "no browser here". */
export function testBrowserBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env[TEST_BROWSER_KEY];
  if (named && preflight(named)) return named;
  return CANDIDATES.find(preflight);
}

// The owned-process accounting reads Linux /proc; other platforms still close over the private CDP
// pipe and require a clean exit, but cannot enumerate the tree, so they never claim a survivor count.
const PROCFS = process.platform === 'linux';

type Identity = { pid: number; parent: number; start: string };
function identity(pid: number): Identity | undefined {
  if (!PROCFS) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(fields[19] ?? '')) throw new Error(`invalid kernel identity for PID ${pid}`);
    return { pid, parent: Number(fields[1]), start: fields[19] };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
}

/** Every child PID a live process has, read per thread; a process that leaves mid-read is simply gone. */
function children(pid: number): string[] {
  const out: string[] = [];
  let tasks: string[];
  try { tasks = readdirSync(`/proc/${pid}/task`); } catch { return out; }
  for (const tid of tasks) {
    try { out.push(...readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').split(/\s+/).filter(Boolean)); } catch { /* gone */ }
  }
  return out;
}

/**
 * Launch a task browser with a private CDP pipe and close it over that pipe. Owned processes are
 * tracked by kernel identity and walked through witnessed parents only: never cwd, session or group
 * matching, and never a negative PID. A close that cannot prove every owned process is gone throws
 * and retains a receipt; it is never retried, masked or widened into a group signal.
 */
export function ownedBrowser(bin: string, args: string[], profile: string, closeBoundMs = 5000) {
  const chrome: ChildProcess = spawn(bin, [...args, '--remote-debugging-pipe'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let spawnError: Error | undefined;
  chrome.on('error', (error) => { spawnError = error; });
  const owned = new Map<number, Identity>();
  let root: Identity | undefined;
  let trackingError: unknown;
  let said = '';
  chrome.stderr!.on('data', (data) => { said = (said + data).slice(-2000); });
  const remember = () => {
    if (!root) {
      if (!chrome.pid || chrome.pid <= 0) throw new Error('no positive spawned browser PID');
      root = PROCFS ? identity(chrome.pid) : { pid: chrome.pid, parent: process.pid, start: '' };
      if (!root || PROCFS && root.parent !== process.pid) throw new Error('spawned browser ownership not witnessed');
      owned.set(root.pid, root);
    }
    if (!PROCFS) return;
    // Walk only the owned tree, through each witnessed parent's own children list. A scan of every
    // process on the machine competes with the browser's own shutdown on a loaded host.
    const todo = [...owned.values()];
    while (todo.length) {
      const parent = todo.pop()!;
      if (identity(parent.pid)?.start !== parent.start) continue; // gone, or another process at that PID
      for (const tid of children(parent.pid)) {
        const child = Number(tid) > 0 ? identity(Number(tid)) : undefined;
        if (child && child.parent === parent.pid && !owned.has(child.pid)) { owned.set(child.pid, child); todo.push(child); }
      }
    }
  };
  const track = () => { try { remember(); } catch (error) { trackingError ??= error; } };
  track();
  const tracker = setInterval(track, 100);
  tracker.unref();
  const input = chrome.stdio[3] as Duplex, output = chrome.stdio[4] as Duplex;
  let buffer = '', acknowledged = false, protocolError: Error | undefined;
  input.on('error', (error) => { protocolError = error; });
  output.on('error', (error) => { protocolError = error; });
  output.on('data', (data) => {
    buffer += data.toString();
    for (let end; (end = buffer.indexOf('\0')) >= 0;) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(raw);
        if (message.id === 1) {
          if (message.error) protocolError = new Error(`Browser.close: ${JSON.stringify(message.error)}`);
          else acknowledged = true;
        }
      } catch (error) { protocolError = error as Error; }
    }
  });
  return { chrome, close: async () => {
    const began = Date.now(), cutoff = began + closeBoundMs;
    const survivors = () => PROCFS ? [...owned.values()].filter((p) => identity(p.pid)?.start === p.start) : [];
    let before: Identity[] = [];
    try {
      if (spawnError) throw spawnError;
      if (trackingError) throw trackingError;
      remember();
      if (!root) throw new Error('no owned browser root before close');
      if (PROCFS && (identity(root.pid)?.start !== root.start || identity(root.pid)?.parent !== process.pid))
        throw new Error('browser PID/starttime/parent ownership lost before close');
      before = survivors();
      input.write(JSON.stringify({ id: 1, method: 'Browser.close' }) + '\0');
      for (;;) {
        if (protocolError) throw protocolError;
        if (trackingError) throw trackingError;
        const remaining = survivors();
        if (acknowledged && chrome.exitCode === 0 && chrome.signalCode === null && !remaining.length) break;
        if (Date.now() >= cutoff) throw new Error(`browser close cutoff: ack=${acknowledged}, exit=${chrome.exitCode}, signal=${chrome.signalCode}, survivors=${JSON.stringify(remaining)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      rmSync(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    } catch (error) {
      const evidence = join(profile, 'cleanup-failure.json');
      try { writeFileSync(evidence, JSON.stringify({ root, before, owned: [...owned.values()], survivors: survivors(),
        acknowledged, exit: chrome.exitCode, signal: chrome.signalCode, began, cutoff, finished: Date.now(), error: String(error), said }, null, 2)); } catch { /* keep the received error */ }
      throw new Error(`browser cleanup failed; retained ${evidence}: ${error}`, { cause: error });
    } finally {
      clearInterval(tracker);
      input.destroy(); output.destroy(); chrome.stderr!.destroy();
      chrome.unref(); // Failed cleanup remains a test failure, not an unbounded wait or a group signal.
    }
  } };
}
