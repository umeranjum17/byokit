// The OS keyring through its CLIs: macOS Keychain via `security`, Secret Service via `secret-tool`.
// The secret reaches the CLI only on stdin, never in argv or env (docs/capability-kits.md D-C). Every spawn
// gets an env built from nothing plus only what the host passes, and process.env is never read (D-G).
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { KeystoreError } from './errors.ts';
import type { Keystore } from './types.ts';
import { assertName, assertSecret } from './validate.ts';

export type KeyringTool = 'security' | 'secret-tool';

export type KeyringOptions = {
  /** Keyring partition; default 'byokit-secrets'. Same rules as a name. */
  service?: string;
  /** Absolute path of the keyring CLI. Defaults: /usr/bin/security (darwin), /usr/bin/secret-tool (linux). */
  bin?: string;
  /** CLI dialect. Defaults from the platform; an explicit tool skips the platform check (tests use this). */
  tool?: KeyringTool;
  /** Host-passed extras only, e.g. DBUS_SESSION_BUS_ADDRESS on Linux. */
  env?: Record<string, string>;
  /** Per-call timeout; default 10_000, clamped 1_000–60_000. */
  timeoutMs?: number;
};

const BASE_ENV = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } as const;
const DEFAULT_SERVICE = 'byokit-secrets';
const STDOUT_CAP = 1024 * 1024;
const STDERR_TAIL = 2048;

/** Exactly the base plus host extras. process.env is never consulted. */
export function keyringEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...BASE_ENV };
  if (extra === undefined) return env;
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
    throw new KeystoreError('invalid', 'keystore keyring env must be a record of strings');
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== 'string' || key.includes('\0') || value.includes('\0')) {
      throw new KeystoreError('invalid', 'keystore keyring env keys and values must be NUL-free strings');
    }
    env[key] = value;
  }
  return env;
}

function defaultTool(): KeyringTool {
  if (process.platform === 'darwin') return 'security';
  if (process.platform === 'linux') return 'secret-tool';
  throw new KeystoreError('unsupported', 'the OS keyring is unsupported on this platform in v1 (Windows Credential Manager is not implemented)');
}

function defaultBin(tool: KeyringTool): string {
  return tool === 'security' ? '/usr/bin/security' : '/usr/bin/secret-tool';
}

function resolveBin(bin: string | undefined, tool: KeyringTool): string {
  const resolved = bin ?? defaultBin(tool);
  if (typeof resolved !== 'string' || !isAbsolute(resolved)) {
    throw new KeystoreError('invalid', 'keystore keyring bin must be an absolute path');
  }
  try {
    accessSync(resolved, constants.X_OK);
  } catch {
    throw new KeystoreError('unavailable', 'the keyring CLI is not executable');
  }
  return resolved;
}

type RunResult = { stdout: Buffer; stderrTail: string; exitCode: number | null };

function runKeyring(bin: string, argv: string[], stdin: Buffer | null, env: Record<string, string>, timeoutMs: number, what: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e: any) {
      if (e?.code === 'ENOENT' || e?.code === 'EACCES') reject(new KeystoreError('unavailable', 'the keyring CLI is not executable'));
      else reject(new KeystoreError('failed', `keystore ${what} could not start the keyring CLI`));
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    let capped = false;
    let stderrTail = '';
    const killGroup = (signal: NodeJS.Signals): void => {
      try { process.kill(-child.pid!, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const fail = (code: 'failed' | 'unavailable', message: string): void => {
      killGroup('SIGKILL');
      reject(new KeystoreError(code, message));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      sigkillTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
    }, timeoutMs);
    let timedOut = false;
    let sigkillTimer: NodeJS.Timeout | undefined;
    child.on('error', (e: any) => {
      clearTimeout(timer);
      if (e?.code === 'ENOENT' || e?.code === 'EACCES') reject(new KeystoreError('unavailable', 'the keyring CLI is not executable'));
      else reject(new KeystoreError('failed', `keystore ${what} could not run the keyring CLI`));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > STDOUT_CAP && !capped) {
        capped = true;
        clearTimeout(timer);
        fail('failed', `keystore ${what} got too much output from the keyring CLI`);
        return;
      }
      if (!capped) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (timedOut) { reject(new KeystoreError('failed', `keystore ${what} timed out talking to the keyring`)); return; }
      if (capped) return; // already rejected
      resolve({ stdout: Buffer.concat(chunks), stderrTail, exitCode });
    });
    if (stdin === null) {
      child.stdin.end();
    } else {
      child.stdin.on('error', () => { /* the CLI exited early; the close handler reports it */ });
      child.stdin.end(stdin);
    }
  });
}

function notFound(stderrTail: string): boolean {
  return /could not be found|not found|no .* (found|match)/i.test(stderrTail);
}

/** Strip the single trailing LF the CLI adds to what it prints. */
function stdoutText(out: Buffer): string {
  let text = out.toString('utf8');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

export function keyringStore(o?: KeyringOptions): Keystore {
  const service = o?.service ?? DEFAULT_SERVICE;
  assertName(service, 'service');
  const tool = o?.tool ?? defaultTool();
  const env = keyringEnv(o?.env);
  const timeoutMs = Math.min(60_000, Math.max(1000, o?.timeoutMs ?? 10_000));
  const bin = resolveBin(o?.bin, tool);

  const argvFor = (verb: 'get' | 'set' | 'delete', name: string): string[] => {
    if (tool === 'security') {
      if (verb === 'get') return ['find-generic-password', '-s', service, '-a', name, '-w'];
      if (verb === 'set') return ['add-generic-password', '-s', service, '-a', name, '-U', '-w'];
      return ['delete-generic-password', '-s', service, '-a', name];
    }
    if (verb === 'get') return ['lookup', 'service', service, 'account', name];
    if (verb === 'set') return ['store', `--label=byokit:${service}:${name}`, 'service', service, 'account', name];
    return ['clear', 'service', service, 'account', name];
  };

  return {
    async get(name: string): Promise<string | null> {
      assertName(name);
      const r = await runKeyring(bin, argvFor('get', name), null, env, timeoutMs, `get of ${JSON.stringify(name)}`);
      if (r.exitCode === 0) return stdoutText(r.stdout);
      if (tool === 'secret-tool' ? r.exitCode === 1 : notFound(r.stderrTail)) return null;
      throw new KeystoreError('failed', `keystore get of ${JSON.stringify(name)} failed`);
    },
    async set(name: string, secret: string): Promise<void> {
      assertName(name);
      assertSecret(secret);
      const r = await runKeyring(bin, argvFor('set', name), Buffer.from(secret, 'utf8'), env, timeoutMs, `set of ${JSON.stringify(name)}`);
      if (r.exitCode !== 0) throw new KeystoreError('failed', `keystore set of ${JSON.stringify(name)} failed`);
    },
    async delete(name: string): Promise<boolean> {
      assertName(name);
      if (tool === 'secret-tool') {
        // `clear` exits 0 whether or not anything was stored, so a lookup decides the answer.
        if ((await this.get(name)) === null) return false;
      }
      const r = await runKeyring(bin, argvFor('delete', name), null, env, timeoutMs, `delete of ${JSON.stringify(name)}`);
      if (r.exitCode === 0) return true;
      if (notFound(r.stderrTail)) return false;
      throw new KeystoreError('failed', `keystore delete of ${JSON.stringify(name)} failed`);
    },
  };
}
