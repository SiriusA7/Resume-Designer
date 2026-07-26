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
