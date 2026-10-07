// "Sign in with ChatGPT" and "Sign in with Claude" in a web page: @byokit/accounts' browser side (ChatGPT by device
// code; Claude by its own page, whose code the person pastes back), kept in this browser's IndexedDB, with
// @byokit/ui-core's phases. Every connected plan and key lists first, each with its billing and room; the Add rows
// come after. Ask runs on one account chosen at the start: Auto takes the most room and says which one and why.
import { Accounts, billingWords, browserStore, clock, planLabel, resolveSelection, roomOf, roomWords, say, signInError, PROVIDERS, type Account, type Room } from '@byokit/accounts';
import { phaseOf } from '@byokit/ui-core/phase';

declare const __BYOKIT_AUTH_BASE__: string | undefined;
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
  fetch: forwarded,
});

// One tile per provider: its initial on its maker's colour, so the list reads at a glance in either theme.
const LOGO: Record<string, string> = { chatgpt: '#10a37f', claude: '#d97757', grok: '#1d1d1f', kimi: '#4d6bfe', copilot: '#6e40c9', meta: '#0082fb' };
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}`;

/** Live rooms by account id, read seconds ago; Ask reuses a fresh one instead of delaying the run. */
const roomCache = new Map<string, { room: Room; at: number }>();
const ROOM_TTL_MS = 60_000;

/** This provider's quota, read live for the run that is starting; unknown when it cannot be read. */
async function roomFor(id: string): Promise<Room> {
  try {
    const { access, accountId } = await accounts.access(ME, undefined, id);
    const res = await forwarded('https://chatgpt.com/backend-api/wham/usage',
      { headers: { authorization: `Bearer ${access}`, 'ChatGPT-Account-Id': accountId }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { left: 'unknown' };
    const raw: any = await res.json();
    const panes: { usedPercent: number; kind: string; resetsAt?: number }[] = [];
    const take = (w: any) => {
      if (typeof w?.used_percent !== 'number') return;
      const mins = typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds / 60 : undefined;
      panes.push({ usedPercent: w.used_percent, kind: mins === 300 ? 'session' : mins === 10080 ? 'weekly' : mins === 43200 ? 'monthly' : 'custom',
        ...(typeof w.reset_at === 'number' ? { resetsAt: w.reset_at * 1000 }
          : typeof w.reset_after_seconds === 'number' && w.reset_after_seconds >= 0 ? { resetsAt: Date.now() + w.reset_after_seconds * 1000 } : {}) });
    };
    take(raw?.rate_limit?.primary_window);
    take(raw?.rate_limit?.secondary_window);
    for (const extra of raw?.additional_rate_limits ?? []) { take(extra?.rate_limit?.primary_window); take(extra?.rate_limit?.secondary_window); }
    return roomOf(panes, Date.now(), 'milliseconds');
  } catch { return { left: 'unknown' }; }
}

/** Fresh rooms for these rows, reusing readings from seconds ago so neither paint nor Ask waits on quota. */
async function readRooms(rows: Account[]): Promise<Map<string, Room>> {
  const rooms = new Map<string, Room>();
  await Promise.all(rows.map(async (a) => {
    const kept = roomCache.get(a.id);
    if (kept && Date.now() - kept.at < ROOM_TTL_MS) { rooms.set(a.id, kept.room); return; }
    const room = a.provider === 'chatgpt' ? await roomFor(a.id) : { left: 'unknown' as const };
    roomCache.set(a.id, { room, at: Date.now() });
    rooms.set(a.id, room);
  }));
  return rooms;
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

  /** One compact row per connected account: who, billing, the usage bar and its room. */
  function drawRows(rows: Account[], rooms: Map<string, Room>, self: { id: string; email?: string }) {
    const box = q('accounts');
    box.replaceChildren();
    for (const a of rows) {
      const row = document.createElement('div');
      row.className = 'acc';
      row.dataset.account = a.id;
      const head = document.createElement('div');
      head.className = 'acc-row';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.dataset.state = a.state;
      head.append(dot);
      const email = document.createElement('span');
      email.className = 'acc-email';
      email.dataset.email = '';
      // The row's own address; the live profile's only for the default row it belongs to.
      email.textContent = a.email ?? (a.id === self.id ? self.email ?? a.name : a.name);
      head.append(email);
      const chip = document.createElement('span');
      chip.className = 'acc-chip';
      chip.dataset.chip = '';
      chip.textContent = a.billing === 'subscription' ? `Your ${a.name} plan`
        : a.billing === 'api' ? 'API key, billed per use' : a.label;
      head.append(chip);
      row.append(head);
      const room = rooms.get(a.id) ?? { left: 'unknown' as const };
      if (typeof room.left === 'number') {
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
      text.textContent = typeof room.left !== 'number' ? roomWords(room)
        : room.resetsAt ? `${Math.round(room.left)}% left - refills ${clock(room.resetsAt)}` : `${Math.round(room.left)}% left`;
      row.append(text);
      if (a.state !== 'ready') {
        const out = document.createElement('button');
        out.className = 'quiet';
        out.textContent = 'Sign out';
        out.onclick = async () => { await accounts.logout(ME, a.id); draw(); };
        row.append(out);
      }
      box.append(row);
    }
  }

  function drawPick(rows: Account[], keep: string) {
    const pick = q<HTMLSelectElement>('pick');
    pick.replaceChildren();
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = 'Auto (most room)';
    pick.append(auto);
    for (const a of rows) {
      const option = document.createElement('option');
      option.value = a.id;
      option.textContent = a.email ? `${a.name} · ${a.email}` : a.name;
      pick.append(option);
    }
    pick.value = rows.some((a) => a.id === keep) ? keep : 'auto';
  }

  let drawing = 0;
  let pendingAdd: string | undefined;
  let cancelledHere = false;
  async function draw() {
    const mine = ++drawing;
    const status = await accounts.status(ME, key);
    // Signed in, even while resting or when the plan lacks something: Ask says why, and Sign out stays.
    const ready = status.state === 'ready' || status.state === 'resting' || status.state === 'not_included';
    const plan = ready ? await accounts.plan(ME, key) : null;
    const rows = (await accounts.list(ME)).filter((a) => a.provider === key);
    drawRows(rows, new Map(), { id: status.id, email: plan?.email });
    drawPick(rows, q<HTMLSelectElement>('pick').value);
    const landed = pendingAdd ? accounts.view(ME, pendingAdd) : undefined;
    if (landed?.state === 'done' && pendingAdd) pendingAdd = undefined;
    // An account being added walks its own sheet, even while another one is already connected.
    const shown = pendingAdd ? accounts.view(ME, pendingAdd) : accounts.view(ME, key);
    const phase = phaseOf({ ready: !pendingAdd && status.state === 'ready', signIn: shown });
    const waiting = shown?.state === 'waiting';
    if (mine !== drawing) return; // a later draw (a sign-out, say) already said how things are
    readRooms(rows).then((rooms) => { if (mine === drawing) drawRows(rows, rooms, { id: status.id, email: plan?.email }); });
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

  q('copy').onclick = async () => {
    const code = q('code').textContent.trim();
    if (!code) return;
    try { await navigator.clipboard.writeText(code); } catch { /* clipboard needs a secure page; selecting still works */ }
    const b = q<HTMLButtonElement>('copy');
    b.textContent = 'Copied';
    window.setTimeout(() => { b.textContent = 'Copy'; }, 1200);
  };
  q('signin').onclick = () => { banner('', ''); accounts.login(ME, key).then(draw); };
  q('add').onclick = async () => {
    note('');
    try {
      const added = await accounts.add(ME, key, { fresh: true });
      pendingAdd = added.id;
    } catch (e: any) { note(e.message); }
    draw();
  };
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
      for (const a of rows) rooms.set(a.id, roomCache.get(a.id)?.room ?? { left: 'unknown' });
      void readRooms(rows); // the next run's rooms, never this one's delay
      const want = q<HTMLSelectElement>('pick').value;
      const pick = resolveSelection(rows, await accounts.defaults(ME), { account: want }, (a) => rooms.get(a.id) ?? { left: 'unknown' }, Date.now());
      if (mine !== asking) return;
      if (!pick.ok) { out.textContent = pick.reason; settle(mine); draw(); return; }
      await accounts.setDefaults(ME, { ...await accounts.defaults(ME), account: pick.account.id });
      if (mine !== asking) return;
      const picked = q('picked');
      const who = pick.account.email ?? pick.account.name;
      const room = rooms.get(pick.account.id);
      picked.textContent = want === 'auto' && typeof room?.left === 'number'
        ? `Auto picks ${who}: ${Math.round(room.left)}% left.`
        : `Using ${who}: ` + say(`pick.why.${pick.why}`, { name: pick.account.name, provider: pick.account.provider });
      show('picked', true);
      draw();
      const signal = mine.signal;
      const onText = (d: string) => { if (mine === asking) out.textContent += d; };
      try {
        const text = key === 'claude'
          ? await accounts.respond(ME, { provider: 'claude', model: PROVIDERS.claude.models.strong, max_tokens: 1024, system: 'Answer in a few short sentences.', messages: [{ role: 'user', content: input }], onText, signal })
          : await accounts.respond(ME, { instructions: 'Answer in a few short sentences.', input, onText, signal });
        if (mine === asking) out.textContent = text;
      } catch (e: any) { if (mine === asking) out.textContent = e.message; }
      settle(mine);
    } catch (e: any) { if (mine === asking) { out.textContent = e.message; settle(mine); } }
  };
  q('stop').onclick = () => settle();
  q('signout').onclick = async () => { settle(); await accounts.logout(ME, key); note(''); show('answer', false); draw(); };
  return draw;
}

const $ = (id: string) => document.getElementById(id)!;
// The picker is the catalogue's: every provider this platform can sign in to, in the order the kit offers them.
const draws: Record<string, () => Promise<void>> = Object.fromEntries(accounts.providers.map((p) => [p.key, card(p.key)]));
// An account being added reports under its own id, not its provider: redraw its card too, not only exact hits.
accounts.onChange = (_member, key) => { const d = draws[key]; if (d) d(); else Object.values(draws).forEach((d) => d()); };
Promise.all(accounts.providers.map((p) => accounts.signedIn(ME, p.key)))
  .then(() => accounts.keepFresh([ME])).then(() => Object.values(draws).forEach((d) => d()));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
