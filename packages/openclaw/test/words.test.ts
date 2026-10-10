// O10 acceptance (docs/runtime-kits.md 5.14, O10): the 5.14 table verbatim, plain words only (4.3), every
// KitState.phase covered, and toAccountView flowing through ui-core's phaseOf unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseOf, type AccountView as UiCoreAccountView } from '@byokit/ui-core';
import { stateWords, toAccountView, words, type WordKey } from '../src/words.ts';
import type { KitState, SignInView } from '../src/types.ts';
import wordsJson from '../src/words.json' with { type: 'json' };

// 5.14, 5.15 and 5.17's tables, verbatim — the data file and this copy must stay identical.
const TABLE: Record<string, string> = {
  'engine.installing': 'Getting things ready on this computer. The first time takes a few minutes.',
  'engine.starting': 'Starting up…',
  'engine.repairing': 'Fixing a small problem with the setup. This takes a moment.',
  'engine.locked': 'Your saved sign-in is locked. Unlock your password storage, then try again.',
  'engine.authStoreUnreadable': "Your saved sign-in couldn't be opened. It is unchanged. Restore its original key or a working backup, then retry.",
  'engine.authStoreSealSize': '{store} is too large to keep safely (more than {size} MB; the limit is {limit} MB). Your sign-ins were kept.',
  'engine.store.engineData': 'Engine data {file}',
  'engine.store.savedSignIn': 'Your saved sign-in data',
  'engine.signInAgain': "Your saved sign-in couldn't be opened, so it was kept aside. Sign in again.",
  'engine.ready': 'Ready.',
  'engine.restarting': 'Something stopped. Starting it again by itself.',
  'engine.alreadyRunning': 'Your saved sign-in is in use. Try again after the other session stops.',
  'engine.failed': "This computer couldn't start the helper. Restart the app to try again.",
  'engine.needsUpdate': 'This app needs an update to keep working.',
  'member.signedOut': 'Sign in with {name} to start.',
  'member.resting': '{name} needs a break until {time}.',
  'member.plan': "Your {name} plan doesn't include this.",
  'member.output': 'The answer did not match the requested format.',
  'member.network': "Can't reach {name} right now. This keeps trying by itself.",
  'signin.returned': 'Thanks. Finishing the sign-in — you can go back to the app now.',
  'signin.busy': 'Another sign-in is already in progress. Finish or cancel it, then try again.',
  'signin.cancelled': 'Sign-in cancelled. You can start again whenever you are ready.',
  'signin.expired': 'The sign-in took too long. Start it again.',
  'signin.title': 'Sign in to {site}',
  'signin.takeover': 'Take over to sign in',
  'signin.notNow': 'Not now',
  'signin.cancel': 'Cancel sign-in',
  'signin.reopen': 'Continue signing in',
  'signin.retry': 'Try signing in again',
  'signin.confirmOrigin': 'Continue on {origin}',
  'signin.done': 'Done signing in',
  'signin.confirmSite': 'First time {name} signs in to {site}. Type the site name to continue.',
  'signin.offOrigin': "You're now on {origin}, not {site}. Continue only if you expected this.",
  'signin.agentNote': '{name} says: “{note}”',
  'signin.waiting': '{name} needs you to sign in to {site}.',
  'signin.parked': 'Sign-in to {site} is waiting for you.',
  'signin.checking': 'Sign-in details entered',
  'signin.verified': 'Signed in to {site}',
  'signin.stillSignedOut': '{site} still shows a sign-in page. Try again?',
  'browser.signin.expired': 'The sign-in request for {site} timed out.',
  'browser.signin.cancelled': 'Sign-in to {site} was cancelled.',
  'browser.signin.notice': 'A browser sign-in is waiting for you.',
  'signin.originMismatch': "You finished on a different site than {site}, so {name} won't continue.",
  'signin.browserGone': "{name}'s browser closed during sign-in.",
  'signin.superseded': 'A newer request replaced this one.',
  'signin.runReplaced': 'This task moved on, so the sign-in request was closed.',
  'signin.resumeFailed': "Signed in, but {name} couldn't continue. Try again.",
  'signin.resumeUnknown': "Signed in, but we can't tell whether {name} continued. Check the task before retrying.",
  'signin.noVerifier': "Sign-in details entered for {site}. {name} can't confirm you're signed in.",
  'signin.insecureRemote': "{site} isn't secure, so taking over to sign in is off.",
  'signin.gate': 'Waiting for the person to sign in to {site}.',
  'signin.resume': 'The person signed in to {site}. Continue the task.',
  'signin.private': 'Private while someone signs in',
  'browser.recovering': "Reconnecting to {name}'s browser…",
  'browser.blocked.noBrowser': 'No browser is set up for {name}.',
  'browser.blocked.exhausted': "{name}'s browser stopped and could not be restarted.",
  'browser.blocked.detached': "{name}'s browser isn't connected.",
  'browser.blocked.unsafe': 'An agent here can run commands or read files, so the browser stays off.',
  'browser.blocked.gateOff': 'Browser handoff needs the tool gate on.',
  'browser.blocked.unprotected': "Signing in for {name} isn't available yet.",
  'live.reconnecting': 'Reconnecting…',
  'live.browser': 'Browser live view',
  'live.label': 'Browser live view',
  'live.ended': 'Browser live view ended.',
  'live.failed': "Browser live view couldn't connect.",
  'approval.ask': '{helper} wants to {summary}. Allow it?',
  'approval.expired': "Nobody answered in time, so this wasn't allowed.",
  'approval.notice': 'Something is waiting for your yes.',
  'link.notAllowed': "This device can't do that. Ask the person at the computer.",
  'key.label': 'API key (billed per use)',
  'key.entry': 'Paste your API key. You pay the provider for each use.',
  'key.checking': 'Checking your key…',
  'key.ok': 'Your key is ready. Use it only when you choose this option.',
  'key.invalid': 'This key could not be saved. Check it and try again.',
  'key.notIncluded': 'This option is not available here.',
  'key.missing': 'Add an API key to use this option.',
  'auto.room': "Right now that's {name}: {room}",
  'auto.unknown': "Right now that's {name} (no recent reading)",
  'auto.refills': 'All {provider} accounts are out of room until {time}. {name} refills first.',
  'auto.refillsNoTime': 'All {provider} accounts are out of room. {name} refills first.',
  'auto.terms': "Auto may use either of a provider's accounts.",
  'auto.none': 'No signed-in {provider} account.',
  'room.unknown': 'Room left unknown',
  'room.session': '{left} left this session',
  'room.week': '{left} left this week',
  'room.month': '{left} left this month',
  'room.tightest': '{left} left for now',
  'pick.out.state': 'Not signed in right now',
  'pick.out.resting': 'Taking a break until {time}',
  'pick.out.billing': 'Billed per use, so used only when you choose it',
  'pick.out.model': "Doesn't include {model}",
  'pick.out.provider': 'A different service',
  'pick.out.bound': 'This conversation uses another account',
  'pick.why.chosen': 'You chose {name}.',
  'pick.why.default': '{name} is your default.',
  'pick.why.first_ready': "Your default isn't ready, so {name}, the first ready account.",
  'pick.why.only': '{name} is the only account that can take this.',
  'pick.why.most_room': '{name} has the most room left.',
  'pick.why.earlier_reset': '{name} has as much room left and refills sooner.',
  'pick.why.list_order': '{name} is tied for room and comes first in your list.',
  'pick.why.no_reading': 'No account has a recent reading, so {name}, first in your list.',
  'pick.why.refills_first': 'All accounts are out of room; {name} refills first.',
  'pick.age': 'Read {ago} ago',
  'pick.ageUnknown': 'Reading time unknown',
  'ago.minutes': '{n} min',
  'ago.hours': '{n} h',
  'account.bound': 'This conversation uses {name}. Move it to switch accounts.',
  'account.paid': 'This conversation uses {name}, which is billed per use. Choose {name} to keep going.',
  'account.signOutFirst': 'To add a different {provider} account, sign out of {provider} in your browser first.',
  'account.legacyMember': 'This person needs a new profile before adding more accounts.',
};

test('every 5.14/5.15/5.17 key is present with the exact sentence, and nothing else', () => {
  assert.deepEqual(Object.keys(wordsJson).sort(), Object.keys(TABLE).sort());
  for (const [key, sentence] of Object.entries(TABLE)) assert.equal(words(key as WordKey), sentence, key);
});

test('plain words only: no codes, commands, paths, model ids or jargon a person would have to look up (4.3)', () => {
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [key, sentence] of Object.entries(TABLE)) assert.doesNotMatch(sentence.replace(/\{\w+\}/g, 'X')
    .replace(key.startsWith('key.') ? /API key/g : /$^/, 'key'), banned, key);
});

test('words fills {name}, {time}, {helper}, {summary} and leaves placeholders it is not given', () => {
  assert.equal(words('member.signedOut', { name: 'ChatGPT' }), 'Sign in with ChatGPT to start.');
  assert.equal(words('member.resting', { name: 'Claude', time: '3 pm' }), 'Claude needs a break until 3 pm.');
  assert.equal(words('approval.ask', { helper: 'The helper', summary: 'read a file' }), 'The helper wants to read a file. Allow it?');
  assert.equal(words('member.network', {}), "Can't reach {name} right now. This keeps trying by itself.");
});

test('every KitState.phase a person can see has its sentence; stopped is never on screen', () => {
  const at = (phase: KitState['phase']): string => stateWords({ phase });
  assert.equal(at('installing'), TABLE['engine.installing']);
  assert.equal(at('starting'), TABLE['engine.starting']);
  assert.equal(at('repairing'), TABLE['engine.repairing']);
  assert.equal(at('ready'), TABLE['engine.ready']);
  assert.equal(at('restarting'), TABLE['engine.restarting']);
  assert.equal(at('failed'), TABLE['engine.failed']);
  assert.equal(stateWords({ phase: 'failed', why: 'engine-already-running' }), TABLE['engine.alreadyRunning']);
  assert.equal(at('needs-update'), TABLE['engine.needsUpdate']);
  assert.equal(at('locked'), TABLE['engine.locked']);
  assert.equal(at('stopped'), '');
});

test('toAccountView is assignable to ui-core AccountView and phaseOf reads it unchanged (5.14)', () => {
  const view = (v: SignInView | null, ready = false): UiCoreAccountView => toAccountView(v, ready); // the type test
  assert.equal(phaseOf(view({ state: 'waiting', via: 'browser', url: 'https://example/yes' })), 'waiting');
  assert.equal(phaseOf(view({ state: 'waiting', via: 'code', code: 'ABCD-1234' })), 'code');
  assert.equal(phaseOf(view({ state: 'waiting', via: 'code' })), 'opening');
  assert.equal(phaseOf(view(null, true)), 'done');
  assert.equal(phaseOf(view({ state: 'done', via: 'browser' }, true)), 'done');
  assert.equal(phaseOf(view(null, false)), 'opening');
  assert.equal(phaseOf(view({ state: 'failed', via: 'code', why: 'busy' })), 'busy');
  assert.equal(phaseOf(view({ state: 'failed', via: 'code', why: 'declined' })), 'cancelled');
  assert.equal(phaseOf(view({ state: 'failed', via: 'code', why: 'expired' })), 'expired');
  assert.equal(phaseOf(view({ state: 'failed', via: 'code', why: 'failed', error: 'no' })), 'failed');
});
