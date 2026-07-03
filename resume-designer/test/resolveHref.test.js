import { describe, it, expect } from 'vitest';

import { resolveHref } from '../src/components/ui/resolveHref.js';

// Matches CHANGELOG_LINK_BASE — a /blob/main/ base so bare-relative file links
// resolve to valid GitHub file routes.
const BASE = 'https://github.com/ashproto/Resume-Designer/blob/main/';

describe('resolveHref', () => {
  it('passes absolute http(s)/mailto/tel through unchanged', () => {
    expect(resolveHref('https://x.com/a', BASE)).toBe('https://x.com/a');
    expect(resolveHref('http://x.com', BASE)).toBe('http://x.com');
    expect(resolveHref('mailto:a@b.com', BASE)).toBe('mailto:a@b.com');
    expect(resolveHref('tel:+15551234', BASE)).toBe('tel:+15551234');
  });

  it('leaves in-page fragments alone', () => {
    expect(resolveHref('#section', BASE)).toBe('#section');
  });

  it('resolves a bare-relative file link to a GitHub blob route', () => {
    expect(resolveHref('README.md', BASE)).toBe('https://github.com/ashproto/Resume-Designer/blob/main/README.md');
    expect(resolveHref('docs/foo.md', BASE)).toBe('https://github.com/ashproto/Resume-Designer/blob/main/docs/foo.md');
  });

  it('resolves a root-relative link against the base origin (not the blob path)', () => {
    expect(resolveHref('/ashproto/other', BASE)).toBe('https://github.com/ashproto/other');
  });

  it('neutralizes a relative link when no base is given', () => {
    expect(resolveHref('docs/foo.md', undefined)).toBeNull();
    expect(resolveHref('/x', '')).toBeNull();
  });

  it('returns falsy hrefs unchanged', () => {
    expect(resolveHref('', BASE)).toBe('');
    expect(resolveHref(undefined, BASE)).toBe(undefined);
  });
});
