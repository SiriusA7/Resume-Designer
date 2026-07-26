import { describe, it, expect } from 'vitest';
import {
  toCatalogEntry,
  CATALOG_SCHEMA_VERSION,
  deriveFeatured,
  isGeneralChatModel,
  familyRoot,
} from '../src/modelCatalog.js';

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

import { CATALOG_SOFT_TTL_MS } from '../src/modelCatalog.js';

describe('catalog refresh policy', () => {
  it('uses a short soft TTL so opening the picker revalidates', () => {
    expect(CATALOG_SOFT_TTL_MS).toBe(5 * 60 * 1000);
  });
});
