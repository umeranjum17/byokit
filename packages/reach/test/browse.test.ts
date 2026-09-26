// The React Native browse API against a fake zeroconf module. The real react-native-zeroconf is never installed
// here: tests inject a fake, and esbuild proves the Node entry never pulls the native module while the
// react-native condition resolves the browse entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { browse, scan, type BrowseService, type ZeroconfLike } from '../src/browse.ts';

class FakeZeroconf implements ZeroconfLike {
  calls: string[] = [];
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  scan(type?: string, protocol?: string, domain?: string): void { this.calls.push(`scan ${type} ${protocol} ${domain}`); }
  stop(): void { this.calls.push('stop'); }
  removeDeviceListeners(): void { this.calls.push('removeDeviceListeners'); }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): void { this.listeners.get(event)?.delete(listener); }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
  count(event: string): number { return this.listeners.get(event)?.size ?? 0; }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const service = (over: Record<string, unknown> = {}): unknown => ({
  name: 'devbox', host: 'devbox.local.', addresses: ['192.168.1.23', 'fe80::1'], port: 8792,
  txt: { machine: 'm1', relay: 'wss://relay' }, ...over,
});

test('browse scans tcp local. by default; stop is idempotent and removes the zeroconf listeners', () => {
  const zc = new FakeZeroconf();
  const handle = browse({ type: 'muxr', zeroconf: zc });
  assert.deepEqual(zc.calls, ['scan muxr tcp local.']);
  assert.equal(zc.count('resolved'), 1);
  handle.stop();
  handle.stop();
  assert.deepEqual(zc.calls, ['scan muxr tcp local.', 'stop', 'removeDeviceListeners']);
  assert.equal(zc.count('resolved'), 0);
  assert.equal(zc.count('remove'), 0);
  assert.equal(zc.count('error'), 0);
});

test('a resolve becomes found with normalized fields, a known name becomes updated', () => {
  const zc = new FakeZeroconf();
  const handle = browse({ type: 'muxr', zeroconf: zc });
  const seen: [string, unknown][] = [];
  handle.on('found', (s) => seen.push(['found', s]));
  handle.on('updated', (s) => seen.push(['updated', s]));
  handle.on('lost', (name) => seen.push(['lost', name]));
  handle.on('error', (e) => seen.push(['error', e.message]));
  zc.emit('resolved', service({ txt: { machine: 'm1', relay: 'wss://relay', junk: 5, flag: 'yes' } }));
  assert.deepEqual(seen, [['found', {
    name: 'devbox', host: 'devbox.local.', addresses: ['192.168.1.23', 'fe80::1'], port: 8792,
    txt: { machine: 'm1', relay: 'wss://relay', flag: 'yes' },
  }]]);
  zc.emit('resolved', service({ port: 8793, txt: { machine: 'm1', relay: 'wss://relay', flag: 'yes' } }));
  assert.deepEqual(seen[1], ['updated', { ...seen[0][1] as object, port: 8793 }]);
  // Fields the platform did not deliver normalize to empties; no name, no service.
  zc.emit('resolved', { port: 1 });
  zc.emit('resolved', { name: 'sparse', addresses: [7, '10.0.0.9'], txt: 'nope' });
  assert.deepEqual(seen[2], ['found', { name: 'sparse', host: '', addresses: ['10.0.0.9'], port: 0, txt: {} }]);
  assert.equal(seen.length, 3);
  handle.stop();
});

test('remove becomes lost by name and a later re-resolve is found again', () => {
  const zc = new FakeZeroconf();
  const handle = browse({ type: 'muxr', zeroconf: zc });
  const lost: string[] = [];
  const events: string[] = [];
  handle.on('found', () => events.push('found'));
  handle.on('updated', () => events.push('updated'));
  handle.on('lost', (name) => { events.push('lost'); lost.push(name); });
  zc.emit('resolved', service());
  zc.emit('remove', 'devbox');
  zc.emit('resolved', service());
  assert.deepEqual(lost, ['devbox']);
  assert.deepEqual(events, ['found', 'lost', 'found']);
  handle.stop();
});

test('errors surface on the error event as Error instances', () => {
  const zc = new FakeZeroconf();
  const handle = browse({ type: 'muxr', zeroconf: zc });
  const errors: Error[] = [];
  handle.on('error', (e) => errors.push(e));
  zc.emit('error', new Error('multicast failed'));
  zc.emit('error', 'boom');
  zc.emit('error', { message: 'native said no' });
  assert.deepEqual(errors.map((e) => [e instanceof Error, e.message]), [
    [true, 'multicast failed'], [true, 'boom'], [true, 'native said no'],
  ]);
  handle.stop();
});

test('a scan that fails to start reports through the error event', async () => {
  class ThrowsOnScan extends FakeZeroconf {
    scan(): void { throw new Error('scan refused'); }
  }
  const zc = new ThrowsOnScan();
  const handle = browse({ type: 'muxr', zeroconf: zc });
  const error = await new Promise<Error>((resolve) => handle.on('error', resolve));
  assert.equal(error.message, 'scan refused');
  handle.stop();
});

test('after stop, events never reach listeners and on() is ignored', () => {
  const zc = new FakeZeroconf();
  const handle = browse({ type: 'muxr', zeroconf: zc });
  const seen: unknown[] = [];
  handle.stop();
  handle.on('found', (s) => seen.push(s));
  zc.emit('resolved', service());
  zc.emit('remove', 'devbox');
  zc.emit('error', new Error('late'));
  assert.deepEqual(seen, []);
});

test('scan collects services for its window, updates in first-seen order, then stops itself', async () => {
  const zc = new FakeZeroconf();
  const pending = scan({ type: 'ssh', ms: 60, zeroconf: zc });
  await wait(10);
  zc.emit('resolved', service({ name: 'hostA', port: 22 }));
  zc.emit('resolved', service({ name: 'hostB', port: 2222, addresses: ['10.0.0.8'] }));
  zc.emit('resolved', service({ name: 'hostA', port: 23 }));
  const services = await pending;
  assert.deepEqual(services.map((s) => [s.name, s.port]), [['hostA', 23], ['hostB', 2222]]);
  assert.deepEqual(zc.calls.slice(-2), ['stop', 'removeDeviceListeners']);
});

test('scan rejects and stops when the scan errors', async () => {
  const zc = new FakeZeroconf();
  const pending = scan({ type: 'ssh', ms: 30_000, zeroconf: zc });
  await wait(5);
  zc.emit('error', new Error('nope'));
  await assert.rejects(pending, /nope/);
  assert.deepEqual(zc.calls.slice(-2), ['stop', 'removeDeviceListeners']);
});

test('scan rejects a non-positive window without starting one', async () => {
  const zc = new FakeZeroconf();
  await assert.rejects(scan({ type: 'ssh', ms: 0, zeroconf: zc }), /ms must be positive/);
  assert.deepEqual(zc.calls, []);
});

test('the Node entry never pulls react-native-zeroconf; the react-native condition resolves the browse entry', async () => {
  const node = await build({
    stdin: { contents: `import { advertise, reach } from '../src/index.ts'; reach; advertise;`, resolveDir: import.meta.dirname },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  });
  assert.ok(!node.outputFiles[0].text.includes('react-native-zeroconf'));
  assert.ok(!node.outputFiles[0].text.includes('removeDeviceListeners'));

  const rn = await build({
    stdin: { contents: `import { browse, scan } from '../src/rn.ts'; browse; scan;`, resolveDir: import.meta.dirname },
    bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent',
    external: ['react-native-zeroconf'],
  });
  assert.ok(rn.outputFiles[0].text.includes('from "react-native-zeroconf"'));

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.exports['.']['react-native'], { types: './dist/rn.d.ts', default: './dist/rn.js' });
  assert.deepEqual(pkg.exports['.'].default, './dist/index.js');
  assert.deepEqual(pkg.peerDependencies, { 'react-native-zeroconf': '^0.14.0' });
  assert.deepEqual(pkg.peerDependenciesMeta, { 'react-native-zeroconf': { optional: true } });
});
