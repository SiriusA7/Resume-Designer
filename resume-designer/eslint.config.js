import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  { ignores: ['dist/', 'node_modules/', 'src-tauri/'] },
  js.configs.recommended,
  {
    rules: {
      // Underscore-prefixed args/vars/caught-errors are intentional throwaways.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Intentional control-char range in a security slug validator (src/aiService.js).
      'no-control-regex': 'off',
      // Deferred: retrofitting `{ cause }` onto legacy throw sites and reworking
      // pre-existing assignments is out of scope for the CI-foundation PR.
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Fast-Refresh hygiene applies only to the React component files.
    files: ['src/**/*.jsx'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['test/**/*.js', '*.config.{js,mjs}', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // Vitest runs under jsdom (see vitest.config.js), so tests legitimately use
      // browser globals (document, DOMParser, requestAnimationFrame, …) alongside node.
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Vendored shadcn primitives (and the dev-only preview harness) legitimately
    // export variant helpers alongside their components; Fast-Refresh hygiene
    // doesn't apply to generated/throwaway files.
    files: ['src/components/ui/**/*.jsx', 'src/dev/**/*.jsx'],
    plugins: { 'react-refresh': reactRefresh },
    rules: { 'react-refresh/only-export-components': 'off' },
  },
];
