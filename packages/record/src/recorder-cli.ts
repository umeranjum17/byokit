import { recorderMain } from './recorder.ts';

process.umask(0o077);
// This is the supervised recorder process, not the library: its environment was built
// from nothing by Capture. Do not inherit it from an unsupervised host.
const env: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XAUTHORITY'] as const) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
process.exitCode = await recorderMain(process.argv.slice(2), line => console.log(line), {
  platform: process.platform, ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe', env,
});
