const MAX_OUTPUT_TOKENS = 1_000_000;

export function validOutputBudget(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= MAX_OUTPUT_TOKENS);
}
