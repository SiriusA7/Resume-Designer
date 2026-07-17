// Framework-free entry for the hidden PDF-capture window (print.html).
//
// The old print path was index.html?print=1 -> main.js -> init() ->
// initPrintMode(). Now that index.html is the React shell, the capture window
// loads this entry instead and calls initPrintMode() directly. It imports from
// the vanilla main.js (NO React in this graph), so the import graph + render
// path are identical to before — only the host document changed.
import { initAppStorage } from './appStorage.js';
import { initPrintMode } from './main.js';

// Storage must be initialized read-only BEFORE initPrintMode() reads the
// variant data: on Tauri the data lives in per-key disk files, not
// localStorage. readOnly means this window can never write app data — the
// main window remains the single writer.
//
// If the disk store can't be read, initAppStorage REJECTS in readOnly mode (it
// does NOT silently fall back to localStorage — after adoption that store is
// empty, so a fallback would render a blank/stale resume and let the main
// window capture a wrong PDF). Catch it and emit `print-error` so the main
// window's pdf.js rejects the export with a real message instead of timing out
// or capturing the wrong resume. The label must match this print window's own
// label, which pdf.js filters on (it spawned us with that label).
initAppStorage({ readOnly: true })
  .then(async () => {
    const { activateProfileMappingForPrint } = await import('./profiles.js');
    activateProfileMappingForPrint();
    return initPrintMode();
  })
  .catch(async (err) => {
    console.error('[PrintEntry] read-only storage init failed — aborting export:', err);
    try {
      const [{ emit }, { getCurrentWindow }] = await Promise.all([
        import('@tauri-apps/api/event'),
        import('@tauri-apps/api/window'),
      ]);
      let label = '';
      try { label = getCurrentWindow().label; } catch { /* unlabeled → pdf.js times out cleanly */ }
      await emit('print-error', {
        label,
        error: 'Could not load your saved data from disk for the PDF export. '
          + 'Free up disk space or check the app data folder, then try again.',
      });
    } catch (emitErr) {
      console.error('[PrintEntry] failed to emit print-error:', emitErr);
    }
  });
