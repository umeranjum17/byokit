import { dirname, join } from 'node:path';
import type { KitOptions } from './kit.ts';
import { routes } from './routes.ts';
import type { Member } from './types.ts';

type Obj = Record<string, any>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const merge = (a: Obj, b: Obj): Obj => {
  for (const [k, v] of Object.entries(b)) a[k] = object(v) ? merge(object(a[k]) ? a[k] : {}, v) : Array.isArray(v) ? structuredClone(v) : v;
  return a;
};
const safeMemory = (memory: unknown): void => {
  if (!object(memory) || !object(memory.search)) return;
  const s = memory.search;
  const local = ['none', 'local', 'ollama', 'lmstudio', 'github-copilot'].includes(s.provider);
  let remote = true;
  if (s.provider === 'ollama' || s.provider === 'lmstudio') {
    try {
      const url = new URL(s.remote?.baseUrl);
      remote = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !s.remote?.apiKey && !url.username && !url.password;
    } catch { remote = false; }
  }
  if (!local || !remote) s.provider = 'none';
  s.fallback = 'none';
};

export function reconcileConfig(saved: object | undefined, o: {
  root: string; stateDir: string; port: number; pluginId: string; pluginDir: string; policyPath: string;
  app?: object; installPolicy?: KitOptions['installPolicy'];
}): object {
  const c: Obj = merge(merge({}, object(saved) ? saved : {}), object(o.app) ? o.app : {});
  merge(c, {
    gateway: { mode: 'local', bind: 'loopback', port: o.port, auth: { mode: 'token' }, controlUi: { enabled: false }, tailscale: { mode: 'off' } },
    discovery: { mdns: { mode: 'off' } }, env: { shellEnv: { enabled: false } },
    update: { checkOnStart: false, auto: { enabled: false } }, telemetry: { enabled: false },
    models: { catalogRefresh: { enabled: false } }, logging: { file: join(o.stateDir, 'logs', 'openclaw-events.log') },
  });
  c.channels ??= {};
  c.agents ??= {};
  c.agents.defaults ??= {};
  c.agents.defaults.models ??= {};
  c.agents.defaults.models['openai/*'] = { ...c.agents.defaults.models['openai/*'], agentRuntime: { id: 'openclaw' } };
  const allow = c.agents.defaults.modelPolicy?.allow;
  if (Array.isArray(allow) && allow.length && !allow.includes('openai/*')) allow.push('openai/*');
  c.memory ??= {};
  c.memory.search ??= { provider: 'none' };
  safeMemory(c.memory);
  for (const entry of Object.values(c.agents.entries ?? {})) safeMemory((entry as { memory?: unknown }).memory);
  // The engine rejects a patched multi-agent roster without explicit ownership (O11); it normalizes the
  // same value on boot, so the kit writes what the engine would. A lone main (or empty) roster stays sole.
  const roster = Object.keys(c.agents.entries ?? {});
  if (roster.length > 1 || (roster.length === 1 && roster[0] !== 'main')) c.agents.ownership = 'explicit';
  c.plugins ??= {};
  c.plugins.load ??= {};
  c.plugins.load.paths = [...new Set([...(c.plugins.load.paths ?? []).filter((p: string) => !p.includes('byokit-openclaw-bridge')), o.pluginDir])];
  c.plugins.allow = [...new Set([...(c.plugins.allow ?? []), o.pluginId,
    ...routes().filter(route => route.offer && route.plugin).map(route => route.plugin)])];
  c.plugins.entries ??= {};
  c.plugins.entries[o.pluginId] = merge(c.plugins.entries[o.pluginId] ?? {}, { hooks: { timeouts: { before_tool_call: 200_000 } } });
  c.security ??= {};
  c.security.installPolicy = { enabled: true, exec: {
    source: 'exec', command: process.execPath, args: [o.policyPath],
    trustedDirs: [dirname(process.execPath), dirname(o.policyPath)], timeoutMs: 10_000,
    passEnv: ['OPENCLAW_STATE_DIR'], env: {
      BYOKIT_TRUSTED_SKILLS: o.installPolicy?.trustedSkills ?? '',
      BYOKIT_OWN_ROOTS: JSON.stringify(o.installPolicy?.ownRoots ?? []),
    },
  } };
  return c;
}

export function memoryLimited(config: object, member: Member): boolean {
  const c = config as Obj;
  const entry = c.agents?.entries?.[member];
  return (entry?.memory ?? c.memory)?.search?.provider === 'none';
}
