import type { Keystore } from '@byokit/secrets';
import type { ClientOptions } from '@modelcontextprotocol/sdk/client/index.js';

export interface OAuthClient {
  id: string;
  secret?: string;
  authMethod?: 'none' | 'client_secret_post' | 'client_secret_basic';
}
export interface OAuthEndpoints {
  authorize: string;
  token: string;
  register?: string;
  issuer?: string;
}
export interface Provider {
  id: string;
  name: string;
  mcpUrl?: string;
  issuer?: string;
  oauth?: OAuthEndpoints;
  scopes?: readonly string[];
  /** Provider-specific authorization parameters; PKCE/state cannot be overridden. */
  extra?: Readonly<Record<string, string>>;
}
export interface ConnectOptions {
  /** A store scoped by the host to this person on this device. */
  store: Keystore;
  /** Distinguishes connections belonging to different people sharing a store. */
  person: string;
  /** HTTPS, loopback HTTP, or the host's registered native app URI. */
  redirectUri: string;
  client?: OAuthClient;
  clientName?: string;
  scopes?: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  flowTimeoutMs?: number;
}
export interface SignIn {
  readonly url: string;
  readonly redirectUri: string;
  /** Pass the complete callback URL; rejects mismatched, expired and reused callbacks. */
  finish(callback: string | URL): Promise<void>;
  cancel(): void;
}
export interface McpOptions {
  clientInfo?: { name: string; version: string };
  /** Includes capabilities and all official SDK client options. */
  clientOptions?: ClientOptions;
  /** Register sampling/elicitation/request/notification handlers before connecting. */
  configure?: (client: import('@modelcontextprotocol/sdk/client/index.js').Client) => void;
}

/** Trusted app data only: never display or log credentials. Times are Unix milliseconds. */
export interface Grant {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  /** The provider's refresh_token_expires_in value, in seconds. */
  refreshTokenExpiresIn?: number;
  /** Absolute deadline; unlike the duration, this does not restart on restore. */
  refreshTokenExpiresAt?: number;
}
export type ClientVerification =
  | { outcome: 'valid'; message: string }
  | { outcome: 'invalid'; message: string; cause?: import('./errors.ts').ProviderErrorCause }
  | { outcome: 'inconclusive'; message: string; cause?: import('./errors.ts').ProviderErrorCause };
