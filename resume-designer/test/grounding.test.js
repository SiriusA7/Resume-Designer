import { describe, it, expect } from 'vitest';
import { GROUNDING_RULES, buildGenerateResumePrompt } from '../src/aiService.js';

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
