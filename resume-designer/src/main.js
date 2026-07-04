/**
 * Resume Designer - Main Application
 * Integrates all components: store, header bar, chat panel, inline editor, structure panel
 */

import { store } from './store.js';
import { appStorage, initAppStorage, markStorageReady } from './appStorage.js';
import {
  renderResume, 
  renderResumeStacked,
  renderResumeStackedVertical,
  renderResumeRightSidebar,
  renderResumeCompact,
  renderResumeExecutive,
  renderResumeClassic,
  renderResumeClassicFeatured,
  renderResumeModern,
  renderResumeTimeline,
  renderResumeCreative
} from './renderer.js';
import { initPdfExport } from './pdf.js';
import { paginate, resetPaginatedState } from './pagination.js';
import { normalizePageSize, DEFAULT_PAGE_WIDTH_IN } from './pageSetup.js';
import { initInlineEditor, refreshInlineEditor, getActiveInlineEditable } from './inlineEditor.js';
import { initVariants } from './variantManager.js';
import { refreshChatPanel, startProfileInterviewFromPanel } from './chatPanel.js';
import { initDiffView } from './diffView.js';
import { initInlineChanges } from './inlineChanges.js';
import { initSettingsModal, openSettings } from './settingsModal.js';
import { initZoomControls } from './zoomControls.js';
import { initWindowDrag } from './tauriDrag.js';
import {
  migrateBuiltInVariants,
  saveSettings,
  getSettings,
  SETTINGS_UPDATED_EVENT,
  getCurrentVariantId,
  getVariants,
  importFullBackupFromEnvelope,
} from './persistence.js';
import {
  isTauri,
  getPlatform,
  openExternal,
  startupUpdateCheck,
  onMenuOpenSettings,
  probeLegacyElectronData,
  importLegacyElectronData,
} from './native.js';
import { initTheme } from './theme.js';
import { openJobDescriptionPanel, onJobPanelVariantChange } from './jobDescriptionPanel.js';
import { initJobDescriptions } from './jobDescriptions.js';
import { openUserProfilePanel } from './userProfilePanel.js';
import { shouldShowOnboarding, showOnboardingWizard } from './onboarding.js';
import { initFontService } from './fontService.js';
import { initHeaderStyleService, applyHeaderStyle, getHeaderStyleSettings } from './headerStyleService.js';
import { initSpacingService, applySpacingSettings, getSpacingSettings, saveSpacingSettings } from './spacingService.js';
import { initAccentService } from './accentService.js';
import { initPhotoService } from './photoService.js';

// Built-in resume variants (for initial migration)
const BUILT_IN_VARIANTS = [
  { id: 'book-illustrator', name: 'Book Illustrator', file: 'BookIllustrator.md' },
  { id: 'brand-campaign', name: 'Brand / Campaign', file: 'Brand-CampaignIllustrator-CharacterDesigner.md' },
  { id: 'concept-artist', name: 'Concept Artist', file: 'ConceptArtist-ArtDirection.md' },
  { id: 'coordinator', name: 'Project Coordinator', file: 'CreativeProjectCoordinator.md' },
  { id: 'viz-dev', name: 'Visual Development', file: 'VizDev-2DAnim-CharacterAndBackgroundDesign.md' }
];

// Color palette definitions
const COLOR_PALETTES = {
  terracotta: {
    accent: '#c45c3e',
    accentLight: '#d97a5d',
    headerBg: '#2d2a26',
    headerBgEnd: '#3d3832',
    sidebarBg: '#f4e8e4'
  },
  rose: {
    accent: '#e11d48',
    accentLight: '#f43f5e',
    headerBg: '#4a1025',
    headerBgEnd: '#5a2035',
    sidebarBg: '#fce7f3'
  },
  amber: {
    accent: '#d97706',
    accentLight: '#f59e0b',
    headerBg: '#451a03',
    headerBgEnd: '#78350f',
    sidebarBg: '#fef3c7'
  },
  coral: {
    accent: '#f97316',
    accentLight: '#fb923c',
    headerBg: '#431407',
    headerBgEnd: '#7c2d12',
    sidebarBg: '#ffedd5'
  },
  ocean: {
    accent: '#2563eb',
    accentLight: '#3b82f6',
    headerBg: '#1e3a5f',
    headerBgEnd: '#2d4a6f',
    sidebarBg: '#e8f0fe'
  },
  teal: {
    accent: '#0d9488',
    accentLight: '#14b8a6',
    headerBg: '#134e4a',
    headerBgEnd: '#115e59',
    sidebarBg: '#ccfbf1'
  },
  forest: {
    accent: '#059669',
    accentLight: '#10b981',
    headerBg: '#1a3c34',
    headerBgEnd: '#2a4c44',
    sidebarBg: '#e6f4f0'
  },
  cyan: {
    accent: '#0891b2',
    accentLight: '#06b6d4',
    headerBg: '#164e63',
    headerBgEnd: '#155e75',
    sidebarBg: '#cffafe'
  },
  plum: {
    accent: '#7c3aed',
    accentLight: '#8b5cf6',
    headerBg: '#2d1f47',
    headerBgEnd: '#3d2f57',
    sidebarBg: '#f3e8ff'
  },
  indigo: {
    accent: '#4f46e5',
    accentLight: '#6366f1',
    headerBg: '#1e1b4b',
    headerBgEnd: '#312e81',
    sidebarBg: '#e0e7ff'
  },
  slate: {
    accent: '#64748b',
    accentLight: '#94a3b8',
    headerBg: '#1e293b',
    headerBgEnd: '#334155',
    sidebarBg: '#f1f5f9'
  },
  zinc: {
    accent: '#52525b',
    accentLight: '#71717a',
    headerBg: '#18181b',
    headerBgEnd: '#27272a',
    sidebarBg: '#f4f4f5'
  }
};

let currentPalette = 'terracotta';
let currentLayout = 'sidebar';
let customColor = '#c45c3e';

// appStorage flag set by `maybeAutoMigrateLegacyData` to remember
// whether we've already tried (regardless of outcome). Lives outside
// the `resume-designer-*` backup-owned keyspace so it's NOT wiped when
// the user runs Import Backup — that way reimporting a legacy backup
// doesn't accidentally retrigger auto-migration on the next launch.
const ELECTRON_MIGRATION_FLAG = 'resume-designer-electron-migration-attempted';

/**
 * Auto-import legacy Electron `localStorage` (LevelDB on disk) on the
 * first Tauri boot after upgrading from Electron. Strict guards:
 *
 *   1. Only runs in Tauri (web has no backend command to probe).
 *   2. Only runs ONCE — sets `ELECTRON_MIGRATION_FLAG` regardless of
 *      outcome (found / not-found / error).
 *   3. Only runs when the current store (appStorage) has no
 *      `resume-designer-data` — so a user who's already created
 *      content in the new build won't have it overwritten.
 *
 * Failures are swallowed (logged to console only) so a corrupt LevelDB
 * or permission error can never block boot. The user can still get
 * their data via Tools → Import Backup if they have a JSON elsewhere.
 *
 * MUST run before `getSettings()` / store init below, otherwise those
 * read an empty store and the just-imported data won't be picked
 * up until the next launch.
 */
async function maybeAutoMigrateLegacyData() {
  if (!isTauri) return;
  if (appStorage.getItem(ELECTRON_MIGRATION_FLAG)) return;
  if (appStorage.getItem('resume-designer-data')) {
    // User already has Tauri-side data; don't touch it. Set the flag
    // so we stop probing on every launch from here on out.
    appStorage.setItem(ELECTRON_MIGRATION_FLAG, 'skipped-has-data');
    return;
  }

  try {
    const probe = await probeLegacyElectronData();
    if (!probe?.found) {
      appStorage.setItem(ELECTRON_MIGRATION_FLAG, 'skipped-no-legacy');
      return;
    }
    console.log('[migration] Legacy Electron data found:', probe);

    const envelope = await importLegacyElectronData();
    const result = importFullBackupFromEnvelope(envelope);
    appStorage.setItem(ELECTRON_MIGRATION_FLAG, 'imported');
    console.log(
      `[migration] Imported ${result.keysImported} keys from legacy Electron data` +
      ` (removed ${result.removedExistingKeys} pre-existing keys` +
      (result.historySkipped > 0
        ? `; skipped ${result.historySkipped} oversize history entries`
        : '') +
      `).`
    );
    // Defer the toast slightly so it shows AFTER the UI mounts —
    // otherwise the toast element gets clobbered by re-renders.
    // Pass `result` so the toast can mention any quota-skipped
    // history (the Tools-menu callers surface this in their alerts;
    // the silent boot path needs to surface it too — otherwise the
    // user has no way of knowing some history was dropped).
    setTimeout(() => showMigrationToast(probe, result), 800);
  } catch (err) {
    console.warn('[migration] Auto-import failed; continuing with empty store:', err);
    appStorage.setItem(ELECTRON_MIGRATION_FLAG, 'failed');
    // Silent fail — user can still use Tools → Import Backup manually
    // if they have a JSON backup from elsewhere.
  }
}

/**
 * Non-blocking "your data was imported" toast. Reuses the existing
 * `.update-status-toast` class so it inherits styling, dark-mode
 * support, and the print-mode hide rule.
 *
 * `result` is optional; when present and `result.historySkipped > 0`,
 * the toast appends a second sentence noting how many undo/redo
 * history entries were dropped because they hit the localStorage
 * quota. Keeping the user informed matters here because the silent
 * auto-migration path has no other surface to report the skip — and
 * a "history is now missing" surprise weeks later is worse UX than a
 * 10-second toast at boot.
 */
function showMigrationToast(probe, result = null) {
  const variantWord = probe.variantCount === 1 ? 'resume' : 'resumes';
  const jdWord = probe.jobDescriptionCount === 1 ? 'job description' : 'job descriptions';
  let message =
    `Imported ${probe.variantCount} ${variantWord} and ` +
    `${probe.jobDescriptionCount} ${jdWord} from your previous version.`;
  if (result?.historySkipped > 0) {
    const n = result.historySkipped;
    message +=
      ` (${n} oversize undo/redo history ${n === 1 ? 'entry was' : 'entries were'} ` +
      `skipped due to browser storage limits.)`;
  }

  let toast = document.getElementById('migration-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'migration-toast';
    toast.className = 'update-status-toast tone-success';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  // Force a re-add of `show` even if the element already had it, so the
  // transition replays for visibility.
  toast.classList.remove('show');
  // Reading offsetWidth flushes the style change before re-adding the
  // class — otherwise the browser may coalesce both into a single tick
  // and skip the transition.
  void toast.offsetWidth;
  toast.classList.add('show');
  // 8 seconds: long enough to read a one-line message, short enough to
  // not feel like it's stuck.
  setTimeout(() => toast.classList.remove('show'), 8000);
}

// Initialize the application
export async function init() {
  // FIRST: bring up the storage facade, THEN pull in any legacy Electron
  // data — and only after BOTH settle, open the React mount gate. On the
  // first Tauri boot after an Electron install the facade comes up empty and
  // maybeAutoMigrateLegacyData() is what populates it; a component mounted in
  // between (ChatPanel was the proven case) snapshots the emptiness and its
  // next save overwrites the migrated data. The finally keeps the gate
  // deadlock-proof: both steps swallow their own failures internally, and
  // even an unexpected throw still opens the gate on whatever state we have.
  //
  // (Print-mode is a separate framework-free entry — print.html /
  // src/printEntry.js — so the main window never short-circuits here.)
  try {
    await initAppStorage();
    await maybeAutoMigrateLegacyData();
  } finally {
    markStorageReady();
  }

  // Seed the job-descriptions module cache from the now-initialized store,
  // regardless of when JobsDialog mounts. The dialog's own mount effect calls
  // this again — that second call is a harmless re-read of the same store.
  initJobDescriptions();

  // Tag the html element so CSS can apply desktop-only chrome (traffic light
  // padding on macOS, etc.). Keep the legacy `electron` / `electron-mac`
  // classes for one transition release alongside the new `desktop` / `desktop-mac`
  // ones, so existing CSS keeps working unchanged.
  if (isTauri) {
    document.documentElement.classList.add('desktop', 'electron');
    const platform = await getPlatform();
    if (platform === 'darwin') {
      document.documentElement.classList.add('desktop-mac', 'electron-mac');
    }

    // Intercept external links so they open in the system browser rather
    // than navigating the Tauri webview. Replaces Electron's
    // setWindowOpenHandler/shell.openExternal pattern.
    document.addEventListener(
      'click',
      (e) => {
        const anchor = e.target.closest?.('a[href]');
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        if (!href) return;
        if (href.startsWith('#') || href.startsWith('/') || href.startsWith('?')) return;
        if (anchor.target === '_blank' || /^https?:\/\//i.test(href)) {
          e.preventDefault();
          openExternal(href).catch((err) =>
            console.warn('[Link] open failed:', err)
          );
        }
      },
      true
    );

    // Flush pending disk writes when the window is closing or backgrounded.
    // The write-behind queue otherwise drains within ~1 tick, but "quit
    // immediately after an edit" must never lose the last write.
    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const win = getCurrentWebviewWindow();
      await win.onCloseRequested(async (event) => {
        // preventDefault() the close, drain the last edit to disk, THEN close
        // explicitly. The onCloseRequested wrapper already awaits this handler
        // before its own destroy(), and Tauri defers the native close until the
        // handler resolves — so the flush completes before the window goes
        // regardless. Doing it via preventDefault()+destroy() is the documented
        // Tauri contract, so the "flush before close" ordering no longer relies
        // on that wrapper internal. destroy() forces the close WITHOUT
        // re-emitting close-requested, so there is no re-entrancy. The flush is
        // best-effort: on a full disk we still close (trapping the user in an
        // un-quittable window is worse, and the failure toast already fired).
        event.preventDefault();
        try { store.saveNow(); } catch { /* nothing pending */ }
        try { await appStorage.flush(); } catch (flushErr) { console.warn('[Storage] close-flush failed:', flushErr); }
        await win.destroy();
      });
    } catch (e) {
      console.warn('[Storage] close-flush hook unavailable:', e);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      // Capture a mid-debounce edit too — backgrounding (Cmd+H, minimize) is
      // often the last event before an OS-level quit, which bypasses
      // onCloseRequested entirely.
      try { store.saveNow(); } catch { /* nothing pending */ }
      appStorage.flush();
    });

    // Make the header bar act as the window's drag region (overlay titlebar).
    // Uses the manual startDragging() handler instead of data-tauri-drag-region,
    // which is unreliable in Tauri v2 (#9901). Fire-and-forget: it resolves the
    // window asynchronously, then attaches a synchronous mousedown handler.
    initWindowDrag(document.getElementById('header-bar'));
  }
  
  // Load saved settings
  const settings = getSettings();
  currentPalette = settings.colorPalette || 'terracotta';
  currentLayout = settings.layout || 'sidebar';
  customColor = settings.customColor || '#c45c3e';
  
  // Migrate built-in variants to storage on first run
  await migrateBuiltInVariants(BUILT_IN_VARIANTS);
  
  // Initialize theme manager (before header for proper icons)
  initTheme();
  
  // Initialize font service (load saved fonts)
  await initFontService();
  
  // Initialize spacing service
  initSpacingService();
  
  // Initialize accent service
  initAccentService();
  
  // Initialize photo service
  initPhotoService();
  
  // Initialize variant management. The header VIEW is now a React component
  // (src/components/Header.jsx) that subscribes to this module; main.js only
  // wires the variant-change callback (re-render + job-panel re-sync). Register
  // the updater->toast bridge here too, BEFORE startupUpdateCheck() below, so it
  // catches startup status events. The bridge is loaded lazily because
  // updateFlow.js statically imports sonner (which pulls React) and main.js is
  // shared with the React-free print entry (printEntry.js -> initPrintMode);
  // a static import here would drag react/sonner into the print window's
  // static chunk graph. init() only runs in the main window.
  initVariants(handleVariantChange);
  const { initUpdateFlow } = await import('./updateFlow.js');
  initUpdateFlow();

  // Initialize inline editor
  initInlineEditor();
  
  // The structure panel is now a React component (src/components/structure/
  // StructurePanel.jsx): it edits the resume directly through the store (the
  // resume re-renders via the store subscription set up below) and dispatches
  // rd:design-change for the palette/layout/custom-color changes main.js owns.
  window.addEventListener('rd:design-change', (e) => handleDesignChange(e.detail));

  // Initialize PDF export
  initPdfExport();
  
  // Chat panel is now React (components/chat/ChatPanel.jsx). main.js still owns
  // the diff/inline-change hosts it drives and wires them with the resume
  // re-render callback (both apply through the store, which re-renders anyway).
  initDiffView(handleChatApply);
  initInlineChanges();
  
  // Initialize zoom controls
  initZoomControls();
  
  // Job descriptions panel is now React (components/jobs/JobsDialog.jsx), opened
  // via window.openJobDescriptionPanel below (dispatches rd:open-jobs).
  
  // Version history is now a React component (src/components/HistoryDialog.jsx)
  // that opens on the rd:open-history event (see window.openHistoryPanel below).

  // User profile editor is now React (components/profile/ProfileDialog.jsx),
  // opened via window.openUserProfilePanel below (dispatches rd:open-profile).
  
  // Expose panel openers and wizards globally
  window.openJobDescriptionPanel = openJobDescriptionPanel;
  // History is React (HistoryDialog) — open it via its window event.
  window.openHistoryPanel = () => window.dispatchEvent(new CustomEvent('rd:open-history'));
  window.openUserProfilePanel = openUserProfilePanel;
  window.showOnboardingWizard = showOnboardingWizard;
  window.startProfileInterviewFromChat = startProfileInterviewFromPanel;
  
  // Initialize undo/redo
  initUndoRedo();

  // Initialize shared text formatting tools in bottom toolbar
  initTextTools();
  
  // Check for first-time user onboarding
  console.log('[Main] Setting up onboarding check...');
  
  // In desktop builds, expose a function to reset onboarding for debugging.
  if (isTauri) {
    window.resetForTesting = () => {
      appStorage.clear();
      appStorage.flush().finally(() => {
        localStorage.clear();
        location.reload();
      });
    };
    console.log('[Main] Desktop build detected, resetForTesting() available');
  }

  // Kick off the auto-update check (no-op in dev / web). Fire-and-forget;
  // catch any rejection so it doesn't surface as UnhandledPromiseRejection.
  startupUpdateCheck().catch((err) =>
    console.warn('[Update] startup check failed:', err)
  );

  // After an update lands, show that release's notes once (compares the running
  // version against the last one seen). Fire-and-forget; lazy import so the
  // React dialog host it pulls in stays out of the print window's static graph.
  import('./changelogService.js')
    .then(({ maybeShowPostUpdateChangelog }) => maybeShowPostUpdateChangelog())
    .catch((err) => console.warn('[Changelog] post-update check failed:', err));

  // Check onboarding after a short delay to ensure UI is ready
  console.log('[Main] Scheduling onboarding check in 300ms...');
  setTimeout(() => {
    console.log('[Main] Running onboarding check NOW');
    try {
      const shouldShow = shouldShowOnboarding();
      console.log('[Main] shouldShowOnboarding returned:', shouldShow);
      if (shouldShow) {
        console.log('[Main] Calling showOnboardingWizard()...');
        showOnboardingWizard();
      }
    } catch (e) {
      console.error('[Main] Error checking onboarding:', e);
      // Force show wizard on error in fresh installs
      console.log('[Main] Forcing wizard due to error');
      showOnboardingWizard();
    }
  }, 300);
  
  // Initialize settings modal
  initSettingsModal();

  // macOS app-menu "Settings…" opens the same Settings dialog as the header gear.
  onMenuOpenSettings(() => openSettings()).catch(() => {});

  // Keep chat availability in sync when settings change. Settings is now a React
  // dialog (SettingsDialog.jsx) that reads settings reactively, so the old
  // #settings-modal refresh is gone.
  window.addEventListener(SETTINGS_UPDATED_EVENT, () => {
    refreshChatPanel();
  });
  
  // Subscribe to store changes for re-rendering
  store.subscribe((event, _payload) => {
    if (event === 'change' || event === 'fieldUpdated' || event === 'dataLoaded') {
      renderCurrentResume();
    }
  });
  
  // Listen for resume-ready event from onboarding
  window.addEventListener('resume-ready', () => {
    console.log('[Main] Resume ready event received, rendering...');
    renderCurrentResume();
  });
  
  // Apply initial design settings
  applyColorPalette(currentPalette);

  // Render initial resume
  renderCurrentResume();

  // Pagination measures block heights; on a cold start the first render can run
  // before the résumé's webfonts finish loading, so it splits pages against
  // fallback metrics and the live view stays mis-paginated until the next
  // re-render. Re-paginate once the real fonts are ready so the on-screen sheets
  // match the exported PDF (the print window already does this).
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      // Don't blow away an in-progress inline edit: if the user started editing
      // before the webfonts resolved, re-rendering would replace their active
      // contentEditable node with stored data and lose the unsaved text. The brief
      // mis-pagination is cosmetic and heals on the next render.
      if (!getActiveInlineEditable()) renderCurrentResume();
    });
  }

  // Defense in depth: boot is fully done — re-broadcast the chat config state
  // once so any chat UI that somehow captured pre-init storage state (in an
  // unforeseen mount order) re-reads and heals. Harmless no-op otherwise.
  refreshChatPanel();
}

/**
 * Print-mode init for the hidden child window pdf.js spawns at `/print.html`.
 *
 * Runs ONLY the minimum needed to render the active variant's resume:
 * design services (fonts/spacing/accent/photo/headerStyle) and the renderer
 * itself, with no chat panel / structure panel / undo-redo / onboarding /
 * autoupdate. Applies `html.pdf-export-mode` so the resume sits at the
 * document origin with no surrounding chrome (the chrome elements are still
 * in the DOM from index.html but get `display: none`).
 *
 * When layout is settled and fonts are ready, emits a global Tauri event
 * `print-ready` carrying the resume's measured bounds. pdf.js (running in
 * the main window) listens for this, then invokes the Rust capture command.
 *
 * On any failure, emits `print-error` so the main window can surface a
 * meaningful error instead of timing out.
 */
export async function initPrintMode() {
  // Resolve this print window's own label so every event we emit can be
  // tagged with it. Each PDF export uses a unique label (e.g.
  // `pdf-print-1716234567890`); the main window's listener uses that label
  // to filter — otherwise two overlapping exports could cross-resolve and
  // capture the wrong window's `print-ready`.
  let printLabel = '';
  try {
    const winMod = await import('@tauri-apps/api/window');
    printLabel = winMod.getCurrentWindow().label;
  } catch (e) {
    console.warn('[PrintMode] could not resolve own window label:', e);
  }

  // Step emitter: lets the main-window pdf.js see exactly where we are in
  // the print-mode boot sequence. Each step is a global Tauri event the
  // main window listens for and console.logs. Critical for debugging when
  // print-ready never fires — pinpoints the hanging step instead of timing
  // out blindly.
  let emit;
  const step = async (name, extra = {}) => {
    try {
      if (!emit) {
        const mod = await import('@tauri-apps/api/event');
        emit = mod.emit;
      }
      await emit('print-step', { label: printLabel, step: name, ...extra });
    } catch (e) {
      console.warn('[PrintMode] step emit failed:', name, e);
    }
  };

  try {
    await step('started');
    document.documentElement.classList.add('pdf-export-mode');
    await step('class-applied');

    // Load saved palette/layout settings.
    const settings = getSettings();
    currentPalette = settings.colorPalette || 'terracotta';
    currentLayout = settings.layout || 'sidebar';
    customColor = settings.customColor || '#c45c3e';
    await step('settings-loaded', { palette: currentPalette, layout: currentLayout });

    // Init only the services that affect resume rendering. No chat, no
    // header bar, no structure panel, no undo/redo, no onboarding — those
    // would mount UI we don't need and might fire network calls.
    initTheme();
    await initFontService();
    initSpacingService();
    initAccentService();
    initPhotoService();
    initHeaderStyleService();
    await step('services-inited');

    // Load the currently active variant's data into the store so the
    // renderer can read it. skipSave=true because this is a read-only
    // render — we don't want to mutate stored data from the print window.
    const variantId = getCurrentVariantId();
    const variants = getVariants();
    const variant = variantId ? variants[variantId] : null;
    if (variant?.data) {
      store.setData(variant.data, true, variantId);
    }
    await step('data-loaded', { variantId, hasData: !!variant?.data });

    // Render the resume into #resume (defined in index.html).
    renderCurrentResume();
    await step('rendered');

    // Wait for fonts and layout to settle — same logic pdf.js used to do
    // around its capture, now living here in the print window.
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
    await step('fonts-ready');

    // Re-render now that the real fonts are loaded. Pagination measures block
    // heights to assign content to sheets; the first pass ran with fallback
    // font metrics (this is a fresh webview), which mis-assigns and clips
    // content. The second pass paginates against the true metrics.
    renderCurrentResume();
    await step('repaginated');

    const resumeEl = document.getElementById('resume');
    if (!resumeEl) {
      throw new Error('Print window: #resume not found after renderCurrentResume');
    }
    // Force synchronous layout. `offsetHeight` triggers a reflow so
    // getBoundingClientRect() below sees up-to-date geometry. We deliberately
    // DON'T use requestAnimationFrame here: this window lives off-screen
    // (x=-10000, y=-10000) and macOS does not run the compositor for
    // windows positioned outside any display, so rAF callbacks never fire.
    // A small setTimeout is enough — fonts.ready has already resolved above,
    // so there's nothing async left to wait on; the 50ms is just a safety
    // margin for any pending microtask work.
    void resumeEl.offsetHeight;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await step('layout-settled');

    const bounds = resumeEl.getBoundingClientRect();
    // Per-sheet rects (doc-relative to #resume, CSS px) so the macOS capture can
    // emit ONE PDF page per on-screen .resume-page. Continuous = a single sheet.
    const pages = Array.from(resumeEl.querySelectorAll('.resume-page')).map((p) => {
      const r = p.getBoundingClientRect();
      return {
        x: r.left - bounds.left,
        y: r.top - bounds.top,
        width: r.width,
        height: r.height,
      };
    });
    await step('measured', { width: bounds.width, height: bounds.height, sheets: pages.length });

    // Emit print-ready globally. Main window's pdf.js is the listener; it
    // filters on `label` so overlapping exports don't cross-resolve.
    await emit('print-ready', {
      label: printLabel,
      width: bounds.width,
      height: bounds.height,
      pages,
    });
  } catch (err) {
    console.error('[PrintMode] init failed:', err);
    await step('error', { error: err?.message ?? String(err) });
    try {
      if (!emit) {
        const mod = await import('@tauri-apps/api/event');
        emit = mod.emit;
      }
      await emit('print-error', {
        label: printLabel,
        error: err?.message ?? String(err),
      });
    } catch (_) { /* swallow */ }
  }
}

// Handle variant change from header bar
function handleVariantChange(_variant) {
  renderCurrentResume();
  // Update job description panel analysis for new variant
  onJobPanelVariantChange();
}

// Handle chat panel apply actions
function handleChatApply() {
  renderCurrentResume();
}

// Handle design changes from structure panel
function handleDesignChange(change) {
  switch (change.type) {
    case 'palette':
      currentPalette = change.value;
      customColor = change.customColor || customColor;
      applyColorPalette(change.value);
      saveSettings({ colorPalette: change.value, customColor });
      break;
    
    case 'headerStyle':
      // Header style is handled by structurePanel and saved automatically
      // Just need to re-render if necessary
      break;
    
    case 'font':
      // Font settings are handled by structurePanel and saved automatically
      break;
    
    case 'spacing':
      // Spacing (font scale, line height, section spacing, margins) and font
      // changes alter the rendered height. With a fixed page size the already-
      // split .resume-page sheets go stale — content clips under their
      // overflow:hidden — so re-render to re-paginate. Continuous has no sheets
      // to re-split.
      if (getPageSetup().pageSize !== 'continuous') renderCurrentResume();
      break;
    
    case 'accent':
      // Accent settings are handled by structurePanel and saved automatically
      break;
    
    case 'photo':
      // Photo settings are handled by structurePanel and saved automatically
      break;
      
    case 'layout':
      currentLayout = change.value;
      saveSettings({ layout: change.value });
      renderCurrentResume();
      break;

    case 'pageSize':
      saveSettings({ pageSize: change.value });
      renderCurrentResume();
      break;

    case 'orientation':
      saveSettings({ orientation: change.value });
      renderCurrentResume();
      break;

    case 'pageWidthIn':
      saveSettings({ pageWidthIn: change.value });
      renderCurrentResume();
      break;

    case 'customColor':
      customColor = change.value;
      applyCustomPalette(change.value);
      saveSettings({ customColor: change.value });
      break;
  }
}

// Apply color palette to resume
function applyColorPalette(paletteName) {
  if (paletteName === 'custom') {
    applyCustomPalette(customColor);
    return;
  }
  
  const palette = COLOR_PALETTES[paletteName];
  if (!palette) return;
  
  applyPaletteColors(palette);
}

// Apply custom palette
function applyCustomPalette(color) {
  const palette = generatePaletteFromColor(color);
  applyPaletteColors(palette);
}

// Apply palette colors to resume element
function applyPaletteColors(palette) {
  const resume = document.getElementById('resume');
  if (!resume) return;
  
  resume.style.setProperty('--resume-accent', palette.accent);
  resume.style.setProperty('--resume-accent-light', palette.accentLight);
  resume.style.setProperty('--header-bg', palette.headerBg);
  resume.style.setProperty('--header-bg-end', palette.headerBgEnd);
  resume.style.setProperty('--sidebar-bg', palette.sidebarBg);
  
  // Also apply header style with new colors
  const headerStyle = getHeaderStyleSettings();
  applyHeaderStyle(headerStyle, {
    headerBg: palette.headerBg,
    headerBgEnd: palette.headerBgEnd,
    accent: palette.accent
  });
}

// Generate a full palette from a single accent color
function generatePaletteFromColor(hexColor) {
  const hsl = hexToHSL(hexColor);
  
  // Generate accent light (slightly lighter and more saturated)
  const accentLightHSL = {
    h: hsl.h,
    s: Math.min(hsl.s + 10, 100),
    l: Math.min(hsl.l + 15, 85)
  };
  
  // Generate header background (dark, desaturated version)
  const headerBgHSL = {
    h: hsl.h,
    s: Math.max(hsl.s - 20, 10),
    l: 15
  };
  
  // Generate header background end (slightly lighter)
  const headerBgEndHSL = {
    h: hsl.h,
    s: Math.max(hsl.s - 15, 15),
    l: 22
  };
  
  // Generate sidebar background (very light tint)
  const sidebarBgHSL = {
    h: hsl.h,
    s: Math.min(hsl.s * 0.4, 30),
    l: 95
  };
  
  return {
    accent: hexColor,
    accentLight: hslToHex(accentLightHSL),
    headerBg: hslToHex(headerBgHSL),
    headerBgEnd: hslToHex(headerBgEndHSL),
    sidebarBg: hslToHex(sidebarBgHSL)
  };
}

// Convert hex to HSL
function hexToHSL(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  
  return { h: h * 360, s: s * 100, l: l * 100 };
}

// Convert HSL to hex
function hslToHex({ h, s, l }) {
  s /= 100;
  l /= 100;
  
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  
  let r, g, b;
  
  if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
  else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
  else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
  else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
  else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  
  r = Math.round((r + m) * 255).toString(16).padStart(2, '0');
  g = Math.round((g + m) * 255).toString(16).padStart(2, '0');
  b = Math.round((b + m) * 255).toString(16).padStart(2, '0');
  
  return `#${r}${g}${b}`;
}

// Initialize undo/redo functionality
function initUndoRedo() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  
  // Update button states
  function updateButtons() {
    if (undoBtn) {
      undoBtn.disabled = !store.canUndo();
      undoBtn.classList.toggle('disabled', !store.canUndo());
    }
    if (redoBtn) {
      redoBtn.disabled = !store.canRedo();
      redoBtn.classList.toggle('disabled', !store.canRedo());
    }
  }
  
  // Subscribe to history changes
  store.subscribe((event) => {
    if (event === 'historyChanged' || event === 'dataLoaded') {
      updateButtons();
    }
  });
  
  // Button click handlers
  undoBtn?.addEventListener('click', () => {
    store.undo();
  });
  
  redoBtn?.addEventListener('click', () => {
    store.redo();
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Don't trigger if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }
    
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    
    if (modKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      store.undo();
    } else if (modKey && e.key === 'z' && e.shiftKey) {
      // Mac style redo: Cmd+Shift+Z
      e.preventDefault();
      store.redo();
    } else if (modKey && e.key === 'y') {
      // Windows style redo: Ctrl+Y
      e.preventDefault();
      store.redo();
    }
  });
  
  // Initial state
  updateButtons();
}

let lastFormattingTarget = null;

function isTextInputElement(element) {
  return !!element && (
    element.tagName === 'TEXTAREA' ||
    (element.tagName === 'INPUT' && (element.type === 'text' || element.type === 'search' || element.type === 'url' || element.type === 'email'))
  );
}

function isEditableFormattingTarget(element) {
  return isTextInputElement(element) || !!element?.isContentEditable;
}

function getSelectionOffsetsInEditable(editable) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const length = editable.textContent?.length || 0;
    return { start: length, end: length };
  }

  const range = selection.getRangeAt(0);
  if (!editable.contains(range.commonAncestorContainer)) {
    const length = editable.textContent?.length || 0;
    return { start: length, end: length };
  }

  const beforeStart = document.createRange();
  beforeStart.selectNodeContents(editable);
  beforeStart.setEnd(range.startContainer, range.startOffset);

  const beforeEnd = document.createRange();
  beforeEnd.selectNodeContents(editable);
  beforeEnd.setEnd(range.endContainer, range.endOffset);

  return {
    start: beforeStart.toString().length,
    end: beforeEnd.toString().length
  };
}

function setSelectionInEditable(editable, start, end) {
  const selection = window.getSelection();
  if (!selection) return;

  const textNode = editable.firstChild || editable.appendChild(document.createTextNode(''));
  const maxLen = textNode.textContent?.length || 0;
  const safeStart = Math.max(0, Math.min(start, maxLen));
  const safeEnd = Math.max(0, Math.min(end, maxLen));

  const range = document.createRange();
  range.setStart(textNode, safeStart);
  range.setEnd(textNode, safeEnd);
  selection.removeAllRanges();
  selection.addRange(range);
}

function toggleWrappedRange(value, start, end, marker) {
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  const selected = value.slice(selectionStart, selectionEnd);
  const markerLength = marker.length;

  if (selectionStart === selectionEnd) {
    const hasOuterMarker = selectionStart >= markerLength &&
      value.slice(selectionStart - markerLength, selectionStart) === marker &&
      value.slice(selectionStart, selectionStart + markerLength) === marker;

    if (hasOuterMarker) {
      const nextValue = value.slice(0, selectionStart - markerLength) + value.slice(selectionStart + markerLength);
      const cursor = selectionStart - markerLength;
      return { value: nextValue, start: cursor, end: cursor };
    }

    const insertion = `${marker}${marker}`;
    const nextValue = value.slice(0, selectionStart) + insertion + value.slice(selectionStart);
    const cursor = selectionStart + markerLength;
    return { value: nextValue, start: cursor, end: cursor };
  }

  if (
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length >= markerLength * 2
  ) {
    const unwrapped = selected.slice(markerLength, -markerLength);
    const nextValue = value.slice(0, selectionStart) + unwrapped + value.slice(selectionEnd);
    return { value: nextValue, start: selectionStart, end: selectionStart + unwrapped.length };
  }

  const hasOuterMarker = selectionStart >= markerLength &&
    value.slice(selectionStart - markerLength, selectionStart) === marker &&
    value.slice(selectionEnd, selectionEnd + markerLength) === marker;

  if (hasOuterMarker) {
    const nextValue = value.slice(0, selectionStart - markerLength) + selected + value.slice(selectionEnd + markerLength);
    return {
      value: nextValue,
      start: selectionStart - markerLength,
      end: selectionEnd - markerLength
    };
  }

  const nextValue = value.slice(0, selectionStart) + `${marker}${selected}${marker}` + value.slice(selectionEnd);
  return {
    value: nextValue,
    start: selectionStart + markerLength,
    end: selectionEnd + markerLength
  };
}

function toggleBulletedLines(value, start, end) {
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);

  const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  const endMarker = value.indexOf('\n', selectionEnd);
  const lineEnd = endMarker === -1 ? value.length : endMarker;

  const segment = value.slice(lineStart, lineEnd);
  const lines = segment.split('\n');
  const hasContent = lines.some(line => line.trim().length > 0);
  if (!hasContent) {
    return { value, start: selectionStart, end: selectionEnd };
  }

  const allBulleted = lines
    .filter(line => line.trim().length > 0)
    .every(line => /^\s*[-*•]\s+/.test(line));

  const nextLines = lines.map((line) => {
    if (!line.trim()) return line;
    if (allBulleted) {
      return line.replace(/^(\s*)[-*•]\s+/, '$1');
    }
    return line.replace(/^(\s*)/, '$1- ');
  });

  const nextSegment = nextLines.join('\n');
  const nextValue = value.slice(0, lineStart) + nextSegment + value.slice(lineEnd);
  return { value: nextValue, start: lineStart, end: lineStart + nextSegment.length };
}

function clearInlineFormatting(value, start, end) {
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  const hasSelection = selectionStart !== selectionEnd;

  const source = hasSelection
    ? value.slice(selectionStart, selectionEnd)
    : value;

  const cleared = source
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\+\+([^+\n]+)\+\+/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1');

  if (!hasSelection) {
    return { value: cleared, start: selectionStart, end: selectionEnd };
  }

  const nextValue = value.slice(0, selectionStart) + cleared + value.slice(selectionEnd);
  return { value: nextValue, start: selectionStart, end: selectionStart + cleared.length };
}

function applyTextCommand(command) {
  const active = document.activeElement;
  const inlineActive = getActiveInlineEditable();

  let target = isEditableFormattingTarget(active) ? active : null;
  if (!target && inlineActive) {
    target = inlineActive;
    if (!inlineActive.isContentEditable) {
      inlineActive.click();
      target = inlineActive.isContentEditable ? inlineActive : null;
    }
  }
  if (!target && lastFormattingTarget && document.contains(lastFormattingTarget)) {
    target = lastFormattingTarget;
  }
  if (!target) return;

  if (isTextInputElement(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    let result = null;

    if (command === 'bold') result = toggleWrappedRange(target.value || '', start, end, '**');
    if (command === 'italic') result = toggleWrappedRange(target.value || '', start, end, '_');
    if (command === 'underline') result = toggleWrappedRange(target.value || '', start, end, '++');
    if (command === 'bullets') result = toggleBulletedLines(target.value || '', start, end);
    if (command === 'clear') result = clearInlineFormatting(target.value || '', start, end);
    if (!result) return;

    // Write through the prototype's native value setter, not `target.value =`.
    // React installs a value-tracker on any input it gives an onChange handler
    // (e.g. the structure panel's summary textarea); a direct assignment updates
    // that tracker, so the dispatched input event is deduped and onChange never
    // fires — the format markers would land in the DOM but never reach the store.
    // The native setter leaves the tracker stale, so React sees a real change.
    // For plain vanilla inputs this behaves exactly like `target.value =`.
    const valueSetter = Object.getOwnPropertyDescriptor(
      target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )?.set;
    if (valueSetter) valueSetter.call(target, result.value);
    else target.value = result.value;
    target.focus();
    target.setSelectionRange(result.start, result.end);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  if (!target.isContentEditable) return;

  const value = target.textContent || '';
  const offsets = getSelectionOffsetsInEditable(target);
  let result = null;

  if (command === 'bold') result = toggleWrappedRange(value, offsets.start, offsets.end, '**');
  if (command === 'italic') result = toggleWrappedRange(value, offsets.start, offsets.end, '_');
  if (command === 'underline') result = toggleWrappedRange(value, offsets.start, offsets.end, '++');
  if (command === 'bullets') result = toggleBulletedLines(value, offsets.start, offsets.end);
  if (command === 'clear') result = clearInlineFormatting(value, offsets.start, offsets.end);
  if (!result) return;

  target.textContent = result.value;
  target.focus();
  setSelectionInEditable(target, result.start, result.end);
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

function adjustGlobalFontScale(delta) {
  const spacing = getSpacingSettings();
  const next = Math.max(0.75, Math.min(1.35, (spacing.fontScale || 1) + delta));
  spacing.fontScale = Math.round(next * 100) / 100;
  saveSpacingSettings(spacing);
  applySpacingSettings(spacing);
  // The toolbar +/- changes font scale exactly like the Design-tab control, so it
  // must re-paginate too: with a fixed page size the already-split .resume-page
  // sheets go stale and clip the resized content under overflow:hidden. Mirrors the
  // rd:design-change 'spacing' handler; continuous mode has no sheets to re-split.
  if (getPageSetup().pageSize !== 'continuous') renderCurrentResume();
  updateTextToolbarState();
}

function updateTextToolbarState() {
  const target = isEditableFormattingTarget(document.activeElement)
    ? document.activeElement
    : getActiveInlineEditable();
  const hasTarget = !!target;

  ['text-bold', 'text-italic', 'text-underline', 'text-bullets', 'text-clear-format'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', hasTarget);
  });

  const textSizeLevel = document.getElementById('text-size-level');
  if (textSizeLevel) {
    const spacing = getSpacingSettings();
    textSizeLevel.textContent = `${Math.round((spacing.fontScale || 1) * 100)}%`;
  }
}

function initTextTools() {
  const toolbar = document.getElementById('zoom-controls');
  if (!toolbar) return;

  document.addEventListener('focusin', (e) => {
    const target = e.target;
    if (isEditableFormattingTarget(target)) {
      lastFormattingTarget = target;
      updateTextToolbarState();
    }
  });

  document.addEventListener('selectionchange', () => {
    updateTextToolbarState();
  });

  toolbar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.text-tool-btn')) {
      // Keep focus in the current editor while applying toolbar commands.
      e.preventDefault();
    }
  });

  const bind = (id, handler) => {
    document.getElementById(id)?.addEventListener('click', handler);
  };

  bind('text-bold', () => applyTextCommand('bold'));
  bind('text-italic', () => applyTextCommand('italic'));
  bind('text-underline', () => applyTextCommand('underline'));
  bind('text-bullets', () => applyTextCommand('bullets'));
  bind('text-clear-format', () => applyTextCommand('clear'));
  bind('text-size-decrease', () => adjustGlobalFontScale(-0.05));
  bind('text-size-increase', () => adjustGlobalFontScale(0.05));

  updateTextToolbarState();
}

// Read the active page-setup (size / orientation / width) from the global
// settings, normalized. The print window loads the same settings object, so the
// on-screen sheets and the exported PDF paginate identically.
function getPageSetup() {
  const s = getSettings();
  return {
    pageSize: normalizePageSize(s.pageSize),
    orientation: s.orientation === 'landscape' ? 'landscape' : 'portrait',
    pageWidthIn: Number(s.pageWidthIn) > 0 ? Number(s.pageWidthIn) : DEFAULT_PAGE_WIDTH_IN,
  };
}

// Render the current resume
function renderCurrentResume() {
  const container = document.getElementById('resume');
  if (!container) return;

  // Preserve the preview scroll position across the full DOM rebuild below.
  // renderCurrentResume() replaces #resume's innerHTML and paginate() then
  // replaceChildren()s the sheets — a destructive rebuild of the scrolled
  // subtree of #resume-scroller. Chromium retains scrollTop through this, but
  // WebKit/WKWebView (the macOS Tauri build) drops it to 0, so the résumé
  // snaps to the top on every re-render — most noticeably when toggling the
  // Tools bulleted/inline view. Capture now; restore after paginate().
  const scroller = document.getElementById('resume-scroller');
  const savedScrollTop = scroller ? scroller.scrollTop : 0;
  const savedScrollLeft = scroller ? scroller.scrollLeft : 0;

  const data = store.getData();
  if (!data) {
    resetPaginatedState(container);
    container.innerHTML = `
      <div class="empty-state">
        <p>No resume loaded</p>
        <p>Select or create a variant to get started</p>
      </div>
    `;
    return;
  }
  
  // Render based on current layout
  switch (currentLayout) {
    case 'stacked':
      container.innerHTML = renderResumeStacked(data);
      break;
    case 'stacked-vertical':
      // Stacked Vertical - skills below highlights (not side-by-side)
      container.innerHTML = renderResumeStackedVertical(data);
      break;
    case 'right-sidebar':
      container.innerHTML = renderResumeRightSidebar(data);
      break;
    case 'compact':
      container.innerHTML = renderResumeCompact(data);
      break;
    case 'executive':
      container.innerHTML = renderResumeExecutive(data);
      break;
    case 'classic':
      container.innerHTML = renderResumeClassic(data);
      break;
    case 'classic-featured':
      // Classic Featured - highlights after summary, skills at bottom
      container.innerHTML = renderResumeClassicFeatured(data);
      break;
    case 'modern':
      // Modern layout - small left sidebar with header on top
      container.innerHTML = renderResumeModern(data);
      break;
    case 'timeline':
      // Timeline layout - experience with visual timeline
      container.innerHTML = renderResumeTimeline(data);
      break;
    case 'creative':
      // Creative layout - multi-section grid
      container.innerHTML = renderResumeCreative(data);
      break;
    default:
      container.innerHTML = renderResume(data);
  }
  
  // Add layout class to resume for CSS targeting
  const resume = container.querySelector('.resume');
  if (resume) {
    resume.dataset.layout = currentLayout;
  }
  
  // Apply current palette
  applyColorPalette(currentPalette);
  
  // Re-apply spacing settings after render
  initSpacingService();
  
  // Re-apply accent settings after render
  initAccentService();
  
  // Re-apply photo settings after render
  initPhotoService();
  
  // Paginate the just-rendered résumé into page "sheets". Screen and PDF share
  // this path (continuous = one open-height sheet); the print window calls the
  // same renderCurrentResume(), so the exported PDF matches what's on screen.
  paginate(container, getPageSetup(), currentLayout);

  // Restore the scroll position captured before the rebuild. paginate() is
  // synchronous, so the sheets are already laid out and scrollHeight is valid;
  // clamp to the new max so we stay in range when the two layouts differ in
  // height (e.g. bulleted vs inline Tools). Restore synchronously AND on the
  // next frame: WebKit can drop the offset during the rebuild or a frame later,
  // and the re-apply is imperceptible in engines that already retained it.
  if (scroller && (savedScrollTop || savedScrollLeft)) {
    const restoreScroll = () => {
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      scroller.scrollTop = Math.min(savedScrollTop, maxTop);
      scroller.scrollLeft = Math.min(savedScrollLeft, maxLeft);
    };
    restoreScroll();
    requestAnimationFrame(restoreScroll);
  }

  // Refresh inline editor
  refreshInlineEditor();
  updateTextToolbarState();
}

// init() is invoked by the React entry (src/main.jsx -> App.jsx) after mount;
// the print window (src/printEntry.js) calls initPrintMode() directly.
