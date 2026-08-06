import { describe, it, expect } from 'vitest';
import {
  toCatalogEntry,
  CATALOG_SCHEMA_VERSION,
  deriveFeatured,
  isGeneralChatModel,
  canOutputText,
  familyRoot,
  stripGroupPrefix,
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

  it('is independent of catalog order when created timestamps tie', () => {
    // Different families, same second — only the tiebreak can order these.
    const tied = [
      entry('anthropic/claude-opus-5', 500),
      entry('anthropic/claude-haiku-5', 500),
    ];
    const forward = deriveFeatured(tied).Anthropic.map((m) => m.id);
    const reversed = deriveFeatured([...tied].reverse()).Anthropic.map((m) => m.id);
    expect(reversed).toEqual(forward);
    expect(forward).toEqual(['anthropic/claude-opus-5', 'anthropic/claude-haiku-5']);
  });
});

describe('stripGroupPrefix', () => {
  it('strips a provider prefix that repeats the group heading', () => {
    expect(stripGroupPrefix('Anthropic: Claude Opus 5', 'Anthropic')).toBe('Claude Opus 5');
    expect(stripGroupPrefix('Google: Gemini 3.6 Flash', 'Google')).toBe('Gemini 3.6 Flash');
  });

  it('leaves unprefixed labels unchanged', () => {
    expect(stripGroupPrefix('Claude Opus 5', 'Anthropic')).toBe('Claude Opus 5');
  });

  it('leaves a colon prefix that is not the group heading unchanged', () => {
    expect(stripGroupPrefix('Meta: Llama 4 Maverick', 'Anthropic')).toBe('Meta: Llama 4 Maverick');
  });
});

import { CATALOG_SOFT_TTL_MS } from '../src/modelCatalog.js';

describe('catalog refresh policy', () => {
  it('uses a short soft TTL so opening the picker revalidates', () => {
    expect(CATALOG_SOFT_TTL_MS).toBe(5 * 60 * 1000);
  });
});

// The chat picker's "All models" section offered every catalog entry, including
// image-, audio- and embedding-output models. streamOpenRouter only consumes
// text, so picking one produced "The model returned an empty response".
//
// This is a DIFFERENT bar from isGeneralChatModel, which curates the Featured
// shortlist. That one also drops :free tiers, dated snapshots and -instruct
// variants — right for a default, wrong for a list the user opened on purpose.
describe('canOutputText', () => {
  const entry = (outputModalities) => ({ id: 'x/y', outputModalities });

  it('accepts text models', () => {
    expect(canOutputText(entry(['text']))).toBe(true);
  });

  it('accepts multimodal models that can still answer in text', () => {
    expect(canOutputText(entry(['text', 'image']))).toBe(true);
  });

  it('rejects models that cannot produce text', () => {
    for (const mods of [['image'], ['audio'], ['embedding'], ['video'], ['image', 'audio']]) {
      expect(canOutputText(entry(mods)), mods.join('+')).toBe(false);
    }
  });

  // A missing field is OpenRouter not describing the model, which is not
  // evidence it cannot emit text. Hiding a working model is the worse error —
  // the same rule the credential code follows for an unreadable store.
  it('treats unknown modalities as usable', () => {
    expect(canOutputText(entry([]))).toBe(true);
    expect(canOutputText({ id: 'x/y' })).toBe(true);
    expect(canOutputText(null)).toBe(true);
  });

  // isGeneralChatModel is stricter on purpose; canOutputText must NOT inherit
  // its curation, or the "All models" list loses entries that work fine.
  it('admits models the featured filter deliberately excludes', () => {
    const free = { id: 'meta/llama-3:free', outputModalities: ['text'] };
    const instruct = { id: 'meta/llama-3-instruct', outputModalities: ['text'] };
    for (const m of [free, instruct]) {
      expect(isGeneralChatModel(m), `featured: ${m.id}`).toBe(false);
      expect(canOutputText(m), `selectable: ${m.id}`).toBe(true);
    }
  });
});
