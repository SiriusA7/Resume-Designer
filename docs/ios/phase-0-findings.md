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

## BLOCKER: the app renders, but is completely invisible

**Severity: critical for any further Phase 0 spike. Confirmed empirically.**

Every launch shows a pure black screen. It is not a load failure, not a CSP
problem, and not a JS error — the WebKit log shows dozens of successful
`WebURLSchemeTaskProxy::startLoading` / `didComplete` pairs and nothing else.

Root cause, `styles/glass.css:80-86`:

```css
/* --- 1. Clear the window down to the native vibrancy --- */
:root[data-tauri="true"],
:root[data-tauri="true"] body,
:root[data-tauri="true"] .app,
:root[data-tauri="true"] .app-content,
:root[data-tauri="true"] .preview-area {
  background: transparent !important;
}
```

`index.html:20-33` sets `data-tauri="true"` whenever **any** Tauri global is
present, and `native.js:24`'s `isTauri` is true on iOS. So glass.css strips
every background "down to the native vibrancy" — but iOS has no vibrancy layer.
`macOSPrivateApi`, `transparent`, and `windowEffects` are macOS-only and are
silently ignored on iOS. The result is a transparent document over a bare black
`UIView`.

**The spec predicted this file would misbehave but understated it**, calling the
outcome "washed-out, low-contrast." It is total invisibility.

**Fix** (already specced as D1, now proven necessary before anything else can be
observed): gate on *platform*, not on Tauri presence. Either extend the
`index.html` sniff to skip iOS, or gate the glass.css block behind an additional
`:root:not([data-platform="ios"])`.

**Isolation performed:** rebuilt with the throwaway probe module removed
entirely — still black. The probe was not the cause.

## Task 4 — platform behaviour

**Status: BLOCKED by the invisibility defect above.** The on-screen probe
(`src/dev/iosProbe.js`, throwaway) renders its own opaque overlay and still
could not be read, because the first run's `<a download>` tore down the
document and later runs inherited the same blank canvas. These readings need
the glass.css gate fixed first; none of them are hard, and all are one rebuild
away once the app is visible.

| Question | Spec predicted | Observed |
|---|---|---|
| `alert()` elapsed ms | no-op (<5 ms) | not yet read |
| `confirm()` elapsed ms / return | no-op (<5 ms), false | not yet read |
| `platform()` | `"ios"` | not yet read |
| `navigator.platform` | unknown | not yet read |
| `env(safe-area-inset-top)` without `viewport-fit=cover` | `0px` | not yet read |
| `env(safe-area-inset-top)` with `viewport-fit=cover` | non-zero | not yet read |
| `Promise.withResolvers` | present on 17.4+ | not yet read |
| `ReadableStream[Symbol.asyncIterator]` | absent | not yet read |
| `#resume` width vs viewport | 816 px inside ~402 pt, cropped | not yet read |
| App launches on the iOS 27 SDK | yes | **YES — confirmed** |

### Partial result: blob `<a download>` is NOT cancelled on iOS

One reading did land, from the WebKit log of the first probe run:

```
decidePolicyForNavigationAction: frameID=…, isMainFrame=1
NavigationState::decidePolicyForNavigationAction: Client responded with policy 2
… listener called: … policyAction=Download
Adding download 30 to UIProcess DownloadProxyMap
ProcessAssertion::acquireSync 'WebKit DownloadProxy DecideDestination'
FrameLoader::continueLoadAfterNavigationPolicy: can't continue loading frame
DocumentLoader::detachFromFrame / stopLoading
```

`WKNavigationActionPolicy` 2 = **Download**, not Cancel (0). Per wry
`navigation.rs:68-74` that branch is only reachable when
`has_download_handler == true` — which **contradicts the audit's premise** that
Tauri leaves `download_handler` at `None`. `tauri/src/webview/mod.rs:612-635` is
only a doc-comment example, not a default handler, so the mechanism is
**unexplained and still open**.

What is clear: on iOS the click starts a real download that then has no
`WKDownloadDelegate` to choose a destination, and the main frame's
`DocumentLoader` is detached and stopped. This is consistent with — and may
independently explain — why macOS succeeds (macOS WebKit has a default
destination) while iOS produces nothing. It strengthens, rather than changes,
the D5 decision to route exports through a share sheet.

| Question | Spec predicted | Observed |
|---|---|---|
| `alert()` elapsed ms | no-op (<5 ms) | |
| `confirm()` elapsed ms / return | no-op (<5 ms), false | |
| `platform()` | `"ios"` | |
| `navigator.platform` | unknown | |
| `env(safe-area-inset-top)` without `viewport-fit=cover` | `0px` | |
| `env(safe-area-inset-top)` with `viewport-fit=cover` | non-zero | |
| `Promise.withResolvers` | present on 17.4+ | |
| `ReadableStream[Symbol.asyncIterator]` | absent | |
| Blob `<a download>` behaviour | unknown on iOS | |
| `#resume` width vs viewport | 816 px inside ~402 pt, cropped | |
| App launches on the iOS 27 SDK | yes, with the scene manifest | |

## Task 5 — createPDF rect spike

*(pending)*

## Task 6 — contentEditable spike (physical hardware)

*(pending — assigned to the developer)*

**Hardware is available**, which the plan treated as an open question. Paired to
this Mac: **Ash's iPhone** (iPhone 16 Pro, `iPhone17,1`, physical), **Ash's iPad
Pro** (`iPad16,3`), **Ash's iPad Mini** (`iPad14,1`). No new purchase or
enrolment is needed for the on-device spike.
