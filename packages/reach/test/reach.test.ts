// A port of muxr's checkTailscaleIngress: every case runs a fake tailscale CLI that logs its arguments. The real
// tailscale binary is never run: each call passes `bin`, and PATH holds only the fake's directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advertise, inspectServe, reach, routes, serve, tailscaleName, unserve, type Bonjour, type ServeIngress } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'byokit-reach-'));
const bin = join(dir, 'tailscale');
const log = join(dir, 'tailscale.log');
const state = join(dir, 'serve.json');
const tailscale = { bin, timeoutMs: 3_000 };
process.env.PATH = dir;
const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function fake(status: unknown, { serveStatus = '{}', serveStatusExit = 0, apply = ':', afterApply = ours, afterOff = '{}' } = {}) {
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
const self = { Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] } };
const occupied = JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } });
const ours = JSON.stringify({ Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8792' } } } } });
const funnel = JSON.stringify({ AllowFunnel: { 'dev.tailnet.ts.net:443': true }, Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8792' } } } } });
const owned: ServeIngress = { kind: 'tailscale-serve', port: 8792, dnsName: 'dev.tailnet.ts.net', proxy: 'http://127.0.0.1:8792' };

test('Serve publishes loopback at the MagicDNS name, never Funnel, and binds the server to loopback', async () => {
  fake(self);
  const at = mark();
  assert.equal(await tailscaleName(tailscale), 'dev.tailnet.ts.net');
  assert.deepEqual(await reach({ port: 8792, tailscale }), { urls: ['wss://dev.tailnet.ts.net'], bind: '127.0.0.1', ingress: owned });
  assert.match(since(at), /^serve --yes --bg --https=443 http:\/\/127\.0\.0\.1:8792$/m);
  assert.doesNotMatch(since(at), /funnel/i);
});

test('only a root matching a prior app-created fingerprint can be reused', async () => {
  fake(self, { serveStatus: ours });
  let at = mark();
  await assert.rejects(serve(8792, tailscale), /already owned/);
  assert.doesNotMatch(since(at), /serve --yes/);
  assert.equal((await serve(8792, tailscale, owned))?.url, 'wss://dev.tailnet.ts.net');
  await assert.rejects(serve(8792, tailscale, { ...owned, dnsName: 'other.tailnet.ts.net' }), /already owned/);
  fake(self, { serveStatus: JSON.stringify({ Web: { 'other.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } }) });
  at = mark();
  assert.equal((await serve(8792, tailscale))?.url, 'wss://dev.tailnet.ts.net');
  assert.match(since(at), /serve --yes/);
});

test('a changed root after Serve setup is reported as occupied without touching it again', async () => {
  fake(self, { afterApply: occupied });
  const at = mark();
  await assert.rejects(reach({ port: 8792, tailscale }), /already owned.*another service took the Serve root/);
  assert.equal((await inspectServe(8792, owned.dnsName, tailscale)).status, 'occupied');
  assert.doesNotMatch(since(at), /^serve --https=443 --set-path=\/ off$/m);
});

test('Funnel-enabled roots are never reused, removed or accepted after writes', async () => {
  fake(self, { serveStatus: funnel });
  const at = mark();
  assert.equal((await inspectServe(8792, owned.dnsName, { ...tailscale, proxy: owned.proxy })).status, 'funnel');
  await assert.rejects(serve(8792, tailscale, owned), /Funnel is on.*reach never uses Funnel/);
  await assert.rejects(unserve(owned, tailscale), /Funnel is on.*reach never uses Funnel/);
  assert.doesNotMatch(since(at), /^serve --yes|^serve --https=443 --set-path=\/ off$/m);

  fake(self, { afterApply: funnel });
  await assert.rejects(serve(8792, tailscale), /Funnel is on.*reach never uses Funnel/);
  fake(self, { serveStatus: ours, afterOff: funnel });
  await assert.rejects(unserve(owned, tailscale), /Funnel is on.*reach never uses Funnel/);
});

test('a successful Serve write with inconclusive status is unverifiable, not occupied', async () => {
  fake(self, { afterApply: 'not json' });
  const at = mark();
  await assert.rejects(serve(8792, tailscale), (error: Error) => /could not verify/.test(error.message) && !/occupied|another service/.test(error.message));
  assert.doesNotMatch(since(at), /^serve --https=443 --set-path=\/ off$/m);
});

test('an occupied root handler is refused and never claimed or reset', async () => {
  fake(self, { serveStatus: occupied });
  const at = mark();
  assert.equal((await inspectServe(8792, 'dev.tailnet.ts.net', tailscale)).status, 'occupied');
  await assert.rejects(reach({ port: 8792, tailscale }), /already owned/);
  assert.equal(await unserve(owned, tailscale), false, 'stale ownership reset a later foreign owner');
  assert.doesNotMatch(since(at), /serve --yes|serve --https=443 .*off/);
  fake(self, { serveStatus: JSON.stringify({ Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Text: 'taken' } } } } }) });
  await assert.rejects(reach({ port: 8792, tailscale }), /already owned/);
  assert.equal(await unserve(owned, tailscale), false);
});

test('a changed root after Serve removal is reported as occupied without further writes', async () => {
  fake(self, { serveStatus: ours, afterOff: occupied });
  const at = mark();
  await assert.rejects(unserve(owned, tailscale), /already owned.*another service took the Serve root/);
  assert.equal((await inspectServe(8792, owned.dnsName, tailscale)).status, 'occupied');
  assert.equal(since(at).split('\n').filter((line) => line.startsWith('serve --https=443 --set-path=/ off')).length, 1);
});

test('Serve disabled on the tailnet names the enable link; a hung Serve times out', async () => {
  const notice = 'Serve is not enabled on your tailnet.\nTo enable, visit: https://login.tailscale.com/f/serve-test';
  fake(self, { serveStatus: notice, serveStatusExit: 1 });
  const off = await inspectServe(8792, 'dev.tailnet.ts.net', tailscale);
  assert.equal(off.status, 'disabled');
  assert.match(off.reason!, /Serve is not enabled.*login\.tailscale\.com.*direct Tailscale or LAN/s);
  fake(self, { serveStatus: 'not json' });
  assert.equal((await inspectServe(8792, 'dev.tailnet.ts.net', tailscale)).status, 'inconclusive');
  fake(self, { apply: `printf '%s\\n' ${sq(notice)} >&2; exec /bin/sleep 30` });
  const at = Date.now();
  await assert.rejects(reach({ port: 8792, tailscale: { bin, timeoutMs: 500 } }), /Serve is not enabled.*login\.tailscale\.com/s);
  assert.ok(Date.now() - at < 10_000, 'a hung Serve left setup blocked');
});

test('no MagicDNS name or an invalid one fails loudly instead of exposing the LAN', async () => {
  fake({ Self: { TailscaleIPs: ['100.64.0.1'] } });
  await assert.rejects(reach({ port: 8792, tailscale }), /MagicDNS name is unavailable/);
  fake({ Self: { DNSName: 'umers-macbook-air.tail@de54.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
  await assert.rejects(reach({ port: 8792, tailscale }), /invalid MagicDNS name/);
  writeFileSync(bin, '#!/bin/sh\necho "logged out" >&2; exit 1\n');
  await assert.rejects(reach({ port: 8792, tailscale }), /installed but unavailable: logged out/);
  writeFileSync(bin, '#!/bin/sh\necho nope\n');
  await assert.rejects(reach({ port: 8792, tailscale }), /invalid status JSON/);
});

test('a DNS rename removes the recorded old root before serving the new one', async () => {
  const old = { ...owned, dnsName: 'old.tailnet.ts.net' };
  const oldRoot = JSON.stringify({ Web: { 'old.tailnet.ts.net:443': { Handlers: { '/': { Proxy: owned.proxy } } } } });
  fake(self, { serveStatus: oldRoot });
  const at = mark();
  assert.deepEqual(await reach({ port: 8792, previous: old, tailscale }), { urls: ['wss://dev.tailnet.ts.net'], bind: '127.0.0.1', ingress: owned });
  assert.deepEqual(since(at).trim().split('\n'), [
    'status --json', 'serve status --json', 'serve --https=443 --set-path=/ off', 'serve status --json',
    'serve status --json', 'serve --yes --bg --https=443 http://127.0.0.1:8792', 'serve status --json',
  ]);
});

test('direct Tailscale is the fallback and the rollback: it removes only the mapping it owns', async () => {
  fake(self, { serveStatus: ours });
  const at = mark();
  assert.deepEqual(await reach({ port: 8792, via: 'tailscale-direct', previous: owned, tailscale }), { urls: ['ws://100.64.0.1:8792'], bind: '0.0.0.0' });
  assert.match(since(at), /^serve --https=443 --set-path=\/ off$/m);
  fake(self);
  const gone = mark();
  assert.equal(await unserve(owned, tailscale), false);
  assert.doesNotMatch(since(gone), /off/, 'cleanup ran again after Serve was already gone');
  fake({ Self: { DNSName: 'dev.tailnet.ts.net.' } });
  await assert.rejects(reach({ port: 8792, via: 'tailscale-direct', tailscale }), /no Tailscale address/);
});

test('disabled Serve does not block direct rollback and retains the cleanup fingerprint', async () => {
  fake(self, { serveStatus: 'Serve is not enabled on your tailnet', serveStatusExit: 1 });
  const at = mark();
  assert.deepEqual(await reach({ port: 8792, via: 'tailscale-direct', previous: owned, tailscale }), {
    urls: ['ws://100.64.0.1:8792'], bind: '0.0.0.0', pendingCleanup: owned,
  });
  assert.doesNotMatch(since(at), /^serve --https=443 --set-path=\/ off$/m);
});

test('failed cleanup retains its fingerprint on LAN, private and port transitions', async () => {
  fake(self, { serveStatus: 'Serve is not enabled on your tailnet', serveStatusExit: 1 });
  const interfaces = { eno1: [{ family: 'IPv4', internal: false, address: '192.168.1.8' }], wt0: [{ family: 'IPv4', internal: false, address: '100.90.0.4' }] } as never;
  assert.deepEqual(await reach({ port: 8792, via: 'lan', previous: owned, tailscale, interfaces }), {
    urls: ['ws://192.168.1.8:8792'], bind: '0.0.0.0', pendingCleanup: owned,
  });
  assert.deepEqual(await reach({ port: 8792, via: 'private', previous: owned, tailscale, interfaces }), {
    urls: ['ws://100.90.0.4:8792'], bind: '0.0.0.0', pendingCleanup: owned,
  });
  assert.deepEqual(await reach({ port: 8793, via: 'lan', previous: owned, tailscale, interfaces }), {
    urls: ['ws://192.168.1.8:8793'], bind: '0.0.0.0', pendingCleanup: owned,
  });
  assert.deepEqual(await reach({ port: 8792, via: 'lan', previous: owned, tailscale: { bin: join(dir, 'not-installed') }, interfaces }), {
    urls: ['ws://192.168.1.8:8792'], bind: '0.0.0.0', pendingCleanup: owned,
  });
});

test('DNS rename keeps old cleanup fingerprint when removal fails', async () => {
  const old = { ...owned, dnsName: 'old.tailnet.ts.net' };
  fake(self, { serveStatus: JSON.stringify({ AllowFunnel: { 'old.tailnet.ts.net:443': true }, Web: {
    'old.tailnet.ts.net:443': { Handlers: { '/': { Proxy: owned.proxy } } },
  } }) });
  assert.deepEqual(await reach({ port: 8792, previous: old, tailscale }), {
    urls: ['wss://dev.tailnet.ts.net'], bind: '127.0.0.1', ingress: owned, pendingCleanup: old,
  });
});

test('without Tailscale, auto falls back to LAN; tailscale mode says it is missing', async () => {
  const missing = { bin: join(dir, 'not-installed') };
  const interfaces = { eno1: [{ family: 'IPv4', internal: false, address: '192.168.1.8' }] } as never;
  assert.deepEqual(await reach({ port: 8792, tailscale: missing, interfaces }), { urls: ['ws://192.168.1.8:8792'], bind: '0.0.0.0' });
  await assert.rejects(reach({ port: 8792, via: 'tailscale', tailscale: missing }), /not installed/);
  await assert.rejects(reach({ port: 8792, via: 'lan', tailscale: missing, interfaces: {} }), /no LAN address/);
  await assert.rejects(reach({ port: 0, tailscale: missing }), /port/);
});

test('routes keep physical LAN addresses and overlays apart, and skip Tailscale, Docker and VM bridges', () => {
  const v4 = (address: string) => [{ family: 'IPv4', internal: false, address }];
  const found = routes({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], docker0: v4('100.90.0.2'), vboxnet0: v4('192.168.56.1'),
    'br-test': v4('100.90.0.3'), veth0: v4('100.90.0.5'), virbr0: v4('100.90.0.6'), podman0: v4('100.90.0.7'),
    lxc0: v4('100.90.0.8'), vmnet0: v4('100.90.0.9'), hyperv0: v4('100.90.0.10'), wsl0: v4('100.90.0.11'),
    eno1: v4('192.168.1.8'), wlan0: v4('10.0.0.5'), wt0: v4('100.90.0.4'), tailscale0: v4('100.64.0.1'), eth1: v4('8.8.8.8'),
  } as never);
  assert.deepEqual(found, { lan: ['192.168.1.8', '10.0.0.5'], private: [{ address: '100.90.0.4', interface: 'wt0' }] });
  assert.deepEqual(routes({ utun4: v4('100.64.0.1'), utun5: v4('10.20.0.2') } as never, ['100.64.0.1']).private,
    [{ address: '10.20.0.2', interface: 'utun5' }]);
});

test('private selection excludes Self.TailscaleIPs even on utun interfaces', async () => {
  fake(self);
  const interfaces = { utun4: [{ family: 'IPv4', internal: false, address: '100.64.0.1' }], utun5: [{ family: 'IPv4', internal: false, address: '100.90.0.4' }] } as never;
  assert.deepEqual(await reach({ port: 8792, via: 'private', tailscale, interfaces }), { urls: ['ws://100.90.0.4:8792'], bind: '0.0.0.0' });
});

test('private routes remain available when Tailscale cannot answer', async () => {
  const interfaces = { wt0: [{ family: 'IPv4', internal: false, address: '100.90.0.4' }] } as never;
  const expected = { urls: ['ws://100.90.0.4:8792'], bind: '0.0.0.0' };
  for (const script of ['echo "logged out" >&2; exit 1', 'echo not-json', 'exec /bin/sleep 30']) {
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    assert.deepEqual(await reach({ port: 8792, via: 'private', tailscale: { bin, timeoutMs: 50 }, interfaces }), expected);
  }
  assert.deepEqual(await reach({ port: 8792, via: 'private', tailscale: { bin: join(dir, 'not-installed') }, interfaces }), expected);
});

test('unserve removes only the owned root, preserving sibling paths', async () => {
  fake(self, { serveStatus: JSON.stringify({ Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: owned.proxy }, '/other': { Text: 'keep' } } } } }) });
  const at = mark();
  assert.equal(await unserve(owned, tailscale), true);
  assert.match(since(at), /^serve --https=443 --set-path=\/ off$/m);
  assert.doesNotMatch(since(at), /^serve --https=443 off$/m);
});

test('advertise publishes one mDNS service and stops it', async () => {
  const calls: unknown[] = [];
  const bonjour: Bonjour = {
    publish: (config) => { calls.push(config); return { stop: (cb) => { calls.push('stop'); cb?.(); } }; },
    destroy: (cb) => { calls.push('destroy'); cb?.(); },
  };
  const ad = await advertise({ type: 'muxr', port: 8792, name: 'Desk', txt: { url: 'ws://192.168.1.8:8792' }, bonjour });
  await ad.stop();
  const config = calls[0] as { name: string; type: string; port: number; host: string; txt: object };
  assert.deepEqual([config.name, config.type, config.port, config.txt], ['Desk', 'muxr', 8792, { url: 'ws://192.168.1.8:8792' }]);
  assert.match(config.host, /^muxr-[a-z0-9-]+-8792$/);
  assert.deepEqual(calls.slice(1), ['stop', 'destroy']);
});
