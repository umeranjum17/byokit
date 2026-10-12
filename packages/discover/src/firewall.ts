// A non-root "is a firewall blocking this port" helper for onboarding: before setup prints its tick, it can say
// whether the computer's own firewall would stop the phone reaching `port`. It only reads firewall state with the
// person's normal permissions and never asks for administrator access: a state it cannot read is reported as
// 'unknown', honestly, with a plain next step. Node only (it shells out); the phone never calls this.
import { execFile } from 'node:child_process';

export type FirewallBlocked = true | false | 'unknown';

/** What the local firewall says about inbound on a port, in everyday words. */
export type FirewallVerdict = {
  /** True when a readable rule blocks the port, false when the firewall is off or lets it through, 'unknown'
   *  when nothing readable says either way (including when reading needs administrator access). */
  blocked: FirewallBlocked;
  /** Which firewall was read and what it said. */
  how: string;
  /** What the person should do next, in plain words. Never a sudo command. */
  nextStep: string;
};

export type FirewallRun = { code: number | null; stdout: string; stderr: string };

export type FirewallOptions = {
  port: number;
  /** Defaults to `process.platform`; tests pass a fake platform for the other systems' output. */
  platform?: NodeJS.Platform;
  /** Runs one command; tests pass stubbed output. Defaults to a real `execFile` with a timeout. */
  run?: (bin: string, args: string[]) => Promise<FirewallRun>;
  /** How long one command gets (default 10_000). */
  timeoutMs?: number;
};

const CLEAR = (port: number) =>
  `No next step: the firewall is not blocking port ${port}. If the phone still cannot reach it, the Wi-Fi or router may be in the way.`;
const ALLOW = (port: number, name: string) =>
  `Allow incoming connections on port ${port} in ${name}, then run this check again.`;
const ELEVATE = (port: number) =>
  `This could not be checked without administrator access. If the phone cannot reach port ${port}, look at this computer's firewall settings first.`;

function realRun(timeoutMs: number): NonNullable<FirewallOptions['run']> {
  return (bin, args) => new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr });
      return resolve({ code: null, stdout, stderr });
    });
  });
}

/** True when the command never ran (missing binary) rather than ran and refused. */
const missing = (r: FirewallRun) => r.code === null && /ENOENT|not found|not recognized/i.test(r.stderr);

/** A ufw rule line naming `port` with an action, e.g. `8792/tcp DENY IN Anywhere`. */
function ufwRule(stdout: string, port: number): 'deny' | 'allow' | undefined {
  let found: 'deny' | 'allow' | undefined;
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)(?:\/(tcp|udp))?\s+(ALLOW|DENY|REJECT|LIMIT)\b/i);
    if (!m || +m[1]! !== port) continue;
    if (/DENY|REJECT/i.test(m[3]!)) return 'deny';
    found = 'allow';
  }
  return found;
}

async function linux(port: number, run: NonNullable<FirewallOptions['run']>): Promise<FirewallVerdict> {
  const ufw = await run('ufw', ['status']);
  if (ufw.code === 0) {
    if (/Status:\s*inactive/i.test(ufw.stdout))
      return { blocked: false, how: `UFW is installed but switched off, so it is not blocking port ${port}.`, nextStep: CLEAR(port) };
    const rule = ufwRule(ufw.stdout, port);
    if (rule === 'deny')
      return { blocked: true, how: `UFW is on and has a rule refusing port ${port}.`, nextStep: ALLOW(port, 'UFW') };
    if (rule === 'allow')
      return { blocked: false, how: `UFW is on and has a rule allowing port ${port}.`, nextStep: CLEAR(port) };
    return { blocked: 'unknown', how: `UFW is on but has no rule naming port ${port}; its default policy may still drop inbound.`, nextStep: ELEVATE(port) };
  }
  if (!missing(ufw)) {
    const refused = /root|permission|denied/i.test(`${ufw.stdout}\n${ufw.stderr}`);
    if (refused) return refusedLinux(port);
  }
  const nft = await run('nft', ['list', 'ruleset']);
  if (nft.code === 0) {
    const hits = nft.stdout.split('\n').filter((l) => new RegExp(`\\bdport\\b[^\\n]*\\b${port}\\b`).test(l));
    if (hits.some((l) => /\b(drop|reject)\b/i.test(l)))
      return { blocked: true, how: `nftables has a rule dropping inbound on port ${port}.`, nextStep: ALLOW(port, 'the firewall') };
    if (hits.some((l) => /\baccept\b/i.test(l)))
      return { blocked: false, how: `nftables has a rule accepting inbound on port ${port}.`, nextStep: CLEAR(port) };
    return { blocked: 'unknown', how: `The nftables rules were read but none names port ${port}.`, nextStep: ELEVATE(port) };
  }
  if (!missing(nft)) {
    const refused = /permission|denied|not permitted/i.test(`${nft.stdout}\n${nft.stderr}`);
    if (refused) return refusedLinux(port);
  }
  const ip = await run('iptables', ['-S']);
  if (ip.code === 0) {
    const hits = ip.stdout.split('\n').filter((l) => new RegExp(`--dport\\s+${port}\\b`).test(l));
    if (hits.some((l) => /\s-j\s+(DROP|REJECT)\b/.test(l)))
      return { blocked: true, how: `iptables has a rule dropping inbound on port ${port}.`, nextStep: ALLOW(port, 'the firewall') };
    if (hits.some((l) => /\s-j\s+ACCEPT\b/.test(l)))
      return { blocked: false, how: `iptables has a rule accepting inbound on port ${port}.`, nextStep: CLEAR(port) };
    return { blocked: 'unknown', how: `The iptables rules were read but none names port ${port}.`, nextStep: ELEVATE(port) };
  }
  return refusedLinux(port);
}

const refusedLinux = (port: number): FirewallVerdict => ({
  blocked: 'unknown',
  how: 'No firewall state could be read without administrator access (UFW, nftables and iptables all refused).',
  nextStep: ELEVATE(port),
});

async function darwin(port: number, run: NonNullable<FirewallOptions['run']>): Promise<FirewallVerdict> {
  const bins = ['/usr/libexec/ApplicationFirewall/socketfilterfw', 'socketfilterfw'];
  let state: FirewallRun = { code: null, stdout: '', stderr: 'missing' };
  for (const bin of bins) {
    state = await run(bin, ['--getglobalstate']);
    if (!missing(state)) break;
  }
  if (missing(state))
    return { blocked: 'unknown', how: 'The macOS application firewall tool could not be found.', nextStep: ELEVATE(port) };
  if (/disabled|state\s*=\s*0/i.test(state.stdout))
    return { blocked: false, how: `The macOS firewall is switched off, so it is not blocking port ${port}.`, nextStep: CLEAR(port) };
  if (!/enabled|state\s*=\s*1/i.test(state.stdout))
    return { blocked: 'unknown', how: 'The macOS firewall state could not be understood.', nextStep: ELEVATE(port) };
  let blockAll: FirewallRun = { code: null, stdout: '', stderr: 'missing' };
  for (const bin of bins) {
    blockAll = await run(bin, ['--getblockall']);
    if (!missing(blockAll)) break;
  }
  if (blockAll.code === 0 && /enable/i.test(blockAll.stdout) && !/disable/i.test(blockAll.stdout))
    return { blocked: true, how: 'The macOS firewall is on and set to block all incoming connections.', nextStep: ALLOW(port, 'System Settings under Network, Firewall') };
  return {
    blocked: 'unknown',
    how: `The macOS firewall is on but decides per app, not per port, so port ${port} cannot be answered from here.`,
    nextStep: `In System Settings under Network, Firewall, make sure this app is allowed to accept incoming connections, then try again.`,
  };
}

async function win32(port: number, run: NonNullable<FirewallOptions['run']>): Promise<FirewallVerdict> {
  const profiles = await run('netsh', ['advfirewall', 'show', 'allprofiles', 'state']);
  if (profiles.code !== 0 || missing(profiles))
    return { blocked: 'unknown', how: 'The Windows Firewall state could not be read.', nextStep: ELEVATE(port) };
  if (!/\bON\b/i.test(profiles.stdout))
    return { blocked: false, how: `Windows Firewall is off on every profile, so it is not blocking port ${port}.`, nextStep: CLEAR(port) };
  const rules = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in']);
  if (rules.code === 0) {
    const blocks = rules.stdout.split('\n\n').filter((b) =>
      /\bEnabled:\s*Yes/i.test(b) && /\bAction:\s*Block/i.test(b) &&
      (/\bLocalPort:\s*Any\b/i.test(b) || new RegExp(`\\bLocalPort:[^\\n]*\\b${port}\\b`).test(b)));
    if (blocks.length)
      return { blocked: true, how: `Windows Firewall is on and has an enabled inbound rule blocking port ${port}.`, nextStep: ALLOW(port, 'Windows Defender Firewall') };
  }
  return {
    blocked: 'unknown',
    how: `Windows Firewall is on but no enabled inbound rule naming port ${port} was found; a rule this reader cannot parse may still apply.`,
    nextStep: ELEVATE(port),
  };
}

/**
 * Would the local host firewall block inbound on `port`? Reads only what a normal user may read and never asks
 * for administrator access: anything unreadable is 'unknown', which callers must treat as "check another way",
 * never as blocked or clear.
 */
export async function firewall(o: FirewallOptions): Promise<FirewallVerdict> {
  const { port } = o;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1-65535');
  const run = o.run ?? realRun(o.timeoutMs ?? 10_000);
  const platform = o.platform ?? process.platform;
  if (platform === 'linux') return linux(port, run);
  if (platform === 'darwin') return darwin(port, run);
  if (platform === 'win32') return win32(port, run);
  return { blocked: 'unknown', how: `Firewalls on ${platform} are not checked.`, nextStep: ELEVATE(port) };
}
