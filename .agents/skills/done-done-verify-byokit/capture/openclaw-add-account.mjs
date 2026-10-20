import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync('.verify-artifacts/add-account-');
const index = () => JSON.parse(readFileSync(join(stateDir, 'openclaw', 'accounts', 'm1.json'), 'utf8')).accounts;
const kit = new OpenClawKit({ stateDir, transport: fakeGateway().factory, spawnEngine: false, callbackPort: 0 });
try {
  await kit.start();
  const identity = async () => (await kit.call('agents.files.get', { agentId: 'm1', name: 'IDENTITY.md' })).file.content;
  const roster = async () => (await kit.call('agents.list', {})).agents.map((a) => a.id);

  const first = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
  console.log('first ChatGPT account:', JSON.stringify(await first.done));
  const before = await identity();

  const views = [];
  const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', name: 'Personal' }, (v) => views.push(v));
  const done = await second.done;
  console.log('second ChatGPT account:', JSON.stringify(done));
  console.log('browser URL:', views.find((v) => v.url).url);
  console.log('accounts:', JSON.stringify((await kit.accounts('m1')).map((a) => [a.id, a.name, a.state])));
  console.log('roster:', JSON.stringify(await roster()));
  console.log('index:', JSON.stringify(Object.fromEntries(Object.entries(index()).map(([id, e]) => [id, e.agent]))));
  assert.match(second.id, /^openai\.[0-9a-f]{6}$/);
  assert.ok((await roster()).includes(`m1--${second.id.slice(7)}`));
  assert.equal(new URL(views.find((v) => v.url).url).searchParams.get('prompt'), 'login');
  assert.equal(await identity(), before, 'IDENTITY.md byte-identical');

  // Error cases: a cancelled sign-in leaves nothing behind; a non-subscription choice is refused with its cause.
  const cancelled = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
  cancelled.cancel();
  console.log('cancelled:', JSON.stringify(await cancelled.done));
  assert.ok(!(await roster()).includes(`m1--${cancelled.id.slice(7)}`));
  assert.ok(!(cancelled.id in index()));
  await assert.rejects(kit.addAccount('m1', { authChoice: 'openai-api-key' }, () => {}), (error) => {
    console.log('refused:', `${error.constructor.name}: ${error.message}`);
    return /not a subscription sign-in/.test(error.message);
  });
  console.log('ADD-ACCOUNT OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
