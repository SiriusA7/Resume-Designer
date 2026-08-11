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

## Closed: the chat button was another contaminated test

The native chat button appeared to open the OLD web drawer, reproducibly,
across several builds — with an `NSLog` in the button's action never firing.
Every hypothesis chased from that (`.chat-panel-toggle` still hit-testable, the
toolbar overlaying the webview) was measured and ruled out.

**The button works.** On a simulator with nothing else competing for the
foreground, tapping it opens the native sheet on the first try. The earlier
result was the same contamination as the "post-export touch" bug — see below,
because this time the culprit is named.

**The canvas running under the bottom toolbar is deliberate, not the bug.**
`window.innerHeight` really is ~49pt taller than the visible area, and an inset
"fix" was written and then reverted on request: the résumé showing behind the
glass is wanted.

### The contamination has a name

`com.oliakitchen.ios.uitests.xctrunner` — a leftover UI-test runner from another
project — was installed and running on the shared simulator, relaunching Olia
and taking the foreground every few seconds. Any tap injected during one of its
turns went to Olia.

Check for it before trusting a negative result:

```
xcrun simctl spawn booted launchctl list | grep UIKitApplication
```

Anything unexpected there means the device is not trustworthy. Terminating the
runner is not enough — it respawns. Boot a different simulator and target it by
UDID (`simctl install <udid>`, `simctl io <udid> screenshot`), because `booted`
is ambiguous with two devices up.

## Chat is native, and proposals can be applied

The chat sheet follows Olia's (`~/HyperBuild/Projects/HyperBite-iOS/Olia`),
reworked after device testing:

- **The reply has no bubble.** Only the user's turn is a shape. A box around the
  answer cost it the full width its lists and headings need.
- **Markdown renders** — headings, bullets, numbered lists, quotes, fenced code
  — through `MarkdownText`, ported from Olia. SwiftUI's `Text` handles the
  inline layer through `LocalizedStringKey`; the block layer is the port. Each
  block fades and rises in as it completes, the way the reasoning timeline does
  its rows.
- **Reasoning is a one-line summary that opens a sheet.** The chevron appears
  only once a summary line has arrived, and the row is inert until then, so it
  is never a button onto an empty sheet.
- **Thinking and answering never overlap.** The first content token settles the
  summary to "Thought process" and stops the shimmer, and the phone taps once
  (`.sensoryFeedback`) — models interleave, and showing both live read as two
  answers being written at once.
- **The reply is PACED, not dumped.** `ReplyStream` (ported from Olia's
  `StreamingAnimationController`) holds a target and walks toward it a couple of
  characters per tick, accelerating when behind, so a reply types itself in
  instead of landing a paragraph at a time — the network clumps tokens and the
  JS side coalesces them again, so rendering the snapshot directly is abrupt by
  construction. Its timer runs in `RunLoop.Mode.common`, or the reply freezes
  for exactly as long as the user is scrolling.
- **The composer carries the model and reasoning-effort chips**, ChatGPT/Claude
  style. The chips are 36pt capsules inside a 26pt card with 8pt of padding:
  26 − 8 = 18, and a 36pt capsule's radius is 18, so the curves are concentric.
  The capsule is part of the LABEL, not a button style's background — as a
  `.bordered` Menu the pill and the text were sized on different passes, so a
  label that changed ("Model" → "Claude Sonnet 4.6" when the catalogue lands)
  briefly overflowed its own pill. Send is drawn at the same 36pt rather than
  left to `.glassProminent`, which adds padding around whatever frame it is
  given: that made it the tallest thing in the row, and since the row centres
  its contents it lifted the chips off the card's bottom edge and broke the
  concentricity they were sized for.
- **The bar's left button is the chat list**, its centre is the current chat's
  title with rename and delete. Navigating between chats and acting on the one
  you are in are different jobs and were briefly merged into one menu.
- **The composer's field is keyed on a generation counter** bumped on send. A
  vertical-axis `TextField` is a `UITextView`, and clearing its binding does not
  invalidate the intrinsic height it grew to, so after a multi-line message the
  composer stayed tall until something unrelated forced a layout pass.
- **The transcript scrolls under the composer** (`safeAreaInset`), and follows
  new turns only — keying the auto-scroll on the streaming text took the scroll
  away from anyone reading back through the answer.

Rename is new engine surface (`renameThread` in `useChat.js`); everything else
routes to what desktop already uses.

The AI's proposed edits get a native review sheet. **Nothing applies without its
before/after on screen first** — that rule is why they were withheld
originally, and it is what the sheet exists to satisfy. Apply-all routes to
`applyAllInlineChanges`, NOT a loop over apply-one: leaf paths are indexed
against the proposed array, so insertions and removals must land before
modifications or a write hits the wrong element.

**How to see any of this without a key.** Everything past "No API key" needs a
real one, which no agent should enter. Publish a canned snapshot instead: a
temporary block in `setChatOpen` (src/iosShell.js) that calls `buildChatView`
with fixture messages and publishes it renders the whole transcript, including
streaming and reasoning states. That is how the rework above was checked —
transcript, markdown, both reasoning states, the title menu and the reasoning
sheet all confirmed on screen. Remove the block before committing.

Still unverified on real traffic: streaming cadence, the haptic, the model and
effort pickers writing through, and the review sheet end to end.

## Fastest way past onboarding on a fresh install

The wizard blocks the shell on every clean install, and the flag is
profile-scoped:

```
xcrun simctl terminate <udid> com.resumedesigner.app
printf 'true' > "<data-container>/Library/Application Support/com.resumedesigner.app/storage/resume-p--<profile-id>--resume-designer-onboarding-complete"
```

The container path comes from `simctl get_app_container <udid>
com.resumedesigner.app data`, and the profile id from the
`resume-designer-active-profile` file beside it. The unscoped key name does
nothing — see `BACKUP_FIXED_KEYS` in `src/profileKeys.js` for which keys are
shared and which are namespaced.

## Open: does the web Library dialog open by itself?

On a clean relaunch the web Library dialog was seen already on screen before any
deliberate tap on it. Nothing in the codebase dispatches `rd:open-library` at
boot — the only emitters are the Header's two menu entries, the empty-state
button, and the shell's own `openLibrary` command, which the Swift no longer
sends anywhere.

**Treat that observation as unconfirmed.** The attempt to A/B it with
`OP_NATIVE_SHELL=0` was contaminated by an unrelated app taking the simulator's
foreground mid-test, which has happened repeatedly and has already produced two
false bug reports in this work. Reproduce on a device before investigating.

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
