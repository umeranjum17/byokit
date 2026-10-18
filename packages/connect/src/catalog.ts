import { ConnectError } from './errors.ts';
import { endpoint, json, request } from './http.ts';
import { providers } from './providers.ts';
import type { Provider } from './types.ts';

/** How a listed app signs in: `oauth` with the app's own registered client, `discovery` from its MCP server
 * (registering itself where the server offers it), `device` with a typed code and the app's own client. */
export type CatalogAuth = 'oauth' | 'discovery' | 'device';
/** A listed app is a `Provider`: pass it to `connect()`, `connectLoopback()` or, for `device`, `deviceSignIn()`. */
export interface CatalogApp extends Provider {
  /** An HTTPS (or loopback) image address from the listing; render it as untrusted content. */
  icon?: string;
  description?: string;
  auth: CatalogAuth;
}
/** Any source of apps a host can list; the kit ships `knownApps` and `mcpDirectory(url)`. */
export interface CatalogProvider { list(): Promise<readonly CatalogApp[]> }
export interface DirectoryOptions { fetch?: typeof fetch; timeoutMs?: number }

function listed(provider: Provider, icon?: string): CatalogApp {
  return { ...provider, ...(icon ? { icon } : {}), auth: provider.device ? 'device' : provider.oauth ? 'oauth' : 'discovery' };
}
function web(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try { return endpoint(raw).href; } catch { return undefined; }
}
/** One MCP registry `server.json` entry, kept only when the kit can sign in to it: a streamable HTTP remote with no
 * address variables or required headers for the person to fill in. */
function fromServer(server: unknown): CatalogApp | undefined {
  if (!server || typeof server !== 'object') return undefined;
  const { name, title, description, remotes, icons } = server as Record<string, unknown>;
  if (typeof name !== 'string' || !name) return undefined;
  const remote = Array.isArray(remotes) ? remotes.find(r => r?.type === 'streamable-http' && typeof r.url === 'string' && !r.url.includes('{') &&
    !(Array.isArray(r.headers) && r.headers.some((h: { isRequired?: unknown } | null) => h?.isRequired))) : undefined;
  const mcpUrl = web(remote?.url);
  if (!mcpUrl) return undefined;
  const icon = Array.isArray(icons) ? icons.map(i => web(i?.src)).find(Boolean) : undefined;
  return { ...listed({ id: name, name: typeof title === 'string' && title ? title : name, mcpUrl }, icon), ...(typeof description === 'string' ? { description } : {}) };
}

const reviewedRegistry = [
  ['com.notion.mcp', 'Notion', 'Find and update pages in your Notion workspace.', 'https://mcp.notion.com/mcp', 'https://www.notion.so/images/favicon.ico'],
  ['com.canva.mcp', 'Canva', 'Create and manage designs in Canva.', 'https://mcp.canva.com/mcp', 'https://www.canva.com/favicon.ico'],
  ['com.linear.mcp', 'Linear', 'Read and manage issues and projects in Linear.', 'https://mcp.linear.app/mcp', 'https://linear.app/favicon.ico'],
  ['com.figma.mcp', 'Figma', 'Inspect and work with Figma design files.', 'https://mcp.figma.com/mcp', 'https://www.figma.com/favicon.ico'],
  ['com.airtable.mcp', 'Airtable', 'Find and manage records in Airtable bases.', 'https://mcp.airtable.com/mcp', 'https://www.airtable.com/favicon.ico'],
  ['com.monday.mcp', 'Monday.com', 'Read and manage work in monday.com.', 'https://mcp.monday.com/mcp', 'https://monday.com/favicon.ico'],
  ['com.clickup.mcp', 'ClickUp', 'Find and update tasks in ClickUp.', 'https://mcp.clickup.com/mcp', 'https://clickup.com/favicon.ico'],
  ['com.miro.mcp', 'Miro', 'Find and work with Miro boards.', 'https://mcp.miro.com/', 'https://miro.com/favicon.ico'],
  ['com.dropbox.mcp', 'Dropbox', 'Find and manage files in Dropbox.', 'https://mcp.dropbox.com/mcp', 'https://www.dropbox.com/favicon.ico'],
  ['com.todoist.mcp', 'Todoist', 'Find and manage tasks in Todoist.', 'https://ai.todoist.net/mcp', 'https://todoist.com/favicon.ico'],
  ['com.intercom.mcp', 'Intercom', 'Find and manage customer conversations in Intercom.', 'https://mcp.intercom.com/mcp', 'https://www.intercom.com/favicon.ico'],
  ['com.attio.mcp', 'Attio', 'Find and manage customer relationship records in Attio.', 'https://mcp.attio.com/mcp', 'https://attio.com/favicon.ico'],
].map(([name, title, description, url, icon]) => ({ name, title, description, remotes: [{ type: 'streamable-http', url }], icons: [{ src: icon }] }));

/** The reviewed, live-probed MCP vendors, published in MCP Registry server.json shape. */
export const reviewedApps: CatalogProvider = { list: async () => reviewedRegistry.map(server => fromServer(server)!) };
/** The kit's hand-known apps (`providers`); reads nothing. */
export const knownApps: CatalogProvider = { list: async () => Object.values(providers).map(provider => listed(provider)) };

/** A remote MCP directory at the caller's HTTPS (or loopback) URL, answering in the MCP registry's `GET /v0/servers`
 * shape and paged by `metadata.nextCursor`. Nothing is read until `list()`. The caller vouches for the directory:
 * signing in to a listed app talks to the server it names. */
export function mcpDirectory(url: string, options: DirectoryOptions = {}): CatalogProvider {
  const base = endpoint(url);
  return { list: async () => {
    const apps: CatalogApp[] = [];
    let cursor: string | undefined;
    // ponytail: at most 100 pages per list(), so a directory that keeps paging stays finite; raise it if a real directory outgrows it.
    for (let page = 0; page < 100; page++) {
      const next = new URL(base);
      if (cursor) next.searchParams.set('cursor', cursor);
      const response = await request(options.fetch ?? globalThis.fetch, next, { headers: { accept: 'application/json' } }, options.timeoutMs ?? 20_000);
      if (!response.ok) { await response.body?.cancel(); throw new ConnectError('catalog', response.status); }
      const body = await json(response, 'catalog');
      if (!Array.isArray(body.servers)) throw new ConnectError('catalog', response.status);
      for (const entry of body.servers) { const app = fromServer(entry?.server); if (app) apps.push(app); }
      const more = (body.metadata as { nextCursor?: unknown } | undefined)?.nextCursor;
      if (typeof more !== 'string' || !more || more === cursor) break;
      cursor = more;
    }
    return apps;
  } };
}

/** Lists the apps of the providers the caller picks, in their order; an id listed twice keeps its first entry. */
export async function catalog(sources: readonly CatalogProvider[]): Promise<CatalogApp[]> {
  const apps = new Map<string, CatalogApp>();
  for (const app of (await Promise.all(sources.map(source => source.list()))).flat()) if (!apps.has(app.id)) apps.set(app.id, app);
  return [...apps.values()];
}
