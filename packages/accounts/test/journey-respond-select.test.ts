// A consumer's own journey against the built @byokit/accounts: one person with two signed-in ChatGPT accounts asks
// with a selected account, and the answer comes from that account's own sign-in. Every import is a published entry
// (the package's dist, never its src modules), the provider is the kit's own loopback stand-in OpenAI, and the two
// sign-ins share one real encrypted file store. The stand-in records the chatgpt-account-id header it was asked with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Accounts, ResponseError, fileStore, portable } from '@byokit/accounts';
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

const answers = (requests: { path: string; account?: string }[]) => requests.filter((r) => r.path === '/codex/responses');

test('respond answers from the selected ChatGPT account, rests only that one, and never falls back to the default', async () => {
  const openai = await mockOpenAI();
  const dir = scratchDir('journey-respond-select');
  const store = fileStore(join(dir, 'member-1.json'), sealing);
  const accounts = new Accounts<any, number>(
    { authBase: openai.base, apiBase: openai.base, app: 'byokit journey', store: () => store },
    portable,
  );
  try {
    // Work signs in first: the first account keeps the bare provider id and is the primary. Personal is a second id.
    Object.assign(openai.state, { accountId: 'umer-work', email: 'umer@work.example', plan: 'team' });
    const workSignIn = await accounts.add(1, 'chatgpt', { via: 'code' });
    openai.approve(workSignIn.signIn!.code!);
    await accounts.finished(1, workSignIn.id);
    const work = accounts.view(1, workSignIn.id)!.id!;
    await accounts.rename(1, work, 'Work');

    Object.assign(openai.state, { accountId: 'umer-personal', email: 'umer@example.com', plan: 'plus' });
    const personalSignIn = await accounts.add(1, 'chatgpt', { via: 'code' });
    openai.approve(personalSignIn.signIn!.code!);
    await accounts.finished(1, personalSignIn.id);
    const personal = accounts.view(1, personalSignIn.id)!.id!;
    await accounts.rename(1, personal, 'Personal');

    assert.equal(work, 'chatgpt', 'the first account is the bare primary');
    assert.notEqual(personal, work);

    // The default is Personal, so a bare provider call would answer with Personal. Auto must still name Work (list order
    // with no room reading), and the request must carry Work's own account header, never the default's.
    await accounts.setDefaults(1, { account: personal });
    const defaultsBefore = await accounts.defaults(1);

    const first = await accounts.respond(1, { instructions: 'Be brief.', input: 'Which account am I?', select: { account: 'auto' } });
    assert.equal(first, 'You said: Which account am I?');
    assert.equal(answers(openai.state.requests).at(-1)!.account, 'umer-work', 'Auto answered with Work, not the default');

    // A 429 on the picked account rests only Work, and the run ends without trying Personal.
    openai.state.fail = { status: 429, body: JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'You have hit your usage limit' } }) };
    const before = answers(openai.state.requests).length;
    await assert.rejects(
      accounts.respond(1, { instructions: 'Be brief.', input: 'again', select: { account: 'auto' } }),
      (e: any) => e instanceof ResponseError && e.kind === 'rate_limit',
    );
    assert.equal(answers(openai.state.requests).length, before + 1, 'one request, no retry on another account');
    const rows = await accounts.list(1);
    assert.equal(rows.find((r) => r.id === work)!.state, 'resting', 'only the picked account rests');
    assert.equal(rows.find((r) => r.id === personal)!.state, 'ready', 'the default is untouched');

    // The next Auto skips the resting account and answers from Personal.
    const second = await accounts.respond(1, { instructions: 'Be brief.', input: 'Who now?', select: { account: 'auto' } });
    assert.equal(second, 'You said: Who now?');
    assert.equal(answers(openai.state.requests).at(-1)!.account, 'umer-personal', 'the next Auto moved to Personal');

    // The saved default is unchanged throughout.
    assert.deepEqual(await accounts.defaults(1), defaultsBefore);

    // An explicit id whose credential is gone is refused typed, before any request reaches the server.
    await store.delete(personal);
    const asked = answers(openai.state.requests).length;
    await assert.rejects(
      accounts.respond(1, { instructions: 'Be brief.', input: 'ghost', select: { account: personal } }),
      (e: any) => e instanceof ResponseError && e.kind === 'signed_out',
    );
    assert.equal(answers(openai.state.requests).length, asked, 'no request was sent for the signed-out id');
  } finally {
    accounts.stop();
    await openai.close();
  }
});
