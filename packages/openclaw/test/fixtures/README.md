# Licensed pinned patch input

`workshop-review-2026.8.1.js` is the unmodified `dist/experience-review-default-6DPIIJds.js` from npm `openclaw@2026.8.1`, commit `ea806575e6450e4d1efdfc72c19f04be982a1b9b`.
SHA256: `30f43da07b2520dd785df42ba417737a0f2cc0286922fe2189f06ecbafc1ab9c`.
The tarball integrity is pinned in `../../engine/package-lock.json`; its full MIT copyright/permission notice is `../../engine/OPENCLAW-LICENSE`.

Fake-engine unit fixtures need the authentic before bytes now that the published manifest includes a semantic patch. They never execute this module. These tests qualify installer handling, **not** native engine accounting; `../engine/day-usage.test.ts` owns the latter. On a pin change, regenerate from that lock and rederive the manifest, never hand-edit the checksum.
