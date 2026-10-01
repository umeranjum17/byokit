// Node-only launch isolation; no runtime Pi import or ambient credential discovery.
import { mkdirSync } from 'node:fs';
import type { AuthContext } from '@earendil-works/pi-ai';
import { PROVIDERS } from './catalogue.ts';

const prefixes = new Set(['PI', 'ANTHROPIC', 'OPENAI', 'CODEX', 'CLAUDE', 'GEMINI', 'GOOGLE', 'GCLOUD',
  'AWS', 'AZURE', 'CLOUDFLARE', 'XAI', 'OPENROUTER', 'GITHUB', 'COPILOT', 'MINIMAX', 'KIMI',
  'MOONSHOT', 'MOONSHOTAI', 'QWEN', 'DASHSCOPE', 'HF']);
for (const p of Object.values(PROVIDERS)) {
  for (const name of [p.key, p.pi, p.company]) {
    prefixes.add(name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
    prefixes.add(name.toUpperCase().replace(/[^A-Z0-9]+/g, ''));
    prefixes.add(name.toUpperCase().split(/[^A-Z0-9]+/)[0]!);
  }
}
/** Inherited provider namespaces (derived from the catalogue), credentials and Pi settings. */
export const INHERITED = new RegExp(`^(?:${[...prefixes].join('|')})_|_API_KEY$|^(?:AI_AGENT|GH_TOKEN|HF_TOKEN)$`, 'i');

export type LaunchEnv = { env: Record<string, string>; unset: string[] };
export type LaunchEnvOptions = {
  base?: Readonly<Record<string, string | undefined>>;
  /** Account folder settings, for example the result of cliAccounts.launchEnv(id). No credential files are read. */
  account?: { set: Readonly<Record<string, string>>; unset?: readonly string[] };
  set?: Readonly<Record<string, string>>;
  unset?: readonly string[];
};
const validName = (key: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);

/** Copy and scrub a launch environment. Explicit settings are opt-in; explicit unsets win. Never mutates inputs. */
export function launchEnv(o: LaunchEnvOptions = {}): LaunchEnv {
  const env: Record<string, string> = {};
  const unset = new Set<string>();
  for (const [key, value] of Object.entries(o.base ?? process.env)) {
    if (!validName(key)) throw new Error('Invalid launch environment.');
    if (INHERITED.test(key)) unset.add(key);
    else if (value !== undefined) {
      if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid launch environment.');
      Object.defineProperty(env, key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
  for (const [key, value] of Object.entries({ ...o.account?.set, ...o.set })) {
    if (!validName(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid launch environment.');
    Object.defineProperty(env, key, { value, writable: true, enumerable: true, configurable: true });
    unset.delete(key);
  }
  for (const key of [...o.account?.unset ?? [], ...o.unset ?? []]) {
    if (!validName(key)) throw new Error('Invalid launch environment.');
    delete env[key]; unset.add(key);
  }
  return { env, unset: [...unset].sort() };
}

/** Ambient discovery switched off: no environment variable or credential file is ever consulted. */
export const emptyAuthContext: AuthContext = { env: async () => undefined, fileExists: async () => false };

/** Prepare the app-owned engine folder. Returns dir for compatibility; launchEnv supplies child isolation. */
export function isolate(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
