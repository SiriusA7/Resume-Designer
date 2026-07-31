import { describe, it, expect, afterEach, vi } from 'vitest';
import { setByPath, createChangeSet } from '../src/diffEngine.js';

afterEach(() => {
  // Hygiene: if the pollution guard ever regresses, keep the fallout inside
  // the failing test instead of leaking into the rest of the run.
  delete Object.prototype.polluted;
  vi.restoreAllMocks();
});

// The guard skips (never throws), but not silently: a filtered path must leave
// a console.warn naming it, or the model's claimed change vanishes untraceably.
function expectWarnedAbout(warnSpy, path) {
  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(warnSpy.mock.calls[0].join(' ')).toContain(path);
}

describe('setByPath', () => {
  it('sets ordinary paths, creating missing containers', () => {
    const obj = {};
    setByPath(obj, 'experience[0].title', 'Engineer');
    expect(obj.experience[0].title).toBe('Engineer');
  });

  it('ignores paths with a __proto__ segment — no prototype pollution', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const obj = {};
    setByPath(obj, '__proto__.polluted', 'x');
    expect({}.polluted).toBeUndefined();
    expect(obj.polluted).toBeUndefined();
    expectWarnedAbout(warnSpy, '__proto__.polluted');
  });

  it('ignores paths walking constructor.prototype — no prototype pollution', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const obj = {};
    setByPath(obj, 'constructor.prototype.polluted', 'x');
    expect({}.polluted).toBeUndefined();
    expectWarnedAbout(warnSpy, 'constructor.prototype.polluted');
  });

  it('createChangeSet survives a malicious path without throwing or polluting', () => {
    // Paths come from AI model output; one bad path must not break the whole
    // change set (setByPath warns and skips it rather than throwing).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const changeSet = createChangeSet({ summary: 'Old' }, {
      summary: 'New',
      '__proto__.polluted': 'x',
    });
    expect(changeSet.proposedData.summary).toBe('New');
    expect({}.polluted).toBeUndefined();
    expectWarnedAbout(warnSpy, '__proto__.polluted');
  });
});
