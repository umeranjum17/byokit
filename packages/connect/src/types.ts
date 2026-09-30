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
