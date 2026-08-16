# On Paper — the mark

The identity is **Loose Leaf**: a solid disc holding two voids in conversation —
a rounded stem and a departed bowl. The P is made of the ground and never drawn
at all, which is why the mark is one silhouette and reads as a single object at
any size.

Everything here is generated. Edit the constants, re-run, and every file moves
together:

```bash
python3 docs/brand/logo/build_identity.py     # mark + app icons
python3 docs/brand/logo/build_lockup.py       # lockups (needs fonttools + brotli)
python3 docs/brand/logo/build_launch_logo.py  # iOS launch screen PNGs (needs pillow)
```

## Where it stands

Chosen from a shortlist of three. Measured — enclosed void area, rasterised at
real icon sizes:

| | 32px | 24px | 16px |
|---|---|---|---|
| **Loose Leaf** | 45 + 44 | 24 + 23 | **10 + 10** |
| One Stroke | 49 | 25 | 9 |
| Initial | 15 | 8 | 3 |

Both voids stay separate components all the way down to 16px, so the drawing
holds. That contradicts the concern raised when it was drawn — that the
66-unit bridge between the voids would fuse at icon size — and the measurement
is why it ships at the width it was drawn at rather than widened.

Its honest weakness, recorded so nobody has to rediscover it: **a disc with a
bar and a dot cut out of it is close to Patreon's old bar-and-circle mark,
inverted.** Without the wordmark beside it, it can also read as "IO" or a
lowercase "i." before it reads as P. This was known and accepted when the mark
was chosen; it is not a discovery waiting to be made.

## The geometry

On a 1024 grid, all values exact:

| | value | why |
|---|---|---|
| Disc | centre 512,512 · radius 340 | 680 across, 66% of the canvas |
| Stem void | x 311–441, y 322–702 | a stadium: 130 wide, cap radius exactly half that |
| Stem cap centres | 376, 387 and 376, 637 | |
| Bowl void | centre 627,452 · radius 120 | free-floating, where a P's counter would sit |
| Bridge | 66 | what the two voids leave between them |
| **Clearance to the disc's edge** | **90.3 · 90.3 · 90.3** | **stem top, stem bottom, bowl — the invariant** |

### Centring: one rule, after two wrong ones

**Every void sits the same distance from the disc's edge — 90.3 units.** Stem top
cap, stem bottom cap, bowl. That is the invariant to preserve if any of these
numbers are ever touched.

It puts the voids +17 horizontally from where they were first drawn, and exactly
where they were drawn vertically. Two other rules were tried first and both
produced a mark that looked wrong:

**Bounding box** (how it was first drawn). Centred by its extremes — and the
extremes here are a narrow stem on one side and a wide bowl on the other. Stem 77
from the edge, bowl 105: the mark read left.

**Mass centroid.** Rasterise the voids, weigh them, centre that. Correct on paper
and wrong in the eye: it put the bowl 80 from the edge against the stem's 98, so
the mark read *right* instead — the same error mirrored. Applied to the vertical
it was worse, moving the stem off its own symmetry to 118 above and 76 below, a
42-unit imbalance around the most conspicuous element in the mark.

Vertically the rule and the original drawing already agreed, which is why nothing
moved on that axis: the stem's caps are symmetric about the disc's centre line by
construction. The group's mass sits 30 units high and that is correct — it is the
bowl, and a P's bowl belongs high.

Scaling the voids down was tested and rejected separately: 6% smaller buys back
clearance, but takes the smaller void from 10 rasterised pixels to 7 at 16px, and
surviving small sizes is the property this mark was chosen for.

One decision does the work: **the mark is a single path filled `evenodd`**, so
the voids are HOLES rather than paper-coloured shapes laid on top. Drawn the
other way it would only ever work on paper; as holes it takes whatever is behind
it, which is what makes it reversible onto ink and coral without redrawing.

At icon scale the mark is enlarged 1.15× about the canvas centre — a circular
mark reads smaller inside a squircle than its measurements suggest, so the disc
goes from 66% to 76% of the tile.

## The files

**Mark** — transparent, cropped to its own bounding box, for documents, the web
and lockups.

- `mark-coral.svg` · `mark-ink.svg` · `mark-paper.svg`

**App icons** — 1024 square, full bleed. iOS masks these to its squircle and
forbids alpha; Windows takes them square.

- `icon-paper.svg` — **the primary.** A coral disc on Paper: the brand is ink on
  paper, and a quiet warm tile is more distinctive on a home screen full of
  saturated ones.
- `icon-ink.svg` — a paper disc on Ink, the dark-mode counterpart.
- `icon-coral.svg` — a paper disc on Coral, for the store listing and marketing.

**macOS icons** — macOS masks nothing, so the shape is in the artwork: Apple's
rounded square, 824×824 on the 1024 canvas, corner radius 185.4, transparent
beyond it.

- `icon-macos-paper.svg` · `icon-macos-ink.svg` · `icon-macos-coral.svg`

**Lockups** — the wordmark is Geist Semibold **converted to outlines**, so the
files render identically without the font installed. Kerned with the font's own
pairs; nothing eyeballed.

- `lockup-horizontal.svg` — a disc has no baseline, so the wordmark's cap box is
  centred on the disc's centre line instead. Cap height is 40% of the disc's
  diameter; the gap is 26% of it.
- `lockup-horizontal-mono-ink.svg` — single colour, for anywhere coral cannot go.
- `lockup-horizontal-reversed.svg` · `lockup-stacked.svg` ·
  `lockup-stacked-reversed.svg`

## Where it is installed

`resume-designer/src-tauri/icons/` — regenerate with:

```bash
cd resume-designer && npx tauri icon ../docs/brand/logo/icon-paper.svg
```

That writes the PNG sizes, `icon.ico`, the iOS `AppIcon` set into
`gen/apple/Assets.xcassets/`, and Android's mipmaps. It also writes `icon.icns`
from the same full-bleed source, which is **wrong for macOS** — the Dock does
not mask, so a full-bleed square shows as a square. Overwrite it:

```bash
cd resume-designer && npx tauri icon ../docs/brand/logo/icon-macos-paper.svg -o /tmp/opmac
cp /tmp/opmac/icon.icns src-tauri/icons/icon.icns
```

`src-tauri/icons/ios/` is a stale directory from an earlier tooling version and
is not read by the build. The live iOS icons are the ones in
`gen/apple/Assets.xcassets/AppIcon.appiconset/`.

### The launch screen

`UILaunchScreen` (declared in `gen/apple/project.yml`) shows `LaunchLogo` over
the `LaunchBackground` colour set, and `OPLaunch.swift` draws a SwiftUI
continuation pixel-matched to it — so the logo has to be a PNG image set at
exactly 88, 176 and 264 px, which is `logoSize` at 1x/2x/3x.
`build_launch_logo.py` renders those from the same geometry and writes them
straight into the asset catalogue.

They are written **with an alpha channel**, unlike the placeholder they replaced:
`LaunchBackground` has a light and a dark value, so the disc's voids and the area
around it must take whatever that colour is instead of baking one in.

### The website

`website/favicon.svg` carries the mark on a Paper tile with the same rounded
corner the previous favicon had. It is a tile rather than a bare mark because a
favicon lands on browser chrome of unknown colour.
