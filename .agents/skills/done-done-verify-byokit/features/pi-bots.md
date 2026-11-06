# One Pi per bot

`@byokit/pi` runs the real pinned Pi as one process per bot. Each bot has its own Pi home, session folder and extension list and answers from its own `AGENTS.md`; Pi starts when there is work, stops when idle and picks the same session back up. A person's own `~/.pi` is never used.

## Sub-features

- `two-bots`: two bots are two pids and two session files, and each model call carries only that bot's `AGENTS.md`, never a parent folder's.
- `steer-abort`: a steer reaches the model on the next call; an abort ends the run as `{ ok: false, aborted: true }`.
- `idle-resume`: an idle bot's process is gone, and its next message reaches the model with the earlier one still in the session.
- `person-pi`: a stand-in `~/.pi` hashes the same before and after, and `stateDir` inside it is refused with `person-pi`.
- `launch`: `BotSpec.launch` wraps the command the kit would run. With none, Pi gets the same argv as always; with one, that command runs instead at every start, after a crash too; a `launch` that throws is refused with `bad-launch` and a missing command with `pi-exited`, and neither starts Pi.
- `tool-cap`: `createPiKit({ maxToolCalls })` (default 30) stops a turn whose model keeps calling tools: a `limit` event with the count, then one `end` of `{ ok: false, message }` naming the limit, with the process still up; a normal turn under the cap is untouched, and `0`, a negative or a fractional cap is refused with `bad-limit`. Drive it with `npm test -w packages/pi` (the `repeats one tool call` journey in `two-bots.test.ts`, against the loopback stand-in's `loop` and `steps: <n>` answers).

## How to get to it (user POV)

An app names two bots, each with a folder and a session, and sends each a message. Each answers as itself. The app can redirect or stop a bot mid-answer, and a bot left alone stops running, then carries on where it was at the next message.

## Driving it with a node scratch consumer

Preconditions: baseline (features/README.md), with `packages/pi/dist/index.js` built. The stand-in model is a loopback server; Pi is the pinned copy in `node_modules`. No real provider is reached: the kit has no sign-in yet. Run the consumer with `HOME` set to an empty folder of its own, so `~/.pi` is the stand-in and not the real one.

Write `"$scratch_dir/verify-pi.mjs"`:

```js
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiKit, PiError } from '@byokit/pi';

const calls = []; const held = [];
const put = (res, delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'v', object: 'chat.completion.chunk', model: 'v', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
const text = (m) => typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('');
const server = createServer((req, res) => { let body = ''; req.on('data', (d) => { body += d; }); req.on('end', async () => {
  const { messages } = JSON.parse(body); const said = messages.filter((m) => m.role === 'user').map(text);
  calls.push({ system: messages.filter((m) => m.role !== 'user' && m.role !== 'assistant').map(text).join('\n'), said });
  res.writeHead(200, { 'content-type': 'text/event-stream' }); put(res, { role: 'assistant', content: '' });
  if (said.at(-1) === 'hold') await new Promise((go) => { held.push(go); res.on('close', go); });
  put(res, { content: `heard: ${said.at(-1)}` }); put(res, {}, 'stop'); res.end('data: [DONE]\n\n');
}); });
await new Promise((go) => server.listen(0, '127.0.0.1', go));
const url = `http://127.0.0.1:${server.address().port}/v1`;

const person = join(homedir(), '.pi', 'agent'); mkdirSync(person, { recursive: true });
writeFileSync(join(person, 'AGENTS.md'), 'CANARY the person'); writeFileSync(join(person, 'auth.json'), '{}');
const hash = () => createHash('sha256').update(readdirSync(person).sort().map((f) => f + readFileSync(join(person, f))).join()).digest('hex');
const before = hash();
const root = mkdtempSync(join(tmpdir(), 'verify-pi-')); writeFileSync(join(root, 'AGENTS.md'), 'CANARY parent');
const stateDir = join(root, 'state');
const spec = (id) => {
  const folder = join(root, 'bots', id); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'AGENTS.md'), `I am ${id}`);
  mkdirSync(join(stateDir, 'pi', id), { recursive: true });
  writeFileSync(join(stateDir, 'pi', id, 'models.json'), JSON.stringify({ providers: { v: { baseUrl: url, api: 'openai-completions', apiKey: 'none', models: [{ id: 'v-1' }] } } }));
  return { id, folder, session: `${id}-task` };
};
const next = (bot, type) => new Promise((go) => { const off = bot.on((e) => { if (e.type === type) { off(); go(e); } }); });
const kit = createPiKit({ stateDir, idleMs: 500 });
const [a, b] = [kit.bot(spec('chief')), kit.bot(spec('scout'))];
const ends = [next(a, 'end'), next(b, 'end')];
await Promise.all([a.prompt('hello chief'), b.prompt('hello scout')]);
console.log('two-bots pids differ:', a.pid !== b.pid, (await Promise.all(ends)).map((e) => e.end.text));
for (const id of ['chief', 'scout']) {
  const call = calls.find((c) => c.said.at(-1) === `hello ${id}`);
  console.log(`two-bots ${id}: own context ${call.system.includes(`I am ${id}`)}, any canary ${call.system.includes('CANARY')}, session files ${readdirSync(join(root, 'bots', id, 'sessions')).length}`);
}
let end = next(a, 'end'); await a.prompt('hold'); while (!held.length) await new Promise((go) => setTimeout(go, 20));
await a.steer('turn left'); held.splice(0).forEach((go) => go()); console.log('steer-abort steered:', (await end).end);
end = next(a, 'end'); await a.prompt('hold'); while (!held.length) await new Promise((go) => setTimeout(go, 20));
await a.abort(); console.log('steer-abort aborted:', (await end).end);
const old = b.pid; const stop = await next(b, 'stopped'); let gone = false; try { process.kill(old, 0); } catch { gone = true; }
console.log('idle-resume stopped:', stop.reason, 'process gone:', gone);
end = next(b, 'end'); await b.prompt('still there'); await end; console.log('idle-resume model saw:', calls.at(-1).said);
await kit.close(); server.closeAllConnections(); server.close();
try { createPiKit({ stateDir: person }); } catch (e) { console.log('person-pi refused:', e instanceof PiError && e.code); }
console.log('person-pi same hash:', hash() === before);
rmSync(root, { recursive: true, force: true });
```

Pass: `pids differ: true`, each bot's own context `true`, any canary `false`, one session file each, a steered reply of `heard: turn left`, `{ ok: false, aborted: true }`, `idle` with the process gone, the model seeing `hello scout` and `still there` together, `person-pi` refused and the same hash.

## Driving `launch`

After building and committing, run `done-done run pi-launch`. It builds the kit, runs `packages/pi/test/*.test.ts` and then the maintained capture `capture/pi-launch.mjs`, which imports the built `@byokit/pi` and runs the real pinned Pi against the loopback stand-in. The wall is real bubblewrap (`/usr/bin/bwrap`), owned by the capture: the kit ships none.

Evidence: `pi-launch.log`, `pi-tests.log`, `build.log` and `steps.json`, all from the same run.

Pass: the log's `launch` line shows `process bwrap`, the same argv as the `no launch` line, and `Pi sees the outside file: false` and `its write reached the real disk: false` where `no launch` shows `true`; the `crash` line shows the launch ran twice and the file is still hidden; `throwing launch` shows `bad-launch`, `missing wall` shows `pi-exited` with `ENOENT`, and the model was asked nothing by either.

## Not provable here

A real provider: the kit has no sign-in until its sign-in slice lands, so every answer comes from the loopback stand-in.
