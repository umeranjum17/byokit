import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parent = tmpdir();
const prefix = 'byokit-test-';
let root: string | undefined;
// Test teardown only: immutable engine sets need writable directories to unlink their children.
function discard(path: string): void {
  if (!existsSync(path)) return;
  const walk = (dir: string) => {
    if (!lstatSync(dir).isDirectory()) return;
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) walk(join(dir, name));
  };
  walk(path); rmSync(path, { recursive: true, force: true });
}
export function removeScratch(path: string): void {
  if (!root || path !== root && !path.startsWith(root + '/')) throw new Error('not this process scratch');
  discard(path);
}
const children = new Set<{ kill(signal?: NodeJS.Signals): boolean; once(event: 'exit', listener: () => void): unknown }>();

/** Remove only this project's scratch parents whose recorded process is no longer alive.
 * The parent defaults to this run's tmpdir; callers that sweep the runner's shared scratch pass it explicitly. */
export function cleanStaleScratch(at: string = parent): void {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const match = entry.isDirectory() && entry.name.match(/^byokit-test-(\d+)-/);
    if (!match) continue;
    let alive = true;
    try { process.kill(Number(match[1]), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (!alive) discard(join(at, entry.name));
  }
}

/** The accounts journeys are written against the exact @earendil-works/pi-ai pin in packages/accounts/package.json
 *  (the 1.x provider catalogue and the Anthropic callback pin). A checkout moved past a pin bump while
 *  node_modules still holds the old catalogue fails them as two suite-order-looking journey errors: the azure
 *  lookup finds no provider, and the browser sign-in has no callback fallback. Return that mismatch so the
 *  runner can fail with the real cause before the suite starts; an install matching the pin returns undefined. */
export function piPinMismatch(root: string): string | undefined {
  const pin = JSON.parse(readFileSync(join(root, 'packages/accounts/package.json'), 'utf8'))
    ?.dependencies?.['@earendil-works/pi-ai'];
  if (typeof pin !== 'string') return undefined;
  let installed: unknown;
  try { installed = JSON.parse(readFileSync(join(root, 'node_modules/@earendil-works/pi-ai/package.json'), 'utf8'))?.version; }
  catch { installed = undefined; }
  if (installed === pin) return undefined;
  return typeof installed === 'string'
    ? `installed @earendil-works/pi-ai is ${installed} but packages/accounts/package.json pins ${pin}: this checkout and node_modules disagree, so journeys written for the pinned catalogue fail as misleading suite errors - run npm ci`
    : `@earendil-works/pi-ai is not installed under ${root}/node_modules (packages/accounts/package.json pins ${pin}) - run npm ci`;
}

function ensureRoot(): string {
  if (!root) {
    root = mkdtempSync(join(parent, `${prefix}${process.pid}-`));
    process.on('exit', () => { for (const child of children) child.kill('SIGKILL'); discard(root!); });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
      for (const child of children) child.kill('SIGKILL');
      discard(root!);
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
  return root;
}

export function scratchDir(name = 'fixture'): string {
  return mkdtempSync(join(ensureRoot(), `${name}-`));
}

/** Real-engine tests share one engine-set install per job when scripts/test.sh exports BYOKIT_TEST_ENGINE_DIR
 * (a job-scoped dir off tmpfs); unset keeps the per-scratch install, so a single file run directly still works. */
export function sharedEngineDir(): string | undefined {
  return process.env.BYOKIT_TEST_ENGINE_DIR;
}

export function trackChild<T extends { kill(signal?: NodeJS.Signals): boolean; once(event: 'exit', listener: () => void): unknown }>(child: T): T {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

const CONSOLE_ORGS = 'https://opencode.ai/console/api/orgs';
let consoleFake: { asked: string[]; answer(next: (signal: AbortSignal) => Promise<Response>): void } | undefined;
/** The OpenCode console's org listing, answered in this process for the rest of the file (a stand-in key is no
 * login: 401, so an add needs no workspace); every other address goes to the real fetch. A plain assignment, not
 * `mock.method`, so a test's `mock.restoreAll()` keeps it. */
export function fakeOpenCodeConsole(): NonNullable<typeof consoleFake> {
  if (consoleFake) return consoleFake;
  const real = globalThis.fetch;
  const asked: string[] = [];
  let answer = async (_signal: AbortSignal): Promise<Response> => new Response('', { status: 401 });
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    if ((input instanceof Request ? input.url : String(input)) !== CONSOLE_ORGS) return real(input, init);
    asked.push(new Headers(init?.headers).get('authorization') ?? '');
    return answer(init?.signal ?? new AbortController().signal);
  };
  return consoleFake = { asked, answer: (next) => { answer = next; } };
}
