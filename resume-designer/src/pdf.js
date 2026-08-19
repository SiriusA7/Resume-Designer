/**
 * PDF Export Utilities
 *
 * Desktop (Tauri): renders the resume in a HIDDEN child WebviewWindow at
 * `/print.html` and captures it via WKWebView.createPDF (macOS) /
 * WebView2.PrintToPdfAsync (Windows). Main window stays unchanged the whole
 * time — no full-screen takeover.
 *
 * Browser fallback: html2pdf.js produces image-based PDFs (not ATS-friendly).
 */

import { isElectron, isIOSPlatform, pickPdfSavePath, capturePdfFromWindow, readPdfPreview, pdfPreviewPath, savePdfPreview, stagePdfForShare, discardPdfPreview, notify } from './native.js';
import { openNativePdfPreview, sharePdf, isNativeShellAvailable } from './iosShell.js';
import { getCurrentId, getVariantList } from './variantManager.js';
import { store } from './store.js';
import { appStorage } from './appStorage.js';
import { withPreviewSuppressed } from './inlineChanges.js';

let html2pdfModule = null;

// Mirror the hidden #download-pdf proxy's busy state onto an app-wide event so
// the visible (React) header PDF button can show its own spinner/disabled state.
// busy:true when generation starts; busy:false on EVERY exit path (success,
// cancel, error). The hidden-button toggling below is kept intact — this is an
// additional event mirror, not a replacement.
function setPdfBusy(busy) {
  window.dispatchEvent(new CustomEvent('rd:pdf-busy', { detail: { busy } }));
}

// Dynamically import html2pdf.js (browser fallback only)
async function loadHtml2Pdf() {
  if (!html2pdfModule) {
    const module = await import('html2pdf.js');
    html2pdfModule = module.default || module;
  }
  return html2pdfModule;
}

/**
 * A main-window capture is running.
 *
 * It counts as EDITING for the sync guards, and that is not a metaphor: the
 * capture takes each page's rect in turn, so a document replaced between two of
 * them puts one résumé on the early pages and another on the late ones. The
 * editing probe is the existing way to say "this document must not be replaced
 * right now", and a capture has exactly that requirement.
 *
 * It became necessary the moment the capture started BLURRING the editor:
 * before that, exporting mid-sentence left a focused contenteditable, and the
 * probe answered true by accident. Blurring closed the typing hole and opened
 * this one — the guard the blur removed has to be replaced deliberately.
 */
let capturing = false;

export function isPdfCapturing() {
  return capturing;
}

export function initPdfExport() {
  const downloadBtn = document.getElementById('download-pdf');

  downloadBtn.addEventListener('click', startPdfExport);
}

// PDF button handler. Desktop (Tauri): generate the real PDF to a temp file,
// then open the preview dialog where the user reviews it and saves or cancels.
// Browser: keep the filename dialog → html2pdf download (no native PDF to
// preview there).
function startPdfExport() {
  const current = getVariantList().find((v) => v.id === getCurrentId());
  const defaultFilename = (current?.name || 'Resume').trim().replace(/\s+/g, '-');

  if (isElectron) {
    runNativeExportWithPreview(defaultFilename);
    return;
  }

  // Browser fallback — filename-only dialog (no previewUrl), then html2pdf.
  window.dispatchEvent(new CustomEvent('rd:open-pdf-dialog', {
    detail: { defaultFilename, onConfirm: handleDownloadPdf, onCancel: () => {} },
  }));
}

async function handleDownloadPdf(customFilename) {
  const resumeEl = document.getElementById('resume');

  // The React dialog has already closed itself by the time it calls this.

  // Validate resume element exists
  if (!resumeEl) {
    console.error('PDF generation failed: Resume element not found');
    await notify({ title: 'PDF export failed', type: 'error', message: 'Failed to generate PDF: Resume content not found.' });
    return;
  }
  
  // Use custom filename or default
  const filename = customFilename ? 
    (customFilename.endsWith('.pdf') ? customFilename : `${customFilename}.pdf`) : 
    'Resume.pdf';
  
  // Show loading state on header button (hidden proxy) + mirror to the visible
  // React header button via the rd:pdf-busy event.
  setPdfBusy(true);
  const headerBtn = document.getElementById('download-pdf');
  if (headerBtn) {
    headerBtn.disabled = true;
    headerBtn.innerHTML = `
      <svg class="spinner" width="18" height="18" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="60" stroke-dashoffset="20"/>
      </svg>
      Generating...
    `;
  }
  
  try {
    // Browser fallback only — html2pdf (image-based). Tauri uses the native
    // preview flow (runNativeExportWithPreview), not this path.
    console.log('PDF Export: Using html2pdf.js (browser fallback)...');
    // Capture STORED data, never the pending preview. This path snapshots the
    // live DOM, and while a proposal is under review that DOM shows projected
    // changes the user has not accepted. `.pdf-export-mode` only strips the
    // highlight styling — the text underneath is still the projection — so
    // without this the PDF silently contains never-applied AI content. The
    // native path is unaffected: it renders /print.html from stored data in a
    // separate window. Re-query inside, since the suppressed re-render rebuilds
    // #resume's subtree.
    await withPreviewSuppressed(() =>
      generatePdfWithHtml2Pdf(document.getElementById('resume') || resumeEl, filename));
    
  } catch (error) {
    console.error('PDF generation failed:', error);
    await notify({ title: 'PDF export failed', type: 'error', message: `Failed to generate PDF: ${error.message || 'Unknown error'}. Check the console for details.` });
  } finally {
    // Restore button state on EVERY exit path (success, user-cancel, error).
    // Mirror busy:false to the visible React header button too.
    setPdfBusy(false);
    if (headerBtn) {
      headerBtn.disabled = false;
      headerBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download PDF
      `;
    }
  }
}

/**
 * Generate PDF via a HIDDEN background Tauri WebviewWindow.
 *
 * Flow:
 *  1. Pick save path via Rust dialog (`pick_pdf_save_path`). Main window
 *     stays unchanged during the dialog — no chrome toggle, no flash.
 *  2. Subscribe to `print-ready` / `print-error` events from the soon-to-be
 *     hidden child window.
 *  3. Spawn a hidden, decoration-less WebviewWindow pointed at `/print.html`.
 *     Its framework-free entry (src/printEntry.js) runs `initPrintMode()`
 *     (services → render → measure → emit ready).
 *  4. Receive the resume's measured bounds via the event payload.
 *  5. Invoke `capture_pdf_from_window` to run WKWebView.createPDF /
 *     WebView2.PrintToPdfAsync against the hidden window's web view.
 *  6. Close the hidden window. The main window never enters pdf-export-mode.
 *
 * `resumeEl` is still passed in but is no longer measured — the print window
 * measures its own copy. Kept in the signature for symmetry with html2pdf.
 */
// One native export at a time: the PreviewPdfPath temp slot in Rust is a
// single slot, so a bridge export racing a user export would clobber it. The
// guard is OWNED by the two public entry points (exportVariantPdfBase64 and
// runNativeExportWithPreview), NOT by generatePdfNative: the interactive flow
// keeps using the temp slot AFTER generatePdfNative returns — the preview dialog
// stays open until the user Saves or Cancels — so the guard must span that whole
// lifecycle, not just the generation step. Acquire/release is exactly-once per
// entry-point invocation; see each caller's path trace.
let nativeExportInFlight = false;

function acquireExportGuard() {
  if (nativeExportInFlight) {
    throw new Error('another PDF export is in progress — try again in a moment');
  }
  nativeExportInFlight = true;
}

function releaseExportGuard() {
  nativeExportInFlight = false;
}

/**
 * Generate the PDF from the MAIN window, for iOS.
 *
 * The desktop flow above spawns a second, off-screen `WebviewWindow` at
 * `/print.html`. iOS Tauri is single-window — an iOS app has one `UIWindow` —
 * and `x`/`y`/`decorations`/`skipTaskbar` are desktop-only options, so that
 * constructor emits `tauri://error` immediately and the export dies with
 * "Print window creation failed". Phase 0 proved `createPDF` itself works on
 * iOS (63,168 bytes returned); it was the window on top of it that never could.
 *
 * So iOS captures the window it already has, using the SAME `html.pdf-export-mode`
 * stylesheet the print window applies to itself: chrome hidden, the zoom
 * transform and its scroll-margins removed, `.resume` planted at the document
 * origin at 8.5in. No re-render is needed — a transform does not affect layout,
 * so the on-screen pagination was already measured at the export width.
 *
 * The visible cost is a brief flash of the export layout, which the desktop
 * flow deliberately avoids. There is no way around it with one window, and the
 * preview dialog opens over it immediately afterwards.
 *
 * @param {string|null} variantId ignored — the main window always holds the
 *   current variant. Bridge exports of OTHER variants are desktop-only for the
 *   same single-window reason; the caller rejects them before reaching here.
 */
async function generatePdfInMainWindow() {
  const root = document.documentElement;
  const resumeEl = document.getElementById('resume');
  if (!resumeEl) throw new Error('Resume content not found');

  const scroller = document.getElementById('resume-scroller');
  const scrollTop = scroller?.scrollTop ?? 0;
  const scrollLeft = scroller?.scrollLeft ?? 0;

  // THE EDITOR TOO, not only the native controls. The toolbar buttons were
  // disabled for the capture, but the résumé itself is `contenteditable`: a
  // field left focused when the export starts stays live through the two-frame
  // wait and every page capture, and the keyboard is still up. Typing then puts
  // one revision in the pages already taken and another in the rest.
  //
  // Blurred AND frozen: blurring alone dismisses the keyboard but leaves the
  // element editable, so a tap during the capture puts the caret straight back.
  const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
  document.activeElement?.blur?.();
  for (const el of editables) el.setAttribute('contenteditable', 'false');
  // …and the sync guard the blur just released. See `isPdfCapturing`.
  capturing = true;

  root.classList.add('pdf-export-mode');
  try {
    // pdf-export-mode makes <html> the scrolling box, so a mid-document scroll
    // position would offset every rect measured below.
    window.scrollTo(0, 0);

    // Fonts are already loaded in this window, unlike a freshly spawned print
    // window — this resolves immediately and only guards a cold first export.
    if (document.fonts?.ready) await document.fonts.ready;

    // Force the reflow that the class change requires before measuring. Two
    // frames, not a timeout: this window IS on screen, so rAF actually fires
    // here (the print window's setTimeout exists precisely because an
    // off-screen macOS window never composites).
    void resumeEl.offsetHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const bounds = resumeEl.getBoundingClientRect();
    // Per-sheet rects, doc-relative to #resume — one PDF page per on-screen
    // `.resume-page`. Identical projection to initPrintMode's.
    const pages = Array.from(resumeEl.querySelectorAll('.resume-page')).map((p) => {
      const r = p.getBoundingClientRect();
      return {
        x: r.left - bounds.left,
        y: r.top - bounds.top,
        width: r.width,
        height: r.height,
      };
    });
    const captureRect = { x: 0, y: 0, width: bounds.width, height: bounds.height };
    const pageSize = { width: bounds.width / 96, height: bounds.height / 96 };

    console.log(
      `PDF Export (iOS, main window): ${bounds.width.toFixed(0)}×${bounds.height.toFixed(0)} CSS px, `
      + `${pages.length || 1} sheet(s)`
    );

    const result = await capturePdfFromWindow(
      'main', pageSize, captureRect, pages.length ? pages : [captureRect]
    );
    if (!result.success) throw new Error(result.error || 'Failed to generate PDF');
  } finally {
    // Restore unconditionally: leaving the class on would strand the user in a
    // chrome-less full-bleed page with no way back.
    root.classList.remove('pdf-export-mode');
    // Restored on every exit, including the throwing ones — a résumé that
    // cannot be typed into is a worse outcome than a failed export.
    for (const el of editables) el.setAttribute('contenteditable', 'true');
    capturing = false;
    // `pdf-export-mode` makes <html> the scrolling box over a document as tall
    // as the whole resume. Once the class is gone `overflow: hidden` returns
    // and hides any leftover offset visually, so a non-zero scroll here is
    // invisible but still shifts where touches land.
    window.scrollTo(0, 0);
    if (scroller) {
      scroller.scrollTop = scrollTop;
      scroller.scrollLeft = scrollLeft;
    }
  }
}

async function generatePdfNative(_resumeEl, _filename, variantId = null) {
  // iOS captures the main window instead of a print window it cannot create.
  // Returning before the saveNow()/flush() below is deliberate, not an
  // oversight: that durability gate exists because the print window is a
  // separate webview that reads ONLY disk and would otherwise capture stale
  // data. Here the capture target IS this DOM, so the newest keystroke is
  // already in it, and blocking the export on a disk write would only add a
  // way for it to fail.
  if (isIOSPlatform()) {
    if (variantId) {
      // Only the companion bridge passes one, and it is desktop-only.
      throw new Error('Exporting a specific resume is not supported on iOS');
    }
    return generatePdfInMainWindow();
  }
  // 0. Flush any pending in-memory edits to storage BEFORE the print
  //    window opens. The store's auto-save is debounced (~SAVE_DEBOUNCE_MS),
  //    so a user who types and immediately clicks "Download PDF" can have
  //    their latest characters still sitting in memory while the print window
  //    boots from persisted storage and renders stale data. `store.saveNow()`
  //    runs the persistence callback synchronously, eliminating that race.
  try {
    store.saveNow();
  } catch (e) {
    console.warn('PDF Export: store.saveNow() failed; continuing with whatever is persisted:', e);
  }

  // saveNow() wrote through appStorage's in-memory cache; make sure the disk
  // write has landed before the print window boots. The print window is a
  // SEPARATE webview that reads ONLY disk — it can't see this window's cache —
  // so a non-durable flush (disk full / permissions) would silently capture
  // stale data. flush() reports durability; abort with a clear message rather
  // than hand back a stale PDF. handleDownloadPdf's catch surfaces this and
  // its finally restores the button.
  const durable = await appStorage.flush();
  if (!durable) {
    throw new Error(
      'Your latest changes could not be saved to disk, so the PDF would not '
      + 'include them. Free up disk space and try again.'
    );
  }

  // Generation writes to a server-side TEMP file (no save path yet) — the user
  // picks the destination later, from the preview dialog.

  const { listen } = await import('@tauri-apps/api/event');
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

  // Use a unique label per export so we never collide with a previous
  // print window whose `close()` is still being released by the OS.
  // Tauri's WebviewWindow constructor errors (or returns a wrapper for the
  // existing window) when a label is reused before fully torn down — exactly
  // the failure mode where the second export silently hangs.
  const PRINT_LABEL = `pdf-print-${Date.now()}`;

  // Race the ready event against an error event and a timeout. Whichever
  // settles first wins; the others get cleaned up in finally.
  let settled = false;
  let resolveReady;
  let rejectReady;
  const printReady = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectReady(new Error('Print window did not become ready within 30s'));
    }
  }, 30000);

  // Await the listen() calls so the IPC subscriptions are FULLY registered
  // before we spawn the print window. Without this, on slow systems the
  // print window can emit `print-ready` before our handler is attached
  // (manifesting as a 30s timeout despite the child window working fine).
  //
  // Each handler requires `payload.label === PRINT_LABEL` exactly. Missing
  // or empty labels are rejected too — if `initPrintMode` couldn't resolve
  // its own window label (rare error path) it emits effectively-unlabeled
  // events, and we'd rather time out cleanly than settle the wrong export.
  const matchesThisExport = (payload) =>
    typeof payload?.label === 'string' && payload.label === PRINT_LABEL;
  const unlistenReady = await listen('print-ready', (event) => {
    if (settled) return;
    if (!matchesThisExport(event.payload)) return;
    settled = true;
    clearTimeout(readyTimeout);
    resolveReady(event.payload);
  });
  const unlistenError = await listen('print-error', (event) => {
    if (settled) return;
    if (!matchesThisExport(event.payload)) return;
    settled = true;
    clearTimeout(readyTimeout);
    rejectReady(new Error(event.payload?.error ?? 'Print window error'));
  });
  // Diagnostic listener so the main window can see each phase of the print
  // window's init. If print-ready times out, the last step we logged points
  // straight at the hanging step (no guessing).
  const unlistenStep = await listen('print-step', (event) => {
    if (!matchesThisExport(event.payload)) return;
    console.log('[PDF Export] print-step:', event.payload);
  });

  let printWindow = null;
  try {
    // Spawn the render-only window OFF-SCREEN instead of `visible: false`.
    //
    // macOS WKWebView has a known behavior where windows with `visible:
    // false` don't run a full layout/paint pass — `document.fonts.ready`
    // can stall and `getBoundingClientRect()` can return zeros, so the
    // child window never emits a usable `print-ready`. By keeping the
    // window technically visible but positioned far off any user screen,
    // we get the full render pipeline AND the user never sees it.
    //
    // `decorations: false` removes the title bar; `focus: false` stops it
    // stealing keyboard focus; `skipTaskbar: true` keeps it out of the
    // macOS Dock / Windows taskbar.
    printWindow = new WebviewWindow(PRINT_LABEL, {
      url: variantId ? `/print.html?variant=${encodeURIComponent(variantId)}` : '/print.html',
      visible: true,
      x: -10000,
      y: -10000,
      decorations: false,
      focus: false,
      skipTaskbar: true,
      // Make the window big enough to fit the full resume so its layout
      // doesn't get squeezed by viewport size. Exact size doesn't matter
      // since createPDF is rect-driven (macOS) or paginated (Windows).
      width: 820,
      height: 1200,
      title: 'On Paper — PDF Export',
    });

    // Tauri emits `tauri://created` on the window itself when the OS
    // window has been opened. Failing fast on errors avoids a 30s hang.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Print window creation timed out')),
        10000
      );
      printWindow.once('tauri://created', () => {
        clearTimeout(timeout);
        resolve();
      });
      printWindow.once('tauri://error', (e) => {
        clearTimeout(timeout);
        reject(new Error(e?.payload?.error ?? 'Print window creation failed'));
      });
    });

    // 4. Wait for print-mode to finish rendering and report bounds.
    const bounds = await printReady;

    // 5. Capture. Width is also passed as pageSize for the Windows path.
    const pageSize = {
      width: bounds.width / 96,
      height: bounds.height / 96,
    };
    const captureRect = {
      x: 0,
      y: 0,
      width: bounds.width,
      height: bounds.height,
    };

    // Per-sheet rects from the print window — one PDF page per on-screen
    // .resume-page, merged + scaled in Rust. Falls back to the single
    // whole-view rect if the print window didn't report sheets.
    const captureRects = Array.isArray(bounds.pages) && bounds.pages.length
      ? bounds.pages
      : [captureRect];

    console.log(
      `PDF Export: print-window bounds ` +
      `${bounds.width.toFixed(0)}×${bounds.height.toFixed(0)} CSS px ` +
      `(${pageSize.width.toFixed(2)}in × ${pageSize.height.toFixed(2)}in), ` +
      `${captureRects.length} sheet(s)`
    );

    // Capture to the server-side temp file; the preview dialog reads it back.
    const result = await capturePdfFromWindow(PRINT_LABEL, pageSize, captureRect, captureRects);

    if (!result.success) {
      throw new Error(result.error || 'Failed to generate PDF');
    }
    console.log('PDF Export: preview PDF generated');
  } finally {
    // 6. Cleanup: unsubscribe listeners and close the hidden window.
    try { if (unlistenReady) unlistenReady(); } catch (_) { /* ignore */ }
    try { if (unlistenError) unlistenError(); } catch (_) { /* ignore */ }
    try { if (unlistenStep) unlistenStep(); } catch (_) { /* ignore */ }
    if (printWindow) {
      try {
        await printWindow.close();
      } catch (err) {
        console.warn('PDF Export: failed to close print window:', err);
      }
    }
  }
}

// ===== Native (Tauri) export with preview =====

// Mirror the busy state to the visible React header button (rd:pdf-busy) and
// disable the hidden proxy. No spinner markup here — the React button renders
// its own spinner from rd:pdf-busy.
function setExportBusy(busy) {
  setPdfBusy(busy);
  const btn = document.getElementById('download-pdf');
  if (btn) btn.disabled = busy;
}

// Desktop export: generate the real PDF to a temp file, then open the preview
// dialog showing it. The dialog rasterizes the PDF with pdf.js → <canvas>
// (see pdfPreview.js for why not an <iframe>). The user saves (→ native
// location dialog → copy temp to path) or cancels (→ discard the temp).
async function runNativeExportWithPreview(defaultFilename) {
  const resumeEl = document.getElementById('resume');
  if (!resumeEl) {
    await notify({ title: 'PDF export failed', type: 'error', message: 'Failed to generate PDF: Resume content not found.' });
    return;
  }
  // Hold the export guard for the WHOLE preview lifecycle — from before
  // generation until the preview dialog reaches a terminal state (saved,
  // picker backed out, or cancelled). The dialog can stay open for minutes,
  // and the temp slot must stay ours that entire time: a bridge export
  // passing the guard mid-preview would overwrite the slot and its cleanup
  // would delete it, breaking (or mis-targeting) the user's Save.
  //
  // Acquire OUTSIDE the try/catch below: if another export already holds the
  // guard we must bail without touching the temp slot (the catch's discard
  // would delete the other export's in-flight PDF) and without releasing a
  // guard we don't own.
  try {
    acquireExportGuard();
  } catch (error) {
    await notify({ title: 'PDF export failed', type: 'error', message: `Failed to generate PDF: ${error.message}.` });
    return;
  }
  setExportBusy(true);
  let previewBase64 = null;
  let previewPath = null;
  try {
    await generatePdfNative(resumeEl, defaultFilename); // captures to the temp slot
    // iOS previews the FILE natively and never needs its bytes in the page.
    if (isIOSPlatform()) {
      previewPath = await pdfPreviewPath();
      if (!previewPath) throw new Error('Could not find the generated PDF to preview.');
    } else {
      previewBase64 = await readPdfPreview();
      if (!previewBase64) throw new Error('Could not read the generated PDF for preview.');
    }
  } catch (error) {
    console.error('PDF generation failed:', error);
    await notify({ title: 'PDF export failed', type: 'error', message: `Failed to generate PDF: ${error.message || 'Unknown error'}.` });
    // Terminal: clean the slot first, then release (discardPdfPreview never
    // throws — see native.js — so the release below always runs).
    await discardPdfPreview();
    releaseExportGuard();
    setExportBusy(false);
    return;
  }
  setExportBusy(false);

  const onConfirm = (filename) => savePreviewedPdf(filename);
  const onCancel = () => cancelPreviewedPdf();

  // The native sheet gets the same two callbacks the web dialog would, so the
  // export guard and the temp file have one lifecycle whichever presented it.
  // Falls through when there is no native shell, which is every other platform.
  if (previewPath
    && openNativePdfPreview({ path: previewPath, defaultFilename, onConfirm, onCancel })) {
    return;
  }

  window.dispatchEvent(new CustomEvent('rd:open-pdf-dialog', {
    detail: { defaultFilename, previewBase64, onConfirm, onCancel },
  }));
}

// Save the previewed temp PDF: pick the destination (native dialog), copy temp →
// path. Backing out of the native dialog discards the temp.
//
// Guard ownership: the export guard has been held since
// runNativeExportWithPreview acquired it. The two TERMINAL outcomes here —
// save succeeded, or the user backed out of the native picker (temp
// discarded) — release it. A FAILED save is NOT terminal: PdfDialog keeps the
// preview open for a retry against the retained temp PDF, so the guard stays
// held — releasing it mid-retry would let a bridge export overwrite the temp
// slot the retry is about to save. The retry loop can only exit through save
// success, picker back-out, or the dialog's Cancel/Esc/X (→ cancelPreviewedPdf),
// each of which releases exactly once.
async function savePreviewedPdf(customFilename) {
  const filename = customFilename
    ? (customFilename.endsWith('.pdf') ? customFilename : `${customFilename}.pdf`)
    : 'Resume.pdf';

  // iOS has no save-to-path dialog, so it shares instead — see
  // stage_pdf_for_share in commands/mod.rs for why the plugin's approximation
  // of one does not work under the native shell. The share sheet's own
  // "Save to Files" is the equivalent of what the desktop picker does.
  if (isIOSPlatform()) {
    setExportBusy(true);
    try {
      // CHECKED BEFORE STAGING, the same order `shareTextFile` uses, and the
      // order is the whole of this. `isIOSPlatform` is a user-agent test and
      // knows nothing about the shell, so this branch is still taken when there
      // is none — `OP_NATIVE_SHELL=0`, a supported control, or an install where
      // the shell never came up. Staged first, the failure left a second,
      // user-named copy of the résumé behind: `discardPdfPreview` in the
      // `finally` deletes only the SOURCE the preview slot holds, and the staged
      // copy is deleted by the share sheet's completion handler, which in this
      // case is never installed. Sensitive PDFs then accumulate in the temp
      // directory, one per attempt. Not staging at all is the fix; there is no
      // command to delete an arbitrary staged file, and adding one would be
      // more surface than simply not creating it.
      if (!isNativeShellAvailable()) {
        await notify({
          title: 'PDF export failed',
          type: 'error',
          message: 'On Paper could not open the share sheet, so the PDF was not '
            + 'saved. Please restart the app and try again.',
        });
        // Terminal, like every other outcome here. There is nothing to retry
        // against: a second attempt finds the shell still missing.
        return;
      }
      const staged = await stagePdfForShare(filename);
      // ANSWERED, not fired and forgotten — the check above cannot rule out the
      // shell going away between it and this call, and an ignored answer is
      // what made Save produce no sheet, no file and no error.
      if (!sharePdf(staged)) {
        await notify({
          title: 'PDF export failed',
          type: 'error',
          message: 'On Paper could not open the share sheet, so the PDF was not '
            + 'saved. Please restart the app and try again.',
        });
        return;
      }
      console.log('PDF Export: shared', staged);
    } catch (error) {
      // Staging CAN fail — a full temp dir, or an emptied preview slot — and a
      // throw here used to escape before the two lines below, which are the
      // only things that release the guard. Unlike the desktop branch there is
      // no retry to keep it held for: the native sheet dismissed itself on the
      // way in, so nothing is left on screen that could call back. Leaving it
      // held meant every later export was refused as already in progress,
      // until the app restarted.
      console.error('PDF share staging failed:', error);
      await notify({
        title: 'PDF export failed',
        type: 'error',
        message: `Could not prepare the PDF to share: ${error.message || 'Unknown error'}.`,
      });
    } finally {
      setExportBusy(false);
      // Terminal either way: the share sheet is the system's now, and whether
      // the user saves or dismisses it is not something the app is told — and
      // a failure has nowhere to go back to.
      await discardPdfPreview();
      releaseExportGuard();
    }
    return;
  }

  const path = await pickPdfSavePath(filename);
  if (!path) {
    await discardPdfPreview();
    releaseExportGuard();
    return;
  }
  setExportBusy(true);
  try {
    const result = await savePdfPreview();
    if (!result.success) throw new Error(result.error || 'Failed to save PDF.');
    console.log('PDF Export: saved to', result.filePath || path);
  } catch (error) {
    console.error('PDF save failed:', error);
    // Propagate so the preview dialog can stay open and offer a retry — the temp
    // PDF is still on disk, so re-picking a path and saving again works. The
    // guard stays HELD across the retry window (see above).
    throw error;
  } finally {
    setExportBusy(false);
  }
  // Save completed — terminal.
  releaseExportGuard();
}

// Cancel the preview: drop the temp file, then release the export guard held
// since runNativeExportWithPreview acquired it. PdfDialog routes every
// non-confirm dismissal (Cancel button, X, Esc, backdrop) here exactly once.
async function cancelPreviewedPdf() {
  await discardPdfPreview();
  releaseExportGuard();
}

/**
 * Generate PDF using html2pdf.js (browser fallback)
 * NOTE: This produces IMAGE-based PDFs where text is rendered as pixels,
 * not actual selectable text. Use native printToPDF in Electron for ATS compatibility.
 */
async function generatePdfWithHtml2Pdf(resumeEl, filename) {
  // Load html2pdf library
  console.log('PDF Export: Loading html2pdf.js...');
  let html2pdf;
  try {
    html2pdf = await loadHtml2Pdf();
    console.log('PDF Export: html2pdf.js loaded successfully');
  } catch (loadError) {
    console.error('PDF Export: Failed to load html2pdf.js', loadError);
    throw new Error(`Failed to load PDF library: ${loadError.message}`);
  }
  
  // The on-screen sheets carry screen-only chrome (inter-sheet gaps, per-sheet
  // drop-shadow and rounded corners) that html2canvas would otherwise bake into
  // the image. The native desktop export strips it via html.pdf-export-mode in
  // its hidden print window; the browser fallback has no such window, so apply
  // the same class here for the duration of the capture. It must be added BEFORE
  // measuring so the gap-collapsed height sizes the PDF page (html2canvas honors
  // class rules, not @media print). Removed in the finally below.
  const exportRoot = document.documentElement;
  exportRoot.classList.add('pdf-export-mode');

  // Get the resume's actual rendered dimensions (after the chrome/gap collapse above).
  const resumeWidth = resumeEl.offsetWidth;
  const resumeHeight = resumeEl.offsetHeight;

  // With a fixed page size the resume is split into fixed-height .resume-page sheets;
  // emit ONE PDF page per sheet (page = one sheet) so the export honors the selected
  // page size instead of producing a single very tall page. Continuous mode has one
  // open-height sheet (.is-continuous), so keep the single full-element page.
  const sheets = resumeEl.querySelectorAll('.resume-page');
  const firstSheet = sheets[0];
  const paginated = !!firstSheet && !firstSheet.classList.contains('is-continuous');

  // Convert pixels to inches (96 DPI). Fixed: exact sheet size so the per-sheet
  // breaks align. Continuous: full height + a tiny buffer so the one page doesn't spill.
  const pageWidthInches = (paginated ? firstSheet.offsetWidth : resumeWidth) / 96;
  const pageHeightInches = paginated
    ? firstSheet.offsetHeight / 96
    : (resumeHeight / 96) + 0.01;

  console.log(`PDF Export: ${paginated ? sheets.length + ' fixed sheet(s)' : 'continuous'} - ${pageWidthInches.toFixed(2)}" x ${pageHeightInches.toFixed(2)}"`);
  
  // html2canvas options for high quality output
  const options = {
    margin: 0,
    filename: filename,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { 
      scale: 2,                      // 2x scale for high quality
      useCORS: true,
      logging: false,
      allowTaint: true,
      foreignObjectRendering: false,
      removeContainer: true,
      backgroundColor: '#ffffff',
      imageTimeout: 0,
      height: resumeHeight,          // Explicitly set height to match element
      windowHeight: resumeHeight,
      ignoreElements: (element) => {
        const tag = element.tagName?.toLowerCase();
        return tag === 'script' || tag === 'noscript' || tag === 'iframe';
      }
    },
    jsPDF: {
      unit: 'in',
      format: [pageWidthInches, pageHeightInches],
      // Match orientation to the page dims: jsPDF normalizes a custom [w,h] to
      // satisfy 'portrait' (swapping when w > h), so a landscape page would
      // otherwise export rotated/cropped instead of matching the sheet.
      orientation: pageWidthInches > pageHeightInches ? 'landscape' : 'portrait'
    }
  };

  console.log('PDF Export: Starting PDF generation (image-based)...');

  try {
    if (paginated) {
      // One PDF page per .resume-page sheet, each sized to THAT sheet — so an
      // oversized `.is-overflowing` sheet exports at its own (taller) height instead
      // of being split/clipped against the first sheet's page size. html2pdf's single
      // `format` can't vary per page, so build the doc by hand: render the first sheet
      // through the worker to get its jsPDF, then addPage + addImage each remaining
      // sheet at its own measured size.
      const sheetCanvas = { ...options.html2canvas };
      delete sheetCanvas.height; // measure each sheet, not the whole column
      delete sheetCanvas.windowHeight;
      let pdf = null;
      for (let i = 0; i < sheets.length; i++) {
        const sheet = sheets[i];
        const wIn = sheet.offsetWidth / 96;
        const hIn = sheet.offsetHeight / 96;
        const orientation = wIn > hIn ? 'landscape' : 'portrait';
        const worker = html2pdf()
          .set({ margin: 0, image: options.image, html2canvas: sheetCanvas,
                 jsPDF: { unit: 'in', format: [wIn, hIn], orientation } })
          .from(sheet);
        if (i === 0) {
          pdf = await worker.toPdf().get('pdf');
        } else {
          const canvas = await worker.toCanvas().get('canvas');
          pdf.addPage([wIn, hIn], orientation);
          pdf.addImage(canvas.toDataURL('image/jpeg', 0.98), 'JPEG', 0, 0, wIn, hIn);
        }
      }
      pdf.save(filename);
    } else {
      // Continuous: one open-height page for the whole element.
      await html2pdf().set(options).from(resumeEl).save();
    }
    console.log('PDF Export: PDF download initiated');
  } catch (renderError) {
    console.error('PDF Export: Render failed', renderError);
    throw new Error(`PDF rendering failed: ${renderError.message}`);
  } finally {
    exportRoot.classList.remove('pdf-export-mode');
  }
}

/**
 * Headless variant export for the companion-extension bridge: render the
 * given variant in the hidden print window, capture, and return the PDF as
 * base64. Uses the same temp-slot flow as the interactive export — the export
 * guard is held from before generation until the slot is cleaned up, so a
 * concurrent user export (or another bridge call) fails fast instead of
 * clobbering the slot.
 */
export async function exportVariantPdfBase64(variantId) {
  acquireExportGuard();
  try {
    await generatePdfNative(null, null, variantId);
    const base64 = await readPdfPreview();
    if (!base64) throw new Error('could not read the generated PDF');
    return base64;
  } finally {
    // Clean the slot, THEN release — never the other way around, or a waiting
    // export could capture into the slot just before our discard deletes it.
    // (discardPdfPreview never throws, so the release always runs.)
    await discardPdfPreview();
    releaseExportGuard();
  }
}
