# Sync bootstrap: how a second device finds the first one's work

**Status:** design approved 2026-08-13. Amends
[2026-08-11-cloudkit-sync-design.md](2026-08-11-cloudkit-sync-design.md); that
document stands except where this one contradicts it.

## The problem

A clean install can never discover an existing device's data.

`resolveActiveProfile()` generates a random profile id and writes a registry
entry during init, before anything CloudKit-related runs — so a new device is
never a blank slate, it always arrives already owning a workspace nobody asked
for. The transport then creates and fetches only the zone named by that local
active profile.

The registry that would name the *other* device's profiles is a record inside
those other zones. So the device needs the registry to learn the ids, and the
ids to fetch the registry. **A fresh iPad opens to an empty workspace and stays
that way.** That is the feature's primary use case.

Two adjacent defects share the root and are fixed here:

- The registry is treated as a snapshot under newer-wins, but creating a profile
  is an **append**. Two devices creating a workspace offline means one entry
  disappears and its résumés are orphaned in a zone nothing lists.
- The registry is duplicated into whichever profile zone happens to be active,
  so a rename is not fanned out and the copies drift.

## The root observation

**The registry is a shared key living in a scoped container.**

`classifyKey` already separates shared keys (`SYNCED_SHARED_KEYS`, today exactly
`resume-designer-profiles`) from profile-namespaced ones. The zone layout does
not mirror that separation — everything lands in a per-profile zone. The fix is
to make the zone topology follow the key topology that already exists, rather
than work around it.

## Design

### 1. A shared zone

One additional CKRecordZone, named by the constant **`opShared`**, in the same
private database. It holds units for keys `classifyKey` answers `'synced'` for
*and* that are shared rather than profile-namespaced. Today that is exactly one
unit: `key:resume-designer-profiles`.

The name is a fixed literal, never derived. It cannot collide with a profile
zone: `generateProfileId()` returns `p` + base36 timestamp + random suffix, so
every profile zone name begins with `p`. It also cannot be rejected as reserved
— CloudKit reserves the leading underscore, which this does not use.

Per-profile zones are unchanged. Résumés, history, settings, applications, job
descriptions, learned answers and token usage all stay in the active profile's
zone exactly as today.

**Fetch scope** widens from `[activeProfileZone]` to
`[activeProfileZone, opSharedZone]` in `nextFetchChangesOptions`. The reason the
scope was narrowed originally still holds — never advance a change token past
records that are then dropped — because both zones' records are genuinely
handled.

**Zone creation** follows the existing idempotent pattern: the shared zone is
added to `pendingDatabaseChanges` on every start alongside the profile zone,
because saving an existing zone is a no-op and a "have I made it yet" flag is a
second piece of state that can disagree with the server.

### 2. The registry is a log, not a snapshot

`resume-designer-profiles` moves from snapshot newer-wins to a **union merge**,
joining version history and token usage under the spec's existing rule that
append-shaped units union and only snapshots take newer-wins.

Merge rule, given two registries:

- Union by profile `id`.
- Where both sides carry the same `id`, take the entry with the newer
  `updatedAt`; if only one side has an `updatedAt`, that side wins; if neither
  does, take the local one (an unstamped entry cannot win a claim it never made,
  matching `resolveConflict`'s treatment of an absent stamp).
- Order the result by `createdAt` ascending, then by `id` using code-unit
  comparison, so two devices merging the same inputs produce byte-identical
  output. **Not `localeCompare`** — it returns 0 for Unicode-equivalent strings,
  which is how an earlier ordering bug in this feature reached production code.

This requires an `updatedAt` field on registry entries. `createProfile` and
`renameProfile` set it; entries written before this change have none and are
treated as unstamped per the rule above.

### 3. One deliberate tombstone, on metadata only

A union merge alone would resurrect deleted workspaces: delete on the iPhone,
and the iPad's registry restores the entry.

Registry entries therefore carry an optional **`deletedAt`**. An entry with one
is retained in the merged registry — it must be, or the union restores it again
— but is not listed as a workspace. `deleteProfile` sets it instead of dropping
the entry.

**This is a deliberate exception to "deletion does not propagate", and it is
scoped to metadata.** A `deletedAt` hides a *listing*; it destroys no content.
The profile's zone and every résumé in it stay exactly where they are. Getting
a content tombstone wrong deletes someone's work; getting this wrong hides a
workspace whose data is still on the server and still on any device that has it.
That asymmetry is the whole justification, and it does not extend to résumés.

Local deletion behaviour is unchanged: `deleteProfileDurably` still removes the
local namespace. The tombstone governs only what the registry lists.

### 4. The fresh-device flow

1. Init creates local profile X exactly as today. Unchanged — sync may be off,
   and the app must work with no iCloud account at all.
2. If sync is on, the shared zone is fetched before the profile zone.
3. The remote registry is unioned into the local one per §2.
4. **If X is provably untouched**, its entry is **tombstoned** per §3 and its
   local namespace deleted, and the least-recently-created non-deleted remote
   profile becomes active. Otherwise X is kept as an ordinary workspace.
5. The active profile's zone is fetched. Other adopted profiles sync when
   activated — profile switching already reloads the window and starts a fresh
   engine.

**Two ordering rules make step 4 safe, and both are load-bearing:**

- **The shared zone is fetched before the registry is ever uploaded.** A fresh
  device owes a full upload on first enable, and if that upload ran first it
  would put X on the server before the merge could see the remote registry.
- **X is tombstoned, not merely removed.** If the upload above ever did land
  first — a retry, a reordering, a future change to the enable path — a bare
  local removal would be undone by the next merge, which would restore X and
  leave the person with the empty workspace forever. The tombstone is harmless
  when X never reached the server and correct when it did.

**"Provably untouched" is the only step in this design that can discard
anything, and is defined conservatively.** X qualifies only when ALL hold:

- its registry entry has no `updatedAt` (never renamed), and
- its `resume-designer-data` holds at most the single résumé
  `resolveActiveProfile` created, and
- **it has no version-history key for any variant.** This is the load-bearing
  clause: the store records a history entry on every change, so an absent
  history is the strongest available evidence that nothing was ever edited.
  Comparing the résumé against the default template was considered and rejected
  — the template evolves between releases, so a byte comparison would silently
  start keeping every X the moment the default changed, and a loose comparison
  would be exactly the kind of "close enough" that discards real work. And
- `resume-designer-applications`, `resume-designer-job-descriptions`,
  `resume-designer-chat-threads` and `resume-designer-learned-answers` are each
  absent or an empty collection, and
- `resume-designer-token-usage` is absent or records no usage.

Any read that fails, any key that cannot be parsed, or any doubt whatsoever
keeps X. A stray empty workspace is an annoyance the person can delete;
absorbing real work is the failure this entire feature exists to prevent.

## What changes

| File | Change |
| --- | --- |
| `src/sync/syncKeys.js` | expose which synced keys are shared, so the unit's zone can be derived from its key |
| `src/sync/syncUnits.js` | unchanged — the blob split is per-profile and stays so |
| `src/sync/syncMerge.js` | `mergeRegistry`, joining `mergeHistory` and `mergeTokenUsage` |
| `src/sync/syncModel.js` | route the registry unit through `mergeRegistry`; expose whether a unit is shared |
| `src/profiles.js` | `updatedAt` on create/rename; `deletedAt` on delete; filter tombstoned entries from listings; the untouched-X test |
| `src-tauri/ios/OPSync.swift` | create and fetch `opShared`; widen `nextFetchChangesOptions` |
| `src-tauri/ios/OPShell.swift` | order the shared fetch before the profile fetch on start |

## Error handling

- The shared zone failing to fetch is not fatal. The device runs on its local
  registry and retries on the next start, exactly as a profile zone does today.
- A registry unit that will not parse is refused before it is written, per the
  established rule that a shape-broken unit never reaches storage.
- Adoption is not atomic across profiles. A crash mid-adoption leaves a merged
  registry and some unfetched zones, which the next start resolves — no step
  destroys anything, so a partial adoption is a slower adoption, not a loss.

## Testing

- `mergeRegistry` is pure and gets the same treatment as `mergeHistory`:
  order-independence proven by feeding both argument orders, tombstone
  retention, per-entry `updatedAt` resolution, and the unstamped cases.
- The untouched-X predicate gets a test per clause, each proving that violating
  that one clause alone keeps X. This is the test that matters most: a
  false positive discards a workspace.
- The bootstrap flow is exercised through the real `appStorage` with an injected
  backend, asserting the **disk**, consistent with the durability rules
  established elsewhere in this feature.
- Zone routing is asserted by unit id: a shared unit must never be collected
  into a profile zone, and a profile unit must never be collected into
  `opShared`.

## What this does not solve

- **A second workspace's data does not arrive until it is opened.** Only the
  active profile's zone is fetched. Accepted: profile switching already reloads
  the window, and fetching every zone would mean either multiple engines or a
  profile-aware apply path, both larger than this problem warrants.
- **Profile deletion still does not remove the zone or its records.** The
  tombstone hides the listing; the data remains in iCloud. Reclaiming it needs
  content tombstones, which stay unbuilt.
- **Nothing here has run against real CloudKit.** Bootstrap is the first item on
  the two-device checklist: install the second device *without* importing a
  backup and confirm it fetches the first device's zone rather than merely
  creating its own.
