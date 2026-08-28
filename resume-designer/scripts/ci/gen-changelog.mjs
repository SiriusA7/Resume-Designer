#!/usr/bin/env node
// Organize conventional-commit subjects into a grouped release changelog:
// "### ✨ New features" → "### 🐛 Fixes" → "### ⚡ Improvements", each
// sub-grouped by the app AREA (the commit scope). Internal-only types
// (chore/docs/ci/test/build/refactor/style) are dropped from a user changelog.
//
// This grouped Markdown is the release step's deterministic output — and the
// input the GitHub Models step rewrites into friendlier wording (with this as
// the fallback if that step fails). See .github/workflows/release.yml.
//
// CLI: `git log <range> --no-merges --pretty='%s' | VERSION=1.2.3 node gen-changelog.mjs`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Friendly names for the commit scope → "the part of the app".
const AREA_NAMES = {
  chat: 'AI Chat',
  pdf: 'PDF Export',
  ui: 'Interface',
  update: 'Updates & Changelog',
  changelog: 'Updates & Changelog',
  render: 'Resume Rendering',
  pagination: 'Pagination',
  store: 'Data & Storage',
  data: 'Data & Storage',
  profile: 'Profile',
  onboarding: 'Onboarding',
  jobs: 'Job Descriptions',
  desktop: 'Desktop App',
};
const areaLabel = (scope) =>
  (!scope ? 'General' : AREA_NAMES[scope] || scope.charAt(0).toUpperCase() + scope.slice(1));

// Scopes whose work the reader of THIS changelog cannot use.
//
// The audience is the desktop app: `changelogService.js` shows these notes when
// an update lands. iOS ships as a separate app, and its CloudKit transport is
// the SwiftUI shell — `initIOSShell` stays dormant until that shell calls
// `activate()`, so on desktop the whole sync layer is wired and silent. Listing
// either is therefore INACCURATE, not merely early: it describes features the
// reader does not have and cannot get from this release.
//
// This also keeps the material away from the AI rewrite in release.yml, which
// is told to find the release's "honest through-line". Measured on the iOS
// promotion: 237 of 338 bullets were ios/sync, so the through-line it would
// have found was the iPhone app.
//
// WHEN iOS SHIPS: delete the scope from this set and its bullets return. Do not
// reach for the subject net below to do the same job — that is a backstop for
// strays, not a switch.
const OMIT_SCOPES = new Set(['ios', 'sync']);

// Matched on the scope's LEADING SEGMENT, not the whole string: the promotion
// carried `ios-shell` and `ios-docs` alongside `ios`, and an exact-set test let
// both through. Splitting on `-` and `/` also means a future `sync-engine`
// needs no edit here, while `iosomething` still does not match.
const omitted = (scope) =>
  OMIT_SCOPES.has(String(scope || '').toLowerCase().split(/[-/]/)[0]);

// Backstop for a commit whose scope is desktop-shaped but whose subject names
// the platform anyway — `feat(secret): carry the API key between devices via
// iCloud Keychain` is the case that motivated it.
//
// CONCRETE PLATFORM TERMS ONLY. An earlier version also matched a generic
// `other|every|between ... devices` phrase, on the assumption that cross-device
// wording implies sync. It does not: the desktop app has its own cross-device
// story — "Export a full JSON backup any time, and import it on another
// machine" (README.md) — so `fix(backup): preserve history between devices
// during backup transfer` is a real desktop note, and that branch would have
// dropped it. Silently, which is the part that matters: nothing downstream
// reports a bullet the generator declined to emit.
//
// The residue is acceptable and was checked rather than assumed. Two sync-shaped
// subjects survive under desktop scopes ("deletes on other devices too",
// "a registry every device has tombstoned"). Neither names a platform, and a
// desktop reader has machines to sync backups between, so neither reveals iOS.
// Suppressing them would mean re-adding exactly the branch that over-filters.
const OMIT_SUBJECT = /\b(ios|iphone|ipad|ipados|icloud|cloudkit|swiftui|app store)\b/i;

// User-facing commit types → section (array order = display order). Any other
// type is treated as internal and omitted.
const SECTIONS = [
  { key: 'feat', title: '### ✨ New features' },
  { key: 'fix', title: '### 🐛 Fixes' },
  { key: 'perf', title: '### ⚡ Improvements' },
];

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const RE = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

// Build the grouped Markdown from an array of commit subject lines.
export function groupChangelog(subjects, version = '') {
  const buckets = { feat: {}, fix: {}, perf: {} };
  for (const raw of subjects) {
    const m = String(raw).trim().match(RE);
    if (!m) continue;
    const [, type, scope, bang, subject] = m;
    if (!buckets[type]) continue; // internal type → drop
    if (omitted(scope)) continue; // not this reader's app
    if (OMIT_SUBJECT.test(subject)) continue; // stray that names the platform anyway
    const area = areaLabel(scope);
    (buckets[type][area] ||= []).push(`${bang ? '**Breaking:** ' : ''}${cap(subject.trim())}`);
  }

  // Canonical heading. The app parses this back out of the published release
  // body to recover the true version (beta builds publish under the rolling
  // `next` tag), so the product name here is a contract with
  // src/changelogService.js and validate-digest.mjs — not decoration.
  const out = [`## On Paper ${String(version).trim()}`.trim(), ''];
  let any = false;
  for (const { key, title } of SECTIONS) {
    const areas = buckets[key];
    const names = Object.keys(areas).sort(
      (a, b) => areas[b].length - areas[a].length || a.localeCompare(b),
    );
    if (!names.length) continue;
    any = true;
    out.push(title);
    for (const area of names) {
      out.push(`**${area}**`);
      for (const item of [...new Set(areas[area])]) out.push(`- ${item}`); // dedup same subject across branches
      out.push('');
    }
  }
  if (!any) out.push('- Maintenance and internal improvements.', '');
  return `${out.join('\n')}\n`;
}

// Run as a CLI (subjects on stdin) — skipped when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const subjects = readFileSync(0, 'utf8').split('\n');
  process.stdout.write(groupChangelog(subjects, process.env.VERSION || ''));
}
