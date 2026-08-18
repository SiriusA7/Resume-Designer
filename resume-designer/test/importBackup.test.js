import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  importFullBackupFromEnvelope, importFullBackupMerge, credentialFromEnvelope,
} from '../src/persistence.js';
import { OPENROUTER_KEY_KEY } from '../src/profileKeys.js';

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

    // Keeping the credential in the incoming blob is not enough on its own:
    // with existing data present, the merge replaces `settings` WHOLESALE with
    // the current one, so a user who already had Tauri-side data but no key and
    // chose "Merge previous data" still lost the Electron credential before the
    // reload-time extraction could migrate it.
    it('carries the credential into a merge with existing data', () => {
      localStorage.setItem('resume-designer-data', JSON.stringify({
        variants: { mine: {} },
        settings: { theme: 'light' },   // existing settings, no key of their own
      }));

      importFullBackupMerge(envelope(), { keepCredential: true });

      const parsed = JSON.parse(localStorage.getItem('resume-designer-data'));
      expect(parsed.settings.openrouterKey).toBe('sk-electron-live');
      // Current settings still win everywhere else.
      expect(parsed.settings.theme).toBe('light');
      expect(parsed.variants.mine).toBeDefined();
    });

    // The credential can arrive in the SHARED key rather than the blob — the
    // previous app stored it there once extraction had run. That key is no
    // longer "owned" (which is how it left backups), so the replace path's
    // owned-key filter dropped it, and the one-shot migration then reported
    // success with no credential.
    it('carries a shared-key credential through a REPLACE migration', () => {
      importFullBackupFromEnvelope({
        backupFormat: 1,
        keys: {
          'resume-designer-data': JSON.stringify({ variants: {}, settings: { theme: 'dark' } }),
          [OPENROUTER_KEY_KEY]: 'sk-shared-electron',
        },
      }, { keepCredential: true });

      // Present for extraction/initSecretStore to migrate into the keychain.
      expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-shared-electron');
    });

    it('drops a shared-key credential from a backup FILE', () => {
      importFullBackupFromEnvelope({
        backupFormat: 1,
        keys: {
          'resume-designer-data': JSON.stringify({ variants: {}, settings: {} }),
          [OPENROUTER_KEY_KEY]: 'sk-shared-electron',
        },
      });

      expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBeNull();
    });

    // The merge path had the same rule wrong in the OPPOSITE direction: it
    // writes every key it is handed, so an older backup carrying the shared
    // credential put it back in plaintext.
    it('drops a shared-key credential from a backup FILE merge', () => {
      importFullBackupMerge({
        backupFormat: 1,
        keys: { [OPENROUTER_KEY_KEY]: 'sk-shared-electron' },
      });

      expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBeNull();
    });

    it('carries a shared-key credential through a MERGE migration', () => {
      importFullBackupMerge({
        backupFormat: 1,
        keys: { [OPENROUTER_KEY_KEY]: 'sk-shared-electron' },
      }, { keepCredential: true });

      expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-shared-electron');
    });

    // A same-machine REPLACE has to put the credential in the KEYCHAIN, not
    // just in storage: adoptKeychainRead treats an existing entry as
    // authoritative at the next boot and the cleanup then strips the imported
    // copy, so the replace came up with the current key — or with none, when
    // that entry is the empty Clear sentinel. backupFlow does the write; this
    // pins the part that decides WHAT it writes.
    describe('credentialFromEnvelope', () => {
      it('finds it in the shared key', () => {
        expect(credentialFromEnvelope({
          backupFormat: 1, keys: { [OPENROUTER_KEY_KEY]: 'sk-shared' },
        })).toBe('sk-shared');
      });

      it('falls back to the data blob, where pre-extraction installs kept it', () => {
        expect(credentialFromEnvelope({
          backupFormat: 1,
          keys: {
            'resume-designer-data': JSON.stringify({ settings: { openrouterKey: 'sk-blob' } }),
          },
        })).toBe('sk-blob');
      });

      it('prefers the shared key, which is the later of the two', () => {
        expect(credentialFromEnvelope({
          backupFormat: 1,
          keys: {
            [OPENROUTER_KEY_KEY]: 'sk-shared',
            'resume-designer-data': JSON.stringify({ settings: { openrouterKey: 'sk-blob' } }),
          },
        })).toBe('sk-shared');
      });

      // Presence beats truthiness, for the fifth time in this PR: an empty
      // value means the previous install had CLEARED its key, and a replace
      // adopts that state rather than skipping it.
      it('returns an empty clear sentinel verbatim', () => {
        expect(credentialFromEnvelope({
          backupFormat: 1, keys: { [OPENROUTER_KEY_KEY]: '' },
        })).toBe('');
      });

      it('reports null when the envelope carries no credential', () => {
        expect(credentialFromEnvelope({ backupFormat: 1, keys: {} })).toBeNull();
        expect(credentialFromEnvelope({ backupFormat: 1, keys: { 'resume-designer-data': 'not json' } })).toBeNull();
        expect(credentialFromEnvelope({
          backupFormat: 1,
          keys: { 'resume-designer-data': JSON.stringify({ settings: 'nope' }) },
        })).toBeNull();
        expect(credentialFromEnvelope(null)).toBeNull();
      });
    });

    // Only into a GAP. An existing credential — including a deliberate '' —
    // is the user's current intent and must not be overwritten by an older one.
    it('never overwrites an existing credential during a merge', () => {
      for (const existing of ['sk-current', '']) {
        localStorage.clear();
        localStorage.setItem('resume-designer-data', JSON.stringify({
          variants: {}, settings: { openrouterKey: existing },
        }));

        importFullBackupMerge(envelope(), { keepCredential: true });

        expect(JSON.parse(localStorage.getItem('resume-designer-data')).settings.openrouterKey)
          .toBe(existing);
      }
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

// `resume-designer-sync-state` is in BACKUP_FIXED_KEYS because the per-unit
// modification stamps in it are genuinely per-profile data a backup has to
// carry. It also holds this device's `deviceId` — and seeding a second device
// from the first's backup is the natural migration path, one the iOS Settings
// sheet actively offers. Both devices then claimed the SAME origin id, and
// store.js scopes undo by origin ("undo traverses only this device's own
// steps"), so that invariant silently stopped holding between exactly the two
// devices most likely to be syncing with each other.
//
// Dropped on the way IN rather than on the way out: the backups that can carry
// a foreign id already exist, so only the receiving device can fix them — and
// only the receiving device is the one that must not clone. Nothing MINTS an id
// here; store.js's one-time memo is the single writer of that field and stays
// so, which is why there is no second generator to race it.
describe('the device identity in a restored sync-state key', () => {
  const SYNC_STATE = 'resume-designer-sync-state';
  const FOREIGN = 'device-theotherphone';
  const sourceState = () => JSON.stringify({
    deviceId: FOREIGN,
    'resume:v-1': { modifiedAt: '2026-08-09T00:00:00.000Z' },
    'key:resume-designer-applications': { modifiedAt: '2026-08-10T00:00:00.000Z' },
  });
  const storedState = () => JSON.parse(localStorage.getItem(SYNC_STATE));

  // FIRST in this file to touch the store, deliberately: `deviceOrigin` memoises
  // for the process, so a later test could not observe the mint. The
  // `typeof … === 'string'` assertion is what makes a future reordering fail
  // loudly instead of passing vacuously.
  it('format 1: mints a different id than the backup carried, and keeps the stamps', async () => {
    const { store } = await import('../src/store.js');

    importFullBackupFromEnvelope({ backupFormat: 1, keys: { [SYNC_STATE]: sourceState() } });

    // The import itself carries the foreign id nowhere.
    expect(storedState().deviceId).toBeUndefined();

    // Anything that records a step asks store.js for this device's origin, and
    // that is the one thing that writes the field.
    store.setData({}, true);

    const after = storedState();
    expect(typeof after.deviceId).toBe('string');
    expect(after.deviceId.length).toBeGreaterThan(0);
    expect(after.deviceId).not.toBe(FOREIGN);
    // The rest of the key is per-profile data the backup is right to carry, and
    // it survives both the import and the mint.
    expect(after['resume:v-1']).toEqual({ modifiedAt: '2026-08-09T00:00:00.000Z' });
    expect(after['key:resume-designer-applications'])
      .toEqual({ modifiedAt: '2026-08-10T00:00:00.000Z' });
  });

  it('format 2: drops it per profile, and keeps that profile’s stamps', () => {
    importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'pa', name: 'A' }, { id: 'pb', name: 'B' }],
      activeProfile: 'pa',
      shared: {},
      profiles: {
        pa: { keys: { [SYNC_STATE]: sourceState() } },
        pb: { keys: { [SYNC_STATE]: sourceState() } },
      },
    });

    for (const pid of ['pa', 'pb']) {
      const stored = JSON.parse(localStorage.getItem(`resume-p--${pid}--${SYNC_STATE}`));
      expect(stored.deviceId).toBeUndefined();
      expect(stored['resume:v-1']).toEqual({ modifiedAt: '2026-08-09T00:00:00.000Z' });
    }
  });

  it('merge: drops it when the incoming key lands in a gap', () => {
    // The merge path writes an incoming owned key verbatim whenever this device
    // has none — the one branch that does not go through the replace paths'
    // normalizer.
    importFullBackupMerge({ backupFormat: 1, keys: { [SYNC_STATE]: sourceState() } });

    const stored = storedState();
    expect(stored.deviceId).toBeUndefined();
    expect(stored['resume:v-1']).toEqual({ modifiedAt: '2026-08-09T00:00:00.000Z' });
  });

  it('leaves an unparseable sync-state value alone rather than dropping it', () => {
    // Still the user's data, and not a value this app could have read an id out
    // of — the same rule withoutStoredCredentials follows for a blob that will
    // not parse.
    importFullBackupFromEnvelope({ backupFormat: 1, keys: { [SYNC_STATE]: '{ not json' } });
    expect(localStorage.getItem(SYNC_STATE)).toBe('{ not json');
  });
});

describe('a replacement restore deletes what it omits, and says so', () => {
  // A restore that replaces a synced workspace is a DELETION for anything it
  // leaves out — but it writes a new blob and a new registry rather than going
  // through `deleteVariant`/`deleteProfile`, so nothing produced the tombstone
  // that makes a deletion travel. Absence alone reads as "keep the local copy"
  // on every other device, and the next fetch hands the removed thing back.
  const DATA = 'resume-designer-data';

  it('tombstones a résumé the backup leaves out', () => {
    localStorage.setItem('resume-designer-profiles', JSON.stringify([
      { id: 'pmine', name: 'Ash', emoji: '🙂', createdAt: 'x' },
    ]));
    localStorage.setItem('resume-designer-active-profile', 'pmine');
    localStorage.setItem(`resume-p--pmine--${DATA}`, JSON.stringify({
      variants: { keep: { id: 'keep', name: 'Kept' }, gone: { id: 'gone', name: 'Dropped' } },
    }));

    importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'pmine', name: 'Ash', emoji: '🙂' }],
      activeProfile: 'pmine',
      shared: {},
      profiles: { pmine: { keys: { [DATA]: JSON.stringify({ variants: { keep: { id: 'keep', name: 'Kept' } } }) } } },
    });

    const blob = JSON.parse(localStorage.getItem(`resume-p--pmine--${DATA}`));
    expect(blob.variants.keep.name).toBe('Kept');
    expect(blob.variants.gone.deletedAt).toEqual(expect.any(String));
    expect(blob.variants.gone.data).toBeUndefined();
  });

  it('tombstones a workspace the backup leaves out', () => {
    localStorage.setItem('resume-designer-profiles', JSON.stringify([
      { id: 'pmine', name: 'Ash', emoji: '🙂', createdAt: 'x' },
      { id: 'pgone', name: 'Old', emoji: '🙂', createdAt: 'x' },
    ]));
    localStorage.setItem('resume-designer-active-profile', 'pmine');

    importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'pmine', name: 'Ash', emoji: '🙂' }],
      activeProfile: 'pmine',
      shared: {},
      profiles: {},
    });

    const registry = JSON.parse(localStorage.getItem('resume-designer-profiles'));
    expect(registry.find((p) => p.id === 'pmine').deletedAt).toBeUndefined();
    // Present and tombstoned, not merely absent: `mergeRegistry` is a union, so
    // an absent entry is "keep the local one" on every other device.
    expect(registry.find((p) => p.id === 'pgone').deletedAt).toEqual(expect.any(String));
  });
});
