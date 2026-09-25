// @byokit/accounts on a computer (Node, Electron's main process): Pi's own sign-in flows, and a listener for ChatGPT's
// page coming back to this computer, so its tab shows the app's words. Phones and browsers get portable.ts instead
// (package.json's "react-native" and "browser" conditions).
import { createServer } from 'node:http';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { Accounts as Portable, type AccountsOptions, type AuthHost, type Loopback, type Member, type Platform } from './accounts.ts';
import { emptyAuthContext } from './isolate.ts';

/** Listen on 127.0.0.1 only; no keep-alive, so a browser never lands on a listener from an earlier try. */
export const loopback: Loopback = (port, handle) => new Promise((resolve, reject) => {
  const server = createServer(async (req, res) => {
    const { status, html } = await handle(req.url ?? '/');
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
    res.end(html);
  });
  server.once('error', reject).listen(port, '127.0.0.1', () => resolve({ close: () => { server.close(); server.closeIdleConnections(); } }));
});

/** A computer: every provider Pi signs in to, and the loopback listener. */
export const computer: Platform = {
  engine: (credentials: CredentialStore) => builtinModels({ credentials, authContext: emptyAuthContext }) as unknown as AuthHost,
  signsIn: () => true,
  loopback,
};

export class Accounts<R extends AuthHost = AuthHost, M extends Member = Member> extends Portable<R, M> {
  constructor(opts: AccountsOptions<M> = {}, platform: Platform = computer) { super(opts, platform); }
}

export * from './portable.ts';
export { INHERITED, emptyAuthContext, isolate } from './isolate.ts';
export { fileStore, type SafeStorageLike } from './node-stores.ts';
