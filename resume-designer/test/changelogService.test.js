import { describe, it, expect } from 'vitest';

import {
  composeUpdateNotes,
  justUpdated,
  MAX_MISSED_RELEASES,
  mergeReleases,
  normalizeRelease,
  releasesSince,
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
  const digest = '## On Paper 1.16.0\n\n- New: a Library for your resumes.\n';
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

// The panel used to show exactly ONE release — whichever matched the running
// version — because `seen` was read only as a boolean by justUpdated(). That
// inverted the intent: the further behind you were, the less you were told.
// Someone going 1.15.0 -> 2.0.1 got a security patch and a PDF fix, and never
// learned the app had been renamed to On Paper in 2.0.0.
const mkRelease = (version, summary = `## On Paper ${version}\n\n- thing`) => ({
  version, summary, full: `full ${version}`, date: null,
});

// Deliberately NOT semver-sorted. maybeShowPostUpdateChangelog feeds
// releasesSince the output of fetchReleaseHistory(), which only maps the GitHub
// payload — it never sorts, so the order is GitHub's (published-date desc), and
// the rolling `next` tag is republished on every beta so it floats to the top.
// Only mergeReleases() sorts, and that is the history view's path, not this one.
// So releasesSince must impose its own order rather than trusting the input.
// Scrambled on purpose: if this were already descending, the two releases the
// main case selects would come out ordered by luck and the sort would be
// untested. Here they are picked up ascending, so only the sort saves them.
const HISTORY = [
  mkRelease('1.16.0'),
  mkRelease('2.0.1-next.141'),
  mkRelease('1.14.0'),
  mkRelease('2.0.1'),
  mkRelease('1.15.0'),
  mkRelease('2.0.0'),
];

describe('releasesSince', () => {
  const versions = (list) => list.map((r) => r.version);

  it('returns every release the user skipped, current one first', () => {
    const got = releasesSince(HISTORY, '1.15.0', '2.0.1');
    expect(versions(got)).toEqual(['2.0.1', '2.0.0', '1.16.0']);
  });

  it('excludes the release already seen, and anything older', () => {
    const got = releasesSince(HISTORY, '1.15.0', '2.0.1');
    expect(versions(got)).not.toContain('1.15.0');
    expect(versions(got)).not.toContain('1.14.0');
  });

  it('returns just the current release for a normal single-step update', () => {
    expect(versions(releasesSince(HISTORY, '2.0.0', '2.0.1'))).toEqual(['2.0.1']);
  });

  // The rolling `next` tag is always in the fetched list. A stable user must
  // never be shown beta notes for a build they are not running.
  it('hides prereleases from a stable user', () => {
    const got = releasesSince(HISTORY, '1.15.0', '2.0.1');
    expect(versions(got).some((v) => v.includes('-next.'))).toBe(false);
  });

  it('keeps prereleases for a user already on the beta channel', () => {
    const got = releasesSince(HISTORY, '2.0.1', '2.0.1-next.141');
    expect(versions(got)).toContain('2.0.1-next.141');
  });

  // Selection is uncapped; composeUpdateNotes decides how many are worth
  // rendering. Capping here would drop releases before anything could tell the
  // user they existed.
  it('returns every skipped release, uncapped', () => {
    const long = [mkRelease('9.0.0'), ...Array.from({ length: 12 }, (_, i) => mkRelease(`8.0.${12 - i}`))];
    const got = releasesSince(long, '8.0.0', '9.0.0');
    expect(got.length).toBe(13);
    expect(got[0].version).toBe('9.0.0');
  });

  it('shows nothing when the running version has no release entry', () => {
    expect(releasesSince(HISTORY, '1.15.0', '3.1.4')).toEqual([]);
  });

  it('falls back to the current release alone when seen is missing or junk', () => {
    expect(versions(releasesSince(HISTORY, null, '2.0.1'))).toEqual(['2.0.1']);
    expect(versions(releasesSince(HISTORY, 'not-a-version', '2.0.1'))).toEqual(['2.0.1']);
  });

  it('tolerates an empty history', () => {
    expect(releasesSince([], '1.15.0', '2.0.1')).toEqual([]);
  });
});

describe('composeUpdateNotes', () => {
  it('passes a single release through unchanged', () => {
    expect(composeUpdateNotes([mkRelease('2.0.1')])).toBe(mkRelease('2.0.1').summary);
  });

  it('stacks skipped releases under the current one', () => {
    const out = composeUpdateNotes([mkRelease('2.0.1'), mkRelease('2.0.0'), mkRelease('1.16.0')]);
    expect(out).toContain('## On Paper 2.0.1');
    expect(out).toContain('## On Paper 2.0.0');
    expect(out).toContain('## On Paper 1.16.0');
    expect(out).toContain('Also new since your last update');
    // Current release leads.
    expect(out.indexOf('2.0.1')).toBeLessThan(out.indexOf('2.0.0'));
  });

  it('synthesises a heading for a body that has none, so a stack stays labelled', () => {
    const out = composeUpdateNotes([mkRelease('2.0.1'), mkRelease('2.0.0', '- bare bullet, no heading')]);
    expect(out).toContain('## 2.0.0');
  });

  it('returns empty for no releases', () => {
    expect(composeUpdateNotes([])).toBe('');
  });

  // Everything up to and including v1.15.0 predates the digest pipeline, so its
  // "summary" is the whole raw grouped changelog. Reprinting three of those ran
  // past 11,000 characters against live release data.
  const legacy = (version) => {
    const body = `## Resume Designer ${version}\n\n### ✨ New features\n${'- a commit subject\n'.repeat(40)}`;
    return { version, summary: body, full: body, date: null }; // no split => no digest
  };

  it('names pre-digest releases instead of reprinting their raw changelog', () => {
    const out = composeUpdateNotes([mkRelease('2.0.0'), mkRelease('1.16.0'), legacy('1.15.0')]);
    expect(out).toContain('## On Paper 1.16.0');       // digest: rendered
    expect(out).toContain('You also passed through 1.15.0');
    expect(out).not.toContain('a commit subject');     // raw log: not reprinted
    expect(out.length).toBeLessThan(2000);
  });

  it('stacks at most MAX_MISSED_RELEASES digests and names the overflow', () => {
    const missed = Array.from({ length: 7 }, (_, i) => mkRelease(`1.${20 - i}.0`));
    const out = composeUpdateNotes([mkRelease('2.0.0'), ...missed]);
    const rendered = missed.filter((r) => out.includes(`## On Paper ${r.version}\n`));
    expect(rendered.length).toBe(MAX_MISSED_RELEASES);
    // The remainder is named rather than silently dropped.
    for (const r of missed.slice(MAX_MISSED_RELEASES)) {
      expect(out).toContain(r.version);
    }
  });

  it('lists a few named versions readably', () => {
    const out = composeUpdateNotes([mkRelease('2.0.0'), legacy('1.15.0'), legacy('1.14.0')]);
    expect(out).toContain('1.15.0 and 1.14.0');
  });

  // A long-dormant user would otherwise get 21 version numbers in a row.
  it('summarises the span instead of naming every version past a handful', () => {
    const old = Array.from({ length: 21 }, (_, i) => legacy(`1.${21 - i}.0`));
    const out = composeUpdateNotes([mkRelease('2.0.0'), ...old]);
    expect(out).toContain('21 earlier releases, from 1.21.0 back to 1.1.0');
    expect(out).not.toContain('1.20.0, 1.19.0');   // not an inline dump
    expect(out.length).toBeLessThan(1200);
  });
});
