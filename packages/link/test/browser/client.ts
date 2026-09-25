// What a browser page (or PWA) does: open a pairing link, pair, then use the link. Bundled for the browser by
// browser.test.ts; it reports back to the host over the link itself.
import { DeviceLink, pairWithOffer } from '../../src/index.ts';

(async () => {
  const shown: string[] = [];
  const grant = await pairWithOffer(location.href, { name: 'Browser tab', onWords: (w) => shown.push(w) });
  const events: unknown[] = [];
  const link = new DeviceLink(grant, { onEvent: (e) => events.push(e) });
  const state = await link.request('get.state');
  await link.request('report', { words: shown[0], state, role: grant.device.role, events, subtle: typeof crypto.subtle });
})().catch((e) => { document.title = `failed: ${e?.message ?? e}`; });
