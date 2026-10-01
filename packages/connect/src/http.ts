import { ConnectError, type ConnectErrorCode } from './errors.ts';
/** Remote secrets go over HTTPS; loopback HTTP is useful for local servers and tests. */
export function endpoint(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConnectError('configuration'); }
  if (u.username || u.password || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new ConnectError('configuration');
  return u;
}
export function redirect(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConnectError('configuration'); }
  if (u.username || u.password || u.hash || u.searchParams.has('state') || u.searchParams.has('code') || u.searchParams.has('error')) throw new ConnectError('configuration');
  if (u.protocol === 'http:' || u.protocol === 'https:') return endpoint(raw);
  if (['javascript:', 'data:', 'file:', 'ftp:', 'ws:', 'wss:'].includes(u.protocol)) throw new ConnectError('configuration');
  return u;
}
export async function request(fetcher: typeof fetch, url: string | URL, init: RequestInit, timeout: number): Promise<Response> {
  try { return await fetcher(endpoint(String(url)), { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(timeout) }); }
  catch { throw new ConnectError('network'); }
}
export async function json(response: Response, code: ConnectErrorCode): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Do not expose response text. */ }
  throw new ConnectError(code, response.status);
}
export function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every(x => typeof x === 'string'); }
