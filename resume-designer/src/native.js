/**
 * Native Platform Utilities
 * Unified API for native features across web and Tauri.
 *
 * Migrated from Electron preload IPC to Tauri 2 plugin imports.
 * Exported names are preserved (incl. legacy `isElectron` alias) so the rest
 * of the renderer keeps working unchanged.
 */

// Deliberate exception to this module's no-static-app-imports style: the
// update-channel / auto-update-check getters below are synchronous, so the
// lazy dynamic-import pattern used for the Tauri plugins can't apply.
// appStorage is tiny and has zero static app imports, so this cannot form a
// cycle (appStorage itself dodges importing native.js for the same reason).
import { appStorage } from './appStorage.js';

// Detect Tauri without statically importing tauri APIs at the web entry
// (so `npm run dev` outside Tauri doesn't blow up at import time).
// Per Tauri 2.5 release notes (v2.tauri.app/release/@tauri-apps/api/v2.5.0),
// `core.isTauri` checks for the `isTauri` property on `globalThis`, which
// Tauri's runtime sets at startup. Doing the sniff inline keeps it sync
// (so module-init code can rely on it) without dynamic-importing
// @tauri-apps/api/core.
export const isTauri =
  typeof globalThis !== 'undefined' && 'isTauri' in globalThis;

// Back-compat alias — keeps src/pdf.js, src/headerBar.js, etc. unchanged.
// Slated for removal in a follow-up cleanup PR.
export const isElectron = isTauri;

let _platformCache = null;
let _appInfoCache = null;

// Lazy holders for the Tauri plugin modules. Dynamic-imported so the web
// branch never tries to resolve `@tauri-apps/*` packages.
//
// `@tauri-apps/plugin-fs` is intentionally NOT loaded here. No renderer
// code reads or writes via fs anymore — PDF export goes through the
// dedicated Rust commands (pick_pdf_save_path + capture_pdf_from_window),
// JSON/Markdown import/export use the browser's File API and `<a download>`.
// Keeping fs out of the renderer means a compromised script can't reach
// the filesystem even if `@tauri-apps/plugin-fs` were re-introduced in
// Cargo without a matching capability.
let _tauri = null;
async function tauri() {
  if (_tauri) return _tauri;
  if (!isTauri) throw new Error('Tauri APIs unavailable outside the desktop app');
  const [dialog, shell, app, osPlugin, updater, process, core, event] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-shell'),
    import('@tauri-apps/api/app'),
    import('@tauri-apps/plugin-os'),
    import('@tauri-apps/plugin-updater'),
    import('@tauri-apps/plugin-process'),
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  _tauri = { dialog, shell, app, osPlugin, updater, process, core, event };
  return _tauri;
}

const PLATFORM_MAP = {
  macos: 'darwin',
  windows: 'win32',
  linux: 'linux',
};

/**
 * Returns 'darwin' | 'win32' | 'linux' | 'web'.
 * Now async (Tauri's platform() is async). The only renderer callers are
 * in main.js init() and persistence.js, both of which can await.
 */
export async function getPlatform() {
  if (!isTauri) return 'web';
  if (_platformCache) return _platformCache;
  const { osPlugin } = await tauri();
  const raw = await osPlugin.platform();
  _platformCache = PLATFORM_MAP[raw] ?? raw;
  return _platformCache;
}

/**
 * Show a message dialog. Returns the index of the clicked button (0 or 1).
 */
export async function showMessage(options) {
  if (isTauri) {
    const { dialog } = await tauri();
    const kind = options.type === 'error' || options.type === 'warning' ? options.type : 'info';
    const buttons = options.buttons || ['OK'];
    if (buttons.length <= 1) {
      await dialog.message(options.message ?? '', {
        title: options.title ?? 'Resume Designer',
        kind,
      });
      return 0;
    }
    const yes = await dialog.ask(options.message ?? '', {
      title: options.title ?? 'Resume Designer',
      kind,
      okLabel: buttons[0],
      cancelLabel: buttons[1],
    });
    return yes ? 0 : 1;
  }

  // Web fallback
  if (options.buttons && options.buttons.length > 1) {
    return confirm(options.message) ? 0 : 1;
  }
  alert(options.message);
  return 0;
}

/**
 * Get app metadata.
 */
export async function getAppInfo() {
  if (_appInfoCache) return _appInfoCache;
  if (isTauri) {
    const { app } = await tauri();
    _appInfoCache = {
      version: await app.getVersion(),
      name: await app.getName(),
      platform: await getPlatform(),
      isPackaged: import.meta.env.PROD,
    };
    return _appInfoCache;
  }
  return {
    version: '1.0.0',
    name: 'Resume Designer',
    platform: 'web',
    isPackaged: false,
  };
}

// ============================================
// Updater state machine — mirrors the Electron behavior exactly:
//   checking → up-to-date | available → (download? Y/N) →
//     download-started → downloading (with percent) → downloaded →
//     (restart? Y/N) → installing | restart-deferred
// ============================================

const updateStatusListeners = [];
const updateProgressListeners = [];
let isCheckingForUpdates = false;

function emitStatus(payload) {
  const enriched = { timestamp: Date.now(), ...payload };
  for (const cb of updateStatusListeners) {
    try { cb(enriched); } catch (_) { /* swallow */ }
  }
}
function emitProgress(percent) {
  for (const cb of updateProgressListeners) {
    try { cb(percent); } catch (_) { /* swallow */ }
  }
}

export function onUpdateStatus(callback) {
  if (typeof callback === 'function') updateStatusListeners.push(callback);
}
export function onUpdateProgress(callback) {
  if (typeof callback === 'function') updateProgressListeners.push(callback);
}

// Update channel: 'stable' (default) or 'beta'. Persisted via appStorage so
// the choice survives restarts; it's an owned key (see persistence.js) so it
// rides along in backup/restore. The actual endpoint switch happens in the
// Rust `check_update_on_channel` command — the JS just supplies the channel.
const UPDATE_CHANNEL_KEY = 'resume-designer-update-channel';
export function getUpdateChannel() {
  try {
    return appStorage.getItem(UPDATE_CHANNEL_KEY) === 'beta' ? 'beta' : 'stable';
  } catch {
    return 'stable';
  }
}
export function setUpdateChannel(channel) {
  const normalized = channel === 'beta' ? 'beta' : 'stable';
  try {
    appStorage.setItem(UPDATE_CHANNEL_KEY, normalized);
  } catch {
    /* ignore storage errors — falls back to the default on next read */
  }
  return normalized;
}

/**
 * First-run channel seed: a beta build (pre-release version, e.g.
 * `1.11.0-next.53`) tracks the beta channel by default so a fresh install gets
 * the superset (beta + stable) instead of silently defaulting to stable and
 * missing pre-releases. Only acts when the user hasn't chosen a channel yet;
 * stable builds keep the unset → stable default (no key written).
 */
async function seedUpdateChannelFromBuild() {
  try {
    if (appStorage.getItem(UPDATE_CHANNEL_KEY) !== null) return;
    const { version } = await getAppInfo();
    if (typeof version === 'string' && version.includes('-')) {
      setUpdateChannel('beta');
    }
  } catch {
    /* non-fatal — falls back to the stable default on next read */
  }
}

// Whether to auto-check for updates on launch. Persisted (owned key) so it
// rides along in backup/restore. Defaults to true (the prior always-on
// behavior); only an explicit 'false' disables it. Consumed by
// startupUpdateCheck() and toggled from Settings → Updates.
const AUTO_UPDATE_CHECK_KEY = 'resume-designer-auto-update-check';
export function getAutoUpdateCheck() {
  try {
    return appStorage.getItem(AUTO_UPDATE_CHECK_KEY) !== 'false';
  } catch {
    return true;
  }
}
export function setAutoUpdateCheck(enabled) {
  try {
    appStorage.setItem(AUTO_UPDATE_CHECK_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore storage errors — falls back to the default on next read */
  }
  return !!enabled;
}

export async function checkForUpdates(source = 'manual', { notifyOnly = false } = {}) {
  if (!isTauri) {
    return {
      checking: false,
      message: 'Update checks are only available in the desktop app.',
    };
  }

  if (import.meta.env.DEV) {
    emitStatus({
      status: 'disabled',
      source,
      message: 'Updates are disabled in development builds.',
    });
    return { checking: false, message: 'Updates disabled in development', reason: 'disabled' };
  }

  if (isCheckingForUpdates) {
    emitStatus({
      status: 'checking',
      source,
      message: 'Already checking for updates...',
    });
    return { checking: false, reason: 'already-checking' };
  }

  isCheckingForUpdates = true;
  emitStatus({ status: 'checking', source, message: 'Checking for updates...' });

  try {
    // Inside try so a dynamic-import failure (chunk load, transient network)
    // is caught by the handler below and resets isCheckingForUpdates.
    const { core, process: tauriProcess, dialog } = await tauri();
    // Channel selection (stable/beta) can only happen Rust-side — the JS
    // plugin-updater check() cannot override the endpoint — so route through
    // our command, which builds the updater for the chosen channel's endpoint.
    const update = await core.invoke('check_update_on_channel', {
      channel: getUpdateChannel(),
    });
    if (!update) {
      emitStatus({ status: 'up-to-date', source, message: 'You are on the latest version.' });
      isCheckingForUpdates = false;
      return { checking: true };
    }

    const currentVersion = await getAppInfo().then((i) => i.version).catch(() => null);
    emitStatus({
      status: 'available',
      source,
      version: update.version,
      currentVersion,
      notifyOnly,
      notes: update.notes || '',
      message: `Version ${update.version} is available.`,
    });

    // Background poll (notify-only): surface the toast and stop here — no
    // download dialog. The user acts via the toast's "Update" action (which runs
    // the manual flow) or Settings → Check for Updates.
    if (notifyOnly) {
      isCheckingForUpdates = false;
      return { checking: true, available: true, version: update.version };
    }

    // Rich release-notes dialog (React host, promise-returning — same pattern as
    // confirmDestructive) replaces the plain native ask so the user sees what's
    // new before downloading. Dynamic import keeps native.js's static graph lean.
    const { showUpdateNotes } = await import('./components/ui/updateNotes.jsx');
    const decision = await showUpdateNotes({
      version: update.version,
      currentVersion,
      notes: update.notes || '',
      mode: 'update',
    });
    const wantsDownload = decision === 'download';
    if (!wantsDownload) {
      emitStatus({
        status: 'deferred',
        source,
        version: update.version,
        message: 'Update download postponed.',
      });
      isCheckingForUpdates = false;
      return { checking: true };
    }

    emitStatus({
      status: 'download-started',
      source,
      version: update.version,
      message: `Downloading version ${update.version}...`,
    });

    let downloaded = 0;
    let total = 0;
    const onEvent = new core.Channel();
    onEvent.onmessage = (event) => {
      switch (event.event) {
        case 'Started':
          total = event.data?.contentLength ?? 0;
          break;
        case 'Progress': {
          downloaded += event.data?.chunkLength ?? 0;
          if (total > 0) {
            const percent = Math.min(100, (downloaded / total) * 100);
            emitProgress(percent);
            emitStatus({
              status: 'downloading',
              source,
              percent,
              message: `Downloading update... ${Math.round(percent)}%`,
            });
          }
          break;
        }
        case 'Finished':
          emitProgress(100);
          emitStatus({
            status: 'downloaded',
            source,
            version: update.version,
            message: `Version ${update.version} is ready to install.`,
          });
          break;
        default:
          break;
      }
    };
    await core.invoke('install_pending_update', { onEvent });

    const wantsRestart = await dialog.ask(
      `Version ${update.version} has been downloaded. Restart the app to apply the update.`,
      { title: 'Update Ready', okLabel: 'Restart Now', cancelLabel: 'Later' }
    );
    if (wantsRestart) {
      // Relaunch is an in-app process exit, but unlike a plain quit the updated
      // app immediately boots BACK from disk — so an edit still only in the
      // write-behind cache would be lost to a stale on-disk value. Drain the
      // debounced edit + the queue FIRST and gate the relaunch on durability,
      // exactly as the PDF/backup-import paths do. Dynamic imports keep this
      // module static-import-free (both are already in the module cache).
      let durable = true;
      try {
        const [{ store }, { appStorage }] = await Promise.all([
          import('./store.js'),
          import('./appStorage.js'),
        ]);
        try { store.saveNow(); } catch { /* nothing pending */ }
        durable = await appStorage.flush();
      } catch (e) {
        console.warn('[Update] pre-relaunch flush failed:', e);
        durable = false;
      }
      if (!durable) {
        // The last change could not be written to disk (disk full /
        // permissions). Relaunching now would boot the updated app from stale
        // files and silently drop it. Hold the restart — the update is already
        // downloaded and installs on the next launch anyway — and tell the user
        // to free space first. (appStorage already fired the generic failure
        // toast.)
        emitStatus({
          status: 'error',
          source,
          version: update.version,
          message:
            'Update downloaded, but your latest change could not be saved to disk, '
            + 'so the restart was held off to avoid losing it. Free up disk space, '
            + 'then restart the app to finish installing.',
        });
        isCheckingForUpdates = false;
        return { checking: false, error: 'flush-not-durable' };
      }
      emitStatus({
        status: 'installing',
        source,
        version: update.version,
        message: 'Restarting to install update...',
      });
      // Mirror Electron's 10s watchdog: if relaunch doesn't actually start,
      // surface guidance instead of hanging silently.
      const guard = setTimeout(() => {
        emitStatus({
          status: 'error',
          source,
          message:
            'Update install did not start. Please verify that the app is properly signed/notarized.',
        });
      }, 10000);
      try {
        await tauriProcess.relaunch();
      } finally {
        clearTimeout(guard);
      }
    } else {
      emitStatus({
        status: 'restart-deferred',
        source,
        version: update.version,
        message: 'Update downloaded. Restart the app later to finish installation.',
      });
    }

    isCheckingForUpdates = false;
    return { checking: true };
  } catch (err) {
    isCheckingForUpdates = false;
    const raw = err?.message ?? String(err);
    const signatureFailure = /signature|verify|verification|invalid/i.test(raw);
    const message = signatureFailure
      ? 'Updater rejected this update because signature verification failed. The release artifact may be unsigned or corrupted.'
      : `Updater error: ${raw}`;
    emitStatus({ status: 'error', source, message });
    return { checking: false, error: raw };
  }
}

/**
 * Auto-check on app launch. Called once from src/main.js init().
 * Equivalent of electron/main.cjs:106 `checkForUpdates('startup')`.
 */
export async function startupUpdateCheck() {
  if (!isTauri || import.meta.env.DEV) return;
  // Seed the channel from the build type on first run — before the auto-check
  // gate, so a fresh beta install lands on the beta (superset) channel even if
  // auto-check is later turned off.
  await seedUpdateChannelFromBuild();
  if (!getAutoUpdateCheck()) return;
  await checkForUpdates('startup');
}

/**
 * Register a handler for the macOS "Check for Updates…" application-menu item. The
 * Rust side (src-tauri/src/lib.rs) emits `menu:check-updates` when it's clicked.
 * No-op on the web build; resolves to an unlisten function on desktop.
 */
export async function onMenuCheckUpdates(callback) {
  if (!isTauri) return () => {};
  const { event } = await tauri();
  return event.listen('menu:check-updates', () => callback());
}

/**
 * Register a handler for the macOS "Settings…" application-menu item. The Rust side
 * (src-tauri/src/lib.rs) emits `menu:open-settings` when it's clicked. No-op on the
 * web build; resolves to an unlisten function on desktop.
 */
export async function onMenuOpenSettings(callback) {
  if (!isTauri) return () => {};
  const { event } = await tauri();
  return event.listen('menu:open-settings', () => callback());
}

/**
 * Open a URL in the system default browser.
 * Mirror of electron's setWindowOpenHandler/shell.openExternal pattern.
 */
export async function openExternal(url) {
  if (isTauri) {
    const { shell } = await tauri();
    await shell.open(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Show the native save-file dialog (PDF filter) and return the chosen path,
 * or `null` if the user cancelled. Pure dialog interaction — no capture yet.
 * Lets pdf.js separate "pick where to save" from "render and capture", which
 * is what enables the background hidden-window flow.
 */
export async function pickPdfSavePath(defaultName = 'Resume.pdf') {
  if (!isTauri) return null;
  const { core } = await tauri();
  return await core.invoke('pick_pdf_save_path', { defaultName });
}

/**
 * Invoke the Rust capture command against a SPECIFIC window's web view
 * (identified by label). Used by pdf.js after spawning a hidden print window
 * at `/print.html` and receiving its `print-ready` event.
 *
 * Notice there is NO `savePath` parameter: the destination path is bound
 * server-side by the prior `pickPdfSavePath` call (which stashes the
 * user-confirmed path in Rust state). This prevents the renderer from
 * writing PDFs to arbitrary filesystem locations even under XSS / a
 * compromised dependency.
 *
 * - `pageSize` (inches) is consumed by the Windows WebView2 PrintToPdfAsync path.
 * - `captureRect` (CSS pixels, doc-relative; in the new flow the print window
 *   anchors the resume at origin so x/y are always 0) is consumed by the
 *   macOS WKWebView createPDF path.
 */
export async function capturePdfFromWindow(windowLabel, pageSize = null, captureRect = null, captureRects = null) {
  if (!isTauri) {
    return { success: false, error: 'Native PDF generation not available in browser' };
  }
  const { core } = await tauri();
  return await core.invoke('capture_pdf_from_window', {
    windowLabel,
    pageSize,
    captureRect,
    captureRects,
  });
}

/**
 * Read the just-generated preview PDF as base64 so the renderer can display it
 * in an <iframe> before the user saves. Returns null in the browser (no native
 * preview there).
 */
export async function readPdfPreview() {
  if (!isTauri) return null;
  const { core } = await tauri();
  return await core.invoke('read_pdf_preview');
}

/**
 * Copy the previewed temp PDF to the path the user just confirmed via
 * pickPdfSavePath. Returns a PdfResult ({ success, filePath?, error?, canceled? }).
 */
export async function savePdfPreview() {
  if (!isTauri) return { success: false, error: 'Native PDF save not available in browser' };
  const { core } = await tauri();
  return await core.invoke('save_pdf_preview');
}

/** Delete the preview temp PDF (user cancelled). Best-effort; never throws. */
export async function discardPdfPreview() {
  if (!isTauri) return;
  try {
    const { core } = await tauri();
    await core.invoke('discard_pdf_preview');
  } catch (e) {
    console.warn('discardPdfPreview failed:', e);
  }
}

/**
 * Check whether a legacy Electron LevelDB exists on disk with this
 * app's data in it. Returns a `ProbeResult` shape: `{ found, sourcePath,
 * keyCount, variantCount, jobDescriptionCount, userProfilePresent }`.
 * Pure read — never modifies the source LevelDB.
 *
 * In a non-Tauri context (web fallback) returns a "not found" result so
 * the caller can no-op without conditional branching.
 */
export async function probeLegacyElectronData() {
  if (!isTauri) {
    return { found: false };
  }
  const { core } = await tauri();
  return await core.invoke('probe_legacy_electron_data');
}

/**
 * Open the legacy Electron LevelDB, decode its `resume-designer-*` and
 * `resume-*` keys, and return a backup-envelope object the caller can
 * pass directly to `importFullBackupFromEnvelope` in persistence.js.
 *
 * Throws (rejects) if no legacy data is found or extraction fails.
 * Callers should treat this as best-effort and silently continue boot
 * on rejection — there's a manual fallback (Tools → Import Backup).
 */
export async function importLegacyElectronData() {
  if (!isTauri) {
    throw new Error('Legacy Electron import is only available in the desktop app.');
  }
  const { core } = await tauri();
  return await core.invoke('import_legacy_electron_data');
}
