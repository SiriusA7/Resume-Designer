import { describe, it, expect, beforeEach, vi } from 'vitest';
// The history bound, from the leaf that owns it (src/historyLimits.js): the
// store trims to it and the merge caps to it, and neither may own it.
import { MAX_HISTORY } from '../src/historyLimits.js';

// The store's only storage dependency, mocked so these tests are a pure
// exercise of the history array. Keys are logical here — profile namespacing
// belongs to appStorage and none of this depends on it.
const disk = new Map();
vi.mock('../src/appStorage.js', () => ({
  appStorage: {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => { disk.set(k, String(v)); },
    keys: () => [...disk.keys()],
  },
  setProfileMapping: () => {},
}));

// A counter around the ONE identity computation the store makes per merge.
// `vi.hoisted` because a vi.mock factory is hoisted above ordinary module-level
// declarations and would read this before it exists.
const identity = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/sync/syncMerge.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    entryIdentity: (entry) => {
      identity.calls += 1;
      return actual.entryIdentity(entry);
    },
  };
});

const { store } = await import('../src/store.js');

// A store with no memoised device id — a freshly launched app, reading the id
// back out of storage the way a real boot does.
const rebooted = async () => {
  vi.resetModules();
  return (await import('../src/store.js')).store;
};

const SYNC_STATE = 'resume-designer-sync-state';
const historyKey = (variantId) => `resume-designer-history-${variantId}`;
const stored = (variantId) => JSON.parse(disk.get(historyKey(variantId)));
const names = () => Array.from(
  { length: store.getHistoryLength() },
  (_, i) => store.getHistoryEntryData(i).name,
);
// An entry as another device wrote it: same shape as pushHistory's, stamped
// with that device's origin rather than this one's.
const foreign = (name, timestamp, over = {}) => ({
  data: { name },
  timestamp,
  description: 'Edit',
  changeType: 'edit',
  origin: 'device-iphone',
  ...over,
});

beforeEach(() => {
  disk.clear();
  identity.calls = 0;
});

describe('this device’s origin', () => {
  it('stamps every entry it writes, and keeps the id in the sync-state key it already owns', async () => {
    // No new key: the device id goes into `resume-designer-sync-state`, beside
    // the per-unit modification times the sync layer records there. That key is
    // classified device-local (src/sync/syncKeys.js), which is what keeps this
    // id off the network.
    disk.set(SYNC_STATE, JSON.stringify({ 'resume:v-origin': { modifiedAt: '2026-08-01T00:00:00.000Z' } }));

    const store = await rebooted();
    store.setData({ name: 'A' }, true, 'v-origin');
    store.update('name', 'B');

    const state = JSON.parse(disk.get(SYNC_STATE));
    expect(typeof state.deviceId).toBe('string');
    expect(state.deviceId.length).toBeGreaterThan(0);
    // Alongside the sync layer's own bookkeeping, not on top of it.
    expect(state['resume:v-origin'].modifiedAt).toBe('2026-08-01T00:00:00.000Z');

    const entries = stored('v-origin').history;
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry.origin).toBe(state.deviceId);
  });

  it('reuses the id it recorded rather than becoming a new device on every load', async () => {
    // The id has to be STABLE: one that changed between sessions would make
    // this user's own earlier entries look foreign and strand their whole
    // history behind their own undo.
    const first = await rebooted();
    first.setData({ name: 'A' }, true, 'v-stable');
    first.update('name', 'B'); // saveHistory writes the key
    const recorded = JSON.parse(disk.get(SYNC_STATE)).deviceId;

    const reloaded = await rebooted();
    // A different document, so no entry here can be identical to one written
    // above and get deduplicated by the union below.
    reloaded.setData({ name: 'C' }, true, 'v-stable-2');
    reloaded.update('name', 'D');

    expect(JSON.parse(disk.get(SYNC_STATE)).deviceId).toBe(recorded);
    for (const entry of stored('v-stable-2').history) expect(entry.origin).toBe(recorded);
    // So entries written before the reboot are still this device's own steps,
    // and undo still walks them.
    expect(reloaded.adoptHistory('v-stable-2', stored('v-stable'))).toBe(true);
    expect(reloaded.getHistoryLength()).toBe(4);
    expect([reloaded.undo(), reloaded.undo(), reloaded.undo()]).toEqual([true, true, true]);
    expect(reloaded.canUndo()).toBe(false);
  });
});

describe('undo traverses only this device’s own steps', () => {
  it('steps over another device’s entries, in both directions', () => {
    // Edit on the phone, open the Mac, press Cmd+Z: undo used to hand back the
    // phone's document rather than the user's own last state. Nothing was lost,
    // but it read as loss.
    store.setData({ name: 'Mine1' }, true, 'v-skip');
    store.update('name', 'Mine2');

    // Dated after both local entries, so the union sorts it last — the position
    // one Cmd+Z lands on once adoptHistory moves the current entry to the end.
    expect(store.adoptHistory('v-skip', {
      history: [foreign('Theirs', '2126-08-08T00:00:00.000Z')],
      historyIndex: 0,
    })).toBe(true);
    expect(names()).toEqual(['Mine1', 'Theirs', 'Mine2']);

    expect(store.canUndo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.getData().name).toBe('Mine1');
    // The floor is the user's own first state, not the entry above it.
    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toBe(false);

    // And redo steps over it going the other way.
    expect(store.canRedo()).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.getData().name).toBe('Mine2');
    expect(store.canRedo()).toBe(false);
  });

  it('reports no undo at all when everything below is another device’s', () => {
    // canUndo has to agree with undo, or the toolbar offers a button that does
    // nothing — or worse, one that looks like it lost the user's work.
    store.setData({ name: 'Only mine' }, true, 'v-only');
    expect(store.adoptHistory('v-only', {
      history: [foreign('Theirs', '2020-01-01T00:00:00.000Z')],
      historyIndex: 0,
    })).toBe(true);
    expect(names()).toEqual(['Theirs', 'Only mine']);

    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toBe(false);
    expect(store.getData().name).toBe('Only mine');
    // Not merely unchanged on screen: undo marks the document dirty and
    // schedules a save of whatever it restored.
    expect(store.isDirty()).toBe(false);
  });

  it('still lists and restores another device’s entries — only the traversal narrows', () => {
    store.setData({ name: 'Mine' }, true, 'v-restore');
    store.adoptHistory('v-restore', {
      history: [foreign('Theirs', '2126-08-08T00:00:00.000Z')],
      historyIndex: 0,
    });

    const listed = store.getHistoryEntries();
    expect(listed).toHaveLength(2);
    const theirs = listed.find((e) => store.getHistoryEntryData(e.index).name === 'Theirs');
    expect(store.restoreToEntry(theirs.index)).toBe(true);
    expect(store.getData().name).toBe('Theirs');
  });

  it('treats an entry with no origin as this device’s, so a pre-sync history stays undoable', () => {
    // History was device-local before sync existed, so every entry written
    // before the field really was written here. Reading absence as "foreign"
    // would strand a user's entire existing history behind their own undo.
    const legacy = (name, timestamp) => ({ data: { name }, timestamp, description: 'Edit', changeType: 'edit' });
    disk.set(historyKey('v-legacy'), JSON.stringify({
      history: [
        legacy('One', '2026-08-01T00:00:00.000Z'),
        legacy('Two', '2026-08-02T00:00:00.000Z'),
        legacy('Three', '2026-08-03T00:00:00.000Z'),
      ],
      historyIndex: 2,
    }));

    store.setData({ name: 'Three' }, true, 'v-legacy');
    // The document IS the entry the loaded history calls current, so nothing
    // was appended to correct it.
    expect(store.getHistoryLength()).toBe(3);

    expect(store.undo()).toBe(true);
    expect(store.getData().name).toBe('Two');
    expect(store.undo()).toBe(true);
    expect(store.getData().name).toBe('One');
    expect(store.canUndo()).toBe(false);
  });
});

describe('adoptHistory', () => {
  it('keeps the history bound when the cap dropped the entry the document is on', () => {
    // mergeHistory returns an array already AT the bound, so re-appending the
    // live document put it one over — and one over per merge, unbounded.
    store.setData({ name: 'local0' }, true, 'v-bound');
    for (let i = 1; i < MAX_HISTORY; i += 1) store.update('name', `local${i}`);
    expect(store.getHistoryLength()).toBe(MAX_HISTORY);

    // A full remote history, every entry newer than every local one, so the
    // union's cap drops the local side entirely — the current entry included.
    const stamp = (i) => new Date(Date.UTC(2126, 7, 1) + i * 60000).toISOString();
    expect(store.adoptHistory('v-bound', {
      history: Array.from({ length: MAX_HISTORY }, (_, i) => foreign(`theirs${i}`, stamp(i))),
      historyIndex: MAX_HISTORY - 1,
    })).toBe(true);

    expect(store.getHistoryLength()).toBe(MAX_HISTORY);
    expect(stored('v-bound').history).toHaveLength(MAX_HISTORY);
    // Whatever else history holds, it has to hold the live document — and the
    // index has to point at it.
    expect(store.getHistoryEntryData(store.getHistoryIndex())).toEqual(store.getData());
    expect(store.getData().name).toBe(`local${MAX_HISTORY - 1}`);
  });

  it('computes the current entry’s identity once, not once per entry scanned', () => {
    // entryIdentity canonical-serialises a whole résumé. Recomputing it inside
    // the findIndex callback did that up to MAX_HISTORY times per merge for a
    // value that cannot change.
    store.setData({ name: 'local0' }, true, 'v-identity');
    for (let i = 1; i < 20; i += 1) store.update('name', `local${i}`);

    // Older than every local entry, so the union puts all 30 ahead of the
    // current one and the scan has to walk past them to find it.
    const stamp = (i) => new Date(Date.UTC(2020, 0, 1) + i * 60000).toISOString();
    const remote = { history: Array.from({ length: 30 }, (_, i) => foreign(`theirs${i}`, stamp(i))), historyIndex: 29 };

    identity.calls = 0;
    expect(store.adoptHistory('v-identity', remote)).toBe(true);

    expect(store.getHistoryLength()).toBe(50);
    // One for the current entry, at most one per entry the scan visits.
    expect(identity.calls).toBeLessThanOrEqual(store.getHistoryLength() + 1);
  });
});

describe('setData', () => {
  it('re-points a loaded history whose current entry is another device’s', () => {
    // A history unit for a variant that is NOT open is merged straight into its
    // key with mergeHistory's index — the newest entry, which the union
    // routinely takes from the other device. Nothing there is a park, so the
    // old check passed, the dialog marked a remote entry current, and one edit
    // plus one Cmd+Z put that device's résumé on screen.
    disk.set(historyKey('v-repoint'), JSON.stringify({
      history: [
        { data: { name: 'Mine' }, timestamp: '2026-08-01T00:00:00.000Z', description: 'Edit', changeType: 'edit' },
        foreign('Theirs', '2026-08-02T00:00:00.000Z'),
      ],
      historyIndex: 1,
    }));

    store.setData({ name: 'Mine' }, true, 'v-repoint');

    expect(store.getHistoryEntryData(store.getHistoryIndex())).toEqual(store.getData());
    expect(store.getData().name).toBe('Mine');
    // Nothing sits after the index, so the next edit splices nothing away and
    // the merged entry survives.
    expect(store.canRedo()).toBe(false);

    store.update('name', 'Edited after opening');
    expect(store.undo()).toBe(true);
    expect(store.getData().name).toBe('Mine');
    expect(store.getHistoryLength()).toBe(4);
  });

  it('appends nothing when the loaded history already holds the document', () => {
    // The correction has to be rare: firing on an ordinary load would add an
    // entry to every résumé every time it was opened.
    store.setData({ name: 'A' }, true, 'v-reload');
    store.update('name', 'B');
    const before = disk.get(historyKey('v-reload'));

    store.setData({ name: 'B' }, true, 'v-reload');
    expect(store.getHistoryLength()).toBe(2);
    expect(disk.get(historyKey('v-reload'))).toBe(before);
  });

  it('does not re-point after a silent UI-only write, so one Cmd+Z still reaches the user’s own last state', () => {
    // The drift this exercises is LEGITIMATE and every user produces it:
    // store.updateSilent writes UI-only state — an experience accordion's
    // `_expanded` (StructurePanel's toggle) and `experienceSortMode` — into the
    // document and persists it with the next debounced save, deliberately
    // WITHOUT a history entry. So `data` and history[historyIndex].data differ
    // by design, and a load that treats that difference as a broken invariant
    // appends an 'Initial state' on every reopen: version history grows a bogus
    // 'Created' per session, and Cmd+Z spends its first press collapsing the
    // accordion instead of undoing the edit. Keep this condition on isOwnStep —
    // a parked loser or another device's entry — never on data equality.
    store.setData({ name: 'A', experience: [{ id: 'e1', title: 'Engineer' }] }, true, 'v-silent');
    store.update('name', 'B');
    store.updateSilent('experience[0]._expanded', true);
    expect(store.getHistoryLength()).toBe(2);

    // Quit and reopen: the document that was persisted carries the silent
    // write, the history key on disk is the two real entries.
    const persisted = store.getData();
    store.setData(persisted, true, 'v-silent');

    expect(store.getHistoryLength()).toBe(2);
    expect(names()).toEqual(['A', 'B']);
    expect(store.getHistoryEntries()[store.getHistoryIndex()].changeType).toBe('edit');
    expect(store.getData().experience[0]._expanded).toBe(true);

    // One press, and it lands on the user's own previous state — not on a
    // freshly minted 'Initial state' holding the document they can already see.
    expect(store.undo()).toBe(true);
    expect(store.getData().name).toBe('A');
    expect(store.canUndo()).toBe(false);
  });

  it('compares by content, so a document rebuilt in another key order is the same document', () => {
    // `data` is rebuilt by migrateSectionAreas on load, which writes its keys in
    // its own order. Comparing serialised text would call that a different
    // document and append a duplicate entry on every single load.
    store.setData({ name: 'A', tagline: 'T', sections: [{ id: 's1', title: 'Skills', content: [] }] }, true, 'v-order');
    expect(store.getHistoryLength()).toBe(1);

    store.setData({ sections: [{ title: 'Skills', content: [], id: 's1' }], tagline: 'T', name: 'A' }, true, 'v-order');
    expect(store.getHistoryLength()).toBe(1);
  });
});

describe('ordinary editing, with nothing synced', () => {
  it('undoes, redoes and truncates the future exactly as it always did', () => {
    store.setData({ name: 'A' }, true, 'v-plain');
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);

    store.update('name', 'B');
    store.update('name', 'C');
    store.update('name', 'D');
    expect(names()).toEqual(['A', 'B', 'C', 'D']);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);

    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.getData().name).toBe('B');
    expect(store.getHistoryIndex()).toBe(1);
    expect(store.canRedo()).toBe(true);

    expect(store.redo()).toBe(true);
    expect(store.getData().name).toBe('C');

    // An edit after an undo drops the redo future.
    store.update('name', 'E');
    expect(store.canRedo()).toBe(false);
    expect(store.redo()).toBe(false);
    expect(names()).toEqual(['A', 'B', 'C', 'E']);

    // And the floor still holds at the first state.
    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.getData().name).toBe('A');
    expect(store.getHistoryIndex()).toBe(0);
    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toBe(false);
    expect(store.getData().name).toBe('A');
  });

  it('walks every entry it wrote, because they are all this device’s own steps', () => {
    store.setData({ name: 'e0' }, true, 'v-walk');
    for (let i = 1; i <= 8; i += 1) store.update('name', `e${i}`);

    for (let i = 8; i > 0; i -= 1) {
      expect(store.getData().name).toBe(`e${i}`);
      expect(store.canUndo()).toBe(true);
      expect(store.undo()).toBe(true);
    }
    expect(store.getData().name).toBe('e0');
    for (let i = 1; i <= 8; i += 1) {
      expect(store.canRedo()).toBe(true);
      expect(store.redo()).toBe(true);
      expect(store.getData().name).toBe(`e${i}`);
    }
    expect(store.canRedo()).toBe(false);
  });
});
