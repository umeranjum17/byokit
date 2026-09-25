// "Sign in with ChatGPT" in a web page: @byokit/accounts' browser side (device code, straight to OpenAI, whose sign-in
// endpoints answer any web page), kept in this browser's IndexedDB, with @byokit/ui-core's phases.
import { Accounts, browserStore, say } from '@byokit/accounts';
import { phaseOf } from '@byokit/ui-core/phase';

declare const __BYOKIT_AUTH_BASE__: string | undefined;
const ME = 1;
const accounts = new Accounts<any, number>({
  app: 'byokit example',
  store: (member) => browserStore(`person-${member}`),
  authBase: __BYOKIT_AUTH_BASE__,
});
const $ = (id: string) => document.getElementById(id)!;
const show = (id: string, on: boolean) => { $(id).hidden = !on; };

async function draw() {
  const status = await accounts.status(ME, 'chatgpt');
  const plan = await accounts.plan(ME);
  const view = accounts.view(ME, 'chatgpt');
  const phase = phaseOf({ ready: status.state === 'ready', signIn: view });
  $('status').textContent = status.words;
  $('plan').textContent = plan && status.state === 'ready' ? `${plan.email}, ${plan.plan} plan` : '';
  show('sheet', view?.state === 'waiting' && (phase === 'code' || phase === 'opening'));
  $('words').textContent = phase === 'code' ? 'On the ChatGPT page, type this code:' : say('signIn.opening', { name: 'ChatGPT' });
  $('code').textContent = view?.code ?? '';
  ($('open') as HTMLAnchorElement).href = view?.url ?? '#';
  if (view?.state === 'failed') $('note').textContent = view.error ?? '';
  show('signin', status.state !== 'ready' && status.state !== 'signing');
  show('recheck', status.state === 'ready');
  show('signout', status.state === 'ready');
}

accounts.onChange = () => { draw(); };
$('signin').onclick = () => { $('note').textContent = ''; accounts.login(ME, 'chatgpt').then(draw); };
$('cancel').onclick = () => accounts.cancel(ME, 'chatgpt');
$('recheck').onclick = async () => {
  // Forces a refresh (the token rotates): what the app does when ChatGPT turns a request away.
  $('note').textContent = (await accounts.recheck(ME, 'chatgpt')) ? 'Still signed in: the sign-in was refreshed.' : 'Signed out.';
  draw();
};
$('signout').onclick = async () => { await accounts.logout(ME, 'chatgpt'); $('note').textContent = ''; draw(); };
accounts.signedIn(ME, 'chatgpt').then(() => accounts.keepFresh([ME])).then(draw);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
