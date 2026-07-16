/**
 * Full-backup export / import flow.
 *
 * Moved verbatim out of headerBar.js during the React migration (Step 6). The
 * Settings dialog (SettingsDialog.jsx) now calls these directly instead of
 * relying on headerBar's document-level delegated handlers. The race-sensitive
 * flush -> synchronous import -> reload chain is preserved exactly — see the
 * inline comments for why every step is ordered the way it is.
 */

import { exportFullBackup, importFullBackupDurably, importFullBackupMerge } from './persistence.js';
import { store } from './store.js';
import { appStorage } from './appStorage.js';
import { flushPendingProfileSave } from './userProfilePanel.js';
import { probeLegacyElectronData, importLegacyElectronData } from './native.js';

/**
 * Bridge the visual gap between "user clicked OK on the post-import alert" and
 * "the WebView finishes reloading and painting the new state." Paints a
 * full-viewport "Reloading…" overlay before reload() blocks the renderer, so
 * the user has continuous feedback through the transition. `void offsetHeight`
 * + a 16 ms timeout guarantees the overlay paints BEFORE reload() begins.
 */
function reloadWithOverlay(message = 'Reloading…') {
  const overlay = document.createElement('div');
  overlay.id = 'reload-overlay';
  // Inline styles so the overlay works even if main.css has been partially
  // purged during a teardown — we don't want to depend on class lookups during
  // what's effectively a page-shutdown moment.
  overlay.style.cssText = [
    'position: fixed',
    'inset: 0',
    'z-index: 99999',
    'background: var(--color-bg, #ffffff)',
    'color: var(--color-text, #333333)',
    'font-family: var(--font-body, system-ui, -apple-system, sans-serif)',
    'font-size: 16px',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'flex-direction: column',
    'gap: 12px',
    'opacity: 1',
  ].join(';');

  const spinner = document.createElement('div');
  spinner.style.cssText = [
    'width: 28px',
    'height: 28px',
    'border: 3px solid var(--color-border, #ccc)',
    'border-top-color: var(--color-accent, #c45c3e)',
    'border-radius: 50%',
    'animation: rd-reload-spin 0.7s linear infinite',
  ].join(';');

  const style = document.createElement('style');
  style.textContent =
    '@keyframes rd-reload-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
  document.head.appendChild(style);

  const text = document.createElement('div');
  text.textContent = message;

  overlay.append(spinner, text);
  document.body.appendChild(overlay);

  // Force a synchronous layout + paint so the overlay is on screen before we
  // ask the browser to unload.
  void overlay.offsetHeight;

  // 16 ms ≈ one frame; enough to ensure the overlay paint commits before
  // reload() begins. setTimeout (not rAF) because rAF can be deferred when the
  // page is about to unload.
  setTimeout(() => window.location.reload(), 16);
}

/**
 * DOM-based "Import successful" modal with an OK button. On OK, transitions
 * into reloadWithOverlay() and reloads the app.
 *
 * Why DOM instead of native alert(): tightly coupling alert() with a subsequent
 * location.reload() exposed a dialog state-machine race in WKWebView/WebView2
 * (the alert re-presented itself, then got stuck). A fully DOM-built modal is
 * under our direct control — created, painted, dismissed in one synchronous JS
 * pass — with no dependency on the platform's modal-window manager. Built with
 * createElement (no innerHTML) so the message can never be interpreted as HTML.
 * Reuses the existing .modal-overlay / .modal classes for theming + dark mode.
 */
// `resumeSavesOnFlushFailure` is true ONLY for the merge path: if the final
// flush fails there and we stay put, resuming is safe because the store still
// matches the merged data. It is FALSE for a replace, whose store is stale — a
// resume would let the next close/background save overwrite the imported
// profile — so a replace stays suspended (the user reloads/retries).
function showImportSuccessAndReload(message, resumeSavesOnFlushFailure = false) {
  // Saving is already suspended by the caller (before the durable import ran),
  // so the stale in-memory résumé can't be written back while this modal waits
  // on the user or during the reload.
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'import-success-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.maxWidth = '480px';

  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('h3');
  title.className = 'modal-title';
  title.textContent = 'Import successful';
  header.appendChild(title);

  const content = document.createElement('div');
  content.className = 'modal-content';

  const body = document.createElement('div');
  body.style.whiteSpace = 'pre-wrap';
  body.style.lineHeight = '1.5';
  body.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  actions.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;';

  const okBtn = document.createElement('button');
  okBtn.className = 'btn btn-primary';
  okBtn.id = 'import-success-ok';
  okBtn.textContent = 'OK';
  actions.appendChild(okBtn);

  content.append(body, actions);
  modal.append(header, content);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => overlay.classList.add('show'));
  setTimeout(() => okBtn.focus(), 50);

  const proceed = async () => {
    overlay.remove();
    document.removeEventListener('keydown', keyHandler);
    // The imported keys must hit disk BEFORE we reload — reload boots from
    // disk, so reloading after a failed flush would drop the import (and the
    // Replace path already cleared the old files). flush() reports durability;
    // on failure, stay put so the in-memory imported data keeps showing, and
    // tell the user (the generic storage-failure toast has already fired too).
    const durable = await appStorage.flush();
    if (!durable) {
      // Import couldn't reach disk and we're staying put (no reload). Re-enable
      // saving ONLY when safe (merge path) so the app stays functional once the
      // user frees space; a replace keeps saves suspended because its store is
      // stale and a resume would clobber the imported profile on the next
      // close/background save.
      if (resumeSavesOnFlushFailure) store.resumeSaves();
      alert(
        'Your backup was imported, but it could NOT be saved to disk — your '
        + 'disk may be full. Don\'t close the app yet: free up space, then use '
        + 'Settings → Data → Export Backup to save a copy, or try the import '
        + 'again. (Reloading now would lose the imported data.)'
      );
      return;
    }
    reloadWithOverlay('Loading your imported data…');
  };

  const keyHandler = (e) => {
    // Enter OR Escape both proceed — the import has already happened; the only
    // path forward is to reload into the new state.
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      proceed();
    }
  };

  okBtn.addEventListener('click', proceed, { once: true });
  document.addEventListener('keydown', keyHandler);
}

/**
 * Export every owned storage key into a single JSON file. No success
 * alert — the browser download bar / native save dialog is feedback enough.
 */
export function exportFullBackupWithFeedback() {
  try {
    const { keysExported, filename } = exportFullBackup();
    console.log(`[backup] Exported ${keysExported} keys to ${filename}`);
  } catch (err) {
    console.error('[backup] Export failed:', err);
    alert(`Export failed: ${err.message ?? String(err)}`);
  }
}

/**
 * Restore every owned storage key from a JSON envelope produced by Export
 * Full Backup or the legacy Electron migration. Parses FIRST (so the
 * destructive confirm can show the key count), flushes pending debounced
 * writers, then runs the writes SYNCHRONOUSLY before reload.
 */
export async function importBackupFromFile(file) {
  if (!file) return;
  // Whether THIS invocation suspended saves. An early throw (malformed JSON,
  // wrong format) reaches the catch BEFORE store.suspendSaves() runs; if a prior
  // Replace import left saves suspended (stale store awaiting a reload), an
  // unconditional resume there would unlock that stale store and let the next
  // close/background save overwrite the restored data. So resume only our own.
  let suspendedHere = false;
  try {
    // Parse FIRST so we can show the key count BEFORE confirming (avoids the
    // "destructive confirm with unknown payload" anti-pattern). This is also
    // the ONLY parse pass — the already-validated `preview` feeds straight into
    // importFullBackupFromEnvelope below, so there's no second `await
    // file.text()` between the flush and the writes.
    const text = await file.text();
    let preview;
    try {
      preview = JSON.parse(text);
    } catch (_) {
      throw new Error('Selected file is not valid JSON.');
    }
    const isFormat1 = preview?.backupFormat === 1 && preview.keys;
    const isFormat2Full = preview?.backupFormat === 2 && preview.kind === 'full';
    if (!isFormat1 && !isFormat2Full) {
      throw new Error('Not a Resume Designer backup file.');
    }
    const incoming = isFormat1
      ? Object.keys(preview.keys).length
      : Object.values(preview.profiles || {}).reduce(
          (count, entry) => count + Object.keys(entry?.keys || {}).length,
          Object.keys(preview.shared || {}).length
        );
    const profileNote = isFormat2Full && Array.isArray(preview.registry)
      ? ` across ${preview.registry.length} ${preview.registry.length === 1 ? 'profile' : 'profiles'}`
      : '';
    const ok = confirm(
      `Restore from backup?\n\n` +
        `This backup contains ${incoming} keys${profileNote} ` +
        `(created ${preview.createdAt || 'unknown date'}).\n\n` +
        `Your current resumes, job descriptions, history, and ` +
        `settings will be REPLACED.\n\n` +
        `The app will reload after import.`
    );
    if (!ok) return;

    // Flush all pending debounced writers (resume store + profile panel) before
    // the destructive restore: reloadWithOverlay yields to the event loop for
    // 16 ms before reload(), and any queued save callback would otherwise fire
    // in that window and overwrite the just-imported data.
    try {
      store.saveNow();
      flushPendingProfileSave();
    } catch (err) {
      console.warn('[backup] pre-import flush failed:', err);
    }

    // Suspend saves BEFORE the import — importFullBackupDurably writes
    // appStorage synchronously and then AWAITS the disk flush; without this, a
    // visibilitychange/close during that await would fire store.saveNow() and
    // write the stale in-memory résumé over the just-imported data. Resumed in
    // the catch below if the import throws (it rolls appStorage back, so the
    // store is consistent again and the app keeps running without a reload).
    store.suspendSaves();
    suspendedHere = true;

    // SYNCHRONOUS call (not importFullBackup(file), which would do a second
    // file.text() — that await would yield AFTER our flush but BEFORE the
    // writes, reopening the race). importFullBackupDurably takes the
    // already-parsed preview and runs the WRITES synchronously (its only
    // await is the durability flush AFTER them, which also rolls the store
    // back on failure), so flush -> writes stays one uninterrupted chain.
    const result = await importFullBackupDurably(preview);

    let backupNote = '';
    if (result.historySkipped > 0) {
      backupNote =
        `\n\nNote: ${result.historySkipped} undo/redo history ` +
        `${result.historySkipped === 1 ? 'entry was' : 'entries were'} ` +
        `too large to fit in browser storage and ` +
        `${result.historySkipped === 1 ? 'was' : 'were'} skipped. ` +
        `Your resumes themselves are intact.`;
    }
    showImportSuccessAndReload(
      `Restored ${result.keysImported} keys from backup ` +
        `(removed ${result.removedExistingKeys} existing keys).` +
        backupNote
    );
  } catch (err) {
    // Resume only a suspension THIS call created — an early throw (before
    // store.suspendSaves) must not unlock a prior import's suspension.
    if (suspendedHere) store.resumeSaves(); // import rolled back — app keeps running
    console.error('[backup] Import failed:', err);
    alert(`Import failed: ${err.message ?? String(err)}`);
  }
}

/**
 * Import résumés / settings / history from a previous (Electron) installation's
 * LevelDB into this build. `mode` is 'replace' (overwrite current data — mirrors
 * the one-time auto-migration in main.js) or 'merge' (union; current data wins
 * on conflicts). Tauri-only — the probe/import calls no-op or throw in the
 * browser. Same race-safe flush -> synchronous import -> reload chain as
 * importBackupFromFile, so a queued debounced save can't clobber the import.
 */
export async function importLegacyElectronWithFeedback(mode = 'replace') {
  const merging = mode === 'merge';
  // See importBackupFromFile: only the catch for a suspension THIS call created
  // may resume it, so an early throw can't unlock a prior import's suspension.
  let suspendedHere = false;
  try {
    const probe = await probeLegacyElectronData();
    if (!probe?.found) {
      alert('No data from a previous (Electron) installation was found on this computer.');
      return;
    }

    const envelope = await importLegacyElectronData();
    const incoming = envelope?.keys ? Object.keys(envelope.keys).length : 0;
    const ok = confirm(
      `Import data from your previous desktop app?\n\n` +
        `Found ${incoming} keys from the legacy (Electron) installation.\n\n` +
        (merging
          ? `They will be MERGED into your current data (your current résumés win on any conflict).`
          : `Your current résumés, job descriptions, history, and settings will be REPLACED.`) +
        `\n\nThe app will reload after import.`
    );
    if (!ok) return;

    try {
      store.saveNow();
      flushPendingProfileSave();
    } catch (err) {
      console.warn('[backup] pre-import flush failed:', err);
    }

    // Suspend saves before the import writes appStorage (see the format-2 path
    // above for the flush-await race); resumed in the catch if it throws.
    store.suspendSaves();
    suspendedHere = true;

    const result = merging
      ? importFullBackupMerge(envelope)
      : await importFullBackupDurably(envelope);

    const skipped = result.historySkipped > 0
      ? `\n\nNote: ${result.historySkipped} oversize undo/redo `
        + `${result.historySkipped === 1 ? 'entry was' : 'entries were'} skipped; `
        + `your résumés are intact.`
      : '';
    const summary = merging
      ? `Merged your previous app's résumés and settings into this one.`
      : `Imported ${result.keysImported} keys from your previous app `
        + `(removed ${result.removedExistingKeys} existing keys).`;
    // Only the merge path may resume saves if the final flush fails (its store
    // isn't stale); a legacy replace stays suspended like the format-2 one.
    showImportSuccessAndReload(summary + skipped, merging);
  } catch (err) {
    if (suspendedHere) store.resumeSaves(); // resume only a suspension THIS call created
    console.error('[backup] Legacy import failed:', err);
    alert(`Couldn't import data from the previous app: ${err.message ?? String(err)}`);
  }
}
