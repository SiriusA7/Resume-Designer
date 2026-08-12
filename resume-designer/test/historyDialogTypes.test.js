import { describe, it, expect } from 'vitest';
import { TYPE_LABELS, TYPE_ICONS } from '../src/components/historyEntryTypes.js';
import { CHANGE_TYPES } from '../src/store.js';

// The version-history dialog labels each entry by its `changeType` and falls
// back to 'Edit' with a pencil for anything it does not know. A fallback is
// fine for a type that never reaches the list; it is a lie for one that does.
describe('the version-history dialog’s type labels', () => {
  it('names every change type the store can write', () => {
    for (const changeType of Object.values(CHANGE_TYPES)) {
      expect(TYPE_LABELS[changeType], changeType).toBeTruthy();
      expect(TYPE_ICONS[changeType], changeType).toBeTruthy();
    }
  });

  it('does not show another device’s rejected version as an edit made here', () => {
    // A parked conflict loser is a résumé another device had when both devices
    // edited the same one: the newer edit won, and this version was kept rather
    // than thrown away so it can be restored. Rendered as "Edit" with a pencil,
    // it claimed to be a change the user made on this machine.
    expect(TYPE_LABELS[CHANGE_TYPES.SYNC_CONFLICT]).not.toBe(TYPE_LABELS[CHANGE_TYPES.EDIT]);
    expect(TYPE_ICONS[CHANGE_TYPES.SYNC_CONFLICT]).not.toBe(TYPE_ICONS[CHANGE_TYPES.EDIT]);
    expect(TYPE_LABELS[CHANGE_TYPES.SYNC_CONFLICT]).toMatch(/device/i);
  });
});
