import { describe, it, expect } from 'vitest';
import { isIOSPlatform } from '../src/native.js';

describe('isIOSPlatform', () => {
  it('detects iPhone from the user agent', () => {
    expect(isIOSPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 5)).toBe(true);
  });

  it('detects modern iPadOS, which reports a MacIntel desktop identity', () => {
    // iPadOS 13+ lies in the UA; maxTouchPoints is the only reliable tell.
    expect(isIOSPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)).toBe(true);
  });

  it('does not match a real Mac, which reports zero touch points', () => {
    expect(isIOSPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0)).toBe(false);
  });

  it('does not match Windows', () => {
    expect(isIOSPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0)).toBe(false);
  });
});
