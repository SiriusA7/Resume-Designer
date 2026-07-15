// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import {
  initLearnedAnswers, getAllLearnedAnswers, saveLearnedAnswer,
  deleteLearnedAnswer, normalizeQuestion,
} from '../src/learnedAnswers.js';

const KEY = 'resume-designer-learned-answers';

beforeEach(() => {
  localStorage.clear();
  initLearnedAnswers();
});

describe('normalizeQuestion', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeQuestion('  What is your  Notice Period?! ')).toBe('what is your notice period');
  });
  it('handles empty and non-string input', () => {
    expect(normalizeQuestion('')).toBe('');
    expect(normalizeQuestion(null)).toBe('');
  });
});

describe('saveLearnedAnswer', () => {
  it('adds a new answer with id and timestamps', () => {
    const entry = saveLearnedAnswer('Notice period?', '4 weeks');
    expect(entry.id).toBeTruthy();
    expect(entry.question).toBe('Notice period?');
    expect(entry.normalized).toBe('notice period');
    expect(entry.answer).toBe('4 weeks');
    expect(entry.createdAt).toBeTruthy();
    expect(getAllLearnedAnswers()).toHaveLength(1);
  });

  it('upserts by normalized question instead of duplicating', () => {
    const first = saveLearnedAnswer('Notice period?', '4 weeks');
    const second = saveLearnedAnswer('notice PERIOD', '2 weeks');
    expect(getAllLearnedAnswers()).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(getAllLearnedAnswers()[0].answer).toBe('2 weeks');
  });

  it('persists across reload', () => {
    saveLearnedAnswer('Work authorization?', 'US citizen');
    initLearnedAnswers(); // fresh boot re-reads storage
    expect(getAllLearnedAnswers()).toHaveLength(1);
    expect(getAllLearnedAnswers()[0].answer).toBe('US citizen');
  });

  it('rejects empty question or answer', () => {
    expect(() => saveLearnedAnswer('', 'x')).toThrow();
    expect(() => saveLearnedAnswer('q', '')).toThrow();
  });
});

describe('initLearnedAnswers — stored shapes', () => {
  it('self-heals a corrupt store to an empty list', () => {
    localStorage.setItem(KEY, '{"not":"an array"}');
    initLearnedAnswers();
    expect(getAllLearnedAnswers()).toEqual([]);
  });
});

describe('deleteLearnedAnswer', () => {
  it('removes by id', () => {
    const { id } = saveLearnedAnswer('Pronouns?', 'they/them');
    deleteLearnedAnswer(id);
    expect(getAllLearnedAnswers()).toEqual([]);
  });
});
