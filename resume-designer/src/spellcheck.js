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

// The attribute pair that disables WebKit's text substitution on an editable.
// Résumé fields round-trip through `textContent` into the store
// (`inlineEditor.js`), so a WebKit autocorrection is persisted with no undo and
// no signal. Worse, the live value carries raw markdown markers, so smart
// punctuation rewrites `**bold**` into curly quotes and dashes.
export const EDITABLE_TEXT_ATTRS = {
  autocorrect: 'off',
  autocapitalize: 'off',
};
