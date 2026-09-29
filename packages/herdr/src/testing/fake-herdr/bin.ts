// The HERDR_BIN shim (docs/runtime-kits.md 6.8): a Node script the kit execs for `--version`,
// `api schema`, the `server` verb, JSON CLI verbs and `terminal session`. World state lives on the
// control socket; this process never speaks JSON-RPC except to forward a CLI verb. Ported from muxr
// `perf/fake-herdr/bin.mjs` with the perf byte rates and graphics probes removed.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HERDR_PROTOCOL, HERDR_VERSION } from '../../constants.ts';

const SELF = fileURLToPath(import.meta.url);

export function writeBinShim({ dir, socketPath }: { dir: string; socketPath: string }): string {
  mkdirSync(dir, { recursive: true });
  const binPath = `${dir}/herdr`;
  // The kit execs the shim; the shim re-imports this module, so the fake's behavior always matches
  // the source the tests type-check. Extensionless → CommonJS, where dynamic `import()` works.
  // The shebang pins the running Node binary: the kit passes the env verbatim, so the child's PATH
  // may not contain node — /usr/bin/env node would exit 127 there.
  writeFileSync(
    binPath,
    `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(SELF).href)}).then((m) => m.main(process.argv.slice(2)), (e) => { console.error(e); process.exit(1); });\n`,
    { encoding: 'utf8', mode: 0o700 },
  );
  chmodSync(binPath, 0o700);
  return binPath;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function rpc(socketPath: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const id = `fake_bin_${process.pid}_${Math.random().toString(16).slice(2)}`;
    let buffer = '';
    const finish = (error: Error | null, result?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error !== null) reject(error);
      else resolve(result ?? {});
    };
    const timer = setTimeout(() => finish(new Error('fake-herdr bin: socket timeout')), 5000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        let message: { id?: unknown; error?: { code?: string; message?: string }; result?: Record<string, unknown> };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== id) continue;
        if (message.error !== undefined && message.error !== null) {
          finish(new Error(`herdr: ${message.error.code ?? 'error'}: ${message.error.message ?? ''}`));
        } else {
          finish(null, message.result ?? {});
        }
        return;
      }
    });
    socket.on('error', (error: Error) => finish(error));
  });
}

async function runServer(): Promise<void> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    process.stderr.write('fake-herdr bin: server needs HERDR_SOCKET_PATH\n');
    process.exit(1);
  }
  const { startFakeHerdr } = await import('./server.ts');
  // One startup line: a harness reads the socket it must expect, and the recorded env lets a test
  // compare the exact environment the kit spawned us with (docs/runtime-kits.md 6.3).
  const handle = await startFakeHerdr({ dir: dirname(socketPath), socketPath, onStop: () => process.exit(0) });
  process.stdout.write(`${JSON.stringify({ socketPath: handle.socketPath, pid: process.pid, env: process.env })}\n`);
  const stop = () => { void handle.stop(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// Terminal frames carry the real Herdr shape — `{ type: 'terminal.frame', pane_id, full, bytes }`
// with `bytes` the UTF-8 length of `full` — plus the fake's `data` alias (same string as `full`),
// so older assertions reading `data` keep passing. A `{"type":"terminal.resize",cols,rows}` line
// resizes the session and answers one empty frame stamped with the new size; `terminal.release`
// exits; `{"type":"fake.stream","count":n,"size":b,"progress":file}` streams n frames with full
// `<i>:` plus b bytes as fast as the pipe takes them, recording the frames-written count in
// `progress` after each write so a test can see how far a paused reader let the stream run, then
// one `{"type":"fake.stream.done","count":n}` line on the same ordered byte stream: when a test sees
// the marker, every stream frame is already past every frame handler, so the delivery verdict is
// causal instead of a wall-clock wait (a stall then means a genuinely wedged child, not a slow one).
function frame(paneId: string, full: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: 'terminal.frame', pane_id: paneId, data: full, full, bytes: Buffer.byteLength(full), ...extra })}\n`;
}

async function stream(paneId: string, o: { count?: number; size?: number; progress?: string }): Promise<void> {
  const count = o.count ?? 0;
  const pad = 'x'.repeat(o.size ?? 1024);
  for (let i = 0; i < count; i += 1) {
    const ok = process.stdout.write(frame(paneId, `${i}:${pad}`));
    if (o.progress) writeFileSync(o.progress, String(i + 1));
    if (!ok) await new Promise((resolve) => process.stdout.once('drain', resolve));
  }
  process.stdout.write(`${JSON.stringify({ type: 'fake.stream.done', pane_id: paneId, count })}\n`);
}

function runTerminal(args: string[]): void {
  // `herdr terminal session <control|observe> <pane> [--takeover] --cols <n> --rows <n>`.
  // The fake needs no server for this: one ready frame, then every send line echoes back as an
  // output frame (docs/runtime-kits.md 6.8), except `fake.stream` and `terminal.resize` above.
  const mode = args[0] === 'observe' ? 'observe' : 'control';
  const rest = args[0] === 'control' || args[0] === 'observe' ? args.slice(1) : args;
  const paneId = rest[0] ?? 'w1:p1';
  let cols = Number(flag(args, '--cols')) || 80;
  let rows = Number(flag(args, '--rows')) || 24;
  const takeover = args.includes('--takeover');
  process.stdout.write(`${JSON.stringify({ type: 'terminal.ready', pane_id: paneId, mode, takeover, cols, rows })}\n`);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      let data: string = line;
      let extra: Record<string, unknown> = {};
      try {
        const message = JSON.parse(line) as { type?: string; data?: unknown; cols?: unknown; rows?: unknown;
          count?: number; size?: number; progress?: string };
        if (message.type === 'terminal.release') process.exit(0);
        if (message.type === 'fake.stream') { void stream(paneId, message); continue; }
        if (message.type === 'terminal.resize') {
          if (typeof message.cols === 'number' && message.cols > 0) cols = Math.floor(message.cols);
          if (typeof message.rows === 'number' && message.rows > 0) rows = Math.floor(message.rows);
          process.stdout.write(frame(paneId, '', { cols, rows }));
          continue;
        }
        // `terminal.input` carries the keys in `data`; anything else with a string `data` echoes it.
        if (typeof message.data === 'string') data = message.data;
      } catch { /* a raw line echoes as-is */ }
      process.stdout.write(frame(paneId, data, { cols, rows }));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}

async function runCliVerb(argv: string[]): Promise<void> {
  const positional: string[] = [];
  const params: Record<string, unknown> = {};
  let socketPath = process.env.HERDR_SOCKET_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--socket') { socketPath = argv[index + 1]; index += 1; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('--')) {
        index += 1;
        try { params[key] = JSON.parse(value); } catch { params[key] = value; }
      } else {
        params[key] = true;
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length < 2 || !socketPath) {
    process.stderr.write(`fake-herdr bin: unhandled ${argv.join(' ')}\n`);
    process.stdout.write('{}\n');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await rpc(socketPath, `${positional[0]}.${positional[1]}`, params);
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, sub] = argv;
  if (cmd === '--version' || cmd === 'version') {
    process.stdout.write(`herdr ${HERDR_VERSION}\n`);
    return;
  }
  if (cmd === 'api' && sub === 'schema') {
    // Prints the pinned v0.9.1 snapshot itself (schema/herdr-api-0.9.1.json, docs/runtime-kits.md
    // 6.7) — the same bytes `scripts/gen-types.ts` generates the typed surface from — exactly as
    // the real `herdr api schema` prints its bundled schema. Only when the snapshot file is
    // unreachable (a packed install without it) does the shim fall back to the pinned identity.
    try {
      const snapshot = readFileSync(join(dirname(SELF), '../../../schema/herdr-api-0.9.1.json'), 'utf8');
      const parsed = JSON.parse(snapshot) as { protocol?: unknown };
      if (parsed.protocol !== HERDR_PROTOCOL) throw new Error('fake-herdr bin: schema snapshot drift');
      process.stdout.write(snapshot.endsWith('\n') ? snapshot : `${snapshot}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({ protocol: HERDR_PROTOCOL, version: HERDR_VERSION })}\n`);
    }
    return;
  }
  if (cmd === 'server') {
    await runServer();
    return;
  }
  if (cmd === 'terminal' && sub === 'session') {
    runTerminal(argv.slice(2));   // args start at the mode token
    return;
  }
  if (cmd !== undefined) {
    await runCliVerb(argv);
    return;
  }
  process.stderr.write('fake-herdr bin: nothing to do\n');
  process.exitCode = 1;
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === SELF;
if (invoked) await main(process.argv.slice(2));
