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

import { isElectron, pickPdfSavePath, capturePdfFromWindow, readPdfPreview, savePdfPreview, discardPdfPreview } from './native.js';
import { getCurrentId, getVariantList } from './variantManager.js';
import { store } from './store.js';
import { appStorage } from './appStorage.js';

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
    alert('Failed to generate PDF: Resume content not found.');
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
    await generatePdfWithHtml2Pdf(resumeEl, filename);
    
  } catch (error) {
    console.error('PDF generation failed:', error);
    alert(`Failed to generate PDF: ${error.message || 'Unknown error'}. Check the console for details.`);
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
async function generatePdfNative(_resumeEl, _filename) {
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
      url: '/print.html',
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
      title: 'Resume Designer — PDF Export',
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
    alert('Failed to generate PDF: Resume content not found.');
    return;
  }
  setExportBusy(true);
  let previewBase64 = null;
  try {
    await generatePdfNative(resumeEl, defaultFilename); // captures to the temp slot
    previewBase64 = await readPdfPreview();
    if (!previewBase64) throw new Error('Could not read the generated PDF for preview.');
  } catch (error) {
    console.error('PDF generation failed:', error);
    alert(`Failed to generate PDF: ${error.message || 'Unknown error'}.`);
    await discardPdfPreview();
    setExportBusy(false);
    return;
  }
  setExportBusy(false);

  window.dispatchEvent(new CustomEvent('rd:open-pdf-dialog', {
    detail: {
      defaultFilename,
      previewBase64,
      onConfirm: (filename) => savePreviewedPdf(filename),
      onCancel: () => cancelPreviewedPdf(),
    },
  }));
}

// Save the previewed temp PDF: pick the destination (native dialog), copy temp →
// path. Backing out of the native dialog discards the temp.
async function savePreviewedPdf(customFilename) {
  const filename = customFilename
    ? (customFilename.endsWith('.pdf') ? customFilename : `${customFilename}.pdf`)
    : 'Resume.pdf';
  const path = await pickPdfSavePath(filename);
  if (!path) {
    await discardPdfPreview();
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
    // PDF is still on disk, so re-picking a path and saving again works.
    throw error;
  } finally {
    setExportBusy(false);
  }
}

// Cancel the preview: drop the temp file.
async function cancelPreviewedPdf() {
  await discardPdfPreview();
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
