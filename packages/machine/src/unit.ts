// Unit file rendering (docs/machine-kit.md 8.4), pure. The rendered bytes are the golden
// files in test/golden/.
import type { HostRecipe } from './types.ts';

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Double-quote one ExecStart/ExecStartPre argument (8.4: \ → \\, " → \", % → %%, $ → $$). */
export function quoteArg(arg: string): string {
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** Double-quote one Environment value (8.4: like quoteArg but $ stays). */
export function quoteEnv(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/**
 * Render `byokit-<name>.service`. `runUser` is the recipe's user or the machine user;
 * `nodePath` is the resolved node binary (8.3 step 4); `selfId` adds the copy-detection
 * boot probe (8.7, present once M6 records its argv).
 */
export function renderUnit(
  r: HostRecipe,
  o: { kind: 'system' | 'user'; runUser: string; nodePath: string; selfId: boolean },
): string {
  const binDir = o.nodePath.slice(0, o.nodePath.lastIndexOf('/'));
  const lines = [
    '[Unit]',
    `Description=byokit ${r.name}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
  ];
  if (o.kind === 'system') lines.push(`User=${o.runUser}`);
  lines.push(`WorkingDirectory=${r.workDir}`);
  const env = Object.entries(r.run.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!Object.hasOwn(r.run.env, 'PATH')) lines.push(`Environment="PATH=${binDir}:${SYSTEM_PATH}"`);
  for (const [name, value] of env) lines.push(`Environment=${quoteEnv(`${name}=${value}`)}`);
  if (o.selfId) lines.push(`ExecStartPre=-${quoteArg(o.nodePath)} ${quoteArg(`${r.workDir}/.byokit/boot.mjs`)}`);
  const [first, ...rest] = r.run.argv;
  const start = first === 'node' ? o.nodePath : first;
  lines.push(`ExecStart=${quoteArg(start)}${rest.map((a) => ` ${quoteArg(a)}`).join('')}`);
  lines.push('Restart=always', 'RestartSec=5', '', '[Install]', `WantedBy=${o.kind === 'system' ? 'multi-user.target' : 'default.target'}`, '');
  return lines.join('\n');
}
