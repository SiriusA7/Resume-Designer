/**
 * Applications Module
 *
 * A first-class "application" links a resume variant to a job it was tailored
 * for / sent to, and tracks the outcome through a timestamped status pipeline.
 * Records survive deletion of the variant or job description via the
 * variantName / jobSnapshot copies taken at creation (no foreign keys here).
 *
 * Storage: own appStorage key (array), same pattern as jobDescriptions.js.
 * React reads through subscribeApplications/getApplicationsSnapshot (the same
 * stable-snapshot bridge variantManager uses for useSyncExternalStore).
 */

import { generateId } from './store.js';
import { appStorage } from './appStorage.js';
import { storageErrorToast } from './storageToast.js';

const STORAGE_KEY = 'resume-designer-applications';

export const PIPELINE_STATUSES = ['prepared', 'applied', 'heard_back', 'interview', 'offer'];
export const TERMINAL_STATUSES = ['rejected', 'no_response'];
export const APPLICATION_STATUSES = [...PIPELINE_STATUSES, ...TERMINAL_STATUSES];

export const STATUS_LABELS = {
  prepared: 'Prepared',
  applied: 'Applied',
  heard_back: 'Heard back',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  no_response: 'No response',
};

// In-memory cache of applications
let applications = [];

// --- React external-store bridge (see variantManager.js for the rationale) ---
const subscribers = new Set();
let snapshot = null;

function notify() {
  snapshot = [...applications];
  subscribers.forEach((cb) => cb());
}

export function subscribeApplications(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function getApplicationsSnapshot() {
  if (!snapshot) snapshot = [...applications];
  return snapshot;
}

/**
 * The list inside a stored or fetched value, or `null` when it is not one.
 * Self-heals an id-keyed object map to the array shape this module requires
 * (same legacy hazard jobDescriptions hit).
 *
 * `null` rather than `[]` for an unreadable value, because the callers below
 * need opposite answers to it: a BOOT with nothing stored starts empty, while
 * an ADOPTION that cannot read what it was told about must keep the list it
 * has — see adoptStoredApplications.
 */
function applicationsIn(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return parsed && typeof parsed === 'object' ? Object.values(parsed) : null;
  } catch (e) {
    console.error('Failed to load applications:', e);
    return null;
  }
}

function readStoredApplications() {
  return applicationsIn(appStorage.getItem(STORAGE_KEY));
}

/**
 * Whether a fetched payload is one this module could adopt — asked by the sync
 * layer BEFORE it writes the key (src/sync/syncModel.js, KEY_OWNERS).
 *
 * The same reader `adoptStoredApplications` uses, so the two cannot disagree
 * about what "readable" means. That agreement is the whole point: a payload the
 * adoption refuses but the write accepted sits on disk as garbage, and the next
 * boot's `initApplications` degrades it to `[]` — which the first local save
 * then persists and pushes up as a clean, uncontested update. Refusing before
 * the write is what keeps absence from becoming deletion on DISK as well as in
 * memory.
 */
export function landsAsApplications(payload) {
  return applicationsIn(payload) !== null;
}

/**
 * Initialize applications from storage, degrading garbage to an empty list.
 */
export function initApplications() {
  applications = readStoredApplications() ?? [];
  notify();
  return applications;
}

/**
 * Take the list `applyUnits` has just written to storage.
 *
 * The cache above is this module's whole truth: every mutation edits it and
 * `save()` serializes it back over the key. So an applications list that
 * arrived from another device lasted exactly until the next local change,
 * which wrote the stale cache over it, stamped the unit, and — the transport
 * legitimately holding the record's change tag, because the page had confirmed
 * the apply — pushed the revert up as a clean, uncontested update. No conflict
 * was raised and the other device's records were gone. Same trap as
 * store.adoptDocument's, and the same answer: the owner adopts, rather than
 * being written behind.
 *
 * `notify()` and not merely a cache swap: React reads this module through
 * useSyncExternalStore (hooks/useApplications.js), so a corrected cache with no
 * notification leaves the Library rendering a list that no longer exists.
 *
 * A value it cannot read leaves the cache alone — absence is never deletion,
 * and one malformed remote unit must not empty someone's application history.
 * The list this device holds is then still the one the next local write puts
 * back on disk, so the bad bytes are corrected rather than inherited.
 */
/**
 * The live note draft, if a card has one open — `{ isBusy() }`.
 *
 * The same shape `registerThreadHolder` uses, and needed for the same reason
 * one level down. `DetailPane` seeds its `notes` state from the application and
 * re-seeds it only when the id CHANGES, so a unit adopted for the id already on
 * screen re-rendered the card while the textarea went on showing the pre-sync
 * note — and the next keystroke wrote that stale text back over the adopted
 * one, and stamped the overwrite as a fresh local change.
 *
 * Asked BEFORE the write, like the chat's: a refusal shortens `applied`, the
 * transport forfeits the change tag, and the unit is re-offered once the draft
 * is closed. Nothing is lost by waiting; the note on screen is the only copy of
 * what the person is part-way through typing.
 */
let noteHolder = null;

export function registerApplicationNoteHolder(next) {
  const installed = next && typeof next.isBusy === 'function' ? next : null;
  noteHolder = installed;
  // Cleared only while THIS holder is still the one installed — React mounts a
  // replacement before unmounting the old one, so an unconditional clear in the
  // departing cleanup would deregister the survivor. Same rule, same reason, as
  // registerThreadHolder.
  return () => {
    if (noteHolder === installed) noteHolder = null;
  };
}

export function applicationNoteBusy() {
  return noteHolder?.isBusy?.() === true;
}

export function adoptStoredApplications() {
  const stored = readStoredApplications();
  if (!stored) return;
  applications = stored;
  notify();
}

function save() {
  // Writes during a destructive backup import are blocked centrally by
  // appStorage's restore guard (which replays this write if the restore fails),
  // so there is no per-writer suspension check here.
  try {
    appStorage.setItem(STORAGE_KEY, JSON.stringify(applications));
  } catch (e) {
    console.error('Failed to save applications:', e);
    storageErrorToast(
      'Could not save your application history — storage is full. Free up '
      + 'space (delete resumes you no longer need) and try again.',
      { once: true },
    );
  }
}

export function getAllApplications() {
  return [...applications];
}

export function getApplicationsForVariant(variantId) {
  return applications.filter((a) => a.variantId === variantId);
}

export function getApplication(id) {
  return applications.find((a) => a.id === id) || null;
}

/**
 * Add an application. Defaults to a 'prepared' draft; creating directly at a
 * later status (the manual "Add application" flow) stamps appliedAt too. An
 * optional `appliedAt` backdates that stamp — and the initial statusHistory
 * entry's `at`, so history stays honest — but is ignored for 'prepared'
 * drafts, which have no appliedAt at all. createdAt/updatedAt always reflect
 * when the record itself was created, never the backdated date.
 */
export function addApplication({
  variantId,
  variantName = '',
  jobId = null,
  jobSnapshot = {},
  status = 'prepared',
  notes = '',
  appliedAt,
} = {}) {
  const now = new Date().toISOString();
  const safeStatus = APPLICATION_STATUSES.includes(status) ? status : 'prepared';
  const appliedStamp = safeStatus === 'prepared' ? null : (appliedAt || now);
  const app = {
    id: generateId('app'),
    variantId,
    variantName,
    jobId,
    jobSnapshot: { title: jobSnapshot.title || '', company: jobSnapshot.company || '' },
    status: safeStatus,
    statusHistory: [{ status: safeStatus, at: appliedStamp || now }],
    createdAt: now,
    updatedAt: now,
    appliedAt: appliedStamp,
    notes,
  };
  applications.unshift(app);
  save();
  notify();
  return app;
}

/**
 * Transition an application's status. Appends to statusHistory; any move past
 * 'prepared' stamps appliedAt once (terminal states imply it was sent too),
 * and reverting to 'prepared' clears it — a draft is by definition unsent, and
 * a lingering appliedAt would keep counting the record as sent in the stats.
 */
export function setApplicationStatus(id, status) {
  const app = applications.find((a) => a.id === id);
  if (!app) return null;
  if (!APPLICATION_STATUSES.includes(status) || app.status === status) return app;

  const now = new Date().toISOString();
  app.status = status;
  app.statusHistory = [...(app.statusHistory || []), { status, at: now }];
  app.updatedAt = now;
  if (!app.appliedAt && status !== 'prepared') app.appliedAt = now;
  if (status === 'prepared') app.appliedAt = null;

  save();
  notify();
  return app;
}

/**
 * Patch freeform fields (notes, jobSnapshot, appliedAt…). Managed fields —
 * id, status, statusHistory, createdAt — only change through their own APIs.
 */
export function updateApplication(id, patch = {}) {
  const app = applications.find((a) => a.id === id);
  if (!app) return null;

  const { id: _id, status: _s, statusHistory: _h, createdAt: _c, ...rest } = patch;
  Object.assign(app, rest, { updatedAt: new Date().toISOString() });

  save();
  notify();
  return app;
}

export function deleteApplication(id) {
  const index = applications.findIndex((a) => a.id === id);
  if (index === -1) return false;
  applications.splice(index, 1);
  save();
  notify();
  return true;
}

/**
 * Capture hook for the tailor flow: one 'prepared' draft per job description.
 * A still-prepared draft for the same variant+job is refreshed in place (a
 * re-tailor is not a new application); once it advanced past prepared, a
 * re-tailor is a genuinely new send and gets a new record.
 */
export function recordTailorDrafts(variantId, variantName, jds = []) {
  const now = new Date().toISOString();
  const result = [];
  let touched = false;

  for (const jd of jds) {
    const existing = applications.find(
      (a) => a.variantId === variantId && a.jobId === jd.id && a.status === 'prepared',
    );
    if (existing) {
      existing.variantName = variantName;
      existing.jobSnapshot = { title: jd.title || '', company: jd.company || '' };
      existing.updatedAt = now;
      touched = true;
      result.push(existing);
    } else {
      result.push(addApplication({
        variantId,
        variantName,
        jobId: jd.id,
        jobSnapshot: { title: jd.title, company: jd.company },
      }));
    }
  }

  if (touched) {
    save();
    notify();
  }
  return result;
}
