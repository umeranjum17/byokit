// A relay on a real port, link hosts behind it, and devices in front, all in this process. No network beyond loopback;
// push services are a fake `fetch`.
import { after } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeviceLink, Host, keyPair, pairWithOffer, type DeviceGrant, type Grant, type KeyPair, type LinkStatus } from '@byokit/link';
import { Relay, RelayClient, type RelayClientOptions, type RelayOptions, type RelayState, type RelayStatus } from '../src/index.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const v = await fn(); if (v) return v; }
  throw new Error('timed out');
}

const closers: (() => void)[] = [];
after(() => closers.splice(0).reverse().forEach((c) => c()));
export const onEnd = (fn: () => void) => closers.push(fn);

/** A relay on a loopback port. `saved` is the last state it stored. */
export async function startRelay(o: RelayOptions = {}, port = 0) {
  let saved: RelayState | undefined;
  const relay = await Relay.open({ store: { load: () => saved, save: (s) => { saved = s; } }, ...o });
  const server: Server = createServer();
  relay.attach(server);
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const at = (server.address() as AddressInfo).port;
  const stop = () => { relay.close(); server.closeAllConnections(); server.close(); };
  onEnd(stop);
  return { relay, server, stop, http: `http://127.0.0.1:${at}`, ws: `ws://127.0.0.1:${at}`, saved: () => saved };
}

/** A link host that answers every request with what it was asked. */
export async function startHost(keys: KeyPair = keyPair(), grants = grantStore()) {
  const host = await Host.open({
    keys, name: 'Kitchen computer', grants,
    confirm: () => true, handle: (r, dev) => ({ op: r.op, args: r.args, by: dev.id }),
  });
  onEnd(() => host.close());
  return host;
}

export const grantStore = () => ({ g: [] as Grant[], load() { return this.g; }, save(g: Grant[]) { this.g = g; } });

/** A host's relay client that records what it sees on the wire and every status. */
export function hostClient(host: Host, url: string, o: Partial<RelayClientOptions> = {}) {
  const wire: string[] = [];
  const seen: (RelayStatus | string)[] = [];
  class Tapped extends WebSocket {
    constructor(u: string) {
      super(u);
      this.addEventListener('message', (e) => wire.push(String(e.data)));
    }
    send(d: any) { wire.push(String(d)); super.send(d); }
  }
  const client = new RelayClient(host, { url: `${url}/relay/v1/host`, WebSocket: Tapped as any, onStatus: (s) => seen.push(s), ...o });
  onEnd(() => client.stop());
  return { client, wire, seen };
}

export function device(grant: DeviceGrant) {
  const seen: LinkStatus[] = [];
  const link = new DeviceLink(grant, { onStatus: (s) => seen.push(s) });
  onEnd(() => link.stop());
  return { link, seen };
}

/** A host registered on a relay with a paired device. */
export async function paired(r: Awaited<ReturnType<typeof startRelay>>, name = 'Away phone', o: Partial<RelayClientOptions> = {}) {
  const grants = grantStore();
  const host = await startHost(keyPair(), grants);
  await r.relay.admit(host.keys.publicKey, 'Kitchen computer');
  const h = hostClient(host, r.ws, o);
  await until(() => h.client.status === 'online');
  const grant = await pairWithOffer(host.offer({ role: 'control', urls: [`${r.ws}/link/v1/${host.id}`] }).text, { name, onWords: () => {} });
  return { host, grants, ...h, grant, dev: device(grant) };
}

/** A raw socket's close, as [code, reason]. */
export function closed(ws: WebSocket): Promise<[number, string]> {
  return new Promise((r) => ws.addEventListener('close', (e) => r([e.code, e.reason])));
}
