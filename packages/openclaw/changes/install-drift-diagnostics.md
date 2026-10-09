- FIX: a failed engine install or post-build verification now retains a size-capped, environment-free diagnosis at
  `<stateDir>/logs/engine-install-drift.json` before the failed temporary set is deleted: the first failed
  root-manifest or package check (its path, expected vs actual version, or the read error), the npm path and
  version, and the npm stderr tail. Previously the temp was deleted with the comparator's reason swallowed, so a
  natural `drift-after-build` failure could not be diagnosed after the fact.
