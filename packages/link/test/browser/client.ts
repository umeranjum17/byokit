// What a browser page (or PWA) does: open a pairing link, pair, then use the link. Bundled for the browser by
// browser.test.ts; it reports back to the host over the link itself.
import { DeviceLink, pairWithCode, pairWithOffer } from '../../src/index.ts';

(async () => {
  const shown: string[] = [];
  const grant = await pairWithOffer(location.href, { name: 'Browser tab', onWords: (w) => shown.push(w) });
  const events: unknown[] = [];
  const link = new DeviceLink(grant, { onEvent: (e) => events.push(e) });
  const state = await link.request('get.state');
  const code = document.querySelector('meta[name="short-code"]')!.getAttribute('content')!;
  const url = new URL('/link', location.href);
  url.protocol = 'ws:';
  const short = await pairWithCode(url.href, code, { name: 'Umer’s browser', onWords: (w) => shown.push(w) });
  const shortLink = new DeviceLink(short);
  const shortState = await shortLink.request('get.state');
  await link.request('report', { words: shown[0], state, role: grant.device.role, events, subtle: typeof crypto.subtle,
    shortWords: shown[1], shortState, shortHost: short.host });
})().catch((e) => fetch('/failed', { method: 'POST', body: String(e?.stack ?? e?.message ?? e) })); // so the test says why
