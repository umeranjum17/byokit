// Node keeps the lazy pinned engine as its default; the portable client shares its validation and version gate.
import { Compose as PortableCompose } from './compose-core.ts';
import { inProcessEngine } from './engine.ts';
import type { ComposeOptions } from './types.ts';

export class Compose extends PortableCompose {
  constructor(o: ComposeOptions = {}) {
    super({ engine: o.engine ?? inProcessEngine() });
  }
}
