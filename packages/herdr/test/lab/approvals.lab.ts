// The blocked-agent answer path (docs/runtime-kits.md 6.4, D10) against a real Cursor agent: a real
// question Herdr reports as `blocked`, answered through the kit's own `blocked()`/`answer()` surface,
// with the pane state afterwards captured as evidence.
//
// Not matched by `npm test`'s glob: run by hand under a `--herdr-lab` brief, with the named lab
// session provisioned and torn down by the Herdr lab helper (which owns the default-session tripwire)
// and its socket passed in. The agent runs as the person's installed, signed-in `cursor-agent` with
// the normal HOME (`APPROVALS_LAB_HOME`), the same way the app runs it; the Herdr server itself keeps
// the helper's disposable HOME.
//
//   APPROVALS_LAB_HOME=<home with a signed-in cursor-agent> \
//   APPROVALS_EVIDENCE=<dir for the captured evidence> \
//   HERDR_LAB_SOCKET=<lab session socket> node packages/herdr/test/lab/approvals.lab.ts
//
// The kit sends keys; the agent's TUI owns what each key means. This build's run-command dialog
// offers Allow (`y`) and one refusal (`esc` or `n`, "Skip & tell the agent what to do instead"), so
// Deny and Skip are two journeys through that same refusal key, each proven by its own observable
// outcome, and the evidence records the dialog text Herdr detected for each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HerdrKit } from '../../src/kit.ts';

const socketPath = process.env.HERDR_LAB_SOCKET;
if (!socketPath || !socketPath.includes('/sessions/')) throw new Error('approvals lab: HERDR_LAB_SOCKET must name a lab session socket');
const agentHome = process.env.APPROVALS_LAB_HOME;
if (!agentHome?.startsWith('/')) throw new Error('approvals lab: APPROVALS_LAB_HOME must name the signed-in home');
const evidenceDir = process.env.APPROVALS_EVIDENCE;
if (!evidenceDir?.startsWith('/')) throw new Error('approvals lab: APPROVALS_EVIDENCE must name a directory');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const cwd = join(evidenceDir, 'agent-cwd');

type Leg = { leg: string; prompt: string; keys: string[]; revision?: number; paneRevision?: number;
  statusWhileBlocked?: string; statusAfter?: string; paneAfter?: string; effect?: string };
const evidence: { agent: string; home: string; legs: Leg[]; stale: Record<string, unknown> } =
  { agent: 'cursor', home: agentHome, legs: [], stale: {} };

await mkdir(cwd, { recursive: true });

test('real Cursor: a blocked question is answered through the kit, and a stale answer is refused', async (t) => {
  const kit = new HerdrKit({ mode: 'adopt', bin: 'herdr', socketPath });
  const status = (paneId: string): string | undefined => {
    for (const w of kit.snapshot().workspaces) for (const tb of w.tabs) for (const p of tb.panes) {
      if (p.id === paneId) return p.agent?.status;
    }
    return undefined;
  };
  const blockedWithin = async (paneId: string, ms: number): Promise<{ revision: number; prompt: string } | undefined> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = kit.blocked().find((b) => b.paneId === paneId);
      if (hit) return hit;
      if (Date.now() >= deadline) return undefined;
      await sleep(500);
    }
  };
  const untilUnblocked = async (paneId: string): Promise<void> => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (!kit.blocked().some((b) => b.paneId === paneId)) return;
      if (Date.now() >= deadline) assert.fail(`${paneId} stayed blocked after its answer`);
      await sleep(500);
    }
  };
  // After a refusal Cursor offers a "tell the agent what to do instead" line; an empty Enter skips it.
  const settle = async (paneId: string): Promise<void> => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      const visible = (await kit.read(paneId, { source: 'visible' })).text;
      const box = visible.includes('Tell the agent what to do instead');
      if (box) await kit.sendKeys({ paneId }, ['enter']);
      if (!box && ['idle', 'done'].includes(status(paneId) ?? '')) return;
      if (Date.now() >= deadline) assert.fail(`the agent did not settle after its answer (${status(paneId)})`);
      await sleep(500);
    }
  };
  const file = async (name: string): Promise<string | undefined> => {
    try { return await readFile(join(cwd, name), 'utf8'); } catch { return undefined; }
  };
  const tail = async (paneId: string): Promise<string> =>
    (await kit.read(paneId, { source: 'visible' })).text.split('\n').filter((l) => l.trim() !== '').slice(-8).join('\n');

  await kit.start();
  try {
  await t.test('setup', async () => {
    assert.equal(kit.state.phase, 'ready');
  });
  const ref = await kit.startAgent({ kind: 'cursor', name: 'cursor', cwd,
    place: { workspace: 'new', label: 'approvals' },
    env: { HOME: agentHome }, args: ['--model', 'auto', '--trust'] });
  await kit.waitPromptable(ref, { timeoutMs: 180_000 });
  await sleep(2000);   // let the agent's own first render finish before the first prompt

  // One prompt, one question: the command's own side effect says whether it ran.
  const ask = async (leg: string, name: string): Promise<Leg> => {
    await kit.prompt(ref, `Run exactly this shell command and report its output: echo ${name} > ${name}.txt`);
    // Cursor's first render can swallow the submit and leave the prompt sitting in its input box; Enter
    // sends what is already there, so a quiet pane gets three chances before the leg is called lost.
    let b = await blockedWithin(ref.paneId, 45_000);
    for (let attempt = 0; b === undefined && attempt < 3; attempt += 1) {
      await kit.sendKeys({ paneId: ref.paneId }, ['enter']);
      b = await blockedWithin(ref.paneId, 30_000);
    }
    if (b === undefined) {
      assert.fail(`Herdr never reported ${ref.paneId} blocked; pane says:\n${(await kit.read(ref.paneId, { source: 'visible' })).text}`);
    }
    const pane = (await kit.call('pane.get', { pane_id: ref.paneId })) as { pane?: { revision?: number } };
    const entry: Leg = { leg, prompt: b.prompt, keys: [], revision: b.revision,
      paneRevision: pane.pane?.revision, statusWhileBlocked: status(ref.paneId) };
    evidence.legs.push(entry);
    return entry;
  };
  const answerLeg = async (entry: Leg, keys: string[], name: string, expect: string): Promise<void> => {
    entry.keys = keys;
    await kit.answer(ref.paneId, keys, { revision: entry.revision! });
    await untilUnblocked(ref.paneId);
    await settle(ref.paneId);
    entry.statusAfter = status(ref.paneId);
    entry.effect = (await file(`${name}.txt`)) === undefined ? 'not run' : 'ran';
    entry.paneAfter = await tail(ref.paneId);
    assert.equal(entry.effect, expect, `${entry.leg}: ${keys.join(' ')} should leave the command ${expect}`);
    assert.notEqual(entry.statusAfter, 'blocked', `${entry.leg}: the question is answered`);
  };

  // Allow: the question really was Herdr's `blocked` state with the dialog text, and `y` runs it.
  const allow = await ask('allow', 'allow-ok');
  assert.equal(allow.statusWhileBlocked, 'blocked');
  assert.match(allow.prompt, /Run this command\?/, 'Herdr detection carries the question');
  await answerLeg(allow, ['y'], 'allow-ok', 'ran');
  assert.equal(await file('allow-ok.txt'), 'allow-ok\n');

  // Deny: the refusal key, after which the agent reports the command rejected and did not run it.
  const deny = await ask('deny', 'deny-ok');
  assert.equal(deny.statusWhileBlocked, 'blocked');
  assert.match(deny.prompt, /Run this command\?/);
  await answerLeg(deny, ['n'], 'deny-ok', 'not run');
  assert.match(deny.paneAfter ?? '', /Rejected|did not run/, 'the agent saw the refusal');

  // Skip: the dialog's own dismiss key, with the same "nothing ran" outcome.
  const skip = await ask('skip', 'skip-ok');
  assert.equal(skip.statusWhileBlocked, 'blocked');
  await answerLeg(skip, ['esc'], 'skip-ok', 'not run');

  // Stale: the identity captured for the skip question is dead once a new question holds the pane.
  const stale = await ask('stale-refused', 'stale-ok');
  const before = (await kit.read(ref.paneId, { source: 'detection' })).text;
  await assert.rejects(kit.answer(ref.paneId, ['y'], { revision: skip.revision! }),
    (e: { code?: string }) => e.code === 'approval-stale', 'an answer for the answered question is refused');
  evidence.stale = {
    refusedRevision: skip.revision, currentRevision: stale.revision,
    // The pinned Herdr names both questions with one pane revision; the kit's own identity is what moved.
    paneRevisionOfAnswered: skip.paneRevision, paneRevisionOfLive: stale.paneRevision,
    stillBlocked: kit.blocked().some((b) => b.paneId === ref.paneId),
    dialogUnchanged: (await kit.read(ref.paneId, { source: 'detection' })).text === before,
    commandRan: (await file('stale-ok.txt')) !== undefined,
  };
  assert.equal(evidence.stale.stillBlocked, true, 'the refusal leaves the live question open');
  assert.equal(evidence.stale.dialogUnchanged, true, 'the refusal typed nothing into the pane');
  assert.equal(evidence.stale.commandRan, false);
  // The current revision still answers it, so the refusal is not a dead end.
  await answerLeg(stale, ['y'], 'stale-ok', 'ran');

  } finally {
    // The evidence is kept even when a leg fails: it is what the PR reads.
    await writeFile(join(evidenceDir, 'approvals.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    await kit.stop();
  }
});
