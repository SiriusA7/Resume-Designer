import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { contentPointAt, anchorScrollDelta } from '../src/zoomControls.js';

/**
 * Pinch zoom: the value a gesture frame applies, and where the canvas ends up.
 *
 * Two bugs on device drove these. A pinch stepped from one whole percent to the
 * next instead of tracking the fingers, and it always zoomed toward the
 * top-left corner however far from there the fingers were.
 */

describe('anchor arithmetic', () => {
  it('converts a focal point to content coordinates by undoing the scale', () => {
    // Container origin at (200, 300); fingers 100px right and 60px below it.
    // At 2x that is 50 x 30 of unscaled content.
    expect(contentPointAt({
      focusX: 300, focusY: 360, originX: 200, originY: 300, scale: 2,
    })).toEqual({ x: 50, y: 30 });
  });

  it('falls back to scale 1 rather than dividing by zero', () => {
    expect(contentPointAt({
      focusX: 300, focusY: 360, originX: 200, originY: 300, scale: 0,
    })).toEqual({ x: 100, y: 60 });
  });

  it('round-trips: the delta puts the anchor back under the fingers', () => {
    const focusX = 300;
    const focusY = 360;
    const anchor = contentPointAt({
      focusX, focusY, originX: 200, originY: 300, scale: 1,
    });

    // At a new scale the origin has moved too — the container's centring
    // margins are a function of the zoom, so this is the general case.
    for (const [scale, originX, originY] of [[2, 140, 300], [0.4, 260, 300], [1, 200, 300]]) {
      const { dx, dy } = anchorScrollDelta({
        anchorX: anchor.x, anchorY: anchor.y, focusX, focusY, originX, originY, scale,
      });
      // Scrolling by (dx, dy) moves the origin by (-dx, -dy).
      expect((originX - dx) + anchor.x * scale).toBeCloseTo(focusX, 9);
      expect((originY - dy) + anchor.y * scale).toBeCloseTo(focusY, 9);
    }
  });
});

/**
 * jsdom does no layout, so the container's rect is stubbed. The stub reads the
 * scale the module actually WROTE and the scroll offsets it actually set,
 * modelling only what is true of any engine: the origin moves when the page
 * scrolls, and — because main.css derives the centring margins from `--zoom` —
 * when the scale changes. It is deliberately not a reimplementation of those
 * margins; the assertions below are the invariant ("the anchored point stays
 * under the fingers"), not the formula.
 */
const ORIGIN_X = 200;
const ORIGIN_Y = 300;
// Deliberately not 100, which is the anchor these tests pinch at: with the two
// equal, the margin shift cancels the anchor's growth exactly and every case
// below passes at scrollLeft 0 — including one with no scroll compensation.
const MARGIN_PER_ZOOM = 30;

function mountCanvas() {
  document.body.innerHTML = `
    <button id="zoom-in"></button>
    <button id="zoom-out"></button>
    <span id="zoom-level"></span>
    <div id="resume-scroller"><div id="resume-container"></div></div>
  `;
  const scroller = document.getElementById('resume-scroller');
  const container = document.getElementById('resume-container');

  // jsdom's scrollLeft/scrollTop are plain writable properties that never
  // clamp, which is what we want: clamping is the browser's job and would only
  // hide arithmetic here.
  const appliedScale = () => {
    const m = /scale\(([\d.]+)\)/.exec(container.style.transform || '');
    return m ? parseFloat(m[1]) : 1;
  };
  container.getBoundingClientRect = () => {
    const z = appliedScale();
    return {
      left: ORIGIN_X - MARGIN_PER_ZOOM * (z - 1) - scroller.scrollLeft,
      top: ORIGIN_Y - scroller.scrollTop,
      width: 816 * z,
      height: 1056 * z,
      right: 0, bottom: 0, x: 0, y: 0,
    };
  };

  return { scroller, container, appliedScale };
}

/** Where a content point currently renders, in client px. */
const renderedAt = ({ container, appliedScale }, contentX, contentY) => {
  const rect = container.getBoundingClientRect();
  return {
    x: rect.left + contentX * appliedScale(),
    y: rect.top + contentY * appliedScale(),
  };
};

describe('setZoomLevel', () => {
  let canvas;
  let setZoomLevel;
  let getZoom;

  beforeEach(async () => {
    localStorage.clear();
    canvas = mountCanvas();
    // currentZoom is module-level state.
    vi.resetModules();
    ({ setZoomLevel, getZoom } = await import('../src/zoomControls.js'));
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('applies a gesture frame at full precision', () => {
    // Rounded to whole percent this is 0.52 — a 2% jump at this scale, which
    // is what made a pinch travel in visible steps.
    setZoomLevel(0.5237, true, { x: 300, y: 360 });
    expect(getZoom()).toBe(0.5237);
  });

  it('rounds and persists only when the gesture ends', () => {
    setZoomLevel(0.5237, true, { x: 300, y: 360 });
    expect(localStorage.getItem('resume-zoom')).toBe(null);

    setZoomLevel(0.5237, false, { x: 300, y: 360 });
    expect(getZoom()).toBe(0.52);
    expect(localStorage.getItem('resume-zoom')).toBe('0.52');
  });

  it('still rounds and persists a button-driven zoom', () => {
    setZoomLevel(0.5237);
    expect(getZoom()).toBe(0.52);
    expect(localStorage.getItem('resume-zoom')).toBe('0.52');
  });

  it('holds the pinched point under the fingers as the scale grows', () => {
    const focus = { x: 300, y: 360 };
    // The content under the fingers before the gesture: 100 x 60 in from the
    // container's corner, at zoom 1.
    const anchor = { x: 100, y: 60 };
    expect(renderedAt(canvas, anchor.x, anchor.y)).toEqual(focus);

    setZoomLevel(2, true, focus);

    const after = renderedAt(canvas, anchor.x, anchor.y);
    expect(after.x).toBeCloseTo(focus.x, 6);
    expect(after.y).toBeCloseTo(focus.y, 6);
    // Not the corner case by accident: the canvas really did scroll.
    expect(canvas.scroller.scrollLeft).not.toBe(0);
  });

  it('holds it across every frame of a gesture, then on the final one', () => {
    const focus = { x: 300, y: 360 };
    const anchor = { x: 100, y: 60 };

    for (const scale of [1.15, 1.4, 1.85, 0.9, 0.45]) {
      setZoomLevel(scale, true, focus);
      const at = renderedAt(canvas, anchor.x, anchor.y);
      expect(at.x).toBeCloseTo(focus.x, 6);
      expect(at.y).toBeCloseTo(focus.y, 6);
    }

    setZoomLevel(0.45, false, focus);
    const at = renderedAt(canvas, anchor.x, anchor.y);
    expect(at.x).toBeCloseTo(focus.x, 6);
    expect(at.y).toBeCloseTo(focus.y, 6);
  });

  it('follows the fingers when they move, so a two-finger drag pans', () => {
    setZoomLevel(1.5, true, { x: 300, y: 360 });
    const scrolledTo = canvas.scroller.scrollLeft;

    // Same scale, fingers 40px to the right: the page should come with them.
    setZoomLevel(1.5, true, { x: 340, y: 360 });
    expect(canvas.scroller.scrollLeft).toBeCloseTo(scrolledTo - 40, 6);
  });

  it('anchors to where the gesture STARTED, not to wherever it has reached', () => {
    const focus = { x: 300, y: 360 };
    setZoomLevel(1.2, true, focus);
    setZoomLevel(2, true, focus);

    // Anchored per-frame instead, each frame would re-read the point already
    // under the fingers and the delta would collapse to zero.
    const at = renderedAt(canvas, 100, 60);
    expect(at.x).toBeCloseTo(focus.x, 6);
    expect(at.y).toBeCloseTo(focus.y, 6);
  });

  it('starts a fresh anchor for the next gesture', () => {
    setZoomLevel(2, true, { x: 300, y: 360 });
    setZoomLevel(2, false, { x: 300, y: 360 });

    // A second pinch, fingers somewhere else: the point under THEM is what
    // has to stay put now.
    const focus = { x: 500, y: 400 };
    const rect = canvas.container.getBoundingClientRect();
    const anchor = { x: (focus.x - rect.left) / 2, y: (focus.y - rect.top) / 2 };

    setZoomLevel(1, true, focus);

    const at = renderedAt(canvas, anchor.x, anchor.y);
    expect(at.x).toBeCloseTo(focus.x, 6);
    expect(at.y).toBeCloseTo(focus.y, 6);
  });

  it('leaves the scroll alone for a zoom with no gesture behind it', () => {
    canvas.scroller.scrollLeft = 25;
    canvas.scroller.scrollTop = 40;

    setZoomLevel(1.5);

    expect(canvas.scroller.scrollLeft).toBe(25);
    expect(canvas.scroller.scrollTop).toBe(40);
  });

  it('suppresses the zoom transition for the duration of the gesture', () => {
    setZoomLevel(1.5, true, { x: 300, y: 360 });
    expect(canvas.container.classList.contains('is-zooming')).toBe(true);

    setZoomLevel(1.5, false, { x: 300, y: 360 });
    // Removed on the next frame, once the final value has been committed.
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        expect(canvas.container.classList.contains('is-zooming')).toBe(false);
        resolve();
      });
    });
  });

  it('clamps to the same range the buttons use', () => {
    expect(setZoomLevel(9, true, { x: 300, y: 360 })).toBe(2);
    expect(setZoomLevel(0.01, true, { x: 300, y: 360 })).toBe(0.25);
  });

  it('ignores a non-finite level', () => {
    setZoomLevel(1.5, false);
    expect(setZoomLevel(NaN)).toBe(1.5);
    expect(getZoom()).toBe(1.5);
  });
});
