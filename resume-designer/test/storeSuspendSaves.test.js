import { describe, it, expect, vi } from 'vitest';
import { store } from '../src/store.js';

// Regression (PR #92 Codex P1 — "Prevent stale saves after a full restore"):
// a format-2 restore rewrites appStorage, but the in-memory store still holds
// the STALE pre-import résumé until the reload. In that window the
// visibilitychange / window-close handlers call store.saveNow(), which would
// write the stale résumé back into the just-restored profile and corrupt the
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
    // failure, and the stale résumé must NOT be written back.
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
});
