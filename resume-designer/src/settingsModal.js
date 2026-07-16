/**
 * Settings bridge.
 *
 * The Settings panel is now a React component (src/components/SettingsDialog.jsx).
 * This module is the thin shim that lets the still-vanilla callers open it:
 *   - the header gear (Header.jsx) calls openSettings() directly;
 *   - the chat-panel gear (ChatPanel.jsx) calls openSettings('api-keys') in JSX.
 * Both dispatch a window event the React dialog listens for. The dialog reads
 * and writes every setting through the same owner modules (persistence.js,
 * theme.js, native.js, tokenTrackingService.js), so the backup bus and
 * SETTINGS_UPDATED flows are unchanged.
 */

/** Open the Settings dialog, optionally to a tab (account|general|api-keys|updates|data|usage). */
export function openSettings(tab) {
  window.dispatchEvent(new CustomEvent('rd:open-settings', { detail: { tab: tab || 'general' } }));
}

/** Retained no-op: main.js still calls this during boot. Both Settings entry
 *  points (header gear, chat-panel gear) are now React buttons that import
 *  openSettings() directly, so there's nothing left to wire here. */
export function initSettingsModal() {}
