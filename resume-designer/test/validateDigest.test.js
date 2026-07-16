import { describe, it, expect } from 'vitest';
import { validateDigest, SENTINEL } from '../scripts/ci/validate-digest.mjs';

const V = '1.16.0';
const good = [
  `## Resume Designer ${V}`,
  '',
  '- New: a Library to search your résumés and track every application.',
  '- The update dialog now shows what changed before you install.',
  '- Plus a dozen smaller fixes and polish.',
  '',
  SENTINEL,
  '',
].join('\n');

describe('validateDigest', () => {
  it('accepts a well-formed digest and strips the sentinel', () => {
    const r = validateDigest(good, V);
    expect(r.ok).toBe(true);
    expect(r.notes).not.toContain(SENTINEL);
    expect(r.notes).toMatch(/^## Resume Designer 1\.16\.0/);
    expect(r.notes.trim().endsWith('polish.')).toBe(true);
  });

  it('rejects a missing sentinel (truncation)', () => {
    const r = validateDigest(good.replace(SENTINEL, ''), V);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/sentinel/i);
  });

  it('rejects a sentinel that is not the last content line', () => {
    const r = validateDigest(good.replace(`${SENTINEL}\n`, `${SENTINEL}\n- stray bullet\n`), V);
    expect(r.ok).toBe(false);
  });

  it('rejects a missing or mismatched version heading', () => {
    expect(validateDigest(good, '9.9.9').ok).toBe(false);
    expect(validateDigest(good.replace(/^## .*$/m, 'Notes'), V).ok).toBe(false);
  });

  it('rejects zero bullets and more than 8 bullets', () => {
    const noBullets = `## Resume Designer ${V}\n\nAll better now.\n\n${SENTINEL}\n`;
    expect(validateDigest(noBullets, V).ok).toBe(false);
    const many = [`## Resume Designer ${V}`, '',
      ...Array.from({ length: 9 }, (_, i) => `- bullet ${i}`), '', SENTINEL, ''].join('\n');
    expect(validateDigest(many, V).ok).toBe(false);
  });

  it('rejects leaked section structure (### headers)', () => {
    const sectioned = `## Resume Designer ${V}\n\n### ✨ New features\n- something\n\n${SENTINEL}\n`;
    expect(validateDigest(sectioned, V).ok).toBe(false);
  });
});
