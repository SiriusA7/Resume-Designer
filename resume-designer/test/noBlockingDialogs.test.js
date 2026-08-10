import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

// Bare calls with a prompt only: not preceded by `.` or a word character, so
// `confirmDestructive(` and `props.confirm(` are correctly ignored. A
// zero-argument local callback named `confirm` is also ignored.
export function findOffenders(pattern) {
  const offenders = [];
  for (const file of jsFiles('src')) {
    const rel = file.replace(/\\/g, '/');
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
    expect(findOffenders(/(^|[^.\w])confirm\s*\((?!\s*\))/)).toEqual([]);
  });
});
