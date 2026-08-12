import { describe, it, expect } from 'vitest';
import { mergeTokenUsage, resolveConflict } from '../src/sync/syncMerge.js';

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
