# @byokit/share

Guarded shared text and files. Private at 0.1.0 until packed/native qualification.

The React Native entry supplies the published share API with additive `errorCode`,
`skipped`, and `skipReasons`. The default entry is native-free and reports
`shareSupported = false`. The RN entry imports `expo-share-intent` and `expo-linking`.
Import through this kit: direct upstream imports bypass its guards.

```json
["@byokit/share", {
  "shareIntent": { "androidIntentFilters": ["text/*", "image/*"], "androidMultiIntentFilters": ["image/*"] },
  "appleTargets": {},
  "desklink": true
}]
```

Supply an app scheme for iOS, or set `shareIntent.disableIOS: true`. Do not also
list the upstream share or target plugin: the kit invokes each selected plugin.
All upstream plugin options pass through, including any apple target `match` glob.
The plugin loads Expo lazily from the app and changes only generated native projects,
never dependencies in `node_modules`. Desklink-only and target-only apps need not
import the JavaScript entry; they still link the inert share receiver.

Qualified pins are expo-share-intent 8.0.1, @bacons/apple-targets 5.0.0,
@desklink/react-native 0.3.0, Expo 57.0.25 and React Native 0.86.3. Other versions
require requalification. iOS native build/device behavior is not qualified here.

## Android rules and limits

Keep MainActivity `singleTask`. The plugin rejects other launch modes. For a bare
app that never runs prebuild, set `expo.autolinking.android.exclude` in package.json
to `["expo-share-intent"]` yourself and preserve `singleTask`.

Only foreign `content://` URIs are read under the sender's existing grant. Own
providers and `N@authority` routes are refused. No persistable or copied grants.
Each file is copied into the app cache on IO; inaccessible or over-100-MB files
are skipped individually. Image/video metadata is measured from the private copy;
metadata failure does not discard a readable file. Audio duration stays null.

One pending share, last wins. Copy/upload files before resetting: their paths stay
until the next read after they stop being the delivered share, or process restart.
A clear affects only the already delivered sequence, not pending or in-flight shares.
Reset before first delivery does not suppress that delivery. Reset with `false`
can show the last share again after remount. Shares during app loading can be dropped
by Expo. Process death/recreation may replay a share or lose an unfinished read.
A stalled provider cannot be interrupted; later reads are not coalesced behind it.

## iOS limits

The kit rejects malformed share links before calling native code. Upstream's
app-group decoding remains native and can still fail on corrupt data. Foreign
extension targets are hidden only during the target plugin's pass, then restored;
watch/App Clip targets and global development-team settings stay unchanged. Adding
an owned target to an existing project requires `expo prebuild --clean`.
A later base-mod post-action can fall outside the hide/manifest assertion window.

See the PR qualification evidence for observed surfaces; tests alone do not prove
user-visible native output or compatibility on other devices.
