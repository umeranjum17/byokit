# Changelog

## Unreleased

Private candidate: native runtime qualification is pending. Do not publish these
notes until each surface's qualification gate is recorded.

- SECURITY: On Android a share can no longer make the app read its own private files: content URIs served by
  the app's own providers (including the `N@authority` form) are refused; that item is left out with
  `skipReasons` `own_provider`, and the share reports `errorCode: 'unreadable'`, or `'partial'` when other
  files were read. expo-share-intent 8.0.1 copies such content into the cache and hands its path to JS.
- FIX: Sharing a file the app may not read, or a `file://` URI (refused as `not_content`), no longer crashes
  the Android app, cold or warm; that file is left out, and the share reports `errorCode: 'partial'` with the
  readable files, or `'unreadable'` when none could be read.
- FIX: On iOS a link of the form `<scheme>://dataUrl=…` that did not come from the app's own share extension
  is ignored and reported as `errorCode: 'invalid_share_url'` instead of reaching expo-share-intent's native
  module, which can crash on it.
- FIX: `appleTargets` keeps @bacons/apple-targets 5.0.0 from taking over another plugin's extension target
  (such as expo-widgets' `ExpoWidgetsTarget`) on a fresh iOS prebuild. Checked by prebuild only.
- FIX: `desklink` builds @desklink/react-native 0.3.0 as an Expo module, so it no longer crashes at launch on
  Expo SDK 57, without a postinstall patch.
- Receive shared text and files with `useShareIntent`, `ShareIntentProvider` and the rest of
  expo-share-intent's public API; reads run off the main thread and image and video sizes are still reported.
