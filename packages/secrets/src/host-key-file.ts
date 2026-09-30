import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { KeystoreError } from './errors.ts';
import { encrypt, decrypt, headerOf, makeHeader, type SealingAdapter } from './sealing.ts';
import { assertName } from './validate.ts';

export type HostKeyFileOptions = {
  service: string;
  /** Platform state directory override; use an absolute, app-owned directory in tests. */
  stateDir?: string;
};
export interface HostKeyFileSeal extends SealingAdapter {
  readonly mode: 'host-key-file';
  /** Hold the host's writer lock and include EVERY store/retained archive using this key. */
  rotate(paths?: readonly string[]): void;
}

const fail = () => new KeystoreError('unavailable', 'The automatic host key is unavailable');
const insecure = () => new KeystoreError('invalid', 'Automatic host key requires owner-only files and directories owned by the current user');
const idPattern = /^[a-f0-9]{32}$/;

function stateRoot(): string {
  switch (process.platform) {
    case 'linux': return process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
    case 'darwin': return join(homedir(), 'Library', 'Application Support');
    case 'win32': return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    default: throw new KeystoreError('unsupported', 'Automatic host keys are unsupported on this platform');
  }
}
export function hostKeyFileDirectory(o: HostKeyFileOptions): string {
  assertName(o?.service, 'service');
  const root = o.stateDir ?? stateRoot();
  if (typeof root !== 'string' || !isAbsolute(root)) throw new KeystoreError('invalid', 'The platform state directory must be absolute');
  // Service names cannot escape the app directory, collide through case folding or expose key bytes.
  return join(root, `byokit-${createHash('sha256').update(o.service).digest('hex')}`, 'host-key');
}

// Node's chmod on Windows cannot install/verify owner-only ACLs. Use the platform ACL API,
// never treating POSIX-looking mode bits as proof. No key material reaches this helper.
function windowsACL(path: string, install: boolean): void {
  if (process.platform !== 'win32') return;
  const script = `$ErrorActionPreference='Stop'; $p=$env:BYOKIT_ACL_PATH; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
if ($env:BYOKIT_ACL_INSTALL -eq '1') { $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$false); foreach($r in @($a.Access)) { $a.RemoveAccessRuleSpecific($r) }; $a.SetOwner($sid); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a };
$a=Get-Acl -LiteralPath $p; if ($a.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { exit 1 }; foreach($r in $a.Access) { if ($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) -ne $sid) { exit 1 } }`;
  const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { SystemRoot: process.env.SystemRoot, BYOKIT_ACL_PATH: path, BYOKIT_ACL_INSTALL: install ? '1' : '0' }, timeout: 3000, stdio: 'ignore', windowsHide: true,
  });
  if (result.error || result.status !== 0) throw insecure();
}
function privateStat(stat: Stats, directory: boolean): void {
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw insecure();
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) throw insecure();
}
function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  privateStat(stat, true);
  windowsACL(path, false);
}
function ensureDirectory(path: string): void {
  // Never repair insecure existing app directories silently.
  if (existsSync(path)) { privateDirectory(path); return; }
  const parent = dirname(path);
  if (!existsSync(parent)) ensureDirectory(parent);
  // Platform state roots may be shared/readable, but must not be writable by other users.
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || (process.platform !== 'win32' && ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw insecure();
  try { mkdirSync(path, { mode: 0o700 }); windowsACL(path, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  privateDirectory(path);
  syncDirectory(parent);
}
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return; // Windows does not expose directory fsync through Node.
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privateRead(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw insecure();
  windowsACL(path, false);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { privateStat(fstatSync(fd), false); return readFileSync(fd); }
  finally { closeSync(fd); }
}
/** Durable replacement with a unique O_EXCL temp; never follows or truncates an existing temp. */
export function durableReplace(path: string, bytes: Uint8Array): void {
  const temp = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    windowsACL(temp, true);
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path); syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}
type Rotation = { old: string; next: string; paths: string[] };

/** Persistent, app-specific 32-byte key; no key bytes are exposed by the adapter. */
export function hostKeyFileSeal(o: HostKeyFileOptions): HostKeyFileSeal {
  const directory = hostKeyFileDirectory(o);
  const app = dirname(directory);
  const service = o.service;
  const activePath = join(directory, 'active');
  const journalPath = join(directory, 'rotation');
  const keyPath = (id: string) => {
    if (!idPattern.test(id)) throw fail();
    return join(directory, `${id}.key`);
  };
  const guard = <T>(fn: () => T): T => {
    try { return fn(); } catch (error) { if (error instanceof KeystoreError) throw error; throw fail(); }
  };
  guard(() => {
    ensureDirectory(app);
    if (!existsSync(directory)) {
      const staging = mkdtempSync(join(app, '.host-key-'));
      windowsACL(staging, true);
      const key = randomBytes(32);
      try {
        const id = randomBytes(16).toString('hex');
        durableReplace(join(staging, `${id}.key`), key);
        durableReplace(join(staging, 'active'), Buffer.from(id));
        // A complete non-empty directory is published atomically. A racing initializer
        // cannot replace it (EEXIST/ENOTEMPTY); O_EXCL protects every staged file.
        try { renameSync(staging, directory); syncDirectory(app); }
        catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') || !existsSync(directory)) throw error; }
      } finally { key.fill(0); rmSync(staging, { recursive: true, force: true }); }
    }
    privateDirectory(directory);
  });
  const active = () => privateRead(activePath).toString('utf8');
  const withKey = <T>(id: string, fn: (key: Buffer) => T): T => {
    privateDirectory(app); privateDirectory(directory);
    const key = privateRead(keyPath(id));
    try { if (key.length !== 32) throw fail(); return fn(key); } finally { key.fill(0); }
  };
  guard(() => withKey(active(), () => {}));
  const encode = (text: string, id: string) => withKey(id, (key) => encrypt(text, key, makeHeader(2, Buffer.from(id, 'hex')), service));
  const decode = (data: Buffer) => {
    const header = headerOf(data, 2);
    return withKey(header.subarray(5).toString('hex'), (key) => decrypt(data, key, header, service));
  };
  return {
    mode: 'host-key-file',
    encryptString: (text) => guard(() => {
      if (existsSync(journalPath)) throw new KeystoreError('unavailable', 'Host key rotation is incomplete; resume rotate() before writing');
      return encode(text, active());
    }),
    decryptString: (data) => guard(() => decode(data)),
    rotate(paths) { guard(() => {
      let rotation: Rotation;
      if (existsSync(journalPath)) {
        rotation = JSON.parse(privateRead(journalPath).toString('utf8')) as Rotation;
        if (!rotation || !idPattern.test(rotation.old) || !idPattern.test(rotation.next) || !Array.isArray(rotation.paths) || rotation.paths.some((p) => typeof p !== 'string' || !isAbsolute(p))) throw fail();
        if (paths && JSON.stringify(paths) !== JSON.stringify(rotation.paths)) throw new KeystoreError('invalid', 'Resume rotation with the original paths or no arguments');
      } else {
        if (!paths || paths.length === 0 || paths.some((p) => typeof p !== 'string' || !isAbsolute(p) || p === directory || p.startsWith(`${directory}/`) || p.startsWith(`${directory}\\`)) || new Set(paths).size !== paths.length) throw new KeystoreError('invalid', 'Rotation requires all sealed store paths, absolute and distinct');
        // Authenticate every source before provisioning or changing anything.
        for (const path of paths) decode(privateRead(path));
        rotation = { old: active(), next: randomBytes(16).toString('hex'), paths: [...paths] };
        const key = randomBytes(32);
        try { durableReplace(keyPath(rotation.next), key); } finally { key.fill(0); }
        durableReplace(journalPath, Buffer.from(JSON.stringify(rotation)));
      }
      for (const path of rotation.paths) {
        const bytes = privateRead(path);
        const text = decode(bytes);
        if (bytes.subarray(5, 21).toString('hex') !== rotation.next) durableReplace(path, encode(text, rotation.next));
      }
      // All ciphertext replacements and their directories are durable before activation/retirement.
      durableReplace(activePath, Buffer.from(rotation.next));
      rmSync(keyPath(rotation.old), { force: true }); syncDirectory(directory);
      unlinkSync(journalPath); syncDirectory(directory);
    }); },
  };
}
