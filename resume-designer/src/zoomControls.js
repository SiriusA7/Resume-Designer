/**
 * Zoom Controls
 * Handles resume preview zoom in/out and fit-to-view functionality
 */

import { appStorage } from './appStorage.js';

let currentZoom = 1;
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
  // phone, an iPad Split View drag. Refit rather than leaving a stale zoom.
  // Debounced because a Split View drag fires continuously.
  let refitTimer = null;
  const scheduleRefit = () => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(fitToView, 150);
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
 * the next frame. Without this, measurement during the 0.2s transition
 * disagrees with getZoom() — see the .is-zooming comment in main.css.
 */
function withoutTransition(container, fn) {
  if (!container) { fn(); return; }
  container.classList.add('is-zooming');
  fn();
  container.offsetHeight; // commit the change before re-enabling
  requestAnimationFrame(() => container.classList.remove('is-zooming'));
}

// Apply zoom to resume container
function applyZoom() {
  const container = document.getElementById('resume-container');
  const zoomLevel = document.getElementById('zoom-level');

  if (container) {
    withoutTransition(container, () => {
      container.style.transform = `scale(${currentZoom})`;
    });
  }

  if (zoomLevel) {
    zoomLevel.textContent = `${Math.round(currentZoom * 100)}%`;
  }
  
  // Update button states
  updateButtonStates();
}

// Fit resume to available view space
export function fitToView() {
  const scroller = document.getElementById('resume-scroller');
  const container = document.getElementById('resume-container');

  if (!scroller || !container) return;

  // Measure at scale 1 so scrollHeight is the true, unscaled height.
  container.classList.add('is-zooming');
  container.style.transform = 'scale(1)';
  container.offsetHeight; // force reflow

  // clientWidth/Height INCLUDE padding, so subtract the real computed values
  // rather than the constants the CSS used to have. Padding is driven by
  // var(--space-xl) and will change again in 3.2.
  const cs = getComputedStyle(scroller);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);

  setZoom(computeFitZoom({
    availableWidth: scroller.clientWidth - padX,
    availableHeight: scroller.clientHeight - padY,
    contentWidth: 8.5 * 96,
    contentHeight: container.scrollHeight || 11 * 96,
  }));
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

// Get current zoom level (for external use)
export function getZoom() {
  return currentZoom;
}
