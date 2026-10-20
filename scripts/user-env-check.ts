// Fails when a provider key sits in the systemd user environment, where every program the person starts inherits it.
// Run: npm run check:user-env [-- --systemctl <path>]. Reads variable names only, never values.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const KEY = /_API_KEY$|_AUTH_TOKEN$|^CLAUDE_CODE_OAUTH_TOKEN$/;

/** Names of provider key variables in `systemctl --user show-environment` output. */
export function keyNames(output: string): string[] {
  return output.split('\n').map((line) => line.slice(0, Math.max(line.indexOf('='), 0))).filter((name) => KEY.test(name));
}

export function checkUserEnv(systemctl = 'systemctl'): { ok: boolean; message: string } {
  let output: string;
  try { output = execFileSync(systemctl, ['--user', 'show-environment'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return { ok: true, message: 'No systemd user environment to check.' }; }
  const names = keyNames(output);
  if (!names.length) return { ok: true, message: 'No provider key is in the systemd user environment.' };
  return { ok: false, message: names.map((name) => `${name} is set in the systemd user environment, so every program you start can use it. Remove it: systemctl --user unset-environment ${name}`).join('\n') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf('--systemctl');
  const result = checkUserEnv(flag > 0 ? process.argv[flag + 1] : undefined);
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
