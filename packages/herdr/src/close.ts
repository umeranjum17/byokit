// Exact close guards (docs/runtime-kits.md 6.4): a close that would widen — the last pane of a tab,
// the only tab of a workspace, the root of a linked worktree group — is refused with a coded error,
// and a target that is gone maps to `<kind>-unavailable`. Ported from muxr's
// closeExactPane/closeExactTab/closeExactWorkspace.
import type { Call } from './agents.ts';

type Raw = Record<string, any>;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') return code;
  return /herdr: ([a-z0-9_]+):/i.exec(error instanceof Error ? error.message : String(error))?.[1];
};
const fail = (code: string, message: string,
  wider?: { scope: 'tab' | 'workspace' | 'worktreeGroup'; id: string; label: string; size?: number }): Error =>
  Object.assign(new Error(message), { code }, wider ?? {});
const unavailable = (kind: 'pane' | 'tab' | 'workspace'): Error =>
  fail(`${kind}-unavailable`, `That ${kind} is no longer available.`);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export async function closePane(call: Call, paneId: string,
  o?: { confirmed?: { scope: 'tab'; id: string } }): Promise<void> {
  let tabId: unknown;
  try {
    const made = (await call('pane.get', { pane_id: paneId })) as Raw;
    tabId = made?.pane?.tab_id;
  } catch (error) {
    if (codeOf(error) === 'pane_not_found') throw unavailable('pane');
    throw error;
  }
  if (typeof tabId !== 'string') throw unavailable('pane');
  // Confirmed-scope close (rollback): the caller echoes the wider target a
  // `pane-close-would-widen` refusal named. The live tree must still match — the pane is still
  // the confirmed tab's sole pane — then exactly that tab closes through the exact path, whose
  // own widening guard still applies (a sole tab closes as `tab-close-would-widen` naming the
  // workspace, never past the confirmed scope).
  if (o?.confirmed !== undefined) {
    let paneCount = 0;
    try {
      const made = (await call('tab.get', { tab_id: tabId })) as Raw;
      paneCount = count(made?.tab?.pane_count);
    } catch (error) {
      if (codeOf(error) === 'tab_not_found') throw unavailable('pane');
      throw error;
    }
    if (tabId !== o.confirmed.id || paneCount > 1) {
      throw fail('confirmed-scope-mismatch',
        'The pane is no longer the confirmed tab\'s sole pane; look at the tree and close fresh.');
    }
    await closeTab(call, o.confirmed.id);
    return;
  }
  let paneCount = 0;
  let tabLabel: string | undefined;
  try {
    const made = (await call('tab.get', { tab_id: tabId })) as Raw;
    paneCount = count(made?.tab?.pane_count);
    tabLabel = typeof made?.tab?.label === 'string' ? made.tab.label : undefined;
  } catch (error) {
    if (codeOf(error) === 'tab_not_found') throw unavailable('pane');
    throw error;
  }
  if (paneCount <= 1) {
    throw fail('pane-close-would-widen', 'Closing this pane would close its tab; close the tab instead.',
      { scope: 'tab', id: tabId, label: tabLabel ?? '' });
  }
  await call('pane.close', { pane_id: paneId });
}

export async function closeTab(call: Call, tabId: string): Promise<void> {
  let workspaceId: unknown;
  try {
    const made = (await call('tab.get', { tab_id: tabId })) as Raw;
    workspaceId = made?.tab?.workspace_id;
  } catch (error) {
    if (codeOf(error) === 'tab_not_found') throw unavailable('tab');
    throw error;
  }
  if (typeof workspaceId !== 'string') throw unavailable('tab');
  let tabCount = 0;
  let workspaceLabel: string | undefined;
  try {
    const made = (await call('workspace.get', { workspace_id: workspaceId })) as Raw;
    tabCount = count(made?.workspace?.tab_count);
    workspaceLabel = typeof made?.workspace?.label === 'string' ? made.workspace.label : undefined;
  } catch (error) {
    if (codeOf(error) === 'workspace_not_found') throw unavailable('tab');
    throw error;
  }
  if (tabCount <= 1) {
    throw fail('tab-close-would-widen', 'Closing this tab would close its workspace; close the workspace instead.',
      { scope: 'workspace', id: workspaceId, label: workspaceLabel ?? '' });
  }
  await call('tab.close', { tab_id: tabId });
}

export async function closeWorkspace(call: Call, workspaceId: string,
  o?: { confirmed?: { scope: 'worktreeGroup'; id: string } }): Promise<void> {
  let worktree: Raw | undefined;
  try {
    const made = (await call('workspace.get', { workspace_id: workspaceId })) as Raw;
    worktree = made?.workspace?.worktree;
  } catch (error) {
    if (codeOf(error) === 'workspace_not_found') throw unavailable('workspace');
    throw error;
  }
  // The group a root anchors: a non-linked checkout whose repo key a linked one shares. The
  // refusal names the group (repo name plus member count) so the confirmation sentence needs no
  // tree read; a confirmed group close sends one `workspace.close` with `close_group: true` and
  // Herdr widens it atomically — members are never closed one by one.
  const group = await groupOf(call, worktree);
  if (group === undefined) {
    await call('workspace.close', { workspace_id: workspaceId });
    return;
  }
  if (o?.confirmed === undefined) {
    throw fail('workspace-close-would-widen',
      'Closing this workspace would close its worktree group; close the linked checkouts instead.',
      { scope: 'worktreeGroup', id: workspaceId, label: group.repoName, size: group.size });
  }
  // Confirmed-scope close: the caller echoes the wider target the refusal named. The live tree
  // must still match — the id is still this group root — then exactly that group closes through
  // the grouped path.
  if (o.confirmed.id !== workspaceId || (await groupOf(call, worktree))?.size !== group.size) {
    throw fail('confirmed-scope-mismatch',
      'The worktree group changed since the refusal; look at the tree and close fresh.');
  }
  await call('workspace.close', { workspace_id: workspaceId, close_group: true });
}

async function groupOf(call: Call, worktree: Raw | undefined): Promise<{ repoName: string; size: number } | undefined> {
  // The root of a worktree group — a non-linked checkout whose repo key a linked one shares — widens.
  if (worktree?.is_linked_worktree !== false || typeof worktree.repo_key !== 'string') return undefined;
  const made = (await call('workspace.list', {})) as Raw;
  const size = (Array.isArray(made?.workspaces) ? made.workspaces : [])
    .filter((w: Raw) => w?.worktree?.repo_key === worktree.repo_key).length;
  if (size < 2) return undefined;
  const repoName = typeof worktree.repo_name === 'string' && worktree.repo_name.length > 0
    ? worktree.repo_name : worktree.repo_key;
  return { repoName, size };
}
