/**
 * How the version-history dialog names and illustrates each kind of entry.
 *
 * Beside HistoryDialog.jsx rather than inside it because the dialog is a
 * component file: sharing constants out of one costs Fast Refresh, and a test
 * has to be able to hold these maps and store.js's CHANGE_TYPES to each other.
 * A change type missing from them renders as an ordinary 'Edit' with a pencil,
 * which for an entry that came off another device is simply untrue.
 */
import {
  FileText, Pencil, Sparkles, Upload, ArrowUpDown, Plus, Minus, MonitorSmartphone,
} from 'lucide-react';

// changeType -> badge label.
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

// changeType -> lucide icon. 'edit' (Pencil) is the unknown-type fallback.
export const TYPE_ICONS = {
  initial: FileText,
  edit: Pencil,
  ai: Sparkles,
  import: Upload,
  reorder: ArrowUpDown,
  add: Plus,
  remove: Minus,
  'sync-conflict': MonitorSmartphone,
};
