// Node-only Hetzner first slice. Wire contract: https://docs.hetzner.cloud/cloud.spec.json.
import { isIP } from 'node:net';
import { join } from 'node:path';
import { sshVm, sshHostKey, type SshVmOptions } from './ssh.ts';
import { MachineError } from './errors.ts';
import type { MachineRef, MachineState, MachineStore, Price, Provider, Size } from './types.ts';

type Rates = { location: string; price_hourly: { net: string }; price_monthly: { net: string } };
type Server = { id: number; name: string; status: string; labels: Record<string, string>; server_type: { name: string }; public_net: { ipv4: { id: number; ip: string }; ipv6: { id: number } | null; firewalls: { id: number; status: string }[] } };
type Firewall = { id: number; labels: Record<string, string>; rules: Record<string, unknown>[] };
const SSH_RULE = { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0', '::/0'] };
const sshOnly = (f: Firewall): boolean => f.rules?.length === 1 && f.rules.every(r => r['direction'] === 'in' && r['protocol'] === 'tcp' && r['port'] === '22' && Array.isArray(r['source_ips']) && r['source_ips'].length === 2 && SSH_RULE.source_ips.every(ip => (r['source_ips'] as unknown[]).includes(ip)));
export type HetznerOptions = {
  baseUrl: string; label: string; project: string; location: string; image: string;
  key: () => Promise<string>; store: MachineStore; publicKey: string;
  ssh: Pick<SshVmOptions, 'ssh' | 'keyPath' | 'stateDir'>;
  fetch?: typeof fetch; signal?: AbortSignal;
};
export type HetznerProvider = Provider & { hostKey(m: MachineRef): ReturnType<typeof sshHostKey> };

export async function hetzner(o: HetznerOptions): Promise<HetznerProvider> {
  const base = new URL(o.baseUrl);
  if (!(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash) throw new MachineError('bad-recipe', 'baseUrl must be HTTPS or loopback, without credentials or query');
  if (!o.project || !o.location || !/^(ubuntu-\d{2}\.\d{2}|debian-\d+)$/.test(o.image) || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [^\r\n]*)?$/.test(o.publicKey)) throw new MachineError('bad-recipe', 'project, location, Ubuntu/Debian image and an ed25519 public key are required');
  const request = async <T>(method: string, path: string, body?: unknown, absent = false, cleanup = false): Promise<T | null> => {
    let key: string;
    try { key = await o.key(); } catch { throw new MachineError('unauthorized', 'the app could not supply the provider key'); }
    if (!key) throw new MachineError('unauthorized', 'the app supplied no provider key');
    let res: Response; let text: string;
    try {
      res = await (o.fetch ?? fetch)(`${o.baseUrl.replace(/\/$/, '')}${path}`, {
        method, redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: o.signal && !cleanup ? AbortSignal.any([o.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      text = await res.text();
    } catch { throw new MachineError('unreachable', 'the Hetzner API could not be reached'); }
    if (res.status === 401 || res.status === 403) throw new MachineError('unauthorized', 'the provider did not accept the key');
    if (res.status === 404 && absent) return null;
    if (!res.ok) throw new MachineError('provider', `Hetzner answered ${res.status}: ${text.replaceAll(key, '[masked]').slice(0, 200)}`, { status: String(res.status) });
    try { return text ? JSON.parse(text) as T : null; } catch { throw new MachineError('provider', 'Hetzner returned invalid JSON'); }
  };
  const list = async <T>(path: string, field: string, cleanup = false): Promise<T[]> => {
    const rows: T[] = []; let page: number | null = 1;
    while (page !== null) {
      const data: Record<string, unknown> | null = await request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=50&page=${page}`, undefined, false, cleanup);
      if (!data || !Array.isArray(data[field])) throw new MachineError('provider', `Hetzner returned no ${field} list`);
      rows.push(...data[field] as T[]);
      const next: number | null = (data['meta'] as { pagination?: { next_page?: number | null } } | undefined)?.pagination?.next_page ?? null;
      if (next !== null && (!Number.isInteger(next) || next <= page)) throw new MachineError('provider', 'Hetzner returned invalid pagination');
      page = next;
    }
    return rows;
  };
  const pricing = (await request<{ pricing: { currency: string; primary_ips: { type: string; prices: Rates[] }[]; server_types: { name: string; prices: Rates[] }[] } }>('GET', '/pricing'))?.pricing;
  if (!pricing || !['EUR', 'USD'].includes(pricing.currency) || !Array.isArray(pricing.server_types) || !Array.isArray(pricing.primary_ips)) throw new MachineError('provider', 'Hetzner returned unsupported pricing');
  const ips = ['ipv4', 'ipv6'].map(type => pricing.primary_ips.find(p => p.type === type)?.prices.find(p => p.location === o.location));
  if (ips.some(ip => !ip)) throw new MachineError('provider', 'Hetzner returned no primary IP price for this location');
  const types = await list<{ name: string; cores: number; memory: number; disk: number; cpu_type: string; locations: { name: string; available: boolean; deprecation: unknown }[] }>('/server_types', 'server_types');
  const sizes: Size[] = []; const prices: Price[] = [];
  for (const t of types.filter(t => t.cpu_type === 'shared' && Array.isArray(t.locations) && t.locations.some(l => l.name === o.location && l.available === true && l.deprecation === null)).sort((a, b) => a.cores - b.cores || a.memory - b.memory || a.disk - b.disk)) {
    const p = pricing.server_types.find(p => p.name === t.name)?.prices.find(p => p.location === o.location);
    if (!p) continue;
    const rates = [p, ...ips];
    if (!rates.every(p => [p?.price_hourly?.net, p?.price_monthly?.net].every(v => typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v)))) throw new MachineError('provider', 'Hetzner returned invalid decimal prices');
    const perHour = rates.reduce((sum, p) => sum + Number(p?.price_hourly.net), 0);
    const perMonthCap = rates.reduce((sum, p) => sum + Number(p?.price_monthly.net), 0);
    if (!t.name || ![t.cores, t.memory, t.disk, perHour, perMonthCap].every(n => Number.isFinite(n) && n > 0)) throw new MachineError('provider', 'Hetzner returned invalid size or price');
    sizes.push({ id: t.name, cpus: t.cores, memoryGb: t.memory, diskGb: t.disk });
    prices.push({ size: t.name, perHour, perMonthCap, asleepPerHour: perHour, currency: pricing.currency as 'EUR' | 'USD', basis: 'incl. IPv4 and IPv6, excl. VAT; bills while off', source: `${o.baseUrl}/pricing`, checked: new Date().toISOString().slice(0, 10) });
  }
  if (!sizes.length) throw new MachineError('unsupported', 'no available shared server type in this location');
  let selected = sizes[0].id;
  const server = async (m: MachineRef): Promise<Server> => {
    if (m.provider !== 'hetzner' || m.account !== o.project || !/^[1-9]\d*$/.test(m.id)) throw new MachineError('wrong-account', 'the ref belongs to another provider or project');
    const s = (await request<{ server: Server }>('GET', `/servers/${m.id}`, undefined, true))?.server;
    if (!s || String(s.id) !== m.id || s.name !== m.name || !s.labels?.['byokit-create']) throw new MachineError('wrong-account', 'the server is not visible as this app machine in this project');
    if (!s.server_type?.name || !s.public_net?.ipv4) throw new MachineError('provider', 'Hetzner returned incomplete server details');
    selected = s.server_type.name;
    return s;
  };
  const firewallFor = async (s: Server, applied = true): Promise<Firewall> => {
    const attached = s.public_net.firewalls;
    if (!Array.isArray(attached) || attached.length !== 1 || !Number.isSafeInteger(attached[0].id) || (applied && attached[0].status !== 'applied')) throw new MachineError('provider', 'the SSH-only firewall is not attached and applied');
    const f = (await request<{ firewall: Firewall }>('GET', `/firewalls/${attached[0].id}`))?.firewall;
    if (!f || f.labels?.['byokit-create'] !== s.labels['byokit-create'] || (applied && !sshOnly(f))) throw new MachineError('provider', 'the app firewall ownership or SSH-only rules changed');
    return f;
  };
  const connection = async (m: MachineRef): Promise<SshVmOptions> => {
    const s = await server(m); await firewallFor(s);
    if (!s.public_net?.ipv4 || isIP(s.public_net.ipv4.ip) !== 4) throw new MachineError('provider', 'Hetzner returned no IPv4 address');
    return { ...o.ssh, stateDir: join(o.ssh.stateDir, m.id), host: s.public_net.ipv4.ip, user: 'user', label: o.label };
  };
  const account = async (): Promise<string> => {
    const saved = (await o.store.load())?.ref;
    if (saved) await server(saved);
    return o.project;
  };
  const waitGone = async (path: string): Promise<void> => {
    const until = Date.now() + 300_000;
    while (await request('GET', path, undefined, true, true) !== null) {
      if (Date.now() >= until) throw new MachineError('timeout', 'Hetzner deletion was not confirmed');
      await new Promise(r => setTimeout(r, 2000));
    }
  };
  const destroy = async (s: Server | undefined, firewall: number): Promise<void> => {
    if (s) {
      await request('DELETE', `/servers/${s.id}`, undefined, true, true); await waitGone(`/servers/${s.id}`);
      for (const ip of [s.public_net?.ipv4, s.public_net?.ipv6]) if (ip && Number.isSafeInteger(ip.id)) {
        await request('DELETE', `/primary_ips/${ip.id}`, undefined, true, true); await waitGone(`/primary_ips/${ip.id}`);
      }
    }
    await request('DELETE', `/firewalls/${firewall}`, undefined, true, true); await waitGone(`/firewalls/${firewall}`);
  };
  return {
    id: 'hetzner', label: o.label, account, sizes: () => sizes,
    prices: () => [...prices].sort((a, b) => Number(b.size === selected) - Number(a.size === selected)),
    status: async m => {
      try {
        const s = await server(m);
        const states: Record<string, MachineState> = { running: 'on', initializing: 'creating', starting: 'waking', stopping: 'stopping', off: 'asleep', deleting: 'stopping', migrating: 'unknown', rebuilding: 'creating', unknown: 'unknown' };
        if (!states[s.status]) throw new MachineError('provider', 'Hetzner returned an unknown server state');
        return states[s.status];
      } catch (e) { if (e instanceof MachineError && (e.code === 'unreachable' || Number(e.extra['status']) === 429 || Number(e.extra['status']) >= 500)) return 'unknown'; throw e; }
    },
    exec: async (m, argv, opts) => sshVm(await connection(m)).exec(m, argv, opts),
    write: async (m, path, bytes, mode) => sshVm(await connection(m)).write(m, path, bytes, mode),
    hostKey: async m => sshHostKey(await connection(m)),
    create: async c => {
      if (c.keepCopies) throw new MachineError('unsupported', 'Hetzner copies are not supported in this slice');
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(c.name) || !/^[a-zA-Z0-9_-]{1,63}$/.test(c.idempotencyKey) || !sizes.some(s => s.id === c.size)) throw new MachineError('bad-recipe', 'invalid machine name, size or idempotency key');
      await account();
      const existing = await list<Server>(`/servers?name=${encodeURIComponent(c.name)}`, 'servers');
      if (existing.some(s => s.labels?.['byokit-create'] !== c.idempotencyKey || s.server_type?.name !== c.size)) throw new MachineError('exists', 'a server already uses this name');
      const user_data = '#cloud-config\n' + JSON.stringify({ users: [{ name: 'user', shell: '/bin/bash', sudo: 'ALL=(ALL) NOPASSWD:ALL', lock_passwd: true, ssh_authorized_keys: [o.publicKey] }], ssh_pwauth: false, disable_root: true, runcmd: [['loginctl', 'enable-linger', 'user']] });
      const owned = (s: Server): boolean => s.name === c.name && s.labels?.['byokit-create'] === c.idempotencyKey && Number.isSafeInteger(s.id) && s.id > 0;
      const firewalls = await list<Firewall>(`/firewalls?name=byokit-${c.name}`, 'firewalls');
      if (firewalls.some(f => f.labels?.['byokit-create'] !== c.idempotencyKey)) throw new MachineError('exists', 'another operation owns this firewall name');
      const f = firewalls[0] ?? (await request<{ firewall: Firewall }>('POST', '/firewalls', { name: `byokit-${c.name}`, labels: { 'byokit-create': c.idempotencyKey }, rules: [SSH_RULE] }))?.firewall;
      if (!f || !Number.isSafeInteger(f.id) || f.id <= 0 || f.labels?.['byokit-create'] !== c.idempotencyKey) throw new MachineError('provider', 'Hetzner returned no owned firewall id');
      let s: Server | undefined = existing[0];
      try {
        if (!sshOnly(f)) throw new MachineError('provider', 'the firewall must allow only inbound SSH 22/tcp');
        if (!s) {
          let created: Server | undefined;
          try { created = (await request<{ server: Server }>('POST', '/servers', { name: c.name, server_type: c.size, location: o.location, image: o.image, labels: { 'byokit-create': c.idempotencyKey }, user_data, firewalls: [{ firewall: f.id }], public_net: { enable_ipv4: true, enable_ipv6: true } }))?.server; }
          catch (e) { if (!(e instanceof MachineError) || e.code !== 'unreachable' || o.signal?.aborted) throw e; created = (await list<Server>(`/servers?name=${c.name}`, 'servers')).find(owned); if (!created) throw e; }
          if (!created || !owned(created)) throw new MachineError('provider', 'Hetzner returned no matching created server');
          s = created;
        }
        if (!s) throw new MachineError('provider', 'Hetzner returned no allocated server');
        const until = Date.now() + 300_000;
        while (s.public_net?.firewalls?.some(f => f.status === 'pending')) {
          if (Date.now() >= until) throw new MachineError('timeout', 'the firewall did not become applied');
          await new Promise(r => setTimeout(r, 2000));
          const current: Server | undefined = (await request<{ server: Server }>('GET', `/servers/${s.id}`))?.server;
          if (!current || !owned(current)) throw new MachineError('provider', 'the server disappeared during firewall attachment');
          s = current;
        }
        if ((await firewallFor(s)).id !== f.id) throw new MachineError('provider', 'the wrong firewall was attached');
        for (const ip of [s.public_net?.ipv4, s.public_net?.ipv6]) {
          if (!ip || !Number.isSafeInteger(ip.id) || ip.id <= 0) throw new MachineError('provider', 'Hetzner returned no primary IP id');
          await request('PUT', `/primary_ips/${ip.id}`, { auto_delete: true, labels: { 'byokit-create': c.idempotencyKey } });
        }
        selected = c.size;
        return { provider: 'hetzner', account: o.project, id: String(s.id), name: c.name, keepCopies: false };
      } catch (e) {
        const reason = e instanceof MachineError ? e.message : 'invalid Hetzner response';
        try { s ??= (await list<Server>(`/servers?name=${c.name}`, 'servers', true)).find(owned); await destroy(s, f.id); }
        catch (cleanup) { throw new MachineError('provider', `setup failed: ${reason}; cleanup failed: ${cleanup instanceof MachineError ? cleanup.message : 'invalid response'}`, { machine: String(s?.id ?? ''), firewall: String(f.id), operation: c.idempotencyKey }); }
        throw new MachineError('provider', `setup failed; allocated resources deleted: ${reason}`);
      }
    },
    remove: async (m, confirm) => {
      if (confirm !== m.id) throw new MachineError('confirm', 'confirm must equal the machine id');
      const s = await server(m);
      const ips = [s.public_net.ipv4, s.public_net.ipv6].filter(ip => ip !== null);
      for (const ip of ips) {
        const info = (await request<{ primary_ip: { auto_delete: boolean; labels: Record<string, string> } }>('GET', `/primary_ips/${ip.id}`))?.primary_ip;
        if (!info?.auto_delete || info.labels?.['byokit-create'] !== s.labels['byokit-create']) throw new MachineError('provider', 'primary IP ownership or auto-delete changed; refusing deletion');
      }
      await destroy(s, (await firewallFor(s, false)).id);
    },
  };
}
