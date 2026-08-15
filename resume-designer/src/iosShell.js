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
// Shared projection and lifecycle services stay on the JS side of the bridge,
// so native code never grows a second implementation of their rules.
import { computeStats, timelinePoints } from './applicationStats.js';
import { profileInitials } from './accountStats.js';
import { listProfiles, switchToProfileDurably } from './profiles.js';
// Version-history entry names, shared with the web dialog. The leaf module
// holds only strings: the dialog's lucide icons live beside IT, because this
// bridge draws nothing and Swift picks its own SF Symbols.
import { TYPE_LABELS } from './historyEntryLabels.js';

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
  document: outline = null, chat = null, library = null, design = null, history = null,
  jobs = null, profile = null, onboarding = null, diff = null,
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
    library,
    design,
    history,
    jobs,
    profile,
    onboarding,
    diff,
  };
}

/**
 * Project the change-review dialog for the native shell. Pure.
 *
 * ONE projection for every entry point that opens it — chat's "Review changes",
 * jobs tailoring, history compare, the inline "Full review" banner — because
 * they all go through `showDiffView` into the same always-mounted DiffDialog.
 *
 * **Nothing here applies anything.** The native buttons call back into that
 * dialog's own handlers, which is the whole point: tailoring goes through
 * diffEngine and `applyChangesToStore`, NOT the inline-changes session, and its
 * Apply All must batch through the ordered helper rather than loop — leaf paths
 * are indexed against the PROPOSED array, so applying in the diff engine's
 * emitted order corrupts them (`[A,B] -> [A,X,B']` writes `experience[2]`
 * before the insert creates it). A second apply route here is exactly how
 * someone accepts an edit that was never applied.
 *
 * `displayOld`/`displayNew` are the strings the engine already rendered for
 * display, so Swift never sees a résumé value it would have to format.
 */
export function buildDiffReview({
  open = false, title = '', changes = [], applied = [], rejected = [], busy = false,
} = {}) {
  const text = (v) => (typeof v === 'string' ? v : '');
  const appliedSet = new Set(Array.isArray(applied) ? applied : []);
  const rejectedSet = new Set(Array.isArray(rejected) ? rejected : []);

  const rows = (Array.isArray(changes) ? changes : [])
    .filter((c) => c && typeof c.path === 'string')
    .map((c) => ({
      path: c.path,
      label: text(c.label) || c.path,
      // "add" | "remove" | "modify", straight from DIFF_TYPES.
      kind: text(c.type) || 'modify',
      before: text(c.displayOld),
      after: text(c.displayNew),
      applied: appliedSet.has(c.path),
      rejected: rejectedSet.has(c.path),
    }));

  return {
    open: !!open,
    title: text(title) || 'Suggested changes',
    changes: rows,
    // What Apply All would actually write. The native button says so, because
    // "Apply all (3)" beside eleven cards is the only way to tell that eight
    // were already decided.
    pending: rows.filter((r) => !r.applied && !r.rejected).length,
    busy: !!busy,
  };
}

/**
 * Project the onboarding / new-résumé wizard. Pure.
 *
 * ONE component serves both: `newVariant` opens it with `skipApiKeyStep`, and a
 * genuine first run opens it without. So this projection carries the step
 * machine rather than a flow per entry point, and `isNewResumeMode` is the only
 * thing that differs.
 *
 * The step numbering is the wizard's own, not a native re-invention, because
 * every back/next handler in `OnboardingWizard.jsx` is written against it:
 *
 *   0 API key · 1 choose path · 2 import | interview | job input ·
 *   3 job descriptions · 4 review · 5 done
 *
 * Step 2 is three different screens picked by `mode`, and in `job` mode it
 * advances straight to 4 — the job flow gathers its own job description, so the
 * step-3 collector would be asking twice.
 *
 * **The API key never crosses back**, the same rule the settings projection
 * follows. `hasKey` says whether one is configured; the native field writes a
 * new one and never displays the old.
 */
export function buildOnboarding({
  open = false, step = 0, mode = null, isNewResumeMode = false, canDismiss = false,
  hasProviders = false, hasKey = false, importText = '', filePreview = null,
  question = 0, questions = [], answers = {}, improved = null,
  jobDescriptions = [], targetJob = null,
  jobGaps = [], models = [], model = '', reasoning = 'medium', generating = null,
  resume = null, busy = '', notice = null,
} = {}) {
  const text = (v) => (typeof v === 'string' ? v : '');
  const list = (v) => (Array.isArray(v) ? v : []);
  // The wizard shows "Step N of M" and a bar; new-résumé mode has one fewer
  // because it never shows the key step. Computed here so the two renderers
  // cannot drift — getting this wrong shows "Step 6 of 5".
  const totalSteps = isNewResumeMode ? 5 : 6;
  const displayStep = isNewResumeMode ? step : step + 1;

  const qs = list(questions).map((q, i) => ({
    id: text(q?.id) || `q${i}`,
    question: text(q?.question),
    // `textarea` gets a multi-line field natively; `aiAssist` is what puts the
    // Improve button there, and it is only on two of the six.
    multiline: q?.type === 'textarea',
    aiAssist: !!q?.aiAssist,
  }));
  const index = Math.min(Math.max(Number(question) || 0, 0), Math.max(qs.length - 1, 0));

  return {
    open: !!open,
    step: Number(step) || 0,
    mode: mode === 'new' || mode === 'import' || mode === 'job' ? mode : '',
    isNewResumeMode: !!isNewResumeMode,
    canDismiss: !!canDismiss,
    hasProviders: !!hasProviders,
    hasKey: !!hasKey,
    displayStep,
    totalSteps,

    // Step 2, import. `filePreview` is the extracted text of a picked file
    // awaiting confirmation; null means the picker has not produced one, which
    // is what selects between ImportStep and FilePreviewStep.
    importText: text(importText),
    filePreview: filePreview == null ? null : text(filePreview),

    // Step 2, interview.
    questions: qs,
    question: index,
    answer: text(answers?.[qs[index]?.id]),
    // The Improve button's result, as a one-shot. The native field owns its own
    // text while the user types — projecting every keystroke back would fight
    // the cursor — so a rewritten answer cannot simply arrive as `answer`.
    // Swift remembers the last token it applied and overwrites the field only
    // when a NEW one shows up, which also makes a re-improve of identical text
    // land instead of being swallowed as "no change".
    improved: improved && improved.token
      ? { token: Number(improved.token) || 0, text: text(improved.text) }
      : null,

    // Step 2, job.
    targetJob: targetJob
      ? {
        title: text(targetJob.title),
        company: text(targetJob.company),
        description: text(targetJob.description),
      }
      : null,
    jobGaps: list(jobGaps).map((g) => text(typeof g === 'string' ? g : g?.text)),
    models: list(models).map((m) => ({
      id: text(m?.id), label: text(m?.label) || text(m?.id), group: text(m?.group),
    })).filter((m) => m.id),
    model: text(model),
    reasoning: text(reasoning) || 'medium',
    // Non-null only while a generation is running or has just settled, so the
    // native side can show the same progress screen the web does rather than a
    // spinner over a blank card.
    generating: generating
      ? {
        phase: text(generating.phase),
        reasoning: text(generating.reasoning),
        elapsed: Number(generating.elapsed) || 0,
        done: !!generating.done,
      }
      : null,

    // Step 3.
    jobDescriptions: list(jobDescriptions).map((j) => ({
      title: text(j?.title) || 'Untitled Position',
      company: text(j?.company) || 'Unknown Company',
      description: text(j?.description),
    })),

    // Step 4. Read-only, and crossing as the SAME outline the structure panel
    // already decodes rather than a second document projection — the review
    // screen would otherwise be a second place that knows the résumé's schema,
    // which is the one thing this bridge does not do anywhere else.
    resume: resume ? buildDocumentOutline(resume) : null,
    isTailored: list(jobDescriptions).length > 0,

    // A long AI call — parse, tailor, improve — with nothing else to show for
    // it. Named rather than boolean so the native side can say which.
    busy: text(busy),
    notice: notice ? { kind: text(notice.kind) || 'info', text: text(notice.text) } : null,
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
 * `syncEnabled` is the only thing about sync that crosses in this direction.
 * The STATUS is not projected: what the iCloud account is doing is knowable
 * only in Swift, where the transport already holds it.
 *
 * @param {string} [state.theme] 'system' | 'light' | 'dark'
 * @param {boolean} [state.hasApiKey]
 * @param {boolean} [state.autoFallback]
 * @param {boolean} [state.syncEnabled]
 * @param {string} [state.version]
 */
export function buildSettings({
  theme, hasApiKey = false, autoFallback = false, syncEnabled = false, version = '',
} = {}) {
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    hasApiKey: !!hasApiKey,
    autoFallback: !!autoFallback,
    syncEnabled: !!syncEnabled,
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
/**
 * What a new row in each list looks like. Pure, and exported for its tests.
 *
 * **This is the only place the shapes live**, because Swift must not learn
 * them: a new bullet is a bare string, a new role is a six-key object, and a
 * new section needs an id and an area. Every other command on this bridge
 * echoes back a path it was handed, and `addItem` keeps that property by
 * carrying only the path and resolving the shape here — the same values the
 * web's own Add buttons pass to `store.addToArray`.
 *
 * Keyed by the path with its indices normalised, so `experience[3].bullets`
 * and `experience[0].bullets` resolve to the one entry.
 *
 * Returns `undefined` for a path with no template, which is how `addItem`
 * refuses a list it was never meant to grow.
 */
export function newListItem(path, makeId = () => `id-${Math.random().toString(36).slice(2, 10)}`) {
  switch (String(path ?? '').replace(/\[\d+\]/g, '[]')) {
    case 'experience[].bullets': return 'New bullet point';
    case 'sections[].content': return 'New item';
    case 'education': return 'Degree — Institution — Dates';
    case 'experience': return {
      id: makeId('exp'),
      title: 'New Position',
      company: 'Company Name',
      dates: 'Start – End',
      bullets: ['Describe your accomplishments'],
      // The web's Add expands the new role so it can be typed into
      // immediately. Harmless here — the native sheet does not read it — but
      // dropping it would mean the same résumé opens differently on desktop.
      _expanded: true,
    };
    case 'sections': return {
      id: makeId('section'),
      title: 'New section',
      type: 'list',
      area: 'sidebar',
      content: ['Item 1'],
    };
    default: return undefined;
  }
}

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
      addLabel: 'Add bullet',
      // The whole role, not a row of it. The array and the index are carried
      // rather than a "delete me" flag so removal goes through the same
      // `removeItem(path, index)` every row deletion uses.
      removePath: 'experience',
      removeIndex: i,
      removeTitle: text(role?.title) || `Role ${i + 1}`,
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
      addLabel: 'Add entry',
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
      // A prose section is one string, not a list — there is no row to add.
      addLabel: Array.isArray(section?.content) ? 'Add item' : '',
      removePath: 'sections',
      removeIndex: i,
      removeTitle: text(section?.title) || `Section ${i + 1}`,
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

  // Defaults applied once rather than at six push sites, so every group
  // decodes into the same Swift struct whether or not it has list actions.
  const withActions = (group) => ({
    addLabel: '', removePath: null, removeIndex: -1, removeTitle: '', ...group,
  });

  return {
    groups: groups.map(withActions),
    // Adding the FIRST of something has nowhere to live on a group, because a
    // group only exists once its array is non-empty — a résumé with no
    // education has no education group, and so had no way to ever gain one.
    additions: [
      { path: 'experience', label: 'Add role' },
      { path: 'education', label: 'Add education' },
      { path: 'sections', label: 'Add section' },
    ],
  };
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
 * Project the undo stack as a list of versions.
 *
 * Newest first, matching the web dialog — the useful end of a hundred-entry
 * stack is the recent end.
 *
 * The timestamp crosses as the raw ISO string, not a formatted one: iOS has
 * `RelativeDateTimeFormatter` and it speaks the user's language, which a
 * hand-rolled "3h ago" in this file does not.
 *
 * `variantId` rides along because history is PER RÉSUMÉ and this sheet has no
 * session identity of its own. A sheet left open across a résumé switch would
 * otherwise be listing another document's versions under this one's name, and
 * restoring one of them would overwrite the wrong résumé.
 *
 * The entry PAYLOADS never cross. `getHistoryEntries()` deliberately omits
 * `entry.data`, and a hundred document snapshots on a wire that is re-posted on
 * every canvas render would be absurd. A comparison is computed on demand
 * instead — see `diff`.
 *
 * Pure.
 *
 * @param {Array} entries rows from `store.getHistoryEntries()`
 * @param {string|null} variantId the résumé these versions belong to
 * @param {object|null} diff the open comparison, if any
 */
export function buildHistory(entries, variantId = null, diff = null) {
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry, index) => ({
      // The store's own index, kept even though the list is reversed: it is
      // what `restoreToEntry` addresses, and Swift must never compute one.
      index,
      timestamp: typeof entry?.timestamp === 'string' ? entry.timestamp : '',
      description: typeof entry?.description === 'string' ? entry.description : '',
      changeType: typeof entry?.changeType === 'string' ? entry.changeType : 'edit',
      label: TYPE_LABELS[entry?.changeType] || TYPE_LABELS.edit,
      isCurrent: !!entry?.isCurrent,
    }))
    .reverse();

  return {
    variantId: typeof variantId === 'string' ? variantId : '',
    entries: rows,
    diff: diff && typeof diff === 'object'
      ? {
        label: typeof diff.label === 'string' ? diff.label : '',
        changes: buildPendingChanges(diff.changes),
      }
      : null,
  };
}

/**
 * Project the résumé library for the native list.
 *
 * A phone list, not the desktop dialog: one row per résumé with its name, when
 * it changed, how many applications it carries, and — when a deep search
 * matched — the snippet that matched. The desktop's split preview pane has no
 * equivalent here; tapping a row opens the résumé, which is what the pane was
 * for.
 *
 * Pure.
 *
 * @param {Array} results rows from `searchLibrary`
 * @param {Array} variants every variant, for names and dates
 * @param {Array} applications every application, for the per-résumé counts
 */
export function buildLibrary(results, variants, applications) {
  const text = (v) => (typeof v === 'string' ? v : '');
  const byId = new Map((Array.isArray(variants) ? variants : []).map((v) => [v?.id, v]));
  const apps = Array.isArray(applications) ? applications : [];

  const stats = computeStats(apps);
  const entries = (Array.isArray(results) ? results : [])
    .filter((r) => r && typeof r.variantId === 'string')
    .map((r) => {
      const variant = byId.get(r.variantId) || {};
      const mine = apps.filter((a) => a?.variantId === r.variantId);
      return {
        id: r.variantId,
        name: text(variant.name) || 'Untitled',
        updatedAt: text(variant.updatedAt),
        applicationCount: mine.length,
        // Latest status is the one worth surfacing in a one-line row; the full
        // history stays on desktop.
        status: text(mine[mine.length - 1]?.status),
        // Only deep search produces these, and only the first is shown — a row
        // is one line, and a second snippet pushes the name off it.
        snippet: text(r.deepHits?.[0]?.snippet),
        snippetSource: text(r.deepHits?.[0]?.source),
      };
    });

  return {
    entries,
    // Raw numbers, not formatted strings: "2 days" and "43%" are locale
    // decisions, and Swift is the side that knows the locale. `null` where
    // there is nothing to divide by, which the native side renders as "—"
    // rather than 0% — no responses yet is not a 0% response rate.
    stats: {
      sent: stats.sent,
      responded: stats.responded,
      responseRate: stats.responseRate,
      interviewRate: stats.interviewRate,
      medianDaysToResponse: stats.medianDaysToResponse,
      perVariant: (stats.perVariant || []).map((row) => ({
        variantId: text(row.variantId),
        variantName: text(row.variantName) || 'Untitled resume',
        sent: row.sent,
        responded: row.responded,
        interviewed: row.interviewed,
      })),
    },
    // NEWEST first, the reverse of `timelinePoints`. The web draws a horizontal
    // axis where left-to-right is oldest-to-newest; the native tab is a
    // scrolling list, and a list you read top-down should open on what just
    // happened rather than on your first-ever application.
    //
    // Flat, with the month grouping left to Swift: which month a date falls in
    // — and what that month is called — is a locale question.
    timeline: timelinePoints(apps).reverse().map((p) => ({
      id: text(p.id),
      variantId: text(p.variantId),
      variantName: text(p.variantName) || 'Untitled resume',
      at: text(p.at),
      status: text(p.status),
      title: text(p.title),
      company: text(p.company),
    })),
  };
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
  const statusLine = typeof thinking === 'string' ? thinking : '';
  // The placeholder — an EMPTY streaming row while the request is in flight but
  // nothing has come back yet — is what lets the native sheet show "Thinking…"
  // from the moment Send is tapped, the way Olia does. Without it the transcript
  // sits unchanged for the seconds before the first token and the send reads as
  // dropped. Suppressed while `thinking` is set: helper turns (/feedback,
  // /improve) render that status line instead, and both at once is two spinners
  // for one request.
  if (streaming || streamingReasoning || (loading && !statusLine)) {
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
    // The engine's live status line ('Thinking…', tool names). Empty when idle.
    thinking: statusLine,
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
 * Project the design settings and the pickers' catalogs for the native Design
 * sheet.
 *
 * Two things at once, and both have to be here. The SETTINGS are what the
 * controls read; the CATALOGS are every palette, header style, font pairing and
 * Google font the pickers offer. Swift holds no catalog of its own, so a style
 * added to headerStyleService.js appears on iOS with no Swift change — and,
 * more importantly, Swift can only ever send back an id it was GIVEN, the same
 * property that keeps the structure panel's path grammar single-sourced.
 *
 * Everything crosses as a String, Bool or Double. Swift decodes this into one
 * Codable struct, so a `null` where it expects a Double fails the WHOLE decode:
 * a single malformed catalog row would blank the entire sheet rather than its
 * own line. That is why every value below is coerced instead of trusted, and
 * why ids that could not round-trip are dropped rather than passed on.
 *
 * Pure — no DOM, no storage.
 *
 * @param {object|null} state what `designController.getDesignState()` returns
 */
export function buildDesign(state) {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const text = (v) => (typeof v === 'string' ? v : '');
  // 0, never the service's own default. A number that only appears when the
  // read went wrong must not look like a setting the user chose — nobody picks
  // a zero font scale, but a 1.0 sitting in a broken sheet is indistinguishable
  // from a real one. It also keeps the defaults single-sourced in
  // spacingService/accentService rather than restated on the wire.
  const num = (v) => (Number.isFinite(v) ? v : 0);
  // An entry with no id cannot be selected, and duplicates a SwiftUI ForEach
  // identity if another blank one follows it.
  const rows = (v) => (Array.isArray(v) ? v : []).filter((o) => o && typeof o.id === 'string' && o.id);
  // Falling back to the id rather than to 'Untitled': these are catalog rows,
  // and 'linear-135' at least tells the user which one they are tapping.
  const options = (v) => rows(v).map((o) => ({ id: o.id, name: text(o.name) || o.id }));

  const s = obj(state);
  const page = obj(s.page);
  const color = obj(s.color);
  const header = obj(s.header);
  const fonts = obj(s.fonts);
  const spacing = obj(s.spacing);
  const accent = obj(s.accent);
  const photo = obj(s.photo);

  return {
    page: {
      size: text(page.size),
      orientation: text(page.orientation),
      widthIn: num(page.widthIn),
      groupPositions: !!page.groupPositions,
    },
    pageSizes: options(s.pageSizes),
    color: { palette: text(color.palette), customColor: text(color.customColor) },
    // Three swatches per row, not the palette's semantics: the sheet paints
    // them and nothing else, so accent/header/sidebar stay a web concern.
    palettes: rows(s.palettes).map((p) => ({
      id: p.id, name: text(p.name) || p.id, p1: text(p.p1), p2: text(p.p2), p3: text(p.p3),
    })),
    layout: text(s.layout),
    layouts: options(s.layouts),
    header: {
      type: text(header.type),
      styleId: text(header.styleId),
      imageOpacity: num(header.imageOpacity),
      imageFit: text(header.imageFit),
      // Whether an image is set, NEVER the image. A header photo is a
      // multi-megabyte data URL and this snapshot goes out on every publish;
      // the canvas is already rendering it a few pixels away.
      hasImage: !!header.hasImage,
    },
    headerStyles: rows(s.headerStyles).map((h) => ({
      id: h.id,
      name: text(h.name) || h.id,
      group: text(h.group),
      // The resolved CSS background, so a native swatch can preview the style
      // itself instead of listing thirty names the user has to try one by one.
      css: text(h.css),
    })),
    fonts: {
      mode: text(fonts.mode),
      // '' when a custom pair matches no preset — the contract says never null,
      // because Swift binds this to a String selection.
      pairingId: text(fonts.pairingId),
      displayName: text(fonts.displayName),
      bodyName: text(fonts.bodyName),
    },
    fontPairings: rows(s.fontPairings).map((p) => ({
      id: p.id, name: text(p.name) || p.id, display: text(p.display), body: text(p.body),
    })),
    systemFonts: options(s.systemFonts),
    // Keyed by family, which is also the value `setDesign` sends back; a font
    // with no family names nothing and could not be loaded.
    googleFonts: (Array.isArray(s.googleFonts) ? s.googleFonts : [])
      .filter((f) => f && typeof f.family === 'string' && f.family)
      .map((f) => ({ family: f.family, category: text(f.category) })),
    spacing: {
      fontScale: num(spacing.fontScale),
      lineHeight: num(spacing.lineHeight),
      sectionSpacing: num(spacing.sectionSpacing),
      sidebarWidth: num(spacing.sidebarWidth),
      marginTop: num(spacing.marginTop),
      marginRight: num(spacing.marginRight),
      marginBottom: num(spacing.marginBottom),
      marginLeft: num(spacing.marginLeft),
      // '' once a slider has moved off every preset, so the sheet shows no
      // preset selected rather than the one the values no longer match.
      presetId: text(spacing.presetId),
    },
    spacingPresets: options(s.spacingPresets),
    accent: {
      underlineStyle: text(accent.underlineStyle),
      underlineWidth: num(accent.underlineWidth),
      bulletStyle: text(accent.bulletStyle),
      borderRadius: text(accent.borderRadius),
      skillTagStyle: text(accent.skillTagStyle),
      showCornerTriangle: !!accent.showCornerTriangle,
      showSidebarGradient: !!accent.showSidebarGradient,
    },
    underlines: options(s.underlines),
    bullets: rows(s.bullets).map((b) => ({
      id: b.id,
      name: text(b.name) || b.id,
      // '' is a real glyph here — it is what the 'none' bullet style renders.
      char: text(b.char),
    })),
    radii: options(s.radii),
    skillTags: options(s.skillTags),
    photo: {
      enabled: !!photo.enabled,
      // Same rule as the header image: presence only.
      hasImage: !!photo.hasImage,
      placement: text(photo.placement),
      shape: text(photo.shape),
      size: text(photo.size),
      borderColor: text(photo.borderColor),
      objectPosition: text(photo.objectPosition),
      scale: num(photo.scale),
    },
    placements: options(s.placements),
    shapes: options(s.shapes),
    sizes: options(s.sizes),
  };
}

/** Whether `value` is something that can be awaited. */
function isThenable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

/**
 * Build the command dispatcher from a map of `type → handler`.
 *
 * Returns a function that never throws: a handler that blows up must not take
 * the shell's chrome down with it, and Swift has no way to catch a JS
 * exception raised inside `evaluateJavaScript`. Failures come back as data.
 *
 * TWO ENTRY POINTS onto the same handlers, because WebKit has two ways of
 * asking and they differ in exactly one thing — what happens to a handler that
 * answers with a PROMISE:
 *
 * - `dispatch(command)` is what `evaluateJavaScript` calls. It is synchronous by
 *   contract; `evaluateJavaScript` cannot serialize a promise, so a thenable is
 *   DROPPED and the reply carries no `result`.
 * - `dispatch.async(command)` is what `callAsyncJavaScript` calls, and it awaits
 *   the thenable before replying. `syncApply` is the reason it exists: an apply
 *   is not confirmed until the bytes are on disk, and that is a promise (see
 *   `applyUnits`). A rejection comes back as `{ ok: false }` like a throw, so
 *   this entry point never rejects either.
 *
 * Pure — the impurity is entirely in the `actions` the caller supplies.
 *
 * @param {Record<string, (payload: object) => unknown>} actions
 * @returns {(command: unknown) => {ok: boolean, result?: unknown, error?: string}}
 */
export function createCommandDispatcher(actions) {
  // Everything both entry points share. Answers `{ reply }` when the command is
  // settled and `{ pending, type }` when the handler returned a thenable — the
  // one case the two treat differently.
  const run = (command) => {
    let parsed = command;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return { reply: { ok: false, error: 'malformed-json' } };
      }
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return { reply: { ok: false, error: 'malformed-command' } };
    }
    const action = actions[parsed.type];
    if (typeof action !== 'function') {
      return { reply: { ok: false, error: `unknown-command:${parsed.type}` } };
    }
    try {
      const result = action(parsed);
      if (isThenable(result)) return { pending: result, type: parsed.type };
      return { reply: result === undefined ? { ok: true } : { ok: true, result } };
    } catch (err) {
      console.error('[iosShell] command failed:', parsed.type, err);
      return { reply: { ok: false, error: String(err?.message ?? err) } };
    }
  };

  function dispatch(command) {
    // A dropped thenable still RAN — the handler was called and its side effects
    // happened; only its answer is unavailable here. Every caller that needs the
    // answer goes through `dispatch.async`.
    const { reply, pending } = run(command);
    // Dropping it leaves nobody attached, so a handler that rejected on this
    // route would raise an unhandled rejection — in a webview, where there is no
    // console anyone is reading. `setSyncEnabled` comes through here every time
    // the switch in the sheet moves, and its promise is a disk write, so this is
    // a live route and not a door being closed early. `Promise.resolve` because
    // a thenable is not necessarily a promise: `isThenable` asks only for
    // `.then`.
    if (pending) Promise.resolve(pending).catch(() => {});
    return reply ?? { ok: true };
  }

  dispatch.async = async (command) => {
    const { reply, pending, type } = run(command);
    if (reply) return reply;
    try {
      const result = await pending;
      return result === undefined ? { ok: true } : { ok: true, result };
    } catch (err) {
      console.error('[iosShell] command failed:', type, err);
      return { ok: false, error: String(err?.message ?? err) };
    }
  };

  return dispatch;
}

const ACCOUNT_PROFILES_TIMEOUT_MS = 5000;
let pendingAccountProfiles = null;

function parseAccountProfilesAnswer(answer) {
  const parsed = JSON.parse(String(answer ?? ''));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('syncAccountProfiles needs an account answer');
  }
  if (parsed.status === 'known') {
    if (!Array.isArray(parsed.profiles) || !parsed.profiles.every((profile) => (
      profile && typeof profile === 'object'
      && typeof profile.id === 'string'
      && typeof profile.name === 'string'
    ))) {
      throw new Error('syncAccountProfiles needs a profile array');
    }
    return parsed;
  }
  if (parsed.status === 'empty' || parsed.status === 'unavailable') return { status: parsed.status };
  throw new Error('syncAccountProfiles needs a known, empty, or unavailable status');
}

function accountProfilesAction(deps) {
  // Deliberately not async: malformed input must throw synchronously so both
  // dispatcher entry points turn it into the same refusal. The returned value
  // may still be a promise; callAsyncJavaScript awaits it through dispatch.async.
  return ({ answer }) => deps.syncAccountProfiles(parseAccountProfilesAnswer(answer));
}

/**
 * Install the one bridge command boot needs before the full shell can exist.
 * `initIOSShell` is intentionally wired much later, after storage and profiles;
 * moving it would break the load-bearing boot sequence. This tiny endpoint is
 * available from module import onward and owns no app state beyond one reply.
 */
export function initIOSProfileBootstrap(deps) {
  if (!isNativeShellAvailable()) return;
  const dispatch = createCommandDispatcher({
    syncAccountProfiles: accountProfilesAction(deps),
  });
  window.__opProfileBootstrap = { commandAsync: dispatch.async };
}

/** Ask native iCloud what the fixed opShared zone holds, bounded to five seconds. */
export function askAccountProfiles() {
  if (!isNativeShellAvailable()) return Promise.resolve({ status: 'unavailable' });
  if (pendingAccountProfiles) return pendingAccountProfiles.promise;

  let resolveRequest;
  const promise = new Promise((resolve) => { resolveRequest = resolve; });
  const timeout = setTimeout(() => {
    if (pendingAccountProfiles?.promise !== promise) return;
    pendingAccountProfiles = null;
    resolveRequest({ status: 'unavailable' });
  }, ACCOUNT_PROFILES_TIMEOUT_MS);
  pendingAccountProfiles = { promise, resolve: resolveRequest, timeout };
  window.webkit.messageHandlers[SHELL_HANDLER].postMessage({ kind: 'syncAccountProfiles' });
  return promise;
}

/** Complete the pending boot question. Passed into both bridge dispatchers. */
export function resolveAccountProfiles(answer) {
  const pending = pendingAccountProfiles;
  if (!pending) return answer;
  clearTimeout(pending.timeout);
  pendingAccountProfiles = null;
  pending.resolve(answer);
  return answer;
}

/** Tell the continuation overlay that profile resolution, not merely the fetch, finished. */
export function reportProfilesResolved() {
  if (!isNativeShellAvailable()) return;
  window.webkit.messageHandlers[SHELL_HANDLER].postMessage({ kind: 'profilesResolved' });
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

// The PDF preview's callbacks, held while the native sheet is up. Same pair the
// web dialog receives in its event detail, so both routes end in the same
// functions in pdf.js — the export guard's lifecycle depends on exactly one of
// them running.
let pdfPreviewCallbacks = null;

/**
 * Show the export preview in the NATIVE sheet instead of the web dialog.
 *
 * Returns false when there is no native shell, which is the caller's signal to
 * fall back to the web dialog — so this is safe to call unconditionally.
 *
 * Swift renders the file itself with PDFKit. The web dialog rasterises the same
 * PDF with pdf.js into stacked canvases because it has nothing better; on iOS
 * the system's own PDF view is right there, and it scrolls, zooms and renders
 * text sharply at any scale without moving a megabyte of base64 through the
 * bridge first.
 *
 * @param {{path: string, defaultFilename: string, onConfirm: (name: string) => void, onCancel: () => void}} request
 */
export function openNativePdfPreview({ path, defaultFilename, onConfirm, onCancel }) {
  if (!isNativeShellAvailable() || typeof path !== 'string' || !path) return false;
  pdfPreviewCallbacks = { onConfirm, onCancel };
  window.webkit.messageHandlers[SHELL_HANDLER].postMessage({
    kind: 'pdfPreview',
    path,
    filename: typeof defaultFilename === 'string' ? defaultFilename : 'Resume',
  });
  return true;
}

/** Resolve the native preview exactly once, whichever way it ended. */
function settlePdfPreview(confirmed, filename) {
  const callbacks = pdfPreviewCallbacks;
  pdfPreviewCallbacks = null;
  if (!callbacks) return;
  if (confirmed) callbacks.onConfirm?.(filename);
  else callbacks.onCancel?.();
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
let activationSent = false;
let streamDocument = false;
let streamChat = false;
let chatView = null;
let streamLibrary = false;
let libraryQuery = '';
let libraryDeep = false;
let streamDesign = false;
let streamHistory = false;
let streamJobs = false;
let streamProfile = false;
// The comparison the history sheet has open, computed on demand because the
// entry payloads never ride the snapshot. Cleared when the sheet closes.
let historyDiff = null;
let publish = () => {};

// The wizard's last projection, or null while it is closed. Unlike every other
// screen there is no `streamOnboarding` flag: the wizard IS the whole screen
// when it is up, so `open` is the only gate there is to have.
let onboardingView = null;
// The wizard's own handlers, re-registered on each of its renders. Commands go
// through these rather than through an extracted controller because — unlike
// StructurePanel and the dialogs — OnboardingWizard is mounted from app start
// (App.jsx renders it once storage is ready) and merely renders null while
// closed, so its handlers are always reachable.
let onboardingHandlers = {};

// The change-review dialog's last projection, and its handlers. Same
// arrangement as the wizard, and available for the same reason: DiffDialog is
// mounted from app start and merely renders nothing while closed.
let diffView = null;
let diffHandlers = {};

/**
 * Push the change-review dialog's state to the native shell. Same contract as
 * `publishOnboarding` below.
 */
export function publishDiffReview(state, handlers) {
  diffView = state ? buildDiffReview(state) : null;
  diffHandlers = handlers || {};
  publish();
}

/**
 * Push the wizard's state to the native shell.
 *
 * Imported DIRECTLY by OnboardingWizard rather than reached through
 * `window.__opShell`, which is what ChatPanel does — and the reason its first
 * push is famously lost, because React mounts it before `init()` defines that
 * global. Here the state is retained in module scope and `publish` is a no-op
 * until `initIOSShell` replaces it, so an early push costs nothing and needs no
 * re-push handshake.
 *
 * No-op on every platform but iOS: `publish` stays the no-op unless the native
 * shell activated, so the web pays one projection build per wizard render and
 * nothing else.
 *
 * @param {object|null} state the wizard's state, or null once it has closed
 * @param {object} [handlers] its flow handlers, for `command()` to call back into
 */
export function publishOnboarding(state, handlers) {
  onboardingView = state ? buildOnboarding(state) : null;
  onboardingHandlers = handlers || {};
  publish();
}

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

  // Persistence names the units whose bytes landed. The shell only carries
  // those ids to CKSyncEngine, and stays silent on desktop/browser builds.
  deps.setSyncDirtyNotifier?.((unitIds) => {
    if (!isNativeShellAvailable()) return;
    window.webkit.messageHandlers[SHELL_HANDLER].postMessage({
      kind: 'syncDirty', unitIds,
    });
  });

  const dispatch = createCommandDispatcher({
    // Résumé selection and CRUD. Rename, delete and import route back through
    // the React chrome, which owns the confirm dialogs, the last-variant guard
    // and the orphaned-chat-thread handling — duplicating any of that in Swift
    // is how a delete quietly loses threads.
    selectVariant: ({ id }) => deps.loadVariant(id),
    newVariant: () => window.showOnboardingWizard?.({ skipApiKeyStep: true }),
    switchProfile: ({ id }) => (deps.switchToProfileDurably || switchToProfileDurably)(
      String(id ?? ''),
    ),

    // The wizard. Every one of these is the SAME handler the web card's button
    // calls — the component owns the step machine, and a second copy of "which
    // step comes after import" in Swift is how the two drift into disagreeing
    // about what the user already answered.
    //
    // `onboardingHandlers` is empty until the wizard's first render, so each
    // call is optional: a command arriving before then is a no-op rather than
    // a throw that takes the whole snapshot down with it.
    onboardingSaveKey: ({ key }) => onboardingHandlers.validateKey?.(String(key ?? '')),
    onboardingChoose: ({ mode }) => onboardingHandlers.chooseMode?.(String(mode ?? '')),
    onboardingParseImport: ({ text }) => onboardingHandlers.parseImport?.(String(text ?? '')),
    // A file from the native document picker. Base64 because the command
    // channel is a JS string literal, and the NAME matters as much as the
    // bytes: `parseResumeFile` picks its extractor off the extension.
    onboardingPickedFile: ({ name, data }) => onboardingHandlers.pickedFile?.(
      String(name ?? ''), String(data ?? ''),
    ),
    onboardingClearFile: () => onboardingHandlers.clearFilePreview?.(),
    onboardingInterviewNext: ({ value }) => onboardingHandlers.interviewNext?.(String(value ?? '')),
    onboardingInterviewBack: () => onboardingHandlers.interviewBack?.(),
    onboardingImprove: ({ value }) => onboardingHandlers.improve?.(String(value ?? '')),
    onboardingGenerate: ({ title, company, description, model, reasoning }) =>
      onboardingHandlers.generateForJob?.({
        title: String(title ?? ''),
        company: String(company ?? ''),
        description: String(description ?? ''),
        model: String(model ?? ''),
        reasoning: String(reasoning ?? 'medium'),
      }),
    onboardingAddJob: ({ title, company, description }) => onboardingHandlers.addJob?.({
      title: String(title ?? ''),
      company: String(company ?? ''),
      description: String(description ?? ''),
    }),
    onboardingRemoveJob: ({ index }) => onboardingHandlers.removeJob?.(Number(index)),
    onboardingCancelGenerate: () => onboardingHandlers.cancelGenerate?.(),
    onboardingNext: () => onboardingHandlers.next?.(),
    // The job step carries its half-typed draft back with it. Absent from every
    // other step, and harmless there — `back()` only reads it in job mode.
    onboardingBack: ({ title, company, description }) => onboardingHandlers.back?.(
      title === undefined && company === undefined && description === undefined
        ? null
        : {
          title: String(title ?? ''),
          company: String(company ?? ''),
          description: String(description ?? ''),
        },
    ),
    onboardingCreate: () => onboardingHandlers.saveResume?.(),
    onboardingFinish: () => onboardingHandlers.finish?.(),
    onboardingOpenProfile: () => onboardingHandlers.openProfile?.(),
    onboardingDismiss: () => onboardingHandlers.dismiss?.(),

    // Reviewing proposed changes. Every one calls DiffDialog's OWN handler, so
    // the apply route stays single — see buildDiffReview.
    diffApply: ({ path }) => diffHandlers.applyChange?.(String(path ?? '')),
    diffReject: ({ path }) => diffHandlers.rejectChange?.(String(path ?? '')),
    diffApplyAll: () => diffHandlers.applyAll?.(),
    diffRejectAll: () => diffHandlers.rejectAll?.(),
    diffClose: () => diffHandlers.close?.(),
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
    // `live` marks the frames of a pinch, which run without the zoom
    // transition — see setZoomLevel. Swift sends one final non-live setZoom
    // when the gesture ends to put the animation back.
    //
    // `x`/`y` are the point between the fingers, and they are what makes the
    // zoom happen where the gesture is rather than at the top-left corner.
    // Absent — from a caller that has no gesture to report — the canvas keeps
    // scaling from the corner, which is the button behaviour.
    setZoom: ({ value, live, x, y }) => deps.setZoomLevel(
      Number(value),
      live === 'true',
      x === undefined || y === undefined ? null : { x: Number(x), y: Number(y) },
    ),
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
    // The native export preview's two outcomes. They land in the same
    // onConfirm/onCancel pdf.js hands the web dialog, and exactly one of them
    // must run: the export guard is held from generation until one does, and
    // the temp PDF is only cleaned up by them.
    pdfSave: ({ filename }) => settlePdfPreview(true, String(filename ?? '').trim() || 'Resume'),
    pdfCancel: () => settlePdfPreview(false),

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
    // Adding and removing rows. Same path-echo contract as moveItem: the path
    // came from the outline Swift was handed and goes back verbatim.
    //
    // What a new row IS resolves here, in `newListItem`, never in Swift — a
    // bullet is a bare string and a role is a six-key object, and putting that
    // in the native side would be the second place the document's schema is
    // known. A path with no template is refused rather than appending
    // something the renderer cannot draw.
    addItem: ({ path }) => {
      if (typeof path !== 'string' || !path) throw new Error('addItem needs a list path');
      const item = newListItem(path, deps.generateId);
      if (item === undefined) throw new Error(`addItem has no template for ${path}`);
      deps.addListItem(path, item);
    },
    removeItem: ({ path, index }) => {
      if (typeof path !== 'string' || !path) throw new Error('removeItem needs a list path');
      const at = Number(index);
      // `removeFromArray` silently ignores an out-of-range index, so a stale
      // row tapped after the list shrank underneath would look like it worked.
      if (!Number.isInteger(at) || at < 0) throw new Error(`removeItem index ${index}`);
      deps.removeListItem(path, at);
    },
    // Chat. Every one of these routes to the engine in useChat.js through the
    // React panel — none of them reimplements any of it.
    chatSend: ({ text }) => ask('rd:chat-send', { text: String(text ?? '') }),
    chatStop: () => ask('rd:chat-stop'),
    chatNewThread: () => ask('rd:chat-new-thread'),
    chatSelectThread: ({ id }) => ask('rd:chat-select-thread', { id }),
    chatRenameThread: ({ id, title }) =>
      ask('rd:chat-rename-thread', { id, title: String(title ?? '') }),
    chatDeleteThread: ({ id }) => ask('rd:chat-delete-thread', { id }),
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
    // The library. Search runs in JS against the same `searchLibrary` the
    // desktop dialog uses; Swift owns only the query string.
    librarySearch: ({ query, deep }) => {
      libraryQuery = String(query ?? '');
      libraryDeep = deep === 'true';
      publish();
    },
    setLibraryOpen: ({ value }) => {
      streamLibrary = value === 'true';
      publish();
    },
    openVariant: ({ id }) => deps.loadVariant(String(id)),

    // Version history. The stack is per-résumé and its indices renumber, so the
    // two commands that address a version carry the timestamp they were shown
    // with — see `restoreVersion` in main.js for what that check prevents.
    setHistoryOpen: ({ value }) => {
      streamHistory = value === 'true';
      if (!streamHistory) historyDiff = null;
      publish();
    },
    restoreVersion: ({ index, timestamp }) => {
      const ok = deps.restoreVersion(Number(index), String(timestamp ?? ''));
      historyDiff = null;
      publish();
      if (!ok) throw new Error('that version is no longer where it was');
    },
    compareVersion: ({ index, timestamp, label }) => {
      const changes = deps.compareVersion(Number(index), String(timestamp ?? ''));
      if (!changes) throw new Error('that version is no longer where it was');
      historyDiff = { label: String(label ?? ''), changes };
      publish();
    },
    closeCompare: () => {
      historyDiff = null;
      publish();
    },

    // Jobs and Profile. Both are whole editors, so rather than a command per
    // control they take ONE action each — same shape the design sheet's
    // `setDesign` uses, and the same rule: every action routes to the function
    // the web dialog calls, and the sheet re-renders from the next projection
    // rather than from what it optimistically set.
    setJobsOpen: ({ value }) => {
      streamJobs = value === 'true';
      publish();
    },
    jobsAction: (command) => {
      const result = deps.jobsAction(command);
      // The action can be async (analysis, tailoring). Publish on the way out
      // AND when it settles: the first shows the busy state, the second the
      // result. `jobDescriptions.js` has no change notification of its own.
      publish();
      if (result && typeof result.then === 'function') result.then(publish, publish);
    },
    setProfileOpen: ({ value }) => {
      streamProfile = value === 'true';
      publish();
    },
    profileAction: (command) => {
      const result = deps.profileAction(command);
      publish();
      if (result && typeof result.then === 'function') result.then(publish, publish);
    },

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
    // The Design sheet. Gated for the same reason the outline is, only more so:
    // the catalogs are the largest payload the bridge carries and they never
    // change, so streaming them alongside every canvas re-render would spend the
    // most bytes on the least news.
    setDesignOpen: ({ value }) => {
      streamDesign = value === 'true';
      publish();
    },
    // `setDesign` is the ONLY way design settings are written from Swift, the
    // way `setField` is for the document. Swift names a group and a property it
    // was handed in the projection and returns a string; designController owns
    // every coercion and every service call, so what a design setting MEANS is
    // never decided twice.
    //
    // Each write republishes because the sheet cannot derive what a write
    // changes elsewhere: moving one spacing slider empties `presetId`, and
    // picking a font empties `pairingId`. Without the re-push the sheet keeps a
    // preset highlighted that the values no longer match.
    setDesign: ({ group, property, value }) => {
      if (typeof group !== 'string' || !group) throw new Error('setDesign needs a group');
      if (typeof property !== 'string' || !property) throw new Error('setDesign needs a property');
      deps.applyDesign({ group, property, value: String(value ?? '') });
      publish();
    },
    resetDesign: ({ group }) => { deps.resetDesign(String(group ?? '')); publish(); },
    // Images travel native → web only. Swift reads the picked photo and sends a
    // data URL; nothing sends one back, which is what `hasImage` is for.
    setDesignImage: ({ target, dataUrl }) => {
      if (typeof dataUrl !== 'string' || !dataUrl) throw new Error('setDesignImage needs a dataUrl');
      deps.setDesignImage(String(target ?? ''), dataUrl);
      publish();
    },
    clearDesignImage: ({ target }) => { deps.clearDesignImage(String(target ?? '')); publish(); },

    // Settings, for the native sheet. Each writes through the same service the
    // web dialog uses, then republishes so the sheet reflects what landed
    // rather than what it optimistically set.
    setTheme: ({ value }) => { deps.setTheme(value); publish(); },
    setAutoFallback: ({ value }) => {
      deps.saveSettings({ autoFallback: value === 'true' });
      publish();
    },
    // The iCloud switch. This side only persists the answer and republishes;
    // starting and stopping the transport is Swift's, off the snapshot it gets
    // back — a boolean in storage that nothing acts on is the worst outcome
    // here, and it is the one that looks fine from JS.
    //
    // RETURNED, like `syncApply`'s count and for the same reason: the answer is
    // `true` only once the preference is on DISK (setSyncEnabled, syncModel.js).
    // An iCloud purge keeps a persisted refusal until it hears that — a purge
    // confirmed against the write-behind cache leaves the next launch reading a
    // stored `true` with nothing left to stop it, and the workspace goes back
    // into the account whose owner had just emptied it (`tellPageSyncIsOff`,
    // OPShell.swift). The toggle in the sheet asks through `command`, which
    // drops the promise; the write and the republish below are synchronous
    // either way, so nothing on screen waits for a disk.
    setSyncEnabled: ({ value }) => {
      const durable = deps.setSyncEnabled(value === 'true');
      publish();
      return durable;
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

    // CloudKit sync. Swift calls these and never parses a payload: a unit is
    // `{ id, kind, payload, modifiedAt }` and the payload is an opaque string.
    // Units cross Swift -> JS as a JSON STRING because the command channel is
    // a JS string literal — the same reason a picked file crosses as base64.
    // Both take the profile whose workspace is being collected. `''` is the
    // open one, which is every case but a full upload of a workspace nobody has
    // opened on this device — the whole reason those two are separable. Swift
    // never derives the id: it reads it off the record's own zone, or names the
    // profile it is paying debt for.
    syncCollect: ({ profileId }) => {
      // Same guard `sharePdf`/`openNativePdfPreview` use before posting
      // directly to the handler, rather than optional-chaining through it —
      // one idiom for "tell Swift something" on this bridge.
      if (!isNativeShellAvailable()) return;
      const forProfile = String(profileId ?? '');
      window.webkit.messageHandlers[SHELL_HANDLER].postMessage({
        // ECHOED BACK, because the answer is asynchronous and Swift may have
        // asked for more than one workspace: the reply has to say which one it
        // is, or its debt is settled against whichever ask happens to be open.
        kind: 'syncUnits', profileId: forProfile, units: deps.collectUnits(forProfile),
      });
    },
    syncUnit: ({ unitId, profileId }) =>
      deps.collectUnit(String(unitId ?? ''), String(profileId ?? '')),
    syncAccountProfiles: accountProfilesAction(deps),
    // Registry bootstrap and profile-zone readiness are separate facts. Native
    // reports only after its initial pull has either settled or become
    // unavailable, so first-run onboarding cannot race ahead of fetched content.
    syncInitialProfileFetchSettled: ({ status }) =>
      deps.markInitialProfileFetchSettled(String(status ?? 'unavailable')),
    // Which zone each named unit belongs in, asked when the transport QUEUES a
    // save: a CloudKit record id carries its zone, and all Swift holds at that
    // moment is the id it was handed. Answered here rather than derived there
    // for the same reason a conflict is resolved here — what a unit id means is
    // this side's knowledge. A JSON STRING in, an object out, like the two
    // batch routes below.
    syncScopes: ({ unitIds }) => {
      const parsed = JSON.parse(String(unitIds ?? '[]'));
      if (!Array.isArray(parsed)) throw new Error('syncScopes needs an array of unit ids');
      return deps.unitScopes(parsed);
    },
    // One of the two commands whose answer is a promise — `setSyncEnabled` is
    // the other, for the same durability reason — and both are asked for
    // through `callAsyncJavaScript` (see `dispatch.async`). A malformed batch
    // still throws SYNCHRONOUSLY — this handler is not `async` on purpose — so
    // it is a refusal on either entry point rather than an answer on one.
    // Each unit now names the profile whose zone it arrived in — `''` for the
    // shared zone. Swift is reporting a fact about the record's zone, not
    // deciding what the unit is; see `syncScopes` for the same seam in reverse.
    syncApply: ({ units }) => {
      const parsed = JSON.parse(String(units ?? '[]'));
      if (!Array.isArray(parsed)) throw new Error('syncApply needs an array of units');
      // RETURNED, not discarded. `applyUnits` answers `{ applied }` — how many
      // units are DURABLY this device's — and the transport keeps the server's
      // change tag for a unit only once it knows this device took it. Swallowing
      // the count here is what let a batch the page never applied leave its
      // change tags behind, and a tag for content this device does not hold
      // makes the next save of that unit a clean update that destroys the
      // server's copy.
      //
      // `applyUnits` lands everything synchronously and only THEN awaits the
      // disk, so the cache is already current when this returns its promise —
      // which is why the republish below can stay where it is and does not wait
      // on a disk write. Nothing on screen ever waits for sync.
      const pending = deps.applyUnits(parsed);
      // Republished like every other mutating route here, and for the same
      // reason: an open sheet projects on demand and nothing else re-reads it.
      // A landing that changed the job list or the application history would
      // otherwise sit behind whatever the sheet last drew, until the user
      // happened to touch something. (The chat sheet gets there anyway —
      // ChatPanel publishes on every engine change, and adopting a thread list
      // is one — so this is the other screens catching up with it.)
      publish();
      return pending;
    },
    // BOTH versions of every unit whose save hit a conflict, resolved by the
    // model — the one side that can tell a newer-wins comparison from a union,
    // and therefore the only one that can tell whether a loser exists at all.
    // The transport used to decide this itself and hand back only the loser,
    // which is why the two append-shaped units never unioned on the save path.
    //
    // A JSON STRING for the same reason `syncApply`'s units are one: the command
    // channel is a JS string literal. The answer is a promise for the same
    // reason its answer is — a resolution is not confirmed until the bytes are
    // on disk — so this route is reached through `dispatch.async` too, and a
    // malformed batch still throws SYNCHRONOUSLY rather than resolving to a
    // refusal.
    syncResolveConflicts: ({ conflicts }) => {
      const parsed = JSON.parse(String(conflicts ?? '[]'));
      if (!Array.isArray(parsed)) {
        throw new Error('syncResolveConflicts needs an array of conflicts');
      }
      // RETURNED, not discarded, exactly as `syncApply`'s count is: the
      // transport keeps the server's change tag for a unit only once the model
      // says it merged, applied or parked the server's version, and it learns
      // whether that unit still owes the server a save from the same answer.
      const pending = deps.resolveConflicts(parsed);
      // Republished like every other mutating route here: a resolution can
      // replace the document on screen and can add a version-history entry.
      publish();
      return pending;
    },
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
      // Optional like the other sync deps: this module is wired on desktop too,
      // where nothing calls it and there is no iCloud switch to read.
      syncEnabled: !!deps.getSyncEnabled?.(),
      version,
    };
  };

  /**
   * Run one sheet's projection, containing its failure to that sheet.
   *
   * The snapshot is one message: a throw anywhere in building it takes the
   * WHOLE chrome down, not just the sheet that failed, and the symptom is a
   * shell that silently stops updating — no title, no zoom readout, nothing.
   * Measured: a projection dep that was never imported into main.js froze
   * everything the moment its sheet opened.
   *
   * The sheet gets `null`, which it already renders as "not open yet", and the
   * name goes to the log so the cause is one search away.
   */
  const project = (name, build) => {
    try {
      return build();
    } catch (error) {
      console.error(`[opShell] ${name} projection failed`, error);
      return null;
    }
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
    const activeProfileId = deps.getActiveProfileId?.() || '';
    const profiles = (deps.listProfiles?.() || listProfiles()).map((profile) => ({
      id: profile.id,
      name: profile.name,
      initials: profileInitials(profile.name),
      isActive: profile.id === activeProfileId,
    }));
    window.webkit.messageHandlers[SHELL_HANDLER].postMessage(
      {
        kind: 'snapshot',
        profiles,
        ...buildSnapshot({
          currentId, list, zoom: getZoom(), pdfBusy, modalOpen: hasOpenModal(),
          settings: readSettings(),
          document: streamDocument ? project('document', () => deps.getDocument()) : null,
          library: streamLibrary
            ? project('library', () => deps.getLibrary(libraryQuery, libraryDeep))
            : null,
          design: streamDesign ? project('design', () => deps.getDesign()) : null,
          history: streamHistory ? project('history', () => deps.getHistory(historyDiff)) : null,
          jobs: streamJobs ? project('jobs', () => deps.getJobs()) : null,
          profile: streamProfile ? project('profile', () => deps.getProfile()) : null,
          // Already a built projection — the wizard pushes it rather than
          // being polled, so there is nothing to build here and nothing that
          // can throw. Null while it is closed.
          onboarding: onboardingView,
          // Already built — pushed by DiffDialog rather than polled.
          diff: diffView,
          chat: streamChat
            ? project('chat', () => ({
              ...chatView, pendingChanges: buildPendingChanges(deps.getPendingChanges()),
            }))
            : null,
        }),
      }
    );
    // The engine reads the profile ids from Swift's current snapshot. Post that
    // snapshot first, then activate sync, so its first start cannot capture the
    // empty pre-snapshot model and fall back to the active profile alone.
    if (!activationSent) {
      activationSent = true;
      window.webkit.messageHandlers[SHELL_HANDLER].postMessage({
        kind: 'activated', profileId: activeProfileId,
      });
    }
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
     * The same commands, for `callAsyncJavaScript`, which awaits what the page
     * returns. `command` drops a promise because `evaluateJavaScript` cannot
     * serialize one; this is how `syncApply`'s durable count crosses the bridge.
     */
    commandAsync: dispatch.async,
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
      // Tell Swift a document just came up, so it can re-disable WKWebView's own
      // pinch zoom. Those settings live on the scroll view and WebKit re-derives
      // them from the new page's viewport, so a reload hands the canvas back a
      // second scale that fights the app's own.
      //
      // `send` posts the profile-bearing snapshot first and the activation
      // immediately after it. That order is load-bearing now that native sync
      // starts every profile zone named by the snapshot.
      publish();
      return true;
    },
  };

  // Two ways in, because the handshake has two failure modes.
  //
  // Swift may win the race and call activate() before this module has run; it
  // leaves a flag behind when it does, so that ordering still completes.
  //
  // And the page can be RELOADED without Swift knowing — WebKit reclaims the
  // content process of a backgrounded app and reloads on return, which reran
  // this module against a document with no `op-native-shell` class on it and
  // brought the web header back under the native one. Swift's own handover is
  // one-shot, so it cannot help. The message handler's presence is proof the
  // native shell is installed, and it survives a reload because it belongs to
  // the webview's configuration, so the web side can just re-assert.
  if (window.__opShellPendingActivate || isNativeShellAvailable(window)) {
    window.__opShell.activate();
  }
}
