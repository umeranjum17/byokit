// Node check and install argv (docs/cloud-kit.md 8.3 step 4), pure. The download, checksum
// and extract happen in one private directory in one shell, as in packages/herdr/src/binary.ts.
import type { HostRecipe } from './types.ts';

export type NodeArch = 'linux-x64' | 'linux-arm64';

/** Map `uname -m` to the recipe arch; anything else is not Linux we run on. */
export function archOf(unameM: string): NodeArch | null {
  if (unameM === 'x86_64') return 'linux-x64';
  if (unameM === 'aarch64') return 'linux-arm64';
  return null;
}

/** Where a pinned node version lives under a home directory. */
export function nodeDir(home: string, version: string): string {
  return `${home}/.local/share/byokit/node/${version}`;
}

/** The pinned node binary path. */
export function nodePath(home: string, version: string): string {
  return `${nodeDir(home, version)}/bin/node`;
}

/** The node download URL for a version and arch. */
export function nodeUrl(version: string, arch: NodeArch): string {
  return `https://nodejs.org/dist/v${version}/node-v${version}-${arch}.tar.xz`;
}

const INSTALL_SCRIPT = 'set -e; d=$(mktemp -d); trap "rm -rf \\"$d\\"" EXIT\ncurl -fsSL -o "$d/n.tar.xz" "$1"\necho "$2  $d/n.tar.xz" | sha256sum -c --status || exit 3\nmkdir -p "$3"; tar -xJf "$d/n.tar.xz" -C "$3" --strip-components=1';

/**
 * The 8.3 step 4 argv, run as the run user: downloads the tarball, checks its sha256
 * (exit 3 on mismatch), and extracts it under the run home. `home` is the run user's home.
 */
export function nodeInstallArgv(r: HostRecipe, arch: NodeArch, home: string): readonly string[] {
  return [
    'sh', '-c', INSTALL_SCRIPT, 'sh',
    nodeUrl(r.node.version, arch),
    r.node.sha256[arch],
    nodeDir(home, r.node.version),
  ];
}
