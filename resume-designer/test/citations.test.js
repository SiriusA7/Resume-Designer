import { describe, it, expect } from 'vitest';

import { normalizeCitations } from '../src/components/chat/citations.js';

describe('normalizeCitations', () => {
  it('reads the documented nested OpenRouter shape', () => {
    const out = normalizeCitations([
      { type: 'url_citation', url_citation: { url: 'https://a.com', title: 'A' } },
    ]);
    expect(out).toEqual([{ url: 'https://a.com', title: 'A' }]);
  });

  it('still reads a flattened shape', () => {
    const out = normalizeCitations([{ type: 'url_citation', url: 'https://b.com', title: 'B' }]);
    expect(out).toEqual([{ url: 'https://b.com', title: 'B' }]);
  });

  it('defaults a missing title to an empty string', () => {
    const out = normalizeCitations([{ type: 'url_citation', url_citation: { url: 'https://c.com' } }]);
    expect(out).toEqual([{ url: 'https://c.com', title: '' }]);
  });

  it('drops non-url_citation, url-less, and null entries', () => {
    const out = normalizeCitations([
      { type: 'file_citation', url: 'https://x.com' },
      { type: 'url_citation' },
      { type: 'url_citation', url_citation: {} },
      null,
    ]);
    expect(out).toEqual([]);
  });

  it('handles missing/empty input', () => {
    expect(normalizeCitations(undefined)).toEqual([]);
    expect(normalizeCitations([])).toEqual([]);
  });
});
