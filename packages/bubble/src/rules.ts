// Per-app visibility (docs/capability-kits.md 7.3). Pure: every function returns new rules.
import type { AppRules } from './types.ts';

/** Whether the bubble shows over `app` (the foreground app's package name, null when unknown). */
export function shownFor(rules: AppRules, app: string | null): boolean {
  if (rules.paused || app === null) return false;
  if (rules.off.includes(app)) return false;
  if (rules.on.includes(app)) return true;
  return rules.defaults.includes(app);
}

/** Moves `app` into `on` (shown) or `off` (hidden), and out of the other list. */
export function setApp(rules: AppRules, app: string, shown: boolean): AppRules {
  const on = rules.on.filter((a) => a !== app);
  const off = rules.off.filter((a) => a !== app);
  (shown ? on : off).push(app);
  return { ...rules, on, off };
}

/** Removes `app` from `on` and `off`, so `defaults` decides again. */
export function resetApp(rules: AppRules, app: string): AppRules {
  return { ...rules, on: rules.on.filter((a) => a !== app), off: rules.off.filter((a) => a !== app) };
}
