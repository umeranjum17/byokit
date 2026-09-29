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

/**
 * Read the device key pair from `device.json`. The kit writes `{ privateKey, publicKey }` (PEM strings);
 * existing Crewhouse state carries `{ deviceId, publicKeyPem, privateKeyPem }` instead. Both shapes are
 * accepted and the file is only ever read, never rewritten, so an existing device identity keeps its keys.
 */
export function loadDeviceKeys(identityPath: string): { privateKeyPem: string; publicKeyPem: string } {
  const raw = JSON.parse(readFileSync(identityPath, 'utf8')) as Record<string, unknown>;
  const privateKeyPem = typeof raw.privateKey === 'string' ? raw.privateKey
    : typeof raw.privateKeyPem === 'string' ? raw.privateKeyPem
    : undefined;
  const publicKeyPem = typeof raw.publicKey === 'string' ? raw.publicKey
    : typeof raw.publicKeyPem === 'string' ? raw.publicKeyPem
    : undefined;
  if (privateKeyPem === undefined || publicKeyPem === undefined) {
    throw new Error(`The device identity file at ${identityPath} is not usable: it holds no device key pair.`);
  }
  return { privateKeyPem, publicKeyPem };
}

export function gatewayTransport(ctx: { port: number; token: string; identityPath: string; bridgeSock: string }): GatewayTransport {
  const pem = loadDeviceKeys(ctx.identityPath);
  const publicKey = createPublicKey(pem.publicKeyPem).export({ format: 'der', type: 'spki' }).subarray(-32);
  const events = new Set<(e: { event: string; payload?: unknown }) => void>();
  const closes = new Set<(why: string) => void>();
  let ready: Hello | undefined;
  let pending: { resolve(h: Hello): void; reject(error: Error): void } | undefined;
  let stopped = false;
  // The last transient connect failure, kept for the terminal error. The client retries boot-time
  // ECONNREFUSED itself with backoff (O11: the first kit.start() lands while the gateway still binds),
  // so connect errors never settle the handshake; only a paused reconnect (terminal: auth, protocol)
  // or the kit's own deadline does.
  let lastConnectError: Error | undefined;
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${ctx.port}`, token: ctx.token, role: 'operator', scopes: [...OPERATOR_SCOPES],
    clientName: 'cli', caps: [...GATEWAY_CAPS], minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
    deviceIdentity: { deviceId: createHash('sha256').update(publicKey).digest('hex'), privateKeyPem: pem.privateKeyPem, publicKeyPem: pem.publicKeyPem },
    hostDeps: {
      signDevicePayload: (key, payload) => sign(null, Buffer.from(payload), createPrivateKey(key)).toString('base64url'),
      publicKeyRawBase64UrlFromPem: (key) => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
      loadDeviceAuthToken: () => null, storeDeviceAuthToken: () => {}, clearDeviceAuthToken: () => {},
    },
    onHelloOk: (h) => {
      if (stopped) return;
      ready = { protocol: h.protocol, server: { version: h.server.version }, methods: h.features.methods, events: h.features.events };
      pending?.resolve(ready); pending = undefined;
    },
    onEvent: (e) => { for (const fn of events) fn({ event: e.event, payload: e.payload }); },
    onConnectError: (e) => { lastConnectError = e; },
    onReconnectPaused: (info) => {
      const terminal = new Error(`gateway connect paused: ${info.code} ${info.reason ?? ''}${lastConnectError ? ` (last: ${lastConnectError.message})` : ''}`);
      pending?.reject(terminal); pending = undefined;
    },
    onClose: (code, reason) => {
      ready = undefined;
      // A pre-hello close while the client still retries is transient (backoff continues inside the
      // client); only a stopped transport settles the handshake here. Terminal give-ups arrive paused.
      if (pending && stopped) { pending.reject(new Error(`gateway closed: ${code} ${reason}`)); pending = undefined; }
      else if (!pending && !stopped) for (const fn of closes) fn(reason || String(code));
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
