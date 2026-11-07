// The pinned nats-server release: one archive per platform, its sha256 committed here, checked over the download before
// anything is unpacked. Nothing downloads on install or import, and never from PATH: a machine's own nats-server may be
// years older. Licence: nats-server is Apache-2.0 (github.com/nats-io/nats-server/blob/v2.15.2/LICENSE).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NatsError } from './error.ts';

export const NATS_VERSION = '2.15.2';
export type NatsPlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';
export type NatsAsset = { url: string; sha256: string; folder: string };

const RELEASE = `https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}`;
const asset = (os: string, sha256: string): NatsAsset => ({ url: `${RELEASE}/nats-server-v${NATS_VERSION}-${os}.tar.gz`, folder: `nats-server-v${NATS_VERSION}-${os}`, sha256 });
// Each sha256 is the release's SHA256SUMS line, recomputed over the download.
export const NATS_ASSETS: Record<NatsPlatform, NatsAsset> = {
  'linux-x64': asset('linux-amd64', '67cb8e10bc6f0c4b47f75a728529a20953dbae2a4f9a4a52ae8517d65ae303ff'),
  'linux-arm64': asset('linux-arm64', 'bc2c788dcbf2849af749564e06a0d48c19bced851f2d68a2e21c54d078949b28'),
  'darwin-x64': asset('darwin-amd64', '9c45b23c19498692e81cd39c75e8382f0e6ff59c0d5b9470e32fe6640afa4446'),
  'darwin-arm64': asset('darwin-arm64', 'cbd2219d01502c38733485ac684269da585ee479fa3b1377264beecdefdf9e9d'),
};

const MAX_BYTES = 64 * 1024 * 1024; // the archives are ~7 MB

/** The server's absolute path in `dir`, downloaded and verified when missing. A bad download leaves nothing behind. */
export async function fetchNats(o: { dir: string; platform?: string; source?: NatsAsset; fetch?: typeof fetch }): Promise<string> {
  const platform = o.platform ?? `${process.platform}-${process.arch}`;
  const src = o.source ?? NATS_ASSETS[platform as NatsPlatform];
  if (src === undefined) throw new NatsError('unsupported-platform', `nats: no pinned NATS server for "${platform}" (covers ${Object.keys(NATS_ASSETS).join(', ')} at ${NATS_VERSION})`);
  const bin = join(o.dir, 'nats-server'), stamp = `${bin}.sha256`;
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  // The archive's hash is what we trust, so it is stamped beside the unpacked binary; the binary alone is never re-trusted.
  if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, 'utf8') === src.sha256) return bin;
  let res: Response;
  try { res = await (o.fetch ?? fetch)(src.url, { signal: AbortSignal.timeout(120_000) }); }
  catch (cause) { throw new NatsError('download-failed', 'nats: could not download the NATS server (network failed)', { cause }); }
  if (!res.ok) throw new NatsError('download-failed', `nats: could not download the NATS server (server answered ${res.status})`, { detail: { status: res.status } });
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength > MAX_BYTES) throw new NatsError('download-failed', 'nats: the download is far bigger than the NATS server; refusing it');
  if (createHash('sha256').update(body).digest('hex') !== src.sha256) throw new NatsError('checksum-failed', 'nats: the downloaded NATS server failed its sha256 check, so it was not kept');
  const work = mkdtempSync(join(o.dir, '.unpack-'));
  try {
    writeFileSync(join(work, 'a.tgz'), body);
    const untar = spawnSync('tar', ['-xzf', 'a.tgz'], { cwd: work, encoding: 'utf8' }), inner = join(work, src.folder, 'nats-server');
    if (untar.status !== 0 || !existsSync(inner)) throw new NatsError('unpack-failed', 'nats: the downloaded NATS server could not be unpacked');
    chmodSync(inner, 0o755);
    renameSync(inner, bin);
    writeFileSync(stamp, src.sha256);
  } finally { rmSync(work, { recursive: true, force: true }); }
  return bin;
}
