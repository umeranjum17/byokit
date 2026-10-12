import type { ProvisionBinding } from './relay.ts';
import type { HostRecord } from './relay.ts';

export type OwnerHost = HostRecord & { online: boolean; devices: number };
export type OwnerEnrolment = { token: string; expires: number };
export type RelayOwnerErrorCode = 'forbidden' | 'not-found' | 'request-failed';

/** An HTTP refusal from the relay. Network failures still reject with the fetch error. */
export class RelayOwnerError extends Error {
  readonly status: number;
  readonly code: RelayOwnerErrorCode;

  constructor(status: number) {
    super(status === 403 ? 'Only the relay owner can do that.' : status === 404 ? 'That relay address was not found.' : "Couldn't reach the relay. Try again.");
    this.name = 'RelayOwnerError';
    this.status = status;
    this.code = status === 403 ? 'forbidden' : status === 404 ? 'not-found' : 'request-failed';
  }
}

export type OwnerClient = {
  /** Every host, or only the ones a provisioning token bound to `account`. */
  hosts(o?: { account?: string }): Promise<OwnerHost[]>;
  enrolment(o?: { name?: string; ttlMs?: number; meta?: unknown; provision?: ProvisionBinding }): Promise<OwnerEnrolment>;
  /** True if the host was removed; false if it was already absent. */
  revoke(hostId: string): Promise<boolean>;
  /** True if a waiting enrolment was withdrawn; false if it was already used or gone. */
  revokeEnrolment(enrolmentId: string): Promise<boolean>;
};

/** The owner's HTTP API on a relay the app runs. Keep its bearer token on the owner's side. */
export function ownerClient(url: string, token: string, o: { fetch?: typeof fetch } = {}): OwnerClient {
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Use an HTTP or HTTPS relay address without credentials.');
  const request = async (path: string, method: string, body?: unknown) => {
    const res = await (o.fetch ?? fetch)(new URL(`/relay/v1/${path}`, base), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
    });
    if (!res.ok) throw new RelayOwnerError(res.status);
    return res.json();
  };
  return {
    async hosts(o = {}) { return (await request(o.account === undefined ? 'hosts' : `hosts?account=${encodeURIComponent(o.account)}`, 'GET') as { hosts: OwnerHost[] }).hosts; },
    async enrolment(opts = {}) { return await request('enrolments', 'POST', opts) as OwnerEnrolment; },
    async revoke(id) { return (await request(`hosts/${encodeURIComponent(id)}`, 'DELETE') as { removed: boolean }).removed; },
    async revokeEnrolment(id) { return (await request(`enrolments/${encodeURIComponent(id)}`, 'DELETE') as { removed: boolean }).removed; },
  };
}
