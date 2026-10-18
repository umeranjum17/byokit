import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createEmulator } from 'emulate';
import { connect, MailReader, type ConnectOptions } from '@byokit/connect';
import { type Keystore } from '@byokit/secrets/node';

function store(): Keystore {
  const values = new Map<string, string>();
  return { get: async k => values.get(k) ?? null, set: async (k, v) => { values.set(k, v); }, delete: async k => values.delete(k) };
}

test('test endpoints drive real Google emulate OAuth and Gmail plus a local GitHub device flow', async () => {
  const google = await createEmulator({ service: 'google', port: 0 });
  const github = createServer();
  const paths: string[] = [];
  github.on('request', async (req, res) => {
    paths.push(req.url ?? '');
    if (req.url === '/login/device/code') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ device_code: 'device', user_code: 'ABCD', verification_uri: 'http://localhost/activate', expires_in: 60, interval: 1 }));
    } else if (req.url === '/login/oauth/access_token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'github-token', token_type: 'bearer', scope: 'repo' }));
    } else if (req.url === '/user') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"login":"test"}');
    } else { res.writeHead(404); res.end(); }
  });
  github.listen(0, '127.0.0.1'); await once(github, 'listening');
  const githubBase = `http://127.0.0.1:${(github.address() as { port: number }).port}`;
  try {
    const options: ConnectOptions = {
      person: 'test', store: store(), redirectUri: 'http://127.0.0.1/callback',
      client: { id: 'test-client' }, endpoints: {
        google: { authorize: `${google.url}/o/oauth2/v2/auth`, token: `${google.url}/oauth2/token`, api: `${google.url}/gmail/v1` },
        github: { deviceCode: `${githubBase}/login/device/code`, token: `${githubBase}/login/oauth/access_token`, api: githubBase },
      },
    };
    const googleConnection = connect('google', options);
    assert.equal(googleConnection.apiBase, `${google.url}/gmail/v1`);
    const flow = await googleConnection.signIn();
    const page = await fetch(flow.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    const form = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
    assert.ok(form, 'emulate should provide its real user-selection form');
    const fields = [...form[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)];
    const body = new URLSearchParams(fields.map(([, k, v]) => [k, v]));
    const selected = await fetch(new URL(form[1], google.url), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
    const callback = new URL(selected.headers.get('location')!);
    await flow.finish(callback);
    const access = await googleConnection.token();
    assert.ok(access);
    const inbox = await new MailReader(googleConnection, { endpoints: options.endpoints }).list();
    assert.ok(Array.isArray(inbox.messages));

    const githubConnection = connect('github', options);
    const device = await githubConnection.deviceSignIn();
    assert.equal(device.userCode, 'ABCD');
    await device.finish();
    assert.equal(await githubConnection.token(), 'github-token');
    assert.deepEqual(paths, ['/login/device/code', '/login/oauth/access_token']);
    assert.equal(githubConnection.apiBase, githubBase);
    const api = await fetch(new URL('/user', githubConnection.apiBase));
    assert.equal((await api.json()).login, 'test');
  } finally {
    await google.close();
    github.close();
  }
});
