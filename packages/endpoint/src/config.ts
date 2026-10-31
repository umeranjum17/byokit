import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export type EndpointErrorCode =
  | 'bad-state-dir' | 'state-dir-in-git' | 'state-dir-open' | 'bad-credential' | 'more-than-one-credential'
  | 'subscription-provider' | 'unknown-provider' | 'no-models' | 'host-not-loopback' | 'base-url-refused'
  | 'store-variable' | 'binary-missing' | 'start-failed';
export class EndpointError extends Error {
  readonly code: EndpointErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: EndpointErrorCode, message: string, o: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'EndpointError';
    this.code = code;
    if (o.detail !== undefined) this.detail = o.detail;
  }
}

/** Key routes the endpoint serves, each an OpenAI-compatible upstream: its executor uses the standard HTTP
 *  transport, never the Claude Code or ChatGPT look-alike one. `usage` names the @byokit/usage source it can be read as. */
export const KEY_ROUTES = {
  openai: { baseUrl: 'https://api.openai.com/v1' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1' },
  opencode: { baseUrl: 'https://opencode.ai/zen/go/v1', usage: true },
  zai: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', usage: true },
} as const;
export type EndpointProvider = keyof typeof KEY_ROUTES;
/** Sign-in routes this slice never serves: named, they are refused rather than treated as an unknown id. */
const SUBSCRIPTIONS = ['claude', 'anthropic-plan', 'chatgpt', 'codex', 'openai-codex', 'copilot', 'github-copilot', 'grok', 'kimi', 'meta', 'qwen', 'gemini', 'google-gemini-cli', 'google-antigravity'];
export type EndpointCredential = { provider: EndpointProvider; key: string };
export type EndpointOptions = {
  /** Absolute, outside any git work tree, private to the person (no group or world access). */
  stateDir: string;
  credential: EndpointCredential;
  /** Model ids the upstream serves; the endpoint answers only for these. */
  models: readonly string[];
  /** Absolute path of the pinned `cli-proxy-api`; absent, the first one on PATH. */
  binaryPath?: string;
  /** Loopback only: `127.0.0.1` (default) or `localhost`. */
  host?: string;
  port?: number;
  /** Replaces the provider's address: https, or http on loopback (a local fake). */
  baseUrl?: string;
  /** Extra child environment, e.g. a proxy. Store and Home variables are refused. */
  env?: Readonly<Record<string, string>>;
  log?: (line: string) => void;
};
const STORE_VARIABLE = /^(PGSTORE_|GITSTORE_|OBJECTSTORE_|HOME_JWT$)/i;
const LOOPBACK = ['127.0.0.1', 'localhost'];

/** Every refusal the options can earn before anything is written or spawned; returns the validated parts. */
export function checkOptions(o: EndpointOptions): { provider: EndpointProvider; key: string; host: string; baseUrl: string } {
  const c: unknown = o.credential;
  if (Array.isArray(c)) throw new EndpointError('more-than-one-credential', 'One endpoint serves exactly one credential; start a second endpoint for another key.', { detail: { count: c.length } });
  const { provider, key } = (c ?? {}) as Partial<EndpointCredential>;
  if (typeof provider !== 'string' || typeof key !== 'string' || key.trim() === '') throw new EndpointError('bad-credential', 'credential needs a provider id and a non-empty key.');
  if (SUBSCRIPTIONS.includes(provider)) throw new EndpointError('subscription-provider', `${provider} is a subscription sign-in; this endpoint serves only API-key routes (${Object.keys(KEY_ROUTES).join(', ')}).`, { detail: { provider } });
  if (!Object.hasOwn(KEY_ROUTES, provider)) throw new EndpointError('unknown-provider', `${provider} is not a key route here; use one of ${Object.keys(KEY_ROUTES).join(', ')}.`, { detail: { provider } });
  if (!o.models?.length || o.models.some((m) => typeof m !== 'string' || m === '')) throw new EndpointError('no-models', 'models needs at least one model id.');
  const host = o.host ?? '127.0.0.1';
  if (!LOOPBACK.includes(host)) throw new EndpointError('host-not-loopback', `host ${host} is not loopback; use 127.0.0.1 or localhost.`, { detail: { host } });
  const baseUrl = o.baseUrl ?? KEY_ROUTES[provider as EndpointProvider].baseUrl;
  let url: URL | undefined;
  try { url = new URL(baseUrl); } catch { /* refused below */ }
  if (!url || !(url.protocol === 'https:' || url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) throw new EndpointError('base-url-refused', 'baseUrl must be https, or http on 127.0.0.1 or localhost, so a key never travels in the clear.');
  const bad = Object.keys(o.env ?? {}).filter((name) => STORE_VARIABLE.test(name));
  if (bad.length) throw new EndpointError('store-variable', `env names ${bad.join(', ')}; PGSTORE_*, GITSTORE_*, OBJECTSTORE_* and HOME_JWT would move the key off this device.`, { detail: { names: bad } });
  return { provider: provider as EndpointProvider, key, host: host === 'localhost' ? '127.0.0.1' : host, baseUrl };
}

/** The child's whole config. Line numbers cite config.example.yaml at CLIProxyAPI v8.0.48 (appendix A of the plan). */
export function endpointConfig(o: EndpointOptions, clientKey: string, dir: string): Record<string, unknown> {
  const { provider, key, host, baseUrl } = checkOptions(o);
  return {
    'config-version': 8,
    // :24-27 host defaults to every interface; :67 commercial-mode true writes no error log of request bodies; :76-77 no mDNS.
    server: { host, port: o.port ?? 8317, 'commercial-mode': true, discovery: { enabled: false }, 'trusted-proxies': [] },
    // :97-105 an empty secret turns the Management API off, the panel download stays off, no remote management.
    management: { 'allow-remote': false, 'secret-key': '', 'disable-control-panel': true },
    // :119-124 the per-run client key is the only way in, on top of the loopback bind.
    access: { 'api-keys': [clientKey] },
    oauth: { 'auth-dir': join(dir, 'auths') },
    // :200-222 and :233-235 one credential has nothing to rotate to, so a transient 5xx is retried on it at once, not cooled for a minute.
    routing: { retry: { 'request-retry': 3, 'max-retry-interval': 5 }, cooldown: { 'transient-error-cooldown-seconds': -1 } },
    // :1190-1205 debug, request logs and statistics off; :1213 pprof off.
    observability: { logs: { debug: false, 'logging-to-file': false, 'request-log': false }, usage: { 'usage-statistics-enabled': false }, pprof: { enable: false } },
    // :370 and :469 the Codex and Claude look-alikes stay off even though no such route is configured below.
    upstream: { codex: { 'disable-codex-cloaking': true }, claude: { 'disable-claude-cloak-mode': true, 'disable-cloaking-model-list': true } },
    'api-keys': { 'openai-compatibility': [{ name: provider, 'base-url': baseUrl, keys: [{ 'api-key': key }], models: o.models.map((name) => ({ name, alias: name })) }] },
  };
}

export const newClientKey = (): string => `byokit-${randomBytes(24).toString('base64url')}`;
