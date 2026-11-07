// Built @byokit/pi and the real pinned Pi against the loopback stand-in model, which keeps calling one tool; no account, no credential.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiKit, PiError } from '@byokit/pi';
import { ended, fakeModel, next, scene } from '../../../../packages/pi/test/fake-model.ts';

const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
assert.ok(evidence, 'run through done-done');
assert.match(createRequire(import.meta.url).resolve('@byokit/pi'), /packages\/pi\/dist\/index\.js$/);

const log = [];
const note = (text) => { log.push(text); console.log(text); };
const root = mkdtempSync(join(tmpdir(), 'byk-pi-tool-cap-'));
const model = await fakeModel();
const crew = scene(root, model.url);
const extension = join(import.meta.dirname, '../../../../packages/pi/test/fixtures/extension.ts');
const refused = [0, -3, 1.5].map((maxToolCalls) => { try { createPiKit({ stateDir: crew.stateDir, maxToolCalls }); return 'accepted'; } catch (error) { assert.ok(error instanceof PiError); return error.code; } });
assert.deepEqual(refused, ['bad-limit', 'bad-limit', 'bad-limit']);
note(`maxToolCalls 0, -3 and 1.5 are refused at construction: ${refused.join(', ')}`);

const kit = createPiKit({ stateDir: crew.stateDir, maxToolCalls: 4 });
try {
  const bot = kit.bot({ ...crew.bot('looper'), extensions: [extension] });
  const events = [];
  bot.on((event) => { events.push(event); });
  const run = async (text) => {
    events.length = 0;
    const done = next(bot, ended);
    await bot.prompt(text);
    return (await done).end;
  };
  const tools = () => events.filter((event) => event.type === 'tool' && event.phase === 'end').length;

  const stopped = await run('loop');
  const limit = events.filter((event) => event.type === 'limit');
  assert.equal(stopped.ok, false);
  assert.match(stopped.message, /limit of 4 tool calls/);
  assert.deepEqual(limit, [{ type: 'limit', toolCalls: 4, limit: 4 }]);
  assert.ok(tools() >= 4 && tools() <= 5);
  assert.notEqual(bot.pid, undefined);
  note(`a model repeating one tool call: ${tools()} tool calls ran, event ${JSON.stringify(limit[0])}, end ${JSON.stringify(stopped)}, process still up: true`);

  const normal = await run('steps: 3');
  assert.deepEqual(normal, { ok: true, text: 'did 3' });
  assert.equal(tools(), 3);
  assert.ok(!events.some((event) => event.type === 'limit'));
  note(`the next turn under the cap counts from zero: ${tools()} tool calls, end ${JSON.stringify(normal)}, no limit event`);
} finally {
  await kit.close();
  await model.close();
  rmSync(root, { recursive: true, force: true });
}
writeFileSync(join(evidence, 'pi-tool-cap.log'), `${log.join('\n')}\n`);
writeFileSync(join(evidence, 'steps.json'), JSON.stringify({
  target: { version: `@byokit/pi ${JSON.parse(readFileSync('packages/pi/package.json', 'utf8')).version}` },
  start: 'A built checkout, a bot with a tool, a kit with maxToolCalls 4, and a loopback stand-in model that calls the tool every time it is asked',
  steps: ['Refuse a tool call cap of zero, a negative and a fraction at construction', 'Send a prompt to a model repeating one tool call until the cap', 'Send a normal prompt that uses three tool calls under the cap'],
  result: 'A bot turn stops at maxToolCalls with a limit event and one plain failed end naming the limit while the process stays up, a repeated tool call cannot spend without bound, and a turn under the cap is untouched',
}, null, 2));
