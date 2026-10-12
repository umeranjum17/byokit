// The computer's side of provisioning-token enrolment: after `RelayClient` comes online with a `provision`
// binding, grant exactly the phone key the token named, through link's own durable grants. No QR, no approval tap:
// the approval happened when the signed-in phone minted the token, and the Noise handshake still pins both keys.
import { unb64url, type Grant, type Host } from '@byokit/pair';
import { parseProvisionBinding, type ProvisionBinding } from './relay.ts';

/** Grants the bound phone key its durable link grant, or null when this host claimed no provisioning binding.
 *  Throws a plain sentence for a binding that is not one the relay could have stored. */
export async function claimProvision(host: Pick<Host, 'enrol'>, provision: ProvisionBinding | undefined): Promise<Grant | null> {
  if (provision === undefined) return null;
  const bound = parseProvisionBinding(provision);
  return host.enrol({ key: unb64url(bound.deviceKey), name: bound.deviceName ?? 'Phone', role: bound.role ?? 'control' });
}
