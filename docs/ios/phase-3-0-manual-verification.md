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
