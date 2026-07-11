// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

import { flattenResumeText, makeSnippet, searchLibrary } from '../src/librarySearch.js';

const resumeData = {
  name: 'Ash Shah',
  tagline: 'Product Designer',
  contact: { email: 'a@b.c', location: 'NYC' },
  summary: 'Designer who ships.',
  sections: [
    { id: 's1', title: 'Skills', type: 'list', content: ['Figma', 'Kubernetes'] },
    { id: 's2', title: 'About', type: 'text', content: 'Loves systems.' },
  ],
  experience: [
    { id: 'e1', title: 'Design Lead', company: 'Acme', dates: '2020–2024', bullets: ['Led a team of 5', 'Shipped the flagship app'] },
  ],
  education: ['BFA — RISD — 2016'],
  tools: 'Figma • Blender',
};

const variants = [
  { id: 'v1', name: 'Stripe PM resume', data: resumeData },
  { id: 'v2', name: 'General resume', data: { ...resumeData, name: 'Ash', sections: [], experience: [] } },
];

const applications = [
  { id: 'app-1', variantId: 'v2', jobId: 'jd-1', jobSnapshot: { title: 'Platform PM', company: 'Linear' }, status: 'applied' },
];

const jobDescriptions = [
  { id: 'jd-1', title: 'Platform PM', company: 'Linear', description: 'Own the roadmap for realtime sync.' },
];

const threads = [
  { id: 't1', homeVariantId: 'v1', messages: [{ role: 'user', content: 'emphasize my Kubernetes work please' }] },
];

describe('flattenResumeText', () => {
  it('includes name, sections (list + text), experience bullets, education, tools', () => {
    const text = flattenResumeText(resumeData);
    for (const needle of ['Ash Shah', 'Kubernetes', 'Loves systems.', 'Led a team of 5', 'RISD', 'Blender']) {
      expect(text).toContain(needle);
    }
  });

  it('handles null data', () => {
    expect(flattenResumeText(null)).toBe('');
  });
});

describe('makeSnippet', () => {
  it('returns a trimmed window around the match with ellipses', () => {
    const text = `${'x'.repeat(100)} the Kubernetes migration ${'y'.repeat(100)}`;
    const snip = makeSnippet(text, 'kubernetes');
    expect(snip).toContain('Kubernetes migration');
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
  });

  it('returns null when there is no match', () => {
    expect(makeSnippet('nothing here', 'kubernetes')).toBeNull();
  });
});

describe('searchLibrary — quick tier', () => {
  it('empty query returns all variants in order', () => {
    const res = searchLibrary('', { variants, applications });
    expect(res.map((r) => r.variantId)).toEqual(['v1', 'v2']);
  });

  it('matches variant name', () => {
    const res = searchLibrary('stripe', { variants, applications });
    expect(res.map((r) => r.variantId)).toEqual(['v1']);
    expect(res[0].quickHit).toBe(true);
  });

  it('matches linked application company via jobSnapshot', () => {
    const res = searchLibrary('linear', { variants, applications });
    expect(res.map((r) => r.variantId)).toEqual(['v2']);
  });

  it('does NOT match resume content when deep is off', () => {
    expect(searchLibrary('kubernetes', { variants, applications })).toEqual([]);
  });
});

describe('searchLibrary — deep tier', () => {
  const ctx = { variants, applications, jobDescriptions, threads, deep: true };

  it('finds hits inside resume content with a snippet', () => {
    const res = searchLibrary('kubernetes', ctx);
    const v1 = res.find((r) => r.variantId === 'v1');
    expect(v1.deepHits.some((h) => h.source === 'resume' && h.snippet.includes('Kubernetes'))).toBe(true);
  });

  it('finds hits inside linked job description text', () => {
    const res = searchLibrary('realtime sync', ctx);
    expect(res.map((r) => r.variantId)).toEqual(['v2']);
    expect(res[0].deepHits[0].source).toBe('job');
  });

  it('finds hits inside that variant\'s chat threads', () => {
    const res = searchLibrary('emphasize my', ctx);
    const v1 = res.find((r) => r.variantId === 'v1');
    expect(v1.deepHits.some((h) => h.source === 'chat')).toBe(true);
  });

  it('a quick hit still reports quickHit alongside deepHits', () => {
    const res = searchLibrary('stripe', ctx);
    expect(res[0].quickHit).toBe(true);
  });
});
