import { describe, it, expect, afterEach } from 'vitest';
import { setByPath, createChangeSet } from '../src/diffEngine.js';

afterEach(() => {
  // Hygiene: if the pollution guard ever regresses, keep the fallout inside
  // the failing test instead of leaking into the rest of the run.
  delete Object.prototype.polluted;
});

describe('setByPath', () => {
  it('sets ordinary paths, creating missing containers', () => {
    const obj = {};
    setByPath(obj, 'experience[0].title', 'Engineer');
    expect(obj.experience[0].title).toBe('Engineer');
  });

  it('ignores paths with a __proto__ segment — no prototype pollution', () => {
    const obj = {};
    setByPath(obj, '__proto__.polluted', 'x');
    expect({}.polluted).toBeUndefined();
    expect(obj.polluted).toBeUndefined();
  });

  it('ignores paths walking constructor.prototype — no prototype pollution', () => {
    const obj = {};
    setByPath(obj, 'constructor.prototype.polluted', 'x');
    expect({}.polluted).toBeUndefined();
  });

  it('createChangeSet survives a malicious path without throwing or polluting', () => {
    // Paths come from AI model output; one bad path must not break the whole
    // change set (setByPath skips it silently rather than throwing).
    const changeSet = createChangeSet({ summary: 'Old' }, {
      summary: 'New',
      '__proto__.polluted': 'x',
    });
    expect(changeSet.proposedData.summary).toBe('New');
    expect({}.polluted).toBeUndefined();
  });
});
