import { describe, it, expect, beforeEach } from 'vitest';
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
