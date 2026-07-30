# Tauri Desktop App Guide

This document covers building, distributing, and updating the on paper desktop app, which is built with [Tauri 2](https://v2.tauri.app/).

## Quick Start

```bash
# Browser-only development (no Tauri shell)
npm run dev

# Tauri development — opens the desktop window with hot reload
npm run tauri:dev

# Production build (current platform, current arch)
npm run tauri:build

# Production build for a specific target
npm run tauri:build:mac:arm64
npm run tauri:build:mac:x64
npm run tauri:build:win
```

First Tauri build takes 3-5 minutes (Rust compilation). Subsequent builds are cached and quick.

## Prerequisites

1. **Rust toolchain** — install via [rustup](https://rustup.rs/).
2. **Node.js 20+**.
3. **macOS dev**: Xcode Command Line Tools (`xcode-select --install`).
4. **Windows dev**: Visual Studio C++ Build Tools and the Windows SDK.

> **Lockfile note:** regenerate `resume-designer/package-lock.json` with **npm 10** (the npm that ships with Node 20), **not npm 11**. npm 11 records esbuild's optional platform packages without the `optional` flag, which makes CI's `npm ci` fail with `EBADPLATFORM`. If your local Node is newer, run `npx npm@10 install` from `resume-designer/`. CI pins Node 20 / npm 10.

## App Icons

The repo currently ships without custom icons (default Tauri placeholders are used). To add custom icons:

1. Create a 1024×1024 PNG named `icon.png`.
2. Run `npx tauri icon path/to/icon.png` from `resume-designer/` — generates all required sizes into `src-tauri/icons/`.

## File Structure

```
resume-designer/
├── src-tauri/
│   ├── Cargo.toml             # Rust dependencies
│   ├── tauri.conf.json        # Window, security/CSP, bundle, updater
│   ├── Entitlements.plist     # macOS entitlements
│   ├── build.rs               # tauri-build runner
│   ├── capabilities/
│   │   └── default.json       # Renderer permissions for Tauri plugins
│   ├── icons/                 # App icons (generate via `tauri icon`)
│   └── src/
│       ├── main.rs
│       ├── lib.rs             # Builder, plugins, RunEvent::Reopen
│       └── commands/
│           ├── mod.rs         # PdfResult / print_to_pdf dispatcher
│           ├── pdf_macos.rs   # WKWebView createPDF
│           └── pdf_windows.rs # WebView2 PrintToPdfAsync
├── src/                       # Renderer (React + shadcn chrome, vanilla resume render, Vite)
├── index.html
├── package.json
└── vite.config.js
```

## Building for Distribution

CI is the recommended path for release builds — see "Release workflow" below. For local releases:

```bash
# Build mac for current architecture (signed if env vars are set, else unsigned)
npm run tauri:build

# Cross-build mac arm64 from Intel mac, or vice versa
rustup target add aarch64-apple-darwin
npm run tauri:build:mac:arm64
```

Outputs live under `src-tauri/target/<arch>/release/bundle/`:

- **macOS**: `bundle/dmg/on paper_<version>_<arch>.dmg`, `bundle/macos/on paper.app`, plus an `.app.tar.gz` + `.app.tar.gz.sig` pair (the updater bundle and its minisign signature).
- **Windows**: `bundle/nsis/on paper_<version>_x64-setup.exe`, plus `.exe.sig` for the updater. (With `createUpdaterArtifacts: true` Tauri 2 produces the **v2** updater format on Windows: the `-setup.exe` *is* the updater payload and `.exe.sig` is its detached signature. No `.nsis.zip` is emitted — see the "Normalize Windows artifact filenames" step in `release.yml`.)

> These are **local build** names, which use `productName` verbatim and so
> contain a space. The names attached to a GitHub Release are different: the
> two "Normalize … artifact filenames" steps in `release.yml` replace spaces
> with hyphens first, because GitHub rewrites spaces in asset names to `.` and
> that would break `latest.json`'s URL field. The README's download table
> therefore lists the hyphenated forms (`on-paper_<version>_aarch64.dmg`).

## Code Signing & Notarization (macOS)

Required for distributing outside the Mac App Store. Without proper notarization, the auto-updater will reject downloaded updates.

### One-time setup

1. **Get a Developer ID Application certificate** from your Apple Developer account (https://developer.apple.com/account/resources/certificates/list).
2. **Export it as `.p12`** from Keychain Access (right-click → Export).
3. **Convert `.p12` to base64** for GitHub secret:
   ```bash
   base64 -i /absolute/path/to/DeveloperIDApplication.p12 | tr -d '\n' > /tmp/csc_link_base64.txt
   ```
4. **Generate an app-specific password** at https://appleid.apple.com/account/manage (Sign-in and Security → App-Specific Passwords).
5. **Look up your Team ID** on the Apple Developer Membership page (10-character code, e.g. `AB12C34DEF`).
6. **Find your signing identity string**:
   ```bash
   security find-identity -v -p codesigning
   # Look for: "Developer ID Application: Your Name (TEAMID12)"
   ```

### GitHub repo secrets (required for CI)

Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded `.p12` contents |
| `CSC_KEY_PASSWORD` | Password set when exporting the `.p12` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from above |
| `APPLE_TEAM_ID` | 10-character Team ID |
| `APPLE_SIGNING_IDENTITY` | Full identity string (e.g. `Developer ID Application: Your Name (AB12C34DEF)`) |

The CI workflow validates that all of these are present before starting the macOS build and fails fast if any are missing.

## Auto-Update Setup

### Generate the minisign keypair (one-time)

> [!CAUTION]
> **ALREADY DONE. NEVER REGENERATE THIS KEYPAIR.** The key exists, its public
> half is baked into `tauri.conf.json` (`plugins.updater.pubkey`), and its
> private half lives in the `TAURI_SIGNING_PRIVATE_KEY` GitHub secret. This
> section is **historical** — it documents how the existing key was made.
>
> Regenerating it and updating both the config and the secret is *internally
> consistent*: the build succeeds and CI goes green. But every already-installed
> app carries the **old** pubkey and will reject every future update with a
> signature-verification failure — silently, with no in-app signal and no
> auto-recovery. The only fix is for 100% of users to manually download and
> reinstall.
>
> The filename below contains the old product slug. **Leave it alone.** The
> GitHub secret stores the key's *contents*, not its path, so renaming the local
> file buys nothing and only invites someone to re-run the command.

Tauri's updater signs every release artifact with a minisign key and verifies the signature against the public key baked into the app.

```bash
# HISTORICAL — do not run. See the caution above.
cd resume-designer
npx tauri signer generate -w ~/.tauri/resume-designer.key
# Set and remember a password when prompted.
```

Two files are produced:

- `~/.tauri/resume-designer.key` — **private** key (never commit; never share).
- `~/.tauri/resume-designer.key.pub` — public key.

### Wire the keys

1. **Paste the public key contents** into [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) under `plugins.updater.pubkey`, replacing `REPLACE_ME_AFTER_RUNNING_TAURI_SIGNER_GENERATE`.
2. **Add two GitHub secrets** (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY`: the **contents** (not the path) of `~/.tauri/resume-designer.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password you set above.

The Tauri CLI reads these env vars during `tauri build` to produce signed updater bundles.

### How auto-update works

- App startup runs `startupUpdateCheck()` (see [src/native.js](src/native.js)).
- The check goes through the Rust `check_update_on_channel` command, which builds the updater for the user's chosen channel and fetches that channel's `latest.json` (stable → `…/releases/latest/download/latest.json`; beta → `…/releases/download/next/latest.json`).
- If `version` exceeds the installed version, the user is prompted to download.
- The download runs through `install_pending_update`, which streams progress to the renderer over an IPC `Channel` and verifies the minisign signature; then the user is prompted to restart.
- A 10-second watchdog timer surfaces a clear error if the restart-into-installer step fails (e.g. malformed signature).

The `latest.json` manifest is assembled by CI from the per-platform `.sig` files and uploaded to the release.

### Where the endpoint actually lives (read before changing it)

> [!IMPORTANT]
> **`plugins.updater.endpoints` in `tauri.conf.json` is inert at runtime.** The
> endpoints installed apps actually use are the Rust constants
> `STABLE_ENDPOINT` / `BETA_ENDPOINT` in
> [src-tauri/src/commands/updater.rs](src-tauri/src/commands/updater.rs).

This trips people up because the config value is the greppable one. The chain:

- `check()` from the JS `plugin-updater` cannot override the endpoint, so
  `src/native.js` routes every check through the Rust `check_update_on_channel`
  command instead.
- That command builds its own updater from `endpoints_for(channel)`, which
  returns the Rust constants. The config value is never consulted.
- Meanwhile `release.yml` **rewrites** the config endpoint for beta builds,
  deriving it from `github.repository`. So the config value self-corrects on a
  repo rename while the Rust constants stay frozen.

The failure mode: someone renames the repo, greps `tauri.conf.json`, updates it,
watches the beta build go green, and ships — having changed nothing about where
installed apps look. `test/updaterEndpoints.test.js` asserts the two stay in
sync so this can't happen silently.

### Preparing for a repo rename

Both endpoints hardcode `ashproto/Resume-Designer`. If the repo is ever renamed,
every already-installed build reaches the new location **only** via GitHub's 301
redirect — and that redirect is destroyed permanently the instant anything is
created at the old path again. It is an unmonitored single point of failure on
the entire installed base's update path.

The durable fix is to stop pointing at GitHub at all: serve `latest.json` from a
domain we control (`onpaper.pro`) and let it redirect or proxy to whatever the
release location happens to be. Because the endpoint is baked into every shipped
binary, **this has to ship to users before the rename, not with it.** Sequence:

1. Publish `latest.json` (and the beta manifest) to the owned domain from CI.
2. Ship a release whose Rust constants point at the owned domain. Wait for
   adoption.
3. Only then rename the repo — installed apps never notice, because the URL they
   were compiled with never changed.

Until step 2 has shipped and been adopted, treat the repo name as load-bearing.

### Switching update channels (in-app)

The desktop **Tools** menu has an **Update channel: Stable / Beta** toggle next to *Check for Updates*. It persists to the `resume-designer-update-channel` localStorage key (an owned key, so it rides along in backup/restore) and defaults to **Stable**.

- The JS `plugin-updater` `check()` cannot override the endpoint, so channel selection happens Rust-side in `check_update_on_channel(channel)`. Both channels are signed with the same key, so they verify against the same `pubkey`.
- Flipping to **Beta** makes the *next* update check pull the rolling `next` pre-release; flipping back to **Stable** returns to released versions — no reinstall needed.

## Release Workflow

[.github/workflows/release.yml](../.github/workflows/release.yml) builds and publishes on every push to **`next`** (beta channel) and **`main`** (stable channel). There is no release-please / Release-PR step — the version is computed directly from git tags + Conventional Commits.

**Branch model**

- Feature PRs target **`next`**. Merging one builds a **beta** and publishes it to the rolling `next` pre-release (a GitHub Release tagged `next`, marked *prerelease*). Beta builds point their updater at `…/releases/download/next/latest.json`.
- Cut a **stable** release by promoting `next → main` (a PR; the `guard-main-source` check enforces that only `next` — or a `skip-build`-labeled infra PR — merges into `main`). Merging it builds a versioned `vX.Y.Z` release (`make_latest`, GitHub-generated notes), served by `…/releases/latest/download/latest.json`. GitHub excludes prereleases from `/releases/latest`, so stable users never see betas.

**The `decide` job** runs first and sets the channel + version, then gates `build-macos` (matrix `aarch64`/`x86_64`, signed + notarized), `build-windows` (unsigned NSIS + updater bundle), and `release` (assembles `latest.json`, attaches installers).

**Version** is computed by [`scripts/ci/compute-version.mjs`](scripts/ci/compute-version.mjs) from the latest `v*` tag + Conventional Commits since it:

- `major` for a `!` marker or `BREAKING CHANGE`; `minor` for `feat:`; otherwise `patch`.
- Beta builds append `-next.<run-number>` (e.g. `1.10.0-next.4`) — valid semver, always lower than the matching stable.

**Controls**

- **Skip a build on merge:** add the **`skip-build`** label to the PR before merging — the `decide` job sees it and publishes nothing (the run still goes green).
- **Force a version / manual build:** run the workflow via **`workflow_dispatch`** from the desired branch, optionally passing a `version` input override.

> A freshly published release is briefly asset-less — the signed installers and `latest.json` attach ~10-15 minutes later once the build jobs finish — so an in-app update check during that window degrades gracefully.

### Windows code signing

Currently **not** signed. Users will see a Microsoft Defender SmartScreen warning the first time they run the installer. To add Authenticode signing later, set the `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` GitHub secrets — `tauri-action` will pick them up automatically.

### Windows upgrade identity (why the rename needs a reinstall there)

Windows install identity is keyed on **`productName` + `bundle.publisher`**, not
on the bundle identifier. The NSIS template derives all of these from them:

```
UNINSTKEY      = …\Uninstall\${PRODUCTNAME}
MANUPRODUCTKEY = Software\${MANUFACTURER}\${PRODUCTNAME}
INSTDIR        = $LOCALAPPDATA\${PRODUCTNAME}
shortcuts      = ${PRODUCTNAME}.lnk
```

So renaming `productName` from "Resume Designer" to "on paper" makes the new
installer invisible to the old install. **User data is unaffected** — that
follows the bundle identifier, which is frozen — but the old Add/Remove Programs
entry, install directory, and shortcuts all persist alongside the new ones, and
the existing shortcuts keep launching the old binary. In the worst reading, an
update-mode install skips shortcut creation entirely, so the user sees the new
build once and every later launch runs the old one, which prompts to update
again — a loop the user never escapes.

**Decision: ship the rename as a manual reinstall on Windows.** No NSIS
migration hook. Two reasons:

1. There is effectively no Windows installed base to migrate. Across the app's
   entire release history the Windows installer has ~15 total downloads, never
   more than one per release — the signature of smoke-testing each build, not of
   users. (The app has no telemetry, so download counts are the only signal;
   treat this as evidence, not proof.)
2. An installer hook cannot be tested from this repo's CI or from a Mac. PR CI
   builds macOS only, and the `x86_64-pc-windows-msvc` target does not build on
   the maintainer's machine (`ring`'s C code fails; the mingw target only
   type-checks Rust). Shipping an untested `.nsh` that runs an uninstaller on a
   user's machine is a worse risk than the duplicate entry it removes.

Do **not** change `bundle.publisher` while this stands. It is `${MANUFACTURER}`
and the only registry anchor a future hook could search on.

**If the Windows base ever becomes real**, the fix is a
`bundle.windows.nsis.installerHooks` `.nsh` implementing `NSIS_HOOK_PREINSTALL`
that reads `HKCU\Software\Ash Shah\Resume Designer` and the old
`UninstallString`, runs the old uninstaller silently *without* `/UPDATE` (so its
shortcuts go but app-data deletion is not triggered), **and explicitly creates
the new shortcuts itself** — the hook cannot make Tauri's
`CreateOrUpdate*Shortcut` functions run. Validate it on a real Windows box by
installing the pre-rename build first, then updating.

### Testing updates end-to-end

1. Install a signed Tauri build from a previous GitHub Release (or trigger one via `workflow_dispatch`).
2. Merge a PR into `next` (beta) or promote `next → main` (stable) — or run `workflow_dispatch` — to publish a newer build.
3. After the workflow finishes, reopen the older app. On startup it should:
   - Toast "Version X.Y.Z is available".
   - Prompt "Download?" → after click, show download progress in the toast.
   - Prompt "Restart Now?" → after click, relaunch into the new version.
   - Confirm via DevTools: `(await import('./native.js')).getAppInfo()`.

## System requirements

- **macOS 14.4 (Sonoma) or later.** `bundle.macOS.minimumSystemVersion` is set to `14.4` in `tauri.conf.json`, so older versions cannot install the app. The floor is driven by pdf.js: the in-app PDF preview and PDF/DOCX import use pdf.js 5, whose modern build relies on `Promise.withResolvers` — shipped in the WebKit bundled with macOS 14.4 (Safari 17.4); older WKWebViews would fail those features at runtime. (PDF export itself uses `WKWebView.createPDF(configuration:completionHandler:)`, available since macOS 11.)
- **Windows 10 1809 or later** (WebView2 runtime required; Windows 11 ships it preinstalled).

## Data storage

Desktop builds persist all app data as **one file per key** under
`<app_data_dir>/storage/` (macOS:
`~/Library/Application Support/com.resumedesigner.app/storage/`). File name =
storage key (e.g. `resume-designer-data`), content = the raw string value.
Writes are atomic (temp file + fsync + rename) via the Rust `storage_*`
commands in `src-tauri/src/commands/storage.rs`; the JS side goes through
`src/appStorage.js`, which serves reads from an in-memory cache and
write-behinds changes, flushing on window close, before PDF capture, before
backup-import reloads, and before the updater's relaunch.

On the first launch after upgrading, any existing webview-localStorage data
(`resume-*` keys) is adopted onto disk once and removed from localStorage.
Browser builds keep using localStorage (the facade passes through), which is
why the old ~5MB-quota guards in `persistence.js` still exist.

Known limitation: macOS **Cmd+Q** terminates through the default menu's
`terminate:` selector, which bypasses the window's close-requested hook — an
edit made within the store's 500 ms save debounce of a Cmd+Q can lose that
last keystroke (the previous on-disk value survives; files can never be torn).
Closing the window with the red button always flushes completely.

## Content Security Policy

The desktop CSP lives in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) under
`app.security.csp`. `script-src` is locked to `'self'` plus the **SHA-256 hash** of the single
inline `<script>` in `index.html` (the liquid-glass bootstrap) — it deliberately does **not** use
`'unsafe-inline'`, so an injected inline `<script>` or event-handler attribute cannot execute.

⚠️ If you edit that inline bootstrap script in `index.html`, recompute its hash and replace the
`'sha256-…'` token in `script-src`, otherwise the desktop build will refuse to run the script (the
window loses its translucent background). Regenerate the hash with:

```bash
node -e "const fs=require('fs'),c=require('crypto');const s=fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];console.log('sha256-'+c.createHash('sha256').update(s).digest('base64'))"
```

`style-src` intentionally keeps `'unsafe-inline'` (dynamic theming + Google Fonts); inline styles
are far lower risk than inline scripts. Note this CSP applies only to the **desktop** webview —
Tauri injects it; the plain browser build (`npm run dev` / `npm run build`) is not covered.

## Troubleshooting

**"App is damaged" on macOS** — the app wasn't signed/notarized. Check that all six macOS secrets are set in the GitHub repo, and inspect the `build-macos` job logs for `codesign`/`notarytool` errors.

**Updater says "signature verification failed"** — usually means the `pubkey` in `tauri.conf.json` doesn't match the private key that signed the `.sig` files in the release. Regenerate the keypair or correct the secret.

**`tauri dev` opens a window but the frontend never appears** — check that Vite is running on port 3000 (the configured `devUrl`). The Vite config uses `strictPort: true`, so a port conflict will fail loudly.

**CSP violation when calling OpenRouter** — the CSP `connect-src` in `tauri.conf.json` must include `https://openrouter.ai`. Test by running `fetch('https://openrouter.ai/api/v1/key')` in DevTools and watching for `Refused to connect` errors.

**`xcrun: error: invalid active developer path`** — install Xcode Command Line Tools: `xcode-select --install`.

## Useful Links

- [Tauri 2 documentation](https://v2.tauri.app/)
- [Tauri updater plugin](https://v2.tauri.app/plugin/updater/)
- [Tauri dialog plugin](https://v2.tauri.app/plugin/dialog/)
- [Tauri fs plugin](https://v2.tauri.app/plugin/file-system/)
- [tauri-action](https://github.com/tauri-apps/tauri-action)
