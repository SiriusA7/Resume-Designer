# On Paper — logo exploration brief

You are designing a symbol for **On Paper**, a private career workspace for
resumes, cover letters and job applications. The mark will be the iOS/iPadOS app
icon and the macOS/Windows app icon. Read this whole file before drawing.

## The product, in one line

One complete career profile, expressed as many tailored documents — with every
AI suggestion reviewed by the person before it lands.

Tagline: **Your career, clearly put.** Brand idea: **substance, clearly
expressed.** Personality: **calm, polished, human.** Stance: local-first,
transparent, user-controlled.

## The palette (already in production — do not invent new hues)

| name      | hex       | role |
|-----------|-----------|------|
| Paper     | `#F4EFE6` | warm background |
| Ink       | `#0C0A08` | primary text, high-contrast surfaces |
| Coral     | `#E8503A` | action, warmth, selective emphasis |
| Cobalt    | `#2B2BFF` | information, focus, rare |
| White     | `#FFFFFF` | clean working surfaces |
| Muted ink | `#62594E` | secondary text |

Coral is the closest thing the brand has to a signature colour and the
references lean the same way. Cobalt is a rarer, cooler alternative. A mark may
also be pure Ink or pure White.

## What the user pinned as inspiration

Eleven reference marks. What they have in common matters more than any one:

1. **A "P" split into a stem and a free-floating circle.** Heavy black, the bowl
   is a separate ring, not attached. Editorial, geometric, confident.
2. **An outlined coral "P" whose lower-left is a turned page corner.** Monoline,
   the counter and the fold share one continuous contour.
3. **A soft solid white "P" on black with a gentle curl at the bottom-left.**
   Rounded, friendly, almost a sticker.
4. **A white disc with a P/quaver cut out of it in negative space.** The
   counter and the stem are made of the ground, not the figure.
5. **A red isometric outline of a sheet lifting off a stack.** Dimensional,
   monoline, drawn in axonometric.
6. **A black outlined sheet caught mid-curl**, with a small solid shadow.
7. **A two-tone grey "P"** where one half is a lighter plane laid over another.
8. **A monoline knot**: two rings and a stem interlacing, one continuous ribbon.
9. **ORO** — a thin circle with a soft filled curve pooling at the bottom, like
   a horizon or a liquid level. Very quiet, tiny type inside.
10. **Ola** — a purple ring drawn as a soft organic blob, not a true circle. The
    imperfection is the whole idea: warm, hand-felt, contemporary.
11. The Ola palette grid — the same blob mark restated across six flat colours.

Read them as a mood, not a menu: **geometric minimalism, monoline or solid mass,
one confident colour, negative space doing the work, and a willingness to let a
circle be slightly imperfect.**

## The brand guide's own direction — and where it disagrees with the references

The guide (docs/brand/on-paper-brand-guide.md §11) suggests a mark may explore:

- a page and application field reduced to **one abstract form**;
- a **margin, caret, or insertion point** that suggests authorship and review;
- **two aligned planes** suggesting source and tailored version;
- an **"O" and "P" relationship** that is editorial without becoming a monogram
  cliché.

And it says to avoid: generic document-sheet icons; **folded page corners**;
profile silhouettes; checkmark-in-briefcase; pens, quills, typewriters; AI
sparkles, brains, robots, or gradients-as-intelligence.

**Three of the pinned references are folded/curled pages**, which the guide
rules out. That tension is deliberate and it is your problem to solve, not to
ignore. Take the *feeling* the user responded to in those marks — a plane that
moves, a surface with a second state, dimension implied by one gesture — and
find a form that does not read as "the little folded corner icon". If your mark
does contain a fold, it must be abstracted far enough that a stranger would not
describe it as a page corner. Say so honestly in your `risk` field either way.

## Hard constraints

1. **Square canvas, `viewBox="0 0 1024 1024"`.** No width/height attributes.
2. **The mark must survive 16px.** No hairlines, no detail that closes up, no
   more than two or three visual elements. Stroke weights at least 40 units on
   the 1024 grid unless the form is solid.
3. **iOS icon safety.** iOS renders the icon in a squircle and crops nothing,
   but a mark that runs to the edge looks wrong beside other icons. Keep the
   artwork inside a centred 720×720 optical area unless the concept is
   deliberately full-bleed.
4. **Monochrome first.** Every mark must still read in one flat colour on one
   flat ground. Deliver each mark as its own file; colour is a property of the
   file, not a variant explosion.
5. **No gradients, no shadows, no bevels, no 3D shading, no photographic
   texture.** Flat vector only. (An axonometric line drawing is fine; a drop
   shadow is not.)
6. **No text, no letterforms borrowed from a font.** If a letter appears it must
   be drawn as geometry.
7. **Valid, self-contained SVG.** Plain paths, circles, rects. No external
   references, no `<image>`, no scripts, no CSS classes — inline attributes
   only, because these get embedded in a page and rasterised.
8. Use `fill="currentColor"` nowhere; state explicit hex fills/strokes so the
   file renders standalone.

## What to deliver

Write each mark to its own file in
`docs/brand/logo-explorations/` using the exact filename you report.
Draw carefully: you are writing path data by hand, so prefer construction you
can reason about exactly — circles, arcs with explicit radii, straight segments,
symmetric coordinates. Check your own numbers. A mark whose geometry does not
close, whose counter is off-centre, or whose stroke weights disagree by accident
is a failed mark, and nobody downstream can fix it for you.
