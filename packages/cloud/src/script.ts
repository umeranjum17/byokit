// First-boot and console install (G8, K-DIRECT): the 8.3 install as one POSIX sh script, so a
// machine installs itself with no exec from the setup device. cloud-init runs it as root with
// the machine user as $1; a console runs it as the person. Portable: no `node:*` import.
import { MachineError } from './errors.ts';
import { PHONE_KEY_FILE } from './enrol.ts';
import { NODE_INSTALL_SHELL } from './node.ts';
import { checkRecipe, markerPath } from './recipe.ts';
import { DELIVER_SHELL, WORKDIR_SHELL, WRITE_SHELL, renderUnit } from './unit.ts';
import type { HostRecipe } from './types.ts';

// Placeholders filled on the machine once the run user and home are known (sed-safe characters only).
const HOME = '@BYOKIT_HOME@';
const USER = '@BYOKIT_USER@';
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const line = (argv: readonly string[]): string => argv.map(q).join(' ');
const base64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

export type InstallScriptOptions = {
  phoneKey?: Uint8Array;   // the owner phone's 32-byte public key, put in the inbox before the host starts (5.12)
  returnFile?: string;     // an outbox file the host writes; its first line follows the ready line
};

/**
 * The install script for a recipe. `workDir` may start with `~/` (the run user's home, known only on the machine).
 * The last line printed is `byokit-ready <name>[ <returnFile line>]` on success, else `byokit-failed <name> <step>`
 * with exit 1. Every step is idempotent, so running it again repairs or reinstalls in place.
 */
export function installScript(r: HostRecipe, o: InstallScriptOptions = {}): string {
  checkRecipe({ ...r, workDir: r.workDir.replace(/^~\//, '/home/user/') }, r.name);
  if (o.phoneKey !== undefined && !(o.phoneKey instanceof Uint8Array && o.phoneKey.length === 32)) throw new MachineError('bad-recipe', 'phoneKey: must be a 32-byte public key');
  if (o.returnFile !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(o.returnFile)) throw new MachineError('bad-recipe', 'returnFile: must be a plain outbox file name');
  const home = r.workDir.startsWith('~/');
  const workDir = home ? `${HOME}/${r.workDir.slice(2)}` : r.workDir;
  const nodeDir = `${HOME}/.local/share/byokit/node/${r.node.version}`;
  const unit = (kind: 'system' | 'user'): string => renderUnit({ ...r, workDir }, { kind, runUser: USER, nodePath: `${nodeDir}/bin/node`, selfId: false });
  const fill = `sed "s|${HOME}|$RH|g; s|${USER}|$RU|g"`;
  const s = [
    'main() {',
    `N=${q(r.name)}; MU=\${1:-$(id -un)}`,
    'fail() { echo "byokit-failed $N $1"; exit 1; }',
    '[ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null || fail not-linux',
    `case "$(uname -m)" in x86_64) A=linux-x64 S=${r.node.sha256['linux-x64']};; aarch64) A=linux-arm64 S=${r.node.sha256['linux-arm64']};; *) fail not-linux;; esac`,
    'if [ "$(id -u)" = 0 ]; then R=; else R=sudo; fi',
    'MH=$(getent passwd "$MU" | cut -d: -f6)',
    r.user === undefined ? 'RU=$MU; RH=$MH' : `RU=${q(r.user)}; RH="$MH/.users/$RU"`,
    'case "$RH" in /*) ;; *) fail home;; esac; case "$RH" in *[!A-Za-z0-9._/-]*) fail home;; esac',
    `W=${home ? `"$RH"/${q(r.workDir.slice(2))}` : q(r.workDir)}`,
    'case "$W/" in "$RH"/*) ;; *) fail workDir;; esac',
    'as_run() { if [ "$RU" = "$(id -un)" ]; then "$@"; else $R runuser -u "$RU" -- env HOME="$RH" "$@"; fi; }',
  ];
  if (r.installRoot !== undefined || r.user !== undefined) {
    s.push(`if [ ! -e ${q(markerPath(r.name, r))} ]; then`, '[ -z "$R" ] || sudo -v || fail needs-root');
    if (r.user !== undefined) {
      s.push('$R install -d -m 0711 -o root -g root "$MH/.users" && $R chmod o+x "$MH" || fail user');
      s.push('id -u "$RU" >/dev/null 2>&1 || { $R useradd --system --no-create-home --home-dir "$RH" --shell /usr/sbin/nologin "$RU" && $R install -d -m 0700 -o "$RU" -g "$RU" "$RH"; } || fail user');
    }
    (r.installRoot ?? []).forEach((argv, i) => s.push(`$R ${line(argv)} || fail installRoot-${i}`));
    s.push(`$R mkdir -p /var/lib/byokit && $R touch ${q(markerPath(r.name, r))} || fail installRoot`, 'fi');
  }
  // ponytail: always the pinned node, never a machine node in range (8.3 step 4); add the range probe if a size matters.
  s.push(
    `ND="$RH/.local/share/byokit/node/${r.node.version}"`,
    `[ "$(as_run "$ND/bin/node" --version 2>/dev/null)" = v${r.node.version} ] || as_run sh -c ${q(NODE_INSTALL_SHELL)} sh "https://nodejs.org/dist/v${r.node.version}/node-v${r.node.version}-$A.tar.xz" "$S" "$ND" || fail node`,
    'as_run mkdir -p "$W" && as_run mkdir -p -m 0700 "$W/.byokit" || fail workDir',
  );
  r.install.forEach((argv, i) => s.push(`as_run sh -c ${q(WORKDIR_SHELL)} sh "$W" "$ND/bin" ${line(argv)} || fail install-${i}`));
  s.push(`printf '%s' '{"id":null}' | as_run sh -c ${q(WRITE_SHELL)} sh "$W/.byokit/installed.json" 600 || fail installed`);
  if (o.phoneKey !== undefined) s.push(`printf '%s' ${base64(o.phoneKey)} | base64 -d | as_run sh -c ${q(DELIVER_SHELL)} sh "$W/.byokit/inbox" ${PHONE_KEY_FILE} || fail phone-key`);
  const u = `byokit-${r.name}.service`;
  s.push(
    `if [ -z "$R" ] || [ "$RU" != "$MU" ]; then`,
    `printf '%s' ${q(unit('system'))} | ${fill} | $R sh -c ${q(WRITE_SHELL)} sh /etc/systemd/system/${u} 644 || fail unit`,
    `$R systemctl daemon-reload && $R systemctl enable --now --no-block ${u} || fail unit`,
    'else',
    `mkdir -p "$MH/.config/systemd/user" && printf '%s' ${q(unit('user'))} | ${fill} | sh -c ${q(WRITE_SHELL)} sh "$MH/.config/systemd/user/${u}" 644 || fail unit`,
    'loginctl enable-linger "$MU" || fail linger',
    `systemctl --user daemon-reload && systemctl --user enable --now ${u} || fail unit`,
    'fi',
  );
  if (o.returnFile === undefined) s.push('echo "byokit-ready $N"');
  else {
    const f = `"$W/.byokit/outbox/${o.returnFile}"`;
    s.push(`i=0; while [ $i -lt 60 ] && ! as_run test -s ${f}; do sleep 1; i=$((i+1)); done`, `as_run test -s ${f} || fail return`, `echo "byokit-ready $N $(as_run head -n 1 ${f})"`);
  }
  // One function, called last: a truncated paste fails to parse and runs nothing.
  return `${s.join('\n')}\n}\nmain "$@"\n`;
}

/**
 * K-DIRECT: the one line a person pastes into their own computer's terminal or any provider console.
 * `ready` is the line that ends a good run (the pinned return); a failed run ends `byokit-failed <name> <step>`.
 */
export function setupCommand(r: HostRecipe, o: InstallScriptOptions = {}): { command: string; script: string; ready: string } {
  const script = installScript(r, o);
  return { command: `echo ${base64(new TextEncoder().encode(script))} | base64 -d | sh`, script, ready: `byokit-ready ${r.name}` };
}
