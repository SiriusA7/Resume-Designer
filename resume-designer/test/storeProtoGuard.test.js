import { describe, it, expect, vi, afterEach } from 'vitest';
import { store } from '../src/store.js';

// store.update writes through the shared guarded setByPath (diffEngine.js).
// AI-supplied paths reach store.update via applyChangeToStore, so a
// __proto__/constructor/prototype segment must be refused HERE too — not only
// in createChangeSet's pre-filter — or a future path routing untrusted text
// straight to the store would pollute Object.prototype for the whole process.
// (store is a singleton; vitest isolates modules per test file, so this file
// owns it.)
afterEach(() => {
  delete Object.prototype.polluted;
});

describe('store.update prototype-pollution guard', () => {
  it('ignores a __proto__ path instead of polluting Object.prototype', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.setData({ name: 'n', sections: [] }, true, null);
    store.update('__proto__.polluted', 'x');
    expect(Object.prototype.polluted).toBeUndefined();
    expect({}.polluted).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('ignores constructor/prototype segments too', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.setData({ name: 'n', sections: [] }, true, null);
    store.update('constructor.prototype.polluted', 'x');
    expect(Object.prototype.polluted).toBeUndefined();
  });
});
