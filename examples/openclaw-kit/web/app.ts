// The phone side: pair with the computer, sign in with ChatGPT there (a device code typed on ChatGPT's own page), send
// the helper a message and watch its reply arrive, and allow or deny what it asks first. Plain DOM; every status a
// person reads is a sentence from @byokit/openclaw's or @byokit/ui-core's words.
import { DeviceLink, browserDeviceStore, normalizeCode, pairWithCode, pairWithOffer, type DeviceGrant, type KeptDevice } from '@byokit/link';
import { openclawDevice, words, type AccountView, type Approval, type RunEnd } from '@byokit/openclaw/device';
import { phaseOf } from '@byokit/ui-core';
import { consentWords, linkWords, pairingView, type PairPhase } from '@byokit/ui-core/link';

type Device = ReturnType<typeof openclawDevice>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};
const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The pairing is sealed in IndexedDB with a key no script can read out, which needs a secure page (https, or this
// computer). A page over plain http from the home network isn't one; there the pairing is kept unsealed, which
// costs nothing more: whoever can change that network's traffic could change this page's code anyway.
const store: KeptDevice = globalThis.isSecureContext ? browserDeviceStore('openclaw-kit') : {
  load: async () => JSON.parse(localStorage.getItem('openclaw-kit') ?? 'null') as DeviceGrant | null,
  save: (g) => localStorage.setItem('openclaw-kit', JSON.stringify(g)),
  clear: () => localStorage.removeItem('openclaw-kit'),
};
// Who answers, as a person knows it, and the account this app signs in with.
const NAME = 'ChatGPT';
const PROVIDER = 'openai';
// This phone's conversation. The computer runs everything for its one member, `me` (host.ts), and a device may only
// use that member's sessions, so the key starts `agent:me:`.
const SESSION = 'agent:me:phone';

// ---- Pairing ----

function showPair(phase: PairPhase, o: { words?: string; error?: string; hostName?: string } = {}) {
  $('home').hidden = true;
  $('forget').hidden = true;
  $('pair').hidden = false;
  const view = pairingView({ phase, ...o });
  $('pair-title').textContent = view.title;
  $('pair-words').hidden = !view.words;
  $('pair-words').textContent = view.words ?? '';
  $('pair-form').hidden = phase === 'compare' || phase === 'waiting';
  $('pair-error').textContent = phase === 'failed' ? view.title : '';
  if (phase === 'failed') $('pair-title').textContent = pairingView({ phase: 'scan', hostName: o.hostName }).title;
}

// A scanned QR opens this page with the offer after `#`; it never reaches a server. Ask before using it.
const offered = location.hash.includes('byokit-link:1:') ? location.hash.slice(1) : '';
history.replaceState(null, '', location.pathname);

const deviceName = () => (/iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad'
  : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Browser');

$('pair-form').onsubmit = async (e) => {
  e.preventDefault();
  const typed = ($('pair-input') as HTMLInputElement).value.trim();
  if (!typed) return;
  $<HTMLButtonElement>('pair-go').disabled = true;
  const options = { name: deviceName(), onWords: (words: string) => showPair('compare', { words }) };
  try {
    const here = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`;
    const grant = normalizeCode(typed) ? await pairWithCode(here, typed, options) : await pairWithOffer(typed, options);
    await store.save(grant);
    connect(grant);
  } catch (err) {
    showPair('failed', { error: said(err) });
  } finally {
    $<HTMLButtonElement>('pair-go').disabled = false;
  }
};

// ---- Paired ----

let oc: Device;
let link: DeviceLink;
let paired = 0; // which pairing the loops below belong to; a new one (or forgetting) ends the old loops

function connect(grant: DeviceGrant) {
  $('pair').hidden = true;
  $('home').hidden = false;
  $('forget').hidden = false;
  const mine = ++paired;
  link = new DeviceLink(grant, {
    store,
    onStatus: (s) => {
      $('link').textContent = linkWords(s, grant.hostName);
      if (s === 'online') void refresh();
      if (s === 'removed') { paired++; void store.clear(); showPair('scan'); }
    },
  });
  $('link').textContent = linkWords(link.status, grant.hostName);
  oc = openclawDevice(link);
  void followApprovals(mine);
}

// The engine's own sentence, then (once it is ready) whether this plan is signed in. One ask at a time, asked again
// every second while the engine is still getting ready or a sign-in is under way.
let timer: ReturnType<typeof setTimeout> | undefined;
let asking = false;
let askAgain = false;
async function refresh() {
  if (asking) { askAgain = true; return; }
  asking = true;
  clearTimeout(timer);
  const mine = paired;
  let poll = true;
  try {
    const { state, words: now } = await oc.state();
    $('engine').textContent = now;
    if (state.phase === 'ready') poll = drawAccount(await oc.signIn.view(PROVIDER));
  } catch { /* the link line says why */ }
  asking = false;
  if (mine !== paired) return;
  if (askAgain) { askAgain = false; void refresh(); } else if (poll) timer = setTimeout(() => void refresh(), 1000);
}

/** Draws the sign-in card or the message box; true while the sign-in is still moving. */
function drawAccount(view: AccountView): boolean {
  const phase = phaseOf(view);
  const moving = view.signIn?.state === 'waiting';
  const finishing = view.signIn?.state === 'done' && !view.ready; // signed in, and the engine is still saying so
  $('signin').hidden = phase === 'done';
  $('talk').hidden = phase !== 'done';
  if (phase === 'done') return false;
  $('signin-code').hidden = phase !== 'code';
  $('signin-code').textContent = view.signIn?.code ?? '';
  $('signin-where').hidden = !view.signIn?.url;
  $<HTMLAnchorElement>('signin-url').href = view.signIn?.url ?? '';
  $('signin-url').textContent = view.signIn?.url ? `Open the ${NAME} page` : '';
  $('signin-go').hidden = moving || finishing;
  $('signin-cancel').hidden = !moving;
  $('signin-title').textContent = !view.signIn ? words('member.signedOut', { name: NAME })
    : phase === 'code' ? `On the ${NAME} page, type this code:`
    : phase === 'busy' ? words('signin.busy')
    : phase === 'expired' ? words('signin.expired')
    : phase === 'failed' ? view.signIn.error ?? words('member.signedOut', { name: NAME })
    : phase === 'cancelled' ? words('member.signedOut', { name: NAME })
    : `Opening ${NAME}…`;
  return moving || finishing;
}

$('signin-go').onclick = async () => {
  $<HTMLButtonElement>('signin-go').disabled = true;
  try { await oc.signIn.start(PROVIDER, 'code'); } catch (err) { $('signin-title').textContent = said(err); }
  $<HTMLButtonElement>('signin-go').disabled = false;
  void refresh();
};
$('signin-cancel').onclick = async () => {
  try { await oc.signIn.cancel(PROVIDER); } catch { /* the link line says why */ }
  void refresh();
};
$('signout').onclick = async () => {
  try { await oc.signOut(PROVIDER); } catch (err) { $('run-said').textContent = said(err); }
  void refresh();
};

// ---- A run ----

const END_WORDS = { 'signed-out': 'member.signedOut', resting: 'member.resting', plan: 'member.plan', network: 'member.network' } as const;
function endWords(end: RunEnd): string {
  if (end.ok) return '';
  if ('aborted' in end) return 'Stopped.';
  if (end.kind === 'other') return end.message;
  const time = end.until === undefined ? 'later' : new Date(end.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return words(END_WORDS[end.kind], { name: NAME, time });
}

$('run-form').onsubmit = async (e) => {
  e.preventDefault();
  const box = $<HTMLTextAreaElement>('message');
  const text = box.value.trim();
  if (!text) return;
  $<HTMLButtonElement>('send').disabled = true;
  $('stop').hidden = false;
  $('reply').textContent = '';
  $('run-said').textContent = '';
  $('tool').textContent = '';
  try {
    for await (const frame of oc.run(text, { sessionKey: SESSION })) {
      if (frame.type === 'text') $('reply').textContent = frame.text;
      else if (frame.type === 'tool') $('tool').textContent = frame.phase === 'start' ? `Using ${frame.name.replaceAll('_', ' ')}…` : '';
      else {
        if (frame.end.ok) { $('reply').textContent = frame.end.text || $('reply').textContent; box.value = ''; }
        $('run-said').textContent = endWords(frame.end);
        if (!frame.end.ok && 'kind' in frame.end && frame.end.kind === 'signed-out') void refresh();
      }
    }
  } catch (err) {
    $('run-said').textContent = said(err);
  } finally {
    $('tool').textContent = '';
    $('stop').hidden = true;
    $<HTMLButtonElement>('send').disabled = false;
  }
};
$('stop').onclick = () => { void oc.abort(SESSION).catch(() => {}); };

// ---- What waits for a yes ----

// Listed once the event stream is open (so nothing falls between the two), then listed again on every approval
// added or answered anywhere. The stream ends whenever the link drops; it opens again a moment later.
async function followApprovals(mine: number) {
  while (mine === paired) {
    const it = oc.events()[Symbol.asyncIterator]();
    try {
      const first = it.next();
      first.catch(() => {});
      drawApprovals(await oc.approvals());
      for (let r = await first; !r.done && mine === paired; r = await it.next()) {
        if (r.value.event === 'approval') drawApprovals(await oc.approvals());
      }
    } catch { /* the link line says why */ } finally {
      void it.return?.();
    }
    await sleep(1000);
  }
}

// A decision that didn't go through stays said on its approval until one does (the list redraws often).
const decideErrors = new Map<string, string>();
function drawApprovals(list: Approval[]) {
  for (const id of decideErrors.keys()) if (!list.some((a) => a.id === id)) decideErrors.delete(id);
  $('approvals-box').hidden = list.length === 0;
  $('approvals').replaceChildren(...list.map((a) => {
    const question = words('approval.ask', { helper: 'Your helper', summary: a.summary });
    const note = el('p', { className: 'error', role: 'alert', textContent: decideErrors.get(a.id) ?? '' } as Partial<HTMLParagraphElement>);
    const choice = (label: string, allow: boolean) => {
      const button = el('button', { type: 'button', className: allow ? 'allow' : '', textContent: label, onclick: async () => {
        for (const b of buttons) b.disabled = true;
        try { await oc.decide(a.id, { allow }); decideErrors.delete(a.id); }
        catch (e) { decideErrors.set(a.id, said(e)); note.textContent = said(e); for (const b of buttons) b.disabled = false; }
      } });
      button.setAttribute('aria-label', `${label}: ${question}`);
      return button;
    };
    const buttons = [choice('Allow', true), choice('Deny', false)];
    const item = el('li', { className: 'card approval' }, el('p', { textContent: question }), el('div', { className: 'choices' }, ...buttons), note);
    item.dataset.id = a.id;
    return item;
  }));
}

$('forget').onclick = async () => {
  paired++;
  try { await link.unpair(); } catch { link.stop(); await store.clear(); }
  showPair('scan');
};

// ---- Start ----

const kept = await store.load();
if (kept) connect(kept);
else {
  showPair('scan');
  if (offered) {
    ($('pair-input') as HTMLInputElement).value = offered;
    try {
      const offer = JSON.parse(atob(offered.split('byokit-link:1:')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { name?: string; role?: 'control' | 'view' };
      $('pair-title').textContent = consentWords({ hostName: offer.name || 'your computer', role: offer.role ?? 'view' });
    } catch { /* pairing itself says what's wrong with it */ }
  }
}
