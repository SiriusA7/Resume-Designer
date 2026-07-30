<!-- project-stack-start -->

This repo is **on paper** (formerly Resume Designer), a Tauri 2 desktop app
(macOS + Windows) for designing résumés, with AI chat assistance and vector PDF
export. The app code lives in `resume-designer/`; the repo root also holds
`website/` (GitHub Pages marketing site) and `docs/`.

The directory name `resume-designer/`, the GitHub repo slug, the bundle
identifier `com.resumedesigner.app`, and every `resume-designer-*` storage key
are **deliberately unchanged** by the rename — they are paths and data
addresses, not branding. See "Project rules" below.

When working on build, packaging, signing, or updater code, **read
`resume-designer/TAURI.md` first** — it is the authoritative guide for the
Tauri setup and overrides anything you may assume about Tauri from training
data.

<!-- project-stack-end -->

# CLAUDE.md

Project-specific guidance. Behavioral guidelines (Think Before Coding,
Simplicity First, Surgical Changes, Goal-Driven Execution) and the
model-selection policy for workflows/subagents live in the user-global
`~/.claude/CLAUDE.md` and apply here — do not duplicate them in this file.

## Commands

Run all of these from `resume-designer/`:

```bash
npm run dev          # browser-only dev server (no Tauri shell)
npm run tauri:dev    # desktop window with hot reload (Rust compile on first run)
npm run test         # vitest, single run
npm run test:watch   # vitest, watch mode
npm run lint         # eslint
npm run tauri:build  # production desktop build (see TAURI.md for targets)
```

## Layout

- `resume-designer/src/` — frontend: React 19 + Vite, plain JavaScript (`.jsx`/`.js`, no TypeScript). Service modules (AI streaming, storage, pagination, chat threads, diffing) are framework-free `.js` files at the top level; React components live in `src/components/`.
- `resume-designer/src/components/ui/` — shadcn/ui primitives (Radix + Tailwind 3 + CVA).
- `resume-designer/src-tauri/` — Rust side: `src/commands/` holds the Tauri command handlers.
- `resume-designer/test/` — vitest suites for the service modules; add tests here when changing them.
- `website/` — static marketing site, deployed to GitHub Pages on push to `main`.

## Project rules

### Git and releases

- **Never commit, push, or open a PR without being explicitly asked.**
- Conventional commits, enforced by commitlint in CI on **every commit in a PR** (both `main` and `next`): subjects must start lowercase (e.g. `fix(chat): …`).
- Branch flow: feature branches → `next` (beta channel) → promotion PR to `main`.
- The `next` **git tag** is the beta release anchor — never delete it. Use `refs/heads/next` / `origin/next` when you mean the branch, to avoid the branch/tag ambiguity.

### Naming (the "on paper" rename)

The app is branded **on paper** — always lowercase, never "On Paper". Where a
space is illegal, use `on-paper` (npm package, export filenames); the Rust lib
is `on_paper_lib`.

These are **frozen and must never be renamed**, however tempting a sweep looks:

- **Bundle identifier `com.resumedesigner.app`** — Tauri derives the app-data
  directory from it, so it is the on-disk address of every user's résumés.
  Changing it ships via the auto-updater and factory-resets the app.
- **Every `resume-designer-*` / `resume-*` storage key** — desktop storage is
  one file per key, so these are filenames. Renaming them also turns the
  wipe-before-validate path in `persistence.js` into a silent data loss on the
  next backup import.
- **The legacy Electron key list and paths in `src-tauri/src/commands/migration.rs`**
  — historical facts about a shipped app's on-disk database, not configuration.
- **The `resume-designer/` directory and the GitHub repo slug** — the repo slug
  is compiled into the updater endpoints of every shipped binary.

Never sweep on the bare string `resume-`: it also names the `.resume-page` /
`.resume-sidebar` CSS classes that pagination and PDF page-splitting depend on.
Drive any key-related change off `BACKUP_FIXED_KEYS` in `src/profileKeys.js`.

### UI

- shadcn/ui here is the real thing: Tailwind Preflight is ON, components come from real shadcn primitives/source. Never hand-roll lookalike components from memory — copy or extend the actual primitives in `src/components/ui/`.

### Testing and verification

- The ClaudePreview browser is Chromium, but the shipped app runs in **WKWebView (WebKit)**. WebKit-only scroll/layout bugs will not reproduce in preview — write engine-agnostic fixes and verify in `npm run tauri:dev` for anything layout- or scroll-sensitive.
- PR CI builds run on macOS only. Type-check `#[cfg(windows)]` Rust code locally with `cargo check --target x86_64-pc-windows-gnu` (mingw toolchain is installed; the msvc target does not build on this machine).
