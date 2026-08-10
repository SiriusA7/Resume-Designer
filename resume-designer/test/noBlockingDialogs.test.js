import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's own module URL, not process.cwd() — so the walk
// still finds src/ if vitest is ever invoked from outside resume-designer/.
// NOTE: this deliberately avoids the literal `new URL('../src',
// import.meta.url)` spelling: under this project's vitest+jsdom setup, Vite's
// built-in "new URL(x, import.meta.url)" asset-URL transform matches that
// exact syntax at the source-text level (regardless of which binding `URL`
// resolves to) and rewrites it to resolve against the dev-server origin
// (http://localhost:3000/) instead of the real file path — confirmed by
// direct testing. fileURLToPath(import.meta.url) + path.dirname/join isn't
// pattern-matched by that transform and resolves correctly.
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src');

// window.confirm is unusable on iOS: it returns an always-truthy Promise, so
// `if (confirm(...))` ALWAYS takes the destructive branch. The ONE permitted use
// is native.js's web fallback, which is unreachable on Tauri — isTauri is true
// on iOS, so showMessage returns before reaching it.
//
// Task 2 widens this to cover `alert(` as well, once the eleven alert sites are
// migrated. Keeping the scopes separate keeps every commit green.
const ALLOWED = new Set(['src/native.js']);

function jsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) jsFiles(full, acc);
    else if (/\.(js|jsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

// Matches the bare call AND the qualified spellings — `window.confirm(`,
// `globalThis.confirm(`, `self.confirm(` — because the qualified form is the
// likeliest way the bug comes back and a naive "not preceded by a dot" rule
// makes it invisible.
//
// Still ignored: `confirmDestructive(` (word char follows), `props.confirm(`
// (an arbitrary member access, not a global), and a zero-argument `confirm()`
// — PdfDialog passes one as a local callback prop.
export function findOffenders(pattern) {
  const offenders = [];
  for (const file of jsFiles(SRC_DIR)) {
    const rel = `src/${relative(SRC_DIR, file).replace(/\\/g, '/')}`;
    if (ALLOWED.has(rel)) continue;
    const source = readFileSync(file, 'utf8');
    source.split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
      if (pattern.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  return offenders;
}

describe('no blocking browser dialogs', () => {
  it('never calls window.confirm outside the web fallback', () => {
    expect(findOffenders(/(^|[^\w.])(window\.|globalThis\.|self\.)?confirm\s*\((?!\s*\))/)).toEqual([]);
  });

  it('never calls window.alert outside the web fallback', () => {
    // alert() does not block on iOS — it returns in ~1ms — so any code that
    // sequences on it is broken, and an error the user must see can be missed.
    expect(findOffenders(/(^|[^\w.])(window\.|globalThis\.|self\.)?alert\s*\((?!\s*\))/)).toEqual([]);
  });
});
