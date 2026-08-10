# Native iOS shell — where staging step 2 got to

**Date:** 2026-08-10 · **Branch:** `feat/ios-phase-0` · Design of record:
[`2026-08-10-ios-swiftui-shell-design.md`](../superpowers/specs/2026-08-10-ios-swiftui-shell-design.md)

## Done and verified on an iOS 26.5 simulator

**Step 1 (deferred remainder).** `src-tauri/gen/apple` is committed source and
the shell Swift compiles straight from `src-tauri/ios/` — see
[`xcode-project-ownership.md`](xcode-project-ownership.md), which also records
what `tauri ios init` destroys and how the scene manifest was moved out of its
reach.

**Step 2.** The chrome is SwiftUI. The three things the device build was called
"absolutely horrible" for are gone: the web header stacked under the status
bar, the round chat/structure buttons on top of the résumé's name, and the zoom
pill wrapped into a column over the page.

Exercised by hand, each confirmed working:

| | |
|---|---|
| Title shows the loaded résumé | snapshot arrives |
| Résumé switcher menu, with a checkmark on the current one | |
| Actions menu — Rename / Duplicate / Delete / Undo / Redo / Import / Export / Profile / Jobs / History / Settings | |
| Rename opens the React dialog | native → JS → React event round trip |
| Zoom −/+ changes the canvas AND the native readout | native → JS → web control → `rd:zoom` → snapshot → native |
| Format menu resizes text | proves the webview keeps its editing state across a native toolbar tap |
| Structure panel opens from the toolbar | |
| PDF export produces a correct vector PDF and the preview renders it | |

## Outstanding — the one real bug

**After a PDF export, the web preview dialog stops responding to touches.**
Save, Cancel and its × all do nothing; a later `Rename` dialog on a fresh
launch responds normally, so it is specific to what the export leaves behind.

What has been ruled out, with evidence:

- **Not the modal handling.** Rename's Cancel works with `modalOpen` true.
- **Not `.disabled` propagation.** That was a real bug (it disabled the hosted
  webview, not just the toolbar) and is fixed; the symptom outlived the fix.
- **Not layout.** A DOM dump during the failure shows `elementFromPoint` at the
  Save button correctly returning the DialogContent, `innerHeight` matching the
  content area, and scroll at 0/0. Rendering and hit-testing agree; only touch
  delivery disagrees.
- **Not the share code.** `stage_pdf_for_share` runs and writes the named PDF
  (verified on disk), so JS gets that far. `OPShell`'s share handler never logs,
  and the dialog never enters its "Saving…" state — i.e. React's `confirm()`
  never fires, so the tap is lost before any of it.

Left as the next thing to chase. **Check it on a real device first**: every
observation above comes from `simctl`-injected taps, which behaved
inconsistently across runs (the document picker's remote service did launch
once, from the same coordinates that later did nothing). A real finger may not
reproduce this at all, and if it does not, the bug is in the harness rather
than the app.

The prime suspect not yet tested: WKWebView's internal scroll view keeping a
stale `contentSize` from `pdf-export-mode`, which makes the document as tall as
the whole résumé. That would shift where touches land while leaving layout
coordinates — and therefore `elementFromPoint` — correct.

## Also unverified

- **Keyboard avoidance.** Staging step 4 deletes `viewportHeight.js` and lets
  SwiftUI inset; neither has been exercised.
- **iPad**, including Stage Manager and split view. The shell is written not to
  foreclose a split view, but no iPad layout exists.
- **Device builds.** Everything here is the simulator. `DEVELOPMENT_TEAM` is
  back in `project.yml`, so signing should work, but that is untested.

## Still to build

Staging steps 3–5 of the design: Settings as a native sheet, the keyboard, and
the structure panel. Step 5 is the only one that needs the document, via
snapshot-in / path-writes-out over the existing `experience[3].bullets[1]`
grammar, with the focus rule that stops an inbound snapshot moving the cursor
mid-word.
