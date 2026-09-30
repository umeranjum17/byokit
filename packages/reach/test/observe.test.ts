import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { phoneNetwork, nativeAddresses, observe, probe, routeOf, type NativeAddress, type ProbeOptions } from '../src/index.ts';
import { nativeAddresses as portableAddresses } from '../src/observe.ts';

const answers = (async () => new Response('', { status: 503 })) as typeof fetch;
const snapshot = (...entries: NativeAddress[]) => ({ addresses: async () => entries });

test('nativeAddresses validates prefixes and tolerates missing or failed native modules', async () => {
  assert.deepEqual(await portableAddresses(), []);
  assert.deepEqual(await nativeAddresses({ nativeModule: null }), []);
  assert.deepEqual(await nativeAddresses({ nativeModule: { addresses: async () => { throw new Error('unavailable'); } } }), []);
  const malformed = [
    { address: '192.168.1.2', prefixLength: 23, interface: 'wlan0' },
    { address: '192.168.1.2', prefixLength: 23, interface: 'wlan0' },
    { address: '192.168.1.3', prefixLength: 33 }, { address: '10.0.0.2', prefixLength: 0 },
    { address: '999.1.1.1' }, { address: 'fe80::1' }, null, '10.0.0.1',
  ];
  assert.deepEqual(await nativeAddresses({ nativeModule: { addresses: async () => malformed as NativeAddress[] } }), [
    { address: '192.168.1.2', prefixLength: 23, interface: 'wlan0' }, { address: '192.168.1.3' }, { address: '10.0.0.2', prefixLength: 0 },
  ]);
  const real = await nativeAddresses();
  assert.ok(real.every((a) => typeof a.address === 'string' && typeof a.interface === 'string'));
});

test('routeOf parses URLs instead of matching arbitrary strings', () => {
  const cases = {
    'ws://192.168.1.2:8792/link': 'home', 'http://10.1.1.2': 'home', 'ws://172.31.1.2': 'home',
    'ws://umer.local': 'home', 'ws://100.64.0.1': 'tailscale', 'ws://100.127.255.255': 'tailscale',
    'wss://umer.tailnet.ts.net': 'tailscale', 'wss://relay.example/link/v1/umer': 'relay',
    'ws://127.0.0.2': 'loopback', 'ws://[::1]': 'loopback', 'http://localhost': 'loopback',
    'ws://100.63.255.255': 'unknown', 'ws://100.128.0.0': 'unknown', 'ws://172.32.1.1': 'unknown',
    'https://example.com/100.64.0.1': 'unknown', 'not a URL': 'unknown', 'file:///link/v1/umer': 'unknown',
  };
  for (const [url, expected] of Object.entries(cases)) assert.equal(routeOf(url), expected, url);
});

test('probe converts ws/wss, treats any response as answers, and distinguishes explicit refusal from unknown errors', async () => {
  let seen: string | undefined;
  let options: RequestInit | undefined;
  const get = (async (url, o) => { seen = String(url); options = o; return new Response('', { status: 401 }); }) as typeof fetch;
  const result = await probe('wss://umer.example:8792/link', { fetch: get });
  assert.equal(seen, 'https://umer.example:8792/link');
  assert.equal(options?.redirect, 'manual');
  assert.equal(result.state, 'answers');
  assert.equal(result.url, 'wss://umer.example:8792/link');
  assert.ok(result.elapsedMs >= 0);
  const fail = (error: unknown): typeof fetch => (async () => { throw error; }) as typeof fetch;
  assert.equal((await probe('ws://127.0.0.1', { fetch: fail({ cause: { code: 'ECONNREFUSED' } }) })).state, 'refused');
  assert.equal((await probe('ws://127.0.0.1', { fetch: fail({ code: 'ETIMEDOUT' }) })).state, 'timeout');
  assert.equal((await probe('ws://127.0.0.1', { fetch: fail(new TypeError('Network request failed')) })).state, 'unknown');
  for (const url of ['bad', 'ftp://umer.example', 'http://umer:secret@example.com']) {
    assert.equal((await probe(url, { fetch: get })).state, 'unknown');
  }
});

test('probe remains bounded when a native fetch ignores abort, and clears timers after success', async () => {
  let signal: AbortSignal | undefined;
  const never = (async (_url, o) => { signal = o?.signal as AbortSignal; return new Promise<Response>(() => {}); }) as typeof fetch;
  const result = await probe('ws://127.0.0.1:8792', { timeout: 20, fetch: never });
  assert.equal(result.state, 'timeout');
  assert.ok(result.elapsedMs < 1000);
  assert.equal(signal?.aborted, true);
  for (const timeout of [0, -1, Infinity, NaN, 2147483648]) await assert.rejects(probe('http://umer.example', { timeout }), /timeout/);
  assert.equal((await probe('ws://127.0.0.1', { timeout: 60_000, fetch: answers })).state, 'answers');
});

test('observe uses actual /23 and /25 evidence, prefers home, and preserves authenticated prior evidence', async () => {
  const urls = ['ws://100.64.0.3:8792/link', 'ws://192.168.0.20:8792/link'];
  const priorEvidence = { anywhere: 'anywhere', peer: false, reached: { tailscale: 42 } };
  const facts = await observe({ urls, priorEvidence,
    nativeModule: snapshot({ address: '192.168.1.2', prefixLength: 23 }, { address: '100.64.0.2', prefixLength: 32 }),
    probe: { fetch: answers },
  });
  assert.equal(facts.home, true);
  assert.equal(facts.vpn, true);
  assert.equal(facts.tailnet, true);
  assert.equal(facts.target, urls[1]);
  assert.equal(facts.knock?.state, 'answers');
  assert.equal(facts.peer, false);
  assert.deepEqual(facts.reached, priorEvidence.reached);
  const away = await observe({ urls: ['ws://192.168.1.200', urls[0]!],
    addresses: [{ address: '192.168.1.2', prefixLength: 25 }, { address: '100.64.0.2' }], probe: { fetch: answers } });
  assert.equal(away.home, false, 'same first three octets is insufficient with /25');
  assert.equal(away.target, urls[0]);
});

test('observe leaves missing prefix/module evidence unknown and never probes an unobserved home or relay', async () => {
  let calls = 0;
  const noFetch = (async () => { calls++; throw new Error('should not probe'); }) as typeof fetch;
  const urls = ['ws://192.168.1.20:8792', 'wss://relay.example/link/v1/umer'];
  const common = { urls, probe: { fetch: noFetch } };
  for (const addresses of [[], [{ address: '192.168.1.2' }], [{ address: '192.168.1.2', prefixLength: 0 }]]) {
    const facts = await observe({ ...common, addresses });
    assert.equal(facts.home, undefined);
    assert.equal(facts.target, undefined);
    assert.equal(facts.knock, undefined);
    assert.equal(facts.tailnet, false);
  }
  const facts = await observe({ ...common, nativeModule: null, priorEvidence: { peer: true } });
  assert.equal(facts.home, undefined);
  assert.equal(facts.vpn, undefined);
  assert.equal(facts.peer, true);
  assert.equal(calls, 0);
});

test('React Native public entry executes injected evidence under Node and has no Node runtime imports', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.exports['./react-native'], { types: './dist/rn.d.ts', default: './dist/rn.js' });
  const output = await build({
    entryPoints: [new URL('../src/rn.ts', import.meta.url).pathname], bundle: true, write: false,
    format: 'esm', platform: 'browser', metafile: true, logLevel: 'silent',
    plugins: [{ name: 'fake-native-browser', setup(build) {
      build.onResolve({ filter: /^react-native-zeroconf$/ }, () => ({ path: 'zeroconf', namespace: 'fake' }));
      build.onResolve({ filter: /^expo-modules-core$/ }, () => ({ path: 'expo', namespace: 'fake' }));
      build.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({ contents: args.path === 'zeroconf' ? 'export default class Zeroconf {}' : `
        export function requireOptionalNativeModule(name) {
          if (name !== 'ByokitReach') throw Error('wrong native module');
          return { addresses: async () => [{address: '192.168.1.2', prefixLength: 24}],
            phoneNetwork: async () => ({onWifi: true, cellular: false, vpnActive: 'yes'}) };
        }` }));
    } }],
  });
  assert.ok(Object.keys(output.metafile!.inputs).every((path) => !path.includes('node:') && !path.endsWith('/index.ts') && !path.endsWith('/tailscale.ts')));
  const rn: typeof import('../src/observe.ts') & typeof import('../src/phone-network.ts') = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0]!.text).toString('base64')}`);
  const nativeModule = snapshot({ address: '192.168.1.2', prefixLength: 24 });
  assert.deepEqual(await rn.nativeAddresses({ nativeModule }), await nativeAddresses({ nativeModule }));
  assert.deepEqual(await rn.nativeAddresses(), [{ address: '192.168.1.2', prefixLength: 24 }]);
  assert.deepEqual(await rn.phoneNetwork(), { onWifi: true, cellular: false, vpnActive: 'yes' });
  assert.deepEqual(await rn.phoneNetwork({ nativeModule: null }), { onWifi: false, cellular: false, vpnActive: 'unknown' });
  assert.equal(rn.routeOf('ws://100.64.0.1'), routeOf('ws://100.64.0.1'));
  const probeOptions: ProbeOptions = { fetch: answers };
  assert.equal((await rn.probe('ws://192.168.1.20', probeOptions)).state, 'answers');
  assert.equal((await rn.observe({ urls: ['ws://192.168.1.20'], nativeModule, probe: probeOptions })).home, true);
});


test('probe exercises a real loopback HTTP response and a closed port through Node fetch', async () => {
  const server = createServer((_req, response) => { response.writeHead(503); response.end('not ready'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/link`;
  try { assert.equal((await probe(url, { timeout: 1000 })).state, 'answers'); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  assert.equal((await probe(url, { timeout: 1000 })).state, 'refused');
});


test('phoneNetwork preserves Android Wi-Fi/cellular/VPN evidence and iOS unknown VPN, including failures', async () => {
  for (const evidence of [
    { onWifi: true, cellular: false, vpnActive: 'yes' as const },
    { onWifi: false, cellular: true, vpnActive: 'no' as const },
    { onWifi: true, cellular: false, vpnActive: 'unknown' as const },
    { onWifi: false, cellular: false, vpnActive: 'no' as const },
    { onWifi: true, cellular: true, vpnActive: 'yes' as const },
  ]) assert.deepEqual(await phoneNetwork({ nativeModule: { phoneNetwork: async () => evidence } }), evidence);
  const unknown = { onWifi: false, cellular: false, vpnActive: 'unknown' };
  assert.deepEqual(await phoneNetwork(), unknown);
  assert.deepEqual(await phoneNetwork({ nativeModule: { phoneNetwork: async () => { throw new Error('native failed'); } } }), unknown);
  assert.deepEqual(await phoneNetwork({ nativeModule: { phoneNetwork: async () => ({ onWifi: 'no', cellular: false }) as never } }), unknown);
  assert.deepEqual(await phoneNetwork({ nativeModule: { phoneNetwork: async () => ({ onWifi: true, cellular: false, vpnActive: 'unsupported' }) as never } }), { ...unknown, onWifi: true });
});


test('the phone observation flow works when React Native URL has no WebSocket hostname or protocol setter', async () => {
  const original = globalThis.URL;
  class NativeURL {
    get hostname() { return ''; }
    get protocol() { return 'ws:'; }
    constructor(_url: string) { throw new Error('the observation flow must not depend on native URL parsing'); }
  }
  (globalThis as unknown as { URL: unknown }).URL = NativeURL;
  try {
    assert.equal(routeOf('ws://192.168.1.20/link'), 'home');
    assert.equal(routeOf('wss://relay.example/link/v1/umer'), 'relay');
    assert.equal(routeOf('ws://[::1]/link'), 'loopback');
    let target = '';
    const get = (async (url) => { target = String(url); return new Response(''); }) as typeof fetch;
    const facts = await observe({ urls: ['ws://192.168.1.20/link'], addresses: [{ address: '192.168.1.2', prefixLength: 24 }], probe: { fetch: get } });
    assert.equal(facts.home, true);
    assert.equal(facts.knock?.state, 'answers');
    assert.equal(target, 'http://192.168.1.20/link');
    assert.equal((await probe('wss://umer.example/link', { fetch: get })).state, 'answers');
    assert.equal(target, 'https://umer.example/link');
  } finally { globalThis.URL = original; }
});
