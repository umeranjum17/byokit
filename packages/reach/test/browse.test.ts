// The React Native browse API against a fake native browser.
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
  on(event: string, listener: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
  count(event: string): number { return this.listeners.get(event)?.size ?? 0; }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const service = (over: Record<string, unknown> = {}): unknown => ({
  name: 'devbox', fullName: 'devbox.local._muxr._tcp.', host: 'devbox.local.', addresses: ['192.168.1.23', 'fe80::1'], port: 8792,
  txt: { machine: 'm1', relay: 'wss://relay' }, ...over,
});

test('browse scans tcp local. by default; stop is idempotent', () => {
  const zc = new FakeZeroconf();
  const handle = browse({ type: 'muxr', zeroconf: zc });
  assert.deepEqual(zc.calls, ['scan muxr tcp local.']);
  assert.equal(zc.count('resolved'), 1);
  handle.stop();
  handle.stop();
  assert.deepEqual(zc.calls, ['scan muxr tcp local.', 'stop']);
  assert.equal(zc.count('resolved'), 1);
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
  zc.emit('resolved', { name: 'sparse', fullName: 'sparse.local._muxr._tcp.', addresses: [7, '10.0.0.9'], txt: 'nope' });
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
  zc.emit('resolved', service({ name: 'hostA', fullName: 'hostA.local._ssh._tcp.', port: 22 }));
  zc.emit('resolved', service({ name: 'hostB', fullName: 'hostB.local._ssh._tcp.', port: 2222, addresses: ['10.0.0.8'] }));
  zc.emit('resolved', service({ name: 'hostA', fullName: 'hostA.local._ssh._tcp.', port: 23 }));
  zc.emit('remove', 'hostB');
  const services = await pending;
  assert.deepEqual(services.map((s) => [s.name, s.port]), [['hostA', 23]]);
  assert.equal(zc.calls.at(-1), 'stop');
});

test('scan rejects and stops when the scan errors', async () => {
  const zc = new FakeZeroconf();
  const pending = scan({ type: 'ssh', ms: 30_000, zeroconf: zc });
  await wait(5);
  zc.emit('error', new Error('nope'));
  await assert.rejects(pending, /nope/);
  assert.equal(zc.calls.at(-1), 'stop');
});

test('a new browse preempts even the same type once, drops old events and never resumes', () => {
  const zc = new FakeZeroconf();
  const first = browse({ type: 'muxr', zeroconf: zc });
  const events: string[] = [];
  first.on('found', (s) => events.push(`first:${s.name}`));
  first.on('stopped', ({ reason }) => events.push(reason));
  zc.emit('resolved', service({ name: 'machine', fullName: 'machine.local._muxr._tcp.' }));
  const second = browse({ type: 'muxr', zeroconf: zc });
  second.on('found', (s) => events.push(`second:${s.name}`));
  assert.deepEqual(events, ['first:machine', 'preempted']);
  first.stop();
  first.on('found', () => events.push('late'));
  zc.emit('resolved', service({ name: 'machine', fullName: 'machine.local._muxr._tcp.' }));
  assert.deepEqual(events, ['first:machine', 'preempted', 'second:machine']);
  second.stop();
  second.stop();
  zc.emit('resolved', service({ name: 'late' }));
  assert.deepEqual(events, ['first:machine', 'preempted', 'second:machine']);
  assert.deepEqual(zc.calls, ['scan muxr tcp local.', 'stop', 'scan muxr tcp local.', 'stop']);
  assert.equal(zc.count('resolved'), 1);
  assert.equal(zc.count('remove'), 1);
  assert.equal(zc.count('error'), 1);
});

test('a timed SSH scan preempts muxr and filters late resolves without auto-resume', async () => {
  const zc = new FakeZeroconf();
  const muxr = browse({ type: 'muxr', zeroconf: zc });
  const seen: string[] = [];
  muxr.on('stopped', ({ reason }) => seen.push(reason));
  muxr.on('found', (s) => seen.push(s.name));
  const ssh = scan({ type: 'ssh', ms: 40, zeroconf: zc });
  assert.deepEqual(seen, ['preempted']);
  zc.emit('resolved', service({ name: 'old', fullName: 'old.local._muxr._tcp.' }));
  zc.emit('resolved', service({ name: 'untyped', fullName: undefined }));
  zc.emit('remove', 'old');
  zc.emit('resolved', service({ name: 'hostA', fullName: 'hostA.local._ssh._tcp.', port: 22 }));
  zc.emit('remove', 'old');
  assert.deepEqual((await ssh).map((s) => s.name), ['hostA']);
  assert.deepEqual(seen, ['preempted']);
  assert.deepEqual(zc.calls, ['scan muxr tcp local.', 'stop', 'scan ssh tcp local.', 'stop']);
});

test('preempting a timed scan rejects it and leaves only the new browse active', async () => {
  const zc = new FakeZeroconf();
  const pending = scan({ type: 'ssh', ms: 30_000, zeroconf: zc });
  const muxr = browse({ type: 'muxr', zeroconf: zc });
  await assert.rejects(pending, /scan preempted/);
  const seen: string[] = [];
  muxr.on('found', (s) => seen.push(s.name));
  zc.emit('resolved', service({ name: 'old', fullName: 'old.local._ssh._tcp.' }));
  zc.emit('resolved', service({ name: 'machine', fullName: 'machine.local._muxr._tcp.' }));
  assert.deepEqual(seen, ['machine']);
  muxr.stop();
  assert.equal(zc.calls.at(-1), 'stop');
});

test('late native errors are suppressed briefly after preemption, then active errors flow', async () => {
  const zc = new FakeZeroconf();
  const first = browse({ type: 'muxr', zeroconf: zc });
  const errors: string[] = [];
  first.on('error', (error) => errors.push(`old:${error.message}`));
  const second = browse({ type: 'ssh', zeroconf: zc });
  second.on('error', (error) => errors.push(error.message));
  zc.emit('error', new Error('late muxr error'));
  assert.deepEqual(errors, []);
  await wait(1050);
  zc.emit('error', new Error('current error'));
  assert.deepEqual(errors, ['current error']);
  second.stop();
});

test('scan rejects a non-positive window without starting one', async () => {
  const zc = new FakeZeroconf();
  await assert.rejects(scan({ type: 'ssh', ms: 0, zeroconf: zc }), /ms must be positive/);
  assert.deepEqual(zc.calls, []);
});

test('the Node entry never pulls react-native-zeroconf; the react-native condition resolves the browse entry', async () => {
  const node = await build({
    stdin: { contents: `import { advertise, reach } from '../src/index.ts'; reach; advertise;`, resolveDir: import.meta.dirname },
    bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent',
  });
  assert.ok(Object.keys(node.metafile!.inputs).every((path) => !path.endsWith('/rn.ts') && !path.includes('react-native-zeroconf')));

  const rn = await build({
    stdin: { contents: `import { browse, scan } from '../src/rn.ts'; browse; scan;`, resolveDir: import.meta.dirname },
    bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent',
    external: ['react-native-zeroconf'],
  });
  assert.ok(Object.values(rn.metafile!.outputs).some((output) => output.imports.some((entry) =>
    entry.path === 'react-native-zeroconf' && entry.external)));

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.exports['.']['react-native'], { types: './dist/rn.d.ts', default: './dist/rn.js' });
  assert.deepEqual(pkg.exports['.'].default, './dist/index.js');
  assert.equal(pkg.dependencies['react-native-zeroconf'], '0.14.0');
  assert.equal(pkg.peerDependencies?.['react-native-zeroconf'], undefined);
});
