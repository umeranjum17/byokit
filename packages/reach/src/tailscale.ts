// Tailscale Serve as the way in, with muxr's rules (docs/decisions/0004 in muxr): the server stays on loopback behind a
// Serve mapping on the machine's MagicDNS name; Funnel is never used; a root handler someone else owns is never
// replaced; the mapping is removed only while it still matches the fingerprint recorded when it was made.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the tailscale CLI is. Tests pass a fake; by default it is `tailscale` on PATH, then the macOS app. */
export type TailscaleOptions = { bin?: string; timeoutMs?: number };

/** The Serve mapping this package made: persist it, and pass it back to `unserve` or `reach({ previous })`. */
export type ServeIngress = { kind: 'tailscale-serve'; port: number; dnsName: string; proxy: string };

export type ServeRoot = 'free' | 'ours' | 'occupied' | 'funnel' | 'disabled' | 'inconclusive';

export const SERVE_OWNED_ERROR = 'Tailscale Serve root is already owned by another service; use direct Tailscale or remove it yourself';
export const FUNNEL_ERROR = 'Funnel is on for this Serve root; reach never uses Funnel. Turn it off before continuing.';

type Run = { code: number | null; stdout: string; stderr: string; error?: { code?: string | number | null; message: string } };

const appBins = () => [join(homedir(), 'Applications/Tailscale.app/Contents/MacOS/Tailscale'), '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

function run1(bin: string, args: string[], timeout: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, encoding: 'utf8', env: { ...process.env, TAILSCALE_BE_CLI: '1' } }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      // A timeout kills the child; call it ETIMEDOUT like spawnSync does, so callers can say so.
      if (error.killed) return resolve({ code: null, stdout, stderr, error: { code: 'ETIMEDOUT', message: error.message } });
      if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr });
      resolve({ code: null, stdout, stderr, error });
    });
  });
}

async function run(args: string[], o: TailscaleOptions = {}): Promise<Run> {
  const bins = o.bin ? [o.bin] : ['tailscale', ...(process.platform === 'darwin' ? appBins() : [])];
  let r: Run = { code: null, stdout: '', stderr: '' };
  for (const bin of bins) {
    r = await run1(bin, args, o.timeoutMs ?? 15_000);
    if (r.error?.code !== 'ENOENT') return r;
  }
  return r;
}

/** A MagicDNS name, lower-cased and without the trailing dot, or undefined when it is not a valid DNS name. */
export function magicDnsName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/\.$/, '').toLowerCase();
  if (name.length === 0 || name.length > 253) return undefined;
  return name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? name : undefined;
}

/** `tailscale status --json`, reduced: undefined when Tailscale isn't installed; throws when it is but can't answer. */
export async function tailscaleStatus(o?: TailscaleOptions): Promise<{ dnsName?: unknown; ips: string[] } | undefined> {
  const r = await run(['status', '--json'], o);
  if (r.error?.code === 'ENOENT') return undefined;
  if (r.error?.code === 'ETIMEDOUT') throw new Error('Tailscale status timed out; restart tailscaled or choose LAN');
  if (r.code !== 0) throw new Error(`Tailscale is installed but unavailable: ${(r.stderr || r.error?.message || '').trim() || 'sign in first'}`);
  let s: { Self?: { DNSName?: unknown; TailscaleIPs?: unknown } };
  try { s = JSON.parse(r.stdout); } catch { throw new Error('Tailscale returned invalid status JSON'); }
  const ips = Array.isArray(s?.Self?.TailscaleIPs) ? s.Self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string') : [];
  return { dnsName: s?.Self?.DNSName, ips };
}

/** The machine's MagicDNS name, the Serve address. Missing or invalid is an error, never a guess at another address. */
export async function tailscaleName(o?: TailscaleOptions): Promise<string | undefined> {
  const s = await tailscaleStatus(o);
  if (s === undefined) return undefined;
  const name = magicDnsName(s.dnsName);
  if (name) return name;
  if (typeof s.dnsName !== 'string' || s.dnsName === '') {
    throw new Error('Tailscale MagicDNS name is unavailable. Enable MagicDNS, then retry, or choose direct Tailscale.');
  }
  throw new Error('Tailscale reported an invalid MagicDNS name, so no address was guessed. Check this computer’s DNS name in Tailscale, then retry or choose another connection.');
}

/** The root handler on :443 of `dnsName`, if present. */
export function serveRootProxy(status: unknown, dnsName: string): { Proxy?: unknown } | undefined {
  const web = (status as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> } | null)?.Web;
  return web?.[`${dnsName}:443`]?.Handlers?.['/'];
}

function serveFailure(r: Run): string {
  const output = [r.stderr, r.stdout].map((v) => v?.trim()).filter(Boolean).join('\n').slice(0, 2_000);
  if (/serve is not enabled on your tailnet/i.test(output)) {
    const enable = output.match(/https:\/\/login\.tailscale\.com\/[^\s<>"']+/)?.[0];
    return `Tailscale Serve is not enabled on your tailnet. ${enable ? `Enable it at ${enable}` : 'Enable it in the Tailscale admin console'}, then retry; or choose direct Tailscale or LAN.`;
  }
  if (r.error?.code === 'ETIMEDOUT') return `${output ? `${output}\n` : ''}Tailscale Serve did not finish before the timeout; restart Tailscale or choose direct Tailscale or LAN.`;
  return output || r.error?.message || 'Tailscale Serve command failed';
}

const loopback = (port: number) => `http://127.0.0.1:${port}`;

/** Who owns the Serve root on `dnsName`:443 now, compared with the proxy we would set (or did set). */
export async function inspectServe(port: number, dnsName: string, o?: TailscaleOptions & { proxy?: string }): Promise<{ status: ServeRoot; reason?: string; missing?: boolean }> {
  const r = await run(['serve', 'status', '--json'], o);
  if (r.error?.code === 'ENOENT') return { status: 'inconclusive', missing: true, reason: 'tailscale not found' };
  if (r.code !== 0 || r.error) {
    return { status: /serve is not enabled on your tailnet/i.test(`${r.stderr}\n${r.stdout}`) ? 'disabled' : 'inconclusive', reason: serveFailure(r) };
  }
  let status: { AllowFunnel?: Record<string, boolean> };
  try { status = JSON.parse(r.stdout || '{}'); }
  catch { return { status: 'inconclusive', reason: 'Tailscale Serve returned invalid status JSON' }; }
  if (status?.AllowFunnel?.[`${dnsName}:443`] === true) {
    return { status: 'funnel', reason: FUNNEL_ERROR };
  }
  const handler = serveRootProxy(status, dnsName);
  if (handler === undefined) return { status: 'free' };
  return { status: o?.proxy === loopback(port) && handler.Proxy === o.proxy ? 'ours' : 'occupied' };
}

/**
 * Publish `127.0.0.1:<port>` at `https://<MagicDNS name>` inside the tailnet (never Funnel). Refuses a root someone else
 * owns; reuses only a mapping recorded by this app. Returns undefined when Tailscale isn't installed.
 */
export async function serve(port: number, o?: TailscaleOptions, previous?: ServeIngress): Promise<{ url: string; ingress: ServeIngress; pendingCleanup?: ServeIngress } | undefined> {
  const dnsName = await tailscaleName(o);
  if (dnsName === undefined) return undefined;
  let pendingCleanup: ServeIngress | undefined;
  if (previous?.port === port && previous.dnsName !== dnsName) {
    try { await unserve(previous, o); }
    catch (error) {
      if (error instanceof Error && error.message === FUNNEL_ERROR) throw error;
      pendingCleanup = previous;
    }
  }
  const proxy = loopback(port);
  const recorded = previous?.kind === 'tailscale-serve' && previous.port === port && previous.dnsName === dnsName && previous.proxy === proxy;
  const root = await inspectServe(port, dnsName, { ...o, ...(recorded ? { proxy } : {}) });
  if (root.status === 'disabled' || root.status === 'inconclusive' || root.status === 'funnel') throw new Error(root.reason);
  if (root.status === 'occupied') throw new Error(SERVE_OWNED_ERROR);
  if (root.status === 'free') {
    const r = await run(['serve', '--yes', '--bg', '--https=443', proxy], o);
    if (r.code !== 0 || r.error) throw new Error(serveFailure(r));
    const after = await inspectServe(port, dnsName, { ...o, proxy });
    if (after.status === 'funnel') throw new Error(after.reason);
    if (after.status === 'occupied') throw new Error(`${SERVE_OWNED_ERROR}; another service took the Serve root after setup`);
    if (after.status !== 'ours') throw new Error('could not verify the Tailscale Serve route after setup');
  }
  return { url: `wss://${dnsName}`, ingress: { kind: 'tailscale-serve', port, dnsName, proxy }, ...(pendingCleanup ? { pendingCleanup } : {}) };
}

/** Remove a mapping `serve` made, only while Serve still points where it recorded. Returns whether it removed one. */
export async function unserve(ingress: ServeIngress | undefined, o?: TailscaleOptions): Promise<boolean> {
  if (ingress?.kind !== 'tailscale-serve' || ingress.proxy !== loopback(ingress.port)) return false;
  const root = await inspectServe(ingress.port, ingress.dnsName, { ...o, proxy: ingress.proxy });
  if (root.status === 'funnel') throw new Error(root.reason);
  if (root.missing) throw new Error('cannot inspect the previous Tailscale Serve route; leaving it unchanged');
  if (root.status === 'free' || root.status === 'occupied') return false;
  if (root.status !== 'ours') throw new Error('cannot inspect the previous Tailscale Serve route; leaving it unchanged');
  const r = await run(['serve', '--https=443', '--set-path=/', 'off'], o);
  if (r.code !== 0 || r.error) throw new Error(`could not remove the previous Tailscale Serve route: ${serveFailure(r)}`);
  const after = await inspectServe(ingress.port, ingress.dnsName, { ...o, proxy: ingress.proxy });
  if (after.status === 'funnel') throw new Error(after.reason);
  if (after.status === 'occupied') throw new Error(`${SERVE_OWNED_ERROR}; another service took the Serve root after removal`);
  if (after.status !== 'free') throw new Error('could not verify removal of the previous Tailscale Serve route');
  return true;
}
