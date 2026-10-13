#!/usr/bin/env node
// Capture only a task-owned emulator's actual screen after engine + phone DOM readback agree.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
const { values: a } = parseArgs({ options: Object.fromEntries(['serial','view','provider','stage','output','cdp','url'].map(k => [k,{type:'string'}])) });
if (!a.serial?.startsWith('emulator-') || !a.output || !isAbsolute(a.output) || !['claude-cli','openai'].includes(a.provider) || !['waiting','done'].includes(a.stage)) throw Error('owned emulator, external output, provider and checkpoint required');
const targets = await (await fetch(`http://127.0.0.1:${Number(a.cdp)}/json/list`)).json();
const target = targets.find(t => t.type === 'page' && t.url === a.url);
if (!target) throw Error('owned phone page is unavailable');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject) => { ws.once('open',resolve); ws.once('error',reject); });
let id = 0;
const pending = new Map();
ws.on('message',raw => { const m = JSON.parse(raw); const held = pending.get(m.id); if (held) { pending.delete(m.id); m.error ? held.reject(Error(m.error.message)) : held.resolve(m.result); } });
const call = (method,params) => new Promise((resolve,reject) => { const next = ++id; pending.set(next,{resolve,reject}); ws.send(JSON.stringify({id:next,method,params})); });
try {
  let captured = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const host = JSON.parse(readFileSync(a.view,'utf8'));
    const result = await call('Runtime.evaluate',{returnByValue:true,expression:"({stage:document.body.dataset.stage,provider:document.body.dataset.provider,status:document.getElementById('status').textContent,empty:document.getElementById('paste').value.length===0})"});
    const phone = result.result.value;
    const expected = a.stage === 'done' ? 'Signed in' : 'Continue on the sign-in page';
    if (host.provider === a.provider && host.state === a.stage && phone?.stage === a.stage && phone.provider === a.provider && phone.status === expected) {
      if (!phone.empty) throw Error('clear the returned-code field before capturing');
      mkdirSync(dirname(a.output),{recursive:true});
      writeFileSync(a.output,execFileSync('adb',['-s',a.serial,'exec-out','screencap','-p'],{timeout:20_000,maxBuffer:8*1024*1024}));
      console.log(`captured ${a.provider} ${a.stage}: ${a.output}`);
      captured = true; break;
    }
    await new Promise(resolve => setTimeout(resolve,1000));
  }
  if (!captured) throw Error('engine and phone did not reach the requested checkpoint');
} finally { ws.close(); }
