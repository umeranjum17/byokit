// Journeys on the real pinned Pi against a loopback stand-in model: no account, no network.
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createPiKit, PiError, type BotEvent } from '../src/index.ts';
import { scratchDir } from '../../test-support.ts';
import { ended, fakeModel, next, scene, stopped, type Scene } from './fake-model.ts';

let model: Awaited<ReturnType<typeof fakeModel>>;
let crew: Scene;
before(async () => { model = await fakeModel(); crew = scene(scratchDir('pi-bots'), model.url); });
after(() => model.close());
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sessionFiles = (folder: string) => readdirSync(join(folder, 'sessions'));

test('two bots run as two processes on two sessions, each with its own AGENTS.md and extensions', async (t) => {
  const kit = createPiKit({ stateDir: crew.stateDir });
  t.after(() => kit.close());
  const chiefSpec = { ...crew.bot('chief'), extensions: [join(import.meta.dirname, 'fixtures', 'extension.ts')] };
  const chief = kit.bot(chiefSpec);
  const scoutSpec = crew.bot('scout');
  const scout = kit.bot(scoutSpec);
  const chiefDone = next(chief, ended);
  const scoutDone = next(scout, ended);
  const words: string[] = [];
  chief.on((event) => { if (event.type === 'text') words.push(event.text); });
  await Promise.all([chief.prompt('answer: line kept whole'), scout.prompt('answer: from scout')]);
  assert.notEqual(chief.pid, undefined);
  assert.notEqual(chief.pid, scout.pid);
  assert.deepEqual((await chiefDone).end, { ok: true, text: 'line kept whole' });
  assert.deepEqual((await scoutDone).end, { ok: true, text: 'from scout' });
  assert.equal(words.join(''), 'line kept whole');

  const asked = (said: string) => model.seen.find((seen) => seen.said.at(-1) === said)!;
  const chiefCall = asked('answer: line kept whole');
  const scoutCall = asked('answer: from scout');
  assert.match(chiefCall.system, /I am chief/);
  assert.doesNotMatch(chiefCall.system, /I am scout/);
  assert.match(scoutCall.system, /I am scout/);
  assert.doesNotMatch(scoutCall.system, /I am chief/);
  for (const call of [chiefCall, scoutCall]) { assert.doesNotMatch(call.system, /CANARY/); assert.ok(!call.tools.includes('bash')); }
  assert.ok(chiefCall.tools.includes('only_this_bot'));
  assert.ok(!scoutCall.tools.includes('only_this_bot'));
  const [chiefFile] = sessionFiles(chiefSpec.folder);
  const [scoutFile] = sessionFiles(scoutSpec.folder);
  assert.match(chiefFile!, /chief-task\.jsonl$/);
  assert.match(scoutFile!, /scout-task\.jsonl$/);
  await kit.close();
  assert.equal(chief.pid, undefined);
  assert.equal(scout.pid, undefined);
});

test('a running bot can be steered, followed up and aborted', async (t) => {
  const kit = createPiKit({ stateDir: crew.stateDir });
  t.after(() => kit.close());
  const bot = kit.bot(crew.bot('steered'));
  const seen: BotEvent[] = [];
  bot.on((event) => { seen.push(event); });

  let done = next(bot, ended);
  await bot.prompt('hold');
  await model.holding();
  await assert.rejects(bot.prompt('too soon'), (error: PiError) => error.code === 'pi-refused' && /already processing/.test(error.message));
  await bot.steer('answer: turn left');
  await bot.followUp('answer: and then stop');
  model.release();
  assert.deepEqual((await done).end, { ok: true, text: 'and then stop' });
  const order = model.seen.map((call) => call.said.at(-1));
  assert.ok(order.indexOf('answer: turn left') < order.indexOf('answer: and then stop'));
  assert.ok(seen.some((event) => event.type === 'started'));

  done = next(bot, ended);
  await bot.prompt('hold');
  await model.holding();
  await bot.followUp('answer: must never run');
  await bot.abort();
  assert.deepEqual((await done).end, { ok: false, aborted: true });
  assert.notEqual(bot.pid, undefined);
  // What was queued is gone for good, not waiting to ride along with the next message.
  done = next(bot, ended);
  await bot.prompt('answer: fresh start');
  assert.deepEqual((await done).end, { ok: true, text: 'fresh start' });
  assert.ok(!model.seen.some((call) => call.said.includes('answer: must never run')));
});

test('an idle bot stops, and its next message picks the same session back up', async (t) => {
  const kit = createPiKit({ stateDir: crew.stateDir, idleMs: 400 });
  t.after(() => kit.close());
  const spec = crew.bot('sleeper');
  const bot = kit.bot(spec);
  const stop = next(bot, stopped);
  const first = next(bot, ended);
  await bot.prompt('answer: remember this');
  const pid = bot.pid!;
  await first;
  assert.deepEqual(await stop, { type: 'stopped', reason: 'idle' });
  assert.equal(bot.pid, undefined);
  assert.equal(alive(pid), false);

  const second = next(bot, ended);
  await bot.prompt('answer: still here');
  assert.notEqual(bot.pid, pid);
  await second;
  assert.deepEqual(model.seen.at(-1)!.said, ['answer: remember this', 'answer: still here']);
  assert.equal(sessionFiles(spec.folder).length, 1);
});

test('a long run is not stopped as idle, and stopping mid-run ends it as aborted', async (t) => {
  const kit = createPiKit({ stateDir: crew.stateDir, idleMs: 200 });
  t.after(() => kit.close());
  const bot = kit.bot(crew.bot('worker'));
  const quick = next(bot, ended);
  await bot.prompt('answer: warm up');
  await quick;
  const end = next(bot, ended);
  await bot.prompt('hold');
  await model.holding();
  const pid = bot.pid;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(bot.pid, pid);
  const stop = next(bot, stopped);
  await bot.stop();
  assert.deepEqual((await end).end, { ok: false, aborted: true });
  assert.deepEqual(await stop, { type: 'stopped', reason: 'asked' });
  model.release();
});

test('a crash reaches the app with its cause, and the next message recovers the session', async (t) => {
  const kit = createPiKit({ stateDir: crew.stateDir });
  t.after(() => kit.close());
  const bot = kit.bot(crew.bot('crasher'));
  const warm = next(bot, ended);
  await bot.prompt('answer: before the crash');
  await warm;
  const end = next(bot, ended);
  const stop = next(bot, stopped);
  await bot.prompt('hold');
  await model.holding();
  process.kill(bot.pid!, 'SIGKILL');
  const crash = await end;
  assert.equal(crash.end.ok, false);
  assert.match((crash.end as { message: string }).message, /SIGKILL/);
  const down = await stop;
  assert.equal(down.reason, 'crashed');
  assert.match(down.detail!, /SIGKILL/);
  model.release();

  const again = next(bot, ended);
  await bot.prompt('answer: after the crash');
  assert.deepEqual((await again).end, { ok: true, text: 'after the crash' });
  assert.ok(model.seen.at(-1)!.said.includes('answer: before the crash'));
});

test('a failed model call and a bot with no model each tell the app the real cause', async (t) => {
  const kit = createPiKit({ stateDir: crew.stateDir });
  t.after(() => kit.close());
  const bot = kit.bot(crew.bot('refused'));
  const failed = next(bot, ended);
  await bot.prompt('fail');
  const failure = (await failed).end;
  assert.equal(failure.ok, false);
  assert.match((failure as { message: string }).message, /the fake model refused/);

  const bare = kit.bot({ id: 'no-model', folder: crew.folder('no-model'), session: 'none' });
  rmSync(join(crew.stateDir, 'pi', 'no-model', 'models.json'));
  const outcome = await bare.prompt('hello').then(() => next(bare, ended).then((event) => JSON.stringify(event.end)), (error: PiError) => `${error.code}: ${error.message}`);
  assert.match(outcome, /model/i);
});

test('a running bot cannot be doubled, and a stopped one can move to another session', async (t) => {
  const kit = createPiKit({ stateDir: crew.stateDir });
  t.after(() => kit.close());
  const spec = crew.bot('mover');
  const bot = kit.bot(spec);
  const done = next(bot, ended);
  await bot.prompt('answer: first session');
  await done;
  assert.throws(() => kit.bot(spec), (error: PiError) => error.code === 'bot-running');
  await bot.stop();
  const moved = kit.bot({ ...spec, session: 'mover-other' });
  const fresh = next(moved, ended);
  await moved.prompt('answer: second session');
  await fresh;
  assert.deepEqual(model.seen.at(-1)!.said, ['answer: second session']);
  assert.equal(sessionFiles(spec.folder).length, 2);
});
