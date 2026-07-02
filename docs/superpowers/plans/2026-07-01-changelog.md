# User-Facing Changelog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show users a clean, digestible changelog before and after updating, plus an in-app history of past releases, with deep detail behind an expander — and generate the user-facing summary with free GitHub Models AI at release time.

**Architecture:** Two phases sharing one data contract (`summary` + `full`). Phase 1 wires the notes the release already produces into three UI surfaces (before-update dialog, after-update panel, Settings history) — no API key, no CI change. Phase 2 adds a free GitHub Models summarize step in CI (bash fallback), a structured `changelog.json` release asset, and bundled offline history. The app reuses the existing promise-returning dialog-host pattern (`confirm.jsx`) and the existing sanitized markdown render path (`formatMessage` + `htmlToBlocks`).

**Tech stack:** Vanilla JS + React 19 (portaled hosts), shadcn `Dialog`, `marked`+`dompurify` via `formatMessage()`, Tauri 2 updater, GitHub Actions + `actions/ai-inference` (GitHub Models), vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-07-01-changelog-design.md`

---

## File structure

**Phase 1 (app UI, no CI):**
- Create: `resume-designer/src/changelogService.js` — pure helpers: parse notes, fetch GitHub Releases history, merge/dedupe/sort, "did we just update?" detection. Unit-tested.
- Create: `resume-designer/test/changelogService.test.js` — vitest for the pure helpers.
- Create: `resume-designer/src/components/ui/SafeMarkdown.jsx` — render sanitized markdown via the existing `formatMessage` + `htmlToBlocks` path (no raw HTML injection).
- Create: `resume-designer/src/components/ui/updateNotes.jsx` — `showUpdateNotes()` (imperative, promise-returning) + `UpdateNotesHost` (mounted once), mirroring `confirm.jsx`.
- Create: `resume-designer/src/components/ChangelogHistory.jsx` — the Settings → Updates "What's new" history list.
- Modify: `resume-designer/src/native.js` — forward `notes` on the `available` status; swap the native download `dialog.ask` for `showUpdateNotes`.
- Modify: `resume-designer/src/App.jsx` — mount `<UpdateNotesHost />` beside `ConfirmHost`.
- Modify: `resume-designer/src/main.js` — call `maybeShowPostUpdateChangelog()` on init.
- Modify: `resume-designer/src/components/SettingsDialog.jsx` — add a history section to the Updates tab.
- Modify: `resume-designer/src-tauri/` capability/CSP — allow `https://api.github.com` for the history fetch (verify what's needed).

**Phase 2 (CI + structured data):**
- Modify: `.github/workflows/release.yml` — add the GitHub Models summarize step (bash fallback), split `summary`/`full`, publish `changelog.json` asset, accumulate bundled history.
- Create: `resume-designer/public/changelog-history.json` — populated by the release build.
- Modify: `resume-designer/src/changelogService.js` — prefer structured `changelog.json` (per-release asset + bundled) and merge bundled+fetched; the dialog gains the `full`-log expander.

---

## Phase 1 — Surface notes in the app

### Task 1: `changelogService.js` pure helpers (TDD)

**Files:**
- Create: `resume-designer/src/changelogService.js`
- Test: `resume-designer/test/changelogService.test.js`

- [ ] **Step 1: Write failing tests**

```js
// resume-designer/test/changelogService.test.js
import { describe, it, expect } from 'vitest';
import { justUpdated, mergeReleases, normalizeRelease } from '../src/changelogService.js';

describe('justUpdated', () => {
  it('true when seen version differs from current', () => {
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
    const r = normalizeRelease({ tag_name: 'v1.3.0', published_at: '2026-07-01T00:00:00Z', body: '## x\n- feat: a' });
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
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd resume-designer && npx vitest run test/changelogService.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// resume-designer/src/changelogService.js
/**
 * Changelog data helpers — pure where possible (unit-tested) plus a GitHub
 * Releases fetch. Phase 1 sources history from release bodies; Phase 2 will
 * prefer a structured changelog.json asset (see plan Task 9).
 */

const RELEASES_API = 'https://api.github.com/repos/ashproto/Resume-Designer/releases?per_page=30';

// True only when we have a prior version on record AND it differs from the one
// now running — i.e. an update landed since last launch. First run (no record)
// must NOT trigger a "what's new" panel.
export function justUpdated(seenVersion, currentVersion) {
  return !!seenVersion && !!currentVersion && seenVersion !== currentVersion;
}

function stripV(tag) {
  return String(tag || '').replace(/^v/, '');
}

// GitHub release payload → our shape. Phase 1: summary === full === body.
export function normalizeRelease(release) {
  const body = release?.body || '';
  return {
    version: stripV(release?.tag_name),
    date: release?.published_at || null,
    summary: body,
    full: body,
  };
}

// Newest-first by semver; unparseable versions sort last.
function bySemverDesc(a, b) {
  const pa = a.version.split('.').map(Number);
  const pb = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return y - x;
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
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list.filter((r) => !r.draft).map(normalizeRelease) : [];
  } catch {
    return [];
  }
}

// Notes for one specific version (the after-update "what's new" source).
export async function fetchNotesForVersion(version) {
  const all = await fetchReleaseHistory();
  return all.find((r) => r.version === version) || null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd resume-designer && npx vitest run test/changelogService.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src/changelogService.js resume-designer/test/changelogService.test.js
git commit -m "feat(update): add changelog data helpers (parse, fetch, merge)"
```

### Task 2: `SafeMarkdown` render helper

**Files:**
- Create: `resume-designer/src/components/ui/SafeMarkdown.jsx`

Reuses the exact sanitized render path chat uses: `formatMessage(md)` runs marked + DOMPurify to a sanitized HTML string, and `htmlToBlocks` converts it to DOM nodes appended via `replaceChildren` — no raw HTML-injection prop.

- [ ] **Step 1: Implement**

```jsx
// resume-designer/src/components/ui/SafeMarkdown.jsx
import { useRef, useEffect } from 'react';

import { formatMessage } from '../../markdownMessage.js';
import { htmlToBlocks } from '../chat/streamReconcile.js';

// Render trusted-but-sanitized markdown. formatMessage() = marked + DOMPurify;
// htmlToBlocks turns the sanitized HTML string into nodes we append directly,
// matching the chat renderer's non-streaming path.
export function SafeMarkdown({ content, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.replaceChildren(...htmlToBlocks(formatMessage(content || '')));
  }, [content]);
  return <div ref={ref} className={className} />;
}
```

- [ ] **Step 2: Verify** — `cd resume-designer && npx eslint src/components/ui/SafeMarkdown.jsx` clean.

- [ ] **Step 3: Commit**

```bash
git add resume-designer/src/components/ui/SafeMarkdown.jsx
git commit -m "feat(ui): add a SafeMarkdown render helper"
```

### Task 3: `updateNotes.jsx` dialog host (mirror confirm.jsx)

**Files:**
- Create: `resume-designer/src/components/ui/updateNotes.jsx`
- Modify: `resume-designer/src/App.jsx`

- [ ] **Step 1: Implement the host + imperative API**

```jsx
// resume-designer/src/components/ui/updateNotes.jsx
import { useEffect, useState } from 'react';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SafeMarkdown } from '@/components/ui/SafeMarkdown';

// Imperative, promise-returning update-notes dialog — same pattern as
// confirm.jsx. mode 'update' resolves 'download' | 'later'; mode 'whatsnew'
// (post-update) resolves 'ok'. UpdateNotesHost is mounted once in App.
let resolver = null;

export function showUpdateNotes({ version, currentVersion = null, notes = '', full = '', mode = 'update' }) {
  return new Promise((resolve) => {
    resolver?.(mode === 'update' ? 'later' : 'ok'); // supersede any pending dialog
    resolver = resolve;
    window.dispatchEvent(new CustomEvent('rd:update-notes', {
      detail: { version, currentVersion, notes, full, mode },
    }));
  });
}

export function UpdateNotesHost() {
  const [opts, setOpts] = useState(null);

  useEffect(() => {
    const onOpen = (e) => setOpts(e.detail);
    window.addEventListener('rd:update-notes', onOpen);
    return () => window.removeEventListener('rd:update-notes', onOpen);
  }, []);

  const settle = (result) => {
    setOpts(null);
    resolver?.(result);
    resolver = null;
  };

  const isUpdate = opts?.mode === 'update';
  const title = isUpdate ? `Update available — v${opts?.version}` : `What's new in v${opts?.version}`;
  const hasFull = !!opts?.full && opts.full !== opts.notes;

  return (
    <Dialog open={!!opts} onOpenChange={(open) => !open && settle(isUpdate ? 'later' : 'ok')}>
      <DialogContent className="glass-card max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Release notes</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto pr-1">
          {opts?.notes
            ? <SafeMarkdown className="chat-markdown text-sm" content={opts.notes} />
            : <p className="text-sm text-muted-foreground">No release notes for this version.</p>}
          {hasFull && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Full changelog</summary>
              <SafeMarkdown className="chat-markdown mt-2 text-xs" content={opts.full} />
            </details>
          )}
        </div>
        <DialogFooter>
          {isUpdate ? (
            <>
              <Button variant="outline" onClick={() => settle('later')}>Later</Button>
              <Button onClick={() => settle('download')}>Download</Button>
            </>
          ) : (
            <Button onClick={() => settle('ok')}>Got it</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Mount the host in App.jsx**

Find where `ConfirmHost` is rendered in `resume-designer/src/App.jsx` and add `<UpdateNotesHost />` next to it.

```jsx
import { UpdateNotesHost } from '@/components/ui/updateNotes.jsx';
// …in the returned tree, beside <ConfirmHost />:
<UpdateNotesHost />
```

- [ ] **Step 3: Verify build**

Run: `cd resume-designer && npx eslint src/components/ui/updateNotes.jsx src/App.jsx && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add resume-designer/src/components/ui/updateNotes.jsx resume-designer/src/App.jsx
git commit -m "feat(update): add promise-returning update-notes dialog host"
```

### Task 4: Wire notes into the update flow (before-update)

**Files:**
- Modify: `resume-designer/src/native.js`

- [ ] **Step 1: Forward `notes` on the available status**

In `checkForUpdates` (native.js ~275), add `notes` to the `available` emit:

```js
    emitStatus({
      status: 'available',
      source,
      version: update.version,
      currentVersion,
      notifyOnly,
      notes: update.notes || '',
      message: `Version ${update.version} is available.`,
    });
```

- [ ] **Step 2: Replace the native download prompt with the React dialog**

Replace the `const wantsDownload = await dialog.ask(...)` block (native.js ~292-295) with:

```js
    const { showUpdateNotes } = await import('./components/ui/updateNotes.jsx');
    const decision = await showUpdateNotes({
      version: update.version,
      currentVersion,
      notes: update.notes || '',
      mode: 'update',
    });
    const wantsDownload = decision === 'download';
```

Leave the download-progress and restart logic unchanged (the restart `dialog.ask` stays native — no notes there).

- [ ] **Step 3: Verify**

Run: `cd resume-designer && npx eslint src/native.js && npm run build`
Expected: clean. (Runtime needs a real update event; verify in `tauri dev` against a test manifest, not the preview.)

- [ ] **Step 4: Commit**

```bash
git add resume-designer/src/native.js
git commit -m "feat(update): show a rich release-notes dialog before downloading"
```

### Task 5: After-update "what's new" panel

**Files:**
- Modify: `resume-designer/src/changelogService.js` (add `maybeShowPostUpdateChangelog`)
- Modify: `resume-designer/src/main.js`

- [ ] **Step 1: Add the post-update entry point to changelogService.js**

```js
// append to resume-designer/src/changelogService.js
import { getSettings, saveSettings } from './persistence.js';
import { isTauri, getAppInfo } from './native.js';

const SEEN_KEY = 'changelogLastSeenVersion';

// On launch: if the running version differs from the last one we recorded, an
// update landed — show its notes once, then record the new version. First run
// records silently (justUpdated() is false without a prior record).
export async function maybeShowPostUpdateChangelog() {
  if (!isTauri) return;
  const current = await getAppInfo().then((i) => i.version).catch(() => null);
  if (!current) return;
  const seen = getSettings()[SEEN_KEY];
  if (justUpdated(seen, current)) {
    const rel = await fetchNotesForVersion(current);
    if (rel) {
      const { showUpdateNotes } = await import('./components/ui/updateNotes.jsx');
      await showUpdateNotes({ version: current, notes: rel.summary, full: rel.full, mode: 'whatsnew' });
    }
  }
  saveSettings({ [SEEN_KEY]: current });
}
```

- [ ] **Step 2: Call it from main init**

In `resume-designer/src/main.js` init (near `startupUpdateCheck()` / `initUpdateFlow()`), add a fire-and-forget call:

```js
import { maybeShowPostUpdateChangelog } from './changelogService.js';
// …after init:
maybeShowPostUpdateChangelog().catch(() => {});
```

- [ ] **Step 3: Verify** — `npx eslint` + `npm run build` clean; unit tests still green.

- [ ] **Step 4: Commit**

```bash
git add resume-designer/src/changelogService.js resume-designer/src/main.js
git commit -m "feat(update): show what's-new after an update lands"
```

### Task 6: Settings → Updates history view

**Files:**
- Create: `resume-designer/src/components/ChangelogHistory.jsx`
- Modify: `resume-designer/src/components/SettingsDialog.jsx`
- Modify: Tauri capability/CSP to allow `https://api.github.com` (verify)

- [ ] **Step 1: Build the history component**

```jsx
// resume-designer/src/components/ChangelogHistory.jsx
import { useEffect, useState } from 'react';

import { fetchReleaseHistory } from '../changelogService.js';
import { SafeMarkdown } from '@/components/ui/SafeMarkdown';

export function ChangelogHistory() {
  const [state, setState] = useState({ loading: true, releases: [] });

  useEffect(() => {
    let alive = true;
    fetchReleaseHistory().then((releases) => { if (alive) setState({ loading: false, releases }); });
    return () => { alive = false; };
  }, []);

  if (state.loading) return <p className="text-sm text-muted-foreground">Loading release history…</p>;
  if (!state.releases.length) return <p className="text-sm text-muted-foreground">Couldn't load release history.</p>;

  return (
    <div className="space-y-3">
      {state.releases.map((r) => (
        <details key={r.version} className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            v{r.version}
            {r.date && <span className="ml-2 text-xs text-muted-foreground">{new Date(r.date).toLocaleDateString()}</span>}
          </summary>
          <SafeMarkdown className="chat-markdown mt-2 text-sm" content={r.summary} />
        </details>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add a "What's new" section to the Updates tab**

In `SettingsDialog.jsx`, import the component and add a section after "Check now" (~423):

```jsx
import { ChangelogHistory } from './ChangelogHistory.jsx';
// …after the "Check now" section, inside the updates tab:
<Separator />
<section>
  <SectionHeader title="What's new" description="Recent releases." />
  <ChangelogHistory />
</section>
```

- [ ] **Step 3: Allow the GitHub API host**

Verify whether the webview `fetch` to `https://api.github.com` is blocked by the Tauri CSP (`src-tauri/tauri.conf.json` `app.security.csp`) or needs an `http`/`fetch` capability. Add `https://api.github.com` to `connect-src` if a CSP exists. Test the fetch in `tauri dev` (the Chromium preview won't exercise the WebKit CSP).

- [ ] **Step 4: Verify** — `npx eslint` + `npm run build` clean; confirm the fetch works in `tauri dev`.

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src/components/ChangelogHistory.jsx resume-designer/src/components/SettingsDialog.jsx resume-designer/src-tauri/tauri.conf.json
git commit -m "feat(update): add a release-history view to Settings"
```

### Task 7: Phase 1 review + PR

- [ ] Run full suite: `cd resume-designer && npx vitest run && npx eslint . && npm run build` — all green.
- [ ] Manual pass in `tauri dev`: history loads; after-update panel logic (temporarily seed a stale `changelogLastSeenVersion` to force it).
- [ ] Branch `feat/changelog-ui` → PR into `next` (Codex cycle) per the project flow. Do NOT merge without explicit go-ahead.

---

## Phase 2 — AI generation + structured data (free, no secret)

### Task 8: GitHub Models summarize step in release.yml

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Grant the job the models scope**

On the `release` job, add (keep existing perms):

```yaml
    permissions:
      contents: write
      models: read
```

- [ ] **Step 2: Produce the raw `full` log, then the AI `summary` with a fallback**

Replace the "Generate release notes" step (release.yml ~329-345) so it writes both `full-changelog.md` (raw, today's output) and `release-notes.md` (the summary):

```yaml
      - name: Generate raw changelog
        env:
          PREV_TAG: ${{ needs.decide.outputs.previous_tag }}
          VERSION: ${{ needs.decide.outputs.version }}
        run: |
          range="HEAD"
          [ -n "$PREV_TAG" ] && range="${PREV_TAG}..HEAD"
          git log "$range" --no-merges --pretty=format:'- %s' \
            | grep -E '^- (feat|fix|perf)(\(|:|!)' \
            > full-changelog.md || echo "- Maintenance and internal improvements." > full-changelog.md

      - name: Summarize changelog (GitHub Models)
        id: summarize
        continue-on-error: true
        uses: actions/ai-inference@v1
        with:
          model: openai/gpt-4o-mini
          system-prompt: |
            You write user-facing release notes for a résumé-builder desktop app.
            Turn the commit list into a short, friendly changelog. Group under
            "### Highlights", "### Improvements", "### Fixes". Drop internal-only
            commits (chore/ci/docs/refactor/test/build). No commit hashes, no PR
            numbers, plain language. If nothing is user-facing, output
            "- Maintenance and internal improvements.".
          prompt-file: full-changelog.md

      - name: Assemble release-notes.md (summary, with fallback)
        env:
          VERSION: ${{ needs.decide.outputs.version }}
          AI_OK: ${{ steps.summarize.outcome == 'success' }}
          AI_TEXT: ${{ steps.summarize.outputs.response }}
        run: |
          {
            echo "## Resume Designer $VERSION"
            echo ""
            if [ "$AI_OK" = "true" ] && [ -n "$AI_TEXT" ]; then
              printf '%s\n' "$AI_TEXT"
            else
              echo "(AI summary unavailable — raw changelog below)"
              cat full-changelog.md
            fi
            echo ""
          } > release-notes.md
          echo "----- release-notes.md -----"; cat release-notes.md
```

Notes: `actions/ai-inference` authenticates via the runner `GITHUB_TOKEN` (needs `models: read`); `continue-on-error` + the `AI_OK` gate guarantee a release never fails on the AI step. Confirm the action's exact input/output names (`model`, `prompt-file`/`prompt`, `outputs.response`) against its README at implementation time.

- [ ] **Step 3: Verify** — push to a throwaway branch and run the workflow (or dry-run the step) to confirm `release-notes.md` is produced both when the AI step succeeds and when it's forced to fail.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): summarize the changelog with GitHub Models and a fallback"
```

### Task 9: Publish `changelog.json` + bundled history

**Files:**
- Modify: `.github/workflows/release.yml` (the "assemble latest.json" node step + release-assets upload)
- Create/populate: `resume-designer/public/changelog-history.json`

- [ ] **Step 1: Emit a structured per-release `changelog.json` asset**

In the node script (release.yml ~400), alongside `latest.json`, write a `changelog.json`:

```js
          const changelog = {
            version: process.env.VERSION,
            date: new Date().toISOString(),
            summary: fs.readFileSync('release-notes.md', 'utf8'),
            full: fs.readFileSync('full-changelog.md', 'utf8'),
          };
          fs.writeFileSync(path.join(flatDir, 'changelog.json'), JSON.stringify(changelog, null, 2));
```

Add `changelog.json` to the `softprops/action-gh-release` `files:` list. `latest.json.notes` already carries `release-notes.md` (the summary) — unchanged, so the before/after-update dialogs get the clean summary automatically.

- [ ] **Step 2: Accumulate the bundled history**

Add a best-effort (`continue-on-error`) step, before the app build, that maintains `resume-designer/public/changelog-history.json`: fetch existing releases via `gh api repos/${{ github.repository }}/releases`, map each to `{version,date,summary,full}` (using each release's `changelog.json` asset when present, else its body), prepend this release, and write the file so Vite bundles it.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml resume-designer/public/changelog-history.json
git commit -m "ci(release): publish structured changelog.json and bundled history"
```

### Task 10: App prefers structured data + merges bundled/fetched

**Files:**
- Modify: `resume-designer/src/changelogService.js`
- Test: `resume-designer/test/changelogService.test.js`

- [ ] **Step 1: Add a failing test for the bundled+fetched merge path**

Extend the test to cover loading the bundled `changelog-history.json` and merging it with `fetchReleaseHistory()` via `mergeReleases` (fetched wins, newest-first).

- [ ] **Step 2: Implement**

- `fetchReleaseHistory()` prefers each release's `changelog.json` asset when present (structured `summary`/`full`), else falls back to the release `body` (Phase 1 behavior).
- Add `loadBundledHistory()` importing `resume-designer/public/changelog-history.json` (Vite static import or fetch of the bundled path).
- The history view calls `mergeReleases(loadBundledHistory(), await fetchReleaseHistory())`.
- The dialogs already pass `full`; with structured data the "Full changelog" expander now differs from the summary and renders.

- [ ] **Step 3: Verify** — `npx vitest run` green; `npm run build` clean; `tauri dev` shows the summary in dialogs with a working "Full changelog" expander, and history merges offline+live.

- [ ] **Step 4: Commit**

```bash
git add resume-designer/src/changelogService.js resume-designer/test/changelogService.test.js
git commit -m "feat(update): prefer structured changelog + merge bundled with fetched"
```

### Task 11: Phase 2 review + PR

- [ ] Full suite green (`vitest`, `eslint`, `build`).
- [ ] Confirm a real release run produces AI notes, `changelog.json`, and latest.json.notes = summary; verify the fallback by forcing the AI step to fail.
- [ ] Branch `feat/changelog-ci` → PR into `next` (Codex cycle). Do NOT merge without explicit go-ahead.

---

## Notes / risks

- **`actions/ai-inference` API surface** — confirm exact `with:` inputs (`model`, `prompt`/`prompt-file`, `system-prompt`) and the output name (`steps.summarize.outputs.response`) against the action's current README when implementing Task 8; they may differ from the snippet.
- **GitHub Models enablement** — may need a one-time org/account toggle for `ashproto`; the bash fallback covers it until then.
- **CSP for the history fetch** — the WebKit build may block `api.github.com`; must be verified in `tauri dev` (Task 6 step 3), not the Chromium preview.
- **Rate limits** — one summary per release is far under GitHub Models free limits; the unauthenticated Releases API fetch (60/hr) is fine for a personal app.
- **Verification caveat** — the before/after-update dialogs need a real update event; verify in `tauri dev` against a test manifest. Unit tests cover the pure helpers.
- **Commitlint** — all subjects above start lowercase; add the `Co-Authored-By: Claude Opus 4.8 (1M context)` footer on real commits.
