import type { ApiKeyCredential } from '@earendil-works/pi-ai';
import { route, type Billing, type Readiness, type RouteHost } from './catalogue.ts';

/** Explicit selection only. home is the person's selected SDK/ADC home, never inferred from this process. */
export type CloudOptions = {
  via: 'cloud' | 'key' | 'endpoint'; route: string; key?: string;
  profile?: string; home?: string; keyFile?: string; region?: string;
  project?: string; location?: string; baseUrl?: string;
  accountId?: string; gatewayId?: string; billing?: Billing;
};
/** Non-secret account metadata. API/bearer keys are held exclusively in keyStore. */
export type CloudAccount = {
  route: string; provider: string; upstream: string; method: string; billing: Billing;
  profile?: string; home?: string; keyFile?: string; region?: string;
  project?: string; location?: string; baseUrl?: string; accountId?: string; gatewayId?: string;
};
export class CloudAccountError extends Error {
  readonly code: Readiness | 'invalid_selection';
  constructor(code: Readiness | 'invalid_selection') {
    super(code === 'unsupported_platform' ? 'Cloud accounts need a Node host.' : code === 'invalid_selection' ? 'Choose the required cloud account settings.' : 'This cloud route is not ready.');
    this.name = 'CloudAccountError';
    this.code = code;
  }
}
const providers = new Set(['amazon-bedrock', 'google-vertex', 'azure-openai-responses', 'cloudflare-ai-gateway', 'cloudflare-workers-ai']);
const value = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !/[\0\r\n]/.test(v);
const path = (v: unknown): v is string => value(v) && /^(\/|[A-Za-z]:[\\/])/.test(v);

/** Readiness and validation precede stores, file access and engines. No environment or filesystem inspection. */
export function cloudSelection(provider: string, o: CloudOptions, host: RouteHost): CloudAccount {
  const r = route(o.route, host);
  if (host.platform !== 'node') throw new CloudAccountError('unsupported_platform');
  if (r.readiness !== 'ready') throw new CloudAccountError(r.readiness);
  if (r.provider !== provider || r.via !== o.via || !providers.has(r.upstream.id) || r.upstream.method === 'workers-binding') throw new CloudAccountError('invalid_selection');
  const a: CloudAccount = { route: r.id, provider, upstream: r.upstream.id, method: r.upstream.method!, billing: r.billing };
  const copy = (name: keyof Omit<CloudAccount, 'route' | 'provider' | 'upstream' | 'method' | 'billing'>, required = false, absolute = false) => {
    const v = o[name];
    if (v !== undefined || required) {
      if (!(absolute ? path(v) : value(v))) throw new CloudAccountError('invalid_selection');
      a[name] = v;
    }
  };
  if (r.upstream.id === 'amazon-bedrock') {
    copy('region', true);
    if (r.upstream.method === 'aws-profile') { copy('profile', true); copy('home', true, true); }
    else if (r.upstream.method === 'credential-chain') copy('home', true, true);
    else if (r.upstream.method === 'skip-auth') {
      copy('baseUrl', true);
      if (!['api', 'subscription', 'local', 'free', 'unknown'].includes(o.billing ?? '')) throw new CloudAccountError('invalid_selection');
      a.billing = o.billing!;
    } else if (r.upstream.method !== 'bearer-token') throw new CloudAccountError('invalid_selection');
  } else if (r.upstream.id === 'google-vertex' && o.via === 'cloud') {
    copy('project', true); copy('location', true);
    if (r.upstream.method === 'service-account') copy('keyFile', true, true);
    else if (r.upstream.method === 'adc') {
      if (o.keyFile !== undefined) copy('keyFile', true, true);
      else copy('home', true, true);
    } else throw new CloudAccountError('invalid_selection');
  } else if (r.upstream.id === 'azure-openai-responses') copy('baseUrl', true);
  else if (r.upstream.id.startsWith('cloudflare-')) {
    copy('accountId', true);
    if (r.upstream.id === 'cloudflare-ai-gateway') copy('gatewayId', true);
    for (const id of [a.accountId, a.gatewayId]) if (id && !/^[A-Za-z0-9_-]+$/.test(id)) throw new CloudAccountError('invalid_selection');
  }
  if (a.baseUrl) {
    try {
      const u = new URL(a.baseUrl);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
    } catch { throw new CloudAccountError('invalid_selection'); }
  }
  if (o.via === 'key' ? !value(o.key) : o.key !== undefined) throw new CloudAccountError('invalid_selection');
  return a;
}

/** Exact pinned credential shape for host adapters. Never stores or returns the secret. */
export function cloudCredential(a: CloudAccount): ApiKeyCredential & { byokitCloud: CloudAccount } {
  const env: Record<string, string> = {};
  if (a.profile) env.AWS_PROFILE = a.profile;
  if (a.region) env.AWS_REGION = a.region;
  if (a.project) env.GOOGLE_CLOUD_PROJECT = a.project;
  if (a.location) env.GOOGLE_CLOUD_LOCATION = a.location;
  if (a.keyFile) env.GOOGLE_APPLICATION_CREDENTIALS = a.keyFile;
  if (a.baseUrl && a.upstream === 'azure-openai-responses') env.AZURE_OPENAI_BASE_URL = a.baseUrl;
  if (a.accountId) env.CLOUDFLARE_ACCOUNT_ID = a.accountId;
  if (a.gatewayId) env.CLOUDFLARE_GATEWAY_ID = a.gatewayId;
  if (a.method === 'skip-auth') env.AWS_BEDROCK_SKIP_AUTH = '1';
  return { type: 'api_key', env, byokitCloud: a };
}
