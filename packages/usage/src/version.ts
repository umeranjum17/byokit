// How every BYOKit app and command says which version is running: the released version itself, a semver
// pre-release, or a build of source that has changes since the last release. No dependencies; Node, browsers and
// React Native. Reading a package.json from disk is `@byokit/usage/version/node`.

/** What a build is: a published release, a semver pre-release, or a dev build of unreleased source. */
export type Channel = 'release' | 'pre-release' | 'dev';
export type BuildVersion = { version: string; channel: Channel };

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** A manifest's version as this build runs it; `unreleased` (changes since `version`) makes it `<version>+dev`. */
export function buildVersion(version: string, opts: { unreleased?: boolean } = {}): BuildVersion {
  const m = SEMVER.exec(version);
  if (!m) throw new TypeError(`"${version}" is not a semver version`);
  if (opts.unreleased) return { version: `${version.replace(/\+.*$/, '')}+dev`, channel: 'dev' };
  return { version, channel: m[1] ? 'pre-release' : 'release' };
}

/** `0.31.0`, `0.32.0-beta.1 (pre-release)`, or `0.31.0+dev (dev build)`. */
export function versionLabel(v: BuildVersion): string {
  return v.channel === 'release' ? v.version : `${v.version} (${v.channel === 'dev' ? 'dev build' : 'pre-release'})`;
}

/** An app and the host it talks to, side by side: `App 0.2.13 · Host 0.2.10`, plus a hint when they differ. */
export function pairLabel(app: BuildVersion, host: BuildVersion | undefined): { text: string; mismatch?: string } {
  const text = `App ${versionLabel(app)} · Host ${host ? versionLabel(host) : 'not connected'}`;
  if (!host || host.version === app.version) return { text };
  return { text, mismatch: 'The app and the host run different versions: update the older one, then reload.' };
}
