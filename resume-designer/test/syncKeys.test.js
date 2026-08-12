import { describe, it, expect } from 'vitest';
import { classifyKey, DEVICE_LOCAL_KEYS } from '../src/sync/syncKeys.js';
import { BACKUP_FIXED_KEYS, BACKUP_HISTORY_PREFIX } from '../src/profileKeys.js';

describe('classifyKey', () => {
  it('classifies every key the backup knows about', () => {
    // The whole point: a key added to BACKUP_FIXED_KEYS without a sync
    // decision fails here rather than silently defaulting to synced (which
    // would leak device state) or local (which would lose content).
    for (const key of BACKUP_FIXED_KEYS) {
      expect(classifyKey(key), key).not.toBe('unknown');
    }
  });

  it('syncs version history, which is the conflict recovery path', () => {
    expect(classifyKey(`${BACKUP_HISTORY_PREFIX}variant-abc`)).toBe('synced');
  });

  it('keeps device state on the device', () => {
    expect(classifyKey('resume-zoom')).toBe('local');
    expect(classifyKey('resume-designer-theme')).toBe('local');
    expect(classifyKey('resume-designer-active-profile')).toBe('local');
    expect(classifyKey('resume-designer-update-channel')).toBe('local');
    expect(classifyKey('resume-designer-model-catalog')).toBe('local');
  });

  it('syncs content', () => {
    expect(classifyKey('resume-designer-data')).toBe('synced');
    expect(classifyKey('resume-designer-applications')).toBe('synced');
    expect(classifyKey('resume-designer-job-descriptions')).toBe('synced');
    expect(classifyKey('resume-designer-chat-threads')).toBe('synced');
  });

  it('reports an unrecognised key rather than guessing', () => {
    expect(classifyKey('resume-designer-something-new')).toBe('unknown');
    expect(classifyKey('')).toBe('unknown');
  });

  it('never lists a device-local key that is not a real key', () => {
    for (const key of DEVICE_LOCAL_KEYS) {
      expect(BACKUP_FIXED_KEYS.includes(key), key).toBe(true);
    }
  });
});
