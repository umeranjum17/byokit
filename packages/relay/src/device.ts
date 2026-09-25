// The device's side, for typed pairing through a relay: turn the short code the host showed into the address to dial.
// No Node APIs, so it runs in browsers and React Native too.

/** The link address for a short code from `RelayClient.code()`, e.g. `findHost('https://relay.example', 'K7M2QX')` →
 *  `wss://relay.example/link/v1/<host id>`. Pass it to link's `pairWithCode` with the pairing code. */
export async function findHost(relay: string, code: string, o: { fetch?: typeof fetch } = {}): Promise<string> {
  const base = new URL(relay);
  const res = await (o.fetch ?? fetch)(new URL(`/relay/v1/codes/${encodeURIComponent(code.trim())}`, base));
  if (res.status === 404) throw new Error('That code is wrong or has run out. Show a new one.');
  if (!res.ok) throw new Error("Couldn't reach the relay. Try again.");
  const { host } = (await res.json()) as { host?: unknown };
  if (typeof host !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(host)) throw new Error("Couldn't reach the relay. Try again.");
  const secure = base.protocol === 'https:' || base.protocol === 'wss:';
  return `${secure ? 'wss' : 'ws'}://${base.host}/link/v1/${host}`;
}
