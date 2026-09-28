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
const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const unavailable = (kind: 'pane' | 'tab' | 'workspace'): Error =>
  fail(`${kind}-unavailable`, `That ${kind} is no longer available.`);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export async function closePane(call: Call, paneId: string): Promise<void> {
  let tabId: unknown;
  try {
    const made = (await call('pane.get', { pane_id: paneId })) as Raw;
    tabId = made?.pane?.tab_id;
  } catch (error) {
    if (codeOf(error) === 'pane_not_found') throw unavailable('pane');
    throw error;
  }
  if (typeof tabId !== 'string') throw unavailable('pane');
  let paneCount = 0;
  try {
    const made = (await call('tab.get', { tab_id: tabId })) as Raw;
    paneCount = count(made?.tab?.pane_count);
  } catch (error) {
    if (codeOf(error) === 'tab_not_found') throw unavailable('pane');
    throw error;
  }
  if (paneCount <= 1) throw fail('pane-close-would-widen', 'Closing this pane would close its tab; close the tab instead.');
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
  try {
    const made = (await call('workspace.get', { workspace_id: workspaceId })) as Raw;
    tabCount = count(made?.workspace?.tab_count);
  } catch (error) {
    if (codeOf(error) === 'workspace_not_found') throw unavailable('tab');
    throw error;
  }
  if (tabCount <= 1) throw fail('tab-close-would-widen', 'Closing this tab would close its workspace; close the workspace instead.');
  await call('tab.close', { tab_id: tabId });
}

export async function closeWorkspace(call: Call, workspaceId: string): Promise<void> {
  let worktree: Raw | undefined;
  try {
    const made = (await call('workspace.get', { workspace_id: workspaceId })) as Raw;
    worktree = made?.workspace?.worktree;
  } catch (error) {
    if (codeOf(error) === 'workspace_not_found') throw unavailable('workspace');
    throw error;
  }
  // The root of a worktree group — a non-linked checkout whose repo key a linked one shares — widens.
  if (worktree?.is_linked_worktree === false && typeof worktree.repo_key === 'string') {
    const made = (await call('workspace.list', {})) as Raw;
    const group = (Array.isArray(made?.workspaces) ? made.workspaces : [])
      .filter((w: Raw) => w?.worktree?.repo_key === worktree.repo_key).length;
    if (group >= 2) {
      throw fail('workspace-close-would-widen',
        'Closing this workspace would close its worktree group; close the linked checkouts instead.');
    }
  }
  await call('workspace.close', { workspace_id: workspaceId });
}
