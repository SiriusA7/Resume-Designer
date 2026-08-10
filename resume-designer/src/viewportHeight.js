/**
 * Keyboard-safe app height.
 *
 * `100vh` is the LARGE viewport on iOS: it does not shrink when the software
 * keyboard appears, and `100dvh` does not either in WKWebView. `visualViewport`
 * does. So publish its height as `--app-height` and let the CSS fall back to
 * `100dvh` wherever the API is absent (older engines, the print window).
 */

/**
 * @param {{visualViewportHeight?: number, innerHeight?: number}} input
 * @returns {number|null} px height, or null to leave the CSS fallback in place
 */
export function computeAppHeight({ visualViewportHeight }) {
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

  const sync = () => {
    const height = computeAppHeight({ visualViewportHeight: vv?.height });
    if (height == null) target.style.removeProperty('--app-height');
    else target.style.setProperty('--app-height', `${height}px`);
  };

  sync();
  if (!vv) return () => {};

  // `scroll` as well as `resize`: iOS scrolls the visual viewport to reveal a
  // focused field, and the height can settle a frame after the resize.
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  window.addEventListener('orientationchange', sync);
  return () => {
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
    window.removeEventListener('orientationchange', sync);
  };
}
