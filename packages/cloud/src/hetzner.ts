// Node-only Hetzner: the portable HTTPS adapter (hetzner-api.ts) plus exec, write and the
// host key over the pinned SSH adapter, through the SSH-only app firewall.
import { join } from 'node:path';
import { sshVm, sshHostKey, type SshVmOptions } from './ssh.ts';
import { MachineError } from './errors.ts';
import { hetznerApi, type HetznerApiOptions, type HetznerApiProvider } from './hetzner-api.ts';
import type { MachineRef } from './types.ts';

export type HetznerOptions = HetznerApiOptions & { publicKey: string; ssh: Pick<SshVmOptions, 'ssh' | 'keyPath' | 'stateDir'> };
export type HetznerProvider = HetznerApiProvider & { hostKey(m: MachineRef): ReturnType<typeof sshHostKey> };

export async function hetzner(o: HetznerOptions): Promise<HetznerProvider> {
  if (typeof o.publicKey !== 'string') throw new MachineError('bad-recipe', 'project, location, Ubuntu/Debian image and an ed25519 public key are required');
  const api = await hetznerApi(o);
  const connection = async (m: MachineRef): Promise<SshVmOptions> =>
    ({ ...o.ssh, stateDir: join(o.ssh.stateDir, m.id), host: await api.address(m), user: 'user', label: o.label });
  return {
    ...api,
    exec: async (m, argv, opts) => sshVm(await connection(m)).exec(m, argv, opts),
    write: async (m, path, bytes, mode) => sshVm(await connection(m)).write(m, path, bytes, mode),
    hostKey: async m => sshHostKey(await connection(m)),
  };
}
