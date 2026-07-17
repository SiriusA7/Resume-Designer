/**
 * User profile panel bridge.
 *
 * The profile editor is now a React component (src/components/profile/ProfileDialog.jsx)
 * that listens for the `rd:profile-*` window events dispatched here. This thin
 * module preserves the original ES exports so the still-vanilla callers keep
 * working unchanged:
 *
 *   - Header.jsx / onboarding.js → window.openUserProfilePanel() (wired in main.js)
 *   - backupFlow.js              → flushPendingProfileSave()
 *
 * CustomEvent dispatch runs listeners synchronously, so flushPendingProfileSave()
 * still flushes the dialog's pending debounced save *before* it returns — exactly
 * what backupFlow.js relies on right before its delayed reload (the documented
 * autosave-clobbers-import race). The dialog is always mounted, so the listener
 * is present even when the editor is closed (a no-op when nothing is pending).
 */

// Open the profile editor.
export function openUserProfilePanel() {
  window.dispatchEvent(new CustomEvent('rd:open-profile'));
}

// Synchronously flush any pending profile autosave (safe to call anytime).
// CustomEvent dispatch runs listeners synchronously, so the ProfileDialog's
// handler has written its persist result to detail.ok by the time dispatch
// returns. Returns false only when a mounted dialog reports a failed save
// (passthrough quota); undefined (no dialog / nothing pending) counts as ok.
export function flushPendingProfileSave() {
  const event = new CustomEvent('rd:profile-flush', { detail: {} });
  window.dispatchEvent(event);
  return event.detail.ok !== false;
}
