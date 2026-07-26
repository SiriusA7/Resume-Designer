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
