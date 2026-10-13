// Loopback Hetzner HTTP bench; requests retain no Authorization value.
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
export async function startFakeHetznerServer() {
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const servers = new Map<number, Record<string, unknown>>();
  const ips = new Map<number, { auto_delete: boolean; labels: Record<string, string> }>();
  const firewalls = new Map<number, Record<string, unknown>>();
  let nextFirewall = 100; let detach = false;
  let next = 1; let drop = false; let hiddenLists = 0; let failedCreateHidden: number | null = null;
  let failure: { status: number; message: string; path?: string } | null = null;
  const rate = (hour: string, month: string) => ({ location: 'fsn1', price_hourly: { net: hour }, price_monthly: { net: month } });
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const b of req) chunks.push(b as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    const url = new URL(req.url ?? '/', 'http://127.0.0.1'); const path = url.pathname.replace(/^\/v1/, '');
    const method = req.method ?? 'GET'; requests.push({ method, path: path + url.search, body });
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== 'Bearer test-key') return send(401, { error: { code: 'unauthorized', message: 'invalid key' } });
    if (failure && (!failure.path || failure.path === path)) { const f = failure; failure = null; return send(f.status, { error: { message: f.message } }); }
    if (path === '/pricing') return send(200, { pricing: { currency: 'EUR', primary_ips: [{ type: 'ipv4', prices: [rate('0.001', '0.6')] }], server_types: [{ name: 'small', prices: [rate('0.005', '3')] }, { name: 'large', prices: [rate('0.01', '6')] }] } });
    if (path === '/server_types') {
      const page = Number(url.searchParams.get('page'));
      return send(200, { server_types: [{ name: page === 1 ? 'large' : 'small', cores: page === 1 ? 4 : 2, memory: page === 1 ? 8 : 4, disk: 40, cpu_type: 'shared', locations: [{ name: 'fsn1', available: true, deprecation: null }] }], meta: { pagination: { next_page: page === 1 ? 2 : null } } });
    }
    if (path === '/firewalls' && method === 'GET') return send(200, { firewalls: [...firewalls.values()].filter(f => !url.searchParams.has('name') || f['name'] === url.searchParams.get('name')), meta: { pagination: { next_page: null } } });
    if (path === '/firewalls' && method === 'POST') {
      assert.deepEqual(body['rules'], [{ direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0'] }]);
      const f = { ...body, id: nextFirewall++ }; firewalls.set(f.id, f); return send(201, { firewall: f, actions: [] });
    }
    if (path === '/servers' && method === 'GET') {
      if (hiddenLists > 0 && url.searchParams.has('name')) { hiddenLists--; return send(200, { servers: [], meta: { pagination: { next_page: null } } }); }
      return send(200, { servers: [...servers.values()].filter(s => !url.searchParams.has('name') || s['name'] === url.searchParams.get('name')), meta: { pagination: { next_page: null } } });
    }
    if (path === '/servers' && method === 'POST') {
      const id = next++; const ipv4 = id * 2;
      const attached = body['firewalls'] as { firewall: number }[];
      assert.equal(attached.length, 1); assert.ok(firewalls.has(attached[0].firewall), 'firewall must exist before server creation');
      const s = { id, name: body['name'], status: 'running', labels: body['labels'], server_type: { name: body['server_type'] }, public_net: { ipv4: { id: ipv4, ip: '127.0.0.1' }, firewalls: detach ? [] : [{ id: attached[0].firewall, status: 'applied' }] } }; detach = false;
      servers.set(id, s); ips.set(ipv4, { auto_delete: false, labels: {} });
      if (failedCreateHidden !== null) { hiddenLists = failedCreateHidden; failedCreateHidden = null; return send(500, { error: { message: 'created before gateway failure' } }); }
      if (drop) { drop = false; req.socket.destroy(); return; }
      return send(201, { server: s, action: { id: 10, status: 'running' }, next_actions: [], root_password: 'unused-fixture-password' });
    }
    const id = Number(path.split('/').at(-1));
    if (path.startsWith('/firewalls/') && firewalls.has(id)) {
      if (method === 'DELETE') {
        if ([...servers.values()].some(s => (s['public_net'] as { firewalls: { id: number }[] }).firewalls.some(f => f.id === id))) return send(409, { error: { code: 'resource_in_use', message: 'firewall is in use' } });
        firewalls.delete(id); return send(204, null);
      }
      return send(200, { firewall: firewalls.get(id) });
    }
    if (path.startsWith('/primary_ips/') && ips.has(id)) {
      if (method === 'PUT') ips.set(id, { auto_delete: body['auto_delete'] === true, labels: body['labels'] as Record<string, string> });
      if (method === 'DELETE') { ips.delete(id); return send(204, null); }
      return send(200, { primary_ip: ips.get(id) });
    }
    if (path.startsWith('/servers/') && servers.has(id)) {
      const s = servers.get(id)!;
      if (method === 'GET') return send(200, { server: s });
      if (method === 'DELETE') {
        for (const ip of Object.values(s['public_net'] as Record<string, { id: number }>)) if (ips.get(ip.id)?.auto_delete) ips.delete(ip.id);
        servers.delete(id); return send(200, { action: { id: 11, status: 'success' } });
      }
    }
    send(404, { error: { code: 'not_found', message: 'not found' } });
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('no loopback address');
  return { url: `http://127.0.0.1:${address.port}/v1`, requests, servers, ips, firewalls, detachNextCreate: () => { detach = true; },
    dropNextCreate: (hidden = 0) => { drop = true; hiddenLists = hidden; }, failNextCreate: (hidden = 0) => { failedCreateHidden = hidden; }, failNext: (status: number, message: string, path?: string) => { failure = { status, message, path }; },
    close: () => new Promise<void>((resolve, reject) => { http.close(e => e ? reject(e) : resolve()); http.closeAllConnections(); }),
  };
}
