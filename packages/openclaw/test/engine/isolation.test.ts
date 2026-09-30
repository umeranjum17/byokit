import { test } from 'node:test';
import { isolationContract } from '../isolation-contract.ts';

test('pinned engine stays within its state directory and loopback', { timeout: 360_000 }, () => isolationContract());
