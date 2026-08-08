/**
 * Changelog data helpers — pure where possible (unit-tested) plus a GitHub
 * Releases fetch. The <!-- full-log --> body marker is the structured source
 * for splitting each release's digest summary from its full grouped log.
 *
 * Kept free of app imports at module load (the post-update entry point below
 * dynamic-imports persistence/native) so the unit tests import cleanly.
 */

const RELEASES_API =
  'https://api.github.com/repos/ashproto/Resume-Designer/releases?per_page=30';

// Base for resolving relative links in fetched release notes. Release-note
// relative links are almost always repo FILE paths (README.md, docs/*.md), and
// GitHub serves files under `/blob/<branch>/…` — resolving against the repo
// root would produce github.com 404s. `/blob/main/` (trailing slash) gives a
// valid file route for bare-relative links, while root-relative links (`/x`)
// still resolve to the origin. Used by the changelog UI as SafeMarkdown baseUrl.
export const CHANGELOG_LINK_BASE = 'https://github.com/ashproto/Resume-Designer/blob/main/';

// True only when we have a prior version on record AND it differs from the one
// now running — i.e. an update landed since last launch. First run (no record)
// must NOT trigger a "what's new" panel.
export function justUpdated(seenVersion, currentVersion) {
  return !!seenVersion && !!currentVersion && seenVersion !== currentVersion;
}

function stripV(tag) {
  return String(tag || '').replace(/^v/, '');
}

// The release workflow stamps the true build version into the body's first
// heading ("## <product> $VERSION", release.yml). Beta builds publish
// under the rolling `next` TAG while the app version is x.y.z-next.N, so the
// tag alone can't identify the build — prefer the heading, fall back to tag.
//
// BOTH PRODUCT NAMES ARE PERMANENT. This reads release bodies off the GitHub
// API, so it sees the app's whole published history — every release cut before
// the "Resume Designer" → "On Paper" rename still carries the old heading and
// always will. Dropping the old alternative silently regresses beta version
// labels on historical releases to the rolling `next` tag. Match is liberal
// (case-insensitive, flexible spacing) because this parses remote text whose
// only failure mode is a wrong-but-plausible version label.
const VERSION_HEADING_RE = /^##\s+(?:Resume Designer|On Paper)\s+(\S+)\s*$/im;

function versionFromBody(body) {
  const m = String(body || '').match(VERSION_HEADING_RE);
  return m ? m[1] : null;
}

// Split point the release workflow writes between the digest and the
// <details>-wrapped full grouped log (see release.yml "Finalize release
// notes and body"). Legacy bodies have no marker → summary === full,
// which is exactly the pre-digest behavior everywhere downstream.
const FULL_LOG_MARKER = '<!-- full-log -->';

export function splitReleaseBody(body) {
  const text = String(body || '');
  const i = text.indexOf(FULL_LOG_MARKER);
  if (i === -1) return { summary: text, full: text };
  const summary = text.slice(0, i).trim();
  const full = text.slice(i + FULL_LOG_MARKER.length)
    .replace(/<details>\s*<summary>[^<]*<\/summary>/i, '')
    .replace(/<\/details>\s*$/i, '')
    .trim();
  // A malformed marked body (either side empty after processing) degrades
  // BOTH fields to the whole body — atomically, so a half-parsed state can
  // never show a nonsense expander (full !== summary implies both parsed).
  if (!summary || !full) return { summary: text, full: text };
  return { summary, full };
}

// A GitHub release payload → our shape.
export function normalizeRelease(release) {
  const body = release?.body || '';
  const { summary, full } = splitReleaseBody(body);
  return {
    version: versionFromBody(body) || stripV(release?.tag_name),
    date: release?.published_at || null,
    summary,
    full,
  };
}

// Newest-first by semver, prerelease-aware: x.y.z-next.N sorts under its
// stable x.y.z (stable gets Infinity in the prerelease slot) and by run
// number among betas. Unparseable versions (e.g. a bare rolling tag) sort last.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/;
function sortKey(version) {
  const m = String(version || '').match(SEMVER_RE);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
}
// Ascending compare of two sortKey tuples. Returns -1/0/1 rather than a
// difference because the prerelease slot holds Infinity for stable builds, and
// Infinity - Infinity is NaN.
function cmpKeys(ka, kb) {
  for (let i = 0; i < 4; i += 1) {
    // Infinity !== Infinity is false, so equal slots fall through.
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return 0;
}
function bySemverDesc(a, b) {
  const ka = sortKey(a.version);
  const kb = sortKey(b.version);
  if (!ka && !kb) return 0;
  if (!ka) return 1;
  if (!kb) return -1;
  return -cmpKeys(ka, kb);
}

// Merge bundled (offline base) with fetched (newer/live); fetched wins on
// conflict; dedupe by version; newest-first.
export function mergeReleases(bundled = [], fetched = []) {
  const byVersion = new Map();
  for (const r of bundled) byVersion.set(r.version, r);
  for (const r of fetched) byVersion.set(r.version, r); // fetched overrides
  return [...byVersion.values()].sort(bySemverDesc);
}

// Fetch recent releases from the public repo. Returns [] on any failure so the
// history view degrades to bundled-only rather than erroring.
export async function fetchReleaseHistory() {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list.filter((r) => !r.draft).map(normalizeRelease) : [];
  } catch {
    return [];
  }
}

const SEEN_KEY = 'changelogLastSeenVersion';

// How many skipped releases to stack under the current one. Someone returning
// after a long gap should get the story, not a wall of text — the rest stay one
// click away in Settings → What's new.
export const MAX_MISSED_RELEASES = 4;

/**
 * The releases to show after an update, newest first, with the release the app
 * is NOW RUNNING at index 0 followed by any the user skipped over.
 *
 * Until this existed the panel showed exactly one release — whichever matched
 * the running version — because `seen` was only ever read as a boolean by
 * justUpdated(). That inverted the intent: the further behind you were, the
 * less you were told. Someone going 1.15.0 -> 2.0.1 saw a security patch and a
 * PDF fix, and never learned the app had been renamed to On Paper in 2.0.0.
 *
 * @param {Array<{version:string,summary:string,full:string}>} releases newest-first
 * @param {string|null} seenVersion  last version recorded on this machine
 * @param {string} currentVersion    version now running
 * @returns {Array} current release first, then skipped ones descending; [] if
 *                  the current release is not in `releases` (nothing to show —
 *                  matches the old behaviour of staying silent).
 */
export function releasesSince(releases = [], seenVersion, currentVersion) {
  // Lead with the release actually running. Finding it explicitly (rather than
  // taking whatever sorts highest) is what keeps a build with no release entry
  // silent — a local build or an unpublished version would otherwise present
  // the newest OLDER release as if it were its own.
  const current = releases.find((r) => r.version === currentVersion);
  if (!current) return [];

  const to = sortKey(currentVersion);
  const from = sortKey(seenVersion);
  // No usable record of where they came from: show this build alone, which is
  // exactly what the panel did before skipped releases were handled at all.
  if (!to || !from) return [current];

  // The rolling `next` release is always in the fetched list. Someone on stable
  // must never be shown notes for a beta build they are not running; someone
  // already on the beta channel should still see them.
  const stableOnly = to[3] === Infinity;

  const missed = releases
    .filter((r) => {
      if (r === current) return false;
      const k = sortKey(r.version);
      if (!k) return false;
      if (stableOnly && k[3] !== Infinity) return false;
      // Strictly after what they last saw, strictly before what they now run.
      return cmpKeys(k, from) > 0 && cmpKeys(k, to) < 0;
    })
    .sort(bySemverDesc);

  // Uncapped on purpose — this picks WHICH releases apply; composeUpdateNotes
  // decides how many are worth rendering. Capping here would drop releases
  // before anything could tell the user they existed.
  return [current, ...missed];
}

// Stack the selected releases into one markdown body for the dialog. Each
// release body already opens with its own `## On Paper x.y.z` heading, so they
// self-label; only a body missing one needs a heading synthesised.
function labelled(rel) {
  const summary = rel?.summary || '';
  return /^\s*##\s+/m.test(summary) ? summary : `## ${rel?.version || ''}\n\n${summary}`.trim();
}

// A release published before the digest pipeline has no summary/full split, so
// splitReleaseBody hands back its entire raw grouped changelog as the "summary"
// — every commit subject under ### headings. That is right for the history
// view and a wall of text stacked here: every release up to and including
// v1.15.0 is like this, and reprinting three of them ran past 11,000
// characters. Same test updateNotes.jsx uses to decide whether to offer its
// expander.
const hasDigest = (rel) => !!rel?.full && rel.full !== rel.summary;

// Past a handful, naming each version is noise — a long-dormant user would get
// 21 numbers in a row. Give the count and the span instead, which still says
// plainly how much they missed.
const MAX_NAMED_VERSIONS = 6;
const describeVersions = (rels) => {
  const v = rels.map((r) => r.version);
  if (v.length === 1) return v[0];
  if (v.length <= MAX_NAMED_VERSIONS) return `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}`;
  return `${v.length} earlier releases, from ${v[0]} back to ${v[v.length - 1]}`;
};

export function composeUpdateNotes(selected = []) {
  if (!selected.length) return '';
  const [current, ...missed] = selected;
  if (!missed.length) return current.summary || '';

  const readable = missed.filter(hasDigest).slice(0, MAX_MISSED_RELEASES);
  // Named, not dropped — a silent cap reads as "that was everything".
  const named = missed.filter((r) => !readable.includes(r));

  const parts = [labelled(current), '---', '_Also new since your last update:_'];
  parts.push(...readable.map(labelled));
  if (named.length) {
    // "the details" rather than a pronoun, so it reads correctly for one
    // skipped release and for twenty.
    parts.push(
      `You also passed through ${describeVersions(named)} — `
      + "see Settings → What's new for the details.",
    );
  }
  return parts.join('\n\n');
}

// On launch: if the running version differs from the last one we recorded, an
// update landed — show its notes once, then record the new version. First run
// records silently (justUpdated() is false without a prior record). App modules
// are dynamic-imported so this file's unit tests import without pulling native /
// persistence at module load.
export async function maybeShowPostUpdateChangelog() {
  const { isTauri, getAppInfo } = await import('./native.js');
  if (!isTauri) return;
  const { getSettings, saveSettings } = await import('./persistence.js');
  const current = await getAppInfo().then((i) => i.version).catch(() => null);
  if (!current) return;
  const seen = getSettings()[SEEN_KEY];
  if (seen === current) return;
  if (!justUpdated(seen, current)) {
    // First run: record silently, never show a panel.
    saveSettings({ [SEEN_KEY]: current });
    return;
  }
  // An update landed. Distinguish "couldn't load history" (empty fetch —
  // network failure / rate limit: leave the seen version stale so the next
  // launch retries) from "history loaded but has no notes for this build"
  // (record it — don't refetch forever for a release that has none).
  const releases = await fetchReleaseHistory();
  if (!releases.length) return;
  // Every release the user passed through, not just the one they landed on.
  const selected = releasesSince(releases, seen, current);
  if (selected.length) {
    const { showUpdateNotes } = await import('./components/ui/updateNotes.jsx');
    await showUpdateNotes({
      version: current,
      notes: composeUpdateNotes(selected),
      // The expander stays scoped to THIS build's full changelog — stacking
      // every skipped release's full log would bury it.
      full: selected[0].full,
      mode: 'whatsnew',
    });
  }
  saveSettings({ [SEEN_KEY]: current });
}
