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
  // A version another device had when both devices edited the same résumé. The
  // newer edit won and this one was kept here rather than thrown away, so it
  // can still be restored — which is exactly why it must not read as an edit
  // made on this machine.
  'sync-conflict': 'From another device',
};
