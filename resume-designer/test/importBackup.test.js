import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { importFullBackupFromEnvelope, importFullBackupMerge } from '../src/persistence.js';

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

  // Format-1 envelopes predate the keychain move entirely, so they are the
  // likeliest carriers of a credential inside the data blob. Both merge writes
  // are reachable: the wholesale adopt takes the incoming blob verbatim, and
  // the merge keeps incomingData.settings whenever the existing blob has no
  // settings key of its own to shadow it.
  describe('legacy credentials in a format-1 merge', () => {
    const withKey = (extra = {}) => JSON.stringify({
      variants: { v1: {} },
      settings: { openrouterKey: 'sk-legacy-blob', theme: 'dark' },
      ...extra,
    });

    it('strips it when adopting the incoming blob wholesale', () => {
      importFullBackupMerge({ backupFormat: 1, keys: { 'resume-designer-data': withKey() } });

      const stored = JSON.parse(localStorage.getItem('resume-designer-data'));
      expect(stored.settings.openrouterKey).toBeUndefined();
      // Only the credential goes.
      expect(stored.settings.theme).toBe('dark');
      expect(stored.variants).toEqual({ v1: {} });
    });

    it('strips it when the existing blob has no settings to shadow it', () => {
      // No `settings` key locally, so the incoming one survives the spread.
      localStorage.setItem('resume-designer-data', JSON.stringify({ variants: { v9: {} } }));

      importFullBackupMerge({ backupFormat: 1, keys: { 'resume-designer-data': withKey() } });

      const stored = JSON.parse(localStorage.getItem('resume-designer-data'));
      expect(stored.settings?.openrouterKey).toBeUndefined();
      expect(localStorage.getItem('resume-designer-data')).not.toContain('sk-legacy-blob');
    });
  });

  // The Replace path writes through normalizeImportedValue — which handled only
  // job descriptions until the credential strip moved into it. On a fresh
  // install with an empty keychain the key would land in plaintext, go live
  // immediately, and be promoted into the keychain on the next boot: an old
  // backup quietly restoring a credential the exclusion policy says it must not.
  //
  // The automatic Electron upgrade shares this code path and is the ONE case
  // that must not strip — see the keepCredential tests below.
  it('strips a legacy credential on a format-1 REPLACE import', () => {
    importFullBackupFromEnvelope({
      backupFormat: 1,
      keys: {
        'resume-designer-data': JSON.stringify({
          variants: { v1: {} },
          settings: { openrouterKey: 'sk-legacy-replace', theme: 'dark' },
        }),
      },
    });

    const stored = localStorage.getItem('resume-designer-data');
    expect(stored).not.toContain('sk-legacy-replace');
    const parsed = JSON.parse(stored);
    expect(parsed.settings.openrouterKey).toBeUndefined();
    expect(parsed.settings.theme).toBe('dark');
    expect(parsed.variants).toEqual({ v1: {} });
  });

  // The automatic Electron upgrade carries the user's own LIVE data across an
  // in-place install on the same machine — it is not a backup file being
  // restored. Stripping there deleted the key outright, and main.js then stamps
  // the migration flag one-shot, so the migration never ran again and the user
  // came up permanently without the AI credential they had configured.
  describe('keepCredential (automatic Electron upgrade)', () => {
    const envelope = () => ({
      backupFormat: 1,
      keys: {
        'resume-designer-data': JSON.stringify({
          variants: { v1: {} },
          settings: { openrouterKey: 'sk-electron-live', theme: 'dark' },
        }),
      },
    });

    it('carries the credential across so extraction can migrate it', () => {
      importFullBackupFromEnvelope(envelope(), { keepCredential: true });

      const parsed = JSON.parse(localStorage.getItem('resume-designer-data'));
      // Left in the blob, which is exactly where extractSharedApiKey looks —
      // it then moves to the shared key and on into the keychain.
      expect(parsed.settings.openrouterKey).toBe('sk-electron-live');
      expect(parsed.settings.theme).toBe('dark');
    });

    // The exemption must be opt-in, or it silently reopens the backup hole it
    // is carved out of.
    it('still strips when the flag is absent', () => {
      importFullBackupFromEnvelope(envelope());

      expect(localStorage.getItem('resume-designer-data')).not.toContain('sk-electron-live');
    });

    // backupFlow's manual "import from previous installation" reads the SAME
    // LevelDB store on the same machine, and offers a merge as well as a
    // replace. Fixing only the automatic path left a user who chose the manual
    // recovery losing their key — the exemption belongs to the data's origin,
    // not to one caller.
    it('carries the credential through the MERGE path too', () => {
      importFullBackupMerge(envelope(), { keepCredential: true });

      const parsed = JSON.parse(localStorage.getItem('resume-designer-data'));
      expect(parsed.settings.openrouterKey).toBe('sk-electron-live');
    });

    it('merge still strips when the flag is absent', () => {
      importFullBackupMerge(envelope());

      expect(localStorage.getItem('resume-designer-data')).not.toContain('sk-electron-live');
    });
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
