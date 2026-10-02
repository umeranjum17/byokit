// WebRTC session signaling over a bridge WebSocket: `{id, method, params}` requests answered by `{id, result}`
// or `{id, error: {code, message}}`, and `{event, params}` notifications. One socket per authorization: the bridge
// ends a session whose socket closed, so a reconnect always starts from a fresh one.

export interface RtcDescription { type: 'offer' | 'answer'; sdp: string }

export interface RtcCandidate { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }

export interface CursorSample { sessionId: string; x: number; y: number; visible: boolean; timestamp_us: number }

/** A bridge notification, unwrapped. `sessionId` names the engine session it belongs to. */
export type SessionEvent =
  | { kind: 'description'; description: RtcDescription; sessionId?: string }
  | { kind: 'candidate'; candidate: RtcCandidate; sessionId?: string }
  | ({ kind: 'cursor' } & CursorSample)
  | { kind: 'state'; capture: string; transport: string; firstFrame: boolean; sessionId?: string }
  | { kind: 'restoreToken'; token: string; sessionId?: string }
  /** `code` `transport` means the path was lost and a new session may recover it; anything else is final. */
  | { kind: 'revoked'; reason: string; code?: string; sessionId?: string };

/** What a session client calls: one request path and one notification stream. */
export interface Signaling {
  /** Rejects with a `SignalingError` whose `code` is the bridge's own token, `transport` or `closed`. */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  subscribe(handler: (event: SessionEvent) => void): () => void;
}

export interface BridgeSignaling extends Signaling {
  /** Closes the socket, rejects pending requests with `closed` and drops every subscriber. */
  close(): void;
}

/**
 * `transport`: the socket could not open or was lost (the bridge refusing the token looks the same to a WebSocket).
 * `closed`: the app closed this signaling. Any other code is the bridge's or engine's own token, passed through.
 */
export type SignalingErrorCode = 'transport' | 'closed' | (string & {});

export class SignalingError extends Error {
  readonly code: SignalingErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: SignalingErrorCode, message: string, o: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'SignalingError';
    this.code = code;
    if (o.detail !== undefined) this.detail = o.detail;
  }
}

// Platform event types differ. Method variance accepts native handlers without a dependency on DOM types.
type SocketListener<E> = { handle(event: E): void }['handle'];

/** The subset of the standard WebSocket this uses; browsers, React Native and Node 22+ all provide it. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: SocketListener<unknown> | null;
  onmessage: SocketListener<{ data: unknown }> | null;
  onerror: SocketListener<unknown> | null;
  onclose: SocketListener<unknown> | null;
  send(data: string): void;
  close(): void;
}

export interface BridgeSignalingOptions {
  /** Defaults to the global `WebSocket`. */
  WebSocket?: new (url: string) => WebSocketLike;
}

const OPEN = 1;

/** The URL with its token hidden, for messages. */
const redact = (url: string) => url.replace(/([?&]token=)[^&#]*/g, '$1…');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Maps a bridge notification onto a SessionEvent; anything malformed or unknown is dropped. */
export function toSessionEvent(event: unknown, params: unknown): SessionEvent | null {
  if (!isObject(params)) return null;
  const sessionId = str(params.sessionId);
  const id = sessionId === undefined ? {} : { sessionId };
  switch (event) {
    case 'session.description': {
      const d = params.description;
      if (!isObject(d) || (d.type !== 'offer' && d.type !== 'answer') || typeof d.sdp !== 'string') return null;
      return { kind: 'description', description: { type: d.type, sdp: d.sdp }, ...id };
    }
    case 'session.candidate': {
      if (typeof params.candidate !== 'string') return null;
      const sdpMid = str(params.sdpMid) ?? null;
      const sdpMLineIndex = typeof params.sdpMLineIndex === 'number' ? params.sdpMLineIndex : null;
      return { kind: 'candidate', candidate: { candidate: params.candidate, sdpMid, sdpMLineIndex }, ...id };
    }
    case 'session.state':
      if (typeof params.capture !== 'string' || typeof params.transport !== 'string' || typeof params.firstFrame !== 'boolean') return null;
      return { kind: 'state', capture: params.capture, transport: params.transport, firstFrame: params.firstFrame, ...id };
    case 'session.cursor': {
      const { x, y, timestamp_us } = params;
      if (sessionId === undefined || typeof x !== 'number' || typeof y !== 'number' || typeof timestamp_us !== 'number') return null;
      return { kind: 'cursor', sessionId, x, y, visible: params.visible === true, timestamp_us };
    }
    case 'session.restoreToken':
      return typeof params.token === 'string' ? { kind: 'restoreToken', token: params.token, ...id } : null;
    case 'session.revoked': {
      const code = str(params.code);
      return { kind: 'revoked', reason: str(params.reason) ?? 'the session was revoked', ...(code === undefined ? {} : { code }), ...id };
    }
    default:
      return null;
  }
}

/**
 * Opens one socket to a bridge (for example `ws://host:port/desktop?token=…`). Requests wait for the socket to open.
 * Use one per authorization: `authorizeBridge` does that for you.
 */
export function bridgeSignaling(url: string, options: BridgeSignalingOptions = {}): BridgeSignaling {
  if (typeof url !== 'string' || url === '') throw new TypeError('bridgeSignaling needs the bridge URL');
  const Socket = options.WebSocket ?? (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (Socket === undefined) throw new TypeError('no global WebSocket; pass options.WebSocket');
  const where = redact(url);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: SignalingError) => void }>();
  const handlers = new Set<(event: SessionEvent) => void>();
  let seq = 0;
  let ended: SignalingError | null = null;
  let opened = false;
  let openWaiters: { resolve: () => void; reject: (error: SignalingError) => void }[] = [];

  let socket: WebSocketLike;
  try { socket = new Socket(url); }
  catch { throw new SignalingError('transport', `cannot reach the bridge at ${where}`); }

  const emit = (event: SessionEvent) => {
    for (const handler of [...handlers]) handler(event);
  };
  const end = (error: SignalingError) => {
    if (ended !== null) return;
    ended = error;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    for (const waiter of openWaiters) waiter.reject(error);
    openWaiters = [];
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    if (socket.readyState <= OPEN) {
      try { socket.close(); } catch { /* Rejections and listener cleanup still apply if transport shutdown fails. */ }
    }
  };
  const lost = () => {
    if (ended !== null) return;
    const wasOpen = opened;
    end(new SignalingError('transport', wasOpen ? `the bridge at ${where} closed` : `cannot reach the bridge at ${where}`));
    // The bridge releases the session of a socket that closed, so tell the session client it is gone and let its
    // reopen policy authorize again on a fresh socket.
    try {
      if (wasOpen) emit({ kind: 'revoked', reason: 'the bridge connection closed', code: 'transport' });
    } finally { handlers.clear(); }
  };

  socket.onopen = () => {
    if (ended !== null) return;
    opened = true;
    for (const waiter of openWaiters) waiter.resolve();
    openWaiters = [];
  };
  socket.onerror = lost;
  socket.onclose = lost;
  socket.onmessage = (message) => {
    if (ended !== null || typeof message.data !== 'string') return;
    let frame: unknown;
    try {
      frame = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!isObject(frame)) return;
    if (frame.id !== undefined) {
      const waiter = typeof frame.id === 'number' ? pending.get(frame.id) : undefined;
      if (waiter === undefined || (!isObject(frame.error) && !Object.hasOwn(frame, 'result'))) return;
      pending.delete(frame.id as number);
      if (isObject(frame.error)) {
        const code = str(frame.error.code) ?? 'engine';
        waiter.reject(new SignalingError(code, str(frame.error.message) ?? 'the bridge refused the request'));
      } else waiter.resolve(frame.result);
      return;
    }
    const event = toSessionEvent(frame.event, frame.params);
    if (event !== null) emit(event);
  };

  const whenOpen = () => {
    if (ended !== null) return Promise.reject(ended);
    if (opened) return Promise.resolve();
    return new Promise<void>((resolve, reject) => openWaiters.push({ resolve, reject }));
  };

  return {
    async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      await whenOpen();
      if (ended !== null) throw ended;
      const id = ++seq;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        try {
          socket.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
        } catch (cause) {
          pending.delete(id);
          reject(new SignalingError('transport', `cannot send to the bridge at ${where}`, { cause }));
        }
      });
    },
    subscribe(handler) {
      if (ended !== null) return () => {};
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    close() {
      if (ended !== null) return;
      end(new SignalingError('closed', 'the signaling was closed'));
      handlers.clear();
    },
  };
}

/**
 * The `authorize` callback a session client takes: every call closes the previous socket and opens a fresh one,
 * including after a disconnect. `close()` ends the current one.
 */
export function authorizeBridge<S>(
  url: string,
  session: S,
  options: BridgeSignalingOptions = {},
): (() => Promise<{ signaling: BridgeSignaling; session: S }>) & { close(): void } {
  let current: BridgeSignaling | null = null;
  const close = () => {
    current?.close();
    current = null;
  };
  return Object.assign(async () => {
    close();
    current = bridgeSignaling(url, options);
    return { signaling: current, session };
  }, { close });
}
