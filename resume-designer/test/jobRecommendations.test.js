// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { store } from '../src/store.js';
import { applyRecommendationToStore } from '../src/jobRecommendations.js';

// Regression for the Codex finding on the next→main flow: AI analysis items
// come from model JSON, so a recommendation may omit `section` — JobsDialog
// then passes undefined through, and the matcher used to throw on
// sectionName.includes(...) instead of returning false (which is what lets
// the UI show its "could not apply" toast).

beforeEach(() => {
  localStorage.clear();
  store.setData({ summary: 'old summary', experience: [], sections: [], contact: {} }, true);
});

describe('applyRecommendationToStore', () => {
  it('applies a direct-mapped section', () => {
    expect(applyRecommendationToStore('summary', 'old summary', 'new summary')).toBe(true);
    expect(store.getData().summary).toBe('new summary');
  });

  it('returns false instead of throwing when the section is missing', () => {
    expect(applyRecommendationToStore(undefined, 'x', 'y')).toBe(false);
    expect(applyRecommendationToStore(null, 'x', 'y')).toBe(false);
    expect(store.getData().summary).toBe('old summary'); // nothing written
  });
});
