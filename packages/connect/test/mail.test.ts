// Mail read/search/send journeys against a canned Gmail transport: no mailbox, network or credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MailReader, MailSender, MailError } from '../src/index.ts';
const HEADERS = [
  { name: 'Subject', value: '' }, { name: 'From', value: 'crew@example.test' },
  { name: 'To', value: 'umer@example.test' }, { name: 'Date', value: 'Tue, 06 Oct 2026 06:00:00 +0000' },
];
function meta(id: string, subject: string) {
  const headers = HEADERS.map(h => h.name === 'Subject' ? { ...h, value: subject } : h);
  return { id, threadId: `t-${id}`, snippet: `snippet ${id}`, labelIds: ['INBOX'],
    payload: { mimeType: 'multipart/mixed', headers } };
}
const BODY = 'Hello Umer, the invoice is attached. '.repeat(40);
const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const PAGE1 = { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }], nextPageToken: 'p2', resultSizeEstimate: 3 };
const PAGE2 = { messages: [{ id: 'm3', threadId: 't3' }] };
function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
/** Canned Gmail transport. `fault` replaces the answer for one leg of the journey. */
function transport(fault?: (url: URL) => Response | null) {
  const calls: string[] = [], auth: (string | null)[] = [];
  const serve: typeof globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === '/gmail/v1/users/me/messages') return json(url.searchParams.get('pageToken') === 'p2' ? PAGE2 : PAGE1);
    const id = url.pathname.split('/').pop()!;
    if (url.searchParams.get('format') !== 'full') return json(meta(id, `Subject ${id}`));
    const m = meta(id, `Subject ${id}`);
    return json({ ...m, payload: { ...m.payload, parts: [{ mimeType: 'text/plain', body: { data: b64url(BODY) } }] } });
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?${url.searchParams.toString()}`);
    auth.push(new Headers(init?.headers).get('authorization'));
    return fault?.(url) ?? serve(input, init);
  };
  return { fetch, calls, auth };
}
function credential(...tokens: string[]) {
  let n = 0;
  return { token: async () => tokens[Math.min(n++, tokens.length - 1)] };
}
const mailError = (code: string) => (e: unknown) => e instanceof MailError && e.code === code && !/t1|t2/.test(e.message);
test('search returns envelopes, then the next page follows the opaque token', async () => {
  const t = transport(), reader = new MailReader(credential('t1'), { fetch: t.fetch });
  const page = await reader.search('invoice');
  assert.deepEqual(page.messages.map(m => m.subject), ['Subject m1', 'Subject m2']);
  assert.equal(page.messages[0].from, 'crew@example.test');
  assert.equal(page.nextPageToken, 'p2');
  assert.equal(page.resultSizeEstimate, 3);
  assert.match(t.calls[0], /q=invoice/);
  assert.equal((await reader.list({ pageToken: page.nextPageToken })).messages.length, 1);
});
test('get decodes the bounded body and flags truncation', async () => {
  const t = transport(), reader = new MailReader(credential('t1'), { fetch: t.fetch });
  const message = await reader.get('m1');
  assert.equal(message.body.text, BODY);
  assert.equal(message.body.truncated, false);
  const capped = await new MailReader(credential('t1'), { fetch: t.fetch, maxBodyChars: 10 }).get('m1');
  assert.equal(capped.body.text, BODY.slice(0, 10));
  assert.equal(capped.body.truncated, true);
});
test('one 401 retries with a fresh token; a second 401 signs out without leaking it', async () => {
  let denials = 1;
  const t = transport(url => url.pathname === '/gmail/v1/users/me/messages' && denials-- > 0 ? json({}, 401) : null);
  assert.equal((await new MailReader(credential('t1', 't2'), { fetch: t.fetch }).list()).messages.length, 2);
  assert.deepEqual(t.auth, ['Bearer t1', 'Bearer t2', 'Bearer t2', 'Bearer t2']);
  const down = new MailReader(credential('t1'), { fetch: transport(url =>
    url.pathname === '/gmail/v1/users/me/messages' ? json({}, 401) : null).fetch });
  await assert.rejects(down.list(), mailError('signed-out'));
});
test('provider failures map to codes; bad calls reject before any fetch', async () => {
  const limited = new MailReader(credential('t1'), { now: () => 1_000_000,
    fetch: transport(() => json({ error: { code: 429 } }, 429, { 'retry-after': '2' })).fetch });
  await assert.rejects(limited.list(), (e: unknown) => e instanceof MailError && e.code === 'rate-limited' && e.until === 1_002_000);
  const down = new MailReader(credential('t1'), { fetch: transport(() => json({}, 500)).fetch });
  await assert.rejects(down.list(), (e: unknown) => e instanceof MailError && e.code === 'network' && e.status === 500);
  const shape = new MailReader(credential('t1'), { fetch: transport(url =>
    url.pathname.endsWith('/messages/m1') ? json({ nope: true }) : null).fetch });
  await assert.rejects(shape.get('m1'), mailError('invalid'));
  const quiet = new MailReader(credential('t1'), { fetch: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(quiet.search('  '), TypeError);
  await assert.rejects(quiet.get(''), TypeError);
  await assert.rejects(quiet.list({ maxResults: 0 }), RangeError);
  assert.throws(() => new MailReader({} as never), TypeError);
});
// Send journeys: the approval sees the frozen message, and nothing leaves without its `true`.
function outbox(answer: () => Response = () => json({ id: 's1', threadId: 'st1', labelIds: ['SENT'] })) {
  const posts: { url: string; auth: string | null; raw: string }[] = [];
  let tokens = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, 'POST');
    posts.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), raw: JSON.parse(String(init?.body)).raw });
    return answer();
  };
  return { fetch, posts, tokens: () => tokens, credential: { token: async () => `t${++tokens}` } };
}
const DRAFT = { to: ['crew@example.test', 'ops@example.test'], subject: 'Rechnung für Umer ✓', body: 'Hi crew,\nthe invoice is paid.' };
test('an approved send posts one encoded message and returns its ids', async () => {
  const o = outbox(), seen: unknown[] = [];
  const sender = new MailSender(o.credential, mail => { seen.push(mail); return true; }, { fetch: o.fetch });
  assert.deepEqual(await sender.send(DRAFT), { id: 's1', threadId: 'st1', labelIds: ['SENT'] });
  assert.equal(seen.length, 1);
  assert.ok(Object.isFrozen(seen[0]));
  assert.deepEqual(seen[0], DRAFT);
  assert.equal(o.posts.length, 1);
  assert.equal(o.posts[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(o.posts[0].auth, 'Bearer t1');
  const [head, body] = Buffer.from(o.posts[0].raw, 'base64url').toString('utf8').split('\r\n\r\n');
  assert.match(head, /^To: crew@example\.test, ops@example\.test\r\n/);
  const subject = [...head.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8')).join('');
  assert.equal(subject, DRAFT.subject);
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Hi crew,\r\nthe invoice is paid.');
  await sender.send({ ...DRAFT, to: 'crew@example.test', subject: '=?UTF-8?B?UGF5IG5vdw==?=' });
  assert.equal(seen.length, 2, 'every message asks again');
  const literal = Buffer.from(o.posts[1].raw, 'base64url').toString('utf8').match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)!;
  assert.equal(Buffer.from(literal[1], 'base64').toString('utf8'), '=?UTF-8?B?UGF5IG5vdw==?=', 'what was approved is what a reader sees');
});
test('denial, a thrown approval and bad drafts leave no token call and no fetch', async () => {
  for (const approve of [() => false, () => 'yes' as never, async () => { throw new Error('closed'); }]) {
    const o = outbox();
    await assert.rejects(new MailSender(o.credential, approve, { fetch: o.fetch }).send(DRAFT), mailError('denied'));
    assert.equal(o.posts.length + o.tokens(), 0);
  }
  const o = outbox();
  let asked = 0;
  const sender = new MailSender(o.credential, () => { asked++; return true; }, { fetch: o.fetch });
  const forged = Object.assign(['ok@example.test'], { [Symbol.iterator]: function* () { yield 'ok@example.test\r\nBcc: spy@example.test'; } });
  for (const bad of [[DRAFT], { ...DRAFT, to: forged }, { ...DRAFT, to: [] }, { ...DRAFT, to: 'Umer <u@example.test>' }, { ...DRAFT, subject: 'x\r\nBcc: a@b.test' }, { ...DRAFT, body: 1 }])
    await assert.rejects(sender.send(bad as never), TypeError);
  assert.equal(asked + o.posts.length + o.tokens(), 0);
  assert.throws(() => new MailSender(o.credential, undefined as never), TypeError);
});
test('send failures keep their codes and are never retried past one fresh token', async () => {
  let n = 0;
  const once = outbox(() => n++ ? json({ id: 's2', threadId: 'st2' }) : json({}, 401));
  assert.equal((await new MailSender(once.credential, () => true, { fetch: once.fetch }).send(DRAFT)).id, 's2');
  assert.deepEqual(once.posts.map(p => p.auth), ['Bearer t1', 'Bearer t2']);
  for (const [answer, code] of [[() => json({}, 403), 'signed-out'], [() => json({}, 429, { 'retry-after': '1' }), 'rate-limited'],
    [() => json({}, 500), 'network'], [() => { throw new TypeError('offline'); }, 'network']] as const) {
    const o = outbox(answer);
    await assert.rejects(new MailSender(o.credential, () => true, { fetch: o.fetch }).send(DRAFT), mailError(code));
    assert.equal(o.posts.length, 1);
  }
});
