/**
 * Full-backup export / import flow.
 *
 * Moved verbatim out of headerBar.js during the React migration (Step 6). The
 * Settings dialog (SettingsDialog.jsx) now calls these directly instead of
 * relying on headerBar's document-level delegated handlers. The race-sensitive
 * flush -> synchronous import -> reload chain is preserved exactly — see the
 * inline comments for why every step is ordered the way it is.
 */

import {
  exportFullBackup, importFullBackupDurably, importFullBackupMerge,
  credentialFromEnvelope, saveApiKey,
} from './persistence.js';
import { getSecret, hasNoCredentialConfigured, recoverSecretStore } from './secretStore.js';
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
function showImportSuccessAndReload(message) {
  // Saving is already suspended by the caller (before the durable import ran), so
  // the stale in-memory resume can't be written back while this modal waits on the
  // user or during the reload. The durable import keeps its restore guard armed on
  // success (continuous ownership — no unguarded microtask gap), so only ARM here
  // if it isn't already: the legacy Merge path is synchronous and never armed one.
  // Either way, EVERY other appStorage writer stays blocked through the modal +
  // reload; the reload boots from the restored data and resets the guard.
  if (!appStorage.isRestoreGuardActive()) appStorage.beginRestoreGuard();
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
      // Import couldn't reach disk; staying put (no reload). KEEP the guard armed:
      // module caches were never reloaded from the imported storage, so a
      // post-alert stale write (e.g. a chat update serializing the pre-import
      // in-memory list) would clobber the imported data. DISCARD the modal-window
      // deferred writes rather than replay them — for a merge they were derived
      // from the pre-import in-memory state, so replaying would ALSO overwrite the
      // imported keys. Writes stay guarded and saves stay suspended until reload;
      // the user exports a copy, then reloads.
      appStorage.discardDeferredWrites();
      alert(
        'Your backup was imported, but it could NOT be saved to disk — your '
        + 'disk may be full. Free up space, then use Settings → Data → Export '
        + 'Backup to save a copy. Reloading or closing the app before the copy '
        + 'is saved will lose the imported data.'
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
  // Whether THIS invocation ACQUIRED the save suspension (flipped it off→on).
  // Two ways it stays false: (1) an early throw — malformed JSON, wrong format —
  // reaches the catch before suspendSaves() runs; (2) saves were ALREADY
  // suspended by a prior import (e.g. a Replace whose success-modal flush failed
  // stays suspended, awaiting a reload). In both cases the catch must NOT resume
  // — that stale store would overwrite restored data on the next close/background
  // save. Resume only a suspension this call owns.
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
      throw new Error('Not an On Paper backup file.');
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
    // write the stale in-memory resume over the just-imported data. Resumed in
    // the catch below if the import throws (it rolls appStorage back, so the
    // store is consistent again and the app keeps running without a reload).
    // suspendSaves() returns TRUE only if it flipped the latch on — false if a
    // prior import already had saves suspended (see the suspendedHere note).
    suspendedHere = store.suspendSaves();

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
    // Resume only a suspension THIS call acquired — an early throw (before
    // suspendSaves) or a re-latched prior suspension must not be unlocked here.
    if (suspendedHere) store.resumeSaves(); // import rolled back — app keeps running
    console.error('[backup] Import failed:', err);
    alert(`Import failed: ${err.message ?? String(err)}`);
  }
}

/**
 * Import resumes / settings / history from a previous (Electron) installation's
 * LevelDB into this build. `mode` is 'replace' (overwrite current data — mirrors
 * the one-time auto-migration in main.js) or 'merge' (union; current data wins
 * on conflicts). Tauri-only — the probe/import calls no-op or throw in the
 * browser. Same race-safe flush -> synchronous import -> reload chain as
 * importBackupFromFile, so a queued debounced save can't clobber the import.
 */
export async function importLegacyElectronWithFeedback(mode = 'replace') {
  const merging = mode === 'merge';
  // See importBackupFromFile: TRUE only if this call ACQUIRED the suspension, so
  // the catch never resumes one a prior import (or an early throw) left in place.
  let suspendedHere = false;
  // Hoisted so the catch can undo a credential swap the import then failed to
  // justify — see the replace branch below.
  let previousCredential = null;
  let credentialReplaced = false;
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
          ? `They will be MERGED into your current data (your current resumes win on any conflict).`
          : `Your current resumes, job descriptions, history, and settings will be REPLACED.`) +
        `\n\nThe app will reload after import.`
    );
    if (!ok) return;

    try {
      store.saveNow();
      flushPendingProfileSave();
    } catch (err) {
      console.warn('[backup] pre-import flush failed:', err);
    }

    // A REPLACE means the previous installation's data wins, and the credential
    // is part of "everything". keepCredential carries it through STORAGE, which
    // is not enough on its own: this install's keychain entry would win at the
    // next boot — adoptKeychainRead treats a present value as authoritative —
    // and the cleanup right after it would strip the imported copy. The replace
    // then comes up with the CURRENT key, or with none at all when that entry is
    // the empty Clear sentinel. So the credential goes to the keychain here,
    // alongside every other key this replace is about to write.
    //
    // BEFORE importFullBackupDurably, which arms the restore guard: with that
    // armed, setSecret's plaintext cleanup is deferred and reports failure, so
    // a successful keychain write would surface as an import error.
    //
    // MERGE is deliberately untouched — "your current data wins on conflict" is
    // its whole contract, and the current key is current data.
    const incomingCredential = merging ? null : credentialFromEnvelope(envelope);

    // A null snapshot in read-only or browser-unreadable means the current key
    // could not be READ, not that there is none — and rolling THAT back as ''
    // would clear a credential the user still has while telling them the import
    // failed. So make it knowable first: recoverSecretStore is the same retry
    // the Settings banner offers, and it usually succeeds because a keychain
    // fault at boot is usually transient.
    if (incomingCredential !== null && !hasNoCredentialConfigured() && getSecret() === null) {
      try { await recoverSecretStore(); } catch { /* still unreadable — handled below */ }
    }
    previousCredential = getSecret();
    // Trustworthy iff we either read a value or can say authoritatively there is
    // none. Unknown is neither, and there is no safe swap from unknown: once the
    // incoming key is written the original is gone and cannot be read back.
    const previousKnown = previousCredential !== null || hasNoCredentialConfigured();

    if (incomingCredential !== null && previousKnown) {
      // Marked BEFORE the await, not after. setSecret writes the keychain and
      // THEN strips any plaintext copy, and it throws if that strip fails — so
      // a rejection does not mean the swap did not happen. Setting the flag
      // afterwards left exactly that case unrolled-back: import reported as
      // failed, AI silently on the Electron key.
      //
      // Optimistic on purpose. The rollback writes a value the keychain may
      // already hold, which is a harmless no-op, whereas a missed rollback is
      // the user's credential changed behind a failure message.
      credentialReplaced = true;
      await saveApiKey(incomingCredential);
    }

    // Suspend saves before the import writes appStorage (see the format-2 path
    // above for the flush-await race); resumed in the catch if it throws.
    suspendedHere = store.suspendSaves();

    // keepCredential, for the same reason as the automatic upgrade in main.js:
    // this reads the previous Electron installation ON THIS MACHINE, so it is a
    // migration of the user's own live data, not the restore of a backup file.
    // Without it the credential is stripped before extraction can move it into
    // the keychain, and the user loses the key by choosing a recovery path.
    // MERGE carries the incoming credential only into a genuine gap. Its
    // contract is "your current data wins on conflict", and the current key is
    // current data — but keepCredential STAGES the old one in appStorage, where
    // a later boot that cannot reach the keychain adopts it as the read-only
    // fallback and starts spending on the previous installation's key. The
    // merge said current wins and the staged value quietly disagreed.
    //
    // `hasNoCredentialConfigured()` rather than `getSecret() === null`: a null
    // read in read-only or browser-unreadable means the store could not be READ,
    // not that nothing is there. Starting a merge while the keychain happens to
    // be locked would otherwise look like a gap and overrule a key that exists.
    // The rule lives in secretStore because this file is outside the suite.
    const keepForMerge = hasNoCredentialConfigured();
    const result = merging
      ? importFullBackupMerge(envelope, { keepCredential: keepForMerge })
      : await importFullBackupDurably(envelope, { keepCredential: true });

    const skipped = result.historySkipped > 0
      ? `\n\nNote: ${result.historySkipped} oversize undo/redo `
        + `${result.historySkipped === 1 ? 'entry was' : 'entries were'} skipped; `
        + `your resumes are intact.`
      : '';
    const summary = merging
      ? `Merged your previous app's resumes and settings into this one.`
      : `Imported ${result.keysImported} keys from your previous app `
        + `(removed ${result.removedExistingKeys} existing keys).`;
    // Said out loud rather than left silent: the user asked to replace
    // everything, and one thing was deliberately not replaced.
    const keyNote = (incomingCredential !== null && !previousKnown)
      ? `\n\nYour API key was left as it is — the current one couldn't be read, `
        + `so replacing it would have discarded a key you may still have.`
      : '';
    showImportSuccessAndReload(summary + skipped + keyNote);
  } catch (err) {
    if (suspendedHere) store.resumeSaves(); // resume only a suspension THIS call created
    // The import did not happen, so the credential swap it was part of must not
    // stand either — otherwise a failed replace silently reconfigures AI to the
    // previous installation's key while reporting that nothing was imported.
    //
    // Restores on `credentialReplaced` ALONE. Gating on
    // `previousCredential !== null` as well treated "no key configured" as
    // nothing to undo, when it is precisely the state that has to be put back:
    // that user ends up on the imported key having been told the import failed.
    // `?? ''` because the empty sentinel is how this app expresses "no
    // credential" — clearing writes '' rather than deleting the entry, so there
    // is no other way to say it.
    //
    // Best-effort: if this write fails too there is nothing further to try, and
    // the import error is the one worth showing.
    if (credentialReplaced) {
      try { await saveApiKey(previousCredential ?? ''); }
      catch (restoreErr) { console.error('[backup] could not restore the previous key:', restoreErr); }
    }
    console.error('[backup] Legacy import failed:', err);
    alert(`Couldn't import data from the previous app: ${err.message ?? String(err)}`);
  }
}
