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
