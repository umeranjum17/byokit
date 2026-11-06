#!/usr/bin/env node
// The blocked-agent answer journey (docs/runtime-kits.md 6.4, D10) on a real Cursor agent: the capture
// the herdr-blocked-approvals feature drives. It provisions one disposable, named Herdr lab session
// through the environment's Herdr lab helper (never the person's `default` session), runs
// `packages/herdr/test/lab/approvals.lab.ts` against that session's socket, and tears the session down
// on exit. The agent runs as the person's installed, signed-in `cursor-agent` under
// APPROVALS_LAB_HOME, the way an app runs it; the Herdr server itself keeps the helper's disposable HOME.
//
//   HERDR_LAB_HELPER=<bin/jg-herdr-lab.sh> APPROVALS_LAB_HOME=<signed-in home> \
//   DONE_DONE_EVIDENCE_ROOT=<this run's evidence folder> node capture/herdr-blocked-approvals.mjs
//
// Writes `approvals.json` (the captured questions, keys, pane states and the stale refusal) and
// `approvals.log` (the journey's own output) into the evidence folder; exits non-zero unless the
// journey passed and both files exist.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const helper = process.env.HERDR_LAB_HELPER ?? '';
const home = process.env.APPROVALS_LAB_HOME ?? '';
const evidence = process.env.DONE_DONE_EVIDENCE_ROOT ?? '';
if (!helper.startsWith('/') || !home.startsWith('/') || !evidence.startsWith('/')) {
  console.error('set HERDR_LAB_HELPER, APPROVALS_LAB_HOME and DONE_DONE_EVIDENCE_ROOT to absolute paths');
  process.exit(2);
}
const lab = (args: string[]): string => execFileSync(helper, args, { encoding: 'utf8' });
const session = lab(['name', 'byk-blocked-approvals']).trim();
let torn = false;
const teardown = (): void => {
  if (torn) return;
  torn = true;
  try { lab(['teardown', session]); } catch (error) { console.error(`teardown failed: ${(error as Error).message}`); }
};
process.on('exit', teardown);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { teardown(); process.exit(1); });

lab(['provision', session]);
const sessions = JSON.parse(lab(['run', session, 'session', 'list', '--json'])) as
  { sessions?: { name?: string; socket_path?: string }[] };
const socketPath = sessions.sessions?.find((s) => s.name === session)?.socket_path;
if (!socketPath || socketPath.includes('/default/')) {
  console.error(`no lab socket for session ${session}; refusing`);
  process.exit(1);
}

const child = spawn(process.execPath, ['packages/herdr/test/lab/approvals.lab.ts'], {
  env: { ...process.env, HERDR_LAB_SOCKET: socketPath, APPROVALS_EVIDENCE: evidence },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output: string[] = [];
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => output.push(chunk.toString()));
const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
writeFileSync(join(evidence, 'approvals.log'), output.join(''));
teardown();

const captured = join(evidence, 'approvals.json');
if (code !== 0 || !existsSync(captured)) {
  console.error(output.join(''));
  console.error(`the approvals journey exited ${code}; no captured questions in ${captured}`);
  process.exit(1);
}
const evidenceOf = JSON.parse(readFileSync(captured, 'utf8')) as {
  legs?: { leg?: string; revision?: number; paneRevision?: number; keys?: string[]; statusWhileBlocked?: string; statusAfter?: string; effect?: string }[];
  stale?: Record<string, unknown>;
};
for (const leg of evidenceOf.legs ?? []) {
  console.log(`${leg.leg}: keys ${JSON.stringify(leg.keys)} at kit revision ${leg.revision} (Herdr pane revision ${leg.paneRevision}), `
    + `${leg.statusWhileBlocked} -> ${leg.statusAfter}, command ${leg.effect}`);
}
console.log(`stale: ${JSON.stringify(evidenceOf.stale)}`);
console.log(`captured ${captured} and ${join(evidence, 'approvals.log')}`);
