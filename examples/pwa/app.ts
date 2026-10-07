// "Sign in with ChatGPT" and "Sign in with Claude" in a web page: @byokit/accounts' browser side (ChatGPT by device
// code; Claude by its own page, whose code the person pastes back), kept in this browser's IndexedDB, with
// @byokit/ui-core's phases. Then asking it, the answer streaming in.
import { Accounts, billingWords, browserStore, planLabel, say, signInError, PROVIDERS } from '@byokit/accounts';
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

function card(key: string) {
  const { name, company } = PROVIDERS[key];
  // Only the two providers this page can ask have a question box; every provider in the catalogue gets a sign-in card.
  const answers = key === 'chatgpt' || key === 'claude';
  const el = ($('card') as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement;
  el.id = key;
  $('cards').append(el);
  const q = <T extends HTMLElement = HTMLElement>(k: string) => el.querySelector(`[data-${k}]`) as T;
  const show = (k: string, on: boolean) => { q(k).hidden = !on; };
  const logo = q('logo');
  logo.textContent = name[0];
  logo.style.background = LOGO[key] ?? '#6e6e73';
  q('name').textContent = name;
  q('company').textContent = company;
  // The honest chip: what paying looks like here — a plan, or per-use billing — before any plan is known.
  const chip = q('chip');
  chip.textContent = PROVIDERS[key].billing === 'api' ? 'Pay per use' : 'Plan';
  chip.title = billingWords(PROVIDERS[key]);
  q('signin').textContent = `Sign in with ${name}`;
  q('open').textContent = `Open ${name}`;
  q('connect').textContent = 'Connect';
  q<HTMLInputElement>('pasted').placeholder = `Paste the code from the ${name} page`;
  q<HTMLTextAreaElement>('question').placeholder = `Ask ${name} something`;
  q('question').hidden = q('ask').hidden = !answers;
  const banner = (tone: '' | 'error' | 'expired' | 'info', words: string) => {
    const n = q('note');
    if (!words) { n.hidden = true; return; }
    n.textContent = words; n.dataset.tone = tone; n.hidden = false;
  };

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

  let drawing = 0;
  let cancelledHere = false;
  async function draw() {
    const mine = ++drawing;
    const status = await accounts.status(ME, key);
    // Signed in, even while resting or when the plan lacks something: Ask says why, and Sign out stays.
    const ready = status.state === 'ready' || status.state === 'resting' || status.state === 'not_included';
    const plan = ready ? await accounts.plan(ME, key) : null;
    if (mine !== drawing) return; // a later draw (a sign-out, say) already said how things are
    const view = accounts.view(ME, key);
    const phase = phaseOf({ ready, signIn: view });
    const waiting = view?.state === 'waiting';
    el.dataset.state = waiting ? 'signing' : status.state;
    q('status').textContent = status.words;
    q('badge').textContent = plan ? planLabel(name, plan.plan) : '';
    const known = !!plan?.plan;
    show('badge', known); show('chip', !known);
    q('who').textContent = plan?.email ? `Signed in as ${plan.email}` : '';
    show('who', !!plan?.email);
    // The sheet opens only while a sign-in is actually waiting; idle 'opening' shows the signed-out card alone.
    const sheet = waiting && (phase === 'code' || phase === 'opening' || phase === 'waiting');
    show('sheet', sheet);
    countdown(waiting ? view?.expiresAt : undefined);
    if (phase === 'code') {
      banner('', '');
      q('words').textContent = `On the ${name} page, type this code:`;
      q('code').textContent = view?.code ?? '';
      show('codewell', true);
      const open = q<HTMLAnchorElement>('open');
      open.href = view?.url ?? '#'; open.textContent = `Open ${name}`; open.removeAttribute('data-quiet');
      show('open', !!view?.url);
      show('paste', false);
    } else if (phase === 'waiting') {
      banner('', '');
      q('words').textContent = say('signIn.waitingUrl', { name });
      show('codewell', false);
      // The paste box is this step's primary action, so Open steps back to a quiet link: one primary per step.
      const open = q<HTMLAnchorElement>('open');
      open.href = view?.url ?? '#'; open.textContent = `Reopen the ${name} page`; open.setAttribute('data-quiet', '');
      show('open', !!view?.url);
      show('paste', key === 'claude');
    } else if (phase === 'opening') {
      banner('', '');
      q('words').textContent = say('signIn.opening', { name });
      show('codewell', false); show('open', false); show('paste', false);
    } else if (!ready) {
      // The sheet is gone; the sign-in button is the single primary again, under a banner saying what happened.
      if (phase === 'expired') banner('expired', signInError(name, view?.error ?? 'expired'));
      else if (phase === 'cancelled') banner('info', say('signIn.cancelled'));
      else if (phase === 'failed' || phase === 'busy' || phase === 'offline') {
        banner(cancelledHere ? 'info' : 'error', cancelledHere ? say('signIn.cancelled') : signInError(name, view?.error ?? 'failed'));
      } else banner('', '');
      cancelledHere = false;
    } else banner('', '');
    if (view?.state === 'failed') void 0; // banner above already said it, in this card's own words
    show('signin', !ready && !waiting);
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
  q('cancel').onclick = () => { cancelledHere = true; accounts.cancel(ME, key); };
  q('connect').onclick = () => {
    const pasted = q<HTMLInputElement>('pasted');
    if (!pasted.value.trim()) return pasted.focus();
    try { accounts.paste(ME, key, pasted.value); pasted.value = ''; } catch { banner('error', say('signIn.failed', { name })); }
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
    const signal = mine.signal;
    q<HTMLButtonElement>('ask').disabled = true; show('stop', true);
    out.textContent = ''; show('answer', true);
    const onText = (d: string) => { if (mine === asking) out.textContent += d; };
    try {
      const text = key === 'claude'
        ? await accounts.respond(ME, { provider: 'claude', model: PROVIDERS.claude.models.strong, max_tokens: 1024, system: 'Answer in a few short sentences.', messages: [{ role: 'user', content: input }], onText, signal })
        : await accounts.respond(ME, { instructions: 'Answer in a few short sentences.', input, onText, signal });
      if (mine === asking) out.textContent = text;
    } catch (e: any) { if (mine === asking) out.textContent = e.message; }
    settle(mine);
  };
  q('stop').onclick = () => settle();
  q('signout').onclick = async () => { settle(); await accounts.logout(ME, key); banner('', ''); show('answer', false); draw(); };
  return draw;
}

const $ = (id: string) => document.getElementById(id)!;
// The picker is the catalogue's: every provider this platform can sign in to, in the order the kit offers them.
const draws: Record<string, () => Promise<void>> = Object.fromEntries(accounts.providers.map((p) => [p.key, card(p.key)]));
accounts.onChange = (_member, key) => { draws[key]?.(); };
Promise.all(accounts.providers.map((p) => accounts.signedIn(ME, p.key)))
  .then(() => accounts.keepFresh([ME])).then(() => Object.values(draws).forEach((d) => d()));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
