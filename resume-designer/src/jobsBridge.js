/**
 * The Jobs screen's seam with the native iOS sheet.
 *
 * Two halves, split the way designController.js is: the PROJECTION the sheet
 * renders from (`getJobsState` reads, `buildJobs` shapes it), and the two AI
 * COMPOSITIONS behind the Analyze and Tailor buttons. Those two used to live
 * inside JobsDialog's React handlers with no exported entry point, which made
 * them unreachable from anywhere else — the web dialog never mounts on iOS, so
 * a native button had nothing to call. They live here now and JobsDialog calls
 * them, so the phone and the desktop cannot end up tailoring a résumé
 * differently.
 *
 * `applyJobs` is the native dispatcher's single door. Everything it does that
 * is not a run is a direct call into jobDescriptions.js — the same module the
 * web dialog calls — with one deliberate exception. DELETE does NOT go through
 * JobsDialog's `removeJob`: that one awaits `confirmDestructive()`, which opens
 * a Radix alert dialog inside the WEBVIEW, i.e. behind the native sheet. The
 * user would see nothing happen and the promise would never settle, hanging the
 * action for good. The confirmation is the sheet's own `.confirmationDialog`
 * and the action here deletes unconditionally.
 *
 * Nothing here subscribes to anything. jobDescriptions.js has no change
 * notification at all — the React dialog re-reads it through a `useReducer`
 * bump after every mutation — and the native side gets the same effect from
 * iosShell's `jobsAction`, which publishes on the way out and again when an
 * async action settles.
 */

import {
  initJobDescriptions, getAllJobDescriptions, getActiveJobDescriptions, getJobDescription,
  addJobDescription, updateJobDescription, deleteJobDescription, toggleJobDescriptionActive,
  parseJobDescriptionText, jobStorageFailed, registerJobEditHolder,
} from './jobDescriptions.js';
import {
  analyzeAgainstJobs, generateResumeChanges, getAllModels, getConfiguredProviders,
  validateModelId, getDefaultModelId,
} from './aiService.js';
import {
  getSettings, saveSettings, saveVariantAnalysis, getVariantAnalysis, getVariants,
} from './persistence.js';
import { recordTailorDrafts } from './applications.js';
import { createChangeSet } from './diffEngine.js';
import { showDiffView } from './diffView.js';
import { store } from './store.js';
import { getCurrentId, loadVariant } from './variantManager.js';
import { applyRecommendationToStore } from './jobRecommendations.js';

/** The four efforts this screen offers. Chat's list is wider; these are not it. */
const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'];

/** What JobCard shows collapsed. A job post is multi-KB and the snapshot is
 * re-posted on every canvas mutation, so the list carries this and never the
 * posting itself — the full text crosses for ONE job at a time, via `draft`. */
const PREVIEW_CHARS = 150;

const NO_NOTICE = { kind: '', text: '' };
const IDLE = { busy: false, op: '', reasoning: '' };

// --- module state -----------------------------------------------------------
//
// Everything JobsDialog holds in `useState` and the native sheet cannot: the
// run in flight, its streamed reasoning, its metadata, which recommendations
// have been applied, and the job being edited. It lives here because the sheet
// renders from the projection and holds no truth of its own.

let seeded = false;
/** Whether the sheet is on screen. `getJobsState` is only called while it is
 * (iosShell gates the projection on `setJobsOpen`), so a read is the signal it
 * is there and the `closed` action is the signal it went away. It gates the
 * handoff below: a dismissal nobody is present to act on would fire the next
 * time the sheet is opened, which reads as a screen that refuses to stay up. */
let sheetOpen = false;
let run = IDLE;
let lastRun = null;
let applied = new Set();
/** The résumé `applied`/`lastRun` belong to — see the reset in `getJobsState`. */
let appliedFor = null;
/** The open résumé was replaced by sync since `applied` was collected. */
let adoptedSinceApplied = false;
let watchingAdoptions = false;

/**
 * Notice the open résumé being replaced under the sheet.
 *
 * Installed lazily from the projection rather than at import, so a module that
 * merely imports this one does not subscribe to the store as a side effect.
 * `documentAdopted` rather than `change`: `change` fires on every keystroke,
 * and clearing the applied set on each one would grey-out nothing while the
 * person typed.
 */
function watchForAdoptedDocument() {
  if (watchingAdoptions) return;
  watchingAdoptions = true;
  store.subscribe((event) => {
    if (event === 'documentAdopted') adoptedSinceApplied = true;
  });
}
let draft = null;

// The NATIVE editor's half of the sync busy guard.
//
// `OPJobs.swift`'s `JobEditorScreen` keeps title, company and description in
// Swift `@State`, and on iOS the React `JobsDialog` stays mounted with
// `editingJd == null` — so the web dialog's holder speaks for nothing there. A
// job unit adopted mid-edit replaced the list underneath the Swift draft, and
// Save wrote all three stale fields back over the adopted job and stamped the
// overwrite as a new local update.
//
// `draft` is already exactly "a native editor is open with a draft": set by
// `newDraft`/`editDraft`, cleared by `clearDraft`, `saveDraft` and the sheet
// closing. So this needs no new message across the bridge — only to say what
// the module already knows.
registerJobEditHolder({ isBusy: () => draft !== null });
/** One-shot fields. Consumed by the read that puts them on the wire, so they
 * ride exactly one snapshot and cannot fire twice or go stale in a sheet that
 * was closed and reopened an hour later. */
let notice = NO_NOTICE;
let handoff = false;

/**
 * Seed the job-descriptions cache if nothing else has.
 *
 * `getAllJobDescriptions()` reads a module-level array that stays EMPTY until
 * `initJobDescriptions()` runs. main.js seeds it at boot and JobsDialog's mount
 * effect seeds it again, but this projection must not depend on either having
 * happened — the failure is silent, and the symptom is a native list that shows
 * no jobs at all for a user who has twenty. The re-read is against the same
 * store, so a second call is harmless.
 */
function seedOnce() {
  if (seeded) return;
  seeded = true;
  initJobDescriptions();
}

/** Flatten `getAllModels()`'s grouped object, the way buildChatView does. */
function flattenModels() {
  const grouped = getAllModels();
  const flat = [];
  for (const models of Object.values(grouped || {})) {
    for (const m of models || []) flat.push({ id: m.id, label: m.label, group: m.group });
  }
  return flat;
}

/**
 * Read everything the native Jobs sheet renders.
 *
 * Impure by definition — storage, the store, the module state above — and the
 * shaping is left to `buildJobs` so the wire contract stays unit-testable.
 */
export function getJobsState() {
  seedOnce();
  sheetOpen = true;
  const settings = getSettings();
  const variantId = getCurrentId();

  // The web's `reloadAnalysis`, which fires on 'rd:jobs-variant-change': the
  // report itself is per-résumé and re-read below, but the applied set and the
  // run metadata are NOT persisted, and carrying them across a switch would
  // grey out recommendations on a résumé they were never applied to.
  watchForAdoptedDocument();
  // …and an adoption of the résumé ALREADY open, which leaves `variantId`
  // unchanged and so slips past the test above. The projection reads the newly
  // adopted report immediately, and `applied` is a set of INDEXES into the
  // report it was collected from — so an index applied against the old one
  // greys out an unrelated recommendation in the new one, and blocks
  // reapplying the one that actually needs it.
  if (variantId !== appliedFor || adoptedSinceApplied) {
    appliedFor = variantId;
    adoptedSinceApplied = false;
    applied = new Set();
    lastRun = null;
  }

  const consumedNotice = notice;
  notice = NO_NOTICE;
  const consumedHandoff = handoff;
  handoff = false;

  return {
    jobs: getAllJobDescriptions(),
    activeCount: getActiveJobDescriptions().length,
    // The web's own answer to a full disk is a toast, and nothing renders the
    // web's toasts under the native shell — a job added at quota looked saved,
    // stayed in the list all session, and was gone on the next launch.
    saveFailed: jobStorageFailed(),
    configured: getConfiguredProviders().length > 0,
    models: flattenModels(),
    // Seeded from the per-area remembered choice, falling back to the global
    // default the first time, exactly as the two web dialogs seed themselves.
    analysisModelId: validateModelId(settings.analysisModel || settings.defaultModel) || getDefaultModelId(),
    analysisReasoning: settings.analysisReasoning || 'medium',
    tailorModelId: validateModelId(settings.tailorModel || settings.defaultModel) || getDefaultModelId(),
    tailorReasoning: settings.tailorReasoning || 'medium',
    analysis: variantId ? getVariantAnalysis(variantId) : null,
    // WHICH REPORT the recommendations below are, echoed back by Apply and
    // checked there. It has to be published HERE, on the projection the sheet
    // actually reads: the guard first took it from the `document` projection,
    // which is streamed only while the structure sheet is open — and the
    // structure sheet cannot be open, because the Jobs sheet is. So the card
    // sent `-1` every time and Apply refused every time.
    revision: store.documentAdoptions(),
    appliedIndexes: [...applied],
    lastRun,
    run,
    notice: consumedNotice,
    handoff: consumedHandoff,
    draft,
  };
}

/**
 * Project the Jobs screen onto the wire shape the SwiftUI sheet decodes.
 *
 * Pure over what it is handed. Swift decodes this into one `Decodable` struct,
 * so a `null` where it expects an Int fails the WHOLE decode and blanks the
 * entire sheet rather than one row — every value below is coerced rather than
 * trusted, and the three fields that are genuinely absent sometimes (`analysis`,
 * `lastRun`, `draft`) are the only ones that may be null, matching the
 * optionals on the Swift side.
 *
 * A recommendation carries the index it has in `analysis.recommendations` and
 * NOT its position here: the native list groups by impact the way
 * AnalysisResults.jsx does, and Apply is addressed by the original index.
 */
export function buildJobs(state) {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const list = (v) => (Array.isArray(v) ? v : []);
  const text = (v) => (typeof v === 'string' ? v : '');
  const strings = (v) => list(v).map(text).filter(Boolean);
  const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const s = obj(state);
  const analysis = s.analysis && typeof s.analysis === 'object' ? obj(s.analysis) : null;
  const runState = obj(s.run);
  const noticeState = obj(s.notice);
  const draftState = s.draft && typeof s.draft === 'object' ? obj(s.draft) : null;
  const meta = s.lastRun && typeof s.lastRun === 'object' ? obj(s.lastRun) : null;

  return {
    jobs: list(s.jobs)
      // An entry with no id cannot be toggled, edited or deleted, and two blank
      // ones collide as a SwiftUI ForEach identity.
      .filter((j) => j && typeof j.id === 'string' && j.id)
      .map((j) => ({
        id: j.id,
        // The same fallbacks addJobDescription writes, so a row that predates
        // them still reads as something rather than as a blank line.
        title: text(j.title) || 'Untitled Position',
        company: text(j.company) || 'Unknown Company',
        preview: text(j.description).length > PREVIEW_CHARS
          ? `${text(j.description).slice(0, PREVIEW_CHARS)}...`
          : text(j.description),
        // Raw ISO. iOS formats dates in the user's language and calendar, which
        // JobCard's hand-rolled 'today'/'yesterday' cannot.
        dateAdded: text(j.dateAdded),
        isActive: !!j.isActive,
      })),
    activeCount: int(s.activeCount),
    configured: !!s.configured,
    saveFailed: !!s.saveFailed,
    models: list(s.models)
      .filter((m) => m && typeof m.id === 'string' && m.id)
      .map((m) => ({ id: m.id, label: text(m.label) || m.id, group: text(m.group) })),
    analysisModelId: text(s.analysisModelId),
    analysisReasoning: REASONING_EFFORTS.includes(s.analysisReasoning) ? s.analysisReasoning : 'medium',
    tailorModelId: text(s.tailorModelId),
    tailorReasoning: REASONING_EFFORTS.includes(s.tailorReasoning) ? s.tailorReasoning : 'medium',
    analysis: analysis && {
      matchScore: int(analysis.matchScore),
      keywordMatches: strings(analysis.keywordMatches),
      missingKeywords: strings(analysis.missingKeywords),
      strengths: strings(analysis.strengths),
      gaps: list(analysis.gaps).map((g, i) => ({
        id: i,
        area: text(obj(g).area),
        issue: text(obj(g).issue),
        suggestion: text(obj(g).suggestion),
      })),
      recommendations: list(analysis.recommendations).map((r, i) => ({
        index: i,
        impact: ['high', 'medium', 'low'].includes(obj(r).impact) ? obj(r).impact : 'medium',
        section: text(obj(r).section),
        current: text(obj(r).current),
        suggested: text(obj(r).suggested),
        reason: text(obj(r).reason),
        // A hover Tooltip on the web, and therefore unreachable on a phone.
        // It crosses so the sheet can show it as ordinary copy.
        impactReason: text(obj(r).impactReason),
      })),
    },
    revision: int(s.revision),
    appliedIndexes: list(s.appliedIndexes).filter((i) => Number.isInteger(i)),
    lastRun: meta && {
      model: text(meta.model),
      reasoningTokens: int(meta.reasoningTokens),
      promptTokens: int(meta.promptTokens),
      completionTokens: int(meta.completionTokens),
      cost: num(meta.cost),
      webSearch: !!meta.webSearch,
      finishReason: text(meta.finishReason),
    },
    run: {
      busy: !!runState.busy,
      op: runState.op === 'tailor' ? 'tailor' : runState.op === 'analyze' ? 'analyze' : '',
      // The model's raw reasoning summary, unparsed — ReasoningTimeline splits
      // and strips it, the same job LiveReasoning.jsx does on the web. It is
      // also the ONLY live feedback either run produces: neither call wires
      // hooks.onContent, so with reasoning off there is nothing to show.
      reasoning: text(runState.reasoning),
    },
    notice: {
      kind: noticeState.kind === 'error' ? 'error' : noticeState.kind === 'info' ? 'info' : '',
      text: text(noticeState.text),
    },
    handoff: !!s.handoff,
    draft: draftState && {
      // '' means "a new job". Swift echoes it back to `saveDraft` and never
      // invents one.
      id: text(draftState.id),
      title: text(draftState.title),
      company: text(draftState.company),
      description: text(draftState.description),
    },
  };
}

// --- the two AI compositions ------------------------------------------------

/**
 * Analyze the résumé against `jobs`, remember the model choice, and persist the
 * report on the current résumé.
 *
 * Extracted verbatim from JobsDialog.runAnalysis so both shells run the same
 * thing — except for the pin, which it did not have.
 *
 * THE TARGET IS PINNED BEFORE THE AWAIT, as `runTailor` below has always done.
 * Reading `getCurrentId()` afterwards saved the report onto whatever résumé was
 * current when the request returned, and `saveVariantAnalysis` overwrites
 * unconditionally — so switching résumés during an analysis destroyed the other
 * one's stored report and left it showing gaps and scores computed against a
 * document it had never seen.
 *
 * This was carried as a known pre-existing bug on the grounds that fixing it
 * would be a silent desktop change in a commit about the phone. That reason
 * expired: the review of this branch fixed the same shape in `Header.jsx`,
 * `DetailPane.jsx`, `StructurePanel.jsx`, `HistoryDialog.jsx` and
 * `ProfileTabs.jsx`, and the iOS Jobs sheet can be dismissed while the run
 * continues, which makes it easier to reach rather than harder.
 *
 * No existence re-check is needed on the way out, unlike tailoring's: the pin is
 * only used to address the write, and `saveVariantAnalysis` already ignores a
 * variant that has been deleted.
 *
 * The pin is RETURNED as well as used, because pinning the write only fixed
 * where the report is stored. The report also comes back to the caller, and the
 * web dialog set it as its displayed state — so A's recommendations rendered as
 * B's and `applyRec` ran them against B's document. Returning the id lets a
 * caller that shows results decide whether these are still about the résumé in
 * front of the person; the iOS sheet does not need it, because its projection
 * reads `getVariantAnalysis(currentId)` out of storage rather than from here.
 *
 * @param {{jobs: Array, modelId: string, reasoning: string, hooks: object}} params
 * @returns {Promise<{results: object, variantId: string|null}>} the parsed
 *   analysis and the résumé it was run against
 */
export async function runJobAnalysis({ jobs = [], modelId = '', reasoning = 'medium', hooks = {} } = {}) {
  const model = modelId || getSettings().defaultModel || getDefaultModelId();
  const reasoningEffort = reasoning || 'medium';
  saveSettings({ analysisModel: model, analysisReasoning: reasoningEffort });
  const variantId = getCurrentId();
  // The DOCUMENT as well as the résumé. Pinning the id stops the report landing
  // on a different résumé; it says nothing about the same résumé being replaced
  // underneath the request, which `adoptDocument` does — and the report was
  // computed against the copy that has just been thrown away. Saving it then
  // overwrites the adopted résumé's own report with recommendations about text
  // nobody has, and applying one writes that text back over what arrived.
  const adoptions = store.documentAdoptions();
  const results = await analyzeAgainstJobs(model, jobs, { reasoningEffort, hooks });
  if (store.documentAdoptions() !== adoptions) {
    return { results: null, variantId: null, superseded: true };
  }
  if (variantId && results) saveVariantAnalysis(variantId, results);
  return { results, variantId: variantId || null, superseded: false };
}

/**
 * Tailor the whole résumé for the ACTIVE jobs and return the change set.
 *
 * Extracted from JobsDialog.handleTailor, guards included. The two that matter:
 *
 *   - the target résumé is PINNED before the await, and the pin is re-checked
 *     against `getVariants()` after it. Otherwise `recordTailorDrafts` creates
 *     application records for a résumé that was deleted mid-run and leaves
 *     orphan timeline lanes that cannot be opened.
 *   - when the user switched résumés mid-run, the pinned one is loaded back
 *     BEFORE the diff is computed, or the change set is built against — and
 *     applied to — the wrong document.
 *
 * Both matter more on a phone, where the sheet is dismissed and résumés are
 * switched far more often than on a desktop.
 *
 * Returns a status and the human sentence that goes with it rather than raising
 * a toast: a toast renders in the webview, which on iOS is behind the native
 * sheet. The web caller toasts the message, the native one projects it, and the
 * copy is written once.
 *
 * @returns {Promise<{status: string, message: string, changeSet: object|null}>}
 */
export async function runTailor({ modelId = '', reasoning = 'medium', hooks = {} } = {}) {
  const activeJDs = getActiveJobDescriptions();
  if (activeJDs.length === 0) {
    return { status: 'no-active-jobs', message: 'Please activate at least one job description', changeSet: null };
  }
  const settings = getSettings();
  const model = modelId || settings.tailorModel || settings.defaultModel || getDefaultModelId();
  const reasoningEffort = reasoning || 'medium';
  saveSettings({ tailorModel: model, tailorReasoning: reasoningEffort });

  const variantId = getCurrentId();
  const variantName = variantId ? getVariants()[variantId]?.name || '' : '';
  // The DOCUMENT as well, exactly as `runJobAnalysis` pins it. The check below
  // asks whether the résumé still EXISTS, which a replacement passes — its id
  // is unchanged — and the changes were generated from the copy that has just
  // been thrown away. The standalone-review adoption handler cannot cover this
  // one either: the review is opened only after this await returns, so at the
  // moment `documentAdopted` fires there is nothing open to close.
  const adoptions = store.documentAdoptions();

  const result = await generateResumeChanges(
    model,
    'Tailor my entire resume for these target jobs. Optimize keywords, adjust the summary, and highlight relevant experience.',
    null,
    { jobDescriptions: activeJDs },
    'tailor',
    { reasoningEffort, hooks },
  );

  if (store.documentAdoptions() !== adoptions) {
    return {
      status: 'variant-changed',
      message: 'This resume changed on another device while the tailoring ran, so it was discarded. Run it again.',
      changeSet: null,
    };
  }
  if (variantId && !Object.hasOwn(getVariants(), variantId)) {
    return {
      status: 'variant-gone',
      message: 'The resume this tailoring was generated for no longer exists.',
      changeSet: null,
    };
  }
  if (variantId) recordTailorDrafts(variantId, variantName, activeJDs);

  if (!result.changes || Object.keys(result.changes).length === 0) {
    return {
      status: 'no-changes',
      message: 'No changes suggested. Your resume may already be well-tailored.',
      changeSet: null,
    };
  }

  let message = '';
  if (variantId && getCurrentId() !== variantId) {
    if (!loadVariant(variantId)) {
      return {
        status: 'variant-gone',
        message: 'The resume this tailoring was generated for no longer exists.',
        changeSet: null,
      };
    }
    message = `Switched back to "${variantName}" to review its tailored changes.`;
  }
  return { status: 'changes', message, changeSet: createChangeSet(store.getData(), result.changes) };
}

// --- the native dispatcher --------------------------------------------------

/** Hooks shared by both runs: the streamed reasoning and the run's metadata. */
function runHooks() {
  return {
    onReasoning: (_delta, full) => { run = { ...run, reasoning: full }; },
    onRun: (meta) => { lastRun = meta; },
  };
}

function startRun(op) {
  run = { busy: true, op, reasoning: '' };
  lastRun = null;
  notice = NO_NOTICE;
}

function startAnalysis({ ids, modelId, reasoning }) {
  const wanted = new Set(ids.split(',').map((id) => id.trim()).filter(Boolean));
  const selected = getAllJobDescriptions().filter((jd) => wanted.has(jd.id));
  if (selected.length === 0) throw new Error('no jobs selected');
  startRun('analyze');
  // A new run invalidates the applied set: the recommendations it greys out
  // belong to the report about to be replaced.
  applied = new Set();
  return runJobAnalysis({ jobs: selected, modelId, reasoning, hooks: runHooks() })
    .then((outcome) => {
      // Discarded rather than shown. Saying nothing here would read as a run
      // that simply produced no findings.
      if (outcome?.superseded) {
        notice = {
          kind: 'error',
          text: 'This résumé changed on another device while the analysis was running, so it was discarded. Run it again.',
        };
      }
    })
    .catch((error) => {
      // The web raises `toast.error` here, which renders in the webview behind
      // the sheet. A failed run that leaves no trace is indistinguishable from
      // one still thinking, so the sheet is told.
      notice = { kind: 'error', text: `Analysis failed: ${error.message}` };
    })
    .finally(() => { run = IDLE; });
}

function startTailor({ modelId, reasoning }) {
  startRun('tailor');
  return runTailor({ modelId, reasoning, hooks: runHooks() })
    .then((outcome) => {
      if (outcome.status !== 'changes') {
        notice = {
          kind: outcome.status === 'no-changes' ? 'info' : 'error',
          text: outcome.message,
        };
        return;
      }
      // The review is the WEB DiffDialog — `showDiffView` dispatches
      // 'rd:open-diff' — and it renders inside the webview, behind the sheet.
      // Nothing dismisses a presented sheet on its own, so the projection
      // carries the handoff and the sheet closes itself onto the dialog. This
      // is deliberately NOT the pendingChanges / ChangeReviewSheet path: tailor
      // goes through diffEngine and DiffDialog, not the inline-changes session,
      // and half-building a second apply route is how someone accepts an edit
      // that was never applied.
      //
      // Only when the sheet is still up. Dismissed mid-run there is nothing
      // covering the dialog, and a handoff left pending would dismiss the sheet
      // the next time it was opened, minutes later, for no visible reason.
      handoff = sheetOpen;
      showDiffView(outcome.changeSet);
    })
    .catch((error) => {
      notice = { kind: 'error', text: `Failed to generate changes: ${error.message}` };
    })
    .finally(() => { run = IDLE; });
}

function applyRecommendation(index, revision) {
  // WHICH REPORT that index counts into. The recommendation list is projected
  // from the résumé's stored analysis, and both travel in the same `resume:<id>`
  // unit — so an adoption replaces the report under the sheet, and the index the
  // tapped card was drawn with now names a different recommendation.
  //
  // Not caught downstream: `applyRecommendationToStore` checks the premise
  // against the DOCUMENT, and the new report's entry at that index was computed
  // against that very document — so it matches, and the wrong suggestion applies
  // cleanly.
  // Required, not optional. Left permissive, a caller that sent no revision at
  // all skipped the check silently — `Number(undefined)` is NaN, which is not
  // an integer — so the guard was one forgotten argument away from not being
  // there, and a test that omitted it passed for that reason rather than for
  // the one it claimed. The only caller is the native sheet.
  const seen = Number(revision);
  if (!Number.isInteger(seen)) throw new Error('applyRecommendation needs the report revision');
  if (seen !== store.documentAdoptions()) {
    notice = {
      kind: 'error',
      text: 'This résumé changed on another device, so that suggestion is out of date. Re-open the analysis.',
    };
    return;
  }
  return applyRecommendationInner(index);
}

function applyRecommendationInner(index) {
  // Read against the CURRENT résumé, which is also the one the projection built
  // the recommendation list from. The index is the position in
  // `analysis.recommendations`, never the impact-sorted position the sheet
  // shows — the projection hands the original index out for exactly this.
  const variantId = getCurrentId();
  const rec = (variantId ? getVariantAnalysis(variantId) : null)?.recommendations?.[index];
  if (!rec || applied.has(index)) return;
  // The shared writer, never a raw `store.update`: an experience match resolves
  // to `experience[i].company`, where a direct write renames a grouped
  // employer's lead alone and splits the run.
  const ok = applyRecommendationToStore(rec.section?.toLowerCase().trim(), rec.current, rec.suggested);
  if (!ok) {
    // Reported rather than thrown. A throw comes back as the dispatcher's
    // `{ok:false}`, which reaches Swift — but it also skips iosShell's
    // publish(), so the sheet would keep its old projection and the reason
    // would never arrive. `applied` is untouched either way, so the row stays
    // on Apply rather than flipping to Applied having changed nothing.
    notice = {
      kind: 'error',
      text: `Could not automatically apply this recommendation to "${rec.section}". Please make this change manually in the resume editor.`,
    };
    return;
  }
  applied = new Set(applied).add(index);
}

/**
 * Perform one action from the native sheet.
 *
 * `action.type` names it and every other value arrives as a String — that is
 * the bridge's convention, so the coercions are here rather than in Swift.
 * Returns a promise ONLY for the two runs; everything else is synchronous, so
 * a rejected guard still reaches iosShell's dispatcher as a throw and comes
 * back to Swift as `{ok:false}`. (An `async` function would swallow that into
 * a rejected promise the dispatcher reports as success.)
 */
export function applyJobs(action) {
  const command = action && typeof action === 'object' ? action : {};
  const str = (v) => String(v ?? '');
  const id = () => {
    const value = str(command.id).trim();
    if (!value) throw new Error('this action needs a job id');
    return value;
  };

  switch (str(command.action)) {
    // Nothing to do: iosShell publishes around every action, and that is the
    // whole point of this one. A run streams its reasoning into module state
    // with no way to publish from here, so the sheet asks for a fresh snapshot
    // while one is in flight.
    case 'refresh':
      return undefined;

    // The sheet went away. The half-finished edit goes with it, and a handoff
    // that raced the dismissal must not be left waiting for a sheet that is no
    // longer there. The `notice` deliberately survives: a run that failed after
    // the sheet was closed is still worth saying the next time it opens.
    case 'closed':
      sheetOpen = false;
      handoff = false;
      draft = null;
      return undefined;

    case 'toggleActive':
      toggleJobDescriptionActive(id());
      return undefined;

    // Unconditional by design — see the note on confirmDestructive at the top.
    case 'deleteJob':
      deleteJobDescription(id());
      return undefined;

    case 'newDraft':
      draft = { id: '', title: '', company: '', description: '' };
      return undefined;

    // The full posting crosses for this one job only, which is why editing is a
    // round trip rather than a field in the list projection.
    case 'editDraft': {
      const jd = getJobDescription(id());
      if (!jd) throw new Error('that job no longer exists');
      draft = {
        id: jd.id,
        title: str(jd.title),
        company: str(jd.company),
        description: str(jd.description),
      };
      return undefined;
    }

    // The clipboard READ is native (UIPasteboard) because `navigator.clipboard`
    // in a backgrounded webview has no permission to it; the splitting is the
    // web's own parser.
    case 'pasteDraft': {
      const parsed = parseJobDescriptionText(str(command.text));
      draft = { id: draft?.id ?? '', ...parsed };
      return undefined;
    }

    case 'clearDraft':
      draft = null;
      return undefined;

    case 'saveDraft': {
      const description = str(command.description).trim();
      // The web's `addError` guard and JobEditDialog's silent no-op, kept: an
      // empty posting is nothing to analyze against and must not be stored.
      if (!description) throw new Error('a job description is required');
      const fields = {
        title: str(command.title).trim() || 'Untitled Position',
        company: str(command.company).trim() || 'Unknown Company',
        description,
      };
      const target = str(command.id).trim();
      if (target) updateJobDescription(target, fields);
      else addJobDescription(fields);
      draft = null;
      return undefined;
    }

    case 'analyze': {
      if (run.busy) return undefined;
      return startAnalysis({
        // A String, like every other payload value: the ids are generated as
        // `jd-<time>-<suffix>` and never contain a comma.
        ids: str(command.ids),
        modelId: str(command.modelId),
        reasoning: REASONING_EFFORTS.includes(command.reasoning) ? command.reasoning : 'medium',
      });
    }

    case 'tailor': {
      if (run.busy) return undefined;
      return startTailor({
        modelId: str(command.modelId),
        reasoning: REASONING_EFFORTS.includes(command.reasoning) ? command.reasoning : 'medium',
      });
    }

    case 'applyRecommendation': {
      const index = Number(command.index);
      if (!Number.isInteger(index) || index < 0) throw new Error('applyRecommendation needs an index');
      applyRecommendation(index, command.revision);
      return undefined;
    }

    default:
      throw new Error(`unknown jobs action: ${str(command.type)}`);
  }
}
