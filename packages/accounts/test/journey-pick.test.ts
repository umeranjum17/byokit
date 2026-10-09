// A consumer's own journey against the built @byokit/accounts: one person with two signed-in ChatGPT accounts asks
// which one a run should use, and reads each account's models, before anything starts. Every import is a published
// entry (the package's dist, never its src modules), the provider is the kit's own loopback stand-in OpenAI, the two
// sign-ins share one real encrypted file store, and a pick is proven not to write it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Accounts, ResponseError, fileStore, portable, type Room } from '@byokit/accounts';
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

    // Each account reports the catalogue's models while it is ready.
    const readyModels = await accounts.models(1, work);
    assert.deepEqual(readyModels.map((m) => [m.id, m.tier, m.available, m.why]), [
      ['gpt-6-sol', 'strong', true, undefined],
      ['gpt-6-luna', 'fast', true, undefined],
    ]);

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

    // A plan without this use and a sign-in that lapsed each say why every model is unavailable.
    accounts.notIncluded(1, personal, true);
    for (const model of await accounts.models(1, personal)) assert.equal(model.why, 'plan');
    accounts.forget(1, personal);
    for (const model of await accounts.models(1, personal)) assert.equal(model.why, 'signed_out');
  } finally {
    accounts.stop();
    await openai.close();
  }
});
