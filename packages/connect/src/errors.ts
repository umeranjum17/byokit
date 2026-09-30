export type ConnectErrorCode = 'configuration' | 'discovery' | 'registration' | 'callback' | 'expired' | 'declined' | 'scope' | 'token' | 'signin' | 'network';
const words: Record<ConnectErrorCode, string> = {
  configuration: 'This app needs its connection settings filled in.',
  discovery: 'Could not find the app’s sign-in page.',
  registration: 'The app could not set up sign-in. Try again.',
  callback: 'This sign-in link does not match. Start again.',
  expired: 'This sign-in link has expired. Start again.',
  declined: 'Nothing was connected. Try again whenever you like.',
  scope: 'Some permissions were left out. Sign in again and select them.',
  token: 'The app did not finish connecting. Try again.',
  signin: 'Sign in to this app again.',
  network: 'Could not reach the app. Check your connection and try again.',
};
/** Never includes provider bodies, callback codes, credentials or URLs. */
export class ConnectError extends Error {
  readonly code: ConnectErrorCode;
  readonly status?: number;
  constructor(code: ConnectErrorCode, status?: number) {
    super(words[code]); this.name = 'ConnectError'; this.code = code; this.status = status;
  }
}
