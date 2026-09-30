# byokit brand

The byokit mark is a lowercase **b** with a blue dot beside it: the person's own device, on and paired. It is
drawn on a 24-unit grid from three shapes (a rounded stem, a ring and a dot), so it reads at 16 px and holds up as a
one-colour silhouette.

## Colours

| Token | Hex | Use |
|---|---|---|
| `ink` | `#1b1b1a` | App icon background, the mark on light surfaces, text |
| `paper` | `#f6f5f2` | The mark on the icon, light backgrounds |
| `accent` | `#1f5eff` | The dot; buttons and links in the example apps |

These are the same values as `--ink`, `--bg` and `--accent` in the light theme of the kit examples' web UIs.

## Files

| File | What it is |
|---|---|
| `mark.svg` | Vector master: ink b, accent dot, transparent, 24×24 grid |
| `icon.svg`, `icon-1024.png` | App icon master: paper b and accent dot on an opaque ink square, no alpha (iOS, Expo `icon`, PWA `any`) |
| `foreground.svg`, `foreground.png` | Android adaptive-icon foreground, transparent 1024², whole mark inside the 66/108 safe circle; pair with an `ink` background |
| `monochrome.svg`, `monochrome.png` | One-colour white silhouette, same placement as the foreground (Android themed icons, notifications) |
| `maskable-512.png` | PWA `maskable` icon: opaque ink, mark inside the 40% safe zone |
| `preview.png` | The icon at 16, 32, 48, 192 and 512 px, in circle, squircle and rounded-square masks, as a themed icon, on light and dark |

## Regenerating

Every file here comes from `build.py` (Python 3 standard library, `rsvg-convert` and ImageMagick 7's `magick`):

```sh
python3 docs/brand/build.py
```

Change the geometry or the colours in `build.py`, never the outputs by hand.
