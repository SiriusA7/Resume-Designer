import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GROUNDING_RULES, buildGenerateResumePrompt, parseGeneratedResume,
  chat, generateResumeChanges, analyzeAgainstJobs,
} from '../src/aiService.js';
import { saveSettings } from '../src/persistence.js';
import { store } from '../src/store.js';

// onboardingLogic statically imports resumeParser, whose pdfjs-dist import
// needs browser APIs jsdom doesn't have. tailorResume never touches the
// parser, so stub the module out (same pattern as onboardingSaveQuota.test.js).
vi.mock('../src/resumeParser.js', () => ({
  parseResumeText: vi.fn(),
  parseResumeFile: vi.fn(),
}));
const { tailorResume } = await import('../src/onboardingLogic.js');

describe('GROUNDING_RULES', () => {
  it('forbids inventing facts and metrics', () => {
    expect(GROUNDING_RULES).toMatch(/never invent/i);
    expect(GROUNDING_RULES).toMatch(/placeholder/i);
  });

  it('forbids inflating scope or seniority', () => {
    expect(GROUNDING_RULES).toMatch(/seniority|scope/i);
  });
});

describe('buildGenerateResumePrompt', () => {
  const prompt = buildGenerateResumePrompt('## User Profile\n- thing', {
    title: 'Designer', company: 'Acme', description: 'Do design.',
  });

  it('embeds the grounding rules', () => {
    expect(prompt).toContain(GROUNDING_RULES);
  });

  it('drops the phrasing that invited invention', () => {
    expect(prompt).not.toMatch(/BEST possible resume/);
    expect(prompt).not.toMatch(/quantify achievements where possible/i);
  });

  it('asks for a gaps array', () => {
    expect(prompt).toContain('"gaps"');
  });
});

describe('parseGeneratedResume', () => {
  it('separates gaps from resume data', () => {
    const { resume, gaps } = parseGeneratedResume(JSON.stringify({
      name: 'Ada', summary: 'Engineer',
      gaps: [{ requirement: 'Kubernetes', severity: 'high', note: 'Not in profile.' }],
    }));
    expect(resume).toEqual({ name: 'Ada', summary: 'Engineer' });
    expect(resume.gaps).toBeUndefined();
    expect(gaps).toHaveLength(1);
  });

  it('tolerates a response with no gaps field', () => {
    const { resume, gaps } = parseGeneratedResume('{"name":"Ada"}');
    expect(resume.name).toBe('Ada');
    expect(gaps).toEqual([]);
  });

  it('keeps well-formed optional gap fields', () => {
    const { gaps } = parseGeneratedResume(JSON.stringify({
      name: 'Ada',
      gaps: [{ requirement: 'Kubernetes', severity: 'high', note: 'Not in profile.' }],
    }));
    expect(gaps[0]).toMatchObject({ requirement: 'Kubernetes', severity: 'high', note: 'Not in profile.' });
  });

  // GapReport renders `severity` and `note` straight into JSX. A non-string
  // throws "Objects are not valid as a React child", and with no error boundary
  // in the app that blanks the completed-generation screen — losing a resume
  // that generated fine because of a cosmetic field.
  it('drops non-string severity and note so they can never reach JSX', () => {
    const { gaps } = parseGeneratedResume(JSON.stringify({
      name: 'Ada',
      gaps: [
        { requirement: 'Kubernetes', severity: { level: 'high' }, note: ['a', 'b'] },
        { requirement: 'Terraform', severity: 3, note: null },
      ],
    }));
    expect(gaps).toHaveLength(2);
    for (const g of gaps) {
      expect(typeof g.requirement).toBe('string');
      // undefined is what GapReport's `|| 'low'` and `note &&` fallbacks expect.
      for (const field of ['severity', 'note']) {
        expect(g[field] === undefined || typeof g[field] === 'string').toBe(true);
      }
    }
    expect(gaps[0].severity).toBeUndefined();
    expect(gaps[0].note).toBeUndefined();
    expect(gaps[1].severity).toBeUndefined();
  });

  it('still drops gaps whose requirement is not a string', () => {
    const { gaps } = parseGeneratedResume(JSON.stringify({
      name: 'Ada',
      gaps: [{ requirement: { text: 'Kubernetes' }, severity: 'high' }, null, { severity: 'low' }],
    }));
    expect(gaps).toEqual([]);
  });

  it('strips code fences', () => {
    const { resume } = parseGeneratedResume('```json\n{"name":"Ada"}\n```');
    expect(resume.name).toBe('Ada');
  });

  it('throws a clear error on non-JSON', () => {
    // parseGeneratedResume logs the raw response on this path; keep the run
    // output clean without silencing console.error anywhere else.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => parseGeneratedResume('sorry, I cannot')).toThrow(/valid JSON/i);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // JSON.parse succeeds on these, but only an object can be a resume: 'null'
  // used to escape as a raw destructure TypeError, a string/array as a
  // nonsense resume. All must take the same friendly error path.
  it.each(['null', '"a plain string"', '[1, 2, 3]', 'true'])(
    'treats non-object JSON %s as invalid',
    (payload) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => parseGeneratedResume(payload)).toThrow(/valid JSON/i);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );
});

// Four of the five grounding-rule injections live in module-private prompts
// (SYSTEM_PROMPT, CHANGE_GENERATION_PROMPT and JOB_ANALYSIS_PROMPT in
// aiService.js; the tailorResume prompt in onboardingLogic.js), so a refactor
// could silently drop one without failing anything above. Pin them through the
// public entry points: stub fetch, drive each call until it issues its request,
// and assert the grounding contract is inside the captured request body. The
// stubbed response is a 500 — the prompt is fully assembled before the response
// is ever read, and failing fast keeps the stream machinery out of the test.
describe('grounding rules reach every AI entry point', () => {
  const MODEL = 'anthropic/claude-sonnet-4.6';
  const JOB = { title: 'Designer', company: 'Acme', description: 'Do design.' };
  let fetchSpy;

  beforeEach(() => {
    localStorage.clear();
    // aiService logs profile/context chatter via console.log on these paths;
    // keep the run output clean without hiding errors.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    saveSettings({ openrouterKey: 'test-key' });
    fetchSpy = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function capturedBody() {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchSpy.mock.calls[0][1].body);
  }

  function systemMessageOf(body) {
    const system = body.messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    return system.content;
  }

  it('chat() sends the default system prompt with the grounding rules embedded', async () => {
    await expect(chat(MODEL, [{ role: 'user', content: 'Hi' }], false)).rejects.toThrow();

    expect(systemMessageOf(capturedBody())).toContain(GROUNDING_RULES);
  });

  it('generateResumeChanges() sends the change-generation prompt with the rules', async () => {
    store.setData({ name: 'Ada', experience: [], education: [], sections: [] }, true);

    await expect(generateResumeChanges(MODEL, 'Punch up the summary')).rejects.toThrow();

    const system = systemMessageOf(capturedBody());
    // The marker pins WHICH prompt was captured; the rules pin the injection.
    expect(system).toContain('JSON object containing the changes');
    expect(system).toContain(GROUNDING_RULES);
  });

  it('analyzeAgainstJobs() sends the job-analysis prompt with the rules', async () => {
    store.setData({ name: 'Ada', experience: [], education: [], sections: [] }, true);

    await expect(analyzeAgainstJobs(MODEL, [JOB])).rejects.toThrow();

    const system = systemMessageOf(capturedBody());
    expect(system).toContain('ATS');
    expect(system).toContain(GROUNDING_RULES);
  });

  it('tailorResume() embeds the grounding rules in its user prompt', async () => {
    await expect(tailorResume({ name: 'Ada', summary: 'Engineer' }, [JOB])).rejects.toThrow();

    const body = capturedBody();
    const user = body.messages.find((m) => m.role === 'user');
    expect(user.content).toContain('HIGHLIGHTS');
    expect(user.content).toContain(GROUNDING_RULES);
  });
});
