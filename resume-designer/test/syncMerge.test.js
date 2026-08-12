import { describe, it, expect } from 'vitest';
import { mergeTokenUsage, mergeHistory, resolveConflict, MAX_HISTORY } from '../src/sync/syncMerge.js';

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
