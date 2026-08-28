#!/usr/bin/env python3
"""Generate the On Paper identity from one set of numbers.

Every file in this directory is emitted from the constants below, so the mark
cannot drift between the app icon, the reversed version and the lockup. Edit the
constants, re-run, and everything moves together.

    python3 docs/brand/logo/build_identity.py

The mark is "Loose Leaf": a solid disc holding two voids in conversation — a
rounded stem and a departed bowl, so the P is made of the ground and never drawn
at all. One path, one silhouette, filled `evenodd`, which is what lets it sit on
any colour without the voids needing to know what is behind them.
"""
import pathlib

OUT = pathlib.Path(__file__).parent

# ── Palette (docs/brand/on-paper-brand-guide.md §11) ────────────────────────
CORAL = "#E8503A"
PAPER = "#F4EFE6"
INK = "#0C0A08"
WHITE = "#FFFFFF"

# ── The mark, on a 1024 grid ────────────────────────────────────────────────
CX, CY = 512.0, 512.0
DISC_R = 340.0

# The stem void: a stadium, so its cap radius is exactly half its width.
STEM_X0, STEM_X1 = 311.0, 441.0
STEM_CAP_TOP, STEM_CAP_BOT = 387.0, 637.0          # centres of the two caps
STEM_R = (STEM_X1 - STEM_X0) / 2                   # 65

# The bowl, departed: a free-floating dot where a P's counter would sit.
DOT_CX, DOT_CY, DOT_R = 627.0, 452.0, 120.0

# The voids sit +17 horizontally from where they were first drawn, and exactly
# where they were drawn vertically. Both numbers come from ONE rule, arrived at
# after getting it wrong twice by using two others:
#
#   EVERY VOID SITS THE SAME DISTANCE FROM THE DISC'S EDGE — 90 units.
#
# Stem top cap 90, stem bottom cap 90, bowl 90. Nothing else about this mark is
# a coincidence either, but that one is worth stating as the invariant, because
# it is the thing to preserve if any of these numbers are ever touched.
#
# The two rules it replaced, and why each failed:
#
#   BOUNDING BOX (the original). Centred by extremes, and the extremes here are
#   a narrow stem on one side and a wide bowl on the other. It put the stem 77
#   from the edge and the bowl 105 — the mark read left.
#
#   MASS CENTROID. Rasterise the voids, weigh them, centre that. Correct on
#   paper and wrong in the eye: at +28 it put the bowl 80 from the edge against
#   the stem's 98, so the mark read right instead. Applied to the VERTICAL it
#   was worse still — it moved the stem off its own symmetry, 118 above and 76
#   below, which is a 42-unit imbalance around the most conspicuous element.
#
# Vertically the rule and the drawing already agreed, which is why nothing moved:
# the stem's caps are symmetric about the disc's centre line by construction. The
# group's mass sits 30 units high and that is correct — it is the bowl, and a P's
# bowl belongs high.

# What the two voids leave between them. The designer held voids to a 90-unit
# floor and flagged this as under it; rasterised at 16px both voids still
# measure ten pixels and stay separate, so it ships as drawn.
BRIDGE = (DOT_CX - DOT_R) - STEM_X1                # 66

DISC_D = DISC_R * 2                                # 680 — 66% of the canvas
VOID_BOX = (STEM_X0, STEM_CAP_TOP - STEM_R, DOT_CX + DOT_R, STEM_CAP_BOT + STEM_R)

# The production scale, about the canvas centre. A circular mark reads smaller
# inside a squircle than its measurements suggest, so the disc is pushed from
# 66% to 76% of the tile — short of the corners the iOS mask eats.
ICON_SCALE = 1.15

# macOS is the one platform that does NOT mask the icon — whatever is in the
# .icns is what appears in the Dock, corners and all. Apple's grid for a 1024
# canvas puts the rounded square at 824x824 centred, corner radius 185.4, and
# everything outside it transparent. iOS is the opposite: it masks, and forbids
# alpha, so its source must be full bleed. One source cannot serve both.
MAC_SQUARE = 824.0
MAC_RADIUS = 185.4


def mark_path():
    """The whole mark as one `evenodd` path: disc, stem void, bowl void.

    One path rather than three shapes, because the voids must be HOLES. Drawn as
    opaque paper-coloured shapes on top they would only work on paper; as holes
    they take whatever is behind them, which is what makes the mark reversible.
    """
    r, cx, cy = DISC_R, CX, CY
    disc = (f"M {cx + r:g},{cy:g} A {r:g},{r:g} 0 1 1 {cx - r:g},{cy:g} "
            f"A {r:g},{r:g} 0 1 1 {cx + r:g},{cy:g} Z")
    stem = (f"M {STEM_X0:g},{STEM_CAP_TOP:g} "
            f"A {STEM_R:g},{STEM_R:g} 0 0 1 {STEM_X1:g},{STEM_CAP_TOP:g} "
            f"L {STEM_X1:g},{STEM_CAP_BOT:g} "
            f"A {STEM_R:g},{STEM_R:g} 0 0 1 {STEM_X0:g},{STEM_CAP_BOT:g} Z")
    dot = (f"M {DOT_CX + DOT_R:g},{DOT_CY:g} "
           f"A {DOT_R:g},{DOT_R:g} 0 1 1 {DOT_CX - DOT_R:g},{DOT_CY:g} "
           f"A {DOT_R:g},{DOT_R:g} 0 1 1 {DOT_CX + DOT_R:g},{DOT_CY:g} Z")
    return f"{disc} {stem} {dot}"


def mark(colour, scale=1.0):
    """The mark's element, scaled about the disc's centre — which is the canvas
    centre, so the mark stays centred at any size."""
    el = f'<path fill="{colour}" fill-rule="evenodd" d="{mark_path()}"/>'
    if scale == 1.0:
        return el
    return (f'<g transform="translate({CX:g} {CY:g}) scale({scale:g}) '
            f'translate({-CX:g} {-CY:g})">{el}</g>')


def icon(ground, colour, scale=ICON_SCALE):
    """A full-bleed 1024 app icon — for iOS, which masks it, and for Windows."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        f'<rect width="1024" height="1024" fill="{ground}"/>'
        f'{mark(colour, scale)}</svg>\n'
    )


def icon_macos(ground, colour, scale=ICON_SCALE):
    """The macOS shape: Apple's rounded square, transparent beyond it."""
    inset = (1024 - MAC_SQUARE) / 2
    k = MAC_SQUARE / 1024
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        f'<g transform="translate({inset:g} {inset:g}) scale({k:g})">'
        f'<rect width="1024" height="1024" rx="{MAC_RADIUS / k:g}" fill="{ground}"/>'
        f'{mark(colour, scale)}</g></svg>\n'
    )


def standalone(colour):
    """The mark alone on a transparent ground, cropped to the disc."""
    x, y = CX - DISC_R, CY - DISC_R
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x:g} {y:g} {DISC_D:g} {DISC_D:g}">'
        f'{mark(colour)}</svg>\n'
    )


FILES = {
    # The mark by itself, transparent, for documents, the website and lockups.
    "mark-coral.svg": standalone(CORAL),
    "mark-ink.svg": standalone(INK),
    "mark-paper.svg": standalone(PAPER),
    # App icons, full bleed: iOS masks these to its squircle and forbids alpha,
    # and Windows takes them square.
    "icon-paper.svg": icon(PAPER, CORAL),
    "icon-ink.svg": icon(INK, PAPER),
    "icon-coral.svg": icon(CORAL, PAPER),
    # The same three carrying macOS's own shape, since macOS masks nothing.
    "icon-macos-paper.svg": icon_macos(PAPER, CORAL),
    "icon-macos-ink.svg": icon_macos(INK, PAPER),
    "icon-macos-coral.svg": icon_macos(CORAL, PAPER),
}

if __name__ == "__main__":
    for name, body in FILES.items():
        (OUT / name).write_text(body)
    print(f"wrote {len(FILES)} files to {OUT}")
    print(f"disc {DISC_D:g} across — {DISC_D / 1024:.0%} of the canvas, "
          f"{DISC_D * ICON_SCALE / 1024:.0%} at icon scale")
    print(f"stem void {STEM_X1 - STEM_X0:g} wide, bowl void {DOT_R * 2:g} across, "
          f"bridge between them {BRIDGE:g}")
    print(f"void group spans x[{VOID_BOX[0]:g},{VOID_BOX[2]:g}] y[{VOID_BOX[1]:g},{VOID_BOX[3]:g}] "
          f"— centred on ({(VOID_BOX[0] + VOID_BOX[2]) / 2:g},"
          f"{(VOID_BOX[1] + VOID_BOX[3]) / 2:g})")
