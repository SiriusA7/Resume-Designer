# iOS Phase 0 — findings

**Date:** 2026-08-09
**Host:** macOS, Xcode 26.6 (17F113), rustc 1.92.0, CocoaPods 1.17.0
**Tauri:** CLI 2.11.2 · tauri 2.11.2 · tauri-utils 2.9.2 · wry 0.55.1 · tao 0.35.3
**Simulator:** iPhone 17, iOS 27.0 (`2BAF4B5E-…`), 402×874 pt
**Signing team:** `847VH25R7U` (HyperBuild, Inc.) — same team as the macOS
Developer ID builds, chosen to keep Universal Purchase available.

## Task 3 — project generation

| Question | Answer |
|---|---|
| Did `tauri ios init` succeed? | **Yes**, cleanly. |
| Does tauri#11257 (productName vs Cargo name) reproduce? | **No.** `productName: "On Paper"` and Cargo `name = "resume-designer"` coexist fine in the generated `project.yml`/pbxproj. The plan's pessimism was unwarranted; no `PRODUCT_NAME` workaround is needed. |
| `TARGETED_DEVICE_FAMILY` | **`"1,2"`** — universal iPhone + iPad by default. Already matches the full-parity decision; no change required. |
| `IPHONEOS_DEPLOYMENT_TARGET` | **`17.4`** in both Debug and Release. The `tauri.ios.conf.json` overlay IS being read. |
| Was `UIApplicationSceneManifest` merged? | **Yes — but not at `init`.** See below. |
| Did anything under `gen/` become tracked? | **No.** `git status --short` empty. The regeneration-safety design holds. |
| iOS icons | `icons/ios/` exists, 18 tracked files, `AppIcon-512@2x.png` is a real 1024×1024. **`hasAlpha: yes`** — an App Store upload gate, deferred to Phase 5. |

### The `Info.ios.plist` merge fires at build, not at init

The Task 3 implementer checked immediately after `tauri ios init`, found no scene
manifest, and concluded *"there is no automatic filename pickup of
`Info.ios.plist`."* **That conclusion was wrong.** The merge happens during
`ios dev` / `ios build`, exactly as the Task 2 reviewer hypothesised.

Verified twice, at both ends of the pipeline:

`src-tauri/gen/apple/resume-designer_iOS/Info.plist` (generated) —

```
"CFBundleDisplayName" => "On Paper"
"ITSAppUsesNonExemptEncryption" => false
"UIApplicationSceneManifest" => {
  "UIApplicationSupportsMultipleScenes" => false
  "UISceneConfigurations" => {
    "UIWindowSceneSessionRoleApplication" => [
      0 => { "UISceneConfigurationName" => "Default Configuration"
             "UISceneDelegateClassName" => "TaoSceneDelegate" } ] } }
```

`Build/Products/debug-iphonesimulator/On Paper.app/Info.plist` (processed,
binary) — same manifest, plus `CFBundleIdentifier => com.resumedesigner.app`,
`MinimumOSVersion => 17.4`, `UIDeviceFamily => [1, 2]`.

**Action: none. Do NOT add `bundle.iOS.infoPlist`** — the auto-detection works.

**Caveat on interpreting a successful launch:** tao wires the scene delegate
*programmatically* at runtime (`tao-0.35.3/src/platform_impl/ios/view.rs:628-646`
returns a `UISceneConfiguration` named `"TaoScene"` and calls
`setDelegateClass`). The static Info.plist entry mainly satisfies the
manifest-*presence* requirement, so a typo in `UISceneDelegateClassName` would
not surface as a launch crash. The string is correct here — diffed against
tao's own `#[name = "TaoSceneDelegate"]` at `scene.rs:52` — but do not treat a
green boot as evidence for it.

## Tooling sharp edges discovered (not in the plan)

These cost real time and belong in `TAURI.md` when Phase 1 lands.

### 1. `tauri ios dev` classifies every simulator as a physical device

```
Detected connected device: iPhone 17 (iPhone18,3) with target "aarch64-apple-ios"
Detected connected device: iPad Pro 13-inch (M5) (iPad17,4) with target "aarch64-apple-ios"
```

Neither is a real device — the only physical iPhone paired to this Mac is an
iPhone 16 Pro (`iPhone17,1`). Tauri 2.11.2 assigns the **device** Rust target
(`aarch64-apple-ios`), builds with `-sdk iphoneos`, and rewrites `devUrl` to the
LAN address, then tries to install that device binary onto a simulator:

> The executable has code for these platforms and architectures: `[iOS, arm64]`.
> This device can run code for these platforms: `iOS-simulator`.

It is systematic, not a name-ambiguity artifact — it reproduced with an
unambiguous iPad simulator name. Both slices are built and present on disk
(`target/aarch64-apple-ios{,-sim}/debug/libon_paper_lib.a`); the wrong one is
selected.

### 2. `xcodebuild` cannot be driven standalone for a Tauri dev build

The Xcode "Build Rust Code" phase shells out to `tauri ios xcode-script`, which
opens a **WebSocket back to a running `tauri ios dev` supervisor** to read its
options. Without that parent process it panics:

```
failed to read CLI options: Context("failed to build WebSocket client",
  Io(Os { code: 61, kind: ConnectionRefused }))
  at crates/tauri-cli/src/mobile/mod.rs:403
```

So "just run xcodebuild with `-sdk iphonesimulator`" is not available as a
workaround for finding 1.

### 3. The way through: `tauri ios build --debug --target aarch64-sim`

`tauri ios build` accepts `--target [aarch64 | aarch64-sim | x86_64]` and acts
as its own supervisor. It produces a self-contained bundle (assets from
`frontendDist`, no dev server), which is also a *better* probe host than
`ios dev` — it exercises the real `tauri://` custom-scheme asset pipeline, which
is what the Task 5 PDF spike depends on.

### 4. Signing is required even for a simulator run

`tauri ios dev` performs an xcodebuild **archive**, which demands a development
team regardless of simulator vs device:

> `error: Signing for "resume-designer_iOS" requires a development team.`

Supplied via `APPLE_DEVELOPMENT_TEAM=847VH25R7U` in the environment, keeping the
team ID out of git as Task 2's config intended.

### 5. CocoaPods must be installed and needs UTF-8

`brew install cocoapods` (1.17.0). It warns that it requires a UTF-8 locale;
prefix invocations with `LANG=en_US.UTF-8`.

## MILESTONE: On Paper launches on iOS

**On Paper builds, installs, and runs on an iOS 27.0 simulator.** The working
route is *not* the one the plan assumed:

```bash
npx tauri ios build --debug --target aarch64-sim     # NOT `tauri ios dev`
xcrun simctl install <udid> src-tauri/gen/apple/build/arm64-sim/On\ Paper.app
xcrun simctl launch  <udid> com.resumedesigner.app
```

Binary verified `platform IOSSIMULATOR, minos 17.4, arm64`. It launches on the
iOS 27 SDK with no scene-lifecycle crash, and every asset loads through the
`tauri://` custom-scheme handler with **zero CSP violations and zero errors**.

## RESOLVED: the blank screen — three-part failure, now fixed

**On Paper renders correctly on iOS 27.** Onboarding, typography, palette, all
of it. Getting there required fixing three separate things, and the first two
diagnoses I published were wrong — recorded here because the wrong turns are
themselves the finding.

### What it was NOT

- **Not `glass.css`.** Gating `data-tauri` on platform (commit `66fa6a9`) is a
  correct, independently-required D1 fix and it is kept — but the screen stayed
  black afterwards. The probe later proved `data-tauri` was `null` and
  `body` background was an opaque `rgb(232,228,223)` the whole time.
- **Not the blob `<a download>`** tearing down the document.
- **Not CSP, not asset loading, not a JS error.** Storage proved the app was
  fully alive: it created a profile, ran the migration probe, and fetched an
  81 KB model catalog from OpenRouter over the network.

### What it was

Read out through the app's own storage layer (probe writes a key; the file is
read from the simulator container — no Safari Web Inspector needed):

```
innerSize [0,0]   outerSize [0,0]   docScroll [0,0]   centerElement null
screen [402,874]  rootHtmlLength 29343  bodyHtmlLength 29767
bodyStyle.background rgb(232,228,223)   resumeRect 816x1056
```

**The app was rendering perfectly into a 0×0 viewport.** Nothing was hidden;
there was nothing to paint into. That also explains why a probe overlay with
`position:fixed; inset:0` never appeared — it resolves against the viewport, so
a 0×0 viewport yields a 0×0 overlay.

Rust-side instrumentation (written to `<container>/Documents/ios-dbg.txt`) found
three stacked causes:

| # | Cause | Evidence |
|---|---|---|
| 1 | **WKWebView frame is 0×0.** wry's iOS branch does `initWithFrame: ns_view.frame()` (`wkwebview/mod.rs:447-451`) — the parent's frame *at creation time* — and sets **no autoresizing mask**. Every `setAutoresizingMask` in wry (`:504/507/521/677`) is macOS-only; the iOS path is a bare `addSubview` at `:705`. | `frame_before=0x0` |
| 2 | **The parent view is also 0×0**, while the grandparent is correct. Sizing only the webview leaves it inside a zero-sized ancestor. | `superview_bounds=0x0`, `superview2_bounds=402x874` |
| 3 | **The `UIWindow` has no `windowScene`,** so it is orphaned on iOS 13+: it can be sized, unhidden and fully populated and will still never composite. `makeKeyAndVisible()` was a silent no-op. | `window hidden=false key=false`; after attaching a scene, `key=true` |

**We trigger this ourselves.** Task 2's `UIApplicationSceneManifest` is
*required* (without it the app will not launch on the iOS 27 SDK), and it is the
same change that moves tao onto the scene lifecycle where the window is never
attached. tao's own `set_focus()` reads `window.windowScene()` and branches on
it, so tao knows the association matters — but under a *static* scene manifest
nothing ever assigns it.

### The workaround (spike-quality; needs a proper home in Phase 1)

From Rust via `with_webview`, on a retry loop **after** the event loop starts
(doing it inside `setup()` is too early — attempt 1 failed exactly that way):

1. size the superview to the grandparent/screen bounds + `autoresizingMask`
2. size the webview to match + `autoresizingMask`
3. if `windowScene` is nil, find the connected `UIWindowScene` and attach it
4. `setHidden:false` + `makeKeyAndVisible`

This belongs upstream (tao/wry) rather than in app code. File it; carry the
workaround until it lands.

## Task 4 — platform behaviour — ANSWERED

Measured on the running app (iPhone 17, iOS 27.0, 402×874 pt).

| Question | Spec predicted | **Observed** |
|---|---|---|
| App launches on the iOS 27 SDK | yes | **YES** |
| `platform()` | `"ios"` | **`"ios"`**, `version()` = `27.0.0` |
| `navigator.platform` | unknown | **`"iPhone"`** |
| User agent | unknown | `…(iPhone; CPU iPhone OS 18_7 like Mac OS X)… Mobile/15E148` — note the **frozen `18_7`** even on iOS 27 |
| `Promise.withResolvers` | present ≥17.4 | **present** — the 17.4 floor is correct |
| `ReadableStream[Symbol.asyncIterator]` | **absent** | **PRESENT — spec is WRONG** |
| `env(safe-area-inset-*)` | 0 without `viewport-fit=cover` | **0 both before and after** adding it — needs re-measuring now the viewport is non-zero |
| `visualViewport` | — | **present** |
| Task 3.5 platform gate | — | **works** — `data-tauri` is `null` on iOS |
| `document.documentElement.className` | — | **`"desktop electron"`** — spec D1's unconditional desktop classes, **confirmed** |
| Google Fonts at runtime | CDN fetch | **confirmed** — `css2?family=Cormorant…` and `DM+Sans` in `document.styleSheets` |
| `#resume` vs viewport | 816 px cropped | **confirmed** — `resumeRect` 816×1056 at `x=-207` in a 402 pt viewport |
| Onboarding hard-gate | 2.1 rejection risk | **confirmed visually** — Step 1 of 6 demands an `sk-or-v1-…` key before anything else |

### `alert()` / `confirm()` — the spec is wrong, and the severity is INVERTED

The spec (from the audit's source reading of wry's `WryWebViewUIDelegate`)
stated these are **silent no-ops**, and reasoned that `backupFlow.js:248`'s
destructive-import `confirm()` therefore **fails safe** by returning `false`.

Observed on device:

- **`alert()` DOES present a native iOS panel.** Screenshotted: a real
  "On Paper / probe / Ok" dialog over the onboarding screen.
- **But it does NOT block JavaScript** — measured `alertMs = 0`, and execution
  continued straight past it.
- **`confirm()` also returned in 0 ms**, and returned a **non-boolean object**
  (serialised as `{}`), not `false`.

Both halves matter. A panel that appears while JS keeps running is a *race*, not
a no-op: any code that assumes `alert()` blocks is wrong. And if `confirm()`
yields a truthy object rather than `false`, then

```js
if (confirm('…will be REPLACED…')) { /* destructive path */ }
```

**proceeds**. The spec assessed this as fail-safe; the observation suggests
fail-**dangerous**.

⚠️ **This specific behaviour needs a dedicated, isolated test before it is
acted on** — the reading comes from one probe run that measured several things
at once. But it is now the highest-priority unknown in the port, because it
governs a destructive whole-store replace. Do not rely on the spec's
"fails safe" claim.

## Task 5 — createPDF rect spike

*(pending)*

## Task 6 — contentEditable spike (physical hardware)

*(pending — assigned to the developer)*

**Hardware is available**, which the plan treated as an open question. Paired to
this Mac: **Ash's iPhone** (iPhone 16 Pro, `iPhone17,1`, physical), **Ash's iPad
Pro** (`iPad16,3`), **Ash's iPad Mini** (`iPad14,1`). No new purchase or
enrolment is needed for the on-device spike.
