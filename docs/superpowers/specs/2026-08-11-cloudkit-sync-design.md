# CloudKit sync — design

**Status:** approved, not yet planned or built
**Date:** 2026-08-11

## Goal

Keep a person's résumés, job descriptions, applications, chat threads and
version history in sync across their Apple devices, through their own iCloud
account, without moving any of it onto a server we run.

## Scope

**In:** iOS and iPadOS, built against the SwiftUI shell that already exists.

**Designed for but not built:** macOS. The record model, the conflict rules and
the storage hook are deliberately platform-neutral, so a Mac client
reimplements only the transport.

**Out:** Windows. CloudKit cannot serve it. If Windows sync is ever wanted it
needs a different mechanism (CloudKit Web Services, or a backend), and that is
a separate design.

**Out:** the OpenRouter API key. It lives in the OS keychain, not in
`appStorage`, and secrets should not ride in CloudKit records. iCloud Keychain
is the right mechanism for it and is a separate decision.

### The macOS question, recorded

Three candidates, none blocking this design:

1. **Tauri plus a Swift CloudKit helper.** A Tauri `.app` is a normal signed
   bundle and can carry iCloud entitlements; the project already calls
   Objective-C from Rust for PDF export. Least disruption, keeps the desktop
   React chrome.
2. **Mac Catalyst**, making the iOS app the Mac app and leaving Tauri for
   Windows only. One shared Swift client, but it moves the *backend* as well as
   the chrome: Catalyst is `aarch64-apple-ios-macabi`, which Tauri's tooling
   does not target, and whether wry/tao build under it is unverified. It would
   also put an iPad-shaped UI in front of Mac users — there is not even an iPad
   layout yet — against a standing decision that the desktop keeps its React
   chrome.
3. **A native SwiftUI macOS target.** Apple has steered multiplatform this way
   rather than Catalyst; worth evaluating against (2) if a shared client is the
   goal.

Deciding this needs a spike, not a guess. It changes who writes the transport,
never the model below.

## Decisions

| Question | Decision |
| --- | --- |
| Platform scope | Apple only; iOS/iPadOS first, Mac deferred behind a neutral design |
| Record granularity | One record per résumé, plus one per other syncable unit |
| Conflict resolution | Newer wins; the losing version is written to that résumé's version history |
| Multi-profile | One CloudKit record zone per profile |
| Database | Private, in the user's own iCloud account |

## What syncs

### Synced

Content, and anything that changes what a résumé looks like.

- **Each résumé**, one record each, decomposed out of the `variants` map inside
  `resume-designer-data`
- **`settings` and `userProfile`**, split out of that same blob into their own
  records
- `resume-designer-job-descriptions`
- `resume-designer-applications`
- `resume-designer-chat-threads` (and the legacy `resume-designer-chat-history`)
- `resume-designer-learned-answers`
- **Version history** — every `resume-designer-history-variant-*` key. Load-
  bearing: it is the recovery path for the conflict rule, and a losing edit
  parked in history on one device is no use from another.
- **Token usage**, by a merge rule rather than newer-wins — see below
- Design defaults: `resume-header-style`, `resume-accent-settings`,
  `resume-font-settings`, `resume-spacing-settings`, `resume-photo-settings`
- `resume-designer-onboarding-complete`, so a second device does not re-run the
  wizard on an account that already has résumés
- `resume-edit-hint-dismissed`
- The profile registry, `resume-designer-profiles`

### Device-local — never leaves the machine

- **`currentVariantId`** (inside the data blob). Which résumé is open is a
  property of a device; syncing it makes one device change documents because
  another did.
- **`resume-zoom`.** A zoom that suits a phone is wrong on a Mac.
- **`resume-designer-active-profile`**, for the same reason as
  `currentVariantId`.
- **`resume-designer-theme`.** Commonly set to follow the system appearance,
  and a synced value fights that on a device whose system setting differs.
- **`resume-designer-update-channel`, `resume-designer-auto-update-check`.** A
  beta Mac beside a stable phone is a legitimate setup.
- **`resume-designer-bridge-token`.** The loopback companion bridge is
  machine-specific.
- **`resume-designer-model-catalog`.** A regenerable cache.
- **`resume-designer-electron-migration-attempted`.** A historical fact about
  one machine.

### Not pruned, and it matters

`tokenTrackingService.js` never trims `events`, and no history retention policy
exists. Locally that is harmless. Synced, both grow without bound against a
record size limit. See "Record size" below for how that is handled, and
"Deferred" for what is not being solved now.

## Architecture

### The seam

`appStorage` is a single coalescing writer over a committed in-memory cache,
with `loadAll` / `write` / `delete` / `clear` beneath it. Every platform goes
through it. Sync hooks there and nowhere else.

### The split, and why it is where it is

**Swift must not learn the document's schema.** That invariant holds across
every screen of the iOS port: the native side echoes back paths it was handed
and never parses a résumé. Splitting `resume-designer-data` into per-résumé
records is schema knowledge, so it cannot live in Swift.

**JS owns what a unit is.** A new framework-free module:

- enumerates the syncable units and classifies every storage key
- splits the data blob into per-résumé units on the way out, and reassembles it
  on the way in
- merges token usage
- knows where a losing version goes in version history

**Swift owns transport.** Zones, subscriptions, change tokens, conflict
detection, retry and backoff. A record is:

```
{ unitId: String, kind: String, payload: <opaque>, modifiedAt: Date }
```

`payload` is an opaque JSON string Swift never parses. `kind` exists so the
transport can route a conflict to the right resolution without understanding
the contents.

This is the same division every other screen uses, and it is what makes the Mac
client a transport-only job.

### Zones

One record zone per profile, named from the profile id. The profile registry
syncs so that zones and local profiles can be reconciled. A per-profile zone
buys atomic per-profile fetches and a clean per-profile delete.

## Conflict resolution

CloudKit rejects a save whose record changed underneath it and attaches the
server's copy. On that rejection:

1. Compare `modifiedAt`. The newer payload wins and is written locally.
2. The losing payload is handed to JS, which writes it into that résumé's
   version history.
3. One non-blocking notice per resolution — not per record: *"A newer version
   from your iPhone replaced this. The previous one is in Version history."*

Nothing is destroyed, recovery is a restore the app already supports, and the
user is never asked to make a decision mid-edit.

### The two units that merge instead

**Token usage.** Every event carries a unique `id`, and `summary` is derived
from `events`. The merge is a union of events by id followed by a recomputed
summary — correct rather than lossy, and nearly free.

**Version history** (amended 2026-08-12, after implementation proved the
original rule self-defeating). History is append-shaped too, so newer-wins
loses entries — and because a conflict's loser is *parked in history*, the
lossy rule destroyed the thing it was meant to protect the moment it synced.
Exercised: a remote history unit lands, one local edit rewrites the key from
the store's in-memory array, and the parked loser is gone. History therefore
takes the same union treatment: union both sides' entries, order by timestamp,
cap at the store's `MAX_HISTORY`.

Entries have no unique id — they are `{data, timestamp, description,
changeType}` — so identity is a canonical hash of the entry, using the same
key-sorted serialisation the token-usage tie-break already relies on. Two
devices must compute the same identity for the same entry, which insertion-order
-dependent `JSON.stringify` would not guarantee.

### Undo traverses only this user's own steps

Unioning two histories has a consequence worth stating outright: a merged
timeline contains states this user was never in. Edit on the phone, open the
Mac, press Cmd+Z, and undo would reach the phone's document rather than your
own last state. Nothing is lost, but it reads as loss.

So the undo timeline is **a record of steps taken on this device**, and
`undo`/`redo` skip entries that are not — both parked conflict losers and
entries whose origin is another device. Version history's dialog still shows
the whole merged union and can restore anything in it; only the traversal is
narrowed. This is one principle, not two: the rule that already excludes a
parked loser excludes a foreign entry for the same reason.

Entries therefore carry an `origin` — a device identifier held in the
device-local sync-state key, never synced. An entry with no `origin` predates
this field and is treated as local, which is correct: history was device-local
before sync existed, so every such entry was in fact written here.

**The general rule, stated once so the next append-shaped unit does not repeat
this:** a unit whose payload GROWS by accumulation cannot take newer-wins. Ask
of every synced unit whether it is a snapshot or a log. Snapshots take
newer-wins; logs need a merge.

## Record size

CloudKit caps a record's fields at roughly 1MB. Version history and the token
log are the two units that will exceed it.

The transport handles this **without learning what it carries**: a payload of
more than **700KB encoded** is stored as a `CKAsset` instead of a string field,
chosen purely on byte count. The headroom below 1MB covers the record's other
fields and encoding overhead, so the decision never has to be revisited at the
boundary.

## Error handling

- **Offline is the normal case, not the error case.** A local write always wins
  locally and lands immediately. Sync is background reconciliation; nothing in
  the app blocks on the network.
- **First sync on a fresh device** is the dangerous moment. An empty local store
  meeting a populated cloud must never be read as "everything was deleted".
  Deletions are explicit tombstones and are never inferred from absence.
- **Signed out of iCloud, or a different account.** Sync stops and says so. It
  must not wipe or overwrite local data.
- **Quota exceeded.** Surfaced the way the storage-full toast already is, and
  the app keeps working locally.
- **Partial failures.** CloudKit reports per-record outcomes for a batch; a
  failed record is retried with backoff and does not fail its neighbours.

## Testing

The parts most likely to be wrong are pure functions over data and are tested
as such, alongside the existing projections:

- key classification — every key in `BACKUP_FIXED_KEYS` and the history prefix
  is either synced or explicitly device-local, with no key falling through
  unclassified
- blob split and reassembly — round-tripping `resume-designer-data` through
  decomposition is byte-identical, and reassembly preserves keys the splitter
  did not know about
- token-usage merge — union by id is order-independent, idempotent, and the
  recomputed summary matches a fresh computation over the merged events
- conflict resolution — the newer payload wins, and the loser reaches history

Transport is deliberately thin and is verified on device, including: a real
two-device edit of the same résumé, a first sync onto a fresh install, and
airplane-mode edits reconciling on reconnect.

## Deferred

- **Retention.** Neither version history nor the token log is pruned. Syncing
  makes that a growth problem rather than a disk problem, but capping either
  one changes user-visible behaviour and deserves its own decision.
- **Sharing.** Private database only. No collaboration, no shared zones.
- **Windows.**
- **A Mac client**, pending the spike described above.
