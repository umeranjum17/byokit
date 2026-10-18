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
  /** RFC 8628 device authorization: the person types a code on any device instead of returning to a redirect. */
  device?: { code: string; token: string };
  scopes?: readonly string[];
  /** Provider-specific authorization parameters; PKCE/state cannot be overridden. */
  extra?: Readonly<Record<string, string>>;
}
export interface ConnectEndpoints {
  google?: { authorize?: string; token?: string; api?: string };
  github?: { deviceCode?: string; token?: string; api?: string };
}
export interface ConnectOptions {
  /** Test-only full endpoint URLs; defaults to the real provider endpoints. */
  endpoints?: ConnectEndpoints;
  /** A store scoped by the host to this person on this device. */
  store: Keystore;
  /** Distinguishes connections belonging to different people sharing a store. */
  person: string;
  /** HTTPS, loopback HTTP, or the host's registered native app URI. Needed by `signIn()`, not by `deviceSignIn()`. */
  redirectUri?: string;
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
export interface DeviceSignIn {
  /** Show this code and `verificationUri`; the person types the code there on any device. */
  readonly userCode: string;
  readonly verificationUri: string;
  /** Unix milliseconds when the code stops working. */
  readonly expiresAt: number;
  /** Waits for the person; stores the grant only when they approve. The same promise on every call. */
  finish(): Promise<void>;
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
