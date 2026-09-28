import { createConnection, type Socket } from 'node:net';
import type { HerdrEvent, HerdrTransport } from './types.ts';

export function socketTransport(socketPath: string): HerdrTransport {
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let closed = false;
  let nextId = 0;
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
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
          if (frame.id !== id) return;
          if (frame.error) {
            const error = new Error(`herdr: ${frame.error.code}: ${frame.error.message}`) as Error & { code: string };
            error.code = frame.error.code;
            finish(error);
          } else finish(undefined, frame.result);
        }, () => finish(new Error('herdr: socket closed')));
        const timer = setTimeout(() => finish(new Error('herdr: request timed out')), timeoutMs);
        socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      });
    },
    subscribe(subs, on, onError) {
      let stopped = false;
      let current: Socket | undefined;
      let attempts = 0;
      let acknowledge: ((ok: boolean) => void) | undefined;
      const ready = new Promise<boolean>((resolve) => { acknowledge = resolve; });
      let reconnect: (() => void) | undefined;
      let disconnect: (() => void) | undefined;
      let connectedBefore = false;
      const open = () => {
        if (stopped || closed) return;
        const id = `byokit-${++nextId}`;
        let ack = false;
        let rejected = false;
        current = connect((frame) => {
          if (frame.error && (frame.id === '' || frame.id === id)) {
            rejected = true;
            acknowledge?.(false);
            onError(String(frame.error.code), String(frame.error.message));
            current?.destroy();
          } else if (frame.id === id) {
            const again = connectedBefore;
            connectedBefore = true;
            ack = true;
            attempts = 0;
            acknowledge?.(true);
            if (again) reconnect?.();
          } else {
            const data = frame.data ?? frame;
            const type = frame.event ?? data.type;
            if (ack && typeof type === 'string') on({ ...data, type } as HerdrEvent);
          }
        }, () => {
          if (stopped || closed || rejected) return;
          if (ack) disconnect?.();
          later(open, ack ? (subs.some((s) => s.type === 'pane.agent_status_changed') ? 2000 : 1000)
            : [250, 500, 1000, 2000][Math.min(attempts++, 3)]);
        });
        current.on('connect', () => current?.write(`${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions: subs } })}\n`));
      };
      open();
      const stop = () => { stopped = true; current?.destroy(); };
      return Object.assign(stop, { ready, onReconnect(fn: () => void) { reconnect = fn; },
        onDisconnect(fn: () => void) { disconnect = fn; } });
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}
