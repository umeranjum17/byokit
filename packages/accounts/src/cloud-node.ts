// Node-only: the SDKs consult process.env and HOME even when Pi authContext is empty.
// Each selected cloud request gets its own process; never change the app's environment.
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream, normalizeContext, type Api, type ApiStreamOptions, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Model, type Context } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { cloudCredential, cloudSelection, CloudAccountError, type CloudAccount } from './cloud.ts';
import { route } from './catalogue.ts';
import { createAiBindingFetch, CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL, type AiBinding } from '@earendil-works/pi-ai/api/cloudflare-ai-binding';

const failed = (model: Model<Api>, aborted: boolean): AssistantMessage => ({
  role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: aborted ? 'aborted' : 'error', errorMessage: aborted ? 'Cloud request cancelled.' : 'Cloud request failed.', timestamp: Date.now(),
});

/** Complete typed Pi stream options, callbacks included. Authentication/endpoint fields are sealed to the selected account. */
export function cloudStream<A extends Api>(account: CloudAccount, key: string | undefined, model: Model<A>, context: Context, options: ApiStreamOptions<A> = {} as ApiStreamOptions<A>, binding?: AiBinding): AssistantMessageEventStream {
  const r = route(account.route, { platform: 'node', hostSide: !!binding });
  if (r.readiness !== 'ready') throw new CloudAccountError(r.readiness);
  if (r.provider !== account.provider || r.upstream.id !== account.upstream || r.upstream.method !== account.method) throw new CloudAccountError('invalid_selection');
  if (model.provider !== account.upstream) throw new CloudAccountError('invalid_selection');
  if (account.method === 'skip-auth' && [key, account.profile, account.home, account.keyFile, options.apiKey, (options as any).bearerToken, (options as any).profile, options.env?.AWS_PROFILE, options.env?.AWS_BEARER_TOKEN_BEDROCK, options.env?.AWS_ACCESS_KEY_ID, options.env?.AWS_SECRET_ACCESS_KEY].some((v) => v !== undefined)) throw new CloudAccountError('invalid_selection');
  if (account.method === 'skip-auth') cloudSelection(account.provider, { via: 'endpoint', route: account.route, baseUrl: account.baseUrl, region: account.region, billing: account.billing }, { platform: 'node' });
  const provider = builtinProviders().find((p) => p.id === account.upstream);
  if (!provider) throw new CloudAccountError('no_upstream_flow');
  let bindingFetch: typeof fetch | undefined;
  if (account.method === 'workers-binding') {
    try { if (!binding) throw new Error(); bindingFetch = createAiBindingFetch(binding); }
    catch { throw new CloudAccountError('needs_host'); }
  }
  const normalized = normalizeContext(context);
  const env = { ...cloudCredential(account).env!, PI_CACHE_RETENTION: 'short', AZURE_OPENAI_DEPLOYMENT_NAME_MAP: '{}',
    AZURE_OPENAI_API_VERSION: 'v1', AZURE_OPENAI_RESOURCE_NAME: 'unused' };
  const redact = <T>(value: T): T => key ? JSON.parse(JSON.stringify(value, (_name, v) => typeof v === 'string' ? v.split(key).join('[redacted]') : v)) : value;
  const headers = <T extends string | null>(h: Record<string, T> | undefined): Record<string, T> => Object.fromEntries(Object.entries(h ?? {}).filter(([name]) => !(account.method === 'skip-auth' ? /^(authorization|proxy-authorization|host)$|^x-amz-/i : /^(authorization|proxy-authorization|api-key|x-api-key|x-goog-api-key|cf-aig-authorization|host)$/i).test(name)));
  const selected = { ...options, env, apiKey: key, bearerToken: key, profile: account.profile, region: account.region,
    project: account.project, location: account.location, azureBaseUrl: account.baseUrl, headers: headers(options.headers),
    ...(account.upstream === 'cloudflare-ai-gateway' ? { headers: { ...headers(options.headers), 'cf-aig-authorization': `Bearer ${bindingFetch ? CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL : key}`, Authorization: null, 'x-api-key': null } } : {}),
    ...(bindingFetch ? { apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL, fetch: bindingFetch } : {}) };
  if (account.method === 'skip-auth') { delete selected.apiKey; delete selected.bearerToken; delete selected.profile; }
  const chosenModel = { ...model, headers: headers(model.headers), ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}) };
  const stream = createAssistantMessageEventStream();
  // Fetch-only adapters have no SDK credential chain; retain native fetch and async callbacks.
  if (account.upstream !== 'amazon-bedrock' && account.upstream !== 'google-vertex') {
    void (async () => {
      try {
        const raw = provider.stream(chosenModel, normalized, { ...selected,
          onPayload: options.onPayload && ((payload: unknown, m: Model<A>) => options.onPayload!(redact(payload), m)),
          onResponse: options.onResponse && ((response, m) => options.onResponse!(redact(response), m)),
        });
        for await (const event of raw) stream.push(event.type === 'error' ? { type: 'error', reason: event.reason, error: redact(failed(model, event.reason === 'aborted')) } : redact(event));
      } catch { stream.push({ type: 'error', reason: options.signal?.aborted ? 'aborted' : 'error', error: redact(failed(model, !!options.signal?.aborted)) }); }
    })();
    return stream;
  }
  void (async () => {
    let scratch: string | undefined;
    let child: ReturnType<typeof fork> | undefined;
    let ended = false;
    let terminal: AssistantMessageEvent | undefined;
    const finish = (aborted = false) => {
      if (ended) return;
      ended = true;
      terminal = { type: 'error', reason: aborted ? 'aborted' : 'error', error: redact(failed(model, aborted)) };
      child?.kill();
    };
    const abort = () => finish(true);
    try {
      if (options.signal?.aborted) { finish(true); return; }
      scratch = await mkdtemp(join(tmpdir(), 'byokit-cloud-'));
      if (options.signal?.aborted) { finish(true); return; }
      const home = account.home ?? scratch;
      // Do not inherit NODE_OPTIONS, proxies, cloud env keys, default HOME or CLI configuration.
      const childEnv = { HOME: home, USERPROFILE: home, APPDATA: join(home, '.config'), ...env };
      const url = new URL(`./cloud-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);
      child = fork(fileURLToPath(url), [], { env: childEnv, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
      const process = child;
      options.signal?.addEventListener('abort', abort, { once: true });
      process.on('error', () => finish());
      process.on('message', async (message: any) => {
        if (ended) return;
        if (message.callback) {
          try {
            const value = message.callback === 'payload' ? await options.onPayload?.(redact(message.value), model) : await options.onResponse?.(redact(message.value), model);
            if (!ended && process.connected) process.send({ reply: message.id, value });
          } catch { finish(); }
          return;
        }
        const event = message.event as AssistantMessageEvent | undefined;
        if (!event) { finish(message.aborted === true); return; }
        if (event.type === 'error') { finish(event.reason === 'aborted'); return; }
        if (event.type === 'done') { ended = true; terminal = redact(event); process.kill(); }
        else stream.push(redact(event));
      });
      const { signal: _signal, onPayload, onResponse, fetch: customFetch, ...wire } = selected;
      // Vertex explicitly refuses custom fetch in this pin. Bedrock uses the AWS SDK's native transport.
      if (customFetch && customFetch !== globalThis.fetch) { finish(); return; }
      process.send({ account, model: chosenModel, context: normalized, options: wire, payload: !!onPayload, response: !!onResponse });
      await new Promise<void>((resolve) => process.once('close', () => { if (!ended) finish(); resolve(); }));
    } catch { finish(); }
    finally {
      options.signal?.removeEventListener('abort', abort);
      child?.kill();
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
      if (terminal) stream.push(terminal);
    }
  })();
  return stream;
}
