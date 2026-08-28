# Sync Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a clean install discover and adopt the profiles and résumés already in the account's iCloud, which it currently cannot do at all.

**Architecture:** Shared storage keys move to a fixed CloudKit zone (`opShared`) whose name any device knows without discovering anything, breaking the cycle where the profile registry lived inside the zones it was supposed to reveal. The registry becomes a union-merged log with per-entry timestamps and a metadata-only tombstone. A fresh device unions the remote registry into its own and absorbs its throwaway local workspace only when that workspace is provably untouched.

**Tech Stack:** JavaScript (ES modules, vitest), Swift 6 / SwiftUI, CloudKit `CKSyncEngine`, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-08-13-sync-bootstrap-design.md`. Read it first — it carries the reasoning this plan only implements.

## Global Constraints

- **Swift never parses a payload**, and after commit `124fc2c` it no longer makes model decisions either. Which zone a unit belongs to is a MODEL decision: JS decides, Swift routes. Never pattern-match a unit id in Swift.
- **Never hold a change tag for content that is not durably ours.** This feature has produced eight bugs of exactly that shape. An apply is not confirmed until `appStorage.flush()` answers true.
- **Absence is never deletion.** A unit that cannot be read, parsed or merged must refuse — never write an empty or partial payload. The single exception in this plan is the registry's `deletedAt`, which hides a listing and destroys no content.
- **Storage keys are frozen.** Never rename a `resume-designer-*` / `resume-*` key. Never sweep on the bare string `resume-` — it also names the `.resume-page` / `.resume-sidebar` CSS classes pagination depends on.
- **`syncModel.js`'s `applying` echo-suppression flag is safe only because the landing path is entirely synchronous** and the flag is restored before the single `await`. Do not introduce an await inside that window.
- Comparisons of strings that must agree across devices use code-unit order, never `localeCompare` — it returns 0 for Unicode-equivalent strings and has already caused one ordering bug here. `byCodeUnit` exists in `src/sync/syncMerge.js`.
- iOS floor 26.0. Container `iCloud.com.onpaper.app`. Private database.
- The same JS runs on desktop, where there is no native shell; every native call site must no-op there.
- Conventional commits, subjects start lowercase. **Never push.**
- Gate before every commit, from `resume-designer/`: `npm run test`, `npm run lint` (2 pre-existing warnings are the baseline), `npx vite build`. Swift changes additionally need `OP_SIM_UDID=373A2871-FDB2-4572-9820-916F108E37AB npm run ios:sim` with no `error:` lines. If that build modifies `src-tauri/gen/apple/*.pbxproj`, grep the diff for `PBXFileReference` and `PBXBuildFile` before reverting anything — churn may be reverted, a line adding a file to the target must be kept.
- There is no Swift test target. Do not create one, and **never write JS tests that read Swift source as a string** — that was done here once and deleted, because asserting tokens are present is not asserting behaviour.

## File Structure

| File | Responsibility for this feature |
| --- | --- |
| `src/sync/syncMerge.js` | `mergeRegistry` — pure union of two registries. Joins `mergeHistory`/`mergeTokenUsage`. |
| `src/sync/syncKeys.js` | Answer whether a synced key is shared or profile-scoped. |
| `src/sync/syncModel.js` | Stamp each unit's `scope`; route the registry unit through `mergeRegistry`. |
| `src/profiles.js` | `updatedAt` / `deletedAt` on entries; filter tombstoned entries from listings; the untouched-workspace test; the adoption flow. |
| `src-tauri/ios/OPSync.swift` | Create the `opShared` zone; widen the fetch scope; route a unit to a zone by its `scope`. |
| `src-tauri/ios/OPShell.swift` | Fetch the shared zone before the profile zone on start. |

---

### Task 1: `mergeRegistry`

A pure function, testable with no storage and no bridge. It must be order-independent: both devices merging the same two registries produce byte-identical output.

**Files:**
- Modify: `resume-designer/src/sync/syncMerge.js`
- Test: `resume-designer/test/syncMerge.test.js`

**Interfaces:**
- Consumes: `byCodeUnit` (already in `syncMerge.js`, used by `mergeHistory`).
- Produces: `export function mergeRegistry(a, b)` taking two arrays of profile entries (or non-arrays, treated as empty) and returning a new array.

An entry is `{ id, name, emoji, createdAt, updatedAt?, deletedAt? }`. `id` and `createdAt` are set at creation and never change.

- [ ] **Step 1: Write the failing tests**

Append to `resume-designer/test/syncMerge.test.js`:

```js
describe('mergeRegistry', () => {
  const A = { id: 'pa', name: 'Work', emoji: '🙂', createdAt: '2026-01-01T00:00:00.000Z' };
  const B = { id: 'pb', name: 'Side', emoji: '🚀', createdAt: '2026-02-01T00:00:00.000Z' };

  it('unions entries neither side has alone', () => {
    expect(mergeRegistry([A], [B]).map((p) => p.id)).toEqual(['pa', 'pb']);
  });

  it('is order-independent', () => {
    expect(mergeRegistry([A], [B])).toEqual(mergeRegistry([B], [A]));
  });

  it('takes the entry with the newer updatedAt', () => {
    const renamed = { ...A, name: 'Renamed', updatedAt: '2026-03-01T00:00:00.000Z' };
    expect(mergeRegistry([A], [renamed])[0].name).toBe('Renamed');
    expect(mergeRegistry([renamed], [A])[0].name).toBe('Renamed');
  });

  it('prefers a stamped entry over an unstamped one', () => {
    const stamped = { ...A, name: 'Stamped', updatedAt: '2026-03-01T00:00:00.000Z' };
    expect(mergeRegistry([A], [stamped])[0].name).toBe('Stamped');
    expect(mergeRegistry([stamped], [A])[0].name).toBe('Stamped');
  });

  it('keeps the local entry when neither is stamped', () => {
    const other = { ...A, name: 'Other' };
    expect(mergeRegistry([A], [other])[0].name).toBe('Work');
  });

  it('retains a tombstone rather than resurrecting the entry', () => {
    const deleted = { ...A, deletedAt: '2026-03-01T00:00:00.000Z' };
    const merged = mergeRegistry([A], [deleted]);
    expect(merged).toHaveLength(1);
    expect(merged[0].deletedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('lets a rename after a deletion win, since it is newer', () => {
    const deleted = { ...A, deletedAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' };
    const revived = { ...A, name: 'Back', updatedAt: '2026-04-01T00:00:00.000Z' };
    expect(mergeRegistry([deleted], [revived])[0].deletedAt).toBeUndefined();
  });

  it('ignores non-arrays and non-entries', () => {
    expect(mergeRegistry(null, undefined)).toEqual([]);
    expect(mergeRegistry([A, null, 7, { name: 'no id' }], [])).toEqual([A]);
  });

  it('orders by createdAt then id, by code unit', () => {
    const sameDay = { id: 'pz', name: 'Z', emoji: '🙂', createdAt: A.createdAt };
    expect(mergeRegistry([sameDay], [A]).map((p) => p.id)).toEqual(['pa', 'pz']);
  });
});
```

Add `mergeRegistry` to the file's existing import from `../src/sync/syncMerge.js`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd resume-designer && npx vitest run test/syncMerge.test.js`
Expected: FAIL — `mergeRegistry is not a function`.

- [ ] **Step 3: Implement**

Add to `resume-designer/src/sync/syncMerge.js`, beside `mergeHistory`:

```js
/**
 * Union two profile registries.
 *
 * The registry is APPEND-SHAPED for creation and SNAPSHOT-SHAPED per entry, so
 * it takes neither rule wholesale: entries union by id, and a collision is
 * settled by `updatedAt`. Under plain newer-wins a profile created offline on
 * one device disappeared when the other device's registry won, and its résumés
 * were orphaned in a zone nothing listed.
 *
 * A tombstoned entry is RETAINED, not dropped — dropping it lets the other
 * side's copy resurrect it on the next merge. See the spec: this is the one
 * deliberate tombstone in the feature, and it hides a listing rather than
 * destroying content.
 */
export function mergeRegistry(a, b) {
  const entries = new Map();
  for (const registry of [a, b]) {
    for (const entry of Array.isArray(registry) ? registry : []) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string' || !entry.id) continue;
      const existing = entries.get(entry.id);
      if (!existing || outranks(entry, existing)) entries.set(entry.id, entry);
    }
  }

  // Stable across devices: `createdAt` never changes after creation, and the id
  // breaks a tie. Both comparisons are by code unit — `localeCompare` returns 0
  // for Unicode-equivalent strings, which has already cost this feature one
  // ordering bug.
  return [...entries.values()].sort((x, y) =>
    byCodeUnit(String(x.createdAt ?? ''), String(y.createdAt ?? ''))
    || byCodeUnit(x.id, y.id));
}

/**
 * Whether `candidate` should replace `held`. An unstamped entry cannot win a
 * claim it never made, which is the same reading `resolveConflict` gives an
 * absent `modifiedAt`. Equal stamps keep the held entry, so the result does not
 * depend on which registry was read first.
 */
function outranks(candidate, held) {
  const at = (entry) => (typeof entry.updatedAt === 'string' ? entry.updatedAt : '');
  return byCodeUnit(at(candidate), at(held)) > 0;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd resume-designer && npx vitest run test/syncMerge.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd resume-designer && npm run test && npm run lint && npx vite build
git add resume-designer/src/sync/syncMerge.js resume-designer/test/syncMerge.test.js
git commit -m "feat(sync): union two profile registries instead of picking one"
```

---

### Task 2: registry entries carry `updatedAt` and `deletedAt`

`mergeRegistry` needs those fields to exist. Nothing writes them yet.

**Files:**
- Modify: `resume-designer/src/profiles.js` — `createProfile` (~:531), `renameProfile` (~:546), `deleteProfile` (~:570), `loadRegistry` (~:66)
- Test: `resume-designer/test/profiles.test.js`

**Interfaces:**
- Produces: entries shaped `{ id, name, emoji, createdAt, updatedAt?, deletedAt? }`; `export function listProfiles()` returning only non-tombstoned entries.

- [ ] **Step 1: Write the failing tests**

Append to `resume-designer/test/profiles.test.js`:

```js
describe('registry entry stamps', () => {
  it('stamps updatedAt on rename', () => {
    const created = createProfile({ name: 'Work' });
    expect(created.updatedAt).toBeUndefined();
    renameProfile(created.id, { name: 'Renamed' });
    const entry = loadRegistry().find((p) => p.id === created.id);
    expect(entry.name).toBe('Renamed');
    expect(typeof entry.updatedAt).toBe('string');
  });

  it('tombstones on delete instead of dropping the entry', () => {
    const created = createProfile({ name: 'Doomed' });
    deleteProfile(created.id);
    const entry = loadRegistry().find((p) => p.id === created.id);
    expect(entry).toBeDefined();
    expect(typeof entry.deletedAt).toBe('string');
    expect(typeof entry.updatedAt).toBe('string');
  });

  it('hides tombstoned profiles from the listing', () => {
    const kept = createProfile({ name: 'Kept' });
    const gone = createProfile({ name: 'Gone' });
    deleteProfile(gone.id);
    const ids = listProfiles().map((p) => p.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(gone.id);
  });
});
```

Import `listProfiles` alongside the existing profile imports in that file.

- [ ] **Step 2: Run and watch them fail**

Run: `cd resume-designer && npx vitest run test/profiles.test.js`
Expected: FAIL — `listProfiles is not a function`, and the delete test failing because the entry is gone.

- [ ] **Step 3: Implement**

In `renameProfile`, add the stamp to the patched entry:

```js
export function renameProfile(id, { name, emoji }) {
  const registry = loadRegistry() || [];
  saveRegistry(registry.map((p) => (p.id === id
    ? {
      ...p,
      ...(name !== undefined ? { name } : {}),
      ...(emoji !== undefined ? { emoji } : {}),
      // mergeRegistry settles a collision on this stamp. Without it a rename on
      // one device loses to an unstamped entry on another.
      updatedAt: new Date().toISOString(),
    }
    : p)));
}
```

In `deleteProfile`, replace the entry-dropping write with a tombstone. Read the existing body first — it also removes the profile's local namespace, and that behaviour is unchanged. Only the registry write changes:

```js
  // TOMBSTONE, not a drop. Under a union merge a dropped entry is restored by
  // the other device's copy on the next sync, and the workspace reappears
  // forever. This is metadata: it hides a listing and destroys no content —
  // the profile's résumés are removed locally by the code below exactly as
  // before, and its CloudKit zone is left alone.
  const stamp = new Date().toISOString();
  saveRegistry(registry.map((p) => (p.id === id
    ? { ...p, deletedAt: stamp, updatedAt: stamp }
    : p)));
```

Add the listing helper beside `loadRegistry`:

```js
/**
 * The profiles a person should see. `loadRegistry` returns the raw array,
 * tombstones included, because the merge needs them; every UI and every
 * iteration over "the profiles" wants this instead.
 */
export function listProfiles() {
  return (loadRegistry() || []).filter((p) => !p?.deletedAt);
}
```

Then find every existing consumer of `loadRegistry()` that iterates profiles for display or selection, and switch it to `listProfiles()`. Run `rg 'loadRegistry\(' resume-designer/src` and judge each call site: anything that merges, rebuilds or persists the registry keeps `loadRegistry`; anything that lists, counts or picks a profile takes `listProfiles`. State in your report which call sites you changed and which you deliberately left.

- [ ] **Step 4: Run and watch them pass**

Run: `cd resume-designer && npx vitest run test/profiles.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd resume-designer && npm run test && npm run lint && npx vite build
git add resume-designer/src/profiles.js resume-designer/test/profiles.test.js
git commit -m "feat(profiles): stamp registry entries and tombstone instead of dropping"
```

---

### Task 3: units carry a scope, and the registry merges

Swift must route a unit to a zone without knowing what the unit is. JS decides.

**Files:**
- Modify: `resume-designer/src/sync/syncKeys.js`, `resume-designer/src/sync/syncModel.js`
- Test: `resume-designer/test/syncKeys.test.js`, `resume-designer/test/syncModel.test.js`

**Interfaces:**
- Consumes: `mergeRegistry` from Task 1; `SYNCED_SHARED_KEYS` (already in `syncKeys.js`).
- Produces: `export function keyScope(logicalKey)` returning `'shared' | 'profile'`; every unit from `collectUnits` / `collectUnit` carrying `scope`; `accumulatorFor` routing the registry key to a new `landRegistry`.

- [ ] **Step 1: Write the failing tests**

Append to `resume-designer/test/syncKeys.test.js`:

```js
describe('keyScope', () => {
  it('calls the profile registry shared', () => {
    expect(keyScope('resume-designer-profiles')).toBe('shared');
  });

  it('calls every other synced key profile-scoped', () => {
    expect(keyScope('resume-designer-applications')).toBe('profile');
    expect(keyScope('resume-designer-token-usage')).toBe('profile');
  });
});
```

Append to `resume-designer/test/syncModel.test.js`:

```js
describe('unit scope', () => {
  it('marks the registry unit shared and résumé units profile-scoped', () => {
    const units = collectUnits();
    const registry = units.find((u) => u.id === 'key:resume-designer-profiles');
    expect(registry?.scope).toBe('shared');
    for (const unit of units.filter((u) => u.id.startsWith('resume:'))) {
      expect(unit.scope).toBe('profile');
    }
  });
});

describe('registry landing', () => {
  it('unions an incoming registry instead of replacing it', () => {
    // Seed a local registry with one profile, apply a remote unit naming
    // another, and assert both survive.
    const local = [{ id: 'pa', name: 'Local', emoji: '🙂', createdAt: '2026-01-01T00:00:00.000Z' }];
    const remote = [{ id: 'pb', name: 'Remote', emoji: '🚀', createdAt: '2026-02-01T00:00:00.000Z' }];
    appStorage.setItem('resume-designer-profiles', JSON.stringify(local));
    applyUnits([{ id: 'key:resume-designer-profiles', kind: 'plain', payload: JSON.stringify(remote), modifiedAt: '2026-03-01T00:00:00.000Z' }]);
    const merged = JSON.parse(appStorage.getItem('resume-designer-profiles'));
    expect(merged.map((p) => p.id).sort()).toEqual(['pa', 'pb']);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd resume-designer && npx vitest run test/syncKeys.test.js test/syncModel.test.js`
Expected: FAIL — `keyScope is not a function`, `scope` undefined, and the registry replaced rather than unioned.

- [ ] **Step 3: Implement**

In `resume-designer/src/sync/syncKeys.js`:

```js
/**
 * Which CloudKit zone a synced key's unit belongs in.
 *
 * SHARED keys describe the workspace set itself and cannot live inside a
 * per-profile zone — that is the bootstrap cycle: a clean device needs the
 * registry to learn the profile ids, and the ids to fetch the zone holding the
 * registry. See docs/superpowers/specs/2026-08-13-sync-bootstrap-design.md.
 *
 * Swift routes on this answer and never inspects a unit id, which is what keeps
 * zone choice a model decision.
 */
export function keyScope(logicalKey) {
  return SYNCED_SHARED_KEYS.includes(logicalKey) ? 'shared' : 'profile';
}
```

In `resume-designer/src/sync/syncModel.js`, add `scope` where units are built. `collectKeyUnit` (~:723) returns the object shown in its body — add `scope: keyScope(key)`. The blob's `resume:` and `data:` units are always profile-scoped; add `scope: 'profile'` where `collectDataUnits` builds them.

Add the registry lander and route to it from `accumulatorFor` (~:434):

```js
function accumulatorFor(key) {
  if (key === TOKEN_KEY) return landTokenUsage;
  if (key.startsWith(HISTORY_PREFIX)) return landHistory;
  // The registry is append-shaped for creation and snapshot-shaped per entry;
  // mergeRegistry is the only merge that reads both.
  if (key === PROFILES_KEY) return landRegistry;
  return null;
}
```

```js
/**
 * Union an incoming registry into what this device holds.
 *
 * `false` when the payload will not parse or is not an array, which shortens
 * `applied` exactly as every other refusal here does — absence is never
 * deletion, and a registry that cannot be read is one this device has nothing
 * to say about.
 */
function landRegistry(key, payload) {
  let incoming;
  try {
    incoming = JSON.parse(payload);
  } catch {
    return false;
  }
  if (!Array.isArray(incoming)) return false;
  const local = readJSON(key, null);
  appStorage.setItem(key, JSON.stringify(mergeRegistry(local, incoming)));
  return true;
}
```

Import `mergeRegistry` from `./syncMerge.js` and `keyScope` from `./syncKeys.js`, and define `PROFILES_KEY` beside the other key constants using the same value `syncKeys.js` uses — do not write the literal twice; import it if `syncKeys.js` exports it, and export it if it does not.

**Both landers run inside the `applying` window and must stay synchronous.** `landRegistry` above is.

- [ ] **Step 4: Run and watch them pass**

Run: `cd resume-designer && npx vitest run test/syncKeys.test.js test/syncModel.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd resume-designer && npm run test && npm run lint && npx vite build
git add resume-designer/src/sync resume-designer/test/syncKeys.test.js resume-designer/test/syncModel.test.js
git commit -m "feat(sync): give every unit a scope and union the registry on landing"
```

---

### Task 4: the shared zone

**Files:**
- Modify: `resume-designer/src-tauri/ios/OPSync.swift`, `resume-designer/src-tauri/ios/OPShell.swift`

**Interfaces:**
- Consumes: `scope` on each unit, from Task 3.
- Produces: a second zone, created and fetched alongside the profile's.

- [ ] **Step 1: Add the zone name and the scope field**

In `OPSync.swift`, beside the other file-level constants:

```swift
/// The zone holding units that describe the workspace SET rather than any one
/// workspace. Its name is a fixed literal and never derived, so a device that
/// knows nothing can still fetch it — that is the whole point.
///
/// It cannot collide with a profile zone: `generateProfileId()` returns
/// `p` + base36 timestamp + suffix, so every profile zone name begins with `p`.
/// It is not a reserved name either — CloudKit reserves the leading underscore,
/// which this does not use.
let opSharedZoneName = "opShared"
```

Add to `SyncUnit`:

```swift
  /// "shared" | "profile" — which zone this unit belongs in, decided by the
  /// model. Optional so a unit encoded before this field existed still decodes;
  /// absent means profile-scoped, which is what every unit was.
  let scope: String?
```

- [ ] **Step 2: Create the zone on start**

Find where `start(profileId:)` adds the profile zone to `pendingDatabaseChanges` and add the shared zone the same way. Saving a zone that already exists is a no-op, which is why this is queued on every start rather than tracked — the existing comment there says so; keep the two together so the reasoning covers both.

- [ ] **Step 3: Widen the fetch scope**

In `nextFetchChangesOptions`, return both zone ids instead of one. The existing comment explains why the scope was narrowed — that reasoning still holds and must be preserved: a token must never advance past records that are then dropped. Both zones' records are genuinely handled, so both belong in the scope. Update the comment to say so rather than deleting it.

- [ ] **Step 4: Route a save by scope**

Where a unit's `CKRecord.ID` is built for a save, choose the zone from the unit's `scope` rather than always using the profile zone. **Do not pattern-match the unit id.** A unit whose scope is absent is profile-scoped.

- [ ] **Step 5: Fetch shared before profile**

In `OPShell.swift`'s start path, ensure the shared zone's records are fetched before the profile zone's. The spec makes this load-bearing: a fresh device owes a full upload on first enable, and if that upload ran before the shared fetch it would put the throwaway local workspace on the server before the merge could see the remote registry.

- [ ] **Step 6: Build**

```bash
cd resume-designer && OP_SIM_UDID=373A2871-FDB2-4572-9820-916F108E37AB npm run ios:sim
```
Expected: no `error:` lines. Revert pbxproj churn only after grepping it for `PBXFileReference` and `PBXBuildFile`.

- [ ] **Step 7: Commit**

```bash
git add resume-designer/src-tauri/ios
git commit -m "feat(sync): give shared units a zone any device can find"
```

---

### Task 5: fresh-device adoption

**Files:**
- Modify: `resume-designer/src/profiles.js`
- Test: `resume-designer/test/profiles.test.js`

**Interfaces:**
- Consumes: `listProfiles`, the tombstone from Task 2; `mergeRegistry` from Task 1.
- Produces: `export function isUntouchedWorkspace(profileId)` returning a boolean.

- [ ] **Step 1: Write the failing tests — one per clause**

The predicate is the only step in this feature that can discard a workspace, so every clause gets a test proving that violating **that clause alone** keeps it. Append to `resume-designer/test/profiles.test.js`:

```js
describe('isUntouchedWorkspace', () => {
  it('is true for a workspace straight out of init', () => {
    const fresh = createProfile({ name: 'Fresh' });
    expect(isUntouchedWorkspace(fresh.id)).toBe(true);
  });

  it('is false once renamed', () => {
    const p = createProfile({ name: 'P' });
    renameProfile(p.id, { name: 'Renamed' });
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('is false when any version history exists', () => {
    const p = createProfile({ name: 'P' });
    writeProfileKey(p.id, 'resume-designer-history-v1', JSON.stringify({ history: [{}] }));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('is false when a second résumé exists', () => {
    const p = createProfile({ name: 'P' });
    writeProfileKey(p.id, 'resume-designer-data', JSON.stringify({ variants: { a: {}, b: {} } }));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('is false when any list has content', () => {
    for (const key of [
      'resume-designer-applications',
      'resume-designer-job-descriptions',
      'resume-designer-chat-threads',
      'resume-designer-learned-answers',
    ]) {
      const p = createProfile({ name: key });
      writeProfileKey(p.id, key, JSON.stringify([{ id: 'x' }]));
      expect(isUntouchedWorkspace(p.id)).toBe(false);
    }
  });

  it('is false when tokens were spent', () => {
    const p = createProfile({ name: 'P' });
    writeProfileKey(p.id, 'resume-designer-token-usage', JSON.stringify({ events: [{ total: 1 }] }));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('keeps the workspace when a key cannot be read', () => {
    const p = createProfile({ name: 'P' });
    writeProfileKey(p.id, 'resume-designer-applications', '{ not json');
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });
});
```

`writeProfileKey(profileId, logicalKey, value)` is a test helper. Because the predicate only ever judges the **active** profile, the helper should activate that profile and then write through ordinary `appStorage.setItem` — the same path production takes — rather than constructing physical keys itself. A helper that hand-built namespaced keys would be a parallel implementation of the mapping and could pass while production read from somewhere else entirely.

- [ ] **Step 2: Run and watch them fail**

Run: `cd resume-designer && npx vitest run test/profiles.test.js`
Expected: FAIL — `isUntouchedWorkspace is not a function`.

- [ ] **Step 3: Implement the predicate**

```js
/**
 * Whether this workspace is the throwaway one `resolveActiveProfile` creates at
 * init and nothing has touched since.
 *
 * THE ONLY PLACE IN SYNC THAT CAN DISCARD ANYTHING, so it is deliberately
 * paranoid: any read that fails, any key that will not parse, and any doubt at
 * all answers false. A stray empty workspace is an annoyance someone can
 * delete; absorbing real work is the failure this whole feature exists to
 * prevent.
 *
 * Version history is the load-bearing clause — the store records an entry on
 * every change, so an absent history is the strongest evidence available that
 * nothing was ever edited. Comparing the résumé to the default template was
 * considered and rejected: the template changes between releases, so a byte
 * comparison would silently start absorbing every workspace the moment the
 * default changed.
 */
export function isUntouchedWorkspace(profileId) {
  // Only ever asked of the ACTIVE profile — the one init just created — so
  // ordinary `appStorage` reads resolve to its namespace. Refusing anything
  // else keeps this from being pointed at a workspace whose keys it would
  // silently read from the wrong namespace and judge empty.
  if (!profileId || profileId !== getActiveProfileId()) return false;

  try {
    const entry = (loadRegistry() || []).find((p) => p.id === profileId);
    if (!entry || entry.updatedAt) return false;

    // Any version history at all. The load-bearing clause: the store records an
    // entry on every change.
    for (const physical of appStorage.keys()) {
      const split = splitPhysicalKey(physical);
      const logical = split?.logicalKey ?? physical;
      if (split && split.profileId !== profileId) continue;
      if (logical.startsWith(BACKUP_HISTORY_PREFIX)) return false;
    }

    // At most the one résumé init created.
    const blob = JSON.parse(appStorage.getItem('resume-designer-data') ?? '{}');
    const variants = blob?.variants;
    if (!variants || typeof variants !== 'object') return false;
    if (Object.keys(variants).length > 1) return false;

    // Every list empty or absent.
    for (const key of [
      'resume-designer-applications',
      'resume-designer-job-descriptions',
      'resume-designer-chat-threads',
      'resume-designer-learned-answers',
    ]) {
      const raw = appStorage.getItem(key);
      if (raw == null) continue;
      const list = JSON.parse(raw);
      const values = Array.isArray(list) ? list : Object.values(list ?? {});
      if (values.length > 0) return false;
    }

    // No tokens spent.
    const usageRaw = appStorage.getItem('resume-designer-token-usage');
    if (usageRaw != null) {
      const usage = JSON.parse(usageRaw);
      if (Array.isArray(usage?.events) ? usage.events.length > 0 : usage != null) return false;
    }

    return true;
  } catch {
    // A key that will not parse is a key this cannot vouch for.
    return false;
  }
}
```

Import `splitPhysicalKey` and `BACKUP_HISTORY_PREFIX` from `./profileKeys.js` if `profiles.js` does not already. Do **not** construct physical keys by hand anywhere in this function.

- [ ] **Step 4: Run and watch them pass**

Run: `cd resume-designer && npx vitest run test/profiles.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the adoption flow**

In `resolveActiveProfile`, after the registry has been unioned by a landing and before the active profile is settled: if the local workspace is untouched and the merged registry contains at least one other non-tombstoned profile, tombstone the local one, delete its namespace, and activate the least-recently-created remaining profile.

**Tombstone it — do not merely remove the entry.** The spec states why: if the full upload ever reached the server before the shared fetch, a bare local removal is undone by the next merge and the empty workspace returns permanently.

- [ ] **Step 6: Gate and commit**

```bash
cd resume-designer && npm run test && npm run lint && npx vite build
git add resume-designer/src/profiles.js resume-designer/test/profiles.test.js
git commit -m "feat(profiles): adopt the account's workspaces on a clean install"
```

---

## What this plan does not do

- **Fetch a non-active profile's zone.** Other adopted workspaces sync when opened. Profile switching already reloads the window and starts a fresh engine.
- **Reclaim a deleted profile's zone or records.** The tombstone hides the listing; the data stays in iCloud. Reclaiming it needs content tombstones, which stay unbuilt deliberately.
- **Prove any of this against real CloudKit.** Bootstrap is the first item on the two-device checklist: install the second device *without* importing a backup, and confirm it fetches the first device's zone rather than merely creating its own.
