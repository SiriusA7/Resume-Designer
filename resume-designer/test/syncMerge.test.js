import { describe, it, expect } from 'vitest';
import {
  mergeTokenUsage, mergeHistory, resolveConflict, canonicalJSON, mergeRegistry,
} from '../src/sync/syncMerge.js';
// From the neutral leaf, not from syncMerge.js: the constant lives outside both
// the store and the sync layer so neither has to import the other for it.
import { MAX_HISTORY } from '../src/historyLimits.js';

// The same name in the two normalisations a resume really meets: composed
// (é as one code point) and decomposed (e + a combining acute). Both are
// DERIVED from one literal rather than typed, so no editor, formatter or
// clipboard on the way into this file can quietly normalise one into the
// other and retire the test without failing it.
const NFC = 'café'.normalize('NFC');
const NFD = 'café'.normalize('NFD');

const event = (id, over = {}) => ({
  id, timestamp: '2026-08-01T00:00:00.000Z', provider: 'openrouter',
  model: 'anthropic/claude-sonnet-4.5', feature: 'chat',
  inputTokens: 10, outputTokens: 20, cacheRead: 0, cacheCreation: 0,
  reasoningTokens: 5, cost: 0.5, ...over,
});

const usage = (events) => ({ events, summary: { byModel: {}, byFeature: {} } });

describe('mergeTokenUsage', () => {
  it('unions events by id rather than letting one device replace the other', () => {
    const merged = mergeTokenUsage(usage([event('a'), event('b')]), usage([event('b'), event('c')]));
    expect(merged.events.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent and order-independent', () => {
    const x = usage([event('a'), event('b')]);
    const y = usage([event('b'), event('c')]);
    expect(mergeTokenUsage(x, y)).toEqual(mergeTokenUsage(y, x));
    expect(mergeTokenUsage(mergeTokenUsage(x, y), y)).toEqual(mergeTokenUsage(x, y));
  });

  it('recomputes the summary rather than merging it', () => {
    // `summary` is derived from `events`, so merging it would double-count.
    const merged = mergeTokenUsage(
      usage([event('a', { inputTokens: 1, outputTokens: 2, cost: 0.1 })]),
      usage([event('b', { inputTokens: 3, outputTokens: 4, cost: 0.3 })]),
    );
    expect(merged.summary.totalInputTokens).toBe(4);
    expect(merged.summary.totalOutputTokens).toBe(6);
    expect(merged.summary.totalCost).toBeCloseTo(0.4, 10);
    expect(merged.summary.byModel['anthropic/claude-sonnet-4.5'].calls).toBe(2);
  });

  it('orders events oldest first, as the tracker writes them', () => {
    const merged = mergeTokenUsage(
      usage([event('late', { timestamp: '2026-08-09T00:00:00.000Z' })]),
      usage([event('early', { timestamp: '2026-08-01T00:00:00.000Z' })]),
    );
    expect(merged.events.map((e) => e.id)).toEqual(['early', 'late']);
  });

  it('resolves same-id events with different content the same way regardless of argument order', () => {
    // If the dedupe just did `events.set(id, event)` while iterating [a, b],
    // whichever document was iterated last would win. Two devices each call
    // this as `merge(mine, theirs)`, so with opposite argument orders they
    // would each keep their own copy and never converge on the same document.
    const mineFirst = mergeTokenUsage(
      usage([event('x', { inputTokens: 1 })]),
      usage([event('x', { inputTokens: 999 })]),
    );
    const theirsFirst = mergeTokenUsage(
      usage([event('x', { inputTokens: 999 })]),
      usage([event('x', { inputTokens: 1 })]),
    );
    expect(mineFirst).toEqual(theirsFirst);
  });

  it('breaks a same-millisecond tie by code unit, which two Unicode-equivalent ids do not survive', () => {
    // `localeCompare` returns 0 for these two DISTINCT ids, so the tie-break
    // decided nothing and the sort fell back to Map insertion order — argument
    // order. Ids are ASCII today, so this was a trap rather than a live bug;
    // it is closed the same way mergeHistory's is, and this is the test that
    // says so.
    expect(NFC).not.toBe(NFD);
    expect(NFC.localeCompare(NFD)).toBe(0);

    const at = '2026-08-04T00:00:00.000Z';
    const mine = usage([event(NFC, { timestamp: at })]);
    const theirs = usage([event(NFD, { timestamp: at })]);
    expect(mergeTokenUsage(mine, theirs)).toEqual(mergeTokenUsage(theirs, mine));
  });

  it('survives a side with no events', () => {
    expect(mergeTokenUsage(usage([]), usage([event('a')])).events).toHaveLength(1);
    expect(mergeTokenUsage(null, usage([event('a')])).events).toHaveLength(1);
    expect(mergeTokenUsage(null, null).events).toEqual([]);
  });
});

// store.js's saveHistory shape, entry-for-entry.
const entry = (name, timestamp, over = {}) => ({
  data: { name },
  timestamp,
  description: `Edited ${name}`,
  changeType: 'edit',
  ...over,
});
const doc = (history, historyIndex = history.length - 1) => ({ history, historyIndex });

describe('mergeHistory', () => {
  const mine = entry('mine', '2026-08-02T00:00:00.000Z');
  const theirs = entry('theirs', '2026-08-03T00:00:00.000Z');
  const shared = entry('shared', '2026-08-01T00:00:00.000Z');

  it('keeps both devices’ entries instead of letting the newer document replace the older', () => {
    // The reason this function exists: a conflict's LOSING résumé is parked in
    // history, so a history unit that replaced local history destroyed the
    // very thing "newer wins" promised to keep.
    const merged = mergeHistory(doc([shared, mine]), doc([shared, theirs]));
    expect(merged.history.map((e) => e.data.name)).toEqual(['shared', 'mine', 'theirs']);
  });

  it('is order-independent and idempotent', () => {
    // Two entries written in the same millisecond on different devices make
    // the tie-break load-bearing: sorted on timestamp alone they would come out
    // in whichever order the union happened to see them, which flips between
    // `merge(mine, theirs)` and `merge(theirs, mine)` — and both devices run
    // this with opposite arguments.
    const sameMs = '2026-08-04T00:00:00.000Z';
    const x = doc([shared, mine, entry('mine-tie', sameMs)]);
    const y = doc([shared, theirs, entry('theirs-tie', sameMs)]);
    expect(mergeHistory(x, y)).toEqual(mergeHistory(y, x));
    expect(mergeHistory(mergeHistory(x, y), y)).toEqual(mergeHistory(x, y));
    expect(mergeHistory(mergeHistory(x, y), mergeHistory(x, y))).toEqual(mergeHistory(x, y));
  });

  it('breaks the tie by code unit, so two Unicode-equivalent entries cannot order by argument order', () => {
    // The one property this function promises, and `localeCompare` broke it:
    // it returns 0 for two DISTINCT strings the locale calls equivalent — a
    // name composed on a Mac and decomposed on a phone, entirely ordinary for a
    // résumé. The two entries got different identities and compared EQUAL, so
    // the sort fell through to Map insertion order, which is argument order.
    // `merge(mine, theirs)` and `merge(theirs, mine)` then came out in opposite
    // orders, each device stored a different payload for the same content, and
    // they re-diverged every round — the resync-forever this tie-break exists
    // to prevent.
    expect(NFC).not.toBe(NFD);
    expect(NFC.localeCompare(NFD)).toBe(0);

    // Same timestamp, so only the tie-break can order them; and the entries
    // differ in nothing else, so no ASCII byte can order them for it.
    const at = '2026-08-04T00:00:00.000Z';
    const mineFirst = mergeHistory(doc([entry(NFC, at)]), doc([entry(NFD, at)]));
    const theirsFirst = mergeHistory(doc([entry(NFD, at)]), doc([entry(NFC, at)]));
    expect(mineFirst.history.map((e) => e.data.name)).toEqual(theirsFirst.history.map((e) => e.data.name));
    expect(mineFirst).toEqual(theirsFirst);
  });

  it('identifies an entry by its content, not by the order its keys were written', () => {
    // Entries have no id, so identity is a canonical hash. `JSON.stringify`
    // serialises in key-insertion order, so the same entry assembled by two
    // code paths — or round-tripped through storage — would hash differently
    // and survive the union twice, growing history on every sync.
    const reordered = {
      changeType: shared.changeType,
      description: shared.description,
      timestamp: shared.timestamp,
      data: { name: 'shared' },
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(shared));
    expect(mergeHistory(doc([shared]), doc([reordered])).history).toHaveLength(1);
  });

  it('does not mutate either argument', () => {
    const x = doc([mine]);
    const y = doc([theirs]);
    Object.freeze(x.history);
    Object.freeze(y.history);
    expect(() => mergeHistory(x, y)).not.toThrow();
    expect(x.history).toEqual([mine]);
    expect(y.history).toEqual([theirs]);
    expect(x.historyIndex).toBe(0);
  });

  it('orders by timestamp, oldest first, as pushHistory appends', () => {
    const merged = mergeHistory(doc([theirs]), doc([shared, mine]));
    expect(merged.history.map((e) => e.timestamp)).toEqual([
      '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z',
    ]);
  });

  it('caps at the store’s bound by dropping the OLDEST, the end pushHistory evicts from', () => {
    // One minute apart, so the ISO strings sort lexicographically the way the
    // merge compares them.
    const stamp = (i) => new Date(Date.UTC(2026, 7, 1) + i * 60000).toISOString();
    const a = doc(Array.from({ length: MAX_HISTORY }, (_, i) => entry(`a${i}`, stamp(i))));
    const b = doc(Array.from({ length: 10 }, (_, i) => entry(`b${i}`, stamp(MAX_HISTORY + i))));
    const merged = mergeHistory(a, b);

    expect(merged.history).toHaveLength(MAX_HISTORY);
    // The newest survive; cutting the new end would discard the entries the
    // merge just gained and make a union with a full history a no-op.
    expect(merged.history.at(-1).data.name).toBe('b9');
    expect(merged.history[0].data.name).toBe('a10');
  });

  it('points historyIndex at the newest entry, where the next edit splices nothing away', () => {
    // Everything after the index is store.js's redo future, which pushHistory
    // splices away on the next edit. An index left mid-array would delete the
    // entries this merge just brought in, one keystroke later.
    const merged = mergeHistory(doc([shared, mine], 0), doc([theirs], 0));
    expect(merged.historyIndex).toBe(merged.history.length - 1);
    expect(merged.history[merged.historyIndex].data.name).toBe('theirs');
  });

  it('survives a side that is missing, empty or malformed', () => {
    expect(mergeHistory(null, null)).toEqual({ history: [], historyIndex: -1 });
    expect(mergeHistory(null, doc([mine])).history).toHaveLength(1);
    expect(mergeHistory(doc([]), doc([mine])).historyIndex).toBe(0);
    // A non-object in `history` is not an entry: HistoryDialog would render it
    // as a blank row and restoring it would throw.
    expect(mergeHistory({ history: [null, 'x', mine] }, { history: 'nope' }).history).toEqual([mine]);
  });
});

describe('canonicalJSON', () => {
  it('calls two résumés the same when only their key order differs', () => {
    // store.js compares the document it holds against the one a history entry
    // carries to decide whether the loaded index still points at the document.
    // `JSON.stringify` serialises in key-insertion order, so the same résumé
    // stored earlier and rebuilt now would compare DIFFERENT and cost the user
    // a duplicate history entry on every load.
    const a = { name: 'Ash', sections: [{ id: 's1', title: 'Skills', content: ['a', 'b'] }] };
    const b = { sections: [{ content: ['a', 'b'], title: 'Skills', id: 's1' }], name: 'Ash' };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
    // Array order is data, not an artifact of construction, and is preserved.
    expect(canonicalJSON({ x: ['a', 'b'] })).not.toBe(canonicalJSON({ x: ['b', 'a'] }));
  });
});

describe('resolveConflict', () => {
  const local = { payload: '{"a":1}', modifiedAt: '2026-08-05T00:00:00.000Z' };
  const remote = { payload: '{"a":2}', modifiedAt: '2026-08-09T00:00:00.000Z' };

  it('keeps the newer edit and hands back the loser', () => {
    expect(resolveConflict(local, remote)).toEqual({ winner: remote, loser: local });
    expect(resolveConflict(remote, local)).toEqual({ winner: remote, loser: local });
  });

  it('prefers the remote on an exact tie, so two devices agree', () => {
    // Both sides run this. If they broke the tie differently they would
    // converge on different winners and sync forever.
    const a = { payload: '{"a":1}', modifiedAt: '2026-08-05T00:00:00.000Z' };
    const b = { payload: '{"a":2}', modifiedAt: '2026-08-05T00:00:00.000Z' };
    expect(resolveConflict(a, b).winner).toBe(b);
  });

  it('treats an unparseable timestamp as older than a real one', () => {
    const broken = { payload: '{}', modifiedAt: 'not a date' };
    expect(resolveConflict(broken, local).winner).toBe(local);
    expect(resolveConflict(local, broken).winner).toBe(local);
  });
});

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
