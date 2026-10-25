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
