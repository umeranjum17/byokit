// H8 acceptance (docs/runtime-kits.md 6.9/11.3): the 6.9 table verbatim, the 4.3 banned-jargon rule, a sentence for
// every HerdrState.phase and AgentStatus, and typed stateWords/agentWords helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, words, stateWords, agentWords, type WordKey } from '../src/words.ts';
import type { AgentStatus, HerdrState } from '../src/types.ts';

// §6.9 table, byte for byte: ASCII apostrophes, U+2026 ellipsis, exactly as the spec table spells them.
const TABLE: readonly (readonly [WordKey, string])[] = [
  ['herdr.missing', 'This computer needs Herdr installed first.'],
  ['herdr.connecting', 'Connecting to Herdr…'],
  ['herdr.ready', 'Connected to Herdr.'],
  ['herdr.reconnecting', "Herdr isn't answering. Trying again by itself."],
  ['herdr.needsUpdate', 'Herdr on this computer needs an update to work with this app.'],
  ['herdr.failed', "Herdr couldn't start on this computer. Restart the app to try again."],
  ['agent.starting', 'Starting…'],
  ['agent.idle', 'Ready for you.'],
  ['agent.working', 'Working.'],
  ['agent.blocked', 'Waiting for your answer.'],
  ['agent.done', 'Finished.'],
  ['agent.unknown', 'Running.'],
  ['agent.signIn', 'Sign in inside {agent}: follow its own steps on the screen.'],
  ['agent.notReady', "This helper isn't ready yet. Try again in a moment."],
  ['agent.installing', 'Installing {agent}…'],
  ['agent.installFailed', "Installing {agent} didn't finish. Try again in a moment."],
  ['agent.launchFailed', "That helper couldn't start. Try again in a moment."],
  ['approval.stale', 'That question already changed. Look again before answering.'],
  ['close.wouldWiden', 'Closing this would close more than you picked. Close the bigger one instead.'],
  ['link.notAllowed', "This device can't do that. Ask the person at the computer."],
  ["move.too_early", "This conversation has not started yet. Try again in a moment."],
  ["move.busy", "Wait for this conversation to finish before moving it."],
  ["move.unsupported", "This conversation cannot move between these accounts."],
  ["move.env_mismatch", "The new pane did not receive that sign-in. Try again."],
  ["move.close_failed", "The old pane could not close. The move was undone where possible."],
  ["move.start_failed", "The new account could not take over. Try again."],
  ['turn.failed', 'This turn could not be confirmed. Check the helper before trying again.'],
];

test('words.json is the 6.9 table verbatim — same keys, same sentences, nothing extra', () => {
  assert.deepEqual(Object.keys(WORDS), TABLE.map(([k]) => k));
  for (const [k, sentence] of TABLE) assert.equal(WORDS[k], sentence, k);
});

test('plain words only: no codes, commands, paths, model ids or jargon a person would have to look up (4.3)', () => {
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w.replace(/\{\w+\}/g, 'X'), banned, k);
  assert.equal(words('agent.signIn', { agent: 'pi' }), 'Sign in inside pi: follow its own steps on the screen.');
  assert.equal(words('agent.signIn', {}), 'Sign in inside {agent}: follow its own steps on the screen.', 'unfilled slots stay visible');
});

test('every HerdrState.phase has a sentence; a stopped kit has nothing to say yet (6.9)', () => {
  const phases = ['connecting', 'ready', 'reconnecting', 'needs-update', 'missing', 'failed'] as const satisfies readonly Exclude<HerdrState['phase'], 'stopped'>[];
  const sentences = new Set<string>();
  for (const phase of phases) {
    const s = stateWords({ phase });
    assert.ok(s.length > 0, phase);
    assert.doesNotMatch(s, /\{|\}/, phase);
    sentences.add(s);
  }
  assert.equal(sentences.size, phases.length, 'no two phases share a sentence');
  assert.equal(stateWords({ phase: 'stopped' }), '');
  assert.equal(stateWords({ phase: 'failed', why: 'server-exited' }), "Herdr couldn't start on this computer. Restart the app to try again.");
});

test('every AgentStatus has a sentence, and launching starts from agent.starting (6.9)', () => {
  const statuses = ['idle', 'working', 'blocked', 'done', 'unknown'] as const satisfies readonly AgentStatus[];
  const sentences = new Set<string>();
  for (const s of statuses) {
    const w = agentWords(s);
    assert.ok(w.length > 0, s);
    assert.doesNotMatch(w, /\{|\}/, s);
    sentences.add(w);
  }
  assert.equal(sentences.size, statuses.length, 'no two statuses share a sentence');
  assert.equal(agentWords('starting'), 'Starting…');
});

test('stateWords and agentWords keep their frozen helper signatures (6.2 words.ts seam)', () => {
  const stateFn: (s: HerdrState) => string = stateWords;
  const agentFn: (s: AgentStatus | 'starting') => string = agentWords;
  const keyFn: (k: WordKey, vars?: Record<string, string>) => string = words;
  assert.equal(stateFn({ phase: 'ready' }), keyFn('herdr.ready'));
  assert.equal(agentFn('unknown'), keyFn('agent.unknown'));
});
