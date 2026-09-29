// M1 acceptance (docs/machine-kit.md 13.2/13.3): section 12 verbatim in the same key order as
// words.json, the jargon expression, a sentence for every MachineState and HostState, and
// unfilled slots staying visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, words, stateWords, hostWords, type WordKey } from '../src/words.ts';
import type { HostState, MachineState } from '../src/types.ts';

// §12 table, byte for byte: ASCII apostrophes, U+2026 ellipsis, exactly as the spec table spells them.
const TABLE: readonly (readonly [WordKey, string])[] = [
  ['state.creating', 'Setting up your cloud computer. This takes a minute or two.'],
  ['state.on', 'Your cloud computer is on.'],
  ['state.waking', 'Waking your cloud computer. This takes a few seconds.'],
  ['state.asleep', 'Your cloud computer is asleep. Opening {app} wakes it.'],
  ['state.stopping', 'Your cloud computer is going to sleep.'],
  ['state.unknown', "Can't reach your cloud computer right now."],
  ['state.failed', '{label} reports a problem with your cloud computer.'],
  ['state.host-key-changed', "Your cloud computer's identity changed. Check with {label} before connecting again."],
  ['state.gone', 'This cloud computer was deleted.'],
  ['asleep.you', 'Your cloud computer is asleep because you put it to sleep. Opening {app} wakes it.'],
  ['asleep.out-of-credit', 'Your {label} balance ran out, so {label} switched your cloud computer off. Add funds, then open {app} to turn it back on.'],
  ['asleep.trial-limit', '{label} switched your cloud computer off, as it does every 2 hours during the free trial. Opening {app} turns it back on.'],
  ['asleep.provider', '{label} switched your cloud computer off. Opening {app} turns it back on.'],
  ['asleep.idle', 'Your cloud computer went to sleep because nobody was using it. Opening {app} wakes it.'],
  ['plan.trial', 'Your first week is a free trial, and {label} switches your cloud computer off every 2 hours during it. Opening {app} turns it back on. After the trial it stays on.'],
  ['setup.makeKey', 'Make a key on the {label} site, then paste it here.'],
  ['setup.typeCode', 'Open the {label} page and type this code: {code}'],
  ['host.not-installed', "{app} isn't on your cloud computer yet."],
  ['host.installing', 'Putting {app} on your cloud computer…'],
  ['host.running', '{app} is running on your cloud computer.'],
  ['host.restarting', '{app} stopped on your cloud computer. Restarting it.'],
  ['host.stopped', '{app} is stopped on your cloud computer.'],
  ['host.failed', '{app} keeps stopping on your cloud computer.'],
  ['host.needsRoot', "{app} needs a few setup steps that only your cloud computer's owner can run. Run the lines below on it once, then try again."],
  ['host.needsAdmin', "{app} needs admin rights on your cloud computer. Sign in to it with a login that has them."],
  ['host.linger', "{app} won't start again by itself when your cloud computer restarts. Run the line below on it once to allow that."],
  ['cost.sandbox', "About {amount} a month, billed by {label} to your own account. {app} doesn't charge for this."],
  ['cost.vm', '{amount} a month, the price you told us {label} charges you.'],
  ['cost.balance', 'Your {label} balance ran out. Your cloud computer stops in a day unless you add funds.'],
  ['cost.checked', 'Price last checked {date}.'],
  ['error.key', "{label} didn't accept your key. Make a new one and try again."],
  ['error.slow', 'Your cloud computer took too long to answer. Try again.'],
  ['error.notLinux', "This cloud computer can't run {app}. It needs a standard Linux setup."],
  ['error.wrongAccount', "This cloud computer belongs to a different {label} account than the one {app} is using."],
  ['error.app', "{app} hit a problem with your cloud computer. Try again, or ask for help."],
  ['key.expiring', 'Your {label} key expires on {date}. Make a new one to keep your cloud computer working.'],
  ['copies.on', "{label} keeps copies of your cloud computer's disk, including your sign-ins, so it can wake where it left off. Your {label} account details may be handled in the United States."],
];

test('words.json is the section 12 table verbatim — same keys, same order, same sentences', () => {
  assert.deepEqual(Object.keys(WORDS), TABLE.map(([k]) => k));
  for (const [k, sentence] of TABLE) assert.equal(WORDS[k], sentence, k);
});

test('plain words only: no codes, commands, paths, model ids or jargon a person would have to look up (12)', () => {
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w.replace(/\{\w+\}/g, 'X'), banned, k);
  assert.equal(words('setup.typeCode', { label: 'L' }), 'Open the L page and type this code: {code}');
  assert.equal(words('setup.typeCode', {}), 'Open the {label} page and type this code: {code}', 'unfilled slots stay visible');
});

test('every MachineState has a sentence', () => {
  const states = ['creating', 'on', 'asleep', 'waking', 'stopping', 'unknown', 'failed', 'host-key-changed', 'gone'] as const satisfies readonly MachineState[];
  const sentences = new Set<string>();
  for (const s of states) {
    const w = stateWords(s, { app: 'App', label: 'Label' });
    assert.ok(w.length > 0, s);
    assert.doesNotMatch(w, /\{|\}/, s);
    sentences.add(w);
  }
  assert.equal(sentences.size, states.length, 'no two states share a sentence');
});

test('every HostState has a sentence', () => {
  const states = ['not-installed', 'installing', 'running', 'restarting', 'stopped', 'failed'] as const satisfies readonly HostState[];
  const sentences = new Set<string>();
  for (const s of states) {
    const w = hostWords(s, { app: 'App' });
    assert.ok(w.length > 0, s);
    assert.doesNotMatch(w, /\{|\}/, s);
    sentences.add(w);
  }
  assert.equal(sentences.size, states.length, 'no two states share a sentence');
});
