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
//
// Keys are the camelCase DOM-property spellings, not the lowercase HTML
// attribute names, because this object has two consumers with different
// requirements: `inlineEditor.js` applies it with `setAttribute`/
// `removeAttribute`, which case-folds and doesn't care either way; but
// `ProfileTabs.jsx` spreads it directly into JSX as props, and React only
// recognises the camelCase spellings (`autoCorrect`/`autoCapitalize`) as valid
// DOM properties — the lowercase form logs an "Invalid DOM property" warning
// once per prop, per render. React renders camelCase props to the correct
// lowercase DOM attributes, so camelCase satisfies both consumers. Do not
// "tidy" these back to lowercase.
export const EDITABLE_TEXT_ATTRS = {
  autoCorrect: 'off',
  autoCapitalize: 'off',
};
