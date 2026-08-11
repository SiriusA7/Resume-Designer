import { describe, it, expect, beforeEach, vi } from 'vitest';

// The AI calls are the only thing here that would reach the network, and the
// bridge reads its model catalogue from the same module.
vi.mock('../src/aiService.js', () => ({
  analyzeAgainstJobs: vi.fn(),
  generateResumeChanges: vi.fn(),
  getAllModels: () => ({
    OpenAI: [{ id: 'openai/gpt-5.5', label: 'GPT-5.5', group: 'OpenAI' }],
    Anthropic: [{ id: 'anthropic/claude-opus-4.8', label: 'Opus 4.8', group: 'Anthropic' }],
  }),
  getConfiguredProviders: () => ['openrouter'],
  validateModelId: (id) => id || null,
  getDefaultModelId: () => 'openai/gpt-5.5',
}));

// variantManager owns `currentVariantId` in module state and would need the
// whole persistence/render pipeline booted to hold one. The two functions the
// bridge uses are the seam, so they are the seam here too.
let currentId = 'v1';
const loadVariant = vi.fn(() => true);
vi.mock('../src/variantManager.js', () => ({
  getCurrentId: () => currentId,
  loadVariant: (...args) => loadVariant(...args),
}));

const { analyzeAgainstJobs, generateResumeChanges } = await import('../src/aiService.js');
const {
  buildJobs, getJobsState, applyJobs, runTailor,
} = await import('../src/jobsBridge.js');
const { initJobDescriptions, getAllJobDescriptions } = await import('../src/jobDescriptions.js');
const { store } = await import('../src/store.js');

const JOBS_KEY = 'resume-designer-job-descriptions';
const DATA_KEY = 'resume-designer-data';

/** Seed the persistence blob with one résumé, optionally carrying a report. */
function seedStorage({ analysis = null } = {}) {
  localStorage.setItem(DATA_KEY, JSON.stringify({
    variants: { v1: { name: 'Main', data: {}, jobAnalysis: analysis } },
    currentVariantId: 'v1',
    settings: {},
  }));
}

function seedJobs(jobs) {
  localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
  initJobDescriptions();
}

const job = (over = {}) => ({
  id: 'jd-1',
  title: 'Staff Designer',
  company: 'Acme',
  description: 'Ship things.',
  dateAdded: '2026-08-01T10:00:00.000Z',
  dateModified: '2026-08-01T10:00:00.000Z',
  tags: [],
  isActive: true,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  currentId = 'v1';
  seedStorage();
  seedJobs([]);
  store.setData({ name: 'Ash', summary: 'Old summary', experience: [] }, true);
  // The bridge keeps the applied set until the résumé changes, so a read from
  // another one is what drops it. Two reads: the first clears, the second
  // drains the one-shot fields for v1, leaving a projection nobody has seen.
  currentId = 'test-reset';
  getJobsState();
  currentId = 'v1';
  getJobsState();
});

describe('buildJobs — the wire shape', () => {
  it('truncates the posting and never puts the full text in the list', () => {
    const description = 'x'.repeat(400);
    const [row] = buildJobs({ jobs: [job({ description })] }).jobs;
    expect(row.preview).toHaveLength(153); // 150 + the ellipsis
    expect(row.preview.endsWith('...')).toBe(true);
    expect(JSON.stringify(row)).not.toContain(description);
  });

  it('keeps a short posting whole', () => {
    const [row] = buildJobs({ jobs: [job({ description: 'Ship things.' })] }).jobs;
    expect(row.preview).toBe('Ship things.');
  });

  it('names a blank job the way addJobDescription would, and drops one with no id', () => {
    const view = buildJobs({ jobs: [job({ title: '', company: '' }), { title: 'orphan' }] });
    expect(view.jobs).toHaveLength(1);
    expect(view.jobs[0].title).toBe('Untitled Position');
    expect(view.jobs[0].company).toBe('Unknown Company');
  });

  it('leaves analysis, lastRun and draft null when there are none', () => {
    const view = buildJobs({});
    expect(view.analysis).toBeNull();
    expect(view.lastRun).toBeNull();
    expect(view.draft).toBeNull();
    // Swift decodes the rest as non-optional, so none of it may be null.
    expect(view.run).toEqual({ busy: false, op: '', reasoning: '' });
    expect(view.notice).toEqual({ kind: '', text: '' });
    expect(view.jobs).toEqual([]);
  });

  it('clamps the efforts, the run op and the notice kind to what Swift knows', () => {
    const view = buildJobs({
      analysisReasoning: 'xhigh',
      tailorReasoning: 'low',
      run: { busy: true, op: 'nonsense', reasoning: '**Reading**\nthe posting' },
      notice: { kind: 'warning', text: 'hm' },
    });
    expect(view.analysisReasoning).toBe('medium');
    expect(view.tailorReasoning).toBe('low');
    expect(view.run.op).toBe('');
    expect(view.run.reasoning).toBe('**Reading**\nthe posting');
    expect(view.notice.kind).toBe('');
  });

  it('carries each recommendation ORIGINAL index, not its sorted position', () => {
    const view = buildJobs({
      analysis: {
        matchScore: 78.6,
        recommendations: [
          { impact: 'low', section: 'Summary', current: 'a', suggested: 'b' },
          { impact: 'high', section: 'Tools', current: 'c', suggested: 'd' },
        ],
      },
    });
    // Rounded: Swift decodes an Int and a fractional score would fail the whole
    // decode, blanking the sheet rather than the score.
    expect(view.analysis.matchScore).toBe(79);
    expect(view.analysis.recommendations.map((r) => r.index)).toEqual([0, 1]);
    expect(view.analysis.recommendations[1].impact).toBe('high');
  });

  it('defaults an impact the model left off, and keeps impactReason as copy', () => {
    const view = buildJobs({
      analysis: { recommendations: [{ section: 'Summary', impactReason: 'Named in the posting' }] },
    });
    expect(view.analysis.recommendations[0].impact).toBe('medium');
    expect(view.analysis.recommendations[0].impactReason).toBe('Named in the posting');
  });

  it('survives being handed nothing at all', () => {
    expect(() => buildJobs(undefined)).not.toThrow();
    expect(buildJobs(undefined).activeCount).toBe(0);
  });
});

describe('getJobsState — the read', () => {
  it('flattens the grouped model catalogue', () => {
    const view = buildJobs(getJobsState());
    expect(view.models.map((m) => m.id)).toEqual(['openai/gpt-5.5', 'anthropic/claude-opus-4.8']);
    expect(view.models[1].group).toBe('Anthropic');
  });

  it('counts the active jobs and reads the résumé report', () => {
    seedJobs([job(), job({ id: 'jd-2', isActive: false })]);
    seedStorage({ analysis: { matchScore: 40, recommendations: [] } });
    const view = buildJobs(getJobsState());
    expect(view.jobs).toHaveLength(2);
    expect(view.activeCount).toBe(1);
    expect(view.analysis.matchScore).toBe(40);
  });

  it('drops the applied set when the résumé changes underneath the sheet', async () => {
    seedJobs([job()]);
    seedStorage({
      analysis: { recommendations: [{ section: 'summary', current: 'Old summary', suggested: 'New' }] },
    });
    applyJobs({ action: 'applyRecommendation', index: '0' });
    expect(buildJobs(getJobsState()).appliedIndexes).toEqual([0]);

    currentId = 'v2';
    // Nothing persists which recommendations were applied, so carrying them
    // across would grey out rows on a résumé they were never applied to.
    expect(buildJobs(getJobsState()).appliedIndexes).toEqual([]);
  });
});

describe('applyJobs — the actions', () => {
  it('adds a job with the web dialog fallbacks and trimming', () => {
    applyJobs({ action: 'saveDraft', id: '', title: '  ', company: '', description: '  Ship things.  ' });
    const [added] = getAllJobDescriptions();
    expect(added.title).toBe('Untitled Position');
    expect(added.company).toBe('Unknown Company');
    expect(added.description).toBe('Ship things.');
    expect(added.isActive).toBe(true);
  });

  it('refuses to store a job with no posting', () => {
    expect(() => applyJobs({ action: 'saveDraft', id: '', title: 'PM', description: '   ' })).toThrow();
    expect(getAllJobDescriptions()).toHaveLength(0);
  });

  it('updates in place when the draft carries an id', () => {
    seedJobs([job()]);
    applyJobs({ action: 'saveDraft', id: 'jd-1', title: 'Principal Designer', company: 'Acme', description: 'Ship more.' });
    expect(getAllJobDescriptions()).toHaveLength(1);
    expect(getAllJobDescriptions()[0].title).toBe('Principal Designer');
  });

  it('deletes unconditionally — the confirmation is the native sheet', () => {
    seedJobs([job(), job({ id: 'jd-2' })]);
    applyJobs({ action: 'deleteJob', id: 'jd-1' });
    expect(getAllJobDescriptions().map((j) => j.id)).toEqual(['jd-2']);
  });

  it('toggles active', () => {
    seedJobs([job()]);
    applyJobs({ action: 'toggleActive', id: 'jd-1' });
    expect(getAllJobDescriptions()[0].isActive).toBe(false);
  });

  it('hands the FULL posting over for the row being edited, and only that one', () => {
    const description = 'y'.repeat(400);
    seedJobs([job({ description }), job({ id: 'jd-2', description })]);
    applyJobs({ action: 'editDraft', id: 'jd-1' });
    const view = buildJobs(getJobsState());
    expect(view.draft.id).toBe('jd-1');
    expect(view.draft.description).toBe(description);
    expect(view.jobs.every((j) => j.preview.length <= 153)).toBe(true);

    applyJobs({ action: 'clearDraft' });
    expect(buildJobs(getJobsState()).draft).toBeNull();
  });

  it('splits a pasted posting with the web parser', () => {
    applyJobs({ action: 'newDraft' });
    applyJobs({ action: 'pasteDraft', text: 'Staff Designer at Acme\nWe need someone to ship.' });
    const { draft } = buildJobs(getJobsState());
    expect(draft.title).toBe('Staff Designer');
    expect(draft.company).toBe('Acme');
    expect(draft.id).toBe('');
  });

  it('throws on an unknown action and on a missing id, so the dispatcher reports it', () => {
    expect(() => applyJobs({ action: 'nope' })).toThrow(/unknown jobs action/);
    expect(() => applyJobs({ action: 'deleteJob', id: '' })).toThrow(/job id/);
  });
});

describe('applyJobs — analyze', () => {
  beforeEach(() => {
    seedJobs([job(), job({ id: 'jd-2', title: 'PM', isActive: false })]);
  });

  it('splits the comma-separated ids and analyses exactly those jobs', async () => {
    analyzeAgainstJobs.mockResolvedValue({ matchScore: 71, recommendations: [] });
    const pending = applyJobs({
      action: 'analyze', ids: 'jd-1,jd-2', modelId: 'openai/gpt-5.5', reasoning: 'high',
    });
    // Busy from the moment the action returns — iosShell publishes there, and
    // that first publish is what puts the progress block on screen.
    expect(buildJobs(getJobsState()).run).toEqual({ busy: true, op: 'analyze', reasoning: '' });
    await pending;

    const [model, jobs, options] = analyzeAgainstJobs.mock.calls[0];
    expect(model).toBe('openai/gpt-5.5');
    expect(jobs.map((j) => j.id)).toEqual(['jd-1', 'jd-2']);
    expect(options.reasoningEffort).toBe('high');
    // Persisted onto the résumé, which is where the projection re-reads it.
    expect(buildJobs(getJobsState()).analysis.matchScore).toBe(71);
    expect(buildJobs(getJobsState()).run.busy).toBe(false);
  });

  it('refuses an empty selection', () => {
    expect(() => applyJobs({ action: 'analyze', ids: ' , ' })).toThrow(/no jobs selected/);
  });

  it('streams the reasoning through the projection', async () => {
    analyzeAgainstJobs.mockImplementation(async (_model, _jobs, options) => {
      options.hooks.onReasoning('ing', 'Reading the posting');
      options.hooks.onRun({ model: 'openai/gpt-5.5', promptTokens: 10, completionTokens: 5, cost: 0.01 });
      expect(buildJobs(getJobsState()).run.reasoning).toBe('Reading the posting');
      return { matchScore: 1, recommendations: [] };
    });
    await applyJobs({ action: 'analyze', ids: 'jd-1' });
    expect(buildJobs(getJobsState()).lastRun.promptTokens).toBe(10);
  });

  it('says a failure out loud — a toast would render behind the sheet', async () => {
    analyzeAgainstJobs.mockRejectedValue(new Error('rate limited'));
    await applyJobs({ action: 'analyze', ids: 'jd-1' });
    const view = buildJobs(getJobsState());
    expect(view.notice).toEqual({ kind: 'error', text: 'Analysis failed: rate limited' });
    expect(view.run.busy).toBe(false);
  });

  it('sends a notice exactly once', async () => {
    analyzeAgainstJobs.mockRejectedValue(new Error('rate limited'));
    await applyJobs({ action: 'analyze', ids: 'jd-1' });
    expect(buildJobs(getJobsState()).notice.text).not.toBe('');
    // Consumed by the read that put it on the wire: the sheet latches it, and a
    // stale one must not resurface when the sheet is reopened an hour later.
    expect(buildJobs(getJobsState()).notice.text).toBe('');
  });
});

describe('applyJobs — applying a recommendation', () => {
  it('applies by the ORIGINAL index and remembers it', () => {
    seedStorage({
      analysis: {
        recommendations: [
          { section: 'summary', current: 'Old summary', suggested: 'Tailored summary' },
        ],
      },
    });
    applyJobs({ action: 'applyRecommendation', index: '0' });
    expect(store.getData().summary).toBe('Tailored summary');
    expect(buildJobs(getJobsState()).appliedIndexes).toEqual([0]);
  });

  it('does NOT mark one applied when the writer could not place it', () => {
    seedStorage({
      analysis: {
        recommendations: [{ section: 'Portfolio flair', current: 'nope', suggested: 'still nope' }],
      },
    });
    applyJobs({ action: 'applyRecommendation', index: '0' });
    const view = buildJobs(getJobsState());
    expect(view.appliedIndexes).toEqual([]);
    expect(view.notice.kind).toBe('error');
    expect(view.notice.text).toContain('Portfolio flair');
  });

  it('rejects an index that is not one', () => {
    expect(() => applyJobs({ action: 'applyRecommendation', index: 'first' })).toThrow(/index/);
  });
});

describe('runTailor — the guards around the long await', () => {
  beforeEach(() => {
    seedJobs([job()]);
  });

  it('refuses when nothing is active', async () => {
    seedJobs([job({ isActive: false })]);
    const outcome = await runTailor({});
    expect(outcome.status).toBe('no-active-jobs');
    expect(generateResumeChanges).not.toHaveBeenCalled();
  });

  it('bails when the pinned résumé was deleted mid-run, before recording drafts', async () => {
    generateResumeChanges.mockImplementation(async () => {
      // The Library can delete it while the request is in flight — on a phone
      // the sheet is dismissed and résumés switched far more often.
      localStorage.setItem(DATA_KEY, JSON.stringify({ variants: {}, currentVariantId: null, settings: {} }));
      return { changes: { summary: 'Tailored' } };
    });
    const outcome = await runTailor({ modelId: 'openai/gpt-5.5' });
    expect(outcome.status).toBe('variant-gone');
    expect(outcome.changeSet).toBeNull();
  });

  it('loads the pinned résumé back when the user switched mid-run', async () => {
    generateResumeChanges.mockImplementation(async () => {
      currentId = 'v2';
      return { changes: { summary: 'Tailored' } };
    });
    const outcome = await runTailor({ modelId: 'openai/gpt-5.5' });
    expect(loadVariant).toHaveBeenCalledWith('v1');
    expect(outcome.status).toBe('changes');
    expect(outcome.message).toContain('Switched back');
  });

  it('reports "no changes" rather than opening an empty review', async () => {
    generateResumeChanges.mockResolvedValue({ changes: {} });
    const outcome = await runTailor({});
    expect(outcome.status).toBe('no-changes');
    expect(outcome.message).toMatch(/No changes suggested/);
  });
});

describe('applyJobs — tailor', () => {
  it('hands the review to the web dialog and asks the sheet to get out of the way', async () => {
    seedJobs([job()]);
    generateResumeChanges.mockResolvedValue({ changes: { summary: 'Tailored' } });
    const opened = vi.fn();
    window.addEventListener('rd:open-diff', opened);

    await applyJobs({ action: 'tailor', modelId: 'openai/gpt-5.5', reasoning: 'medium' });

    expect(opened).toHaveBeenCalledTimes(1);
    const view = buildJobs(getJobsState());
    expect(view.handoff).toBe(true);
    // One-shot, like the notice: reopening the sheet must not dismiss it again.
    expect(buildJobs(getJobsState()).handoff).toBe(false);
    window.removeEventListener('rd:open-diff', opened);
  });

  it('does not ask a sheet that was already dismissed to dismiss itself', async () => {
    seedJobs([job()]);
    generateResumeChanges.mockResolvedValue({ changes: { summary: 'Tailored' } });
    const pending = applyJobs({ action: 'tailor' });
    // Swiped away while the request was in flight. Nothing is covering the diff
    // dialog now, and a pending handoff would dismiss the sheet the next time it
    // was opened for no visible reason.
    applyJobs({ action: 'closed' });
    await pending;
    expect(buildJobs(getJobsState()).handoff).toBe(false);
  });

  it('shows a failed run instead of leaving the sheet looking idle', async () => {
    seedJobs([job()]);
    generateResumeChanges.mockRejectedValue(new Error('model unavailable'));
    await applyJobs({ action: 'tailor' });
    const view = buildJobs(getJobsState());
    expect(view.notice).toEqual({ kind: 'error', text: 'Failed to generate changes: model unavailable' });
    expect(view.run.busy).toBe(false);
  });
});

describe('buildJobs — a write that did not land', () => {
  // The web's answer to a full disk is a toast, and nothing renders the web's
  // toasts under the native shell: the job stayed in the list all session and
  // was gone on the next launch. Same projection the profile sheet uses.
  it('carries the failure so the sheet can say so', () => {
    expect(buildJobs({ saveFailed: true }).saveFailed).toBe(true);
  });

  it('is false when the write landed, and for a state that never said', () => {
    expect(buildJobs({ saveFailed: false }).saveFailed).toBe(false);
    expect(buildJobs({}).saveFailed).toBe(false);
    expect(buildJobs(undefined).saveFailed).toBe(false);
  });
});
