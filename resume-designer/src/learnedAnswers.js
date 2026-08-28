/**
 * Learned Answers Module
 *
 * Q&A pairs the companion extension learns while filling job applications
 * (notice period, work authorization, ...). Keyed by a normalized form of the
 * question so re-asked questions upsert instead of piling up duplicates.
 * Fed back into the AI mapping call as context on later applications.
 *
 * Storage: own appStorage key (array), same pattern as applications.js.
 */

import { generateId } from './store.js';
import { appStorage } from './appStorage.js';
import { storageErrorToast } from './storageToast.js';

const STORAGE_KEY = 'resume-designer-learned-answers';

let answers = [];

/** Lowercase, strip punctuation, collapse whitespace — the upsert key. */
export function normalizeQuestion(q) {
  return String(q ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function save() {
  // Writes during a destructive backup import are blocked centrally by
  // appStorage's restore guard, so there is no per-writer suspension check here.
  try {
    appStorage.setItem(STORAGE_KEY, JSON.stringify(answers));
  } catch (e) {
    console.error('Failed to save learned answers:', e);
    storageErrorToast(
      'Could not save your reusable answers — storage is full. Free up '
      + 'space (delete resumes you no longer need) and try again.',
      { once: true },
    );
  }
}

/**
 * The list inside a stored or fetched value, or `null` when it is not one.
 *
 * `null` rather than `[]` for an unreadable value, because the callers below
 * need opposite answers to it: a BOOT with nothing stored starts empty, while
 * an ADOPTION that cannot read what it was told about must keep the list it
 * has.
 */
function answersIn(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.error('Failed to load learned answers:', e);
    return null;
  }
}

/** Load from storage; self-heal anything that isn't an array to []. */
export function initLearnedAnswers() {
  answers = answersIn(appStorage.getItem(STORAGE_KEY)) ?? [];
  return answers;
}

/**
 * Take the list `applyUnits` has just written to storage.
 *
 * The cache above is this module's whole truth: `saveLearnedAnswer` upserts
 * into it and `save()` serializes THAT array back over the key. So a Q&A list
 * that arrived from another device lasted exactly until the next answer the
 * companion extension learned, which wrote the stale cache over it, stamped the
 * unit, and — the transport legitimately holding the record's change tag,
 * because the page had confirmed the apply — pushed the revert up as a clean,
 * uncontested update. No conflict was raised and the other device's answers were
 * gone. The fourth key with this shape; see src/sync/syncModel.js's KEY_OWNERS
 * for the three before it, and store.adoptDocument for the original.
 *
 * A bare cache swap, with no notification, because this module has no reader to
 * notify: the ONLY consumer is the companion bridge (src/bridge.js →
 * bridgeRoutes.js), which calls `getAllLearnedAnswers()` per request and so sees
 * the corrected list on the next one. There is no dialog, no React subscriber
 * and no native projection of this key — a subscriber list here would have no
 * reader for it. Nor an `isBusy()`: nothing edits an answer live, the bridge's
 * writes are whole upserts that complete synchronously, and there is no draft
 * anywhere for a replacement to interrupt.
 *
 * A value it cannot read leaves the cache alone — absence is never deletion.
 * `landsAsLearnedAnswers` is what stops such a value reaching the key at all.
 */
export function adoptStoredLearnedAnswers() {
  const stored = answersIn(appStorage.getItem(STORAGE_KEY));
  if (!stored) return;
  answers = stored;
}

/**
 * Whether a fetched payload is one this module could adopt — asked by the sync
 * layer BEFORE it writes the key (src/sync/syncModel.js, KEY_OWNERS).
 *
 * The same reader the two above use, so the write and the adoption cannot
 * disagree about what "readable" means. That agreement is the whole point: a
 * payload the adoption refuses but the write accepted sits on disk as garbage,
 * and the next boot's `initLearnedAnswers` degrades it to `[]` — which the first
 * answer learned after that persists and pushes up as a clean, uncontested
 * update. Refusing before the write is what keeps absence from becoming deletion
 * on DISK as well as in memory.
 */
export function landsAsLearnedAnswers(payload) {
  return answersIn(payload) !== null;
}

export function getAllLearnedAnswers() {
  return answers.slice();
}

/** Upsert by normalized question. Throws on empty question/answer. */
export function saveLearnedAnswer(question, answer) {
  const q = String(question ?? '').trim();
  const a = String(answer ?? '').trim();
  if (!q) throw new Error('learned answer needs a question');
  if (!a) throw new Error('learned answer needs an answer');
  const normalized = normalizeQuestion(q);
  const now = new Date().toISOString();
  const existing = answers.find((e) => e.normalized === normalized);
  if (existing) {
    existing.question = q;
    existing.answer = a;
    existing.updatedAt = now;
    save();
    return existing;
  }
  const entry = { id: generateId('ans'), question: q, normalized, answer: a, createdAt: now, updatedAt: now };
  answers.push(entry);
  save();
  return entry;
}

export function deleteLearnedAnswer(id) {
  const before = answers.length;
  answers = answers.filter((e) => e.id !== id);
  if (answers.length !== before) save();
}
