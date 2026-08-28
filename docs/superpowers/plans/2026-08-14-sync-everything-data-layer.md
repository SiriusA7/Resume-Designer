# Sync Everything — Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every profile's data syncs between a person's devices, not just the one that happens to be open, and the API key is entered once.

**Architecture:** The CloudKit zone set widens from `[activeProfileZone, opShared]` to every profile's zone plus `opShared`. Swift reports which zone each fetched record came from — the zone name *is* the profile id — and the JS model writes that unit into that profile's namespaced keys via `physicalKey(profileId, logicalKey)` rather than through the active-profile mapping. The API key becomes a synchronizable keychain item, carried by iCloud Keychain, never entering CloudKit.

**Tech Stack:** Rust (Tauri commands, `keyring` crate), Swift 6 / `@MainActor` (CKSyncEngine), JavaScript (framework-free service modules, vitest).

This is plan 1 of 2 for [2026-08-14-ios-sync-everything-design.md](../specs/2026-08-14-ios-sync-everything-design.md). Plan 2 covers the launch splash, the account handshake, the profile switcher, toggle removal and purge suspension.

## Global Constraints

- **Never commit, push, or open a PR without being explicitly asked.** Conventional commits, subjects start lowercase.
- **Frozen identifiers, never renamed:** desktop bundle id and keychain `SERVICE` `com.resumedesigner.app`; iOS bundle id `com.onpaper.app`; container `iCloud.com.onpaper.app`; every `resume-designer-*` / `resume-*` storage key; the `resume-designer/` directory.
- **Never sweep on the bare string `resume-`** — it also names the `.resume-page` / `.resume-sidebar` CSS classes pagination depends on.
- **Swift classifies nothing about a unit id.** Which zone a unit belongs to is the page's answer (`syncScopes`); which profile a *record* arrived in is a fact about the zone it came from, which Swift may report.
- **A durability barrier is never relaxed.** A change tag is kept only for bytes that reached disk — for foreign profiles exactly as for the active one.
- **There is no Swift test suite and none is to be invented.** Never write a JS test that reads Swift source as a string; this project did that once and deleted it.
- **Test the disk, not the cache.** Drive the real `appStorage` over an injected backend, as `test/syncConflict.test.js` and `test/syncDurableApply.test.js` already do.
- Baseline before this plan: **1511 passing tests, 0 lint errors, exactly 2 pre-existing warnings.**
- Gate: `cd resume-designer && npm run test && npm run lint`
- iOS build: `cd resume-designer && OP_SIM_UDID=7AC9B466-1F79-4091-8DAE-790CC3D8CE6B npm run ios:sim` — expects `Finished 1 iOS Bundle` and **zero** `error:` lines. Non-zero exit at the install step with no booted simulator is fine. If the build cannot run at all, say so plainly; never describe it as passing.
- **If a build touches `src-tauri/gen/apple/*.pbxproj`:** grep the diff for `PBXFileReference` and `PBXBuildFile` before reverting anything. Churn may be reverted; a line adding a **file to the target** must be kept. Blind-reverting has dropped Swift files from the target twice here.

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src-tauri/src/commands/secret.rs` | Keychain get/set, now storing a **synchronizable** item, with a one-time upgrade of a pre-existing local item |
| `src-tauri/ios/OPSync.swift` | Zone set covering every profile; reports each fetched record's zone as a profile id |
| `src-tauri/ios/OPShell.swift` | Passes the profile id through to the page with each fetched unit |
| `src/sync/syncModel.js` | `applyUnits` accepts per-unit profile ids and writes foreign profiles through `physicalKey` |
| `src/iosShell.js` | `syncApply` accepts the profile id per unit |
| `test/syncForeignProfile.test.js` | **New.** Foreign-profile landing, isolation, and durability |

---

### Task 1: The API key becomes a synchronizable keychain item

Independent of everything else in this plan. Do it first — it is the smallest deliverable and unblocks nothing, so it also cannot break anything downstream.

**Files:**
- Modify: `resume-designer/src-tauri/src/commands/secret.rs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no signature changes. `secret_get(name: String) -> Result<Option<String>, String>` and `secret_set(name: String, value: String) -> Result<(), String>` keep their exact shapes; only the underlying keychain attributes change.

**Background the implementer needs:** the crate in use is `keyring`. `Entry::new(SERVICE, name)` creates a non-synchronizable item. A synchronizable item is a **different item** as far as the keychain is concerned — a query for one does not match the other. That is why the upgrade in Step 3 exists: without it, every existing user's saved key reads as absent.

- [ ] **Step 1: Read the file and confirm the current shape**

Run: `sed -n '1,80p' resume-designer/src-tauri/src/commands/secret.rs`

Confirm `const SERVICE: &str = "com.resumedesigner.app";` is present and that `entry()` builds `Entry::new(SERVICE, name)`. **Do not change `SERVICE`.** It is frozen and shared with desktop; the comment above it says so.

- [ ] **Step 2: Check whether the installed `keyring` version exposes a synchronizable builder**

Run: `cd resume-designer/src-tauri && cargo tree -p keyring --depth 0`

The API differs by major version. If the version in use exposes an attribute/builder API for `kSecAttrSynchronizable`, use it. If it does **not**, implement the item with `security-framework` directly for the macOS/iOS target and keep `keyring` for other platforms behind `#[cfg]`. **Report which route the version forced**, with the version number, in your report — this determines how Plan 2 and the deferred bundle-id rename handle the same item.

- [ ] **Step 3: Write the get path so it upgrades a pre-existing local item exactly once**

The read tries the synchronizable item first. On a miss it looks for the legacy non-synchronizable item; if that exists, it re-saves the value as synchronizable and returns it. A second read then hits the first branch and does not re-save.

```rust
/// Read a secret.
///
/// `Ok(Some(v))` stored, `Ok(None)` no such entry, `Err` keychain unreachable.
/// See the module note — these three are load-bearing and distinct.
///
/// A synchronizable item and a local one are DIFFERENT items to the keychain: a
/// query for one never matches the other. So a miss here is not proof of
/// absence until the legacy local item has been looked for too, and finding one
/// upgrades it in place — once, because the next read matches the first branch.
#[tauri::command(async)]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match synchronizable_entry(&name)?.get_password() {
        Ok(v) => return Ok(Some(v)),
        Err(KeyringError::NoEntry) => {}
        Err(e) => return Err(format!("keychain read {name}: {e}")),
    }
    match local_entry(&name)?.get_password() {
        Ok(v) => {
            // Best effort: a failed upgrade must not hide a key the person has.
            let _ = synchronizable_entry(&name).and_then(|e| {
                e.set_password(&v).map_err(|e| format!("keychain upgrade {name}: {e}"))
            });
            Ok(Some(v))
        }
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read {name}: {e}")),
    }
}
```

- [ ] **Step 4: Write the set path**

Writes only the synchronizable item. Errors still propagate — the caller uses a successful return as its durability signal before deleting a plaintext original.

```rust
#[tauri::command(async)]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    synchronizable_entry(&name)?
        .set_password(&value)
        .map_err(|e| format!("keychain write {name}: {e}"))
}
```

- [ ] **Step 5: Keep the existing name-validation tests passing and add one for the new helpers**

The file already has `mod tests` with `accepts_app_secret_names`. Add a test that both helper constructors validate the name the same way, so a bad name cannot reach the keychain through the new path:

```rust
#[test]
fn both_entry_builders_reject_a_bad_name() {
    assert!(synchronizable_entry("bad name").is_err());
    assert!(local_entry("bad name").is_err());
}
```

- [ ] **Step 6: Run the Rust tests**

Run: `cd resume-designer/src-tauri && cargo test --lib commands::secret`
Expected: PASS, including the pre-existing `accepts_app_secret_names`.

- [ ] **Step 7: Type-check the Windows half**

Run: `cd resume-designer/src-tauri && cargo check --target x86_64-pc-windows-gnu`
Expected: exit 0. CI builds Windows nowhere, so this is the only check it gets. If you put the synchronizable path behind `#[cfg(target_vendor = "apple")]`, this is what proves the other branch still compiles.

- [ ] **Step 8: Build for iOS**

Run: `cd resume-designer && OP_SIM_UDID=7AC9B466-1F79-4091-8DAE-790CC3D8CE6B npm run ios:sim`
Expected: `Finished 1 iOS Bundle`, zero `error:` lines.

- [ ] **Step 9: Commit**

```bash
git add resume-designer/src-tauri/src/commands/secret.rs
git commit -m "feat(secret): carry the API key between devices via iCloud Keychain"
```

---

### Task 2: The zone set covers every profile

**Files:**
- Modify: `resume-designer/src-tauri/ios/OPSync.swift`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `OPSyncEngine.start(profileId:knownProfileIds:) async -> CKAccountStatus` — the existing `start(profileId:)` gains a second parameter naming every profile in the registry. `OPShell.swift`'s caller passes it in Task 3.

**Background:** zone creation is already idempotent-on-every-start and deliberately has no "have I made it yet" flag, because that is a second piece of state that can disagree with the server. Keep that property — add every profile's zone to `pendingDatabaseChanges` on every start, not just new ones.

- [ ] **Step 1: Read the current zone setup and fetch scope**

Run: `grep -n "zoneID\|sharedZoneID\|pendingDatabaseChanges\|nextFetchChangesOptions" resume-designer/src-tauri/ios/OPSync.swift | head -30`

Note the two stored zone properties and the `FetchChangesOptions(scope: .zoneIDs([...]))` construction. The comment above `nextFetchChangesOptions` explains the narrowing rule — **never advance a change token past records that are then dropped.** Widening is only safe because every zone in the new scope is genuinely handled; keep that sentence true and update the comment to say why it still holds.

- [ ] **Step 2: Widen `start` to take the full profile list**

Replace the single `zoneID` with a set derived from the passed ids, keeping `sharedZoneID` exactly as it is. Every id gets a zone saved on every start:

```swift
/// Every profile's zone, not only the open one: a profile's résumés are user
/// data whichever profile happens to be active, and a device that fetched only
/// the open one could never mirror the account. Saved on every start because
/// saving an existing zone is a no-op, and a "have I made it yet" flag is a
/// second piece of state that can disagree with the server.
func start(profileId: String, knownProfileIds: [String]) async -> CKAccountStatus {
```

Inside, build `profileZoneIDs` from `knownProfileIds` (deduplicated, and always including `profileId` even if the registry has not caught up), and add a `CKRecordZone` for each plus the shared zone to `pendingDatabaseChanges`.

- [ ] **Step 3: Widen the fetch scope**

`nextFetchChangesOptions` intersects the requested scope with what this device handles. That set becomes every profile zone plus the shared zone:

```swift
let zoneIDs = profileZoneIDs + [sharedZoneID]
let asked = zoneIDs.filter { context.options.scope.contains($0) }
options.scope = .zoneIDs(asked.isEmpty ? zoneIDs : asked)
```

- [ ] **Step 4: Build for iOS**

Run: `cd resume-designer && OP_SIM_UDID=7AC9B466-1F79-4091-8DAE-790CC3D8CE6B npm run ios:sim`
Expected: this **fails to compile** — `OPShell.swift` still calls `start(profileId:)` with one argument. That is the expected intermediate state; Task 3 fixes the caller. Record the error text in your report and continue.

- [ ] **Step 5: Do not commit yet**

This task does not compile on its own. Commit at the end of Task 3, which restores a building tree.

---

### Task 3: Each fetched unit carries the profile it belongs to

**Files:**
- Modify: `resume-designer/src-tauri/ios/OPSync.swift`
- Modify: `resume-designer/src-tauri/ios/OPShell.swift`
- Modify: `resume-designer/src/iosShell.js`

**Interfaces:**
- Consumes: `start(profileId:knownProfileIds:)` from Task 2.
- Produces: the `syncApply` bridge command now receives units shaped `{ id, kind, payload, modifiedAt, profileId }`. `deps.applyUnits(units)` is called with that shape; Task 4 makes the model honour it.

**Background:** a `CKRecord.ID` carries its zone, and the zone's name **is** the profile id — that is how `send` already routes, in reverse. Reporting it is not classification: Swift is stating which zone a record arrived in, not deciding what the unit means.

- [ ] **Step 1: Read how a fetched record becomes a `SyncUnit`**

Run: `grep -n "SyncUnit(\|syncDidFetch\|func handle" resume-designer/src-tauri/ios/OPSync.swift | head -20`

Find where a fetched `CKRecord` is turned into the struct handed to `syncDidFetch`.

- [ ] **Step 2: Add the profile id to `SyncUnit`**

Add a `profileId: String` field, populated from `record.recordID.zoneID.zoneName`. For a record from the shared zone, set it to the empty string — the shared zone belongs to the account, not a profile, and Task 4 treats empty as "the shared/unnamespaced key".

- [ ] **Step 3: Pass it across the bridge**

In `OPShell.swift`, where units are JSON-encoded for `syncApply`, include `profileId`. Keep every existing field and its name unchanged.

- [ ] **Step 4: Accept it in the bridge handler**

`src/iosShell.js`, the `syncApply` command. It currently parses an array and hands it to `deps.applyUnits`. The only change is the comment — the shape gained a field and the handler still refuses a malformed batch **synchronously**, which is what makes it a refusal on either entry point rather than an answer on one:

```js
    // Each unit now names the profile whose zone it arrived in — `''` for the
    // shared zone. Swift is reporting a fact about the record's zone, not
    // deciding what the unit is; see `syncScopes` for the same seam in reverse.
    syncApply: ({ units }) => {
      const parsed = JSON.parse(String(units ?? '[]'));
      if (!Array.isArray(parsed)) throw new Error('syncApply needs an array of units');
      return deps.applyUnits(parsed);
    },
```

- [ ] **Step 5: Fix the `start` call site**

In `OPShell.swift`, pass the profile list. The shell has no workspace list of its own — that is Plan 2's job — so for now derive it by asking the page through the existing snapshot, or pass `[profileId]` and **note in your report that the list is still a single id**, which keeps behaviour identical to today until Plan 2 supplies the real list. Do not invent a workspace list in Swift.

- [ ] **Step 6: Build for iOS**

Run: `cd resume-designer && OP_SIM_UDID=7AC9B466-1F79-4091-8DAE-790CC3D8CE6B npm run ios:sim`
Expected: `Finished 1 iOS Bundle`, zero `error:` lines.

- [ ] **Step 7: Run the JS gate**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: 1511 passing, 0 errors, 2 warnings. Nothing in the model reads `profileId` yet, so no test should change.

- [ ] **Step 8: Commit both tasks together**

```bash
git add resume-designer/src-tauri/ios/OPSync.swift resume-designer/src-tauri/ios/OPShell.swift resume-designer/src/iosShell.js
git commit -m "feat(sync): fetch every profile's zone and name the profile each unit came from"
```

---

### Task 4: The model applies a foreign profile's unit to that profile's keys

The one task in this plan that can lose data. Everything above it is plumbing.

**Files:**
- Modify: `resume-designer/src/sync/syncModel.js:935-1010`
- Create: `resume-designer/test/syncForeignProfile.test.js`

**Interfaces:**
- Consumes: units shaped `{ id, kind, payload, modifiedAt, profileId }` from Task 3.
- Produces: `applyUnits(units)` keeps its signature and its `{ applied: number }` return.

**Background the implementer must read before touching anything:**

`appStorage` namespaces every key to the **active** profile via `setProfileMapping`. `mapKey` (in `src/profileKeys.js`) short-circuits when handed a key that is already physical, so `appStorage.setItem(physicalKey(id, logical), v)` writes that exact key regardless of which profile is active. That is the whole mechanism — no new storage primitive is needed.

Read `landFetchedUnits` (line 962) in full first. Every filter it applies exists for a reason written in the comment above it.

- [ ] **Step 1: Write the failing tests**

Create `resume-designer/test/syncForeignProfile.test.js`. Copy the harness shape from `test/syncConflict.test.js` — the real `appStorage` over `makeBackend()`, `initAppStorage({ backend })`, and `setProfileMapping(...)` to make one profile active.

```js
/**
 * A UNIT FROM ANOTHER PROFILE'S ZONE LANDS IN THAT PROFILE'S KEYS.
 *
 * Every profile syncs now, so a fetch arrives for profiles that are not open.
 * The active mapping must not capture them: a résumé belonging to profile B
 * written into profile A's namespace is both a loss for B and a corruption of
 * A, and neither is visible until someone switches.
 */
it('lands a foreign profile unit in that profile keys, not the active ones', async () => {
  setProfileMapping('pactive');
  const unit = {
    id: 'resume:v-9',
    kind: 'resume',
    payload: JSON.stringify({ id: 'v-9', name: 'Theirs', data: { name: 'Bo' } }),
    modifiedAt: NEW,
    profileId: 'pother',
  };

  expect(await applyUnits([unit])).toEqual({ applied: 1 });

  const theirs = JSON.parse(backend.files.get(physicalKey('pother', DATA)));
  expect(theirs.variants['v-9'].data).toEqual({ name: 'Bo' });
  expect(backend.files.get(physicalKey('pactive', DATA)) ?? '{}').not.toContain('v-9');
});

it('keeps the same unit id in two profiles independent', async () => {
  setProfileMapping('pactive');
  await applyUnits([
    { id: 'resume:v-1', kind: 'resume', payload: JSON.stringify({ id: 'v-1', name: 'Mine', data: { name: 'A' } }), modifiedAt: NEW, profileId: 'pactive' },
    { id: 'resume:v-1', kind: 'resume', payload: JSON.stringify({ id: 'v-1', name: 'Theirs', data: { name: 'B' } }), modifiedAt: NEW, profileId: 'pother' },
  ]);

  expect(JSON.parse(backend.files.get(physicalKey('pactive', DATA))).variants['v-1'].data).toEqual({ name: 'A' });
  expect(JSON.parse(backend.files.get(physicalKey('pother', DATA))).variants['v-1'].data).toEqual({ name: 'B' });
});

it('refuses to acknowledge a foreign landing that did not reach disk', async () => {
  setProfileMapping('pactive');
  backend.fail.add(physicalKey('pother', DATA));

  expect(await applyUnits([{
    id: 'resume:v-9', kind: 'resume',
    payload: JSON.stringify({ id: 'v-9', name: 'Theirs', data: { name: 'Bo' } }),
    modifiedAt: NEW, profileId: 'pother',
  }])).toEqual({ applied: 0 });
});
```

- [ ] **Step 2: Run them against the current code to see them fail for the right reason**

Run: `cd resume-designer && npx vitest run test/syncForeignProfile.test.js`
Expected: FAIL. The first two fail because the unit lands in `pactive`'s keys — **confirm that is the reason in the failure output**, not a missing import. A test that fails for the wrong reason is pinning nothing.

- [ ] **Step 3: Add the key resolver**

One helper decides every storage key in this file. An empty or absent `profileId` means the active profile, which preserves today's behaviour for every existing caller and test.

```js
/**
 * The storage key a fetched unit's bytes belong under.
 *
 * A unit names the profile whose ZONE it arrived in. For the open profile that
 * is the ordinary logical key, which `appStorage` maps as usual. For any other
 * it is that profile's PHYSICAL key: `mapKey` short-circuits on an already
 * physical key, so this writes exactly there rather than through the active
 * mapping — which would put another person's résumé in the open workspace and
 * lose it from its own, neither visible until somebody switches.
 */
function storageKeyFor(profileId, logicalKey) {
  if (!profileId || profileId === getActiveProfileId()) return logicalKey;
  return physicalKey(profileId, logicalKey);
}
```

Import `physicalKey` from `../profileKeys.js` and `getActiveProfileId` / `listProfiles` from `../profiles.js`.

And the grouping Step 4 uses. Insertion order is preserved, so the active profile's group lands in the same relative order it does today:

```js
/** Fetched units bucketed by the profile whose zone each arrived in. */
function groupByProfile(units) {
  const groups = new Map();
  for (const unit of units) {
    const id = typeof unit?.profileId === 'string' ? unit.profileId : '';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(unit);
  }
  return groups;
}
```

- [ ] **Step 4: Route the blob write and the live-state adopters by profile**

`landing` currently writes one `DATA_KEY` and then tells the live holders to adopt. Group it by profile: each group writes its own blob, and **only the active profile's group adopts**, because a foreign profile has no open document, no module cache and no history store to keep in step.

```js
  for (const [profileId, group] of groupByProfile(landing)) {
    const dataKey = storageKeyFor(profileId, DATA_KEY);
    const blob = readJSON(dataKey, {});
    appStorage.setItem(dataKey, JSON.stringify(mergeData(blob, group)));
    applied += group.length;
    // AFTER the storage write, never before: the store is what the screen
    // reads, and putting a résumé there that the write then failed to persist
    // (quota) would show the user content this device does not hold.
    //
    // Only for the OPEN profile. Another profile has no mounted editor and no
    // loaded document, so there is nothing to hand these bytes to — and
    // handing them over anyway would show one workspace's résumé inside
    // another.
    if (dataKey !== DATA_KEY) continue;
    for (const unit of group) {
      if (unit.id.startsWith(RESUME_UNIT_PREFIX)) adoptLoadedDocument(unit);
      else if (unit.id === USER_PROFILE_UNIT_ID) adoptStoredUserProfile();
    }
  }
```

- [ ] **Step 5: Route the `key:` loop the same way**

In the loop over `incoming`, the snapshot write becomes profile-aware, and so does the stamp it is checked against — `SYNC_STATE_KEY` is itself a per-profile key, so a foreign unit compared against the **active** profile's stamps would land or refuse for the wrong reason entirely:

```js
    const recordedForUnit = stateFor(unit.profileId);
    ...
      if (!outranksLocalCopy(unit, recordedForUnit)) continue;
      appStorage.setItem(storageKeyFor(unit.profileId, key), unit.payload);
```

Give `state()` a `stateFor(profileId)` sibling that reads `storageKeyFor(profileId, SYNC_STATE_KEY)`, and make the accumulator path (`accumulate(key, unit)`) take the profile too, so a union merges into the right namespace. The résumé path in Step 4 needs the same treatment where it calls `outranksLocalCopy`.

**Every stamp written after a landing goes to the same profile's `SYNC_STATE_KEY`.** A stamp in the wrong namespace is the recency-guard bug this feature has already produced twice.

- [ ] **Step 6: Refuse a unit for a profile the registry does not list**

A namespace with no registry entry is invisible to every listing and cannot be opened, so writing one strands the bytes. Refuse instead; `opShared` lands the registry, and the unit is offered again on a later fetch.

```js
    // A profile the registry does not list cannot be opened or listed, so its
    // namespace would be unreachable bytes. The registry lands from opShared and
    // this unit comes back on the next fetch.
    if (profileId && !listProfiles().some((p) => p.id === profileId)) return false;
```

- [ ] **Step 7: Run the new tests**

Run: `cd resume-designer && npx vitest run test/syncForeignProfile.test.js`
Expected: PASS, all three.

- [ ] **Step 8: Verify by mutation**

Make the profile-aware write ignore `profileId` and always use the active mapping. Re-run. Expected: the first two tests FAIL. Restore the fix. **Report this result explicitly** — a test for this property that passes against the old code is testing the wrong thing.

- [ ] **Step 9: Re-run every existing sync suite with a foreign profile as the subject**

The existing conflict, durability and echo-suppression suites all assume the active profile. For each of `test/syncConflict.test.js`, `test/syncDurableApply.test.js` and `test/syncModel.test.js`, add a foreign-profile case for the behaviours that are about **landing**: refusal on a failed flush, the recency guard, and echo suppression. Do not duplicate cases that are purely about `collectUnit`, which only ever reads the active profile.

- [ ] **Step 10: Run the full gate**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: all passing (count above 1511 by however many you added), 0 lint errors, exactly 2 pre-existing warnings.

- [ ] **Step 11: Build for iOS**

Run: `cd resume-designer && OP_SIM_UDID=7AC9B466-1F79-4091-8DAE-790CC3D8CE6B npm run ios:sim`
Expected: `Finished 1 iOS Bundle`, zero `error:` lines.

- [ ] **Step 12: Commit**

```bash
git add resume-designer/src/sync/syncModel.js resume-designer/test/
git commit -m "feat(sync): land a fetched unit in the profile whose zone it came from"
```

---

## After this plan

The data layer is done: every profile's zone is fetched, and each unit lands in
its own namespace under the same durability barrier as the active profile's.

**Not yet reachable by a person.** Sync is still behind the Settings toggle,
which is still behind onboarding, and there is still no way to switch profiles on
iOS. Plan 2 removes the toggle, adds the purge-suspension state, builds the
launch splash and the account handshake, and adds the profile switcher — and only
then does the two-device test from the spec become meaningful.
