import { dirname, join } from 'node:path';
import type { KitOptions } from './kit.ts';
import type { Member } from './types.ts';
import { routes } from './routes.ts';

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
  browser?: { profiles: Record<string, { cdpUrl: string; attachOnly: true }>; tools: string[] };
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
  if (o.browser) {
    // Replace, never merge caller-controlled profiles/targets. The dead default fails closed without our hook.
    c.browser = { enabled: true, defaultProfile: 'byokit-none', evaluateEnabled: false,
      tabCleanup: { enabled: false }, ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      profiles: { 'byokit-none': { cdpUrl: 'http://127.0.0.1:1', attachOnly: true }, ...o.browser.profiles } };
    c.plugins.allow = [...new Set([...c.plugins.allow, 'browser'])];
    c.plugins.entries.browser = { enabled: true };
    c.plugins.entries[o.pluginId].hooks.allowConversationAccess = true;
    c.tools ??= {};
    const browserTools = [...new Set([...(c.tools.alsoAllow ?? []), 'browser', 'request_sign_in', ...o.browser.tools])];
    // The stock schema rejects allow + alsoAllow in one scope; an explicit closed allow must absorb additions.
    if (Array.isArray(c.tools.allow)) {
      c.tools.allow = [...new Set([...c.tools.allow, ...browserTools])];
      delete c.tools.alsoAllow;
    } else c.tools.alsoAllow = browserTools;
  }
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

/** A closed explicit global allow is required, not a group deny or an OS sandbox claim. Every nested
 * agent, delegate and provider policy must stay inside it. The runtime also checks tools.effective. */
export function browserToolPolicySafe(config: unknown, tools: readonly string[]): boolean {
  const safe = new Set(['browser', 'request_sign_in', ...tools]);
  const allowed = (value: unknown) => Array.isArray(value) && value.every(t => typeof t === 'string' && safe.has(t));
  if (!object(config) || !object(config.tools) || !allowed(config.tools.allow) || !config.tools.allow.length) return false;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(visit);
    if (!object(value)) return true;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'tools') {
        if (!object(child)) return false;
        if (child.profile !== undefined || (child.allow !== undefined && !allowed(child.allow))
          || (child.alsoAllow !== undefined && !allowed(child.alsoAllow))) return false;
      }
      if (!visit(child)) return false;
    }
    // byProvider entries are tool policies too, not named `tools`.
    if (object(value.byProvider) && Object.values(value.byProvider).some(p => !object(p) || p.profile !== undefined
      || (p.allow !== undefined && !allowed(p.allow)) || (p.alsoAllow !== undefined && !allowed(p.alsoAllow)))) return false;
    return true;
  };
  return visit(config);
}

// The pinned config.get redacts the entire token-bearing CDP URL. Only an applied, stable host-owned
// config snapshot can substitute its exact endpoint; an arbitrary masked/changed URL never counts as an ack.
export function browserProfileAcknowledged(profile: unknown, owned: unknown, endpoint: string,
  snapshot: { configRevisionHash?: unknown; appliedConfigHash?: unknown }, stableFile: boolean): boolean {
  if (!object(profile) || !object(owned) || profile.attachOnly !== true || owned.attachOnly !== true
    || owned.cdpUrl !== endpoint || !stableFile || typeof snapshot.configRevisionHash !== 'string'
    || !snapshot.configRevisionHash || snapshot.configRevisionHash !== snapshot.appliedConfigHash) return false;
  return profile.cdpUrl === endpoint || profile.cdpUrl === '__OPENCLAW_REDACTED__';
}

export function memoryLimited(config: object, member: Member): boolean {
  const c = config as Obj;
  const entry = c.agents?.entries?.[member];
  return (entry?.memory ?? c.memory)?.search?.provider === 'none';
}
