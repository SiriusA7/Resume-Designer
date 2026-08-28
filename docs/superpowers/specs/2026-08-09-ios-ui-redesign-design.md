# A native iOS / iPadOS UI for On Paper (Phase 3)

**Date:** 2026-08-09
**Status:** Approved design, pending implementation plan
**Depends on:** [`2026-08-09-ios-ipados-port-design.md`](2026-08-09-ios-ipados-port-design.md) (the port; D7 revised)
**Evidence:** [`docs/ios/phase-0-findings.md`](../../ios/phase-0-findings.md) — empirical, from a real iPhone 16 Pro and iOS 27 simulators. Supersedes the port spec and audit wherever they conflict.

## Problem

Phase 0 got On Paper running on iPhone and iPad. The developer's verdict after
using it on real hardware:

> "The current UI/UX just doesn't work for a mobile device. Everything was too
> cramped, spacing was off, content was too zoomed in or too zoomed out. This is
> currently a desktop app we've shoved onto a small screen. It might work and
> look fine on an iPad, but definitely not an iPhone. And given that app windows
> are resizable on iPads, and that there's going to be foldable iPhones coming
> soon… we need to make sure we properly design the new UI/UX to be dynamic and
> responsive and adaptive to different sizes and still work."

So this is not a responsive retrofit. It is a UI that is native to the platform
and **adaptive across a continuous width range** — phone, foldable, Split View,
Stage Manager, full iPad — with no device classes.

## The arithmetic that decides everything

`.resume` body text is `calc(9pt * var(--font-scale, 1))` = **12 CSS px**
(`styles/resume.css:34`), inside a hard 816 px page (`resume.css:41` `width:
8.5in`, restated `main.css:881-882` and pinned inline by `pagination.js:335`).
On a 402 pt iPhone:

| Fit | Resulting body text |
|---|---|
| Whole sheet (today's behaviour) | **4.9 pt** |
| Two sheets | 3.5 pt |
| Sheet width exactly | 5.8 pt |
| **The text column** (`.resume-main`, 489.6 px) | **9.7 pt** |
| *Apple's readability floor* | *~11 pt* |

**This is arithmetic, not a bug.** No layout work makes a whole 8.5 in sheet
readable at 402 pt. The phone product therefore cannot be "the résumé, smaller":
the sheet is a *navigational overview*, and reading and editing happen at a zoom
that fits **a column**, not a page. 394 / 489.6 = **0.80**, which the existing
`transform: scale()` machinery already delivers.

## Decisions made during brainstorm

| Decision | Choice |
|---|---|
| Document model | **Two-zoom canvas** — overview ⟷ column zoom. Not a reflow, not a pinch-only page |
| Second surface | **Outline mode**, and it is **`StructurePanel` promoted**, not a new UI. Mirrors desktop, where the sidebar and the page are both editors |
| Navigation | **Segmented `Page ⟷ Outline`** in the nav bar; Design and Chat are tools in a toolbar, opening as sheets |
| Adaptivity | **Container queries on `.app`**, not device breakpoints. The wide state *is* today's desktop shell |
| Zoom binding | **Bound to the editing session** — enter on tap-to-edit, follow the caret, return to overview on Done |
| Sticky reading zoom | **Parked.** Revisit if panning at 0.80 proves to be the wrong reading gesture |
| On-page editing | **Kept.** Phase 0 proved caret and selection work on device; the port spec's sheet-rehost (D7) is withdrawn |

## Design

### D1 — The adaptive shell

Two states, driven purely by available inline width via **container queries** on
`.app` / `.app-content`. `styles/main.css:737` already uses
`container-type: inline-size`, so the technique is established here.

**Compact.** Segmented `Page ⟷ Outline` control in the nav bar; one surface
visible at a time. Design and Chat open as sheets over the current surface.

**Regular.** The segment dissolves; both surfaces render side by side and the
tools become docked panels — **this is the existing desktop shell, unchanged**.

There is no third layout and no phone-specific shell to maintain. A foldable
unfolding, an iPad window dragged narrower, or Split View at ~507 pt are
continuous transitions through one set of rules.

**On the threshold.** "No device breakpoints" does not mean "no thresholds" —
container queries need a value. The rule is that the value is **derived from
content, not from hardware**: regular begins at the width where the outline
surface and a readable page column can coexist without either being crushed.
Given `--structure-panel-width: 380px` and a 489.6 px text column, that lands
near 900 px of container inline-size, but the number must be measured against
real content during 3.2 and written down with its derivation — never picked to
match an iPad.

**Delete on the way:** `main.css:1466-1671` is a dead media-query ladder (~200
lines) that misrepresents what the shell does, plus the dead
`.header-actions > *` rule at `:1674`.

### D2 — Two editing surfaces as peers

- **Page** — the canvas, with on-page `contentEditable` retained.
- **Outline** — `StructurePanel`, promoted from sidebar to a first-class surface.

Both edit the same model through the same store. This is not a second UI; it is
the desktop's existing two-surface model given a native presentation. The
consequence for scope is large: the "phone as a distinct surface" direction was
rejected precisely because its honest version is *promote what already exists*.

### D3 — The canvas zoom model

Two states:

- **Overview** — fit-to-width, the sheet as a navigable thumbnail.
- **Column zoom** — tap a block, animate to the scale that fits **its column**.
  `.resume-main` → 0.80 → 9.7 pt. `.resume-sidebar` is only 163.2 px
  (`resume.css:292`), so it clamps at `MAX_ZOOM` → ~24 pt. That asymmetry is
  deliberate and should be designed for, not smoothed away.

**Zoom is bound to the editing session, not the tap.** Entering edit zooms in;
moving to the next block (tap, or Tab on a hardware keyboard) pans at the same
scale; **Done** returns to overview. Re-zooming per field would put an animation
between every bullet, and bullets are most of what editing a résumé is.

**Prerequisites, all of which are existing bugs:**

| | |
|---|---|
| `transform-origin: 0 0` | Currently `top center` (`main.css:890`); zoom must anchor on the tap point, which needs scroll compensation |
| `.is-zooming` transition suppression | `fitToView` resets to `scale(1)` at `zoomControls.js:106` *through* a 200 ms transition — the visible wobble on desktop today |
| `pagination.js` divisor | Already latently wrong: a repaginate landing mid-transition produces wrong page breaks on desktop **now** |
| `MIN_ZOOM` | `0.25` (`zoomControls.js:9`) but a 3-sheet résumé needs 0.29 and a 4-sheet ~0.22 — "fit" silently stops fitting on longer résumés |
| `fitToView` padding | Reads hardcoded 32/100 px (`zoomControls.js:112-113`); must read computed padding |

`fitToView` must also be exported and called on launch, `resize` and
`orientationchange` — none of which happens today.

### D4 — The AI review touch surface

`inlineEditor.js:58` registers `mouseover` as the only route to
`showAIButton()`, and `startEditing()` calls `hideAIButton()` at `:785`. The tap
that reveals the button destroys it, so **Apply / Reject is unreachable by touch**.
The apparent fallback is dead code: `inlineChanges.js:188-224` handles
`#inline-open-review`, `#inline-apply-all`, `.inline-change-apply`,
`.inline-change-reject` — none of which is rendered anywhere in `src/`.

**Replace the hover trigger with a tap-driven anchored popover, copying a pattern
this repo already has.** `ExperienceDateEditorHost.jsx:104-116` has vanilla
`inlineEditor` dispatching a `CustomEvent` carrying a captured rect, with a React
host rendering a Radix `Popover` anchored to it; the header comment at `:15-20`
already explains why portalling to `body` survives `pagination`'s
`replaceChildren` and stays out of PDF capture. Résumé nodes already carry
`data-change-status="pending"` (`changePreview.js:163`), so a tap can detect a
pending change with no hover involved.

**This is independent of the shell and the zoom model and can land at any time.**

### D5 — Sheets, and what hosts the tools

`components/ui/sheet.jsx` is vendored with **zero consumers** (`grep SheetContent`
matches only the file itself). It becomes the compact host for Design and Chat.
It needs `max-h`, safe-area padding and a grabber before use.

Adopting it also fixes desktop: the two hand-rolled drawers (`chat.css:315-330`
and the structure panel) have **no scrim, no focus trap and no Esc** on any
platform today.

### D6 — Touch, pointer and safe area

- **Coarse-pointer target floor of 44 pt** via mobile variants, not global bumps —
  `segmented.jsx:12` states its heights are "the spec, not magic numbers to be
  rounded", so the compact sizes are additive.
- **Native `title=""` tooltips never fire on touch.** Disabled-state explanations
  must move out of `title=` (`ProfileTabs.jsx:385`/`:445`,
  `StructurePanel.jsx:446`), which is also unreachable in some desktop browsers.
- **`opacity-0 group-hover:opacity-100`** controls are worse than hidden — they
  hold layout and swallow taps at zero opacity.
- **Safe area:** `viewport-fit=cover` plus `env(safe-area-inset-*)`. Measured
  once the viewport is real: iPhone 62 px top / 34 px bottom, iPad 32 / 20.
- **Pinch:** `index.html` has no `maximum-scale`, so WKWebView page zoom fights
  `zoomControls.js`'s `transform: scale()` indistinguishably. Scope the canvas
  with `touch-action` rather than disabling system zoom app-wide — see Open
  questions.

### D7 — Pane navigation

The two 52 px FABs at `chat.css:42-46` and `editor.css:739-743` sit at
`top: calc(var(--header-height) + var(--space-md))` = 72 px in the top corners —
on the résumé's first inch and ~700 pt from the thumb. They are replaced by the
segmented control and the tool toolbar.

`--chat-panel-width` is currently pinned by an **inline `:root` style**
(`ChatPanel.jsx:44-48`, clamped 240–500 at `:16-17`), which outranks every media
query — so `main.css:1491` and `:1525` are dead, and a width synced from the Mac
can exceed the phone's screen. Clamp at point of use against the container.

## Foundation — the seven blockers

Not part of any direction; the app is not operable without them.

| | Defect | Evidence |
|---|---|---|
| **B1** | **The résumé's left half is unreachable at any width.** A centred flex item wider than its scrollport overflows both sides, and start-side overflow is not scrollable in any engine | `main.css:869-878` + `:880-888`; measured `resumeRect x=-207` = `(402−816)/2`. Fix: `justify-content: flex-start` + `margin-inline: auto`. **Two lines, and broken on macOS too** |
| **B2** | `.structure-panel` has no responsive rule at any width; `.preview-area` collapses to 62 px | `editor.css:666-691`; the file's only `@media` is `@media print` at `:848`, while `chat.css:315-330` does have the ≤768 px rule |
| **B3** | Opens at 100 % zoom and never auto-fits | `zoomControls.js:8`, `:22-27`, `:40`; no `resize`/`orientationchange` listener exists |
| **B4** | AI Apply / Reject unreachable by touch; fallback is dead code | `inlineEditor.js:58`, `:785`, `:787`; `inlineChanges.js:188-224` |
| **B5** | **Autocorrect silently corrupts and persists résumé text** | Zero `autocorrect`/`autocapitalize` anywhere; `:857` sets only `spellcheck`, which does not govern autocorrect in WebKit; `:975` writes `textContent` to the store. Worse, `:840` puts raw markdown markers into live text, so smart punctuation acts on them too |
| **B6** | Onboarding hard-gates on an API key, no skip, no close | `OnboardingSteps.jsx:72-77`; `OnboardingWizard.jsx:474` + `:100`. App Store 2.1 risk, confirmed visually in Phase 0 |
| **B7** | Keyboard avoidance is structurally impossible | `main.css:190-194`, `:213`, `:220` — `100vh` + `overflow: hidden` at three levels; nothing reads `visualViewport` |

## What this shares with a desktop improvement

Roughly a third of the work is a Mac bug fix that happens to unblock iOS. This
changes the cost calculus and should inform sequencing.

| Fix | Desktop benefit |
|---|---|
| **B1** centred-flex overflow | Any narrow Mac window has the same unreachable left margin today |
| `fitToView` computed padding | Correct at every breakpoint instead of assuming 32/100 px |
| `.is-zooming` suppression | Removes the visible out-and-back wobble on every fit-to-view click |
| `pagination.js` divisor | Already produces wrong page breaks when a repaginate lands mid-transition |
| `serializeEmphasis` widened to `strong, b` / `em, i` | Emphasis inserted by WebKit's own `execCommand` is silently dropped on macOS (`inlineEditor.js:933-939`) |
| Cmd+I / Cmd+U | Two missing shortcuts on every platform; `applyTextCommand` already has the wrappers |
| `main.js:1052` → `e.metaKey \|\| e.ctrlKey` | Removes a deprecated `navigator.platform` read |
| Dialog `max-h` + overflow (`dialog.jsx:32`, `alert-dialog.jsx:30`) | `PdfDialog`/`DiffDialog` clip on a short laptop screen with no scroller |
| `grid-cols-1 sm:grid-cols-2` (6 sites) | `DiffDialog.jsx:170` already does it right; the rest break in a narrow Mac window |
| `sheet.jsx` adoption | Scrim, focus trap and Esc for two drawers that have none on the Mac |
| Deleting the dead ladder | ~200 lines that misrepresent the shell |

**iOS-only spend, for contrast:** safe-area plumbing, the `visualViewport`
keyboard inset, the pinch/`touch-action` layer, the coarse-pointer target floor,
the AI menu's touch entry, autocorrect attributes, and the segmented switcher.

## Staging

Six increments, each independently landable.

| | Content | Ships value to |
|---|---|---|
| **3.0** | Shared fixes: B1, `fitToView` padding, `.is-zooming`, pagination divisor, dialog `max-h`, dead ladder, `serializeEmphasis`, Cmd+I/U | **macOS immediately** |
| **3.1** | iOS survival: safe area, `visualViewport` (B7), autocorrect (B5), touch-target floor, onboarding skip (B6), chat-width clamp | iOS usable |
| **3.2** | Adaptive shell: container queries, `sheet.jsx`, segmented switcher, structure-panel drawer (B2), scrim + dismiss | Both |
| **3.3** | Zoom model: overview ⟷ column zoom, `transform-origin`, follow-the-caret, `MIN_ZOOM`, auto-fit (B3) | Both |
| **3.4** | Outline promoted to a peer surface | Both |
| **3.5** | AI Apply / Reject touch surface (B4) — independent, any time after 3.0 | Both |

**3.0 before 3.1** is deliberate: it lands on `next` and improves the shipping
Mac app before any iOS-specific work, so a regression there is caught by desktop
use rather than by an iOS build.

### This spec is an umbrella; each increment gets its own plan

No single implementation plan should cover 3.0 through 3.5. This document is the
design of record; plans are written **one increment at a time**, because the later
ones are informed by what the earlier ones measure:

- 3.3's column-zoom feel — including whether the sidebar's ~24 pt clamp is right —
  can only be judged once 3.2's shell exists to host it.
- 3.2's regular-state threshold must be measured against real content (see D1),
  not chosen in advance.
- The pinch-vs-app-zoom decision (Open question 1) changes how much of 3.3 is
  gesture work versus configuration.

Planning 3.3 today would be planning against three unmeasured values.

## Testing

- The 964 existing tests stay green throughout.
- **Unit-testable and must be tested:** the zoom maths (`fitToView`, column-fit,
  `MIN_ZOOM` bounds against 1–4 sheet documents) and the container-query state
  machine. Both are pure functions.
- **Device-verified, never ClaudePreview:** all layout, gesture, safe-area and
  keyboard work. Chromium does not reproduce WebKit scroll/layout behaviour and
  this design lives entirely in that gap. Route:
  `tauri ios build --debug --target aarch64-sim` + `xcrun simctl install/launch`.
- **Verify at a continuous range of widths**, not at device sizes: 320, 402, 507,
  700, 1032 pt. The point of container queries is that no width is special.

## Error handling

- **Zoom fails safe.** If a column cannot be measured, stay at overview rather
  than animating to a wrong scale.
- **Sheets need dismissal.** Scrim, Esc, and a back gesture — the current
  hand-rolled drawers have none.
- **Autocorrect is a data-integrity issue, not a polish item.** Until B5 lands,
  every edit on iOS risks a persisted rewrite.

## Out of scope

Sticky reading zoom (parked; revisit if panning at 0.80 is the wrong reading
gesture); Apple Pencil / PencilKit; a phone-specific outline UI distinct from
`StructurePanel`; any change to the PDF export pipeline; sync.

## Open questions

1. **Pinch-zoom vs the app's own zoom.** Keep system pinch on the chrome and
   scope the canvas with `touch-action`, or set `maximum-scale=1` given
   `zoomControls.js` already offers 25–200 %? A values call about accessibility,
   and it decides how much fixed-position drift work is required. Note the app is
   already carrying one accessibility-adjacent App Review risk (B6).
2. **`contentEditable = 'plaintext-only'` on coarse pointers?** It removes the
   iPad shortcut-bar B/I/U divergence and stops pasted rich text entering
   `textContent` — but WebKit and Chromium differ on caret behaviour, so it must
   be verified with a real iOS build, and it changes desktop paste if applied
   unconditionally.
3. **Is `--chat-panel-width` per-device or synced?** Decides whether M1's fix is a
   point-of-use clamp or a device-scoped setting.
4. **Does the sidebar's ~24 pt column zoom feel right**, or should narrow columns
   clamp lower than `MAX_ZOOM`? Device question, cheap to answer in 3.3.
