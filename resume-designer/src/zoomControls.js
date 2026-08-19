/**
 * Zoom Controls
 * Handles resume preview zoom in/out and fit-to-view functionality
 */

import { appStorage } from './appStorage.js';

let currentZoom = 1;
// The last fit this module applied — `{ zoom, axis }` — or null if the canvas
// has never been fitted. Read by the resize handler to tell an app-chosen zoom
// from a user-chosen one. The AXIS is part of it because there are two fits
// now: re-fitting a width fit as a whole-page fit on the next rotation would
// silently undo the choice.
let lastFit = null;
// The animation frame a fit in flight is waiting on, so a second fit takes over
// from the first instead of the two driving the same canvas at once.
let fitTravel = null;
// True only while the fit's own animation frame is writing. Every direct zoom
// CANCELS a running fit (see `cancelFitTravel`), and the fit drives the very
// same `setZoom` a button or a pinch does — so without this flag its first
// frame would cancel itself.
let fitDriving = false;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;
// How long a fit takes to travel. The same 0.2s the CSS gives the buttons, so
// the two kinds of zoom read as one app.
const FIT_TRAVEL_MS = 200;

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
  // `'both'` fits the whole page and is what "Fit to view" means. `'width'`
  // ignores the height entirely: the page fills the view edge to edge and runs
  // off the bottom, which is the right answer when you are READING it rather
  // than looking at its shape — and on a phone the difference is most of the
  // screen, because a portrait page fitted whole is mostly margin.
  axis = 'both',
}) {
  const ok = (n) => Number.isFinite(n) && n > 0;
  if (!ok(availableWidth) || !ok(contentWidth)) return 1;
  if (axis !== 'width' && (!ok(availableHeight) || !ok(contentHeight))) return 1;
  const byWidth = availableWidth / contentWidth;
  const fit = axis === 'width'
    ? byWidth
    : Math.min(byWidth, availableHeight / contentHeight);
  return Math.min(Math.max(fit, minZoom), maxZoom);
}

/**
 * Tell the CSS how tall the page is, unscaled, so it can subtract the height
 * the transform does not use.
 *
 * `offsetHeight` is a LAYOUT height — a transform never touches it — which is
 * exactly the number the margin needs. See the margin-bottom comment in
 * main.css for why this cannot be a constant the way the width is, and
 * `watchPageHeight` for why publishing it once is not enough.
 */
function publishPageHeight(container) {
  if (!container) return;
  container.style.setProperty('--page-height', `${container.offsetHeight}px`);
}

/**
 * Keep it published. The page's height changes without the zoom ever moving —
 * an edit, a repagination, a font that finishes loading — and a stale height
 * leaves exactly the dead scroll space this is here to remove.
 *
 * No feedback loop: the property drives `margin-bottom`, and a margin is
 * outside the border box the observer is watching.
 */
function watchPageHeight(container) {
  if (!container) return;
  publishPageHeight(container);
  if (typeof ResizeObserver !== 'function') return;
  new ResizeObserver(() => publishPageHeight(container)).observe(container);
}

// Initialize zoom controls
export function initZoomControls() {
  // Before the guard below: the page's height belongs to the canvas, not to the
  // toolbar, and the canvas is there whether or not the buttons are.
  watchPageHeight(document.getElementById('resume-container'));

  const zoomIn = document.getElementById('zoom-in');
  const zoomOut = document.getElementById('zoom-out');
  const zoomFit = document.getElementById('zoom-fit');
  const zoomReset = document.getElementById('zoom-reset');

  if (!zoomIn || !zoomOut || !zoomFit || !zoomReset) return;
  
  // Load saved zoom level.
  //
  // Without a transition, for two reasons. The page should not visibly zoom
  // itself as the app opens — it was never at 100%, it was saved at this.
  // And the 0.2s animation is a window in which `getBoundingClientRect()`
  // reports an in-flight scale while `getZoom()` reports the target, so
  // anything that measures inside it measures wrongly: pagination divides
  // rects by `getZoom()`, so a repaginate landing mid-restore broke pages at
  // roughly (rendered ÷ target) of the right height. On a WARM load — the
  // webfonts already cached, as they are every time the app is reopened —
  // `document.fonts.ready` resolves inside those 200ms and main.js
  // re-renders exactly there, which is why it showed up on resume from
  // background and not on a cold start.
  const savedZoom = appStorage.getItem('resume-zoom');
  if (savedZoom) {
    currentZoom = parseFloat(savedZoom);
    withoutTransition(document.getElementById('resume-container'), applyZoom);
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
  // and saved it. `lastFit` is set only by a fit and cleared by every other
  // zoom, so a canvas that was never fitted — or has been zoomed since — is
  // left alone. Debounced because a Split View drag fires continuously.
  let refitTimer = null;
  const scheduleRefit = () => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      if (!lastFit) return;
      applyFit(lastFit.axis);
    }, 150);
  };
  window.addEventListener('resize', scheduleRefit);
  window.addEventListener('orientationchange', scheduleRefit);
}

// Set zoom level
//
// `live` marks a frame of a gesture, and it changes two things. The value is
// kept RAW rather than rounded to whole percent: 0.01 of absolute scale is a
// 2% relative jump at a typical fit zoom of ~50%, which is what made a pinch
// travel in visible steps instead of tracking the fingers. And the write is
// not persisted — a pinch produces ~60 of these a second, and only where the
// fingers come to rest is worth saving. The final non-live frame of a gesture
// rounds and saves, so what reaches storage is the same tidy value as before.
/**
 * Stop a fit part-way and let go of the gesture it was driving.
 *
 * The travel is a GESTURE — `setZoomLevel(live)` with an anchor held under the
 * middle of the view — so abandoning it means releasing that anchor as well as
 * dropping the frame. Left behind, the next pinch inherited the fit's anchor
 * and the two inputs fought over scale and scroll.
 */
function cancelFitTravel() {
  // Nothing running means nothing to release. Without this early return the
  // call from `setZoom` wiped the anchor an ORDINARY pinch had just captured —
  // `setZoomLevel` captures before it delegates — and the gesture stopped
  // following the fingers.
  if (fitTravel === null) return;
  cancelAnimationFrame(fitTravel);
  fitTravel = null;
  liveGesture = false;
  gestureAnchor = null;
  document.getElementById('resume-container')?.classList.remove('is-zooming');
}

function setZoom(level, live = false) {
  // ANY zoom that is not the fit's own ends the fit. Only a second fit used to
  // reach the cancellation, so pressing Zoom In / Out / Reset or starting a
  // pinch mid-travel left the outstanding frame computing from its original
  // `from` value — and it overwrote every direct input until it landed on the
  // fit target. The person's own zoom simply lost for 200 ms.
  if (!fitDriving) {
    cancelFitTravel();
    // ...and it also ends the FIT, not just the travel. `lastFit` is what the
    // resize handler consults, and it used to be validated by comparing the
    // current zoom against the fitted one — a proxy that any coincidence
    // satisfies. Zoom In then Zoom Out returns to the exact fitted percentage
    // (both are rounded to two decimals), and the canvas was silently armed
    // again: the next resize or rotation refit it and persisted that, over a
    // zoom the person had chosen by hand.
    lastFit = null;
  }
  currentZoom = live ? level : Math.round(level * 100) / 100;
  applyZoom();
  if (!live) saveZoom();
}

/**
 * Run a zoom mutation with the CSS transition suppressed, then restore it on
 * the next frame. Used to restore the saved zoom at startup, which must not
 * animate — ordinary user-initiated zoom (buttons, shortcuts) does not use this
 * and keeps its 0.2s animation. See the .is-zooming comment in main.css.
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

/** Fit the résumé to the view. `'both'` fits the page; `'width'` fills it. */
function applyFit(axis) {
  const scroller = document.getElementById('resume-scroller');
  const container = document.getElementById('resume-container');

  if (!scroller || !container) return;

  const from = currentZoom;

  // Measure at scale 1, then put the canvas straight back where it was. None of
  // this is ever seen: both writes and the reflow between them happen inside
  // one task, so the frame on screen is still the zoom we are travelling FROM —
  // which is what stops the old out-and-back wobble. The suppression stays on
  // afterwards and is handed to the travel, which is a live gesture and owns it
  // from there. See the .is-zooming comment in main.css.
  container.classList.add('is-zooming');
  container.style.transform = 'scale(1)';
  container.offsetHeight; // force reflow

  // clientWidth/Height INCLUDE padding, so subtract the real computed values
  // rather than the constants the CSS used to have.
  const cs = getComputedStyle(scroller);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);

  const target = computeFitZoom({
    availableWidth: scroller.clientWidth - padX,
    availableHeight: scroller.clientHeight - padY,
    contentWidth: 8.5 * 96,
    contentHeight: container.scrollHeight || 11 * 96,
    axis,
  });

  container.style.transform = `scale(${from})`;

  travelZoomTo(target, from, scroller, () => {
    // Read back rather than reusing the computed value: setZoom rounds to two
    // decimals, and the resize guard compares for exact equality.
    lastFit = { zoom: currentZoom, axis };
  });
}

/**
 * Travel from `from` to `target` over FIT_TRAVEL_MS, scaling about the middle
 * of the view.
 *
 * A fit is not only a new zoom, it is a new scroll position: filling the width
 * of a canvas that was zoomed in and panned across has to bring the page back
 * to the left edge as well as shrink it. Setting the zoom outright did both in
 * one frame, and the page appeared to teleport rather than to move.
 *
 * So it is run as a gesture instead. `setZoomLevel(live)` is the pinch path —
 * transition suppressed, an anchored point held under a focal point — and
 * driving it from a clock rather than from fingers carries the scroll along for
 * free: the middle of the view stays put while the page grows or shrinks around
 * it, and the scroller's own clamping does the rest.
 */
function travelZoomTo(target, from, scroller, done) {
  cancelFitTravel();

  const rect = scroller.getBoundingClientRect();
  const focus = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

  // From the first frame's timestamp, not from now: the gap before the first
  // frame is time the page has not moved in, and counting it would start the
  // travel already part-way through.
  let start = null;
  const step = (now) => {
    if (start === null) start = now;
    const t = Math.min(1, (now - start) / FIT_TRAVEL_MS);
    // Ease out: fastest where the movement is largest, settling gently onto the
    // fitted value rather than stopping dead on it.
    const eased = 1 - (1 - t) ** 3;
    // The last frame is not live, which is what rounds the value, saves it, and
    // gives the canvas its transition back.
    fitDriving = true;
    try {
      setZoomLevel(from + (target - from) * eased, t < 1, focus);
    } finally {
      fitDriving = false;
    }
    if (t < 1) {
      fitTravel = requestAnimationFrame(step);
    } else {
      fitTravel = null;
      done();
    }
  };
  fitTravel = requestAnimationFrame(step);
}

// Fit resume to available view space
export function fitToView() { applyFit('both'); }

/** Fill the view's width with the page, whatever that does to its height. */
export function fitToWidth() { applyFit('width'); }

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

// True while a native pinch is in flight. See setZoomLevel.
let liveGesture = false;

// The point the running gesture is anchored to, in UNSCALED content
// coordinates, or null when no gesture is in flight. See setZoomLevel.
let gestureAnchor = null;

/**
 * Which point of the page is under the fingers, in UNSCALED content px
 * measured from the container's own top-left.
 *
 * `focus` and `origin` are both client (viewport) px. The container scales
 * from `top left`, so its rect origin IS the transformed origin, and undoing
 * the scale is the whole conversion.
 *
 * Pure, and paired with anchorScrollDelta below, so the arithmetic that is
 * easy to get backwards — the sign of the delta, which side the scale
 * multiplies — is testable without a layout engine. Reading the right rect at
 * the right moment is the caller's job.
 */
export function contentPointAt({ focusX, focusY, originX, originY, scale }) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { x: (focusX - originX) / s, y: (focusY - originY) / s };
}

/**
 * How far to scroll to put an anchored content point back under the fingers,
 * given where the container's origin ended up at the new scale.
 *
 * The inverse of contentPointAt: applying this delta makes
 * `origin + anchor * scale` land exactly on `focus`.
 */
export function anchorScrollDelta({
  anchorX, anchorY, focusX, focusY, originX, originY, scale,
}) {
  return {
    dx: originX + anchorX * scale - focusX,
    dy: originY + anchorY * scale - focusY,
  };
}

/**
 * Record which point of the page is under the fingers.
 *
 * `focus` is in client px, which is what the native side measures in — iOS
 * points and CSS px are the same unit here, because the page's own zoom is off
 * and the webview is pinned edge-to-edge with the view the recognizer is
 * attached to.
 */
function captureAnchor(focus) {
  const container = document.getElementById('resume-container');
  if (!container || !Number.isFinite(focus?.x) || !Number.isFinite(focus?.y)) return null;
  const rect = container.getBoundingClientRect();
  const { x, y } = contentPointAt({
    focusX: focus.x, focusY: focus.y, originX: rect.left, originY: rect.top, scale: currentZoom,
  });
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Scroll so the anchored content point sits back under the fingers.
 *
 * This is what makes a pinch zoom toward the gesture instead of toward the
 * top-left corner. The container scales from `top left` — deliberately, see
 * the margin comment in main.css — so with no compensation the whole page just
 * grows away from that corner, and pinching the bottom of page 2 zoomed the
 * top of page 1.
 *
 * The origin is MEASURED after the scale is applied rather than predicted: the
 * container's margins are themselves a function of `--zoom` (they are what
 * makes the scaled page scrollable at all), so the origin moves when the scale
 * does. Reading the rect back forces the layout the transform write already
 * made pending.
 *
 * Re-anchoring to the CURRENT focal point every frame, rather than accumulating
 * per-frame deltas, also means a two-finger drag pans the canvas and nothing
 * drifts — each frame is corrected against what is actually on screen,
 * including any scrolling WebKit did on its own.
 */
function restoreAnchor(focus) {
  const scroller = document.getElementById('resume-scroller');
  const container = document.getElementById('resume-container');
  if (!scroller || !container || !gestureAnchor) return;
  const rect = container.getBoundingClientRect();
  const { dx, dy } = anchorScrollDelta({
    anchorX: gestureAnchor.x, anchorY: gestureAnchor.y,
    focusX: focus.x, focusY: focus.y,
    originX: rect.left, originY: rect.top,
    scale: currentZoom,
  });
  // The scroller clamps these itself. Below the fitted width there is no scroll
  // room and the container's auto margins keep the page centred, so a pinch
  // there zooms from the middle — which is what every other viewer does too.
  scroller.scrollLeft += dx;
  scroller.scrollTop += dy;
}

/**
 * Set the zoom programmatically, clamped to the same range the buttons use.
 *
 * Exported for the native iOS shell, where a pinch drives THIS model rather
 * than WKWebView's own scroll-view zoom. Those were two independent scales on
 * one canvas: the buttons moved the CSS transform, the pinch moved the webview,
 * and the readout only ever tracked the first — so pinching moved the page and
 * the percentage sat still. The webview's zoom is disabled on iOS (see
 * `disablePageZoom` in iosShell.js) and this is the single survivor, because
 * it is the one that can go BELOW 100% to fit a whole page.
 *
 * `live` says a gesture is driving this, and it suppresses the transition for
 * the duration. Without it the canvas ANIMATES to each of the ~30 values a
 * pinch produces per second, so it is always 200ms behind the fingers and never
 * settles — which reads on the device as the page stuttering and fighting back,
 * not as a smooth zoom. Ordinary button-driven zoom keeps its animation.
 *
 * `focus` is the point between the fingers, in client px. When it is given the
 * canvas is scrolled to keep the content under that point fixed, so the zoom
 * happens where the gesture is. The buttons pass nothing and keep scaling from
 * the corner, which is what they should do — there is no gesture to follow.
 */
export function setZoomLevel(level, live = false, focus = null) {
  if (!Number.isFinite(level)) return currentZoom;
  // BEFORE the anchor is captured, so a pinch starting mid-fit releases the
  // fit's anchor and then takes its own. Cancelling further down, inside
  // `setZoom`, would drop the capture this call had already made.
  if (!fitDriving) cancelFitTravel();
  const container = document.getElementById('resume-container');
  if (live && !liveGesture) {
    liveGesture = true;
    container?.classList.add('is-zooming');
  }
  // Captured before the scale changes, so it is read at the zoom the gesture
  // began at. Held for the whole gesture: re-capturing per frame would anchor
  // to wherever the fingers had already dragged the page to, which is a no-op.
  if (focus && !gestureAnchor) gestureAnchor = captureAnchor(focus);

  setZoom(Math.min(Math.max(level, MIN_ZOOM), MAX_ZOOM), live);
  if (focus) restoreAnchor(focus);

  if (!live && liveGesture) {
    liveGesture = false;
    gestureAnchor = null;
    if (container) {
      container.offsetHeight; // commit the final value before animating again
      requestAnimationFrame(() => container.classList.remove('is-zooming'));
    }
  }
  return currentZoom;
}

// Get current zoom level (for external use)
export function getZoom() {
  return currentZoom;
}
