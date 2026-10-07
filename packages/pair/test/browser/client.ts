// What a browser page (or PWA) does: open a pairing link, pair, then use the link. Bundled for the browser by
// browser.test.ts; it reports back to the host over the link itself.
import { DeviceLink, pairWithCode, pairWithOffer } from '../../src/index.ts';
import { milestone } from './milestones.ts';

(async () => {
  milestone('module-started');
  const shown: string[] = [];
  milestone('offer-pairing');
  const grant = await pairWithOffer(location.href, { name: 'Browser tab', onWords: (w) => shown.push(w) });
  milestone('offer-paired');
  const events: unknown[] = [];
  const link = new DeviceLink(grant, { onEvent: (e) => events.push(e), onStatus: (s) => milestone(`offer-${s}`) });
  milestone('state-requested');
  const state = await link.request('get.state');
  milestone('state-received');
  const code = document.querySelector('meta[name="short-code"]')!.getAttribute('content')!;
  const url = new URL('/link', location.href);
  url.protocol = 'ws:';
  milestone('code-pairing');
  const short = await pairWithCode(url.href, code, { name: 'Umer’s browser', onWords: (w) => shown.push(w) });
  milestone('code-paired');
  const shortLink = new DeviceLink(short, { onStatus: (s) => milestone(`code-${s}`) });
  milestone('short-state-requested');
  const shortState = await shortLink.request('get.state');
  milestone('short-state-received');
  milestone('report-requested');
  await link.request('report', { words: shown[0], state, role: grant.device.role, events, subtle: typeof crypto.subtle,
    shortWords: shown[1], shortState, shortHost: short.host });
})().catch(() => fetch('/failed', { method: 'POST' })); // the milestone trace says where; never send error payloads
