// Consumer journey for the built `write` CLI: an operator runs the published bin and reads its TOON output,
// exit codes and plain `error:` lines. The deterministic cases drive the built `dist/cli.js` module with the
// kit's published fake engine (the CLI takes an engine seam for exactly this), and one case spawns the built
// bin end to end over the real pinned engine when it is installed. Every contract the old CLI cases held
// survives: exit 0 pass / 1 a draft fails / 2 usage / 3 engine missing or needs-update / 4 other engine
// failure, and every sentence on stderr is a plain one. No network, key or live model is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../dist/cli.js';
import { ComposeError, type Engine } from '@byokit/write';
import { fakeEngine } from '@byokit/write/testing';

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

test('an operator drafts from the command line: the built CLI prints drafts, issues and the pass count', async () => {
  assert.deepEqual(await run(['hello']), { code: 0, out: 'protocol: 1\nversion: 1.0.0\n', err: '' });
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

  const parsed = await run(['voice', 'parse', 'profile.md'], { 'profile.md': '## Never say\n- delve\n- "game changer"\n' });
  assert.equal(parsed.code, 0);
  assert.equal(parsed.err, '');
  assert.equal(parsed.out, 'rules: {"never":["delve","game changer"],"noDashes":false,"statementEndings":false,"note":""}\nskipped: 0\n');
  const guided = await run(['voice', 'guide', '--voice', '{"never":[],"noDashes":true,"statementEndings":false,"note":""}']);
  assert.deepEqual([guided.code, guided.out, guided.err], [0, 'line: No em dashes.\n', '']);
  const briefed = await run(['brief', '--kind', 'reply', '--platform', 'x']);
  assert.deepEqual([briefed.code, briefed.err], [0, '']);
  assert.equal(briefed.out, 'lines[3]:\n' +
    '  "Agree and add one concrete detail."\n' +
    '  "Push back kindly, with one reason."\n' +
    '  "Ask one sharp question."\n');

  // One failing draft exits 1 and names every break; a clean run exits 0 with `issues: none`.
  const failing = await run(['check', '--platform', 'x', '--original', 'original.md', 'a.md', 'b.md'],
    { 'original.md': ORIGINAL, 'a.md': A_DRAFT, 'b.md': B_DRAFT });
  assert.deepEqual([failing.code, failing.err], [1, '']);
  assert.equal(failing.out, 'drafts[2]{file,fits,length,limit,verdict}:\n' +
    '  a.md,yes,212,280,Sounds natural\n' +
    '  b.md,no,301,280,A bit stock\n' +
    'issues[3]{file,kind,detail}:\n' +
    '  b.md,stock,delve\n' +
    '  b.md,added,50\n' +
    '  b.md,dropped,40\n' +
    'result: 1 of 2 drafts pass\n');
  const clean = await run(['check', '--platform', 'x', '--original', 'original.md', 'a.md'],
    { 'original.md': ORIGINAL, 'a.md': A_DRAFT });
  assert.deepEqual([clean.code, clean.err], [0, '']);
  assert.equal(clean.out, 'drafts[1]{file,fits,length,limit,verdict}:\n' +
    '  a.md,yes,212,280,Sounds natural\n' +
    'issues: none\n' +
    'result: 1 of 1 drafts pass\n');

  const text = Array(30).fill('All systems go now.').join(' ');
  const split = await run(['split', '--platform', 'x', 'long.md'], { 'long.md': text });
  assert.deepEqual([split.code, split.err], [0, '']);
  const [header, ...rows] = split.out.split('\n').filter((line, i, all) => i < all.length - 1);
  assert.match(header ?? '', /^posts\[\d+\]:$/);
  assert.ok(rows.length >= 2);
  const posts = rows.map((row) => {
    assert.match(row, /^  ".+"$/);
    return JSON.parse(row.trim()) as string;
  });
  for (const post of posts) assert.ok(post.length <= 280);
  assert.equal(posts.join(' '), text);
});

test('an operator gets a plain usage line, never a stack, and the right exit code for every failure', async () => {
  const unknownPlatform = await run(['brief', '--kind', 'reply', '--platform', 'nope']);
  assert.deepEqual([unknownPlatform.code, unknownPlatform.out], [2, '']);
  assert.equal(unknownPlatform.err, 'error: unknown platform "nope". Pick one of: x, linkedin, reddit, slack, whatsapp, gmail\n' +
    "help: write brief --kind reply|polish|post|thread --platform <id> [--voice '<rules json>']\n");
  const badVoice = await run(['brief', '--kind', 'reply', '--platform', 'x', '--voice', '{bad']);
  assert.equal(badVoice.code, 2);
  assert.equal(badVoice.out, '');
  assert.ok(badVoice.err.startsWith('error: --voice is not valid rules JSON\n'));
  const files: Record<string, string> = {};
  const names: string[] = [];
  for (let i = 0; i < 51; i += 1) { names.push(`d${i}.md`); files[`d${i}.md`] = 'hi'; }
  const tooMany = await run(['check', '--platform', 'x', ...names], files);
  assert.deepEqual([tooMany.code, tooMany.out], [2, '']);
  assert.ok(tooMany.err.startsWith('error: drafts must have 1–50 entries\n'), tooMany.err);
  assert.deepEqual((await run(['frobnicate'])).code, 2);
  assert.deepEqual((await run([])).code, 2);

  // A missing or stale engine exits 3 with the plain sentence a person reads.
  const stale = await run(['hello'], {}, fakeEngine({ protocol: 9, version: '1.0.0' }));
  assert.deepEqual([stale.code, stale.out, stale.err], [3, '', 'error: This app needs an update to check drafts.\n']);
  const missingEngine: Engine = { handle: async () => { throw new ComposeError('missing', 'gone'); } };
  const missing = await run(['hello'], {}, missingEngine);
  assert.deepEqual([missing.code, missing.err], [3, "error: The writing checker isn't installed yet.\n"]);
  const broken = await run(['platforms'], {}, fakeEngine({ fail: { verb: 'platforms', code: 'boom', message: 'bang' } }));
  assert.deepEqual([broken.code, broken.out, broken.err], [4, '', 'error: The writing checker stopped with a problem. Try again.\n']);
});

test('the published write bin runs end to end over the real pinned engine', (t) => {
  try {
    import.meta.resolve('ownvoice-engine');
  } catch {
    t.skip('ownvoice-engine is not installed here; the engine CI job covers it');
    return;
  }
  const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [bin, 'platforms'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trimEnd().split('\n');
  assert.equal(lines[0], 'platforms[6]{id,label,kind,limit}:');
  assert.deepEqual(lines.slice(1).map((line) => line.trim().split(',')[0]), ['x', 'linkedin', 'reddit', 'slack', 'whatsapp', 'gmail']);
});
