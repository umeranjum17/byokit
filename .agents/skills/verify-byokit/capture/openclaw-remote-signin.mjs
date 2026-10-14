#!/usr/bin/env node
// Captures only a task-owned emulator's screen once the engine view and phone DOM agree on one checkpoint.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'; import { dirname, isAbsolute } from 'node:path'; import { execFileSync } from 'node:child_process'; import { parseArgs } from 'node:util'; import WebSocket from 'ws';
const { values: a } = parseArgs({ options: Object.fromEntries(['serial', 'view', 'provider', 'stage', 'output', 'cdp', 'url'].map((k) => [k, { type: 'string' }])) });
if (!a.serial?.startsWith('emulator-') || !isAbsolute(a.output ?? '') || !['claude-cli', 'openai'].includes(a.provider) || !['waiting', 'done'].includes(a.stage)) throw Error('owned emulator, external output, provider and checkpoint required');
const target = (await (await fetch(`http://127.0.0.1:${Number(a.cdp)}/json/list`)).json()).find((t) => t.type === 'page' && t.url === a.url);
if (!target) throw Error('owned phone page is unavailable');
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
let id = 0; const pending = new Map(); ws.on('message', (raw) => { const m = JSON.parse(raw), held = pending.get(m.id); if (held) { pending.delete(m.id); m.error ? held.reject(Error(m.error.message)) : held.resolve(m.result); } });
const call = (method, params) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params })); });
const expected = a.stage === 'done' ? 'Signed in' : 'Continue on the sign-in page', probe = "({stage: document.body.dataset.stage, provider: document.body.dataset.provider, status: document.getElementById('status').textContent, empty: document.getElementById('paste').value.length === 0})";
try { for (let attempt = 0; attempt < 30; attempt++) {
  const host = JSON.parse(readFileSync(a.view, 'utf8')), phone = (await call('Runtime.evaluate', { returnByValue: true, expression: probe })).result.value;
  if (host.provider === a.provider && host.state === a.stage && phone?.stage === a.stage && phone.provider === a.provider && phone.status === expected) {
    if (!phone.empty) throw Error('clear the returned-code field before capturing');
    mkdirSync(dirname(a.output), { recursive: true }); writeFileSync(a.output, execFileSync('adb', ['-s', a.serial, 'exec-out', 'screencap', '-p'], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
    console.log(`captured ${a.provider} ${a.stage}: ${a.output}`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 1000)); }
throw Error('engine and phone did not reach the requested checkpoint'); } finally { ws.close(); }
