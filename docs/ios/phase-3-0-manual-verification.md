# Phase 3.0 — manual verification checklist

**Branch:** `feat/ios-phase-0` · **Commits:** `dc653f4..41dd67b` (9)
**Automated gates (verified):** 982 tests · lint 0 errors · `vite build` ·
`cargo check` · `cargo clippy -- -D warnings` · `cargo check --target aarch64-apple-ios`

Every code change in 3.0 passed automated verification. **None of it has been
seen running.** Subagents cannot drive a GUI, so all visual checks were
deliberately deferred to one pass. Run them in a single `npm run tauri:dev`
session.

```bash
cd resume-designer && npm run tauri:dev
```

---

## Results — run 2026-08-10 (Chromium, `npm run dev`)

Driven against the Vite dev server in the Chromium preview at 1240×800 unless
stated, with a seeded 8-role résumé paginating to **4 Letter sheets**. Every
figure below is a measurement, not an inference.

| # | Check | Result |
|---|---|---|
| 1 | Reachable left margin | **Partial** — the fix works (confirmed in WebKit); a *second, pre-existing* cause remains (below) |
| 2 | Fit no longer wobbles | **Pass** — no wobble (WebKit); zoom buttons still glide (confirmed by eye) |
| 3 | Structure panel 340 px at 1200 | **Pass** |
| 4 | Dialogs on a short window | **Pass** — all four, including Diff review, confirmed in WebKit |
| 5 | ⌘B via the blur flow | **Pass** on the stated case; two side-findings (below) |
| 6 | ⌘I on a bold tool chip | **Pass** |
| 7 | Resize with a 2+ page résumé | **X3 confirmed, quantified, and fixed** (below) |

No console errors throughout. No stored value was corrupted by any test.

Two fixes landed off the back of this run — the X3 guard and the restored
collapsed-caret branch. Gates after both: **992 tests** (was 982) · lint 0
errors · `vite build`.

**All seven checks and X3 are now closed**, across both engines: 3, 5, 6 and X3
in Chromium (engine-independent), and 1, 2 and 4 re-verified in WKWebView via
`npm run tauri:dev`. Nothing in Phase 3.0 remains unseen. Two out-of-scope
findings are recorded below for later — the above-100 %-zoom margin bug and the
floating-button overlap — neither of them a regression from this branch.

**Check 1.** The Task-1 fix is sound and the reviewer's specific worry is
cleared: while paginated (4 sheets) at 1240 px the container centres exactly —
`margin-inline-start` resolves to 180 px, left gap == right gap == 180. When
cropped at 100 % and 25 %, the page's left edge sits precisely on the
scroller's content-left, i.e. reachable. **But a second cause of an
unreachable left margin survives, independent of the flex fix:**
`.resume-container` carries `transform-origin: top center`, and a CSS
transform does not extend an ancestor's scrollable overflow. So above roughly
106 % zoom the page grows outside the scrollport on *both* sides with nothing
to scroll to. Measured at 140 % (reached with the app's own Zoom In button):
container's visual left edge at **x = −131**, scroller's content-left at
x = 0, `maxScrollLeft` = **20 px** — 131 px of the page is unreachable, and
the name renders as "ex Marchetti". This is **pre-existing**, not a
regression: `transform-origin: top center` was already on `next` at `293c5ac`;
this branch only added `margin-inline: auto`. Fixing it means changing
`transform-origin` to `top left` (and letting the auto margins do the
centring) — a separate change, out of 3.0's scope.

**Check 2.** Cannot be observed in this environment: the Browser pane keeps the
page at `document.visibilityState === "hidden"`, so `requestAnimationFrame`
never fires and the `is-zooming` class added by `withoutTransition` is never
removed. That is an artifact of the harness, not a defect — the class is
removed in a `finally`. What *is* verified, statically and conclusively: the
suppression has exactly **one** call site (`fitToView`,
`src/zoomControls.js:160`), `applyZoom` — the path every button and keyboard
shortcut takes — never touches the class, and the only rule is
`.resume-container.is-zooming { transition: none }`. The narrow scoping is what
shipped, and the native pass below confirms both halves in the running app.

**Check 4.** At 460 px tall the Settings dialog caps at 391 px, sits fully
inside the viewport, scrolls in an inner `overflow-y-auto` region, and has
**zero** buttons offscreen. The short Download PDF dialog measures 204 px
against a 414 px cap — **not stretched**. Diff review was not exercised: it
needs a live AI change session, so it needs an API key. Worth noting for 3.1:
`SettingsDialog` overrides the shared cap with `max-h-[85vh]` — **`vh`, not
`dvh`** — which is precisely the unit that misreports on iOS once browser
chrome or the keyboard is on screen.

**Check 5.** The stated case passes end-to-end through the real blur flow:
plain field → ⌘B → `**Alex Marchetti**` → click away (commits, renders
`<strong>`) → click back in (raw markdown shown, select-all includes the
markers) → ⌘B → **`Alex Marchetti`, zero asterisks**. `41dd67b` holds. Two
things found alongside it:

- **New in this branch — since fixed.** ⌘B with a *collapsed caret* had become
  a no-op: the old `toggleBoldMarkdown` inserted `****` and placed the caret
  between the pairs (turn bold on, then type), and the generalised
  `toggleMarkdownMarker` returned `{ value, start, end }` unchanged for
  `selectionStart === selectionEnd`. The branch now restores it for all three
  markers, including the toggle-off case when the caret already sits inside an
  empty pair, with an underflow guard at offset 0. Verified live end to end:
  caret at the end of a field → ⌘B → `Alex Marchetti****` with the caret at
  offset 16 → type `Hi` → blur → stored `Alex Marchetti**Hi**`, rendered
  `<strong>Hi</strong>`.
- **Pre-existing:** a *partially* bold field plus select-all plus ⌘B produces
  malformed nesting — `Product Designer — **systems**, typography, and craft`
  becomes `**Product Designer — **systems**, typography, and craft**`. The old
  code had the identical `**${selected}**` fallback, so this is not a
  regression. A correct fix strips interior markers before wrapping.

**Check 6.** The guard's `matches()` arm is exactly what saves this: the
editable **is** the chip (`<span class="highlight-bullet"
data-editable="tools">`), which `querySelector` alone can never see. ⌘I on it
is a clean no-op, `<strong>Figma</strong>` intact, and blur round-trips
`**Figma**` back to storage unchanged.

### X3 — confirmed, quantified, and decided-on-your-desk

A single `resize` event discards a manually chosen zoom, refits, **and
persists the result**: from a deliberate 100 % the canvas jumped to **25 %**
and `resume-zoom` was written as `0.25`. (Note the CDP viewport override does
not dispatch `resize`, so the earlier silent resizes were a harness artifact;
a real window drag does dispatch it.)

Fit zoom by document length, measured at a 1240×860 window:

| pages | fit | note |
|---|---|---|
| 1 | 64 % | fine |
| 2 | **31 %** | the doc's "~38 %" was optimistic |
| 3 | 25 % | clamped; true fit 21 % |
| 4 | 25 % | clamped; true fit 15 % |

One bound worth having: this does **not** fire on launch. A stored 100 %
reloads as 100 %, so the damage is confined to resize, orientation change, and
page-setup changes — not every app start.

**Recommendation: guard it.** Auto-refit only when the current zoom still
equals the last fitted value. That keeps the iOS rotation behaviour the plan
asked for and stops a Mac window drag from throwing away a chosen zoom.

**Decided and fixed (2026-08-10): guarded.** `zoomControls.js` now tracks
`lastFittedZoom` — the value `fitToView` last applied, read back *after*
`setZoom` because setZoom rounds to two decimals and the guard compares for
exact equality. The resize/orientation handler returns early unless
`currentZoom === lastFittedZoom`. It stays `null` until the user actually
fits, so a zoom that was never fitted — including one restored from storage —
is never touched. Verified live: a manual 100 % on the 4-page résumé now
survives a resize (`resume-zoom` stays `1`), while an explicitly fitted canvas
still tracks the window (25 % → 31 % when the scrollport doubles in height).
Five tests in `test/zoomRefitGuard.test.js`; the three protection tests fail
with the guard removed, which is how they were checked.

### Environment caveats on this run

Chromium, not WKWebView — per `CLAUDE.md`, WebKit-only scroll and layout bugs
will not reproduce here, and checks 1 and 4 are both layout-sensitive. The
`visibilityState: hidden` limitation above blocks check 2's visual half. A
`npm run tauri:dev` pass is still worth doing for checks 1, 2 and 4; checks 3,
5, 6 and X3 are engine-independent and settled.

---

## Native WKWebView pass — `npm run tauri:dev`, 2026-08-10

Run against the real desktop app on the author's own résumé data (read-only:
window resizes, zoom, and opening dialogs; no content edited, nothing applied
or restored, zoom returned to 100 % afterwards).

**Check 1 — pass.** Filled to the screen, the page centres exactly (376 px of
gap on the left, 375 px on the right). Dragged narrow until genuinely cropped —
the sidebar rendered as "IGHLIGHTS" / "KILLS" and a horizontal scrollbar
appeared — and scrolling left restored the full left margin, sidebar padding
included. The engine-specific half of the Task-1 fix holds in WebKit.

**Check 2 — pass, both halves.** Fit snapped straight to 46 % and two
consecutive frames were identical: no shrink-then-grow. The "buttons must still
animate" half cannot be captured with these tools — a screenshot round-trip is
roughly 1 s against a 200 ms transition, so no intermediate frame is
reachable — and was confirmed by eye instead: **the zoom buttons glide.** That
is the pair the narrow scoping was chosen for. Fit is instantaneous, ordinary
zoom keeps its 0.2 s ease, and the static argument (single call site;
`applyZoom` never adds the class) is borne out in the running app.

**Check 4 — pass, all four dialogs**, in a window ~530 px tall (≈667 CSS px).
Each sits fully inside the viewport with its actions reachable and its header
pinned while the body scrolls:

| dialog | height | notes |
|---|---|---|
| Settings | 450 px (85 %) | internal scroll, "Replay" reachable |
| Export PDF | 485 px | Cancel / Save PDF reachable; the close X stays visible, so **M-G does not bite here** |
| Version history | 450 px | internal scroll with a visible thumb |
| Review changes (diff) | 475 px | "Reject all" / "Apply all" pinned at the bottom |

The diff dialog was reached through **History → Compare**, which needs no AI
session — worth remembering, since that is the only way to exercise it without
an API key. It closes the Chromium gap where Diff review went untested.

**X3 fix confirmed in the real app.** Zoom held at 100 % across four genuine
macOS window resizes, including the height shrink that used to be the worst
case (a whole-document refit). An explicit Fit still worked (100 % → 46 %).

**New finding — floating buttons overlap the page when narrow.** The chat FAB
(top-left) and the structure-panel FAB (top-right) sit above the canvas, so as
the window narrows they cover résumé content: the chat button hides "As" of the
name, the structure button covers the contact block. Pre-existing and unrelated
to this branch, but it is a real collision and it will be worse on a phone,
where the page is never wider than the viewport. One for the Phase 3 responsive
work.

**Not testable here.** Escape-to-close could not be exercised in the native
app: synthetic key events do not reach the webview. Proven rather than assumed —
Settings ignored Escape too, while the same Escape closes it correctly in
Chromium. No conclusion either way about the app's Escape handling.

---

## The seven checks

1. **Reachable left margin** — narrow the window until the page is cropped.
   The résumé's left margin must be reachable by scrolling. Widen past 8.5in:
   the page re-centres. **Also check while paginated** — a reviewer flagged that
   `.resume-container.is-paginated` was never exercised against the new
   `margin-inline: auto`.

2. **Fit-to-view no longer wobbles** — click fit repeatedly; the page should
   snap with no shrink-then-grow. **But the zoom in/out buttons and ⌘+ / ⌘− must
   STILL animate** (0.2 s ease). If they snap too, the suppression is too wide.

3. **Structure panel width at 1200 px** — it must still be **340 px**, not 380.
   This is the regression Task 6 nearly shipped: the plan claimed the
   `--structure-panel-width` override was dead, and it is not. Also sweep
   1400 / 1200 / 1050 / 900 / 768 for any other visual change; there should be
   none.

4. **Dialogs on a short window** — resize to roughly 700 px tall, then open
   **Settings**, **PDF export** and **Diff review**. Each must scroll internally
   with its action buttons reachable. A short confirm dialog must NOT be
   stretched.

5. **⌘B / ⌘I / ⌘U — use the blur flow.** Bold a field, **click away, click back
   in**, then ⌘B. Expect `Title`, not `**Title**`. Pressing ⌘B twice in one
   session passes even when this is broken — that is exactly how the bug
   survived seven reviews.

6. **⌘I on a bold *tool chip*** (not a plain field). Chips take a different
   branch in `startEditing`, and the guard was silently destroying their `<strong>`.

7. **Resize with a 2+ page résumé loaded** — then look at the zoom. See the open
   question below; this is a decision, not a pass/fail.

## Two things that will look broken but are NOT from this branch

- **⌘⇧Z redo has never worked.** `main.js` tests `e.key === 'z' && e.shiftKey`,
  but Shift makes `e.key` `'Z'`. Caps Lock breaks plain undo the same way. Both
  lines are untouched context in this branch. Redo is still reachable via ⌘Y.
- **Fit produces a slightly smaller zoom than before.** `fitToView` now reads
  the real computed padding (32 + 100 = 132 px) instead of a hardcoded 96. The
  old value was simply wrong.

## Open design question — X3

Task 2 added a debounced refit on `resize` / `orientationchange`. It does what
the plan asked, but with a wider blast radius than the plan acknowledged:

`fitToView` → `setZoom` → **`saveZoom()`**. So resizing a Mac window discards a
manually chosen zoom **and persists the fitted one**. And `fitToView` fits the
*whole document* (`contentHeight: container.scrollHeight` = every sheet
stacked), so a 2-page résumé in an ~800 px-tall window lands near **38 %**, and
a 3-page one clamps to `MIN_ZOOM` **25 %**. Previously that only happened on an
explicit Fit click.

The final review called this the highest-probability visible regression on the
Mac. Two options:

- **Leave it.** Correct for iOS rotation, which is why the plan asked for it.
- **Guard it** — only auto-refit when the current zoom still equals the last
  fitted value, i.e. the user has not manually zoomed since.

## Deferred findings (follow-ups, not blockers)

| | |
|---|---|
| **M-A** | `serializeEmphasis` uses `String.replace(textContent, …)` — first occurrence only. `on the mat, <b>the</b> cat sat` marks the **wrong** "the". Pre-existing; proper fix is a node-walk rewrite. |
| **M-B** | `<strong><b>x</b></strong>` now yields `****x****`. Theoretical — `renderer.js` only emits `<strong>`. |
| **M-C** | `e.metaKey \|\| e.ctrlKey` means Ctrl+Z also undoes on macOS, Win+Z on Windows. Every modifier handler was checked; no collision. |
| **M-D** | ⌘⇧Z redo (above). |
| **M-G** | `PdfDialog` is the one dialog keeping the default close X, which will scroll away past `90dvh`. Esc and overlay-click still dismiss. |
| **Header CSS** | ~180 lines of legacy `.header-*` rules look orphaned since `Header.jsx` moved to shadcn inline `max-[…]` variants. Needs visual verification, and `print.html` also loads `main.css`, so a static grep of `src/` under-counts. |

## Release note

`eda1bee` is a `feat`, so merging to `next` cuts a **minor** version bump, not a
patch. `compute-version.mjs` derives this from conventional commits at merge
time.
