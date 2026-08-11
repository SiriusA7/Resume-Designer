# Native iOS shell — status

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

**Step 3 — Settings is a native sheet.** Theme, OpenRouter key, automatic
fallback, backup export/import, replay onboarding, version. Every control
renders from the snapshot, so a write that does not land springs the control
back. `hasApiKey` crosses the bridge, never the key. The native chrome also
follows the app's own theme now, not the system's.

**Step 4 — the keyboard.** Its planned deliverable was already done by the 3.1
revert; the real work was that WKWebView and SwiftUI were both avoiding the
keyboard, which collapsed the canvas to a ~90pt strip. The canvas now opts out
with `.ignoresSafeArea(.keyboard)` and leaves it to the webview.

**Step 5 — the structure panel is native.** `buildDocumentOutline()` flattens
the résumé into groups of `{path, label, value, multiline}`; Swift renders a
generic form and echoes back paths it was handed, so it never learns the
schema and cannot construct a path. Writes go through `setField` to
`store.update` — same `setByPath`, same undo history as the web editor. The
focus rule holds: 16 characters typed into the middle of a value kept the
caret in place. The outline only streams while the panel is open.

## Closed: the "post-export touch" bug was the test harness

Recorded here because it cost real time and the wrong conclusion was one step
away. On the simulator the PDF preview dialog appeared to stop accepting taps
after an export — Save, Cancel and its × all did nothing, reproducibly, across
several builds. Ruling out the modal handling, `.disabled` propagation and the
layout took a DOM dump and three rebuilds.

**On a real device both buttons work.** The taps were being lost by
`simctl`-injected input, not by the app.

The lesson for next time: `simctl` taps are good enough to prove a control
WORKS, and not good enough to prove one is broken. A negative result from them
is not evidence.

## Also unverified

- **iPad**, including Stage Manager and split view. The shell is written not to
  foreclose a split view, but no iPad layout exists.
- **Device builds.** Everything here is the simulator. `DEVELOPMENT_TEAM` is
  back in `project.yml`, so signing should work, but that is untested.

## Still to build

All five staging steps of the design are done. What is left is not new
structure but polish and coverage: the outstanding bug above, an iPad layout,
and reordering/adding/removing items in the structure panel (it edits values
today; `moveItem`/`addItem`/`removeItem` from the design are not built).
