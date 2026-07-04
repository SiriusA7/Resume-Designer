import { describe, it, expect } from 'vitest';
import {
  makeThread, migrateThreads, groupThreadsByHome, pickCurrentThreadId,
  chooseThreadAfterDelete,
  lastTurnVariantId, withContextMarker,
  reassignThreadsForDeletedVariant, threadIdsForVariant,
} from '../src/chatThreads.js';

describe('makeThread homeVariantId', () => {
  it('defaults homeVariantId to null (General)', () => {
    expect(makeThread('x').homeVariantId).toBe(null);
  });
  it('stores a provided homeVariantId', () => {
    expect(makeThread('x', [], 'v-1').homeVariantId).toBe('v-1');
  });
});

describe('migrateThreads', () => {
  it('adds homeVariantId: null to legacy threads missing the field', () => {
    const out = migrateThreads([{ id: 'a', name: 'A', messages: [] }]);
    expect(out[0].homeVariantId).toBe(null);
  });
  it('preserves an existing homeVariantId', () => {
    const out = migrateThreads([{ id: 'a', homeVariantId: 'v-9', messages: [] }]);
    expect(out[0].homeVariantId).toBe('v-9');
  });
  it('returns [] for a non-array', () => {
    expect(migrateThreads(null)).toEqual([]);
  });
});

const T = (id, home, updatedAt) => ({ id, name: id, messages: [], homeVariantId: home, updatedAt });

describe('groupThreadsByHome', () => {
  const variants = [{ id: 'v1', name: 'Acme' }, { id: 'v2', name: 'Globex' }];
  const threads = [
    T('a', 'v1', '2026-01-03'), T('b', 'v1', '2026-01-05'),
    T('c', null, '2026-01-02'), T('d', 'v2', '2026-01-04'),
    T('e', 'v-deleted', '2026-01-01'),
  ];
  it('splits into current / general / others and sorts current by updatedAt desc', () => {
    const g = groupThreadsByHome(threads, 'v1', variants);
    expect(g.current.map((t) => t.id)).toEqual(['b', 'a']);
    expect(g.general.map((t) => t.id)).toEqual(['c', 'e']); // deleted-home falls into General
    expect(g.others).toEqual([{ variantId: 'v2', variantName: 'Globex', threads: [threads[3]] }]);
  });
  it('current is empty when the active variant has no threads', () => {
    expect(groupThreadsByHome(threads, 'v2', variants).current.map((t) => t.id)).toEqual(['d']);
    expect(groupThreadsByHome([], 'v1', variants).current).toEqual([]);
  });
});

describe('pickCurrentThreadId', () => {
  const threads = [T('a', 'v1', '2026-01-03'), T('b', 'v1', '2026-01-05'), T('c', 'v2', '2026-01-09')];
  it('returns the most-recent thread homed to the active variant', () => {
    expect(pickCurrentThreadId(threads, 'v1')).toBe('b');
  });
  it('returns null when the active variant has no threads', () => {
    expect(pickCurrentThreadId(threads, 'v3')).toBe(null);
  });
});

describe('chooseThreadAfterDelete', () => {
  it("selects the active variant's most-recent remaining thread (no new thread)", () => {
    const threads = [T('a', 'v1', '2026-01-03'), T('b', 'v1', '2026-01-05'), T('c', null, '2026-01-09')];
    const r = chooseThreadAfterDelete(threads, 'b', 'v1'); // delete current 'b'
    expect(r.currentThreadId).toBe('a'); // 'a' is v1's remaining thread
    expect(r.created).toBe(null);
    expect(r.threads.map((t) => t.id)).toEqual(['a', 'c']); // 'b' removed, 'c' kept
  });
  it('creates a thread homed to the active variant — never jumps to General/another résumé', () => {
    const threads = [T('a', 'v1', '2026-01-03'), T('c', null, '2026-01-09'), T('d', 'v2', '2026-01-08')];
    const r = chooseThreadAfterDelete(threads, 'a', 'v1'); // delete v1's only thread
    const cur = r.threads.find((t) => t.id === r.currentThreadId);
    expect(cur.homeVariantId).toBe('v1'); // new thread homed to the active variant
    expect(r.created).not.toBe(null);
    expect(r.currentThreadId).not.toBe('c'); // did NOT select the General thread
    expect(r.currentThreadId).not.toBe('d'); // did NOT select the other résumé's thread
    expect(r.threads.some((t) => t.id === 'c')).toBe(true); // General preserved
    expect(r.threads.some((t) => t.id === 'd')).toBe(true); // other résumé preserved
  });
  it('creates a homed thread when no threads remain', () => {
    const r = chooseThreadAfterDelete([T('a', 'v1', '2026-01-03')], 'a', 'v1');
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0].homeVariantId).toBe('v1');
    expect(r.currentThreadId).toBe(r.threads[0].id);
  });
});

describe('lastTurnVariantId', () => {
  it('returns the variantId of the last non-context message', () => {
    const msgs = [
      { role: 'user', variantId: 'v1' },
      { role: 'context', variantId: 'v2' },
      { role: 'assistant', variantId: 'v1' },
    ];
    expect(lastTurnVariantId(msgs)).toBe('v1');
  });
  it('returns null for an empty thread', () => {
    expect(lastTurnVariantId([])).toBe(null);
  });
});

describe('withContextMarker', () => {
  it('appends a context marker when the active variant differs from the last turn', () => {
    const msgs = [{ id: 'm1', role: 'user', variantId: 'v1' }];
    const out = withContextMarker(msgs, 'v2', 'Globex');
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: 'context', variantId: 'v2', variantName: 'Globex' });
    expect(typeof out[1].id).toBe('string');
  });
  it('is a no-op when the active variant matches the last turn', () => {
    const msgs = [{ id: 'm1', role: 'user', variantId: 'v1' }];
    expect(withContextMarker(msgs, 'v1', 'Acme')).toBe(msgs);
  });
  it('is a no-op for an empty thread (no prior turn to switch from)', () => {
    const msgs = [];
    expect(withContextMarker(msgs, 'v1', 'Acme')).toBe(msgs);
  });
});

describe('reassignThreadsForDeletedVariant', () => {
  const threads = [
    { id: 'a', homeVariantId: 'v1' }, { id: 'b', homeVariantId: 'v2' },
    { id: 'c', homeVariantId: null },
  ];
  it("mode 'general' clears homeVariantId for the deleted variant's threads", () => {
    const out = reassignThreadsForDeletedVariant(threads, 'v1', 'general');
    expect(out.find((t) => t.id === 'a').homeVariantId).toBe(null);
    expect(out.find((t) => t.id === 'b').homeVariantId).toBe('v2'); // untouched
  });
  it("mode 'delete' removes the deleted variant's threads", () => {
    const out = reassignThreadsForDeletedVariant(threads, 'v1', 'delete');
    expect(out.map((t) => t.id)).toEqual(['b', 'c']);
  });
});

describe('threadIdsForVariant', () => {
  const threads = [
    { id: 'a', homeVariantId: 'v1' }, { id: 'b', homeVariantId: 'v2' },
    { id: 'c', homeVariantId: null }, { id: 'd', homeVariantId: 'v1' },
  ];
  it("returns exactly the ids a 'delete' reassign would drop", () => {
    const ids = threadIdsForVariant(threads, 'v1');
    expect(ids).toEqual(['a', 'd']);
    const kept = reassignThreadsForDeletedVariant(threads, 'v1', 'delete').map((t) => t.id);
    expect(kept.filter((id) => ids.includes(id))).toEqual([]);
  });
  it('treats a missing homeVariantId as General (null)', () => {
    expect(threadIdsForVariant([{ id: 'x' }], null)).toEqual(['x']);
  });
  it('returns [] for a non-array', () => {
    expect(threadIdsForVariant(undefined, 'v1')).toEqual([]);
  });
});
