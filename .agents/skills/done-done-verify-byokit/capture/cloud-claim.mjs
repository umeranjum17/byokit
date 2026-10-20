#!/usr/bin/env node
// Live Boat claim proof driver (features/cloud-claim.md): runs the built @byokit/cloud claim()
// (https://boat.dev/auth.md steps 1-5), then one read-only GET /me with the claimed key, then ALWAYS
// revokes the key with the kit's revokeClaim() (finally: success, failure, Ctrl-C, deadline;
// also a key seen on the wire that claim() did not hand over) and proves the revoke with a
// second GET /me that must be refused. No billing, no sandbox route: a wire allowlist refuses
// anything else before it leaves the process.
//
// The key, claim token and assertion live in memory only. Every line written to stdout or the
// evidence log passes a leak guard that throws if one of them appears. The sign-in handoff
// (link, then code) goes to HANDOFF_FILE (mode 0600) when set, else to stdout; stdout carries
// one masked line per step; the evidence log carries the same steps plus every wire call
// (method, masked URL, status, safe fields, ms).
//
//   CLAIM_EMAIL=person@example.com  EVIDENCE_DIR=<outside the repo>  node cloud-claim.mjs
// Optional: HANDOFF_FILE, BOAT_BASE_URL (default https://boat.dev/api/v1), CLAIM_DEADLINE_S
// (default 600). Exit 0 = PASS, 1 = FAIL, 2 = bad setup.
import { createHash } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fp = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const maskEmail = (e) => e.replace(/^(.).*?(@.*)$/, '$1***$2');
// Fields that are safe to record from sign-in and API answers; everything else stays out.
const SAFE = ['error', 'type', 'token_type', 'expires_in', 'interval', 'scope', 'ok'];

export async function drive(o) {
  const { claim, revokeClaim, baseUrl, email, signal, logFile } = o;
  const baseFetch = o.fetch ?? globalThis.fetch;
  const out = o.out ?? ((l) => process.stdout.write(`${l}\n`));
  const handoff = o.handoff ?? out;
  const t0 = Date.now();
  const secrets = new Set();
  const lines = [];
  const emit = (line, { log = true, print = true } = {}) => {
    for (const s of secrets) if (s && line.includes(s)) throw new Error('leak guard: a secret reached an output line');
    const stamped = `${new Date().toISOString()} +${String(Date.now() - t0).padStart(6)}ms ${line}`;
    if (print) out(stamped);
    if (log && logFile) appendFileSync(logFile, `${stamped}\n`, { mode: 0o600 });
    lines.push(stamped);
  };
  const origin = new URL(baseUrl).origin;
  const api = baseUrl.replace(/\/$/, '');
  const ep = { meta: `${origin}/api/boat/.well-known/oauth-authorization-server` };
  const maskUrl = (u) => {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) x.searchParams.set(k, '***');
    return `${x.origin}${x.pathname}${x.search}`;
  };
  const allowed = (method, url) => {
    const bare = url.split('?')[0];
    return (method === 'GET' && bare === ep.meta) || (method === 'POST' && bare === ep.identity) ||
      (method === 'POST' && bare === ep.token) || (method === 'POST' && bare === ep.revoke) ||
      (method === 'GET' && bare === `${api}/me`);
  };
  const polls = { n: 0 };
  // A key the token endpoint issued, even if claim() then failed closed and kept it.
  const issued = { key: null };
  // The one fetch claim() and this driver use: allowlist, secret capture, masked wire log.
  const wire = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    if (!allowed(method, url)) {
      emit(`wire  REFUSED ${method} ${maskUrl(url)} (not on the claim allowlist)`);
      throw new Error('refused by the claim allowlist');
    }
    if (method === 'POST' && url === ep.token) polls.n++;
    const started = Date.now();
    const res = await baseFetch(url, init);
    const text = await res.clone().text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (json && typeof json === 'object') {
      for (const k of ['access_token', 'claim_token', 'identity_assertion', 'refresh_token']) {
        if (typeof json[k] === 'string') secrets.add(json[k]);
      }
      if (url === ep.token && typeof json.access_token === 'string') issued.key = json.access_token;
      if (url === ep.meta) {
        ep.identity = json.agent_auth?.identity_endpoint;
        ep.token = json.token_endpoint;
        ep.revoke = json.revocation_endpoint;
      }
    }
    const safe = json && typeof json === 'object'
      ? SAFE.filter((k) => k in json).map((k) => `${k}=${JSON.stringify(json[k])}`).join(' ') : '';
    emit(`wire  ${method} ${maskUrl(url)} -> ${res.status} ${safe} (${Date.now() - started}ms)`, { print: false });
    return res;
  };
  const me = async (key, label) => {
    const res = await wire(`${api}/me`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => null);
    const id = body?.user?.id;
    emit(`check ${label}: GET /me -> ${res.status}${typeof id === 'string' ? ` account fp=${fp(id)}` : ''}`);
    return res.status;
  };

  let key = null;
  let result = { pass: false, why: 'not started' };
  emit(`start claim email=${maskEmail(email)} provider=${origin} (steps 1-5 only, no billing)`);
  try {
    for await (const s of claim({ baseUrl, email, fetch: wire, signal })) {
      if (s.step === 'open-page') {
        emit(`step  1-2 discover+register ok; 3 sign-in link ready`);
        handoff(`HANDOFF open this link in the person's browser and sign in: ${s.url}`);
        emit(`step  3 link shown (logged masked: ${maskUrl(s.url)})`, { print: false });
      } else if (s.step === 'type-code') {
        handoff(`HANDOFF when the page asks, type this code: ${s.code}`);
        emit(`step  3 code shown (logged masked: ******)`, { print: false });
      } else if (s.step === 'waiting') {
        emit(`step  4 waiting for the person to finish on the provider's page`);
      } else if (s.step === 'done') {
        key = s.key;
        secrets.add(key);
        emit(`step  5 key received: prefix=${/^[A-Za-z]{1,8}_/.exec(key)?.[0] ?? '(none)'} len=${key.length} fp=${fp(key)} expires=${s.expires} scopes=${s.scopes.join(',')} polls=${polls.n}`);
      } else {
        emit(`step  failed why=${s.why} polls=${polls.n}`);
        result = { pass: false, why: `claim failed: ${s.why}` };
      }
    }
    if (key === null && result.why === 'not started') {
      result = { pass: false, why: signal?.aborted ? 'aborted before a key was issued' : 'claim ended without a key' };
      emit(`step  ended: ${result.why} (polls=${polls.n})`);
    }
    if (key !== null && signal?.aborted) {
      result = { pass: false, why: 'aborted after the key was issued' };
      emit(`step  aborted after the key arrived: skipping the key check, revoking now`);
    } else if (key !== null) {
      const st = await me(key, 'key works');
      result = st === 200 ? { pass: true, why: 'claimed key read GET /me' } : { pass: false, why: `GET /me answered ${st}` };
    }
  } catch (e) {
    result = { pass: false, why: `driver error: ${e instanceof Error ? e.message : 'unknown'}` };
    emit(`error ${result.why}`);
  } finally {
    if (key === null && issued.key !== null) {
      key = issued.key;
      secrets.add(key);
      emit(`revoke the provider issued key fp=${fp(key)} but claim() did not hand it over: revoking it`);
    }
    if (key === null) {
      emit(`revoke nothing to revoke: no key was issued to this run`);
    } else {
      let revoked = false;
      try {
        await revokeClaim({ baseUrl, key, fetch: wire, signal: AbortSignal.timeout(15_000) });
        emit(`revoke revokeClaim() resolved (RFC 7009 at revocation_endpoint)`);
        const after = await me(key, 'after revoke');
        revoked = after === 401 || after === 403;
      } catch (e) {
        emit(`revoke error: ${e?.code ?? 'error'}: ${e instanceof Error ? e.message : 'unknown'}`);
      }
      if (revoked) {
        emit(`revoke CONFIRMED: key fp=${fp(key)} is refused by the provider`);
      } else {
        emit(`revoke NOT CONFIRMED: delete key fp=${fp(key)} by hand in the provider's dashboard now`);
        result = { pass: false, why: `${result.why}; revoke not confirmed` };
      }
      key = null;
    }
    emit(`RESULT ${result.pass ? 'PASS' : 'FAIL'}: ${result.why} (total ${Date.now() - t0}ms)`);
  }
  return { ...result, polls: polls.n, lines };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const email = process.env.CLAIM_EMAIL;
  const dir = process.env.EVIDENCE_DIR;
  const handoffFile = process.env.HANDOFF_FILE;
  if (!email || !dir) {
    process.stderr.write('set CLAIM_EMAIL and EVIDENCE_DIR (a folder outside the repo)\n');
    process.exit(2);
  }
  const { claim, revokeClaim } = await import('@byokit/cloud');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logFile = join(dir, `claim-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const ctrl = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => ctrl.abort());
  const deadline = Number(process.env.CLAIM_DEADLINE_S ?? 600) * 1000;
  const r = await drive({
    claim, revokeClaim, email, logFile,
    handoff: handoffFile ? (l) => appendFileSync(handoffFile, `${l}\n`, { mode: 0o600 }) : undefined,
    baseUrl: process.env.BOAT_BASE_URL ?? 'https://boat.dev/api/v1',
    signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(deadline)]),
  });
  process.stdout.write(`evidence: ${logFile}\n`);
  process.exit(r.pass ? 0 : 1);
}
