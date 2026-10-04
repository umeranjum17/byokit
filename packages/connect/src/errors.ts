import WORDS from './words.json' with { type: 'json' };
export type ConnectErrorCode = 'configuration' | 'discovery' | 'registration' | 'callback' | 'expired' | 'declined' | 'scope' | 'token' | 'signin' | 'network';
const words: Record<ConnectErrorCode, string> = WORDS.errors;
export interface ProviderErrorCause { readonly error: string; readonly error_description?: string }
/** Preserve OAuth diagnostics, removing credentials supplied to or returned by the provider. */
export function providerCause(body: Record<string, unknown>, secrets: readonly string[]): ProviderErrorCause | undefined {
  if (typeof body.error !== 'string') return undefined;
  const values = [...secrets, ...['access_token', 'refresh_token', 'id_token', 'client_secret', 'client_id'].map(k => body[k]).filter((v): v is string => typeof v === 'string')];
  const redact = (text: string): string => {
    for (const value of values.filter(Boolean).sort((a, b) => b.length - a.length)) {
      const variants = new Set([value, new URLSearchParams({ v: value }).toString().slice(2)]);
      try { variants.add(encodeURIComponent(value)); } catch { /* Malformed Unicode still gets literal/form redaction. */ }
      for (const encoded of variants) text = text.split(encoded).join('[redacted]');
    }
    return text.replace(/https?:\/\/[^\s<>"']+/gi, '[redacted]').replace(/(?:Bearer|Basic)\s+[^\s,;]+/gi, '[redacted]');
  };
  const standard = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error', 'temporarily_unavailable', 'invalid_client_metadata', 'invalid_redirect_uri'];
  return Object.freeze({ error: standard.includes(body.error) && !values.includes(body.error) ? body.error : redact(body.error), ...(typeof body.error_description === 'string' ? { error_description: redact(body.error_description) } : {}) });
}
/** Plain message and optional sanitized OAuth cause; never includes raw response bodies. */
export class ConnectError extends Error {
  readonly code: ConnectErrorCode;
  readonly status?: number;
  declare readonly cause?: ProviderErrorCause;
  constructor(code: ConnectErrorCode, status?: number, cause?: ProviderErrorCause) {
    super(words[code], cause ? { cause } : undefined); this.name = 'ConnectError'; this.code = code; this.status = status;
  }
}
