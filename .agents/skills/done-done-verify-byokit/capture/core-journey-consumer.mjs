// The consumer app for the core journey: it links a ChatGPT account and asks a
// question, exactly as the @byokit/accounts README quickstart shows, plus the two
// refusals the quickstart leaves out.
//
// The drive copies this file into a fresh app directory and runs it there, so
// `import '@byokit/accounts'` resolves to the package installed in that app, never
// to the monorepo's workspace copy. The app checks that before it does anything.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Accounts, memoryStore, portable } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';

const appDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(appDir, 'node_modules', '@byokit', 'accounts');
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const entry = fileURLToPath(import.meta.resolve('@byokit/accounts'));
if (!existsSync(join(packageDir, 'dist', 'index.js'))) throw new Error('the installed package ships no built entry');
if (!entry.startsWith(packageDir + sep)) throw new Error(`the import resolved outside the installed package: ${entry}`);
console.log(`package: ${manifest.name}@${manifest.version}`);

// The stand-in provider: OpenAI's sign-in and its answers, on 127.0.0.1. No account,
// no key, no network beyond loopback.
const openai = await mockOpenAI();
const accounts = new Accounts(
  { authBase: openai.base, apiBase: openai.base, offer: ['chatgpt'], store: () => memoryStore() },
  portable,
);

// 1. The app links a ChatGPT account: it shows a device code the person types on the
// provider's page, and the sign-in finishes when the person approves it.
const shown = await accounts.login(1, 'chatgpt');
console.log(`sign-in: ${shown.state} ${shown.via} ${shown.code}`);
openai.approve(shown.code);
await accounts.finished(1, 'chatgpt');

// 2. The app reads the account's status in plain words.
console.log(`status: ${(await accounts.status(1, 'chatgpt')).words}`);

// 3. The app asks a question and shows the answer as it streams in.
let streamed = '';
const answer = await accounts.respond(1, {
  model: 'gpt-6-sol',
  instructions: 'Answer briefly.',
  input: 'Plan my day',
  onText: (piece) => { streamed += piece; },
});
console.log(`streamed: ${streamed}`);
console.log(`answer: ${answer}`);

// 4. A provider the app does not offer is refused, in plain words.
try {
  await accounts.login(1, 'grok');
  console.log('not offered: no error (wrong)');
} catch (error) {
  console.log(`not offered: ${error.constructor.name}: ${error.message}`);
}

// 5. Asking with no account linked is refused, in plain words.
const signedOut = new Accounts(
  { authBase: openai.base, apiBase: openai.base, offer: ['chatgpt'], store: () => memoryStore() },
  portable,
);
try {
  await signedOut.respond(1, { model: 'gpt-6-sol', instructions: 'Answer briefly.', input: 'Plan my day' });
  console.log('no account: no error (wrong)');
} catch (error) {
  console.log(`no account: ${error.constructor.name}: ${error.message}`);
}

await openai.close();
