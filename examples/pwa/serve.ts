// Bundles app.ts for the browser (esbuild, as any web build would: the package's "browser" side, and nothing from Node
// can get in) and serves the page. `node examples/pwa/serve.ts [port]`, after `npm run build`.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const TYPES: Record<string, string> = { html: 'text/html', js: 'text/javascript', webmanifest: 'application/manifest+json', png: 'image/png', ico: 'image/x-icon', svg: 'image/svg+xml' };
/** The provider endpoints that don't answer other web pages, which the page asks through `/fwd/<name>/…` instead. */
const UPSTREAM: Record<string, string> = { chatgpt: 'https://chatgpt.com/', claude: 'https://platform.claude.com/', anthropic: 'https://api.anthropic.com/' };
const DROP = /^(host|origin|referer|cookie|connection|content-length|accept-encoding|user-agent|sec-|proxy-)/i;

const body = (req: import('node:http').IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
});
const headers = (h: IncomingHttpHeaders) => Object.entries(h).filter(([k, v]) => !DROP.test(k) && typeof v === 'string') as [string, string][];

export async function serve(port = 0, authBase?: string) {
  const bundle = await build({ entryPoints: [here('app.ts'), here('pair.ts'), here('usage.ts')], outdir: 'out', bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent',
    define: { __BYOKIT_AUTH_BASE__: JSON.stringify(authBase) ?? 'undefined' } });
  const apps = new Map(bundle.outputFiles.map((f) => [f.path.split('/').pop()!, f.text]));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const [, fwd, name, ...rest] = url.pathname.split('/');
    if (fwd === 'fwd') {
      // Passed on as it came, the answer streamed straight back; nothing is kept or logged.
      if (!Object.hasOwn(UPSTREAM, name)) return res.writeHead(404).end();
      try {
        const up = await fetch(UPSTREAM[name] + rest.join('/') + url.search, {
          method: req.method, headers: headers(req.headers), body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(await body(req)),
        });
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' });
        if (up.body) Readable.fromWeb(up.body as any).pipe(res); else res.end();
      } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
      return;
    }
    const file = url.pathname.slice(1) || 'index.html';
    const ext = file.split('.').pop()!;
    try {
      const page = apps.get(file) ?? readFileSync(here(file.replace(/[^\w.-]/g, '')));
      res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(page);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`byokit example on ${(await serve(Number(process.argv[2] ?? 8080))).url}`);
