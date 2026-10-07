// Shared by the link tests: a host on a real port and devices on Node's built-in (browser-shaped) WebSocket.
import { after } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  DeviceLink, Host, PublicLinkError, keyPair, pairWithCode as pairCode, pairWithOffer as pairOffer,
  type DeviceGrant, type Grant, type HostOptions, type LinkOptions, type LinkStatus, type PairRequest,
} from '../src/index.ts';

type Pairing = Omit<Parameters<typeof pairOffer>[1], 'onWords'> & { onWords?: (w: string) => void };
export const pairWithOffer = (text: string, o: Pairing) => pairOffer(text, { ...o, onWords: o.onWords ?? (() => {}) });
export const pairWithCode = (url: string, code: string, o: Pairing) => pairCode(url, code, { ...o, onWords: o.onWords ?? (() => {}) });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const v = await fn(); if (v) return v; }
  throw new Error('timed out');
}

export const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

/** A host on a real port. `asked` records every pairing request; `sockets` are the host's side of each connection. */
export async function startHost(o: Partial<HostOptions> & { peers?: boolean } = {}) {
  const asked: PairRequest[] = [];
  let saved: Grant[] = [];
  const ran: string[] = [];
  const errors: unknown[] = [];
  const host = await Host.open({
    keys: keyPair(), name: 'Kitchen computer',
    grants: { load: () => saved, save: (g) => { saved = g; } },
    confirm: (p) => { asked.push(p); return true; },
    canView: (r) => r.op.startsWith('get.'),
    onError: (e) => { errors.push(e); },
    handle: async (r, dev) => { ran.push(`${dev.name}:${r.op}`); if (r.op === 'slow') await sleep(300); if (r.op === 'fail') throw new PublicLinkError('nope'); if (r.op === 'secret-fail') throw new Error('secret-token'); return { op: r.op, args: r.args, by: dev.id }; },
    ...o,
  });
  const sockets: WsSocket[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });
  wss.on('connection', (ws, req) => { sockets.push(ws); host.accept(ws, o.peers ? { peer: req.socket.remoteAddress } : {}); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
  const stop = () => { host.close(); for (const s of sockets) s.terminate(); wss.close(); server.close(); };
  closers.push(stop);
  return { host, url, asked, ran, errors, sockets, stop, saved: () => saved };
}

/** A device's live link, with its statuses and events recorded and an in-memory store. */
export function connect(grant: DeviceGrant, extra: LinkOptions = {}) {
  const seen: LinkStatus[] = [], events: unknown[] = [];
  const store = { g: grant as DeviceGrant | null, save(g: DeviceGrant) { this.g = g; }, clear() { this.g = null; } };
  const link = new DeviceLink(grant, { store, onStatus: (s) => seen.push(s), onEvent: (e) => events.push(e), ...extra });
  closers.push(() => link.stop());
  return { link, seen, events, store };
}

