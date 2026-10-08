// A run as a person sees it: the state machine over the kit's run frames, the sentence for each way a run can fail
// (the OpenClaw kit's own words), and the live store driven through the kit's real device client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openclawDevice } from '../../openclaw/src/device.ts';
import { words } from '../../openclaw/src/words.ts';
import { RUN_IDLE, runStep, runStore, runView, type RunAction, type RunState } from '../src/kits.ts';
import { stubLink, until } from './stub-link.ts';

const PLAIN = new RegExp(JSON.parse(readFileSync(new URL('../../../fixtures/conformance/plain-words.json', import.meta.url), 'utf8')).pattern, 'i');
const walk = (...actions: RunAction[]) => actions.reduce(runStep, RUN_IDLE);
const view = (s: RunState) => runView(s, { words, name: 'ChatGPT', time: () => '3:05 PM' });

test('a run streams text, tracks each tool it uses, and ends done with the final reply', () => {
  assert.deepEqual(RUN_IDLE, { phase: 'idle', text: '', tools: [] });
  const running = walk({ type: 'start' }, { type: 'text', text: 'Hel' }, { type: 'text', text: 'Hello' },
    { type: 'tool', name: 'web_search', phase: 'start' });
  assert.equal(running.phase, 'running');
  assert.equal(runStep(running, { type: 'started' }), running, 'acceptance keeps the current reply and tools');
  assert.equal(runStep(running, { type: 'thinking', tokens: 23 }), running, 'thinking keeps the current reply and tools');
  assert.equal(running.text, 'Hello', 'text is cumulative: each frame replaces');
  assert.equal(view(running).tool, 'web_search');
  const two = walk({ type: 'start' }, { type: 'tool', name: 'read', phase: 'start' }, { type: 'tool', name: 'read', phase: 'start' },
    { type: 'tool', name: 'read', phase: 'end' });
  assert.deepEqual(two.tools, [{ name: 'read', done: true }, { name: 'read', done: false }], 'the same tool twice ends one at a time');
  assert.equal(view(two).tool, 'read');
  const unmatched = runStep(two, { type: 'tool', name: 'other', phase: 'end' });
  assert.equal(unmatched, two, 'an end for a tool never started changes nothing');

  const done = runStep(running, { type: 'end', end: { ok: true, text: 'Hello there.' } });
  assert.equal(done.phase, 'done');
  assert.equal(done.text, 'Hello there.');
  assert.deepEqual(done.tools, [{ name: 'web_search', done: true }], 'an end finishes every tool');
  assert.equal(view(done).tool, undefined);
  assert.equal(view(done).words, '');
  assert.equal(runStep(running, { type: 'end', end: { ok: true, text: '' } }).text, 'Hello', 'an empty final reply keeps the streamed text');
});

test('a finished run hears nothing more until the next start', () => {
  const done = walk({ type: 'start' }, { type: 'end', end: { ok: true, text: 'Hi.' } });
  for (const a of [{ type: 'text', text: 'late' }, { type: 'tool', name: 't', phase: 'start' }, { type: 'stop' },
    { type: 'error', message: 'x' }, { type: 'end', end: { ok: false, aborted: true } }] as RunAction[]) {
    assert.equal(runStep(done, a), done, a.type);
  }
  assert.equal(runStep(RUN_IDLE, { type: 'text', text: 'x' }), RUN_IDLE, 'nor does one never started');
  assert.deepEqual(runStep(done, { type: 'start' }), { phase: 'running', text: '', tools: [] }, 'a new run starts clean');
});

test('each way a run can end has its phase and, where the kit has one, its sentence', () => {
  const ended = (end: Extract<RunAction, { type: 'end' }>['end']) => walk({ type: 'start' }, { type: 'text', text: 'partial' }, { type: 'end', end });
  const aborted = ended({ ok: false, aborted: true });
  assert.equal(aborted.phase, 'stopped');
  assert.equal(aborted.text, 'partial', 'what streamed before stays');
  assert.equal(view(aborted).words, '');
  const cases = [
    ['signed-out', undefined, 'Sign in with ChatGPT to start.'],
    ['resting', Date.UTC(2026, 8, 29, 15, 5), 'ChatGPT needs a break until 3:05 PM.'],
    ['resting', undefined, 'ChatGPT needs a break until later.'],
    ['plan', undefined, "Your ChatGPT plan doesn't include this."],
    ['network', undefined, "Can't reach ChatGPT right now. This keeps trying by itself."],
    ['other', undefined, ''],
  ] as const;
  for (const [kind, until, said] of cases) {
    const s = ended({ ok: false, kind, message: 'HTTP 429 from upstream', ...(until === undefined ? {} : { until }) });
    assert.equal(s.phase, 'failed', kind);
    assert.equal(view(s).words, said, kind);
    assert.doesNotMatch(view(s).words, PLAIN, kind);
  }
  const output = ended({ ok: false, kind: 'output', message: 'The answer did not match the requested format.' });
  assert.equal(output.phase, 'failed');
  assert.equal(view(output).words, 'The answer did not match the requested format.');
  const clock = runView(ended({ ok: false, kind: 'resting', until: 0, message: '' }), { words, name: 'ChatGPT' }).words;
  assert.match(clock, /^ChatGPT needs a break until \S.*\.$/, 'the default clock says a time');

  const refused = walk({ type: 'start' }, { type: 'error', message: "This device can't do that. Ask the person at the computer." });
  assert.equal(refused.phase, 'failed');
  assert.equal(view(refused).words, "This device can't do that. Ask the person at the computer.", 'the host\'s own words');
  const stopped = walk({ type: 'start' }, { type: 'text', text: 'so far' }, { type: 'stop' });
  assert.deepEqual([stopped.phase, stopped.text], ['stopped', 'so far']);
});

test('the store runs through the kit\'s device client: streamed, ended, and one run at a time', async () => {
  const net = stubLink(() => null);
  const run = runStore(openclawDevice(net.link));
  const seen: RunState[] = [];
  const off = run.subscribe((s) => seen.push(s));
  assert.equal(run.get(), RUN_IDLE);

  run.send('hello', { sessionKey: 'agent:me:1' });
  const first = await net.next();
  assert.deepEqual([first.op, first.args], ['oc.run', { message: 'hello', sessionKey: 'agent:me:1' }]);
  first.line({ type: 'started' });
  first.line({ type: 'thinking', tokens: 23 });
  first.line({ type: 'text', text: 'Hi' });
  first.line({ type: 'tool', name: 'demo_note', phase: 'start' });
  await until(() => run.get().tools.length === 1);
  assert.deepEqual([run.get().phase, run.get().text], ['running', 'Hi']);
  first.line({ type: 'tool', name: 'demo_note', phase: 'end' });
  first.line({ type: 'end', end: { ok: true, text: 'Hi, noted.' } });
  await until(() => run.get().phase === 'done');
  assert.equal(run.get().text, 'Hi, noted.');
  assert.equal(seen.at(-1), run.get(), 'listeners hear the latest state');
  assert.ok(seen.every((s, i) => i === 0 || s !== seen[i - 1]), 'only changes are announced');

  // A new send stops listening to the one still streaming; its late frames change nothing.
  run.send('one');
  const one = await net.next();
  run.send('two');
  const two = await net.next();
  await until(() => one.ended);
  one.line({ type: 'text', text: 'late' });
  two.line({ type: 'text', text: 'fresh' });
  await until(() => run.get().text === 'fresh');
  assert.equal(run.get().phase, 'running');

  // Stop: the stream ends and the run reads as stopped, keeping what it said.
  run.stop();
  assert.equal(run.get().phase, 'stopped');
  await until(() => two.ended);
  run.stop();
  assert.equal(run.get().phase, 'stopped', 'stopping twice is fine');

  // A host that ends the stream with its own words: the run failed, with those words.
  run.send('not allowed');
  const refused = await net.next();
  refused.end("This device can't do that. Ask the person at the computer.");
  await until(() => run.get().phase === 'failed');
  assert.equal(runView(run.get(), { words, name: 'ChatGPT' }).words, "This device can't do that. Ask the person at the computer.");

  // The link cut the stream mid-run: it ends with the link's bare reason, which is no sentence; the run stopped here.
  run.send('cut off');
  const cut = await net.next();
  cut.line({ type: 'text', text: 'half' });
  cut.end('unreachable');
  await until(() => run.get().phase === 'stopped');
  assert.deepEqual([run.get().text, runView(run.get(), { words, name: 'ChatGPT' }).words], ['half', '']);

  // A stream that ends without an end frame: stopped. A link that cannot open one: failed with its words.
  run.send('cut');
  (await net.next()).end();
  await until(() => run.get().phase === 'stopped');
  net.refuse(Object.assign(new Error("Can't reach the computer."), { code: 'unreachable' }));
  run.send('offline');
  await until(() => run.get().phase === 'failed');
  assert.equal(run.get().error, "Can't reach the computer.");
  off();
});
