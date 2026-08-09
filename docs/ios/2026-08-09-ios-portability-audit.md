---
title: On Paper — iOS / iPadOS portability audit
date: 2026-08-09
status: audit only — nothing implemented, no decisions made
method: 37-agent audit; 8 parallel subsystem readers, 117 findings, 34 load-bearing claims, 14 adversarially verified from two angles (refute + find-a-workaround)
note: |
  Claims marked "verified" were checked by actually running the command
  (cargo check --target aarch64-apple-ios, npx vite build, vitest) or by
  reading upstream source (wry 0.55.1, tauri 2.11.x, WebKit, objc2-web-kit).
  Section "Explicitly unverified" at the end is authoritative about what is
  NOT settled. Do not treat anything outside it as guesswork, and do not
  treat anything inside it as settled.
---

# On Paper → iOS / iPadOS: Portability Map

> ## ⚠️ Correction — 2026-08-09, after publication
>
> **The blob `<a download>` finding in §1(e), §3, §4 and §5 is WRONG for
> desktop.** The audit reasoned that wry's `navigation_policy` Cancel branch
> fires for `<a download>`, and flagged that desktop might therefore already be
> broken. Direct verification says it is not:
>
> - `~/Downloads/resume-designer-backup-2026-07-{16,17}.json` (3.6 MB each) were
>   produced by `persistence.js:617` → `downloadFile()` and contain exactly the
>   desktop disk store's profile IDs — which browser mode cannot see.
> - `Cargo.lock` pinned wry **0.55.1** at that date, identical to today, and
>   `downloadFile` is unchanged since.
>
> The guard exists and its precondition is satisfiable, but it does not fire:
> the audit never established that `shouldPerformDownload` is true for a
> same-origin `blob:` URL with a `download` attribute. **Desktop needs no fix.**
> The iOS share-sheet design still stands, because iOS has no user-visible
> Downloads directory. See the corrected finding in
> [`../superpowers/specs/2026-08-09-ios-ipados-port-design.md`](../superpowers/specs/2026-08-09-ios-ipados-port-design.md).

## 1. The one-paragraph answer

No, you cannot "just build it to iOS" — but you are far closer than the size of the app suggests, and the reason is that the two things that usually kill a port are already solved here. The Rust backend compiles for `aarch64-apple-ios` today (verified: `cargo check --target aarch64-apple-ios` finishes clean after removing exactly one line, `"updater:default"`, from `src-tauri/capabilities/default.json`), and the web bundle already runs with zero Tauri globals and zero console errors (verified: `npx vite build` + serve in Chromium, `window.isTauri === false`, app boots into onboarding). 964/964 vitest tests pass under jsdom with no Tauri runtime. What actually blocks you is narrower and sharper than "iOS is different": (a) the PDF export pipeline is built on a hidden off-screen second `WebviewWindow`, and Tauri has no runtime multi-window on iOS — but the capture primitive itself, `WKWebView.createPDF`, is iOS 14+ and the verification pass compiled a working iOS binding for it, so this is a rehost, not a rewrite; (b) the save flow is `pick path → write into path`, which iOS inverts, though the app *already* captures-then-picks, so the fix is one `#[cfg(target_os = "ios")]` branch, not a redesign; (c) `isTauri` means "desktop" in ~41 places across 11 files, so every desktop branch fires on iOS including a broken updater poll every 30 minutes; (d) `alert()`/`confirm()` are verified no-ops in wry's iOS WKWebView (its `WryWebViewUIDelegate` implements no JS-panel selectors), which silently kills the destructive backup-restore confirm and every failure message; and (e) blob + `<a download>` exports do nothing, because wry's `navigation_policy` cancels download-attributed navigations when no download handler is registered. The genuinely large, genuinely unavoidable cost is the UI: a 1400×900 three-pane shell around a fixed 816px paper canvas is a *different product* on a 390pt phone, and that is where the xlarge estimate lives — not in Rust, not in the PDF engine.

---

## 2. What ports untouched

Measured line counts (`find src -name '*.js' -o -name '*.jsx' | xargs wc -l` = 36,999; `src-tauri/src` = 2,859).

### Frontend: 13,326 lines (36.0%) — zero platform coupling

`aiService.js` (1,647 — **1** DOM reference, **0** Tauri references), `persistence.js` (1,457), `renderer.js` (1,282 — 0 DOM/Tauri refs, emits HTML strings), `components/chat/useChat.js` (1,139), `profiles.js` (703), `store.js` (608), `diffEngine.js` (568 — 0/0), `onboardingLogic.js` (409), `headerStyleService.js` (378), `changeApply.js` (368), `changelogService.js` (336), `resumeParser.js` (334), `profileMarkdown.js` (334), `jobRecommendations.js` (288), `jobDescriptions.js` (283), `variantManager.js` (267), `chatThreads.js` (250), `tokenTrackingService.js` (241), `parser.js` (241), `applications.js` (231), `profileKeys.js` (217), `experienceGroups.js` (211), `changePreview.js` (176), `readableStreamAsyncIterator.js` (140), `modelCatalog.js` (139), `applicationStats.js` (125), `experienceDates.js` (122), `aiStream.js` (105), `librarySearch.js` (99), `learnedAnswers.js` (87), `changeSession.js` (86), `pageSetup.js` (40), `accountStats.js` (38), plus the small helpers.

### Rust: 2,105 of 2,859 lines (74%)

| Module | Lines | Status |
|---|---|---|
| `commands/storage.rs` | — | `app.path().app_data_dir()` resolves inside the iOS container; tmp+`sync_all()`+`rename` is plain POSIX on APFS. Physical keys `resume-p--<id>--<key>` are already filename-legal. |
| `commands/secret.rs` | — | keyring 3.6.3 ships `src/ios.rs` under `#[cfg(all(target_os = "ios", feature = "apple-native"))]`, wrapping `security_framework::passwords::*`. `Entry::new(SERVICE, name)` passes no target, which is exactly what the iOS module requires; `validate_name` already rejects empty names. Compiled in the iOS check. |
| `commands/pdf_merge.rs` | 590 | Pure `lopdf`, no platform APIs, 8 unit tests. Independently verified: a scratch crate depending on `lopdf 0.36` compiles clean for `aarch64-apple-ios`. Excluded today only by the `cfg(any(macos, windows))` gate at `Cargo.toml:95`. |
| `commands/mod.rs` preview slots | — | `read_pdf_preview` / `save_pdf_preview` / `discard_pdf_preview` + `PendingPdfPath`/`PreviewPdfPath` are `Mutex<Option<PathBuf>>` + `std::fs`. `std::env::temp_dir()` → `$TMPDIR` inside the container. |
| `commands/bundle_name.rs` | — | Already `#[cfg(target_os = "macos")]`; premise (auto-updated bundle stranded with an old directory name) cannot occur on iOS. Zero work. |
| `commands/pdf_windows.rs` | 281 | Already `#[cfg(target_os = "windows")]`. Drops out. |

### Also untouched

- **Profile namespacing, restore guard, reload-based profile switch** — `profileKeys.js:197-217`, `appStorage.js:339-433`, `backupFlow.js:78/106`. Pure JS + filename-safe keys + a webview reload.
- **The AI network layer.** All traffic is browser `fetch` from the webview to `https://openrouter.ai`; there is no `reqwest`/`tauri-plugin-http` in `src-tauri`. The CSP's `connect-src 'self' ipc: … https://openrouter.ai https://api.github.com` already covers iOS, because iOS uses the same `tauri://localhost` origin form macOS does.
- **The SSE streaming loop.** `aiService.js:1077-1091` uses `response.body.getReader()` manually, *not* `for await`. The `readableStreamAsyncIterator.js` polyfill exists for pdf.js's `streamTextContent`, not for chat — the audit's original framing of that dependency was wrong. Chat streaming is immune to WebKit's missing `ReadableStream[Symbol.asyncIterator]`.
- **Tests.** 960 of 964 keep protecting the port. Only `updaterEndpoints.test.js` (4 tests, reads `commands/updater.rs` off disk) is desktop-only.
- **`<input type="file">` imports.** WKWebView presents the system picker and yields a real `File`; `file.arrayBuffer()` → pdf.js/mammoth in `resumeParser.js:291,312-316` works. `Header.jsx:383`, `SettingsDialog.jsx:718`, `AccountSection.jsx:374`, `DesignTab.jsx:473`, `JobsDialog.jsx:216` all fine (verify `accept=".txt,.pdf,.docx"` at `OnboardingSteps.jsx:341-343` — plugins-workspace #3030/#1578 report unrecognised accept lists defaulting to the photo picker).
- **`@dnd-kit` reordering.** `Sortable.jsx:32-34` uses `PointerSensor`, which activates on touch, and `touch-none` on the handle correctly stops the scroller stealing the gesture. Only the 14px handle size and the 4px no-delay activation need attention.
- **`macos-private-api` Cargo feature and `macOSPrivateApi: true`.** Verified inert on iOS — consulted only under `cfg(any(not(target_os = "macos"), feature = "macos-private-api"))`.

---

## 3. What needs adaptation

### 3.1 Build configuration — small, mechanical, do first

**`src-tauri/capabilities/default.json`** — line 26 lists `"updater:default"` with no `"platforms"` key. Tauri's capability schema defaults to all platforms; `updater:default` does not exist in the iOS ACL because `Cargo.toml:69` cfg-gates the plugin off iOS. This is a hard `build.rs` error and it is literally the first thing that breaks. Proof both ways: `src-tauri/gen/schemas/desktop-schema.json` contains `updater:default`; `gen/schemas/iOS-schema.json` does not — and every *other* permission the file lists (`process:default`, `shell:allow-open`, `dialog:*`, `fs:*`, `os:*`, `core:window:allow-start-dragging`, `core:webview:allow-create-webview-window`) **is** present in the iOS schema. Split into `desktop.json` (`"platforms": ["macOS","windows","linux"]`, holding `updater:*`, `process:*`, the `pdf-print-*` window glob, `core:webview:allow-create-webview-window`) and `mobile.json` (`"platforms": ["iOS"]`, `"windows": ["main"]`). Don't delete `pdf-print-*` — scope it.

**`src-tauri/tauri.conf.json`** — the entire `app.windows[0]` block is desktop-only (`width: 1400`, `minWidth: 750`, `transparent`, `titleBarStyle: "Overlay"`, `trafficLightPosition`, `windowEffects: ["popover","acrylic"]`). None of it throws on iOS; it is read into `WindowConfig` and ignored, which is worse than an error. Create `tauri.ios.conf.json` — Tauri merges it per RFC 7396 JSON Merge Patch — replacing `app.windows` with `[{"label":"main","title":"On Paper"}]`, nulling `plugins.updater`, setting `bundle.createUpdaterArtifacts: false`, and adding a `bundle.iOS` block.

**`bundle.iOS`** — `tauri-utils-2.9.2/src/config.rs:3160-3191` defines `IosConfig` with `minimumSystemVersion` defaulting to **13.0**, which is far below your real floor. TAURI.md pins macOS 14.4 because pdf.js needs `Promise.withResolvers` (Safari 17.4). The iOS equivalent is **17.4** — leaving 13.0 means the app installs on iOS 13 and throws at runtime in PDF/DOCX import. Also required: `developmentTeam` (the `APPLE_TEAM_ID` secret already exists) and `bundleVersion` (monotonic CFBundleVersion; use `github.run_number`).

**Cargo target tables** — widen `objc2`/`objc2-foundation`/`objc2-web-kit`/`block2` from `cfg(target_os = "macos")` (`Cargo.toml:75-82`) to include iOS, widen `lopdf` (`:95`), and move `tiny_http`, `rusty-leveldb`, `dirs` into the existing `cfg(not(any(android, ios)))` block. **Correction from verification:** do NOT simply "widen the cfg and reuse `objc2_web_kit::WKWebView`" — see §6.

**Icons** — `src-tauri/icons/` has no `ios/` and no 1024px master; TAURI.md:42 says the repo ships default Tauri placeholders. `tauri ios init` populates `AppIcon.appiconset` from `icons/ios/`, and App Store submission requires a 1024×1024 opaque, no-alpha, no-pre-applied-radius icon. One `npx tauri icon icon.png` run fixes both the iOS gap and the long-standing desktop placeholder problem.

### 3.2 `src/native.js` — the single JS seam

`native.js:24-25` `isTauri` and `:29` `isElectron = isTauri` are true on iOS (verified in tauri 2.11.3 `src/manager/webview.rs:167-171`: the `Object.defineProperty(window, 'isTauri', {value: true})` init script is unconditional, no `cfg`). Consequences at ~41 call sites across 11 files:

- `native.js:450` `startupUpdateCheck()` and `updateFlow.js:98-104` (a 30-min `setInterval`) both fire on iOS, invoking `check_update_on_channel`, which is `#[cfg(desktop)]` and unregistered → rejection → `updateFlow.js:239-245` shows "Could not check for updates." on first launch. That is a 2.1 App Completeness risk on its own.
- `main.js:374-378` adds `desktop`/`electron` classes unconditionally. (The `desktop-mac` traffic-light padding is safe — it's gated on `platform === 'darwin'`.)
- `index.html:20-33` sets `data-tauri="true"` on any Tauri presence, and `glass.css:80-86` then forces `background: transparent !important` on `:root`/`body`/`.app`/`.app-content`/`.preview-area` with chrome tinted at 8–14% — over a bare UIView with no vibrancy behind it. Washed-out, low-contrast. Gate on platform, not Tauri presence.
- `native.js:62-66` `PLATFORM_MAP` has no `ios` key; `:78` does `PLATFORM_MAP[raw] ?? raw`, so it returns `'ios'` by fallthrough rather than intent. Add the key.
- `bridge.js:41` `initBridge()` mints and *persists* a `crypto.randomUUID()` pairing token under `resume-designer-bridge-token` and logs `[Bridge] ready on 127.0.0.1:17872` — on a platform where the listener never starts.
- `tauriDrag.js:80` `getCurrentWindow().startDragging()` on `mousedown` — dead on touch.
- `main.js:1052` branches on the deprecated `navigator.platform` for the undo/redo mod key. Unverified what it returns in Tauri's iOS WKWebView.

Introduce a real `isDesktop`/`isMobile` predicate (prefer a compile-time flag — `TAURI_ENV_PLATFORM` is already exposed via `vite.config.js:32` `envPrefix: ['VITE_','TAURI_ENV_']` — so the Updates tab never flashes before an async `getPlatform()` resolves).

### 3.3 Dead-but-shipped Rust

`commands/mod.rs:40` `pub mod migration;` and `:52` `pub mod bridge;` are both ungated, and `lib.rs:19/87-88/95` register `BridgePending`, `probe_legacy_electron_data`, `import_legacy_electron_data`, `bridge_respond` unconditionally. The iOS check emitted 9 dead-code warnings from `bridge.rs` alone. `migration.rs:109-118` probes `dirs::config_dir()/{resume-designer,"Resume Designer"}/Local Storage/leveldb` — on iOS that's inside the sandbox, so the answer is always "no", yet it drags a LevelDB reader + snappy + crc + fs2 into an App Store binary and burns a boot-time IPC round-trip inside the storage-ready gate (`appStorage.js:100-113`). Gate both `#[cfg(desktop)]`.

**Verification softened the bridge finding.** The original said the feature "has no meaning on iOS." One reviewer overturned that: Safari Web Extensions are iOS 15+ and *must* ship inside a containing app; the extension's native handler (`SafariWebExtensionHandler`) runs in the extension's own process via `browser.runtime.sendNativeMessage`, so no listener and no running app are required. And `src/bridgeRoutes.js` is already a pure, transport-agnostic router (`createBridgeRouter(deps) → handleBridgeRequest({method, path, authorization, body})`), whose own header says "Pure so vitest can drive the full HTTP surface without Tauri." **So: gate the socket transport, preserve the router.** Do not fold `bridgeRoutes.js` into `bridge.js` or delete it. The residual iOS-specific redesign, if the feature is ever wanted there, is (a) `GET /resumes/:id/pdf` returning base64 will blow the ~6MB Safari-extension memory ceiling — pre-render into an App Group container instead, and (b) the Chrome plan's `DataTransfer` file-injection trick doesn't work in iOS Safari; the replacement is exposing PDFs through Files so the user picks from the system document picker.

### 3.4 Storage and durability

- **iCloud backup is an unmade decision.** No occurrence of `NSURLIsExcludedFromBackupKey`, `isExcludedFromBackup`, `NSUbiquitous`, or `CloudKit` anywhere in `src/` or `src-tauri/src/`. Path resolves to `<container>/Library/Application Support/com.resumedesigner.app/storage/` (dirs-5.0.1 `mac.rs:7` selects the Apple branch for iOS; `$HOME` is the container root). Everything under `Library/` is backed up unless excluded. For irreplaceable resume data that default is probably *right* — but multi-MB `resume-designer-history-*` keys arguably should carry `isExcludedFromBackup` so they don't bloat every user's iCloud backup.
- **Boot loads the entire store twice.** `storage_load_all` reads every file with `fs::read_to_string` into a `HashMap<String,String>`, serialises to JSON across IPC, and `appStorage.js:476` retains it in a `Map` for the session. That includes 100-snapshot history blobs (`store.js:134` `MAX_HISTORY = 100`; `persistence.js:478-483` notes "100s of KB to multiple MB") and base64 photos. Invisible on desktop, a launch-time jetsam spike on iOS. Cheapest interim: skip `resume-designer-history-*` in `load_all` and fetch on first undo.
- **Durability hooks are desktop lifecycle.** `main.js:405-424` `win.onCloseRequested` → `saveNow()` + `flush()` never fires on iOS. The only remaining barrier is `visibilitychange` (`main.js:427-434`), whose reliability on WKWebView backgrounding is contested, and `flush()` is async with no background-task assertion. Worst case ~750ms of unwritten edits at every suspension — and suspension is the *normal* exit on iOS. Fix: Swift plugin observing `UIApplication.didEnterBackgroundNotification`, wrapping the flush in `beginBackgroundTask(withName:)`. Belt-and-braces: cut `SAVE_DEBOUNCE_MS` (500) and `DRAIN_COALESCE_MS` (250) on mobile. Note the data-protection interaction degrades correctly already — a pre-first-unlock write failure surfaces through `reportWriteFailure` (`appStorage.js:159-167`) and re-queues.
- **Keychain reinstall asymmetry.** iOS keychain items survive app deletion. Delete-and-reinstall returns an app with the API key restored and every resume gone — a state the six-mode machine in `secretStore.js:88-160` was never designed for. Add a first-launch reconciliation. Also: keyring's `ios.rs` does not set `kSecAttrAccessible`, so the accessibility class is whatever security-framework 2 defaults to — **unverified**, and it matters because `secretStore.js` treats a failed read as "keychain unreachable" and holds off deleting a plaintext original. Do not enable `kSecAttrSynchronizable` casually; that syncs the OpenRouter key via iCloud Keychain.

### 3.5 Images and photos

`DesignTab.jsx:810-818` does `reader.readAsDataURL(file)` → straight into `resume-photo-settings` with no resize, no compression, no cap. A 12MP iPhone capture is 3–5MB raw, ~4–7MB base64, re-serialised on every settings tweak and re-parsed on every `getPhotoSettings()`. Add a canvas downscale (~512px long edge, `toDataURL('image/jpeg', 0.85)`) — ~30 lines, and it also fixes the browser build's 5MB localStorage risk. Add `NSPhotoLibraryUsageDescription`/`NSCameraUsageDescription`, or skip both by using `PHPickerViewController` (out-of-process, needs no permission). **Unverified:** whether the iOS picker hands back a transcoded JPEG or raw HEIC for HEIC captures — raw HEIC would not render, and `photoService.js` does no format validation.

### 3.6 Fonts

`fontService.js:174-212` injects `<link href="https://fonts.googleapis.com/css2?...">` at runtime, and all 10 preset pairings plus all 28 popular fonts are CDN fonts. `print.html:11-14` states the print window depends entirely on `initFontService()` + `document.fonts.ready` before emitting `print-ready`. On network failure `document.fonts.ready` resolves anyway, the second paginating render measures **fallback metrics**, and the PDF is captured with the wrong typeface *and* wrong pagination, silently. Mobile devices are offline far more often than desktops. Self-host via `@fontsource/*` (the repo already does exactly this for the UI at `main.jsx:7-12`) — this is the single highest-value fix, it benefits desktop equally, and it deletes two CSP entries and a third-party network call from the privacy story.

### 3.7 CSP and safe area

Production CSP already carries the scheme-form tokens (`asset:`, `ipc:`) iOS uses — the `https://asset.localhost` / `https://ipc.localhost` tokens are dead weight but harmless. The **devCsp** hardcodes `ws://localhost:3000 ws://localhost:3001` and will CSP-block HMR on a physical device, where Tauri binds `TAURI_DEV_HOST` and you connect over an IPv6 address. Override `app.security.devCsp` in `tauri.ios.conf.json` only.

Safe area: `index.html:5` has no `viewport-fit=cover`, and there are **zero** hits for `100dvh`, `visualViewport`, or `env(safe-area-inset` across `src/`, `styles/`, `index.html`. **Verification tightened this considerably** — the fix needs no Swift plugin, because `tauri::webview::PlatformWebview::inner()` is `#[cfg(any(target_os = "macos", target_os = "ios"))]` (tauri-2.11.3 `src/webview/mod.rs:195-199`) and the repo *already* uses `with_webview` + objc2 in `pdf_macos.rs:73`. Ten lines of Rust in `lib.rs` setup:

```rust
#[cfg(target_os = "ios")]
window.with_webview(|wv| unsafe {
    let scroll: Retained<UIScrollView> = msg_send![wv.inner() as *mut AnyObject, scrollView];
    scroll.setContentInsetAdjustmentBehavior(
        UIScrollViewContentInsetAdjustmentBehavior::Never);
})?;
```

Then `viewport-fit=cover` + `env(safe-area-inset-*)` padding. (`tauri-plugin-ios-webview-insets` and `tauri-plugin-safe-area-insets` do the same thing off the shelf.)

**Two audit claims here were overturned:** rubber-band scrolling is *already* disabled — wry 0.55.1 `src/wkwebview/mod.rs:519-531` unconditionally calls `scroll_view.setBounces(false)` on iOS. And `100vh` vs. a "dynamic toolbar" does not apply: an embedded WKWebView has no browser chrome, so `100vh` is stable. The real `100vh` hazard (`main.css:213`, `:220` `calc(100vh - var(--header-height))`) is the **software keyboard**, which shrinks only the visual viewport — so with every ancestor at `overflow: hidden`, the chat composer and structure-panel inputs sit in containers that physically cannot scroll a focused field above the keyboard. Fix with a `visualViewport` resize listener writing a CSS custom property, or `interactive-widget=resizes-content`.

Also overturned: DevTools do not require USB. wry already calls `setInspectable(true)`, and Safari Web Inspector attaches to the **Simulator** over loopback on the same Mac (launch the Simulator before Safari or it won't appear in the Develop menu). The verification loop is far cheaper than the audit assumed.

---

## 4. What must be rewritten, and with what

| What | Why it can't be adapted | Replacement mechanism |
|---|---|---|
| **The hidden `pdf-print-*` window** (`pdf.js:274-288`) | `x:-10000/y:-10000`, `decorations:false`, `skipTaskbar`, `focus:false` are desktop window attributes. tao `ios/window.rs:235-237` no-ops `set_inner_size`; `set_visible(false)` → `setHidden: YES`, which is exactly the non-rendering state the comment at `pdf.js:262-273` exists to avoid. Tauri's in-window escape hatch is closed too: `Window::add_child` is `#[cfg(any(test, all(desktop, feature = "unstable")))]` (tauri-2.11.3 `window/mod.rs:1127`). | A second **WKWebView** (a `UIView`, not a window), created from Rust via `with_webview` → `PlatformWebview::view_controller()`, inserted into the hierarchy at `alpha = 0.01`. See §6. |
| **`pick_pdf_save_path` → `fs::copy`** (`mod.rs:157-164`, `:312`) | `tauri-plugin-dialog-2.7.1/ios/Sources/DialogPlugin.swift:138-176` writes a **zero-byte placeholder** and presents `UIDocumentPickerViewController(url:in:.exportToService)`; the export happens *at picker time*, and the returned URL is a security-scoped file-provider path (tauri#12587: lands in Library/Caches, leaves a 0KB ghost at the chosen location — the copy may *silently succeed* into an invisible cache copy). | Capture-then-share. The app **already** captures first (see §6). Either present `UIActivityViewController` / `UIDocumentPickerViewController(forExporting:asCopy:)` on the existing temp file, or use the pre-seed trick: the Swift only writes the placeholder `if !fileManager.fileExists(atPath: srcPath.path)`, and Tauri's `document_dir()` on iOS resolves to the same `Documents` directory — so staging the real PDF there first makes the unmodified plugin export real bytes. Pin the plugin version if you rely on that. |
| **Blob + `<a download>` export** (`persistence.js:1348-1358` + 3 inline copies) | **Root cause corrected by verification:** WebKit bug 216918 is RESOLVED/CONFIGURATION CHANGED (blob downloads work in Safari). The real cause is wry 0.55.1 `src/wkwebview/navigation.rs`: `if should_download { if has_download_handler { Download } else { Cancel } }`, and Tauri's `download_handler` defaults to `None`. `should_download` is true for *any* anchor with a `download` attribute. | Collapse the 4 sites into `downloadFile()`, add a Rust `export_temp_file(name, contents) -> path` writing into `app_cache_dir()`, then `tauri-plugin-sharekit`'s `shareFile('file://'+path, {mimeType, position})`. **Must pass `position`** or `UIActivityViewController` crashes on iPad. Alternative with zero deps: `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` in Info.plist — worse UX but the *correct* fix for the storage-failure escape hatch at `appStorage.js:162-166`, since a share sheet reachable only from a broken app isn't a recovery path. **⚠️ Verify on macOS first** — the same wry Cancel branch is in the shared `src/wkwebview/` backend, so either desktop export is already broken today or the source reading is incomplete. That answer decides whether this is an iOS finding or a live production bug. |
| **`alert()` / `confirm()`** (`backupFlow.js:248`, `:167`, `:306`, `:330`, `:336`, `:467`; plus 9 sites in `pdf.js`/`variantManager.js`) | **Verified, no longer "unknown":** wry installs `WryWebViewUIDelegate` (`mod.rs:599-602`, un-cfg-gated; iOS declares `setUIDelegate:` at `ios/WKWebView.rs:141`) but `class/wry_web_view_ui_delegate.rs` implements only `runOpenPanelWithParameters` (macOS-gated) and `requestMediaCapturePermissionForOrigin`. Grep for `runJavaScriptAlertPanel|runJavaScriptConfirmPanel` across wry 0.55.1 + tauri 2.11.2 + tauri-runtime-wry: **no matches**. macOS works only because macOS WebKit has default panels; iOS has none. wry's *Android* backend does implement them — the iOS gap is deliberate. | Already in the repo: `confirmDestructive()` (`components/ui/confirm.jsx:13`, a Radix AlertDialog promise, used by 8+ call sites) and `@tauri-apps/plugin-dialog` (already a dep; `dialog:allow-message/ask/confirm` already granted; `native.js:85 showMessage()` already routes it). `backupFlow.js` is the outlier that never migrated — and it *already proved the DOM-modal pattern* in `showImportSuccessAndReload` (`:98-189`), which moved off native `alert()` for a WKWebView/WebView2 race. ~20 lines of call-site swaps. |
| **The iPhone shell** | Three simultaneous panes (320 + 380 = 700px of chrome) around an 816px canvas cannot coexist at 390pt. | See §7. |

**Severity ranking correction on the dialog issue:** the `confirm()` at `backupFlow.js:248` returning false is *fail-safe* — it returns before `saveNow()`, before `suspendSaves()`, before any write. The Import button just looks dead. The dangerous one is `backupFlow.js:167-172`: reached after `appStorage.flush()` failed, with saves still suspended, the restore guard still armed, and deferred writes discarded. That alert is the only signal telling the user the import never reached disk. Invisible on iOS → an apparently-imported app that has silently stopped persisting, losing the import on next launch. Fix that one first.

---

## 5. Hard blockers

### Platform

| Blocker | Confidence | Verification outcome |
|---|---|---|
| Crate does not compile for `aarch64-apple-ios` — `updater:default` unresolvable in the iOS ACL | **Certain** (reproduced twice, independently) | Stands. Fix is one capability `platforms` field. `gen/schemas/iOS-schema.json` vs `desktop-schema.json` is the proof. |
| No runtime multi-window on iOS → hidden print window impossible | **Certain** | Stands as a fact. **Conclusion overturned:** "the safest multi-window config is 'none'" is wrong — on the iOS 27 SDK an app with *no* `UIApplicationSceneManifest` fails to launch (`NoSceneLifecycleAdoption`), same wall Expo hit. tauri#15719 ships its own verified fix: a **static** `UISceneConfigurations` entry with `UISceneDelegateClassName = TaoSceneDelegate` (tao's ObjC class), plus `UIApplicationSupportsMultipleScenes`. Ranking on iOS 27: no manifest → crash; empty `<dict/>` → crash; static config → launches. Also needs the tao autorelease fix from tao#1245 for a separate `EXC_BAD_ACCESS`. |
| `alert`/`confirm` are no-ops | **Certain** (source-verified) | Upgraded from "unknown" to confirmed. Not a blocker — replacements exist in-repo. |
| Blob `<a download>` cancelled | **High** | Cause re-attributed from WebKit to wry. Not a blocker — share sheet / plugin. |
| `dialog.save()` "not implemented on mobile" | **Overturned** | plugins-workspace #1494 **closed 2024-09-11**; #1707 landed the iOS implementation. It *is* implemented — but broken (#1763/#1976/#2089/#2379; fix PR #2548 open and merge-conflicted since 2025-11-24). Don't build on it. |
| `objc2-web-kit` has no iOS `WKWebView` | **Certain** (compile-reproduced) | New finding from verification. `objc2-web-kit-0.3.2/src/generated/WKWebView.rs:107-114` declares the class `#[unsafe(super(NSView, NSResponder, NSObject))]` + `#[cfg(target_os = "macos")]`. Widening the cfg gives `error[E0432]: unresolved import objc2_web_kit::WKWebView`. `WKPDFConfiguration` is *not* gated. Fix in §6. |

### Policy

| Blocker | Confidence | Verification outcome |
|---|---|---|
| **2.5.2 forbids the Tauri updater** | **Certain** | Stands for the native binary. But **both reviewers overturned the framing.** The updater is already `#[cfg(desktop)]`-gated in Cargo.toml and lib.rs including inside `generate_handler!` — so it costs *zero* Rust work, and calling it a "foundational feasibility" blocker is wrong. Losing in-app binary updates is the normal condition of every App Store app. See §9 for the OTA nuance. |
| **5.1.2(i): resume PII → third-party AI with no consent screen** | **High** | The most concrete policy gap in the codebase. Guidelines (Nov 2025 revision): "You must clearly disclose where personal data will be shared with third parties, **including with third-party AI**, and obtain explicit permission before doing so." `aiService.js:642-644` and `:788-790` concatenate `fullName`/`email`/`phone` into the outbound message; `aiService.js:431` lists nine contact fields; there is no consent gate anywhere in `useChat.js` or `aiService.js`. |
| **5.1.1: no privacy policy page exists** | **Certain** | `ls website/` → `CNAME, favicon.svg, hero.jpg, index.html`. One marketing sentence at `index.html:521`. A privacy policy URL is a hard App Store Connect submission gate, and the guideline requires an in-app link too. |
| **PrivacyInfo.xcprivacy missing** | **Certain** | Required-reason API manifest is an *upload-time* gate (since 1 May 2024). Your Swift shell + WKWebView touch `NSPrivacyAccessedAPICategoryUserDefaults` (CA92.1); `storage.rs`'s tmp+fsync+rename touches `FileTimestamp` (3B52.1). |
| **4.2 minimum functionality** | **Medium** | Not fatal in substance — `frontendDist: "../dist"`, no remote site, fully offline, real local document authoring. The risk is entirely that the iPhone build *looks like* a shrunken desktop app. Ship share-sheet export + Files integration before first submission. |
| **Onboarding hard-gates on an OpenRouter key** | **High** | Screen 1 of 6 is "Enter your OpenRouter API key to get started" with a required `sk-or-v1-…` field and one button. App Review cannot reach the app. Also a 2.1 rejection risk independent of 3.1.1. Add a "Skip for now" path — which is the right product decision anyway, since the editor and export work fine without a key. |
| **3.1.1 vs. BYOK** | **Low-medium, unverified** | Nothing is sold today so IAP isn't triggered. BYOK apps ship on the App Store (OwnKey, AssisChat). No authoritative Apple statement found either way; the defence is that the app is fully functional without a key. Supply a funded key in review notes regardless. |
| **CC BY-NC-SA §2(a)(5)(c) anti-TPM vs. App Store DRM** | **Medium, latent** | `LICENSE:243-248` forbids applying "Effective Technological Measures" that restrict recipients. FairPlay + the Licensed Application EULA are exactly that. **Currently harmless**: `git log --format='%an'` shows all 788 human commits are Ash Shah (both handles share GitHub id 35086581); a licensor isn't bound by his own license. But `README.md:129` says contributions are licensed under CC BY-NC-SA — the first merged outside contribution makes you a licensee of that code and closes the door. Add a CLA or a standing App Store exception *before* accepting any PR. |
| **Age rating / AI questionnaire** | **Certain, trivial** | The 2025 overhaul added 13+/16+/18+ and states chatbots/AI assistants "must be evaluated for potential mature or sensitive content." Expect >4+. Costs nothing commercially. |
| **Encryption export compliance** | **Low** | Keychain + HTTPS is textbook exempt. Set `ITSAppUsesNonExemptEncryption = false`. One wrinkle: confirm the iOS build uses `commands/secret.rs`, not `browserSecretStore.js`'s WebCrypto path (it does — `secretStore.js:38,995` gates the browser path on `!IS_TAURI`). |

---

## 6. The PDF export problem

This is the crux, and the verification pass changed the answer substantially — from "xlarge rewrite, critical risk" to "large but bounded, with the hard part already proven."

### What the desktop pipeline actually does

`pdf.js:177-196` flushes to disk (`store.saveNow()` + `appStorage.flush()`), spawns `pdf-print-<timestamp>` at `/print.html` off-screen, waits for `print-ready`. That child runs `printEntry.js` (React-free, `initAppStorage({readOnly: true})`), renders, awaits `document.fonts.ready`, re-renders to re-paginate against true font metrics, then measures `#resume` and every `.resume-page` and emits doc-relative CSS-px rects (`main.js:646-780`). The main window calls `capture_pdf_from_window`, which on macOS runs `WKWebView.createPDF` once per sheet rect (`pdf_macos.rs:97-126`) and merges via `merge_scaled(pages, 72.0/96.0)`.

### What is actually true on iOS

**The capture primitive exists and works.** `createPDF(configuration:completionHandler:)` is iOS 14.0+; `WKPDFConfiguration` is iOS 13.4+. Tauri hands you the pointer: `PlatformWebview::inner()` is `#[cfg(any(macos, ios))]`, `view_controller()` is `#[cfg(target_os = "ios")]`, and `with_webview` is gated only on `feature = "wry"`, not on `desktop`.

**The rect question is settled, not open.** The audit flagged rect-honouring as "must be measured, high risk." Verification read WebKit source and closed it: `WKWebView.mm` `-createPDFWithConfiguration:` builds `std::optional<FloatRect>` and forwards to `_page->drawToPDF(...)` with no `#if PLATFORM(MAC)`; `WebPageCocoa.mm` `WebPage::drawToPDF` does `rect.value_or(FloatRect{{}, frameView->contentsSize()})`; and `WebPage.cpp` `drawMainFrameToPDF` calls `frameView->setLayoutViewportOverrideRect(LayoutRect(snapshotRect))` — that override *is* the "undocumented" mechanism letting a rect address content outside the viewport, and it lives in the cross-platform file with no guard. `pdfSnapshotAtSize` emits `context.beginPage(FloatRect{{}, bitmapSize})` with `bitmapSize` in CSS px, so **MediaBox pt == CSS px 1:1 on iOS**, and `PX_TO_PT = 72/96` stays correct. Both Apple Forum threads cited as evidence against were misread: 700418 (macOS) passes *no configuration at all* (null rect → whole document, as documented), and 734881 (iOS) sets a rect taller than the viewport and gets all 8–10 pages of content back — that is rect being **honoured**, the complaint is only that createPDF doesn't auto-paginate. Which is precisely why the N-call design exists.

**One genuine edge case:** `pdfSnapshotAtSize` caps a page at `72 * 200` = 14400pt and loops, so a single rect taller than 14400 CSS px silently becomes multiple PDF pages. Reachable in continuous / `.is-overflowing` mode. Guard it.

**The binding problem is real and new.** `objc2-web-kit-0.3.2` declares `WKWebView` with an AppKit superclass under `#[cfg(target_os = "macos")]` and ships no UIKit variant. Two proven workarounds, both compile-verified for `aarch64-apple-ios`:

1. **Dynamic dispatch** — `use objc2::runtime::AnyObject; use objc2::msg_send;`, then `let _: () = msg_send![wkwebview, createPDFWithConfiguration: &*configuration, completionHandler: &*handler];`. Reviewer 1 compiled the full lib this way.
2. **Hand-declared iOS binding** — exactly what wry already does: `wry-0.55.1/src/wkwebview/ios/WKWebView.rs:88-93` declares `#[unsafe(super(UIView, UIResponder, NSObject))] pub struct WKWebView;` and line 375-376 *already binds* `createPDFWithConfiguration:completionHandler:`. It's `pub(crate)`, so copy ~40 lines. Reviewer 2 compiled this variant clean.

Either way, `WKPDFConfiguration` needs no treatment (ungated), `NSRect`/`NSPoint`/`NSSize` are cross-platform CG aliases (`objc2-foundation-0.3.2/src/geometry.rs:13-32`), `MainThreadMarker` works, `block2::RcBlock` works, and `pdf_merge.rs` is untouched. Drop the `objc2-app-kit` feature for the iOS target.

### Candidate paths

| Path | Vector? | Verdict |
|---|---|---|
| **A. Native offscreen WKWebView + `createPDF`** (Rust via objc2, or a Swift plugin) | Yes | **RECOMMENDED.** Preserves `print.html`, `printEntry.js`, the measured rects, and `merge_scaled` verbatim. Create the webview with `mainWebView.configuration` (the copy inherits wry's `tauri://` `WKURLSchemeHandler` — `APIPageConfiguration::copyDataFrom` copies `urlSchemeHandlers`), so `/print.html` resolves for free. **Critical, easy to miss:** immediately assign a **fresh `WKUserContentController`**, or the copy shares wry's `ipc` script-message handler bound to the *main* webview's delegate — Tauri would attribute the print page's `invoke()` to label `main` and reply by `evaluateJavaScript` on the wrong webview, hanging every call (the exact 30s-timeout failure the desktop code exists to avoid). Then a `WKScriptMessageHandler` + document-start `WKUserScript` shim, ~60 lines Rust + ~20 JS, servicing a whitelist. Sizing: `frame = CGRect(0, 0, 816–820, totalHeight)` — load-bearing, because `print.html:5` uses `width=device-width`, which in an embedded WKWebView resolves to the *webview's* width, so an 816pt frame gives 816 CSS px. **Attach it** (`insertSubview:atIndex:0` with `alpha = 0.01`, not `isHidden`) — detached/hidden WKWebViews skip layout and JS (WKZombie's `Renderer.swift` uses exactly 0.01; radianttap/HTML2PDFRenderer does the same). |
| **B. In-document capture — print DOM inside the main webview** | Yes | **Viable, cheaper, worse isolation.** `pdf-export-mode` is already a *document-level* CSS class (`public/styles/print.css` says so explicitly: createPDF does not evaluate `@media print`; `main.js:646` `initPrintMode()` is just `classList.add('pdf-export-mode')`). Capture the main window's own WKWebView with rects into a hidden container. Zero new native surface. Cost: `printEntry.js`'s `readOnly: true` isolation collapses into one realm, app stylesheets can leak, and you'd re-establish `withPreviewSuppressed` (`pdf.js:106`) manually. Also needs a viewport-meta swap to `width=816`, reverted in `finally`. |
| **C. Same-origin `<iframe src="/print.html">`** | Yes | **Strong dark-horse.** Gets its own layout viewport equal to its element size, so content lays out at exactly 816 CSS px regardless of a 390pt device — preserving the 1 CSS px → 1 pt mapping without touching the app's viewport meta. Keeps a separate document and JS realm, so `printEntry.js` mostly survives. Needs a `postMessage` bridge (Tauri's IPC init script is main-frame-only) and verification that WebKit composites iframe content into the PDF rect. |
| **D. `UIPrintPageRenderer` + `UIMarkupTextPrintFormatter` → `UIGraphicsPDFRenderer`** | Yes | **Fallback only.** Genuinely native and vector (radianttap/HTML2PDFRenderer ships it; output matches Safari's print). But it does its **own** pagination against `paperRect`/`printableRect`, which fights `pagination.js`'s `.resume-page` sheets and the `.is-overflowing` growth rule (`pagination.js:257-287, 377, 426`). You'd be replacing the pagination model, not the capture step, and forfeiting `pageSetup.js:6-7`'s "same HTML renders both." |
| **E. `webView.viewPrintFormatter()` → `UIPrintPageRenderer`** | Yes | **Awkward.** Re-lays-out the live webview for print rather than capturing the DOM you measured. Widely reported flaky against WKWebView. |
| **F. `UIGraphicsPDFRenderer` + `layer.render(in:)` / `drawHierarchy`** | **No** | **Reject.** Rasterises. Same downgrade as html2pdf. |
| **G. html2pdf.js** (`pdf.js:477-594`) | **No** | **Reject as primary.** `pdf.js:474-475` states it plainly: "IMAGE-based PDFs where text is rendered as pixels." Defeats the ATS premise. Plus html2canvas at `scale: 2` (`:527`) building one full-sheet canvas per page against WebKit's canvas ceiling. Acceptable *only* as a labelled TestFlight escape hatch. |
| **H. PDFKit** | n/a | Not an HTML renderer — cannot produce the PDF. But genuinely useful downstream: native preview rendering instead of pdf.js-into-canvas, which sidesteps the memory problem below entirely. |

### The preview's memory problem

`read_pdf_preview` does `fs::read` → `STANDARD.encode` → returns a `String` over IPC; `pdfPreview.js:33-38` does `atob` → `Uint8Array`. That's ~4–5 simultaneous copies. Then `pdfPreview.js:76-105` renders **every** page at `dpr = devicePixelRatio` (2–3 on iOS) into separate canvases with no virtualization or teardown: at 600 CSS px and dpr 3, one Letter sheet is ~1800×2329 ≈ 16.8MB RGBA; a 5-page resume is ~84MB of canvas, against WebKit's documented canvas ceiling (~224MB historically, ~384MB newer) and iOS jetsam. Fix: serve the temp file over a custom protocol and hand pdf.js a URL, cap `dpr` at 2, virtualize, and null out `canvas.width/height` for off-screen pages (`pdfPreview.js` already threads a `shouldCancel()` callback, so the plumbing exists). Keep the legacy pdf.js build and the `readableStreamAsyncIterator.js` polyfill — both are load-bearing on iOS WebKit.

### Two CSS caveats

`styles/print.css:185-192` already hides `.resume-header::before` / `.resume-sidebar::before` because `color-mix(in srgb, …)` doesn't reliably resolve in createPDF — iOS will be the same or worse. And multiple reports say backgrounds drop out of iOS 16.6+ createPDF output without `-webkit-print-color-adjust: exact !important`; `styles/print.css` has no such rule today. **Unverified** — needs a visual diff against a macOS reference.

---

## 7. The UX problem

### The measurements

At **1024×1366 (iPad portrait)** the built app renders essentially correctly — header, dialog, resume sheet, no overflow. At **375×812** the header overflows, the floating zoom/format toolbar overlaps the document, and `document.getElementById('resume').getBoundingClientRect().width` = **816** in a 375px viewport while `document.documentElement.scrollWidth` = 375 — the sheet is *cropped*, not scrolled. `fitToView()` (`zoomControls.js:99-128`) computes `(390-64)/816 ≈ 0.40`, so a 10pt body becomes ~4pt.

### The structural facts

- `--chat-panel-width: 320px` + `--structure-panel-width: 380px` (`main.css:28-29`) = 700px of chrome. At 1024pt with both open, 324px remains for an 816px sheet. Even landscape iPad needs overlays, not docked panels.
- `.chat-panel` **has** an off-canvas treatment at ≤768px (`chat.css:315-329`). `.structure-panel` has **none** — grep across `styles/*.css` finds rules only in `editor.css:666-774`, `glass.css:99-108`, `print.css:169/176`. At 390pt the panel alone is 340px of a 390px viewport.
- `src/components/ui/sheet.jsx` exists (109 lines, full Radix Dialog sheet with side variants) and is imported by **zero** files. It is a lowered cost, not evidence of an existing mobile pattern — and its `bottom` variant has no `max-h`, no safe-area padding, no grabber.
- Touch targets: `button.jsx:24-27` `default: h-9` (36px), `sm: h-8` (32px), `icon: h-9 w-9`; Header uses `size-8` (32px); `.zoom-btn` is 30×30 with `gap: 2px` in a 12-button strip; `slider.jsx:18` thumb is `h-4 w-4` (16px) on an `h-1.5` track, used by ~9 `ControlSlider`s in DesignTab; `segmented.jsx:41` is `h-[25px]`/`h-[29px]` — and its own comment at `:12-14` calls those "the spec, not magic numbers to be rounded." HIG minimum is 44pt.
- `LibraryDialog.jsx:97` is `h-[82vh] w-[94vw] max-w-[980px]` with a hardcoded `w-[340px]` master column at `:141`. At 390pt: 367px wide, detail pane gets **27px**.
- 115 native `title=""` tooltips across `src/components`, never shown on touch. `ThreadSelector.jsx:62,73` uses `opacity-0 group-hover:opacity-100` on 20px controls — worse than hidden, since they occupy layout and swallow taps at zero opacity. Radix `Tooltip` is the sole carrier of per-application detail in `TimelineView.jsx:39,69-90` — unreachable on touch.

### The critical one: the inline editor

`inlineEditor.js:58-59` registers `mouseover`/`mouseout` on `#resume` as the **only** trigger for `showAIButton()`. `handleClick` (`:741-754`) calls `startEditing()`, which at `:785-787` does `hideAIButton(); hideAIMenu();`. So a tap fires the synthetic mouseover *and* the click in one gesture, and the click handler tears the button down before it can be pressed. The menu it gates (`:167`) is the only UI for **Apply / Reject / Review All of a pending AI change** (`:193-224`) and for adding resume context to chat (`:344-461`). **On iPhone there is no way to accept or reject an AI edit from the document.** On iPad with a Magic Keyboard trackpad, real hover events fire and it works — which makes it easy to miss in testing.

Compounding, in the contentEditable itself (`inlineEditor.js:856-868`): programmatic select-all on focus raises the edit callout and two selection handles over the text being read, and the first keystroke wipes the field; `spellcheck = true` with no `autocorrect`/`autocapitalize` opt-out (grep: zero such attributes anywhere in `src/`) means iOS silently rewrites resume prose and the rewrite is *persisted* (`:975` writes `element.textContent`); there is no Escape key on the software keyboard, so the only abort path (`:1013-1027`) has no touch equivalent while blur (`:979-989`) silently commits; Tab-to-next-field (`:1030`) and Cmd+B (`:997`) need a hardware keyboard.

**Genuinely unverified and the single biggest UX unknown:** whether WKWebView's caret placement, selection-handle dragging, and edit-menu positioning behave correctly inside a CSS `transform: scale()`d contentEditable subtree — `zoomControls.js:87` scales `#resume-container`, which contains every `[data-editable]`. This needs a device spike before the inline editor is estimated at all.

### Honest assessment

**iPad: a port.** At 1024pt+ the three-pane model, the 816px canvas, contentEditable-with-a-keyboard, and dnd-kit reordering all work with adaptation. Convert both drawers to overlays (the vendored `sheet.jsx`), add `viewport-fit=cover` + safe-area padding, fix touch targets, add `TouchSensor` with a 200ms delay, and you have a real product. Caveat: iPadOS 26's Windowed Apps mode plus Stage Manager plus Split View (~507pt) plus Slide Over (~320pt) mean a *continuous* width range, not two or three device widths — so rebuild around container queries and a compact/regular split rather than pixel breakpoints. The app already proves the technique (`main.css:737` `container-type: inline-size`, `:777` `@container (max-width: 565px)`).

**iPhone: a different product.** The shell, the editor, and the canvas each need a different mechanism — three rewrites, not one port. The defensible phone product is: browse/switch resumes, read the page (pinch-zoomable preview, or a native PDFKit/QuickLook render), edit text via the structured form fields, chat with the AI, export/share the PDF. Page setup, spacing/accents tuning, the diff-review UI, and drag-reordering every list are iPad/desktop work. Note the browser pinch-zoom problem too: `index.html:5` has no `maximum-scale`, so WKWebView page-zoom will fight `zoomControls.js`'s `transform: scale()` indistinguishably, and every `position: fixed` affordance (`chat.css:43`, `editor.css:740`, `editor.css:219`, `editor.css:261`) plus the AI button's `getBoundingClientRect()` math (`inlineEditor.js:677-689`) gets stranded.

**Apple Pencil:** nothing in the codebase reads `pointerType`, pressure, or coalesced events. Pencil behaves as a fine-tip finger today — fine for panel controls, arguably the *best* input for tap-to-place-caret. Scribble/annotation would be new PencilKit work.

---

## 8. Data & sync

**Nothing syncs today.** Grepping `src/` and `src-tauri/src/` for `iCloud`, `CloudKit`, `NSUbiquitous` returns zero hits. `app_data_dir()` on iOS lands inside the per-install container (whose parent is a UUID that changes across installs — tauri#12276), so an iOS install starts **empty, always**, and is not reachable from the macOS app.

The only transfer mechanism is a **destructive whole-store replace**: `persistence.js:602-620` builds `{backupFormat: 2, kind: 'full', registry, activeProfile, shared, profiles}`, and `backupFlow.js:248-255` warns "Your current resumes, job descriptions, history, and settings will be REPLACED." `importFullBackupMerge` exists but is reached only from the legacy Electron path (`backupFlow.js:426-428`), and it's a union with "current wins," not a reconciler.

**Is sync table-stakes?** For v1, no — arguably. Resume editing is single-device-at-a-time by nature, and the export/import path works. But the moment the phone is used for quick edits and the Mac for layout, the user hits a data-loss cliff *by design*. My read: sync is not required to ship, but "Transfer to another device" *is* required to ship, and it should not be the same button as "Replace everything."

| Option | Cost | Notes |
|---|---|---|
| **File transfer via share sheet / AirDrop** | ~1 week (the export plugin from §4 covers it) | Cheapest honest answer. Make Replace warn loudly. |
| **CloudKit private database** (CKRecord per storage key, `CKServerChangeToken` deltas) | **4–8 weeks + permanent maintenance tax** — the single biggest line item in the whole port | Developer-ID macOS apps *can* use CloudKit (Apple states so, with a Developer ID provisioning profile) — but iCloud *Documents*/ubiquity containers reportedly still require Mac App Store distribution, so plan CloudKit, not `NSUbiquitousKeyValueStore`. Requires adding a provisioning profile to the currently-plain Developer ID DMG pipeline, a Swift plugin for iOS *and* an objc2/Swift binding for macOS, and per-key conflict resolution for a model with internal cross-references (`persistence.js:400-408` explicitly says the envelope is atomic because `currentVariantId` → variants, history keyed by variantId, chat threads reference variantIds). **Unverified:** whether the ubiquity-container restriction still holds in 2026 — my source was old forum material. |
| **Middle path** | ~2–3 weeks | Sync only `resume-designer-data`, job descriptions, applications. Leave history and photos device-local. Cuts the conflict surface dramatically and sidesteps the memory/size problems. |
| **Third-party (Supabase/Firebase)** | Cheaper to build | Puts résumé content on a server, contradicting `tauri.conf.json`'s own `shortDescription: "A private career workspace"`. Not recommended. |

Also decide: iCloud *device backup* of `storage/` (see §3.4). Device backup is not sync — it restores to the same device/user and gives no desktop↔iOS continuity.

---

## 9. Distribution reality

**Cost:** Apple Developer Program, USD 99/year, individual. Covers unlimited apps, App Store distribution in 175+ storefronts, and TestFlight (100 internal / 10,000 external). Renews annually; apps are removed if it lapses — a real consideration for a one-person project. GitHub-hosted `macos-26` runners are GA (26 Feb 2026) and free. No new paid tooling needed.

**Identifier:** reuse `com.resumedesigner.app`. It is syntactically valid, it's frozen for the right reason (it's the on-disk address of user data), and it doubles as the keychain `SERVICE` (`commands/secret.rs:30`). Register it as an **explicit App ID** — Developer ID signing never required one, so it may not exist yet. Create **one** App Store Connect record and add the iOS platform, keeping macOS on Developer ID: records cannot be merged retroactively, so this preserves the Universal Purchase option. **Do not** create a second `com.resumedesigner.ios` identifier. **Warning about the Mac side:** a Mac App Store build must be sandboxed, which moves data from `~/Library/Application Support/com.resumedesigner.app/` to `~/Library/Containers/com.resumedesigner.app/Data/…` — the exact factory-reset the CLAUDE.md freeze rule exists to prevent, caused by sandboxing rather than renaming. That's a migration project, not a checkbox.

**The updater.** It is already correctly `#[cfg(desktop)]`-gated in `Cargo.toml:69`, `commands/mod.rs:56-57`, and `lib.rs:21-25, 96-99` including inside `generate_handler!`. Zero Rust work. Remove the Updates tab (`SettingsDialog.jsx:69` gates it on `isTauri` — extend to `isTauri && !isMobile`), drop `updater:default` and `process:*` from the iOS capability (`tauriProcess.relaunch()` at `native.js:418` is the *only* caller of the process plugin, confirmed by grep, so it goes with the updater).

**On OTA — the one place the verification votes disagreed, and it matters.** Both reviewers noted that ADPLA §3.3.2 (renumbered §3.3.1(B) in 2025) permits downloading **interpreted** code that "does not change the primary purpose of the Application," and that this is the basis on which CodePush, Expo Updates, Capacitor Live Updates, and `tauri-plugin-ota-updater` (which swaps `context.set_assets(Box::new(OTAAssets{...}))` and minisign-verifies each file) ship on the App Store today. On Paper is ~93% interpreted code by line count, so web-asset OTA is *legally reachable*. **My assessment: technically true, but do not do it in v1.** Three reasons. (a) There is a hard prerequisite nobody has paid: the CSP at `tauri.conf.json:36` pins an inline script hash (`'sha256-GP4MzNSj0LFdsPQ+…'`) compiled into the binary — any OTA'd `index.html` differing by one byte is CSP-blocked and the app shows a blank webview. You'd have to change the Vite build to emit no inline script first. (b) It requires a rollback watchdog (`ota_mark_healthy` within N seconds or revert), a `minNativeVersion` gate (an OTA'd bundle calling a Rust command absent from the installed binary fails at runtime), and a CI rule that any `src-tauri/**` change cannot ship via OTA. (c) The vendor crate is PolyForm-Noncommercial and hard-coupled to CrabNebula Cloud, so you'd self-host — cheap, since GitHub Releases already exists, but it's still net-new infrastructure on the critical path of a first submission. Ship App Store + TestFlight for v1; revisit OTA once the app is actually in the store.

**Beta channel:** `next` → TestFlight **internal** testing (up to 100 App Store Connect users, builds live in minutes, **no** Beta App Review), `main` → App Store. This preserves the branch model exactly. External TestFlight (up to 10,000) triggers Beta App Review on the first build of each version string — 2–7 days in 2026, longer with AI features cited — so batch external betas rather than shipping one per merge. Builds expire after 90 days.

**Versioning — a real, concrete break.** `scripts/ci/compute-version.mjs:154` produces `2.1.0-next.4`, and `release.yml:152` writes it straight into `tauri.conf.json`'s `version`, which maps to `CFBundleShortVersionString`. Apple requires that field to be at most three period-separated non-negative integers — `2.1.0-next.4` is rejected (ITMS-90060). Split it: pass `2.1.0` as `version` and `${{ github.run_number }}` as `bundle.iOS.bundleVersion` (CFBundleVersion must strictly increase per upload). Best done as a third output from `compute-version.mjs`. **Unverified:** whether the Tauri CLI strips prerelease suffixes for iOS — one secondary source claims yes, the official reference only says `version` "maps to CFBundleShortVersionString." Treat as unsafe until tested against a real upload.

**CI:** add a `build-ios` job as another `needs: decide` matrix arm. Pin `runs-on: macos-26` — **do not** use `macos-latest`, which doesn't roll to 26 until mid-June 2026, and Apple requires the iOS 26 SDK for App Store Connect uploads since 28 April 2026. Add `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID` / `APPLE_API_PRIVATE_KEY` to the existing fail-fast secret check at `release.yml:163-190`; `APPLE_TEAM_ID` already exists. Build with `tauri ios build --export-method app-store-connect`, upload via `xcrun altool --upload-app`.

**The `gen/` gitignore will bite silently.** `resume-designer/.gitignore` ignores `src-tauri/gen/` wholesale, and XcodeGen regenerates `gen/apple/*.xcodeproj` from `project.yml` on every `tauri ios init/dev/build`. Any hand-added entitlement, `PrivacyInfo.xcprivacy`, or Info.plist key is destroyed on the next CI run. Decide deliberately: either un-ignore `src-tauri/gen/apple/` and commit it, or drive **every** customization from `tauri.conf.json` (`bundle.iOS.template` for a custom XcodeGen `project.yml`, `bundle.iOS.infoPlist`, `frameworks`) so regeneration is lossless. The second is cleaner for this repo's style. Never hand-edit the pbxproj.

**Upstream naming bug to test early:** tauri#11257 ("productName from tauri.conf.json not working as expected for iOS," open since Oct 2024) describes exactly this configuration — `productName: "On Paper"` vs. Cargo `name = "resume-designer"` — with the IPA named after the package name and `tauri ios dev` failing with "An application bundle was not found." The Cargo name is frozen by project policy, so "just rename it" isn't available. The issue predates 2.11 and may be partly fixed; **test empirically on first `tauri ios init`**, and if it reproduces, force `PRODUCT_NAME` via `bundle.iOS.template`. Set `CFBundleDisplayName = "On Paper"` in `Info.ios.plist` regardless — on iOS that's what the home screen uses.

**Calendar:** Phase 0 (simulator, free) — days. Phase 1 (enroll, App ID, ASC record, iOS CI job, internal TestFlight) — a few days once the app runs. Phase 2 (privacy policy, PrivacyInfo.xcprivacy, App Privacy answers, age rating, screenshots for every required device size, review notes with a funded OpenRouter key, one rejection round) — **weeks, not days.**

---

## 10. Strategy comparison

| | Reuse | Effort | Risk | UX ceiling | App Store viability |
|---|---|---|---|---|---|
| **A. Tauri iOS** | ~36% verbatim + ~74% of Rust + 960/964 tests; ~70% of frontend ships with edits | Large (iPad-first: ~1,500–2,500 new lines) / XL (iPhone parity: ~4,000–7,000) | **Medium** — concentrated in PDF orchestration + Tauri mobile tooling maturity | High on iPad, medium-high on iPhone (WKWebView: no native scroll physics, but the paper metaphor is pixel-identical to desktop) | **Good.** Local-first, offline, real document authoring. Needs share sheet + Files + consent gate. |
| **B. PWA / mobile web** | ~100%, zero native build | Small | **High** | **Low** | **N/A** (not an App Store product) — and it forces the two fallbacks the codebase itself documents as inferior: `appStorage.js:17-21` "webview localStorage has a hard ~5MB per-origin quota… At quota, writes silently fail and user data vanished," and `pdf.js:9` raster PDFs. No `public/`, no manifest, no service worker exists. **Disqualified on the 5MB quota alone.** |
| **C. Capacitor** | Same 36,999 frontend lines; **discards all 2,859 Rust lines** | Large | Medium | Identical to A (same WKWebView) | Good | Rebuilds storage as a Filesystem plugin, secrets as a secure-storage plugin, and the entire PDF pipeline with no `createPDF` binding to inherit. Rational **only** if Tauri's iOS toolchain proves unworkable — which the green `cargo check` argues against. |
| **D. Native SwiftUI + Rust core via UniFFI** | The JSON backup envelope and the resume Markdown format. That's it. | **XLarge** | **High** | **Highest** — the only option buying native scroll, Dynamic Type, and system text editing (which solves the contentEditable problem outright) | Best | **Misreads where the value is.** The Rust is 2,859 lines of pure platform glue; there is no domain core to expose. `renderer.js` (1,282), `parser.js` (241), `diffEngine.js` (568), `changeApply.js` (368), `aiService.js` (1,647) are all JavaScript. UniFFI would share nothing, and you'd maintain a second `changeApply`/`diffEngine` that must stay bit-compatible with desktop — against a codebase whose history records a seven-round bug saga in the experience writers. |
| **E. Reduced-scope companion** (view + light edit + share) | ~8,000 of the 13,326 pure lines — `renderer.js` unchanged (emits HTML strings, so WKWebView renders byte-identically to desktop), plus `parser.js`, `store.js`, `persistence.js`, `variantManager.js`, `profiles.js`, `applications.js`, `librarySearch.js`, `chatThreads.js` | **Medium** | **Low** | High *for what it does* | Good | Drops `DesignTab.jsx` (1,767) + `StructurePanel.jsx` (850) and the full AI chat — the two hardest things at 375pt. It is a different product, not a smaller one. |

---

## 11. Recommendation

**Strategy A, iPad-first, with E held in reserve as the descope target for iPhone.**

The defence is entirely evidential rather than architectural preference. Three things are *measured*, not argued: (1) the web bundle boots Tauri-free with zero console errors, so every degradation path is pre-built and the iOS build is the *better* of the two cases the code already handles; (2) the Rust compiles for `aarch64-apple-ios` — including the vector-PDF engine that makes exports ATS-usable rather than images — after four mechanical changes, and the one non-mechanical piece (the missing iOS `WKWebView` binding) was independently compile-verified two different ways; (3) the app already renders correctly at iPad widths. Options C and D both throw away (2), and D throws away (1) as well. Option B is disqualified by the app's own documentation of its fallbacks.

iPad-first matters because it converts the single largest workstream — a 17,328-line responsive rework — from a prerequisite into a later, optional phase. It is also the configuration where the desktop feature set genuinely transfers (hardware keyboard → contentEditable, Tab, Cmd+B, and real hover events for the AI menu all work).

### Phase 0 — cheapest possible first milestone: **something running on a physical iPad within a day or two**

Cost: $0 if you use a personal-team free provisioning profile (7-day install), or $99 if you enroll now. No App Store involvement. Steps, in order, each producing real information:

1. **One-line unblock, then compile.** Add `"platforms": ["macOS","windows","linux"]` to `capabilities/default.json` and create `capabilities/mobile.json` without `updater:*`. Run `cargo check --target aarch64-apple-ios`. *This is already proven to pass* — you're confirming it in your tree, not discovering it. Land it as a no-op-on-desktop PR with `cargo check --target aarch64-apple-ios` added to CI, so the iOS target becomes a compile-gated invariant before any UI work.
2. **`npx tauri ios init`.** Immediately answers three open questions: whether tauri#11257 (productName ≠ Cargo name) still reproduces on 2.11.2; whether `TARGETED_DEVICE_FAMILY` defaults to iPhone, iPad, or both; and what the generated `project.yml`/entitlements look like before you decide the `gen/` gitignore question.
3. **Add the iOS 27 scene manifest** — the static `UISceneConfigurations` with `UISceneDelegateClassName = TaoSceneDelegate` from tauri#15719, plus `UIApplicationSupportsMultipleScenes`. Without it, the app may not launch at all on the current SDK, regardless of whether you ever open a second window.
4. **`npx tauri ios dev` into the Simulator**, attach **Safari Web Inspector over loopback** (no cable). Ten minutes of console work answers four things the audits could not: does `alert('x'); confirm('y')` do anything (predicted: no); does `platform()` return `'ios'` and what is `navigator.platform`; does `env(safe-area-inset-top)` resolve non-zero after adding `viewport-fit=cover`; does a blob `<a download>` fire.
5. **The one decisive PDF spike.** In the Simulator, load `/print.html` in a WKWebView sized ~816×1056 and run `createPDF` with a rect for sheet 2 only. Check the page count and the MediaBox. The WebKit source reading says this will work and that MediaBox pt == CSS px, but you want the number in your hand before committing to path A vs. C in §6. Do this *before* writing the Swift/objc2 plugin.
6. **The contentEditable spike.** On a physical iPad: tap into a `[data-editable]` inside the `transform: scale()`d container and drag a selection handle. This is the largest genuinely unverified risk in the entire port and it gates the whole editor estimate.

If steps 1–4 go green, you have an On Paper icon on an iPad home screen, launching, rendering the three-pane UI at native size, with storage and keychain working — in a day or two, for $0 or $99. Everything after that is informed by measurement rather than inference.

**Then, in order:** Phase 1 — delete/gate the dead code (updater UI, bridge socket, migration, `tauriDrag`), add the `isDesktop` predicate, self-host the fonts, swap `backupFlow.js`'s `alert`/`confirm` for the existing `confirmDestructive`, ship html2pdf as a *labelled* interim export. Phase 2 — the real PDF path (§6 option A or C) plus the share-sheet export. Phase 3 — iPad polish (drawers→sheets, touch targets, container queries, `TouchSensor`). Phase 4 — the App Store non-code obligations, which take weeks. Phase 5, optional — the iPhone shell, or descope to E.

---

## 12. Open questions for the developer

Ranked by how much the answer changes the plan.

1. **iPhone parity, or iPad-first with an iPhone companion?** This single answer moves the estimate from ~1,500–2,500 new lines to ~4,000–7,000, and decides whether the inline editor is "needs-adaptation" or "needs-rewrite." Everything else in the plan is downstream of it.

2. **Does "accept AI edits on my phone" have to work on day one?** Today it *cannot* — the Apply/Reject menu is hover-only (`inlineEditor.js:58-59`) and the click handler destroys the button before it can be tapped. If yes, the editor interaction model needs a full tap-select-act redesign. If no, `DiffDialog.jsx` becomes the primary review surface on mobile and the phone editor can be structured-form-only.

3. **Is sync in scope, and if so at what fidelity?** No sync = ship faster, users get a destructive whole-store transfer. Full CloudKit = 4–8 weeks plus a permanent maintenance tax and a provisioning-profile change to the macOS pipeline. The middle path (sync `resume-designer-data` + jobs + applications only) is probably the right answer, but it's your call, and it interacts with #4.

4. **Is a Mac App Store version ever intended?** Determines whether to create one Universal Purchase App Store Connect record *now* (records cannot be merged later) and forces a decision about sandboxing relocating `~/Library/Application Support/com.resumedesigner.app/` — the exact data-address move the freeze rule exists to prevent.

5. **Is the App Store build BYOK-only, permanently?** Everything in the 3.1.1 / IAP analysis turns on this, and no monetization document exists anywhere under `docs/` to anchor it. If credits are ever sold, it must go through IAP, and 3.1.3(b) means any existing desktop/web subscription must *also* be purchasable in-app.

6. **Will you ever accept an outside contribution?** The CC BY-NC-SA anti-TPM clause (`LICENSE:243-248`) is harmless only while you are the sole copyright holder. Adding a CLA or a standing App Store exception costs nothing today and is unfixable after the first merged PR.

7. **Should the phone replace the HTML canvas with a native PDFKit/QuickLook preview?** It would sidestep the 816px canvas, the transform-zoom, and the pagination sheets in one move — at the cost of losing tap-to-edit-on-the-page. Changes how much of `pagination.js`'s on-screen half needs to port at all.

8. **Should `storage/` be excluded from iCloud backup?** Default is backed up. For irreplaceable résumé data that is probably correct and gives free device-migration continuity; for multi-MB history keys it probably isn't. The brand positioning ("your information stays yours") likely has an opinion.

9. **Does the multi-profile workspace model belong on a phone at all,** or does iOS present a single profile and treat profile management as desktop-only? Purely a product question — the mechanism (`profileKeys.js:197-217`) ports unchanged either way.

10. **How large is a real store today** — total bytes, largest key, number of history keys? One command against `~/Library/Application Support/com.resumedesigner.app/storage/` answers both the boot-memory finding and the iCloud-backup finding, and it costs thirty seconds.

### Explicitly unverified (do not treat as settled)

- Whether `WKPDFConfiguration.rect` behaves as the WebKit source implies on a real device with a 3-sheet resume (source reading is strong; no device run).
- Whether an `alpha = 0.01` WKWebView in the hierarchy reliably resolves `document.fonts.ready` and returns non-zero `getBoundingClientRect()`.
- Whether Tauri's iOS scheme handler serves `/print.html` (a second Vite entry) at all.
- Whether `-webkit-print-color-adjust: exact` is required for iOS createPDF backgrounds.
- Caret/selection behaviour inside the `transform: scale()`d contentEditable.
- What `kSecAttrAccessible` class security-framework 2 applies via keyring's `ios.rs`.
- Whether keychain calls succeed from a Simulator build without a provisioning profile (errSecMissingEntitlement -34018 is the classic failure).
- What the iOS `<input type="file" accept="image/*">` returns for a HEIC capture.
- Whether the Tauri CLI strips semver prerelease suffixes when writing `CFBundleShortVersionString`.
- Whether desktop blob-download is *already* broken by wry's `navigation_policy` Cancel branch — check on `npm run tauri:dev` before filing the export finding as iOS-specific.
- Whether the iCloud ubiquity-container restriction for Developer-ID macOS apps still holds in 2026.
