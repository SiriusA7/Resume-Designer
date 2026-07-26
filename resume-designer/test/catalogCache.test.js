import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CATALOG_SCHEMA_VERSION } from '../src/modelCatalog.js';

// Regression tests for the catalog-cache version gate in aiService.js
// (readCatalogCache): a stored cache is honored ONLY when its `version`
// matches CATALOG_SCHEMA_VERSION, so records written in the pre-versioning
// narrow shape ({ fetchedAt, models: { slug: { reasoning } } }, no `version`)
// are discarded instead of being misread as complete records.
//
// Lives in its own file (not modelCatalog.test.js) because aiService.js
// memoizes the parsed cache in a module-level `catalogMemo` — each test needs
// vi.resetModules() + a fresh dynamic import to get an unmemoized module,
// which doesn't mix with that file's plain static imports.

const CATALOG_STORAGE_KEY = 'resume-designer-model-catalog';
// Not in the curated MODELS shortlist, so modelSupportsReasoning consults ONLY
// the cached catalog for it.
const SLUG = 'vendor/uncurated-test-model';

// Fresh aiService module instance per call: resetModules clears the module
// registry so the dynamic import re-evaluates aiService.js (catalogMemo = null)
// and its import graph. In jsdom appStorage stays in passthrough mode, so
// readCatalogCache reads straight from localStorage (the key is a SHARED_KEY —
// never profile-prefixed).
async function importFreshAiService() {
  vi.resetModules();
  return import('../src/aiService.js');
}

beforeEach(() => {
  localStorage.clear();
});

// Full reduced-shape catalog entry (the fields toCatalogEntry persists), built
// so it survives deriveFeatured's rules unless an override breaks one.
function catalogEntry(id, overrides = {}) {
  return {
    id,
    name: id,
    created: 1000,
    contextLength: 200000,
    maxTokens: 8192,
    reasoning: true,
    outputModalities: ['text'],
    ...overrides,
  };
}

function seedCatalog(models) {
  localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify({
    version: CATALOG_SCHEMA_VERSION,
    fetchedAt: Date.now(),
    models,
  }));
}

describe('catalog cache version gate (readCatalogCache)', () => {
  it('discards an old-shape versionless cache instead of reading it', async () => {
    // Old narrow shape from before versioning: no `version` key. The entry says
    // reasoning: false — so if the stale record WERE read, the assertion below
    // would see false.
    localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify({
      fetchedAt: Date.now(),
      models: { [SLUG]: { reasoning: false } },
    }));

    const { modelSupportsReasoning } = await importFreshAiService();

    // No catalog entry consulted → the optimistic default (true). Proves the
    // versionless record was rejected, not misread as current.
    expect(modelSupportsReasoning(SLUG)).toBe(true);
  });

  it('reads a current-version cache', async () => {
    localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify({
      version: CATALOG_SCHEMA_VERSION,
      fetchedAt: Date.now(),
      models: { [SLUG]: { id: SLUG, name: 'Uncurated Test Model', reasoning: false } },
    }));

    const { modelSupportsReasoning } = await importFreshAiService();

    // The cached entry (reasoning: false) overrides the optimistic default —
    // proves a valid same-version cache IS read.
    expect(modelSupportsReasoning(SLUG)).toBe(false);
  });
});

// getAllModels() backs the picker's "Featured" section. Synchronous, cache-only
// (no network): catalog cached → groups derived via deriveFeatured; no catalog,
// or a degenerate one → the hardcoded MODELS shortlist. The fallback is
// load-bearing — if it broke, a cold start (first run / offline) would render
// an EMPTY model picker.
describe('getAllModels', () => {
  // Every entry the picker consumes must have exactly this shape.
  function expectPickerShape(groups) {
    for (const [group, models] of Object.entries(groups)) {
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(Object.keys(m).sort()).toEqual(['group', 'id', 'label', 'model']);
        expect(m.model).toBe(m.id);
        expect(m.group).toBe(group);
        expect(typeof m.label).toBe('string');
        expect(m.label.length).toBeGreaterThan(0);
      }
    }
  }

  // The fallback IS the hardcoded shortlist: same ids, nothing else.
  function expectHardcodedFallback(groups, getAvailableModelIds) {
    expectPickerShape(groups);
    const flatIds = Object.values(groups).flat().map((m) => m.id);
    expect(flatIds.sort()).toEqual([...getAvailableModelIds()].sort());
  }

  it('returns the hardcoded shortlist groups when no catalog is cached', async () => {
    const { getAllModels, getAvailableModelIds } = await importFreshAiService();

    const groups = getAllModels();

    expect(Object.keys(groups)).toEqual(
      ['Anthropic', 'OpenAI', 'Google', 'xAI', 'DeepSeek', 'Mistral'],
    );
    expectHardcodedFallback(groups, getAvailableModelIds);
  });

  it('derives groups from the cached catalog instead of the hardcoded map', async () => {
    // Neither slug is in the curated MODELS map, so any hardcoded leakage into
    // the result (or any ignored catalog) fails the exact match below.
    seedCatalog({
      'anthropic/claude-probe-9': catalogEntry('anthropic/claude-probe-9', { name: 'Claude Probe 9' }),
      'openai/gpt-probe-9': catalogEntry('openai/gpt-probe-9', { name: 'GPT Probe 9' }),
    });

    const { getAllModels } = await importFreshAiService();

    expect(getAllModels()).toEqual({
      Anthropic: [{
        id: 'anthropic/claude-probe-9',
        model: 'anthropic/claude-probe-9',
        label: 'Claude Probe 9',
        group: 'Anthropic',
      }],
      OpenAI: [{
        id: 'openai/gpt-probe-9',
        model: 'openai/gpt-probe-9',
        label: 'GPT Probe 9',
        group: 'OpenAI',
      }],
    });
  });

  it('falls back to the shortlist when a valid-version cache has no models', async () => {
    seedCatalog({});

    const { getAllModels, getAvailableModelIds } = await importFreshAiService();

    expectHardcodedFallback(getAllModels(), getAvailableModelIds);
  });

  it('falls back to the shortlist when every cached model is filtered out', async () => {
    // Non-empty cache, but nothing survives deriveFeatured — one entry per
    // filter: `:` tier, dated snapshot, non-text output, non-featured provider.
    // Without the empty-`grouped` guard this would return {} → empty picker.
    seedCatalog({
      'anthropic/claude-probe-9:free': catalogEntry('anthropic/claude-probe-9:free'),
      'openai/gpt-probe-2024-11-20': catalogEntry('openai/gpt-probe-2024-11-20'),
      'google/gemini-probe': catalogEntry('google/gemini-probe', { outputModalities: ['text', 'image'] }),
      'qwen/qwen-probe': catalogEntry('qwen/qwen-probe'),
    });

    const { getAllModels, getAvailableModelIds } = await importFreshAiService();

    expectHardcodedFallback(getAllModels(), getAvailableModelIds);
  });
});

describe('getAllCatalogModels', () => {
  it('returns [] when no catalog is cached', async () => {
    const { getAllCatalogModels } = await importFreshAiService();

    expect(getAllCatalogModels()).toEqual([]);
  });

  it('returns every catalog model sorted newest-created first', async () => {
    // Insertion order (100, 300, 200) matches neither sort direction, so a
    // missing sort cannot pass by Object.values() ordering accident.
    seedCatalog({
      'vendor/model-old': catalogEntry('vendor/model-old', { created: 100 }),
      'vendor/model-new': catalogEntry('vendor/model-new', { created: 300 }),
      'vendor/model-mid': catalogEntry('vendor/model-mid', { created: 200 }),
    });

    const { getAllCatalogModels } = await importFreshAiService();

    expect(getAllCatalogModels().map((m) => m.id)).toEqual(
      ['vendor/model-new', 'vendor/model-mid', 'vendor/model-old'],
    );
  });
});
