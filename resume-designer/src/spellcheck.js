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
