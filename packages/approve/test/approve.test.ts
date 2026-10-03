import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Approvals, authorizeApproval, type ApprovalGrant, type ApprovalRequest } from '../src/index.ts';

const subject = { action: 'mail.send', button: 'Send reply to plumber', app: 'Mail', reason: 'Tenant confirmed the Thursday visit' };
const clock = (ms: number) => () => ms;
const T0 = 1_700_000_000_000;

const grantFor = (approvals: Approvals, id: string) => {
  const outcome = approvals.approve(id);
  if (!outcome.ok) throw new Error(`test broken: approve refused ${outcome.code}`);
  return outcome.grant;
};

test('raise mints a fresh unguessable id per raise and supersedes the previous one', () => {
  const approvals = new Approvals({ now: clock(T0) });
  const first = approvals.raise(subject);
  const second = approvals.raise(subject);
  assert.match(first.id, /^[A-Za-z0-9_-]{16,}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(approvals.request('mail.send')?.id, second.id);
  assert.deepEqual(approvals.approve(first.id), { ok: false, code: 'superseded-request' });
});

test('a raise of one action never supersedes another action', () => {
  const approvals = new Approvals({ now: clock(T0) });
  const mail = approvals.raise(subject);
  approvals.raise({ ...subject, action: 'mail.discard' });
  assert.equal(approvals.request('mail.send')?.id, mail.id);
});

test('approve binds the grant to the current request, its subject and its deadline', () => {
  const approvals = new Approvals({ now: clock(T0), ttlMs: 5 * 60_000 });
  const request = approvals.raise(subject);
  const grant = grantFor(approvals, request.id);
  assert.equal(grant.requestId, request.id);
  assert.deepEqual(grant.subject, subject);
  assert.equal(grant.approvedAt, T0);
  assert.equal(grant.expires, request.expires);
});
test('approve refuses unknown ids, and past the deadline', () => {
  let ms = T0;
  const approvals = new Approvals({ now: () => ms });
  assert.deepEqual(approvals.approve('never-raised'), { ok: false, code: 'unknown-request' });
  const request = approvals.raise(subject);
  ms = T0 + 10 * 60_001;
  assert.deepEqual(approvals.approve(request.id), { ok: false, code: 'expired' });
});

test('authorizeApproval authorizes the exact approved request', () => {
  const approvals = new Approvals({ now: clock(T0) });
  const request = approvals.raise(subject);
  const grant = grantFor(approvals, request.id);
  assert.deepEqual(authorizeApproval(grant, request, { now: clock(T0 + 60_000) }), { ok: true, subject });
});

test('a mutated or different request is refused with the mismatch it carries', () => {
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
  // The same words re-raised are still a different request: identity, not wording, is what authorizes.
  const reraised = approvals.raise(subject);
  assert.deepEqual(authorizeApproval(grant, reraised, { now: clock(T0) }), { ok: false, code: 'stale-identity' });
  assert.deepEqual(authorizeApproval(grant, { ...request, id: 'another-raise' }, { now: clock(T0) }),
    { ok: false, code: 'stale-identity' });
});

test('a grant from one subject never authorizes a request of another action', () => {
  const approvals = new Approvals({ now: clock(T0) });
  approvals.raise(subject);
  approvals.raise({ ...subject, action: 'mail.discard' });
  const grant = grantFor(approvals, approvals.request('mail.discard')!.id);
  assert.deepEqual(authorizeApproval(grant, approvals.request('mail.send')!, { now: clock(T0) }),
    { ok: false, code: 'action' });
});

test('past the deadline the grant is refused even against a forged later request deadline', () => {
  const approvals = new Approvals({ now: clock(T0), ttlMs: 10 * 60_000 });
  const request = approvals.raise(subject);
  const outcome = approvals.approve(request.id);
  assert.ok(outcome.ok);
  const late = T0 + 10 * 60_001;
  assert.deepEqual(authorizeApproval(outcome.grant, request, { now: clock(late) }), { ok: false, code: 'expired' });
  assert.deepEqual(
    authorizeApproval(outcome.grant, { ...request, expires: T0 + 60 * 60_000 }, { now: clock(late) }),
    { ok: false, code: 'expired' });
});

test('garbage-carrying inputs are refused, never crash, and never authorize', () => {
  const approvals = new Approvals({ now: clock(T0) });
  const request = approvals.raise(subject);
  const grant = grantFor(approvals, request.id);
  const garbage = { requestId: 42 } as unknown as ApprovalGrant;
  assert.deepEqual(authorizeApproval(garbage, request, { now: clock(T0) }), { ok: false, code: 'action' });
  assert.deepEqual(authorizeApproval(grant, {} as ApprovalRequest, { now: clock(T0) }), { ok: false, code: 'action' });
});

test('raised requests and grants are frozen against in-place mutation', () => {
  const approvals = new Approvals({ now: clock(T0) });
  const request = approvals.raise(subject);
  assert.throws(() => { request.subject.reason = 'mutated'; }, TypeError);
  const grant = grantFor(approvals, request.id);
  assert.throws(() => { grant.requestId = 'other'; }, TypeError);
});

test('bad subjects are programming mistakes: built-in TypeError', () => {
  const approvals = new Approvals();
  for (const bad of [{ ...subject, action: '' }, { ...subject, button: 'x'.repeat(81) },
    { ...subject, app: 7 as unknown as string }, { ...subject, reason: 'y'.repeat(281) }, undefined as never]) {
    assert.throws(() => approvals.raise(bad), TypeError);
  }
});
