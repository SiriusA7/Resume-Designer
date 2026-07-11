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
 * Initialize applications from storage. Self-heals an id-keyed object map to
 * the array shape this module requires (same legacy hazard jobDescriptions
 * hit) and degrades garbage to an empty list.
 */
export function initApplications() {
  try {
    const stored = appStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      applications = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' ? Object.values(parsed) : []);
    } else {
      applications = [];
    }
  } catch (e) {
    console.error('Failed to load applications:', e);
    applications = [];
  }
  notify();
  return applications;
}

function save() {
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
 * 'prepared' stamps appliedAt once (terminal states imply it was sent too).
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
