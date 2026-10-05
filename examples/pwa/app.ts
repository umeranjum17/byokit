// "Sign in with ChatGPT" and "Sign in with Claude" in a web page: @byokit/accounts' browser side (ChatGPT by device
// code; Claude by its own page, whose code the person pastes back), kept in this browser's IndexedDB, with
// @byokit/ui-core's phases. Then asking it, the answer streaming in.
import { Accounts, browserStore, planLabel, say, PROVIDERS } from '@byokit/accounts';
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

function card(key: string) {
  const { name } = PROVIDERS[key];
  // Only the two providers this page can ask have a question box; every provider in the catalogue gets a sign-in card.
  const answers = key === 'chatgpt' || key === 'claude';
  const el = ($('card') as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement;
  el.id = key;
  $('cards').append(el);
  const q = <T extends HTMLElement = HTMLElement>(k: string) => el.querySelector(`[data-${k}]`) as T;
  const show = (k: string, on: boolean) => { q(k).hidden = !on; };
  const note = (words: string) => { q('note').textContent = words; show('note', !!words); };
  q('name').textContent = name;
  q('signin').textContent = `Sign in with ${name}`;
  q('open').textContent = `Open ${name}`;
  q('connect').textContent = 'Connect';
  q<HTMLInputElement>('pasted').placeholder = `Paste the code from the ${name} page`;
  q<HTMLTextAreaElement>('question').placeholder = `Ask ${name} something`;
  q('question').hidden = q('ask').hidden = !answers;

  let drawing = 0;
  async function draw() {
    const mine = ++drawing;
    const status = await accounts.status(ME, key);
    // Signed in, even while resting or when the plan lacks something: Ask says why, and Sign out stays.
    const ready = status.state === 'ready' || status.state === 'resting' || status.state === 'not_included';
    const plan = ready ? await accounts.plan(ME, key) : null;
    if (mine !== drawing) return; // a later draw (a sign-out, say) already said how things are
    const view = accounts.view(ME, key);
    const phase = phaseOf({ ready: status.state === 'ready', signIn: view });
    const waiting = view?.state === 'waiting';
    q('status').textContent = status.words;
    q('badge').textContent = plan ? planLabel(name, plan.plan) : '';
    show('badge', !!plan?.plan);
    q('who').textContent = plan?.email ? `Signed in as ${plan.email}` : '';
    show('who', !!plan?.email);
    show('sheet', waiting && (phase === 'code' || phase === 'opening' || phase === 'waiting'));
    q('words').textContent = phase === 'code' ? `On the ${name} page, type this code:`
      : phase === 'waiting' ? `Sign in on the ${name} page, then copy the code it shows and paste it here.` : say('signIn.opening', { name });
    q('code').textContent = view?.code ?? '';
    show('code', phase === 'code');
    q<HTMLAnchorElement>('open').href = view?.url ?? '#';
    show('open', !!view?.url);
    show('paste', key === 'claude' && phase === 'waiting');
    if (view?.state === 'failed') note(view.error ?? '');
    show('signin', !ready && !waiting);
    show('ready', ready);
  }

  q('signin').onclick = () => { note(''); accounts.login(ME, key).then(draw); };
  q('cancel').onclick = () => accounts.cancel(ME, key);
  q('connect').onclick = () => {
    const pasted = q<HTMLInputElement>('pasted');
    if (!pasted.value.trim()) return pasted.focus();
    try { accounts.paste(ME, key, pasted.value); pasted.value = ''; } catch { note(say('signIn.failed', { name })); }
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
  q('signout').onclick = async () => { settle(); await accounts.logout(ME, key); note(''); show('answer', false); draw(); };
  return draw;
}

const $ = (id: string) => document.getElementById(id)!;
// The picker is the catalogue's: every provider this platform can sign in to, in the order the kit offers them.
const draws: Record<string, () => Promise<void>> = Object.fromEntries(accounts.providers.map((p) => [p.key, card(p.key)]));
accounts.onChange = (_member, key) => { draws[key]?.(); };
Promise.all(accounts.providers.map((p) => accounts.signedIn(ME, p.key)))
  .then(() => accounts.keepFresh([ME])).then(() => Object.values(draws).forEach((d) => d()));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
