// Herdr's agents as a person sees them: the tree and waiting-agents state machine over `hd.events` frames, the
// grouped tree and names, and the live store through the kit's real device client: one stream per device however
// many views watch it, closed when the last one leaves, reopened after a dropped link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWords, herdrDevice } from '../../herdr/src/device.ts';
import {
  HERDR_EMPTY, agentIn, blockedView, herdrStep, herdrStore, herdrTreeView, type BlockedAgent, type HerdrState, type HerdrTree,
} from '../src/kits.ts';
import { stubLink, until } from './stub-link.ts';

const TREE: HerdrTree = {
  connected: true,
  workspaces: [
    { id: 'w1', label: '/home/me/projects/site/', tabs: [
      { id: 'w1:t1', label: 'main', panes: [
        { id: 'w1:p1', cwd: '/home/me' },
        { id: 'w1:p2', agent: { kind: 'pi', status: 'idle', revision: 3 } },
      ] },
      { id: 'w1:t2', label: 'shell', panes: [{ id: 'w1:p3' }] },
    ] },
    { id: 'w2', label: 'pi', tabs: [
      { id: 'w2:t1', label: 'one', panes: [
        { id: 'w2:p1', agent: { kind: 'pi', name: 'reviewer', status: 'blocked', revision: 7 } },
        { id: 'w2:p2', agent: { kind: 'codex', status: 'unknown', revision: 0, launchPending: true } },
      ] },
    ] },
  ],
};
const BLOCKED: BlockedAgent = { paneId: 'w2:p1', workspaceId: 'w2', tabId: 'w2:t1', kind: 'pi', revision: 7, prompt: 'Allow this? (y/n)', since: 1 };
const blockedFrame = (change: 'added' | 'resolved', b: BlockedAgent = BLOCKED) => ({ type: 'blocked' as const, change, blocked: b });

test('the tree comes from snapshots; waiting agents are listed, added, replaced and resolved', () => {
  let s: HerdrState = HERDR_EMPTY;
  assert.equal(s.tree, null, 'nothing known until the computer says');
  s = herdrStep(s, { type: 'snapshot', snapshot: TREE });
  assert.equal(s.tree, TREE);
  s = herdrStep(s, { type: 'listed', blocked: [BLOCKED] });
  assert.deepEqual(s.blocked, [BLOCKED]);
  const asked = { ...BLOCKED, revision: 9, prompt: 'Overwrite? (y/n)' };
  s = herdrStep(s, blockedFrame('added', asked));
  assert.deepEqual(s.blocked, [asked], 'a pane asked again replaces its question');
  const other = { ...BLOCKED, paneId: 'w1:p2', workspaceId: 'w1', tabId: 'w1:t1' };
  s = herdrStep(s, blockedFrame('added', other));
  assert.deepEqual(s.blocked.map((b) => b.paneId), ['w2:p1', 'w1:p2']);
  assert.equal(herdrStep(s, { type: 'raw', line: 'not json' }), s, 'a line that was not JSON changes nothing');
  assert.equal(herdrStep(s, blockedFrame('resolved', { ...BLOCKED, paneId: 'w9:p9' })), s, 'nor does resolving one not waiting');
  // The tree moves a still-waiting agent to a new revision with no question frame: the answer must carry it.
  const moved = { ...TREE, workspaces: TREE.workspaces.map((w) => ({ ...w, tabs: w.tabs.map((t) => ({ ...t, panes: t.panes.map((p) =>
    (p.id === 'w2:p1' ? { ...p, agent: { ...p.agent!, revision: 11 } } : p)) })) })) };
  const before = s;
  s = herdrStep(s, { type: 'snapshot', snapshot: moved });
  assert.deepEqual(s.blocked.map((b) => [b.paneId, b.revision]), [['w2:p1', 11], ['w1:p2', 3]], 'each takes its agent\'s revision');
  const lost = herdrStep({ ...before, blocked: [{ ...BLOCKED, paneId: 'w9:p9' }] }, { type: 'snapshot', snapshot: moved });
  assert.equal(lost.blocked[0].revision, 7, 'a pane the tree lacks keeps what it had');
  assert.equal(herdrStep(s, { type: 'snapshot', snapshot: moved }).blocked, s.blocked, 'nothing new, same list');
  s = herdrStep(s, blockedFrame('resolved', asked));
  assert.deepEqual(s.blocked, [{ ...other, revision: 3 }]);
  assert.equal(s.tree, moved, 'the tree is untouched by questions');
});

test('the tree view groups agents by where they run, with the status agentWords takes', () => {
  assert.deepEqual(herdrTreeView(null), []);
  const groups = herdrTreeView(TREE);
  assert.deepEqual(groups.map((g) => g.where), ['site · main', 'pi · one'], 'folder name · tab; tabs without an agent left out');
  assert.deepEqual(groups.map((g) => g.project), ['site', 'pi'], 'the folder name alone, without the tab label');
  assert.deepEqual(groups.map((g) => [g.workspaceId, g.tabId]), [['w1', 'w1:t1'], ['w2', 'w2:t1']]);
  assert.deepEqual(groups.flatMap((g) => g.agents.map((a) => [a.paneId, a.name, a.status])), [
    ['w1:p2', 'pi', 'idle'], ['w2:p1', 'reviewer', 'blocked'], ['w2:p2', 'codex', 'starting'],
  ]);
  assert.deepEqual(groups.flatMap((g) => g.agents.map((a) => agentWords(a.status))), ['Ready for you.', 'Waiting for your answer.', 'Starting…']);
  const bare = { ...TREE, workspaces: [{ id: 'w3', label: '/', tabs: [{ id: 't', label: 'x', panes: [{ id: 'p', agent: { status: 'done' as const, revision: 0 } }] }] }] };
  assert.deepEqual(herdrTreeView(bare).map((g) => [g.where, g.agents[0].name]), [['/ · x', 'Agent']]);

  assert.equal(agentIn(TREE, 'w2:p1')?.name, 'reviewer');
  assert.equal(agentIn(TREE, 'w1:p1'), undefined, 'a shell pane has no agent');
  assert.equal(agentIn(TREE, undefined), undefined);
  assert.equal(agentIn(null, 'w2:p1'), undefined);

  const named = blockedView({ tree: TREE, blocked: [BLOCKED, { ...BLOCKED, paneId: 'gone', kind: 'codex' }, { ...BLOCKED, paneId: 'gone', kind: undefined }] });
  assert.deepEqual(named.map((b) => b.name), ['reviewer', 'codex', 'Agent']);
  assert.equal(named[0].revision, 7, 'the revision to answer with is kept');
});

test('the store follows one stream per device, lists the waiting once open, and closes with its last watcher', async () => {
  let listing: BlockedAgent[] = [BLOCKED];
  const asked: string[] = [];
  const net = stubLink((op, args) => {
    asked.push(op);
    if (op === 'hd.blocked') return listing;
    if (op === 'hd.answer') return (args as { paneId: string }).paneId;
    return null;
  });
  const hd = herdrDevice(net.link);
  const tree = herdrStore(hd, { retryMs: 10 });
  assert.equal(herdrStore(hd), tree, 'every view of one device shares one store');
  const a: HerdrState[] = [];
  const b: HerdrState[] = [];
  const offA = tree.subscribe((s) => a.push(s));
  const offB = tree.subscribe((s) => b.push(s));
  const events = await net.next();
  assert.equal(events.op, 'hd.events');
  events.line({ type: 'snapshot', snapshot: TREE });
  await until(() => tree.get().blocked.length === 1);
  assert.equal(tree.get().tree?.workspaces.length, 2);
  assert.deepEqual(asked, ['hd.blocked']);
  assert.equal(net.opened.length, 1, 'two watchers, one stream');
  assert.equal(a.at(-1), b.at(-1));
  assert.ok(a.every((s) => s.tree !== null), 'the waiting list never shows before the tree');

  events.line('garbage');
  events.line(blockedFrame('resolved'));
  await until(() => tree.get().blocked.length === 0);

  // The link drops: the tree stays on screen, the stream reopens, and the waiting list is read again.
  listing = [];
  events.end();
  const again = await net.next();
  again.line({ type: 'snapshot', snapshot: { ...TREE, workspaces: TREE.workspaces.slice(0, 1) } });
  await until(() => tree.get().tree?.workspaces.length === 1);
  assert.equal(asked.filter((op) => op === 'hd.blocked').length, 2);

  offA();
  assert.equal(again.ended, false, 'one watcher is still there');
  offB();
  await until(() => again.ended);
  assert.equal(tree.get().tree?.workspaces.length, 1, 'the last state stays readable');
});

test('a stream that ends before the tree arrives is simply opened again', async () => {
  const net = stubLink((op) => (op === 'hd.blocked' ? [] : null));
  const tree = herdrStore(herdrDevice(net.link), { retryMs: 5 });
  const off = tree.subscribe(() => {});
  (await net.next()).end();
  const again = await net.next();
  again.line({ type: 'snapshot', snapshot: TREE });
  await until(() => tree.get().tree !== null);
  off();
  await until(() => again.ended);
});
