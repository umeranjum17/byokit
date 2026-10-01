const words = {
  unauthorized: 'Sign in before continuing.',
  expired: 'That sign-in code has run out. Start again.',
  invalid: 'That request could not be read. Check it and try again.',
  pending: 'Approve this sign-in on your account page.',
  busy: 'Please wait a moment and try again.',
  session: 'This connection has ended. Connect again.',
  failed: 'This request could not be completed. Try again.',
} as const;

export type McpErrorCode = keyof typeof words;
/** Fixed public words: never accepts an upstream error or credential as a message. */
export class McpError extends Error {
  readonly code: McpErrorCode;
  constructor(code: McpErrorCode) {
    super(words[code]);
    this.name = 'McpError';
    this.code = code;
  }
}
export const publicError = (error: unknown): McpError =>
  error instanceof McpError ? new McpError(error.code) : new McpError('failed');
