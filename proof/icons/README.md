# Example app icons

All artwork comes from the approved `docs/brand/` masters. Regenerate the assets and the contact sheet with:

```sh
python3 scripts/app-icons.py
```

Requires Python 3, librsvg (`rsvg-convert`) and ImageMagick 7 (`magick`), the same toolchain as the brand masters. SVG masters are rasterized directly at each target size; never upscale a small PNG.

| App | Icon surfaces | Wiring |
| --- | --- | --- |
| Expo | 1024 RGB app/iOS store icon and 512 RGB Google Play icon; full iPhone/iPad AppIcon set; Android legacy launcher 36–192 px, adaptive foreground/monochrome 81–432 px, notification 18–96 px; favicon; overlay moods | `app.json`, `icon-plugin.cjs`, status example's `byokit_notification` drawable |
| PWA | ICO 16/32, SVG favicon, 180 touch icon, 192/512 regular and 512 maskable manifest icons | Both HTML entry pages, manifest, static server MIME types and service-worker shell |
| Herdr-kit | Same web set | HTML, manifest and explicit host routes |
| OpenClaw-kit | Same web set | HTML, manifest and explicit host routes |

There are no Electron/desktop binaries, tray applications, browser extensions or separate store-listing apps in `examples/`. The two kit hosts are terminal processes with browser phone pages. `android/` is a library, not an app. Expo's web setting supplies a favicon; its runnable native targets are Android/iOS (no React DOM/React Native Web dependencies).

Native directories remain generated and ignored. The Expo config plugin copies committed Android drawables/mipmaps and the iOS AppIcon catalog on every prebuild. Adaptive XML has a monochrome layer on API 33+; older devices use the API 26 layers or density-specific legacy PNGs. Overlay and status notifications explicitly select the white-on-transparent drawable rather than falling back to a full-color launcher bitmap.

`contact-sheet.png` includes every generated PNG at its real size: view/download at 100%. The last row shows circle and squircle masks for Android adaptive layers, themed monochrome and the PWA maskable master. Android previews crop the central 72dp viewport from a 108dp foreground, matching launcher framing. The explicitly labelled solid ink tile is the Android adaptive background layer, composed with the foreground in the mask previews; it is not a standalone app icon. Marketing/AppIcon PNGs have no alpha channel.

`expo-launcher.png` is the installed example on an Android emulator (details recorded after capture below).

Validation: Expo Android release APK built after prebuild and installed on an isolated Pixel 7 AVD, Android 15 / API 35 (`google_apis;x86_64`, 1080×2400, 420 dpi). The screenshot shows the example in the launcher app drawer. `expo-launcher-themed.png` shows its monochrome layer rendered by Pixel Launcher on the home screen with themed icons enabled. iOS prebuild copied the full catalog successfully; no iOS simulator was used. The status kit requires API 36+, so API 35 does not post its notification: the small-icon resource selection and all density assets are verified here, but status-chip rendering is not claimed on this emulator. The overlay foreground-service notification uses the same drawable and was rendered successfully: see `expo-notification.png`. Both marketing and PWA maskable PNGs are RGB without alpha; repeating generation produces byte-identical files.
