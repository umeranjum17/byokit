import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { Host, keyPair, pairWithOffer, LinkStream } from '@byokit/link';
import { JobChannel, readJobStream, type JobFrame, type JobWriter } from '../src/index.ts';
import { readJobStream as deviceReader } from '../src/device.ts';
import { device, hostClient, onEnd, startRelay, until } from './helpers.ts';

test('one encrypted job delivers live text, binary images and final usage, resuming after relay reconnect', async () => {
  const jobs = new JobChannel();
  let starts = 0;
  let writer!: JobWriter;
  const host = await Host.open({
    keys: keyPair(), name: 'Job host', confirm: () => true,
    handle: (req, grant) => {
      if (req.op === 'ping') return true;
      assert.equal(req.op, 'job.start');
      writer = jobs.create('job-1', grant.id);
      starts++;
      return { job: 'job-1' };
    },
    stream: (stream, req, grant) => jobs.follow(stream, req.args as { job: string; after: number }, grant.id),
  });
  onEnd(() => host.close());
  const r = await startRelay();
  await r.relay.admit(host.keys.publicKey);
  const hc = hostClient(host, r.ws);
  await until(() => hc.client.status === 'online');
  const offer = () => host.offer({ role: 'control', urls: [`${r.ws}/link/v1/${host.id}`] }).text;
  const grant = await pairWithOffer(offer(), { name: 'Job phone', onWords: () => {} });
  const dev = device(grant);
  // Production starts its selected kit run after creating the job, not from the follow handler.
  assert.deepEqual(await dev.link.request('job.start'), { job: 'job-1' });
  const frames: JobFrame[] = [];
  let cursor = 0;
  const stream = await dev.link.stream('job.follow', { job: 'job-1', after: cursor });
  const first = readJobStream(stream, { job: 'job-1' }, async (frame) => {
    frames.push(frame); cursor = frame.seq;
  });
  const lost = assert.rejects(first, /Reconnect to resume/);
  writer.append({ type: 'text', text: 'progress-marker 🐈' });
  await until(() => cursor === 1); // progressive output before completion
  const port = Number(new URL(r.http).port), state = r.saved();
  r.stop();
  await lost;
  await until(() => hc.client.status === 'offline');
  const image = Uint8Array.from({ length: 320_000 }, (_, i) => i % 256);
  writer.append({ type: 'image', mime: 'image/png', data: image });
  image.fill(0); // retained frames own their bytes
  const usage = { inputTokens: 12, outputTokens: 34 };
  writer.append({ type: 'usage', usage });
  usage.inputTokens = 999;
  writer.append({ type: 'end' });
  const again = await startRelay({ store: { load: () => state, save: () => {} } }, port);
  await until(() => hc.client.status === 'online');
  await dev.link.request('ping'); // ensures DeviceLink has reconnected
  assert.equal(starts, 1);
  const resumed = await dev.link.stream('job.follow', { job: 'job-1', after: cursor });
  assert.equal(await deviceReader(resumed, { job: 'job-1', after: cursor }, (frame) => {
    frames.push(frame); cursor = frame.seq;
  }), 4);
  assert.deepEqual(frames.map((f) => [f.job, f.seq, f.type]), [
    ['job-1', 1, 'text'], ['job-1', 2, 'image'], ['job-1', 3, 'usage'], ['job-1', 4, 'end'],
  ]);
  assert.equal(frames[1]!.type, 'image');
  if (frames[1]!.type === 'image') assert.deepEqual(frames[1].data, Uint8Array.from({ length: 320_000 }, (_, i) => i % 256));
  assert.deepEqual(frames[2], { job: 'job-1', seq: 3, type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } });
  // Pairing closes its temporary socket without waiting for the relay to observe the close.
  // Wait for that server-side event before counting the two persistent device links.
  let pairingClosed = false;
  again.server.once('upgrade', (_req, socket) => {
    socket.once('close', () => { pairingClosed = true; });
  });
  const strangerGrant = await pairWithOffer(offer(), { name: 'Other phone', onWords: () => {} });
  const stranger = device(strangerGrant);
  await stranger.link.request('ping');
  const denied = await stranger.link.stream('job.follow', { job: 'job-1', after: 0 });
  await assert.rejects(readJobStream(denied, { job: 'job-1' }, () => assert.fail('cross-owner frame')));
  const invalid = await dev.link.stream('job.follow', { job: 'job-1', after: 99 });
  await assert.rejects(readJobStream(invalid, { job: 'job-1', after: 99 }, () => assert.fail('invalid cursor frame')));
  const finished = await dev.link.stream('job.follow', { job: 'job-1', after: 4 });
  assert.equal(await readJobStream(finished, { job: 'job-1', after: 4 }, () => assert.fail('already applied frame')), 4);
  assert.doesNotMatch(hc.wire.join('\n'), /progress-marker|inputTokens|image\/png|job-1/);
  await until(() => pairingClosed);
  assert.equal(again.relay.count(host.id), 2);
});

test('history is bounded, terminal, isolated by owner and explicitly released', () => {
  assert.throws(() => new JobChannel({ maxBytes: 0 }));
  const jobs = new JobChannel({ maxJobs: 2, maxFrames: 2, maxBytes: 200 });
  const first = jobs.create('one', 'owner');
  assert.throws(() => jobs.create('one', 'owner'), /already exists/);
  assert.equal(first.append({ type: 'text', text: 'first' }), 1);
  assert.throws(() => first.append({ type: 'text', text: 'a'.repeat(200) }), /full/);
  assert.equal(first.append({ type: 'end' }), 2, 'failed appends do not consume sequence numbers');
  assert.throws(() => first.append({ type: 'text', text: 'late' }), /ended/);
  const other = jobs.create('one', 'other');
  assert.throws(() => jobs.create('three', 'owner'), /full/);
  assert.equal(jobs.drop('one', 'owner'), true);
  assert.equal(jobs.drop('one', 'owner'), false);
  assert.throws(() => first.append({ type: 'end' }), /ended/);
  assert.equal(other.append({ type: 'text', text: 'other' }), 1);
  assert.equal(other.append({ type: 'text', text: 'next' }), 2);
  assert.throws(() => other.append({ type: 'end' }), /full/);
  jobs.drop('one', 'other');
  const fresh = jobs.create('new', 'owner');
  assert.throws(() => fresh.append({ type: 'usage', usage: { tokens: -1 } }), /Invalid/);
  assert.equal(fresh.append({ type: 'end' }), 1);
});

test('reader handles fragmented UTF-8, rejects reordered frames and waits for application before completing', async () => {
  const make = () => new LinkStream(1, 'job.follow', {}, { send() {}, data() {} }, () => {});
  const stream = make();
  let release!: () => void;
  const applied = new Promise<void>((r) => { release = r; });
  const result = readJobStream(stream, { job: 'j' }, () => applied);
  const bytes = new TextEncoder().encode('{"job":"j","seq":1,"type":"text","text":"🐈"}\n');
  for (const b of bytes) stream.received(Uint8Array.of(b));
  stream.ended();
  let settled = false;
  void result.then(() => { settled = true; });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(settled, false);
  release();
  assert.equal(await result, 1);
  const bad = make();
  const rejected = assert.rejects(readJobStream(bad, { job: 'j' }, () => assert.fail()), /out of order/);
  bad.received(new TextEncoder().encode('{"job":"j","seq":2,"type":"end"}\n'));
  await rejected;
  const truncated = make();
  const incomplete = assert.rejects(readJobStream(truncated, { job: 'j' }, () => {}), /Incomplete/);
  truncated.received(new TextEncoder().encode('{"job":'));
  truncated.ended();
  await incomplete;
  const malformed = make();
  const invalidText = assert.rejects(readJobStream(malformed, { job: 'j' }, () => {}), /Invalid job text/);
  malformed.received(Uint8Array.of(0xc0, 0x80, 10)); // overlong UTF-8, not a valid JSON line
  await invalidText;
});

test('device reader bundles and reads text and image without Node globals or TextDecoder (React Native)', async () => {
  const bundle = await build({
    stdin: { contents: `import { readJobStream } from '@byokit/relay/device';
      import { LinkStream } from '@byokit/link';
      const s = new LinkStream(1, 'job.follow', {}, { send() {}, data() {} }, () => {});
      const frames = [];
      globalThis.result = readJobStream(s, { job: 'j' }, f => frames.push(f)).then(seq => ({ seq, frames }));
      s.received(new TextEncoder().encode(JSON.stringify({ job: 'j', seq: 1, type: 'text', text: '🐈' }) + '\\n'));
      s.received(new TextEncoder().encode(JSON.stringify({ job: 'j', seq: 2, type: 'image', mime: 'image/png', data: 'AAH_' }) + '\\n'));
      s.ended();`, resolveDir: import.meta.dirname },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'],
    mainFields: ['react-native', 'browser', 'module', 'main'], write: false, logLevel: 'silent',
  });
  const sandbox: any = { TextEncoder, Uint8Array };
  assert.equal(runInNewContext('typeof TextDecoder + ":" + typeof Buffer + ":" + typeof process + ":" + typeof require', sandbox),
    'undefined:undefined:undefined:undefined');
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  const result = await sandbox.result;
  assert.equal(result.seq, 2);
  assert.equal(result.frames[0].text, '🐈');
  assert.deepEqual(Array.from(result.frames[1].data), [0, 1, 255]);
});
