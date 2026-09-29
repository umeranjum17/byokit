// The deterministic herd the fake serves (docs/runtime-kits.md 6.8): 1 workspace, 1 tab, 2 panes —
// `w1:p1` a plain shell, `w1:p2` an agent of the first kind. Ids follow the live Herdr
// `workspace:pane` shape so close guards and filtered subscriptions bind. Ported from muxr
// `perf/fake-herdr/world.mjs` with the multi-tab herd and perf fixtures removed.

export type FakeRect = { x: number; y: number; width: number; height: number };

export type FakeScroll = {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
};

export type FakePane = {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cwd: string;
  foreground_cwd: string;
  agent_status?: string;
  label: string;
  terminal_title: string;
  terminal_title_stripped: string;
  focused: boolean;
  tokens: Record<string, unknown>;
  env?: Record<string, string>;          // placement env the pane was created with (K7), if any
  rect: FakeRect;
  text: string[];                      // visible screen text, one entry per line
  revision: number;                    // the pane revision `pane.get` reports (tracks the agent's)
  scroll: FakeScroll;                  // the scroll state `pane.get` reports
};

export type FakeAgent = {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cwd: string;
  foreground_cwd: string;
  name: string;
  agent: string;
  display_agent: string;
  title: string;
  agent_status: string;
  interactive_ready: boolean;
  launch_pending: boolean;
  revision: number;
  terminal_id: string;                 // `term-<pane_id>`, as the prompt receipt reports it
  focused: boolean;
  detection?: string;                  // what `pane.read { source: 'detection' }` returns while blocked
  agent_session: { source: string; agent: string; kind: string; value: string };
};

export type FakePluginSeed = {
  plugin_id: string;
  name?: string;
  version?: string;
  enabled?: boolean;
};

export type FakePlugin = {
  plugin_id: string;
  name: string;
  version: string;
  manifest_path: string;
  plugin_root: string;
  enabled: boolean;
};

export type FakeTab = { tab_id: string; workspace_id: string; label: string };

export type FakeWorkspace = {
  workspace_id: string;
  label: string;
  focused: boolean;
  number: number;
  tokens: Record<string, string>;
  worktree?: {
    repo_key: string;
    repo_name: string;
    repo_root: string;
    checkout_path: string;
    is_linked_worktree: boolean;
  };
};

export type FakeWorld = {
  cwd: string;
  workspaces: FakeWorkspace[];
  tabs: FakeTab[];
  panes: FakePane[];
  agents: FakeAgent[];
  plugins: FakePlugin[];
};

export const COLS = 80;
export const ROWS = 24;

export function paneRect(indexInTab: number, panesInTab: number): FakeRect {
  const height = Math.max(1, Math.floor(ROWS / panesInTab));
  const y = indexInTab * height;
  return {
    x: 0,
    y,
    width: COLS,
    height: indexInTab === panesInTab - 1 ? ROWS - y : height,
  };
}

export function agentRecord(o: {
  paneId: string; tabId: string; workspaceId: string; cwd: string;
  name: string; kind: string; revision: number; focused?: boolean;
}): FakeAgent {
  return {
    pane_id: o.paneId,
    tab_id: o.tabId,
    workspace_id: o.workspaceId,
    cwd: o.cwd,
    foreground_cwd: o.cwd,
    name: o.name,
    agent: o.kind,
    display_agent: o.name,
    title: o.name,
    agent_status: 'idle',
    interactive_ready: true,
    launch_pending: false,
    revision: o.revision,
    terminal_id: `term-${o.paneId}`,
    focused: o.focused ?? false,
    agent_session: { source: `herdr:${o.kind}`, agent: o.kind, kind: 'id', value: `gen-${o.paneId}` },
  };
}

export function pluginRecord(o: { dir: string; seed: FakePluginSeed }): FakePlugin {
  return {
    plugin_id: o.seed.plugin_id,
    name: o.seed.name ?? o.seed.plugin_id,
    version: o.seed.version ?? '0.0.0',
    manifest_path: `${o.dir}/plugins/${o.seed.plugin_id}/herdr.plugin.json`,
    plugin_root: `${o.dir}/plugins/${o.seed.plugin_id}`,
    enabled: o.seed.enabled ?? true,
  };
}

export function paneScroll(): FakeScroll {
  return { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: ROWS };
}

export function createWorld(o: { cwd: string; kinds: readonly string[]; plugins?: readonly FakePluginSeed[] }): FakeWorld {
  const workspace: FakeWorkspace = {
    workspace_id: 'w1',
    label: o.cwd,
    focused: true,
    number: 1,
    tokens: {},
    worktree: {
      repo_key: 'fake-herdr',
      repo_name: 'fake-herdr',
      repo_root: o.cwd,
      checkout_path: o.cwd,
      is_linked_worktree: false,
    },
  };
  const tab: FakeTab = { tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' };
  const shell: FakePane = {
    pane_id: 'w1:p1',
    tab_id: tab.tab_id,
    workspace_id: 'w1',
    cwd: o.cwd,
    foreground_cwd: o.cwd,
    label: 'zsh',
    terminal_title: `zsh · ${o.cwd}`,
    terminal_title_stripped: `zsh · ${o.cwd}`,
    focused: true,
    tokens: {},
    rect: paneRect(0, 2),
    text: ['ready.'],
    revision: 0,
    scroll: paneScroll(),
  };
  const kind = o.kinds[0] ?? 'pi';
  const agentPane: FakePane = {
    ...shell,
    pane_id: 'w1:p2',
    focused: false,
    rect: paneRect(1, 2),
    agent_status: 'idle',
    label: kind,
    terminal_title: `${kind} · ${kind}`,
    terminal_title_stripped: `${kind} · ${kind}`,
    revision: 0,
    scroll: paneScroll(),   // its own scroll: the spread would alias the shell's object
  };
  const agent = agentRecord({
    paneId: agentPane.pane_id, tabId: tab.tab_id, workspaceId: 'w1', cwd: o.cwd,
    name: kind, kind, revision: 0,
  });
  const plugins = (o.plugins ?? []).map((seed) => pluginRecord({ dir: o.cwd, seed }));
  return { cwd: o.cwd, workspaces: [workspace], tabs: [tab], panes: [shell, agentPane], agents: [agent], plugins };
}

export function relayoutTab(world: FakeWorld, tabId: string): void {
  const panes = world.panes.filter((pane) => pane.tab_id === tabId);
  panes.forEach((pane, index) => { pane.rect = paneRect(index, panes.length); });
}

export function freezeWorld(world: FakeWorld): FakeWorld {
  return JSON.parse(JSON.stringify(world)) as FakeWorld;
}
