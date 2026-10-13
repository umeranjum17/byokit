// Member attribution (5.15, O14m): the one shared helper mapping an agent id or an
// `agent:<agent>:<tail>` session key to its member. An `<member>--<hex6>` account agent maps to
// `<member>`, `byokit-key-<member>` to `<member>`; anything else maps to itself when it is a member
// id, else undefined. Index membership is checked by accounts.ts `memberOfAccount`, not here, so this
// module stays portable (device.ts imports it; test/portable.test.ts guards that).
import type { Member } from './types.ts';

const MEMBER = /^[a-z][a-z0-9-]{0,31}$/;
const HEX6 = /^[0-9a-f]{6}$/;
const KEY_PREFIX = 'byokit-key-';

export function memberOf(ref: string): Member | undefined {
  let agent: string;
  if (ref.startsWith('agent:')) {
    const m = /^agent:([^:]+):/.exec(ref);
    if (!m) return undefined;
    agent = m[1]!;
  } else {
    agent = ref;
  }
  if (agent.startsWith(KEY_PREFIX)) {
    const inner = agent.slice(KEY_PREFIX.length);
    return MEMBER.test(inner) ? inner : undefined;
  }
  const dash = agent.lastIndexOf('--');
  if (dash >= 0) {
    const head = agent.slice(0, dash);
    const tail = agent.slice(dash + 2);
    if (MEMBER.test(head) && HEX6.test(tail)) return head;
  }
  return MEMBER.test(agent) ? agent : undefined;
}
