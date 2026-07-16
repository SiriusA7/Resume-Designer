import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { importFullBackupFromEnvelope } from '../src/persistence.js';

beforeEach(() => {
  localStorage.clear();
});

describe('importFullBackupFromEnvelope', () => {
  it('throws on a non-envelope object', () => {
    expect(() => importFullBackupFromEnvelope({})).toThrow(/backupFormat/i);
    expect(() => importFullBackupFromEnvelope(null)).toThrow(/backupFormat/i);
  });

  it('throws when a value is not a string', () => {
    expect(() =>
      importFullBackupFromEnvelope({
        backupFormat: 1,
        keys: { 'resume-designer-data': 123 },
      })
    ).toThrow(/must be a string/i);
  });

  it('writes owned keys and silently skips foreign keys', () => {
    const result = importFullBackupFromEnvelope({
      backupFormat: 1,
      keys: {
        'resume-designer-data': '{"summary":"hi"}',
        'evil-key': 'pwned',
      },
    });
    expect(localStorage.getItem('resume-designer-data')).toBe('{"summary":"hi"}');
    expect(localStorage.getItem('evil-key')).toBeNull();
    expect(result.keysImported).toBe(1);
  });

  it('clears pre-existing owned keys not present in the new backup', () => {
    localStorage.setItem('resume-zoom', '1.5');
    importFullBackupFromEnvelope({
      backupFormat: 1,
      keys: { 'resume-designer-data': '{}' },
    });
    expect(localStorage.getItem('resume-zoom')).toBeNull();
    expect(localStorage.getItem('resume-designer-data')).toBe('{}');
  });

  // Legacy Electron stores can hold job descriptions as an id-keyed object map
  // (the Rust migration probe counts that shape as valid); the app requires an
  // array. The import must canonicalize it — and leave every other shape alone.
  it('normalizes an object-map job-descriptions value to an array', () => {
    importFullBackupFromEnvelope({
      backupFormat: 1,
      keys: {
        'resume-designer-job-descriptions':
          '{"jd-1":{"id":"jd-1","title":"PM","description":"Ship"},"jd-2":{"id":"jd-2","title":"EM","description":"Lead"}}',
      },
    });
    const stored = JSON.parse(localStorage.getItem('resume-designer-job-descriptions'));
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.map((j) => j.id)).toEqual(['jd-1', 'jd-2']);
  });

  it('leaves an array job-descriptions value byte-for-byte untouched', () => {
    const value = '[{"id":"jd-1","title":"PM","description":"Ship"}]';
    importFullBackupFromEnvelope({
      backupFormat: 1,
      keys: { 'resume-designer-job-descriptions': value },
    });
    expect(localStorage.getItem('resume-designer-job-descriptions')).toBe(value);
  });

  it('leaves malformed job-descriptions JSON as-is', () => {
    importFullBackupFromEnvelope({
      backupFormat: 1,
      keys: { 'resume-designer-job-descriptions': 'not-json{' },
    });
    expect(localStorage.getItem('resume-designer-job-descriptions')).toBe('not-json{');
  });
});

// Regression (PR #89 finding 25): both import paths wipe existing keys BEFORE
// writing the backup's. A mid-write QuotaExceededError in passthrough mode (a
// desktop multi-profile backup can exceed a browser origin's quota) used to
// leave storage half-restored or empty — losing the CURRENT profiles. The
// import now snapshots everything it removes and rolls back on failure.
describe('import quota rollback', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Throw quota exactly once, when `targetKey` is first written; pass every
  // other write through so the rollback's own setItem calls succeed.
  function throwQuotaOnce(targetKey) {
    const real = Storage.prototype.setItem;
    let fired = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(k, v) {
      if (!fired && k === targetKey) {
        fired = true;
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      return real.call(this, k, v);
    });
  }

  it('format 2: restores registry, pointer, and workspaces on a critical-write quota throw', () => {
    localStorage.setItem('resume-designer-profiles', JSON.stringify([{ id: 'orig', name: 'Orig' }]));
    localStorage.setItem('resume-designer-active-profile', 'orig');
    localStorage.setItem('resume-p--orig--resume-designer-data', '{"mine":true}');
    localStorage.setItem('resume-designer-theme', 'dark');

    throwQuotaOnce('resume-p--pB--resume-designer-data');

    expect(() => importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'pA', name: 'A' }, { id: 'pB', name: 'B' }],
      activeProfile: 'pA',
      shared: {},
      profiles: {
        pA: { keys: { 'resume-designer-data': '{"a":1}' } },
        pB: { keys: { 'resume-designer-data': '{"b":2}' } },
      },
    })).toThrow(/quota/i);

    // Pre-import state is fully back…
    expect(localStorage.getItem('resume-designer-profiles'))
      .toBe(JSON.stringify([{ id: 'orig', name: 'Orig' }]));
    expect(localStorage.getItem('resume-designer-active-profile')).toBe('orig');
    expect(localStorage.getItem('resume-p--orig--resume-designer-data')).toBe('{"mine":true}');
    expect(localStorage.getItem('resume-designer-theme')).toBe('dark');
    // …and nothing from the failed import survives.
    expect(localStorage.getItem('resume-p--pA--resume-designer-data')).toBeNull();
    expect(localStorage.getItem('resume-p--pB--resume-designer-data')).toBeNull();
  });

  it('format 1: restores the active workspace on a pass-1 quota throw', () => {
    localStorage.setItem('resume-designer-data', '{"mine":true}');
    localStorage.setItem('resume-zoom', '1.25');

    throwQuotaOnce('resume-designer-job-descriptions');

    expect(() => importFullBackupFromEnvelope({
      backupFormat: 1,
      keys: {
        'resume-designer-data': '{"theirs":true}',
        'resume-designer-job-descriptions': '[]',
      },
    })).toThrow(/quota/i);

    expect(localStorage.getItem('resume-designer-data')).toBe('{"mine":true}');
    expect(localStorage.getItem('resume-zoom')).toBe('1.25');
    expect(localStorage.getItem('resume-designer-job-descriptions')).toBeNull();
  });
});
