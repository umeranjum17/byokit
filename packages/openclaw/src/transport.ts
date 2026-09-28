import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GatewayClient } from '@openclaw/gateway-client';
import { OPERATOR_SCOPES, PROTOCOL_VERSION } from './constants.ts';
import type { GatewayTransport, Hello } from './types.ts';

/**
 * Client caps for the operator connection. `approvals` makes this connection an approval client, so the
 * engine delivers exec/plugin.approval.requested to it (B7); without it the broadcast set is empty.
 */
export const GATEWAY_CAPS = ['tool-events', 'approvals'] as const;

export function gatewayTransport(ctx: { port: number; token: string; identityPath: string; bridgeSock: string }): GatewayTransport {
  const pem = JSON.parse(readFileSync(ctx.identityPath, 'utf8')) as { privateKey: string; publicKey: string };
  const publicKey = createPublicKey(pem.publicKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const events = new Set<(e: { event: string; payload?: unknown }) => void>();
  const closes = new Set<(why: string) => void>();
  let ready: Hello | undefined;
  let pending: { resolve(h: Hello): void; reject(error: Error): void } | undefined;
  let stopped = false;
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${ctx.port}`, token: ctx.token, role: 'operator', scopes: [...OPERATOR_SCOPES],
    clientName: 'cli', caps: [...GATEWAY_CAPS], minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
    deviceIdentity: { deviceId: createHash('sha256').update(publicKey).digest('hex'), privateKeyPem: pem.privateKey, publicKeyPem: pem.publicKey },
    hostDeps: {
      signDevicePayload: (key, payload) => sign(null, Buffer.from(payload), createPrivateKey(key)).toString('base64url'),
      publicKeyRawBase64UrlFromPem: (key) => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
      loadDeviceAuthToken: () => null, storeDeviceAuthToken: () => {}, clearDeviceAuthToken: () => {},
    },
    onHelloOk: (h) => {
      ready = { protocol: h.protocol, server: { version: h.server.version }, methods: h.features.methods, events: h.features.events };
      pending?.resolve(ready); pending = undefined;
    },
    onEvent: (e) => { for (const fn of events) fn({ event: e.event, payload: e.payload }); },
    onConnectError: (e) => { pending?.reject(e); pending = undefined; },
    onClose: (code, reason) => {
      ready = undefined;
      pending?.reject(new Error(`gateway closed: ${code} ${reason}`)); pending = undefined;
      if (!stopped) for (const fn of closes) fn(reason || String(code));
    },
  });
  return {
    start: () => {
      if (ready) return Promise.resolve(ready);
      if (pending) return Promise.reject(new Error('gateway handshake already pending'));
      return new Promise<Hello>((resolve, reject) => { pending = { resolve, reject }; stopped = false; client.start(); });
    },
    request: (method, params, o) => client.request(method, params, o),
    onEvent: (fn) => { events.add(fn); return () => { events.delete(fn); }; },
    onClose: (fn) => { closes.add(fn); return () => { closes.delete(fn); }; },
    stop: async () => { stopped = true; pending?.reject(new Error('gateway stopped')); pending = undefined; ready = undefined; await client.stopAndWait(); },
  };
}
