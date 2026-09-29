// BK-P1 (docs/capability-kits.md 4.6): the CLI's golden text, shapes and exit codes, driven through main()
// with the fake engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.ts';
import { ComposeError } from '../src/errors.ts';
import { fakeEngine } from '../src/testing/fake-engine.ts';
import type { Engine } from '../src/types.ts';

const ORIGINAL = 'Meet at 3pm on Friday, 40 seats.';
const A_DRAFT = `${ORIGINAL} ${'x'.repeat(179)}`;
const B_DRAFT = `Meet at 3pm on Friday, 50 seats. delve ${'x'.repeat(262)}`;
assert.equal(A_DRAFT.length, 212);
assert.equal(B_DRAFT.length, 301);

async function run(
  argv: string[],
  files: Record<string, string> = {},
  engine: Engine = fakeEngine({ version: '1.0.0' }),
): Promise<{ code: number; out: string; err: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(argv, {
    engine,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such test file: ${path}`);
      return text;
    },
  });
  return { code, out: stdout.join(''), err: stderr.join('') };
}

test('hello prints the protocol and version', async () => {
  assert.deepEqual(await run(['hello']), { code: 0, out: 'protocol: 1\nversion: 1.0.0\n', err: '' });
});

test('platforms prints the six-row TOON table', async () => {
  assert.deepEqual(await run(['platforms']), {
    code: 0,
    out: 'platforms[6]{id,label,kind,limit}:\n' +
      '  x,X,feed,280\n' +
      '  linkedin,LinkedIn,feed,3000\n' +
      '  reddit,Reddit,feed,10000\n' +
      '  slack,Slack,chat,40000\n' +
      '  whatsapp,WhatsApp,chat,65536\n' +
      '  gmail,Gmail,mail,none\n',
    err: '',
  });
});

test('voice parse prints the rules as one-line JSON', async () => {
  const { code, out, err } = await run(['voice', 'parse', 'profile.md'], {
    'profile.md': '## Never say\n- delve\n- "game changer"\n',
  });
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.equal(out, 'rules: {"never":["delve","game changer"],"noDashes":false,"statementEndings":false,"note":""}\nskipped: 0\n');
});

test('voice guide prints the line', async () => {
  const { code, out, err } = await run(['voice', 'guide', '--voice', '{"never":[],"noDashes":true,"statementEndings":false,"note":""}']);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.equal(out, 'line: No em dashes.\n');
});

test('brief prints the quoted reply slots', async () => {
  const { code, out, err } = await run(['brief', '--kind', 'reply', '--platform', 'x']);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.equal(out, 'lines[3]:\n' +
    '  "Agree and add one concrete detail."\n' +
    '  "Push back kindly, with one reason."\n' +
    '  "Ask one sharp question."\n');
});

test('check prints drafts, issues and the pass count', async () => {
  const files = { 'original.md': ORIGINAL, 'a.md': A_DRAFT, 'b.md': B_DRAFT };
  const { code, out, err } = await run(['check', '--platform', 'x', '--original', 'original.md', 'a.md', 'b.md'], files);
  assert.equal(code, 1, 'one draft fails');
  assert.equal(err, '');
  assert.equal(out, 'drafts[2]{file,fits,length,limit,verdict}:\n' +
    '  a.md,yes,212,280,Sounds natural\n' +
    '  b.md,no,301,280,A bit stock\n' +
    'issues[3]{file,kind,detail}:\n' +
    '  b.md,stock,delve\n' +
    '  b.md,added,50\n' +
    '  b.md,dropped,40\n' +
    'result: 1 of 2 drafts pass\n');
});

test('check passes clean with issues: none and exit 0', async () => {
  const files = { 'original.md': ORIGINAL, 'a.md': A_DRAFT };
  const { code, out, err } = await run(['check', '--platform', 'x', '--original', 'original.md', 'a.md'], files);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.equal(out, 'drafts[1]{file,fits,length,limit,verdict}:\n' +
    '  a.md,yes,212,280,Sounds natural\n' +
    'issues: none\n' +
    'result: 1 of 1 drafts pass\n');
});

test('split prints the quoted post count and rows', async () => {
  const text = Array(30).fill('All systems go now.').join(' ');
  const { code, out, err } = await run(['split', '--platform', 'x', 'long.md'], { 'long.md': text });
  assert.equal(code, 0);
  assert.equal(err, '');
  const [header, ...rows] = out.split('\n').filter((line, i, all) => i < all.length - 1);
  assert.match(header ?? '', /^posts\[\d+\]:$/);
  assert.ok((rows?.length ?? 0) >= 2);
  for (const row of rows ?? []) {
    assert.match(row, /^  ".+"$/);
    const post = JSON.parse(row.trim()) as string;
    assert.ok(post.length <= 280);
  }
  const posts = (rows ?? []).map((row) => JSON.parse(row.trim()) as string);
  assert.equal(posts.join(' '), text);
});

test('an unknown platform is a usage error naming the six ids', async () => {
  const { code, out, err } = await run(['brief', '--kind', 'reply', '--platform', 'nope']);
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.equal(err, 'error: unknown platform "nope". Pick one of: x, linkedin, reddit, slack, whatsapp, gmail\n' +
    "help: compose brief --kind reply|polish|post|thread --platform <id> [--voice '<rules json>']\n");
});

test('bad --voice JSON is a usage error', async () => {
  const { code, out, err } = await run(['brief', '--kind', 'reply', '--platform', 'x', '--voice', '{bad']);
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.ok(err.startsWith('error: --voice is not valid rules JSON\n'));
});

test('51 draft files are a usage error', async () => {
  const files: Record<string, string> = {};
  const names: string[] = [];
  for (let i = 0; i < 51; i += 1) {
    names.push(`d${i}.md`);
    files[`d${i}.md`] = 'hi';
  }
  const { code, out, err } = await run(['check', '--platform', 'x', ...names], files);
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.ok(err.startsWith('error: drafts must have 1–50 entries\n'), err);
});

test('an unknown command and no command are usage errors', async () => {
  assert.deepEqual((await run(['frobnicate'])).code, 2);
  assert.deepEqual((await run([])).code, 2);
});

test('a missing or stale engine exits 3 with its sentence', async () => {
  const stale = await run(['hello'], {}, fakeEngine({ protocol: 9, version: '1.0.0' }));
  assert.equal(stale.code, 3);
  assert.equal(stale.out, '');
  assert.equal(stale.err, 'error: This app needs an update to check drafts.\n');
  const missingEngine: Engine = { handle: async () => { throw new ComposeError('missing', 'gone'); } };
  const missing = await run(['hello'], {}, missingEngine);
  assert.equal(missing.code, 3);
  assert.equal(missing.err, "error: The writing checker isn't installed yet.\n");
});

test('any other engine failure exits 4 with the failed sentence', async () => {
  const engine = fakeEngine({ fail: { verb: 'platforms', code: 'boom', message: 'bang' } });
  const { code, out, err } = await run(['platforms'], {}, engine);
  assert.equal(code, 4);
  assert.equal(out, '');
  assert.equal(err, 'error: The writing checker stopped with a problem. Try again.\n');
});
