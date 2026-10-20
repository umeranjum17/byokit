// @byokit/accounts on a computer (Node, Electron's main process): Pi's own sign-in flows, and a listener for ChatGPT's
// page coming back to this computer, so its tab shows the app's words. Phones and browsers get portable.ts instead
// (package.json's "react-native" and "browser" conditions).
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { subscribe } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { Accounts as Portable, type AccountsOptions, type AuthHost, type Loopback, type Member, type Platform } from './accounts.ts';
import { emptyAuthContext } from './isolate.ts';
import { withNamedModels } from './named-model.ts';
import { endpointDriver } from './node-endpoints.ts';
import { cloudStream } from './cloud-node.ts';

/** Listen on 127.0.0.1 only; no keep-alive, so a browser never lands on a listener from an earlier try. */
export const loopback: Loopback = (port, handle) => new Promise((resolve, reject) => {
  const server = createServer(async (req, res) => {
    const { status, html } = await handle(req.url ?? '/');
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
    res.end(html);
  });
  server.once('error', reject).listen(port, '127.0.0.1', () => resolve({ close: () => { server.close(); server.closeIdleConnections(); } }));
});

/** The status a provider last refused with while one `getAuth` ran, read off Node's fetch as Pi's own refresh sends it:
 *  Pi's error keeps the status only in its words. A request sent outside a `getAuth` is never watched.
 *  A host that swaps the global fetch for one not built on Node's undici loses the status: typed network, kept. */
const tokenPaths: Record<string, string> = {
  xai: '/oauth2/token',
  'github-copilot': '/copilot_internal/v2/token',
  'kimi-coding': '/api/oauth/token',
  meta: '/muse-code/key',
};
const refreshing = new AsyncLocalStorage<{ provider: string; status?: number }>();
const watched = new WeakMap<object, { status?: number }>();
subscribe('undici:request:create', ({ request }: any) => {
  const w = refreshing.getStore();
  if (w && request.path.split('?')[0] === tokenPaths[w.provider]) watched.set(request, w);
});
subscribe('undici:request:headers', ({ request, response }: any) => { const w = watched.get(request); if (w) w.status = response.statusCode; });

/** Pi's engine, its failed refresh carrying the provider's refusal as `httpStatus`, as the kit's own store carries it. */
function engine(credentials: CredentialStore) {
  const models = withNamedModels(builtinModels({ credentials, authContext: emptyAuthContext }));
  const getAuth = models.getAuth.bind(models) as (id: string, opts?: object) => ReturnType<typeof models.getAuth>;
  return Object.assign(models, { getAuth: (id: string, opts?: object) => {
    const w: { provider: string; status?: number } = { provider: id };
    return refreshing.run(w, () => getAuth(id, opts)).catch((e) => { throw w.status && w.status >= 400 && e instanceof Error ? Object.assign(e, { httpStatus: w.status }) : e; });
  } }) as unknown as AuthHost;
}

/** A computer: every provider Pi signs in to, and the loopback listener. */
export const computer: Platform = {
  kind: 'node',
  keys: () => import('./node-keys.ts').then((m) => m.runtime),
  engine,
  signsIn: () => true,
  loopback,
  endpoint: endpointDriver,
  cloudStream,
};

export class Accounts<R extends AuthHost = AuthHost, M extends Member = Member> extends Portable<R, M> {
  constructor(opts: AccountsOptions<M> = {}, platform: Platform = computer) { super(opts, platform); }
  /** A key route's key may come from `keyFile`, the path of a file holding only the key (read once, trimmed, never
   *  echoed). A cloud account's own `keyFile` (service account) is untouched. */
  override async add(member: M, key: string, options: Parameters<Portable<R, M>['add']>[2] | { keyFile: string; via?: 'key' | 'plan_key' } = {}) {
    const { keyFile, ...rest } = options as { keyFile?: string; key?: string };
    if (typeof keyFile !== 'string' || 'route' in options) return super.add(member, key, options);
    if (rest.key !== undefined) throw new Error('Pass either key or keyFile, not both.');
    let text: string;
    try { text = (await readFile(keyFile, 'utf8')).trim(); } catch { throw new Error(`Couldn’t read the key file ${keyFile}.`); }
    if (!text) throw new Error(`The key file ${keyFile} is empty.`);
    return super.add(member, key, { ...rest, key: text });
  }
}

export * from './portable.ts';
export { INHERITED, emptyAuthContext, isolate, launchEnv, type LaunchEnv, type LaunchEnvOptions } from './isolate.ts';
export { fileStore, machineStore, type SafeStorageLike } from './node-stores.ts';
