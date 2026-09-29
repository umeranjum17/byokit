// The phone side: pair with the computer, then see its Herdr agents, start one, talk to it and answer its questions.
// Plain DOM; every status a person reads is a sentence from @byokit/herdr's or @byokit/ui-core's words.
import { DeviceLink, browserDeviceStore, normalizeCode, pairWithCode, pairWithOffer, type DeviceGrant } from '@byokit/link';
import { agentWords, herdrDevice } from '@byokit/herdr/device';
import type { BlockedAgent, HerdrSnapshot } from '@byokit/herdr'; // types only: nothing from the computer side is bundled
import { consentWords, linkWords, pairingView, type PairPhase } from '@byokit/ui-core/link';

type Device = ReturnType<typeof herdrDevice>;
type Agent = NonNullable<HerdrSnapshot['workspaces'][number]['tabs'][number]['panes'][number]['agent']>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};
const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
const store = browserDeviceStore('herdr-kit');
// Keys Herdr sends to the pane exactly as named; the labels are what a person reads.
const KEYS: [label: string, key: string, spoken: string][] = [['Enter', 'Enter', 'Press Enter'], ['y', 'y', 'Answer y'], ['n', 'n', 'Answer n'], ['Esc', 'Escape', 'Press Esc']];

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

let hd: Device;
let link: DeviceLink;
let tree: HerdrSnapshot = { connected: false, workspaces: [] };
let selected: string | undefined;

function connect(grant: DeviceGrant) {
  $('pair').hidden = true;
  $('home').hidden = false;
  $('forget').hidden = false;
  link = new DeviceLink(grant, {
    store,
    onStatus: (s) => {
      $('link').textContent = linkWords(s, grant.hostName);
      if (s === 'online') void online();
      if (s === 'removed') { void store.clear(); showPair('scan'); }
    },
  });
  $('link').textContent = linkWords(link.status, grant.hostName);
  hd = herdrDevice(link);
}

let listening = false;
async function online() {
  setup().catch(() => {});
  void refresh();
  if (listening) return;
  listening = true;
  try {
    // Tree changes and question add/resolve frames; the stream ends when the link drops and reopens on `online`.
    for await (const frame of hd.events() as AsyncIterable<{ type: string; snapshot?: HerdrSnapshot }>) {
      if (frame.type === 'snapshot' && frame.snapshot) { tree = frame.snapshot; drawTree(); }
      void refresh();
    }
  } catch { /* offline: onStatus says so */ } finally { listening = false; }
}

async function setup() {
  const { kinds, folder } = await link.request('example.setup') as { kinds: string[]; folder: string };
  const pick = $<HTMLSelectElement>('kind');
  pick.replaceChildren(...kinds.map((k) => el('option', { value: k, textContent: k })));
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
      const [state, blocked] = await Promise.all([hd.state(), hd.blocked()]);
      $('herdr').textContent = state.words;
      drawBlocked(blocked);
      await drawAgent();
    } catch { /* the link line says why */ }
  })().finally(() => { refreshing = undefined; if (again) { again = false; void refresh(); } });
  return refreshing;
}

const statusOf = (a: Agent) => (a.launchPending ? 'starting' : a.status);
const nameOf = (a: Agent) => a.name ?? a.kind ?? 'Agent';
function agentAt(paneId: string | undefined): Agent | undefined {
  for (const w of tree.workspaces) for (const t of w.tabs) for (const p of t.panes) if (p.id === paneId) return p.agent;
  return undefined;
}

function drawTree() {
  const groups = tree.workspaces.flatMap((w) => w.tabs.map((t) => ({ where: `${w.label.split('/').filter(Boolean).pop() ?? w.label} · ${t.label}`, panes: t.panes.filter((p) => p.agent) })))
    .filter((g) => g.panes.length > 0);
  selected ??= groups[0]?.panes[0]?.id; // a just-started agent stays picked until the tree has it
  $('tree').replaceChildren(...(groups.length ? groups.flatMap((g) => [
    el('p', { className: 'place', textContent: g.where, title: g.where }),
    el('ul', {}, ...g.panes.map((p) => {
      const status = statusOf(p.agent!);
      const button = el('button', { className: 'agent', type: 'button', onclick: () => { selected = p.id; drawTree(); void drawAgent(); } },
        el('span', { className: 'who', textContent: nameOf(p.agent!) }), el('span', { className: `pill ${status}`, textContent: agentWords(status) }));
      button.setAttribute('aria-pressed', String(p.id === selected));
      button.dataset.pane = p.id;
      return el('li', {}, button);
    })),
  ]) : [el('p', { className: 'empty', textContent: 'No agents yet. Start one below.' })]));
  const agent = agentAt(selected);
  $('agent').hidden = !agent;
  if (agent) {
    $('agent-name').textContent = nameOf(agent);
    $('agent-status').className = `pill ${statusOf(agent)}`;
    $('agent-status').textContent = agentWords(statusOf(agent));
  }
}

async function drawAgent() {
  const paneId = selected;
  if (!paneId || !agentAt(paneId)) return;
  const { text } = await hd.read(paneId, { source: 'recent', lines: 60 });
  if (paneId !== selected) return;
  const screen = $('screen');
  const atEnd = screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 4;
  screen.textContent = text.trimEnd();
  if (atEnd) screen.scrollTop = screen.scrollHeight;
}

function drawBlocked(list: BlockedAgent[]) {
  $('questions').hidden = list.length === 0;
  $('blocked').replaceChildren(...list.map((b) => {
    const agent = agentAt(b.paneId);
    const note = el('p', { className: 'error', role: 'alert' } as Partial<HTMLParagraphElement>);
    const keys = KEYS.map(([label, key, spoken]) => {
      const button = el('button', { type: 'button', textContent: label, onclick: async () => {
        for (const k of keys) k.disabled = true;
        try { await hd.answer(b.paneId, [key], b.revision); } catch (e) { note.textContent = said(e); for (const k of keys) k.disabled = false; }
        void refresh();
      } });
      button.setAttribute('aria-label', `${spoken} to ${agent ? nameOf(agent) : 'the agent'}`);
      return button;
    });
    const item = el('li', { className: 'card question' },
      el('h3', { textContent: agent ? nameOf(agent) : b.kind ?? 'Agent' }),
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
  $('receipt').textContent = '';
  try {
    const receipt = await hd.prompt(selected, text);
    box.value = '';
    $('receipt').textContent = 'Sent.';
    $('receipt').dataset.revision = String(receipt.revision);
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
  if (!kind || !cwd) return;
  const button = $<HTMLButtonElement>('start-go');
  button.disabled = true;
  button.textContent = agentWords('starting');
  $('start-error').textContent = '';
  try {
    const ref = await hd.startAgent({ kind, cwd, place: { workspace: 'new', label: kind } });
    selected = ref.paneId;
    ($('start') as HTMLDetailsElement).open = false;
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
