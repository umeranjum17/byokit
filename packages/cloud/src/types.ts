// Public types (docs/cloud-kit.md section 4: 4.1 with the 4.3 consumer additions merged in).
// Frozen at M1 (D-5): a change here is a spec change first — stop and ask.
export type MachineRef = {
  provider: string                // Provider.id
  account: string                 // provider account id, read once at setup; the kit refuses a ref from another account
  id: string                      // provider machine id
  name: string                    // ^[a-z][a-z0-9-]{0,31}$
  keepCopies: boolean             // provider snapshots on; false = no backups AND no sleep (section 11)
}

export type MachineState =
  | 'creating' | 'on' | 'asleep' | 'waking' | 'stopping'
  | 'unknown'                      // provider can't be asked (VM unreachable, API down)
  | 'failed'                       // provider reports an error
  | 'host-key-changed'             // SSH VM only: the pinned key no longer matches (section 13 rule 6)
  | 'gone'                         // deleted, or a create that never got a machine

export type HostState = 'not-installed' | 'installing' | 'running' | 'restarting' | 'stopped' | 'failed'

export type Size = { id: string; cpus: number; memoryGb: number; diskGb: number }
export type Price = {
  size: string
  perHour?: number; perMonthCap?: number
  planFloorPerMonth?: number       // minimum the person pays the provider each month
  asleepPerHour: number            // 0 on per-second sandbox APIs; = perHour on a VM that bills while off
  currency: 'USD' | 'EUR'
  basis: string                    // e.g. 'incl. IPv4, excl. VAT'
  source: string                   // public URL
  checked: string                  // YYYY-MM-DD
}
export type Cost = { perMonth: number; floor: number | null; currency: 'USD' | 'EUR'; basis: 'list' | 'usage' | 'entered'; checked: string; words: string }
export type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type Usage = { from: string; to: string; hours: number; amount: number; currency: 'USD' | 'EUR' }
export type KeyInfo = { expires: string | null; scopes: readonly string[] }

export interface Provider {
  readonly id: string              // 'sandbox-api' | 'ssh-vm'
  readonly label: string           // from the app, e.g. the provider's name; shown in words
  account(): Promise<string>
  sizes(): readonly Size[]
  prices(): readonly Price[]
  status(m: MachineRef): Promise<MachineState>
  exec(m: MachineRef, argv: readonly string[], o: { timeoutMs: number; root?: boolean; input?: Uint8Array }): Promise<ExecResult>
  write(m: MachineRef, path: string, bytes: Uint8Array, mode: number): Promise<void>
  // Optional. Absent means the adapter can't, and the UI hides the action.
  create?(o: { name: string; size: string; keepCopies: boolean; idempotencyKey: string }): Promise<MachineRef>
  wake?(m: MachineRef): Promise<void>                 // resolves at 'on'
  sleep?(m: MachineRef): Promise<void>
  snapshot?(m: MachineRef, name: string): Promise<{ name: string }>
  fork?(m: MachineRef, o: { name: string; size: string; idempotencyKey: string }): Promise<MachineRef>
  remove?(m: MachineRef, confirm: string): Promise<void>        // confirm must equal m.id; also removes the kit's named snapshots
  url?(m: MachineRef, port: number): Promise<string | null>     // provider HTTPS URL for a port bound on 0.0.0.0
  usage?(m: MachineRef, since: string): Promise<Usage>
  key?(): Promise<KeyInfo>                                      // provider key expiry and scopes
  plan?(): Promise<Plan>                                 // G2
  why?(m: MachineRef): Promise<AsleepWhy | null>         // G3: null when not asleep
  adopt?(): Promise<string>                              // SSH VM: the pinned host key's fingerprint, the adopted machine's id; rejects 'host-key' when unpinned
  selfId?: readonly string[]                             // G4: argv that prints this machine's provider id on the machine itself (15.1, fixed by M6)
  wakeKey?(m: MachineRef, o: { label: string }): Promise<{ id: string; key: string; expires: string | null }>  // G11 (M7)
  stopKey?(m: MachineRef): Promise<{ id: string; key: string; expires: string | null }>                    // M7
  revokeKey?(id: string): Promise<void>                  // G11 (M7)
}

export type HostRecipe = {
  name: string                                           // unit 'byokit-<name>.service'
  node: { version: string; sha256: Record<'linux-x64' | 'linux-arm64', string>; range?: string }  // G5a: the machine's node is used only if it satisfies this; default '>=<version>'
  install: readonly (readonly string[])[]                // argv lists, run once in workDir
  update?: readonly (readonly string[])[]
  run: { argv: readonly string[]; env: Readonly<Record<string, string>> }  // names matching /KEY|TOKEN|SECRET|PASSWORD/i refused
  workDir: string                                        // absolute, inside the machine user's home
  installRoot?: readonly (readonly string[])[]           // G5b: argv lists run as root before `install` and `update` when the 8.3 step 3 marker is missing; must be idempotent
  user?: string                                          // G7: run as this no-sudo user, created by the kit, home inside the machine user's home
}

export type AsleepWhy = 'you' | 'out-of-credit' | 'trial-limit' | 'provider' | 'idle'      // G3
export type Plan = { inTrial: boolean; trialEndsAt: string | null; canStayOn: boolean; checkoutUrl: string | null }  // G2

// The app's own persistence for the one MachineRef + provider key; the same load/save seam as
// recordStore(load, save) (packages/accounts/src/stores.ts:11). The kit imports no other kit.
export type MachineRecord = { ref: MachineRef | null; providerKey: string; monthlyEntered?: number }
export type MachineStore = { load(): Promise<MachineRecord | null>; save(r: MachineRecord): Promise<void> }

export interface Machine {
  readonly ref: MachineRef | null
  create(o: { name: string; size: string; keepCopies: boolean }): Promise<MachineRef>
  state(): Promise<MachineState>
  wake(): Promise<void>; sleep(): Promise<void>
  install(r: HostRecipe, onLine?: (line: string) => void): Promise<void>
  update(r: HostRecipe): Promise<void>
  host(): Promise<HostState>                             // systemctl is-active + NRestarts
  logs(lines: number): Promise<string[]>                 // journalctl, capped
  url(port: number): Promise<string | null>
  cost(): Promise<Cost>
  remove(confirm: string): Promise<void>
  plan(): Promise<Plan | null>                           // G2: null when the provider has no plan()
  why(): Promise<AsleepWhy | null>                       // G3 (5.7)
  deliver(r: HostRecipe, file: string, bytes: Uint8Array): Promise<void>  // G9 (5.8)
}
