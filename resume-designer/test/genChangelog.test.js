import { describe, it, expect } from 'vitest';

import { groupChangelog } from '../scripts/ci/gen-changelog.mjs';

describe('groupChangelog', () => {
  it('groups by type (features → fixes → improvements) then by app area', () => {
    const md = groupChangelog([
      'feat(chat): add per-resume threads',
      'fix(pdf): keep fonts when merging sheets',
      'feat(update): show release notes',
      'fix(chat): abort on thread delete',
      'perf(render): repaginate less often',
    ], '1.2.0');

    // Heading.
    expect(md).toContain('## On Paper 1.2.0');
    // Section order.
    const featIdx = md.indexOf('### ✨ New features');
    const fixIdx = md.indexOf('### 🐛 Fixes');
    const perfIdx = md.indexOf('### ⚡ Improvements');
    expect(featIdx).toBeGreaterThan(-1);
    expect(featIdx).toBeLessThan(fixIdx);
    expect(fixIdx).toBeLessThan(perfIdx);
    // Area sub-headers use friendly names.
    expect(md).toContain('**AI Chat**');
    expect(md).toContain('**PDF Export**');
    expect(md).toContain('**Updates & Changelog**');
    expect(md).toContain('**Resume Rendering**');
    // Prefix stripped + capitalized.
    expect(md).toContain('- Add per-resume threads');
    expect(md).toContain('- Keep fonts when merging sheets');
  });

  it('drops internal-only commit types', () => {
    const md = groupChangelog([
      'chore: bump deps',
      'docs: update readme',
      'ci: fix workflow',
      'refactor(chat): tidy internals',
      'test: add coverage',
    ], '1.0.0');
    expect(md).not.toContain('bump deps');
    expect(md).not.toContain('update readme');
    expect(md).not.toContain('tidy internals');
    expect(md).toContain('- Maintenance and internal improvements.');
  });

  it('dedupes an identical subject that landed on two branches', () => {
    const md = groupChangelog([
      'fix(chat): keep a reply running when switching threads',
      'fix(chat): keep a reply running when switching threads',
    ], '1.0.0');
    const occurrences = md.split('- Keep a reply running when switching threads').length - 1;
    expect(occurrences).toBe(1);
  });

  it('marks breaking changes and treats no-scope commits as General', () => {
    const md = groupChangelog(['feat!: overhaul the storage format', 'fix: correct a typo'], '2.0.0');
    expect(md).toContain('**General**');
    expect(md).toContain('- **Breaking:** Overhaul the storage format');
  });

  it('handles empty input', () => {
    const md = groupChangelog([], '1.0.0');
    expect(md).toContain('## On Paper 1.0.0');
    expect(md).toContain('- Maintenance and internal improvements.');
  });
});

// The changelog is read by DESKTOP users — changelogService.js shows it when an
// update lands. iOS ships as a separate app and its CloudKit transport is
// dormant on desktop, so these bullets describe features the reader does not
// have. Each case below was taken from the real ios→next promotion, where 237
// of 338 bullets were ios/sync.
describe('groupChangelog: omitting work the reader cannot use', () => {
  it('drops the ios and sync scopes entirely', () => {
    const md = groupChangelog([
      'feat(ios): make the jobs and profile screens native',
      'feat(sync): give shared units a zone any device can find',
      'feat(chat): add per-resume threads',
    ], '2.2.0');

    expect(md).not.toContain('native');
    expect(md).not.toContain('zone');
    expect(md).not.toContain('**Ios**');
    expect(md).not.toContain('**Sync**');
    // The desktop bullet still lands, so this is a filter and not a blackout.
    expect(md).toContain('Add per-resume threads');
  });

  it('drops ios-* sub-scopes, which an exact-match set let through', () => {
    // This is the case the first version of the filter missed: the promotion
    // carried ios-shell and ios-docs beside ios, and both reached the output.
    const md = groupChangelog([
      'fix(ios-shell): hold the splash for the first pull',
      'fix(ios-docs): record the bundle identifier rule',
      'feat(sync-engine): a scope that does not exist yet',
    ], '2.2.0');

    expect(md).not.toContain('splash');
    expect(md).not.toContain('bundle identifier');
    expect(md).not.toContain('does not exist yet');
    expect(md).toContain('Maintenance and internal improvements.');
  });

  it('does not match a scope that merely starts with those letters', () => {
    const md = groupChangelog(['feat(iosomething): a real desktop feature'], '2.2.0');
    expect(md).toContain('A real desktop feature');
  });

  it('catches a stray that names the platform under another scope', () => {
    // feat(secret) in the real promotion: the scope is desktop-shaped, the
    // subject is not.
    const md = groupChangelog([
      'feat(secret): carry the API key between devices via iCloud Keychain',
    ], '2.2.0');

    expect(md).not.toContain('iCloud');
    expect(md).toContain('Maintenance and internal improvements.');
  });

  it('keeps a desktop cross-device subject: the backstop reads platforms, not phrasing', () => {
    // The first version of this backstop also matched a generic
    // "other|every|between ... devices" phrase, on the assumption that
    // cross-device wording implies sync. It does not — the desktop app has its
    // own cross-device story ("Export a full JSON backup any time, and import
    // it on another machine", README.md) — so that branch silently dropped real
    // desktop notes. Silently is the operative word: nothing downstream reports
    // a bullet the generator declined to emit.
    const md = groupChangelog([
      'fix(backup): preserve history between devices during backup transfer',
      'fix(backup): say that a replace now deletes on other devices too',
      'fix(profiles): recover from a registry every device has tombstoned',
    ], '2.2.0');

    expect(md).toContain('Preserve history between devices during backup transfer');
    expect(md).toContain('Say that a replace now deletes on other devices too');
    expect(md).toContain('Recover from a registry every device has tombstoned');
  });

  it('keeps "this device", which is about local storage and reveals nothing', () => {
    // The narrowness matters: over-filtering would silently drop real desktop
    // fixes, and nothing downstream would say so.
    const md = groupChangelog(['fix(backup): clear an omitted key this device never stored'], '2.2.0');
    expect(md).toContain('Clear an omitted key this device never stored');
  });
});
