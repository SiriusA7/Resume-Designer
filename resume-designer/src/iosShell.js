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
  document: outline = null, chat = null,
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
    // `null` means "the panel is closed, do not re-render it" — distinct from
    // an empty outline, which would blank a panel that is open.
    document: outline,
    chat,
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
 * Project the résumé into the flat, labelled, PATH-KEYED outline the native
 * structure panel renders.
 *
 * This is the only place the document crosses the bridge, and the shape is
 * chosen so that **Swift never learns the document's schema**. It receives
 * groups of `{path, label, value}` and renders a generic form; it cannot know
 * that `experience[0].bullets[1]` is a bullet, only that it is a multiline
 * field with that path. So Swift can only ever echo back a path it was GIVEN —
 * it has no way to construct one, which is what keeps the path grammar from
 * getting a second implementation. Drift in that grammar has corrupted data
 * here before.
 *
 * Pure — no DOM, no storage.
 *
 * @param {object|null} data the résumé document
 */
export function buildDocumentOutline(data) {
  if (!data || typeof data !== 'object') return { groups: [] };
  const groups = [];
  const text = (v) => (typeof v === 'string' ? v : '');
  const list = (v) => (Array.isArray(v) ? v : []);

  // Keys read off EMPTY_RESUME in store.js, not guessed: the document has
  // `name`/`tagline` at the top level and the rest under `contact`.
  const contact = data.contact || {};
  groups.push({
    id: 'header',
    title: 'Header',
    listPath: null,
    listOffset: 0,
    fields: [
      { path: 'name', label: 'Name', value: text(data.name), multiline: false },
      { path: 'tagline', label: 'Professional title', value: text(data.tagline), multiline: false },
      { path: 'contact.location', label: 'Location', value: text(contact.location), multiline: false },
      { path: 'contact.email', label: 'Email', value: text(contact.email), multiline: false },
      { path: 'contact.phone', label: 'Phone', value: text(contact.phone), multiline: false },
      { path: 'contact.portfolio', label: 'Portfolio', value: text(contact.portfolio), multiline: false },
    ],
  });

  groups.push({
    id: 'summary',
    title: 'Summary',
    listPath: null,
    listOffset: 0,
    fields: [{ path: 'summary', label: 'Summary', value: text(data.summary), multiline: true }],
  });

  list(data.experience).forEach((role, i) => {
    const fields = [
      { path: `experience[${i}].title`, label: 'Role', value: text(role?.title), multiline: false },
      { path: `experience[${i}].company`, label: 'Company', value: text(role?.company), multiline: false },
      { path: `experience[${i}].dates`, label: 'Dates', value: text(role?.dates), multiline: false },
    ];
    list(role?.bullets).forEach((bullet, j) => {
      fields.push({
        path: `experience[${i}].bullets[${j}]`,
        label: `Bullet ${j + 1}`,
        value: text(bullet),
        multiline: true,
      });
    });
    groups.push({
      id: `experience-${i}`,
      title: text(role?.title) || `Role ${i + 1}`,
      fields,
      // Only the bullets are a reorderable list here; the role's own
      // title/company/dates are fields of one object.
      listPath: `experience[${i}].bullets`,
      listOffset: 3,
    });
  });

  const education = list(data.education);
  if (education.length) {
    groups.push({
      id: 'education',
      title: 'Education',
      fields: education.map((entry, i) => ({
        path: `education[${i}]`, label: `Entry ${i + 1}`, value: text(entry), multiline: true,
      })),
      listPath: 'education',
      listOffset: 0,
    });
  }

  list(data.sections).forEach((section, i) => {
    const fields = [
      { path: `sections[${i}].title`, label: 'Heading', value: text(section?.title), multiline: false },
    ];
    if (Array.isArray(section?.content)) {
      section.content.forEach((item, j) => {
        fields.push({
          path: `sections[${i}].content[${j}]`, label: `Item ${j + 1}`, value: text(item), multiline: false,
        });
      });
    } else if (typeof section?.content === 'string') {
      // Prose sections keep their content as one string, not a list.
      fields.push({ path: `sections[${i}].content`, label: 'Text', value: section.content, multiline: true });
    }
    groups.push({
      id: `section-${i}`,
      title: text(section?.title) || `Section ${i + 1}`,
      fields,
      // The heading occupies row 0, so the list starts one row in. A string
      // (prose) section is not a list and gets no listPath.
      listPath: Array.isArray(section?.content) ? `sections[${i}].content` : null,
      listOffset: 1,
    });
  });

  if (typeof data.tools === 'string' && data.tools) {
    groups.push({
      id: 'tools',
      title: 'Tools',
      listPath: null,
      listOffset: 0,
      fields: [{ path: 'tools', label: 'Tools', value: data.tools, multiline: true }],
    });
  }

  return { groups };
}

/**
 * Project the AI's still-pending changes for the native review sheet.
 *
 * `before`/`after` are the human-readable strings the web diff already computes
 * (`displayOld`/`displayNew`), so the native list shows the same text the
 * desktop review does — nothing about what a change MEANS is decided twice.
 *
 * Truncated, because a whole-section proposal serialises to JSON that no phone
 * screen can show: a review that does not fit is a review nobody reads.
 *
 * Pure.
 */
export function buildPendingChanges(changes) {
  const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const clip = (v) => (v.length > 600 ? `${v.slice(0, 600)}…` : v);
  return (Array.isArray(changes) ? changes : [])
    .filter((c) => c && typeof c.path === 'string')
    .map((c) => ({
      path: c.path,
      // The path is the only label the diff guarantees; it is also exactly what
      // the user needs to know WHERE the edit lands.
      label: c.path,
      type: c.type === 'add' ? 'add' : c.type === 'remove' ? 'remove' : 'modify',
      before: clip(text(c.displayOld)),
      after: clip(text(c.displayNew)),
    }));
}

/**
 * Project the chat engine's state for the native chat sheet.
 *
 * A SUBSET, and the boundary is deliberate. Threads, messages, streaming and
 * sending are here. The model picker, reasoning effort, web search, context
 * chips and — most importantly — the AI's proposed CHANGES are not: applying a
 * change runs the diff engine and a review session, and putting a second,
 * partial version of that behind a native button is how a user accepts an edit
 * they never actually saw. Those stay in the web panel until they get the same
 * treatment the structure panel got.
 *
 * Pure — no DOM, no engine access.
 */
export function buildChatView({
  threads = [], currentThreadId = null, messages = [], loading = false,
  streamingMessage = null, configured = false, thinking = null,
  currentModel = '', models = [], reasoningEffort = 'medium', reasoningSupported = false,
} = {}) {
  const text = (v) => (typeof v === 'string' ? v : '');
  const visible = (Array.isArray(messages) ? messages : [])
    // `context` rows are chips the web panel renders inline; there is nothing
    // for a native bubble to show and an empty one reads as a failed reply.
    .filter((m) => m && m.role !== 'context')
    .map((m, i) => ({
      id: `${i}`,
      role: m.role === 'user' ? 'user' : m.role === 'error' ? 'error' : 'assistant',
      text: text(m.content),
      // The engine hands proposals to the web panel; say so rather than
      // silently dropping the part of the reply that matters.
      hasChanges: Array.isArray(m.pendingChanges) && m.pendingChanges.length > 0,
      // Raw reasoning summary. The native timeline splits and strips it — the
      // same job LiveReasoning.jsx does on the web — so it crosses unparsed.
      reasoning: text(m.reasoning),
    }))
    .filter((m) => m.text || m.hasChanges || m.reasoning);

  const streaming = text(streamingMessage?.content);
  const streamingReasoning = text(streamingMessage?.reasoning);
  if (streaming || streamingReasoning) {
    visible.push({
      id: 'streaming', role: 'assistant', text: streaming,
      hasChanges: false, reasoning: streamingReasoning,
    });
  }

  return {
    threads: (Array.isArray(threads) ? threads : []).map((t, i) => ({
      id: text(t?.id) || `${i}`,
      title: text(t?.title) || 'New chat',
      isCurrent: t?.id === currentThreadId,
    })),
    messages: visible,
    loading: !!loading,
    streaming: !!streaming,
    configured: !!configured,
    // The engine's live status line ('Thinking…', tool names). Null when idle.
    thinking: typeof thinking === 'string' ? thinking : '',
    currentModel: text(currentModel),
    // Flattened from the engine's grouped list: a native Menu renders sections
    // from a flat array with a group key more easily than nested arrays, and
    // the grouping is presentational either way.
    models: (Array.isArray(models) ? models : []).flatMap((g) =>
      (Array.isArray(g?.options) ? g.options : []).map((o) => ({
        id: text(o?.value), label: text(o?.label), group: text(g?.group),
      }))
    ).filter((m) => m.id),
    reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)
      ? reasoningEffort : 'medium',
    // Effort is meaningless on a model that does not reason; the picker hides
    // rather than offering a setting with no effect.
    reasoningSupported: !!reasoningSupported,
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

/**
 * Turn OFF WKWebView's own pinch zoom, so the app's zoom model is the only one.
 *
 * The two used to run side by side: the toolbar moved a CSS transform on
 * `.resume-container`, a pinch moved the webview's scroll view, and neither
 * knew about the other. The CSS transform wins because it is the one that
 * reaches below 100% — WebKit clamps `minimumZoomScale` to the fitted width and
 * re-derives it on every layout, so its own zoom cannot fit a whole page.
 *
 * Three belts, because two were not enough (measured — with only the viewport
 * meta and a disabled `pinchGestureRecognizer`, a pinch still scaled the page
 * and left the toolbar reading its old value):
 *
 *   1. `user-scalable=no` in the viewport, which WKWebView honours unless
 *      `ignoresViewportScaleLimits` is set.
 *   2. `preventDefault()` on WebKit's `gesturestart`/`gesturechange`/`gestureend`
 *      — the actual pinch-zoom hooks on iOS, and the only one of the three that
 *      a relayout cannot quietly undo.
 *   3. `scrollView.pinchGestureRecognizer.isEnabled = false` in OPShell.swift.
 *
 * With the page's own zoom out of the way, the native `MagnifyGesture` is the
 * only thing left that sees a pinch, and it drives `setZoom` here.
 */
function disablePageZoom() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta && !/user-scalable/.test(meta.getAttribute('content') || '')) {
    meta.setAttribute(
      'content',
      `${meta.getAttribute('content')}, maximum-scale=1.0, user-scalable=no`
    );
  }
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
}

let activated = false;
let streamDocument = false;
let streamChat = false;
let chatView = null;
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
    // Driven by the native pinch. Sent continuously during a gesture, so it
    // goes straight to the zoom model rather than through a button click.
    setZoom: ({ value }) => deps.setZoomLevel(Number(value)),
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

    // The structure panel. `setField` is the ONLY way the document is written
    // from Swift, and it routes to the same `store.update` the web editor uses
    // — same path grammar, same undo history, same re-render.
    setField: ({ path, value }) => {
      if (typeof path !== 'string' || !path) throw new Error('setField needs a path');
      deps.updateField(path, String(value ?? ''));
    },
    // Reordering. Swift sends the LIST's path and two indices — it never
    // builds an element path, so the grammar stays owned by the projection.
    moveItem: ({ path, from, to }) => {
      if (typeof path !== 'string' || !path) throw new Error('moveItem needs a list path');
      deps.moveListItem(path, Number(from), Number(to));
    },
    // Chat. Every one of these routes to the engine in useChat.js through the
    // React panel — none of them reimplements any of it.
    chatSend: ({ text }) => ask('rd:chat-send', { text: String(text ?? '') }),
    chatStop: () => ask('rd:chat-stop'),
    chatNewThread: () => ask('rd:chat-new-thread'),
    chatSelectThread: ({ id }) => ask('rd:chat-select-thread', { id }),
    chatSetModel: ({ id }) => ask('rd:chat-set-model', { id }),
    chatSetReasoning: ({ value }) => ask('rd:chat-set-reasoning', { value }),
    // Reviewing the AI's proposed edits. Each routes to the same session the
    // web review uses, so a change applied here goes through `applyChangeToStore`
    // with the same ordering rules — leaf paths are indexed against the proposed
    // array, and applying them out of order writes against the wrong element.
    applyChange: ({ path }) => deps.applyInlineChange(String(path)),
    rejectChange: ({ path }) => deps.rejectInlineChange(String(path)),
    applyAllChanges: () => deps.applyAllInlineChanges(),
    rejectAllChanges: () => deps.rejectAllInlineChanges(),
    setChatOpen: ({ value }) => {
      streamChat = value === 'true';
      // Ask the panel to re-push. Its first publish is normally LOST: React
      // mounts ChatPanel before main.js's init() has defined window.__opShell,
      // so the mount-time effect optional-chains into nothing, and the effect
      // does not run again until the engine's state changes — which, in a quiet
      // chat, is never. Without this the sheet opens permanently empty.
      if (streamChat) ask('rd:chat-publish');
      publish();
    },
    // The outline is only projected while the panel is open. It is by far the
    // largest thing on the wire, and the canvas re-renders on every keystroke,
    // so streaming it unconditionally would rebuild the whole document on each
    // character typed into a résumé nobody is looking at through the panel.
    setStructureOpen: ({ value }) => {
      streamDocument = value === 'true';
      publish();
    },

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
          document: streamDocument ? deps.getDocument() : null,
          chat: streamChat
            ? { ...chatView, pendingChanges: buildPendingChanges(deps.getPendingChanges()) }
            : null,
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
  // Edits made in the canvas have to reach an open panel, or the two views of
  // one document silently disagree.
  deps.subscribeDocument(() => { if (streamDocument) publish(); });
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
     * Called by ChatPanel whenever the chat engine's state changes.
     *
     * The engine lives in a React hook, so this module cannot read it — the
     * panel pushes instead. Stored either way, but only put on the wire while
     * the native sheet is open.
     */
    publishChat: (state) => {
      chatView = buildChatView(state);
      if (streamChat) publish();
    },
    /**
     * Called by Swift once the SwiftUI chrome is installed. Hides the web
     * chrome and starts publishing. Idempotent — Swift may retry if the page
     * had not finished booting on its first attempt.
     */
    activate: () => {
      if (activated) return true;
      activated = true;
      document.documentElement.classList.add(NATIVE_SHELL_CLASS);
      disablePageZoom();
      publish();
      return true;
    },
  };

  // Swift may win the race and call activate() before this module has run. It
  // leaves this flag behind when it does, so the handshake completes either way.
  if (window.__opShellPendingActivate) window.__opShell.activate();
}
