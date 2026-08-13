import { describe, it, expect } from 'vitest';
import { classifyKey, keyScope, DEVICE_LOCAL_KEYS } from '../src/sync/syncKeys.js';
import {
  BACKUP_FIXED_KEYS,
  BACKUP_HISTORY_PREFIX,
  isSharedKey,
  PROFILES_KEY,
  ACTIVE_PROFILE_KEY,
  OPENROUTER_KEY_KEY,
} from '../src/profileKeys.js';

describe('classifyKey', () => {
  it('classifies every key the backup knows about', () => {
    // The whole point: a key added to BACKUP_FIXED_KEYS without a sync
    // decision fails here rather than silently defaulting to synced (which
    // would leak device state) or local (which would lose content).
    for (const key of BACKUP_FIXED_KEYS) {
      expect(classifyKey(key), key).not.toBe('unknown');
    }
  });

  it('classifies every SHARED_KEYS key too, not only BACKUP_FIXED_KEYS', () => {
    // profileKeys.js does not export SHARED_KEYS itself, so build the set
    // from what it does export (PROFILES_KEY, ACTIVE_PROFILE_KEY,
    // OPENROUTER_KEY_KEY) plus the literal shared key names DEVICE_LOCAL_KEYS
    // already names. A SHARED_KEYS member is NOT reached by the
    // BACKUP_FIXED_KEYS check in classifyKey, so without this test a shared
    // key left off both DEVICE_LOCAL_KEYS and SYNCED_SHARED_KEYS would come
    // back 'unknown' and nothing here would catch it.
    const sharedKeys = new Set([
      PROFILES_KEY,
      ACTIVE_PROFILE_KEY,
      OPENROUTER_KEY_KEY,
      ...DEVICE_LOCAL_KEYS.filter(isSharedKey),
    ]);
    for (const key of sharedKeys) {
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

  it('keeps the sync switch itself on the device that owns it', () => {
    // Whether this device syncs is this device's business. Syncing the flag
    // would also let one device turn sync ON for another, which is the one
    // decision this preference exists to leave with the person holding the
    // phone.
    expect(classifyKey('resume-designer-sync-enabled')).toBe('local');
  });

  it('keeps the OpenRouter credential off CloudKit', () => {
    // A credential must never reach CloudKit, so this must stay 'local' even
    // though it is a SHARED_KEYS member like the synced profile registry.
    expect(classifyKey('resume-designer-openrouter-key')).toBe('local');
  });

  it('syncs content', () => {
    expect(classifyKey('resume-designer-data')).toBe('synced');
    expect(classifyKey('resume-designer-applications')).toBe('synced');
    expect(classifyKey('resume-designer-job-descriptions')).toBe('synced');
    expect(classifyKey('resume-designer-chat-threads')).toBe('synced');
  });

  it('syncs the profile registry, which CloudKit zone reconciliation depends on', () => {
    // Each profile lives in its own CloudKit record zone; the zone list is
    // reconciled against this registry, so a device that never receives it
    // cannot discover another device's profiles.
    expect(classifyKey('resume-designer-profiles')).toBe('synced');
  });

  it('reports an unrecognised key rather than guessing', () => {
    expect(classifyKey('resume-designer-something-new')).toBe('unknown');
    expect(classifyKey('')).toBe('unknown');
  });

  it('catches a typo in DEVICE_LOCAL_KEYS rather than letting it silently miss classification', () => {
    // DEVICE_LOCAL_KEYS mixes keys from two sources: BACKUP_FIXED_KEYS (the
    // backup/restore system) and SHARED_KEYS (machine-level keys in
    // profileKeys.js). A misspelled entry belongs to neither list — that is
    // not a new category of key, it is a typo, and this is the guard that
    // catches it.
    for (const key of DEVICE_LOCAL_KEYS) {
      expect(BACKUP_FIXED_KEYS.includes(key) || isSharedKey(key), key).toBe(true);
    }
  });
});

describe('keyScope', () => {
  it('calls the profile registry shared', () => {
    expect(keyScope('resume-designer-profiles')).toBe('shared');
  });

  it('calls every other synced key profile-scoped', () => {
    expect(keyScope('resume-designer-applications')).toBe('profile');
    expect(keyScope('resume-designer-token-usage')).toBe('profile');
  });
});
