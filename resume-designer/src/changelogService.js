/**
 * Changelog data helpers — pure where possible (unit-tested) plus a GitHub
 * Releases fetch. Phase 1 sources history from release bodies; Phase 2 will
 * prefer a structured changelog.json asset (see the changelog plan, Task 10).
 *
 * Kept free of app imports at module load (the post-update entry point below
 * dynamic-imports persistence/native) so the unit tests import cleanly.
 */

const RELEASES_API =
  'https://api.github.com/repos/ashproto/Resume-Designer/releases?per_page=30';

// Base for resolving relative links in fetched release notes (trailing slash so
// `new URL('docs/x', REPO_URL)` keeps the repo path). Used by the changelog UI.
export const REPO_URL = 'https://github.com/ashproto/Resume-Designer/';

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
// heading ("## Resume Designer $VERSION", release.yml). Beta builds publish
// under the rolling `next` TAG while the app version is x.y.z-next.N, so the
// tag alone can't identify the build — prefer the heading, fall back to tag.
function versionFromBody(body) {
  const m = String(body || '').match(/^##\s+Resume Designer\s+(\S+)\s*$/m);
  return m ? m[1] : null;
}

// A GitHub release payload → our shape. Phase 1: summary === full === body.
export function normalizeRelease(release) {
  const body = release?.body || '';
  return {
    version: versionFromBody(body) || stripV(release?.tag_name),
    date: release?.published_at || null,
    summary: body,
    full: body,
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
function bySemverDesc(a, b) {
  const ka = sortKey(a.version);
  const kb = sortKey(b.version);
  if (!ka && !kb) return 0;
  if (!ka) return 1;
  if (!kb) return -1;
  for (let i = 0; i < 4; i += 1) {
    // Infinity !== Infinity is false, so equal slots fall through (no NaN).
    if (ka[i] !== kb[i]) return kb[i] - ka[i];
  }
  return 0;
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
  const rel = releases.find((r) => r.version === current) || null;
  if (rel) {
    const { showUpdateNotes } = await import('./components/ui/updateNotes.jsx');
    await showUpdateNotes({ version: current, notes: rel.summary, full: rel.full, mode: 'whatsnew' });
  }
  saveSettings({ [SEEN_KEY]: current });
}
