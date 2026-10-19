// Hetzner over HTTPS only (G8), portable: create, status and confirmed delete with the app's token.
// `firstBoot` installs the recipe through cloud-init, so no shell into the machine is needed.
// The Node entry (hetzner.ts) adds exec and write over SSH. Wire contract: https://docs.hetzner.cloud/cloud.spec.json.
import { MachineError } from './errors.ts';
import { installScript, type InstallScriptOptions } from './script.ts';
import type { HostRecipe, MachineRef, MachineState, MachineStore, Price, Provider, Size } from './types.ts';

type Rates = { location: string; price_hourly: { net: string }; price_monthly: { net: string } };
type Server = { id: number; name: string; status: string; labels: Record<string, string>; server_type: { name: string }; public_net: { ipv4: { id: number; ip: string }; firewalls: { id: number; status: string }[] } };
type Firewall = { id: number; labels: Record<string, string>; rules: Record<string, unknown>[] };
const SSH_RULE = { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0'] };
const sshOnly = (f: Firewall): boolean => f.rules?.length === 1 && f.rules.every(r => r['direction'] === 'in' && r['protocol'] === 'tcp' && r['port'] === '22' && Array.isArray(r['source_ips']) && r['source_ips'].length === 1 && SSH_RULE.source_ips.every(ip => (r['source_ips'] as unknown[]).includes(ip)));
/** Extra `POST /servers` fields in Hetzner's own names; the kit's name, type, location, image, label, user_data, firewall and IPv4 win. */
export type HetznerServerExtras = {
  ssh_keys?: (number | string)[]; volumes?: number[]; networks?: number[]; placement_group?: number; automount?: boolean;
  labels?: Record<string, string>; public_net?: { enable_ipv6?: boolean }; [field: string]: unknown;
};
export type HetznerApiOptions = {
  baseUrl: string; label: string; project: string; location: string; image: string;
  key: () => Promise<string>; store: MachineStore;
  publicKey?: string;                                        // opens SSH 22/tcp; absent, the firewall lets nothing in
  firstBoot?: { recipe: HostRecipe } & InstallScriptOptions; // cloud-init installs it on first boot (recipe.name = machine name)
  server?: HetznerServerExtras;
  cloudConfig?: Record<string, unknown>;                     // extra cloud-config keys; its write_files and runcmd come before the kit's install
  fetch?: typeof fetch; signal?: AbortSignal;
};
export type HetznerApiProvider = Provider & {
  /** The server's IPv4 after the ownership and app-firewall checks. */
  address(m: MachineRef): Promise<string>;
  /** Any other Hetzner Cloud call with the same key, masking and typed errors; null for an empty answer. */
  request<T>(method: string, path: string, body?: unknown): Promise<T | null>;
};

export async function hetznerApi(o: HetznerApiOptions): Promise<HetznerApiProvider> {
  const base = new URL(o.baseUrl);
  if (!(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash) throw new MachineError('bad-recipe', 'baseUrl must be HTTPS or loopback, without credentials or query');
  if (!o.project || !o.location || !/^(ubuntu-\d{2}\.\d{2}|debian-\d+)$/.test(o.image) || (o.publicKey !== undefined && !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [^\r\n]*)?$/.test(o.publicKey))) throw new MachineError('bad-recipe', 'project, location, Ubuntu/Debian image and an ed25519 public key are required');
  if (o.firstBoot) installScript(o.firstBoot.recipe, o.firstBoot);
  const ruled = (f: Firewall): boolean => o.publicKey === undefined ? Array.isArray(f.rules) && f.rules.length === 0 : sshOnly(f);
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
  const ip = pricing.primary_ips.find(p => p.type === 'ipv4')?.prices.find(p => p.location === o.location);
  if (!ip) throw new MachineError('provider', 'Hetzner returned no primary IP price for this location');
  const types = await list<{ name: string; cores: number; memory: number; disk: number; cpu_type: string; locations: { name: string; available: boolean; deprecation: unknown }[] }>('/server_types', 'server_types');
  const sizes: Size[] = []; const prices: Price[] = [];
  for (const t of types.filter(t => t.cpu_type === 'shared' && Array.isArray(t.locations) && t.locations.some(l => l.name === o.location && l.available === true && l.deprecation === null)).sort((a, b) => a.cores - b.cores || a.memory - b.memory || a.disk - b.disk)) {
    const p = pricing.server_types.find(p => p.name === t.name)?.prices.find(p => p.location === o.location);
    if (!p) continue;
    const rates = [p, ip];
    if (!rates.every(p => [p?.price_hourly?.net, p?.price_monthly?.net].every(v => typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v)))) throw new MachineError('provider', 'Hetzner returned invalid decimal prices');
    const perHour = rates.reduce((sum, p) => sum + Number(p?.price_hourly.net), 0);
    const perMonthCap = rates.reduce((sum, p) => sum + Number(p?.price_monthly.net), 0);
    if (!t.name || ![t.cores, t.memory, t.disk, perHour, perMonthCap].every(n => Number.isFinite(n) && n > 0)) throw new MachineError('provider', 'Hetzner returned invalid size or price');
    sizes.push({ id: t.name, cpus: t.cores, memoryGb: t.memory, diskGb: t.disk });
    prices.push({ size: t.name, perHour, perMonthCap, asleepPerHour: perHour, currency: pricing.currency as 'EUR' | 'USD', basis: 'incl. IPv4, excl. VAT; bills while off', source: `${o.baseUrl}/pricing`, checked: new Date().toISOString().slice(0, 10) });
  }
  if (!sizes.length) throw new MachineError('unsupported', 'no available shared server type in this location');
  const serverOrNull = async (m: MachineRef): Promise<Server | null> => {
    if (m.provider !== 'hetzner' || m.account !== o.project || !/^[1-9]\d*$/.test(m.id)) throw new MachineError('wrong-account', 'the ref belongs to another provider or project');
    return (await request<{ server: Server }>('GET', `/servers/${m.id}`, undefined, true))?.server ?? null;
  };
  const checkServer = (m: MachineRef, s: Server | null): Server => {
    if (!s || String(s.id) !== m.id || s.name !== m.name || !s.labels?.['byokit-create']) throw new MachineError('wrong-account', 'the server is not visible as this app machine in this project');
    if (!s.server_type?.name || !s.public_net?.ipv4) throw new MachineError('provider', 'Hetzner returned incomplete server details');
    return s;
  };
  const server = async (m: MachineRef): Promise<Server> => checkServer(m, await serverOrNull(m));
  const firewallFor = async (s: Server): Promise<Firewall> => {
    const attached = s.public_net.firewalls;
    if (!Array.isArray(attached) || attached.length !== 1 || !Number.isSafeInteger(attached[0].id) || attached[0].status !== 'applied') throw new MachineError('provider', 'the app firewall is not attached and applied; re-attach the app firewall or remove the machine');
    const f = (await request<{ firewall: Firewall }>('GET', `/firewalls/${attached[0].id}`, undefined, true))?.firewall;
    if (!f || f.labels?.['byokit-create'] !== s.labels['byokit-create'] || !ruled(f)) throw new MachineError('provider', 'the app firewall ownership or rules changed; re-attach the app firewall or remove the machine');
    return f;
  };
  const address = async (m: MachineRef): Promise<string> => {
    const s = await server(m); await firewallFor(s);
    const ip = s.public_net?.ipv4?.ip;
    if (typeof ip !== 'string' || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split('.').some(n => Number(n) > 255)) throw new MachineError('provider', 'Hetzner returned no IPv4 address');
    return ip;
  };
  const account = async (): Promise<string> => {
    const saved = (await o.store.load())?.ref;
    if (saved) { const s = await serverOrNull(saved); if (s) checkServer(saved, s); }
    return o.project;
  };
  const waitGone = async (path: string): Promise<void> => {
    const until = Date.now() + 300_000;
    while (await request('GET', path, undefined, true, true) !== null) {
      if (Date.now() >= until) throw new MachineError('timeout', 'Hetzner deletion was not confirmed');
      await new Promise(r => setTimeout(r, 2000));
    }
  };
  const destroy = async (s: Server | undefined, firewall?: number): Promise<void> => {
    if (s) {
      await request('DELETE', `/servers/${s.id}`, undefined, true, true); await waitGone(`/servers/${s.id}`);
      const ip = s.public_net?.ipv4;
      if (ip && Number.isSafeInteger(ip.id)) {
        await request('DELETE', `/primary_ips/${ip.id}`, undefined, true, true); await waitGone(`/primary_ips/${ip.id}`);
      }
    }
    if (firewall !== undefined) {
      await request('DELETE', `/firewalls/${firewall}`, undefined, true, true); await waitGone(`/firewalls/${firewall}`);
    }
  };
  const sweepFirewalls = async (name: string): Promise<void> => {
    const attached = new Set((await list<Server>('/servers', 'servers')).flatMap(s => s.public_net?.firewalls ?? []).map(a => a.id));
    for (const f of await list<Firewall>('/firewalls', 'firewalls')) if (f.labels?.['byokit-name'] === name && f.labels?.['byokit-create'] && !attached.has(f.id)) await destroy(undefined, f.id);
  };
  return {
    id: 'hetzner', label: o.label, account, sizes: () => sizes, address,
    request: (method, path, body) => request(method, path, body),
    prices: () => [...prices],
    status: async m => {
      try {
        const s = await server(m);
        const states: Record<string, MachineState> = { running: 'on', initializing: 'creating', starting: 'waking', stopping: 'stopping', off: 'asleep', deleting: 'stopping', migrating: 'unknown', rebuilding: 'creating', unknown: 'unknown' };
        if (!states[s.status]) throw new MachineError('provider', 'Hetzner returned an unknown server state');
        return states[s.status];
      } catch (e) { if (e instanceof MachineError && (e.code === 'unreachable' || Number(e.extra['status']) === 429 || Number(e.extra['status']) >= 500)) return 'unknown'; throw e; }
    },
    exec: async () => { throw new MachineError('unsupported', 'this computer installs on first boot; the phone has no shell into it'); },
    write: async () => { throw new MachineError('unsupported', 'this computer installs on first boot; the phone has no shell into it'); },
    create: async c => {
      if (c.keepCopies) throw new MachineError('unsupported', 'Hetzner copies are not supported in this slice');
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(c.name) || !/^[a-zA-Z0-9_-]{1,63}$/.test(c.idempotencyKey) || !sizes.some(s => s.id === c.size)) throw new MachineError('bad-recipe', 'invalid machine name, size or idempotency key');
      await account();
      const existing = await list<Server>(`/servers?name=${encodeURIComponent(c.name)}`, 'servers');
      if (existing.some(s => s.labels?.['byokit-create'] !== c.idempotencyKey || s.server_type?.name !== c.size)) throw new MachineError('exists', 'a server already uses this name');
      const boot = o.firstBoot;
      if (boot && boot.recipe.name !== c.name) throw new MachineError('bad-recipe', 'name: the first-boot recipe name must equal the machine name');
      const cc = o.cloudConfig ?? {}; const more = (k: string): unknown[] => Array.isArray(cc[k]) ? cc[k] as unknown[] : [];
      const setupPath = `/var/lib/byokit/setup-${c.name}.sh`;
      const user_data = '#cloud-config\n' + JSON.stringify({
        ...cc, ssh_pwauth: false, disable_root: true,
        users: [{ name: 'user', shell: '/bin/bash', sudo: 'ALL=(ALL) NOPASSWD:ALL', lock_passwd: true, ...(o.publicKey ? { ssh_authorized_keys: [o.publicKey] } : {}) }, ...more('users')],
        write_files: [...more('write_files'), ...(boot ? [{ path: setupPath, permissions: '0700', owner: 'root:root', encoding: 'b64', content: btoa(Array.from(new TextEncoder().encode(installScript(boot.recipe, boot)), b => String.fromCharCode(b)).join('')) }] : [])],
        runcmd: [...more('runcmd'), ['loginctl', 'enable-linger', 'user'], ...(boot ? [['sh', setupPath, 'user']] : [])],
      });
      const owned = (s: Server): boolean => s.name === c.name && s.labels?.['byokit-create'] === c.idempotencyKey && Number.isSafeInteger(s.id) && s.id > 0;
      const firewallName = `byokit-${c.idempotencyKey}`;
      const [same] = await list<Firewall>(`/firewalls?name=${encodeURIComponent(firewallName)}`, 'firewalls');
      if (same && same.labels?.['byokit-create'] !== c.idempotencyKey) throw new MachineError('exists', 'another operation owns this firewall name');
      const f = same ?? (await request<{ firewall: Firewall }>('POST', '/firewalls', { name: firewallName, labels: { 'byokit-create': c.idempotencyKey, 'byokit-name': c.name }, rules: o.publicKey ? [SSH_RULE] : [] }))?.firewall;
      if (!f || !Number.isSafeInteger(f.id) || f.id <= 0 || f.labels?.['byokit-create'] !== c.idempotencyKey) throw new MachineError('provider', 'Hetzner returned no owned firewall id');
      let s: Server | undefined = existing[0];
      try {
        if (!ruled(f)) throw new MachineError('provider', o.publicKey ? 'the firewall must allow only inbound SSH 22/tcp' : 'the firewall must allow nothing inbound');
        if (!s) {
          let created: Server | undefined;
          try { created = (await request<{ server: Server }>('POST', '/servers', { ...o.server, name: c.name, server_type: c.size, location: o.location, image: o.image, labels: { ...o.server?.labels, 'byokit-create': c.idempotencyKey }, user_data, firewalls: [{ firewall: f.id }], public_net: { enable_ipv6: false, ...o.server?.public_net, enable_ipv4: true } }))?.server; }
          catch (e) {
            const ambiguous = e instanceof MachineError && (e.code === 'unreachable' || Number(e.extra['status']) >= 500);
            if (!ambiguous || o.signal?.aborted) throw e;
            const until = Date.now() + 30_000;
            do {
              created = (await list<Server>(`/servers?name=${c.name}`, 'servers')).find(owned);
              if (!created && Date.now() < until) await new Promise(r => setTimeout(r, 2000));
            } while (!created && Date.now() < until);
            if (!created) throw e;
          }
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
        const ip = s.public_net?.ipv4;
        if (!ip || !Number.isSafeInteger(ip.id) || ip.id <= 0) throw new MachineError('provider', 'Hetzner returned no primary IP id');
        await request('PUT', `/primary_ips/${ip.id}`, { auto_delete: true, labels: { 'byokit-create': c.idempotencyKey } });
        return { provider: 'hetzner', account: o.project, id: String(s.id), name: c.name, keepCopies: false };
      } catch (e) {
        const reason = e instanceof MachineError ? e.message : 'invalid Hetzner response';
        try { s ??= (await list<Server>(`/servers?name=${c.name}`, 'servers', true)).find(owned); await destroy(s, f.id); }
        catch (cleanup) { throw new MachineError('provider', `setup failed: ${reason}; cleanup failed: ${cleanup instanceof MachineError ? cleanup.message : 'invalid response'}`, { ...(s ? { machine: String(s.id) } : {}), name: c.name, firewall: String(f.id), operation: c.idempotencyKey }); }
        throw new MachineError('provider', `setup failed; allocated resources deleted: ${reason}`);
      }
    },
    remove: async (m, confirm) => {
      if (confirm !== m.id) throw new MachineError('confirm', 'confirm must equal the machine id');
      const found = await serverOrNull(m);
      if (found === null) {
        await sweepFirewalls(m.name);
        return;
      }
      const s = checkServer(m, found);
      const ip = s.public_net.ipv4;
      const info = (await request<{ primary_ip: { auto_delete: boolean; labels: Record<string, string> } }>('GET', `/primary_ips/${ip.id}`))?.primary_ip;
      if (!info?.auto_delete || info.labels?.['byokit-create'] !== s.labels['byokit-create']) throw new MachineError('provider', 'primary IP ownership or auto-delete changed; refusing deletion');
      await destroy(s);
      await sweepFirewalls(m.name);
    },
  };
}
