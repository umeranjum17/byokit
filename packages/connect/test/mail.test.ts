// Mail read/search journeys against a canned Gmail transport: no mailbox, network or credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MailReader, MailError } from '../src/index.ts';
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
