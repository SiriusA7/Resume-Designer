/**
 * Keyboard-safe app height.
 *
 * `100vh` is the LARGE viewport on iOS: it does not shrink when the software
 * keyboard appears, and `100dvh` does not either in WKWebView. `visualViewport`
 * does. So publish its height as `--app-height` and let the CSS fall back to
 * `100dvh` wherever the API is absent (older engines, the print window).
 */

// visualViewport.scale reports fractional noise at rest (e.g. 1.0000001 on
// iOS), so "zoomed" needs a tolerance rather than a `> 1` check.
const PINCH_ZOOM_SCALE_TOLERANCE = 1.01;

/**
 * @param {{visualViewportHeight?: number, innerHeight?: number, scale?: number}} input
 * @returns {number|null} px height, or null to leave the CSS fallback / last
 *   applied value in place (pinch-zoomed, or no usable height)
 */
export function computeAppHeight({ visualViewportHeight, scale }) {
  // Pinch-zoomed: visualViewport.height is layoutHeight / scale, so publishing
  // it here would shrink --app-height and reflow the page into the zoomed
  // sub-rect instead of letting the browser magnify it in place.
  if (Number.isFinite(scale) && scale > PINCH_ZOOM_SCALE_TOLERANCE) return null;
  if (!Number.isFinite(visualViewportHeight) || visualViewportHeight <= 0) return null;
  // Floor rather than round: a fractional height rounded UP overflows the
  // viewport by a pixel and reintroduces the scroll it exists to prevent.
  return Math.floor(visualViewportHeight);
}

/**
 * Publish `--app-height` and keep it current. Returns a teardown function.
 * @param {HTMLElement} [target]
 * @returns {() => void}
 */
export function installViewportHeight(target = document.documentElement) {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;

  // Last value actually written (a px number, or null meaning "removed").
  // `scroll` fires continuously while iOS pans/settles the visual viewport
  // around a focused field, so without this cache every tick would rewrite
  // an inherited custom property on <html> and force a full document style
  // recalc + layout - exactly when the keyboard is opening.
  let lastApplied = null;

  const sync = () => {
    const scale = vv?.scale;
    // computeAppHeight returns null for two different reasons, and they need
    // different handling here:
    //  - pinch-zoomed: leave whatever height is already applied untouched.
    //    Removing the property would fall back to 100dvh, which reflows the
    //    page too - the exact thing this guards against.
    //  - no usable height (no visualViewport, or an invalid reading): fall
    //    back to the CSS default by removing the property.
    // computeAppHeight can't tell these apart from a bare `null`, so the
    // pinch-zoom case is checked here first and short-circuits before that
    // ambiguity matters.
    if (Number.isFinite(scale) && scale > PINCH_ZOOM_SCALE_TOLERANCE) return;

    const height = computeAppHeight({ visualViewportHeight: vv?.height, scale });
    if (height === lastApplied) return;
    if (height == null) target.style.removeProperty('--app-height');
    else target.style.setProperty('--app-height', `${height}px`);
    lastApplied = height;
  };

  sync();
  if (!vv) return () => {};

  // `scroll` as well as `resize`: iOS scrolls the visual viewport to reveal a
  // focused field, and the height can settle a frame after the resize.
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  window.addEventListener('orientationchange', sync);
  // Hedge for the Mac app: if WebKit ever doesn't fire visualViewport.resize
  // for a plain window resize, --app-height would stay pinned to its launch
  // value (dead space below .app when the window grows, clipped header/chat
  // panel when it shrinks). Redundant with vv's own resize event when both
  // fire, but the equality guard above makes that duplicate call free.
  window.addEventListener('resize', sync);
  return () => {
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
    window.removeEventListener('orientationchange', sync);
    window.removeEventListener('resize', sync);
  };
}
