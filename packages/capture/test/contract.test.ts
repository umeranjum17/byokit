// BK-C2 acceptance: the whole captureContract (docs/capability-kits.md 5.5) against the fake recorder, once for an X
// desktop and once for the person's own screen.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { Capture } from '../src/capture.ts';
import { captureContract, fakeRecorder } from '../src/testing/index.ts';
import type { Source } from '../src/types.ts';

const display = {
  WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  HYPRLAND_INSTANCE_SIGNATURE: 'sig', XAUTHORITY: '/run/user/1000/xauth',
};

// `x11::99` is `x11:` followed by the display `:99` (the 6.4 grammar).
for (const source of ['x11::99', 'screen'] as Source[]) {
  captureContract(async () => {
    const dir = scratchDir('capture-contract');
    const fake = fakeRecorder({ dir: join(dir, 'fake') });
    const root = join(dir, 'takes');
    mkdirSync(root);
    return { capture: new Capture({ bin: fake.bin, stateDir: join(dir, 'state'), display }), source, root, fake };
  });
}
