// The phone side: pair with the computer, then see its Herdr agents, start one, talk to it and answer its questions.
// Plain DOM over @byokit/ui's view state (the live tree and questions); every status a person reads is a sentence
// from @byokit/herdr's or @byokit/ui's words.
import { DeviceLink, browserDeviceStore, normalizeCode, pairWithCode, pairWithOffer, type DeviceGrant, type KeptDevice } from '@byokit/pair';
import { agentWords, herdrDevice } from '@byokit/herdr/device';
import { consentWords, linkWords, pairErrorWords, pairingView, type PairPhase } from '@byokit/ui/link';
import { connectedWords } from '@byokit/ui/route';
import { HERDR_EMPTY, agentIn, blockedView, herdrStore, herdrTreeView, type HerdrState } from '@byokit/ui/kits';

type Device = ReturnType<typeof herdrDevice>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};
const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
// The pairing is sealed in IndexedDB with a key no script can read out, which needs a secure page (https, or this
// computer). A page over plain http from the home network isn't one; there the pairing is kept unsealed, which
// costs nothing more: whoever can change that network's traffic could change this page's code anyway.
const store: KeptDevice = globalThis.isSecureContext ? browserDeviceStore('herdr-kit') : {
  load: async () => JSON.parse(localStorage.getItem('herdr-kit') ?? 'null') as DeviceGrant | null,
  save: (g) => localStorage.setItem('herdr-kit', JSON.stringify(g)),
  clear: () => localStorage.removeItem('herdr-kit'),
};
// Keys Herdr sends to the pane exactly as named; the labels are what a person reads.
const KEYS: [label: string, key: string][] = [['Allow', 'y'], ['Deny', 'n'], ['Skip', 'Escape']];
// Plain words for an agent's kind ('pi' is what the computer calls it, 'Pi' is what a person reads).
const plainKind = (kind?: string) => (kind ? kind[0].toUpperCase() + kind.slice(1) : 'Agent');
// A badge names a state, so it reads without the sentence's full stop ('Ready for you', not 'Ready for you.').
const badge = (s: Parameters<typeof agentWords>[0]) => agentWords(s).replace(/\.$/, '');

// ---- Pairing ----

function showPair(phase: PairPhase, o: { words?: string; error?: string; hostName?: string } = {}) {
  $('home').hidden = true;
  $('menu').hidden = true;
  $('pair').hidden = false;
  const view = pairingView({ phase, ...o });
  $('pair-title').textContent = view.title;
  $('pair-words').hidden = !view.words;
  $('pair-words').textContent = view.words ?? '';
  $('pair-form').hidden = phase === 'compare' || phase === 'waiting';
  if (phase === 'failed') {
    // Back to the code entry, with the failure in plain words under it: a run-out code says to get a new one,
    // a mismatch says to check and retry.
    $('pair-title').textContent = pairingView({ phase: 'scan', hostName: o.hostName }).title;
    $('pair-error').textContent = pairErrorWords(o.error ?? '').words;
  } else {
    $('pair-error').textContent = '';
  }
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
  let words: string | undefined;
  const options = { name: deviceName(), onWords: (w: string) => { words = w; showPair('compare', { words: w }); } };
  // The words match; the computer hasn't said yes yet: say who is being waited on.
  const waiter = setTimeout(() => { if (words) showPair('waiting', { words }); }, 2500);
  try {
    const here = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`;
    const grant = normalizeCode(typed) ? await pairWithCode(here, typed, options) : await pairWithOffer(typed, options);
    await store.save(grant);
    connect(grant);
  } catch (err) {
    showPair('failed', { error: said(err) });
  } finally {
    clearTimeout(waiter);
    $<HTMLButtonElement>('pair-go').disabled = false;
  }
};

// ---- Paired ----

let hd: Device;
let link: DeviceLink;
let host = 'your computer';
let view: HerdrState = HERDR_EMPTY;
let unwatch: (() => void) | undefined;
let selected: string | undefined;

function connect(grant: DeviceGrant) {
  $('pair').hidden = true;
  $('home').hidden = false;
  $('menu').hidden = false;
  host = grant.hostName || 'your computer';
  link = new DeviceLink(grant, {
    store,
    onStatus: (s) => {
      // Online names the route just dialled (`Connected to Kitchen computer - same Wi-Fi.`); every other status
      // stays the link's own sentence. The grant keeps what worked first, so the route never contradicts it.
      $('link').textContent = s === 'online' ? connectedWords(host, link.grant.urls[0]) : linkWords(s, host);
      if (s === 'online') online();
      if (s === 'removed') { unwatch?.(); unwatch = undefined; void store.clear(); showPair('scan'); }
    },
  });
  $('link').textContent = link.status === 'online' ? connectedWords(host, link.grant.urls[0]) : linkWords(link.status, host);
  hd = herdrDevice(link);
  // The agents and their questions, live: the store keeps the tree and the waiting list current from the kit's
  // events, and follows them again whenever the link comes back.
  unwatch?.();
  unwatch = herdrStore(hd).subscribe((s) => {
    view = s;
    drawTree();
    drawBlocked();
    if (!$<HTMLSelectElement>('kind').options.length) setup().catch(() => {}); // Herdr was still starting
    void refresh();
  });
}

function online() {
  setup().catch(() => {});
  void refresh();
}

async function setup() {
  const { kinds, folder } = await link.request('example.setup') as { kinds: string[]; folder: string };
  const pick = $<HTMLSelectElement>('kind');
  pick.replaceChildren(...kinds.map((k) => el('option', { value: k, textContent: plainKind(k) })))
  const where = $<HTMLInputElement>('folder');
  if (!where.value) where.value = folder;
}

// One refresh at a time; a change during one runs one more after it.
let refreshing: Promise<void> | undefined;
let again = false;
function refresh(): Promise<void> {
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    try {
      await drawAgent();
    } catch { /* the link line says why */ }
  })().finally(() => { refreshing = undefined; if (again) { again = false; void refresh(); } });
  return refreshing;
}

// Every row leads with the folder and names the agent second — folder, kind — and no two rows read the same: a
// second agent that would read alike gets a number. Tab labels stay inside the computer; a person never reads them.
function distinctMains(groups: { project: string; agents: { paneId: string; name: string; kind?: string }[] }[]) {
  const seen = new Map<string, number>();
  return new Map(groups.flatMap((g) => g.agents.map((a) => {
    // A name someone gave the agent reads as is; otherwise the kind in plain words ('pi' reads 'Pi').
    const base = a.name && a.name !== a.kind ? a.name : plainKind(a.kind);
    const n = (seen.get(`${g.project} ${base}`) ?? 0) + 1;
    seen.set(`${g.project} ${base}`, n);
    return [a.paneId, n > 1 ? `${base} ${n}` : base] as [string, string];
  })));
}

function drawTree() {
  if (!view.tree) return; // the computer hasn't said yet
  const groups = herdrTreeView(view.tree);
  selected ??= groups[0]?.agents[0]?.paneId; // a just-started agent stays picked until the tree has it
  const mains = distinctMains(groups);
  const rows = groups.flatMap((g) => g.agents.map((a) => ({ g, a })));
  $('tree').replaceChildren(...(rows.length ? [el('ul', {}, ...rows.map(({ g, a }) => {
    const main = mains.get(a.paneId) ?? plainKind(a.kind);
    const sub = `${main} · ${host}`;
    const status = badge(a.status);
    const button = el('button', { className: 'agent', type: 'button', onclick: () => { selected = a.paneId; drawTree(); void drawAgent(); } },
      el('span', { className: 'id' },
        el('span', { className: 'who', textContent: g.project }),
        el('span', { className: 'sub', textContent: sub })),
      el('span', { className: `pill ${a.status}`, textContent: status }));
    button.setAttribute('aria-pressed', String(a.paneId === selected));
    button.setAttribute('aria-label', `${g.project}, ${main}, ${host}, ${status}`);
    button.dataset.pane = a.paneId;
    return el('li', {}, button);
  }))] : [el('p', { className: 'empty', textContent: 'No agents yet. Start one below.' })]));
  const agent = agentIn(view.tree, selected);
  $('agent').hidden = !agent;
  if (agent) {
    const main = mains.get(agent.paneId) ?? plainKind(agent.kind);
    const where = groups.find((g) => g.agents.some((x) => x.paneId === agent.paneId))?.project;
    $('agent-name').textContent = where ? `${where} · ${main}` : `${main} · ${host}`;
    $('agent-status').className = `pill ${agent.status}`;
    $('agent-status').textContent = badge(agent.status);
  }
}

async function drawAgent() {
  const paneId = selected;
  if (!paneId || !agentIn(view.tree, paneId)) return;
  const { text } = await hd.read(paneId, { source: 'recent', lines: 60 });
  if (paneId !== selected) return;
  const screen = $('screen');
  const atEnd = screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 4;
  screen.textContent = text.trimEnd();
  if (atEnd) screen.scrollTop = screen.scrollHeight;
}

// An answer that didn't go through stays said on its question until an answer does (the list redraws often).
const answerErrors = new Map<string, string>();
function drawBlocked() {
  const list = blockedView(view);
  for (const pane of answerErrors.keys()) if (!list.some((b) => b.paneId === pane)) answerErrors.delete(pane);
  const groups = view.tree ? herdrTreeView(view.tree) : [];
  const mains = distinctMains(groups);
  const projectOf = (paneId: string) => groups.find((g) => g.agents.some((a) => a.paneId === paneId))?.project;
  $('questions').hidden = list.length === 0;
  $('blocked').replaceChildren(...list.map((b) => {
    const main = mains.get(b.paneId) ?? (b.kind ? plainKind(b.kind) : 'Agent');
    const where = projectOf(b.paneId);
    // The card names its agent once, folder first; the computer is the link line above, not repeated here.
    const who = where ? `${where} · ${main}` : `${main} · ${host}`;
    const note = el('p', { className: 'error', role: 'alert', textContent: answerErrors.get(b.paneId) ?? '' } as Partial<HTMLParagraphElement>);
    const keys = KEYS.map(([label, key]) => {
      const button = el('button', { type: 'button', textContent: label, onclick: async () => {
        for (const k of keys) k.disabled = true;
        try { await hd.answer(b.paneId, [key], b.revision); answerErrors.delete(b.paneId); }
        catch (e) { answerErrors.set(b.paneId, said(e)); note.textContent = said(e); for (const k of keys) k.disabled = false; }
      } });
      button.setAttribute('aria-label', `${label}: ${who}`);
      return button;
    });
    const item = el('li', { className: 'card question' },
      el('h3', { textContent: who }),
      el('p', { className: 'status', textContent: agentWords('blocked') }),
      el('pre', { textContent: b.prompt.trim() }),
      el('div', { className: 'keys' }, ...keys), note);
    item.dataset.pane = b.paneId;
    return item;
  }));
}

$('prompt-form').onsubmit = async (e) => {
  e.preventDefault();
  const box = $<HTMLTextAreaElement>('prompt');
  const text = box.value.trim();
  if (!text || !selected) return;
  $<HTMLButtonElement>('send').disabled = true;
  $('receipt').textContent = 'Sending…';
  try {
    const receipt = await hd.prompt(selected, text);
    box.value = '';
    $('receipt').textContent = 'Waiting for the reply below.';
    $('receipt').dataset.revision = String(receipt.revision);
    void refresh();
  } catch (err) {
    $('receipt').textContent = said(err);
  } finally {
    $<HTMLButtonElement>('send').disabled = false;
  }
};

$('start-form').onsubmit = async (e) => {
  e.preventDefault();
  const kind = $<HTMLSelectElement>('kind').value;
  const cwd = $<HTMLInputElement>('folder').value.trim();
  if (!kind) { $('start-error').textContent = "Herdr hasn't listed its agents yet. Try again in a moment."; void setup().catch(() => {}); return; }
  if (!cwd) return;
  const button = $<HTMLButtonElement>('start-go');
  button.disabled = true;
  button.textContent = agentWords('starting');
  $('start-error').textContent = '';
  try {
    const ref = await hd.startAgent({ kind, cwd, place: { workspace: 'new', label: plainKind(kind) } });
    selected = ref.paneId;
    drawTree();
    void refresh();
  } catch (err) {
    $('start-error').textContent = said(err);
  } finally {
    button.disabled = false;
    button.textContent = 'Start agent';
  }
};

$('forget').onclick = async () => {
  unwatch?.();
  unwatch = undefined;
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
