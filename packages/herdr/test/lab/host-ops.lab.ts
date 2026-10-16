// The contract's host-edit journey (`rename`, `focus`, `layout`) against a real Herdr in a named lab session,
// adopted on that session's own socket — never the `default` session.
//
// Not matched by `npm test`'s glob: run by hand under a `--herdr-lab` brief, with the session provisioned and
// torn down by the Herdr lab helper (which owns the default-session tripwire), and its socket passed in:
//
//   HERDR_LAB_SOCKET=<lab session socket> node packages/herdr/test/lab/host-ops.lab.ts
import { test } from 'node:test';
import { HerdrKit } from '../../src/kit.ts';
import { herdrContract } from '../../src/testing/index.ts';

const socketPath = process.env.HERDR_LAB_SOCKET;
if (!socketPath || socketPath.includes('/default/')) throw new Error('host-ops lab: HERDR_LAB_SOCKET must name a lab session socket');

herdrContract(async () => ({ kit: new HerdrKit({ mode: 'adopt', bin: 'herdr', socketPath }) }),
  (name, fn) => { if (name.includes('host rename, focus and layout')) test(name, fn); });
