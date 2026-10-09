// Consumer journeys for the published @byokit/approve surface, driven the way a host app uses it: `raise` names what
// the person will see, `approve` mints a grant when they press that button, and `authorizeApproval(grant, request)` is
// the pure exact-match check the host runs at the moment of acting. Every import is a published entry
// (`@byokit/approve`): no src, no internals. The security and correctness contracts the old unit and fixture cases held
// survive as assertions inside a journey: a grant binds to exactly the one request naming its action, button, app and
// reason; any other or mutated request, a later raise of the same words, and a past deadline are refused with the typed
// code; a superseded or unknown press settles nothing; garbage-carrying inputs are refused, never authorized or crashed
// on; bad subjects throw the built-in TypeError; outputs are frozen; and the entry stays portable, bundling for browsers
// and React Native and running where there is no Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { Approvals, authorizeApproval, type ApprovalGrant, type ApprovalRequest } from '@byokit/approve';

const subject = { action: 'mail.send', button: 'Send reply to plumber', app: 'Mail', reason: 'Tenant confirmed the Thursday visit' };
const clock = (ms: number) => () => ms;
const T0 = 1_700_000_000_000;

const grantFor = (approvals: Approvals, id: string) => {
  const outcome = approvals.approve(id);
  if (!outcome.ok) throw new Error(`journey broken: approve refused ${outcome.code}`);
  return outcome.grant;
};

test('a person approves the request they saw, and the app acts on exactly it', () => {
  const approvals = new Approvals({ now: clock(T0), ttlMs: 5 * 60_000 });
  const request = approvals.raise(subject);
  assert.match(request.id, /^[A-Za-z0-9_-]{16,}$/, 'a url-safe, unguessable id');
  const grant = grantFor(approvals, request.id);
  assert.equal(grant.requestId, request.id, 'the grant names the request that was pressed');
  assert.deepEqual(grant.subject, subject, 'the grant carries the exact subject shown');
  assert.equal(grant.approvedAt, T0);
  assert.equal(grant.expires, request.expires, 'the grant copies the request deadline');
  assert.deepEqual(authorizeApproval(grant, request, { now: clock(T0 + 60_000) }), { ok: true, subject });

  // Frozen: the host can hand these to a worker without anyone mutating them in place.
  assert.throws(() => { request.subject.reason = 'mutated'; }, TypeError);
  assert.throws(() => { grant.requestId = 'other'; }, TypeError);
});

test('an approval for one request never authorizes another wording or a different request', () => {
  const approvals = new Approvals({ now: clock(T0) });
  const request = approvals.raise(subject);
  const grant = grantFor(approvals, request.id);
  const mutated = (change: Partial<typeof subject>, id = request.id): ApprovalRequest =>
    ({ subject: { ...subject, ...change }, id, raisedAt: request.raisedAt, expires: request.expires });
  assert.deepEqual(authorizeApproval(grant, mutated({ action: 'mail.discard' }), { now: clock(T0) }),
    { ok: false, code: 'action' });
  assert.deepEqual(authorizeApproval(grant, mutated({ button: 'Send reply now' }), { now: clock(T0) }),
    { ok: false, code: 'button' });
  assert.deepEqual(authorizeApproval(grant, mutated({ app: 'Calendar' }), { now: clock(T0) }),
    { ok: false, code: 'app' });
  assert.deepEqual(authorizeApproval(grant, mutated({ reason: 'Tenant cancelled; send anyway' }), { now: clock(T0) }),
    { ok: false, code: 'reason' });
  // Identity, not wording, authorizes: the same words re-raised is a different request.
  const reraised = approvals.raise(subject);
  assert.deepEqual(authorizeApproval(grant, reraised, { now: clock(T0) }), { ok: false, code: 'stale-identity' });
  assert.deepEqual(authorizeApproval(grant, { ...request, id: 'another-raise' }, { now: clock(T0) }),
    { ok: false, code: 'stale-identity' });
  // A grant for one action never spends on another action's request.
  approvals.raise({ ...subject, action: 'mail.discard' });
  const other = grantFor(approvals, approvals.request('mail.discard')!.id);
  assert.deepEqual(authorizeApproval(other, approvals.request('mail.send')!, { now: clock(T0) }),
    { ok: false, code: 'action' });
});

test('the raising app keeps one request per action current; a superseded or unknown press settles nothing', () => {
  const approvals = new Approvals({ now: clock(T0) });
  const first = approvals.raise(subject);
  const second = approvals.raise(subject);
  assert.notEqual(first.id, second.id, 'every raise mints a fresh id');
  assert.equal(approvals.request('mail.send')?.id, second.id, 'the latest raise is the current one');
  assert.deepEqual(approvals.approve(first.id), { ok: false, code: 'superseded-request' });
  assert.deepEqual(approvals.approve('never-raised'), { ok: false, code: 'unknown-request' });

  // Raising a different action leaves this one alone: the host can hold several current requests at once.
  const mail = approvals.raise({ ...subject, reason: 'first' });
  approvals.raise({ ...subject, action: 'mail.discard' });
  assert.equal(approvals.request('mail.send')?.id, mail.id);

  // The currency check a raising app runs before acting on a grant it still holds.
  const fresh = approvals.raise({ ...subject, reason: 'Rewritten draft needs a new approval' });
  const grant = grantFor(approvals, fresh.id);
  assert.equal(approvals.request('mail.send')!.id, grant.requestId);
});

test('the deadline is enforced on the request and the grant alike, even against a forged later deadline', () => {
  let ms = T0;
  const approvals = new Approvals({ now: () => ms, ttlMs: 10 * 60_000 });
  const request = approvals.raise(subject);
  ms = T0 + 10 * 60_001;
  assert.deepEqual(approvals.approve(request.id), { ok: false, code: 'expired' }, 'a late press mints nothing');

  ms = T0; // back on time: build a pair, then authorize it late
  const onTime = approvals.raise({ ...subject, reason: 'Deadline draft' });
  const grant = grantFor(approvals, onTime.id);
  const late = T0 + 10 * 60_001;
  assert.deepEqual(authorizeApproval(grant, onTime, { now: clock(late) }), { ok: false, code: 'expired' });
  // Extending the request's own deadline cannot revive a grant: the grant's copied deadline is checked too.
  assert.deepEqual(authorizeApproval(grant, { ...onTime, expires: T0 + 60 * 60_000 }, { now: clock(late) }),
    { ok: false, code: 'expired' });
});

test('hostile or malformed data is refused, never authorized, never crashes on; bad subjects throw', () => {
  const approvals = new Approvals({ now: clock(T0) });
  const request = approvals.raise(subject);
  const grant = grantFor(approvals, request.id);
  assert.deepEqual(authorizeApproval({ requestId: 42 } as unknown as ApprovalGrant, request, { now: clock(T0) }),
    { ok: false, code: 'action' });
  assert.deepEqual(authorizeApproval(grant, {} as ApprovalRequest, { now: clock(T0) }), { ok: false, code: 'action' });

  // A subject outside the documented caps is a programming mistake, not a runtime refusal.
  for (const bad of [{ ...subject, action: '' }, { ...subject, button: 'x'.repeat(81) },
    { ...subject, app: 7 as unknown as string }, { ...subject, reason: 'y'.repeat(281) }, undefined as never]) {
    assert.throws(() => approvals.raise(bad), TypeError);
  }
});

test('an app bundles the published entry for the browser and runs it where there is no Node', async () => {
  const bundle = await build({
    stdin: {
      contents: `import { Approvals, authorizeApproval } from '@byokit/approve';
        const approvals = new Approvals({ ttlMs: 60000, now: () => 1000 });
        const request = approvals.raise({ action: 'mail.send', button: 'Send', app: 'Mail', reason: 'Draft ready' });
        const outcome = approvals.approve(request.id);
        globalThis.result = outcome.ok
          ? authorizeApproval(outcome.grant, request, { now: () => 2000 })
          : { ok: false, code: outcome.code };`,
      resolveDir: import.meta.dirname, sourcefile: 'phone-approve.ts',
    },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'], write: false, metafile: true, logLevel: 'silent',
  });
  assert.deepEqual(Object.keys(bundle.metafile!.inputs).filter((f) => /node:/.test(f)), [], 'nothing from Node');
  const sandbox: any = { crypto, btoa }; // the only globals a Web Crypto platform provides
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  assert.equal(sandbox.result.ok, true, 'it raises, approves and authorizes with no Node');
  assert.deepEqual({ ...sandbox.result.subject }, { action: 'mail.send', button: 'Send', app: 'Mail', reason: 'Draft ready' });
});
