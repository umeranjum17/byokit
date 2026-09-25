// @byokit/accounts on phones (React Native, Expo) and in browsers (a PWA, Electron's renderer): the same Accounts, with
// ChatGPT by device code (portableEngine) and the phone's or browser's own storage. No Node module is imported.
export { Accounts, planOf, portable, type AccountsOptions, type AuthHost, type Loopback, type Member, type Platform, type SignIn, type Status } from './accounts.ts';
export { PROVIDERS, offered, provider, type Provider, type Terms } from './catalogue.ts';
export { PORTABLE, claims, credentialOf, devicePoll, deviceStart, portableEngine, type EngineOptions, type Poll } from './engine.ts';
export { REST_MS, classify, type Kind } from './limits.ts';
export { ResponseError, limitResponse, respond, sseReader, type Ask } from './responses.ts';
export { browserStore, memoryStore, recordStore, secureStore, type SecureStoreLike } from './stores.ts';
export { WORDS, callbackPage, clock, failure, say, signInError, type WordKey, type Why } from './words.ts';
