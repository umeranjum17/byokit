// In-process stand-in for an app's SSH transport (K-PHONE-SSH): the kit's quoted command runs on one
// `FakeMachine`, the same machine the other benches run, so a phone app's tests need no network or `ssh`.
import { MachineError } from '../errors.ts';
import type { SshTransport } from '../ssh-vm.ts';
import { FakeMachine, parseCommand } from './fake-machine.ts';

export type FakeSshTransport = SshTransport & {
  machine: FakeMachine;
  /** The server's current host key fingerprint; set another to model a replaced server. */
  fingerprint: string;
  /** Every command line the kit sent, in order. */
  commands: string[];
};

export function fakeSshTransport(o: { machine?: FakeMachine; fingerprint?: string } = {}): FakeSshTransport {
  const t: FakeSshTransport = {
    machine: o.machine ?? new FakeMachine(),
    fingerprint: o.fingerprint ?? `SHA256:${'A'.repeat(43)}`,
    commands: [],
    hostKey: async () => ({ fingerprint: t.fingerprint }),
    exec: async (to, command, x) => {
      if (to.fingerprint !== t.fingerprint) throw new MachineError('host-key', 'the server host key changed');
      t.commands.push(command);
      const parsed = parseCommand(command, (p) => t.machine.readFile(p));
      return t.machine.run(parsed.argv, { root: parsed.root, input: x.input, asUser: parsed.asUser ?? undefined });
    },
  };
  return t;
}
