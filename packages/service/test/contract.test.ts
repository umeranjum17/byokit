// The docs/service-kit.md 8 contract against the fake exec: runs everywhere — locally, under
// scripts/test.sh's throwaway HOME and in CI — with no real manager, no filesystem outside a
// scratch bin and no network.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, status, uninstall, type ServiceOptions } from '../src/index.ts';
import { FakeSystemd, serviceContract, type ServiceBench } from '../src/testing.ts';

const fakeBench = (): ServiceBench => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-service-contract-'));
  const bin = join(dir, 'host.sh'); // stat-ed by checkBin; the fake never runs it
  writeFileSync(bin, '#!/bin/sh\nexec sleep 300\n');
  chmodSync(bin, 0o755);
  const fake = new FakeSystemd();
  return {
    bin,
    service: {
      install: (o: ServiceOptions) => install({ ...o, exec: fake.exec }),
      status: (o: ServiceOptions) => status({ ...o, exec: fake.exec }),
      uninstall: (o: ServiceOptions) => uninstall({ ...o, exec: fake.exec }),
    },
    fake,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
};

serviceContract('fake', fakeBench);
