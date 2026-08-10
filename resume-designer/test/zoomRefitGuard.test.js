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

  return {
    resizeTo(width, height) {
      dim(scroller, 'clientWidth', width);
      dim(scroller, 'clientHeight', height);
    },
  };
}

const shownZoom = () => document.getElementById('zoom-level').textContent;

function fireAndSettle(eventName) {
  window.dispatchEvent(new Event(eventName));
  vi.advanceTimersByTime(200); // past the 150ms debounce
}

// initZoomControls has no teardown, and its resize listener resolves its
// elements by id at call time — so a previous test's module instance would
// happily refit THIS test's canvas. vi.resetModules() gives fresh module state
// but cannot detach listeners from the shared jsdom window, so capture them.
let detachListeners = () => {};

async function boot(opts) {
  const harness = mountCanvas(opts);

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
    expect(shownZoom()).toBe('45%'); // min(380/816, 480/1056)

    resizeTo(400, 900);
    fireAndSettle('resize');

    expect(shownZoom()).toBe('47%'); // min(380/816, 880/1056) — width now binds
  });

  it('refits a fitted canvas on orientationchange (the iOS rotation case)', async () => {
    const { resizeTo } = await boot({ clientWidth: 400, clientHeight: 500 });

    document.getElementById('zoom-fit').click();
    expect(shownZoom()).toBe('45%');

    resizeTo(900, 400);
    fireAndSettle('orientationchange');

    expect(shownZoom()).toBe('36%'); // min(880/816, 380/1056) — height now binds
  });

  it('stops refitting once the user zooms away from the fitted value', async () => {
    const { resizeTo } = await boot({ clientWidth: 400, clientHeight: 500 });

    document.getElementById('zoom-fit').click();
    expect(shownZoom()).toBe('45%');

    document.getElementById('zoom-in').click();
    expect(shownZoom()).toBe('55%');

    resizeTo(400, 900);
    fireAndSettle('resize');

    expect(shownZoom()).toBe('55%');
  });
});
