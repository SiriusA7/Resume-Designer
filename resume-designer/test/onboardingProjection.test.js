import { describe, it, expect } from 'vitest';
import { buildOnboarding, buildSnapshot } from '../src/iosShell.js';

/**
 * The wizard's projection. One component serves both first-run onboarding and
 * the header's "New resume", so the only thing that differs is
 * `isNewResumeMode` — and the step counter, which is the visible consequence.
 */

const QUESTIONS = [
  { id: 'name', question: "What's your full name?", type: 'text' },
  { id: 'summary', question: 'Tell me about yourself.', type: 'textarea', aiAssist: true },
];

describe('buildOnboarding', () => {
  it('counts six steps on a first run and five in new-resume mode', () => {
    // First run starts at the API-key step and shows it as step 1 of 6.
    const first = buildOnboarding({ open: true, step: 0 });
    expect([first.displayStep, first.totalSteps]).toEqual([1, 6]);

    // New-resume mode starts at step 1 (choose path) and calls it 1 of 5,
    // because the key step it skipped is not counted either.
    const again = buildOnboarding({ open: true, step: 1, isNewResumeMode: true });
    expect([again.displayStep, again.totalSteps]).toEqual([1, 5]);
  });

  it('never lets the counter run past the total', () => {
    for (const isNewResumeMode of [false, true]) {
      for (let step = 0; step <= 5; step += 1) {
        const p = buildOnboarding({ open: true, step, isNewResumeMode });
        expect(p.displayStep).toBeLessThanOrEqual(p.totalSteps);
      }
    }
  });

  it('does not carry the API key, only whether one is set', () => {
    const p = buildOnboarding({ open: true, hasKey: true, openrouterKey: 'sk-or-secret' });
    expect(p.hasKey).toBe(true);
    expect(JSON.stringify(p)).not.toContain('sk-or-secret');
  });

  it('rejects a mode it does not know', () => {
    expect(buildOnboarding({ mode: 'job' }).mode).toBe('job');
    expect(buildOnboarding({ mode: 'sideways' }).mode).toBe('');
    expect(buildOnboarding({}).mode).toBe('');
  });

  it('distinguishes "no file picked" from "a file with no text in it"', () => {
    // null selects the import screen; '' selects the preview screen showing an
    // empty extraction, which is a real outcome for a scanned PDF.
    expect(buildOnboarding({}).filePreview).toBe(null);
    expect(buildOnboarding({ filePreview: '' }).filePreview).toBe('');
  });

  it('carries the current question and the answer already given for it', () => {
    const p = buildOnboarding({
      questions: QUESTIONS, question: 1, answers: { name: 'Ash', summary: 'Designer.' },
    });
    expect(p.question).toBe(1);
    expect(p.answer).toBe('Designer.');
    expect(p.questions[1]).toEqual({
      id: 'summary', question: 'Tell me about yourself.', multiline: true, aiAssist: true,
    });
    expect(p.questions[0].multiline).toBe(false);
    expect(p.questions[0].aiAssist).toBe(false);
  });

  it('clamps a question index that is out of range rather than reading undefined', () => {
    const p = buildOnboarding({ questions: QUESTIONS, question: 9, answers: { summary: 'x' } });
    expect(p.question).toBe(1);
    expect(p.answer).toBe('x');
    expect(buildOnboarding({ questions: [], question: 3 }).question).toBe(0);
  });

  it('marks the resume tailored exactly when a job description was gathered', () => {
    expect(buildOnboarding({}).isTailored).toBe(false);
    expect(buildOnboarding({ jobDescriptions: [{ title: 'Designer' }] }).isTailored).toBe(true);
  });

  it('fills in the same job placeholders the web flow uses', () => {
    const [jd] = buildOnboarding({ jobDescriptions: [{ description: 'Do the thing' }] })
      .jobDescriptions;
    expect(jd).toEqual({
      title: 'Untitled Position', company: 'Unknown Company', description: 'Do the thing',
    });
  });

  it('drops models with no id, which cannot be selected', () => {
    const p = buildOnboarding({
      models: [{ id: 'a/b', label: 'B', group: 'A' }, { label: 'orphan' }],
    });
    expect(p.models).toEqual([{ id: 'a/b', label: 'B', group: 'A' }]);
  });

  it('labels a model by its id when it has no label of its own', () => {
    expect(buildOnboarding({ models: [{ id: 'custom/slug' }] }).models[0].label)
      .toBe('custom/slug');
  });

  it('reports generation progress only while there is a run to report', () => {
    expect(buildOnboarding({}).generating).toBe(null);
    expect(buildOnboarding({ generating: { phase: 'drafting', elapsed: 12 } }).generating)
      .toEqual({ phase: 'drafting', reasoning: '', elapsed: 12, done: false });
  });

  it('survives an entirely empty call', () => {
    const p = buildOnboarding();
    expect(p.open).toBe(false);
    expect(p.questions).toEqual([]);
    expect(p.jobDescriptions).toEqual([]);
    expect(p.answer).toBe('');
  });
});

describe('buildSnapshot', () => {
  it('carries onboarding on the wire', () => {
    // buildSnapshot DECLARES the wire shape: a projection missing from its
    // return is built, published and decoded correctly everywhere else and
    // still never arrives. That has happened twice on this bridge.
    const wizard = buildOnboarding({ open: true, step: 2, mode: 'import' });
    expect(buildSnapshot({ onboarding: wizard }).onboarding).toBe(wizard);
  });

  it('defaults it to null, meaning "not open, do not render"', () => {
    expect(buildSnapshot({}).onboarding).toBe(null);
  });
});
