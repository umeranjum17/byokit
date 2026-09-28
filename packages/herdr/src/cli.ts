// `herdr <args>` with the kit's own env, one argv entry per argument, no environment read
// (docs/runtime-kits.md 6.5, D13) — built in H4.

export function runCli(bin: string, env: Record<string, string>, args: string[], timeoutMs?: number):
  Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  throw new Error('@byokit/herdr: runCli lands in H4 (docs/runtime-kits.md §11.3).');
}
