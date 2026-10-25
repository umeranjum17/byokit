// K1 (docs/runtime-kits.md 5.15): an anthropic-cli account is bound to its own managed native CLI row. A fake `claude`
// signs in per CLAUDE_CONFIG_DIR, so two accounts land in two folders; list and status read through the binding, a
// re-auth that is cancelled keeps the row, removal logs out that folder only, and the engine is never asked to seal or activate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import type { SignInView } from '../src/types.ts';

const POLICY = { authChoice: 'anthropic-cli', credentialPolicy: 'in-place' } as const;

test('native accounts: two folders, listed and checked through their bindings, re-auth keeps the row, removal is exact', { timeout: 30_000 }, async () => {
  const root = scratchDir('k1-native'), bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), dir = process.env.CLAUDE_CONFIG_DIR, granted = path.join(dir, 'granted');
if (process.argv[3] === 'status') { console.log(JSON.stringify({ loggedIn: fs.existsSync(granted) })); process.exit(); }
console.log('If the browser did not open, visit: https://claude.example.test/authorize');
process.stdin.setEncoding('utf8'); process.stdin.once('data', (code) => { fs.writeFileSync(granted, code.trim()); process.exit(0); });
`, { mode: 0o700 });
  const fake = fakeGateway(), methods: string[] = [];
  const kit = new OpenClawKit({ stateDir: root, enginePath: [bin], spawnEngine: false, callbackPort: 0,
    transport: (ctx) => { const t = fake.factory(ctx); return { ...t, request: (method, params, o) => { methods.push(method === 'byokit.accounts' ? `${method}:${String((params as { action?: string }).action)}` : method); return t.request(method, params, o); } }; } });
  const index = () => JSON.parse(readFileSync(join(root, 'openclaw', 'accounts', 'm1.json'), 'utf8')) as
    { accounts: Record<string, { agent: string; native?: { kind: string; cliAccountId: string; cli: string } }> };
  const claude = join(root, 'openclaw', 'native', 'claude');
  const logins = () => readdirSync(claude).flatMap((d) => { try { return [[d, readFileSync(join(claude, d, 'granted'), 'utf8')]]; } catch { return []; } });
  const add = async (fields: { again?: string; name?: string } = {}) => {
    const seen: SignInView[] = [];
    const handle = await kit.addAccount('m1', { ...POLICY, ...fields }, (v) => seen.push(v));
    return { handle, seen };
  };
  const signedIn = async (name: string, code: string) => { const { handle, seen } = await add({ name }); for (let i = 0; !seen.some((v) => v.url) && i < 300; i++) await new Promise((r) => setTimeout(r, 10)); handle.paste(code); return { id: handle.id, result: await handle.done }; };
  try {
    await kit.start();
    const a = await signedIn('Claude — Work', 'code-a'), b = await signedIn('Claude — Home', 'code-b');
    assert.equal(a.result.view.state, 'done'); assert.equal(b.result.view.state, 'done');
    assert.match(a.id, /^claude-cli\.[0-9a-f]{6}$/); assert.notEqual(a.id, b.id);
    const bindA = index().accounts[a.id]!.native!, bindB = index().accounts[b.id]!.native!;
    assert.deepEqual(Object.keys(bindA).sort(), ['cli', 'cliAccountId', 'kind']); assert.equal(bindA.kind, 'native-cli'); assert.notEqual(bindA.cliAccountId, bindB.cliAccountId);
    assert.deepEqual(logins().map(([, who]) => who).sort(), ['code-a', 'code-b'], 'two final folders, each holding its own login');
    assert.deepEqual((await kit.accounts('m1')).map((r) => [r.id, r.state, r.origin]), [[a.id, 'ready', 'managed'], [b.id, 'ready', 'managed']]);
    assert.ok(!methods.includes('openclaw.setup.activate') && !methods.includes('byokit.accounts:seal') && !methods.includes('byokit.accounts:ready'), 'the engine seals and activates nothing for a bound row');

    // A cancelled re-auth of B keeps B's binding and A untouched.
    const again = await add({ again: b.id }); for (let i = 0; !again.seen.some((v) => v.url) && i < 300; i++) await new Promise((r) => setTimeout(r, 10));
    again.handle.cancel(); const cancelled = await again.handle.done;
    assert.equal(cancelled.view.state, 'failed'); assert.equal(cancelled.id, b.id);
    assert.deepEqual(index().accounts[b.id]!.native, bindB, 'the same binding after a cancelled re-auth');
    assert.deepEqual((await kit.accounts('m1')).map((r) => r.state), ['ready', 'ready']);

    // B's own folder is logged out: B reads signed out through its binding, A is still ready.
    rmSync(join(claude, logins().find(([, who]) => who === 'code-b')![0]!, 'granted'));
    assert.deepEqual((await kit.accounts('m1')).map((r) => [r.id, r.state]), [[a.id, 'ready'], [b.id, 'signed_out']]);
    assert.equal((await kit.accountStatus('m1', a.id)).state, 'ready');
    assert.equal((await kit.accountStatus('m1', b.id)).state, 'signed_out');

    await kit.removeAccount('m1', b.id);
    assert.deepEqual((await kit.accounts('m1')).map((r) => [r.id, r.state]), [[a.id, 'ready']]);
    assert.deepEqual(logins().map(([, who]) => who), ['code-a'], 'removal logged out B\'s folder only');
  } finally { await kit.stop(); }
});

// K2 (docs/runtime-kits.md 5.15): the binding reaches the engine as a table of folder paths, one row per bound account
// agent, rewritten from the index after an add or a removal and never holding anything but a folder. Reading one account
// is that account's own probe: a slow sibling delays nothing and never signs it out.
test('K2: bound folders are published per account agent, and a slow probe on one account leaves the other ready', { timeout: 30_000 }, async () => {
  const root = scratchDir('k2-published'), bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
  // A login per CLAUDE_CONFIG_DIR; a slow marker file in that folder makes the status probe pause, as a hung CLI would.
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), dir = process.env.CLAUDE_CONFIG_DIR, granted = path.join(dir, 'granted');
if (process.argv[3] === 'status') {
  if (fs.existsSync(path.join(dir, 'slow'))) { const wait = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(wait, 0, 0, 1500); }
  console.log(JSON.stringify({ loggedIn: fs.existsSync(granted) })); process.exit();
}
console.log('If the browser did not open, visit: https://claude.example.test/authorize');
process.stdin.setEncoding('utf8'); process.stdin.once('data', (code) => { fs.writeFileSync(granted, code.trim()); process.exit(0); });
`, { mode: 0o700 });
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir: root, enginePath: [bin], spawnEngine: false, callbackPort: 0,
    transport: (ctx) => fake.factory(ctx) });
  const kitRoot = join(root, 'openclaw'), nativeDir = join(kitRoot, 'native', 'claude');
  const table = () => JSON.parse(readFileSync(join(kitRoot, 'native', 'env.json'), 'utf8')) as
    { v: number; accounts: Record<string, { cli: string; dir: string }> };
  const index = () => JSON.parse(readFileSync(join(kitRoot, 'accounts', 'm1.json'), 'utf8')) as
    { accounts: Record<string, { agent: string; native?: { cliAccountId: string } }> };
  const signedIn = async (name: string) => {
    const seen: SignInView[] = [];
    const handle = await kit.addAccount('m1', { ...POLICY, name }, (view) => seen.push(view));
    for (let waited = 0; !seen.some((view) => view.url) && waited < 300; waited++) await new Promise((r) => setTimeout(r, 10));
    handle.paste(name);
    const result = await handle.done;
    assert.equal(result.view.state, 'done', `${name}: ${JSON.stringify(result.view)}`);
    return result.id;
  };
  try {
    await kit.start();
    const idA = await signedIn('Claude — Work'), idB = await signedIn('Claude — Home');
    const rows = index().accounts;
    // The folder each account's own login landed in, by the code the fake CLI wrote there.
    const folderOf = (name: string) => readdirSync(nativeDir)
      .map((id) => join(nativeDir, id)).find((dir) => { try { return readFileSync(join(dir, 'granted'), 'utf8') === name; } catch { return false; } })!;
    await kit.accounts('m1');
    const published = table();
    assert.equal(published.v, 1);
    assert.deepEqual(Object.keys(published.accounts).sort(), [rows[idA]!.agent, rows[idB]!.agent].sort(),
      'one row per bound account agent: nothing the app could read as a credential');
    assert.deepEqual(Object.keys(published.accounts[rows[idA]!.agent]!).sort(), ['cli', 'dir'], 'a row is a CLI name and a folder');
    assert.equal(published.accounts[rows[idA]!.agent]!.dir, folderOf('Claude — Work'));
    assert.equal(published.accounts[rows[idB]!.agent]!.dir, folderOf('Claude — Home'));
    assert.notEqual(published.accounts[rows[idA]!.agent]!.dir, published.accounts[rows[idB]!.agent]!.dir, 'two accounts, two folders');

    // A's probe hangs for a moment: B still reads ready through its own folder, and A keeps its own answer after.
    writeFileSync(join(folderOf('Claude — Work'), 'slow'), 'slow');
    const slowA = kit.accountStatus('m1', idA);
    const sibling = await kit.accountStatus('m1', idB);
    assert.equal(sibling.state, 'ready', 'a slow sibling never signs another account out');
    assert.equal((await slowA).state, 'ready', 'A keeps its own answer');

    // Signing A out of its own folder changes A alone: B is untouched, and both rows are still bound.
    rmSync(join(folderOf('Claude — Work'), 'slow'));
    rmSync(join(folderOf('Claude — Work'), 'granted'));
    assert.deepEqual((await kit.accounts('m1')).map((row) => [row.id, row.state, row.native]), [[idA, 'signed_out', true], [idB, 'ready', true]]);
    assert.deepEqual(Object.keys(table().accounts).sort(), [rows[idA]!.agent, rows[idB]!.agent].sort(),
      'reading the folder of one account never unpublishes another');

    // Dropping an account drops its row: the table never outlives the index entry that names it.
    await kit.removeAccount('m1', idB);
    assert.deepEqual(Object.keys(table().accounts), [rows[idA]!.agent]);
  } finally { await kit.stop(); }
});
