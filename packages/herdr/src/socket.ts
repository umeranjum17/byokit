import { createConnection, type Socket } from 'node:net';
import type { HerdrEvent, HerdrTransport } from './types.ts';

// The deadline for a subscription's acknowledgement: the same 15 s the request timeout gives a
// call. A server that takes the request and never answers it is given up on like a refusal, so
// the readiness (and the bootstrap barrier behind it) settles instead of waiting forever.
const DEFAULT_ACK_TIMEOUT_MS = 15_000;

export type SocketTransportOptions = {
  /** How long a subscription waits for the server's acknowledgement (default 15 s). */
  ackTimeoutMs?: number;
};

export function socketTransport(socketPath: string, o: SocketTransportOptions = {}): HerdrTransport {
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const unsettled = new Set<(ok: boolean) => void>();   // subscriptions that never became ready
  let closed = false;
  let nextId = 0;
  const ackTimeoutMs = o.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  };
  // An error frame answers the one request its socket carries, so one with no id of its own (`""`,
  // null, absent) is that request's refusal too; matching only `""` left a null id waiting forever.
  // Herdr answers a refused subscription with the request id plus its own suffix — its probe of
  // subscription 0 answers `<id>:sub:0:probe` — so an id derived from the request id answers it
  // as well; only the request's own id was matched, and that refusal left the watch waiting.
  const answers = (frame: any, id: string): boolean => {
    if (frame.id === id || frame.id === '' || frame.id == null) return true;
    return typeof frame.id === 'string' && frame.id.startsWith(`${id}:`);
  };
  const connect = (onLine: (frame: any) => void, onClose: () => void): Socket => {
    const socket = createConnection(socketPath);
    sockets.add(socket);
    let buffer = '';
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      sockets.delete(socket);
      onClose();
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let pos: number;
      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, pos);
        buffer = buffer.slice(pos + 1);
        if (line.trim()) {
          try { onLine(JSON.parse(line)); } catch { /* malformed frame */ }
        }
      }
    });
    socket.on('error', end);
    socket.on('close', end);
    return socket;
  };
  return {
    call(method, params, timeoutMs = 15_000) {
      if (closed) return Promise.reject(new Error('herdr: transport closed'));
      return new Promise((resolve, reject) => {
        const id = `byokit-${++nextId}`;
        let done = false;
        const finish = (error?: Error, result?: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          socket.destroy();
          if (error) reject(error); else resolve(result);
        };
        const socket = connect((frame) => {
          if (frame.error ? !answers(frame, id) : frame.id !== id) return;
          if (frame.error) {
            const error = new Error(`herdr: ${frame.error.code}: ${frame.error.message}`) as Error & { code: string };
            error.code = frame.error.code;
            finish(error);
          } else finish(undefined, frame.result);
        }, () => finish(new Error('herdr: socket closed')));
        const timer = setTimeout(() => {
          const error = new Error('herdr: request timed out') as Error & { code: string };
          error.code = socket.connecting ? 'socket' : 'timeout';
          finish(error);
        }, timeoutMs);
        socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      });
    },
    subscribe(subs, on, onError) {
      let stopped = false;
      let current: Socket | undefined;
      let attempts = 0;
      let acknowledge!: (ok: boolean) => void;
      const ready = new Promise<boolean>((resolve) => { acknowledge = resolve; });
      // Every way out of a subscription settles its readiness: the server's ack, its refusal, the
      // acknowledgement deadline, a stop and a closed transport. A readiness left pending would
      // hold the kit's bootstrap barrier (and the events buffered behind it) forever.
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        unsettled.delete(settle);
        acknowledge(ok);
      };
      unsettled.add(settle);
      let reconnect: (() => void) | undefined;
      let disconnect: (() => void) | undefined;
      let connectedBefore = false;
      let ackTimer: NodeJS.Timeout | undefined;
      const clearAck = () => {
        if (ackTimer === undefined) return;
        clearTimeout(ackTimer);
        timers.delete(ackTimer);
        ackTimer = undefined;
      };
      const open = () => {
        if (stopped || closed) return;
        const id = `byokit-${++nextId}`;
        let ack = false;
        let rejected = false;
        current = connect((frame) => {
          if (frame.error && answers(frame, id)) {
            rejected = true;
            clearAck();
            settle(false);
            onError(String(frame.error.code), String(frame.error.message));
            current?.destroy();
          } else if (frame.id === id) {
            const again = connectedBefore;
            connectedBefore = true;
            ack = true;
            attempts = 0;
            clearAck();
            settle(true);
            if (again) reconnect?.();
          } else {
            const data = frame.data ?? frame;
            const type = frame.event ?? data.type;
            if (ack && typeof type === 'string') on({ ...data, type } as HerdrEvent);
          }
        }, () => {
          clearAck();
          if (stopped || closed || rejected) return;
          if (ack) disconnect?.();
          later(open, ack ? (subs.some((s) => s.type === 'pane.agent_status_changed') ? 2000 : 1000)
            : [250, 500, 1000, 2000][Math.min(attempts++, 3)]);
        });
        current.on('connect', () => current?.write(`${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions: subs } })}\n`));
        // The acknowledgement deadline: a server that takes the request and never answers it is
        // given up on like a refusal (reported once, never retried), so the readiness settles.
        ackTimer = setTimeout(() => {
          clearAck();
          if (ack || rejected || stopped || closed) return;
          rejected = true;
          settle(false);
          onError('subscription_timeout', `the server did not acknowledge the subscription within ${ackTimeoutMs} ms`);
          current?.destroy();
        }, ackTimeoutMs);
        timers.add(ackTimer);
      };
      open();
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearAck();
        // A stopped subscription never becomes ready: its readiness settles here.
        settle(false);
        current?.destroy();
      };
      return Object.assign(stop, { ready, onReconnect(fn: () => void) { reconnect = fn; },
        onDisconnect(fn: () => void) { disconnect = fn; } });
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      // A closed transport answers nothing: every subscription that never became ready settles now.
      for (const pending of [...unsettled]) pending(false);
      unsettled.clear();
    },
  };
}
