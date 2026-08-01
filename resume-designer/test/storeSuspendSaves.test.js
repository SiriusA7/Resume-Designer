import { describe, it, expect, vi, beforeEach } from 'vitest';
import { store } from '../src/store.js';

// suspendSaves latches the per-file singleton one-way, so reset it before each
// case — otherwise a prior test's latch leaves scheduleSave() a no-op here and
// the debounce-cancellation assertion would pass even with the logic removed.
beforeEach(() => { store.resumeSaves(); });

// Regression (PR #92 Codex P1 — "Prevent stale saves after a full restore"):
// a format-2 restore rewrites appStorage, but the in-memory store still holds
// the STALE pre-import resume until the reload. In that window the
// visibilitychange / window-close handlers call store.saveNow(), which would
// write the stale resume back into the just-restored profile and corrupt the
// backup. store.suspendSaves() latches saving off so those handlers no-op.
//
// Own test file: suspendSaves is intentionally one-way (the only path forward
// from a restore is the reload), so a fresh per-file store singleton keeps the
// latch from leaking into other suites.
describe('store.suspendSaves', () => {
  it('makes saveNow a no-op that still reports success', () => {
    let writes = 0;
    store.setData({ name: 'stale', sections: [] }, true, null);
    store.onSave(() => { writes += 1; return true; });

    store.suspendSaves();
    const result = store.saveNow();

    // Shutdown callers (close/visibilitychange) must not read the no-op as a
    // failure, and the stale resume must NOT be written back.
    expect(result).toBe(true);
    expect(writes).toBe(0);
  });

  it('cancels a debounced save armed by an edit', () => {
    vi.useFakeTimers();
    try {
      let writes = 0;
      store.setData({ name: 'stale', sections: [] }, true, null);
      store.onSave(() => { writes += 1; return true; });

      store.update('name', 'edited'); // dirties the store + arms the 500ms debounce
      store.suspendSaves();           // …latch off before it can fire
      vi.advanceTimersByTime(2000);

      expect(writes).toBe(0); // the armed save was cancelled, not just skipped
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports acquisition only when it flips the latch off→on', () => {
    // tryAcquire semantics: exactly one caller per suspend/resume cycle owns the
    // suspension, so only that caller may resume it. backupFlow relies on this —
    // a valid import retry that re-latches an existing suspension (left by a
    // prior Replace whose success-modal flush failed) must NOT resume it on
    // rollback, or the stale store overwrites the restored data on next close.
    expect(store.suspendSaves()).toBe(true); // acquired: off → on
    expect(store.suspendSaves()).toBe(false); // already suspended — not ours
    store.resumeSaves();
    expect(store.suspendSaves()).toBe(true); // released, so acquirable again
  });
});
