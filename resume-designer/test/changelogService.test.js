import { describe, it, expect } from 'vitest';

import {
  justUpdated,
  mergeReleases,
  normalizeRelease,
  splitReleaseBody,
} from '../src/changelogService.js';

describe('justUpdated', () => {
  it('true when the seen version differs from current', () => {
    expect(justUpdated('1.2.0', '1.3.0')).toBe(true);
  });
  it('false on first run (no seen version)', () => {
    expect(justUpdated(null, '1.3.0')).toBe(false);
    expect(justUpdated(undefined, '1.3.0')).toBe(false);
  });
  it('false when unchanged', () => {
    expect(justUpdated('1.3.0', '1.3.0')).toBe(false);
  });
});

describe('normalizeRelease', () => {
  it('maps a GitHub release payload to {version,date,summary,full}', () => {
    const r = normalizeRelease({
      tag_name: 'v1.3.0',
      published_at: '2026-07-01T00:00:00Z',
      body: '## x\n- feat: a',
    });
    expect(r.version).toBe('1.3.0');
    expect(r.date).toBe('2026-07-01T00:00:00Z');
    expect(r.summary).toBe('## x\n- feat: a');
    expect(r.full).toBe('## x\n- feat: a');
  });
  it('strips a leading v and tolerates a missing body', () => {
    const r = normalizeRelease({ tag_name: '1.4.0', published_at: null, body: null });
    expect(r.version).toBe('1.4.0');
    expect(r.summary).toBe('');
  });
  it('prefers the version stamped in the body heading over the tag (beta/next releases)', () => {
    const r = normalizeRelease({
      tag_name: 'next',
      published_at: '2026-07-01T00:00:00Z',
      body: '## On Paper 1.2.3-next.7\n- feat: beta thing',
    });
    expect(r.version).toBe('1.2.3-next.7');
  });
  it('falls back to the tag when the body has no version heading', () => {
    const r = normalizeRelease({ tag_name: 'v1.6.0', body: 'Just some notes without our heading' });
    expect(r.version).toBe('1.6.0');
  });
  // The rename ("Resume Designer" → "On Paper") splits the published release
  // history in two, and this parser reads ALL of it off the GitHub API. Both
  // headings must keep resolving, permanently and in both directions:
  // pre-rename builds must parse new releases, and new builds must parse the
  // pre-rename back-catalogue.
  it('reads the version from an "On Paper" heading', () => {
    const r = normalizeRelease({
      tag_name: 'next',
      published_at: '2026-07-01T00:00:00Z',
      body: '## On Paper 2.0.0-next.1\n- feat: renamed thing',
    });
    expect(r.version).toBe('2.0.0-next.1');
  });
  it('still reads the version from a pre-rename "Resume Designer" heading', () => {
    const r = normalizeRelease({ tag_name: 'next', body: '## Resume Designer 1.15.0\n- fix: a' });
    expect(r.version).toBe('1.15.0');
  });
  it('tolerates casing drift in the product name', () => {
    // The digest heading is LLM-authored (release.yml "Rewrite the changelog").
    // validate-digest.mjs rejects a miscased heading and falls back, so this
    // shouldn't reach us — but a lowercase brand invites "On Paper", and
    // degrading a version label to the rolling tag is a worse outcome than
    // being liberal here.
    const r = normalizeRelease({ tag_name: 'next', body: '## On Paper 2.1.0\n- feat: b' });
    expect(r.version).toBe('2.1.0');
  });
  it('does not treat an unrelated h2 as a version heading', () => {
    const r = normalizeRelease({ tag_name: 'v1.7.0', body: '## Notes on paper sizes\n- a' });
    expect(r.version).toBe('1.7.0');
  });
});

describe('mergeReleases', () => {
  it('dedupes by version (fetched wins) and sorts newest-first by semver', () => {
    const bundled = [{ version: '1.1.0', date: 'a', summary: 'old' }];
    const fetched = [
      { version: '1.2.0', date: 'b', summary: 'new' },
      { version: '1.1.0', date: 'a', summary: 'fetched-1.1' },
    ];
    const out = mergeReleases(bundled, fetched);
    expect(out.map((r) => r.version)).toEqual(['1.2.0', '1.1.0']);
    expect(out.find((r) => r.version === '1.1.0').summary).toBe('fetched-1.1');
  });
  it('handles double-digit version components correctly', () => {
    const out = mergeReleases([], [{ version: '1.9.0' }, { version: '1.10.0' }]);
    expect(out.map((r) => r.version)).toEqual(['1.10.0', '1.9.0']);
  });
  it('orders prerelease (-next.N) builds under their stable release and by run number', () => {
    const out = mergeReleases([], [
      { version: '1.2.3-next.2' },
      { version: '1.2.2' },
      { version: '1.2.3' },
      { version: '1.2.3-next.9' },
    ]);
    expect(out.map((r) => r.version)).toEqual(['1.2.3', '1.2.3-next.9', '1.2.3-next.2', '1.2.2']);
  });
  it('sorts unparseable versions last', () => {
    const out = mergeReleases([], [{ version: 'next' }, { version: '1.0.0' }]);
    expect(out.map((r) => r.version)).toEqual(['1.0.0', 'next']);
  });
});

describe('splitReleaseBody', () => {
  const digest = '## On Paper 1.16.0\n\n- New: a Library for your résumés.\n';
  const grouped = '### ✨ New features\n**Library**\n- Add tiered library search module\n';
  const body = `${digest}\n<!-- full-log -->\n<details><summary>Full changelog</summary>\n\n${grouped}\n</details>`;

  it('splits a marked body into digest summary and full log', () => {
    const r = splitReleaseBody(body);
    expect(r.summary).toBe(digest.trim());
    expect(r.full).toContain('Add tiered library search module');
    expect(r.full).not.toContain('<details>');
    expect(r.full).not.toContain('</details>');
  });

  it('returns summary === full for unmarked (legacy) bodies', () => {
    const r = splitReleaseBody(digest);
    expect(r.summary).toBe(digest);
    expect(r.full).toBe(digest);
  });

  it('normalizeRelease carries the split through', () => {
    const rel = normalizeRelease({ tag_name: 'v1.16.0', published_at: 'd', body });
    expect(rel.version).toBe('1.16.0');
    expect(rel.summary).not.toBe(rel.full);
    expect(rel.full).toContain('Add tiered library search module');
  });
});

describe('splitReleaseBody malformed bodies', () => {
  it('degrades BOTH fields when the marker has no content before it', () => {
    const r = splitReleaseBody('<!-- full-log -->\n<details><summary>Full changelog</summary>\n- x\n</details>');
    expect(r.summary).toBe(r.full);
    expect(r.full).toContain('- x');
  });

  it('degrades BOTH fields when the tail is empty after unwrapping', () => {
    const body = '## On Paper 1.16.0\n\n- New thing.\n\n<!-- full-log -->\n<details><summary>Full changelog</summary>\n</details>';
    const r = splitReleaseBody(body);
    expect(r.summary).toBe(body);
    expect(r.full).toBe(body);
  });
});
