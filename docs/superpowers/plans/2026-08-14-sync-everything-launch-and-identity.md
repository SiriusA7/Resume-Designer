# Sync Everything — Launch and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sync that Plan 1 built reachable by a person — sync runs from launch with no switch, a splash holds while the account is asked what it holds, workspaces can be opened on iOS, and a device joining an existing account never onboards.

**Architecture:** Sync stops being a preference. A launch splash — a pixel-matched continuation of the OS launch screen — holds the first launch while Swift fetches the `opShared` zone, and the page asks what the account holds **before** `resolveActiveProfile` mints anything. A device joining an existing account takes the account's profiles and never creates a starter, which deletes adoption and the untouched-workspace predicate outright. A native switcher lists profiles and, in doing so, finally supplies the real profile list Plan 1's engine has been waiting for.

**Tech Stack:** Swift 6 / SwiftUI (`@MainActor`), xcodegen (owns `Info.plist`), JavaScript (framework-free service modules, vitest).

Plan 2 of 2 for [2026-08-14-ios-sync-everything-design.md](../specs/2026-08-14-ios-sync-everything-design.md). Plan 1 (`18518d9`, `ef69f37`, `bdde0a5`) built the data layer.

## Global Constraints

- **Never commit, push, or open a PR without being explicitly asked.** Conventional commits, subjects start lowercase.
- **Frozen identifiers, never renamed:** desktop bundle id and keychain `SERVICE` `com.resumedesigner.app`; iOS bundle id `com.onpaper.app`; container `iCloud.com.onpaper.app`; every `resume-designer-*` / `resume-*` storage key; the `resume-designer/` directory.
- **Never sweep on the bare string `resume-`** — it also names the `.resume-page` / `.resume-sidebar` CSS classes pagination depends on.
- **Display copy follows [docs/brand/on-paper-brand-guide.md](../../brand/on-paper-brand-guide.md).** "On Paper", two words. **`resume`, not `résumé`, in display copy** — the guide is explicit. Sentence case, no exclamation marks.
- **Nothing claims success it cannot back.** The existing `syncStatus` doc comment sets this rule; every string you add obeys it.
- **Swift classifies nothing about a unit id.** The profile list comes from the page; do not synthesise one in Swift.
- **There is no Swift test suite and none is to be invented.** Never write a JS test that reads Swift source as a string.
- **Test the disk, not the cache.** Drive the real `appStorage` over an injected backend.
- Baseline before this plan: **1518 passing tests, 0 lint errors, exactly 2 pre-existing warnings.**
- Gate: `cd resume-designer && npm run test && npm run lint`
- iOS build: `cd resume-designer && OP_SIM_UDID=7AC9B466-1F79-4091-8DAE-790CC3D8CE6B npm run ios:sim` — expects `Finished 1 iOS Bundle` and **zero** `error:` lines. **Six agents in a row have found `CoreSimulatorService` unavailable in their sandbox. If that happens, say so plainly and report exactly what you ran instead. Never describe a check as passing when it did not run.**
- **If a build touches `src-tauri/gen/apple/*.pbxproj`:** grep the diff for `PBXFileReference` and `PBXBuildFile` before reverting. Churn may be reverted; a line adding a **file to the target** must be kept.

## File Structure

| File | Responsibility after this plan |
|---|---|
| `gen/apple/project.yml` | `UILaunchScreen` replacing the storyboard reference; launch assets declared |
| `gen/apple/Assets.xcassets/LaunchLogo.imageset` | **New.** The launch mark |
| `gen/apple/Assets.xcassets/LaunchBackground.colorset` | **New.** The launch background, light and dark |
| `src-tauri/ios/OPLaunch.swift` | **New.** `LaunchScreenContinuationView` — pixel-matched, decorative |
| `src-tauri/ios/OPShell.swift` | Splash gating; no sync toggle; purge suspension row; profile switcher; real profile list |
| `src/profiles.js` | The account question before minting; adoption and the untouched predicate deleted |
| `src/iosShell.js` | Account-question command; profile list in the snapshot; adoption command deleted |
| `src/sync/syncKeys.js` | `resume-designer-sync-enabled` removed; the purge-suspension key added as device-local |

---

### Task 1: The launch screen and its continuation

Visual only. No behaviour changes, so it is safe to land first and it gives the later tasks something to hold.

**Files:**
- Modify: `resume-designer/src-tauri/gen/apple/project.yml`
- Create: `resume-designer/src-tauri/gen/apple/Assets.xcassets/LaunchLogo.imageset/Contents.json` (+ artwork)
- Create: `resume-designer/src-tauri/gen/apple/Assets.xcassets/LaunchBackground.colorset/Contents.json`
- Create: `resume-designer/src-tauri/ios/OPLaunch.swift`

**Interfaces:**
- Produces: `LaunchScreenContinuationView` — a SwiftUI `View` with no initialiser arguments. Task 4 presents it over the web view while the first launch waits.

**Background:** `project.yml` currently sets `UILaunchStoryboardName: LaunchScreen`, referencing a storyboard. The modern declarative key is `UILaunchScreen`, which needs no storyboard file and names assets instead. **Declaring both is ambiguous — remove `UILaunchStoryboardName` when you add `UILaunchScreen`.** The iOS floor is 26.0, far above `UILaunchScreen`'s iOS 14 requirement.

The reference implementation is HyperBuild's, at `/Users/ashshah/HyperBuild/Projects/HyperBuild/HyperBuild/Onboarding/OnboardingExperienceView.swift` — read `LaunchScreenContinuationView` there before writing this one.

- [ ] **Step 1: Add the colorset**

Create `LaunchBackground.colorset/Contents.json` with `universal` entries for light and dark appearances. Use the app's existing background tokens rather than inventing colours — read them from the web app's CSS custom properties so the splash matches the app it hands off to.

- [ ] **Step 2: Add the imageset**

Create `LaunchLogo.imageset/Contents.json` with `1x`/`2x`/`3x` slots. **The artwork is being redesigned as its own project**, so use the current app mark; this task creates the slot, and swapping the file later is an asset change with no code impact.

- [ ] **Step 3: Switch the plist key**

In `project.yml`, under `info: properties:`, remove `UILaunchStoryboardName: LaunchScreen` and add:

```yaml
        UILaunchScreen:
          UIImageName: LaunchLogo
          UIColorName: LaunchBackground
          UIImageRespectsSafeAreaInsets: false
```

- [ ] **Step 4: Write the continuation view**

Create `src-tauri/ios/OPLaunch.swift`. It must be **pixel-matched** to the OS launch screen — compute the centre from the full size including safe-area insets, exactly as HyperBuild does, or the hand-off visibly jumps:

```swift
/// A pixel-matched continuation of the native `UILaunchScreen`.
///
/// Kept decorative so launch plumbing never adds a VoiceOver stop: the person
/// is not waiting on a control, and a focusable element here would be one more
/// thing between them and their resumes.
///
/// The centre is computed from the FULL size including safe-area insets because
/// the OS screen ignores them (`UIImageRespectsSafeAreaInsets: false`). Using
/// the inset size instead moves the logo by the notch height, and the hand-off
/// jumps.
struct LaunchScreenContinuationView: View {
  static let logoSize: CGFloat = 88
  static let dissolveDuration: Double = 0.55

  var body: some View {
    GeometryReader { proxy in
      let insets = proxy.safeAreaInsets
      let fullWidth = proxy.size.width + insets.leading + insets.trailing
      let fullHeight = proxy.size.height + insets.top + insets.bottom

      ZStack {
        Color("LaunchBackground").ignoresSafeArea()
        Image("LaunchLogo")
          .resizable()
          .scaledToFit()
          .frame(width: Self.logoSize, height: Self.logoSize)
          .position(x: fullWidth / 2 - insets.leading, y: fullHeight / 2 - insets.top)
      }
    }
    .statusBarHidden(true)
    .accessibilityHidden(true)
  }
}
```

- [ ] **Step 5: Regenerate the Xcode project and build**

Run: `cd resume-designer/src-tauri/gen/apple && xcodegen generate`

A new Swift file needs this — the Xcode project is committed source (`docs/ios/xcode-project-ownership.md`), and skipping it produces a confusing "Build input file cannot be found".

Run: `cd resume-designer && OP_SIM_UDID=7AC9B466-1F79-4091-8DAE-790CC3D8CE6B npm run ios:sim`
Expected: `Finished 1 iOS Bundle`, zero `error:` lines.

**The pbxproj diff will contain a real `PBXFileReference` and `PBXBuildFile` for `OPLaunch.swift`. Keep those** — reverting them drops the file from the target, which has happened twice here.

- [ ] **Step 6: Commit**

```bash
git add resume-designer/src-tauri/gen/apple resume-designer/src-tauri/ios/OPLaunch.swift
git commit -m "feat(ios): add a launch screen and its pixel-matched continuation"
```

---

### Task 2: Sync is always on, and a purge suspends rather than opts out

**Files:**
- Modify: `resume-designer/src/sync/syncKeys.js`
- Modify: `resume-designer/src-tauri/ios/OPShell.swift`
- Test: `resume-designer/test/syncKeys.test.js`

**Interfaces:**
- Produces: `SYNC_SUSPENDED_KEY = 'resume-designer-sync-suspended'`, exported from `syncKeys.js` and listed in `DEVICE_LOCAL_KEYS`. Task 4 does not use it; only `OPShell.swift` does.

**Background:** Apple's guidance is explicit — "Sync should be automatic … Resist the temptation to ask the user whether they'd like to sync this or that" — and iOS already offers a system-level opt-out under Settings → Apple ID → iCloud. **No migration is needed: iOS sync has never shipped**, so no user holds a preference this overrides.

The one behaviour the old preference carried that still matters: after an iCloud purge the app must stop rather than immediately re-upload what the person just deleted. That is **not** a preference and must not reuse its key — a later reader cannot tell "does not want sync" from "the server was emptied and we are waiting", and the correct behaviour differs.

- [ ] **Step 1: Write the failing test**

In `test/syncKeys.test.js`:

```js
it('classifies the purge-suspension marker as device-local', () => {
  // Suspension is a fact about THIS device's relationship with the account —
  // syncing it would suspend every other device over one person's deletion.
  expect(classifyKey(SYNC_SUSPENDED_KEY)).toBe('local');
});

it('no longer knows the removed sync preference', () => {
  // The toggle is gone; an unclassified key must refuse rather than sync.
  expect(classifyKey('resume-designer-sync-enabled')).toBe('unknown');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd resume-designer && npx vitest run test/syncKeys.test.js`
Expected: FAIL — `SYNC_SUSPENDED_KEY` is not exported, and the old key still classifies as `local`.

- [ ] **Step 3: Change the key lists**

In `src/sync/syncKeys.js`, remove `'resume-designer-sync-enabled'` from `DEVICE_LOCAL_KEYS` along with its comment, and add:

```js
  // Set when iCloud data was purged, so this device stops rather than
  // immediately re-uploading what the person just deleted. NOT a preference:
  // there is no longer a switch, and the two facts must not share a key —
  // "does not want sync" is permanent, "the server was emptied" is a prompt.
  SYNC_SUSPENDED_KEY,
```

Define and export `export const SYNC_SUSPENDED_KEY = 'resume-designer-sync-suspended';` above the list.

- [ ] **Step 4: Run the test**

Run: `cd resume-designer && npx vitest run test/syncKeys.test.js`
Expected: PASS.

- [ ] **Step 5: Remove the toggle from Settings**

In `OPShell.swift`, the Sync `Section` currently holds `Toggle("iCloud sync", isOn: syncBinding)` and a status line. Delete the toggle and its binding. **Keep the status line** — Apple's guidance is to show status, not a switch — and keep the footer copy explaining where résumés go.

- [ ] **Step 6: Add the suspension row**

When suspension is set, the Sync section shows a line and a button. Copy, following the brand guide (`resume`, not `résumé`; sentence case):

- Line: `iCloud data for On Paper was removed. This device stopped syncing so it does not put it back.`
- Button: `Resume syncing`

Pressing it clears the suspension and re-offers this device's full upload. **Nothing else clears it** — there is no toggle to flip, and time passing is not consent to re-upload data somebody deleted on purpose.

- [ ] **Step 7: Make the purge path set suspension instead of writing the preference**

Find where the purge / `.userDeletedZone` / `.encryptedDataReset` handling currently turns sync off and have it set the suspension marker. Every start checks the marker and does not start the engine while it is set.

- [ ] **Step 8: Run the full gate and build**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: 1518 + your new tests, 0 errors, 2 warnings.

Run: `cd resume-designer && OP_SIM_UDID=7AC9B466-1F79-4091-8DAE-790CC3D8CE6B npm run ios:sim`
Expected: `Finished 1 iOS Bundle`, zero `error:` lines.

- [ ] **Step 9: Commit**

```bash
git add resume-designer/src/sync/syncKeys.js resume-designer/test/syncKeys.test.js resume-designer/src-tauri/ios/OPShell.swift
git commit -m "feat(sync): sync without asking, and suspend rather than opt out after a purge"
```

---

### Task 3: The profile switcher, and the real profile list

This is what retires Plan 1's `[profileId]` stub — the engine has been able to mirror an account since `ef69f37` but has only ever been asked for one zone.

**Files:**
- Modify: `resume-designer/src/iosShell.js`
- Modify: `resume-designer/src-tauri/ios/OPShell.swift`
- Test: `resume-designer/test/iosShell.test.js`

**Interfaces:**
- Consumes: `start(profileId:knownProfileIds:)` from Plan 1.
- Produces: `ShellSnapshot` gains `profiles: [ShellProfile]` where `ShellProfile` is `{ id: String, name: String, initials: String, isActive: Bool }`.

**Background:** the native shell has never had a workspace list — "THE MARKER KEYS ARE THE LIST. This side never sees a workspace list." The web switcher exists but `native-shell.css` hides the header it lives in, which is why iOS currently cannot open a profile it already knows about. Desktop's equivalent is `src/components/profile/AccountAvatar.jsx` and `AccountSection.jsx`; match its behaviour, not its markup.

- [ ] **Step 1: Write the failing test**

In `test/iosShell.test.js`:

```js
it('puts the profile list and the active one in the snapshot', async () => {
  const listProfiles = vi.fn(() => [
    { id: 'pa', name: 'Ada Shah' },
    { id: 'pb', name: 'Bo' },
  ]);
  const getActiveProfileId = vi.fn(() => 'pb');
  const { snapshot } = await mount({ listProfiles, getActiveProfileId });

  expect(snapshot().profiles).toEqual([
    { id: 'pa', name: 'Ada Shah', initials: 'AS', isActive: false },
    { id: 'pb', name: 'Bo', initials: 'B', isActive: true },
  ]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd resume-designer && npx vitest run test/iosShell.test.js -t "profile list"`
Expected: FAIL — `profiles` is undefined on the snapshot.

- [ ] **Step 3: Add the profile list to the snapshot**

In `src/iosShell.js`, add `profiles` to the snapshot the page pushes. Reuse `profileInitials` from `src/accountStats.js` — desktop already computes initials there and a second implementation would drift.

- [ ] **Step 4: Run the test**

Run: `cd resume-designer && npx vitest run test/iosShell.test.js -t "profile list"`
Expected: PASS.

- [ ] **Step 5: Decode it in Swift**

Add `ShellProfile` and `profiles` to `ShellSnapshot` (line 32). Both `Decodable` and `Equatable`, matching the existing fields' style. Default `profiles` to `[]` when absent so an older page cannot crash a newer shell.

- [ ] **Step 6: Build the switcher**

A nav-bar button on the leading side showing the active profile's initials, opening a `Menu` listing every profile with the active one marked. Selecting one sends the existing profile-switch command — **do not invent a new switch path**; switching already reloads the window and goes through a durable activation, and that path has been reviewed repeatedly.

Show the button only when there is more than one profile. A single-profile install has nothing to switch to, and a control that does nothing is worse than no control.

- [ ] **Step 7: Pass the real list to the engine**

At the `sync.start` call site, replace `[profileId]` with the ids from the snapshot's `profiles`. **This is the line that makes all-profile sync actually happen.** Note in your report that the stub is now retired.

- [ ] **Step 8: Run the full gate and build**

Run: `cd resume-designer && npm run test && npm run lint`
Run: `cd resume-designer && OP_SIM_UDID=7AC9B466-1F79-4091-8DAE-790CC3D8CE6B npm run ios:sim`

- [ ] **Step 9: Commit**

```bash
git add resume-designer/src/iosShell.js resume-designer/test/iosShell.test.js resume-designer/src-tauri/ios/OPShell.swift
git commit -m "feat(ios): switch workspaces from the nav bar, and sync every one of them"
```

---

### Task 4: Ask the account before minting anything, and delete adoption

The task that makes a fresh device open into the person's existing workspace instead of onboarding — and the one that deletes the most dangerous code in the project.

**Files:**
- Modify: `resume-designer/src/profiles.js`
- Modify: `resume-designer/src/iosShell.js`
- Modify: `resume-designer/src/main.js`
- Modify: `resume-designer/src-tauri/ios/OPShell.swift`
- Test: `resume-designer/test/profiles.test.js`

**Interfaces:**
- Consumes: `LaunchScreenContinuationView` (Task 1), the profile list (Task 3).
- Produces: bridge command `syncAccountProfiles` answering `{ status: 'known', profiles: [...] } | { status: 'empty' } | { status: 'unavailable' }`.

**Background — read before writing:** the boot sequence is load-bearing: `initAppStorage` → `maybeAutoMigrateLegacyData` → `ensureProfilesInitialized` → `markStorageReady`, with mapping identity until profiles resolve. The question goes **inside `ensureProfilesInitialized`, before the registry is written**; everything around it keeps its current order.

`opShared` needs no profile id — its name is a fixed literal — which is what makes asking before minting possible at all.

- [ ] **Step 1: Write the failing tests**

In `test/profiles.test.js`:

```js
it('takes the account profiles and mints no starter', async () => {
  const ask = vi.fn(async () => ({
    status: 'known',
    profiles: [{ id: 'paccount', name: 'Account', createdAt: '2026-07-01T00:00:00.000Z' }],
  }));

  expect(await ensureProfilesInitialized({ askAccount: ask })).toBe('paccount');
  expect(JSON.parse(backend.files.get(PROFILES_KEY)).map((p) => p.id)).toEqual(['paccount']);
  expect(backend.files.get(STARTER_KEY)).toBeUndefined();
});

it.each([['empty'], ['unavailable']])('mints a starter when the account answers %s', async (status) => {
  const ask = vi.fn(async () => ({ status }));
  const id = await ensureProfilesInitialized({ askAccount: ask });

  expect(id).toMatch(/^p/);
  expect(backend.files.get(STARTER_KEY)).toBe(id);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd resume-designer && npx vitest run test/profiles.test.js -t "account"`
Expected: FAIL — `ensureProfilesInitialized` takes no argument and always mints.

- [ ] **Step 3: Ask before minting**

In `resolveActiveProfile`, before the branch that generates an id and writes a registry, call the injected `askAccount`. On `known`, write the account's profiles as the registry and activate the **least-recently-created** — the same ordering `mergeRegistry` sorts by, so two devices bootstrapping against one account open the same workspace. On `empty` or `unavailable`, fall through to today's path unchanged.

A device that already has a registry never asks. Only the first launch pays the wait.

- [ ] **Step 4: Delete adoption**

Remove `adoptAccountWorkspaces`, `accountWorkspaceToAdopt`, `shouldAdoptAccountWorkspaces`, `isUntouchedWorkspace`, the `STARTER_PROFILE_KEY` marker and every test that exercised them, plus the `syncShouldAdoptAccountWorkspaces` bridge command, its `deps` entry in `main.js`, and the once-per-launch reload guard in `OPShell.swift`.

**Nothing may be left that can delete a workspace.** If you find a caller you cannot remove, stop and escalate rather than leaving a partial deletion.

- [ ] **Step 5: Wire the bridge command**

Add `syncAccountProfiles` to `iosShell.js` and its `deps` entry in `main.js`. It is asked through `callAsyncJavaScript` because the answer waits on a network fetch — follow `syncApply`'s pattern, and note that a malformed request still throws **synchronously**.

- [ ] **Step 6: Gate the first launch on the answer**

In `OPShell.swift`: begin the `opShared` fetch as early as possible; present `LaunchScreenContinuationView` over the web view until the page reports it has resolved profiles, or until a **5-second timeout**, whichever comes first. Dissolve using `LaunchScreenContinuationView.dissolveDuration`.

**The timeout is not optional.** An offline first launch must open, and a device that could not ask is not a device that may block.

- [ ] **Step 7: Run the tests**

Run: `cd resume-designer && npx vitest run test/profiles.test.js`
Expected: PASS. The suite shrinks — the deleted predicate took its tests with it. **Report the new total and the delta.**

- [ ] **Step 8: Verify by mutation**

Make `askAccount` always answer `empty`. Confirm the first test fails — a fresh device mints a starter and ignores the account. Restore. **Report the result explicitly.**

- [ ] **Step 9: Run the full gate and build**

Run: `cd resume-designer && npm run test && npm run lint`
Run: `cd resume-designer && OP_SIM_UDID=7AC9B466-1F79-4091-8DAE-790CC3D8CE6B npm run ios:sim`

- [ ] **Step 10: Commit**

```bash
git add resume-designer/src resume-designer/test resume-designer/src-tauri/ios/OPShell.swift
git commit -m "feat(profiles): ask the account before minting a workspace, and delete adoption"
```

---

## After this plan

The two-device test in the spec finally means something. Re-run it from a clean
install on both devices, and expect: the second device opens **into the first
device's workspace** without onboarding, the API key is already there, and both
devices' full profile lists are present and switchable from the nav bar.

Until a device test passes, none of this is verified. Four adversarial review
rounds passed code that could not work on a phone.
