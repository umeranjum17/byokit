// Consumer journeys for the published @byokit/discover surface, driven the way a host app uses it: `reach()` to get
// the dial addresses and set up Tailscale Serve, `serve`/`unserve` to own exactly one mapping, `recommend()` to pick
// the route a person sees, and `advertise`/`tailscaleState`/`isPeer` for mDNS and diagnostics. Everything runs against
// a fake `tailscale` CLI that logs every call (the real binary never runs) and a fake mDNS publisher; no packet goes
// out. Every security and correctness contract the old table/unit cases held survives as an assertion inside a
// journey: Serve stays on loopback and never uses Funnel, a foreign root is never touched, a mapping is reused/removed
// only by its recorded fingerprint, a broken Tailscale is an error rather than a silent LAN, only this machine's own
// addresses are dialled, mDNS never advertises bridge/tailnet addresses, and the recommendation order and reasons hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { routeChoices } from '@byokit/ui/route';
import {
  FUNNEL_ERROR, SERVE_OWNED_ERROR, advertise, directRoutes, inspectServe, isPeer, needsSignin,
  reach, recommend, routes, serve, tailscaleState, unserve,
  type Bonjour, type BonjourRecord, type ServeIngress, type TailscaleState,
} from '@byokit/discover';

const dir = scratchDir('journey-reach');
const bin = join(dir, 'tailscale');
const log = join(dir, 'tailscale.log');
const state = join(dir, 'serve.json');
const tailscale = { bin, timeoutMs: 3_000 };
process.env.PATH = dir;
const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const self = { Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] } };
const occupied = JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } });
const ours = JSON.stringify({ Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8792' } } } } });
const funnel = JSON.stringify({ AllowFunnel: { 'dev.tailnet.ts.net:443': true }, Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8792' } } } } });
const owned: ServeIngress = { kind: 'tailscale-serve', port: 8792, dnsName: 'dev.tailnet.ts.net', proxy: 'http://127.0.0.1:8792' };
const missing = { bin: join(dir, 'not-installed') };
const nic = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal, cidr: `${address}/24` });

function fakeCli(status: unknown, { serveStatus = '{}', serveStatusExit = 0, apply = ':', afterApply = ours, afterOff = '{}' } = {}): void {
  writeFileSync(state, serveStatus);
  writeFileSync(bin, `#!/bin/sh
[ "$TAILSCALE_BE_CLI" = 1 ] || exit 2
printf '%s\\n' "$*" >> ${sq(log)}
case "$*" in
  "status --json") printf '%s' ${sq(JSON.stringify(status))} ;;
  "serve status --json") /bin/cat ${sq(state)}; exit ${serveStatusExit} ;;
  "serve --yes --bg --https=443 http://127.0.0.1:8792") ${apply}; [ "$?" = 0 ] || exit 1; printf '%s' ${sq(afterApply)} > ${sq(state)} ;;
  "serve --https=443 --set-path=/ off") printf '%s' ${sq(afterOff)} > ${sq(state)} ;;
  *) exit 1 ;;
esac
`);
  chmodSync(bin, 0o755);
}
const mark = () => (existsSync(log) ? readFileSync(log, 'utf8').length : 0);
const since = (at: number) => readFileSync(log, 'utf8').slice(at);
const noWrites = (text: string) => assert.doesNotMatch(text, /^serve --yes|^serve --https=443 --set-path=\/ off$/m);

test('an app serves on loopback and never disturbs a root someone else owns or one with Funnel on', async () => {
  // A free root: Serve publishes loopback at the MagicDNS name, the server binds loopback, and Funnel is never used.
  fakeCli(self);
  const at = mark();
  assert.deepEqual(await reach({ port: 8792, tailscale }), { urls: ['wss://dev.tailnet.ts.net'], bind: '127.0.0.1', ingress: owned });
  assert.match(since(at), /^serve --yes --bg --https=443 http:\/\/127\.0\.0\.1:8792$/m);
  assert.doesNotMatch(since(at), /funnel/i);

  // A root we did not record is refused, and a stale fingerprint never resets a foreign owner.
  fakeCli(self, { serveStatus: occupied });
  const foreign = mark();
  await assert.rejects(reach({ port: 8792, tailscale }), new RegExp(SERVE_OWNED_ERROR));
  assert.equal(await unserve(owned, tailscale), false);
  noWrites(since(foreign));

  // A root that becomes occupied after setup is reported without further writes.
  fakeCli(self, { afterApply: occupied });
  const changed = mark();
  await assert.rejects(reach({ port: 8792, tailscale }), /another service took the Serve root/);
  assert.equal((await inspectServe(8792, owned.dnsName, tailscale)).status, 'occupied');
  assert.doesNotMatch(since(changed), /^serve --https=443 --set-path=\/ off$/m);

  // Funnel on the root is never reused, removed or accepted after a write.
  fakeCli(self, { serveStatus: funnel });
  const funnelled = mark();
  assert.equal((await inspectServe(8792, owned.dnsName, { ...tailscale, proxy: owned.proxy })).status, 'funnel');
  await assert.rejects(serve(8792, tailscale, owned), new RegExp(FUNNEL_ERROR));
  await assert.rejects(unserve(owned, tailscale), new RegExp(FUNNEL_ERROR));
  noWrites(since(funnelled));
  fakeCli(self, { afterApply: funnel });
  await assert.rejects(serve(8792, tailscale), /Funnel is on.*reach never uses Funnel/);
  fakeCli(self, { serveStatus: ours, afterOff: funnel });
  await assert.rejects(unserve(owned, tailscale), /Funnel is on.*reach never uses Funnel/);
});

test('an app reuses only its own Serve mapping, removes exactly what it made, and keeps a fingerprint when it cannot', async () => {
  // A recorded fingerprint is reused; a different MagicDNS name is treated as someone else's root.
  fakeCli(self, { serveStatus: ours });
  await assert.rejects(serve(8792, tailscale), new RegExp(SERVE_OWNED_ERROR));
  assert.equal((await serve(8792, tailscale, owned))?.url, 'wss://dev.tailnet.ts.net');
  await assert.rejects(serve(8792, tailscale, { ...owned, dnsName: 'other.tailnet.ts.net' }), new RegExp(SERVE_OWNED_ERROR));

  // unserve removes only the owned root and leaves sibling paths in place.
  fakeCli(self, { serveStatus: JSON.stringify({ Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: owned.proxy }, '/other': { Text: 'keep' } } } } }) });
  const removed = mark();
  assert.equal(await unserve(owned, tailscale), true);
  assert.match(since(removed), /^serve --https=443 --set-path=\/ off$/m);
  assert.doesNotMatch(since(removed), /^serve --https=443 off$/m);

  // On a DNS rename the recorded old root is removed before the new one is served.
  const old = { ...owned, dnsName: 'old.tailnet.ts.net' };
  fakeCli(self, { serveStatus: JSON.stringify({ Web: { 'old.tailnet.ts.net:443': { Handlers: { '/': { Proxy: owned.proxy } } } } }) });
  const renamed = mark();
  assert.deepEqual(await reach({ port: 8792, previous: old, tailscale }), { urls: ['wss://dev.tailnet.ts.net'], bind: '127.0.0.1', ingress: owned });
  assert.deepEqual(since(renamed).trim().split('\n'), [
    'status --json', 'serve status --json', 'serve --https=443 --set-path=/ off', 'serve status --json',
    'serve status --json', 'serve --yes --bg --https=443 http://127.0.0.1:8792', 'serve status --json',
  ]);

  // A Funnel-enabled old root stops the rename before a new one is served.
  fakeCli(self, { serveStatus: JSON.stringify({ AllowFunnel: { 'old.tailnet.ts.net:443': true }, Web: { 'old.tailnet.ts.net:443': { Handlers: { '/': { Proxy: owned.proxy } } } } }) });
  const blocked = mark();
  await assert.rejects(reach({ port: 8792, previous: old, tailscale }), /Funnel is on.*Turn it off before continuing/);
  noWrites(since(blocked));

  // A write that cannot be verified exposes its fingerprint for a later cleanup.
  fakeCli(self, { afterApply: 'not json' });
  let pending: ServeIngress | undefined;
  await assert.rejects(reach({ port: 8792, tailscale }), (error: Error & { pendingCleanup?: ServeIngress }) => {
    pending = error.pendingCleanup;
    return /could not verify/.test(error.message) && !/occupied|another service/.test(error.message);
  });
  assert.deepEqual(pending, owned);
  fakeCli(self, { serveStatus: ours });
  assert.equal(await unserve(pending, tailscale), true);

  // A disabled Serve names the enable link, and a hung Serve times out instead of blocking setup.
  const notice = 'Serve is not enabled on your tailnet.\nTo enable, visit: https://login.tailscale.com/f/serve-test';
  fakeCli(self, { serveStatus: notice, serveStatusExit: 1 });
  const off = await inspectServe(8792, owned.dnsName, tailscale);
  assert.equal(off.status, 'disabled');
  assert.match(off.reason!, /Serve is not enabled.*login\.tailscale\.com.*direct Tailscale or LAN/s);
  fakeCli(self, { serveStatus: 'not json' });
  assert.equal((await inspectServe(8792, owned.dnsName, tailscale)).status, 'inconclusive');
  fakeCli(self, { apply: `printf '%s\\n' ${sq(notice)} >&2; exec /bin/sleep 30` });
  await assert.rejects(reach({ port: 8792, tailscale: { bin, timeoutMs: 500 } }), /Serve is not enabled.*login\.tailscale\.com/s);
});

test('an app falls back to direct Tailscale or LAN, and a broken Tailscale is an error rather than a silent LAN', async () => {
  // Direct Tailscale is the fallback and the rollback: it removes only the mapping this package made.
  fakeCli(self, { serveStatus: ours });
  let at = mark();
  assert.deepEqual(await reach({ port: 8792, via: 'tailscale-direct', previous: owned, tailscale }), { urls: ['ws://100.64.0.1:8792'], bind: '100.64.0.1' });
  assert.match(since(at), /^serve --https=443 --set-path=\/ off$/m);

  // Only an address from this machine's own Self.TailscaleIPs may be bound; a foreign or wildcard one is refused first.
  fakeCli({ Self: { TailscaleIPs: ['100.64.0.1', '100.64.0.2'] } }, { serveStatus: ours });
  at = mark();
  assert.deepEqual(await reach({ port: 8792, via: 'tailscale-direct', address: '100.64.0.2', tailscale }), { urls: ['ws://100.64.0.2:8792'], bind: '100.64.0.2' });
  for (const address of ['0.0.0.0', '192.168.1.8', '100.64.0.99', '']) {
    await assert.rejects(reach({ port: 8792, via: 'tailscale-direct', address, previous: owned, tailscale }), /no Tailscale address/);
  }
  assert.doesNotMatch(since(at), /off/);

  // An unavailable explicit destination leaves a working Serve mapping intact.
  fakeCli({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: [] } }, { serveStatus: ours });
  at = mark();
  await assert.rejects(reach({ port: 8792, via: 'tailscale-direct', previous: owned, tailscale }), /no Tailscale address/);
  await assert.rejects(reach({ port: 8792, via: 'lan', previous: owned, tailscale, interfaces: {} }), /no LAN address/);
  await assert.rejects(reach({ port: 8792, via: 'private', previous: owned, tailscale, interfaces: {} }), /no private network address/);
  assert.doesNotMatch(since(at), /^serve --https=443 --set-path=\/ off$/m);

  // A missing or nameless Tailscale is a loud error, never a silent LAN fallback.
  const interfaces = { eno1: [nic('192.168.1.8')] };
  await assert.rejects(reach({ port: 8792, via: 'tailscale', tailscale: missing }), /not installed/);
  fakeCli({ Self: { TailscaleIPs: ['100.64.0.1'] } });
  await assert.rejects(reach({ port: 8792, tailscale }), /MagicDNS name is unavailable/);
  await assert.rejects(reach({ port: 0, tailscale: missing }), /port/);

  // When Tailscale disappears, auto falls back to LAN and keeps the Serve fingerprint for a later retry.
  assert.deepEqual(await reach({ port: 8792, previous: owned, tailscale: missing, interfaces }), {
    urls: ['ws://192.168.1.8:8792'], bind: '0.0.0.0', pendingCleanup: owned,
  });

  // Failed cleanup on a LAN/private route switch retains the fingerprint; a successful one omits it.
  fakeCli(self, { serveStatus: 'Serve is not enabled on your tailnet', serveStatusExit: 1 });
  const transitions = { eno1: [nic('192.168.1.8')], wt0: [nic('100.90.0.4')] };
  assert.deepEqual(await reach({ port: 8792, via: 'lan', previous: owned, tailscale, interfaces: transitions }), {
    urls: ['ws://192.168.1.8:8792'], bind: '0.0.0.0', pendingCleanup: owned,
  });
  assert.deepEqual(await reach({ port: 8792, via: 'private', previous: owned, tailscale, interfaces: transitions }), {
    urls: ['ws://100.90.0.4:8792'], bind: '0.0.0.0', pendingCleanup: owned,
  });
  fakeCli(self, { serveStatus: ours });
  assert.deepEqual(await reach({ port: 8793, via: 'lan', previous: owned, tailscale, interfaces }), {
    urls: ['ws://192.168.1.8:8793'], bind: '0.0.0.0',
  });
});

test('an app picks dial addresses without exposing Docker, VM or VPN bridges', async () => {
  // routes keeps physical LAN addresses and overlays apart, includes Tailscale, and skips known bridges.
  const v4 = (address: string) => [{ family: 'IPv4', internal: false, address }];
  const bridge = Object.fromEntries(['docker0', 'vboxnet0', 'br-test', 'veth0', 'virbr0', 'podman0', 'lxc0', 'vmnet0', 'hyperv0', 'wsl0']
    .map((name, i) => [name, v4(`100.90.0.${i + 2}`)]));
  assert.deepEqual(routes({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], ...bridge,
    eno1: v4('192.168.1.8'), wlan0: v4('10.0.0.5'), wt0: v4('100.90.0.4'), tailscale0: v4('100.64.0.1'), eth1: v4('8.8.8.8'),
  } as never), { lan: ['192.168.1.8', '10.0.0.5'], private: [{ address: '100.90.0.4', interface: 'wt0' }], tailscale: ['100.64.0.1'] });
  // A macOS utun Tailscale address is recognised only when the snapshot supplies it, never guessed from the range.
  assert.deepEqual(routes({ utun4: v4('100.64.0.1'), utun5: v4('10.20.0.2') } as never, ['100.64.0.1']).private, [{ address: '10.20.0.2', interface: 'utun5' }]);

  // directRoutes enables only requested scopes, orders LAN before tailnet, and validates port, path and hosts.
  const interfaces = { lo: [nic('127.0.0.1', true)], en0: [nic('192.168.1.20')], utun3: [nic('100.101.2.3')], wt0: [nic('100.90.1.2')], docker0: [nic('172.17.0.1')] };
  const base = { interfaces, tailnetIPs: ['100.101.2.3'], port: 8792, path: '/link' };
  assert.deepEqual(directRoutes(base), { hosts: ['127.0.0.1', '100.101.2.3'], urls: ['ws://100.101.2.3:8792/link'] });
  assert.deepEqual(directRoutes({ ...base, listen: { loopback: true, tailnet: true, lan: true } }), {
    hosts: ['127.0.0.1', '100.101.2.3', '192.168.1.20'], urls: ['ws://192.168.1.20:8792/link', 'ws://100.101.2.3:8792/link'],
  });
  assert.deepEqual(directRoutes({ ...base, listen: {} }), { hosts: [], urls: [] });
  assert.deepEqual(directRoutes({ port: 8792, interfaces: {} }), { hosts: ['127.0.0.1'], urls: ['ws://127.0.0.1:8792'] });
  assert.deepEqual(directRoutes({ ...base, hosts: ['0.0.0.0'] }).urls, ['ws://192.168.1.20:8792/link', 'ws://100.101.2.3:8792/link']);
  assert.deepEqual(directRoutes({ ...base, hosts: ['127.umer.local'] }).urls, ['ws://127.umer.local:8792/link'], 'a DNS label starting with 127 is not loopback');
  for (const port of [0, 65536, 1.5, NaN]) assert.throws(() => directRoutes({ ...base, port }), /port/);
  for (const path of ['link', '//elsewhere', '/link?q=1', '/link#x']) assert.throws(() => directRoutes({ ...base, path }), /path/);
  for (const hosts of [['ws://umer'], ['umer:8792'], [''], [' umer'], ['umer..local'], ['127.1']]) assert.throws(() => directRoutes({ ...base, hosts }), /hosts/);

  // A private-overlay route never binds a Tailscale address, even on macOS utun interfaces.
  fakeCli(self);
  assert.deepEqual(await reach({ port: 8792, via: 'private', tailscale, interfaces: { utun4: [nic('100.64.0.1')], utun5: [nic('100.90.0.4')] } }), { urls: ['ws://100.90.0.4:8792'], bind: '0.0.0.0' });
  // Private routes stay available even when Tailscale cannot answer.
  for (const script of ['echo "logged out" >&2; exit 1', 'echo not-json']) {
    writeFileSync(bin, `#!/bin/sh\n${script}\n`); chmodSync(bin, 0o755);
    assert.deepEqual(await reach({ port: 8792, via: 'private', tailscale: { bin, timeoutMs: 50 }, interfaces: { wt0: [nic('100.90.0.4')] } }), { urls: ['ws://100.90.0.4:8792'], bind: '0.0.0.0' });
  }
});

test('a computer advertises over mDNS without leaking bridge or tailnet addresses, and reads Tailscale without changing it', async () => {
  // advertise publishes one service and stops both the service and the browser.
  const calls: unknown[] = [];
  const bonjour: Bonjour = {
    publish: (config) => { calls.push(config); return { stop: (cb) => { calls.push('stop'); cb?.(); } }; },
    destroy: (cb) => { calls.push('destroy'); cb?.(); },
  };
  const ad = await advertise({ type: 'muxr', port: 8792, name: 'Desk', txt: { url: 'ws://192.168.1.8:8792' }, bonjour });
  await ad.stop();
  assert.deepEqual(calls[0], { name: 'Desk', type: 'muxr', port: 8792, txt: { url: 'ws://192.168.1.8:8792' } });
  assert.deepEqual(calls.slice(1), ['stop', 'destroy']);

  // A/AAAA records are filtered to the selected addresses on announce and goodbye; discovery metadata is kept.
  const metadata: BonjourRecord[] = [
    { type: 'PTR', data: 'Desk._muxr._tcp.local' }, { type: 'SRV', data: { port: 8792, target: 'desk.local' } }, { type: 'TXT', data: { url: 'ws://192.168.1.8:8792' } },
  ];
  const records = [...metadata, ...['192.168.1.8', '172.17.0.1', '100.64.0.1', '127.0.0.1'].map((data) => ({ type: 'A', data })),
    ...['fd00::8', 'fd7a::1', '::1'].map((data) => ({ type: 'AAAA', data }))];
  let stopped: BonjourRecord[] = [];
  const service = { records() { assert.equal(this, service); return records; }, stop(cb?: () => void) { stopped = this.records(); cb?.(); } };
  const publisher: Bonjour = { publish: () => service, destroy: (cb) => cb?.() };
  const handle = await advertise({ type: 'muxr', port: 8792, addresses: ['192.168.1.8', 'fd00::8'], bonjour: publisher });
  const expected = [...metadata, { type: 'A', data: '192.168.1.8' }, { type: 'AAAA', data: 'fd00::8' }];
  assert.deepEqual(service.records(), expected);
  await handle.stop();
  assert.deepEqual(stopped, expected);

  // Diagnostics report backend state without signing in or changing Serve; malformed output never throws.
  fakeCli({ ...self, BackendState: 'Running' });
  const at = mark();
  assert.deepEqual(await tailscaleState(tailscale), {
    installed: true, backendState: 'Running', needsSignin: false, reason: undefined, dnsName: 'dev.tailnet.ts.net', ips: ['100.64.0.1', 'fd7a::1'],
  });
  assert.equal(since(at), 'status --json\n');
  for (const backendState of ['NeedsLogin', 'NeedsMachineAuth', 'Stopped', 'Starting']) {
    fakeCli({ BackendState: backendState });
    const result = await tailscaleState(tailscale);
    assert.equal(result.backendState, backendState);
    assert.equal(result.needsSignin, backendState === 'NeedsLogin');
    assert.deepEqual(result.ips, []);
  }
  assert.deepEqual(await tailscaleState(missing), { installed: false, needsSignin: false, ips: [], reason: 'Tailscale is not installed' });
  for (const [script, reason] of [['echo unavailable >&2; exit 1', /unavailable/], ['echo not-json', /invalid status JSON/]] as const) {
    writeFileSync(bin, `#!/bin/sh\n${script}\n`); chmodSync(bin, 0o755);
    const broken = await tailscaleState({ bin, timeoutMs: 50 });
    assert.equal(broken.installed, true);
    assert.match(broken.reason!, reason);
  }

  // Key expiry and typed peers are validated and exposed without extra CLI calls.
  fakeCli({ ...self, Self: { ...self.Self, KeyExpiry: '2026-10-01T00:00:00Z' }, Peer: {
    good: { TailscaleIPs: ['100.64.0.2', null], DNSName: 'PHONE.TAIL.NET.', Online: false, Secret: 'discard' }, bad: null,
  } });
  const snap = await tailscaleState(tailscale);
  assert.equal(snap.keyExpiry, '2026-10-01T00:00:00Z');
  assert.deepEqual(snap.Peer, { good: { TailscaleIPs: ['100.64.0.2'], DNSName: 'phone.tail.net', Online: false } });
  assert.equal(isPeer(snap, '100.64.0.2'), true);

  // The pure helpers use explicit login state and peer membership, never address ranges or Self.
  assert.equal(needsSignin({ BackendState: 'NeedsLogin' }), true);
  for (const status of [undefined, null, {}, { BackendState: 'NeedsMachineAuth' }, { BackendState: 'Stopped' }]) assert.equal(needsSignin(status), false);
  const status = { ...self, Peer: { a: { TailscaleIPs: ['100.64.0.2', 'fd7a::2'], Online: false }, b: null, c: { TailscaleIPs: '100.64.0.3' } } };
  for (const ip of ['100.64.0.2', '::ffff:100.64.0.2', 'fd7a::2']) assert.equal(isPeer(status, ip), true);
  for (const ip of ['100.64.0.1', '100.64.0.3', '192.168.1.1', '']) assert.equal(isPeer(status, ip), false);
});

test('an app recommends the route a person sees: Serve, then direct when Serve is taken, then Same Wi-Fi', async () => {
  const words = new Map(routeChoices().map((c) => [c.code, c] as const));
  const up = { installed: true, backendState: 'Running', needsSignin: false, dnsName: 'dev.tailnet.ts.net', ips: ['100.64.0.1'] } satisfies TailscaleState;
  const out = { installed: true, backendState: 'NeedsLogin', needsSignin: true, ips: [] } satisfies TailscaleState;
  const absent = { installed: false, needsSignin: false, reason: 'Tailscale is not installed', ips: [] } satisfies TailscaleState;
  const lanOnly = { en0: [nic('192.168.1.20')] };
  const overlay = { en0: [nic('192.168.1.20')], wt0: [nic('100.90.1.2')] };
  const order = (entries: Awaited<ReturnType<typeof recommend>>) => entries.map((e) => e.via);
  const picked = (entries: Awaited<ReturnType<typeof recommend>>) => entries.find((e) => e.recommended)?.via;

  // Connected with a free root: Serve is recommended and carries the words from the one table.
  let entries = await recommend({ state: up, serve: { status: 'free' }, interfaces: lanOnly });
  assert.equal(picked(entries), 'tailscale');
  assert.deepEqual(order(entries), ['tailscale', 'tailscale-direct', 'private', 'lan']);
  assert.equal(entries[0]!.sentence, words.get('tailscale')!.sentence);
  assert.equal(entries[0]!.disabledReason, undefined);

  // A taken, disabled, funnelled or nameless Serve root recommends direct Tailscale and says why.
  for (const serve of [{ status: 'occupied' as const }, { status: 'disabled' as const, reason: 'Serve is not enabled.' }, { status: 'funnel' as const, reason: 'Funnel is on.' }]) {
    entries = await recommend({ state: up, serve, interfaces: lanOnly });
    assert.equal(picked(entries), 'tailscale-direct', serve.status);
    assert.ok(entries.find((e) => e.via === 'tailscale')?.disabledReason, serve.status);
  }
  entries = await recommend({ state: { ...up, dnsName: undefined }, serve: { status: 'free' }, interfaces: lanOnly });
  assert.equal(picked(entries), 'tailscale-direct');
  assert.match(entries.find((e) => e.via === 'tailscale')?.disabledReason ?? '', /MagicDNS/);

  // Signed-out Tailscale stays selectable with sign-in in `needs` while Same Wi-Fi is recommended.
  entries = await recommend({ state: out, serve: { status: 'inconclusive' }, interfaces: lanOnly });
  assert.equal(picked(entries), 'lan');
  for (const via of ['tailscale', 'tailscale-direct'] as const) {
    const e = entries.find((x) => x.via === via)!;
    assert.equal(e.disabledReason, undefined, via);
    assert.match(e.needs, /Sign in to Tailscale next/);
  }

  // Missing Tailscale disables both Tailscale routes; a private overlay outranks LAN; a healthy current route stays first.
  entries = await recommend({ state: absent, serve: { status: 'inconclusive' }, interfaces: lanOnly });
  assert.equal(picked(entries), 'lan');
  assert.ok(entries.find((e) => e.via === 'tailscale')?.disabledReason);
  assert.ok(entries.find((e) => e.via === 'tailscale-direct')?.disabledReason);
  assert.equal(picked(await recommend({ state: absent, serve: { status: 'inconclusive' }, interfaces: overlay })), 'private');
  const kept = await recommend({ state: up, serve: { status: 'free' }, interfaces: overlay, current: { via: 'lan', healthy: true } });
  assert.equal(picked(kept), 'lan');
  assert.deepEqual(order(kept), ['lan', 'tailscale', 'tailscale-direct', 'private']);
  assert.equal(picked(await recommend({ state: up, serve: { status: 'free' }, interfaces: lanOnly, current: { via: 'lan', healthy: false } })), 'tailscale');

  // Nothing ready recommends nothing, with a reason on every route.
  entries = await recommend({ state: absent, serve: { status: 'inconclusive' }, interfaces: {} });
  assert.equal(picked(entries), undefined);
  assert.deepEqual(order(entries), ['tailscale', 'tailscale-direct', 'private', 'lan']);
  for (const e of entries) assert.ok(e.disabledReason, e.via);

  // With no fakes it probes this computer: fake CLI status, Serve root and interface list, Serve first.
  fakeCli({ BackendState: 'Running', Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
  entries = await recommend({ tailscale, interfaces: lanOnly });
  assert.equal(picked(entries), 'tailscale');
  assert.deepEqual(order(entries), ['tailscale', 'tailscale-direct', 'private', 'lan']);
});
