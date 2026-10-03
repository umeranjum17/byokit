// Drives the real kit through the exact-match and mismatch matrix with a fixed clock, so the committed
// fixtures.json is actual owned output of this implementation (ids are minted at run time and kept out).
import { Approvals, authorizeApproval } from '../src/index.ts';

export type Scenario = Record<string, unknown>;

const T0 = 1_700_000_000_000; // fixed epoch ms; the scenario's "now"

const subject = { action: 'mail.send', button: 'Send reply to plumber', app: 'Mail', reason: 'Tenant confirmed the Thursday visit' };

/** Every case returns plain JSON; run with `node test/scenario.ts` to regenerate fixtures.json. */
export function runScenario(): Scenario {
  const out: Scenario = {};
  let ms = T0;
  const clock = () => ms;
  const approvals = new Approvals({ now: clock });

  const request = approvals.raise(subject);
  const approved = approvals.approve(request.id);
  if (!approved.ok) throw new Error('scenario broken: fresh raise refused');
  const grant = approved.grant;

  out.exactMatch = authorizeApproval(grant, request, { now: clock });
  out.grantBindsSubjectAndDeadline = {
    subject: grant.subject, requestIdEqualsRequest: grant.requestId === request.id,
    approvedAt: grant.approvedAt, expires: grant.expires, requestExpires: request.expires,
  };

  out.actionMismatch = authorizeApproval(
    grant, approvals.raise({ ...subject, action: 'mail.discard' }), { now: clock });
  out.buttonMismatch = authorizeApproval(
    grant, approvals.raise({ ...subject, button: 'Send reply now' }), { now: clock });
  out.appMismatch = authorizeApproval(
    grant, approvals.raise({ ...subject, app: 'Calendar' }), { now: clock });
  out.reasonMismatch = authorizeApproval(
    grant, approvals.raise({ ...subject, reason: 'Tenant cancelled; send anyway' }), { now: clock });

  const reraised = approvals.raise(subject); // identical words, fresh identity
  out.staleIdentityAfterReraise = authorizeApproval(grant, reraised, { now: clock });
  out.staleIdentityOtherRaise = authorizeApproval(
    grant, { ...request, id: 'other-raise-id' }, { now: clock });
  out.currencyCheckForRaisingApp = { currentIsNotApprovedRaise: approvals.request('mail.send')!.id !== grant.requestId };
  out.approveSuperseded = approvals.approve(request.id);
  const fresh = approvals.raise({ ...subject, reason: 'Rewritten draft needs a new approval' });
  out.approveUnknownId = approvals.approve('never-raised');
  const current = approvals.approve(fresh.id);
  out.approveCurrent = current.ok
    ? { code: 'ok', requestIdEqualsCurrentRaise: current.grant.requestId === fresh.id, subject: current.grant.subject,
        approvedAt: current.grant.approvedAt, expires: current.grant.expires }
    : current;

  ms = T0 + 11 * 60_000;
  const late = approvals.raise({ ...subject, reason: 'Late draft' });
  ms = T0 + 22 * 60_000; // now is past that request's own 10-minute deadline
  out.approveExpired = approvals.approve(late.id);
  ms = T0; // back on time: build a pair, then authorize it late
  const deadline = approvals.raise({ ...subject, reason: 'Deadline draft' });
  const deadlineGrant = approvals.approve(deadline.id);
  if (!deadlineGrant.ok) throw new Error('scenario broken: deadline raise refused');
  out.authorizeExpired = authorizeApproval(deadlineGrant.grant, deadline, { now: () => T0 + 10 * 60_001 });
  out.authorizeForgedExtendedDeadline = authorizeApproval(
    deadlineGrant.grant, { ...deadline, expires: T0 + 60 * 60_000 }, { now: () => T0 + 10 * 60_001 });

  let frozenThrew = false;
  try { request.subject.reason = 'mutated in place'; } catch { frozenThrew = true; }
  out.raisedRequestIsFrozen = frozenThrew && request.subject.reason === subject.reason;

  return out;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(runScenario(), null, 2));
}
