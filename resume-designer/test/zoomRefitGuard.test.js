import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The resize/orientation refit guard lives inside initZoomControls' closure, so
 * it needs the real DOM initZoomControls binds to. jsdom does no layout — every
 * client/scroll dimension reads 0, and computeFitZoom's documented fallback
 * turns unmeasurable input into 1 — so the sizes are defined explicitly.
 *
 * The sizes are chosen so an UNGUARDED refit produces a visibly different zoom
 * from the one under test; otherwise these tests would pass with the guard
 * deleted.
 */
function mountCanvas({ clientWidth = 400, clientHeight = 500 } = {}) {
  document.body.innerHTML = `
    <button id="zoom-in"></button>
    <button id="zoom-out"></button>
    <button id="zoom-fit"></button>
    <button id="zoom-reset"></button>
    <span id="zoom-level"></span>
    <div id="resume-scroller"><div id="resume-container"></div></div>
  `;
  const scroller = document.getElementById('resume-scroller');
  const container = document.getElementById('resume-container');

  // fitToView reads the REAL computed padding; jsdom's getComputedStyle
  // reflects inline styles, so set it inline. 10px each side => 20px both axes.
  scroller.style.padding = '10px';

  const dim = (el, prop, value) => Object.defineProperty(el, prop, { value, configurable: true });
  dim(scroller, 'clientWidth', clientWidth);
  dim(scroller, 'clientHeight', clientHeight);
  dim(container, 'scrollHeight', 11 * 96); // one Letter sheet
  dim(container, 'offsetHeight', 11 * 96); // ...and its LAYOUT height, unscaled

  return {
    resizeTo(width, height) {
      dim(scroller, 'clientWidth', width);
      dim(scroller, 'clientHeight', height);
    },
    growPageTo(height) {
      dim(container, 'offsetHeight', height);
    },
  };
}

const shownZoom = () => document.getElementById('zoom-level').textContent;

/**
 * A fit TRAVELS to its value now — an animation-frame loop, so the canvas and
 * its scroll position move together instead of teleporting. Run the frames.
 *
 * The frames are driven off `Date.now()`, which vitest's fake timers own, so
 * advancing the clock advances the travel: no real time passes and the landing
 * value is exact rather than however far a real 200ms happened to get.
 */
const settleFit = () => vi.advanceTimersByTime(400);

function fireAndSettle(eventName) {
  window.dispatchEvent(new Event(eventName));
  vi.advanceTimersByTime(200); // past the 150ms debounce
  settleFit();
}

// initZoomControls has no teardown, and its resize listener resolves its
// elements by id at call time — so a previous test's module instance would
// happily refit THIS test's canvas. vi.resetModules() gives fresh module state
// but cannot detach listeners from the shared jsdom window, so capture them.
let detachListeners = () => {};
let resizeCallbacks = [];

async function boot(opts) {
  const harness = mountCanvas(opts);
  resizeCallbacks = [];

  // jsdom's own rAF runs on real time, which fake timers cannot advance — the
  // travel would never finish inside a test. Backing it with setTimeout puts it
  // on the clock the test controls, at a plausible frame interval.
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  // jsdom has no ResizeObserver. Stand one in and keep its callback, so the
  // "the page got taller on its own" case is reachable.
  globalThis.ResizeObserver = class {
    constructor(cb) { resizeCallbacks.push(cb); }
    observe() {}
    disconnect() {}
  };

  const added = [];
  const realAdd = window.addEventListener.bind(window);
  window.addEventListener = (type, fn, options) => {
    added.push([type, fn, options]);
    realAdd(type, fn, options);
  };

  // Fresh module instance per test: currentZoom and lastFittedZoom are
  // module-level state.
  vi.resetModules();
  const mod = await import('../src/zoomControls.js');
  mod.initZoomControls();

  window.addEventListener = realAdd;
  detachListeners = () => added.forEach(([type, fn, options]) => window.removeEventListener(type, fn, options));

  return harness;
}

describe('resize refit guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    detachListeners();
    detachListeners = () => {};
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('leaves a manually chosen zoom alone when the window resizes', async () => {
    const { resizeTo } = await boot();

    document.getElementById('zoom-in').click();
    expect(shownZoom()).toBe('110%');

    // Unguarded, this refits to min(880/816, 1180/1056) => 108%.
    resizeTo(900, 1200);
    fireAndSettle('resize');

    expect(shownZoom()).toBe('110%');
  });

  it('does not overwrite a zoom restored from storage', async () => {
    localStorage.setItem('resume-zoom', '1.5');
    const { resizeTo } = await boot();
    expect(shownZoom()).toBe('150%');

    resizeTo(900, 1200);
    fireAndSettle('resize');

    expect(shownZoom()).toBe('150%');
  });

  it('keeps an explicitly fitted canvas fitted across a resize', async () => {
    const { resizeTo } = await boot({ clientWidth: 400, clientHeight: 500 });

    document.getElementById('zoom-fit').click();
    settleFit();
    expect(shownZoom()).toBe('45%'); // min(380/816, 480/1056)

    resizeTo(400, 900);
    fireAndSettle('resize');

    expect(shownZoom()).toBe('47%'); // min(380/816, 880/1056) — width now binds
  });

  it('refits a fitted canvas on orientationchange (the iOS rotation case)', async () => {
    const { resizeTo } = await boot({ clientWidth: 400, clientHeight: 500 });

    document.getElementById('zoom-fit').click();
    settleFit();
    expect(shownZoom()).toBe('45%');

    resizeTo(900, 400);
    fireAndSettle('orientationchange');

    expect(shownZoom()).toBe('36%'); // min(880/816, 380/1056) — height now binds
  });

  // The canvas used to arrive at a fit in one frame, which on a phone meant the
  // page changed size AND jumped across the screen at once — a fit from a
  // zoomed-in, panned canvas has to bring it back to the left edge too. It
  // travels now, and the scroll is carried along by the same anchoring a pinch
  // uses.
  it('travels to a fit rather than jumping to it', async () => {
    await boot({ clientWidth: 400, clientHeight: 500 });
    // The readout is only written when the zoom is; start it at a known value.
    document.getElementById('zoom-reset').click();
    expect(shownZoom()).toBe('100%');

    document.getElementById('zoom-fit').click();

    // Three frames in: under way, and nowhere near either end.
    vi.advanceTimersByTime(50);
    const underway = parseInt(shownZoom(), 10);
    expect(underway).toBeLessThan(100);
    expect(underway).toBeGreaterThan(45);

    // And it lands exactly on the fitted value, not near it.
    settleFit();
    expect(shownZoom()).toBe('45%');
  });

  // Below 100% the transform shrinks the page but not the box layout reserves
  // for it, so the scroller went on offering the full unscaled height — enough,
  // measured at 42%, to scroll the résumé right off the screen. The margin that
  // takes it back is CSS, but it cannot be: no length reads an element's own
  // height, so the height is published from here.
  const pageHeight = () =>
    document.getElementById('resume-container').style.getPropertyValue('--page-height');

  it('publishes the page height the over-scroll margin is computed from', async () => {
    await boot();
    expect(pageHeight()).toBe('1056px');
  });

  it('republishes it when the page changes height on its own', async () => {
    const { growPageTo } = await boot();
    expect(pageHeight()).toBe('1056px');

    // An edit, a repagination, a font that finished loading: taller, with the
    // zoom untouched. A stale height leaves exactly the dead space back.
    growPageTo(2112);
    resizeCallbacks.forEach((cb) => cb());

    expect(pageHeight()).toBe('2112px');
  });

  // The guard used to be "is the current zoom still the fitted value?", which
  // any coincidence satisfies — and this is not an exotic one: both values are
  // rounded to two decimals, so Zoom In followed by Zoom Out lands exactly back
  // on it. The canvas was silently armed again, and the next resize or rotation
  // refit it and persisted that over the zoom the person had chosen by hand.
  it('stays put when a manual zoom happens to land back on the fitted value', async () => {
    const { resizeTo } = await boot({ clientWidth: 400, clientHeight: 500 });

    document.getElementById('zoom-fit').click();
    settleFit();
    expect(shownZoom()).toBe('45%');

    document.getElementById('zoom-in').click();
    document.getElementById('zoom-out').click();
    expect(shownZoom()).toBe('45%'); // back on it, but chosen by hand now

    // Unguarded — or guarded only by the value — this refits to 47%.
    resizeTo(400, 900);
    fireAndSettle('resize');

    expect(shownZoom()).toBe('45%');
  });

  it('stops refitting once the user zooms away from the fitted value', async () => {
    const { resizeTo } = await boot({ clientWidth: 400, clientHeight: 500 });

    document.getElementById('zoom-fit').click();
    settleFit();
    expect(shownZoom()).toBe('45%');

    document.getElementById('zoom-in').click();
    expect(shownZoom()).toBe('55%');

    resizeTo(400, 900);
    fireAndSettle('resize');

    expect(shownZoom()).toBe('55%');
  });
});
