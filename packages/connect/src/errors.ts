import WORDS from './words.json' with { type: 'json' };
export type ConnectErrorCode = 'configuration' | 'discovery' | 'registration' | 'callback' | 'expired' | 'declined' | 'scope' | 'token' | 'signin' | 'network';
const words: Record<ConnectErrorCode, string> = WORDS.errors;
/** Never includes provider bodies, callback codes, credentials or URLs. */
export class ConnectError extends Error {
  readonly code: ConnectErrorCode;
  readonly status?: number;
  constructor(code: ConnectErrorCode, status?: number) {
    super(words[code]); this.name = 'ConnectError'; this.code = code; this.status = status;
  }
}
