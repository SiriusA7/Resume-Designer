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

/** Newest first, then descending id — the tiebreak deriveFeatured relies on. */
function newestFirst(a, b) {
  return b.created - a.created || b.id.localeCompare(a.id);
}

/**
 * Derive the "featured" shortlist live from the catalog. Two structural rules,
 * deliberately free of vendor-specific version parsing (which was prototyped
 * and rejected — it picked -fast/-pro over their cheaper base siblings):
 *
 *   1. prefix-sibling — drop X when another surviving id is a strict prefix of
 *      it, so `claude-opus-5` beats `claude-opus-5-fast`.
 *   2. family-root    — keep only the newest model per version-agnostic root.
 *
 * Both `created` sorts break ties on descending id: `created` has second
 * granularity and same-second sibling releases do happen, so without the
 * secondary key the pick would follow API response order, not catalog content.
 */
export function deriveFeatured(entries, perProvider = 4) {
  const grouped = {};
  for (const [prefix, label] of FEATURED_PROVIDERS) {
    const pool = entries.filter((m) => m.id.startsWith(`${prefix}/`) && isGeneralChatModel(m));
    if (pool.length === 0) continue;

    const ids = pool.map((m) => m.id);
    const bases = pool.filter((m) => !ids.some((o) => o !== m.id && m.id.startsWith(`${o}-`)));

    const byRoot = new Map();
    for (const m of [...bases].sort(newestFirst)) {
      const root = familyRoot(m.id);
      if (!byRoot.has(root)) byRoot.set(root, m);
    }

    const top = [...byRoot.values()].sort(newestFirst).slice(0, perProvider);
    if (top.length) grouped[label] = top;
  }
  return grouped;
}

/**
 * Strip a redundant "<Group>: " provider prefix from a label rendered under
 * that same group heading. OpenRouter names are inconsistently prefixed
 * ("Anthropic: Claude Opus 5" vs "Claude Opus 5"); only the exact own-group
 * prefix is stripped, so a colon inside a legitimate model name survives.
 */
export function stripGroupPrefix(label, group) {
  const prefix = `${group}: `;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

// Opening a model picker revalidates if the cache is older than this. The 24h
// hard TTL in aiService still backs the reasoning-support path; this only
// governs how eagerly the picker refreshes.
export const CATALOG_SOFT_TTL_MS = 5 * 60 * 1000;
