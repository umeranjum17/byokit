// MachineError (docs/cloud-kit.md 4.2, plus the 4.3 'needs-root' and 4.4 'no-snapshot' codes).
export type MachineErrorCode =
  | 'no-machine'          // a call that needs a ref, with none in the store
  | 'exists'              // create() while the store already holds a ref
  | 'wrong-account'       // stored ref.account !== provider.account()
  | 'unsupported'         // the provider lacks the optional method this call needs
  | 'confirm'             // remove(confirm) with confirm !== ref.id
  | 'bad-recipe'          // 8.1 check failed; message names the rule
  | 'not-linux'           // uname, systemd or arch check failed (8.3)
  | 'linger'              // loginctl enable-linger refused (8.3 step 9); extra.command holds the line to run
  | 'host-key'            // SSH host key unconfirmed or changed (7.2)
  | 'unauthorized'        // provider answered 401/403
  | 'balance'             // provider says the account's balance is spent (10)
  | 'unreachable'         // network or ssh transport failure
  | 'provider'            // any other provider failure; message holds the provider's own text
  | 'needs-root'          // G5b, G7: root steps on an SSH VM without passwordless sudo; extra.command holds the lines to run
  | 'timeout'
  | 'no-snapshot'         // K3: restore or delete of an id that is not one of this machine's ready copies
  | 'busy'                // K3: a save, reset or remove of this machine is already running; the second one changes nothing
  | 'owner-enrolled'      // adopt(): this app is already installed there, so another phone owns it; replaceOwner takes it over (5.12)

// Keep typed errors (including frozen provider errors) intact for direct adopt() callers.
const adoptionInstallFailures = new WeakSet<object>();
export const markAdoptionInstallFailure = (cause: unknown): object => {
  const error = cause !== null && (typeof cause === 'object' || typeof cause === 'function')
    ? cause : new Error('installation failed', { cause });
  adoptionInstallFailures.add(error);
  return error;
};
export const isAdoptionInstallFailure = (error: unknown): boolean =>
  error !== null && (typeof error === 'object' || typeof error === 'function') && adoptionInstallFailures.has(error);

export class MachineError extends Error {
  readonly code: MachineErrorCode
  readonly extra: Readonly<Record<string, string>>
  constructor(code: MachineErrorCode, message: string, extra?: Record<string, string>) {
    super(message)
    this.name = 'MachineError'
    this.code = code
    this.extra = extra ?? {}
  }
}
