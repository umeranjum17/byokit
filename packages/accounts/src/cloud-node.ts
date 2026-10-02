// Node-only: the SDKs consult process.env and HOME even when Pi authContext is empty.
// Each selected cloud request gets its own process; never change the app's environment.
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream, type Api, type ApiStreamOptions, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Model, type TranscriptContext } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { cloudCredential, CloudAccountError, type CloudAccount } from './cloud.ts';

export type CloudStream = <A extends Api>(account: CloudAccount, key: string | undefined, model: Model<A>, context: TranscriptContext, options?: ApiStreamOptions<A>) => AssistantMessageEventStream;

const failed = (model: Model<Api>, aborted: boolean): AssistantMessage => ({
  role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: aborted ? 'aborted' : 'error', errorMessage: aborted ? 'Cloud request cancelled.' : 'Cloud request failed.', timestamp: Date.now(),
});

/** Complete typed Pi stream options, callbacks included. Authentication/endpoint fields are sealed to the selected account. */
export function cloudStream<A extends Api>(account: CloudAccount, key: string | undefined, model: Model<A>, context: TranscriptContext, options: ApiStreamOptions<A> = {} as ApiStreamOptions<A>): AssistantMessageEventStream {
  if (model.provider !== account.upstream) throw new CloudAccountError('invalid_selection');
  const r = builtinProviders().find((p) => p.id === account.upstream);
  if (!r) throw new CloudAccountError('no_upstream_flow');
  const env = cloudCredential(account).env!;
  const selected = { ...options, env, apiKey: key, bearerToken: key, profile: account.profile, region: account.region,
    project: account.project, location: account.location, azureBaseUrl: account.baseUrl,
    ...(account.upstream === 'cloudflare-ai-gateway' ? { apiKey: undefined, headers: { ...options.headers, 'cf-aig-authorization': `Bearer ${key}`, Authorization: null, 'x-api-key': null } } : {}) };
  const chosenModel = { ...model, ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}) };
  // These fetch-only adapters don't consult SDK credential chains. Keep their native fetch/callback API intact.
  if (account.upstream !== 'amazon-bedrock' && account.upstream !== 'google-vertex') return r.stream(chosenModel, context, selected);
  const stream = createAssistantMessageEventStream();
  void (async () => {
    let scratch: string | undefined;
    let child: ReturnType<typeof fork> | undefined;
    let ended = false;
    let terminal: AssistantMessageEvent | undefined;
    const finish = (aborted = false) => {
      if (ended) return;
      ended = true;
      terminal = { type: 'error', reason: aborted ? 'aborted' : 'error', error: failed(model, aborted) };
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
            const value = message.callback === 'payload' ? await options.onPayload?.(message.value, model) : await options.onResponse?.(message.value, model);
            if (!ended && process.connected) process.send({ reply: message.id, value });
          } catch { finish(); }
          return;
        }
        const event = message.event as AssistantMessageEvent | undefined;
        if (!event) { finish(message.aborted === true); return; }
        if (event.type === 'error') { finish(event.reason === 'aborted'); return; }
        if (event.type === 'done') { ended = true; terminal = event; process.kill(); }
        else stream.push(event);
      });
      const { signal: _signal, onPayload, onResponse, fetch: customFetch, ...wire } = selected;
      // Vertex explicitly refuses custom fetch in this pin. Bedrock uses the AWS SDK's native transport.
      if (customFetch && customFetch !== globalThis.fetch) { finish(); return; }
      process.send({ account, model: chosenModel, context, options: wire, payload: !!onPayload, response: !!onResponse });
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
