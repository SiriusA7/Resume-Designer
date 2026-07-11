import { describe, it, expect } from 'vitest';
import { isOwnedKey } from '../src/persistence.js';

describe('isOwnedKey', () => {
  it('accepts a fixed owned key', () => {
    expect(isOwnedKey('resume-designer-data')).toBe(true);
    expect(isOwnedKey('resume-zoom')).toBe(true);
  });
  it('accepts the applications store key', () => {
    expect(isOwnedKey('resume-designer-applications')).toBe(true);
  });
  it('accepts history-prefixed keys', () => {
    expect(isOwnedKey('resume-designer-history-variant-1')).toBe(true);
  });
  it('rejects foreign keys', () => {
    expect(isOwnedKey('evil-key')).toBe(false);
    expect(isOwnedKey('resume-designer')).toBe(false);
    expect(isOwnedKey('')).toBe(false);
  });
});
