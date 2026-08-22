# Brand assets

Everything here is derived from two files you supplied, kept at the repo root:

- `app_icon.jpeg` — the rounded-square icon. It is a JPEG with a checkerboard
  *painted into it*, not a transparent PNG, so the icon was cut out of it by
  measuring the dark rim (1010×1010 at +904+259) and the corners were cleared
  with a mask matched to the artwork's own radius, ~22% of the side.
- `feather.png` — the mark, already transparent. Trimmed to 1253×1024.

## Masters

| file | what it is |
|---|---|
| `icon-master-1010.png` | the icon exactly as cut, corners transparent |
| `icon-rounded-1024.png` | the same at 1024, full bleed — the source for web and iOS |
| `macos/icon-1024.png` | the icon at 824px on a 1024 canvas, Apple's macOS grid |

## macOS — `macos/`

`icon.icns` plus the `Inkju.iconset` it was built from: 16, 32, 128, 256 and
512pt, each at 1× and 2×, so every Retina step has real pixels rather than an
upscale. `icon.icns` and `icon-1024.png` are copied to `desktop/build/`, which
is where electron-builder picks them up.

The .icns is ~6 MB. Brushed metal is noise, and noise does not compress; that
is the price of this artwork rather than a mistake.

## iOS — `ios/`

20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180 and 1024, opaque, no alpha,
**square**.

Square is deliberate. iOS applies its own rounded mask, so an icon that already
has rounded corners gets rounded twice and shows dark notches. The supplied art
is a rounded square, so the corners here are filled from the icon's own interior
and the rim sits just inside the edge. If you want this pixel-perfect for the
App Store, the right fix is artwork drawn square from the start.

## Logo — `logo/`

| file | use |
|---|---|
| `logo-feather.png` (+`@2x`, `@3x`) | the mark in colour, transparent |
| `logo-feather-white.png` | white silhouette, for dark backgrounds |
| `logo-feather-ink.png` | ink silhouette, for light backgrounds |

## Web — `web/`

`favicon.ico` (16/32/48), `favicon-16`, `favicon-32`, `favicon-48`,
`apple-touch-icon` (180), `icon-192`, `icon-512`, `icon-maskable-512` and
`icon.png` (256, the nav mark). The maskable one keeps the art inside the safe
circle, because Android crops to one.

These are copied into `docs/assets/` and referenced from `docs/index.html` and
`docs/site.webmanifest`.

## Regenerating

The whole set comes from the two source files with ImageMagick and `iconutil`.
The one number to keep is the crop: `1010x1010+904+259` of `app_icon.jpeg`,
with a corner radius of 222 at that size.
