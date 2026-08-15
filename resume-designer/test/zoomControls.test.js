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
    // ~0.166 (700 / 4224) but MIN_ZOOM is 0.25. Phase 3.3 lowers MIN_ZOOM; this test pins
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

describe('fitting to width only', () => {
  // "Fit to view" fits the whole page, so a portrait page on a phone is mostly
  // margin — the text ends up too small to read. Fitting the WIDTH fills the
  // view edge to edge and lets the page run off the bottom, which is what you
  // want while reading rather than while judging the layout.
  const view = { availableWidth: 400, availableHeight: 800 };
  const page = { contentWidth: 816, contentHeight: 3168 };  // 8.5in, ~3 pages

  it('ignores the height, which is what makes it different', () => {
    // Whole-page fit is HEIGHT-bound on a three-page résumé (800/3168), and
    // that is the number that makes the text unreadable. Width-bound is nearly
    // twice it.
    expect(computeFitZoom({ ...view, ...page })).toBeCloseTo(800 / 3168, 5);
    expect(computeFitZoom({ ...view, ...page, axis: 'width' })).toBeCloseTo(400 / 816, 5);
  });

  it('still respects the zoom limits', () => {
    expect(computeFitZoom({
      availableWidth: 10_000, availableHeight: 10_000, ...page, axis: 'width',
    })).toBe(2);
  });

  it('does not need a measurable height to answer', () => {
    // The height is exactly what a width fit has no opinion about, so an
    // unmeasurable one must not collapse it to the 1 that means "no idea".
    expect(computeFitZoom({
      availableWidth: 400, availableHeight: 0, contentWidth: 816, contentHeight: 0,
      axis: 'width',
    })).toBeCloseTo(400 / 816, 5);
  });

  it('leaves the whole-page fit exactly as it was', () => {
    expect(computeFitZoom({
      availableWidth: 400, availableHeight: 0, contentWidth: 816, contentHeight: 0,
    })).toBe(1);
  });
});
