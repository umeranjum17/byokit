// K-CLAIM: link a provider account without pasting a key (docs/cloud-kit.md 11.5).
// claim() drives Boat's documented agent sign-in (https://boat.dev/auth.md steps 1-5)
// against the loopback fake's sign-in routes; no live provider, no real waits. A wrong
// email is refused, an expired code ends expired with plain words, an abort ends the
// iterator with no step, and the key appears in `done` only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim, words } from '@byokit/cloud';
import type { ClaimStep } from '@byokit/cloud';
import { startFakeSandboxServer } from '@byokit/cloud/testing';

const email = 'umer@example.com';

const collect = async (it: AsyncIterable<ClaimStep>): Promise<ClaimStep[]> => {
  const steps: ClaimStep[] = [];
  for await (const s of it) steps.push(s);
  return steps;
};

const polls = (requests: { method: string; path: string }[]): number =>
  requests.filter((r) => r.method === 'POST' && r.path === '/api/boat/oauth2/token').length;

test('claim shows the link, the code, waits, then finishes with the key alone in done', async () => {
  const server = await startFakeSandboxServer();
  try {
    const steps = await collect(claim({ baseUrl: server.url, email }));
    assert.deepEqual(steps.map((s) => s.step), ['open-page', 'type-code', 'waiting', 'done']);
    assert.equal(steps[0].step === 'open-page' ? steps[0].url : '', `${new URL(server.url).origin}/api/boat/agent/identity/claim?claim_attempt_token=att-test-1`);
    assert.deepEqual(steps[1], { step: 'type-code', url: steps[0].step === 'open-page' ? steps[0].url : '', code: '123456' });
    const done = steps[3];
    assert.ok(done.step === 'done');
    assert.equal(done.step === 'done' ? done.key : '', 'boat-claimed-key');
    assert.ok(done.step === 'done' && !Number.isNaN(Date.parse(done.expires ?? '')));
    assert.deepEqual(done.step === 'done' ? done.scopes : [], ['box.me', 'box.limits', 'box.write', 'box.billing']);
    assert.ok(!JSON.stringify(steps.slice(0, 3)).includes('boat-claimed-key'));
  } finally { await server.close(); }
});

test('a pending poll waits its interval and then finishes', async () => {
  const server = await startFakeSandboxServer();
  try {
    server.scriptClaimPoll(['pending']);
    const steps = await collect(claim({ baseUrl: server.url, email }));
    assert.deepEqual(steps.map((s) => s.step), ['open-page', 'type-code', 'waiting', 'done']);
    assert.equal(polls(server.requests), 2);
  } finally { await server.close(); }
});

test('an assertion-only poll is exchanged once for the key', async () => {
  const server = await startFakeSandboxServer();
  try {
    server.scriptClaimPoll(['assertion']);
    const steps = await collect(claim({ baseUrl: server.url, email }));
    assert.deepEqual(steps.map((s) => s.step), ['open-page', 'type-code', 'waiting', 'done']);
    assert.equal(steps[3].step === 'done' ? steps[3].key : '', 'boat-claimed-key');
    assert.equal(polls(server.requests), 2);
  } finally { await server.close(); }
});

test('an expired code ends expired with plain words and no key', async () => {
  const server = await startFakeSandboxServer();
  try {
    server.scriptClaimPoll(['expired_token']);
    const steps = await collect(claim({ baseUrl: server.url, email }));
    assert.deepEqual(steps.map((s) => s.step), ['open-page', 'type-code', 'waiting', 'failed']);
    assert.deepEqual(steps[3], { step: 'failed', why: 'expired' });
    assert.equal(words('claim.expired', { label: 'Boat' }), 'That sign-in expired. Try again.');
    assert.ok(!JSON.stringify(steps).includes('boat-claimed-key'));
  } finally { await server.close(); }
});

test('a wrong email is refused before any ceremony with plain words', async () => {
  const server = await startFakeSandboxServer();
  try {
    const steps = await collect(claim({ baseUrl: server.url, email: 'someone-else@example.com' }));
    assert.deepEqual(steps, [{ step: 'failed', why: 'refused' }]);
    assert.equal(words('claim.refused', { label: 'Boat' }), "Boat didn't accept that address. Check it and try again.");
  } finally { await server.close(); }
});

test('an unreachable provider ends unreachable', async () => {
  const steps = await collect(claim({ baseUrl: 'http://127.0.0.1:1/api/v1', email }));
  assert.deepEqual(steps, [{ step: 'failed', why: 'unreachable' }]);
});

test('an abort during a slowed poll ends the iterator with no step', async () => {
  const server = await startFakeSandboxServer();
  try {
    server.scriptClaimPoll(['slow_down', 'success']);
    const controller = new AbortController();
    const iter = claim({ baseUrl: server.url, email, signal: controller.signal })[Symbol.asyncIterator]();
    assert.equal((await iter.next()).value?.step, 'open-page');
    assert.equal((await iter.next()).value?.step, 'type-code');
    assert.equal((await iter.next()).value?.step, 'waiting');
    const fourth = iter.next();
    for (let i = 0; i < 100 && polls(server.requests) === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(polls(server.requests), 1);
    controller.abort();
    assert.equal((await fourth).done, true);
    assert.equal(polls(server.requests), 1);
  } finally { await server.close(); }
});
