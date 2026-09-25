// Nothing from the person's own AI tools or shell may reach the app's engine. No Pi import here: an app imports this
// first, because Pi's coding agent reads some of these at import time.
import { mkdirSync } from 'node:fs';
import type { AuthContext } from '@earendil-works/pi-ai';

/** Inherited Pi settings, and provider keys that would let the app run on someone's account without signing in. */
export const INHERITED = /^(PI_|AI_AGENT$|ANTHROPIC_|AWS_|AZURE_|GOOGLE_|GCLOUD_|CLOUDFLARE_)|_API_KEY$|^(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|HF_TOKEN)$/;

/** Ambient discovery switched off: no environment variable or credential file is ever consulted. */
export const emptyAuthContext: AuthContext = { env: async () => undefined, fileExists: async () => false };

/** Scrub inherited settings and keys from this process, and pin Pi's agent folder to `dir` (never ~/.pi). Returns `dir`. */
export function isolate(dir: string) {
  for (const k of Object.keys(process.env)) if (INHERITED.test(k)) delete process.env[k];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  Object.assign(process.env, { PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' });
  return dir;
}
