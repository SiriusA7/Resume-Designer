# SwiftUI shell — Step 1: own the entry point — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take ownership of the iOS Xcode project and its entry point, with the
existing webview hosted full-screen — **zero visible change to the app**.

**Architecture:** `src-tauri/gen/apple` stops being disposable generated output
and becomes committed source. The generated SwiftUI entry point is replaced by
one we own, which builds a trivial shell whose entire body is the Tauri webview.
Nothing else changes: same webview, same JS, same storage, same commands.

**Tech Stack:** Swift / SwiftUI, Tauri 2 iOS (`tauri ios build`), Xcode, an
existing React + vanilla-JS webview.

**Why this step exists:** it is the cheapest possible test of the riskiest
unknown in the whole SwiftUI plan — whether a committed Xcode project survives
Tauri's tooling, and whether we can own the entry point without losing commands,
storage, or the updater. If this step is nasty, we find out for the price of one
step instead of discovering it halfway through a shell rewrite.

**Success is defined by absence:** the app must look and behave *exactly* as it
does today on device. Any visible difference in this step is a bug.

## Global Constraints

- **The design of record is
  [`docs/superpowers/specs/2026-08-10-ios-swiftui-shell-design.md`](../specs/2026-08-10-ios-swiftui-shell-design.md).**
  Read it before starting. This plan implements only its staging step 1.
- **Frozen forever and not touched by this work:** bundle identifier
  `com.resumedesigner.app` (Tauri derives the app-data directory from it, so
  changing it factory-resets every user), the Cargo package name
  `resume-designer`, and every `resume-designer-*` / `resume-*` storage key.
  Never sweep on the bare string `resume-` — it also names the `.resume-page` /
  `.resume-sidebar` CSS classes that pagination and PDF page-splitting depend on.
- **`src-tauri/src/ios_view.rs` must keep working.** The app renders nothing
  without it: tao never assigns the `UIWindow` a `windowScene` under a static
  scene manifest, so the webview stays 0×0. If the entry point changes who owns
  the window, this workaround may become unnecessary or may break — either
  outcome must be established deliberately, never left ambiguous.
- **Web gates unchanged and must stay green:** `cd resume-designer && npm run
  test && npm run lint && npx vite build`. This step should not touch web code
  at all; if it does, that is a signal the scope slipped.
- Conventional commits; subjects start lowercase. CI lints **every** commit in a
  PR.
- The brand is **On Paper**, two words, title case.
- Device build: `npx tauri ios build --debug --target aarch64`, install with
  `xcrun devicectl device install app --device <UDID> "<path>.ipa"`. Do NOT use
  `tauri ios dev` — it misclassifies every simulator as a physical device.
- Signing team is **847VH25R7U**; the pre-existing wildcard profile `847VH25R7U.*`
  covers `com.resumedesigner.app`, so no App ID registration is needed.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `resume-designer/.gitignore` | stop ignoring the Apple project; keep ignoring other generated targets | 1 |
| `resume-designer/src-tauri/gen/apple/**` | the Xcode project, now committed source | 1 |
| `docs/ios/xcode-project-ownership.md` | **new** — what is now hand-maintained, and how to re-run `tauri ios init` safely | 1, 2 |
| `resume-designer/src-tauri/gen/apple/Sources/**` | the entry point we own | 3 |

---

### Task 1: Commit the generated Xcode project as a baseline

Nothing is modified here. The point is to capture *exactly* what Tauri generates
today, so that any later diff is attributable to us rather than to the generator.

**Files:**
- Modify: `resume-designer/.gitignore` (line 10, currently `src-tauri/gen/`)
- Add: `resume-designer/src-tauri/gen/apple/**`
- Create: `docs/ios/xcode-project-ownership.md`

- [ ] **Step 1: Record what is generated today**

```bash
cd resume-designer && find src-tauri/gen/apple -type f | sort > /tmp/apple-baseline.txt && wc -l /tmp/apple-baseline.txt
```

Keep this list — Task 2 compares against it.

- [ ] **Step 2: Narrow the ignore rule**

`resume-designer/.gitignore` line 10 is `src-tauri/gen/`. Replace it with a rule
that keeps ignoring other generated targets but tracks the Apple project:

```gitignore
src-tauri/gen/*
!src-tauri/gen/apple
```

Then check what that actually stages — the generated project contains build
artefacts that must NOT be committed:

```bash
cd resume-designer && git add -An src-tauri/gen/apple | head -50
```

- [ ] **Step 3: Exclude build output and local state**

Anything under `build/`, `Externals/`, `*.xcuserstate`, `xcuserdata/`, `Pods/`,
or `.build/` is derived output, not source. Add these to
`resume-designer/.gitignore` beneath the rule above, then re-run the dry-run from
Step 2 and confirm only project sources, `project.yml`/`.xcodeproj`, `Assets.xcassets`,
`Sources/`, and the Info plists are staged. **Report the exact final file count.**
If anything above ~200 files is staged, stop and reassess — that is a signal
build output is still included.

- [ ] **Step 4: Write down what ownership now means**

Create `docs/ios/xcode-project-ownership.md` covering: which paths are now
hand-maintained; that `tauri ios init` will overwrite them; the safe procedure
for re-running it (branch, regenerate, diff against committed, reapply our
entry point); and that Tauri upgrades will produce conflicts here that are ours
to resolve. This file is the thing that stops a future contributor deleting the
shell by running a routine command.

- [ ] **Step 5: Commit the untouched baseline**

```bash
git add resume-designer/.gitignore resume-designer/src-tauri/gen/apple docs/ios/xcode-project-ownership.md
git commit -m "build(ios): commit the generated xcode project as source"
```

The commit body must state that the project is **unmodified generator output**
at this commit, so the next commit's diff is purely ours.

---

### Task 2: Prove regeneration is survivable

Committing the project is only safe if we know what `tauri ios init` does to it.
Establish that now, while the project is still pristine and a mistake costs
nothing.

**Files:**
- Modify: `docs/ios/xcode-project-ownership.md`

**Interfaces:**
- Consumes: the committed baseline and `/tmp/apple-baseline.txt` from Task 1
- Produces: a documented, tested regeneration procedure

- [ ] **Step 1: Regenerate onto the committed tree**

```bash
cd resume-designer && npx tauri ios init 2>&1 | tail -20 && git status --short src-tauri/gen/apple
```

- [ ] **Step 2: Record exactly what it changed**

```bash
cd resume-designer && git diff --stat src-tauri/gen/apple
```

Write the real answer into `docs/ios/xcode-project-ownership.md`: which files it
rewrites, which it leaves alone, and whether it is destructive or idempotent.
**Do not guess or generalise — paste what the command actually reported.**

- [ ] **Step 3: Restore the baseline**

```bash
cd resume-designer && git checkout -- src-tauri/gen/apple && git status --short src-tauri/gen/apple
```

Expected: clean.

- [ ] **Step 4: Confirm the app still builds after all that**

```bash
cd resume-designer && npx tauri ios build --debug --target aarch64 2>&1 | tail -5
```

Expected: a `.ipa` at `src-tauri/gen/apple/build/arm64/On Paper.ipa`.

- [ ] **Step 5: Commit the findings**

```bash
git add docs/ios/xcode-project-ownership.md
git commit -m "docs(ios): record what tauri ios init does to the committed project"
```

---

### Task 3: Own the entry point

Replace the generated app entry point with ours. The shell is deliberately
trivial: its whole body is the Tauri webview, full-screen. No navigation bar, no
toolbar, no sheets — those are step 2.

**Files:**
- Modify: the generated entry point under
  `resume-designer/src-tauri/gen/apple/Sources/` (find it in Task 1's file list;
  do not assume a filename)

**Interfaces:**
- Consumes: the committed project from Task 1
- Produces: an entry point we control, into which step 2 adds real chrome

- [ ] **Step 1: Read what is there now**

Find and read the current entry point and note precisely how it starts Tauri —
which function it calls, what it passes, and how the window is created. Quote it
in your report. **This is the load-bearing detail of the whole step**: the
replacement must call exactly the same thing.

- [ ] **Step 2: Replace it with an entry point we own**

Write a `SwiftUI` `App` whose body hosts the Tauri webview full-screen and
starts Tauri identically to the generated version. Mark the file clearly:

```swift
// OWNED BY THIS REPO — not generated output.
// `tauri ios init` will overwrite this file; see
// docs/ios/xcode-project-ownership.md before regenerating.
```

Keep it minimal. Resist adding any chrome — a nav bar here would make this step
impossible to evaluate against its own success criterion.

- [ ] **Step 3: Build**

```bash
cd resume-designer && npx tauri ios build --debug --target aarch64 2>&1 | tail -5
```

Expected: a `.ipa` is produced.

- [ ] **Step 4: Establish what happened to the `ios_view.rs` workaround**

The app is invisible today without `src-tauri/src/ios_view.rs`, which assigns
the `UIWindow` a `windowScene` that tao leaves unset. Owning the entry point may
make that unnecessary, or may break it. Determine which — do not leave it
ambiguous. Report the answer with evidence. **Do not delete `ios_view.rs` in
this step even if it appears redundant**; note it as a follow-up so the deletion
is a change someone can evaluate on its own.

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src-tauri/gen/apple
git commit -m "feat(ios): own the swiftui entry point"
```

---

## Final verification — the whole point of this step

Automated gates prove nothing here; the deliverable is "nothing changed". This
must be checked on the device.

- [ ] `cd resume-designer && npm run test && npm run lint && npx vite build` — green,
      and the diff should show **no web files changed at all**.
- [ ] Install on the iPhone:
      `xcrun devicectl device install app --device 67372965-5465-5753-92EF-254B7E4E945A "src-tauri/gen/apple/build/arm64/On Paper.ipa"`
- [ ] **On device, confirm the app is indistinguishable from the previous build:**
      it launches and renders (not a blank screen — that is the `ios_view.rs`
      failure mode); the résumé loads; tap-to-edit places the caret; the variant
      switcher works; **PDF export still produces a correct multi-page vector
      PDF** (this exercises `createPDF` over the live DOM, the architectural
      constraint the entire design rests on); settings open; the app survives
      backgrounding and resuming.
- [ ] Confirm a clean checkout builds: the committed project must be sufficient
      on a machine that has never run `tauri ios init`. If it is not, say so —
      that materially changes the ownership story.

## Explicitly out of scope

Navigation bar, toolbar, sheets, Settings, the keyboard work, and anything that
touches the bridge. All of that is step 2 onward. This step earns the right to
do those by proving the foundation holds.
