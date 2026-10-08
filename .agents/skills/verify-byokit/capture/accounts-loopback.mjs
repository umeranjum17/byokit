// Real app processes, pinned Node OAuth engine, loopback provider stand-ins; no real credentials.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = process.env.BYOKIT_ACCOUNTS_ENTRY ?? '@byokit/accounts';
const testing = process.env.BYOKIT_TESTING_ENTRY ?? '@byokit/accounts/testing';
if (process.argv[2] === 'child') {
  const { Accounts, memoryStore } = await import(entry);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith('https://auth.openai.com/')) throw new Error('Unexpected provider request');
    return realFetch(url.replace('https://auth.openai.com', process.env.PROVIDER_BASE), init);
  };
  const kit = new Accounts({ app: 'Umer', offer: ['chatgpt'], store: () => memoryStore(),
    callbackPort: Number(process.env.CALLBACK_PORT), signInMs: 8000, redirectMs: 7000 });
  process.on('message', async (message) => {
    if (message === 'start') {
      process.send({ type: 'started' });
      const view = await kit.login('Umer', 'chatgpt', { via: 'browser' });
      process.send({ type: 'view', view });
      await kit.finished('Umer', 'chatgpt');
      process.send({ type: 'end', view: kit.view('Umer', 'chatgpt'), plan: await kit.plan('Umer') });
    } else if (message === 'cancel') {
      kit.cancel('Umer', 'chatgpt');
      process.send({ type: 'cancelled' });
    }
  });
  process.send({ type: 'ready' });
} else {
  const { mockOpenAI } = await import(testing);
  const home = await mkdtemp(join(tmpdir(), 'byk-loopback-'));
  const reserve = createServer().listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const providers = [], children = [];
  const wait = (child, type) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, 12000);
    const handler = message => { if (message.type === type) { cleanup(); resolve(message); } };
    const exited = code => { cleanup(); reject(new Error(`Child exited ${code}`)); };
    const cleanup = () => { clearTimeout(timeout); child.off('message', handler); child.off('exit', exited); };
    child.on('message', handler); child.on('exit', exited);
  });
  const start = async email => {
    const provider = await mockOpenAI({ email }); providers.push(provider);
    const child = fork(fileURLToPath(import.meta.url), ['child'], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, TMPDIR: home,
        CALLBACK_PORT: String(port), PROVIDER_BASE: provider.base }, silent: true,
    });
    children.push(child);
    child.stderr.on('data', data => process.stderr.write(data));
    await wait(child, 'ready');
    child.provider = provider;
    return child;
  };
  const login = async child => {
    const started = wait(child, 'started'), view = wait(child, 'view');
    child.send('start'); await started;
    return { view };
  };
  const callback = async (child, view, wrong = false) => {
    assert.equal(view.state, 'waiting'); assert.equal(view.via, 'browser');
    // Obtain a genuine one-use exchange code from the stand-in, not a canned credential.
    const device = await (await fetch(`${child.provider.base}/api/accounts/deviceauth/usercode`, { method: 'POST' })).json();
    child.provider.approve(device.user_code);
    const state = wrong ? 'wrong-state' : new URL(view.url).searchParams.get('state');
    const result = await fetch(`http://127.0.0.1:${port}/auth/callback?${new URLSearchParams({ state, code: `ac_${device.user_code}` })}`);
    const page = await result.text();
    assert.equal(result.status, wrong ? 400 : 200);
    if (!wrong) assert.match(page, /You're signed in/);
    console.log(wrong ? 'wrong-state: HTTP 400; no flow completed' : 'callback: HTTP 200; signed-in page');
  };
  try {
    const first = await start('umer-first@example.com'), second = await start('umer-second@example.com');
    const a = await login(first), firstView = (await a.view).view;
    const b = await login(second);
    let early; b.view.then(message => { early = message; });
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(early, undefined, `second ceremony must wait, not fail: ${JSON.stringify(early)}`);
    await callback(first, firstView, true);
    const firstEnd = wait(first, 'end');
    await callback(first, firstView);
    assert.equal((await firstEnd).plan.email, 'umer-first@example.com');
    const secondView = (await b.view).view;
    // A delayed callback for the previous owner cannot sign in the new owner.
    const stale = await fetch(`http://127.0.0.1:${port}/auth/callback?code=stale&state=${new URL(firstView.url).searchParams.get('state')}`);
    assert.equal(stale.status, 400); await stale.text();
    console.log('previous-owner callback: HTTP 400');
    const secondEnd = wait(second, 'end'); await callback(second, secondView);
    assert.equal((await secondEnd).plan.email, 'umer-second@example.com');
    console.log('two processes: both correct member credentials, one ceremony each');
    // Cancellation of the owner releases its OS-held port to the queued process.
    const c = await login(first), held = (await c.view).view;
    const d = await login(second);
    const cancelled = wait(first, 'cancelled'); first.send('cancel'); await cancelled;
    const next = (await d.view).view;
    assert.notEqual(new URL(held.url).searchParams.get('state'), new URL(next.url).searchParams.get('state'));
    const end = wait(second, 'end'); await callback(second, next); await end;
    console.log('owner cancellation: queued app completes');
    // Cancellation while waiting never starts a provider ceremony later.
    const e = await login(first); await e.view;
    const f = await login(second);
    const cancelledWait = wait(second, 'cancelled'); second.send('cancel'); await cancelledWait;
    assert.equal((await f.view).view, null);
    const release = wait(first, 'cancelled'); first.send('cancel'); await release;
    console.log('queued cancellation: settles without provider URL');
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill(); await exited;
    }));
    await Promise.all(providers.map(provider => provider.close()));
    await rm(home, { recursive: true, force: true });
  }
}
