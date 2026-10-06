// Owner-bound history/export journeys: a signed Connection is the credential,
// Gmail answers come from a canned transport. No mailbox, network or secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, MailHistory, HistoryError, type Provider } from '../src/index.ts';
import type { Keystore } from '@byokit/secrets';
function memory(): Keystore {
  const values = new Map<string, string>();
  return { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => values.delete(key) };
}
const app: Provider = { id: 'gmail', name: 'Gmail', oauth: { authorize: 'https://app.test/authorize', token: 'https://app.test/token' }, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] };
async function signed() {
  const oauth: typeof fetch = async () => new Response(JSON.stringify(
    { access_token: 'access-canary', token_type: 'Bearer', expires_in: 3600, scope: app.scopes![0] }), { status: 200 });
  const store = memory();
  const connection = connect(app, { store, person: 'Umer', client: { id: 'client' }, redirectUri: 'https://device.test/callback', fetch: oauth });
  const flow = await connection.signIn();
  const back = new URL('https://device.test/callback');
  back.searchParams.set('state', new URL(flow.url).searchParams.get('state')!);
  back.searchParams.set('code', 'code-canary');
  await flow.finish(back);
  return connection;
}
const HEADERS = (subject: string) => [
  { name: 'Subject', value: subject }, { name: 'From', value: 'crew@example.test' },
  { name: 'To', value: 'umer@example.test' }, { name: 'Date', value: 'Tue, 06 Oct 2026 06:00:00 +0000' },
];
const meta = (id: string) => ({ id, threadId: `t-${id}`, snippet: `snippet ${id}`, labelIds: ['INBOX'],
  payload: { mimeType: 'multipart/mixed', headers: HEADERS(`Subject ${id}`) } });
function gmail() {
  const calls: string[] = [], auth: (string | null)[] = [];
  const pages: Record<string, unknown> = {
    '': { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }], nextPageToken: 'p2', resultSizeEstimate: 3 },
    p2: { messages: [{ id: 'm3', threadId: 't3' }] },
  };
  const serve: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname); auth.push(new Headers(init?.headers).get('authorization'));
    if (url.pathname === '/gmail/v1/users/me/messages') return Response.json(pages[url.searchParams.get('pageToken') ?? ''] ?? { messages: [] });
    return Response.json(meta(url.pathname.split('/').pop()!));
  };
  return { fetch: serve, calls, auth };
}
const denied = (e: unknown) => e instanceof HistoryError && e.code === 'denied' && !/canary/.test(e.message);
test('the owner reads across pages and exports json/csv on the signed grant', async () => {
  const connection = await signed(), t = gmail();
  const history = new MailHistory(connection, { owner: 'Umer', fetch: t.fetch });
  const rows = await history.messages({ principal: 'Umer', query: 'invoice' });
  assert.deepEqual(rows.map(m => m.subject), ['Subject m1', 'Subject m2', 'Subject m3']);
  assert.ok(t.auth.every(h => h === 'Bearer access-canary'));
  const back = JSON.parse(await history.export({ principal: 'Umer', query: 'invoice', format: 'json' }));
  assert.deepEqual(back.map((m: { id: string }) => m.id), ['m1', 'm2', 'm3']);
  const csv = await history.export({ principal: 'Umer', query: 'invoice', format: 'csv' });
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'id,threadId,subject,from,to,date,snippet,labelIds');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^m1,t-m1,Subject m1,crew@example\.test,umer@example\.test,/);
  const capped = await history.messages({ principal: 'Umer', maxMessages: 2, pageSize: 2 });
  assert.deepEqual(capped.map(m => m.id), ['m1', 'm2']);
});
test('a foreign principal is denied before any provider fetch; bad calls reject early', async () => {
  const connection = await signed(), t = gmail();
  const history = new MailHistory(connection, { owner: 'Umer', fetch: t.fetch });
  const before = t.calls.length;
  await assert.rejects(history.messages({ principal: 'crew' }), denied);
  await assert.rejects(history.export({ principal: 'crew', format: 'json' }), denied);
  assert.equal(t.calls.length, before);
  await assert.rejects(history.messages({ principal: '' }), TypeError);
  await assert.rejects(history.messages({ principal: 'Umer', maxMessages: 0 }), RangeError);
  await assert.rejects(history.messages({ principal: 'Umer', query: '  ' }), TypeError);
  await assert.rejects(history.export({ principal: 'Umer', format: 'mbox' as never }), TypeError);
  assert.throws(() => new MailHistory(connection, { owner: '  ' }), TypeError);
  assert.throws(() => new MailHistory({} as never, { owner: 'Umer' }), TypeError);
});
