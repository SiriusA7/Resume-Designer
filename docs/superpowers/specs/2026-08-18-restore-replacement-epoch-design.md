# Replacement epoch: making "replace everything" mean it across devices

**Status:** design, not implemented. Raised by two P1 review findings on
[PR #125](https://github.com/ashproto/Resume-Designer/pull/125) that share one
root cause, and deliberately split out of that PR rather than patched into it.

## The problem

A replacement restore can only remove what it can name.

`withTombstonesForDroppedVariants` compares the backup against the **pre-wipe
snapshot of this device**. A résumé that exists only on the server — created on
another device after the backup was taken, and not yet fetched here — is in
neither set. No tombstone is written for it, so the next fetch treats the server
record as new and restores content the replacement explicitly omitted.

The same hole exists one level up for whole profiles: a workspace created
elsewhere and not yet fetched survives a replacement that omitted it.

The confirmation dialog promised otherwise. As of this design's companion commit
it no longer does — it now says the removal covers what has already synced to
this device. That is honest, and it is not the end state we want.

## Why there is no per-record fix

Every per-record rule reduces to *guessing which unseen records the user meant to
delete*.

The obvious candidate — persist a `replacedAt` per workspace, and on fetch
tombstone any résumé absent locally whose stamp predates it — fails on the case
it most needs to get right. "Stamped before the restore" is not the same as
"known to the restoring device", and the gap between them is exactly a résumé
someone created on another device shortly before the restore. That résumé is
destroyed silently, with no notice and no recovery, and cross-device clock skew
widens the window.

This is a known dead end rather than a local oversight. It is the same shape as
the tombstone-expiry problem in sync systems generally: when a replica's causal
history is insufficient to know what was deleted, the options are **fail and
force re-initialisation** or **proceed without the deletes**. There is no third
option that correctly infers the deletions. See
[Sync Services: Periodic Tombstone Cleanup](https://learn.microsoft.com/en-us/archive/blogs/synchronizer/sync-services-periodic-tombstone-cleanup)
and [Tombstone (data store)](https://en.wikipedia.org/wiki/Tombstone_(data_store)).

## The design: publish a baseline instead

Model a replacement restore as what it is — the workspace starts over from this
snapshot — rather than as a very large edit.

1. **The restore publishes an epoch.** A record in the shared `opShared` zone,
   beside the registry: `{ epochId, profileId, at, deviceId }`. New id per
   replacement.
2. **Other devices re-initialise rather than merge.** A device seeing an epoch
   newer than the one it last acted on discards its local records for that
   workspace and takes the server baseline. It does not diff, and it does not
   decide per record.
3. **Content after the epoch is ordinary.** A record stamped after the epoch is
   normal content and survives — so a device that comes back online a week later
   keeps what it created since, and only loses what predates the replacement.
4. **The restoring device records the epoch it just published**, so it does not
   re-initialise itself.

### Why this is better than the alternatives

- No device ever deletes a record on a guess about another device's intent.
- One mechanism covers résumés *and* profiles. A per-record rule needs a second,
  parallel rule for workspaces.
- The semantics become statable in one sentence: **this resets the workspace on
  all your devices.** Today's cannot be stated in one sentence, which is the
  clearest signal that the model is wrong.

### The cost, stated plainly

A device holding work created **before** the replacement and never synced loses
it. That is inherent to "replace" — but it becomes explicit and uniform, rather
than depending on which records happened to have reached the server first.

## What implementing it involves

- A new shared-zone record kind, and its collect/apply/merge rules.
- A re-initialisation path in `applyUnits`: today every unit is judged
  individually, and this needs a workspace-level "adopt the baseline" step.
- Ordering: the epoch must be applied before the units it invalidates, or a
  device re-initialises and then re-adopts what it just discarded.
- Migration: devices on builds without epoch support ignore the record and keep
  today's behaviour. They must not be *worse* than today — they simply do not
  get the guarantee.
- Confirmation copy changes again, to the one-sentence version.

## What was done instead, for now

`backupFlow.js` states the actual scope of the removal rather than promising
completeness. Nothing destroys data on a blind rule, because there is no such
rule — the limitation is disclosed instead of silently wrong.

Both review threads stay open against this document.
