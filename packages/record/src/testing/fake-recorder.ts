// The fake recorder (docs/capability-kits.md 5.5): a Node shim bin speaking recorder protocol v1, scripted through
// <dir>/script.json and logging every run to <dir>/invocations.jsonl. Lands in BK-C1.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecorderHello } from '../types.ts';

export type RecorderErrorWire = { code: string; message: string; hint?: string; [k: string]: unknown };
export type FakeRecorderScript = {
  /** Merged over the default hello. */
  hello?: Partial<RecorderHello>;
  /** screen only, default 'yes'; 'timeout' answers at once, no 120 s wait. */
  consent?: 'yes' | 'no' | 'timeout';
  /** Take length before `done` unless stopped, default 1, capped by --max-seconds. */
  seconds?: number;
  /** make answers this envelope. */
  makeError?: RecorderErrorWire;
  /** Default 1000. */
  plannedTokens?: number;
  /** Print `not json` instead of the answer. */
  corrupt?: 'hello' | 'record' | 'make';
  /** Write 9 MB to that stream, then hang. */
  flood?: 'stdout' | 'stderr';
  /** Never answer. */
  hang?: 'hello' | 'stop' | 'make';
};
export type FakeInvocation = { argv: string[]; env: Record<string, string>; key?: string; captions?: unknown };
export type FakeRecorder = {
  /** Absolute path of the shim (0700). */
  bin: string;
  /** Replaces the script for later runs. */
  script(s: FakeRecorderScript): void;
  /** Every run so far, in order. */
  invocations(): FakeInvocation[];
};

// The shim is self-contained CommonJS: it reads <dir>/script.json on every run (dir from its own path),
// appends one JSON line per run to <dir>/invocations.jsonl, then speaks recorder protocol v1. No backticks
// and no template placeholders inside, so it embeds safely.
const SHIM_BODY = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const shimDir = path.dirname(process.argv[1]);",
  "const scriptPath = path.join(shimDir, 'script.json');",
  "const invocationsPath = path.join(shimDir, 'invocations.jsonl');",
  "function readScript() {",
  "  try { return JSON.parse(fs.readFileSync(scriptPath, 'utf8')); } catch { return {}; }",
  "}",
  "function flag(args, name) {",
  "  const i = args.indexOf(name);",
  "  return i >= 0 ? args[i + 1] : undefined;",
  "}",
  "function hasFlag(args, name) { return args.indexOf(name) >= 0; }",
  "function setFlags(args, name) {",
  "  const out = [];",
  "  for (let i = 0; i < args.length; i += 1) { if (args[i] === name) { out.push(args[i + 1]); i += 1; } }",
  "  return out;",
  "}",
  "function outLine(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }",
  "function fail(code, message, hint, extra, exit) {",
  "  const e = { code, message };",
  "  if (hint !== undefined) e.hint = hint;",
  "  if (extra !== undefined) for (const k of Object.keys(extra)) e[k] = extra[k];",
  "  process.stdout.write(JSON.stringify({ error: e }) + '\\n');",
  "  process.exit(exit === undefined ? 1 : exit);",
  "}",
  "function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }",
  "function sleepForever() { setInterval(function () {}, 1000000); }",
  "function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }",
  "async function main() {",
  "  const argv = process.argv.slice(2);",
  "  const script = readScript();",
  "  let key = undefined;",
  "  const keyFd = flag(argv, '--planner-key-fd');",
  "  if (keyFd !== undefined) {",
  "    try { key = fs.readFileSync(Number(keyFd), 'utf8').replace(/\\r?\\n$/, ''); } catch { key = undefined; }",
  "  }",
  "  let captions = undefined;",
  "  const captionsFile = flag(argv, '--captions');",
  "  if (captionsFile !== undefined) {",
  "    try { captions = JSON.parse(fs.readFileSync(captionsFile, 'utf8')); } catch { captions = undefined; }",
  "  }",
  "  const entry = { argv, env: Object.assign({}, process.env) };",
  "  if (key !== undefined) entry.key = key;",
  "  if (captions !== undefined) entry.captions = captions;",
  "  try { fs.appendFileSync(invocationsPath, JSON.stringify(entry) + '\\n'); } catch {}",
  "  if (argv[0] !== 'capture') fail('invalid-arguments', 'expected capture <verb>', undefined, undefined, 2);",
  "  const verb = argv[1];",
  "  if (verb === 'hello') {",
  "    if (script.hang === 'hello') { sleepForever(); return; }",
  "    if (script.corrupt === 'hello') { process.stdout.write('not json\\n'); return; }",
  "    const hello = {",
  "      protocol: 1,",
  "      recorder: { name: 'fake-recorder', version: '0.0.0' },",
  "      sources: ['screen', 'x11'],",
  "      android: false,",
  "      events: ['own', 'none'],",
  "      planner: { available: true, needsKey: true },",
  "    };",
  "    const over = script.hello || {};",
  "    for (const k of Object.keys(over)) hello[k] = over[k];",
  "    if (over.sources !== undefined && over.android === undefined) hello.android = hello.sources.indexOf('android') >= 0;",
  "    outLine(hello);",
  "    return;",
  "  }",
  "  if (verb === 'record') {",
  "    const source = flag(argv, '--source');",
  "    const root = flag(argv, '--root');",
  "    const stateDir = flag(argv, '--state-dir');",
  "    const events = flag(argv, '--events');",
  "    const maxSecondsRaw = flag(argv, '--max-seconds');",
  "    if (!source || !root || !stateDir || !events || !maxSecondsRaw) fail('invalid-arguments', 'record needs every flag', undefined, undefined, 2);",
  "    const maxSeconds = Number(maxSecondsRaw);",
  "    const hello = { sources: ['screen', 'x11'], events: ['own', 'none'] };",
  "    const over = script.hello || {};",
  "    if (over.sources !== undefined) hello.sources = over.sources;",
  "    if (over.events !== undefined) hello.events = over.events;",
  "    const kind = source.indexOf(':') >= 0 ? source.slice(0, source.indexOf(':')) : source;",
  "    if (hello.sources.indexOf(kind) < 0) fail('unsupported-source', 'source not offered: ' + kind);",
  "    if (hello.events.indexOf(events) < 0) fail('invalid-arguments', 'events mode not offered: ' + events, undefined, undefined, 2);",
  "    try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}",
  "    const lock = path.join(stateDir, 'recording.pid');",
  "    try {",
  "      const old = Number(fs.readFileSync(lock, 'utf8'));",
  "      if (old && pidAlive(old)) fail('already-recording', 'a recording already runs for this state dir');",
  "      try { fs.unlinkSync(lock); } catch {}",
  "    } catch {}",
  "    if (script.corrupt === 'record') { process.stdout.write('not json\\n'); return; }",
  "    try { fs.writeFileSync(lock, String(process.pid)); } catch {}",
  "    let recordingPrinted = false;",
  "    let settled = false;",
  "    const cleanupLock = function () { try { fs.unlinkSync(lock); } catch {} };",
  "    const onSignal = function () {",
  "      if (settled) return;",
  "      if (!recordingPrinted) {",
  "        settled = true;",
  "        cleanupLock();",
  "        fail('capture-stopped', 'stopped before anything was recorded');",
  "      }",
  "    };",
  "    process.on('SIGTERM', onSignal);",
  "    process.on('SIGINT', onSignal);",
  "    if (kind === 'screen') {",
  "      outLine({ event: 'consent-pending' });",
  "      const consent = script.consent || 'yes';",
  "      if (consent === 'no') { cleanupLock(); fail('consent-cancelled', 'the person said no'); }",
  "      if (consent === 'timeout') { cleanupLock(); fail('consent-timeout', 'no answer in time'); }",
  "    }",
  "    try { fs.mkdirSync(root, { recursive: true }); } catch {}",
  "    let n = 1;",
  "    try {",
  "      for (const e of fs.readdirSync(root)) {",
  "        const m = /^take-(\\d+)$/.exec(e);",
  "        if (m) n = Math.max(n, Number(m[1]) + 1);",
  "      }",
  "    } catch {}",
  "    const take = path.join(root, 'take-' + n);",
  "    const wanted = typeof script.seconds === 'number' ? script.seconds : 1;",
  "    const secs = Math.min(Math.max(0, wanted), maxSeconds);",
  "    try { fs.mkdirSync(take, { recursive: true }); } catch {}",
  "    try { fs.writeFileSync(path.join(take, 'take.json'), JSON.stringify({ fake: true, source, events, seconds: secs })); } catch {}",
  "    recordingPrinted = true;",
  "    outLine({ event: 'recording', take });",
  "    const done = function () {",
  "      if (settled) return;",
  "      settled = true;",
  "      cleanupLock();",
  "      outLine({ event: 'done', take, seconds: secs, warnings: [] });",
  "      process.exit(0);",
  "    };",
  "    process.on('SIGTERM', function () { done(); });",
  "    process.on('SIGINT', function () { done(); });",
  "    await sleep(Math.max(0, secs) * 1000);",
  "    done();",
  "    return;",
  "  }",
  "  if (verb === 'stop') {",
  "    const stateDir = flag(argv, '--state-dir');",
  "    if (!stateDir) fail('invalid-arguments', 'stop needs --state-dir', undefined, undefined, 2);",
  "    if (script.hang === 'stop') { sleepForever(); return; }",
  "    const lock = path.join(stateDir, 'recording.pid');",
  "    let pid = 0;",
  "    try { pid = Number(fs.readFileSync(lock, 'utf8')); } catch { pid = 0; }",
  "    if (!pid || !pidAlive(pid)) fail('not-recording', 'nothing is recording');",
  "    try { process.kill(pid, 'SIGTERM'); } catch {}",
  "    outLine({ stopping: true });",
  "    return;",
  "  }",
  "  if (verb === 'make') {",
  "    const take = argv[2];",
  "    if (!take) fail('invalid-arguments', 'make needs a take', undefined, undefined, 2);",
  "    if (script.hang === 'make') { sleepForever(); return; }",
  "    if (script.flood === 'stdout') { process.stdout.write('x'.repeat(9 * 1024 * 1024)); sleepForever(); return; }",
  "    if (script.flood === 'stderr') { process.stderr.write('x'.repeat(9 * 1024 * 1024)); sleepForever(); return; }",
  "    if (script.corrupt === 'make') { process.stdout.write('not json\\n'); return; }",
  "    if (script.makeError) {",
  "      const me = script.makeError;",
  "      const extra = {};",
  "      for (const k of Object.keys(me)) { if (k !== 'code' && k !== 'message' && k !== 'hint') extra[k] = me[k]; }",
  "      fail(me.code || 'internal', me.message || 'make failed', me.hint, extra, me.code === 'invalid-arguments' ? 2 : 1);",
  "    }",
  "    let takeDoc = null;",
  "    try { takeDoc = JSON.parse(fs.readFileSync(path.join(take, 'take.json'), 'utf8')); } catch { takeDoc = null; }",
  "    if (!takeDoc) fail('take-input', 'take missing or unreadable: ' + take);",
  "    for (const kv of setFlags(argv, '--set')) {",
  "      const eq = (kv || '').indexOf('=');",
  "      const k = eq >= 0 ? kv.slice(0, eq) : kv;",
  "      if (k !== 'speed') fail('invalid-arguments', 'unknown --set key: ' + k, undefined, undefined, 2);",
  "    }",
  "    const planned = typeof script.plannedTokens === 'number' ? script.plannedTokens : 1000;",
  "    const takeSeconds = typeof takeDoc.seconds === 'number' ? takeDoc.seconds : 1;",
  "    const beats = Math.max(1, Math.round(takeSeconds));",
  "    const planOnly = hasFlag(argv, '--plan-only');",
  "    const noPlanner = hasFlag(argv, '--no-planner');",
  "    const maxTokensRaw = flag(argv, '--max-tokens');",
  "    if (planOnly) {",
  "      outLine({ out: null, seconds: takeSeconds, beats, planner: { planned_tokens: planned, input_tokens: 0, usd: 0, failed: false }, warnings: [] });",
  "      return;",
  "    }",
  "    if (!noPlanner && maxTokensRaw !== undefined && Number(maxTokensRaw) < planned) {",
  "      fail('preflight-refused', 'planned ' + planned + ' tokens, cap ' + maxTokensRaw, undefined, { planned, cap: Number(maxTokensRaw) });",
  "    }",
  "    const title = flag(argv, '--title');",
  "    if (title !== undefined) takeDoc.title = title;",
  "    if (captions !== undefined) takeDoc.captions = captions;",
  "    try { fs.writeFileSync(path.join(take, 'take.json'), JSON.stringify(takeDoc)); } catch {}",
  "    const base = path.basename(take);",
  "    const outDir = path.join(take, 'out');",
  "    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}",
  "    try { fs.writeFileSync(path.join(outDir, base + '.mp4'), 'fake'); } catch {}",
  "    const withKey = !noPlanner && keyFd !== undefined;",
  "    outLine({",
  "      out: path.join(outDir, base + '.mp4'),",
  "      seconds: takeSeconds,",
  "      beats,",
  "      planner: withKey",
  "        ? { planned_tokens: planned, input_tokens: planned, usd: 0, failed: false }",
  "        : { planned_tokens: 0, input_tokens: 0, usd: 0, failed: false },",
  "      warnings: [],",
  "    });",
  "    return;",
  "  }",
  "  fail('invalid-arguments', 'unknown verb: ' + verb, undefined, undefined, 2);",
  "}",
  "main().catch(function (e) { try { process.stderr.write(String((e && e.stack) || e) + '\\n'); } catch {} process.exit(1); });",
].join('\n');

export function fakeRecorder(o: { dir: string; script?: FakeRecorderScript }): FakeRecorder {
  mkdirSync(o.dir, { recursive: true });
  const bin = join(o.dir, 'recorder');
  writeFileSync(bin, '#!' + process.execPath + '\n' + SHIM_BODY + '\n', { encoding: 'utf8', mode: 0o700 });
  chmodSync(bin, 0o700);
  writeFileSync(join(o.dir, 'script.json'), JSON.stringify(o.script ?? {}));
  writeFileSync(join(o.dir, 'invocations.jsonl'), '');
  return {
    bin,
    script(s: FakeRecorderScript): void {
      writeFileSync(join(o.dir, 'script.json'), JSON.stringify(s));
    },
    invocations(): FakeInvocation[] {
      let raw = '';
      try {
        raw = readFileSync(join(o.dir, 'invocations.jsonl'), 'utf8');
      } catch {
        return [];
      }
      const out: FakeInvocation[] = [];
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          out.push(JSON.parse(line) as FakeInvocation);
        } catch {
          continue;
        }
      }
      return out;
    },
  };
}
