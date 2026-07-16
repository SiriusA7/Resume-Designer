import { describe, it, expect, afterEach } from 'vitest';
import { store } from '../src/store.js';

// store is a singleton; vitest isolates modules per test file, so this file owns
// it. Restore a no-op callback after each test regardless.
afterEach(() => { store.onSave(() => true); });

describe('store.saveNow durability signal (profile-switch abort)', () => {
  it('returns false when the persist callback reports failure', () => {
    store.setData({ name: 'n', sections: [] }, true, null);
    store.onSave(() => false);
    expect(store.saveNow()).toBe(false);
  });

  it('returns true when the persist callback succeeds', () => {
    store.setData({ name: 'n', sections: [] }, true, null);
    store.onSave(() => true);
    expect(store.saveNow()).toBe(true);
  });

  it('treats an undefined callback return as success (legacy callbacks)', () => {
    store.setData({ name: 'n', sections: [] }, true, null);
    store.onSave(() => undefined);
    expect(store.saveNow()).toBe(true);
  });
});
