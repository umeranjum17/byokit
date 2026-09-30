// The two ways to reach the pinned engine (docs/capability-kits.md 4.5, D-H): in process (the default) or through
// the engine's own bin as a separate process. Both adapt the kit's `{ verb, params }` to the engine's wire (4.2): the
// schema's flat `{ verb, ...params }`, with `hello` answered outside it (`Protocol.hello()`, `<bin> hello`).
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ENGINE_PACKAGE } from './constants.ts';
import { ComposeError } from './errors.ts';
import type { Engine, EngineRequest } from './types.ts';
import type { WireRequest } from './generated/protocol.ts';

const MAX_OUTPUT = 8 * 1024 * 1024;

function wire(request: EngineRequest): WireRequest {
  return { verb: request.verb, ...request.params } as WireRequest;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Protocol = { handle(request: WireRequest): unknown; hello(): unknown };

function protocolOf(mod: unknown): Protocol {
  // The engine's entry exports the protocol as `Protocol`; a flat `handle`/`hello` export is accepted too.
  const m = mod as { Protocol?: Partial<Protocol> } & Partial<Protocol>;
  const p = m?.Protocol ?? m;
  if (typeof p?.handle !== 'function' || typeof p.hello !== 'function') {
    throw new ComposeError('engine', `${ENGINE_PACKAGE} exports no protocol handle`);
  }
  return p as Protocol;
}

/** The in-process engine over a module loader (`inProcessEngine` imports the pin; tests pass a stub). */
export function moduleEngine(load: () => Promise<unknown>): Engine {
  let protocol: Promise<Protocol> | null = null;
  return {
    async handle(request: EngineRequest): Promise<unknown> {
      protocol ??= load().then(protocolOf, (e: unknown) => {
        if ((e as { code?: unknown })?.code === 'ERR_MODULE_NOT_FOUND') {
          throw new ComposeError('missing', `${ENGINE_PACKAGE} is not installed`);
        }
        throw new ComposeError('engine', `${ENGINE_PACKAGE} failed to load: ${message(e)}`);
      });
      // A failed load is not kept: a later call tries again.
      const p = await protocol.catch((e: unknown) => { protocol = null; throw e; });
      try {
        return await (request.verb === 'hello' ? p.hello() : p.handle(wire(request)));
      } catch (e) {
        // The same envelope the engine's bin prints for a throw.
        return { error: { code: 'internal', message: message(e) } };
      }
    },
  };
}

/** Lazily imports ENGINE_PACKAGE on the first request; a missing package rejects `missing`. */
export function inProcessEngine(): Engine {
  return moduleEngine(() => import(ENGINE_PACKAGE));
}

/** Runs the engine's bin (absolute path) per request with env { PATH, LANG } only; timeout default 10 s. */
export function binEngine(o: { bin: string; timeoutMs?: number }): Engine {
  const timeoutMs = Math.min(60_000, Math.max(1_000, o.timeoutMs ?? 10_000));
  return {
    handle(request: EngineRequest): Promise<unknown> {
      const { bin } = o;
      if (typeof bin !== 'string' || !isAbsolute(bin) || bin.includes('\0')) {
        return Promise.reject(new ComposeError('missing', 'the engine bin must be an absolute path'));
      }
      try {
        accessSync(bin, constants.R_OK);
      } catch {
        return Promise.reject(new ComposeError('missing', `no engine bin at ${bin}`));
      }
      const hello = request.verb === 'hello';
      return new Promise((resolve, reject) => {
        // Node itself runs the bin: a `#!/usr/bin/env node` shebang would search a PATH that holds no Node.
        const child = spawn(process.execPath, hello ? [bin, 'hello'] : [bin], {
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let failure: ComposeError | null = null;
        const fail = (e: ComposeError): void => {
          failure ??= e;
          child.kill('SIGKILL');
        };
        const timer = setTimeout(() => fail(new ComposeError('engine', `the engine did not answer within ${timeoutMs} ms`)), timeoutMs);
        const out: Buffer[] = [];
        const sizes = { stdout: 0, stderr: 0 };
        const cap = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
          sizes[stream] += chunk.length;
          if (sizes[stream] > MAX_OUTPUT) fail(new ComposeError('engine', `the engine wrote more than 8 MB on ${stream}`));
          else if (stream === 'stdout') out.push(chunk);
        };
        child.stdout.on('data', cap('stdout'));
        child.stderr.on('data', cap('stderr'));
        child.stdin.on('error', () => {}); // an engine that exits without reading stdin is judged by its answer
        child.on('error', (e: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(failure ?? (e.code === 'ENOENT' || e.code === 'EACCES'
            ? new ComposeError('missing', `cannot run the engine: ${e.code}`)
            : new ComposeError('engine', `cannot run the engine: ${e.message}`)));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (failure) return reject(failure);
          const text = Buffer.concat(out).toString('utf8');
          try {
            resolve(JSON.parse(text) as unknown);
          } catch {
            reject(new ComposeError('engine', code === 0 ? 'the engine answered no JSON' : `the engine exited ${code} with no JSON`));
          }
        });
        child.stdin.end(hello ? '' : JSON.stringify(wire(request)) + '\n');
      });
    },
  };
}
