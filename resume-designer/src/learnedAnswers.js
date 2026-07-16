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
  try {
    appStorage.setItem(STORAGE_KEY, JSON.stringify(answers));
  } catch (e) {
    console.error('Failed to save learned answers:', e);
    storageErrorToast(
      'Could not save your learned answers — storage is full. Free up '
      + 'space (delete resumes you no longer need) and try again.',
      { once: true },
    );
  }
}

/** Load from storage; self-heal anything that isn't an array to []. */
export function initLearnedAnswers() {
  try {
    const raw = appStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    answers = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Failed to load learned answers:', e);
    answers = [];
  }
  return answers;
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
