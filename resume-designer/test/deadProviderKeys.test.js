import { describe, it, expect, beforeEach, vi } from 'vitest';
import { withoutDeadProviderCredentials } from '../src/profileKeys.js';
import { appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping } from '../src/appStorage.js';
import { stripDeadProviderCredentials, exportProfileBackup } from '../src/profiles.js';
import {
  importFullBackupFromEnvelope, importFullBackupMerge, exportFullBackup,
} from '../src/persistence.js';

// The Electron app stored `anthropicKey` / `openaiKey` / `geminiKey`. The app
// moved to OpenRouter on 2026-05-30 (7a9e6d6), five days AFTER `electron/` was
// deleted (535b24c, 2026-05-25) — so those three fields are dead in the current
// codebase (grepping the tree for them matches comments only) while still
// present in any Electron LevelDB on disk. The migration imported the blob
// verbatim, so they landed in clear text under app_data_dir and stayed there:
// the same exposure class as CodeQL alert 32, which the keychain work closed
// for the OpenRouter key alone.

beforeEach(() => {
  __resetAppStorageForTests();
  localStorage.clear();
});

const BLOB = 'resume-designer-data';

describe('withoutDeadProviderCredentials', () => {
  it('removes all three and leaves everything else alone', () => {
    const value = JSON.stringify({
      variants: { v1: {} },
      settings: {
        anthropicKey: 'sk-ant', openaiKey: 'sk-oai', geminiKey: 'sk-gem',
        theme: 'dark', openrouterKey: 'sk-or',
      },
    });

    const parsed = JSON.parse(withoutDeadProviderCredentials(BLOB, value));

    expect(parsed.settings.anthropicKey).toBeUndefined();
    expect(parsed.settings.openaiKey).toBeUndefined();
    expect(parsed.settings.geminiKey).toBeUndefined();
    // NOT the OpenRouter key — that one the current app still uses, and it has
    // its own rules about when it may be stripped.
    expect(parsed.settings.openrouterKey).toBe('sk-or');
    expect(parsed.settings.theme).toBe('dark');
    expect(parsed.variants).toEqual({ v1: {} });
  });

  it('removes whichever subset is present', () => {
    const parsed = JSON.parse(withoutDeadProviderCredentials(BLOB, JSON.stringify({
      settings: { openaiKey: 'sk-oai', theme: 'light' },
    })));
    expect(parsed.settings.openaiKey).toBeUndefined();
    expect(parsed.settings.theme).toBe('light');
  });

  // Byte-identical return when there is nothing to do, so callers can use
  // `cleaned === raw` to skip a pointless storage write.
  it('returns the value UNTOUCHED when there is nothing to strip', () => {
    const clean = JSON.stringify({ settings: { theme: 'dark' } });
    expect(withoutDeadProviderCredentials(BLOB, clean)).toBe(clean);
    expect(withoutDeadProviderCredentials(BLOB, 'not json')).toBe('not json');
    expect(withoutDeadProviderCredentials('some-other-key', clean)).toBe(clean);
    expect(withoutDeadProviderCredentials(BLOB, null)).toBe(null);
  });

  // `in` throws on a string operand, and this runs over the user's live data
  // during boot — a throw here would take down the rest of init.
  it('survives a non-object settings blob', () => {
    for (const settings of ['nope', 42, true, []]) {
      const value = JSON.stringify({ settings });
      expect(() => withoutDeadProviderCredentials(BLOB, value)).not.toThrow();
      expect(withoutDeadProviderCredentials(BLOB, value)).toBe(value);
    }
  });
});

describe('import boundary', () => {
  const envelope = () => ({
    backupFormat: 1,
    keys: {
      [BLOB]: JSON.stringify({
        variants: {},
        settings: { anthropicKey: 'sk-ant', openrouterKey: 'sk-or', theme: 'dark' },
      }),
    },
  });

  // THE TRAP. `keepCredential` exempts the same-machine Electron migration from
  // the OpenRouter strip, because the current app still uses that key. Folding
  // the dead providers into the same helper would have meant the ONE path that
  // actually carries them was the one path that skipped removing them.
  it('strips them even when keepCredential exempts the OpenRouter key', () => {
    importFullBackupFromEnvelope(envelope(), { keepCredential: true });

    const parsed = JSON.parse(localStorage.getItem(BLOB));
    expect(parsed.settings.anthropicKey).toBeUndefined();
    // ...while the credential the migration exists to carry is still carried.
    expect(parsed.settings.openrouterKey).toBe('sk-or');
  });

  it('strips them on an ordinary backup restore too', () => {
    importFullBackupFromEnvelope(envelope());
    expect(localStorage.getItem(BLOB)).not.toContain('sk-ant');
  });

  it('strips them on the merge path, exempt or not', () => {
    importFullBackupMerge(envelope(), { keepCredential: true });
    expect(localStorage.getItem(BLOB)).not.toContain('sk-ant');

    localStorage.clear();
    importFullBackupMerge(envelope());
    expect(localStorage.getItem(BLOB)).not.toContain('sk-ant');
  });
});

// The boundary I covered on the way IN and not on the way OUT. A blob the boot
// sweep could not clean — quota, or a profile imported after boot — was
// serialised straight into clear-text backup JSON.
describe('export boundary', () => {
  const dirty = JSON.stringify({
    variants: { v1: {} },
    settings: { anthropicKey: 'sk-ant', geminiKey: 'sk-gem', theme: 'dark' },
  });

  // exportFullBackup RETURNS a summary and downloads the envelope, so asserting
  // on its return value is vacuous — my first version of this did exactly that
  // and passed against unstripped code. Capture the Blob, as profileBackup does.
  function captureDownload() {
    const blobs = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (b) => { blobs.push(b); return 'blob:x'; },
      revokeObjectURL: () => {},
    });
    return async () => blobs[0].text();
  }

  const seed = () => {
    localStorage.setItem('resume-designer-profiles', JSON.stringify([
      { id: 'pmine', name: 'Ash', emoji: '🙂', createdAt: 'x' },
    ]));
    localStorage.setItem('resume-designer-active-profile', 'pmine');
    localStorage.setItem('resume-p--pmine--resume-designer-data', dirty);
  };

  it('keeps a deleted workspace out, but never the one still on screen', async () => {
    // Two halves, and getting the second wrong is worse than not filtering.
    // A tombstoned workspace's bytes must not travel — restored, the workspace
    // the person deleted is simply back. But the ACTIVE one is exempt, because
    // `purgeTombstonedProfiles` deliberately leaves it full: it is still mapped
    // and still holding what is on screen.
    //
    // The path that makes this bite: when the switch away from a remotely
    // deleted workspace fails — a failed disk write — the app STAYS on it, and
    // its own response to a failed disk write is a toast telling the person to
    // export a backup. Filtering the active one dropped everything they were
    // looking at, reported success, and a restore of that file then replaced
    // the local copy with an empty workspace.
    localStorage.setItem('resume-designer-profiles', JSON.stringify([
      { id: 'pmine', name: 'Ash', emoji: '🙂', createdAt: 'x', deletedAt: '2026-08-18T00:00:00.000Z' },
      { id: 'pgone', name: 'Old', emoji: '🙂', createdAt: 'x', deletedAt: '2026-08-18T00:00:00.000Z' },
    ]));
    localStorage.setItem('resume-designer-active-profile', 'pmine');
    localStorage.setItem('resume-p--pmine--resume-designer-data', JSON.stringify({
      variants: { v1: { name: 'On screen right now' } },
    }));
    localStorage.setItem('resume-p--pgone--resume-designer-data', JSON.stringify({
      variants: { v9: { name: 'Deleted elsewhere' } },
    }));
    const readDownload = captureDownload();

    exportFullBackup();
    const json = await readDownload();

    expect(json).toContain('On screen right now');
    expect(json).not.toContain('Deleted elsewhere');
  });

  it('keeps them out of a whole-app backup', async () => {
    seed();
    const readDownload = captureDownload();

    exportFullBackup();
    const json = await readDownload();

    expect(json).not.toContain('sk-ant');
    expect(json).not.toContain('sk-gem');
    // Proof the blob really is in there — otherwise the assertions above hold
    // for the wrong reason.
    expect(json).toContain('dark');
  });

  it('keeps them out of a per-profile export', async () => {
    seed();
    const readDownload = captureDownload();

    // Returns a PROMISE — it pulls downloadFile through a dynamic import to
    // keep the module graph acyclic, so the blob does not exist until it settles.
    await exportProfileBackup('pmine');
    const json = await readDownload();

    expect(json).not.toContain('sk-ant');
    expect(json).not.toContain('sk-gem');
    expect(json).toContain('dark');
  });
});

// Sanitising on import only helps FUTURE migrations. The Electron import has
// shipped since 2026-05-27, so anyone who already took it is carrying these
// three in clear text right now — and nothing will ever visit them, precisely
// because nothing reads them.
describe('stripDeadProviderCredentials (boot sweep)', () => {
  function makeBackend(initial = {}) {
    const files = new Map(Object.entries(initial));
    return {
      files,
      loadAll: vi.fn(async () => Object.fromEntries(files)),
      write: vi.fn(async (k, v) => { files.set(k, v); }),
      delete: vi.fn(async (k) => { files.delete(k); }),
      clear: vi.fn(async () => { files.clear(); }),
    };
  }

  it('cleans EVERY profile blob, not just the active one', async () => {
    const backend = makeBackend({
      'resume-p--pactive--resume-designer-data': JSON.stringify({
        settings: { anthropicKey: 'sk-ant-a', theme: 'dark' },
      }),
      'resume-p--pother--resume-designer-data': JSON.stringify({
        settings: { geminiKey: 'sk-gem-b', theme: 'light' },
      }),
    });
    await initAppStorage({ backend });
    setProfileMapping('pactive');

    stripDeadProviderCredentials();
    await appStorage.flush();

    expect(JSON.stringify([...backend.files.values()])).not.toContain('sk-ant-a');
    expect(JSON.stringify([...backend.files.values()])).not.toContain('sk-gem-b');
    // The rest of each blob survives.
    expect(JSON.parse(backend.files.get('resume-p--pactive--resume-designer-data'))
      .settings.theme).toBe('dark');
    expect(JSON.parse(backend.files.get('resume-p--pother--resume-designer-data'))
      .settings.theme).toBe('light');
  });

  it('is a no-op on clean blobs, so it costs nothing every boot', async () => {
    const clean = JSON.stringify({ settings: { theme: 'dark' } });
    const backend = makeBackend({ 'resume-designer-data': clean });
    await initAppStorage({ backend });
    backend.write.mockClear();

    stripDeadProviderCredentials();
    await appStorage.flush();

    expect(backend.write).not.toHaveBeenCalled();
  });

  // Best-effort by design: this is a DELETION of data nothing depends on, so
  // there is no "strip only once the new copy is durable" rule to obey, and a
  // refusal must not take down boot.
  it('survives storage refusing a rewrite, and leaves the rest cleaned', async () => {
    localStorage.setItem('resume-p--pbad--resume-designer-data', JSON.stringify({
      settings: { anthropicKey: 'sk-bad' },
    }));
    localStorage.setItem('resume-p--pgood--resume-designer-data', JSON.stringify({
      settings: { anthropicKey: 'sk-good' },
    }));
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function set(k, v) {
      if (k === 'resume-p--pbad--resume-designer-data') throw new Error('QuotaExceededError');
      return realSetItem.call(this, k, v);
    });

    try {
      expect(() => stripDeadProviderCredentials()).not.toThrow();
      // The one that could be written IS written — one bad blob does not stop
      // the sweep.
      expect(localStorage.getItem('resume-p--pgood--resume-designer-data'))
        .not.toContain('sk-good');
      // ...and the refused one is left for the next boot to retry.
      expect(localStorage.getItem('resume-p--pbad--resume-designer-data'))
        .toContain('sk-bad');
    } finally {
      spy.mockRestore();
    }
  });
});
