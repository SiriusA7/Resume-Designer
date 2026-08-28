# Sync everything, always: the iOS sync redesign

**Date:** 2026-08-14
**Status:** Approved design, pending implementation plan
**Supersedes:** [2026-08-13-sync-bootstrap-design.md](2026-08-13-sync-bootstrap-design.md) in full.
Amends [2026-08-11-cloudkit-sync-design.md](2026-08-11-cloudkit-sync-design.md);
that document stands except where this one contradicts it.

## The problem

Two devices signed into one iCloud account, both running the finished sync and
bootstrap work, **never showed each other's data.** Found on real hardware on
2026-08-14, after four adversarial review rounds had passed the code. Every one
of those rounds reviewed the sync logic against its spec. None asked whether a
person could reach the state that logic requires.

They could not, for two independent reasons.

**The sync toggle is unreachable until the workspace is no longer empty.**
Onboarding is a `.fullScreenCover`, so Settings — the only place with the iCloud
switch — cannot be opened until onboarding finishes, and both of onboarding's
exits author content. By the time sync can be switched on, `isUntouchedWorkspace`
correctly refuses, and adoption never fires. The predicate is right; its
precondition is unsatisfiable.

**There is no manual fallback either.** Even when the shared-zone fetch unions
the other device's profile into the local registry, iOS cannot open it:
`native-shell.css` hides the web header that holds the switcher, and the native
Settings sheet has no workspace section.

Two further defects sit underneath those:

- **Only the active profile's zone is ever fetched.** The bootstrap spec listed
  this as an accepted limitation. It is not one. Profiles are user data, and a
  second device is expected to mirror the first.
- **The credential is per-device.** The API key must be typed again on every
  install, which is friction with no security benefit — the key already lives in
  a keychain that can sync.

## Decisions

| Question | Choice |
|---|---|
| Which profiles sync | **All of them.** Every profile's zone is fetched and applied, whichever is open |
| The sync toggle | **Removed.** Apple's guidance is that sync is automatic and the toggle should not exist; iOS already offers a system-level opt-out |
| Fresh-device flow | **Do not create a starter profile until the account is known to be empty** |
| Launch | **Splash holds on first launch** until the account answers or a timeout fires; brief on every launch after |
| API key | **iCloud Keychain** — the existing item becomes synchronizable. It never enters CloudKit |
| Logo / app icon | **Out of scope.** The splash creates named asset slots; artwork swaps later without code changes |

Apple's position on the toggle, from a staff response in the developer forums:
"Sync should be automatic. Users will expect this if they use your app across
multiple devices. … Resist the temptation to ask the user whether they'd like to
sync this or that."

## Design

### 1. Every profile syncs

Zones become **every profile in the registry, plus `opShared`** — not just the
active one. Zone creation stays idempotent-on-every-start, so the set is
reconciled against the registry each time rather than tracked separately.
`nextFetchChangesOptions` widens to the same set.

The narrowing rule the original design set still holds and still matters: never
advance a change token past records that are then dropped. It is satisfied for
the same reason as before — every zone in the scope is genuinely handled.

### 2. The apply path becomes profile-aware

This is the intricate part of the redesign and the only part that can lose data.

Today `applyUnits` writes through `appStorage`, which namespaces every key to the
active profile via `setProfileMapping`. A unit arriving from profile P's zone
must land in **P's** keys even while Q is open.

**Swift passes the profile id alongside each fetched unit.** It knows which zone
each record came from, and the zone name is the profile id. This is the mirror
image of `syncScopes`, which already answers which zone a unit *goes* to — and it
keeps the seam intact: Swift still classifies nothing, it only reports the zone
a record arrived in.

JS writes `physicalKey(profileId, logicalKey)` directly. `mapKey` already
short-circuits on an already-physical key, so no new storage primitive is needed
and the active mapping is bypassed rather than fought.

Everything the fetch path does per unit becomes profile-scoped with it: the
per-unit stamps in `SYNC_STATE_KEY` (already a per-profile key), the
`outranksLocalCopy` recency check, conflict resolution, and echo suppression.

**One simplification falls out.** Only the active profile has live in-memory
state — a React document, module-level caches, the history store. A foreign
profile's units reach disk and nothing else, so the entire class of
"applied content must also reach the live document" problems does not apply to
them. The live-state write-back stays exactly as it is, and runs only when the
arriving unit belongs to the active profile.

### 3. Sync is always on

The Settings toggle is removed. The status row stays — Apple's guidance is to
show status, not a switch — and keeps its existing rule that nothing claims
success it cannot back.

**No migration is required: iOS sync has never shipped.** Nothing is pushed past
`0a9610a`, so no user holds a sync preference that removing the toggle would
override. Desktop is unaffected; it has no sync yet.

`resume-designer-sync-enabled` is **removed** along with the toggle it recorded.
One behaviour it carried still needs a home: when iCloud data is purged, the app
must stop syncing rather than immediately re-upload what the person just deleted.

That becomes a **separate device-local key** recording suspension after a purge —
not a repurposing of the old preference key. The two are different facts and must
not share storage, because a later reader cannot tell "this person does not want
sync" from "the server was emptied and we are waiting", and the correct behaviour
differs: the first is permanent, the second is a prompt.

Suspension surfaces in the Sync section of Settings as a line saying iCloud data
was removed, with a **Resume syncing** button. Pressing it clears the suspension
and re-offers this device's full upload. Nothing else clears it — there is no
longer a toggle to flip, and time passing is not consent to re-upload data
somebody deleted on purpose.

### 4. Launch: the splash, and the question asked before anything is created

The app gains a launch screen it does not currently have — there is no
`UILaunchScreen` key and no launch assets today, only an app icon.

Following the pattern already proven in HyperBuild:

- a static `UILaunchScreen` (declared through `project.yml`, since xcodegen owns
  the plist) naming a `LaunchLogo` imageset and a `LaunchBackground` colorset;
- a **pixel-matched** SwiftUI continuation view that positions the same logo at
  the same point, computing the centre from the full size including safe-area
  insets so the hand-off from the OS screen has no visual jump;
- the continuation is decorative — `accessibilityHidden`, status bar hidden — so
  launch plumbing never adds a VoiceOver stop;
- it dissolves out rather than cutting.

**The handshake.** Swift begins fetching `opShared` as early as it can; that zone
needs no profile id, because its name is a fixed literal. Then, during boot and
**before `resolveActiveProfile` mints anything**, the page asks Swift what the
account holds. Three answers:

- **known** — the account has profiles. Take them into the local registry, open
  the least-recently-created (the same ordering `mergeRegistry` sorts by, so two
  devices bootstrapping against one account open the same one), and **never
  create a starter workspace at all.**
- **empty** — the account has no profiles. Mint the starter and onboard, exactly
  as today.
- **unavailable** — offline, no iCloud account, or the timeout fired. Treated as
  `empty`: mint the starter and onboard. A device that could not ask is not a
  device that may block.

The wait is bounded and only happens on a device with no local registry, so
every later launch and every existing install skips it entirely.

**This is what deletes the bootstrap feature.** With no starter created on a
device joining an existing account, there is nothing to absorb: no adoption, no
tombstone-on-adoption, no reload, and no `isUntouchedWorkspace` — the only code
in this project that can discard a person's workspace.

The boot sequence it inserts into is load-bearing (`initAppStorage` → legacy
migration → `ensureProfilesInitialized` → `markStorageReady`, with mapping
identity until profiles resolve). The question is asked inside
`ensureProfilesInitialized`, before the registry is written, and the ordering of
everything around it is unchanged.

### 5. A profile switcher on iOS

A nav-bar button showing the active profile's initials, matching desktop's
`AccountAvatar`, opening a menu that lists profiles and switches on tap.
Switching reloads the window, as it already does everywhere else.

The native shell has no concept of a profile list today — "THE MARKER KEYS ARE
THE LIST. This side never sees a workspace list" — so the snapshot the page
pushes gains the profile list and the active id. That is the only new state; the
switch itself goes through the existing durable activation path.

### 6. The API key syncs through iCloud Keychain

The keychain item in `src-tauri/src/commands/secret.rs` becomes synchronizable
(`kSecAttrSynchronizable`). It is then carried between the person's devices by
iCloud Keychain, which is end-to-end encrypted regardless of whether Advanced
Data Protection is enabled, and **the credential never enters CloudKit** — the
existing refusal in `syncKeys.js` stands unchanged.

`SERVICE` stays `com.resumedesigner.app` in this project. It is the same address
desktop uses, and moving it here would orphan every shipped desktop user's saved
key.

**Migration.** A synchronizable query does not match a non-synchronizable item,
so an existing key would read as missing. On a read miss, look for the
non-synchronizable item and, if found, re-save it synchronizable. One-time, and
idempotent.

**A constraint this hands to the deferred bundle-id rename.** That project moves
`SERVICE` to `com.onpaper.app`. Migrating a *synced* keychain item is harder than
migrating a local one: copies exist on every device the person owns, and deleting
the old item propagates that deletion everywhere — including to devices still
running the pre-rename build, which would lose their key. The rename must write
the new item and let it propagate **before** removing the old one.

## What this deletes

- `isUntouchedWorkspace` and its test suite
- `adoptAccountWorkspaces`, `accountWorkspaceToAdopt`,
  `shouldAdoptAccountWorkspaces`, and the `syncShouldAdoptAccountWorkspaces`
  bridge command
- the once-per-launch adoption reload guard in `OPShell.swift`
- the starter-profile marker key
- the tombstone-on-adoption path (`deleteProfile`'s tombstone stays — that is a
  different thing, and still needed)

## What changes

| File | Change |
|---|---|
| `src/sync/syncModel.js` | profile-scoped apply, stamping, recency and conflict paths |
| `src/sync/syncKeys.js` | unchanged — the credential refusal stands |
| `src/profiles.js` | the pre-boot account question; adoption and the predicate removed |
| `src/iosShell.js` | the account-registry question; profile list in the snapshot; adoption command removed |
| `src/main.js` | dependency wiring for the above |
| `src-tauri/ios/OPSync.swift` | all-profile zone set; per-record profile id on the fetch path; early shared fetch |
| `src-tauri/ios/OPShell.swift` | splash continuation; the launch handshake; profile switcher; toggle removed; purge suspension |
| `src-tauri/src/commands/secret.rs` | synchronizable keychain item + one-time upgrade on read miss |
| `gen/apple/project.yml` | `UILaunchScreen`, launch assets |

## Error handling

- **The account question fails or times out** → treated as `empty`. The device
  onboards as a fresh install. It is not an error state and shows no message.
- **A zone fails to fetch** → not fatal, exactly as today; the device runs on
  what it has and retries at the next start.
- **A unit arrives for a profile not in the local registry** → refused rather
  than written. A namespace with no registry entry is invisible to every listing
  and cannot be opened; the registry lands from `opShared` and the unit is
  offered again on a later fetch.
- **A foreign-profile write fails to reach disk** → the change tag is forfeited
  for that unit, under the same durability barrier as the active profile's. The
  barrier is not relaxed for foreign profiles.

## Testing

The apply path is where this can lose data, so that is where the tests go.

- A unit for a foreign profile lands in **that profile's** physical keys, on
  disk, and the active profile's keys are untouched. Assert both directions.
- The same unit id in two profiles resolves independently — no cross-talk
  through the stamp or the recency check.
- Every existing conflict, durability and echo-suppression test is re-run with a
  foreign profile as the subject, not only the active one.
- The launch handshake: `known` adopts and creates no starter, `empty` and
  `unavailable` both mint one and onboard.
- The keychain upgrade: a non-synchronizable item is found and re-saved once,
  and a second read does not re-save.

Swift has no test suite here and none is to be invented; in particular, no JS
test may read Swift source as a string. The splash, the switcher and the
handshake wiring are verified on device.

## What this does not solve

- **Desktop still has no sync.** macOS sync remains its own project (Tauri plus a
  Swift CloudKit helper), sequenced after the bundle-id rename.
- **Windows has no iCloud Keychain**, so the API key is still entered once per
  Windows machine.
- **Deleting a profile still leaves its zone and records in iCloud.** Reclaiming
  that needs content tombstones, which stay unbuilt.
- **There are still no CloudKit push notifications** (no `aps-environment`), so
  propagation rides CKSyncEngine's schedule plus foreground and activation.
