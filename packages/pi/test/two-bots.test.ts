// Journeys on the real pinned Pi against a loopback stand-in model: no account, no network.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPiKit, PiError, type Bot, type BotEvent, type BotSpec, type Launch } from '../src/index.ts';
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

test('with no launch Pi runs exactly as it always has, and a launch runs instead, at every start', async (t) => {
  const kit = createPiKit({ stateDir: crew.stateDir });
  t.after(() => kit.close());
  const extension = join(import.meta.dirname, 'fixtures', 'extension.ts');
  const spec = { ...crew.bot('walled'), extensions: [extension] };
  const argv = () => JSON.parse(readFileSync(join(crew.stateDir, 'pi', 'walled', 'seen-argv.json'), 'utf8')) as string[];
  const ask = async (bot: Bot, text: string) => {
    const done = next(bot, ended);
    await bot.prompt(text);
    assert.deepEqual((await done).end, { ok: true, text: text.slice('answer: '.length) });
  };

  const plain = kit.bot(spec);
  await ask(plain, 'answer: bare');
  await plain.stop();
  const bare = argv();
  assert.deepEqual(bare, [process.execPath, fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry')),
    '--session-dir', join(spec.folder, 'sessions'), '--session-id', 'walled-task',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-mcp', '--no-approve',
    '--exclude-tools', 'bash', '--extension', extension, '--append-system-prompt', join(spec.folder, 'AGENTS.md')]);

  // A stand-in wall: a real process of the consumer's that notes its pid, then becomes what it was asked to run.
  const marks = join(crew.root, 'wall-pids');
  const given: Launch[] = [];
  const walled = kit.bot({ ...spec, launch: (pi) => {
    given.push(pi);
    return { command: '/bin/sh', args: ['-c', 'echo $$ >> "$0"; exec "$@"', marks, pi.command, ...pi.args] };
  } });
  const pids = () => readFileSync(marks, 'utf8').trim().split('\n').map(Number);
  await ask(walled, 'answer: behind the wall');
  assert.deepEqual([given[0]!.command, ...given[0]!.args], bare);
  assert.deepEqual(argv(), bare);
  assert.deepEqual(pids(), [walled.pid]);

  // A Pi that dies comes back behind the same wall, never outside it.
  const down = next(walled, stopped);
  process.kill(walled.pid!, 'SIGKILL');
  await down;
  await ask(walled, 'answer: still walled');
  assert.equal(given.length, 2);
  assert.deepEqual(pids().at(-1), walled.pid);
});

test('a launch that fails is refused with its cause, Pi never starts without it, and the bot recovers', async (t) => {
  const kit = createPiKit({ stateDir: crew.stateDir });
  t.after(() => kit.close());
  const spec = crew.bot('unwalled');
  const refused = async (launch: BotSpec['launch'], words: RegExp) => {
    const bot = kit.bot({ ...spec, launch });
    await assert.rejects(bot.prompt('answer: must never run'), (error: PiError) => error.code === 'bad-launch' && words.test(error.message));
    assert.equal(bot.pid, undefined);
  };
  await refused(() => { throw new Error('the wall is not ready'); }, /the wall is not ready/);
  for (const wrong of [undefined, {}, { command: '', args: [] }, { command: 'wall' }, { command: 'wall', args: ['ok', 1] }, Promise.resolve({ command: 'wall', args: [] })]) {
    await refused(() => wrong as never, /command and its args/);
  }
  await refused(null as never, /not a function/);
  await refused('wall' as never, /not a function/);

  // A wall that is gone stops the start in Pi's own words, once, and leaves the bot free to start.
  const gone = kit.bot({ ...spec, launch: () => ({ command: join(crew.root, 'no-such-wall'), args: [] }) });
  const seen: BotEvent[] = [];
  gone.on((event) => { seen.push(event); });
  await assert.rejects(gone.prompt('answer: must never run'), (error: PiError) => error.code === 'pi-exited' && /did not start.*ENOENT/.test(error.message));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(seen.map((event) => event.type), ['stopped']);
  assert.equal(gone.pid, undefined);
  assert.ok(!model.seen.some((call) => call.said.includes('answer: must never run')));

  let ready = false;
  const late = kit.bot({ ...spec, launch: (pi) => { if (!ready) throw new Error('not yet'); return pi; } });
  await assert.rejects(late.prompt('answer: too soon'), (error: PiError) => error.code === 'bad-launch');
  ready = true;
  const done = next(late, ended);
  await late.prompt('answer: wall up');
  assert.deepEqual((await done).end, { ok: true, text: 'wall up' });
});

test('a model that repeats one tool call is stopped at the cap with a plain result, and a normal turn is untouched', async (t) => {
  assert.throws(() => createPiKit({ stateDir: crew.stateDir, maxToolCalls: 0 }), (error: PiError) => error.code === 'bad-limit');
  assert.throws(() => createPiKit({ stateDir: crew.stateDir, maxToolCalls: -3 }), (error: PiError) => error.code === 'bad-limit');
  assert.throws(() => createPiKit({ stateDir: crew.stateDir, maxToolCalls: 1.5 }), (error: PiError) => error.code === 'bad-limit');

  const kit = createPiKit({ stateDir: crew.stateDir, maxToolCalls: 4 });
  t.after(() => kit.close());
  const bot = kit.bot({ ...crew.bot('looper'), extensions: [join(import.meta.dirname, 'fixtures', 'extension.ts')] });
  const events: BotEvent[] = [];
  bot.on((event) => { events.push(event); });

  const done = next(bot, ended);
  await bot.prompt('loop');
  const { end } = await done;
  assert.equal(end.ok, false);
  assert.match((end as { message: string }).message, /limit of 4 tool calls/);
  assert.deepEqual(events.filter((event) => event.type === 'limit'), [{ type: 'limit', toolCalls: 4, limit: 4 }]);
  // The call that trips the cap was already on its way, so one may run past it; a request already sent is cut, and nothing after it runs.
  const ran = events.filter((event) => event.type === 'tool' && event.phase === 'end').length;
  assert.ok(ran === 4 || ran === 5, `${ran} tool calls ran`);
  assert.ok(model.seen.filter((call) => call.said.at(-1) === 'loop').length <= 6);
  assert.equal(events.filter((event) => event.type === 'end').length, 1);
  assert.notEqual(bot.pid, undefined);

  // The count is per turn: the next turn starts from zero, and one that stays under the cap is not cut.
  events.length = 0;
  const again = next(bot, ended);
  await bot.prompt('steps: 4');
  assert.deepEqual((await again).end, { ok: true, text: 'did 4' });
  assert.ok(!events.some((event) => event.type === 'limit'));
  assert.equal(events.filter((event) => event.type === 'tool' && event.phase === 'end').length, 4);
});
