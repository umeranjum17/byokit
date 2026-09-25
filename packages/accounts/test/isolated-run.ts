// Run by isolation.test.ts in a child process: the real Pi engine, a ChatGPT sign-in up to its code (the provider's
// endpoints mocked), a stored sign-in and its status, all in the app's own folder. Prints one JSON line.
import { join } from 'node:path';
import { isolate } from '../src/isolate.ts';

const app = process.env.APP_DIR!;
isolate(join(app, 'engine'));
const { Accounts, fileStore } = await import('../src/index.ts');

const asked: string[] = [];
globalThis.fetch = async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push(new URL(url).host + new URL(url).pathname);
  if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'dev-1', user_code: 'MOCK-12345', interval: '1' });
  if (url.endsWith('/deviceauth/token')) return new Response('', { status: 403 }); // the person hasn't typed it yet
  throw new Error(`no network in this test: ${url}`);
};

const store = (m: string | number) => fileStore(join(app, 'people', String(m), 'auth.json'));
const kit = new Accounts({ store });
const shown = await kit.login(1, 'chatgpt', { via: 'code' });
kit.cancel(1, 'chatgpt');
const cancelled = await kit.signedIn(1, 'chatgpt');
await store(1).modify('openai-codex', async () => ({ type: 'oauth', access: 'mock', refresh: 'mock', expires: Date.now() + 86_400_000, accountId: 'acct' }));
console.log(JSON.stringify({
  code: shown?.code, url: shown?.url, cancelled,
  ready: await kit.signedIn(1, 'chatgpt'),
  // The decoy's OPENROUTER_API_KEY was scrubbed, and ambient discovery is off anyway: not signed in.
  openrouter: await kit.signedIn(1, 'openrouter'),
  other: await kit.signedIn(2, 'chatgpt'),
  words: (await kit.status(1, 'chatgpt')).words,
  env: Object.keys(process.env).filter((k) => /^PI_|_API_KEY$|^GH_TOKEN$/.test(k)).sort(),
  asked,
}));
