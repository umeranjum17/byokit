// recommend() orders the onboarding routes and attaches everyday words: every case passes fakes for the
// Tailscale state, the Serve root and the interface lists, except the last test, which runs the live probes
// against a fake tailscale CLI. The real binary never runs, and no packet goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { routeChoices } from '../../ui/src/route.ts';
import { recommend, type RecommendEntry, type TailscaleState } from '../src/index.ts';

const up = { installed: true, backendState: 'Running', needsSignin: false, dnsName: 'dev.tailnet.ts.net', ips: ['100.64.0.1'] } satisfies TailscaleState;
const out = { installed: true, backendState: 'NeedsLogin', needsSignin: true, ips: [] } satisfies TailscaleState;
const missing = { installed: false, needsSignin: false, reason: 'Tailscale is not installed', ips: [] } satisfies TailscaleState;
const nic = (address: string): NetworkInterfaceInfo =>
  ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal: false, cidr: `${address}/24` });
const lanOnly = { en0: [nic('192.168.1.20')] };
const overlay = { en0: [nic('192.168.1.20')], wt0: [nic('100.90.1.2')] };
const words = new Map(routeChoices().map((c) => [c.code, c] as const));
const orderOf = (entries: RecommendEntry[]) => entries.map((e) => e.via);
const picked = (entries: RecommendEntry[]) => entries.find((e) => e.recommended)?.via;

test('a connected Tailscale with a free root recommends Serve, with words from the one table', async () => {
  const entries = await recommend({ state: up, serve: { status: 'free' }, interfaces: lanOnly });
  assert.equal(picked(entries), 'tailscale');
  assert.deepEqual(orderOf(entries), ['tailscale', 'tailscale-direct', 'private', 'lan']);
  const serve = entries[0]!;
  assert.equal(serve.sentence, words.get('tailscale')!.sentence);
  assert.equal(serve.needs, words.get('tailscale')!.needs);
  assert.equal(serve.disabledReason, undefined);
  assert.equal(entries.find((e) => e.via === 'lan')?.disabledReason, undefined);
});

test('a taken, disabled, funnelled or nameless Serve root recommends direct and says why', async () => {
  for (const serve of [
    { status: 'occupied' as const },
    { status: 'disabled' as const, reason: 'Tailscale Serve is not enabled on your tailnet.' },
    { status: 'funnel' as const, reason: 'Funnel is on for this Serve root.' },
  ]) {
    const entries = await recommend({ state: up, serve, interfaces: lanOnly });
    assert.equal(picked(entries), 'tailscale-direct', serve.status);
    assert.ok(entries.find((e) => e.via === 'tailscale')?.disabledReason, serve.status);
  }
  const entries = await recommend({ state: { ...up, dnsName: undefined }, serve: { status: 'free' }, interfaces: lanOnly });
  assert.equal(picked(entries), 'tailscale-direct');
  assert.match(entries.find((e) => e.via === 'tailscale')?.disabledReason ?? '', /MagicDNS/);
});

test('signed-out Tailscale stays selectable with sign-in in needs while Same Wi-Fi is recommended', async () => {
  const entries = await recommend({ state: out, serve: { status: 'inconclusive' }, interfaces: lanOnly });
  assert.equal(picked(entries), 'lan');
  for (const via of ['tailscale', 'tailscale-direct'] as const) {
    const e = entries.find((x) => x.via === via)!;
    assert.equal(e.disabledReason, undefined, via);
    assert.match(e.needs, /Sign in to Tailscale next/);
  }
});

test('missing Tailscale disables both Tailscale routes and recommends Same Wi-Fi', async () => {
  const entries = await recommend({ state: missing, serve: { status: 'inconclusive' }, interfaces: lanOnly });
  assert.equal(picked(entries), 'lan');
  assert.ok(entries.find((e) => e.via === 'tailscale')?.disabledReason);
  assert.ok(entries.find((e) => e.via === 'tailscale-direct')?.disabledReason);
});

test('a private overlay outranks LAN, and the current healthy route stays first', async () => {
  const entries = await recommend({ state: missing, serve: { status: 'inconclusive' }, interfaces: overlay });
  assert.equal(picked(entries), 'private');
  const kept = await recommend({ state: up, serve: { status: 'free' }, interfaces: overlay, current: { via: 'lan', healthy: true } });
  assert.equal(picked(kept), 'lan');
  assert.deepEqual(orderOf(kept), ['lan', 'tailscale', 'tailscale-direct', 'private']);
  const dropped = await recommend({ state: up, serve: { status: 'free' }, interfaces: lanOnly, current: { via: 'lan', healthy: false } });
  assert.equal(picked(dropped), 'tailscale');
});

test('nothing ready recommends nothing, with a reason on every route', async () => {
  const entries = await recommend({ state: missing, serve: { status: 'inconclusive' }, interfaces: {} });
  assert.equal(picked(entries), undefined);
  assert.deepEqual(orderOf(entries), ['tailscale', 'tailscale-direct', 'private', 'lan']);
  for (const e of entries) assert.ok(e.disabledReason, e.via);
});

test('the live probes order Serve first: fake CLI status, Serve root and interface list', async () => {
  const dir = scratchDir('reach-recommend');
  const bin = join(dir, 'tailscale');
  const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
  writeFileSync(bin, `#!/bin/sh\ncase \"$*\" in\n  \"status --json\") printf '%s' ${sq(status)} ;;\n  \"serve status --json\") printf '{}' ;;\n  *) exit 1 ;;\nesac\n`);
  chmodSync(bin, 0o755);
  const entries = await recommend({ tailscale: { bin, timeoutMs: 3_000 }, interfaces: lanOnly });
  assert.equal(picked(entries), 'tailscale');
  assert.deepEqual(orderOf(entries), ['tailscale', 'tailscale-direct', 'private', 'lan']);
});
