import { describe, it, expect } from 'vitest';
import {
  PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY, PHYSICAL_PREFIX,
  isSharedKey, isOwnedKey, physicalKey, splitPhysicalKey, mapKey,
} from '../src/profileKeys.js';

describe('key classification', () => {
  it('marks machine-level keys shared', () => {
    for (const k of [
      'resume-designer-theme',
      'resume-designer-update-channel',
      'resume-designer-auto-update-check',
      'resume-designer-model-catalog',
      'resume-designer-electron-migration-attempted',
      PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY,
    ]) expect(isSharedKey(k), k).toBe(true);
  });

  it('leaves per-profile keys unshared', () => {
    for (const k of [
      'resume-designer-data', 'resume-designer-job-descriptions',
      'resume-designer-applications', 'resume-designer-chat-threads',
      'resume-designer-history-abc', 'resume-zoom',
      'resume-designer-onboarding-complete',
    ]) expect(isSharedKey(k), k).toBe(false);
  });

  it('isOwnedKey keeps its historical behavior', () => {
    expect(isOwnedKey('resume-designer-data')).toBe(true);
    expect(isOwnedKey('resume-designer-history-x1')).toBe(true);
    expect(isOwnedKey('resume-designer-theme')).toBe(true);
    expect(isOwnedKey('resume-designer-model-catalog')).toBe(false);
    expect(isOwnedKey('unrelated')).toBe(false);
  });
});

describe('physical key mapping', () => {
  it('round-trips physicalKey/splitPhysicalKey', () => {
    const p = physicalKey('p1a2b3', 'resume-designer-data');
    expect(p).toBe(`${PHYSICAL_PREFIX}p1a2b3:resume-designer-data`);
    expect(splitPhysicalKey(p)).toEqual({ profileId: 'p1a2b3', logicalKey: 'resume-designer-data' });
    expect(splitPhysicalKey('resume-designer-data')).toBeNull();
    expect(splitPhysicalKey(`${PHYSICAL_PREFIX}noseparator`)).toBeNull();
  });

  it('mapKey namespaces per-profile keys and nothing else', () => {
    expect(mapKey('p1', 'resume-designer-data')).toBe(`${PHYSICAL_PREFIX}p1:resume-designer-data`);
    expect(mapKey('p1', 'resume-designer-theme')).toBe('resume-designer-theme');       // shared
    expect(mapKey('p1', `${PHYSICAL_PREFIX}p2:resume-zoom`)).toBe(`${PHYSICAL_PREFIX}p2:resume-zoom`); // already physical
    expect(mapKey(null, 'resume-designer-data')).toBe('resume-designer-data');         // mapping inactive
    // keys we don't own (e.g. __adoption_pending__) are never namespaced
    expect(mapKey('p1', '__adoption_pending__')).toBe('__adoption_pending__');
  });
});
