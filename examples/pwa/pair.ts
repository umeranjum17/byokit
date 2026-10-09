// Open host.offer({ role: 'view', base: '<this origin>/pair.html', ... }) or paste an offline envelope.
import { browserDeviceStore, decodeOffer, DeviceLink, offerText, pairWithOffer, parseOffer } from '@byokit/link';

const $ = (id: string) => document.getElementById(id)!;
const store = browserDeviceStore('pwa-example');
let link: DeviceLink | undefined;
function connect(grant: ConstructorParameters<typeof DeviceLink>[0]) {
  link?.stop();
  link = new DeviceLink(grant, { store, onStatus: (s) => {
    $('status').textContent = s === 'online' ? 'Your computer is connected.' : 'Waiting for your computer.';
    $('read').hidden = s !== 'online';
    if (s === 'removed') { $('pair').hidden = false; $('status').textContent = 'Ask your computer for a new invitation.'; }
  } });
  $('pair').hidden = true;
}
function failed(e: unknown) {
  $('status').textContent = e instanceof Error ? e.message : 'Please try again.';
}
const fragment = location.hash;
if (fragment) {
  // Do not leave the single-use ticket in the address bar/history after opening the terminal's link.
  history.replaceState(null, '', location.pathname + location.search);
  ($('offer') as HTMLTextAreaElement).value = fragment;
}
$('pair').onsubmit = async (e) => {
  e.preventDefault();
  const button = $('connect') as HTMLButtonElement;
  button.disabled = true;
  try {
    const text = ($('offer') as HTMLTextAreaElement).value;
    const offer = text.includes('byokit-link:1:') ? parseOffer(text) : decodeOffer(text);
    if (!('ticket' in offer)) throw new Error('Ask your computer for a pairing link or code.');
    // Host-side policy is authoritative. This example also refuses offers that don't explicitly say view-only.
    if (offer.role !== 'view') throw new Error('Ask your computer for an invitation to read here.');
    const grant = await pairWithOffer(offerText(offer), { name: 'My browser', onWords: (words) => {
      $('words').textContent = `Check your computer shows “${words}”, then say yes there.`;
    } });
    await store.save(grant);
    ($('offer') as HTMLTextAreaElement).value = '';
    $('words').textContent = '';
    connect(grant);
  } catch (e) { failed(e); }
  finally { button.disabled = false; }
};
$('read').onclick = async () => {
  try { $('answer').textContent = JSON.stringify(await link!.request('get.summary')); }
  catch (e) { failed(e); }
};
store.load().then((grant) => { if (grant && !fragment) connect(grant); }).catch(failed);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
