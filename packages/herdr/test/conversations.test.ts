import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, symlinkSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit, importConversation, type ConversationImport } from '../src/index.ts';
import { startFakeHerdr } from '../src/testing/index.ts';

// Real socket and filesystem; the fake never launches an agent CLI or model session.
test('carry Pi history between isolated accounts, refusing damaged, unsafe and unwritable destinations', async () => {
  const root = realpathSync(scratchDir('conversation')), a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  const id = '12345678-1234-1234-1234-123456789abc', path = `sessions/--fixture--/2026-10-25T00-00-00-000Z_${id}.jsonl`;
  mkdirSync(join(a, 'sessions/--fixture--'), { recursive: true });
  const body = `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-25T00:00:00.000Z', cwd: '/fixture' })}\n${JSON.stringify({ type: 'message', id: 'msg', parentId: null, timestamp: '2026-10-25T00:00:00.000Z', message: { role: 'user', content: 'Hello Umer' } })}\n`;
  writeFileSync(join(a, path), body); writeFileSync(join(a, 'auth.json'), 'credential-canary');
  const fake = await startFakeHerdr({ dir: join(root, 'fake') });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/unused', socketPath: fake.socketPath });
  const code = (r: ConversationImport, want: string) => { assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, want); };
  const tree = (dir: string): string => createHash('sha256').update(JSON.stringify(readdirSync(dir, { recursive: true }).sort().map(p => {
    const file = join(dir, String(p)); return [p, lstatSync(file).mode, lstatSync(file).isFile() ? readFileSync(file).toString('hex') : 'directory'];
  }))).digest('hex');
  try {
    await kit.start();
    code(await kit.exportConversation({ paneId: 'w1:p2' }, { to: join(root, 'absent') }), 'unsupported');
    const ref = await kit.startAgent({ kind: 'pi', cwd: a, place: { pane: 'w1:p1' }, args: ['--model', 'fixture/offline'], installProbe: { path: [] },
      env: { env: { HOME: a, PI_CODING_AGENT_DIR: a }, unset: [] } });
    const agent = fake.world.agents.find(x => x.pane_id === ref.paneId)!;
    agent.agent_session = { source: 'fixture', agent: 'pi', kind: 'path', value: join(a, path) };
    const before = tree(root);
    for (const options of [{ maxBytes: 1 }, { maxBytes: Buffer.byteLength(body) }, { maxFiles: 0 }, { maxBytes: 1024 ** 3 + 1 }])
      code(await kit.exportConversation(ref, { to: join(root, 'absent'), ...options }), 'too-large');
    assert.equal(tree(root), before);
    const bundle = join(root, 'bundle'), exported = await kit.exportConversation(ref, { to: bundle });
    assert.equal(exported.ok, true); if (!exported.ok) return;
    assert.equal(exported.conversation, id); assert.equal(exported.files, 1);
    const options = { bundle, accountFolder: b, kind: 'pi', conversation: id };
    assert.deepEqual(await importConversation(options), exported);
    assert.equal(readFileSync(join(b, path), 'utf8'), body);
    assert.deepEqual(readdirSync(b), ['sessions']);
    const restored = tree(b); code(await kit.importConversation(options), 'exists'); assert.equal(tree(b), restored);
    writeFileSync(join(b, path), 'original conversation');
    const original = tree(b), mode = lstatSync(join(b, 'sessions/--fixture--')).mode; chmodSync(join(b, 'sessions/--fixture--'), 0o500);
    const locked = tree(b); code(await importConversation({ ...options, overwrite: true }), 'write-failed');
    assert.equal(tree(b), locked); chmodSync(join(b, 'sessions/--fixture--'), mode); assert.equal(tree(b), original);
    assert.deepEqual(await importConversation({ ...options, overwrite: true }), exported); assert.equal(tree(b), restored);
    const bytes = readFileSync(bundle), length = bytes.readUInt32BE(8), manifest = JSON.parse(bytes.subarray(12, 12 + length).toString());
    assert.equal(manifest.files[0].path, path); assert.equal(manifest.bytes, Buffer.byteLength(body));
    assert.equal(bytes.includes(Buffer.from('credential-canary')), false);
    const bad = join(root, 'bad');
    const altered = Buffer.from(bytes); altered[altered.length - 1] = altered[altered.length - 1]! ^ 1; writeFileSync(bad, altered);
    code(await importConversation({ ...options, bundle: bad }), 'digest-mismatch');
    for (const patch of [{ path: '../escape' }, { path: '/absolute' }, { path: 'sessions/../escape' }, { type: 'symlink', target: '../escape' }]) {
      const m = structuredClone(manifest); Object.assign(m.files[0], patch);
      const header = Buffer.from(JSON.stringify(m)), prefix = Buffer.from(bytes.subarray(0, 12)); prefix.writeUInt32BE(header.length, 8);
      writeFileSync(bad, Buffer.concat([prefix, header, bytes.subarray(12 + length)]));
      code(await importConversation({ ...options, bundle: bad }), 'unsafe-path'); assert.equal(tree(b), restored);
    }
    const linked = join(root, 'linked'); symlinkSync(bundle, linked);
    code(await importConversation({ ...options, bundle: linked }), 'unsafe-path');
    const c = join(root, 'c'); mkdirSync(c); symlinkSync(a, join(c, 'sessions'));
    code(await importConversation({ ...options, accountFolder: c }), 'unsafe-path');
    assert.equal(tree(b), restored); assert.equal(readdirSync(b).some(p => p.startsWith('.conversation-')), false);
  } finally { await kit.stop(); await fake.stop(); }
});
