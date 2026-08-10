# On Paper on iOS and iPadOS

**Date:** 2026-08-09
**Status:** Approved design, pending implementation plan
**Audit:** [`docs/ios/2026-08-09-ios-portability-audit.md`](../../ios/2026-08-09-ios-portability-audit.md) — 37-agent audit, 117 findings, 34 load-bearing claims, 14 adversarially verified from two angles

## Problem

On Paper is a Tauri 2 desktop app (macOS + Windows) for designing résumés, with
AI chat and vector PDF export. The user wants it on iPhone and iPad. The
question posed was whether a Tauri 2 app can simply add an iOS target, and what
would have to be rebuilt.

Short answer: not "simply", but the two things that normally kill such a port
are already solved here, and the cost is concentrated in one place — the UI —
rather than spread across the stack.

## What is already true (measured, not assumed)

These were verified by running commands, not by reading and inferring:

- **The Rust compiles for `aarch64-apple-ios`.** `cargo check --target
  aarch64-apple-ios` finishes clean after removing exactly one line —
  `"updater:default"` from `src-tauri/capabilities/default.json`. Reproduced
  twice independently.
- **The web bundle already runs Tauri-free.** `npx vite build` + serve gives
  `window.isTauri === false`, zero console errors, app boots into onboarding.
- **960 of 964 vitest tests are platform-free.** Only `updaterEndpoints.test.js`
  (4 tests) is desktop-bound.
- **The app already renders correctly at iPad widths** (1024×1366). At 375×812
  it does not: `#resume` is 816px wide inside a 375px viewport — *cropped*, not
  scrolled — and `fitToView()` computes ~0.40, rendering 10pt body text at ~4pt.
- **The real store is 4.4 MB across 45 files**, of which **3.8 MB (86%) is undo
  history across 14 keys**. Actual document data is 180 KB.
- **`resume-designer-data` is a single envelope holding every variant**:
  `variants` (162 KB), `currentVariantId`, `settings`, `userProfile`.

## Decisions made during brainstorm

| Decision | Choice |
|---|---|
| Strategy | **Tauri iOS target, one codebase.** Capacitor discards all 2,859 Rust lines incl. the vector-PDF engine; native SwiftUI shares nothing, because there is no domain core to share |
| Device scope | **iPhone + iPad, full parity** |
| Repository | **Same repo, same Tauri project.** Split the *release pipelines*, not the code |
| Sync | **Partial — documents only.** `resume-designer-data`, job descriptions, applications. History, photos, device settings stay local |
| Sync granularity | **Finer than storage.** Decompose the envelope into per-variant CloudKit records; on-disk format never moves |
| Mac App Store | **Keep the door open.** One App Store Connect record with both platforms registered; ship iOS only |
| Monetization | **BYOK for v1**, credits possible later. No IAP work now |
| Phone edit model | **Hybrid: tap the page, edit in a sheet.** `contentEditable` disabled on mobile |
| PDF host | **Spike in Phase 0** — same-origin iframe preferred, native offscreen WKWebView as proven fallback |
| Contributor terms | Add a second grant so the App Store's DRM does not collide with CC BY-NC-SA's anti-TPM clause. **Done** (`README.md`) |

## Verified findings that shaped the design

Several of the audit's own first-pass conclusions were overturned during
adversarial verification. These are the corrected versions.

### `isTauri` conflates "has IPC" with "is a desktop computer"

`native.js:24` sets `isTauri` from a `globalThis` property that tauri 2.11.3
defines **unconditionally** on every platform (`manager/webview.rs:167-171`, no
cfg). On iOS the first meaning stays true and the second becomes false, so ~41
call sites across 11 files silently do the wrong thing — including a 30-minute
updater `setInterval` (`updateFlow.js:98`) calling a `#[cfg(desktop)]` command,
surfacing "Could not check for updates." on first launch. That alone is a 2.1
rejection.

### 🔴 `confirm()` is a silent data-loss path — corrected 2026-08-09 by Phase 0

**This section previously read "`alert()` and `confirm()` are silent no-ops
(upgraded from 'unknown')".** It reasoned from wry source — `WryWebViewUIDelegate`
implements no JS-panel selectors; grepping
`runJavaScriptAlertPanel|runJavaScriptConfirmPanel` across wry 0.55.1 + tauri
2.11.2 + tauri-runtime-wry returns nothing — and concluded that `confirm()`
returns `false`, making the Import button merely *look* dead. It rated the defect
low-severity and **fail-safe**, and named `backupFlow.js:167` as the dangerous
site.

**Every part of that is wrong, in the dangerous direction.** Measured on the
running app (iOS 27.0 simulator, isolated probe — see
[`docs/ios/phase-0-findings.md`](../../ios/phase-0-findings.md)):

- **`window.confirm()` returns a `Promise`**, in ~1 ms. `confirm_typeof:
  "object"`, `confirm_ctor: "Promise"`, `confirm_strictTrue: false`,
  `confirm_strictFalse: false`, `confirm_BOOLEAN_COERCION: true`.
- **A Promise is always truthy**, so `if (confirm(…))` **always** takes the
  destructive branch, regardless of what the user taps. The literal shape at
  `backupFlow.js:248` was executed in the probe and
  `backupFlowPattern_destructiveRan` came back `true`.
- **`alert()` does present a real native panel** — screenshotted over the
  onboarding screen — but returns in ~1 ms without blocking. It is
  fire-and-forget; any code sequencing on it is broken.

So this is **not** a no-op and **not** fail-safe. On iOS it is a **silent
data-loss path**: a destructive whole-store replace runs with no confirmation at
all.

**The dangerous sites are the two `confirm()` gates**, not `backupFlow.js:167`:

| Site | Consequence on iOS |
|---|---|
| `backupFlow.js:248` | whole-store **REPLACE** proceeds unconfirmed |
| `backupFlow.js:336` | legacy-Electron replace/merge, same pattern |

`backupFlow.js:167` remains real but is a lesser, non-destructive defect: it is an
`alert()` — still the only signal that an import never reached disk, now
non-blocking rather than absent. Eleven reachable `alert()` sites lose their
blocking behaviour (`backupFlow.js:167/201/306/330/467`,
`pdf.js:71/111/376/393/404`, `variantManager.js:251`).

**`native.js:108`'s `confirm` is UNREACHABLE on iOS.** `showMessage()` opens with
`if (isTauri)` at `:86` and returns at `:95`/`:103` through
`tauri-plugin-dialog`'s `dialog.message` / `dialog.ask`. Lines 106-111 are the
**web fallback**, and `isTauri` is `true` on iOS (proved — `platform()` returned
`"ios"` and the migration probe ran, both of which require IPC). Do not budget
work for it. (`components/PdfDialog.jsx:164`'s `confirm()` is a local callback
prop, not `window.confirm` — also unaffected.)

**This moves Phase 1's "swap `backupFlow.js` alert/confirm for
`confirmDestructive`" from cleanup to a data-loss blocker. Nothing that calls
`window.confirm` may ship on iOS.** The iOS behaviour of `dialog.ask` /
`dialog.message` — the natural target for all thirteen sites (eleven `alert()`
calls plus the two `confirm()` gates) — was never exercised in Phase 0; measure
it before designing the fix.

### Blob + `<a download>`: the audit's claim was WRONG, and desktop is fine

**Corrected 2026-08-09 by direct verification.** The audit claimed wry cancels
`<a download>` navigations, citing wry 0.55.1 `wkwebview/navigation.rs:68-74`
(`if should_download { if has_download_handler {…} else { Cancel } }`) plus
Tauri's `download_handler: None` default. Both halves are true — the branch
exists, is not iOS-gated, and `has_download_handler` is genuinely false, since
this app never calls `on_download`.

**But the guard does not fire.** `~/Downloads` contains
`resume-designer-backup-2026-07-16.json` (3,644,200 bytes) and
`…-07-17.json` (3,646,156 bytes), both produced by `persistence.js:617` →
`downloadFile()`. They carry exactly the disk store's profile IDs
(`pmrmwcxgc2sogy6`, `pmrmwdpdi8oeuqx`), which browser mode cannot see —
localStorage on `localhost:3000` is a separate origin from the desktop
per-key disk store. `Cargo.lock` pinned wry **0.55.1** at that date, identical
to today, and `downloadFile` is unchanged since.

The audit verified that the guard *exists* and that its precondition is
*satisfiable*, then inferred that it *fires*. It never established that
`shouldPerformDownload` is true for a same-origin `blob:` URL carrying a
`download` attribute.

**Mechanism is unverified** and deliberately not asserted: either
`shouldPerformDownload` is false (wry takes the `else` branch), or WebKit never
consults the navigation delegate for blob downloads. The second is more likely,
because the `else` branch ends in `Allow`, which would navigate the webview *to*
the blob rather than write a file.

**Implication for iOS:** the sharing design is unaffected and still correct, for
a different reason — iOS has no user-visible Downloads directory, so even an
uncancelled download has nowhere to land. Collapse the four `<a download>` sites
(`persistence.js:1348` and its callers at `:387`, `:393`, `:617`,
`profiles.js:652`) behind one helper with an `isMobile` branch to the share
sheet. **Do not** treat this as a desktop bug; desktop keeps `<a download>`
exactly as-is.

### `createPDF` honours rects on iOS; MediaBox pt == CSS px

WebKit source: `-createPDFWithConfiguration:` forwards `std::optional<FloatRect>`
to `_page->drawToPDF` with no `#if PLATFORM(MAC)`; `drawMainFrameToPDF` calls
`setLayoutViewportOverrideRect`, which is the mechanism letting a rect address
content outside the viewport, in the cross-platform file with no guard.
`pdfSnapshotAtSize` emits pages in CSS px, so `PX_TO_PT = 72/96` stays correct.
Both Apple Forum threads cited as counter-evidence were misread.

**Edge case:** WebKit caps a page at 14400pt and loops, so a rect taller than
14400 CSS px silently becomes multiple PDF pages. Reachable in `.is-overflowing`
mode.

### `objc2-web-kit` has no iOS `WKWebView`

`objc2-web-kit-0.3.2` declares the class `#[unsafe(super(NSView, …))]` +
`#[cfg(target_os = "macos")]`. Widening the cfg gives `error[E0432]`. Two
compile-verified fixes: dynamic `msg_send!` through `AnyObject`, or hand-declare
~40 lines as wry already does (`wry/src/wkwebview/ios/WKWebView.rs:375` already
binds `createPDFWithConfiguration:`, just `pub(crate)`). `WKPDFConfiguration` is
not gated.

### iOS 27 requires a scene manifest

An app with **no** `UIApplicationSceneManifest` fails to launch on the iOS 27
SDK (`NoSceneLifecycleAdoption`). tauri#15719 ships the fix: a **static**
`UISceneConfigurations` entry with `UISceneDelegateClassName = TaoSceneDelegate`
plus `UIApplicationSupportsMultipleScenes`. Ranking: no manifest → crash; empty
dict → crash; static config → launches. Also needs tao#1245's autorelease fix.

### Font loading fails open, and it is a live desktop bug

`fontService.js:174` injects a Google Fonts `<link>` at runtime; `print.html:11`
depends on `document.fonts.ready`. On network failure that promise **resolves
anyway**, so the second paginating render measures fallback metrics and the PDF
is captured with the wrong typeface *and* wrong pagination, silently. This
affects macOS today; mobile only makes it common.

### The AI review menu is unreachable by touch

`inlineEditor.js:58` registers `mouseover`/`mouseout` as the **only** trigger
for `showAIButton()`, and `handleClick` → `startEditing()` calls
`hideAIButton()` at `:785`. A tap fires both in one gesture, destroying the
button before it can be pressed. That menu is the sole UI for Apply / Reject /
Review All. **There is currently no way to accept an AI edit on a touchscreen.**
It works on iPad with a trackpad, which makes it easy to miss in testing.

### Overturned worries (do not budget for these)

- Rubber-band scrolling is already disabled — wry calls `setBounces(false)` on
  iOS unconditionally.
- `100vh` is stable in an embedded webview (no browser chrome). The real hazard
  is the software keyboard shrinking only the visual viewport.
- DevTools need no cable — wry calls `setInspectable(true)` and Safari Web
  Inspector attaches to the Simulator over loopback.
- Chat streaming is fine — `aiService.js:1077` uses `getReader()` manually, so it
  never touches `ReadableStream[Symbol.asyncIterator]`. **Premise corrected
  2026-08-09 by Phase 0: that method is not missing.** This bullet used to say
  "immune to WebKit's *missing* `ReadableStream[Symbol.asyncIterator]`"; measured
  on iOS 27.0 the symbol is **PRESENT**. The conclusion survives, the reason does
  not. **Do not delete `src/readableStreamAsyncIterator.js` on the strength of
  this** — the measurement is iOS 27 and the deployment floor is 17.4. The
  polyfill exists for pdf.js, and stays.
- `dialog.save()` **is** implemented on iOS (shipped 2024) — but broken. Do not
  build on it.
- `@dnd-kit` already uses `PointerSensor`, which activates on touch.
- `macos-private-api` and `macOSPrivateApi: true` are inert on iOS.
- The companion bridge is **not** meaningless on iOS — Safari Web Extensions
  ship inside a containing app. Gate the socket transport; **preserve
  `bridgeRoutes.js`**, which is already transport-agnostic by design.

## Design

### D1 — The platform seam

Replace the overloaded `isTauri` with a three-way predicate resolved at **build
time** (`TAURI_ENV_PLATFORM` is already exposed via `vite.config.js:32`
`envPrefix`). Build-time matters because `SettingsDialog.jsx:69` gates the
Updates tab synchronously; an async `getPlatform()` would flash a dead tab.

```js
export const isTauri   = typeof globalThis !== 'undefined' && 'isTauri' in globalThis;
export const isMobile  = import.meta.env.TAURI_ENV_PLATFORM === 'ios';
export const isDesktop = isTauri && !isMobile;
```

Audit all ~41 sites across the 11 files that reference `isTauri`/`isElectron`:
`native.js`, `pdf.js`, `main.js`, `persistence.js`, `appStorage.js`,
`secretStore.js`, `bridge.js`, `updateFlow.js`, `changelogService.js`,
`tauriDrag.js`, `components/SettingsDialog.jsx`.

Specific corrections:

- `native.js:62` `PLATFORM_MAP` has no `ios` key; `:78`'s `?? raw` returns
  `'ios'` by fallthrough rather than intent. Add it.
- `main.js:374` adds `desktop`/`electron` classes unconditionally.
- `index.html:20` sets `data-tauri="true"` on any Tauri presence, and
  `glass.css:80` then forces `background: transparent !important` on
  `:root`/`body`/`.app` with chrome tinted at 8–14%. Gate on platform, not Tauri
  presence. **Fix shipped** in commit `66fa6a9`; Phase 0 confirms the gate works
  (`data-tauri` is `null` on iOS).
  **Consequence disproven, 2026-08-09.** This bullet used to justify itself with
  "— over a bare UIView with no vibrancy behind it", and the transparency was
  then blamed for the blank screen. **Neither holds.** glass.css was never
  observed to cause any visual damage on iOS: the app was invisible for an
  entirely unrelated reason (a 0×0 WKWebView inside a 0×0 superview inside a
  scene-less `UIWindow` — see the findings), and throughout that period the probe
  read `data-tauri` as `null` with an **opaque** `body` background of
  `rgb(232,228,223)`. The gate is still correct and is kept — it is a
  platform-hygiene fix, not a repair for observed washed-out chrome. Strike the
  vibrancy claim as evidence for anything.
- `tauriDrag.js:80` `startDragging()` on `mousedown` is dead on touch.
- `main.js:1052` branches on deprecated `navigator.platform` for the undo/redo
  modifier. Unverified what it returns on iOS; determine in Phase 0.

### D2 — Build configuration

**Capabilities.** Split `capabilities/default.json`:

- `desktop.json` — `"platforms": ["macOS","windows","linux"]`, holding
  `updater:*`, `process:*`, the `pdf-print-*` window glob, and
  `core:webview:allow-create-webview-window`.
- `mobile.json` — `"platforms": ["iOS"]`, `"windows": ["main"]`.

Scope `pdf-print-*`; do not delete it. Every other permission currently listed
**is** present in `gen/schemas/iOS-schema.json`; only `updater:default` is not.

**`tauri.ios.conf.json`** (new; Tauri merges per RFC 7396): replace
`app.windows` with `[{"label":"main","title":"On Paper"}]`, null
`plugins.updater`, set `bundle.createUpdaterArtifacts: false`, override
`app.security.devCsp` (the current one hardcodes `ws://localhost:3000` and will
CSP-block HMR on a physical device), and add `bundle.iOS`.

**`bundle.iOS.minimumSystemVersion` must be `17.4`, not the 13.0 default.**
`TAURI.md` pins macOS 14.4 because pdf.js needs `Promise.withResolvers` (Safari
17.4); iOS 17.4 is the same engine. The default ships an app that installs on
iOS 13 and throws at runtime in PDF/DOCX import. Also set `developmentTeam`
(`APPLE_TEAM_ID` secret exists) and `bundleVersion`.

**Do NOT set `bundle.iOS.infoPlist` — corrected 2026-08-09 by Phase 0.**
`Info.ios.plist` is picked up by filename automatically; the merge simply fires
at **build** time, not at `init`. An implementer who checks straight after
`tauri ios init`, sees no scene manifest and concludes there is no auto-detection
will add an `infoPlist` block that is redundant at best. Verified at both ends:
the generated `gen/apple/resume-designer_iOS/Info.plist` and the processed
`On Paper.app/Info.plist` both carry `UIApplicationSceneManifest`,
`CFBundleDisplayName`, and `ITSAppUsesNonExemptEncryption`.

**Cargo target tables — corrected 2026-08-09 by the audit's own adversarial
verification pass, not by a Phase 0 finding** (`phase-0-findings.md` says
nothing about Cargo target tables; this is guidance, not an empirical result).
The audit previously said "widen `objc2` / `objc2-foundation` / `objc2-web-kit`
/ `block2` (`Cargo.toml:75-82`) … to include iOS; drop the `objc2-app-kit`
feature on the iOS target." **Widening is wrong**: that block is the macOS
target table and it also carries `objc2-app-kit`, which `pdf_macos.rs` needs
and which iOS cannot build — there is no per-dependency way to "drop a feature
on the iOS target" once the two share one `[target.'cfg(…)'.dependencies]`
table. **Add a separate `[target.'cfg(target_os = "ios")'.dependencies]`
block** carrying only what iOS needs, and leave the macOS block untouched.
This is already the shape of `src-tauri/Cargo.toml` today: a
`[target.'cfg(target_os = "ios")'.dependencies]` block exists, carrying `objc2`
and `objc2-foundation` for the view-hierarchy workaround in `src/ios_view.rs`.
It does **not** carry `block2` yet — that's forward-looking, needed only once
D5's `createPDF` binding requires a completion-handler block (§6 of the
audit), not required for what has shipped so far. Add it, and whatever the
`objc2-web-kit` handling settles on, when D5's Rust work actually lands. Widen
`lopdf` (`:95`) to include iOS as stated. Move `tiny_http`, `rusty-leveldb`,
`dirs` into the existing `cfg(not(any(android, ios)))` block.

**Icons — audit claim corrected 2026-08-09.** The audit said `src-tauri/icons/`
"has no `ios/` and no 1024px master." **Both halves are wrong.** `icons/ios/`
exists with a full `AppIcon-*` set, is tracked in git (18 files), and
`AppIcon-512@2x.png` is a genuine 1024×1024. `tauri ios init` is not blocked and
Phase 0 needs no `npx tauri icon` run.

The real, verified issue is narrower and belongs to Phase 5: that 1024 master
reports `hasAlpha: yes`, and App Store Connect rejects a marketing icon with an
alpha channel. It must be flattened (and checked for a pre-applied corner
radius) before the first upload.

**Do not commit `src-tauri/gen/apple/`.** `.gitignore` ignores `src-tauri/gen/`
wholesale and XcodeGen regenerates the project on every `tauri ios
init/dev/build`, destroying hand-added entitlements or Info.plist keys. Drive
**every** customization from `tauri.conf.json` (`bundle.iOS.template`,
`.frameworks`) so regeneration is lossless — **except `.infoPlist`**, per the
D2 correction above: `Info.ios.plist` auto-detection already works, and setting
`bundle.iOS.infoPlist` on top of it is redundant at best. Never hand-edit the
pbxproj.

### D3 — Dead-but-shipped Rust

`commands/mod.rs:40` `pub mod migration;` and `:52` `pub mod bridge;` are
ungated, and `lib.rs` registers `probe_legacy_electron_data`,
`import_legacy_electron_data`, `bridge_respond`, `BridgePending`
unconditionally. The iOS check emitted 9 dead-code warnings from `bridge.rs`
alone. `migration.rs:109` probes for an Electron LevelDB inside the iOS sandbox,
so the answer is always "no" — while dragging a LevelDB reader + snappy + crc +
fs2 into an App Store binary and burning a boot-time IPC round-trip inside the
storage-ready gate (`appStorage.js:100`).

Gate both `#[cfg(desktop)]`. Keep `bridgeRoutes.js`.

### D4 — Repository and release pipelines

**One repo, one Tauri project.** Moving the repo is not available: `release.yml:78`
hardcodes the updater manifest at `github.com/ashproto/Resume-Designer/...` and
the slug is compiled into every shipped binary. A second iOS-only repo would
fork the 37k-line frontend behind a submodule or package, producing two copies
of `diffEngine`/`changeApply` that must stay bit-compatible — the exact class of
problem this codebase's history shows is expensive.

A monorepo restructure (`packages/core` + `apps/*`) is explicitly **not**
proposed: Tauri mobile wants one project, so it buys a boundary the toolchain
does not want.

The real problem is the pipeline, and it is independent of code layout.
`release.yml:3` triggers on `push: branches: [main, next]` with **no path
filter**, and `compute-version.mjs` derives the version from conventional
commits. An iOS-only `feat(ios):` on `next` today would compute a new version,
build macOS *and* Windows, publish an updater manifest, and notify every beta
user of a release containing nothing visible. The only escape is remembering the
`skip-build` label.

Three changes, all before Phase 2:

1. **Path-scope the triggers.** `release.yml` gains `paths-ignore` for iOS-only
   surfaces; a new `release-ios.yml` takes the complement. `deploy-pages.yml:9`
   already establishes the pattern.
2. **Split the version output.** `compute-version.mjs:154` emits
   `2.1.0-next.4`, which Apple rejects (ITMS-90060 — `CFBundleShortVersionString`
   must be ≤3 integers). Emit a third output: `2.1.0` as the marketing version,
   `github.run_number` as `CFBundleVersion` (must strictly increase per upload).
   *Unverified:* whether the Tauri CLI strips prerelease suffixes itself. Treat
   as unsafe until tested against a real upload.
3. **Decouple cadences.** Desktop ships on merge; TestFlight is not bound to a
   desktop version bump.

### D5 — PDF export

**What survives unchanged:** `pdf_merge.rs` (590 lines, 8 tests — a scratch
crate proved it compiles for `aarch64-apple-ios`), `print.html`,
`printEntry.js`, the pagination measurement, the doc-relative CSS-px rects, and
`PX_TO_PT = 72/96`.

**What dies:** the hidden `pdf-print-*` window. `Window::add_child` is
`#[cfg(any(test, all(desktop, feature = "unstable")))]`, and tao's iOS
`set_visible(false)` maps to `setHidden: YES` — the non-rendering state
`pdf.js:262` exists to avoid.

**Host selection is a Phase 0 spike between two options.** Both need the same
`createPDF` binding, so the spike is cheap.

**Option C — same-origin iframe (preferred).** `<iframe src="/print.html">`
sized 816 × totalHeight, captured via `createPDF` rects on the main webview. An
iframe's layout viewport equals its *element* size, so content lays out at 816
CSS px regardless of a 390pt phone — no viewport-meta surgery. Keeps a separate
document and JS realm, so `printEntry.js` mostly survives. Needs a `postMessage`
bridge (Tauri's IPC init script is main-frame-only). **Unverified:** whether
WebKit composites iframe content into a `createPDF` rect outside the visible
area. This is what the spike settles.

**Option A — native offscreen WKWebView (proven fallback).** A second
`WKWebView` (a `UIView`, not a window) built from Rust via `with_webview` →
`PlatformWebview::view_controller()`, inserted with `insertSubview:atIndex:0`
at `alpha = 0.01` — **not** `isHidden`, because detached/hidden WKWebViews skip
layout and JS. Frame `CGRect(0, 0, 816, totalHeight)`; the 816 is load-bearing,
since `print.html:5` uses `width=device-width`, which in an embedded WKWebView
resolves to the webview's width.

> **Landmine in A.** Create the webview with the main webview's `configuration`
> so it inherits wry's `tauri://` `WKURLSchemeHandler` (that is how
> `/print.html` resolves for free) — then **immediately assign a fresh
> `WKUserContentController`.** The copy otherwise shares wry's `ipc`
> script-message handler bound to the *main* webview, so Tauri attributes the
> print page's `invoke()` to label `main` and replies by `evaluateJavaScript` on
> the wrong webview. Every call hangs to its 30-second timeout.

**Rejected:** in-document capture in the main webview (requires viewport-meta
swapping, hostile on phone); `UIPrintPageRenderer` (does its own pagination,
fighting `pagination.js`); `layer.render(in:)` and html2pdf (both rasterise,
defeating the ATS premise — `pdf.js:474` says so explicitly). html2pdf stays as
a **labelled** interim export during Phase 1 only.

**Save becomes share.** `pick_pdf_save_path` → `fs::copy` is inverted on iOS:
the dialog plugin writes a zero-byte placeholder and exports at picker time, so
the copy can silently succeed into an invisible cache (tauri#12587). The app
already captures *before* picking, so this is one `#[cfg(target_os = "ios")]`
branch to `UIActivityViewController`. **Pass `position` or it crashes on iPad.**

**Preview memory must be fixed before shipping.** `pdfPreview.js:76` renders
every page at `devicePixelRatio` with no virtualization: at dpr 3 one Letter
sheet is ~16.8 MB RGBA, so a 5-page résumé is ~84 MB of canvas — on top of ~4–5
copies of the base64 blob crossing IPC from `read_pdf_preview`. Cap dpr at 2,
virtualize, serve the temp file over a custom protocol instead of base64, and
null `canvas.width/height` off-screen. The `shouldCancel()` plumbing exists.

**Guard the 14400pt page cap.** Also verify whether iOS `createPDF` needs
`-webkit-print-color-adjust: exact` for backgrounds (`styles/print.css` has no
such rule); unverified, needs a visual diff against a macOS reference.

### D6 — Fonts

Self-host all preset pairings and the 28 popular fonts via `@fontsource/*`,
replacing the runtime Google Fonts `<link>` in `fontService.js:174`. The repo
already does exactly this for UI type (`main.jsx:7`). This is the
highest-value single fix in the plan: it hardens **desktop** export against the
silent wrong-typeface/wrong-pagination failure, removes two CSP entries and a
third-party network call from the privacy story, and makes offline export
correct on mobile.

### D7 — Editing on mobile

`contentEditable` is **disabled entirely when `isMobile`.** This does not
mitigate the port's largest unverified risk — caret placement and
selection-handle dragging inside `zoomControls.js:87`'s `transform: scale()`
subtree, at ~0.40 on a phone — it removes it, because no caret is ever placed
there.

**The model:**

1. Tap a `[data-editable]` → **select**, don't edit. Highlight in place; the
   canvas stays a scaled read-only surface.
2. A bottom sheet opens with a real `<textarea>` at native size, plus
   Cancel / Done.
3. If the element has a pending AI change, the sheet also carries
   **Apply / Reject / Review All** — the fix for the unreachable hover menu.

**What this buys:** system keyboard avoidance, system selection handles, and
`autocorrect="off"` / `autocapitalize="off"`. There are currently **zero** such
attributes anywhere in `src/`, and `inlineEditor.js:975` writes
`element.textContent` straight to storage — so iOS would silently rewrite
résumé prose and persist the rewrite.

**What it still costs:**

- `components/ui/sheet.jsx` (109 lines) is vendored and imported by **zero**
  files. This is its first consumer. Its `bottom` variant needs `max-h`,
  safe-area padding, and a grabber.
- A `visualViewport` resize listener writing a CSS custom property.
  Non-optional: every ancestor is `overflow: hidden`, so a focused field
  physically cannot scroll above the keyboard.
- Blur must **not** silently commit on mobile (`inlineEditor.js:979`) — there is
  no Escape key, so Cancel is the only abort path.
- Desktop behaviour is unchanged: `contentEditable`, Tab-to-next
  (`inlineEditor.js:1030`), and Cmd+B (`:997`) all stay.

### D8 — Responsive shell and touch

**Container queries, not device breakpoints.** iPadOS 26 Windowed Apps + Stage
Manager + Split View (~507pt) + Slide Over (~320pt) make width a *continuous*
range overlapping the phone, so there is one continuum, not two devices.
`main.css:737` already proves the technique (`container-type: inline-size`,
`@container (max-width: 565px)`).

- `--chat-panel-width: 320px` + `--structure-panel-width: 380px` = 700px of
  chrome around an 816px canvas. Both become overlays below the regular
  breakpoint. `.chat-panel` already has an off-canvas rule at ≤768px
  (`chat.css:315`); **`.structure-panel` has none at any width** — at 390pt it
  is 340px of a 390px viewport.
- `LibraryDialog.jsx:97` is `h-[82vh] w-[94vw]` with a hardcoded `w-[340px]`
  master column at `:141` — leaving the detail pane **27px** at 390pt.
- Touch targets to 44pt via mobile variants, not global bumps: `button.jsx:24`
  `h-9`; `slider.jsx:18` thumb `h-4 w-4`; `segmented.jsx:41` `h-[25px]` (whose
  own comment at `:12` calls those heights "the spec, not magic numbers");
  `.zoom-btn` 30×30 with 2px gaps.
- 115 native `title=""` tooltips never fire on touch. `ThreadSelector.jsx:62`'s
  `opacity-0 group-hover:opacity-100` controls are worse than hidden — they hold
  layout and swallow taps at zero opacity. `TimelineView.jsx:69`'s Radix
  `Tooltip` is the sole carrier of per-application detail.
- Safe area: `index.html:5` needs `viewport-fit=cover`; there are zero hits for
  `env(safe-area-inset` anywhere. **No Swift plugin needed** —
  `PlatformWebview::inner()` is `#[cfg(any(macos, ios))]` and the repo already
  uses `with_webview` + objc2 in `pdf_macos.rs:73`, so ~10 lines set
  `contentInsetAdjustmentBehavior = .never`.
- `index.html:5` has no `maximum-scale`, so WKWebView page-zoom will fight
  `zoomControls.js`'s `transform: scale()` indistinguishably, stranding every
  `position: fixed` affordance and the AI button's `getBoundingClientRect()`
  math (`inlineEditor.js:677`).

### D9 — Storage and durability

- **Lazy-load `resume-designer-history-*`.** 86% of the store, read into a
  `HashMap`, serialized across IPC, and retained in a JS `Map` at every launch
  (`appStorage.js:476`). Fetch on first undo. Fixes launch memory, sync payload,
  and backup bloat together.
- **Background durability.** `main.js:405`'s `onCloseRequested` →
  `saveNow()` + `flush()` never fires on iOS, where suspension *is* the normal
  exit; `visibilitychange` (`:427`) is the only remaining barrier and `flush()`
  is async with no background-task assertion. Worst case ~750 ms of unwritten
  edits per suspension. Needs a Swift plugin observing
  `UIApplication.didEnterBackgroundNotification` wrapping the flush in
  `beginBackgroundTask(withName:)`. Also reduce `SAVE_DEBOUNCE_MS` (500) and
  `DRAIN_COALESCE_MS` (250) on mobile.
- **Exclude history from iCloud device backup** (`isExcludedFromBackup`); keep
  documents backed up. Nothing sets this today.
- **Keychain reinstall asymmetry.** iOS keychain items survive app deletion, so
  delete-and-reinstall yields an app with the API key restored and every résumé
  gone — a state `secretStore.js:88`'s six-mode machine has never seen. Add a
  first-launch reconciliation. Do **not** enable `kSecAttrSynchronizable`; that
  would sync the OpenRouter key via iCloud Keychain. *Unverified:* what
  `kSecAttrAccessible` class keyring's `ios.rs` applies, and whether keychain
  calls succeed from an unprovisioned Simulator build (errSecMissingEntitlement
  −34018 is the classic failure).
- **Photos.** `DesignTab.jsx:810` does `readAsDataURL` with no resize,
  compression, or cap — a 12MP capture is ~4–7 MB base64, re-serialised on every
  settings tweak. Add a canvas downscale (~512px long edge, JPEG 0.85); ~30
  lines, and it also fixes the browser build's 5 MB localStorage risk. Add
  `NSPhotoLibraryUsageDescription`, or skip it via `PHPickerViewController`.
  *Unverified:* whether the iOS picker returns transcoded JPEG or raw HEIC —
  `photoService.js` does no format validation.

### D10 — Sync

**Sync granularity is deliberately finer than storage granularity.**
`resume-designer-data` is a single 162 KB envelope holding every variant, so
one-record-per-key would mean editing résumé A on the phone and résumé B on the
Mac silently clobbers one of them. The CloudKit adapter decomposes on write and
recomposes on read. **On disk nothing changes** — `BACKUP_FIXED_KEYS` stays
frozen, the atomic envelope `persistence.js:400` relies on stays intact, and the
wipe-before-validate restore path is untouched.

| Record | Contents | Conflict rule |
|---|---|---|
| `variant/<id>` | one résumé | LWW + "newer version on another device" prompt |
| `index` | `currentVariantId`, `settings`, `userProfile` | LWW |
| `jobDescription/<id>`, `application/<id>` | already independent | LWW |
| *not synced* | history, photos, device settings | — |

Conflict granularity becomes per-résumé, matching how the app is used. Hazard: a
variant arriving before the index leaves `currentVariantId` dangling — fall back
to the first available variant.

Payload ~600 KB (14% of the store), `CKServerChangeToken` deltas thereafter.
Costs a Swift plugin on iOS, an objc2/Swift binding on macOS, and — easy to miss
— **a provisioning profile added to the currently-plain Developer ID DMG
pipeline.** CloudKit records, not `NSUbiquitousKeyValueStore`: the restriction
on iCloud Documents/ubiquity containers for Developer-ID Mac apps is *unverified*
for 2026, and this design does not depend on the answer.

### D11 — Distribution and compliance

- **$99/yr** individual. Register `com.resumedesigner.app` as an explicit App ID
  (Developer ID never required one). **One** App Store Connect record with both
  platforms; records cannot be merged retroactively. Do **not** mint
  `com.resumedesigner.ios`.
- **The updater needs zero Rust work** — already `#[cfg(desktop)]`-gated in
  `Cargo.toml:69`, `mod.rs:56`, and inside `generate_handler!`. Hide the Updates
  tab via `isDesktop`; drop `process:*` with it (`native.js:418`'s `relaunch()`
  is the plugin's only caller).
- **`next` → TestFlight internal** (100 users, no Beta App Review, minutes);
  `main` → App Store. Branch model survives. Batch external betas — those
  trigger Beta App Review (2–7 days, longer with AI features cited).
- **CI: pin `runs-on: macos-26`**, not `macos-latest`. Apple has required the
  iOS 26 SDK for uploads since 28 April 2026. Add `APPLE_API_KEY_ID` /
  `APPLE_API_ISSUER_ID` / `APPLE_API_PRIVATE_KEY` to the existing fail-fast
  secret check at `release.yml:163`. Build with `tauri ios build
  --export-method app-store-connect`, upload via `xcrun altool`.
- **`productName` — tested, does NOT reproduce (Phase 0, 2026-08-09).** This
  entry used to read "Test `productName` on first `tauri ios init`… force
  `PRODUCT_NAME` via `bundle.iOS.template` if it reproduces". tauri#11257
  describes this exact config — `productName: "On Paper"` vs Cargo `name =
  "resume-designer"` — producing a mis-named IPA and a failing `tauri ios dev`.
  **It did not happen.** The two coexist cleanly in the generated
  `project.yml`/pbxproj; the CLI 2.11.2 handles it. **The conditional
  `PRODUCT_NAME` workaround is struck** — do not budget for it, and do not add
  a `bundle.iOS.template` for this reason. `CFBundleDisplayName = "On Paper"` is
  still correct and is already shipping (verified in the built
  `On Paper.app/Info.plist`).
- **No OTA web-asset updates in v1.** Legally reachable under ADPLA §3.3.1(B)
  (the basis for CodePush/Expo/Capacitor), but there is an unpaid prerequisite:
  `tauri.conf.json:36` pins an inline script hash into the binary's CSP, so any
  OTA'd `index.html` differing by one byte is CSP-blocked and shows a blank
  webview. Revisit after the app is in the store.

**Compliance gaps that are real work, not checkboxes:**

1. **No privacy policy exists.** `website/` is `CNAME, favicon.svg, hero.jpg,
   index.html`. A policy URL is a hard submission gate and must also be linked
   in-app.
2. **Guideline 5.1.2(i)** (Nov 2025 revision) requires explicit consent before
   sharing personal data with third-party AI. `aiService.js:642` and `:788`
   concatenate `fullName`/`email`/`phone` into outbound messages; `:431` lists
   nine contact fields. There is no consent gate anywhere. Needs a real one-time
   disclosure screen.
3. **Onboarding hard-gates on an API key.** Screen 1 of 6 demands a
   `sk-or-v1-…` field with one button, so App Review cannot reach the app — a
   2.1 rejection independent of anything commercial. Add "Skip for now"; the
   editor and export work fine without a key.
4. `PrivacyInfo.xcprivacy` (an *upload-time* gate — `UserDefaults` CA92.1 and
   `FileTimestamp` 3B52.1 both apply), App Privacy labels, age rating (expect
   >4+ given AI chat), `ITSAppUsesNonExemptEncryption = false`, screenshots for
   every required device size, review notes with a funded OpenRouter key.

## Phasing

| Phase | Content | Gate |
|---|---|---|
| **0 — Spike** | Capability split → `cargo check --target aarch64-apple-ios` → `tauri ios init` → iOS 27 scene manifest → Simulator + Safari Web Inspector. **Plus the two decisive spikes:** `createPDF` rect test (iframe vs native webview), and contentEditable-in-`transform: scale()` on physical hardware | App icon on a device; PDF host chosen |
| **1 — Correctness** | `isDesktop` predicate + all 41 sites; gate dead Rust; `backupFlow.js` `alert`/`confirm` → `confirmDestructive`; self-host fonts; lazy history; onboarding skip. Ship html2pdf as a *labelled* interim export | Desktop unaffected or improved; CI green on both targets |
| **2 — PDF engine** | D5. Requires D4's pipeline split to have landed | Vector PDF byte-comparable to macOS reference |
| **3 — UI** | D7 + D8. The largest workstream | Usable at 390pt and across the iPad continuum |
| **4 — Sync** | D10 | Two devices, no clobber |
| **5 — Compliance** | D11. Weeks of non-code work | Submitted |

Phase 1 is deliberately front-loaded with items that are **desktop wins**
(fonts, `alert()`, lazy history) so they flow through `next` and release
normally. D4's pipeline split must land before Phase 2, when iOS-only commits
begin.

### This spec is an umbrella; each phase gets its own plan

Phases 0–5 span months and several thousand new lines. No single implementation
plan should cover them. This document is the design of record; implementation
plans are written **one phase at a time**, and later phases are deliberately
not planned yet because Phase 0's spikes change them:

- The `createPDF` rect spike decides D5's host, which decides how much of
  Phase 2 is native code versus JavaScript.
- The contentEditable spike is what would reopen on-page editing on mobile if it
  came back clean — which would materially change D7 and Phase 3.
- `tauri ios init` settles the `productName`, `TARGETED_DEVICE_FAMILY`, and
  `gen/` questions that D2 and D4 currently answer by inference.

Planning Phase 3 today would be planning against nine unverified assumptions.

## Testing

- **960 of 964 existing tests keep protecting the port** and must stay green
  throughout. `updaterEndpoints.test.js` (4 tests) needs desktop-gating.
- **`cargo check --target aarch64-apple-ios` becomes a CI invariant in Phase 0**,
  before any UI work, so the iOS target cannot silently regress.
- `npx vite build` stays in the gate — `npm run test` covers only service
  modules, so broken imports or JSX in `src/components/**` pass a green suite.
- New unit tests: the sync decompose/recompose round-trip (pure, no CloudKit),
  the `isDesktop`/`isMobile` predicate matrix, and the 14400pt page-cap guard.
- PDF output verified by byte-comparing a fixed fixture résumé against a macOS
  reference, not by eye.
- Anything layout- or scroll-sensitive is verified on device, not in
  ClaudePreview (Chromium) — the shipped app is WKWebView.

## Error handling

- Every path that currently surfaces failure through `alert()` must route
  through the existing `confirmDestructive` / `showMessage` instead.
  **Priority reordered 2026-08-09 by Phase 0:** the two `window.confirm()` gates
  (`backupFlow.js:248` and `:336`) come first — on iOS they are a silent
  data-loss path, not a cosmetic one. `backupFlow.js:167` is next, still the only
  signal that an import never reached disk, now non-blocking rather than absent.
- Sync failures are non-blocking and never destructive: on conflict, prompt;
  on network failure, queue.
- PDF export failure must not leave the app in `pdf-export-mode` — the existing
  `finally` teardown applies to whichever host wins the spike.

## Out of scope

Android; Apple Pencil / PencilKit; OTA web-asset updates; a Mac App Store build
(only the App Store Connect record is created now); IAP and credit sales;
Safari Web Extension companion on iOS (the router is preserved, the transport
is not built).

## Explicitly unverified

Carried forward from the audit. None of these are settled; several gate
estimates.

### Answered by Phase 0 — 2026-08-09

These were open questions (or, worse, confidently wrong answers) when this spec
was written. Running the app on an iOS 27.0 simulator settled them. Do not
re-derive work for any of them; the detail is in
[`docs/ios/phase-0-findings.md`](../../ios/phase-0-findings.md).

| Question | Answer |
|---|---|
| What `alert()` / `confirm()` actually do on iOS | **ANSWERED** — `confirm()` returns a truthy `Promise` in ~1 ms, so `if (confirm(…))` always runs the destructive branch; `alert()` presents a real panel but does not block. Not a no-op, not fail-safe. See the corrected finding above. |
| Whether `icons/ios/` exists and blocks `tauri ios init` | **ANSWERED** — it exists (18 tracked files), `AppIcon-512@2x.png` is a real 1024×1024, `init` is not blocked. The `hasAlpha: yes` upload gate is confirmed and stays Phase 5. |
| Whether tauri#11257 (`productName` vs Cargo `name`) reproduces | **ANSWERED — no.** Workaround struck; see D11. |
| Whether `ReadableStream[Symbol.asyncIterator]` is missing on iOS WebKit | **ANSWERED — it is PRESENT** on iOS 27. Conclusion unchanged, premise was false; the polyfill still stays for the 17.4 floor. |
| Whether `Info.ios.plist` is auto-detected | **ANSWERED — yes**, merged at build time, not at `init`. Do not set `bundle.iOS.infoPlist`. |
| `TARGETED_DEVICE_FAMILY`, `IPHONEOS_DEPLOYMENT_TARGET`, `gen/` tracking | **ANSWERED** — `"1,2"`, `17.4`, and nothing under `gen/` becomes tracked. |
| What `navigator.platform` returns on iOS (D1's `main.js:1052`) | **ANSWERED — `"iPhone"`** (on iPhone; see the new iPad unknown below). |

**Still open, unchanged:** the `createPDF` rect question is **not** answered —
Task 5's spike did not run in Phase 0. Everything in the list below stands.

### New unknowns opened by Phase 0

These replace the answered items and did not exist as questions before the app
ran.

- **Whether `dialog.ask` / `dialog.message` present *and resolve* on iOS.** This
  is the natural single fix for all thirteen `alert`/`confirm` sites, the
  permissions are already in `capabilities/default.json`
  (`dialog:allow-ask`, `allow-message`, `allow-confirm`), and the path was never
  exercised. Measure before designing the Phase 1 fix — it decides whether that
  work is a facade swap or needs React plumbing.
- **What the iPad user agent is.** The platform gate and the UA string
  (`…(iPhone; CPU iPhone OS 18_7 …)`, note the frozen `18_7`) were measured on
  **iPhone only**. Any UA- or `navigator.platform`-derived branch must be
  re-measured on iPad before it is trusted.
- **Safe-area insets need re-measuring.** `env(safe-area-inset-*)` read `0` both
  with and without `viewport-fit=cover` — but that reading was taken against a
  **0×0 viewport**, which makes it worthless. Re-measure now the viewport is
  non-zero, before D8's safe-area work is planned.
- **Why wry returned navigation policy 2 (`Download`) on iOS.** During the
  blank-screen investigation, **before the 0×0-viewport fix landed**, the log
  showed `decidePolicyForNavigationAction … Client responded with policy 2`
  plus "Adding download 30 to UIProcess DownloadProxyMap" — recorded in
  [`phase-0-findings.md`'s ASIDE
  section](../../ios/phase-0-findings.md#aside-an-unexplained-navigation-policy-log--observed-pre-fix-needs-re-observation).
  Per wry `navigation.rs:70`, returning `Download` implies
  `has_download_handler == true` — which contradicts the premise, shared by the
  audit and by the corrected blob finding above, that Tauri leaves
  `download_handler` at `None`. Unexplained, and it bears directly on the still-
  open `<a download>`-on-iOS question below — **but it was observed against a
  broken render and must be re-confirmed on the now-visible app before anyone
  invests time explaining it.**

### Carried forward

- Whether `WKPDFConfiguration.rect` behaves as WebKit source implies on a real
  device with a 3-sheet résumé.
- Whether WebKit composites **iframe** content into a `createPDF` rect outside
  the visible area (decides D5's host).
- Whether an `alpha = 0.01` WKWebView reliably resolves `document.fonts.ready`
  and returns non-zero `getBoundingClientRect()`.
- Whether Tauri's iOS scheme handler serves `/print.html` (a second Vite entry).
- Whether `-webkit-print-color-adjust: exact` is required for iOS backgrounds.
- Caret and selection behaviour inside a `transform: scale()`d contentEditable
  (mooted by D7 for mobile, but still gates any future on-page editing).
- What `kSecAttrAccessible` class keyring's `ios.rs` applies.
- Whether keychain calls succeed from an unprovisioned Simulator build.
- What iOS `<input type="file" accept="image/*">` returns for a HEIC capture.
- Whether the Tauri CLI strips semver prerelease suffixes for
  `CFBundleShortVersionString`.
- Whether `<a download>` produces anything on **iOS**. (Desktop is **settled**:
  verified working — see the corrected finding above. Only the iOS outcome and
  the underlying WebKit mechanism remain open, and the share-sheet design does
  not depend on either answer.)
- Whether the iCloud ubiquity-container restriction for Developer-ID macOS apps
  still holds in 2026.
