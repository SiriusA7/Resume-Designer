/**
 * The merge rules. Pure — no storage, no DOM.
 *
 * The rule that decides whether a unit belongs here at all: a unit whose
 * payload GROWS by accumulation cannot take newer-wins, because the newer
 * document is missing whatever the other device appended. Snapshots take
 * newer-wins (resolveConflict, below); logs need a merge.
 */

// The history bound, from a leaf that imports nothing — see historyLimits.js
// for why neither this module nor store.js may own it. This is the only import
// this file has, and it must stay that way: everything else in the sync layer
// is allowed to touch storage, and this module is not.
import { MAX_HISTORY } from '../historyLimits.js';

/**
 * Total, deterministic string order.
 *
 * NOT `localeCompare`, which returns 0 for two DISTINCT strings the locale
 * considers equivalent: `café` written as NFC and the same name written as NFD
 * — one typed on a phone, one on a Mac, entirely ordinary for a résumé. Two
 * entries with different identities then compared equal, the sort fell through
 * to Map insertion order, and Map insertion order is ARGUMENT order. So
 * `merge(mine, theirs)` and `merge(theirs, mine)` came out in opposite orders,
 * each device stored a different payload for the same content, and they
 * re-diverged every round — the exact "resync forever" the tie-breaks below
 * exist to prevent.
 *
 * `<` and `>` compare UTF-16 code units: total, and computed identically on
 * both devices without consulting a locale.
 */
function byCodeUnit(x, y) {
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

/**
 * Union two token-usage documents.
 *
 * The ONE unit where newer-wins is actively wrong: both devices append events,
 * so taking the newer document discards the other's calls outright. Every
 * event carries a unique id and `summary` is derived from `events`, so the
 * correct merge is a union by id followed by a recomputed summary — which also
 * means the summary can never drift from the events it describes.
 *
 * Mirrors the accumulation in `trackUsage` (src/tokenTrackingService.js).
 */
export function mergeTokenUsage(a, b) {
  const events = new Map();
  for (const doc of [a, b]) {
    for (const event of Array.isArray(doc?.events) ? doc.events : []) {
      if (!event || typeof event.id !== 'string') continue;
      const existing = events.get(event.id);
      // Two events can share an id but differ in content (e.g. a record that
      // was edited on one device after being synced). Which one survives
      // must be a pure function of the two events, not of which document
      // happened to be iterated last — otherwise `merge(mine, theirs)` and
      // `merge(theirs, mine)` keep different winners and the devices never
      // converge, the same failure `resolveConflict`'s tie-break exists to
      // avoid. `canonicalJSON` (below) is order-independent, so both devices
      // compute the same winner; which one wins is otherwise arbitrary.
      if (!existing || canonicalJSON(event) > canonicalJSON(existing)) {
        events.set(event.id, event);
      }
    }
  }
  // Tie-break on `id` too, not just `timestamp`: two events written in the
  // same millisecond would otherwise sort by which argument position (`a` vs
  // `b`) happened to insert them into the Map first — order that flips
  // between `merge(x, y)` and `merge(y, x)` and breaks the order-independence
  // this function promises.
  const merged = [...events.values()].sort(
    (x, y) => byCodeUnit(String(x.timestamp), String(y.timestamp))
      || byCodeUnit(String(x.id), String(y.id)),
  );
  return { events: merged, summary: summarize(merged) };
}

/**
 * `JSON.stringify` serialises object keys in property-insertion order, so
 * the same event assembled by two different code paths (or round-tripped
 * through storage) can serialise differently even though its fields are
 * identical. That would make it unfit as a merge discriminator — two
 * devices building "the same" event in a different order would disagree on
 * which one wins. Sorting keys at every object level removes that
 * dependency; array order is left alone since it's meaningful data, not an
 * artifact of construction.
 *
 * Exported for the same reason `entryIdentity` is: store.js has to compare two
 * RÉSUMÉS — the document it holds against the one a history entry carries — and
 * `JSON.stringify` would call the same résumé different because its keys were
 * inserted in a different order (a stored entry versus one just rebuilt by
 * migrateSectionAreas). A false "different" there costs the user a duplicate
 * history entry on every load.
 */
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A history entry's identity: what `mergeHistory` unions on.
 *
 * Exported because store.js has to find the entry its live document is on
 * inside a merged array, and reference equality will not do it — the union
 * keeps ONE object per identity, so an entry both devices hold comes back as
 * the remote's deserialised twin, equal in content and a different object.
 */
export function entryIdentity(entry) {
  return canonicalJSON(entry);
}

/**
 * Union two version-history documents.
 *
 * History is append-shaped, exactly like the token log, so newer-wins is wrong
 * here for the same reason — and worse: a conflict's LOSING résumé is parked in
 * history (syncModel.js's parkLoser) precisely so newer-wins destroys nothing,
 * so an incoming history unit that overwrote local history wholesale destroyed
 * the thing the conflict rule promised to keep.
 *
 * The document is `{ history: [...], historyIndex }` — store.js's saveHistory /
 * loadHistory shape — whose entries are `{ data, timestamp, description,
 * changeType }`.
 *
 * Entries carry no unique id, so identity is `canonicalJSON` of the whole
 * entry: two devices holding the same entry must compute the same identity, and
 * plain `JSON.stringify` would not give them that (it serialises in key-
 * insertion order, so the same entry assembled by two code paths can stringify
 * differently and survive the union twice).
 *
 * The result is a pure function of the two documents' contents, so it is
 * order-independent and idempotent: both devices run it as `merge(mine,
 * theirs)` with opposite arguments, and they must land on the same document or
 * they resync forever.
 */
export function mergeHistory(a, b) {
  const entries = new Map();
  for (const doc of [a, b]) {
    for (const entry of Array.isArray(doc?.history) ? doc.history : []) {
      // Non-objects are not entries; store.js would render one as a blank row
      // in HistoryDialog and throw on restoring it.
      if (!entry || typeof entry !== 'object') continue;
      entries.set(entryIdentity(entry), entry);
    }
  }

  const merged = [...entries]
    // Chronological, matching the order pushHistory appends in. Ties break on
    // the identity string — arbitrary but computed identically on both devices,
    // where "whichever Map insertion came first" would depend on argument
    // order and break the order-independence above. Both comparisons are by
    // code unit, not by locale: see byCodeUnit.
    .sort(([keyX, x], [keyY, y]) => byCodeUnit(String(x.timestamp), String(y.timestamp))
      || byCodeUnit(keyX, keyY))
    .map(([, entry]) => entry)
    // Over the bound, the OLDEST entries go — `slice(-MAX_HISTORY)` keeps the
    // tail. That matches pushHistory's `history.shift()`, and it is the only
    // end that can be dropped safely: cutting the new end would discard the
    // very entries the merge just gained, so a union with a full history on
    // either side would be a no-op.
    .slice(-MAX_HISTORY);

  // `historyIndex` points at the entry the document considers current, and
  // neither side's number survives a union: entries interleave by timestamp and
  // the cap can drop the entry an index pointed at. It is set to the newest
  // entry, which is both well-defined and the same on both devices — and, more
  // importantly, the only safe position. Everything AFTER the index is
  // store.js's redo future, and pushHistory splices the future away on the next
  // edit: an index left mid-array would delete the entries this merge just
  // brought in, one keystroke later. The end leaves that future empty. It is
  // also exactly what loadHistory falls back to for a document with no recorded
  // index (`history.length - 1`), so an empty history comes out at -1, the same
  // value the store uses for "no history".
  return { history: merged, historyIndex: merged.length - 1 };
}

/**
 * Recompute the summary from scratch, mirroring `trackUsage`'s accumulation
 * field-for-field (see src/tokenTrackingService.js) rather than the brief's
 * generic version, for two reasons found while cross-checking that function:
 *
 * - `byModel` entries there carry `provider`/`model` alongside the totals —
 *   the Settings usage table (`SettingsDialog.jsx`) reads `d.model` straight
 *   off each entry, so an entry without it would render blank.
 * - There is no top-level `totalCalls` in the real summary shape; the same
 *   table derives that count itself from `byModel`. Inventing one here would
 *   leave a field `trackUsage` never touches, so it would go stale the next
 *   time a device tracks a new event locally instead of through a merge.
 */
function summarize(events) {
  const summary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCost: 0,
    byModel: {},
    byFeature: {},
  };

  for (const e of events) {
    const input = e.inputTokens || 0;
    const output = e.outputTokens || 0;
    // `|| 0`: events written before reasoningTokens existed lack the field.
    const reasoning = e.reasoningTokens || 0;
    const cost = e.cost || 0;

    summary.totalInputTokens += input;
    summary.totalOutputTokens += output;
    summary.totalReasoningTokens += reasoning;
    summary.totalCost += cost;

    // Guarded the same way `trackUsage` effectively is: it always writes a
    // truthy `feature` (defaulting to 'unknown'), so a falsy key here means
    // a malformed/legacy event, and skipping it avoids inventing a bucket
    // the app itself would never have created.
    if (e.model) {
      if (!summary.byModel[e.model]) {
        summary.byModel[e.model] = {
          provider: e.provider,
          model: e.model,
          inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cost: 0, calls: 0,
        };
      }
      const m = summary.byModel[e.model];
      m.inputTokens += input;
      m.outputTokens += output;
      m.reasoningTokens += reasoning;
      m.cost += cost;
      m.calls += 1;
    }

    if (e.feature) {
      if (!summary.byFeature[e.feature]) {
        summary.byFeature[e.feature] = {
          inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cost: 0, calls: 0,
        };
      }
      const f = summary.byFeature[e.feature];
      f.inputTokens += input;
      f.outputTokens += output;
      f.reasoningTokens += reasoning;
      f.cost += cost;
      f.calls += 1;
    }
  }

  return summary;
}

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
 * absent `modifiedAt`. When the stamps tie (including both absent), a
 * tombstoned side still wins. Per the spec, `deleteProfile` sets `deletedAt`
 * alone, not `updatedAt`, so a plain updatedAt comparison ties a deletion
 * against the untouched entry it deleted, and letting that tie fall through
 * to the rule below would discard the tombstone whenever the deleting
 * device's own copy happened to be `held`.
 *
 * Below that — stamps tied AND tombstone-ness tied — the entries are broken
 * on content, deterministically. "Keep the held entry" looks like a safe
 * default here but is argument-order dependence wearing a reasonable-looking
 * disguise: both devices call this as `merge(local, remote)`, so `held` is
 * always the LOCAL entry, and "keep held" means each device keeps its own
 * copy of every tied entry forever — the two never converge, which is the
 * single property this whole file exists to guarantee. This is not exotic:
 * every registry entry written before this feature has no `updatedAt` at
 * all, so a profile renamed on one device pre-upgrade and not on the other
 * gives exactly two unstamped, non-tombstoned entries with different names.
 * `canonicalJSON` + `byCodeUnit` — already used in `mergeTokenUsage` for the
 * identical reason — give a comparison both devices compute the same way, so
 * which side wins is arbitrary but consistent.
 */
function outranks(candidate, held) {
  const at = (entry) => (typeof entry.updatedAt === 'string' ? entry.updatedAt : '');
  const byStamp = byCodeUnit(at(candidate), at(held));
  if (byStamp !== 0) return byStamp > 0;

  const isTombstone = (entry) => typeof entry.deletedAt === 'string';
  if (isTombstone(candidate) !== isTombstone(held)) return isTombstone(candidate);

  return byCodeUnit(canonicalJSON(candidate), canonicalJSON(held)) > 0;
}

/**
 * Newer wins.
 *
 * Both devices run this, so the tie-break has to be one both sides compute the
 * same way — otherwise they converge on different winners and sync forever.
 * The remote wins an exact tie, arbitrarily but consistently.
 *
 * An unparseable timestamp loses to a real one: a record with a broken stamp
 * should not be able to overwrite a good edit.
 */
export function resolveConflict(local, remote) {
  const at = (side) => {
    const value = Date.parse(side?.modifiedAt ?? '');
    return Number.isFinite(value) ? value : -Infinity;
  };
  return at(local) > at(remote)
    ? { winner: local, loser: remote }
    : { winner: remote, loser: local };
}
