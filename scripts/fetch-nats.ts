// CI: downloads the pinned, hash-checked nats-server into the folder given as argv[2] and prints its path, so the
// `@byokit/nats` tests can run the real server (BYOKIT_NATS_BIN). The tests themselves never touch the network.
import { fetchNats } from '../packages/nats/src/binary.ts';

if (!process.argv[2]) throw new Error('usage: node scripts/fetch-nats.ts <dir>');
console.log(await fetchNats({ dir: process.argv[2] }));
