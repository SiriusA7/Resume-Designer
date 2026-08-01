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
  render: 'Résumé Rendering',
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
