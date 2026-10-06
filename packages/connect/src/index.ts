export { connect, Connection } from './connect.ts';
export { providers } from './providers.ts';
export type { ProviderId } from './providers.ts';
export { ConnectError } from './errors.ts';
export { MailReader, MailError } from './mail.ts';
export type { MailErrorCode, MailCredential, MailReaderOptions, MailEnvelope, MailBody, MailMessage, MailPage, MailListOptions, MailGetOptions } from './mail.ts';
export type { ConnectErrorCode, ProviderErrorCause } from './errors.ts';
export type { Provider, OAuthClient, OAuthEndpoints, ConnectOptions, SignIn, McpOptions, Grant, ClientVerification } from './types.ts';
// Expose the pinned engine for typed protocol pass-through without a second SDK pin.
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export * from '@modelcontextprotocol/sdk/types.js';
