import { describe, it, expect } from 'vitest';
import { computeAppHeight } from '../src/viewportHeight.js';

describe('computeAppHeight', () => {
  it('prefers the visual viewport, which shrinks for the keyboard', () => {
    // iPhone 16 Pro portrait: 874pt tall, ~336pt of keyboard.
    expect(computeAppHeight({ visualViewportHeight: 538, innerHeight: 874 })).toBe(538);
  });

  it('uses the visual viewport even when it equals innerHeight (no keyboard)', () => {
    expect(computeAppHeight({ visualViewportHeight: 874, innerHeight: 874 })).toBe(874);
  });

  it('returns null when there is no visual viewport, so CSS keeps its fallback', () => {
    expect(computeAppHeight({ visualViewportHeight: undefined, innerHeight: 874 })).toBeNull();
  });

  it('ignores a non-finite or zero visual viewport rather than collapsing the app', () => {
    expect(computeAppHeight({ visualViewportHeight: 0, innerHeight: 874 })).toBeNull();
    expect(computeAppHeight({ visualViewportHeight: Number.NaN, innerHeight: 874 })).toBeNull();
  });

  it('rounds down, so a fractional height never overflows the viewport by a pixel', () => {
    expect(computeAppHeight({ visualViewportHeight: 537.6, innerHeight: 874 })).toBe(537);
  });
});
