# A native SwiftUI shell for On Paper on iOS/iPadOS

**Status:** design of record. Supersedes Phase 3.2 entirely and reopens 3.3.
Working notes that led here: [`docs/ios/swiftui-hybrid-brainstorm-notes.md`](../../ios/swiftui-hybrid-brainstorm-notes.md).

## Why

Phase 3.1 shipped to a real iPhone and the verdict was that the app still looks
"absolutely horrible" there. That is a fair reading of what was built: 3.1 was
survival plumbing — data loss, keyboard, safe area, autocorrect, onboarding
gate, updater — not visual design. The adaptive UI was Phases 3.2–3.5 and none
of it existed.

Two 3.1 changes made it visibly worse and are pending revert:

- the 44 px touch floor plus `flex-wrap` turned the zoom toolbar into a floating
  column over the résumé
- the `visualViewport` `--app-height` work distorts the layout when the keyboard
  opens

Settings on a 390 pt screen wraps one word per line, clips the Dark toggle and
overlaps its own Replay button. It is a two-column desktop dialog on a phone.
The conclusion is that a web shell is the wrong instrument, not that it was
badly tuned.

## The constraint that frames everything

**The résumé canvas stays HTML.** Vector PDF export hands WKWebView's
`createPDF` the *live app DOM* — the "HTML renders both screen and PDF"
architecture. A SwiftUI résumé means a second rendering engine for PDF, and the
two drift on every layout change. This is not negotiable and it is what makes
the design a hybrid rather than a rewrite.

## Decisions

1. **SwiftUI owns the full native shell** — navigation bar, toolbar, sheets —
   and hosts the webview as a child view showing only the résumé page.
2. **The web keeps editing.** Tap-to-edit `contentEditable` in the canvas is
   unchanged; it is already verified working on real hardware, caret and
   selection included. One editing implementation, not two.
3. **The JS store stays source of truth.** `appStorage` and the Rust disk store
   stay authoritative. SwiftUI holds no durable state. One data layer, one
   backup format, the frozen `resume-designer-*` keys untouched, and iOS
   identical to desktop below the UI.
4. **`src-tauri/gen/apple` becomes committed source.** The generated SwiftUI
   entry point is replaced by ours. `resume-designer/.gitignore:10` currently
   ignores all of `src-tauri/gen/`; it must ignore only the non-Apple targets.
5. **The structure panel is native SwiftUI**, not the web editor in a native
   sheet. This knowingly kills the "the document never crosses the bridge" rule
   and is what makes this a project rather than a refactor.
6. **Desktop keeps the React chrome permanently.** The bridge is an iOS special
   case, not a general seam. Consequence: **nothing is deleted from the web
   chrome, only bypassed on iOS.**

## CloudKit — settled, and not a reason to move data into Swift

"Source of truth for the running app" and "who owns the sync engine" are
separate questions. Storage is already one file per key written by Rust with
atomic tmp+rename, and the same Rust store runs on iOS — so a native Swift
CloudKit layer can replicate those files and signal the app to reload while the
JS store stays authoritative.

The real tension is unrelated to this design. The decision on record is
documents-only sync with **per-variant** CloudKit records, but
`resume-designer-data` is a single key holding **every** variant. At file
granularity the whole library is one record: edit résumé A on the Mac and
résumé B on the phone and they collide with no merge path. Either sync the blob
(last-writer-wins across the library) or split storage so each variant is its
own key — which touches `BACKUP_FIXED_KEYS`, the backup format and profile
namespacing. That split is needed whichever UI ships.

## The bridge

Transport is Tauri's existing `invoke` (Swift → JS) and event system (JS →
Swift). Four kinds of traffic:

**Swift → JS commands.** `switchVariant(id)`, `setZoom(z)`, `fitToView()`,
`exportPdf()`, `openChatWithContext(path)`, `applyChange(path)`. These are
existing JS functions; the bridge is a dispatcher, not new logic.

**JS → Swift snapshots.** A coarse view-model the chrome renders from: current
variant id and name, the variant list, zoom, page count, dirty/saving state,
whether a change session is open. Pushed on change, never polled.

**JS → Swift events.** Onboarding finished; import completed and needs a
reload; unrecoverable storage error.

**Swift → JS lifecycle.** Backgrounding, memory warnings, and the keyboard —
SwiftUI knows the keyboard frame natively and insets the webview itself, which
is what lets `viewportHeight.js` and `--app-height` be deleted rather than
debugged.

### The structure panel's document access

The structure panel needs the document, so it reuses the path grammar that
already exists — `experience[3].bullets[1]`, `sections[2].title` — exercised by
`changeApply.js`, the diff engine and every applied AI edit.

- **Read:** structured JSON snapshot, pushed on change.
- **Write:** `setField(path, value)`, `moveItem`, `addItem`, `removeItem`.

Swift never owns a document *type*; it renders a snapshot and writes paths. The
JS store remains the single writer, so canvas and panel cannot diverge.

**Three risks, in order of how much they will hurt:**

1. **Echo while typing.** Swift sets a field → store updates → snapshot returns
   → SwiftUI re-renders the field mid-word and the cursor jumps. **Rule:** a
   focused native field ignores inbound snapshots for its own path until blur.
2. **Snapshot granularity.** Whole-document JSON per keystroke is wasteful — a
   real résumé is roughly 8 roles × 5 bullets. Start debounced; measure before
   optimising to path-scoped deltas.
3. **Path grammar drift.** If SwiftUI builds paths itself it becomes a second
   implementation of a grammar whose drift has already caused data corruption.
   Swift echoes back paths it *received*; it never constructs them.

## The shell

A `NavigationStack` root: native navigation bar (title is the current variant,
switcher as a menu), native bottom toolbar replacing the floating zoom pill, and
the webview as content in a `UIViewRepresentable` showing only
`#resume-scroller`. Settings, structure panel, chat, onboarding and PDF export
all become real sheets with detents.

Won for free: keyboard avoidance, sheet dismissal and scroll physics, Dynamic
Type in the chrome.

## Staging

Each step ships something usable; there is no interval where the app is broken.

1. **Commit `gen/apple`, own the entry point, host the existing webview
   full-screen.** Zero visible change. Proves the project survives regeneration
   and that the build still works — the riskiest unknown, bought cheaply.
2. **Native chrome around the unchanged canvas** — nav bar, bottom toolbar, safe
   area. Alone this removes the overlapping header, the floating buttons over the
   name, and the wrapped toolbar column.
3. **Settings as a native sheet.** A pure form with no document access: the
   cheapest real proof of the bridge.
4. **The keyboard.** Delete `viewportHeight.js`; SwiftUI insets. 3.1's worst
   regression goes away.
5. **Structure panel native.** Last, because it is the only piece needing the
   document, and by then the bridge and the focus rule are proven.

Steps 1–4 need only the small bridge. Only step 5 needs the document.

## Testing

The vitest suite covers service modules and does not reach `src/components/**`,
so it is unaffected by this work and must stay green throughout. What it cannot
cover, and what therefore needs its own answer per step:

- **The bridge contract** is testable on the JS side: the command dispatcher and
  the snapshot projection are pure functions over the store and should be unit
  tested there, without Swift.
- **SwiftUI views** need XCTest/XCUITest in the committed Xcode project. Step 1
  should establish whether that runs in CI at all before later steps depend on it.
- **Everything visual remains device-verified by a human.** Phase 3.1's lesson
  is that a green suite and a clean review said nothing about whether the app
  looked right, and three of nine tasks had defects traceable to the plan.

## What this kills

- **Phase 3.2 (adaptive shell) is superseded entirely** — container queries, the
  segmented switcher and the web structure-panel drawer are all replaced.
- **Phase 3.3 (zoom model) reopens.** It was designed against a web toolbar and
  an unresolved pinch-versus-app-zoom question; a native toolbar changes both.
- **Phases 3.4 and 3.5** need re-reading against a sheet-based shell before
  their plans are trusted.

## Open questions

1. **Does CI build the iOS target at all?** PR CI is macOS-only today and does
   not build for iOS. Committing the Xcode project makes iOS breakable
   independently of the web app, so step 1 must decide whether CI gains an iOS
   build or whether it stays a local-only gate.
2. **iPad.** This design is written for iPhone. iPad wants a split view rather
   than sheets, and the decision on record is full iPhone/iPad parity. The shell
   must not be built in a way that forecloses it, but the iPad layout is not
   designed here.
3. **What happens to the 3.1 regressions in the meantime?** The toolbar column
   and the keyboard distortion are live on the device build now. They should be
   reverted before step 1 rather than waiting to be deleted by step 4.
