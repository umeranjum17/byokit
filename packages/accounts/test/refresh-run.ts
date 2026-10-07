// Run by signin.test.ts in a child process: one app process that wants a fresh access token for PROVIDER from the
// store at STORE, with the provider's token endpoint (OpenAI's or Claude's) stood in for at TOKEN_URL. Prints one JSON line.
import { sealing } from './sealing.ts';
import { Accounts, fileStore } from '../src/index.ts';

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url === 'https://auth.openai.com/oauth/token' || url === 'https://platform.claude.com/v1/oauth/token') return realFetch(process.env.TOKEN_URL!, init);
  throw new Error(`no network in this test: ${url}`);
}) as typeof fetch;

const kit = new Accounts<any, number>({ app: 'Crewhouse', store: () => fileStore(process.env.STORE!, sealing) });
const access = await (await kit.runtime(1)).getAuth(process.env.PROVIDER!).then((a: unknown) => ({ ok: !!a }), (e: Error) => ({ ok: false, error: e.name }));
kit.stop();
console.log(JSON.stringify(access));
