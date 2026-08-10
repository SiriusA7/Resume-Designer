import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeAppHeight, installViewportHeight } from '../src/viewportHeight.js';

describe('computeAppHeight', () => {
  it('prefers the visual viewport, which shrinks for the keyboard', () => {
    // iPhone 16 Pro portrait: 874pt tall, ~336pt of keyboard.
    expect(computeAppHeight({ visualViewportHeight: 538, innerHeight: 874 })).toBe(538);
  });

  it('uses the visual viewport even when it equals innerHeight (no keyboard)', () => {
    expect(computeAppHeight({ visualViewportHeight: 874, innerHeight: 874 })).toBe(874);
  });

  it('returns null when there is no visual viewport, so CSS keeps its fallback', () => {
    expect(computeAppHeight({ visualViewportHeight: undefined, innerHeight: 874 })).toBeNull();
  });

  it('ignores a non-finite or zero visual viewport rather than collapsing the app', () => {
    expect(computeAppHeight({ visualViewportHeight: 0, innerHeight: 874 })).toBeNull();
    expect(computeAppHeight({ visualViewportHeight: Number.NaN, innerHeight: 874 })).toBeNull();
  });

  it('rounds down, so a fractional height never overflows the viewport by a pixel', () => {
    expect(computeAppHeight({ visualViewportHeight: 537.6, innerHeight: 874 })).toBe(537);
  });
});

describe('computeAppHeight with pinch-zoom scale', () => {
  it('returns null when pinch-zoomed, so the caller leaves the last height/fallback in place', () => {
    expect(computeAppHeight({ visualViewportHeight: 269, scale: 2 })).toBeNull();
  });

  it('still returns the height at scale 1 (not zoomed)', () => {
    expect(computeAppHeight({ visualViewportHeight: 538, scale: 1 })).toBe(538);
  });

  it('tolerates the fractional scales iOS reports at rest, e.g. 1.005', () => {
    expect(computeAppHeight({ visualViewportHeight: 538, scale: 1.005 })).toBe(538);
  });

  it('behaves exactly as before when scale is undefined', () => {
    expect(computeAppHeight({ visualViewportHeight: 538, innerHeight: 874 })).toBe(538);
    expect(computeAppHeight({ visualViewportHeight: 0, innerHeight: 874 })).toBeNull();
    expect(computeAppHeight({ visualViewportHeight: 537.6 })).toBe(537);
  });
});

describe('installViewportHeight', () => {
  // A real EventTarget so vv.addEventListener/dispatchEvent behave like the
  // browser API instead of a hand-rolled stand-in.
  class FakeVisualViewport extends EventTarget {
    constructor({ height, scale = 1 } = {}) {
      super();
      this.height = height;
      this.scale = scale;
    }
  }

  function createFakeTarget() {
    return {
      style: {
        setProperty: vi.fn(),
        removeProperty: vi.fn(),
      },
    };
  }

  afterEach(() => {
    delete window.visualViewport;
    vi.restoreAllMocks();
  });

  it('writes the property once for a repeated identical height', () => {
    const vv = new FakeVisualViewport({ height: 538 });
    window.visualViewport = vv;
    const target = createFakeTarget();

    installViewportHeight(target);
    vv.dispatchEvent(new Event('scroll'));
    vv.dispatchEvent(new Event('scroll'));
    vv.dispatchEvent(new Event('resize'));

    expect(target.style.setProperty).toHaveBeenCalledTimes(1);
    expect(target.style.setProperty).toHaveBeenCalledWith('--app-height', '538px');
  });

  it('a window resize triggers a sync', () => {
    const vv = new FakeVisualViewport({ height: 538 });
    window.visualViewport = vv;
    const target = createFakeTarget();

    installViewportHeight(target);
    expect(target.style.setProperty).toHaveBeenCalledTimes(1);

    vv.height = 400;
    window.dispatchEvent(new Event('resize'));

    expect(target.style.setProperty).toHaveBeenCalledTimes(2);
    expect(target.style.setProperty).toHaveBeenLastCalledWith('--app-height', '400px');
  });

  it('leaves the last-applied height in place while pinch-zoomed, without removing the property', () => {
    const vv = new FakeVisualViewport({ height: 538, scale: 1 });
    window.visualViewport = vv;
    const target = createFakeTarget();

    installViewportHeight(target);
    expect(target.style.setProperty).toHaveBeenCalledWith('--app-height', '538px');

    // layoutHeight / 2, as visualViewport.height would read while pinched to 2x.
    vv.height = 269;
    vv.scale = 2;
    vv.dispatchEvent(new Event('resize'));

    // Still just the one write from mount: the zoomed height was never applied,
    // and the property was never removed (that would fall back to 100dvh and
    // reflow too).
    expect(target.style.setProperty).toHaveBeenCalledTimes(1);
    expect(target.style.removeProperty).not.toHaveBeenCalled();
  });

  it('teardown removes every listener it added', () => {
    const vv = new FakeVisualViewport({ height: 538 });
    window.visualViewport = vv;
    const target = createFakeTarget();

    const vvAddSpy = vi.spyOn(vv, 'addEventListener');
    const vvRemoveSpy = vi.spyOn(vv, 'removeEventListener');
    const winAddSpy = vi.spyOn(window, 'addEventListener');
    const winRemoveSpy = vi.spyOn(window, 'removeEventListener');

    const teardown = installViewportHeight(target);
    teardown();

    const addedVvEvents = vvAddSpy.mock.calls.map(([type]) => type).sort();
    const removedVvEvents = vvRemoveSpy.mock.calls.map(([type]) => type).sort();
    expect(removedVvEvents).toEqual(addedVvEvents);
    expect(addedVvEvents).toEqual(['resize', 'scroll']);

    const addedWinEvents = winAddSpy.mock.calls.map(([type]) => type).sort();
    const removedWinEvents = winRemoveSpy.mock.calls.map(([type]) => type).sort();
    expect(removedWinEvents).toEqual(addedWinEvents);
    expect(addedWinEvents).toEqual(['orientationchange', 'resize']);
  });
});
