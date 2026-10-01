const WORDS = {
  'host-offline': "Can't reach your computer. Check it's on and connected.",
  'not-paired': 'Pair this device with your computer first.',
  'key-missing': 'Add a decision API key on your computer. It is billed per use.',
  disabled: 'Allow paid decisions on your computer first.',
  'not-allowed': "This device isn't allowed to ask for paid decisions.",
  'invalid-request': 'That decision request could not be read.',
  'request-failed': 'Your computer could not answer that decision.',
  cancelled: 'That decision was cancelled.',
} as const;

export type PairedHostProblem = keyof typeof WORDS;

/** Plain, fixed words only: never retains a transport, storage or provider error as a cause. */
export class PairedHostError extends Error {
  readonly code: PairedHostProblem;
  constructor(code: PairedHostProblem) {
    super(WORDS[code]);
    this.name = 'PairedHostError';
    this.code = code;
  }
}

export function hostProblem(value: unknown): value is PairedHostProblem {
  return typeof value === 'string' && Object.hasOwn(WORDS, value);
}
