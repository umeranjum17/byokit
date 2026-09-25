// Bundles app.ts for the browser (esbuild, as any web build would: the package's "browser" side, and nothing from Node
// can get in) and serves the page. `node examples/pwa/serve.ts [port]`, after `npm run build`.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const TYPES: Record<string, string> = { html: 'text/html', js: 'text/javascript', webmanifest: 'application/manifest+json', png: 'image/png' };

export async function serve(port = 0) {
  const bundle = await build({ entryPoints: [here('app.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent' });
  const app = bundle.outputFiles[0].text;
  const server = createServer((req, res) => {
    const name = new URL(req.url ?? '/', 'http://x').pathname.slice(1) || 'index.html';
    const ext = name.split('.').pop()!;
    try {
      const body = name === 'app.js' ? app : readFileSync(here(name.replace(/[^\w.-]/g, '')));
      res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`byokit example on ${(await serve(Number(process.argv[2] ?? 8080))).url}`);
