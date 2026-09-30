import { fileURLToPath } from 'node:url';

// Works both in Node's source runner and in the published dist tree.
export const bundledRecorder = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './recorder-cli.ts' : './recorder-cli.js', import.meta.url));
