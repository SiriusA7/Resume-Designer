import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mapKey, BACKUP_HISTORY_PREFIX } from '../src/profileKeys.js';
// The history bound, from the leaf that owns it. store.js and syncMerge.js both
// enforce it and neither may own it — see src/historyLimits.js.
import { MAX_HISTORY } from '../src/historyLimits.js';

// appStorage is the only dependency, and it is mocked so these tests stay
// pure: the real one is an async coalescing writer over a disk backend.
//
// The mock reproduces the real asymmetry deliberately, because it is what a
// naive implementation gets wrong: `keys()` returns PHYSICAL, profile-
// namespaced keys, while `getItem`/`setItem` take LOGICAL ones. A mock that
// returned logical keys from `keys()` would pass against code that never
// syncs anything.
//
// The mapping is the REAL `mapKey`, not a hand-rolled namespacer: it is the
// IDENTITY for shared keys (`resume-designer-profiles`,
// `resume-designer-active-profile`) and for anything the app does not own. A
// mock that namespaced every key never exercised the shared-key path — the one
// `collectUnits`' `?? physical` fallback exists for.
const PROFILE = 'ptest';
const disk = new Map();
let failDataWrites = false;
let failSyncStateWrites = false;
const physical = (k) => mapKey(PROFILE, k);
vi.mock('../src/appStorage.js', () => ({
  appStorage: {
    getItem: (k) => (disk.has(physical(k)) ? disk.get(physical(k)) : null),
    // `String(value)` mirrors the real setItem — the reason applyUnits has to
    // refuse a payload that is not a string (it would store "undefined").
    setItem: (k, v) => {
      if (failDataWrites && k === 'resume-designer-data') {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      if (failSyncStateWrites && k === 'resume-designer-sync-state') {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      disk.set(physical(k), String(v));
    },
    keys: () => [...disk.keys()],
    // This mock's `setItem` IS the disk — there is no write-behind cache in
    // front of it — so a flush here has nothing to wait for and is always
    // durable. The real facade's is neither, which is why the durability of an
    // apply is proven in syncDurableApply.test.js against the REAL appStorage
    // and a backend whose writes can fail. These tests are about what lands, not
    // about when it is safe to say so.
    flush: async () => true,
    // ALWAYS false, and there is no switch for it on purpose. A `true` from
    // here would only prove that applyUnits reads the flag it was handed; the
    // refusal that matters is that a landing during a restore writes NOTHING
    // and must not be confirmed anyway, and that is only visible against the
    // real appStorage — see syncDurableApply.test.js, which arms the real
    // guard with `beginRestoreGuard` and asserts the disk.
    isRestoreGuardActive: () => false,
  },
  // profiles.js imports this beside appStorage; syncModel reaches profiles.js
  // for getActiveProfileId. Never called here — the active profile is set by
  // seeding its key below, the same way the real app reads it.
  setProfileMapping: () => {},
}));

const {
  collectUnit, collectUnits, unitScopes, applyUnits, parkLoser, registerPersistedSaveHandler,
  registerEditingProbe, touchUnit, resolveConflict,
} = await import('../src/sync/syncModel.js');
// The résumé store, not the storage map above: parking into the LOADED
// variant's history has to go through it.
const { store: resumeStore } = await import('../src/store.js');
const {
  initPersistence, setPersistedSaveHandler, setSyncDirtyNotifier,
  getUserProfile, saveUserProfile,
} = await import('../src/persistence.js');
// The four modules that hold a whole synced key in memory. Imported after the
// mock like everything else here, so their own appStorage reads go through the
// same disk map.
const {
  initApplications, addApplication, getAllApplications,
  subscribeApplications, getApplicationsSnapshot,
} = await import('../src/applications.js');
const {
  initLearnedAnswers, saveLearnedAnswer, getAllLearnedAnswers,
} = await import('../src/learnedAnswers.js');
// The fifth holder, and the only one whose unit is a FIELD of the data blob
// rather than a key of its own: `data:userProfile`, held by ProfileDialog.
const { registerUserProfileHolder } = await import('../src/userProfileHolder.js');
const {
  initJobDescriptions, addJobDescription, getAllJobDescriptions, subscribeJobDescriptions,
} = await import('../src/jobDescriptions.js');
const {
  loadThreads, persistThreads, makeThread, registerThreadHolder,
} = await import('../src/chatThreads.js');
// Only the new registry-landing test below reaches this directly — every
// other test goes through the `disk` map above, which is the same mock.
const { appStorage } = await import('../src/appStorage.js');

const DATA = 'resume-designer-data';
const AT = '2026-08-09T00:00:00.000Z';

beforeEach(() => {
  disk.clear();
  failDataWrites = false;
  failSyncStateWrites = false;
  disk.set(physical('resume-designer-active-profile'), PROFILE);
  disk.set(physical(DATA), JSON.stringify({
    variants: { 'v-1': { name: 'Design Engineer' } },
    currentVariantId: 'v-1',
    settings: { pageSize: 'letter' },
  }));
  disk.set(physical('resume-designer-applications'), '[]');
  disk.set(physical('resume-zoom'), '1.5');
  // A SHARED key (never namespaced) that nonetheless syncs — see
  // SYNCED_SHARED_KEYS in syncKeys.js.
  disk.set(physical('resume-designer-profiles'), JSON.stringify([{ id: PROFILE, name: 'Personal' }]));
  // No inline editing session unless a test says so — the app registers a real
  // probe from main.js, and nothing else in this file has a DOM.
  registerEditingProbe(null);
  // Nobody holds the thread list unless a test says so — the app registers
  // useChat from ChatPanel, and this file mounts no React tree.
  registerThreadHolder(null);
  // Same for the profile working copy, whose holder is ProfileDialog.
  registerUserProfileHolder(null);
});

// A résumé unit's payload is the whole variant RECORD, exactly as splitData
// emits it — `{ id, name, data, ... }`, with the document one level in, under
// `data`. The store and version history both hold the DOCUMENT.
//
// The two shapes are deliberately told apart here, and every fixture below
// keeps them apart: the record's `name` is the RÉSUMÉ'S name (a label in the
// variant switcher) and the document's is the PERSON'S, so a fixture whose
// document is `{ name: '…' }` alone reads as valid whichever way it is
// interpreted — and a test built on one cannot see the difference between
// parking a record and parking the document inside it.
const variantRecord = (id, document, name = 'Tailored for Acme') => JSON.stringify({
  id, name, data: document, createdAt: AT, updatedAt: AT,
});
const resumeUnit = (id, document, modifiedAt = AT) => ({
  id: `resume:${id}`, kind: 'resume', payload: variantRecord(id, document), modifiedAt,
});

describe('collectUnits', () => {
  it('emits a unit per résumé and per synced key, and nothing device-local', () => {
    const ids = collectUnits().map((u) => u.id);
    expect(ids).toContain('resume:v-1');
    expect(ids).toContain('key:resume-designer-applications');
    // A shared key, stored unnamespaced: it reaches this list only through the
    // `?? physical` fallback for a key `splitPhysicalKey` cannot split.
    expect(ids).toContain('key:resume-designer-profiles');
    expect(ids).not.toContain('key:resume-zoom');
    expect(ids).not.toContain('key:resume-designer-active-profile');
    // The data blob never travels whole — it travels decomposed.
    expect(ids).not.toContain('key:resume-designer-data');
  });

  it('leaves an unstamped unit’s time unknown instead of claiming it changed now', () => {
    // A `new Date()` fallback made every unit this device collected newer than
    // any real remote stamp, so resolveConflict handed this device every
    // conflict and parked or discarded the other device's genuine edit — on a
    // timestamp it never earned. Nothing calls touchUnit yet, so that was every
    // unit. An unknown time has to LOSE to a real one.
    touchUnit('resume:v-1');
    const units = collectUnits();
    const stamped = units.find((u) => u.id === 'resume:v-1');
    const unstamped = units.find((u) => u.id === 'key:resume-designer-applications');

    expect(Number.isFinite(Date.parse(stamped.modifiedAt))).toBe(true);
    expect(unstamped.modifiedAt).toBe(null);
    // The remote edit is two years older and still wins, because it is the only
    // side that knows when it changed.
    const remote = { id: unstamped.id, modifiedAt: '2024-01-01T00:00:00.000Z' };
    expect(resolveConflict(unstamped, remote).winner).toBe(remote);
  });

  it('marks token usage with its own kind so the transport can merge it', () => {
    disk.set(physical('resume-designer-token-usage'), JSON.stringify({ events: [], summary: {} }));
    const unit = collectUnits().find((u) => u.id === 'key:resume-designer-token-usage');
    expect(unit.kind).toBe('tokenUsage');
  });

  it('never collects another profile’s key, which getItem would read as the active profile’s', () => {
    // appStorage's cache holds EVERY profile's physical keys. Reducing one to
    // its logical name with no profile check emits it as if it belonged to the
    // active profile, and reads its payload with getItem — which maps to the
    // ACTIVE profile. So the inactive profile's key is either emitted with the
    // wrong profile's value (a SECOND unit under the same id — below) or with
    // an empty one, which lands on another device as setItem(key, '') and wipes
    // the chat threads it names.
    disk.set('resume-p--pother--resume-designer-chat-threads', JSON.stringify([{ id: 't-1' }]));
    disk.set(physical('resume-designer-job-descriptions'), JSON.stringify(['mine']));
    disk.set('resume-p--pother--resume-designer-job-descriptions', JSON.stringify(['theirs']));

    const units = collectUnits();
    const ids = units.map((u) => u.id);
    expect(ids).not.toContain('key:resume-designer-chat-threads');
    expect(ids.filter((id) => id === 'key:resume-designer-job-descriptions')).toHaveLength(1);
    expect(units.find((u) => u.id === 'key:resume-designer-job-descriptions').payload)
      .toBe(JSON.stringify(['mine']));
    for (const unit of units) expect(unit.payload, unit.id).not.toBe('');
  });

  it('skips a synced key getItem cannot read, rather than emitting an empty payload', () => {
    // An unprefixed owned key — pre-adoption residue — is in keys() but reads
    // back as null through getItem, which maps to the active profile. `?? ''`
    // turned that into a unit whose payload CLEARS the key on every other
    // device, and an empty history payload makes store.js's loadHistory throw
    // on JSON.parse('') and reset that variant's history.
    disk.set('resume-designer-chat-threads', JSON.stringify([{ id: 't-1' }]));
    expect(collectUnits().map((u) => u.id)).not.toContain('key:resume-designer-chat-threads');
  });
});

describe('collectUnit', () => {
  it('returns the same stamped résumé unit as a full collection', () => {
    touchUnit('resume:v-1');

    expect(collectUnit('resume:v-1'))
      .toEqual(collectUnits().find((unit) => unit.id === 'resume:v-1'));
  });

  it('returns the same stamped key unit as a full collection', () => {
    touchUnit('key:resume-designer-applications');

    expect(collectUnit('key:resume-designer-applications'))
      .toEqual(collectUnits().find((unit) => unit.id === 'key:resume-designer-applications'));
  });

  it('refuses a device-local key', () => {
    expect(collectUnit('key:resume-zoom')).toBe(null);
  });

  it('returns null for an id no unit matches', () => {
    expect(collectUnit('unknown:v-1')).toBe(null);
  });

  it('returns null for a synced key absent from storage', () => {
    expect(collectUnit('key:resume-designer-chat-threads')).toBe(null);
  });

  it('deep-equals individual lookup for every unit in a full collection', () => {
    for (const unit of collectUnits()) {
      expect(collectUnit(unit.id), unit.id).toEqual(unit);
    }
  });
});

describe('applyUnits', () => {
  it('lands a remote résumé without touching the local currentVariantId', async () => {
    await applyUnits([resumeUnit('v-2', { name: 'Ada Lovelace', summary: 'Product Lead' })]);
    const blob = JSON.parse(disk.get(physical(DATA)));
    expect(Object.keys(blob.variants).sort()).toEqual(['v-1', 'v-2']);
    // The whole RECORD lands, document and all — mergeData reassembles exactly
    // what splitData took apart.
    expect(blob.variants['v-2'].data).toEqual({ name: 'Ada Lovelace', summary: 'Product Lead' });
    expect(blob.currentVariantId).toBe('v-1');
  });

  it('merges token usage instead of replacing it', async () => {
    disk.set(physical('resume-designer-token-usage'), JSON.stringify({
      events: [{ id: 'mine', timestamp: '2026-08-01T00:00:00.000Z', inputTokens: 1 }],
      summary: {},
    }));
    await applyUnits([{
      id: 'key:resume-designer-token-usage', kind: 'tokenUsage',
      payload: JSON.stringify({
        events: [{ id: 'theirs', timestamp: '2026-08-02T00:00:00.000Z', inputTokens: 2 }],
        summary: {},
      }),
      modifiedAt: AT,
    }]);
    const merged = JSON.parse(disk.get(physical('resume-designer-token-usage')));
    expect(merged.events.map((e) => e.id)).toEqual(['mine', 'theirs']);
    expect(merged.summary.totalInputTokens).toBe(3);
  });

  it('refuses a unit for a key that is device-local', async () => {
    const before = disk.get(physical('resume-zoom'));
    await applyUnits([{ id: 'key:resume-zoom', kind: 'plain', payload: '"2"', modifiedAt: AT }]);
    expect(disk.get(physical('resume-zoom'))).toBe(before);
  });

  it('refuses every device-local key, including the stored credential and this device’s sync bookkeeping', async () => {
    // A device-local key never leaves a machine, so one arriving is a bug on
    // the other end or an attack on this one. Honouring it would let a remote
    // unit overwrite the OpenRouter credential, or rewrite the sync state this
    // device uses to decide what it has already sent.
    for (const key of ['resume-designer-openrouter-key', 'resume-designer-sync-state', 'resume-designer-theme']) {
      const { applied } = await applyUnits([{ id: `key:${key}`, kind: 'plain', payload: '"stolen"', modifiedAt: AT }]);
      expect(applied, key).toBe(0);
      expect(disk.has(physical(key)), key).toBe(false);
    }
  });

  it('unions a version-history unit into local history instead of overwriting the loser parked in it', async () => {
    // Version history syncs precisely so a conflict's losing edit is not
    // stranded on the device that received it (syncKeys.js) — and it is
    // append-shaped, so a whole-key setItem here destroyed exactly that: the
    // loser parkLoser had just written, gone the moment the other device's
    // history landed.
    disk.set(physical('resume-designer-history-v-9'), JSON.stringify({
      history: [{ data: { name: 'The version that lost' }, timestamp: '2026-08-09T00:00:00.000Z', description: 'Conflicting edit synced from another device', changeType: 'sync-conflict' }],
      historyIndex: 0,
    }));
    const payload = JSON.stringify({
      history: [{ data: { name: 'Edited on the iPhone' }, timestamp: '2026-08-08T00:00:00.000Z', description: 'Edit', changeType: 'edit' }],
      historyIndex: 0,
    });
    expect((await applyUnits([{ id: 'key:resume-designer-history-v-9', kind: 'plain', payload, modifiedAt: AT }])).applied).toBe(1);

    const stored = JSON.parse(disk.get(physical('resume-designer-history-v-9')));
    expect(stored.history.map((e) => e.changeType)).toEqual(['edit', 'sync-conflict']);
    expect(stored.historyIndex).toBe(1);
  });

  it('lands a history unit for the LOADED variant through the store, so the next edit does not undo the merge', async () => {
    // store.js holds the loaded variant's history in memory and saveHistory
    // rewrites the whole key from that array — which never saw a merge written
    // straight to storage. So a storage-only merge survives exactly until the
    // next keystroke, which is the same trap parkLoser documents.
    resumeStore.setData({ name: 'Loaded' }, true, 'v-loaded');
    await applyUnits([{
      id: 'key:resume-designer-history-v-loaded',
      kind: 'plain',
      payload: JSON.stringify({
        history: [{ data: { name: 'From the other device' }, timestamp: '2026-08-08T00:00:00.000Z', description: 'Edit on iPhone', changeType: 'edit' }],
        historyIndex: 0,
      }),
      modifiedAt: AT,
    }]);

    resumeStore.update('name', 'Edited after the sync');

    const stored = JSON.parse(disk.get(physical('resume-designer-history-v-loaded')));
    expect(stored.history.map((e) => e.description)).toContain('Edit on iPhone');
    // The merge archives; it does not restore. The document is still the local
    // one, and the redo future is empty so the edit above spliced nothing away.
    expect(resumeStore.getData().name).toBe('Edited after the sync');
    expect(stored.historyIndex).toBe(stored.history.length - 1);
  });

  it('leaves the index on the document’s own entry after a history merge, so one Cmd+Z is still the user’s own last state', async () => {
    // The union interleaves by timestamp, so the newest merged entry is
    // routinely the other device's — or a loser IT parked. Taking mergeHistory's
    // index (the newest entry) therefore pointed historyIndex at an entry the
    // document had never been on, breaking the invariant every method here
    // assumes: history[historyIndex].data IS data.
    resumeStore.setData({ name: 'Mine1' }, true, 'v-merge');
    resumeStore.update('name', 'Mine2');

    // Dated ahead of the entries the store just stamped with `new Date()`, so
    // the union sorts it LAST — the position that used to take the index.
    await applyUnits([{
      id: 'key:resume-designer-history-v-merge',
      kind: 'plain',
      payload: JSON.stringify({
        history: [{
          data: { name: 'Their rejected version' },
          timestamp: '2126-08-08T00:00:00.000Z',
          description: 'Conflicting edit synced from another device',
          changeType: 'sync-conflict',
        }],
        historyIndex: 0,
      }),
      modifiedAt: AT,
    }]);

    const current = resumeStore.getHistoryEntries().find((e) => e.isCurrent);
    expect(current.changeType).not.toBe('sync-conflict');
    expect(resumeStore.getHistoryEntryData(current.index)).toEqual(resumeStore.getData());
    // Nothing sits after the index, so the next edit splices nothing away.
    expect(resumeStore.canRedo()).toBe(false);

    // One Cmd+Z is the user's own previous state, not the version another
    // device rejected.
    expect(resumeStore.undo()).toBe(true);
    expect(resumeStore.getData().name).toBe('Mine1');

    // And the merged entry survived the trip, redo included.
    expect(resumeStore.redo()).toBe(true);
    expect(resumeStore.getData().name).toBe('Mine2');
    resumeStore.update('name', 'Mine3');
    const stored = JSON.parse(disk.get(physical('resume-designer-history-v-merge')));
    expect(stored.history.filter((e) => e.changeType === 'sync-conflict')).toHaveLength(1);
  });

  it('keeps one Cmd+Z on this user’s own last state when the merge brings in another device’s edits', async () => {
    // The union puts states in the timeline that this user was never in. Edit
    // on the phone, open the Mac, press Cmd+Z, and undo handed back the
    // phone's document rather than the user's own last state — nothing lost,
    // but it reads as loss. The undo timeline is a record of steps taken HERE,
    // so the traversal steps over an entry another device wrote, exactly as it
    // already steps over a parked loser.
    resumeStore.setData({ name: 'Mine1' }, true, 'v-foreign');
    resumeStore.update('name', 'Mine2');

    await applyUnits([{
      id: 'key:resume-designer-history-v-foreign',
      kind: 'plain',
      // Dated ahead of the entries the store just stamped, so the union sorts
      // it into the slot one Cmd+Z lands on. An ORDINARY edit, not a park:
      // nothing about it is a conflict, it simply happened on another device.
      payload: JSON.stringify({
        history: [{
          data: { name: 'Edited on the iPhone' },
          timestamp: '2126-08-08T00:00:00.000Z',
          description: 'Edit',
          changeType: 'edit',
          origin: 'device-iphone',
        }],
        historyIndex: 0,
      }),
      modifiedAt: AT,
    }]);

    expect(resumeStore.undo()).toBe(true);
    expect(resumeStore.getData().name).toBe('Mine1');
    expect(resumeStore.canUndo()).toBe(false);
    // Redo steps over it too, on the way back up.
    expect(resumeStore.redo()).toBe(true);
    expect(resumeStore.getData().name).toBe('Mine2');
    expect(resumeStore.canRedo()).toBe(false);

    // Skipped by the traversal, NOT hidden: the dialog still lists the phone's
    // version and can still restore it.
    const listed = resumeStore.getHistoryEntries();
    const theirs = listed.find((e) => resumeStore.getHistoryEntryData(e.index).name === 'Edited on the iPhone');
    expect(theirs).toBeTruthy();
    expect(resumeStore.restoreToEntry(theirs.index)).toBe(true);
    expect(resumeStore.getData().name).toBe('Edited on the iPhone');
  });

  it('opens a variant whose history was merged while it was closed without marking the remote entry current', async () => {
    // The loaded variant's index is fixed by the store (adoptHistory). The COLD
    // variant's is not: this path writes mergeHistory's own index, the NEWEST
    // entry, which the union routinely takes from the other device. Nothing
    // there is a park, so setData's guard — which asked only about parks —
    // passed it: the dialog marked the remote entry current, the store-wide
    // invariant history[historyIndex].data === data was broken, and one edit
    // plus one Cmd+Z put the remote version on screen.
    disk.set(physical('resume-designer-history-v-closed'), JSON.stringify({
      history: [{ data: { name: 'Mine' }, timestamp: '2026-08-01T00:00:00.000Z', description: 'Edit', changeType: 'edit' }],
      historyIndex: 0,
    }));
    await applyUnits([{
      id: 'key:resume-designer-history-v-closed',
      kind: 'plain',
      payload: JSON.stringify({
        history: [{
          data: { name: 'Theirs' },
          timestamp: '2026-08-02T00:00:00.000Z',
          description: 'Edit',
          changeType: 'edit',
          origin: 'device-iphone',
        }],
        historyIndex: 0,
      }),
      modifiedAt: AT,
    }]);
    // The merged key really does call the remote entry current — the state the
    // store then has to open safely.
    const merged = JSON.parse(disk.get(physical('resume-designer-history-v-closed')));
    expect(merged.history[merged.historyIndex].data).toEqual({ name: 'Theirs' });

    resumeStore.setData({ name: 'Mine' }, true, 'v-closed');

    const current = resumeStore.getHistoryEntries().find((e) => e.isCurrent);
    expect(resumeStore.getHistoryEntryData(current.index)).toEqual(resumeStore.getData());
    expect(resumeStore.canRedo()).toBe(false);

    resumeStore.update('name', 'Edited after opening');
    expect(resumeStore.undo()).toBe(true);
    expect(resumeStore.getData().name).toBe('Mine');
    // And the merge survived being opened: the remote entry is still there to
    // restore from the dialog.
    const listed = resumeStore.getHistoryEntries();
    expect(listed.some((e) => resumeStore.getHistoryEntryData(e.index).name === 'Theirs')).toBe(true);
  });

  it('lands the blob’s settings and userProfile units, which used to be dropped in silence', async () => {
    // splitData emits them and mergeData reassembles them, but applyUnits
    // matched only `resume:` and `key:` — so settings and the user profile
    // synced OUT of a device and never back into it.
    const { applied } = await applyUnits([
      { id: 'data:settings', kind: 'plain', payload: JSON.stringify({ pageSize: 'a4' }), modifiedAt: AT },
      { id: 'data:userProfile', kind: 'plain', payload: JSON.stringify({ name: 'Ash' }), modifiedAt: AT },
    ]);

    expect(applied).toBe(2);
    const blob = JSON.parse(disk.get(physical(DATA)));
    expect(blob.settings).toEqual({ pageSize: 'a4' });
    expect(blob.userProfile).toEqual({ name: 'Ash' });
    // Reassembly leaves the rest of the blob alone, device-local field included.
    expect(blob.currentVariantId).toBe('v-1');
    expect(Object.keys(blob.variants)).toEqual(['v-1']);
  });

  it('refuses a data unit whose payload is null, rather than blanking settings and calling it applied', async () => {
    // `'null'` parses fine, so it cleared the whole `settings` object off one
    // malformed remote unit AND counted as landed — the count being the only
    // thing that tells a caller a no-op from a failure.
    const { applied } = await applyUnits([
      { id: 'data:settings', kind: 'plain', payload: 'null', modifiedAt: AT },
      { id: 'data:userProfile', kind: 'plain', payload: 'null', modifiedAt: AT },
    ]);
    expect(applied).toBe(0);
    const blob = JSON.parse(disk.get(physical(DATA)));
    expect(blob.settings).toEqual({ pageSize: 'letter' });
    expect('userProfile' in blob).toBe(false);
  });

  // `'null'` above is the corruption that is actually reachable (String(null)).
  // These are the rest of the shapes the same predicate let through, and the
  // reason it now asks for an OBJECT rather than merely not-null.
  describe('a data unit whose payload is not an object', () => {
    const ORIGINAL = { contactInfo: { fullName: 'Ada Lovelace' }, workExperience: [] };

    beforeEach(() => {
      disk.set(physical(DATA), JSON.stringify({
        variants: { 'v-1': { name: 'Design Engineer' } },
        currentVariantId: 'v-1',
        settings: { pageSize: 'letter' },
        userProfile: ORIGINAL,
      }));
    });

    // Asserting the DISK is the whole point. The previous instance of this bug
    // was masked by tests that asserted MEMORY: the holder refused the payload
    // and kept the good copy, while the bad bytes sat on the key until the next
    // boot read them. Every assertion below reads the stored blob back.
    const storedBlob = () => JSON.parse(disk.get(physical(DATA)));

    for (const payload of ['[]', '5', '"x"', 'true', '[{"company":"Acme"}]']) {
      it(`refuses \`${payload}\` for the user profile, on disk and after a restart`, async () => {
        const { applied } = await applyUnits([
          { id: 'data:userProfile', kind: 'plain', payload, modifiedAt: AT },
        ]);

        // Refused, so the transport forfeits the change tag and re-offers it —
        // the same terms as every other refusal here.
        expect(applied).toBe(0);
        expect(storedBlob().userProfile).toEqual(ORIGINAL);

        // The restart. `getUserProfile` re-reads the key from storage on every
        // call, so this is exactly what the app does after a relaunch — and it
        // is where the damage used to happen: the truthy garbage came back,
        // completeProfile normalised it to a defaults-shaped EMPTY profile, and
        // the next debounced save persisted that and pushed it up.
        expect(getUserProfile()).toEqual(ORIGINAL);
      });

      it(`refuses \`${payload}\` for settings, which would spread to defaults`, async () => {
        // The lower-stakes twin: `{ ...[], ...rest }` in saveSettings degrades
        // every stored preference to its default.
        const { applied } = await applyUnits([
          { id: 'data:settings', kind: 'plain', payload, modifiedAt: AT },
        ]);

        expect(applied).toBe(0);
        expect(storedBlob().settings).toEqual({ pageSize: 'letter' });
      });
    }

    it('still lands a legitimate object, including an explicitly emptied one', async () => {
      // An empty OBJECT is a value someone wrote — a profile they cleared — not
      // an absence, and it has to land exactly like any other edit.
      const { applied } = await applyUnits([
        { id: 'data:userProfile', kind: 'plain', payload: '{}', modifiedAt: AT },
        { id: 'data:settings', kind: 'plain', payload: '{"pageSize":"a4"}', modifiedAt: AT },
      ]);

      expect(applied).toBe(2);
      expect(storedBlob().userProfile).toEqual({});
      expect(storedBlob().settings).toEqual({ pageSize: 'a4' });
    });
  });

  it('refuses a data unit for a field that never travels, and does not count it', async () => {
    // `currentVariantId` is absent from splitData's list on purpose: which
    // résumé is open is a property of a device. mergeData refuses it, so the
    // count here has to refuse it too rather than report a phantom apply.
    const { applied } = await applyUnits([{ id: 'data:currentVariantId', kind: 'plain', payload: '"v-2"', modifiedAt: AT }]);
    expect(applied).toBe(0);
    expect(JSON.parse(disk.get(physical(DATA))).currentVariantId).toBe('v-1');
  });

  it('lands the units around a corrupt payload, and counts only the ones that landed', async () => {
    // mergeData skips an unparseable payload so one bad record cannot stop the
    // rest of a sync (syncUnits.js). Counting it anyway reported 3 applied when
    // 2 landed — and `applied` is the only thing that tells a caller a no-op
    // from a failure.
    const { applied } = await applyUnits([
      resumeUnit('v-2', { name: 'Ada Lovelace', summary: 'Product Lead' }),
      { id: 'resume:v-3', kind: 'resume', payload: '{ not json', modifiedAt: AT },
      { id: 'key:resume-designer-applications', kind: 'plain', payload: '[{"id":"a-1"}]', modifiedAt: AT },
    ]);
    expect(applied).toBe(2);
    const blob = JSON.parse(disk.get(physical(DATA)));
    expect(Object.keys(blob.variants).sort()).toEqual(['v-1', 'v-2']);
    expect(disk.get(physical('resume-designer-applications'))).toBe('[{"id":"a-1"}]');
  });

  it('refuses a malformed unit rather than writing the text “undefined” into a real key', async () => {
    // appStorage.setItem does String(value), so a unit that crossed the native
    // bridge without a payload would store the literal string "undefined" —
    // data that looks written and parses nowhere.
    const before = disk.get(physical('resume-designer-applications'));
    const { applied } = await applyUnits([{ id: 'key:resume-designer-applications', kind: 'plain', modifiedAt: AT }]);
    expect(applied).toBe(0);
    expect(disk.get(physical('resume-designer-applications'))).toBe(before);
  });

  it('reports how many landed, so a caller can tell a no-op from a failure', async () => {
    expect((await applyUnits([])).applied).toBe(0);
  });
});

describe('applyUnits and the variant the app has OPEN', () => {
  // Seed the blob the way the app really holds it — a variant record with a
  // document inside — and open it, so the store and the disk start in step.
  const open = (document) => {
    disk.set(physical(DATA), JSON.stringify({
      variants: { 'v-open': JSON.parse(variantRecord('v-open', document)) },
      currentVariantId: 'v-open',
    }));
    resumeStore.setData(document, true, 'v-open');
  };

  it('replaces the document the store holds, not only the copy on disk', async () => {
    open({ name: 'Mine' });

    expect((await applyUnits([resumeUnit('v-open', { name: 'Edited on the iPhone' })])).applied).toBe(1);

    expect(resumeStore.getData().name).toBe('Edited on the iPhone');
    expect(JSON.parse(disk.get(physical(DATA))).variants['v-open'].data.name)
      .toBe('Edited on the iPhone');
  });

  it('does not let the next save write the stale in-memory document back over it', async () => {
    // THE BUG. Sync applies a fetched résumé by merging it into the blob ON
    // DISK and counts it applied, so the transport keeps the record's change
    // tag. The loaded variant's document also lives in store.js, and nothing
    // told the store it had been replaced — so the next debounced save wrote
    // the stale document straight back over the applied content, stamped it
    // fresh, and pushed it as a clean, uncontested update. No conflict was
    // raised and nothing was parked.
    open({ name: 'Mine' });
    registerPersistedSaveHandler(setPersistedSaveHandler);
    initPersistence('v-open');

    await applyUnits([resumeUnit('v-open', { name: 'Edited on the iPhone' })]);
    expect(resumeStore.saveNow()).toBe(true);

    expect(JSON.parse(disk.get(physical(DATA))).variants['v-open'].data.name)
      .toBe('Edited on the iPhone');
  });

  it('re-renders, because every renderer hangs off the store’s events', async () => {
    open({ name: 'Mine' });
    const seen = [];
    const stop = resumeStore.subscribe((event) => seen.push(event));

    await applyUnits([resumeUnit('v-open', { name: 'Edited on the iPhone' })]);
    stop();

    // 'change' is what a whole-document replacement of the SAME variant
    // already emits (undo/redo/restoreToEntry), and what main.js,
    // useResumeStore and the iOS document snapshot all repaint on.
    expect(seen).toContain('change');
  });

  it('leaves the store not dirty, so the adoption is not pushed straight back', async () => {
    // The adopted content is what the caller just wrote to storage. A store
    // left dirty would schedule a save of it, which restamps the unit and
    // sends this device's copy of what it has only just received.
    open({ name: 'Mine' });

    await applyUnits([resumeUnit('v-open', { name: 'Edited on the iPhone' })]);

    expect(resumeStore.isDirty()).toBe(false);
  });

  it('leaves the replaced document one restore away in that résumé’s history', async () => {
    // Newer wins, and the loser is never discarded silently. Every edit path
    // records its result in history before the save debounce runs, so the
    // document the adoption replaces is still there to restore.
    open({ name: 'Mine1' });
    resumeStore.update('name', 'Mine2');
    // The save that edit scheduled, landing — an adoption is refused outright
    // while one is still in flight (below), so this is the state in which a
    // fetch may replace the document at all.
    resumeStore.markSaved();

    await applyUnits([resumeUnit('v-open', { name: 'Edited on the iPhone' })]);

    expect(resumeStore.getData().name).toBe('Edited on the iPhone');
    const mine = resumeStore.getHistoryEntries()
      .find((e) => resumeStore.getHistoryEntryData(e.index).name === 'Mine2');
    expect(mine).toBeTruthy();
    expect(resumeStore.restoreToEntry(mine.index)).toBe(true);
    expect(resumeStore.getData().name).toBe('Mine2');
  });

  it('writes a résumé for a variant that is NOT open to storage and leaves the store alone', async () => {
    open({ name: 'Mine' });

    expect((await applyUnits([resumeUnit('v-other', { name: 'Theirs' })])).applied).toBe(1);

    expect(JSON.parse(disk.get(physical(DATA))).variants['v-other'].data.name).toBe('Theirs');
    expect(resumeStore.getData().name).toBe('Mine');
    // The store is the only thing that can tell — currentVariantId is private
    // to it — so it says so rather than guessing.
    expect(resumeStore.adoptDocument('v-other', { name: 'Theirs' })).toBe(false);
  });

  it('never clears the open document off a unit that carries no résumé — on disk or in the store', async () => {
    // Absence is never deletion: a variant record with no `data` is a broken
    // unit, not an empty résumé.
    //
    // The STORE refused it and the filter did not, so the data-less record went
    // through mergeData and over the blob's good copy while the document on
    // screen stayed — disk and memory disagreeing, which is the exact state
    // this path exists to eliminate. It counted as applied too, so the
    // transport kept the change tag, and the app reloaded data-less if it quit
    // before this variant's next save.
    open({ name: 'Mine' });

    const { applied } = await applyUnits([{
      id: 'resume:v-open', kind: 'resume', modifiedAt: AT,
      payload: JSON.stringify({ id: 'v-open', name: 'Tailored for Acme' }),
    }]);

    expect(applied).toBe(0);
    expect(resumeStore.getData().name).toBe('Mine');
    expect(JSON.parse(disk.get(physical(DATA))).variants['v-open'].data).toEqual({ name: 'Mine' });
  });

  it('never blanks a CLOSED variant’s copy on disk off a unit that carries no résumé', async () => {
    // No store involved at all here, which is the point: the loaded variant was
    // saved by adoptDocument's own guard, and every other variant had nothing
    // between the broken unit and the blob.
    open({ name: 'Mine' });
    await applyUnits([resumeUnit('v-other', { name: 'Theirs' })]);

    const { applied } = await applyUnits([{
      id: 'resume:v-other', kind: 'resume', modifiedAt: AT,
      payload: JSON.stringify({ id: 'v-other', name: 'Tailored for Acme' }),
    }]);

    expect(applied).toBe(0);
    expect(JSON.parse(disk.get(physical(DATA))).variants['v-other'].data).toEqual({ name: 'Theirs' });
  });

  it('refuses a résumé while an edit is still in flight, rather than repainting over it', async () => {
    // Adoption repaints: the store emits 'change' and main.js rebuilds
    // #resume's innerHTML from it. An edit the store has taken but no save has
    // written is also an edit whose time is NOT in the sync bookkeeping — the
    // stamp compared here is the last PERSISTED one and the save debounce has
    // no max wait, so under continuous editing a remote copy older than the
    // live document outranks it and displaces it.
    open({ name: 'Mine1' });
    resumeStore.update('name', 'Mine2');

    const { applied } = await applyUnits([resumeUnit('v-open', { name: 'Edited on the iPhone' })]);

    expect(applied).toBe(0);
    expect(resumeStore.getData().name).toBe('Mine2');
    // Refused on disk too: landing there and not in the store is the
    // disagreement this filter exists to stop.
    expect(JSON.parse(disk.get(physical(DATA))).variants['v-open'].data).toEqual({ name: 'Mine1' });

    // And the remote copy is not dropped. The short count makes the transport
    // forfeit the change tag, so the save this edit is about to trigger meets
    // the conflict path with a fresh stamp — where the loser is parked.
    resumeStore.markSaved();
    expect((await applyUnits([resumeUnit('v-open', { name: 'Edited on the iPhone' })])).applied).toBe(1);
    expect(resumeStore.getData().name).toBe('Edited on the iPhone');
  });

  it('refuses a résumé while someone is typing, whose text exists only in the DOM', async () => {
    // An inline edit commits on BLUR (src/inlineEditor.js's finishEditing), so
    // mid-word the text is in the contentEditable node and nowhere else: the
    // store is not dirty, no history entry holds it, and a repaint deletes the
    // characters outright. The sync layer cannot see the DOM, so main.js hands
    // it the question (registerEditingProbe).
    open({ name: 'Mine' });
    registerEditingProbe(() => true);

    const { applied } = await applyUnits([resumeUnit('v-open', { name: 'Edited on the iPhone' })]);

    expect(applied).toBe(0);
    expect(resumeStore.getData().name).toBe('Mine');
    expect(JSON.parse(disk.get(physical(DATA))).variants['v-open'].data).toEqual({ name: 'Mine' });

    // The session ends when the edit commits, and the unit the transport
    // re-offers lands then.
    registerEditingProbe(() => false);
    expect((await applyUnits([resumeUnit('v-open', { name: 'Edited on the iPhone' })])).applied).toBe(1);
    expect(resumeStore.getData().name).toBe('Edited on the iPhone');
  });

  it('lets a résumé for a variant that is NOT open land while another one is being edited', async () => {
    // The guard is about the document on screen. Refusing every résumé because
    // one variant is being typed into would stall sync on a whole workspace.
    open({ name: 'Mine' });
    registerEditingProbe(() => true);
    resumeStore.update('name', 'Mine, mid-edit');

    expect((await applyUnits([resumeUnit('v-other', { name: 'Theirs' })])).applied).toBe(1);

    expect(JSON.parse(disk.get(physical(DATA))).variants['v-other'].data).toEqual({ name: 'Theirs' });
    expect(resumeStore.getData().name).toBe('Mine, mid-edit');
  });

  it('refuses a résumé older than the copy this device holds, on the fetch path too', async () => {
    // Newer wins. The fetch path merged every résumé unconditionally, so a
    // record the server had not caught up with — this device edited while the
    // transport was down, or between a send and this pull — overwrote a newer
    // local edit on disk AND, now that the store adopts, on screen mid-edit.
    // Refusing is what the transport is built for: the short count makes it
    // forfeit the change tag, so the next save of this unit meets the conflict
    // path, where both copies are compared and the loser is parked.
    open({ name: 'Mine' });
    touchUnit('resume:v-open');

    const { applied } = await applyUnits([
      resumeUnit('v-open', { name: 'Older, from the other device' }, '2024-01-01T00:00:00.000Z'),
    ]);

    expect(applied).toBe(0);
    expect(resumeStore.getData().name).toBe('Mine');
    expect(JSON.parse(disk.get(physical(DATA))).variants['v-open'].data.name).toBe('Mine');
  });

  it('takes a remote résumé when this device has never stamped one, because unknown loses', async () => {
    // `modifiedAtFor` answers null for a unit this device never saved, and an
    // unknown time has to lose to a real one — the same rule resolveConflict
    // applies everywhere else.
    open({ name: 'Mine' });

    const { applied } = await applyUnits([
      resumeUnit('v-open', { name: 'Edited on the iPhone' }, '2024-01-01T00:00:00.000Z'),
    ]);

    expect(applied).toBe(1);
    expect(resumeStore.getData().name).toBe('Edited on the iPhone');
  });
});

// The same trap as the résumé's, one layer out: a module that holds its WHOLE
// key in memory and rewrites the key from that copy on the next local write
// reverts anything sync landed underneath it — and, the transport legitimately
// holding the record's change tag by then, pushes the revert back as a clean
// uncontested update that destroys the other device's content with no conflict
// raised. Four modules do it, in four different ownership shapes.
describe('applyUnits and the modules that hold a synced key IN MEMORY', () => {
  const keyUnit = (key, payload, modifiedAt = AT) => ({
    id: `key:${key}`, kind: 'plain', payload, modifiedAt,
  });

  const APPS_KEY = 'resume-designer-applications';
  const JOBS_KEY = 'resume-designer-job-descriptions';
  const THREADS_KEY = 'resume-designer-chat-threads';
  const LEARNED_KEY = 'resume-designer-learned-answers';

  const storedIds = (key) => JSON.parse(disk.get(physical(key))).map((r) => r.id);
  // The same, but reading through an unreadable value rather than throwing on
  // it: the whole point of the refusal tests below is that the key USED to end
  // up holding the literal bytes `null`, and `expected undefined to deeply equal
  // [...]` says that far more clearly than a TypeError from `.map`.
  const storedIdsOrNothing = (key) => JSON.parse(disk.get(physical(key)))?.map((r) => r.id);

  describe('applications — a cache with its own React subscribers', () => {
    it('survives the next local write through the module', async () => {
      initApplications();

      expect((await applyUnits([keyUnit(APPS_KEY, JSON.stringify([
        { id: 'app-iphone', variantId: 'v-1', status: 'applied', statusHistory: [] },
      ]))])).applied).toBe(1);
      // A perfectly ordinary local write — the record it saves is not the point,
      // the LIST it serializes is.
      addApplication({ variantId: 'v-1', variantName: 'Design Engineer' });

      expect(storedIds(APPS_KEY)).toContain('app-iphone');
      expect(getAllApplications().map((a) => a.id)).toContain('app-iphone');
    });

    it('reaches the screen, not just the cache', async () => {
      // React reads this module through useSyncExternalStore
      // (hooks/useApplications.js), so a cache corrected without notifying
      // leaves the Library showing a list that no longer exists.
      initApplications();
      const seen = vi.fn();
      const stop = subscribeApplications(seen);

      await applyUnits([keyUnit(APPS_KEY, JSON.stringify([{ id: 'app-iphone' }]))]);
      stop();

      expect(seen).toHaveBeenCalled();
      expect(getApplicationsSnapshot().map((a) => a.id)).toContain('app-iphone');
    });

    it('never empties the list off a unit it cannot read', async () => {
      // Absence is never deletion. `null` parses fine and would land as an
      // empty list; the cache keeps what it has, and the next local write puts
      // it back on disk.
      initApplications();
      addApplication({ variantId: 'v-1', variantName: 'Mine' });
      const mine = getAllApplications()[0].id;

      await applyUnits([keyUnit(APPS_KEY, 'null')]);

      expect(getAllApplications().map((a) => a.id)).toEqual([mine]);
    });

    it('never lets a unit it cannot read reach the KEY — the restart chain', async () => {
      // The assertion above is about MEMORY, and memory was never where the
      // destruction happened. The unreadable payload was still WRITTEN and still
      // counted: the cache kept the good list while the key held `null`, which
      // survives exactly as long as the process does. Restart before the next
      // local write and initApplications reads the garbage, degrades it to `[]`,
      // and the first save afterwards persists that empty list and pushes it up
      // as a clean, uncontested update.
      initApplications();
      addApplication({ variantId: 'v-1', variantName: 'Mine' });
      const mine = getAllApplications()[0].id;

      const { applied } = await applyUnits([keyUnit(APPS_KEY, 'null')]);

      // Short count: the transport forfeits the change tag and re-offers it.
      expect(applied).toBe(0);
      expect(storedIdsOrNothing(APPS_KEY)).toEqual([mine]);
      // The restart the in-memory refusal could not survive.
      expect(initApplications().map((a) => a.id)).toEqual([mine]);
    });

    it('still lands an EXPLICIT empty list, which is a deletion someone made', async () => {
      // The guard above tells absence from deletion; it must not refuse the
      // second. An empty array is what the other device's list actually is.
      initApplications();
      addApplication({ variantId: 'v-1', variantName: 'Mine' });

      expect((await applyUnits([keyUnit(APPS_KEY, '[]')])).applied).toBe(1);

      expect(getAllApplications()).toEqual([]);
      expect(disk.get(physical(APPS_KEY))).toBe('[]');
    });
  });

  describe('job descriptions — a cache the UI re-reads, with no second copy', () => {
    // The module cache outlives a test, and initJobDescriptions() deliberately
    // KEEPS it when the key is absent (an empty read must not wipe a seeded
    // list). Seed the key so each test's init really starts from nothing.
    beforeEach(() => { disk.set(physical(JOBS_KEY), '[]'); });

    it('survives the next local write through the module', async () => {
      initJobDescriptions();

      expect((await applyUnits([keyUnit(JOBS_KEY, JSON.stringify([
        { id: 'jd-iphone', title: 'Staff Engineer', company: 'Acme', isActive: true },
      ]))])).applied).toBe(1);
      addJobDescription({ title: 'Added here', company: 'Globex', description: 'x' });

      expect(storedIds(JOBS_KEY)).toContain('jd-iphone');
      expect(getAllJobDescriptions().map((j) => j.id)).toContain('jd-iphone');
    });

    it('tells the dialog to re-read, so an open Jobs list is not stale', async () => {
      initJobDescriptions();
      const seen = vi.fn();
      const stop = subscribeJobDescriptions(seen);

      await applyUnits([keyUnit(JOBS_KEY, JSON.stringify([{ id: 'jd-iphone' }]))]);
      stop();

      expect(seen).toHaveBeenCalled();
    });

    it('never empties the list off a unit it cannot read', async () => {
      initJobDescriptions();
      addJobDescription({ title: 'Mine', company: 'Mine', description: 'x' });
      const mine = getAllJobDescriptions()[0].id;

      await applyUnits([keyUnit(JOBS_KEY, 'null')]);

      expect(getAllJobDescriptions().map((j) => j.id)).toEqual([mine]);
    });

    it('never lets a unit it cannot read reach the KEY — the restart chain', async () => {
      // As above: the cache surviving is not the same as the disk surviving,
      // and initJobDescriptions degrades the same `null` to an empty list.
      initJobDescriptions();
      addJobDescription({ title: 'Mine', company: 'Mine', description: 'x' });
      const mine = getAllJobDescriptions()[0].id;

      const { applied } = await applyUnits([keyUnit(JOBS_KEY, 'null')]);

      expect(applied).toBe(0);
      expect(storedIdsOrNothing(JOBS_KEY)).toEqual([mine]);
      expect(initJobDescriptions().map((j) => j.id)).toEqual([mine]);
    });
  });

  describe('chat threads — a cache that lives in the React tree', () => {
    // chatThreads.js is stateless by design: every function takes threads and
    // hands threads back. The one live copy is useChat's React state, and
    // `persistThreads` writes THAT back. This stands in for the hook — the same
    // hold-and-write-back shape, without a renderer — and `busy` stands in for
    // its `loading`/in-flight-stream refs.
    const liveChat = () => {
      const holder = {
        busy: false,
        threads: loadThreads().threads,
        isBusy: () => holder.busy,
        adopt: () => { holder.threads = loadThreads().threads; },
      };
      registerThreadHolder(holder);
      return holder;
    };

    const theirs = [{
      id: 'thread-iphone', name: 'From the iPhone', messages: [],
      createdAt: AT, updatedAt: AT, homeVariantId: null,
    }];

    beforeEach(() => {
      disk.set(physical(THREADS_KEY), JSON.stringify([{
        id: 'thread-mine', name: 'Mine', messages: [],
        createdAt: AT, updatedAt: AT, homeVariantId: null,
      }]));
    });

    it('survives the next local write through the module', async () => {
      const chat = liveChat();

      expect((await applyUnits([keyUnit(THREADS_KEY, JSON.stringify(theirs))])).applied).toBe(1);
      // What useChat does on every send: rebuild the list from the copy it
      // holds and persist it.
      persistThreads([...chat.threads, makeThread('Typed here', [], 'v-1')]);

      expect(storedIds(THREADS_KEY)).toContain('thread-iphone');
    });

    it('refuses a thread list while a reply is in flight, rather than repainting over it', async () => {
      // Same exposure as the résumé's inline edit, same answer. A streamed
      // reply exists only in React state until it commits, and it commits by
      // mapping over the thread list — so replacing that list mid-stream drops
      // the reply on the floor with nothing anywhere holding it.
      const chat = liveChat();
      chat.busy = true;

      const { applied } = await applyUnits([keyUnit(THREADS_KEY, JSON.stringify(theirs))]);

      expect(applied).toBe(0);
      // Refused on disk too: landing there and not in the hook is the
      // disagreement the refusal exists to stop.
      expect(storedIds(THREADS_KEY)).toEqual(['thread-mine']);

      // And nothing is lost by refusing — the short count forfeits the change
      // tag, and the unit the transport re-offers lands once the reply is in.
      chat.busy = false;
      expect((await applyUnits([keyUnit(THREADS_KEY, JSON.stringify(theirs))])).applied).toBe(1);
      expect(storedIds(THREADS_KEY)).toEqual(['thread-iphone']);
    });

    it('lands with nobody holding a copy, because loadThreads reads storage each time', async () => {
      registerThreadHolder(null);

      expect((await applyUnits([keyUnit(THREADS_KEY, JSON.stringify(theirs))])).applied).toBe(1);
      expect(loadThreads().threads.map((t) => t.id)).toEqual(['thread-iphone']);
    });

    it('never lets a unit it cannot read reach the KEY', async () => {
      // The worst of the four, and the only one that needs no restart to bite:
      // loadThreads does not merely fall back to an empty list on garbage, it
      // MANUFACTURES a single fresh 'New Chat'. So a `null` allowed onto the key
      // is adopted as an empty conversation history, and the next send persists
      // that and pushes it up as a clean, uncontested update.
      const chat = liveChat();

      const { applied } = await applyUnits([keyUnit(THREADS_KEY, 'null')]);

      expect(applied).toBe(0);
      expect(storedIdsOrNothing(THREADS_KEY)).toEqual(['thread-mine']);
      expect(loadThreads().threads.map((t) => t.id)).toEqual(['thread-mine']);
      expect(chat.threads.map((t) => t.id)).toEqual(['thread-mine']);
    });

    it('does not let a departing holder deregister its successor', async () => {
      // One call site today, so the unconditional clear this replaces was
      // correct today — and silently stopped being correct the moment a second
      // holder registered. React mounts a replacement BEFORE unmounting the one
      // it replaces, so the departing holder's cleanup would deregister the
      // SURVIVOR, and an unreachable holder is the revert bug back with no
      // symptom until another device's threads went missing.
      const first = { isBusy: () => false, adopt: vi.fn() };
      const second = { isBusy: () => false, adopt: vi.fn() };
      const releaseFirst = registerThreadHolder(first);
      registerThreadHolder(second);
      releaseFirst();

      expect((await applyUnits([keyUnit(THREADS_KEY, JSON.stringify(theirs))])).applied).toBe(1);
      expect(second.adopt).toHaveBeenCalled();
      expect(first.adopt).not.toHaveBeenCalled();
    });
  });

  // The fourth instance, and the simplest ownership shape of the four: a module
  // array, and no reader of it anywhere but the companion bridge, which asks per
  // request. No subscribers to notify and no live draft to interrupt.
  describe('learned answers — a cache the companion bridge reads per request', () => {
    beforeEach(() => { disk.set(physical(LEARNED_KEY), '[]'); });

    const theirAnswer = [{
      id: 'ans-iphone',
      question: 'Notice period?',
      normalized: 'notice period',
      answer: '4 weeks',
      createdAt: AT,
      updatedAt: AT,
    }];

    it('survives the next local write through the module', async () => {
      initLearnedAnswers();

      expect((await applyUnits([keyUnit(LEARNED_KEY, JSON.stringify(theirAnswer))])).applied).toBe(1);
      // One answer learned while filling a form is enough: `save()` serializes
      // the whole cache back over the key.
      saveLearnedAnswer('Work authorization?', 'US citizen');

      expect(storedIds(LEARNED_KEY)).toContain('ans-iphone');
      expect(getAllLearnedAnswers().map((a) => a.id)).toContain('ans-iphone');
    });

    it('never lets a unit it cannot read reach the KEY — the restart chain', async () => {
      initLearnedAnswers();
      saveLearnedAnswer('Pronouns?', 'they/them');
      const mine = getAllLearnedAnswers()[0].id;

      const { applied } = await applyUnits([keyUnit(LEARNED_KEY, 'null')]);

      expect(applied).toBe(0);
      expect(storedIdsOrNothing(LEARNED_KEY)).toEqual([mine]);
      expect(initLearnedAnswers().map((a) => a.id)).toEqual([mine]);
    });
  });

  // The fifth instance, and the only one that is NOT a `key:` unit: the user
  // profile is a FIELD of the data blob (`data:userProfile`), and ProfileDialog
  // holds a whole-object working copy of it that `saveUserProfile` writes back
  // wholesale. Everything above it in the ownership argument is identical.
  describe('the user profile — a working copy in an always-mounted dialog', () => {
    const dataUnit = (field, value, modifiedAt = AT) => ({
      id: `data:${field}`, kind: 'plain', payload: JSON.stringify(value), modifiedAt,
    });

    const MINE = { contactInfo: { fullName: 'Ada Lovelace' }, workExperience: [] };
    const THEIRS = {
      contactInfo: { fullName: 'Ada Lovelace' },
      workExperience: [{ company: 'Added on the iPhone' }],
    };

    // Stands in for ProfileDialog — the same take-a-copy-and-write-it-back-whole
    // shape without a React tree, exactly as `liveChat` stands in for useChat.
    // `busy` stands in for its debounce timer / failed-save refs.
    const liveProfileDialog = () => {
      const dialog = {
        busy: false,
        profile: getUserProfile(),
        isBusy: () => dialog.busy,
        adopt: () => { dialog.profile = getUserProfile(); },
      };
      registerUserProfileHolder(dialog);
      return dialog;
    };

    const storedProfile = () => JSON.parse(disk.get(physical(DATA))).userProfile;

    beforeEach(() => {
      disk.set(physical(DATA), JSON.stringify({
        variants: { 'v-1': { name: 'Design Engineer' } },
        currentVariantId: 'v-1',
        settings: { pageSize: 'letter' },
        userProfile: MINE,
      }));
      registerUserProfileHolder(null);
    });

    it('survives the next debounced save through the dialog', async () => {
      const dialog = liveProfileDialog();

      expect((await applyUnits([dataUnit('userProfile', THEIRS)])).applied).toBe(1);
      // One keystroke in any field of the open dialog: ProfileTabs mutates the
      // working copy in place and the 500 ms debounce writes the WHOLE object
      // back over `storage.userProfile`.
      dialog.profile.contactInfo.email = 'ada@example.com';
      saveUserProfile(dialog.profile);

      expect(storedProfile().workExperience).toEqual(THEIRS.workExperience);
      expect(storedProfile().contactInfo.email).toBe('ada@example.com');
    });

    it('refuses a profile while an edit is in flight, rather than overwriting it', async () => {
      // The edit lives ONLY in that ref until the debounce fires — no DOM copy,
      // no history — so adopting mid-edit drops the typing with nothing holding
      // it. Same rule as the chat's, same refusal.
      const dialog = liveProfileDialog();
      dialog.busy = true;

      const { applied } = await applyUnits([dataUnit('userProfile', THEIRS)]);

      expect(applied).toBe(0);
      // Refused on disk too: landing there and not in the dialog is the
      // disagreement the refusal exists to stop.
      expect(storedProfile()).toEqual(MINE);

      // And nothing is lost by refusing — the short count forfeits the change
      // tag, and the unit the transport re-offers lands once the edit is saved.
      dialog.busy = false;
      expect((await applyUnits([dataUnit('userProfile', THEIRS)])).applied).toBe(1);
      expect(storedProfile()).toEqual(THEIRS);
    });

    it('leaves `data:settings` alone, which nobody holds a whole copy of', async () => {
      // Every writer of settings calls saveSettings with the ONE field it
      // changed, merged into a freshly-read blob — so the busy rule must not
      // spread to it, and a settings unit lands whatever the profile editor is
      // doing.
      const dialog = liveProfileDialog();
      dialog.busy = true;

      expect((await applyUnits([dataUnit('settings', { pageSize: 'a4' })])).applied).toBe(1);
      expect(JSON.parse(disk.get(physical(DATA))).settings.pageSize).toBe('a4');
    });
  });
});

describe('parkLoser', () => {
  // The losing version, in the shape the transport really hands over: a
  // `resume:` unit's payload, which is the whole variant RECORD. A history
  // entry's `data` is the DOCUMENT inside it.
  //
  // The fixture keeps the two apart deliberately. `{ name: 'The version that
  // lost' }` — what this used to park — reads as valid whichever shape it is
  // taken for, so a test built on it passed identically whether the record or
  // the document went into history. Here the record is named for the RÉSUMÉ,
  // the document for the PERSON, and only the document carries a summary: park
  // the record and the entry restores to a résumé called 'Tailored for Acme'
  // with nothing in it.
  const LOST_DOCUMENT = { name: 'Ada Lovelace', summary: 'The paragraph that lost' };
  const lostPayload = (id) => variantRecord(id, LOST_DOCUMENT, 'Tailored for Acme');

  // The real key/shape, confirmed against src/store.js (saveHistory/
  // loadHistory) and src/components/HistoryDialog.jsx: the value at
  // `resume-designer-history-<variantId>` (BACKUP_HISTORY_PREFIX + variantId
  // — no "-variant-" infix) is `{ history: [...], historyIndex }`, and each
  // entry the dialog renders carries `data`, `timestamp`, `description` and
  // `changeType`. A brief that wrote a bare array to
  // `resume-designer-history-variant-<id>` would park the loser at a key
  // nothing reads and in a shape loadHistory() would discard on the next load.
  it('writes a losing résumé into that résumé’s version history, in the shape store.js reads', () => {
    const ok = parkLoser('resume:v-1', lostPayload('v-1'));
    expect(ok).toBe(true);
    const historyData = JSON.parse(disk.get(physical('resume-designer-history-v-1')));
    expect(Array.isArray(historyData.history)).toBe(true);
    const entry = historyData.history.at(-1);
    // The DOCUMENT, not the variant record around it. Parking the record put a
    // shape one level too high into `data`: the entry listed and restored like
    // any other, and what it restored was a near-empty résumé named after the
    // variant. The entire conflict design rests on a parked loser being
    // RESTORABLE — otherwise "newer wins, nothing is discarded" is not true.
    expect(entry.data).toEqual(LOST_DOCUMENT);
    expect(entry.changeType).toBe('sync-conflict');
    expect(typeof entry.description).toBe('string');
    expect(entry.description.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
  });

  it('adds to existing history rather than clobbering it, and keeps historyIndex on the entry that was current', () => {
    disk.set(physical('resume-designer-history-v-1'), JSON.stringify({
      history: [
        { data: { name: 'Older' }, timestamp: '2026-07-31T00:00:00.000Z', description: 'Older', changeType: 'edit' },
        { data: { name: 'Design Engineer' }, timestamp: '2026-08-01T00:00:00.000Z', description: 'Initial state', changeType: 'initial' },
      ],
      historyIndex: 1,
    }));
    parkLoser('resume:v-1', lostPayload('v-1'));
    const historyData = JSON.parse(disk.get(physical('resume-designer-history-v-1')));

    expect(historyData.history).toHaveLength(3);
    expect(historyData.history.map((e) => e.description)).toContain('Older');
    // The index moved by one, but it still points at the same ENTRY: parking
    // changes what history holds, not what the document considers current.
    expect(historyData.history[historyData.historyIndex].description).toBe('Initial state');
    // And the parked entry is in the PAST, not in the redo future that
    // store.js's pushHistory splices away on the next edit.
    const parkedAt = historyData.history.findIndex((e) => e.changeType === 'sync-conflict');
    expect(parkedAt).toBeLessThan(historyData.historyIndex);
    // Not the entry one undo away either — the index moves up with the park, so
    // parking AT the index makes the loser what the next Cmd+Z restores. Same
    // rule as store.js's adoptHistoryEntry, which the loaded variant takes.
    expect(historyData.history[historyData.historyIndex - 1].description).toBe('Older');
  });

  it('keeps a parked loser through the next local edit, which is the entire point of parking it', () => {
    // The loaded variant's history lives in store.js's in-memory array, and
    // saveHistory rewrites the whole key from it — an array that never saw an
    // entry written straight to storage. On top of that, pushHistory splices
    // away everything after historyIndex before it appends. So a park that
    // wrote the key directly (or appended into that future) was gone one
    // keystroke later, and "newer wins is safe because nothing is destroyed"
    // was destroying the losing version it promised to keep.
    resumeStore.setData({ name: 'Design Engineer' }, true, 'v-park');
    expect(parkLoser('resume:v-park', lostPayload('v-park'))).toBe(true);

    resumeStore.update('name', 'Edited after the park');

    const historyData = JSON.parse(disk.get(physical('resume-designer-history-v-park')));
    const parked = historyData.history.filter((e) => e.changeType === 'sync-conflict');
    expect(parked).toHaveLength(1);
    expect(parked[0].data).toEqual(LOST_DOCUMENT);
    // The winner is still what the document shows — parking archives, it does
    // not restore.
    expect(resumeStore.getData().name).toBe('Edited after the park');
  });

  it('parks out of undo’s way, so one Cmd+Z does not restore another device’s rejected résumé', () => {
    // Landing the entry AT historyIndex put it one slot below the index once
    // the index moved up to keep pointing at the same entry — which is the undo
    // target. A park would then hand the user the version their newer edit had
    // just beaten, on the next Cmd+Z. Splice-safety only needs a position at or
    // below the index, so the entry goes BELOW it and undo is untouched.
    resumeStore.setData({ name: 'First' }, true, 'v-undo');
    resumeStore.update('name', 'Second');
    expect(parkLoser('resume:v-undo', lostPayload('v-undo'))).toBe(true);

    expect(resumeStore.undo()).toBe(true);
    expect(resumeStore.getData().name).toBe('First');

    // And it is still parked — out of undo's way, not out of history.
    const stored = JSON.parse(disk.get(physical('resume-designer-history-v-undo')));
    const parked = stored.history.filter((e) => e.changeType === 'sync-conflict');
    expect(parked).toHaveLength(1);
    expect(parked[0].data).toEqual(LOST_DOCUMENT);
  });

  it('does not put a park in undo’s reach on a freshly loaded résumé, where there is no slot below the index', () => {
    // historyIndex 0 is the state of EVERY freshly loaded résumé, and the
    // likeliest moment for a first sync conflict. There is no slot below the
    // current entry, so the park lands at 0 and the index moves to 1 — one
    // Cmd+Z away. Undo was unavailable a moment earlier and parking must not
    // make it available: a rejected version is not a step the user took.
    resumeStore.setData({ name: 'Fresh' }, true, 'v-fresh');
    expect(resumeStore.canUndo()).toBe(false);

    expect(parkLoser('resume:v-fresh', lostPayload('v-fresh'))).toBe(true);

    expect(resumeStore.canUndo()).toBe(false);
    expect(resumeStore.undo()).toBe(false);
    expect(resumeStore.getData().name).toBe('Fresh');
    // Not merely unchanged on screen: undo marked the document dirty and
    // scheduled a save of the rejected version.
    expect(resumeStore.isDirty()).toBe(false);

    // Skipped by the traversal, NOT hidden: still listed and still restorable
    // from the history dialog, which is the whole point of parking it.
    const parked = resumeStore.getHistoryEntries().filter((e) => e.changeType === 'sync-conflict');
    expect(parked).toHaveLength(1);
    expect(resumeStore.getHistoryEntryData(parked[0].index)).toEqual(LOST_DOCUMENT);
    expect(resumeStore.restoreToEntry(parked[0].index)).toBe(true);
    expect(resumeStore.getData()).toEqual(LOST_DOCUMENT);
  });

  it('opens a résumé whose only history is a park without treating the rejected version as current', () => {
    // A variant this device has never opened has no history for parkLoser to
    // insert into, so the storage path writes `{ history: [loser],
    // historyIndex: 0 }`. loadHistory then takes its SUCCESS path — no
    // 'Initial state' is pushed — and the rejected version is what the store
    // calls current, so one edit and one Cmd+Z put it on screen.
    expect(parkLoser('resume:v-cold', lostPayload('v-cold'))).toBe(true);
    expect(JSON.parse(disk.get(physical('resume-designer-history-v-cold'))).historyIndex).toBe(0);

    resumeStore.setData({ name: 'The version that won' }, true, 'v-cold');
    expect(resumeStore.getHistoryEntries().find((e) => e.isCurrent).changeType).not.toBe('sync-conflict');

    resumeStore.update('name', 'Edited after opening');
    expect(resumeStore.undo()).toBe(true);
    expect(resumeStore.getData().name).toBe('The version that won');
    expect(resumeStore.undo()).toBe(false);

    const parked = resumeStore.getHistoryEntries().filter((e) => e.changeType === 'sync-conflict');
    expect(parked).toHaveLength(1);
  });

  it('refuses a payload with no document rather than parking an entry that restores to nothing', () => {
    // The one thing worse than refusing is an entry that looks parked. A
    // refusal is left out of `resolveConflicts`' parked count, so nothing tells
    // the person to look in Version history for it; a park that cannot be
    // restored disappears silently instead, and leaves a row in the history
    // dialog claiming otherwise.
    expect(parkLoser('resume:v-broken', JSON.stringify({ id: 'v-broken', name: 'Tailored for Acme' }))).toBe(false);
    expect(parkLoser('resume:v-broken', '{ not json')).toBe(false);
    expect(parkLoser('resume:v-broken', 'null')).toBe(false);
    expect(disk.has(physical('resume-designer-history-v-broken'))).toBe(false);
  });

  it('refuses a unit that is not a résumé, which has no history to park in', () => {
    expect(parkLoser('key:resume-designer-applications', '[]')).toBe(false);
    expect(parkLoser('key:resume-designer-history-v-1', '{}')).toBe(false);
  });

  // A park CHANGES that variant's history unit, and it is the one history write
  // no persisted save accompanies: Swift calls it from the conflict path,
  // outside `applying` and outside any save. The storage interceptor skips
  // history keys on the premise that the persistence path stamps them, so an
  // unstamped park left the unit carrying `modifiedAt: null` — which
  // resolveConflict reads as -Infinity. Swift names the record to CloudKit
  // either way, so the parked loser went up as a unit that loses EVERY conflict
  // it ever meets: the archive the whole newer-wins design rests on, quietly
  // beaten by anything.
  const stampOf = (unitId) => JSON.parse(disk.get(physical('resume-designer-sync-state')) ?? '{}')[unitId];

  it('stamps the history unit it changed for the LOADED variant', () => {
    resumeStore.setData({ name: 'On screen' }, true, 'v-1');
    expect(parkLoser('resume:v-1', lostPayload('v-1'))).toBe(true);

    const unitId = `key:${BACKUP_HISTORY_PREFIX}v-1`;
    const { modifiedAt } = stampOf(unitId) ?? {};
    expect(new Date(modifiedAt).toISOString()).toBe(modifiedAt);
  });

  it('stamps the history unit it changed for a variant that is NOT loaded', () => {
    // The other branch — the direct history-key write — mutates the same unit
    // and needs the same stamp.
    resumeStore.setData({ name: 'On screen' }, true, 'v-1');
    expect(parkLoser('resume:v-cold', lostPayload('v-cold'))).toBe(true);

    const unitId = `key:${BACKUP_HISTORY_PREFIX}v-cold`;
    const { modifiedAt } = stampOf(unitId) ?? {};
    expect(new Date(modifiedAt).toISOString()).toBe(modifiedAt);
  });

  it('leaves the parked history a unit that can WIN a later conflict, not one read as -Infinity', () => {
    resumeStore.setData({ name: 'On screen' }, true, 'v-1');
    parkLoser('resume:v-1', lostPayload('v-1'));

    const unitId = `key:${BACKUP_HISTORY_PREFIX}v-1`;
    const local = collectUnit(unitId);
    expect(local.modifiedAt).not.toBe(null);
    // An older remote copy — one that does not hold the park — must not beat it.
    const remote = { id: unitId, modifiedAt: '2024-01-01T00:00:00.000Z' };
    expect(resolveConflict(local, remote).winner).toBe(local);
  });
});

describe('the history bound', () => {
  it('is the store’s bound too, taken from the leaf module rather than from the sync layer', () => {
    // store.js's pushHistory and syncMerge.js's mergeHistory both enforce this
    // number, and a merge that kept more than the store's bound would just be
    // trimmed on the next edit, one entry per edit, silently. It is declared in
    // a leaf both sides can import: declaring it in syncMerge.js made the core
    // store import the sync layer, and syncModel.js already imports store.js —
    // no cycle today, one the moment the store calls into sync.
    resumeStore.setData({ name: 'e0' }, true, 'v-cap');
    for (let i = 1; i <= MAX_HISTORY + 5; i += 1) resumeStore.update('name', `e${i}`);

    expect(resumeStore.getHistoryLength()).toBe(MAX_HISTORY);
    const stored = JSON.parse(disk.get(physical('resume-designer-history-v-cap')));
    expect(stored.history).toHaveLength(MAX_HISTORY);
    expect(stored.history.at(-1).data.name).toBe(`e${MAX_HISTORY + 5}`);
  });
});

describe('touchUnit', () => {
  it('records a modification time that collectUnits then reports', () => {
    touchUnit('resume:v-1');
    const unit = collectUnits().find((u) => u.id === 'resume:v-1');
    const state = JSON.parse(disk.get(physical('resume-designer-sync-state')));
    expect(unit.modifiedAt).toBe(state['resume:v-1'].modifiedAt);
  });
});

describe('persisted save stamping', () => {
  it('stamps the résumé and history units after a successful save', () => {
    const notifyDirty = vi.fn();
    registerPersistedSaveHandler(setPersistedSaveHandler);
    setSyncDirtyNotifier(notifyDirty);
    resumeStore.setData({ name: 'Edited' }, true, 'v-1');
    initPersistence('v-1');

    expect(resumeStore.saveNow()).toBe(true);

    const recorded = JSON.parse(disk.get(physical('resume-designer-sync-state')) ?? '{}');
    const stamps = [
      recorded['resume:v-1'],
      recorded[`key:${BACKUP_HISTORY_PREFIX}v-1`],
    ];
    for (const { modifiedAt } of stamps) {
      expect(new Date(modifiedAt).toISOString()).toBe(modifiedAt);
    }
    expect(notifyDirty).toHaveBeenCalledWith([
      'resume:v-1',
      `key:${BACKUP_HISTORY_PREFIX}v-1`,
    ]);
  });

  it('stamps neither unit when the save fails', () => {
    const notifyDirty = vi.fn();
    registerPersistedSaveHandler(setPersistedSaveHandler);
    setSyncDirtyNotifier(notifyDirty);
    resumeStore.setData({ name: 'Edited' }, true, 'v-1');
    initPersistence('v-1');
    failDataWrites = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(resumeStore.saveNow()).toBe(false);
    const recorded = JSON.parse(disk.get(physical('resume-designer-sync-state')) ?? '{}');
    expect(recorded['resume:v-1']).toBeUndefined();
    expect(recorded[`key:${BACKUP_HISTORY_PREFIX}v-1`]).toBeUndefined();
    expect(notifyDirty).not.toHaveBeenCalled();

    error.mockRestore();
  });

  it('still reports a successful save when sync-state stamping throws', () => {
    const notifyDirty = vi.fn();
    registerPersistedSaveHandler(setPersistedSaveHandler);
    setSyncDirtyNotifier(notifyDirty);
    resumeStore.setData({ name: 'Edited' }, true, 'v-1');
    initPersistence('v-1');
    failSyncStateWrites = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(resumeStore.saveNow()).toBe(true);
      expect(notifyDirty).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe('unit scope', () => {
  it('marks the registry unit shared and résumé units profile-scoped', () => {
    const units = collectUnits();
    const registry = units.find((u) => u.id === 'key:resume-designer-profiles');
    expect(registry?.scope).toBe('shared');
    for (const unit of units.filter((u) => u.id.startsWith('resume:'))) {
      expect(unit.scope).toBe('profile');
    }
  });

  it('answers by id exactly what the collection stamps on the unit', () => {
    // The transport asks by id when it QUEUES a save and reads `scope` off the
    // unit it collects. Two answers for one unit is a record saved into one zone
    // and looked for in the other, so they are asserted against each other.
    const units = collectUnits();
    const scopes = unitScopes(units.map((unit) => unit.id));
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) expect(scopes[unit.id], unit.id).toBe(unit.scope);
  });

  it('calls an id in no shape it issues profile-scoped', () => {
    expect(unitScopes(['nonsense', 'key:resume-designer-profiles'])).toEqual({
      nonsense: 'profile',
      'key:resume-designer-profiles': 'shared',
    });
  });
});

describe('registry landing', () => {
  it('unions an incoming registry instead of replacing it', async () => {
    // Seed a local registry with one profile, apply a remote unit naming
    // another, and assert both survive.
    const local = [{ id: 'pa', name: 'Local', emoji: '🙂', createdAt: '2026-01-01T00:00:00.000Z' }];
    const remote = [{ id: 'pb', name: 'Remote', emoji: '🚀', createdAt: '2026-02-01T00:00:00.000Z' }];
    appStorage.setItem('resume-designer-profiles', JSON.stringify(local));
    await applyUnits([{
      id: 'key:resume-designer-profiles', kind: 'plain', payload: JSON.stringify(remote), modifiedAt: '2026-03-01T00:00:00.000Z',
    }]);
    const merged = JSON.parse(appStorage.getItem('resume-designer-profiles'));
    expect(merged.map((p) => p.id).sort()).toEqual(['pa', 'pb']);
  });
});
