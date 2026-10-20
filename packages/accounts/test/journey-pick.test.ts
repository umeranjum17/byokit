// A consumer's own journey against the built @byokit/accounts: one person with two signed-in ChatGPT accounts asks
// which one a run should use, and reads each account's models, before anything starts. Every import is a published
// entry (the package's dist, never its src modules), the provider is the kit's own loopback stand-in OpenAI, the two
// sign-ins share one real encrypted file store, and a pick is proven not to write it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Accounts, ResponseError, fileStore, portable, type AgentCapabilities, type Room } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';
import { scratchDir } from '../../test-support.ts';

// The test's own authenticated seal: an app's OS keychain seal stands in as AES-256-GCM. The key never leaves the run.
const key = randomBytes(32);
const sealing = {
  encryptString(text: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
  },
  decryptString(data: Buffer) {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  },
};

test('Pi and Codex keep independent choices across a consumer process restart and refuse unavailable choices', async () => {
  const openai = await mockOpenAI();
  const dir = scratchDir('journey-kind-pick');
  const storePath = join(dir, 'Umer.json');
  const store = fileStore(storePath, sealing);
  const options = { authBase: openai.base, apiBase: openai.base, app: 'Umer',
    store: (member: string | number) => member === 'Umer' ? store : fileStore(join(dir, `${member}.json`), sealing) };
  const accounts = new Accounts(options, portable);
  let restarted: Accounts | undefined;
  try {
    const ids: string[] = [];
    for (const accountId of ['umer-personal', 'umer-work']) {
      Object.assign(openai.state, { accountId, email: `${accountId}@example.com`, plan: 'plus' });
      const added = await accounts.add('Umer', 'chatgpt', { via: 'code' });
      openai.approve(added.signIn!.code!);
      await accounts.finished('Umer', added.id);
      ids.push(accounts.view('Umer', added.id)!.id!);
    }
    const [personal, work] = ids as [string, string];
    const pi = { account: personal, model: 'gpt-6-luna', auto: false };
    const codex = { account: work, model: 'gpt-6-sol' };
    await accounts.setDefaults('Umer', { account: work, model: 'gpt-6-sol' });
    await accounts.setDefaults('Umer', { ...pi, access: 'CANARY-token', refresh: 'CANARY-refresh', key: 'CANARY-key' } as any, 'pi');
    await accounts.setDefaults('Umer', codex, 'codex');
    await accounts.setDefaults('Umer', pi, 'other-kind');
    assert.deepEqual(await accounts.defaults('Other member', 'pi'), {});
    assert.deepEqual(await accounts.defaults('Umer', 'unconfigured'), {});
    const metadata = JSON.parse(sealing.decryptString(readFileSync(storePath)))['.accounts'];
    assert.deepEqual(metadata.byAgent, { pi, codex, 'other-kind': pi });
    assert.ok(!JSON.stringify(metadata).includes('CANARY'), 'preferences never copy credential properties');
    const snapshot = await store.index();
    snapshot.byAgent!.pi!.account = work;
    assert.deepEqual(await accounts.defaults('Umer', 'pi'), pi, 'index reads do not alias saved kind preferences');
    accounts.stop();

    // A separate Node consumer reads the encrypted store and actually resolves both persisted choices.
    const child = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createDecipheriv } from 'node:crypto';
      import { Accounts, fileStore, portable } from '@byokit/accounts';
      const seal = { encryptString() { throw new Error('read-only restart'); }, decryptString(data) {
        const d = createDecipheriv('aes-256-gcm', Buffer.from(process.env.BYOKIT_TEST_SEAL, 'hex'), data.subarray(0, 12));
        d.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8');
      } };
      const a = new Accounts({ store: () => fileStore(process.env.BYOKIT_TEST_PREFERENCES, seal) }, portable);
      try {
        const picks = [];
        for (const agentKind of ['pi', 'codex']) {
          const p = await a.pick('Umer', { agentKind, account: 'default' });
          assert.equal(p.ok, true);
          picks.push([agentKind, p.account.id, p.model]);
        }
        console.log(JSON.stringify(picks));
      } finally { a.stop(); }
    `], { cwd: new URL('../../../', import.meta.url), encoding: 'utf8', env: { ...process.env,
      BYOKIT_TEST_SEAL: key.toString('hex'), BYOKIT_TEST_PREFERENCES: storePath } });
    assert.deepEqual(JSON.parse(child), [['pi', personal, pi.model], ['codex', work, codex.model]]);
    console.log('consumer restart: Pi and Codex kept separate accounts and models');

    restarted = new Accounts(options, portable);
    const capabilities: AgentCapabilities = { routes: [(await restarted.list('Umer'))[0]!.route],
      models: () => [{ id: 'native-model', available: true }] };
    const refused = async (agentKind: string, caps?: AgentCapabilities, account = 'default') => {
      const pick = await restarted!.pick('Umer', { agentKind, account }, undefined, caps);
      assert.equal(pick.ok, false, 'a refused selection cannot admit a launch');
      if (!pick.ok) console.log('launch refused:', agentKind, pick.code, pick.reason);
      return pick;
    };
    await refused('unconfigured'); // never inherits the ready member-wide default
    await refused('pi', capabilities); // saved catalogue model is not a native model
    await restarted.setDefaults('Umer', { account: personal, model: 'native-model' }, 'pi');
    const native = await restarted.pick('Umer', { agentKind: 'pi', account: 'default' }, undefined, capabilities);
    assert.equal(native.ok, true);
    if (native.ok) assert.equal(native.model, 'native-model');
    await refused('pi', { ...capabilities, routes: [] });
    await refused('pi', { ...capabilities, models: () => [{ id: 'native-model', available: false }] });
    // Legacy status mutators resolve a bare provider id through the member-wide default.
    await restarted.setDefaults('Umer', { account: personal, model: 'gpt-6-luna' });
    restarted.notIncluded('Umer', personal, true);
    assert.equal((await restarted.list('Umer')).find((a) => a.id === personal)!.state, 'not_included');
    await refused('pi', capabilities);
    await refused('pi', capabilities, personal); // explicit scoped ids also refuse
    restarted.notIncluded('Umer', personal, false);
    await restarted.failed('Umer', personal, new ResponseError('429 Too Many Requests', 'rate_limit', Date.now() + 3_600_000), true);
    await refused('pi', capabilities); // a resting saved choice is not permission to switch accounts
    await restarted.logout('Umer', personal);
    assert.equal((await restarted.defaults('Umer', 'pi')).account, personal, 'sign-out retains the selected reference');
    assert.deepEqual((await restarted.list('Umer')).map((a) => a.id), [work]);
    await refused('pi', capabilities); // signed-out reference never falls back to another ready account
    const auto = await restarted.pick('Umer', { agentKind: 'pi', account: 'auto' });
    assert.equal(auto.ok, true, 'Auto is still available when explicitly requested');
    if (auto.ok) assert.equal(auto.account.id, work);
    await restarted.remove('Umer', personal);
    for (const kind of ['pi', 'other-kind']) {
      const cleared = await restarted.defaults('Umer', kind);
      assert.equal(cleared.account, undefined); assert.equal(cleared.model, undefined);
    }
    assert.deepEqual(await restarted.defaults('Umer', 'codex'), codex);
    assert.deepEqual(await restarted.defaults('Umer'), {}, 'member-wide selection and model also clear');
    await refused('pi'); // removal cannot activate the still-ready Work account
    await restarted.remove('Umer', work);
    assert.deepEqual(await restarted.defaults('Umer', 'codex'), {});
    assert.deepEqual(await restarted.defaults('Umer'), {});
    console.log('removal: all referencing selections and models cleared; no credential preferences');
  } finally { accounts.stop(); restarted?.stop(); await openai.close(); }
});

test('a person with two ChatGPT accounts picks the roomier one, reads each one’s models, and a pick writes nothing', async () => {
  const openai = await mockOpenAI();
  const dir = scratchDir('journey-pick');
  const storePath = join(dir, 'member-1.json');
  const accounts = new Accounts<any, number>(
    { authBase: openai.base, apiBase: openai.base, app: 'byokit journey', store: () => fileStore(storePath, sealing) },
    portable,
  );
  try {
    // The first ChatGPT sign-in keeps the bare provider id and is the person's personal plan.
    Object.assign(openai.state, { accountId: 'umer-personal', email: 'umer@example.com', plan: 'plus' });
    const personalSignIn = await accounts.add(1, 'chatgpt', { via: 'code' });
    openai.approve(personalSignIn.signIn!.code!);
    await accounts.finished(1, personalSignIn.id);
    const personal = accounts.view(1, personalSignIn.id)!.id!;

    // A different identity adds a second account; the person names it Work.
    Object.assign(openai.state, { accountId: 'umer-work', email: 'umer@work.example', plan: 'team' });
    const workSignIn = await accounts.add(1, 'chatgpt', { via: 'code' });
    openai.approve(workSignIn.signIn!.code!);
    await accounts.finished(1, workSignIn.id);
    const work = accounts.view(1, workSignIn.id)!.id!;
    await accounts.rename(1, work, 'Work');
    assert.notEqual(work, personal);

    // Each account reports ChatGPT's own live list while it is ready: the rows it shows, never a hidden one.
    const readyModels = await accounts.models(1, work);
    assert.deepEqual(readyModels.map((m) => [m.id, m.name, m.available, m.why]), [
      ['gpt-6-sol', 'GPT-6 Sol', true, undefined],
      ['gpt-6-luna', 'GPT-6 Luna', true, undefined],
    ]);
    const listed = openai.state.requests.filter((r) => r.path === '/codex/models');
    assert.equal(listed.at(-1)?.account, 'umer-work', 'read with that account\'s own sign-in');

    // Work has more room this week, so Auto names Work and says why; the pick writes neither store nor defaults.
    const rooms: Record<string, Room> = { [work]: { left: 60, span: 'week' }, [personal]: { left: 30, span: 'week' } };
    const storeBefore = readFileSync(storePath);
    const defaultsBefore = await accounts.defaults(1);
    const read: string[] = [];
    const picked = await accounts.pick(1, { account: 'auto' }, (account) => { read.push(account.id); return rooms[account.id]; });
    assert.equal(picked.ok, true);
    if (picked.ok) {
      assert.equal(picked.account.id, work);
      assert.equal(picked.account.name, 'Work');
      assert.equal(picked.model, 'gpt-6-sol');
      assert.equal(picked.reason, "Right now that's Work: 60% left this week");
    }
    assert.deepEqual(read.sort(), [personal, work].sort(), 'each account is read exactly once');
    assert.deepEqual(readFileSync(storePath), storeBefore, 'pick never writes the store');
    assert.deepEqual(await accounts.defaults(1), defaultsBefore, 'pick never writes defaults');
    assert.deepEqual(await accounts.list(1).then((rows) => rows.map((r) => r.id).sort()), [personal, work].sort());

    // No room source, or one that throws, leaves every row unknown: the pick falls back to list order, first eligible.
    for (const absent of [undefined, () => { throw new Error('readings are down'); }]) {
      const fallback = await accounts.pick(1, { account: 'auto' }, absent as any);
      assert.equal(fallback.ok, true);
      if (fallback.ok) assert.equal(fallback.account.id, personal, 'unknown rows keep list order');
    }

    // Work hits its limit: only Work rests, so the next Auto moves to Personal, and no default changed.
    await accounts.failed(1, work, new ResponseError('429 Too Many Requests', 'rate_limit', Date.now() + 3_600_000));
    assert.equal((await accounts.list(1)).find((r) => r.id === work)!.state, 'resting');
    const after = await accounts.pick(1, { account: 'auto' }, (account) => rooms[account.id]);
    assert.equal(after.ok, true);
    if (after.ok) assert.equal(after.account.id, personal);
    assert.deepEqual(readFileSync(storePath), storeBefore, 'a later pick writes nothing either');

    // The resting account's models say so, each with the time it clears.
    const resting = await accounts.models(1, work);
    assert.equal(resting.length, 2);
    for (const model of resting) {
      assert.equal(model.available, false);
      assert.equal(model.why, 'resting');
      assert.ok(model.until && model.until > Date.now(), `${model.id} names when it clears`);
    }

    // An id that is not in the list is refused, never silently replaced by another account.
    const missing = await accounts.pick(1, { account: 'chatgpt.deadbeef' });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'unknown_account');
    await assert.rejects(accounts.models(1, 'chatgpt.deadbeef'), /No such account/);

    // A plan without this use says why every model is unavailable.
    accounts.notIncluded(1, personal, true);
    const excluded = await accounts.models(1, personal);
    assert.ok(excluded.length && excluded.every((m) => !m.available && m.why === 'plan'));
    // Signed out, there is no sign-in to read the list with, so nothing is listed.
    accounts.forget(1, personal);
    assert.deepEqual(await accounts.models(1, personal), []);
  } finally {
    accounts.stop();
    await openai.close();
  }
});
