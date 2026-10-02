// Task-owned child of cloud-node.ts; no ambient account discovery, stdout or credential files written.
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { CloudAccount } from './cloud.ts';
import type { Api, ApiStreamOptions, Model, TranscriptContext } from '@earendil-works/pi-ai';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream';

const SIGNING = new Set(['authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256']);
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);
const dropHeaders = (headers: http.IncomingHttpHeaders, signing = false) => {
  const drop = new Set([...HOP, ...(signing ? SIGNING : []), ...String(headers.connection ?? '').split(',').map((t) => t.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !drop.has(name)));
};

/** Private per-request transport seam. Only placeholder-signed SDK POSTs reach the fixed selected target. */
export async function unsignedForwarder(baseUrl: string) {
  const target = new URL(baseUrl);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error('Invalid endpoint.');
  const secret = randomUUID();
  const server = http.createServer((req, res) => {
    const rest = req.url?.startsWith(`/${secret}/`) ? req.url.slice(secret.length + 1) : '';
    if (req.method !== 'POST' || !/^\/model\/[^/?#]+\/converse-stream$/.test(rest) || !/^AWS4-HMAC-SHA256 Credential=dummy-access-key\//.test(req.headers.authorization ?? '')) { res.writeHead(403).end(); return; }
    const url = new URL(target);
    const path = target.pathname.replace(/\/$/, '') + rest;
    url.pathname = path;
    if (url.pathname !== path) { res.writeHead(403).end(); return; }
    const out = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers: dropHeaders(req.headers, true), agent: false }, (response) => {
      res.writeHead(response.statusCode ?? 502, dropHeaders(response.headers));
      pipeline(response, res, () => {});
    });
    out.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    res.on('close', () => out.destroy());
    pipeline(req, out, () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/${secret}`,
    close: () => { server.closeAllConnections(); server.close(); } };
}

let next = 0;
const replies = new Map<number, (value: unknown) => void>();
const callback = (name: string, value: unknown) => new Promise<unknown>((resolve) => {
  const id = ++next;
  replies.set(id, resolve);
  process.send?.({ callback: name, id, value });
});
process.on('message', async (m: any) => {
  if (m.reply) { replies.get(m.reply)?.(m.value); replies.delete(m.reply); return; }
  let forwarder: Awaited<ReturnType<typeof unsignedForwarder>> | undefined;
  try {
    const a = m.account as CloudAccount;
    let model = m.model as Model<Api>;
    const p = builtinProviders().find((p) => p.id === a.upstream);
    if (!p || model.provider !== p.id) throw new Error();
    const options: ApiStreamOptions<Api> = { ...m.options,
      ...(m.payload ? { onPayload: (payload: unknown) => callback('payload', payload) } : {}),
      ...(m.response ? { onResponse: async (response: unknown) => { await callback('response', response); } } : {}),
    };
    if (a.method === 'skip-auth') {
      if (a.upstream !== 'amazon-bedrock' || !a.baseUrl || [a.profile, a.home, a.keyFile, options.apiKey, (options as any).bearerToken, (options as any).profile].some((v) => v !== undefined)) throw new Error();
      forwarder = await unsignedForwarder(a.baseUrl);
      model = { ...model, baseUrl: forwarder.baseUrl };
      const flags = { AWS_BEDROCK_SKIP_AUTH: '1', AWS_BEDROCK_FORCE_HTTP1: '1', AWS_EC2_METADATA_DISABLED: 'true' };
      Object.assign(process.env, flags); // This isolated child only, never the app's process.env.
      options.env = { ...options.env, ...flags };
    }
    for await (const event of p.stream(model, m.context as TranscriptContext, options)) {
      // Upstream exceptions may echo settings/credentials. Only the parent emits safe error words.
      if (event.type === 'error') process.send?.({ failed: true, aborted: event.reason === 'aborted' });
      else process.send?.({ event });
    }
  } catch { process.send?.({ failed: true }); }
  finally { forwarder?.close(); }
});
