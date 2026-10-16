import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorWords, install, ServiceError } from '../src/index.ts';

test('a bad-bin rejection reads as a setup failure, not a stopped host', async () => {
  const caught = await install({ name: 'echo', bin: 'rel/echo' }).catch((e: unknown) => e);
  assert.ok(caught instanceof ServiceError);
  assert.equal(caught.code, 'bad-bin');
  assert.equal(errorWords(caught, { app: 'Tracker' }), 'Tracker could not be set up on this computer.');
});
