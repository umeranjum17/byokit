// In-process stand-in for an app's SSH transport (K-PHONE-SSH): the kit's quoted command runs on one
// `FakeMachine`, the same machine the other benches run, so a phone app's tests need no network or `ssh`.
import { connect, createServer, type Socket } from 'node:net';
import { MachineError } from '../errors.ts';
import type { SshTransport } from '../ssh-vm.ts';
import { FakeMachine, parseCommand } from './fake-machine.ts';

export type FakeSshTransport = SshTransport & {
  machine: FakeMachine;
  /** The server's current host key fingerprint; set another to model a replaced server. */
  fingerprint: string;
  /** Every command line the kit sent, in order. */
  commands: string[];
  /**
   * What listens on the machine's loopback: machine port to a real local port (a test's host on a socket), so a
   * forward to the machine's port reaches it. A port not listed refuses like a closed port.
   */
  loopback: Map<number, number>;
  /** Every `forward` the kit opened: the machine port it reached and whether it is still up. */
  forwards: { remotePort: number; open: boolean }[];
};

export function fakeSshTransport(o: { machine?: FakeMachine; fingerprint?: string } = {}): FakeSshTransport {
  const t: FakeSshTransport = {
    machine: o.machine ?? new FakeMachine(),
    fingerprint: o.fingerprint ?? `SHA256:${'A'.repeat(43)}`,
    commands: [],
    loopback: new Map(),
    forwards: [],
    hostKey: async () => ({ fingerprint: t.fingerprint }),
    exec: async (to, command, x) => {
      if (to.fingerprint !== t.fingerprint) throw new MachineError('host-key', 'the server host key changed');
      t.commands.push(command);
      const parsed = parseCommand(command, (p) => t.machine.readFile(p));
      return t.machine.run(parsed.argv, { root: parsed.root, input: x.input, asUser: parsed.asUser ?? undefined });
    },
    forward: async (to, remote) => {
      if (to.fingerprint !== t.fingerprint) throw new MachineError('host-key', 'the server host key changed');
      const sockets = new Set<Socket>();
      const server = createServer((local) => {
        const target = t.loopback.get(remote.port);
        sockets.add(local);
        local.on('close', () => sockets.delete(local));
        if (target === undefined) { local.destroy(); return; }
        const far = connect({ host: '127.0.0.1', port: target });
        sockets.add(far);
        far.on('close', () => { sockets.delete(far); local.destroy(); });
        local.on('close', () => far.destroy());
        far.on('error', () => local.destroy());
        local.on('error', () => far.destroy());
        local.pipe(far);
        far.pipe(local);
      });
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
      const record = { remotePort: remote.port, open: true };
      t.forwards.push(record);
      const closed = new Promise<void>((resolve) => server.once('close', () => { record.open = false; resolve(); }));
      const close = async (): Promise<void> => {
        for (const s of sockets) s.destroy();
        server.close();
        await closed;
      };
      return { localPort: (server.address() as { port: number }).port, close, closed };
    },
  };
  return t;
}
