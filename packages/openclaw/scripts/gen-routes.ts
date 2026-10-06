// Offline pin generator. Run: node scripts/gen-routes.ts <extracted npm package> <pin source checkout>.
// The tarball omits external manifests (including llama-cpp, absent from the provider catalog).
// Read every source extensions/* manifest too, never execute a plugin or install one.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Route } from '../src/types.ts';

export const PIN = '2026.8.1';
export const REVISION = 'ea806575e6450e4d1efdfc72c19f04be982a1b9b';
export type Choice = {
  provider: string; method: string; choiceId: string; choiceLabel: string;
  choiceHint?: string; groupLabel?: string; appGuidedAuth?: string;
  assistantVisibility?: string; onboardingScopes?: string[]; deprecatedChoiceIds?: string[];
};
export type Manifest = {
  id: string; providers?: string[]; providerAuthChoices?: Choice[];
  contracts?: { [key: string]: string[] };
};
export type CatalogEntry = { openclaw: {
  plugin: { id: string; label: string };
  providers: { id: string; name: string; authChoices?: Omit<Choice, 'provider'>[] }[];
  install: { npmSpec?: string; clawhubSpec?: string; minHostVersion?: string };
} };
export type PinSnapshot = { revision: string; manifests: Manifest[]; bundled: string[]; catalog: CatalogEntry[] };

// Billing corrections audited in F0, not guessed from an endpoint or the word 'key'.
const PLANS = new Set(['opencode-go', 'kimi-code-api-key', 'qwen-api-key', 'qwen-api-key-cn',
  'qwen-token-plan', 'qwen-token-plan-cn', 'stepfun-plan-api-key-cn', 'stepfun-plan-api-key-intl',
  'tokenplan-api-key', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp',
  'zai-coding-global', 'zai-coding-cn']);
const SUBSCRIPTIONS = new Set(['openai', 'openai-device-code', 'xai-oauth', 'xai-device-code',
  'github-copilot', 'github-copilot-enterprise', 'minimax-global-oauth', 'minimax-cn-oauth',
  'anthropic-cli', 'setup-token']);
const LOCAL = new Set(['ollama', 'lmstudio', 'sglang', 'vllm', 'llama-cpp']);
const ENDPOINT = new Set(['custom-api-key', 'copilot-proxy', 'llama-cpp-existing-server']);
const CHOICELESS = new Map<string, 'cloud' | 'cli'>([
  ['google-vertex', 'cloud'], ['google-gemini-cli', 'cli'], ['amazon-bedrock', 'cloud'],
  ['amazon-bedrock-mantle', 'cloud'], ['anthropic-vertex', 'cloud'],
] as const);

export function generateRoutes(snapshot: PinSnapshot): Route[] {
  if (snapshot.revision !== REVISION) throw new Error('Route snapshot is not the pinned revision');
  const external = new Map(snapshot.catalog.map(entry => [entry.openclaw.plugin.id, entry.openclaw]));
  const bundled = new Set(snapshot.bundled);
  const rows: Route[] = [];
  function row(manifest: Manifest, choice: Choice): Route {
    const id = choice.choiceId;
    // A Claude Code login is reported as `claude-cli` (auth-status, `providers()`, runs); the manifest's
    // `anthropic` stays in the route id and `upstream.id`. `anthropic` itself is the API-billed provider.
    const provider = id === 'anthropic-cli' ? 'claude-cli' : choice.provider;
    const plan = PLANS.has(id);
    const endpoint = ENDPOINT.has(id);
    const billing: Route['billing'] = endpoint ? 'unknown' : LOCAL.has(id) ? 'local'
      : plan || SUBSCRIPTIONS.has(id) ? 'subscription' : 'api';
    const via: Route['via'] = plan ? 'plan_key' : endpoint ? 'endpoint' : LOCAL.has(id) ? 'local'
      : choice.method === 'cli' ? 'cli' : choice.method === 'setup-token' ? 'setup_token'
      : choice.method === 'entra-id' ? 'cloud' : choice.appGuidedAuth === 'device-code' ? 'code'
      : choice.method.includes('oauth') || choice.appGuidedAuth === 'oauth' ? 'browser' : 'key';
    const alias = choice.assistantVisibility === 'manual-only';
    const needs: NonNullable<Route['needs']> = {};
    if (manifest.id && !bundled.has(manifest.id)) needs.plugin = manifest.id;
    if (via === 'cli') needs.binary = 'claude';
    if (id === 'chutes') needs.client = 'CHUTES_CLIENT_ID';
    const keyEntry = via === 'key' || via === 'plan_key' || id === 'custom-api-key' || id === 'llama-cpp-existing-server';
    const scopes = choice.onboardingScopes;
    const services = !!scopes?.length && !scopes.includes('text-inference');
    // The pin's Gateway setup refuses an interactive sign-in whose choice has no app-guided flow
    // ("That provider setup is not available on this Gateway."): list it, never offer it.
    const unguided = !keyEntry && ['browser', 'code', 'setup_token'].includes(via) && !choice.appGuidedAuth;
    const absent = alias || unguided;
    const offerPolicy = billing === 'subscription' && !absent ? 'default' : 'explicit';
    return {
      choice: id, provider, plugin: manifest.id, billing, via,
      ...(id === 'anthropic-cli' ? { auth: 'cli' as const } : id === 'apiKey' ? { auth: 'api_key' as const }
        : id === 'setup-token' ? { auth: 'token' as const } : {}),
      prerequisite: via === 'cli' ? 'Claude Code in the isolated HOME' : null,
      offer: offerPolicy === 'default' && Object.keys(needs).length === 0, offerPolicy,
      ...(id === 'anthropic-cli' ? { legacy: { provider: 'claude-cli', via: 'browser' as const },
        deprecatedProvider: 'anthropic' } // remove in 0.8.0 and build the id from `provider`
        : id === 'minimax-global-oauth' || id === 'minimax-cn-oauth'
          ? { legacy: { provider: 'minimax', via: 'code' as const } } : {}),
      reason: alias ? 'Compatibility alias the Gateway does not offer; use xai-oauth.'
        : unguided ? 'The pinned Gateway has no app-guided sign-in for this choice.'
        : billing === 'api' ? `${choice.groupLabel ?? choice.provider}: ${via === 'cloud' ? 'Cloud credentials' : keyEntry ? 'API key' : 'OAuth'} (billed per use).`
        : billing === 'subscription' ? `${choice.choiceLabel}: subscription sign-in.`
        : billing === 'local' ? 'Local runtime; explicitly select this route.'
        : 'Billing must be supplied by the host; a server address does not determine billing.',
      source: `${manifest.id ? `extensions/${manifest.id}/openclaw.plugin.json` : 'src/commands/auth-choice-options.static.ts'} (${PIN})`,
      revision: PIN, checked: '2026-10-02', label: choice.choiceLabel,
      keyEntry, keyErrors: keyEntry ? { invalid: 'key.invalid', not_included: 'key.notIncluded' } : null,
      id: `${choice.provider}:${via}:${id}`, name: choice.groupLabel ?? choice.provider,
      company: choice.groupLabel ?? choice.provider,
      ...(choice.deprecatedChoiceIds?.length ? { aliases: choice.deprecatedChoiceIds } : {}),
      billingFrom: endpoint ? 'host' : 'source', group: services ? 'services' : 'models',
      platforms: { node: 'yes', browser: 'host', rn: 'host' },
      ...(Object.keys(needs).length ? { needs } : {}),
      ...(external.has(manifest.id) && !bundled.has(manifest.id) ? { install: external.get(manifest.id)!.install } : {}),
      upstream: { surface: 'openclaw', id: choice.provider, method: choice.method, revision: REVISION,
        flow: absent ? 'absent' : 'present' },
    };
  }
  for (const manifest of snapshot.manifests) {
    for (const choice of manifest.providerAuthChoices ?? []) rows.push(row(manifest, choice));
    for (const provider of manifest.providers ?? []) {
      const via = CHOICELESS.get(provider);
      if (!via) continue;
      const entry = row(manifest, { provider, method: via, choiceId: '', choiceLabel: provider });
      rows.push({ ...entry, id: `${provider}:${via}`, via, keyEntry: false, keyErrors: null,
        billing: via === 'cli' ? 'unknown' : 'api', offer: false, offerPolicy: 'explicit',
        prerequisite: via === 'cli' ? 'Gemini CLI in the isolated HOME' : 'Host-configured cloud credentials',
        reason: via === 'cli' ? 'Native CLI runtime; billing is unverified. No wizard sign-in choice.'
          : 'Cloud credentials (billed per use); configured by the host, not a wizard sign-in choice.',
        ...(via === 'cli' ? { needs: { ...entry.needs, binary: 'gemini' } } : {}),
        upstream: { ...entry.upstream!, flow: 'absent' },
      });
    }
  }
  // The catalog is authoritative for external dependencies and cross-checks all its choice ids.
  for (const { openclaw } of snapshot.catalog) {
    for (const provider of openclaw.providers) for (const choice of provider.authChoices ?? []) {
      if (!rows.some(route => route.choice === choice.choiceId && route.provider === provider.id && route.plugin === openclaw.plugin.id)) {
        throw new Error(`Catalog choice missing from pin manifests: ${choice.choiceId}`);
      }
    }
  }
  rows.push(row({ id: '' }, { provider: 'custom', method: 'custom', choiceId: 'custom-api-key', choiceLabel: 'Custom endpoint' }));
  if (rows.filter(route => route.choice).length !== 91 || rows.length !== 96 || new Set(rows.map(route => route.id)).size !== rows.length) {
    throw new Error('Pin route inventory changed; reconcile source before generating');
  }
  return rows; // Sorted manifest directories, choice order preserved (legacy routeFor preference).
}

export function readSnapshot(packageRoot: string, sourceRoot: string): PinSnapshot {
  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
  if (version !== PIN) throw new Error(`Expected engine ${PIN}, got ${version}`);
  function manifests(root: string): Manifest[] {
    return readdirSync(root).sort().flatMap(dir => {
      try { return [JSON.parse(readFileSync(join(root, dir, 'openclaw.plugin.json'), 'utf8')) as Manifest]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    });
  }
  const source = manifests(join(sourceRoot, 'extensions'));
  const tarball = manifests(join(packageRoot, 'dist/extensions'));
  if (source.length !== 151) throw new Error('Expected all 151 real pin manifests');
  const all = new Map(source.map(manifest => [manifest.id, manifest]));
  for (const manifest of tarball) {
    const original = all.get(manifest.id);
    if (!original || JSON.stringify(original.providerAuthChoices) !== JSON.stringify(manifest.providerAuthChoices)) {
      throw new Error(`Tarball/source manifest mismatch: ${manifest.id}`);
    }
  }
  return { revision: REVISION, manifests: source, bundled: tarball.map(manifest => manifest.id),
    catalog: JSON.parse(readFileSync(join(packageRoot, 'scripts/lib/official-external-provider-catalog.json'), 'utf8')).entries };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [packageRoot, sourceRoot] = process.argv.slice(2);
  if (!packageRoot || !sourceRoot) throw new Error('Expected extracted pin package and source checkout');
  writeFileSync(new URL('../src/routes.json', import.meta.url), JSON.stringify(generateRoutes(readSnapshot(packageRoot, sourceRoot)), null, 2) + '\n');
}
