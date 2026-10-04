// Exact-action approval: an approval binds to one request naming the action, the exact button label the person
// pressed, the app that showed it and the reason. It authorizes that request and nothing else: any other or
// mutated request, a request from a later raise, or a past-deadline request is refused with a typed code.
//
// Portable by construction: no imports, no storage, no clock of its own (`now` is injectable), Web Crypto only.

/** Exactly what an approval names. Every field is compared exactly; the person saw `button` in `app` with `reason`. */
export type ApprovalSubject = {
  /** Stable action id the host will perform, e.g. `'mail.send'`. 1..64 chars. */
  action: string;
  /** The exact button label the person pressed, e.g. `'Send reply to plumber'`. 1..80 chars. */
  button: string;
  /** Identity of the app that showed the button, e.g. `'Mail'`. 1..60 chars. */
  app: string;
  /** Why the action should run, shown to the person. 1..280 chars. */
  reason: string;
};

/** One raised request. A re-raise of the same action is a new request with a fresh id; ids are unguessable. */
export type ApprovalRequest = {
  subject: ApprovalSubject;
  /** Kit-minted, url-safe, 128-bit. The only identity: an approval names exactly one id. */
  id: string;
  raisedAt: number; // epoch ms
  expires: number; // epoch ms; `approve` and `authorizeApproval` refuse past it
};

/** The person's approval of exactly one request. Plain JSON; carries its own deadline copied from the request. */
export type ApprovalGrant = {
  subject: ApprovalSubject;
  requestId: string; // the one request this grant authorizes
  approvedAt: number; // epoch ms
  expires: number; // copied from the approved request; checked alongside the request's own
};

/** Why an authorization refused, in the order `authorizeApproval` checks. */
export type ApprovalRefusal =
  | 'action' // the request's action differs from the approved one
  | 'button' // the button label differs: the person pressed different words
  | 'app' // the app identity differs: another app is spending this approval
  | 'reason' // the reason differs: what the person read is not what is running
  | 'stale-identity' // the grant names another raise's id: a different or superseded request
  | 'expired'; // past the request's (or grant's copied) deadline

/** Expected outcome of every authorization: what ran, or the first typed refusal. */
export type ApprovalAuthorization =
  | { ok: true; subject: ApprovalSubject }
  | { ok: false; code: ApprovalRefusal };

/** Expected outcome of pressing a button: the grant, or why that press settles nothing. */
export type ApproveOutcome =
  | { ok: true; grant: ApprovalGrant }
  | { ok: false; code: 'unknown-request' | 'superseded-request' | 'expired' };

export type ApprovalsOptions = {
  /** Request lifetime in ms. Default 10 minutes. */
  ttlMs?: number;
  /** The clock, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
};

const CAPS: Record<keyof ApprovalSubject, number> = { action: 64, button: 80, app: 60, reason: 280 };

/** Bad subjects are programming mistakes: built-in `TypeError`, per the kit conventions. */
function subjectOf(subject: ApprovalSubject): ApprovalSubject {
  if (typeof subject !== 'object' || subject === null) throw new TypeError('subject must be an object');
  for (const field of Object.keys(CAPS) as (keyof ApprovalSubject)[]) {
    const value = subject[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > CAPS[field])
      throw new TypeError(`subject.${field} must be a string of 1..${CAPS[field]} chars`);
  }
  return { action: subject.action, button: subject.button, app: subject.app, reason: subject.reason };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const mintId = (): string => base64url(crypto.getRandomValues(new Uint8Array(16)));

const frozen = <T extends object>(value: T): T => {
  Object.freeze(value);
  return value;
};

/** Does `grant` authorize exactly `request`, right now? Pure: same inputs, same answer; safe across a process. */
export function authorizeApproval(
  grant: ApprovalGrant,
  request: ApprovalRequest,
  o: { now?: () => number } = {},
): ApprovalAuthorization {
  const now = o.now?.() ?? Date.now();
  const subject = request.subject ?? ({} as ApprovalSubject);
  const approved = grant.subject ?? ({} as ApprovalSubject);
  if (subject.action !== approved.action) return { ok: false, code: 'action' };
  if (subject.button !== approved.button) return { ok: false, code: 'button' };
  if (subject.app !== approved.app) return { ok: false, code: 'app' };
  if (subject.reason !== approved.reason) return { ok: false, code: 'reason' };
  if (grant.requestId !== request.id) return { ok: false, code: 'stale-identity' };
  if (now > request.expires || now > grant.expires) return { ok: false, code: 'expired' };
  return { ok: true, subject };
}

/**
 * The host-side registry: raise a request, mint the grant when the person presses that request's button.
 * One current request per action; raising again supersedes it (the old id can never be approved again).
 * No I/O, no clock of its own; everything it returns is frozen, plain JSON.
 */
export class Approvals {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly current = new Map<string, ApprovalRequest>();
  private readonly superseded = new Set<string>();

  constructor(o: ApprovalsOptions = {}) {
    this.ttlMs = o.ttlMs ?? 10 * 60_000;
    this.now = o.now ?? Date.now;
  }

  /** Raises `subject` as the current request for its action, superseding any previous raise. */
  raise(subject: ApprovalSubject): ApprovalRequest {
    const checked = subjectOf(subject);
    const previous = this.current.get(checked.action);
    if (previous) this.superseded.add(previous.id);
    const at = this.now();
    const request: ApprovalRequest = { subject: frozen({ ...checked }), id: mintId(), raisedAt: at, expires: at + this.ttlMs };
    this.current.set(checked.action, frozen(request));
    return request;
  }

  /** The person pressed the button of request `requestId`. Settles nothing on refusal: show the current request. */
  approve(requestId: string): ApproveOutcome {
    for (const request of this.current.values()) {
      if (request.id !== requestId) continue;
      if (this.now() > request.expires) return { ok: false, code: 'expired' };
      const grant: ApprovalGrant = {
        subject: request.subject, requestId, approvedAt: this.now(), expires: request.expires,
      };
      return { ok: true, grant: frozen(grant) };
    }
    return { ok: false, code: this.superseded.has(requestId) ? 'superseded-request' : 'unknown-request' };
  }

  /** The current request for an action, if one was raised on this instance. */
  request(action: string): ApprovalRequest | undefined {
    return this.current.get(action);
  }
}
