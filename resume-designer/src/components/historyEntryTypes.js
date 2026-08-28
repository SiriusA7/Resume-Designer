/**
 * How the version-history dialog illustrates each kind of entry.
 *
 * Beside HistoryDialog.jsx rather than inside it because the dialog is a
 * component file: sharing constants out of one costs Fast Refresh, and a test
 * has to be able to hold these maps and store.js's CHANGE_TYPES to each other.
 * A change type missing from them renders as an ordinary 'Edit' with a pencil,
 * which for an entry that came off another device is simply untrue.
 *
 * The LABELS live one level up in `src/historyEntryLabels.js` and are only
 * re-exported here, so this file stays the single import for the dialog. They
 * are shared with the native iOS sheet, which draws SF Symbols and must not
 * pull lucide-react — and React — into the bridge's module graph to obtain a
 * handful of strings. That file carries the whole argument.
 */
import {
  FileText, Pencil, Sparkles, Upload, ArrowUpDown, Plus, Minus, MonitorSmartphone,
} from 'lucide-react';

export { TYPE_LABELS } from '../historyEntryLabels.js';

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
