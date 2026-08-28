#!/usr/bin/env python3
"""Compose the On Paper lockups: the mark set with the wordmark.

The wordmark is Geist Semibold — the product's own interface face — converted to
OUTLINES here rather than left as live text, so the files render identically
anywhere without the font being installed. Run after build_identity.py:

    python3 docs/brand/logo/build_lockup.py

The mark's geometry is imported from build_identity rather than copied, so the
two cannot drift apart. The type is set by the font's real metrics and kerned
with its own pairs; nothing is eyeballed.
"""
import pathlib
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import build_identity as identity  # noqa: E402

OUT = pathlib.Path(__file__).parent
ROOT = OUT.parents[2]

WORD = "On Paper"
FONT = sorted((ROOT / "resume-designer/dist/assets").glob("geist-sans-latin-600-normal-*.woff2"))[0]

CX, CY, R = identity.CX, identity.CY, identity.DISC_R
DISC_L, DISC_R_EDGE = CX - R, CX + R
DISC_T, DISC_B = CY - R, CY + R
DISC_D = identity.DISC_D

# A disc has no baseline, so the wordmark is centred on the disc's centre rather
# than sitting on anything. Centred on the CAP BOX (baseline to cap height),
# which is what the eye reads as the line's body — centring on the full ascender
# -to-descender extent drops the word visibly low.
CAP_RATIO = 0.40      # cap height as a fraction of the disc's diameter
GAP_RATIO = 0.26      # space between mark and word, as a fraction of the diameter
STACK_CAP_RATIO = 0.26
STACK_LEAD_RATIO = 0.22


def word_paths(text, font_path):
    """Outline `text`, returning (svg path data, advance width, upem, cap height)."""
    font = TTFont(font_path)
    cmap = font.getBestCmap()
    glyphset = font.getGlyphSet()
    hmtx = font["hmtx"]
    kern = {}
    if "kern" in font:
        for sub in font["kern"].kernTables:
            kern.update(sub.kernTable)

    names = [cmap[ord(c)] for c in text]
    parts, x = [], 0.0
    for i, name in enumerate(names):
        if i:
            x += kern.get((names[i - 1], name), 0)
        pen = SVGPathPen(glyphset)
        glyphset[name].draw(pen)
        d = pen.getCommands()
        if d:
            parts.append(f'<path transform="translate({x:g} 0)" d="{d}"/>')
        x += hmtx[name][0]
    return "".join(parts), x, font["head"].unitsPerEm, font["OS/2"].sCapHeight


D, ADV, UPEM, CAP = word_paths(WORD, FONT)


def word(colour, cap_h, x, baseline):
    """Place the outlined wordmark. Glyph outlines grow upward in font space, so
    the y axis is flipped about the baseline."""
    k = cap_h / CAP
    return (
        f'<g transform="translate({x:g} {baseline:g}) scale({k:g} {-k:g})" '
        f'fill="{colour}">{D}</g>'
    ), ADV * k


def horizontal(mark_colour, word_colour):
    """Mark left, wordmark right, the word's cap box centred on the disc."""
    cap_h = DISC_D * CAP_RATIO
    gap = DISC_D * GAP_RATIO
    tx = DISC_R_EDGE + gap
    baseline = CY + cap_h / 2
    w_el, w_w = word(word_colour, cap_h, tx, baseline)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{DISC_L:g} {DISC_T:g} {(tx + w_w) - DISC_L:g} {DISC_D:g}">'
        f'{identity.mark(mark_colour)}{w_el}</svg>\n'
    )


def stacked(mark_colour, word_colour):
    """Mark above, wordmark centred beneath it."""
    cap_h = DISC_D * STACK_CAP_RATIO
    lead = DISC_D * STACK_LEAD_RATIO
    baseline = DISC_B + lead + cap_h
    w_el, w_w = word(word_colour, cap_h, 0, baseline)
    tx = CX - w_w / 2
    w_el, w_w = word(word_colour, cap_h, tx, baseline)
    x0 = min(DISC_L, tx)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{x0:g} {DISC_T:g} {max(DISC_R_EDGE, tx + w_w) - x0:g} {baseline - DISC_T:g}">'
        f'{identity.mark(mark_colour)}{w_el}</svg>\n'
    )


FILES = {
    "lockup-horizontal.svg": horizontal(identity.CORAL, identity.INK),
    "lockup-horizontal-mono-ink.svg": horizontal(identity.INK, identity.INK),
    "lockup-horizontal-reversed.svg": horizontal(identity.CORAL, identity.PAPER),
    "lockup-stacked.svg": stacked(identity.CORAL, identity.INK),
    "lockup-stacked-reversed.svg": stacked(identity.CORAL, identity.PAPER),
}

if __name__ == "__main__":
    for name, body in FILES.items():
        (OUT / name).write_text(body)
    print(f"wrote {len(FILES)} lockups from {FONT.name}")
    print(f"  wordmark: Geist Semibold, outlined; cap height {CAP}/{UPEM} upem")
    print(f"  horizontal: cap {DISC_D * CAP_RATIO:g} grid units "
          f"({CAP_RATIO:.0%} of the disc), gap {DISC_D * GAP_RATIO:g}, "
          f"cap box centred on the disc's centre line")
