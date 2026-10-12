// "Sign in with ChatGPT" and "Sign in with Claude" in a web page: @byokit/accounts' browser side (ChatGPT by device
// code; Claude by its own page, whose code the person pastes back), kept in this browser's IndexedDB, with
// @byokit/ui's phases. Every connected plan and key lists first through the shared account rows, each with its
// billing and room; the Add rows come after. Ask runs on one account chosen at the start through the shared run
// picker: Auto takes the most room and says which one and why, and suggests the roomier account when yours is low.
// Add an account lists every route the kit has, grouped by @byokit/ui's connectView: Plans first, then Pay per use
// and the rest, each with how it is paid for, how you sign in and whether it works here.
import { Accounts, billingWords, browserStore, planLabel, resolveSelection, roomOf, say, signInError, PROVIDERS, type Account, type ModelInfo, type Room, type RouteView } from '@byokit/accounts';
import { accountRows, bestMoveTarget, modelPicker, moveWords, type AccountRow, type Pick, type PickerView } from '@byokit/ui/accounts';
import { connectView, type ConnectRow } from '@byokit/ui/connect';
import { phaseOf } from '@byokit/ui/phase';
import type { Reading, Window } from '@byokit/usage';
import { windowsView } from '@byokit/usage/view';

declare const __BYOKIT_AUTH_BASE__: string | undefined;
declare const __BYOKIT_DEVICE_BASE__: string | undefined;
// ChatGPT's model endpoint and Claude's sign-in endpoints don't answer other web pages, so this page asks them through
// its own server (serve.ts), which passes each request on unchanged and keeps nothing.
const FORWARD: Record<string, string> = { 'https://chatgpt.com/': 'fwd/chatgpt/', 'https://platform.claude.com/': 'fwd/claude/', 'https://api.anthropic.com/': 'fwd/anthropic/' };
const forwarded: typeof fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const from = Object.keys(FORWARD).find((f) => url.startsWith(f));
  return fetch(from ? new URL(FORWARD[from] + url.slice(from.length), location.href).toString() : input, init);
};

const ME = 1;
const accounts = new Accounts<any, number>({
  app: 'byokit example',
  store: (member) => browserStore(`person-${member}`),
  authBase: __BYOKIT_AUTH_BASE__,
  deviceBase: __BYOKIT_DEVICE_BASE__,
  fetch: forwarded,
});

// One tile per provider: its initial on its maker's colour, so the list reads at a glance in either theme.
const LOGO: Record<string, string> = { chatgpt: '#10a37f', claude: '#d97757', grok: '#1d1d1f', kimi: '#4d6bfe', copilot: '#6e40c9', meta: '#0082fb' };
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}`;

/** The last usage reading per account id and when it was asked for; Ask reuses one from seconds ago instead of
 *  delaying the run, and a failed refresh keeps the last one, which then shows its age. */
const readingCache = new Map<string, { reading?: Reading; asked: number }>();
const ROOM_TTL_MS = 60_000;

/** The tightest window as Auto weighs it, carrying the reading's own time so a day-old one counts as unknown. */
const roomIn = (r?: Reading): Room =>
  r ? roomOf(r.windows.map((w) => ({ ...w, usedPercent: w.usedPercent ?? NaN })), r.at, 'milliseconds') : { left: 'unknown' };
/** Rooms by account id, for the picker, Auto and Move. */
const roomsIn = (readings: Map<string, Reading | undefined>) => new Map([...readings].map(([id, r]) => [id, roomIn(r)] as const));

/** This provider's usage windows, read live for the run that is starting; undefined when they cannot be read. */
async function readingFor(id: string): Promise<Reading | undefined> {
  try {
    const { access, accountId } = await accounts.access(ME, undefined, id);
    const res = await forwarded('https://chatgpt.com/backend-api/wham/usage',
      { headers: { authorization: `Bearer ${access}`, 'ChatGPT-Account-Id': accountId }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return undefined;
    const raw: any = await res.json();
    const panes: Window[] = [];
    const take = (w: any) => {
      if (typeof w?.used_percent !== 'number') return;
      const mins = typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds / 60 : undefined;
      panes.push({ provider: 'codex', usedPercent: w.used_percent, kind: mins === 300 ? 'session' : mins === 10080 ? 'weekly' : mins === 43200 ? 'monthly' : 'custom',
        ...(typeof w.reset_at === 'number' ? { resetsAt: w.reset_at * 1000 }
          : typeof w.reset_after_seconds === 'number' && w.reset_after_seconds >= 0 ? { resetsAt: Date.now() + w.reset_after_seconds * 1000 } : {}) });
    };
    take(raw?.rate_limit?.primary_window);
    take(raw?.rate_limit?.secondary_window);
    for (const extra of raw?.additional_rate_limits ?? []) { take(extra?.rate_limit?.primary_window); take(extra?.rate_limit?.secondary_window); }
    return { provider: 'codex', windows: panes, at: Date.now() };
  } catch { return undefined; }
}

/** Fresh readings for these rows, reusing ones from seconds ago so neither paint nor Ask waits on quota. */
async function readReadings(rows: Account[]): Promise<Map<string, Reading | undefined>> {
  const readings = new Map<string, Reading | undefined>();
  await Promise.all(rows.map(async (a) => {
    const kept = readingCache.get(a.id);
    if (kept && Date.now() - kept.asked < ROOM_TTL_MS) { readings.set(a.id, kept.reading); return; }
    const reading = (a.provider === 'chatgpt' ? await readingFor(a.id) : undefined) ?? kept?.reading;
    readingCache.set(a.id, { reading, asked: Date.now() });
    readings.set(a.id, reading);
  }));
  return readings;
}

function card(key: string) {
  const { name, company } = PROVIDERS[key];
  // Only the two providers this page can ask have a question box; every provider in the catalogue gets a sign-in card.
  const answers = key === 'chatgpt' || key === 'claude';
  const el = ($('card') as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement;
  el.id = key;
  $('cards').append(el);
  const q = <T extends HTMLElement = HTMLElement>(k: string) => el.querySelector(`[data-${k}]`) as T;
  const show = (k: string, on: boolean) => { q(k).hidden = !on; };
  const banner = (tone: '' | 'error' | 'expired' | 'info', words: string) => {
    const n = q('note');
    if (!words) { n.hidden = true; return; }
    n.textContent = words; n.dataset.tone = tone; n.hidden = false;
  };
  const note = (words: string) => banner(words ? 'error' : '', words);
  const logo = q('logo');
  logo.textContent = name[0];
  logo.style.background = LOGO[key] ?? '#6e6e73';
  q('name').textContent = name;
  q('company').textContent = company;
  // The honest chip: what paying looks like here — a plan, or per-use billing — before any plan is known.
  const billing = q('billing');
  billing.textContent = PROVIDERS[key].billing === 'api' ? 'Pay per use' : 'Plan';
  billing.title = billingWords(PROVIDERS[key]);
  q('signin').textContent = `Sign in with ${name}`;
  q('add').textContent = `Add another ${name}`;
  q('open').textContent = `Open ${name}`;
  q('connect').textContent = 'Connect';
  q<HTMLInputElement>('pasted').placeholder = `Paste the code from the ${name} page`;
  q<HTMLTextAreaElement>('question').placeholder = `Ask ${name} something`;
  q('question').hidden = q('ask').hidden = !answers;

  // A countdown this card owns: redrawn on every draw, so a stale timer never writes another card's time.
  let tick: number | undefined;
  const countdown = (expiresAt?: number) => {
    window.clearInterval(tick); tick = undefined;
    const line = q('expires');
    if (!expiresAt) { show('expires', false); return; }
    const paint = () => {
      const left = expiresAt - Date.now();
      show('expires', true);
      line.classList.toggle('out', left <= 0);
      line.textContent = left <= 0 ? 'This code has expired. Cancel and sign in again for a new one.' : `Code expires in ${mmss(left)}`;
    };
    paint();
    tick = window.setInterval(paint, 1000);
  };

  /** The row's own address; the live profile's only for the default row it belongs to. */
  const addrOf = (a: Account, self: { id: string; email?: string }) =>
    a.email ?? (a.id === self.id ? self.email ?? a.name : a.name);

  /** One model list per account, read live; a failure leaves that account's models empty, never breaks the picker. */
  async function modelsFor(rows: Account[]): Promise<Record<string, ModelInfo[]>> {
    const models: Record<string, ModelInfo[]> = {};
    await Promise.all(rows.map(async (a) => {
      try { models[a.id] = await accounts.models(ME, a.id); } catch { models[a.id] = []; }
    }));
    return models;
  }

  /** The line under the picker, naming the same account the picker shows: Auto's own reason, the chosen
   *  account, or why the chosen account cannot run. */
  const noteFor = (rows: Account[], views: AccountRow[], view: PickerView, auto: Pick, want: string, self: { id: string; email?: string }): string => {
    if (want === 'auto') return auto.reason;
    const a = rows.find((r) => r.id === want);
    if (!a) return auto.reason;
    const addr = addrOf(a, self);
    if (view.ok) return say('pick.why.chosen', { name: addr });
    const detail = views.find((v) => v.id === want)?.detail;
    return detail ? `${addr} — ${detail}` : auto.reason;
  };

  /** Every connected account from the shared rows: the kit's own title and room (or why it cannot run), the
   *  account's own address beside the title, the usage bar while the room is known, then each usage window with
   *  its reset and how old the reading is. */
  function paintRows(rows: Account[], readings: Map<string, Reading | undefined>, self: { id: string; email?: string }) {
    const box = q('accounts');
    box.replaceChildren();
    const rooms = roomsIn(readings);
    const now = Date.now();
    const views = accountRows(rows, (a) => rooms.get(a.id) ?? { left: 'unknown' }, now, (a) => {
      const r = readings.get(a.id);
      return r && windowsView(r, now);
    });
    for (const v of views) {
      const a = rows.find((r) => r.id === v.id)!;
      const row = document.createElement('div');
      row.className = 'acc';
      row.dataset.account = a.id;
      const head = document.createElement('div');
      head.className = 'acc-row';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.dataset.state = v.state;
      head.append(dot);
      const email = document.createElement('span');
      email.className = 'acc-email';
      email.dataset.email = '';
      const addr = addrOf(a, self);
      email.textContent = addr === v.title ? v.title : `${v.title} · ${addr}`;
      head.append(email);
      row.append(head);
      const room = rooms.get(a.id) ?? { left: 'unknown' as const };
      // No bar for a room whose window reset since the reading: its old number no longer holds.
      if (typeof room.left === 'number' && !(typeof room.resetsAt === 'number' && room.resetsAt <= now)) {
        const bar = document.createElement('div');
        bar.className = 'meter';
        const fill = document.createElement('i');
        fill.style.width = `${Math.round(room.left)}%`;
        bar.append(fill);
        bar.dataset.room = '';
        row.append(bar);
      }
      const text = document.createElement('p');
      text.className = 'acc-room';
      text.dataset.room = '';
      text.textContent = v.detail;
      row.append(text);
      const line = (words: string, data: string) => {
        const p = document.createElement('p');
        p.className = 'acc-room';
        p.dataset[data] = '';
        p.textContent = words;
        row.append(p);
      };
      for (const w of v.windows ?? []) line(w.resetText ? `${w.text} · ${w.resetText}` : w.text, 'window');
      if (v.asOf) line(v.asOf.text, 'age');
      if (v.asOf?.stale) row.dataset.stale = '';
      // No per-row Sign out: the card's own Sign out is the single way out, so it never shows twice.
      box.append(row);
    }
  }

  /** The run picker from the shared picker: the Auto row carrying Auto's own reason, then one row per account, and
   *  a Move suggestion when the chosen account is low and a roomier one is signed in. */
  async function paintPick(rows: Account[], readings: Map<string, Reading | undefined>, self: { id: string; email?: string }) {
    const pick = q<HTMLSelectElement>('pick');
    const rooms = roomsIn(readings);
    const now = Date.now();
    const roomOf = (a: { id: string }): Room => rooms.get(a.id) ?? { left: 'unknown' };
    const models = await modelsFor(rows);
    const auto = resolveSelection(rows, await accounts.defaults(ME), { account: 'auto', provider: key },
      roomOf, now, (a) => models[a.id] ?? []);
    const view = modelPicker(rows, models, { account: pick.value || 'auto' }, auto, now);
    // The selection is read here, after every await, so a repaint that started before the person chose keeps
    // their choice instead of restoring the one it started with.
    const keep = pick.value || 'auto';
    pick.replaceChildren();
    for (const r of view.rows) {
      const option = document.createElement('option');
      option.value = r.key;
      if (r.kind === 'auto') option.textContent = r.title;
      else {
        const a = rows.find((x) => x.id === r.key)!;
        const addr = addrOf(a, self);
        option.textContent = addr === r.title ? r.title : `${r.title} · ${addr}`;
      }
      pick.append(option);
    }
    pick.value = Array.from(pick.options).some((o) => o.value === keep) ? keep : 'auto';
    const views = accountRows(rows, roomOf, now);
    // The note always names what the picker shows, so the two never drift apart between runs.
    const picked = q('picked');
    picked.textContent = noteFor(rows, views, view, auto, pick.value, self);
    show('picked', rows.length > 0);
    const move = q<HTMLButtonElement>('move');
    const current = pick.value === 'auto' ? (auto.ok ? auto.account.id : undefined) : pick.value;
    const target = current !== undefined && (views.find((v) => v.id === current)?.low ?? false)
      ? bestMoveTarget(rows, Object.fromEntries(rooms), current, now)
      : undefined;
    if (target) {
      const t = rows.find((a) => a.id === target)!;
      const title = views.find((v) => v.id === target)?.title ?? t.name;
      const addr = addrOf(t, self);
      move.textContent = moveWords(addr === title ? title : `${title} · ${addr}`);
      move.hidden = false;
      move.onclick = () => { pick.value = target; void draw(); };
    } else move.hidden = true;
  }

  let drawing = 0;
  let pendingAdd: string | undefined;
  let cancelledHere = false;
  let signedIn = false;
  async function draw() {
    const mine = ++drawing;
    const status = await accounts.status(ME, key);
    // Signed in, even while resting or when the plan lacks something: Ask says why, and Sign out stays.
    const ready = status.state === 'ready' || status.state === 'resting' || status.state === 'not_included';
    signedIn = ready;
    const plan = ready ? await accounts.plan(ME, key) : null;
    const rows = (await accounts.list(ME)).filter((a) => a.provider === key);
    const self = { id: status.id, email: plan?.email };
    paintRows(rows, new Map(), self);
    await paintPick(rows, new Map(), self);
    const landed = pendingAdd ? accounts.view(ME, pendingAdd) : undefined;
    if (landed?.state === 'done' && pendingAdd) pendingAdd = undefined;
    // An account being added walks its own sheet, even while another one is already connected.
    const shown = pendingAdd ? accounts.view(ME, pendingAdd) : accounts.view(ME, key);
    const phase = phaseOf({ ready: !pendingAdd && status.state === 'ready', signIn: shown });
    const waiting = shown?.state === 'waiting';
    if (mine !== drawing) return; // a later draw (a sign-out, say) already said how things are
    readReadings(rows).then((readings) => {
      if (mine !== drawing) return;
      paintRows(rows, readings, self);
      void paintPick(rows, readings, self);
    });
    el.dataset.state = waiting ? 'signing' : status.state;
    q('status').textContent = status.words;
    q('badge').textContent = plan ? planLabel(name, plan.plan) : '';
    const known = !!plan?.plan;
    show('badge', known); show('billing', !known);
    q('who').textContent = plan?.email ? `Signed in as ${plan.email}` : '';
    show('who', !!plan?.email);
    // The sheet opens only while a sign-in is actually waiting; idle 'opening' shows the signed-out card alone.
    const sheet = waiting && (phase === 'code' || phase === 'opening' || phase === 'waiting');
    show('sheet', sheet);
    countdown(waiting ? shown?.expiresAt : undefined);
    if (phase === 'code') {
      banner('', '');
      q('words').textContent = `On the ${name} page, type this code:`;
      q('code').textContent = shown?.state === 'waiting' ? shown.code ?? '' : '';
      show('codewell', true);
      const open = q<HTMLAnchorElement>('open');
      open.href = shown?.state === 'waiting' ? shown.url ?? '#' : '#';
      open.textContent = `Open ${name}`; open.removeAttribute('data-quiet');
      show('open', !!shown?.url && shown.state === 'waiting');
      show('paste', false);
    } else if (phase === 'waiting') {
      banner('', '');
      q('words').textContent = say('signIn.waitingUrl', { name });
      show('codewell', false);
      // The paste box is this step's primary action, so Open steps back to a quiet link: one primary per step.
      const open = q<HTMLAnchorElement>('open');
      open.href = shown?.state === 'waiting' ? shown.url ?? '#' : '#';
      open.textContent = `Reopen the ${name} page`; open.setAttribute('data-quiet', '');
      show('open', !!shown?.url && shown.state === 'waiting');
      show('paste', key === 'claude');
    } else if (phase === 'opening') {
      banner('', '');
      q('words').textContent = say('signIn.opening', { name });
      show('codewell', false); show('open', false); show('paste', false);
    } else if (!ready || pendingAdd) {
      // The sheet is gone; the sign-in button is the single primary again, under a banner saying what happened.
      if (phase === 'expired') banner('expired', signInError(name, shown?.error ?? 'expired'));
      else if (phase === 'cancelled') banner('info', say('signIn.cancelled'));
      else if (phase === 'failed' || phase === 'busy' || phase === 'offline') {
        banner(cancelledHere ? 'info' : 'error', cancelledHere ? say('signIn.cancelled') : signInError(name, shown?.error ?? 'failed'));
      } else banner('', '');
      cancelledHere = false;
    } else banner('', '');
    if (shown?.state === 'failed') void 0; // banner above already said it, in this card's own words
    show('signin', !ready && !waiting && !pendingAdd);
    show('add', ready && !waiting && !pendingAdd);
    show('ready', ready);
  }

  // Choosing another account redraws at once, so the note and the Move suggestion name what the picker shows.
  q<HTMLSelectElement>('pick').onchange = () => { draw(); };
  q('copy').onclick = async () => {
    const code = q('code').textContent.trim();
    if (!code) return;
    try { await navigator.clipboard.writeText(code); } catch { /* clipboard needs a secure page; selecting still works */ }
    const b = q<HTMLButtonElement>('copy');
    b.textContent = 'Copied';
    window.setTimeout(() => { b.textContent = 'Copy'; }, 1200);
  };
  const signIn = () => { banner('', ''); return accounts.login(ME, key).then(draw); };
  const addAnother = async () => {
    note('');
    try {
      const added = await accounts.add(ME, key, { fresh: true });
      pendingAdd = added.id;
    } catch (e: any) { note(e.message); }
    draw();
  };
  q('signin').onclick = signIn;
  q('add').onclick = addAnother;
  // A row in the Add sheet starts this card's own way in. A sign-in already waiting here is shown, never doubled.
  const start = () => (pendingAdd || accounts.view(ME, key)?.state === 'waiting' ? draw() : signedIn ? addAnother() : signIn());
  q('cancel').onclick = () => {
    cancelledHere = true;
    accounts.cancel(ME, pendingAdd ?? key);
    pendingAdd = undefined;
  };
  q('connect').onclick = () => {
    const pasted = q<HTMLInputElement>('pasted');
    if (!pasted.value.trim()) return pasted.focus();
    try { accounts.paste(ME, pendingAdd ?? key, pasted.value); pasted.value = ''; } catch { note(say('signIn.failed', { name })); }
  };
  // One question at a time per card: Ask waits while an answer is coming, Stop ends it, and only the newest question's
  // answer may write here, so an older answer's late pieces, final text or failure never overwrite a newer one.
  let asking: AbortController | undefined;
  const settle = (mine?: AbortController) => {
    if (mine && mine !== asking) return;
    asking?.abort(); asking = undefined;
    q<HTMLButtonElement>('ask').disabled = false; show('stop', false);
  };
  q('ask').onclick = async () => {
    const out = q('answer');
    const input = q<HTMLTextAreaElement>('question').value.trim();
    if (!input || asking) return;
    if (!answers) return;
    const mine = asking = new AbortController();
    q<HTMLButtonElement>('ask').disabled = true; show('stop', true);
    out.textContent = ''; show('answer', true);
    try {
      // The run's account is chosen once, before asking, and never changes while the answer streams in.
      // Rooms come from the live readings on screen; quota never delays the run.
      const rows = (await accounts.list(ME)).filter((a) => a.provider === key);
      if (mine !== asking) return;
      const rooms = new Map<string, Room>();
      for (const a of rows) rooms.set(a.id, roomIn(readingCache.get(a.id)?.reading));
      void readReadings(rows); // the next run's rooms, never this one's delay
      const now = Date.now();
      const models = await modelsFor(rows);
      if (mine !== asking) return;
      const roomOf = (a: { id: string }): Room => rooms.get(a.id) ?? { left: 'unknown' };
      const auto = resolveSelection(rows, await accounts.defaults(ME), { account: 'auto', provider: key },
        roomOf, now, (a) => models[a.id] ?? []);
      if (mine !== asking) return;
      // The run's account comes from the shared picker: a signed-out choice shows its sign-in reason here and runs nothing.
      const want = q<HTMLSelectElement>('pick').value;
      const view = modelPicker(rows, models, { account: want }, auto, now);
      if (!view.ok) {
        out.textContent = want === 'auto' ? auto.reason : view.rows.find((r) => r.key === want)?.detail || auto.reason;
        settle(mine); draw(); return;
      }
      if (mine !== asking) return;
      const picked = q('picked');
      if (want === 'auto') picked.textContent = auto.reason;
      else {
        const chosen = rows.find((a) => a.id === view.account)!;
        picked.textContent = say('pick.why.chosen', { name: chosen.email ?? chosen.name });
      }
      show('picked', true);
      draw();
      const signal = mine.signal;
      const onText = (d: string) => { if (mine === asking) out.textContent += d; };
      try {
        const select = { account: view.account! };
        const text = key === 'claude'
          ? await accounts.respond(ME, { provider: 'claude', model: PROVIDERS.claude.models.strong, max_tokens: 1024, system: 'Answer in a few short sentences.', messages: [{ role: 'user', content: input }], onText, signal, select })
          : await accounts.respond(ME, { instructions: 'Answer in a few short sentences.', input, onText, signal, select });
        if (mine === asking) out.textContent = text;
      } catch (e: any) { if (mine === asking) out.textContent = e.message; }
      settle(mine);
    } catch (e: any) { if (mine === asking) { out.textContent = e.message; settle(mine); } }
  };
  q('stop').onclick = () => settle();
  q('signout').onclick = async () => { settle(); await accounts.logout(ME, key); note(''); show('answer', false); draw(); };
  return { draw, start };
}

const $ = (id: string) => document.getElementById(id)!;
// The picker is the catalogue's: every provider this platform can sign in to, in the order the kit offers them.
const cards: Record<string, ReturnType<typeof card>> = Object.fromEntries(accounts.providers.map((p) => [p.key, card(p.key)]));
// An account being added reports under its own id, not its provider: redraw its card too, not only exact hits.
accounts.onChange = (_member, key) => { const c = cards[key]; if (c) c.draw(); else Object.values(cards).forEach((c) => c.draw()); };
Promise.all(accounts.providers.map((p) => accounts.signedIn(ME, p.key)))
  .then(() => accounts.keepFresh([ME])).then(() => Object.values(cards).forEach((c) => c.draw()));

/** The card a route signs in on, when this page has one: the provider with that route's upstream id. */
const cardFor = (row: ConnectRow, routes: RouteView[]) => accounts.providers.find((p) => p.pi === routes.find((r) => r.id === row.id)?.upstream.id)?.key;
/** Every route, grouped. A row is a button only when this page can start it: a ready sign-in with its card here.
 *  Anything else stays listed and cannot be tapped, saying why: its readiness words, or that this page has no form for it. */
function addSheet() {
  const box = $('add-groups');
  box.replaceChildren();
  const routes = accounts.routes();
  for (const g of connectView(routes).groups) {
    const group = document.createElement('section');
    group.className = 'group';
    group.dataset.group = g.id;
    const title = document.createElement('h3');
    title.textContent = g.title;
    const note = document.createElement('p');
    note.className = 'company';
    note.textContent = g.note;
    group.append(title, note);
    // Ready ways in first, then the ones that cannot be used here; each keeps the kit's order within its kind.
    for (const r of [...g.rows].sort((a, b) => Number(b.ready) - Number(a.ready))) {
      const key = r.does === 'signin' ? cardFor(r, routes) : undefined;
      const row = document.createElement('button');
      row.className = 'route';
      row.type = 'button';
      row.dataset.route = r.id;
      // aria-disabled, not disabled: the row stays focusable, so its reason is still read out.
      if (!key) row.setAttribute('aria-disabled', 'true');
      if (!r.ready) row.dataset.unavailable = '';
      const line = (cls: string, words: string) => { const s = document.createElement('span'); s.className = cls; s.textContent = words; row.append(s); };
      // The way in names the card: one provider can have several (its page, a pasted code, a key).
      line('route-name', `${r.name} — ${r.method[0].toLowerCase()}${r.method.slice(1)}`);
      line('route-line', r.billingWords);
      line('route-status', r.ready && !key ? 'Ready, but this page has no form for it yet.' : r.status);
      row.onclick = () => {
        if (!key) return;
        $('add-sheet').hidden = true;
        const el = $(key);
        el.tabIndex = -1;
        el.focus();
        el.scrollIntoView({ block: 'start' });
        void cards[key].start();
      };
      group.append(row);
    }
    box.append(group);
  }
}
$('add-open').onclick = () => { addSheet(); $('add-sheet').hidden = false; $('add-title').focus(); $('add-sheet').scrollIntoView({ block: 'start' }); };
$('add-close').onclick = () => { $('add-sheet').hidden = true; $('add-open').focus(); };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
