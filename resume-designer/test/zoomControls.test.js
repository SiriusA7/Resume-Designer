import { describe, it, expect } from 'vitest';
import { computeFitZoom } from '../src/zoomControls.js';

const LETTER_W = 8.5 * 96;   // 816
const SHEET_H  = 11 * 96;    // 1056

describe('computeFitZoom', () => {
  it('fits width when width is the binding constraint', () => {
    // 402pt phone, 24px padding each side -> 354 available
    const z = computeFitZoom({
      availableWidth: 354, availableHeight: 2000,
      contentWidth: LETTER_W, contentHeight: SHEET_H,
    });
    expect(z).toBeCloseTo(354 / LETTER_W, 5);
  });

  it('fits height when height is the binding constraint', () => {
    const z = computeFitZoom({
      availableWidth: 2000, availableHeight: 528,
      contentWidth: LETTER_W, contentHeight: SHEET_H,
    });
    expect(z).toBeCloseTo(528 / SHEET_H, 5);
  });

  it('never exceeds maxZoom', () => {
    const z = computeFitZoom({
      availableWidth: 5000, availableHeight: 5000,
      contentWidth: LETTER_W, contentHeight: SHEET_H,
      maxZoom: 2,
    });
    expect(z).toBe(2);
  });

  it('clamps to minZoom, which means a long resume does NOT fully fit', () => {
    // Documented limitation, not desired behaviour: a 4-sheet resume needs
    // ~0.22 but MIN_ZOOM is 0.25. Phase 3.3 lowers MIN_ZOOM; this test pins
    // today's behaviour so that change is visible when it happens.
    const z = computeFitZoom({
      availableWidth: 354, availableHeight: 700,
      contentWidth: LETTER_W, contentHeight: SHEET_H * 4,
      minZoom: 0.25,
    });
    expect(z).toBe(0.25);
  });

  it('returns 1 for unmeasurable input rather than NaN or 0', () => {
    expect(computeFitZoom({ availableWidth: 0, availableHeight: 0,
                            contentWidth: 0, contentHeight: 0 })).toBe(1);
    expect(computeFitZoom({ availableWidth: NaN, availableHeight: 100,
                            contentWidth: 100, contentHeight: 100 })).toBe(1);
  });
});
