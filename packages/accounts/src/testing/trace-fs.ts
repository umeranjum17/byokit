// Preload (node --import) that records every file-system call naming a path under TRACE_ROOTS (colon-separated), one
// line per touch in TRACE_LOG. It keeps the original appendFileSync for itself, so it never traces its own writes.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

const roots = (process.env.TRACE_ROOTS ?? '').split(':').filter(Boolean);
const log = process.env.TRACE_LOG;
const append = fs.appendFileSync;
const hit = (p: unknown) => {
  if (typeof p === 'number' || p == null) return;
  const s = resolve(String(p instanceof URL ? p.pathname : p));
  if (roots.some((r) => s === r || s.startsWith(r + '/'))) append(log!, `${s}\n`);
};
const wrap = (obj: any, name: string) => {
  const f = obj[name];
  if (typeof f !== 'function' || (name === 'appendFileSync' && obj === fs)) return;
  obj[name] = function (this: unknown, a: unknown, b: unknown, ...rest: unknown[]) { hit(a); if (/rename|copy|link|symlink|cp/i.test(name)) hit(b); return f.call(this, a, b, ...rest); };
};
if (log && roots.length) {
  for (const name of Object.keys(fs)) if (/^[a-z]/.test(name) && !['watch', 'watchFile', 'unwatchFile'].includes(name)) wrap(fs, name);
  for (const name of Object.keys(fs.promises)) wrap(fs.promises, name);
  syncBuiltinESMExports();
}
