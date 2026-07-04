/**
 * Updater status flow.
 *
 * Ported from headerBar.js (Step 6 of the React migration). The status
 * state-machine and the manual-check trigger are unchanged; the only difference
 * is the surface: the bespoke single #update-status-toast element is replaced by
 * Sonner (the toast() emitter reaches the <Toaster> mounted in App.jsx). A
 * stable toast id makes successive status messages update one toast in place,
 * exactly like the old reused element did.
 *
 * The manual "Check for Updates" trigger lives in Settings → Updates; this
 * module owns the shared `busy` flag (so that button can disable itself via the
 * useUpdateBusy() hook) and the manual-vs-automatic gating that decides which
 * status transitions surface a toast.
 */

import { toast } from 'sonner';
import {
  isElectron, checkForUpdates, onUpdateStatus, getAutoUpdateCheck, onMenuCheckUpdates,
} from './native.js';

const UPDATE_TOAST_ID = 'rd-update-status';

let initialized = false;
let manualUpdateCheckActive = false;

// Background update polling: re-check every 30 min while the app is open and
// surface one toast per new version (deduped). Notify-only — no download dialog.
const POLL_INTERVAL_MS = 30 * 60 * 1000;
let pollTimer = null;
let lastBackgroundAvailableVersion = null;

// --- busy state (drives the Settings "Check for Updates" button) -------------
let busy = false;
const busySubscribers = new Set();

export function subscribeUpdateBusy(callback) {
  busySubscribers.add(callback);
  return () => busySubscribers.delete(callback);
}

export function getUpdateBusy() {
  return busy;
}

function setBusy(value) {
  if (busy === value) return;
  busy = value;
  busySubscribers.forEach((cb) => cb());
}

// --- toast bridge ------------------------------------------------------------
/**
 * Show / update the single update-status toast. `persistent` toasts stay until
 * replaced or dismissed (Infinity duration); transient ones auto-dismiss after
 * 4.5s — matching the old behavior. Reusing one id means a "Checking…" toast
 * becomes the "Up to date" toast in place rather than stacking.
 */
function showUpdateToast(message, tone = 'info', persistent = false, action = null) {
  if (!isElectron || !message) return;
  const opts = {
    id: UPDATE_TOAST_ID,
    duration: persistent ? Infinity : 4500,
    ...(action ? { action } : {}),
  };
  switch (tone) {
    case 'success':
      toast.success(message, opts);
      break;
    case 'warning':
      toast.warning(message, opts);
      break;
    case 'error':
      toast.error(message, opts);
      break;
    default:
      toast.info(message, opts);
  }
}

/**
 * Subscribe to native update-status events once. Safe to call on every boot;
 * a no-op in the browser build and idempotent in desktop.
 */
export function initUpdateFlow() {
  if (!isElectron || initialized) return;
  initialized = true;
  onUpdateStatus((payload = {}) => handleUpdateStatus(payload));
  // The macOS app-menu "Check for Updates…" item runs the same flow as the
  // Settings → Updates button. Fire-and-forget the async listener registration.
  onMenuCheckUpdates(() => triggerManualUpdateCheck()).catch(() => {});
  startBackgroundPolling();
}

// Poll for updates every 30 minutes while the app is open. Notify-only (the
// "available" handler shows one actionable toast per version); respects the
// Settings auto-update toggle live, and never runs in dev.
function startBackgroundPolling() {
  if (pollTimer || import.meta.env.DEV) return;
  pollTimer = setInterval(() => {
    if (!getAutoUpdateCheck()) return;
    checkForUpdates('background', { notifyOnly: true }).catch(() => {});
  }, POLL_INTERVAL_MS);
}

/**
 * Manual "Check for Updates" (Settings → Updates). Disables the button, shows a
 * persistent "Checking…" toast, then lets the status events drive the rest.
 */
export async function triggerManualUpdateCheck() {
  if (!isElectron) return;

  manualUpdateCheckActive = true;
  setBusy(true);
  showUpdateToast('Checking for updates...', 'info', true);

  try {
    const result = await checkForUpdates();
    if (!result?.checking) {
      manualUpdateCheckActive = false;
      setBusy(false);

      if (result?.reason === 'already-checking') {
        showUpdateToast('Already checking for updates...', 'info');
      } else if (result?.message) {
        showUpdateToast(result.message, 'warning');
      }
    }
  } catch (error) {
    manualUpdateCheckActive = false;
    setBusy(false);
    showUpdateToast(`Could not check for updates: ${error.message}`, 'error');
  }
}

function handleUpdateStatus(payload) {
  if (!payload?.status) return;

  const status = payload.status;
  const source = payload.source || 'auto';
  const isManualFlow = source === 'manual' || manualUpdateCheckActive;
  const percent = typeof payload.percent === 'number' ? Math.round(payload.percent) : null;
  const version = payload.version ? ` ${payload.version}` : '';

  switch (status) {
    case 'checking':
      if (isManualFlow) {
        setBusy(true);
        showUpdateToast(payload.message || 'Checking for updates...', 'info', true);
      }
      break;

    case 'up-to-date':
      if (isManualFlow) {
        showUpdateToast(payload.message || 'You are on the latest version.', 'success');
      }
      manualUpdateCheckActive = false;
      setBusy(false);
      break;

    case 'available': {
      if (payload.notifyOnly === true) {
        // Background poll: one actionable toast per new version, no nagging.
        if (payload.version && payload.version === lastBackgroundAvailableVersion) {
          manualUpdateCheckActive = false;
          setBusy(false);
          break;
        }
        lastBackgroundAvailableVersion = payload.version || null;
        showUpdateToast(
          payload.message || `Update${version} is available.`,
          'info',
          true,
          { label: 'Update', onClick: () => triggerManualUpdateCheck() }
        );
      } else {
        showUpdateToast(
          payload.message || `Update${version} is available. Choose Download in the dialog to continue.`,
          'info'
        );
      }
      manualUpdateCheckActive = false;
      setBusy(false);
      break;
    }

    case 'download-started':
      setBusy(true);
      showUpdateToast(payload.message || 'Downloading update... 0%', 'info', true);
      break;

    case 'downloading':
      setBusy(true);
      showUpdateToast(
        payload.message || `Downloading update... ${percent || 0}%`,
        'info',
        true
      );
      break;

    case 'downloaded':
      showUpdateToast(
        payload.message || `Update${version} downloaded. Choose Restart Now in the dialog to install.`,
        'success'
      );
      manualUpdateCheckActive = false;
      setBusy(false);
      break;

    case 'restart-deferred':
      showUpdateToast(
        payload.message || 'Update downloaded. Restart the app later to finish installation.',
        'info'
      );
      manualUpdateCheckActive = false;
      setBusy(false);
      break;

    case 'deferred':
      showUpdateToast(payload.message || 'Update download postponed.', 'info');
      manualUpdateCheckActive = false;
      setBusy(false);
      break;

    case 'installing':
      showUpdateToast(payload.message || 'Restarting to install update...', 'info', true);
      manualUpdateCheckActive = false;
      setBusy(true);
      break;

    case 'disabled':
      if (isManualFlow) {
        showUpdateToast(payload.message || 'Updates are disabled in development builds.', 'warning');
      }
      manualUpdateCheckActive = false;
      setBusy(false);
      break;

    case 'error':
      if (isManualFlow || source === 'startup') {
        showUpdateToast(payload.message || 'Could not check for updates.', 'error');
      }
      manualUpdateCheckActive = false;
      setBusy(false);
      break;

    default:
      break;
  }
}
