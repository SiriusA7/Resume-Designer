# Live models, composer, grounding, change preview, main sections, spellcheck — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship six fixes on one branch: a live OpenRouter model catalog, a chat composer that survives narrow widths, AI that stops fabricating experience, a change-preview system that renders correctly and stays in sync, custom main-area sections, and spellcheck.

**Architecture:** Five of the six are additive and contained. The sixth (change preview) replaces direct DOM text mutation with a data-driven re-render plus path-keyed attribute marking. Two workstreams touch `renderer.js` (change preview, sections) and are deliberately sequenced adjacent so they never interleave. The spellcheck spike runs first because a negative result changes what stage 2 can be.

**Tech Stack:** React 19 + Vite, plain JavaScript (no TypeScript), Tailwind 3 + shadcn/ui (Radix + CVA), vitest + jsdom, Tauri 2 (Rust), OpenRouter API.

## Global Constraints

- **No TypeScript.** `.js` / `.jsx` only. Service modules are framework-free `.js` at `src/` top level; React components live under `src/components/`.
- **Commit convention:** conventional commits, subject MUST start lowercase. commitlint runs on **every commit in the PR**, not just the tip.
- **Never commit, push, or open a PR unless explicitly asked.** Each task ends with a commit — that is pre-authorized by this plan. Pushing and PR creation are not.
- **Branch:** one feature branch off `next`. All six workstreams land on it, one workstream per contiguous commit run, so the branch stays bisectable.
- **shadcn/ui is real here.** Tailwind Preflight is ON. Never hand-roll lookalike components — extend the real primitives in `src/components/ui/`.
- **Preview is Chromium; the shipped app is WKWebView.** Layout- and scroll-sensitive work MUST be verified in `npm run tauri:dev`. ClaudePreview cannot answer a WebKit question.
- **Windows Rust must be type-checked locally:** `cargo check --target x86_64-pc-windows-gnu` (mingw installed; msvc target does not build on this machine). PR CI builds macOS only.
- **Commands run from `resume-designer/`:** `npm run test`, `npm run lint`, `npm run dev`, `npm run tauri:dev`.
- **Never delete the `next` git tag.** Use `refs/heads/next` / `origin/next` when you mean the branch.

## File Structure

**Created**
- `src/modelCatalog.js` — pure catalog logic: noise filter, prefix-sibling rule, family-root rule, featured derivation. No I/O, fully unit-testable.
- `src/changeSession.js` — single source of truth for the active change set and per-path status, with subscribe/notify.
- `src/changePreview.js` — pure preview projection (`applyPendingToData`) + path-keyed DOM marking (`markChangedNodes`).
- `src/spellcheck.js` — spellcheck opt-out list and (stage 2) range→highlight painting.
- `src/components/onboarding/GapReport.jsx` — renders the post-generation gap list.
- `test/modelCatalog.test.js`, `test/grounding.test.js`, `test/changeSession.test.js`, `test/changePreview.test.js`, `test/sectionAreas.test.js`

**Modified**
- `src/aiService.js` — widened catalog cache, `CATALOG_UPDATED_EVENT`, grounding rules, gap parsing.
- `src/components/chat/useChat.js` — `AI_MODELS` const → live function.
- `src/components/chat/ModelSelector.jsx` — search, featured/all split, refresh state, shrink fix.
- `src/components/chat/ChatComposer.jsx` — ResizeObserver compact mode, shrink fixes.
- `src/renderer.js` — `paragraph` section type, area partitioning across 11 layouts.
- `src/store.js` — `area` migration in `setData`.
- `src/components/structure/StructurePanel.jsx` — section area picker, relabel, paragraph option.
- `src/inlineChanges.js` — gutted; delegates to `changeSession` + `changePreview`.
- `src/components/DiffDialog.jsx`, `src/components/chat/MessageList.jsx` — read status from `changeSession`.
- `src/components/ui/input.jsx`, `src/components/ui/textarea.jsx`, `src/inlineEditor.js` — spellcheck attributes.
- `src/onboardingLogic.js`, `src/components/onboarding/OnboardingWizard.jsx` — grounding + gap plumbing.

---

## Task 1: Spellcheck capability spike (gate)

This is a **manual investigation task**. It produces a decision, not a feature. It runs first because a negative result changes what Task 19 can be.

**Files:**
- Create: `docs/superpowers/notes/2026-07-25-spellcheck-spike.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded verdict — `CUSTOM_HIGHLIGHT_SUPPORTED: true|false` and `SPELLING_ERROR_DECORATION_SUPPORTED: true|false` — that Task 19 branches on.

- [ ] **Step 1: Launch the real webview**

ClaudePreview is Chromium and **cannot** answer this. Run:

```bash
cd resume-designer && npm run tauri:dev
```

First run compiles Rust; this takes several minutes.

- [ ] **Step 2: Probe the WKWebView for both capabilities**

Open the app's devtools (right-click → Inspect Element, or Cmd+Opt+I) and run in the console:

```js
(() => {
  const highlight = typeof CSS !== 'undefined' && 'highlights' in CSS;
  const probe = document.createElement('span');
  probe.style.textDecorationLine = 'spelling-error';
  const decoration = probe.style.textDecorationLine === 'spelling-error';
  return { CUSTOM_HIGHLIGHT_SUPPORTED: highlight, SPELLING_ERROR_DECORATION_SUPPORTED: decoration };
})()
```

- [ ] **Step 3: Verify native spellcheck reaches the context menu**

Still in the running app, in the console:

```js
(() => {
  const p = document.createElement('p');
  p.contentEditable = 'true';
  p.spellcheck = true;
  p.textContent = 'This sentance has a mispelled word.';
  p.style.cssText = 'position:fixed;top:80px;left:20px;z-index:99999;background:#fff;padding:8px;';
  document.body.appendChild(p);
  return 'probe added — click into it, then right-click a red word';
})()
```

Click into the paragraph, then right-click `sentance`. Record whether (a) a squiggle appears, (b) the context menu offers spelling suggestions. Remove the probe afterwards with `document.querySelectorAll('[style*="99999"]').forEach(e=>e.remove())`.

- [ ] **Step 4: Record the verdict**

Write `docs/superpowers/notes/2026-07-25-spellcheck-spike.md` with the three booleans, the macOS version, and the WKWebView/Safari version (`navigator.userAgent`). State plainly which Task 19 branch is now live:

- Both CSS capabilities true → **Task 19 proceeds as specified.**
- Either false → **STOP and report to the user.** Do not silently substitute a bundled JS dictionary; the spec routes that decision back to them.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-07-25-spellcheck-spike.md
git commit -m "docs(spellcheck): record wkwebview capability spike results"
```

---

## Task 2: Native spellcheck attributes

**Files:**
- Create: `src/spellcheck.js`
- Modify: `src/components/ui/input.jsx`, `src/components/ui/textarea.jsx`, `src/inlineEditor.js:802`, `src/components/chat/ModelSelector.jsx:96`
- Test: `test/spellcheck.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `shouldSpellcheck(fieldKind: string): boolean` — Task 19 reuses it.

- [ ] **Step 1: Write the failing test**

Create `test/spellcheck.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { shouldSpellcheck } from '../src/spellcheck.js';

describe('shouldSpellcheck', () => {
  it('enables spellcheck for prose fields', () => {
    expect(shouldSpellcheck('prose')).toBe(true);
    expect(shouldSpellcheck(undefined)).toBe(true);
  });

  it('disables spellcheck for identifier fields', () => {
    expect(shouldSpellcheck('identifier')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/spellcheck.test.js`
Expected: FAIL — `Failed to resolve import "../src/spellcheck.js"`

- [ ] **Step 3: Write minimal implementation**

Create `src/spellcheck.js`:

```js
/**
 * Spellcheck policy. Prose gets the OS spellchecker; identifiers (model slugs,
 * URLs, file paths) do not — squiggling `anthropic/claude-opus-5` is noise.
 */

// Field kinds that must NOT be spellchecked.
const IDENTIFIER_KINDS = new Set(['identifier', 'slug', 'url', 'code']);

/** @param {string} [fieldKind] @returns {boolean} */
export function shouldSpellcheck(fieldKind) {
  return !IDENTIFIER_KINDS.has(fieldKind);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/spellcheck.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Default spellcheck on in the UI primitives**

In `src/components/ui/input.jsx`, the component currently spreads `...props` onto `<input>`. Add a `spellCheck` default **before** the spread so callers can still override:

```jsx
const Input = React.forwardRef(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      spellCheck
      className={cn(/* existing classes unchanged */)}
      ref={ref}
      {...props}
    />
  )
})
```

Do the same in `src/components/ui/textarea.jsx` — add `spellCheck` immediately before `{...props}`.

Because `{...props}` comes last, any explicit `spellCheck={false}` from a caller wins.

- [ ] **Step 6: Enable spellcheck on the inline editor**

In `src/inlineEditor.js`, find line 802 (`element.contentEditable = 'true';`) and add the spellcheck flag directly beneath it:

```js
  element.contentEditable = 'true';
  element.spellcheck = true;
```

And at line 846 (`element.contentEditable = 'false';`), turn it back off so idle resume text carries no spellcheck state:

```js
  element.contentEditable = 'false';
  element.spellcheck = false;
```

- [ ] **Step 7: Opt the model-slug field out**

In `src/components/chat/ModelSelector.jsx`, the custom-slug `<Input>` (around line 96) is an identifier field. Add the opt-out:

```jsx
                <Input
                  className={cn('h-[30px] font-mono text-xs', invalid && 'border-destructive')}
                  aria-invalid={invalid || undefined}
                  spellCheck={false}
                  placeholder="Custom slug, e.g. anthropic/claude-opus-4.8"
                  value={slug}
                  onChange={(e) => { setSlug(e.target.value); setInvalid(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applySlug(); } }}
                />
```

- [ ] **Step 8: Verify nothing regressed**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: all suites PASS, lint clean.

- [ ] **Step 9: Commit**

```bash
git add src/spellcheck.js test/spellcheck.test.js src/components/ui/input.jsx src/components/ui/textarea.jsx src/inlineEditor.js src/components/chat/ModelSelector.jsx
git commit -m "feat(spellcheck): enable native spellcheck on editable surfaces"
```

---

## Task 3: Catalog record widening + schema version

**Files:**
- Modify: `src/aiService.js:285-340`
- Test: `test/modelCatalog.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: cached catalog shape `{ version: number, fetchedAt: number, models: Record<string, CatalogEntry> }` where `CatalogEntry = { id, name, created, contextLength, maxTokens, reasoning, outputModalities }`. Tasks 4–6 read this.

- [ ] **Step 1: Write the failing test**

Create `test/modelCatalog.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { toCatalogEntry, CATALOG_SCHEMA_VERSION } from '../src/modelCatalog.js';

const RAW = {
  id: 'anthropic/claude-opus-5',
  name: 'Claude Opus 5',
  created: 1784912546,
  context_length: 1000000,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  top_provider: { max_completion_tokens: 128000 },
  supported_parameters: ['reasoning', 'max_tokens'],
};

describe('toCatalogEntry', () => {
  it('keeps the fields the picker and request path need', () => {
    expect(toCatalogEntry(RAW)).toEqual({
      id: 'anthropic/claude-opus-5',
      name: 'Claude Opus 5',
      created: 1784912546,
      contextLength: 1000000,
      maxTokens: 128000,
      reasoning: true,
      outputModalities: ['text'],
    });
  });

  it('defaults missing optional fields without throwing', () => {
    const e = toCatalogEntry({ id: 'x/y' });
    expect(e.reasoning).toBe(false);
    expect(e.maxTokens).toBe(null);
    expect(e.outputModalities).toEqual([]);
  });

  it('pins a schema version so old caches are discarded', () => {
    expect(CATALOG_SCHEMA_VERSION).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/modelCatalog.test.js`
Expected: FAIL — `Failed to resolve import "../src/modelCatalog.js"`

- [ ] **Step 3: Write minimal implementation**

Create `src/modelCatalog.js`:

```js
/**
 * Pure OpenRouter catalog logic — no I/O, no storage, no DOM. aiService.js owns
 * fetching and caching; this module owns *meaning*: which models are
 * general-purpose chat models, and which are "featured".
 */

// Bumped whenever the cached entry shape changes. aiService discards any cache
// whose version differs rather than misreading an older, narrower record.
export const CATALOG_SCHEMA_VERSION = 2;

/** Reduce one raw /models entry to the fields we actually use. */
export function toCatalogEntry(raw) {
  const arch = (raw && raw.architecture) || {};
  const top = (raw && raw.top_provider) || {};
  const params = Array.isArray(raw && raw.supported_parameters) ? raw.supported_parameters : [];
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    created: typeof raw.created === 'number' ? raw.created : 0,
    contextLength: typeof raw.context_length === 'number' ? raw.context_length : null,
    maxTokens: typeof top.max_completion_tokens === 'number' ? top.max_completion_tokens : null,
    reasoning: params.includes('reasoning'),
    outputModalities: Array.isArray(arch.output_modalities) ? arch.output_modalities : [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/modelCatalog.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the widened entry into the fetch + cache**

In `src/aiService.js`, add to the imports at the top of the file:

```js
import { toCatalogEntry, CATALOG_SCHEMA_VERSION } from './modelCatalog.js';
```

Replace the body of `readCatalogCache` (line 296) so it rejects stale schemas:

```js
function readCatalogCache() {
  if (catalogMemo) return catalogMemo;
  try {
    const parsed = JSON.parse(appStorage.getItem(CATALOG_STORAGE_KEY) || 'null');
    if (parsed && parsed.models && typeof parsed.fetchedAt === 'number'
        && parsed.version === CATALOG_SCHEMA_VERSION) {
      catalogMemo = parsed;
      return parsed;
    }
  } catch (_) { /* ignore corrupt cache */ }
  return null;
}
```

Then in `fetchModelCatalog` (line 313), replace the reduction loop and the `fresh` object:

```js
      const models = {};
      for (const m of (data && data.data) || []) {
        if (!m || typeof m.id !== 'string') continue;
        models[m.id] = toCatalogEntry(m);
      }
      const fresh = { version: CATALOG_SCHEMA_VERSION, fetchedAt: Date.now(), models };
```

- [ ] **Step 6: Run the full suite**

Run: `cd resume-designer && npm run test`
Expected: all PASS. `modelSupportsReasoning` still reads `entry.reasoning`, which the widened entry still carries.

- [ ] **Step 7: Commit**

```bash
git add src/modelCatalog.js test/modelCatalog.test.js src/aiService.js
git commit -m "feat(models): widen cached catalog records and version the cache"
```

---

## Task 4: Featured-model derivation

**Files:**
- Modify: `src/modelCatalog.js`
- Test: `test/modelCatalog.test.js`

**Interfaces:**
- Consumes: `toCatalogEntry` output from Task 3.
- Produces: `deriveFeatured(entries: CatalogEntry[], perProvider?: number): Record<string, CatalogEntry[]>` keyed by display label ("Anthropic", "OpenAI", …). Task 5 consumes it. Also `isGeneralChatModel(entry)` and `familyRoot(id)`.

- [ ] **Step 1: Write the failing test**

Append to `test/modelCatalog.test.js`:

```js
import { deriveFeatured, isGeneralChatModel, familyRoot } from '../src/modelCatalog.js';

const entry = (id, created, outputModalities = ['text']) =>
  ({ id, name: id, created, contextLength: null, maxTokens: null, reasoning: true, outputModalities });

describe('isGeneralChatModel', () => {
  it('rejects free tiers, dated snapshots, and task-specific variants', () => {
    expect(isGeneralChatModel(entry('openai/gpt-oss-20b:free', 1))).toBe(false);
    expect(isGeneralChatModel(entry('openai/gpt-4o-2024-11-20', 1))).toBe(false);
    expect(isGeneralChatModel(entry('openai/gpt-5.3-codex', 1))).toBe(false);
    expect(isGeneralChatModel(entry('openai/gpt-5-image', 1))).toBe(false);
    expect(isGeneralChatModel(entry('google/gemma-4-26b-a4b-it', 1))).toBe(false);
  });

  it('rejects models that do not output plain text', () => {
    expect(isGeneralChatModel(entry('openai/gpt-audio', 1, ['audio']))).toBe(false);
  });

  it('accepts ordinary chat models', () => {
    expect(isGeneralChatModel(entry('anthropic/claude-opus-5', 1))).toBe(true);
  });
});

describe('familyRoot', () => {
  it('collapses version digits so successive releases share a root', () => {
    expect(familyRoot('anthropic/claude-opus-5')).toBe('claude-opus-#');
    expect(familyRoot('anthropic/claude-opus-4.8')).toBe('claude-opus-#');
  });
});

describe('deriveFeatured', () => {
  const catalog = [
    entry('anthropic/claude-opus-5-fast', 300),
    entry('anthropic/claude-opus-5', 300),
    entry('anthropic/claude-opus-4.8', 200),
    entry('anthropic/claude-sonnet-5', 250),
    entry('openai/gpt-5.6-sol-pro', 280),
    entry('openai/gpt-5.6-sol', 280),
    entry('openai/gpt-4o-2024-11-20', 100),
  ];

  it('prefers the base model over its -fast/-pro sibling', () => {
    const ids = deriveFeatured(catalog).Anthropic.map((m) => m.id);
    expect(ids).toContain('anthropic/claude-opus-5');
    expect(ids).not.toContain('anthropic/claude-opus-5-fast');
  });

  it('keeps only the newest model per family', () => {
    const ids = deriveFeatured(catalog).Anthropic.map((m) => m.id);
    expect(ids).not.toContain('anthropic/claude-opus-4.8');
  });

  it('groups by provider label and orders newest first', () => {
    const featured = deriveFeatured(catalog);
    expect(featured.Anthropic.map((m) => m.id))
      .toEqual(['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5']);
    expect(featured.OpenAI.map((m) => m.id)).toEqual(['openai/gpt-5.6-sol']);
  });

  it('caps each provider at perProvider entries', () => {
    expect(deriveFeatured(catalog, 1).Anthropic).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/modelCatalog.test.js`
Expected: FAIL — `deriveFeatured is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/modelCatalog.js`:

```js
// Featured providers, in display order. Anthropic and OpenAI lead by request.
const FEATURED_PROVIDERS = [
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['google', 'Google'],
  ['x-ai', 'xAI'],
  ['deepseek', 'DeepSeek'],
  ['mistralai', 'Mistral'],
];

// Task- or modality-specific lines that are never a general chat default.
const VARIANT_NOISE = /(-image|-audio|-tts|-embed|-search-preview|-deep-research|-codex|-oss|-instruct|gemma)/;
// Pinned dated snapshots, e.g. gpt-4o-2024-11-20.
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/** Is this a general-purpose, text-output chat model worth featuring? */
export function isGeneralChatModel(entry) {
  if (!entry || typeof entry.id !== 'string' || !entry.id.includes('/')) return false;
  if (entry.id.includes(':')) return false;               // :free, :extended tiers
  const name = entry.id.slice(entry.id.indexOf('/') + 1);
  if (VARIANT_NOISE.test(name) || DATED_SNAPSHOT.test(name)) return false;
  const out = entry.outputModalities || [];
  return out.length === 1 && out[0] === 'text';
}

/**
 * Version-agnostic family key: digits collapse to '#', so claude-opus-5 and
 * claude-opus-4.8 share a root and only the newest survives.
 */
export function familyRoot(id) {
  return id.slice(id.indexOf('/') + 1).replace(/\d+(\.\d+)*/g, '#');
}

/**
 * Derive the "featured" shortlist live from the catalog. Two structural rules,
 * deliberately free of vendor-specific version parsing (which was prototyped
 * and rejected — it picked -fast/-pro over their cheaper base siblings):
 *
 *   1. prefix-sibling — drop X when another surviving id is a strict prefix of
 *      it, so `claude-opus-5` beats `claude-opus-5-fast`.
 *   2. family-root    — keep only the newest model per version-agnostic root.
 */
export function deriveFeatured(entries, perProvider = 4) {
  const grouped = {};
  for (const [prefix, label] of FEATURED_PROVIDERS) {
    const pool = entries.filter((m) => m.id.startsWith(`${prefix}/`) && isGeneralChatModel(m));
    if (pool.length === 0) continue;

    const ids = pool.map((m) => m.id);
    const bases = pool.filter((m) => !ids.some((o) => o !== m.id && m.id.startsWith(`${o}-`)));

    const byRoot = new Map();
    for (const m of [...bases].sort((a, b) => b.created - a.created)) {
      const root = familyRoot(m.id);
      if (!byRoot.has(root)) byRoot.set(root, m);
    }

    const top = [...byRoot.values()].sort((a, b) => b.created - a.created).slice(0, perProvider);
    if (top.length) grouped[label] = top;
  }
  return grouped;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/modelCatalog.test.js`
Expected: PASS (all 11 tests)

- [ ] **Step 5: Sanity-check against the real catalog**

```bash
cd resume-designer && node --input-type=module -e "
import { toCatalogEntry, deriveFeatured } from './src/modelCatalog.js';
const raw = await (await fetch('https://openrouter.ai/api/v1/models')).json();
const f = deriveFeatured(raw.data.map(toCatalogEntry));
for (const [g, ms] of Object.entries(f)) console.log(g, '→', ms.map(m=>m.id).join(', '));
"
```

Expected: Anthropic leads with the current Opus/Sonnet base models (no `-fast`), OpenAI with current GPT base models (no `-pro`), and no dated snapshots or `:free` entries anywhere.

- [ ] **Step 6: Commit**

```bash
git add src/modelCatalog.js test/modelCatalog.test.js
git commit -m "feat(models): derive featured shortlist live from the catalog"
```

---

## Task 5: Catalog refresh event + live `getAllModels`

**Files:**
- Modify: `src/aiService.js` (`getAllModels` at 1306, `fetchModelCatalog` at 313, exports)
- Test: `test/modelCatalog.test.js`

**Interfaces:**
- Consumes: `deriveFeatured` (Task 4), widened cache (Task 3).
- Produces:
  - `CATALOG_UPDATED_EVENT: string` — window CustomEvent name.
  - `getAllModels(): Record<string, {id, model, label, group}[]>` — unchanged signature, now catalog-backed with the hardcoded `MODELS` map as offline fallback.
  - `getAllCatalogModels(): CatalogEntry[]` — the full 345 for the "All models" list.
  - `refreshCatalogIfStale(): void` — fire-and-forget stale-while-revalidate, used on picker open.

- [ ] **Step 1: Write the failing test**

Append to `test/modelCatalog.test.js`:

```js
import { CATALOG_SOFT_TTL_MS } from '../src/modelCatalog.js';

describe('catalog refresh policy', () => {
  it('uses a short soft TTL so opening the picker revalidates', () => {
    expect(CATALOG_SOFT_TTL_MS).toBe(5 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/modelCatalog.test.js`
Expected: FAIL — `expected undefined to be 300000`

- [ ] **Step 3: Add the soft TTL constant**

Append to `src/modelCatalog.js`:

```js
// Opening a model picker revalidates if the cache is older than this. The 24h
// hard TTL in aiService still backs the reasoning-support path; this only
// governs how eagerly the picker refreshes.
export const CATALOG_SOFT_TTL_MS = 5 * 60 * 1000;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/modelCatalog.test.js`
Expected: PASS

- [ ] **Step 5: Make `getAllModels` catalog-backed**

In `src/aiService.js`, extend the Task 3 import:

```js
import {
  toCatalogEntry, CATALOG_SCHEMA_VERSION, deriveFeatured, CATALOG_SOFT_TTL_MS,
} from './modelCatalog.js';
```

Add the event name near the other catalog constants (around line 290):

```js
export const CATALOG_UPDATED_EVENT = 'resume-designer-catalog-updated';
```

Replace `getAllModels` (line 1306) entirely:

```js
/**
 * Models grouped for the picker's "Featured" section. Derived live from the
 * cached OpenRouter catalog; falls back to the built-in MODELS shortlist when
 * the catalog has never loaded (first run, offline).
 */
export function getAllModels() {
  const cached = readCatalogCache();
  const entries = cached ? Object.values(cached.models) : [];
  if (entries.length) {
    const grouped = {};
    for (const [group, models] of Object.entries(deriveFeatured(entries))) {
      grouped[group] = models.map((m) => ({ id: m.id, model: m.id, label: m.name, group }));
    }
    if (Object.keys(grouped).length) return grouped;
  }
  // Offline / first run — the hardcoded shortlist is the backstop.
  const fallback = {};
  for (const [id, config] of Object.entries(MODELS)) {
    (fallback[config.group] = fallback[config.group] || []).push({
      id, model: id, label: config.label, group: config.group,
    });
  }
  return fallback;
}

/** Every catalog model, newest first — backs the picker's searchable list. */
export function getAllCatalogModels() {
  const cached = readCatalogCache();
  if (!cached) return [];
  return Object.values(cached.models).sort((a, b) => b.created - a.created);
}

/** Stale-while-revalidate: refresh in the background if the soft TTL lapsed. */
export function refreshCatalogIfStale() {
  const cached = readCatalogCache();
  if (cached && (Date.now() - cached.fetchedAt) < CATALOG_SOFT_TTL_MS) return;
  fetchModelCatalog(true);
}
```

- [ ] **Step 6: Broadcast when a fetch lands**

In `fetchModelCatalog`, immediately after `try { appStorage.setItem(...) } catch (_) {}`, notify listeners:

```js
      try { appStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(fresh)); } catch (_) { /* quota */ }
      try {
        window.dispatchEvent(new CustomEvent(CATALOG_UPDATED_EVENT, { detail: { fetchedAt: fresh.fetchedAt } }));
      } catch (_) { /* non-DOM context */ }
      return fresh;
```

- [ ] **Step 7: Use catalog maxTokens on the request path**

In `callOpenRouter` (around line 908), the request currently reads `cfg?.maxTokens` from the hardcoded map only. Let the catalog supply it for non-curated slugs. Directly above the `requestBody` construction, add:

```js
  const catalogEntry = readCatalogCache()?.models?.[modelId];
  const modelMaxTokens = cfg?.maxTokens || catalogEntry?.maxTokens || 8192;
```

and replace the `max_tokens` line with:

```js
    max_tokens: reasoningOn ? Math.max(modelMaxTokens, 16000) : modelMaxTokens,
```

- [ ] **Step 8: Run the full suite and lint**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: all PASS, lint clean.

- [ ] **Step 9: Commit**

```bash
git add src/modelCatalog.js test/modelCatalog.test.js src/aiService.js
git commit -m "feat(models): back the picker with the live catalog and broadcast refreshes"
```

---

## Task 6: Live `AI_MODELS` in useChat

`AI_MODELS` is currently a module-level constant evaluated once at import — it can never reflect a live catalog. This task converts it to a function and subscribes the hook to catalog updates.

**Files:**
- Modify: `src/components/chat/useChat.js:19-25`, `:41-60`, and the hook body around `:171`
- Test: none (covered by Task 4's derivation tests; this is wiring)

**Interfaces:**
- Consumes: `getAllModels`, `CATALOG_UPDATED_EVENT`, `refreshCatalogIfStale` (Task 5).
- Produces: `getAIModels(): {group, options: {value, label}[]}[]` replacing the `AI_MODELS` constant. `getModelLabel(value)` keeps its signature. `ModelSelector` (Task 7) consumes both.

- [ ] **Step 1: Replace the constant with a function**

In `src/components/chat/useChat.js`, replace lines 19–25:

```js
// AI model catalog for the picker's Featured section. This MUST be a function,
// not a module constant: the catalog refreshes at runtime, and a constant
// evaluated at import time could never reflect it.
// Shape: [{ group, options: [{ value: slug, label }] }]
export function getAIModels() {
  return Object.entries(getAllModels()).map(([group, models]) => ({
    group,
    options: models.map((m) => ({ value: m.id, label: m.label })),
  }));
}
```

- [ ] **Step 2: Make `getModelLabel` catalog-aware**

Replace the loop at the top of `getModelLabel` (line 43) so it reads the live groups, then falls back to the full catalog before prettifying:

```js
export function getModelLabel(value) {
  if (!value) return 'Select Model';
  for (const group of getAIModels()) {
    for (const opt of group.options) {
      if (opt.value === value) return opt.label;
    }
  }
  const fromCatalog = getAllCatalogModels().find((m) => m.id === value);
  if (fromCatalog) return fromCatalog.name;
  // Custom slug not in the catalog — prettify the model part of the slug.
```

Leave the rest of the function body unchanged.

- [ ] **Step 3: Extend the import**

Update the `aiService.js` import block at the top of `useChat.js` to add the three new names:

```js
  modelSupportsReasoning, getCustomModels, removeCustomModel, fetchModelCatalog,
  getAllCatalogModels, refreshCatalogIfStale, CATALOG_UPDATED_EVENT,
```

- [ ] **Step 4: Re-render the hook when the catalog lands**

Inside the hook body, next to the existing `customModels` state (line 171), add a catalog revision counter and subscribe to the event:

```js
  // Bumped whenever a catalog refresh lands, so every model picker re-renders
  // with the new list. Mirrors the SETTINGS_UPDATED_EVENT pattern.
  const [catalogRev, setCatalogRev] = useState(0);
  useEffect(() => {
    const onCatalog = () => setCatalogRev((n) => n + 1);
    window.addEventListener(CATALOG_UPDATED_EVENT, onCatalog);
    return () => window.removeEventListener(CATALOG_UPDATED_EVENT, onCatalog);
  }, []);
```

- [ ] **Step 5: Expose the refresh trigger and revision from the hook**

Find the hook's return object (around line 1102, the line listing `configured, configuredProviders, reasoningSupported, customModels,`) and add:

```js
    catalogRev, refreshCatalog: refreshCatalogIfStale,
```

- [ ] **Step 6: Fix remaining `AI_MODELS` references**

Run: `cd resume-designer && grep -rn "AI_MODELS" src/`
Expected after this task: only `ModelSelector.jsx` still references it (fixed in Task 7). Any other hit must be converted to `getAIModels()`.

- [ ] **Step 7: Run the suite**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: all PASS, lint clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/chat/useChat.js
git commit -m "refactor(chat): make the model list a live function rather than an import-time constant"
```

---

## Task 7: Model picker — featured + searchable all-models

**Files:**
- Modify: `src/components/chat/ModelSelector.jsx` (whole component), `src/components/chat/ChatComposer.jsx:214-222`
- Test: none (UI; verified in Step 7)

**Interfaces:**
- Consumes: `getAIModels`, `getModelLabel` (Task 6); `getAllCatalogModels`, `refreshCatalogIfStale` (Task 5).
- Produces: `ModelSelector` gains props `catalogRev: number`, `onRefreshCatalog: () => void`.

- [ ] **Step 1: Add search and the all-models section**

In `src/components/chat/ModelSelector.jsx`, update the imports:

```jsx
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, Settings2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import { getAIModels, getModelLabel } from './useChat.js';
import { getAllCatalogModels } from '../../aiService.js';
```

Change the signature to accept the two new props:

```jsx
export function ModelSelector({
  currentModel, configured, customModels, catalogRev, onRefreshCatalog,
  onSelect, onApplyCustomSlug, onRemoveCustom, onConfigure,
}) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [invalid, setInvalid] = useState(false);

  // Recomputed when the popover opens or a catalog refresh lands.
  const featured = useMemo(() => getAIModels(), [open, catalogRev]);
  const allModels = useMemo(() => getAllCatalogModels(), [open, catalogRev]);

  // Stale-while-revalidate: the lists above render from cache immediately, and
  // this kicks a background refresh that swaps them in via catalogRev.
  useEffect(() => {
    if (open && configured) onRefreshCatalog();
  }, [open, configured, onRefreshCatalog]);

  const featuredIds = useMemo(
    () => new Set(featured.flatMap((g) => g.options.map((o) => o.value))),
    [featured],
  );
```

- [ ] **Step 2: Replace the `CommandList` block**

Replace the `<Command>` element (lines 54–91 of the original) with:

```jsx
            <Command>
              <CommandInput placeholder="Search 300+ models…" />
              <CommandList className="max-h-[300px]">
                <CommandEmpty>No model matches.</CommandEmpty>

                {featured.map((group) => (
                  <CommandGroup
                    key={group.group}
                    heading={group.group}
                    className="[&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-primary"
                  >
                    {group.options.map((opt) => (
                      <CommandItem key={opt.value} value={opt.value} onSelect={() => pick(opt.value)}>
                        <Check className={cn('size-4', opt.value !== currentModel && 'opacity-0')} />
                        <span className="min-w-0 truncate">{opt.label}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}

                {customModels.length > 0 && (
                  <CommandGroup heading="Custom">
                    {customModels.map((s) => (
                      <CommandItem key={s} value={s} onSelect={() => pick(s)}>
                        <Check className={cn('size-4', s !== currentModel && 'opacity-0')} />
                        <span className="min-w-0 flex-1 truncate">{getModelLabel(s)}</span>
                        <span
                          role="button"
                          aria-label="Remove"
                          title="Remove from list"
                          className="ml-auto rounded-sm p-0.5 text-muted-foreground hover:bg-muted-foreground/20 hover:text-destructive"
                          onClick={(e) => { e.stopPropagation(); onRemoveCustom(s); }}
                        >
                          <X className="size-3.5" />
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {allModels.length > 0 && (
                  <CommandGroup heading="All models">
                    {allModels.filter((m) => !featuredIds.has(m.id)).map((m) => (
                      <CommandItem key={m.id} value={m.id} onSelect={() => pick(m.id)}>
                        <Check className={cn('size-4', m.id !== currentModel && 'opacity-0')} />
                        <span className="min-w-0 truncate">{m.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
```

- [ ] **Step 3: Show catalog state when it is empty**

Directly beneath the `</Command>` closing tag, before the custom-slug `<div className="border-t p-2">`, add:

```jsx
            {allModels.length === 0 && (
              <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Loading the model catalog…
              </div>
            )}
```

- [ ] **Step 4: Fix the trigger so it can shrink**

Replace the `PopoverTrigger` button's className (line 45 of the original) — `max-w-40` becomes a flexible, truncating item, which Task 8 depends on:

```jsx
          className="h-7 min-w-0 flex-1 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
```

- [ ] **Step 5: Pass the new props from the composer**

In `src/components/chat/ChatComposer.jsx`, add the two props to the `ChatComposer` signature (after `customModels,` on line 51):

```jsx
  currentModel, configured, customModels, catalogRev, onRefreshCatalog,
```

and forward them in the `<ModelSelector>` element at line 214:

```jsx
          <ModelSelector
            currentModel={currentModel}
            configured={configured}
            customModels={customModels}
            catalogRev={catalogRev}
            onRefreshCatalog={onRefreshCatalog}
            onSelect={onSelectModel}
            onApplyCustomSlug={onApplyCustomSlug}
            onRemoveCustom={onRemoveCustom}
            onConfigure={onConfigure}
          />
```

- [ ] **Step 6: Thread them from ChatPanel**

Run `cd resume-designer && grep -n "ChatComposer" src/components/chat/ChatPanel.jsx` to find the render site, and add `catalogRev={chat.catalogRev}` and `onRefreshCatalog={chat.refreshCatalog}` to the props it already spreads from the `useChat` return.

- [ ] **Step 7: Verify in the browser preview**

```bash
cd resume-designer && npm run dev
```

Open the chat panel, click the model button. Confirm: the search box filters; "Featured" shows current models; "All models" lists the rest; picking a model closes the popover. (An OpenRouter key is required for the picker to render — without one it shows the Configure state, which is also correct.)

- [ ] **Step 8: Commit**

```bash
git add src/components/chat/ModelSelector.jsx src/components/chat/ChatComposer.jsx src/components/chat/ChatPanel.jsx
git commit -m "feat(chat): add model search and a live all-models section to the picker"
```

---

## Task 8: Composer narrow-width handling

**Files:**
- Modify: `src/components/chat/ChatComposer.jsx:56-66`, `:213-280`
- Test: none (layout; verified in Steps 5–6)

**Interfaces:**
- Consumes: the flexible `ModelSelector` trigger from Task 7 Step 4.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the compact-width observer**

In `src/components/chat/ChatComposer.jsx`, add to the React import on line 1:

```jsx
import { useEffect, useRef, useState } from 'react';
```

Add the threshold constant next to `COMMANDS_NEEDING_ARGS` (line 25):

```jsx
// Below this control-row width the reasoning control drops its text label. The
// chat panel resizes independently of the viewport (240–500px, ChatPanel.jsx),
// so a viewport media query would be measuring the wrong box — hence a
// ResizeObserver rather than a Tailwind breakpoint.
const COMPACT_ROW_WIDTH = 300;
```

Inside the component, beside the existing refs (line 56):

```jsx
  const controlsRef = useRef(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = controlsRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width < COMPACT_ROW_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
```

- [ ] **Step 2: Attach the ref and stop the controls from crushing**

Replace the controls row opening tag (line 213):

```jsx
        <div ref={controlsRef} className="flex items-center gap-1 px-1.5 pb-1.5 pt-0.5">
```

Add `shrink-0` to the web-search button's className (line 229):

```jsx
            className={cn('size-7 shrink-0', webSearchEnabled && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary')}
```

Add `shrink-0` to the send button (line 272):

```jsx
            className="ml-auto size-[30px] shrink-0 rounded-lg"
```

- [ ] **Step 3: Collapse the reasoning control**

Replace the reasoning `PopoverTrigger` button (lines 239–249):

```jsx
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-7 shrink-0 gap-1 text-xs font-normal text-muted-foreground', compact ? 'px-1.5' : 'px-2')}
                disabled={!reasoningSupported}
                title={reasoningSupported ? `Reasoning effort: ${reasoningLabel(reasoningEffort)}` : 'Reasoning not available for this model'}
                aria-label={reasoningSupported ? `Reasoning effort: ${reasoningLabel(reasoningEffort)}` : 'Reasoning not available for this model'}
              >
                <Brain className="size-3.5" />
                {!compact && <span>{reasoningSupported ? reasoningLabel(reasoningEffort) : 'N/A'}</span>}
                {!compact && <ChevronDown className="size-3 opacity-60" />}
              </Button>
```

The level stays reachable in `title`/`aria-label` when the text is hidden, so nothing becomes unreadable or unlabelled.

- [ ] **Step 4: Make the divider non-shrinking**

Replace line 224:

```jsx
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />
```

- [ ] **Step 5: Verify at the minimum panel width**

```bash
cd resume-designer && npm run dev
```

With the chat panel open, drag its right edge fully left (240px minimum). Confirm: no icon overflows its button, the send button stays inside the composer card, the reasoning label is hidden, and the model name truncates with an ellipsis. Then in the devtools console:

```js
(() => {
  const row = document.querySelector('#chat-input')?.closest('.rounded-\\[12px\\]')?.lastElementChild;
  const r = row.getBoundingClientRect();
  return [...row.children].map(c => {
    const b = c.getBoundingClientRect();
    return { cls: c.className.slice(0, 24), w: +b.width.toFixed(1), overflows: b.right > r.right + 0.5 };
  });
})()
```

Expected: every `overflows` is `false`.

- [ ] **Step 6: Verify in the real webview**

```bash
cd resume-designer && npm run tauri:dev
```

Repeat the drag. Per the project rule, the shipped app is WKWebView and this is layout-sensitive — Chromium agreement is not sufficient evidence.

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/ChatComposer.jsx
git commit -m "fix(chat): keep composer controls legible at narrow sidebar widths"
```

---

## Task 9: Grounding rules in every prompt

**Files:**
- Modify: `src/aiService.js:54-160`, `:546-627`; `src/onboardingLogic.js:209-230`
- Test: `test/grounding.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `GROUNDING_RULES: string` exported from `aiService.js`; `buildGenerateResumePrompt(profileContext, jobDescription): string` exported so the prompt is testable without a network call.

- [ ] **Step 1: Write the failing test**

Create `test/grounding.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { GROUNDING_RULES, buildGenerateResumePrompt } from '../src/aiService.js';

describe('GROUNDING_RULES', () => {
  it('forbids inventing facts and metrics', () => {
    expect(GROUNDING_RULES).toMatch(/never invent/i);
    expect(GROUNDING_RULES).toMatch(/placeholder/i);
  });

  it('forbids inflating scope or seniority', () => {
    expect(GROUNDING_RULES).toMatch(/seniority|scope/i);
  });
});

describe('buildGenerateResumePrompt', () => {
  const prompt = buildGenerateResumePrompt('## User Profile\n- thing', {
    title: 'Designer', company: 'Acme', description: 'Do design.',
  });

  it('embeds the grounding rules', () => {
    expect(prompt).toContain(GROUNDING_RULES);
  });

  it('drops the phrasing that invited invention', () => {
    expect(prompt).not.toMatch(/BEST possible resume/);
    expect(prompt).not.toMatch(/quantify achievements where possible/i);
  });

  it('asks for a gaps array', () => {
    expect(prompt).toContain('"gaps"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/grounding.test.js`
Expected: FAIL — `GROUNDING_RULES` is not exported.

- [ ] **Step 3: Add the rules constant**

In `src/aiService.js`, add this **immediately after the `OPENROUTER_TITLE` constant (line 17)** — before `SYSTEM_PROMPT`, `CHANGE_GENERATION_PROMPT` and `JOB_ANALYSIS_PROMPT`, all of which interpolate it in Step 7 and would otherwise reference it before initialisation:

```js
// The single anti-fabrication contract, injected into every prompt that writes
// or rewrites résumé content. Users reported the assistant inventing employers,
// metrics and achievements; the prompts previously contained no constraint
// against it while actively asking for "the BEST possible resume".
const GROUNDING_RULES_TEXT = `TRUTHFULNESS — these rules override every other instruction, including any request to make the resume stronger or more competitive:
- Use ONLY facts present in the user's profile. Never invent employers, job titles, dates, degrees, certifications, tools, projects, or achievements.
- Never introduce a number, percentage, duration, team size, or currency figure that does not appear in the profile. If a metric would strengthen a bullet but the profile does not supply it, write the bullet WITHOUT the metric. Do not estimate, do not approximate, and do not emit placeholders such as "[X]%" or "N+".
- Rephrasing, reframing, reordering, condensing and emphasis are allowed. Adding new claims is not.
- Aligning with the job description means describing genuinely-held experience in the job's vocabulary. It NEVER means claiming skills, tools or domains the profile does not evidence.
- Never inflate scope or seniority. If the profile says "contributed to" or "assisted with", the resume may not say "led", "owned" or "drove".
- If the profile is too thin to fill a section well, leave it short. A shorter truthful resume is the correct output.`;

export const GROUNDING_RULES = GROUNDING_RULES_TEXT;
```

- [ ] **Step 4: Run test to verify the first two pass**

Run: `cd resume-designer && npx vitest run test/grounding.test.js`
Expected: the two `GROUNDING_RULES` tests PASS; the three `buildGenerateResumePrompt` tests still FAIL.

- [ ] **Step 5: Extract and fix the generation prompt**

In `src/aiService.js`, replace the inline `const prompt = ...` inside `generateResumeFromProfileForJob` (line 546) with a call, and add the extracted builder immediately **above** that function:

```js
/**
 * Build the generate-a-resume-for-this-job prompt. Extracted from
 * generateResumeFromProfileForJob so the wording is unit-testable without a
 * network call — the grounding rules are a correctness requirement, not styling.
 */
export function buildGenerateResumePrompt(profileContext, jobDescription) {
  return `You are an expert resume consultant and ATS optimization specialist. Create the strongest resume the user's profile truthfully supports, targeted at the job below.

${GROUNDING_RULES_TEXT}

${profileContext}

## Target Job

**Position:** ${jobDescription.title || 'Not specified'}
**Company:** ${jobDescription.company || 'Not specified'}

**Job Description:**
${jobDescription.description}

## Your Task

Create an ATS-optimized resume that:
1. Surfaces the experience and skills from the profile most relevant to this job
2. Uses the job description's vocabulary for experience the profile actually evidences
3. Orders experience by relevance (most relevant first), and ALSO provides
   machine-readable startDate/endDate per role so the app can re-sort chronologically
4. Writes a professional summary grounded in the profile and targeted at this position
5. Writes bullets that quantify results ONLY where the profile supplies the number
6. Includes 3-4 highlights that are DISTINCT, career-level achievements — not
   restatements of the experience bullets
7. Separates concrete tools/software from competency skills (see the fields below)
8. Reports, in "gaps", what this job asks for that the profile does not support

Return ONLY a valid JSON object (no code fences, no prose outside the JSON) in this exact format:
{
  "name": "Full Name from profile",
  "tagline": "Professional title supported by the profile",
  "email": "email from profile if available",
  "phone": "phone from profile if available",
  "location": "location from profile if available",
  "linkedin": "linkedin url if available",
  "portfolio": "portfolio url if available",
  "summary": "2-3 sentence summary, every claim traceable to the profile",
  "highlights": [
    "Career-level achievement, distinct from the experience bullets below",
    "Another high-level qualification matching the job (not repeated below)",
    "Summary-level achievement relevant to the role"
  ],
  "skills": ["competency1", "competency2", "... (at most 12, most relevant only)"],
  "tools": ["Concrete tool/software/platform e.g. Figma", "Git", "Docker"],
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "location": "City, State",
      "startDate": "YYYY-MM (machine-readable; YYYY ok if month unknown)",
      "endDate": "YYYY-MM or Present (machine-readable)",
      "dates": "Human-readable range shown on the resume, e.g. Jan 2022 - Jun 2024",
      "bullets": [
        "Achievement bullet drawn from the profile, relevant to the target job",
        "Another bullet highlighting relevant, evidenced skills"
      ]
    }
  ],
  "education": [
    { "degree": "Degree Name", "school": "School Name", "year": "Year" }
  ],
  "certifications": ["Certification present in the profile"],
  "gaps": [
    {
      "requirement": "What the job asks for that the profile does not support",
      "severity": "high | medium | low",
      "note": "One sentence on what the user would need to add to close it"
    }
  ]
}

IMPORTANT:
- Only include sections that have relevant content from the profile
- Order experience by relevance (most relevant first); ALWAYS include
  machine-readable startDate/endDate so the app can offer a chronological view
- Put concrete tools/software/platforms (e.g. Figma, Git, Docker, Excel) in
  "tools"; keep "skills" for competencies. Do NOT duplicate an item across both.
- Limit "highlights" to 3-4 entries, each a DISTINCT career-level achievement
- Select at most 12 of the most relevant skills (quality over quantity)
- Use action verbs, but never ones that overstate the profile's scope
- "gaps" must be honest and may be empty. Do NOT close a gap by inventing
  experience — reporting it is the correct behaviour.

${EMPHASIS_GUIDANCE}`;
}
```

Then replace the original `const prompt = \`...\`;` block (lines 546–627) with:

```js
  const prompt = buildGenerateResumePrompt(profileContext, jobDescription);
```

- [ ] **Step 6: Run test to verify all pass**

Run: `cd resume-designer && npx vitest run test/grounding.test.js`
Expected: PASS (5 tests)

- [ ] **Step 7: Inject the rules into the four remaining prompts**

In `src/aiService.js`, append the rules to each of these template literals, immediately before their closing backtick:

- `SYSTEM_PROMPT` (line 54) — append `\n\n${GROUNDING_RULES_TEXT}`
- `CHANGE_GENERATION_PROMPT` (line 82) — append `\n\n${GROUNDING_RULES_TEXT}` after `${EMPHASIS_GUIDANCE}`
- `JOB_ANALYSIS_PROMPT` (line 113) — append `\n\n${GROUNDING_RULES_TEXT}`

Step 3 already placed the declaration above all three, so no reordering is needed here.

In `src/onboardingLogic.js`, add to the `aiService.js` import on line 10:

```js
import { getDefaultModelId, chat, generateResumeFromProfileForJob, getAllModels, getCustomModels, isConfigured, GROUNDING_RULES } from './aiService.js';
```

and rewrite the `tailorResume` prompt opening (line 209) — the old wording asked the model to position the candidate as "ideal", which invites embellishment:

```js
  const prompt = `You are helping tailor a resume for specific job applications. Based on the resume and target job(s) below, create:

${GROUNDING_RULES}

1. A professional SUMMARY (2-3 sentences) positioning the candidate for the target role(s) using only what the resume below evidences
2. A HIGHLIGHTS section (3-4 bullet points) of DISTINCT, career-level achievements already present in the resume — NOT restatements of the experience bullets, and NOT new claims
3. Identify KEY SKILLS that match the job requirements AND appear in the resume
```

Leave the rest of that template (the resume/job context and JSON shape) unchanged.

- [ ] **Step 8: Run the full suite and lint**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: all PASS, lint clean.

- [ ] **Step 9: Commit**

```bash
git add src/aiService.js src/onboardingLogic.js test/grounding.test.js
git commit -m "fix(ai): forbid fabricated experience across every resume prompt"
```

---

## Task 10: Gap report parsing and display

**Files:**
- Modify: `src/aiService.js:638-654`, `src/onboardingLogic.js:176-179`, `src/components/onboarding/OnboardingWizard.jsx:245-256`
- Create: `src/components/onboarding/GapReport.jsx`
- Test: `test/grounding.test.js`

**Interfaces:**
- Consumes: the `gaps` field from Task 9's prompt.
- Produces: `parseGeneratedResume(responseText): { resume: object, gaps: Gap[] }` where `Gap = { requirement: string, severity: 'high'|'medium'|'low', note: string }`. `generateResumeFromProfileForJob` and `generateResumeForJob` now resolve to this object instead of the bare resume.

- [ ] **Step 1: Write the failing test**

Append to `test/grounding.test.js`:

```js
import { parseGeneratedResume } from '../src/aiService.js';

describe('parseGeneratedResume', () => {
  it('separates gaps from resume data', () => {
    const { resume, gaps } = parseGeneratedResume(JSON.stringify({
      name: 'Ada', summary: 'Engineer',
      gaps: [{ requirement: 'Kubernetes', severity: 'high', note: 'Not in profile.' }],
    }));
    expect(resume).toEqual({ name: 'Ada', summary: 'Engineer' });
    expect(resume.gaps).toBeUndefined();
    expect(gaps).toHaveLength(1);
  });

  it('tolerates a response with no gaps field', () => {
    const { resume, gaps } = parseGeneratedResume('{"name":"Ada"}');
    expect(resume.name).toBe('Ada');
    expect(gaps).toEqual([]);
  });

  it('strips code fences', () => {
    const { resume } = parseGeneratedResume('```json\n{"name":"Ada"}\n```');
    expect(resume.name).toBe('Ada');
  });

  it('throws a clear error on non-JSON', () => {
    expect(() => parseGeneratedResume('sorry, I cannot')).toThrow(/valid JSON/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/grounding.test.js`
Expected: FAIL — `parseGeneratedResume is not a function`

- [ ] **Step 3: Write the parser**

In `src/aiService.js`, add above `generateResumeFromProfileForJob`:

```js
/**
 * Parse a generate-resume response into résumé data plus the gap report.
 * `gaps` is stripped from the résumé object — it is advice about the résumé,
 * not a field of it, and would otherwise be persisted as résumé content.
 */
export function parseGeneratedResume(responseText) {
  let jsonStr = String(responseText || '').trim();
  const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonStr = fenced[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error('Failed to parse AI response as JSON:', responseText);
    throw new Error('AI response was not valid JSON. Please try again.');
  }

  const { gaps, ...resume } = parsed;
  return {
    resume,
    gaps: Array.isArray(gaps)
      ? gaps.filter((g) => g && typeof g.requirement === 'string')
      : [],
  };
}
```

Then replace the parse block at the end of `generateResumeFromProfileForJob` (lines 638–653) with:

```js
  const { resume, gaps } = parseGeneratedResume(response);
  console.log('[AI Service] Generated resume from profile:', resume, 'gaps:', gaps);
  return { resume, gaps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/grounding.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Update the two call sites**

In `src/onboardingLogic.js`, `generateResumeForJob` (line 176) just forwards, so its JSDoc must change but its body need not:

```js
/**
 * Generate a tailored resume from the saved profile for a target job.
 * @returns {Promise<{resume: Object, gaps: Array<{requirement: string, severity: string, note: string}>}>}
 */
export function generateResumeForJob(modelId, targetJob, reasoningEffort, options = {}) {
```

In `src/components/onboarding/OnboardingWizard.jsx`, add gap state beside the other wizard state, and unwrap the new shape in `generateForJob` (line 254):

```jsx
  const [jobGaps, setJobGaps] = useState([]);
```

```jsx
    const { resume, gaps } = await generateResumeForJob(model, job, reasoning, { hooks, signal });
    setParsedResume(resume);
    setJobGaps(gaps);
```

Then expose `jobGaps` wherever the wizard passes state down to its steps (follow the existing pattern used for `parsedResume`).

- [ ] **Step 6: Build the gap report component**

Create `src/components/onboarding/GapReport.jsx`:

```jsx
import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// Severity → badge treatment, matching the status-tinted Badge idiom used by
// AnalysisResults.jsx for keyword gaps.
const SEVERITY_STYLES = {
  high: 'bg-destructive/10 text-destructive',
  medium: 'bg-warning-bg text-warning',
  low: 'bg-muted text-muted-foreground',
};

/**
 * What the target job asks for that the profile does not support. Shown after
 * generation so a thin résumé reads as an actionable gap rather than a
 * disappointment — the assistant is no longer allowed to close these by
 * inventing experience.
 */
export function GapReport({ gaps }) {
  if (!gaps || gaps.length === 0) return null;

  return (
    <div className="space-y-2.5 rounded-[12px] border bg-muted/30 p-[14px]">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-warning" />
        <h4 className="text-[13px] font-semibold">Not covered by your profile</h4>
      </div>
      <p className="text-[12px] text-muted-foreground">
        These came up in the job description but aren’t supported by anything in your profile,
        so they were left out rather than invented. Add them to your profile if they apply.
      </p>
      <ul className="space-y-2">
        {gaps.map((gap, i) => (
          <li key={i} className="flex items-start gap-2">
            <Badge className={cn('shrink-0 capitalize', SEVERITY_STYLES[gap.severity] || SEVERITY_STYLES.low)}>
              {gap.severity || 'low'}
            </Badge>
            <span className="min-w-0 text-[12.5px]">
              <span className="font-medium">{gap.requirement}</span>
              {gap.note && <span className="text-muted-foreground"> — {gap.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 7: Render it on the post-generation step**

Run `cd resume-designer && grep -n "JobInputStep\|'done'" src/components/onboarding/OnboardingSteps.jsx` to locate the settled "done" screen described in the `generateForJob` comment, import `GapReport`, and render `<GapReport gaps={jobGaps} />` beneath the existing reasoning/token-usage summary.

- [ ] **Step 8: Run the suite and lint**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: all PASS, lint clean.

- [ ] **Step 9: Commit**

```bash
git add src/aiService.js src/onboardingLogic.js src/components/onboarding/ test/grounding.test.js
git commit -m "feat(ai): report job requirements the profile does not support"
```

---

## Task 11: `changeSession` — one source of truth

**Files:**
- Create: `src/changeSession.js`
- Test: `test/changeSession.test.js`

**Interfaces:**
- Consumes: `changeSet` objects from `createChangeSet` (`diffEngine.js:303`) — shape `{ changes: [{path, type, oldValue, newValue}], proposedChanges, getSummary() }`.
- Produces:
  - `startSession(changeSet): void`
  - `endSession(): void`
  - `getChangeSet(): object | null`
  - `getStatus(path): 'pending' | 'applied' | 'rejected'`
  - `setStatus(path, status): void`
  - `setAllPending(status): void`
  - `pendingPaths(): string[]`
  - `hasPending(): boolean`
  - `statusMap(): Map<string, string>`
  - `subscribe(cb): () => void`

  Tasks 12–14 consume all of these.

- [ ] **Step 1: Write the failing test**

Create `test/changeSession.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  startSession, endSession, getChangeSet, getStatus, setStatus,
  setAllPending, pendingPaths, hasPending, subscribe,
} from '../src/changeSession.js';

const changeSet = (paths) => ({
  changes: paths.map((p) => ({ path: p, type: 'modify', oldValue: 'a', newValue: 'b' })),
  proposedChanges: Object.fromEntries(paths.map((p) => [p, 'b'])),
  getSummary: () => ({ added: 0, removed: 0, modified: paths.length, total: paths.length }),
});

beforeEach(() => endSession());

describe('changeSession', () => {
  it('starts every change pending', () => {
    startSession(changeSet(['summary', 'name']));
    expect(pendingPaths()).toEqual(['summary', 'name']);
    expect(getStatus('summary')).toBe('pending');
  });

  it('reports unknown paths as pending-by-default only inside a session', () => {
    expect(getStatus('nope')).toBe('pending');
    startSession(changeSet(['summary']));
    expect(getStatus('nope')).toBe('pending');
  });

  it('converges every surface — one status per path', () => {
    startSession(changeSet(['summary', 'name']));
    setStatus('summary', 'applied');
    expect(getStatus('summary')).toBe('applied');
    expect(pendingPaths()).toEqual(['name']);
    expect(hasPending()).toBe(true);
    setStatus('name', 'rejected');
    expect(hasPending()).toBe(false);
  });

  it('setAllPending skips already-decided paths', () => {
    startSession(changeSet(['a', 'b', 'c']));
    setStatus('b', 'rejected');
    setAllPending('applied');
    expect(getStatus('a')).toBe('applied');
    expect(getStatus('b')).toBe('rejected');
    expect(getStatus('c')).toBe('applied');
  });

  it('notifies subscribers on every transition', () => {
    const seen = [];
    const unsub = subscribe(() => seen.push(1));
    startSession(changeSet(['summary']));
    setStatus('summary', 'applied');
    endSession();
    unsub();
    expect(seen.length).toBe(3);
  });

  it('clears state on endSession', () => {
    startSession(changeSet(['summary']));
    endSession();
    expect(getChangeSet()).toBe(null);
    expect(pendingPaths()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/changeSession.test.js`
Expected: FAIL — `Failed to resolve import "../src/changeSession.js"`

- [ ] **Step 3: Write the implementation**

Create `src/changeSession.js`:

```js
/**
 * The ONE source of truth for an in-flight AI change proposal.
 *
 * Previously three surfaces tracked "what is still pending" independently —
 * inlineChanges.js module singletons, DiffDialog.jsx React state, and
 * msg.pendingChanges on chat messages — with no subscription between them, so
 * applying everything in one surface left the others still offering
 * accept/reject. They are now all views over this module.
 *
 * Statuses: 'pending' | 'applied' | 'rejected'. A path with no recorded status
 * is pending; the map only ever records decisions.
 */

const listeners = new Set();

let changeSet = null;
let statuses = new Map();

function notify() {
  for (const cb of listeners) {
    try { cb(); } catch (e) { console.error('[changeSession] listener failed:', e); }
  }
}

/** Subscribe to any session transition. Returns an unsubscribe function. */
export function subscribe(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Begin reviewing a change set. Replaces any session already in flight. */
export function startSession(nextChangeSet) {
  changeSet = nextChangeSet || null;
  statuses = new Map();
  notify();
}

/** Discard the session — nothing is pending afterwards. */
export function endSession() {
  changeSet = null;
  statuses = new Map();
  notify();
}

export function getChangeSet() {
  return changeSet;
}

/** @returns {'pending'|'applied'|'rejected'} */
export function getStatus(path) {
  return statuses.get(path) || 'pending';
}

export function setStatus(path, status) {
  if (!changeSet) return;
  if (statuses.get(path) === status) return;
  statuses.set(path, status);
  notify();
}

/** Decide every still-pending path at once ("apply all" / "reject all"). */
export function setAllPending(status) {
  if (!changeSet) return;
  let changed = false;
  for (const change of changeSet.changes) {
    if (!statuses.has(change.path)) {
      statuses.set(change.path, status);
      changed = true;
    }
  }
  if (changed) notify();
}

export function pendingPaths() {
  if (!changeSet) return [];
  return changeSet.changes.map((c) => c.path).filter((p) => !statuses.has(p));
}

export function hasPending() {
  return pendingPaths().length > 0;
}

/** Snapshot of every recorded decision, for DOM marking. */
export function statusMap() {
  return new Map(statuses);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/changeSession.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/changeSession.js test/changeSession.test.js
git commit -m "feat(changes): add a single source of truth for pending change state"
```

---

## Task 12: `changePreview` — data projection and path-keyed marking

**Files:**
- Create: `src/changePreview.js`
- Test: `test/changePreview.test.js`

**Interfaces:**
- Consumes: `changeSession` (Task 11); `setByPath` semantics from `diffEngine.js`.
- Produces:
  - `applyPendingToData(data, changeSet, statuses): object` — deep-cloned résumé data with still-pending changes projected in.
  - `markChangedNodes(rootEl, changeSet, statuses): void` — sets `data-change-status` on **every** node matching each path.
  - `clearChangeMarks(rootEl): void`

- [ ] **Step 1: Write the failing test**

Create `test/changePreview.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyPendingToData, markChangedNodes, clearChangeMarks } from '../src/changePreview.js';

const changeSet = {
  changes: [
    { path: 'summary', type: 'modify', oldValue: 'Old', newValue: 'New **bold**' },
    { path: 'name', type: 'modify', oldValue: 'A', newValue: 'B' },
  ],
  proposedChanges: { summary: 'New **bold**', name: 'B' },
};

describe('applyPendingToData', () => {
  it('projects pending changes without mutating the original', () => {
    const data = { summary: 'Old', name: 'A' };
    const next = applyPendingToData(data, changeSet, new Map());
    expect(next.summary).toBe('New **bold**');
    expect(data.summary).toBe('Old');
  });

  it('leaves rejected paths at their original value', () => {
    const next = applyPendingToData({ summary: 'Old', name: 'A' }, changeSet,
      new Map([['summary', 'rejected']]));
    expect(next.summary).toBe('Old');
    expect(next.name).toBe('B');
  });

  it('leaves applied paths alone — the store already holds them', () => {
    const next = applyPendingToData({ summary: 'New **bold**', name: 'A' }, changeSet,
      new Map([['summary', 'applied']]));
    expect(next.summary).toBe('New **bold**');
  });
});

describe('markChangedNodes', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('marks EVERY node for a path, not just the first', () => {
    // Pagination clones nodes across pages, so a path legitimately matches more
    // than one element. The old code took querySelector's first hit and often
    // marked an off-screen clone.
    document.body.innerHTML = `
      <div id="root">
        <p data-editable="summary">x</p>
        <p data-editable="summary">x</p>
      </div>`;
    const root = document.getElementById('root');
    markChangedNodes(root, changeSet, new Map());
    const marked = root.querySelectorAll('[data-change-status="pending"]');
    expect(marked).toHaveLength(2);
  });

  it('does not touch node text', () => {
    document.body.innerHTML = '<div id="root"><p data-editable="summary">original</p></div>';
    const root = document.getElementById('root');
    markChangedNodes(root, changeSet, new Map());
    expect(root.querySelector('p').textContent).toBe('original');
  });

  it('escapes paths containing brackets', () => {
    document.body.innerHTML = '<div id="root"><p data-editable="experience[0].bullets[1]">x</p></div>';
    const root = document.getElementById('root');
    markChangedNodes(root, {
      changes: [{ path: 'experience[0].bullets[1]', type: 'modify' }],
      proposedChanges: {},
    }, new Map());
    expect(root.querySelector('p').dataset.changeStatus).toBe('pending');
  });

  it('clearChangeMarks removes every marker', () => {
    document.body.innerHTML = '<div id="root"><p data-editable="summary">x</p></div>';
    const root = document.getElementById('root');
    markChangedNodes(root, changeSet, new Map());
    clearChangeMarks(root);
    expect(root.querySelector('p').dataset.changeStatus).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/changePreview.test.js`
Expected: FAIL — `Failed to resolve import "../src/changePreview.js"`

- [ ] **Step 3: Write the implementation**

Create `src/changePreview.js`:

```js
/**
 * Change preview, done as data — not as DOM surgery.
 *
 * The previous implementation wrote proposed text straight into
 * `element.textContent`. That flattened the renderer's <strong>/<em> markup,
 * displayed literal markdown asterisks, and — because the "original" it saved
 * for restore was itself a textContent snapshot — permanently destroyed the
 * original's emphasis when a change was rejected.
 *
 * Instead: project pending changes onto a COPY of the résumé data, re-render
 * through the normal renderer (so markdown, pagination and every layout work by
 * construction), then mark the changed nodes by path with a data attribute.
 * Nothing here ever writes text into the DOM.
 */

import { setByPath } from './diffEngine.js';

/**
 * Résumé data with still-pending changes projected in.
 * Applied paths are skipped (the store already holds them); rejected paths keep
 * their original value.
 */
export function applyPendingToData(data, changeSet, statuses) {
  const next = JSON.parse(JSON.stringify(data));
  if (!changeSet) return next;
  for (const [path, value] of Object.entries(changeSet.proposedChanges || {})) {
    const status = statuses.get(path) || 'pending';
    if (status !== 'pending') continue;
    setByPath(next, path, value);
  }
  return next;
}

// CSS.escape isn't available in every test environment; attribute values only
// need quotes and backslashes escaped for a [attr="..."] selector.
function escapeAttr(value) {
  return String(value).replace(/(["\\])/g, '\\$1');
}

/**
 * Tag every node belonging to a changed path with its status, for CSS styling.
 * Marks ALL matches deliberately: pagination clones nodes across pages, so one
 * path legitimately maps to several elements and marking only the first left
 * visible changes unhighlighted.
 */
export function markChangedNodes(rootEl, changeSet, statuses) {
  if (!rootEl || !changeSet) return;
  for (const change of changeSet.changes) {
    const status = statuses.get(change.path) || 'pending';
    const nodes = rootEl.querySelectorAll(`[data-editable="${escapeAttr(change.path)}"]`);
    for (const node of nodes) {
      node.dataset.changeStatus = status;
      node.dataset.changeType = change.type;
    }
  }
}

/** Remove every preview marker — used before PDF capture and on session end. */
export function clearChangeMarks(rootEl) {
  if (!rootEl) return;
  for (const node of rootEl.querySelectorAll('[data-change-status]')) {
    delete node.dataset.changeStatus;
    delete node.dataset.changeType;
  }
}
```

- [ ] **Step 4: Export `setByPath` from diffEngine**

`changePreview.js` imports `setByPath`, which `diffEngine.js` currently keeps private. Run `cd resume-designer && grep -n "function setByPath" src/diffEngine.js` and add `export` to its declaration:

```js
export function setByPath(obj, path, value) {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/changePreview.test.js`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add src/changePreview.js test/changePreview.test.js src/diffEngine.js
git commit -m "feat(changes): preview proposals via data projection instead of dom mutation"
```

---

## Task 13: Rewire `inlineChanges` onto the session

**Files:**
- Modify: `src/inlineChanges.js` (replace lines 1–360 wholesale)
- Test: `test/inlineChanges.test.js` (rewritten)

**Interfaces:**
- Consumes: `changeSession` (Task 11), `changePreview` (Task 12).
- Produces: the existing public API is preserved so callers need no changes —
  `initInlineChanges()`, `showInlineChanges(changeSet)`, `hideInlineChanges()`,
  `isInlineChangesActive()`, `applyInlineChange(path)`, `rejectInlineChange(path)`,
  `applyAllInlineChanges()`, `getCurrentChangeSet()`.

- [ ] **Step 1: Rewrite the test**

Replace the whole of `test/inlineChanges.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { showInlineChanges, hideInlineChanges, isInlineChangesActive } from '../src/inlineChanges.js';
import { getStatus, hasPending, setStatus } from '../src/changeSession.js';

function makeChangeSet(changes) {
  return {
    changes,
    proposedChanges: Object.fromEntries(changes.map((c) => [c.path, c.newValue])),
    getSummary: () => ({
      added: 0, removed: 0, modified: changes.length, total: changes.length,
    }),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  hideInlineChanges();
});

describe('inlineChanges → changeSession', () => {
  it('starting a preview makes every change pending in the session', () => {
    showInlineChanges(makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'New' }]));
    expect(isInlineChangesActive()).toBe(true);
    expect(getStatus('summary')).toBe('pending');
  });

  it('a decision made elsewhere is visible here — surfaces converge', () => {
    showInlineChanges(makeChangeSet([
      { path: 'summary', type: 'modify', newValue: 'New' },
      { path: 'name', type: 'modify', newValue: 'B' },
    ]));
    // Simulates DiffDialog applying one change.
    setStatus('summary', 'applied');
    expect(getStatus('summary')).toBe('applied');
    expect(hasPending()).toBe(true);
    setStatus('name', 'applied');
    expect(hasPending()).toBe(false);
  });

  it('a second preview replaces the first rather than leaking its state', () => {
    showInlineChanges(makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'One' }]));
    setStatus('summary', 'applied');
    showInlineChanges(makeChangeSet([{ path: 'name', type: 'modify', newValue: 'Two' }]));
    expect(getStatus('summary')).toBe('pending');
    expect(getStatus('name')).toBe('pending');
  });

  it('hiding ends the session', () => {
    showInlineChanges(makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'New' }]));
    hideInlineChanges();
    expect(isInlineChangesActive()).toBe(false);
    expect(hasPending()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/inlineChanges.test.js`
Expected: FAIL — the old module keeps its own `appliedChanges` Set and does not touch `changeSession`.

- [ ] **Step 3: Replace the module's state and lifecycle**

In `src/inlineChanges.js`, replace the module-level state (lines 9–12) and the `showInlineChanges` / `hideInlineChanges` / `isInlineChangesActive` / `getCurrentChangeSet` functions with session-backed versions. Add these imports at the top:

```js
import * as session from './changeSession.js';
import { markChangedNodes, clearChangeMarks } from './changePreview.js';
```

Delete the `currentChangeSet`, `appliedChanges`, `highlightElements` and `isActive` declarations entirely, then:

```js
// Re-render is owned by main.js (it holds the render pipeline); inlineChanges
// only asks for one. Set via initInlineChanges.
let requestRerender = () => {};

export function initInlineChanges(onRerender) {
  if (typeof onRerender === 'function') requestRerender = onRerender;
  document.addEventListener('click', handleInlineAction);
}

/** Begin previewing a change set. Replaces any preview already showing. */
export function showInlineChanges(changeSet) {
  session.startSession(changeSet);
  requestRerender();
}

/** Dismiss the preview and drop every pending decision. */
export function hideInlineChanges() {
  const root = document.getElementById('resume-container');
  clearChangeMarks(root);
  session.endSession();
  requestRerender();
}

export function isInlineChangesActive() {
  return session.getChangeSet() !== null;
}

export function getCurrentChangeSet() {
  return session.getChangeSet();
}

/** Tag the freshly-rendered résumé nodes with their change status. */
export function decorateRenderedResume(rootEl) {
  const changeSet = session.getChangeSet();
  if (!changeSet) { clearChangeMarks(rootEl); return; }
  markChangedNodes(rootEl, changeSet, session.statusMap());
}
```

- [ ] **Step 4: Replace apply/reject with session writes**

Replace `applyInlineChange` (line 304) and `rejectInlineChange` (line 343), and add the bulk helper:

```js
export function applyInlineChange(path) {
  const changeSet = session.getChangeSet();
  if (!changeSet || session.getStatus(path) !== 'pending') return;
  const change = changeSet.changes.find((c) => c.path === path);
  if (!change) return;
  store.update(path, changeSet.proposedChanges[path]);
  session.setStatus(path, 'applied');
  if (!session.hasPending()) hideInlineChanges(); else requestRerender();
}

export function rejectInlineChange(path) {
  if (!session.getChangeSet()) return;
  session.setStatus(path, 'rejected');
  if (!session.hasPending()) hideInlineChanges(); else requestRerender();
}

export function applyAllInlineChanges() {
  const changeSet = session.getChangeSet();
  if (!changeSet) return;
  for (const path of session.pendingPaths()) {
    store.update(path, changeSet.proposedChanges[path]);
  }
  session.setAllPending('applied');
  hideInlineChanges();
}
```

Delete `findElementByPath` (lines 212–255) and the `highlightElement`/restore helpers that wrote `element.textContent` — they are the source of the data loss and are now unreachable.

`handleInlineAction` (line 262) is kept, but its "open full review" branch closes over the deleted `currentChangeSet` module variable. Repoint it at the session:

```js
  if (e.target.closest('#inline-open-review')) {
    import('./diffView.js').then(({ showDiffView }) => {
      showDiffView(session.getChangeSet());
    });
    return;
  }
```

After the edits, confirm no dangling references remain:

```bash
cd resume-designer && grep -n "currentChangeSet\|appliedChanges\|highlightElements" src/inlineChanges.js
```

Expected: no output.

- [ ] **Step 5: Re-render with the preview projection**

Locate the render pipeline with `cd resume-designer && grep -n "renderResumeForLayout" src/main.js`. At that call site, project pending changes onto the data before rendering, and decorate afterwards:

```js
import { applyPendingToData } from './changePreview.js';
import * as changeSession from './changeSession.js';
import { decorateRenderedResume } from './inlineChanges.js';
```

```js
  const changeSet = changeSession.getChangeSet();
  const viewData = changeSet
    ? applyPendingToData(data, changeSet, changeSession.statusMap())
    : data;
  container.innerHTML = renderResumeForLayout(viewData, layout);
  decorateRenderedResume(container);
```

Then pass the re-render callback when initialising: find the `initInlineChanges()` call in `src/main.js` and give it the render function, e.g. `initInlineChanges(renderResume)` using whatever the local render entry point is named.

- [ ] **Step 6: Style the markers**

Find the stylesheet carrying the old `[data-has-change]` rules (`cd resume-designer && grep -rn "data-has-change" src/`) and replace those selectors with the new attribute, keeping the existing visual treatment:

```css
[data-change-status="pending"][data-change-type="modify"] { /* existing modify styling */ }
[data-change-status="pending"][data-change-type="add"]    { /* existing add styling */ }
[data-change-status="pending"][data-change-type="remove"] { /* existing remove styling */ }
[data-change-status="applied"],
[data-change-status="rejected"] { /* no decoration — already decided */ }
```

- [ ] **Step 7: Exclude markers from PDF export**

Run `cd resume-designer && grep -rn "clearChangeMarks\|data-change-status" src/pdf.js src/printEntry.js` — if the export path clones the container, call `clearChangeMarks(clone)` on it before capture so no preview highlight reaches the PDF.

- [ ] **Step 8: Run the suite and lint**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: all PASS, lint clean.

- [ ] **Step 9: Commit**

```bash
git add src/inlineChanges.js src/main.js src/pdf.js test/inlineChanges.test.js
git commit -m "fix(changes): drive the inline preview from the shared session"
```

---

## Task 14: Converge DiffDialog and MessageList

**Files:**
- Modify: `src/components/DiffDialog.jsx:199-320`, `src/components/chat/MessageList.jsx:118-175`
- Test: none (covered by Task 11/13; verified in Step 5)

**Interfaces:**
- Consumes: `changeSession` (Task 11).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Replace DiffDialog's local Sets with the session**

In `src/components/DiffDialog.jsx`, add the import:

```jsx
import * as changeSession from '../changeSession.js';
```

Delete the two local state declarations at lines 203–204:

```jsx
  const [applied, setApplied] = useState(() => new Set());
  const [rejected, setRejected] = useState(() => new Set());
```

and replace them with a subscription that re-renders on any session transition.

Derive the two Sets with plain `const`, **not** `useMemo`: they depend on
`changeSession.getStatus`, which `react-hooks/exhaustive-deps` cannot see, so a
memo keyed on `sessionRev` would be flagged as having an unnecessary dependency
while genuinely needing it. The Sets are tiny and rebuilding them per render is
cheaper than the lint suppression would be to justify.

```jsx
  // The session is the source of truth; this counter exists only to force a
  // re-render when another surface (inline preview, chat message) decides a path.
  const [sessionRev, setSessionRev] = useState(0);
  useEffect(() => changeSession.subscribe(() => setSessionRev((n) => n + 1)), []);

  // eslint-disable-next-line no-unused-vars -- read for its render-triggering effect
  const _rev = sessionRev;
  const pathsWithStatus = (status) =>
    new Set((changeSet?.changes || [])
      .filter((c) => changeSession.getStatus(c.path) === status)
      .map((c) => c.path));

  const applied = pathsWithStatus('applied');
  const rejected = pathsWithStatus('rejected');
```

No change to the React import is needed beyond `useEffect`/`useState`, which the file already imports.

- [ ] **Step 2: Write decisions through the session**

In `applyChange` (line 256), replace the `setApplied((prev) => ...)` call with:

```jsx
      changeSession.setStatus(change.path, 'applied');
```

In `rejectChange` (line 290), replace the `setRejected(...)` call with:

```jsx
      changeSession.setStatus(change.path, 'rejected');
```

In the apply-all handler (line 309), replace the loop's bookkeeping with:

```jsx
      changeSession.setAllPending('applied');
```

leaving the `store.update` calls that actually write the values.

- [ ] **Step 3: Gate the chat message actions on the session**

In `src/components/chat/MessageList.jsx`, add:

```jsx
import * as changeSession from '../../changeSession.js';
```

and subscribe near the top of the message component that renders the actions:

```jsx
  const [, setSessionRev] = useState(0);
  useEffect(() => changeSession.subscribe(() => setSessionRev((n) => n + 1)), []);
```

Then change the `hasActions` test on line 118 so a message stops offering actions once its changes are all decided:

```jsx
  const changesStillPending = msg.pendingChanges ? changeSession.hasPending() : false;
  const hasActions = msg.applyData || changesStillPending;
```

Add `useEffect, useState` to that file's React import if not already present.

- [ ] **Step 4: Run the suite and lint**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: all PASS, lint clean.

- [ ] **Step 5: Verify convergence by hand**

```bash
cd resume-designer && npm run tauri:dev
```

With an OpenRouter key configured, ask the assistant for a change that touches several fields, then:

1. Open the review dialog, click **Apply all**. Confirm the in-résumé highlights clear **and** the chat message's Apply button disappears.
2. Repeat, but this time apply one change from the résumé's inline control. Confirm the dialog's card for that path shows as applied without being clicked.
3. Repeat, and reject everything. Confirm all three surfaces stand down together.

- [ ] **Step 6: Commit**

```bash
git add src/components/DiffDialog.jsx src/components/chat/MessageList.jsx
git commit -m "fix(changes): converge dialog and chat actions on the shared session"
```

---

## Task 15: Section `area` field and migration

**Files:**
- Modify: `src/store.js:153` (`setData`), `src/store.js:567` (`EMPTY_RESUME`)
- Test: `test/sectionAreas.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `migrateSectionAreas(data): object` exported from `store.js` — stamps `area: 'sidebar'` on any section lacking one. Tasks 16–17 rely on `section.area` always being set.

- [ ] **Step 1: Write the failing test**

Create `test/sectionAreas.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { migrateSectionAreas } from '../src/store.js';

describe('migrateSectionAreas', () => {
  it('defaults existing sections to the sidebar so output is unchanged', () => {
    const out = migrateSectionAreas({
      sections: [{ id: 's1', title: 'Skills', type: 'list', content: ['a'] }],
    });
    expect(out.sections[0].area).toBe('sidebar');
  });

  it('preserves an explicit area', () => {
    const out = migrateSectionAreas({
      sections: [{ id: 's1', title: 'Awards', type: 'list', content: [], area: 'main' }],
    });
    expect(out.sections[0].area).toBe('main');
  });

  it('rejects an unknown area rather than passing it to the renderer', () => {
    const out = migrateSectionAreas({ sections: [{ id: 's1', area: 'footer' }] });
    expect(out.sections[0].area).toBe('sidebar');
  });

  it('tolerates data with no sections', () => {
    expect(() => migrateSectionAreas({})).not.toThrow();
    expect(migrateSectionAreas({}).sections).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const input = { sections: [{ id: 's1' }] };
    migrateSectionAreas(input);
    expect(input.sections[0].area).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/sectionAreas.test.js`
Expected: FAIL — `migrateSectionAreas is not a function`

- [ ] **Step 3: Write the migration**

In `src/store.js`, above `createStore`, add:

```js
// Sections gained an `area` in 2026-07. Every pre-existing section is a sidebar
// section by definition, so stamping 'sidebar' keeps rendered output identical.
// Additive on purpose: the array, its indices and every sections[i].content[j]
// path are untouched, so AI change paths, data-editable attributes, saved
// variants and backups keep working without their own migration.
const SECTION_AREAS = new Set(['main', 'sidebar']);

export function migrateSectionAreas(data) {
  if (!data || !Array.isArray(data.sections)) return data;
  return {
    ...data,
    sections: data.sections.map((section) => ({
      ...section,
      area: SECTION_AREAS.has(section && section.area) ? section.area : 'sidebar',
    })),
  };
}
```

- [ ] **Step 4: Run migration on load**

In `setData` (line 153), migrate before cloning:

```js
    setData(newData, skipSave = false, variantId = null) {
      data = deepClone(migrateSectionAreas(newData));
```

- [ ] **Step 5: Give the default template an area**

In `EMPTY_RESUME` (line 567), add the field so new résumés never rely on the migration:

```js
  sections: [
    {
      id: generateId('section'),
      title: 'Skills',
      type: 'list',
      area: 'sidebar',
      content: ['Skill 1', 'Skill 2', 'Skill 3']
    }
  ],
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/sectionAreas.test.js`
Expected: PASS (5 tests)

- [ ] **Step 7: Commit**

```bash
git add src/store.js test/sectionAreas.test.js
git commit -m "feat(sections): add an area field with a sidebar-preserving migration"
```

---

## Task 16: `paragraph` section type

**Files:**
- Modify: `src/renderer.js:15` (`normalizeSectionType`), `:66-118`
- Test: `test/sectionAreas.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeSectionType` now returns `'list' | 'skills' | 'paragraph'`.

- [ ] **Step 1: Write the failing test**

Append to `test/sectionAreas.test.js`:

```js
import { normalizeSectionType } from '../src/renderer.js';

describe('normalizeSectionType', () => {
  it('recognises the three display types', () => {
    expect(normalizeSectionType('list')).toBe('list');
    expect(normalizeSectionType('skills')).toBe('skills');
    expect(normalizeSectionType('paragraph')).toBe('paragraph');
  });

  it('falls back to list for anything unknown', () => {
    expect(normalizeSectionType('bogus')).toBe('list');
    expect(normalizeSectionType(undefined)).toBe('list');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/sectionAreas.test.js`
Expected: FAIL — either `normalizeSectionType` is not exported, or `paragraph` returns `'list'`.

- [ ] **Step 3: Extend the type normalizer**

In `src/renderer.js`, replace line 15's function body and export it:

```js
export function normalizeSectionType(type) {
  if (type === 'skills') return 'skills';
  if (type === 'paragraph') return 'paragraph';
  return 'list';
}
```

- [ ] **Step 4: Render paragraphs**

In `renderSectionContent` (line 73), add a paragraph branch before the existing list/skills handling:

```js
function renderSectionContent(section, sIdx, variant = 'sidebar') {
  const mode = normalizeSectionType(section?.type);

  if (mode === 'paragraph') {
    return (section.content || [])
      .map((line, i) =>
        `<p class="section-paragraph" data-editable="sections[${sIdx}].content[${i}]">${formatInlineMarkdown(line)}</p>`)
      .join('');
  }

  // ... existing list / skills handling unchanged
```

Match the existing function's use of `formatInlineMarkdown` (the helper at line 44 that converts `**` → `<strong>`); if the surrounding code calls `renderSectionLine` instead, use that for consistency with its siblings.

- [ ] **Step 5: Add the paragraph style**

In the stylesheet holding `.section-title` (`cd resume-designer && grep -rln "section-title" src/`), add:

```css
.section-paragraph {
  margin: 0 0 var(--section-item-gap, 4px);
  line-height: 1.45;
}
.section-paragraph:last-child { margin-bottom: 0; }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/sectionAreas.test.js`
Expected: PASS (7 tests)

- [ ] **Step 7: Commit**

```bash
git add src/renderer.js test/sectionAreas.test.js
git commit -m "feat(sections): add a paragraph display type"
```

---

## Task 17: Render main-area sections across the layouts

**Files:**
- Modify: `src/renderer.js:120-134` (`splitSectionsByMode`), `:468-527` (`renderSidebar`), and the six sidebar layout functions
- Test: `test/sectionAreas.test.js`

**Interfaces:**
- Consumes: `section.area` (Task 15), `normalizeSectionType` (Task 16).
- Produces: `partitionSectionsByArea(sections): { main: {section, sIdx}[], sidebar: {section, sIdx}[] }` and `renderMainSections(data): string`.

- [ ] **Step 1: Write the failing test**

Append to `test/sectionAreas.test.js`:

```js
import { partitionSectionsByArea, renderResumeForLayout } from '../src/renderer.js';

const DATA = {
  name: 'Ada', tagline: 'Engineer', contact: {}, summary: 'S',
  experience: [], education: [], tools: '',
  sections: [
    { id: 'a', title: 'Skills', type: 'list', area: 'sidebar', content: ['Rust'] },
    { id: 'b', title: 'Publications', type: 'paragraph', area: 'main', content: ['A paper.'] },
  ],
};

describe('partitionSectionsByArea', () => {
  it('splits by area while preserving original indices', () => {
    const { main, sidebar } = partitionSectionsByArea(DATA.sections);
    expect(main.map((e) => e.sIdx)).toEqual([1]);
    expect(sidebar.map((e) => e.sIdx)).toEqual([0]);
  });
});

describe('layout rendering', () => {
  it('sidebar layouts place a main section in the main column', () => {
    const html = renderResumeForLayout(DATA, 'sidebar');
    expect(html).toContain('Publications');
    expect(html).toContain('data-editable="sections[1].content[0]"');
  });

  it('sidebar-less layouts render every section, ignoring area', () => {
    for (const layout of ['stacked', 'classic', 'creative']) {
      const html = renderResumeForLayout(DATA, layout);
      expect(html, layout).toContain('Publications');
      expect(html, layout).toContain('Skills');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/sectionAreas.test.js`
Expected: FAIL — `partitionSectionsByArea is not a function`

- [ ] **Step 3: Add the partition helper**

In `src/renderer.js`, beside `splitSectionsByMode` (line 120):

```js
/**
 * Split sections by column. Indices are preserved because every data-editable
 * path and every AI change path is `sections[<original index>]…`.
 *
 * Only the six layouts that actually have a sidebar call this. The five
 * sidebar-less layouts (stacked, stacked-vertical, classic, classic-featured,
 * creative) deliberately ignore `area` and render every section in their single
 * column — forcing the distinction there would change existing résumés' output
 * for no benefit.
 */
export function partitionSectionsByArea(sections = []) {
  const main = [];
  const sidebar = [];
  sections.forEach((section, sIdx) => {
    (section && section.area === 'main' ? main : sidebar).push({ section, sIdx });
  });
  return { main, sidebar };
}

/** Render the main-column custom sections, in array order. */
export function renderMainSections(data) {
  const { main } = partitionSectionsByArea(data.sections || []);
  if (main.length === 0) return '';
  return main.map(({ section, sIdx }) => `
      <section class="resume-section main-custom-section">
        <h2 class="section-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h2>
        ${renderSectionContent(section, sIdx, 'main')}
      </section>`).join('');
}
```

- [ ] **Step 4: Make the sidebar render only sidebar sections**

In `renderSidebar` (line 468), replace the `for (let sIdx = 0; sIdx < data.sections.length; sIdx++)` loop header so it iterates the partition instead of the raw array:

```js
  if (data.sections) {
    const { sidebar } = partitionSectionsByArea(data.sections);
    for (const { section, sIdx } of sidebar) {
```

Delete the now-redundant `const section = data.sections[sIdx];` line inside the loop and close the loop consistently. Every `sections[${sIdx}]` template inside stays exactly as-is — `sIdx` is still the original index.

- [ ] **Step 5: Emit main sections in the six sidebar layouts**

For each of `renderResume` (180), `renderResumeRightSidebar` (580), `renderResumeCompact` (628), `renderResumeExecutive` (692), `renderResumeModern` (899), `renderResumeTimeline` (960): find where the main column emits education (the last fixed main block) and add the call immediately after it:

```js
        ${renderMainSections(data)}
```

Do **not** touch `renderResumeStacked`, `renderResumeStackedVertical`, `renderResumeClassic`, `renderResumeClassicFeatured` or `renderResumeCreative` — they read `data.sections` directly and must keep rendering all of them.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/sectionAreas.test.js`
Expected: PASS (10 tests)

- [ ] **Step 7: Guard against output drift**

Run the whole suite — any existing renderer snapshot that changes means a sidebar section moved, which would be a regression:

Run: `cd resume-designer && npm run test`
Expected: all PASS with no snapshot updates required.

- [ ] **Step 8: Commit**

```bash
git add src/renderer.js test/sectionAreas.test.js
git commit -m "feat(sections): render main-area sections in the six sidebar layouts"
```

---

## Task 18: Section management UI

**Files:**
- Modify: `src/components/structure/StructurePanel.jsx:159-200`, `:344-352`, `:435-445`
- Test: none (UI; verified in Step 6)

**Interfaces:**
- Consumes: `section.area` (Task 15), `paragraph` type (Task 16).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the area picker and paragraph option**

In `src/components/structure/StructurePanel.jsx`, replace the `SectionItem` display-toggle block (lines 180–194) with a two-control row:

```jsx
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Area</span>
          <Segmented size="xs">
            {[['sidebar', 'Sidebar'], ['main', 'Main']].map(([a, label]) => (
              <SegmentedItem
                key={a} size="xs"
                active={(section.area || 'sidebar') === a}
                onClick={() => store.update(`sections[${index}].area`, a)}
              >
                {label}
              </SegmentedItem>
            ))}
          </Segmented>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Display</span>
          <Segmented size="xs">
            {[['list', 'Bulleted'], ['skills', 'Inline Tags'], ['paragraph', 'Paragraph']].map(([t, label]) => (
              <SegmentedItem
                key={t} size="xs"
                active={type === t}
                onClick={() => store.update(`sections[${index}].type`, t)}
              >
                {label}
              </SegmentedItem>
            ))}
          </Segmented>
        </div>
      </div>
```

Update the `type` derivation on line 160 to admit the third value:

```jsx
  const type = ['skills', 'paragraph'].includes(section?.type) ? section.type : 'list';
```

- [ ] **Step 2: Note when the active layout has one column**

Still inside `SectionItem`, beneath the controls row, add the explanatory note. The area picker is always shown — `area` is a property of the résumé, not of the active template, so hiding it would silently discard the user's choice when they switch templates:

```jsx
      {SINGLE_COLUMN_LAYOUTS.has(store.getData()?.layout) && (
        <p className="text-[11px] text-muted-foreground">
          This template uses a single column, so Area has no visible effect here.
        </p>
      )}
```

and add the constant near `SECTION_TEMPLATES` (line 48):

```jsx
// Layouts with no sidebar — they render every section in one column regardless
// of its area. Mirrors the list in renderer.js partitionSectionsByArea.
const SINGLE_COLUMN_LAYOUTS = new Set([
  'stacked', 'stacked-vertical', 'classic', 'classic-featured', 'creative',
]);
```

- [ ] **Step 3: Default new sections to an area**

Update `addSection` (line 344) and `addCustomSection` (line 349) so nothing relies on the migration:

```jsx
  const addSection = (templateKey) => {
    const template = SECTION_TEMPLATES[templateKey];
    if (!template) return;
    store.addToArray('sections', {
      id: generateId('section'), area: 'sidebar',
      ...JSON.parse(JSON.stringify(template)),
    });
  };
```

```jsx
    store.addToArray('sections', {
      id: generateId('section'), title, type: 'list', area: 'sidebar', content: ['Item 1'],
    });
```

- [ ] **Step 4: Relabel the panel**

The heading "Sidebar Sections" (line 435) is already wrong on 5 of 11 layouts and is now wrong on all of them. Change it:

```jsx
            <PanelSection title="Sections" {...sectionProps('sidebar-sections')} headerExtra={
```

Leave the `sectionProps('sidebar-sections')` key untouched — it is a persisted collapse-state id, and renaming it would reset users' panel state.

- [ ] **Step 5: Run lint and the suite**

Run: `cd resume-designer && npm run test && npm run lint`
Expected: all PASS, lint clean.

- [ ] **Step 6: Verify end to end**

```bash
cd resume-designer && npm run tauri:dev
```

Open the structure panel: add a custom section, set Area to **Main** and Display to **Paragraph**, and confirm it renders in the main column on the Sidebar template. Switch to the Classic template and confirm it still renders (single column) with the explanatory note showing. Switch back and confirm it returns to the main column. Export a PDF and confirm the section appears.

- [ ] **Step 7: Commit**

```bash
git add src/components/structure/StructurePanel.jsx
git commit -m "feat(sections): let custom sections target the main area"
```

---

## Task 19: OS-backed spellcheck indicators

**GATE:** Only run this task if Task 1 recorded both capabilities as `true`. If either was `false`, **stop and report to the user** — the spec routes that fallback decision back to them rather than silently substituting a bundled dictionary.

**Files:**
- Create: `src-tauri/src/commands/spellcheck.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src/spellcheck.js`
- Test: `test/spellcheck.test.js`

**Interfaces:**
- Consumes: `shouldSpellcheck` (Task 2).
- Produces:
  - Rust command `spellcheck(text: String) -> Vec<Misspelling>` where `Misspelling = { start: usize, len: usize, suggestions: Vec<String> }`.
  - JS `checkText(text): Promise<Misspelling[]>` and `paintMisspellings(el, misspellings): void`.

- [ ] **Step 1: Write the failing test**

Append to `test/spellcheck.test.js`:

```js
import { toHighlightRanges } from '../src/spellcheck.js';

describe('toHighlightRanges', () => {
  it('maps offsets onto a text node', () => {
    const el = document.createElement('p');
    el.textContent = 'This sentance is wrong';
    document.body.appendChild(el);
    const ranges = toHighlightRanges(el, [{ start: 5, len: 8, suggestions: ['sentence'] }]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe('sentance');
  });

  it('skips ranges beyond the text length rather than throwing', () => {
    const el = document.createElement('p');
    el.textContent = 'short';
    document.body.appendChild(el);
    expect(toHighlightRanges(el, [{ start: 99, len: 4, suggestions: [] }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd resume-designer && npx vitest run test/spellcheck.test.js`
Expected: FAIL — `toHighlightRanges is not a function`

- [ ] **Step 3: Add the range mapper and painter**

Append to `src/spellcheck.js`:

```js
/**
 * Map {start,len} character offsets onto DOM Ranges over an element's first
 * text node. Ranges are painted with the CSS Custom Highlight API, which draws
 * without touching the DOM — deliberate, given the data loss the change-preview
 * work traced to DOM text mutation.
 */
export function toHighlightRanges(el, misspellings) {
  const node = el && el.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return [];
  const length = node.textContent.length;
  const ranges = [];
  for (const m of misspellings || []) {
    if (m.start < 0 || m.start + m.len > length) continue;
    const range = document.createRange();
    range.setStart(node, m.start);
    range.setEnd(node, m.start + m.len);
    ranges.push(range);
  }
  return ranges;
}

const HIGHLIGHT_NAME = 'spelling-error';

/** Paint misspellings. No-ops where the Custom Highlight API is unavailable. */
export function paintMisspellings(el, misspellings) {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  const ranges = toHighlightRanges(el, misspellings);
  if (ranges.length === 0) { CSS.highlights.delete(HIGHLIGHT_NAME); return; }
  CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

/** Ask the OS spellchecker. Returns [] outside Tauri or on any failure. */
export async function checkText(text) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('spellcheck', { text });
  } catch (e) {
    console.warn('[spellcheck] native check unavailable:', (e && e.message) || e);
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd resume-designer && npx vitest run test/spellcheck.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Style the highlight**

In the stylesheet carrying the resume text styles, add:

```css
::highlight(spelling-error) {
  text-decoration-line: spelling-error;
}
```

- [ ] **Step 6: Add the Rust command**

Create `src-tauri/src/commands/spellcheck.rs`:

```rust
//! OS-backed spell checking. Using the platform checker (rather than a bundled
//! dictionary) means the user's own dictionary, learned words and language
//! settings apply — which is what "use the system spellchecker" has to mean.

use serde::Serialize;

#[derive(Serialize)]
pub struct Misspelling {
    pub start: usize,
    pub len: usize,
    pub suggestions: Vec<String>,
}

#[tauri::command]
pub fn spellcheck(text: String) -> Vec<Misspelling> {
    platform::check(&text)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Misspelling;

    pub fn check(text: &str) -> Vec<Misspelling> {
        // NSSpellChecker via objc2. Walk the string, collecting each misspelled
        // range and its guesses.
        crate::commands::spellcheck::macos::check_with_nsspellchecker(text)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::Misspelling;

    pub fn check(text: &str) -> Vec<Misspelling> {
        crate::commands::spellcheck::windows::check_with_ispellchecker(text)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::Misspelling;

    pub fn check(_text: &str) -> Vec<Misspelling> {
        Vec::new()
    }
}
```

Implement the two `macos` / `windows` submodules against `NSSpellChecker`
(`checkSpellingOfString:startingAt:` plus `guessesForWordRange:`) and
`ISpellChecker` (`Check` + `Suggest`) respectively, adding the `objc2`/`objc2-app-kit`
and `windows` crates to `src-tauri/Cargo.toml` under the matching
`[target.'cfg(target_os = "…")'.dependencies]` sections.

Register the command: add `pub mod spellcheck;` to `src-tauri/src/commands/mod.rs` and add `commands::spellcheck::spellcheck` to the `tauri::generate_handler![…]` list in `src-tauri/src/lib.rs`.

- [ ] **Step 7: Type-check both targets**

Run:

```bash
cd resume-designer/src-tauri && cargo check && cargo check --target x86_64-pc-windows-gnu
```

Expected: both clean. PR CI builds macOS only, so the Windows check has to happen here — the msvc target does not build on this machine, which is why the gnu target is used.

- [ ] **Step 8: Debounce the check on the inline editor**

In `src/inlineEditor.js`, where the editable element receives input, debounce a call at ~400ms and paint the result:

```js
import { checkText, paintMisspellings } from './spellcheck.js';

let spellTimer = null;
function scheduleSpellcheck(element) {
  clearTimeout(spellTimer);
  spellTimer = setTimeout(async () => {
    paintMisspellings(element, await checkText(element.textContent || ''));
  }, 400);
}
```

Call `scheduleSpellcheck(element)` from the existing input handler, and clear the highlight on blur beside the `element.spellcheck = false` line from Task 2:

```js
  if (typeof CSS !== 'undefined' && 'highlights' in CSS) CSS.highlights.delete('spelling-error');
```

- [ ] **Step 9: Keep highlights out of the PDF**

In the PDF export path, delete the highlight before capture:

```js
  if (typeof CSS !== 'undefined' && 'highlights' in CSS) CSS.highlights.delete('spelling-error');
```

- [ ] **Step 10: Verify in the real webview**

```bash
cd resume-designer && npm run tauri:dev
```

Type `This sentance has a mispelled word` into a résumé field. Confirm both words get a native-looking squiggle, right-click offers corrections, and an exported PDF has no squiggles.

- [ ] **Step 11: Commit**

```bash
git add src/spellcheck.js src/inlineEditor.js src/pdf.js src-tauri/ test/spellcheck.test.js
git commit -m "feat(spellcheck): paint os-backed misspelling indicators"
```

---

## Task 20: Full verification pass

**Files:** none modified.

- [ ] **Step 1: Run everything**

```bash
cd resume-designer && npm run test && npm run lint
```

Expected: all suites PASS, lint clean.

- [ ] **Step 2: Confirm commitlint will accept every commit**

```bash
cd /Users/ashshah/Projects/Resume-Designer && git log origin/next..HEAD --format='%s'
```

Every subject must be conventional-commit form with a **lowercase** first word after the type. CI lints every commit in the PR, not just the tip.

- [ ] **Step 3: Verify the six behaviours in the real app**

```bash
cd resume-designer && npm run tauri:dev
```

1. **Models** — open the picker; current models appear under Featured; search finds a non-featured model.
2. **Composer** — drag the panel to its 240px minimum; nothing overflows or inverts.
3. **Grounding** — generate against a deliberately sparse profile; confirm no invented employer or metric, and that gaps are reported.
4. **Change preview** — request a multi-field change; confirm bold/italic survives a reject, and that apply-all in one surface stands all three down.
5. **Sections** — add a main-area paragraph section; confirm it renders and exports.
6. **Spellcheck** — confirm squiggles and corrections per Task 19 (or per Task 1's verdict if gated off).

- [ ] **Step 4: Report to the user**

Summarise what shipped, what the spike concluded, and anything left open. **Do not push and do not open a PR** — neither is authorised by this plan.

---

## Self-Review

**Spec coverage** — every spec section maps to a task:

| Spec section | Tasks |
|---|---|
| 1 Live model catalog | 3, 4, 5, 6, 7 |
| 2 Composer responsiveness | 8 (+ Task 7 Step 4) |
| 3 AI grounding | 9 |
| 3 Gap report | 10 |
| 4 Single source of truth | 11, 13, 14 |
| 4 Data-driven preview | 12, 13 |
| 5 Sections data model + migration | 15 |
| 5 Display types | 16, 18 |
| 5 Rendering across layouts | 17 |
| 5 UI relabel + area picker | 18 |
| 6 Stage 1 native | 2 |
| 6 Stage 2 spike + OS-backed | 1, 19 |
| Testing section | folded into each task; end-to-end in 20 |

**Type consistency checked** — `CatalogEntry` fields (`id/name/created/contextLength/maxTokens/reasoning/outputModalities`) are produced in Task 3 and consumed unchanged in 4, 5, 6, 7. `changeSession`'s exported names are declared in Task 11 and used verbatim in 12, 13, 14. `partitionSectionsByArea` returns `{main, sidebar}` of `{section, sIdx}` in Task 17 and is consumed with those field names. `Misspelling` (`start/len/suggestions`) matches between the Rust struct and `toHighlightRanges`.

**Known ordering constraints** — Task 1 gates Task 19. Tasks 12–13 and 15–17 both touch `renderer.js`/render pipeline and are sequenced so they never interleave. Task 7 Step 4 makes the model trigger flexible, which Task 8 depends on.
