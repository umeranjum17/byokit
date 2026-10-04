import type { SiteVerifier, SettledReason } from '../browser.ts';
import { checkUrl, validOrigin } from './store.ts';

// The accepted Broker.probe seam: this callback runs on a host-only tab, never an engine/client tab.
export type Probe = { url: string; status: number; exists(selector: string): Promise<boolean> };
export type Prober = { probe(url: string, verify: (p: Probe) => Promise<boolean>, timeoutMs: number): Promise<'ok' | 'fail' | 'timeout'> };
export type Verification = { state: 'verified' } | { state: 'entered-unverified'; reason: SettledReason };
export function validateVerifiers(verifiers: SiteVerifier[]): void {
  for (const v of verifiers) {
    validOrigin(v.origin);
    if (new URL(checkUrl(v.url)).origin !== v.origin || (v.status !== undefined && (!Number.isInteger(v.status) || v.status < 100 || v.status > 599))) {
      throw new Error('invalid browser verifier');
    }
  }
}
export async function verifySignIn(broker: Prober, origin: string, verifiers: SiteVerifier[], timeoutMs: number): Promise<Verification> {
  const v = verifiers.find(v => v.origin === origin);
  // A bare endpoint status is not positive proof; host code or a signed-in-only selector is required.
  if (!v || (!v.selector && !v.check)) return { state: 'entered-unverified', reason: 'no-verifier' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      broker.probe(v.url, async p => {
        if (new URL(p.url).origin !== origin || (v.status !== undefined && p.status !== v.status)) return false;
        if (v.selector && !await p.exists(v.selector)) return false;
        if (v.check && !await v.check(p)) return false;
        // The verifier may have navigated: check the final host-side URL again.
        return new URL(p.url).origin === origin;
      }, timeoutMs),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
    ]);
    return result === 'ok' ? { state: 'verified' } : { state: 'entered-unverified', reason: result === 'timeout' ? 'check-timeout' : 'still-signed-out' };
  } catch { return { state: 'entered-unverified', reason: 'still-signed-out' }; }
  finally { clearTimeout(timer); }
}
