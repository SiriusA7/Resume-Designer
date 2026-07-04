import { describe, it, expect } from 'vitest';
import { revealStep } from '../src/components/chat/streamReveal.js';

describe('revealStep (streaming reveal pacing)', () => {
  it('returns the target once everything is shown', () => {
    expect(revealStep(5, 5)).toBe(5);
    expect(revealStep(6, 5)).toBe(5); // defensive: shown past target clamps back
  });

  it('reveals at least the minimum step at the live edge', () => {
    expect(revealStep(0, 2)).toBe(2);
    expect(revealStep(50, 53)).toBe(52); // backlog 3 -> ceil(3/5)=1, floored to min 2
  });

  it('accelerates with backlog, paced by the divisor below the lag cap', () => {
    expect(revealStep(0, 100)).toBe(20); // ceil(100/5); cap term (100-90=10) doesn't dominate
    expect(revealStep(0, 110)).toBe(22); // ceil(110/5)
  });

  it('never overshoots the target', () => {
    expect(revealStep(0, 1)).toBe(1); // min step 2 clamps to target
    expect(revealStep(99, 100)).toBe(100);
    for (let shown = 0; shown <= 200; shown++) {
      expect(revealStep(shown, 200)).toBeLessThanOrEqual(200);
    }
  });

  it('always converges to the target in finite frames', () => {
    let shown = 0;
    const target = 4096;
    let frames = 0;
    while (shown < target) {
      const next = revealStep(shown, target);
      expect(next).toBeGreaterThan(shown); // strictly advances
      shown = next;
      frames += 1;
      expect(frames).toBeLessThan(target); // can't take more frames than characters
    }
    expect(shown).toBe(target);
  });

  it('honours custom minStep / divisor', () => {
    expect(revealStep(0, 100, 1, 10)).toBe(10);
    expect(revealStep(0, 100, 50, 10)).toBe(50); // min step wins
  });

  it('never lets the display trail by more than maxLag', () => {
    // backlog 1000, maxLag 90 -> must jump to within 90 of target this frame
    const next = revealStep(0, 1000, 2, 5, 90);
    expect(1000 - next).toBeLessThanOrEqual(90);
    expect(next).toBe(910); // backlog - maxLag = 910 dominates ceil(1000/5)=200
  });

  it('does not engage the cap for a normal small backlog', () => {
    // backlog 40 < maxLag 90 -> paced by the divisor, not the cap
    expect(revealStep(0, 40, 2, 5, 90)).toBe(8); // ceil(40/5)
  });
});
