#!/usr/bin/env python3
"""Render the iOS launch-screen logo as PNGs, straight from the mark's geometry.

    python3 docs/brand/logo/build_launch_logo.py

`UILaunchScreen` takes an image set, not a vector, and the SwiftUI continuation
view in OPLaunch.swift is pixel-matched to it — so these three files have to be
exactly 88, 176 and 264 px, which is `logoSize` at 1x, 2x and 3x.

Written with transparency, unlike the placeholder they replace: the launch
background is a colour set with a light and a dark value, so the voids and the
area around the disc must take whatever that colour is rather than baking one in.
"""
import pathlib
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import build_identity as identity  # noqa: E402

OUT = pathlib.Path(__file__).parent
XCASSETS = (
    OUT.parents[2]
    / "resume-designer/src-tauri/gen/apple/Assets.xcassets/LaunchLogo.imageset"
)

SS = 8  # supersample, then downsample — PIL's draw has no antialiasing of its own
CORAL = (232, 80, 58, 255)
SIZES = {"LaunchLogo.png": 88, "LaunchLogo@2x.png": 176, "LaunchLogo@3x.png": 264}


def render(px):
    """The mark at `px` square, cropped to the disc, on transparency."""
    n = px * SS
    s = n / identity.DISC_D                      # grid units -> supersampled px
    ox = oy = identity.CX - identity.DISC_R      # the disc's top-left in grid units

    def gx(v):
        return (v - ox) * s

    def gy(v):
        return (v - oy) * s

    mask = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(mask)

    # The disc, then the two voids punched back out of it.
    d.ellipse([gx(identity.CX - identity.DISC_R), gy(identity.CY - identity.DISC_R),
               gx(identity.CX + identity.DISC_R), gy(identity.CY + identity.DISC_R)], fill=255)
    d.rounded_rectangle(
        [gx(identity.STEM_X0), gy(identity.STEM_CAP_TOP - identity.STEM_R),
         gx(identity.STEM_X1), gy(identity.STEM_CAP_BOT + identity.STEM_R)],
        radius=identity.STEM_R * s, fill=0,
    )
    d.ellipse([gx(identity.DOT_CX - identity.DOT_R), gy(identity.DOT_CY - identity.DOT_R),
               gx(identity.DOT_CX + identity.DOT_R), gy(identity.DOT_CY + identity.DOT_R)], fill=0)

    img = Image.new("RGBA", (n, n), CORAL)
    img.putalpha(mask)
    return img.resize((px, px), Image.LANCZOS)


if __name__ == "__main__":
    for name, px in SIZES.items():
        img = render(px)
        img.save(OUT / name)
        if XCASSETS.is_dir():
            img.save(XCASSETS / name)
    print(f"wrote {len(SIZES)} launch logos to {OUT}")
    print(f"  and into {XCASSETS.relative_to(OUT.parents[2])}"
          if XCASSETS.is_dir() else "  (xcassets not found — copy them yourself)")
