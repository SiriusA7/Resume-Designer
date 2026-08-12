/**
 * The two merge rules. Pure — no storage, no DOM.
 */

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
      if (event && typeof event.id === 'string') events.set(event.id, event);
    }
  }
  // Tie-break on `id` too, not just `timestamp`: two events written in the
  // same millisecond would otherwise sort by which argument position (`a` vs
  // `b`) happened to insert them into the Map first — order that flips
  // between `merge(x, y)` and `merge(y, x)` and breaks the order-independence
  // this function promises.
  const merged = [...events.values()].sort(
    (x, y) => String(x.timestamp).localeCompare(String(y.timestamp))
      || String(x.id).localeCompare(String(y.id)),
  );
  return { events: merged, summary: summarize(merged) };
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
