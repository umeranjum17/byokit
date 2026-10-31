import { spawn } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { usage, type Reading } from '@byokit/usage';
import { EndpointError, KEY_ROUTES, checkOptions, endpointConfig, newClientKey, type EndpointCredential, type EndpointOptions } from './config.ts';

export * from './config.ts';
export type Endpoint = {
  /** `http://127.0.0.1:<port>`: point any OpenAI or Anthropic web-format tool here. */
  url: string;
  port: number;
  /** This run's client key; the tool sends it as its API key. A new one every run. */
  clientKey: string;
  stop(): Promise<void>;
};

const inGitTree = (dir: string): boolean => {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
};
function checkStatePath(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new EndpointError('bad-state-dir', 'stateDir must be an absolute path.');
  const target = resolve(path);
  let current = target;
  let existing: string | undefined;
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new EndpointError('state-dir-symlink', 'endpoint state contains a symbolic link; a link could place the key inside a repository.');
      existing ??= current;
    } catch (error) {
      if (error instanceof EndpointError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error;
    }
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  const actual = join(realpathSync(existing!), relative(existing!, target));
  if (inGitTree(actual)) throw new EndpointError('state-dir-in-git', 'endpoint state is inside a git work tree, where the key could be committed; use an app data folder.');
}
/** Refuses a stateDir that is relative, inside a git work tree or open to group or world; nothing is written yet. */
function checkStateDir(stateDir: string): void {
  checkStatePath(stateDir);
  if (existsSync(stateDir) && (statSync(stateDir).mode & 0o077) !== 0) throw new EndpointError('state-dir-open', 'stateDir is accessible to its group or others; run chmod 700 on it.');
}
function checkStateFile(path: string): boolean {
  try {
    const file = lstatSync(path);
    if (file.isSymbolicLink() || !file.isFile()) throw new EndpointError('state-file-symlink', `${basename(path)} must be a regular file, not a symbolic link or other file type.`);
    return true;
  } catch (error) {
    if (error instanceof EndpointError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function binary(path: string | undefined): string {
  const candidates = path !== undefined ? [path] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'cli-proxy-api'));
  const found = candidates.find((p) => { try { accessSync(p, constants.X_OK); return isAbsolute(p) && statSync(p).isFile(); } catch { return false; } });
  if (!found) throw new EndpointError('binary-missing', path !== undefined ? 'binaryPath is not an executable absolute file path.' : 'cli-proxy-api is not on PATH; pass the absolute binaryPath of the pinned release.');
  return found;
}

/** Starts the pinned CLIProxyAPI on loopback for one API key and resolves once it answers. */
export async function startEndpoint(options: EndpointOptions): Promise<Endpoint> {
  checkStateDir(options.stateDir);
  const checked = checkOptions(options);
  const bin = binary(options.binaryPath);
  const dir = join(options.stateDir, 'endpoint');
  const privateDirs = [options.stateDir, dir, join(dir, 'auths'), join(dir, 'home')];
  for (const d of privateDirs) checkStatePath(d);
  for (const d of privateDirs) mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const d of privateDirs) checkStatePath(d);
  checkStateDir(options.stateDir);
  for (const d of privateDirs) chmodSync(d, 0o700);
  const clientKey = newClientKey();
  const config = join(dir, 'config.yaml');
  const logFile = join(dir, 'server.log');
  const staleConfig = checkStateFile(config);
  checkStateFile(logFile);
  if (staleConfig) rmSync(config);
  checkStateFile(logFile);
  const out = openSync(logFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  fchmodSync(out, 0o600);
  // JSON is YAML, so a key with any character is quoted exactly and cannot add a setting.
  try {
    checkStateFile(config);
    writeFileSync(config, JSON.stringify(endpointConfig(options, clientKey, dir), null, 2), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    closeSync(out);
    throw error;
  }
  // The child's environment is built from nothing: no store or Home variable can reach it.
  const env = { ...options.env, HOME: join(dir, 'home'), GOTRACEBACK: 'none' };
  const child = spawn('/bin/sh', ['-c', 'umask 077; ulimit -c 0; exec "$0" "$@"', bin, '--config', config, '--local-model'], { cwd: dir, env, stdio: ['ignore', out, out] });
  closeSync(out);
  let exited = false;
  const done = new Promise<void>((resolve) => child.once('exit', () => { exited = true; resolve(); }));
  const port = options.port ?? 8317;
  const url = `http://${checked.host}:${port}`;
  const stop = async () => {
    if (!exited) { child.kill('SIGTERM'); const t = setTimeout(() => child.kill('SIGKILL'), 5000); await done; clearTimeout(t); }
    rmSync(config, { force: true }); // the plaintext key does not outlive the run
  };
  for (let i = 0; i < 80 && !exited; i++) {
    try {
      if ((await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${clientKey}` }, signal: AbortSignal.timeout(1000) })).status === 200) return { url, port, clientKey, stop };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  await stop();
  throw new EndpointError('start-failed', `the endpoint did not answer on ${url}; see server.log in the endpoint folder of stateDir.`, { detail: { port } });
}

export type NoUsageApi = { ok: false; code: 'no-usage-api'; provider: string };
export type RoomOptions = { credential: EndpointCredential; fetch?: typeof fetch; now?: () => number; signal?: AbortSignal };
/** The provider's own quota reading, taken with the person's key through @byokit/usage and returned in its shape. */
export async function readEndpointRoom(options: RoomOptions): Promise<Reading | NoUsageApi> {
  const { provider, key } = options.credential;
  if (!Object.hasOwn(KEY_ROUTES, provider) || !('usage' in KEY_ROUTES[provider])) return { ok: false, code: 'no-usage-api', provider };
  const reader = usage({ ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) });
  return reader.read({ provider: provider as 'opencode' | 'zai', key }, options.signal ? { signal: options.signal } : {});
}
