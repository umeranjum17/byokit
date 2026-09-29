// Opt-in pinned binary fetch (gap G11): `ensureHerdr({ dir })` downloads the pinned release asset for the
// current platform into an app-owned `dir`, verifies its sha256 against the committed table below, marks it
// executable, and returns the absolute `bin` for `HerdrKit` own mode. Nothing downloads on install or import —
// the network happens only when this is called. Never PATH, never `~/.local/bin`.
//
// The hashes are the v0.9.1 release manifest's (`https://herdr.dev/latest.json`) per-platform entries, each
// recomputed over the downloaded official asset before being committed (linux-x86_64 in schema/SOURCE.md via
// H2/H9; the other three against the same manifest on 2026-09-29).
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { HERDR_VERSION } from './constants.ts';

export type HerdrBinaryPlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

type PinnedAsset = { url: string; sha256: string };

const RELEASE = 'https://github.com/herdrdev/herdr/releases/download/v0.9.1';

const PINNED: Record<HerdrBinaryPlatform, PinnedAsset> = {
  'linux-x64': {
    url: `${RELEASE}/herdr-linux-x86_64`,
    sha256: '2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7',
  },
  'linux-arm64': {
    url: `${RELEASE}/herdr-linux-aarch64`,
    sha256: 'f4ccf4de745f2cb9a39a983e9ba3703dad50ec2a58dea83026ceab721bbd8d9e',
  },
  'darwin-x64': {
    url: `${RELEASE}/herdr-macos-x86_64`,
    sha256: '053be0639935fe54ab5efbdb46651054e4f6a753a5b43153c88bd6912bce1e94',
  },
  'darwin-arm64': {
    url: `${RELEASE}/herdr-macos-aarch64`,
    sha256: '5fc7a7e7adfaca56fa80aa89dcb025693357268dab8285b9ce2d08a2313c89de',
  },
};

/** The pinned asset (URL and sha256) for each platform this helper covers. */
export const HERDR_ASSETS: Record<HerdrBinaryPlatform, PinnedAsset> = PINNED;

const PLATFORMS: readonly HerdrBinaryPlatform[] = Object.keys(PINNED) as HerdrBinaryPlatform[];

function currentPlatform(): HerdrBinaryPlatform | undefined {
  const name = `${process.platform}-${process.arch}`;
  return PLATFORMS.includes(name as HerdrBinaryPlatform) ? (name as HerdrBinaryPlatform) : undefined;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export type EnsureHerdrOptions = {
  /** App-owned directory the binary lives in; created when missing. Never a shared location. */
  dir: string;
  /** Defaults to this computer's platform. Only the four pinned platforms are supported. */
  platform?: HerdrBinaryPlatform | string;
  /** Defaults to the pinned release. Anything else is refused: only the pinned hashes are committed. */
  version?: string;
  /** Override the pinned asset URL (tests serve a loopback fixture; mirrors). The hash is still verified. */
  url?: string;
  /** Override the expected sha256 (tests use their fixture's hash). The download is still verified. */
  sha256?: string;
};

// The release assets are ~24 MB; a body far past that is never the pinned binary.
const MAX_BYTES = 128 * 1024 * 1024;

async function download(url: string, dest: string, expected: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new Error('herdr: could not download the Herdr app (network failed); check the connection and try again');
  }
  if (!response.ok || !response.body) {
    throw new Error(`herdr: could not download the Herdr app (server answered ${response.status}); try again later`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const out = createWriteStream(dest, { mode: 0o600 });
  try {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new Error('herdr: the download is far bigger than the Herdr app; refusing it');
        hash.update(value);
        if (!out.write(value)) await once(out, 'drain');
      }
    } finally {
      reader.releaseLock();
    }
    out.end();
    await once(out, 'close');
  } catch (error) {
    try { unlinkSync(dest); } catch { /* already gone */ }
    throw error;
  }
  if (hash.digest('hex') !== expected) {
    try { unlinkSync(dest); } catch { /* already gone */ }
    throw new Error('herdr: the downloaded Herdr app failed its safety check, so it was deleted; try again later');
  }
}

/**
 * Make sure the pinned Herdr binary is in the app-owned `dir` and return its absolute path for
 * `HerdrKit` own mode. Downloads the pinned release asset only when the verified file is missing;
 * an existing file whose sha256 matches is returned without touching the network. A bad download
 * is refused and no file is left behind.
 */
export async function ensureHerdr(o: EnsureHerdrOptions): Promise<string> {
  if (o.version !== undefined && o.version !== HERDR_VERSION) {
    throw new Error(`herdr: this helper only fetches the pinned Herdr ${HERDR_VERSION}; install another version by hand`);
  }
  const platform = o.platform ?? currentPlatform();
  const asset = platform !== undefined ? PINNED[platform as HerdrBinaryPlatform] : undefined;
  if (platform === undefined || asset === undefined) {
    throw new Error(
      `herdr: no pinned Herdr app for "${o.platform ?? `${process.platform}-${process.arch}`}" ` +
      `(this helper covers ${PLATFORMS.join(', ')} at ${HERDR_VERSION}); install Herdr by hand`,
    );
  }
  const url = o.url ?? asset.url;
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    throw new Error('herdr: the download address must be an http(s) address');
  }
  const expected = o.sha256 ?? asset.sha256;
  mkdirSync(o.dir, { recursive: true });
  const dir = isAbsolute(o.dir) ? o.dir : resolve(o.dir);
  const bin = join(dir, 'herdr');
  if (existsSync(bin) && statSync(bin).isFile() && sha256File(bin) === expected) {
    chmodSync(bin, 0o755);
    return bin;
  }
  // The download lands beside its target so the rename below is atomic; a failed or tampered
  // download is deleted, never moved into place.
  const temp = join(dir, `.herdr-download-${process.pid}`);
  await download(url, temp, expected);
  chmodSync(temp, 0o755);
  renameSync(temp, bin);
  return bin;
}

/** Alias of `ensureHerdr` for the `fetchHerdr({ version, dir, platform? })` spelling. */
export const fetchHerdr = ensureHerdr;
