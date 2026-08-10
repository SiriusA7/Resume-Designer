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

// Kinds where autocorrect is welcome: free text the user is writing FOR a
// machine to read, where a substitution is harmless and a typo is not stored.
const AUTOCORRECT_KINDS = new Set(['chat']);

/**
 * Autocorrect policy — deliberately far stricter than spellcheck.
 *
 * Résumé fields round-trip through `textContent` into the store
 * (`inlineEditor.js`), so a WebKit autocorrection is persisted with no undo and
 * no signal. Worse, the live value carries raw markdown markers, so smart
 * punctuation rewrites `**bold**` into curly quotes and dashes. Spellcheck only
 * squiggles; autocorrect edits.
 *
 * @param {string} [fieldKind] @returns {boolean}
 */
export function shouldAutocorrect(fieldKind) {
  return AUTOCORRECT_KINDS.has(fieldKind);
}

// The attribute set that disables WebKit's text substitution on an editable.
// `autocorrect` and `autocapitalize` are the iOS-relevant pair; `autocomplete`
// stops the keyboard's strip offering stored form values.
export const EDITABLE_TEXT_ATTRS = {
  autocorrect: 'off',
  autocapitalize: 'off',
  autocomplete: 'off',
};
