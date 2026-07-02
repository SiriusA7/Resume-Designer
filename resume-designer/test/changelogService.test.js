import { describe, it, expect } from 'vitest';

import { justUpdated, mergeReleases, normalizeRelease } from '../src/changelogService.js';

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
      body: '## Resume Designer 1.2.3-next.7\n- feat: beta thing',
    });
    expect(r.version).toBe('1.2.3-next.7');
  });
  it('falls back to the tag when the body has no version heading', () => {
    const r = normalizeRelease({ tag_name: 'v1.6.0', body: 'Just some notes without our heading' });
    expect(r.version).toBe('1.6.0');
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
