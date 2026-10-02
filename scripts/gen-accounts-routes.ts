// Generated from the installed pin, not the person's environment or credentials.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { Billing, Route, RouteVia } from '../packages/accounts/src/catalogue.ts';

const dist = new URL('.', import.meta.resolve('@earendil-works/pi-ai'));
const source = (path: string) => readFileSync(new URL(path, dist), 'utf8');
const manifest = JSON.parse(source('../package.json')) as { version: string };
const pin = JSON.parse(readFileSync(new URL('../packages/accounts/package.json', import.meta.url), 'utf8')).dependencies['@earendil-works/pi-ai'];
if (manifest.version !== pin) throw new Error(`Install the accounts pin ${pin} before generating routes`);
const revision = `@earendil-works/pi-ai@${pin}`;
// The env map is private upstream data. Fail closed if its published shape changes.
const envBlock = source('env-api-keys.js').match(/const envMap = \{([\s\S]*?)\n    \};/)?.[1];
if (!envBlock) throw new Error('Pinned provider env map not found');
const envMap = Object.fromEntries([...envBlock.matchAll(/(?:"([^"]+)"|([\w-]+)):\s*"([^"]+)"/g)].map((m) => [m[1] ?? m[2], m[3]]));
const aliases: Record<string, string> = {
  'amazon-bedrock': 'aws-bedrock', 'azure-openai-responses': 'azure', google: 'google-ai-studio',
  'openai-codex': 'openai', 'kimi-coding': 'kimi-code', moonshotai: 'moonshot', 'moonshotai-cn': 'moonshot',
  'minimax-cn': 'minimax', 'cloudflare-ai-gateway': 'cloudflare', 'cloudflare-workers-ai': 'cloudflare',
  'qwen-token-plan': 'alibaba', 'qwen-token-plan-cn': 'alibaba', 'qwen-token-plan-individual': 'alibaba',
  'xiaomi-token-plan-ams': 'xiaomi', 'xiaomi-token-plan-cn': 'xiaomi', 'xiaomi-token-plan-sgp': 'xiaomi',
  'zai-coding-cn': 'zai', 'opencode-go': 'opencode',
};
const companies: Record<string, string> = {
  'aws-bedrock': 'Amazon Web Services', azure: 'Microsoft', 'google-ai-studio': 'Google', 'google-vertex': 'Google',
  anthropic: 'Anthropic', openai: 'OpenAI', 'kimi-code': 'Moonshot AI', moonshot: 'Moonshot AI',
  alibaba: 'Alibaba', cloudflare: 'Cloudflare', 'github-copilot': 'GitHub', 'vercel-ai-gateway': 'Vercel',
  'ant-ling': 'Ant Group', together: 'Together AI', xai: 'xAI', zai: 'Z.AI',
};
// Source methods are not public metadata in this pin. Read their modules and
// assert each overlay's method evidence so an upstream change cannot silently disappear.
const oauthMethods: Record<string, RouteVia[]> = {
  anthropic: ['paste', 'browser'], 'openai-codex': ['browser', 'paste', 'code'],
  'github-copilot': ['code'], 'kimi-coding': ['code'], meta: ['code'], xai: ['code'],
  openrouter: ['browser', 'paste'], radius: ['browser', 'code'],
};
const planKeys = new Set(['kimi-coding', 'opencode-go', 'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn']);
const all = { node: 'yes', browser: 'yes', rn: 'yes' } as const;
const node = { node: 'yes', browser: 'no', rn: 'no' } as const;
// These source methods need a host adapter until the dependent account-flow units land.
// A host reports hostSide only when it actually supplies that route's driver.
const host = { node: 'host', browser: 'host', rn: 'host' } as const;
const nodeHost = { node: 'host', browser: 'no', rn: 'no' } as const;

export function generateRoutes(): Route[] {
  const result: Route[] = [];
  const add = (upstreamId: string, name: string, via: RouteVia, billing: Billing, method: string, variant?: string, extra: Partial<Route> = {}) => {
    const provider = aliases[upstreamId] ?? upstreamId;
    const company = companies[provider] ?? name;
    result.push({
      id: `${provider}:${via}${variant ? `:${variant}` : ''}`, provider, name, company,
      label: billing === 'subscription' ? `Uses your ${name} plan` : billing === 'api' ? `API key (billed per use by ${company})` : billing === 'local' ? 'Runs on this computer' : `Billing set by ${company}`,
      aliases: upstreamId === provider ? [] : [upstreamId], via, billing, billingFrom: 'source',
      offer: billing === 'subscription' ? 'default' : 'explicit', platforms: via === 'key' || via === 'plan_key' ? all : host,
      upstream: { surface: 'accounts', id: upstreamId, method, revision, flow: 'present' }, ...extra,
    });
  };
  for (const p of builtinProviders()) {
    const variant = aliases[p.id] && aliases[p.id] !== p.id && !['openai-codex', 'amazon-bedrock', 'google', 'kimi-coding', 'moonshotai', 'azure-openai-responses'].includes(p.id) ? p.id : undefined;
    if (p.auth.apiKey) {
      if (p.id === 'amazon-bedrock') {
        add(p.id, p.name, 'key', 'api', 'bearer-token', undefined, { platforms: node });
        for (const method of ['aws-profile', 'credential-chain']) add(p.id, p.name, 'cloud', 'api', method, method, { platforms: node, label: 'Cloud account (billed per use by Amazon Web Services)' });
        add(p.id, p.name, 'endpoint', 'unknown', 'skip-auth', 'skip-auth', { billingFrom: 'host', platforms: node, label: 'Your own server (billing you choose)' });
      } else {
        if (!envMap[p.id] && p.id !== 'github-copilot' && p.id !== 'anthropic') throw new Error(`Missing key metadata for ${p.id}`);
        const billing = planKeys.has(p.id) ? 'subscription' : p.id === 'radius' ? 'unknown' : 'api';
        add(p.id, p.name, planKeys.has(p.id) ? 'plan_key' : 'key', billing, envMap[p.id] ?? (p.id === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'COPILOT_GITHUB_TOKEN'), variant, {
          ...(p.id === 'github-copilot' ? { billing: 'subscription', offer: 'default', label: `Paste your Copilot token (uses your ${p.name} plan)` } : {}),
          ...(['anthropic', 'openai', 'openrouter'].includes(p.id) ? { platforms: all } : {}),
          ...(['google-vertex', 'azure-openai-responses', 'cloudflare-ai-gateway', 'cloudflare-workers-ai'].includes(p.id) ? { platforms: node } : {}),
        });
      }
    }
    if (p.auth.oauth) {
      const methods = oauthMethods[p.id];
      if (!methods) throw new Error(`Missing OAuth methods for ${p.id}`);
      const text = source(`auth/oauth/${p.id}.js`);
      for (const via of methods) {
        if (via === 'paste' && !text.includes('manual_code')) throw new Error(`Missing paste flow for ${p.id}`);
        if (via === 'code' && !/device[_-]code|device_code/.test(text)) throw new Error(`Missing device flow for ${p.id}`);
        if (via === 'browser' && !/createServer|startCallbackServer/.test(text)) throw new Error(`Missing browser flow for ${p.id}`);
        const billing = p.auth.oauth.isSubscription ? 'subscription' : p.id === 'openrouter' ? 'api' : 'unknown';
        const portable = p.id === 'openai-codex' && via === 'code' || p.id === 'anthropic' && via === 'paste';
        add(p.id, p.id === 'openai-codex' ? 'ChatGPT' : p.id === 'anthropic' ? 'Claude' : p.name, via, billing,
          via === 'code' ? 'device' : via === 'browser' ? 'loopback' : 'paste', undefined,
          { platforms: portable ? { node: 'yes', browser: 'host', rn: 'yes' } : node,
            ...(p.id === 'openai-codex' && via === 'code' ? { platforms: all } : {}) });
      }
    }
    if (p.id === 'anthropic') {
      add(p.id, 'Claude', 'setup_token', 'subscription', 'ANTHROPIC_OAUTH_TOKEN');
      add(p.id, p.name, 'key', 'unknown', 'ANTHROPIC_AUTH_TOKEN', 'bearer', { label: 'Paste your Anthropic bearer token (billing set by Anthropic)' });
      add(p.id, 'Claude', 'plan_key', 'subscription', 'ANTHROPIC_OAUTH_TOKEN', 'oauth-token', { label: 'Paste your Claude token (uses your Claude plan)' });
    }
    if (p.id === 'google-vertex') for (const method of ['adc', 'service-account']) add(p.id, p.name, 'cloud', 'api', method, method, { platforms: node, label: 'Cloud account (billed per use by Google)' });
    if (p.id === 'cloudflare-ai-gateway') add(p.id, p.name, 'cloud', 'api', 'workers-binding', 'workers-binding', { platforms: { node: 'host', browser: 'no', rn: 'no' }, label: 'Cloud account (billed per use by Cloudflare)' });
  }
  add('custom', 'Your own server', 'endpoint', 'unknown', 'createProvider', undefined, { billingFrom: 'host', label: 'Your own server (billing you choose)' });
  add('custom', 'Local model', 'local', 'local', 'createProvider');
  add('qwen', 'Qwen', 'browser', 'subscription', 'oauth', undefined, { company: 'Alibaba', platforms: node, upstream: { surface: 'accounts', id: 'qwen-portal', method: 'oauth', revision, flow: 'absent' } });
  // No plan login exists at this pin; a key is not proof of a plan.
  add('minimax', 'MiniMax', 'plan_key', 'subscription', 'plan-key', undefined, { upstream: { surface: 'accounts', id: 'minimax', method: 'plan-key', revision, flow: 'absent' } });
  if (new Set(result.map((r) => r.id)).size !== result.length) throw new Error('Duplicate route id');
  return result.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('../packages/accounts/src/routes.json', import.meta.url), JSON.stringify(generateRoutes(), null, 2) + '\n');
}
