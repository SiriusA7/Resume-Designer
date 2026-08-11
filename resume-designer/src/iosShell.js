/**
 * The bridge to the native iOS shell.
 *
 * On iOS the chrome is SwiftUI (`src-tauri/ios/OPShell.swift`) and only the
 * résumé canvas is web. This module is the seam between them. It is
 * deliberately a DISPATCHER, not a second implementation: every command routes
 * to the same function or the same DOM control the web chrome uses, so the two
 * shells cannot drift.
 *
 * Direction and transport:
 *
 *   Swift → JS   `webView.evaluateJavaScript("window.__opShell.command(json)")`
 *   JS → Swift   `window.webkit.messageHandlers.opShell.postMessage(snapshot)`
 *
 * The message handler is added by Swift when it installs the shell, so its
 * presence is also how the web side knows a native shell is there at all.
 * Nothing here runs on desktop or in the browser: `activate()` is only ever
 * called by Swift.
 *
 * The two pure pieces — `buildSnapshot` and `createCommandDispatcher` — carry
 * the contract and are unit-tested (test/iosShell.test.js). The rest is glue
 * that cannot be tested without a WKWebView.
 */

/** Name of the `WKScriptMessageHandler` Swift registers. Must match OPShell.swift. */
export const SHELL_HANDLER = 'opShell';

/** Class placed on `<html>` once the native shell owns the chrome. */
export const NATIVE_SHELL_CLASS = 'op-native-shell';

/**
 * Selectors for "a web dialog owns the screen".
 *
 * The native toolbar floats ABOVE the webview, so it covers the bottom of any
 * web modal — which put the PDF preview's Save button under it, unreachable.
 * The chrome has to get out of the way while one is open.
 *
 * Radix portals its dialogs to `<body>` and marks them `data-state="open"`.
 * The other two are the app's own overlay tokens: `.onboarding-overlay.show`
 * (the wizard's documented "on screen" contract, see onboarding.js) and
 * `.modal-overlay.show` (backupFlow.js's hand-built modal).
 *
 * The chat and structure panels are deliberately NOT here. They are drawers,
 * not modals, and they are toggled FROM the toolbar — hiding it would strand
 * the user in a panel with no way back.
 */
const MODAL_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '.onboarding-overlay.show',
  '.modal-overlay.show',
].join(',');

/** True when any web dialog is on screen. Pure over the passed root. */
export function hasOpenModal(root = document) {
  return !!root?.querySelector?.(MODAL_SELECTOR);
}

/**
 * Project app state onto the wire shape the SwiftUI chrome renders from.
 *
 * Coarse on purpose: the chrome needs a title, a menu of names, and a zoom
 * readout. Sending more would be a second document model living in Swift, which
 * is the thing the design rules out until the structure panel (staging step 5).
 *
 * Pure — no DOM, no storage.
 *
 * @param {object} state
 * @param {string|null} [state.currentId] id of the loaded résumé variant
 * @param {Array<{id: string, name?: string}>} [state.list] every variant
 * @param {number} [state.zoom] canvas scale, 1 = 100%
 * @param {boolean} [state.pdfBusy] a PDF export is in flight
 * @param {boolean} [state.modalOpen] a web dialog owns the screen
 * @returns {{variantId: string|null, variantName: string, variants: Array<{id: string, name: string}>, zoom: number, zoomPercent: number, pdfBusy: boolean, modalOpen: boolean}}
 */
export function buildSnapshot({
  currentId = null, list = [], zoom = 1, pdfBusy = false, modalOpen = false, settings,
} = {}) {
  const variants = (Array.isArray(list) ? list : [])
    .filter((v) => v && typeof v.id === 'string')
    .map((v) => ({ id: v.id, name: typeof v.name === 'string' && v.name ? v.name : 'Untitled' }));
  // A non-finite zoom would render as "NaN%" in the toolbar, so it is clamped
  // here rather than in Swift — the projection owns the wire shape's validity.
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    variantId: currentId,
    variantName: variants.find((v) => v.id === currentId)?.name ?? '',
    variants,
    zoom: safeZoom,
    zoomPercent: Math.round(safeZoom * 100),
    pdfBusy: !!pdfBusy,
    modalOpen: !!modalOpen,
    settings: buildSettings(settings),
  };
}

/**
 * Project the settings the native sheet renders. Pure.
 *
 * Deliberately a SUBSET of the web Settings dialog. Left out on purpose:
 * updates (`check_update_on_channel` is a `#[cfg(desktop)]` command and App
 * Store builds must not self-update), the companion bridge (a loopback HTTP
 * server), and the legacy Electron import (desktop paths). Showing controls
 * that cannot work is worse than not showing them.
 *
 * **The API key never crosses back.** Only whether one is set. The key lives in
 * the OS keychain; a native field can write a new one, but nothing needs to
 * read it out, so nothing does.
 *
 * @param {object} state
 * @param {string} [state.theme] 'system' | 'light' | 'dark'
 * @param {boolean} [state.hasApiKey]
 * @param {boolean} [state.autoFallback]
 * @param {string} [state.version]
 */
export function buildSettings({ theme, hasApiKey = false, autoFallback = false, version = '' } = {}) {
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    hasApiKey: !!hasApiKey,
    autoFallback: !!autoFallback,
    version: typeof version === 'string' ? version : '',
  };
}

/**
 * Build the command dispatcher from a map of `type → handler`.
 *
 * Returns a function that never throws: a handler that blows up must not take
 * the shell's chrome down with it, and Swift has no way to catch a JS
 * exception raised inside `evaluateJavaScript`. Failures come back as data.
 *
 * Pure — the impurity is entirely in the `actions` the caller supplies.
 *
 * @param {Record<string, (payload: object) => unknown>} actions
 * @returns {(command: unknown) => {ok: boolean, error?: string}}
 */
export function createCommandDispatcher(actions) {
  return function dispatch(command) {
    let parsed = command;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return { ok: false, error: 'malformed-json' };
      }
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return { ok: false, error: 'malformed-command' };
    }
    const action = actions[parsed.type];
    if (typeof action !== 'function') {
      return { ok: false, error: `unknown-command:${parsed.type}` };
    }
    try {
      action(parsed);
      return { ok: true };
    } catch (err) {
      console.error('[iosShell] command failed:', parsed.type, err);
      return { ok: false, error: String(err?.message ?? err) };
    }
  };
}

/**
 * Ask the native shell to present a share sheet for `path`.
 *
 * No-op anywhere the shell is not installed, so the caller does not have to
 * branch twice. The path always comes from Rust (`stage_pdf_for_share`), never
 * from anything the renderer composed.
 */
export function sharePdf(path) {
  if (!isNativeShellAvailable() || typeof path !== 'string' || !path) return false;
  window.webkit.messageHandlers[SHELL_HANDLER].postMessage({ kind: 'share', path });
  return true;
}

/** True when Swift has registered its message handler on this webview. */
export function isNativeShellAvailable(win = globalThis) {
  return typeof win?.webkit?.messageHandlers?.[SHELL_HANDLER]?.postMessage === 'function';
}

// --- glue -------------------------------------------------------------------

/** Click an existing web control so the native command runs the SAME code path. */
function click(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`control not found: #${id}`);
  el.click();
}

/** Ask the React chrome to run a flow it owns (confirm dialogs, file picker). */
function ask(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Open a file picker for a backup and hand the file to `onFile`.
 *
 * A transient input rather than a hidden one in the markup: the web Settings
 * dialog's input only exists while that dialog is open, and the native sheet
 * replaces it. The destructive confirmation still lives in backupFlow.js —
 * importing a backup replaces the whole store, and that gate must not be
 * duplicated or bypassed here.
 */
function pickBackupFile(onFile) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) onFile(file);
  }, { once: true });
  document.body.appendChild(input);
  input.click();
}

let activated = false;
let publish = () => {};

/**
 * Wire the bridge. Safe to call on every platform: it only installs
 * `window.__opShell` and some listeners, and does nothing visible until Swift
 * calls `activate()`.
 *
 * @param {object} deps injected so this stays testable and so main.js keeps
 *   ownership of the module graph.
 */
export function initIOSShell(deps) {
  const {
    subscribeVariants,
    getVariantsSnapshot,
    getZoom,
    fitToView,
    duplicateVariant,
    exportCurrentVariant,
  } = deps;

  const dispatch = createCommandDispatcher({
    // Résumé selection and CRUD. Rename, delete and import route back through
    // the React chrome, which owns the confirm dialogs, the last-variant guard
    // and the orphaned-chat-thread handling — duplicating any of that in Swift
    // is how a delete quietly loses threads.
    selectVariant: ({ id }) => deps.loadVariant(id),
    newVariant: () => window.showOnboardingWizard?.({ skipApiKeyStep: true }),
    renameVariant: () => ask('rd:variant-rename'),
    duplicateVariant: () => duplicateVariant(),
    deleteVariant: () => ask('rd:variant-delete'),
    importVariant: () => ask('rd:variant-import'),
    exportVariant: ({ format }) => exportCurrentVariant(format === 'md' ? 'md' : 'json'),

    // Tools. All of these already have a single entry point used by the web
    // header; the native menu calls the same one.
    openSettings: () => deps.openSettings(),
    openProfile: () => window.openUserProfilePanel?.(),
    openJobs: () => window.openJobDescriptionPanel?.(),
    openLibrary: () => ask('rd:open-library'),
    openHistory: () => window.openHistoryPanel?.(),

    // Panels stay web in step 2 — the native buttons drive the web toggles.
    toggleChat: () => click('toggle-chat-panel'),
    toggleStructure: () => click('toggle-structure-panel'),

    // Canvas. Clicking the hidden zoom buttons keeps the min/max clamping and
    // the disabled states in one place (zoomControls.js) instead of two.
    zoomIn: () => click('zoom-in'),
    zoomOut: () => click('zoom-out'),
    zoomReset: () => click('zoom-reset'),
    zoomFit: () => fitToView(),
    undo: () => click('undo-btn'),
    redo: () => click('redo-btn'),

    // Text formatting. These controls lived inside the floating zoom pill,
    // which the native shell hides — without routing them here, hiding the pill
    // would have quietly removed bold/italic/underline/bullets/text-size from
    // iOS. Clicking the same buttons keeps initTextTools() the only
    // implementation.
    textBold: () => click('text-bold'),
    textItalic: () => click('text-italic'),
    textUnderline: () => click('text-underline'),
    textBullets: () => click('text-bullets'),
    textClearFormat: () => click('text-clear-format'),
    textSizeIncrease: () => click('text-size-increase'),
    textSizeDecrease: () => click('text-size-decrease'),

    exportPdf: () => click('download-pdf'),

    // Settings, for the native sheet. Each writes through the same service the
    // web dialog uses, then republishes so the sheet reflects what landed
    // rather than what it optimistically set.
    setTheme: ({ value }) => { deps.setTheme(value); publish(); },
    setAutoFallback: ({ value }) => {
      deps.saveSettings({ autoFallback: value === 'true' });
      publish();
    },
    setApiKey: ({ value }) => {
      // Fire-and-forget by design: the keychain write is async and the sheet
      // learns the outcome from the next snapshot's `hasApiKey`, not from a
      // return value the bridge has no way to deliver.
      deps.saveApiKey(String(value ?? ''))
        .then(publish)
        .catch((err) => console.error('[iosShell] saving the API key failed:', err));
    },
    replayOnboarding: () => window.showOnboardingWizard?.(),
    exportBackup: () => deps.exportFullBackupWithFeedback(),
    importBackup: () => pickBackupFile(deps.importBackupFromFile),
  });

  let pdfBusy = false;
  let queued = false;
  let waits = 0;
  // The version is a one-shot async read, so it is fetched once and folded into
  // every later snapshot rather than making the projection async.
  let version = '';
  deps.getAppInfo().then((info) => { version = info?.version ?? ''; publish(); }).catch(() => {});

  const readSettings = () => {
    const s = deps.getSettings();
    return {
      theme: deps.getTheme(),
      hasApiKey: !!s.openrouterKey,
      autoFallback: !!s.autoFallback,
      version,
    };
  };

  const send = () => {
    queued = false;
    if (!activated) return;
    if (!isNativeShellAvailable()) {
      // Swift adds its message handler and calls activate() in the same run
      // loop pass, so the handler's JS namespace can lag the activation by a
      // frame. Without this the chrome would launch with an empty title and
      // stay that way until the user happened to change a variant or the zoom.
      if (waits++ < 40) setTimeout(publish, 50);
      return;
    }
    waits = 0;
    const { currentId, list } = getVariantsSnapshot();
    window.webkit.messageHandlers[SHELL_HANDLER].postMessage(
      {
        kind: 'snapshot',
        ...buildSnapshot({
          currentId, list, zoom: getZoom(), pdfBusy, modalOpen: hasOpenModal(),
          settings: readSettings(),
        }),
      }
    );
  };
  // Coalesce: loading a variant fires the variant subscription AND a zoom
  // refit in the same frame, and the chrome only needs the settled result.
  publish = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(send);
  };

  subscribeVariants(publish);
  window.addEventListener('rd:zoom', publish);
  // Dialogs open and close without any event this module could listen for —
  // Radix just portals a node into <body> and flips data-state. Watching the
  // DOM is the only signal that covers React dialogs, the onboarding wizard
  // and backupFlow's hand-built modal alike. Cheap: publish() coalesces into
  // one microtask, and the payload is a few hundred bytes.
  new MutationObserver(publish).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-state', 'class'],
  });
  window.addEventListener('rd:pdf-busy', (e) => {
    pdfBusy = !!e.detail?.busy;
    publish();
  });

  window.__opShell = {
    command: dispatch,
    /**
     * Called by Swift once the SwiftUI chrome is installed. Hides the web
     * chrome and starts publishing. Idempotent — Swift may retry if the page
     * had not finished booting on its first attempt.
     */
    activate: () => {
      if (activated) return true;
      activated = true;
      document.documentElement.classList.add(NATIVE_SHELL_CLASS);
      publish();
      return true;
    },
  };

  // Swift may win the race and call activate() before this module has run. It
  // leaves this flag behind when it does, so the handshake completes either way.
  if (window.__opShellPendingActivate) window.__opShell.activate();
}
