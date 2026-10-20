// Bench check for cloud-claim.mjs (features/cloud-claim.md) against the loopback Boat fake
// (@byokit/cloud/testing startFakeSandboxServer). The fake serves the RFC 7009
// revocation_endpoint (revoke -> 200, then GET /me with that key -> 401), and the driver
// revokes through the kit's revokeClaim(). The CLI cases run the real entry point as a child
// process against the same fake. Exit 0 only when every case ends as expected with no leak.
//   node cloud-claim-bench.mjs   (SCRATCH: optional parent folder for the case logs)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claim, revokeClaim } from '@byokit/cloud';
import { startFakeSandboxServer } from '@byokit/cloud/testing';
import { drive } from './cloud-claim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const KEY = 'boat-claimed-key'; // the fake's claimed key; the fake also accepts it on /me
const say = (l) => process.stdout.write(`${l}\n`);
const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'claim-dry-'));

const bad = [];
const leakCheck = (text, label) => {
  const leaked = [KEY, 'clm-test-', 'assert-test', '123456', 'att-test-'].filter((s) => text.includes(s));
  if (leaked.length > 0) bad.push(`${label}: leaked`);
  say(`  leak check (${label}): ${leaked.length === 0 ? 'clean: no key, claim token, assertion, code or attempt token' : `LEAKED ${leaked.join(',')}`}`);
};

const inProcess = async (title, { script = [], interval = 0, email = 'umer@example.com', abortOn, expect }) => {
  say(`\n=== ${title} (in-process drive(), fake with its RFC 7009 revoke route) ===`);
  const server = await startFakeSandboxServer({ key: KEY, claimInterval: interval });
  server.scriptClaimPoll(script);
  const ctrl = new AbortController();
  const logFile = join(scratch, `${title.replace(/\W+/g, '-')}.log`);
  const r = await drive({
    claim, revokeClaim, email, logFile, baseUrl: server.url, signal: ctrl.signal,
    out: (l) => {
      say(`  stdout| ${l}`);
      if (abortOn && l.includes(abortOn)) { say(`  [harness] abort fired on "${abortOn}"`); ctrl.abort(); }
    },
  });
  const pollsAtEnd = server.requests.filter((q) => q.path === '/api/boat/oauth2/token').length;
  await new Promise((res) => setTimeout(res, 1500));
  const pollsLater = server.requests.filter((q) => q.path === '/api/boat/oauth2/token').length;
  say(`  token-endpoint calls at end=${pollsAtEnd}, 1.5 s later=${pollsLater} (${pollsAtEnd === pollsLater ? 'polling stopped' : 'STILL POLLING'})`);
  say(`  tokens the fake revoked: ${server.revoked.size} (${[...server.revoked].map((t) => (t === KEY ? 'the key' : 'the spare assertion')).join(', ') || 'none'})`);
  say(`  routes the fake saw: ${[...new Set(server.requests.map((q) => `${q.method} ${q.path.split('?')[0]}`))].join(' | ')}`);
  await server.close();
  const log = readFileSync(logFile, 'utf8');
  say(`  evidence log (${logFile.split('/').pop()}):`);
  for (const l of log.trimEnd().split('\n')) say(`  log| ${l}`);
  leakCheck(log + r.lines.join('\n').replace(/HANDOFF.*$/gm, ''), 'log + non-handoff stdout');
  say(`  -> pass=${r.pass} why="${r.why}"`);
  if (r.why !== expect) bad.push(`${title}: expected "${expect}"`);
};

const cli = async (title, { script = [], interval = 0, sigintOn, expect }) => {
  say(`\n=== ${title} (CLI child: node cloud-claim.mjs, fake with its revoke route) ===`);
  const server = await startFakeSandboxServer({ key: KEY, claimInterval: interval });
  server.scriptClaimPoll(script);
  const evidence = mkdtempSync(join(scratch, 'cli-'));
  const handoffFile = join(scratch, `${title.replace(/\W+/g, '-')}.handoff`);
  const child = spawn(process.execPath, [join(here, 'cloud-claim.mjs')], {
    env: { PATH: process.env.PATH, CLAIM_EMAIL: 'umer@example.com', BOAT_BASE_URL: server.url, EVIDENCE_DIR: evidence, HANDOFF_FILE: handoffFile, CLAIM_DEADLINE_S: '60' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => {
    stdout += d;
    if (sigintOn && stdout.includes(sigintOn) && !child.sigSent) { child.sigSent = true; say(`  [harness] SIGINT sent on "${sigintOn}"`); child.kill('SIGINT'); }
  });
  const code = await new Promise((res) => child.on('exit', (c) => res(c)));
  for (const l of stdout.trimEnd().split('\n')) say(`  stdout| ${l.replace(evidence, '<evidence-dir>')}`);
  const log = readFileSync(join(evidence, readdirSync(evidence)[0]), 'utf8');
  for (const l of log.trimEnd().split('\n')) say(`  log| ${l}`);
  leakCheck(log, 'evidence log');
  const handoffLines = readFileSync(handoffFile, 'utf8').trimEnd().split('\n');
  const handoffMode = (statSync(handoffFile).mode & 0o777).toString(8);
  say(`  handoff file: ${handoffLines.length} HANDOFF lines, mode ${handoffMode}; stdout HANDOFF lines: ${stdout.includes('HANDOFF') ? 'yes' : 'none'}`);
  if (handoffLines.length !== 2 || handoffMode !== '600' || stdout.includes('HANDOFF')) bad.push(`${title}: handoff not kept to HANDOFF_FILE`);
  say(`  -> exit code ${code}`);
  if (code !== expect) bad.push(`${title}: expected exit ${expect}`);
  await server.close();
};

say(`bench ${new Date().toISOString()} node ${process.version}`);
await inProcess('A success: two pending polls then the key', { script: ['pending', 'pending'], interval: 1, expect: 'claimed key read GET /me' });
await inProcess('B success via assertion exchange', { script: ['assertion'], expect: 'claimed key read GET /me' });
await inProcess('C aborted while waiting (no key issued)', { script: Array(20).fill('pending'), interval: 1, abortOn: 'step  4', expect: 'aborted before a key was issued' });
await inProcess('D aborted right after the key arrived', { abortOn: 'step  5', expect: 'aborted after the key was issued' });
await inProcess('E code expired', { script: ['expired_token'], expect: 'claim failed: expired' });
await inProcess('F wrong email refused', { email: 'someone-else@example.com', expect: 'claim failed: refused' });
await cli('G CLI success path: the kit revokes the key, /me then 401', { expect: 0 });
await cli('H CLI Ctrl-C while waiting', { script: Array(20).fill('pending'), interval: 1, sigintOn: 'step  4', expect: 1 });
say(bad.length === 0 ? '\nBENCH PASS: every case ended as expected, no leak' : `\nBENCH FAIL: ${bad.join('; ')}`);
process.exit(bad.length === 0 ? 0 : 1);
