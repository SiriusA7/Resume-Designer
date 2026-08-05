/**
 * The month-range vocabulary shared by the date picker and everything that
 * persists an experience date.
 *
 * Framework-free and top level on purpose: vitest covers only service modules
 * (`vitest.config.js` includes `test/**` and nothing under `src/components/**`),
 * so every rule worth proving has to live here rather than in the component.
 *
 * The strict parser and the ongoing vocabulary are IMPORTED from
 * experienceGroups.js rather than re-implemented. That is what guarantees the
 * writer and the run gate agree: anything this module emits, `interval()` can
 * read back.
 */
import { parseYearMonth, isOpenEnded } from './experienceGroups.js';

// Hardcoded, never toLocaleString. The formatted string is PERSISTED, so a
// locale-derived name would make the same profile serialise differently on
// different machines — and this app ships to macOS (WKWebView) and Windows
// (WebView2). A resume authored in one locale would render its dates in another.
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// En dash, matching the seeds in store.js (`'Start Date – End Date'`) and
// StructurePanel.jsx (`'Start – End'`).
export const RANGE_SEPARATOR = '–';

// Already in isOpenEnded's vocabulary, and already what the generation prompt
// asks the model for.
export const ONGOING_LABEL = 'Present';

function monthKey(month) {
  return month.year * 12 + month.month;
}

export function formatMonthYear(year, month) {
  const name = MONTH_NAMES[month - 1];
  if (!name || !Number.isInteger(year)) return '';
  return `${name} ${year}`;
}

/**
 * 'YYYY-MM' -> { year, month }, or null for anything the gate would refuse.
 * Derived by inverting parseYearMonth's comparable key rather than re-parsing,
 * so this can never accept a value interval() rejects.
 */
export function toMonth(value) {
  const key = parseYearMonth(value);
  if (key === null) return null;
  const year = Math.floor((key - 1) / 12);
  return { year, month: key - year * 12 };
}

export function formatMonthField(month) {
  return `${String(month.year).padStart(4, '0')}-${String(month.month).padStart(2, '0')}`;
}

/**
 * The picker's opening state for an entry. Reads ONLY the machine-readable
 * fields — never the display string. Recovering structure from prose is exactly
 * what the strict/lenient split documented in experienceGroups.js exists to
 * prevent, and a wrong guess here would be persisted.
 *
 * `freeform: true` means there is no readable pair, so the picker opens with
 * nothing selected and offers the existing text for editing.
 */
export function readEntryDates(entry) {
  const start = toMonth(entry?.startDate);
  const ongoing = isOpenEnded(entry?.endDate);
  const end = ongoing ? null : toMonth(entry?.endDate);
  if (start === null || (!ongoing && end === null)) {
    return { start: null, end: null, ongoing: false, freeform: true };
  }
  if (!ongoing && monthKey(end) < monthKey(start)) {
    return { start: null, end: null, ongoing: false, freeform: true };
  }
  return { start, end, ongoing, freeform: false };
}

/**
 * The atomic R1 write. Returns null for any draft that would persist half a
 * pair or a reversed range — the caller writes nothing rather than leaving the
 * machine fields disagreeing with the display string.
 */
export function buildDateFields(draft) {
  const start = draft?.start;
  if (!start) return null;
  const startLabel = formatMonthYear(start.year, start.month);
  if (draft.ongoing) {
    return {
      dates: `${startLabel} ${RANGE_SEPARATOR} ${ONGOING_LABEL}`,
      startDate: formatMonthField(start),
      endDate: ONGOING_LABEL,
    };
  }
  const end = draft.end;
  if (!end || monthKey(end) < monthKey(start)) return null;
  return {
    dates: `${startLabel} ${RANGE_SEPARATOR} ${formatMonthYear(end.year, end.month)}`,
    startDate: formatMonthField(start),
    endDate: formatMonthField(end),
  };
}

/**
 * The R2 write. A hand-edited display string beside a stale machine pair is a
 * contradiction, and the run gate would act on the stale half — so typing
 * returns the entry to unstructured, which interval() already handles by
 * failing closed.
 */
export function freeformDateFields(text) {
  return { dates: String(text ?? ''), startDate: '', endDate: '' };
}

/**
 * The exact interval, appended to an entry's line in the AI prompt so the model
 * copies it instead of inferring a month from prose. Empty for entries with no
 * readable pair, which then serialise exactly as they do today.
 */
export function formatIntervalHint(entry) {
  const { start, end, ongoing, freeform } = readEntryDates(entry);
  if (freeform) return '';
  return ` [${formatMonthField(start)} → ${ongoing ? 'present' : formatMonthField(end)}]`;
}
