- New control link ops `hd.rename { pane | tab | workspace, label }`, `hd.focus { pane | tab | workspace }` and
  `hd.layout { root, focus?, tabId?, tabLabel?, workspaceId? }`, with device `rename()`, `focus()` and
  `layout()`. Each copies `hd.close`'s scope rule: the one pane, tab (through its owning workspace) or
  workspace it names must be in `scopeOf(grant)`, or the device hears the `link.notAllowed` sentence and no
  Herdr call is made; a `view` grant is refused. They map only to the typed `pane.rename`/`tab.rename`/
  `workspace.rename`, `pane.focus`/`tab.focus`/`workspace.focus` and `layout.apply` calls, never through
  `hd.call`. The fake Herdr now answers `layout.apply` and emits `layout.updated`.
