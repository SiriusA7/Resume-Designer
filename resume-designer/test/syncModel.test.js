import { describe, it, expect, beforeEach, vi } from 'vitest';

// appStorage is the only dependency, and it is mocked so these tests stay
// pure: the real one is an async coalescing writer over a disk backend.
//
// The mock reproduces the real asymmetry deliberately, because it is what a
// naive implementation gets wrong: `keys()` returns PHYSICAL, profile-
// namespaced keys, while `getItem`/`setItem` take LOGICAL ones. A mock that
// returned logical keys from `keys()` would pass against code that never
// syncs anything.
const PROFILE = 'p-test';
const store = new Map();
const physical = (k) => `resume-p--${PROFILE}--${k}`;
vi.mock('../src/appStorage.js', () => ({
  appStorage: {
    getItem: (k) => (store.has(physical(k)) ? store.get(physical(k)) : null),
    setItem: (k, v) => { store.set(physical(k), v); },
    keys: () => [...store.keys()],
  },
}));

const { collectUnits, applyUnits, parkLoser, touchUnit } = await import('../src/sync/syncModel.js');

const DATA = 'resume-designer-data';

beforeEach(() => {
  store.clear();
  store.set(physical(DATA), JSON.stringify({
    variants: { 'v-1': { name: 'Design Engineer' } },
    currentVariantId: 'v-1',
    settings: { pageSize: 'letter' },
  }));
  store.set(physical('resume-designer-applications'), '[]');
  store.set(physical('resume-zoom'), '1.5');
});

describe('collectUnits', () => {
  it('emits a unit per résumé and per synced key, and nothing device-local', () => {
    const ids = collectUnits().map((u) => u.id);
    expect(ids).toContain('resume:v-1');
    expect(ids).toContain('key:resume-designer-applications');
    expect(ids).not.toContain('key:resume-zoom');
    // The data blob never travels whole — it travels decomposed.
    expect(ids).not.toContain('key:resume-designer-data');
  });

  it('stamps every unit with a modification time', () => {
    for (const unit of collectUnits()) {
      expect(Number.isFinite(Date.parse(unit.modifiedAt)), unit.id).toBe(true);
    }
  });

  it('marks token usage with its own kind so the transport can merge it', () => {
    store.set(physical('resume-designer-token-usage'), JSON.stringify({ events: [], summary: {} }));
    const unit = collectUnits().find((u) => u.id === 'key:resume-designer-token-usage');
    expect(unit.kind).toBe('tokenUsage');
  });
});

describe('applyUnits', () => {
  it('lands a remote résumé without touching the local currentVariantId', () => {
    applyUnits([{
      id: 'resume:v-2', kind: 'resume',
      payload: JSON.stringify({ name: 'Product Lead' }),
      modifiedAt: '2026-08-09T00:00:00.000Z',
    }]);
    const blob = JSON.parse(store.get(physical(DATA)));
    expect(Object.keys(blob.variants).sort()).toEqual(['v-1', 'v-2']);
    expect(blob.currentVariantId).toBe('v-1');
  });

  it('merges token usage instead of replacing it', () => {
    store.set(physical('resume-designer-token-usage'), JSON.stringify({
      events: [{ id: 'mine', timestamp: '2026-08-01T00:00:00.000Z', inputTokens: 1 }],
      summary: {},
    }));
    applyUnits([{
      id: 'key:resume-designer-token-usage', kind: 'tokenUsage',
      payload: JSON.stringify({
        events: [{ id: 'theirs', timestamp: '2026-08-02T00:00:00.000Z', inputTokens: 2 }],
        summary: {},
      }),
      modifiedAt: '2026-08-09T00:00:00.000Z',
    }]);
    const merged = JSON.parse(store.get(physical('resume-designer-token-usage')));
    expect(merged.events.map((e) => e.id)).toEqual(['mine', 'theirs']);
    expect(merged.summary.totalInputTokens).toBe(3);
  });

  it('refuses a unit for a key that is device-local', () => {
    const before = store.get(physical('resume-zoom'));
    applyUnits([{ id: 'key:resume-zoom', kind: 'plain', payload: '"2"', modifiedAt: '2026-08-09T00:00:00.000Z' }]);
    expect(store.get(physical('resume-zoom'))).toBe(before);
  });

  it('reports how many landed, so a caller can tell a no-op from a failure', () => {
    expect(applyUnits([]).applied).toBe(0);
  });
});

describe('parkLoser', () => {
  // The real key/shape, confirmed against src/store.js (saveHistory/
  // loadHistory) and src/components/HistoryDialog.jsx: the value at
  // `resume-designer-history-<variantId>` (BACKUP_HISTORY_PREFIX + variantId
  // — no "-variant-" infix) is `{ history: [...], historyIndex }`, and each
  // entry the dialog renders carries `data`, `timestamp`, `description` and
  // `changeType`. A brief that wrote a bare array to
  // `resume-designer-history-variant-<id>` would park the loser at a key
  // nothing reads and in a shape loadHistory() would discard on the next load.
  it('writes a losing résumé into that résumé’s version history, in the shape store.js reads', () => {
    const ok = parkLoser('resume:v-1', JSON.stringify({ name: 'The version that lost' }));
    expect(ok).toBe(true);
    const historyData = JSON.parse(store.get(physical('resume-designer-history-v-1')));
    expect(Array.isArray(historyData.history)).toBe(true);
    const entry = historyData.history.at(-1);
    expect(entry.data).toEqual({ name: 'The version that lost' });
    expect(entry.changeType).toBe('sync-conflict');
    expect(typeof entry.description).toBe('string');
    expect(entry.description.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
  });

  it('appends to existing history rather than clobbering it, and keeps historyIndex pointed at what was current', () => {
    store.set(physical('resume-designer-history-v-1'), JSON.stringify({
      history: [{
        data: { name: 'Design Engineer' },
        timestamp: '2026-08-01T00:00:00.000Z',
        description: 'Initial state',
        changeType: 'initial',
      }],
      historyIndex: 0,
    }));
    parkLoser('resume:v-1', JSON.stringify({ name: 'The version that lost' }));
    const historyData = JSON.parse(store.get(physical('resume-designer-history-v-1')));
    expect(historyData.history).toHaveLength(2);
    expect(historyData.history[0].description).toBe('Initial state');
    expect(historyData.historyIndex).toBe(0);
  });

  it('refuses a unit that is not a résumé, which has no history to park in', () => {
    expect(parkLoser('key:resume-designer-applications', '[]')).toBe(false);
  });
});

describe('touchUnit', () => {
  it('records a modification time that collectUnits then reports', () => {
    touchUnit('resume:v-1');
    const unit = collectUnits().find((u) => u.id === 'resume:v-1');
    const state = JSON.parse(store.get(physical('resume-designer-sync-state')));
    expect(unit.modifiedAt).toBe(state['resume:v-1'].modifiedAt);
  });
});
