import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpError as ProtocolError, ErrorCode, type CallToolResult, type ReadResourceResult,
  type ServerRequest, type ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import type { Authenticator, DeviceFlow, Principal } from './auth.ts';
import { McpError, publicError } from './errors.ts';

export type RequestContext = {
  principal: Principal;
  signal: AbortSignal;
  /** Emits SDK progress notifications on the calling request's event stream. */
  progress(value: number, total?: number): Promise<void>;
};
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export interface Mount {
  tool<S extends z.ZodRawShape>(name: string, options: { description?: string; inputSchema: S },
    handle: (args: z.output<z.ZodObject<S>>, context: RequestContext) => CallToolResult | Promise<CallToolResult>): void;
  resource(name: string, uri: string, options: { description?: string; mimeType?: string },
    read: (uri: URL, context: RequestContext) => ReadResourceResult | Promise<ReadResourceResult>): void;
}
export type HostedMcpOptions = {
  name: string;
  version: string;
  /** Externally visible HTTPS endpoint; HTTP is allowed only for loopback development. */
  url: string;
  auth: Authenticator;
  /** Optional device code/token endpoints beneath the endpoint's path. Approval stays in the host app. */
  device?: DeviceFlow;
  /** Called once per session; definitions should stay the same across sessions. */
  mount: (mount: Mount) => void;
  sessionMs?: number;
  maxSessions?: number;
};
type Session = { server: McpServer; transport: StreamableHTTPServerTransport; owner: string; timer: NodeJS.Timeout };

function reply(res: ServerResponse, status: number, value: unknown) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new McpError('invalid');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new McpError('invalid');
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new McpError('invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpError('invalid');
  return value as Record<string, unknown>;
}

/** A request handler for the app's HTTP server; never listens, reads credentials or logs by itself. */
export function hostedMcp(o: HostedMcpOptions) {
  const url = new URL(o.url);
  const sessionMs = o.sessionMs ?? 30 * 60_000, maxSessions = o.maxSessions ?? 1000;
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      !Number.isSafeInteger(sessionMs) || sessionMs < 1 || sessionMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new McpError('invalid');
  const sessions = new Map<string, Session>();
  const all = new Set<McpServer>();
  const scope = new AsyncLocalStorage<Principal>();
  let closed = false;
  const context = (extra: Extra): RequestContext => {
    const principal = scope.getStore();
    if (!principal) throw new McpError('unauthorized');
    return { principal: { ...principal }, signal: extra.signal,
      async progress(progress, total) {
        const progressToken = extra._meta?.progressToken;
        if (progressToken !== undefined) await extra.sendNotification({ method: 'notifications/progress',
          params: { progressToken, progress, ...(total === undefined ? {} : { total }) } });
      } };
  };
  const makeServer = () => {
    const server = new McpServer({ name: o.name, version: o.version });
    // Public errors carry only fixed words; upstream exceptions never reach protocol clients.
    o.mount({
      tool(name, options, handle) {
        const run = async (args: z.output<z.ZodObject<typeof options.inputSchema>>, extra: Extra): Promise<CallToolResult> => {
          try { return await handle(args, context(extra)); }
          catch (error) { return { isError: true, content: [{ type: 'text', text: publicError(error).message }] }; }
        };
        if (Object.keys(options.inputSchema).length === 0) {
          server.registerTool(name, { description: options.description }, extra =>
            run({} as z.output<z.ZodObject<typeof options.inputSchema>>, extra));
        } else {
          server.registerTool<z.ZodRawShape, z.ZodRawShape>(name, options, (args, extra) =>
            run(args as z.output<z.ZodObject<typeof options.inputSchema>>, extra));
        }
      },
      resource(name, uri, options, read) {
        server.registerResource(name, uri, options, async (uri, extra) => {
          try { return await read(uri, context(extra)); }
          catch (error) { throw new ProtocolError(ErrorCode.InternalError, publicError(error).message); }
        });
      },
    });
    // The SDK's default diagnostics must never print an exception with credentials.
    server.server.onerror = () => {};
    return server;
  };
  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      res.setHeader('cache-control', 'no-store');
      try {
        if (closed) throw new McpError('session');
        // Validate the app's public host and browser origin before any unauthenticated operation.
        if (req.headers.host !== url.host || (req.headers.origin && req.headers.origin !== url.origin)) {
          reply(res, 403, { error: 'unauthorized', message: new McpError('unauthorized').message }); return;
        }
        const path = new URL(req.url ?? '/', url).pathname;
        if (o.device && [url.pathname + '/device/code', url.pathname + '/device/token'].includes(path)) {
          if (req.method !== 'POST') { res.setHeader('allow', 'POST'); reply(res, 405, { message: new McpError('invalid').message }); return; }
          if (path.endsWith('/code')) { await body(req); reply(res, 200, o.device.begin()); }
          else {
            const value = await body(req);
            if (typeof value.device_code !== 'string' || value.device_code.length > 256) throw new McpError('invalid');
            reply(res, 200, await o.device.poll(value.device_code));
          }
          return;
        }
        if (path !== url.pathname) { reply(res, 404, { message: new McpError('invalid').message }); return; }
        const header = req.headers.authorization;
        const token = typeof header === 'string' && /^Bearer [A-Za-z0-9._~-]{1,8192}$/i.test(header) ? header.slice(7) : '';
        const principal = token ? await o.auth.authenticate(token) : null;
        if (closed) throw new McpError('session');
        if (!principal) {
          res.setHeader('www-authenticate', 'Bearer');
          throw new McpError('unauthorized');
        }
        const id = req.headers['mcp-session-id'];
        if (id !== undefined) {
          const session = typeof id === 'string' ? sessions.get(id) : undefined;
          if (!session || session.owner !== principal.id) throw new McpError('session');
          await scope.run({ ...principal }, () => session.transport.handleRequest(req, res));
          if (req.method === 'DELETE' && res.statusCode === 200) await session.server.close();
          return;
        }
        if (req.method !== 'POST') throw new McpError('session');
        if (all.size >= maxSessions) throw new McpError('busy');
        const server = makeServer();
        all.add(server);
        let sessionId: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized(id) {
            sessionId = id;
            const timer = setTimeout(() => { void server.close().catch(() => {}); }, sessionMs);
            timer.unref();
            sessions.set(id, { server, transport, owner: principal.id, timer });
          },
        });
        server.server.onclose = () => {
          if (sessionId) { clearTimeout(sessions.get(sessionId)?.timer); sessions.delete(sessionId); }
          all.delete(server);
        };
        try {
          await server.connect(transport);
          await scope.run({ ...principal }, () => transport.handleRequest(req, res));
        } finally { if (!sessionId) await server.close(); }
      } catch (error) {
        const e = publicError(error);
        const status = e.code === 'unauthorized' ? 401 : e.code === 'session' ? 404 : e.code === 'busy' ? 429 : e.code === 'failed' ? 500 : 400;
        reply(res, status, { error: e.code, message: e.message });
      }
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.all([...all].map(server => server.close()));
    },
  };
}
