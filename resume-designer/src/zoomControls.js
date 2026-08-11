/**
 * Zoom Controls
 * Handles resume preview zoom in/out and fit-to-view functionality
 */

import { appStorage } from './appStorage.js';

let currentZoom = 1;
// The zoom fitToView last applied, or null if the canvas has never been fitted.
// Read by the resize handler to tell an app-chosen zoom from a user-chosen one.
let lastFittedZoom = null;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

/**
 * Pure fit-to-view maths, extracted so it can be unit-tested without a DOM.
 * All measurements are in CSS px at scale 1.
 *
 * Returns 1 (not 0 or NaN) for unmeasurable input, so a failed measurement
 * leaves the canvas where it is instead of collapsing it.
 */
export function computeFitZoom({
  availableWidth,
  availableHeight,
  contentWidth,
  contentHeight,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
}) {
  const ok = (n) => Number.isFinite(n) && n > 0;
  if (!ok(availableWidth) || !ok(availableHeight) || !ok(contentWidth) || !ok(contentHeight)) {
    return 1;
  }
  const fit = Math.min(availableWidth / contentWidth, availableHeight / contentHeight);
  return Math.min(Math.max(fit, minZoom), maxZoom);
}

// Initialize zoom controls
export function initZoomControls() {
  const zoomIn = document.getElementById('zoom-in');
  const zoomOut = document.getElementById('zoom-out');
  const zoomFit = document.getElementById('zoom-fit');
  const zoomReset = document.getElementById('zoom-reset');

  if (!zoomIn || !zoomOut || !zoomFit || !zoomReset) return;
  
  // Load saved zoom level
  const savedZoom = appStorage.getItem('resume-zoom');
  if (savedZoom) {
    currentZoom = parseFloat(savedZoom);
    applyZoom();
  }
  
  // Zoom in
  zoomIn.addEventListener('click', () => {
    setZoom(Math.min(currentZoom + ZOOM_STEP, MAX_ZOOM));
  });
  
  // Zoom out
  zoomOut.addEventListener('click', () => {
    setZoom(Math.max(currentZoom - ZOOM_STEP, MIN_ZOOM));
  });
  
  // Fit to view
  zoomFit.addEventListener('click', fitToView);
  
  // Reset to 100%
  zoomReset.addEventListener('click', () => {
    setZoom(1);
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Only if not editing text
    if (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      return;
    }
    
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      setZoom(Math.min(currentZoom + ZOOM_STEP, MAX_ZOOM));
    } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault();
      setZoom(Math.max(currentZoom - ZOOM_STEP, MIN_ZOOM));
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      setZoom(1);
    }
  });
  
  // The zoom toolbar centers itself purely via CSS (`position: absolute;
  // left: 50%; transform: translateX(-50%)` anchored to `.preview-area`, a flex
  // child that already shrinks/grows with the chat & structure panels). No JS
  // repositioning is needed — a prior repositionToolbar() computed a
  // viewport-relative left and applied it to the now preview-area-relative bar,
  // double-counting the open chat panel's width and pushing it off-screen.

  // The window can change size at any time — a resized Mac window, a rotated
  // phone, an iPad Split View drag. Keep a FITTED canvas fitted, but never
  // overwrite a zoom the user chose: fitToView goes through setZoom, which
  // persists, so an unguarded refit silently replaced a deliberate 100% with a
  // whole-document fit — 31% on a 2-page résumé, MIN_ZOOM on anything longer —
  // and saved it. `lastFittedZoom` stays null until the user actually fits, so
  // a zoom that was never fitted (including one restored from storage) is left
  // alone. Debounced because a Split View drag fires continuously.
  let refitTimer = null;
  const scheduleRefit = () => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      if (currentZoom !== lastFittedZoom) return;
      fitToView();
    }, 150);
  };
  window.addEventListener('resize', scheduleRefit);
  window.addEventListener('orientationchange', scheduleRefit);
}

// Set zoom level
function setZoom(level) {
  currentZoom = Math.round(level * 100) / 100;
  applyZoom();
  saveZoom();
}

/**
 * Run a zoom mutation with the CSS transition suppressed, then restore it on
 * the next frame. Used by fitToView to make its measure-and-apply sequence
 * instantaneous — ordinary user-initiated zoom (buttons, shortcuts) does not
 * use this and keeps its 0.2s animation. See the .is-zooming comment in
 * main.css.
 */
function withoutTransition(container, fn) {
  if (!container) { fn(); return; }
  container.classList.add('is-zooming');
  try {
    fn();
  } finally {
    container.offsetHeight; // commit the change before re-enabling
    requestAnimationFrame(() => container.classList.remove('is-zooming'));
  }
}

// Apply zoom to resume container
function applyZoom() {
  const container = document.getElementById('resume-container');
  const zoomLevel = document.getElementById('zoom-level');

  if (container) {
    container.style.transform = `scale(${currentZoom})`;
    // `.resume-container` sizes its own margins from this so the element's
    // footprint tracks the SCALED width — a transform alone never extends the
    // scroller's scrollable area, which is what made the page's left margin
    // unreachable above ~106%. See the margin comment in main.css.
    container.style.setProperty('--zoom', `${currentZoom}`);
  }

  if (zoomLevel) {
    zoomLevel.textContent = `${Math.round(currentZoom * 100)}%`;
  }

  // Update button states
  updateButtonStates();

  // The native iOS toolbar renders its own zoom readout and has no way to
  // observe this module otherwise. Same event idiom as rd:pdf-busy; inert
  // everywhere nothing is listening.
  window.dispatchEvent(new CustomEvent('rd:zoom', { detail: { zoom: currentZoom } }));
}

// Fit resume to available view space
export function fitToView() {
  const scroller = document.getElementById('resume-scroller');
  const container = document.getElementById('resume-container');

  if (!scroller || !container) return;

  // Suppression spans the measurement AND the final apply: applyZoom no longer
  // suppresses anything, so user-initiated zoom keeps its 0.2s animation while
  // fit-to-view stays instantaneous. See the .is-zooming comment in main.css.
  withoutTransition(container, () => {
    // Measure at scale 1 so scrollHeight is the true, unscaled height.
    container.style.transform = 'scale(1)';
    container.offsetHeight; // force reflow

    // clientWidth/Height INCLUDE padding, so subtract the real computed values
    // rather than the constants the CSS used to have.
    const cs = getComputedStyle(scroller);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);

    setZoom(computeFitZoom({
      availableWidth: scroller.clientWidth - padX,
      availableHeight: scroller.clientHeight - padY,
      contentWidth: 8.5 * 96,
      contentHeight: container.scrollHeight || 11 * 96,
    }));
    // Read back rather than reusing the computed value: setZoom rounds to two
    // decimals, and the resize guard compares for exact equality.
    lastFittedZoom = currentZoom;
  });
}

// Update button enabled/disabled states
function updateButtonStates() {
  const zoomIn = document.getElementById('zoom-in');
  const zoomOut = document.getElementById('zoom-out');
  
  if (zoomIn) {
    zoomIn.disabled = currentZoom >= MAX_ZOOM;
    zoomIn.style.opacity = currentZoom >= MAX_ZOOM ? '0.4' : '1';
  }
  
  if (zoomOut) {
    zoomOut.disabled = currentZoom <= MIN_ZOOM;
    zoomOut.style.opacity = currentZoom <= MIN_ZOOM ? '0.4' : '1';
  }
}

// Save zoom level to storage
function saveZoom() {
  appStorage.setItem('resume-zoom', currentZoom.toString());
}

/**
 * Set the zoom programmatically, clamped to the same range the buttons use.
 *
 * Exported for the native iOS shell, where a pinch drives THIS model rather
 * than WKWebView's own scroll-view zoom. Those were two independent scales on
 * one canvas: the buttons moved the CSS transform, the pinch moved the webview,
 * and the readout only ever tracked the first — so pinching moved the page and
 * the percentage sat still. The webview's zoom is disabled on iOS (see
 * `lockViewportScale` in iosShell.js) and this is the single survivor, because
 * it is the one that can go BELOW 100% to fit a whole page.
 */
export function setZoomLevel(level) {
  if (!Number.isFinite(level)) return currentZoom;
  setZoom(Math.min(Math.max(level, MIN_ZOOM), MAX_ZOOM));
  return currentZoom;
}

// Get current zoom level (for external use)
export function getZoom() {
  return currentZoom;
}
