# The iOS Xcode project is committed source

`resume-designer/src-tauri/gen/apple` used to be disposable generated output.
It is now **tracked source**, because the SwiftUI shell
([`src-tauri/ios/`](../../resume-designer/src-tauri/ios/)) has to be compiled
into the app and an untracked project loses that reference on every
regeneration.

The rest of `src-tauri/gen/` is still ignored. `resume-designer/.gitignore`:

```gitignore
src-tauri/gen/*
!src-tauri/gen/apple
```

Build output inside the Apple project is excluded by the project's own
`src-tauri/gen/apple/.gitignore`, which Tauri generates and we keep:
`build/`, `Externals/`, `xcuserdata/`. Committed set: **33 files** — the
xcodeproj, `project.yml`, the app icons, the Info plist, the entitlements, the
launch storyboard, `main.mm` and its bindings header.

## What is hand-maintained

**`project.yml` is the only file to edit.** `resume-designer.xcodeproj` is
derived from it by `xcodegen generate`, so never hand-edit the pbxproj — the
next regeneration would silently discard the edit.

Four blocks in `project.yml` are ours. Each is commented `HAND-MAINTAINED` in
place:

| Block | Why it exists |
|---|---|
| `sources: - path: ../../ios` | Compiles the SwiftUI shell from its tracked home, so there is exactly one copy of it. Without this the shell is not in the app and `AnyClass::get(c"OPShell")` returns `None` at runtime. |
| `Externals: excludes: ["**/*.a"]` | `Externals` is empty when `tauri ios init` first runs and holds the 365 MB `libapp.a` afterwards. Without the exclude, a later `xcodegen generate` copies that static library into the app bundle's Resources. It is *linked* via the `libapp.a` dependency; it must never be a resource. |
| `DEVELOPMENT_TEAM: "847VH25R7U"` | Tauri writes this straight into the pbxproj and never records it in `project.yml`, so `xcodegen generate` drops it and device builds stop signing. Simulator builds don't care; device builds do. |
| the `Shell` group name | Cosmetic — keeps the shell separate from generated `Sources` in Xcode's navigator. |

## Re-running `tauri ios init`

It is destructive to all four. The safe procedure:

```bash
cd resume-designer
git status --short src-tauri/gen/apple     # must be clean first
npx tauri ios init
git diff src-tauri/gen/apple               # read every hunk
```

Then reapply the four blocks above (or `git checkout -- src-tauri/gen/apple/project.yml`
if nothing else in it changed), run `xcodegen generate`, and rebuild. Commit
the generator's changes and ours as separate commits so the next person can
tell them apart.

**Tauri upgrades will produce conflicts here.** That is the deal: a generated
project became a maintained one. The conflicts are ours to resolve, and the
table above is the checklist.

## Gotchas that cost time once already

- **`failed to rename app …: Directory not empty (os error 66)`** during Tauri's
  post-build packaging is a stale output directory, not a project-file problem.
  `rm -rf src-tauri/gen/apple/build/arm64-sim` and rebuild.
- **Xcode sometimes emits the app as a small stub plus `On Paper.debug.dylib`.**
  When it does, `nm "On Paper"` looks empty and is misleading — check the dylib.
  Whether you get a stub or one fat binary varies by build; search both.
- **`tauri ios dev` is unusable for simulators** — it misclassifies every one as
  a physical device. Use
  `npx tauri ios build --debug --target aarch64-sim` plus
  `xcrun simctl install booted "…/build/arm64-sim/On Paper.app"`.

## Frozen, and not touched by any of this

Bundle identifier `com.resumedesigner.app` (Tauri derives the app-data
directory from it, so changing it factory-resets every user), the Cargo package
name `resume-designer`, and every `resume-designer-*` / `resume-*` storage key.
The Xcode project name and target name are `resume-designer` for the same
reason; only `PRODUCT_NAME` is branded **On Paper**.
