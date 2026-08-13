/**
 * What each kind of version-history entry is called.
 *
 * Owned by neither of the two surfaces that show it. The web dialog pairs these
 * with lucide icons in `src/components/historyEntryTypes.js`; the native iOS
 * sheet pairs them with SF Symbols, chosen in `OPShell.swift`. So the LABELS
 * are shared and the icons are not — there is no drawing both can use.
 *
 * That asymmetry is why this file exists rather than iOS importing the icon
 * module. `src/iosShell.js` is the bridge, and it is deliberately free of
 * anything with a side effect: that is the property that lets every projection
 * in it be unit-tested without a DOM. Importing the icon module would drag
 * lucide-react — and React — into the bridge's graph to obtain strings it could
 * have had on their own.
 *
 * Same shape, and the same reason, as `src/historyLimits.js`.
 *
 * A change type missing from here renders as an ordinary 'Edit', which for an
 * entry that came off another device is simply untrue.
 */

/** changeType -> the name shown to a person. */
export const TYPE_LABELS = {
  initial: 'Created',
  edit: 'Edit',
  ai: 'AI change',
  import: 'Import',
  reorder: 'Reordered',
  add: 'Added',
  remove: 'Removed',
  // One of the two versions two devices held when both edited the same résumé.
  // The newer one won and this one was kept here rather than thrown away, so it
  // can still be restored — which is why it must not read as an ordinary edit.
  //
  // DIRECTION-NEUTRAL, and that is the load-bearing part. This used to read
  // "From another device", which is false in half of all conflicts: when the
  // remote copy is the newer one, the version parked here is THIS device's own
  // work — labelled as somebody else's in exactly the branch where the person
  // comes looking for what they lost. Carrying the direction across from the
  // transport would not fix it either, because the transport does not know
  // whose version it is: it knows which COPY lost, and the losing server copy
  // is very often this device's own earlier upload (any send that quotes no
  // change tag — the recovery path for a forfeited tag — meets the conflict
  // path against a record this device wrote itself). What is true of every
  // parked version either way is that two devices had the résumé and this is
  // the earlier of the two, which is also exactly what the iOS conflict notice
  // says (`conflictNoticeText` in OPShell.swift). Shown on both surfaces beside
  // a two-device icon, so "earlier" is not read as "any older entry".
  'sync-conflict': 'Earlier version',
};
