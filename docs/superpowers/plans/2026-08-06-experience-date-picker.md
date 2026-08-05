# Experience Date Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace freeform experience-date text with a month-range picker on all three date-editing surfaces, writing machine-readable `startDate`/`endDate` alongside the display string.

**Architecture:** A framework-free core module (`src/experienceDates.js`) owns every parsing and formatting rule, because vitest covers only service modules. One React control built on the real shadcn `Popover` serves all three surfaces; the rendered résumé reaches it through a `CustomEvent` bridge so `inlineEditor.js` stays free of React, exactly as `confirmDestructive`/`ConfirmHost` already do.

**Tech Stack:** React 19, Vite, plain JavaScript (no TypeScript), Tailwind 3 + shadcn/ui (Radix Popover), vitest + jsdom.

Spec: [docs/superpowers/specs/2026-08-06-experience-date-picker-design.md](../specs/2026-08-06-experience-date-picker-design.md)

## Global Constraints

- **Plain JavaScript only.** `.js` / `.jsx`. No TypeScript, no type annotations.
- **Separator is the en dash `–`** (U+2013), matching the seeds in `store.js` and `StructurePanel.jsx`. Never a hyphen.
- **Ongoing is the literal string `Present`**, capital P.
- **Month names come from a hardcoded table, never `toLocaleString`.** The formatted string is persisted; a locale-derived name would serialise the same profile differently on macOS (WKWebView) and Windows (WebView2).
- **R1 — a date write sets `dates`, `startDate` and `endDate` together**, in one store write. Never three separate scalar updates.
- **R2 — any freeform edit to `dates` clears `startDate` and `endDate`.** A hand-edited display string beside a stale machine value is a contradiction the grouping gate would act on.
- **`startDate`/`endDate` are never AI-addressable.** Only `experience[i].dates` stays in the path grammar, matching `_groupId`.
- **Never rename** the bundle identifier `com.resumedesigner.app`, any `resume-designer-*` storage key, the `resume-designer/` directory, the repo slug, or `name = "resume-designer"` in `Cargo.toml`.
- **Never sweep on the bare string `resume-`** — it also names the `.resume-page` / `.resume-sidebar` CSS classes that pagination and PDF page-splitting depend on.
- **Conventional commits, lowercase subject** (`feat(dates): …`). CI lints every commit in the PR.
- **`src/components/ui/` is shadcn primitives only.** New app-level components go in `src/components/experience/`.
- Run all commands from `resume-designer/`.

## File Structure

| File | Responsibility |
|---|---|
| `src/experienceGroups.js` *(modify)* | Gains two additive `export` keywords so the picker and the run gate share one parser and one ongoing-vocabulary |
| `src/experienceDates.js` *(create)* | Framework-free core: read an entry's interval, build the three-field write, format for display and for the prompt |
| `test/experienceDates.test.js` *(create)* | Proves every rule above, including that the writer's output satisfies the gate |
| `src/components/experience/ExperienceDateField.jsx` *(create)* | The control: `ExperienceDatePanel` (the guts) plus `ExperienceDateField` (trigger + popover) |
| `src/components/experience/ExperienceDateEditorHost.jsx` *(create)* | Singleton bridging the vanilla inline editor to the React panel; owns the résumé-side store write |
| `src/components/profile/ProfileTabs.jsx` *(modify)* | `RoleSubCard` and `SoloJobCard` use the field |
| `src/components/structure/StructurePanel.jsx` *(modify)* | The `dates` `Field` becomes the picker |
| `src/inlineEditor.js` *(modify)* | Intercepts clicks on `experience[N].dates`; suppresses the AI button while the picker is open |
| `src/App.jsx` *(modify)* | Mounts the host |
| `src/aiService.js` *(modify)* | Both profile serialisers emit the exact interval |

---

### Task 1: Core date module

**Files:**
- Modify: `resume-designer/src/experienceGroups.js:77` and `:88` (add `export` to two existing functions)
- Create: `resume-designer/src/experienceDates.js`
- Test: `resume-designer/test/experienceDates.test.js`

**Interfaces:**
- Consumes: `parseYearMonth(value)` and `isOpenEnded(value)` from `src/experienceGroups.js` — currently module-private, made public by this task. `parseYearMonth` returns `year * 12 + month` for a strict `"YYYY-MM"` (an optional trailing day tolerated), else `null`.
- Produces, all from `src/experienceDates.js`:
  - `MONTH_NAMES` — `string[12]`, `['Jan', …, 'Dec']`
  - `RANGE_SEPARATOR` — `'–'`
  - `ONGOING_LABEL` — `'Present'`
  - `formatMonthYear(year, month)` → `'Jan 2020'` or `''`
  - `toMonth(value)` → `{ year, month }` or `null`
  - `formatMonthField(month)` → `'2020-01'`
  - `readEntryDates(entry)` → `{ start: Month|null, end: Month|null, ongoing: boolean, freeform: boolean }`
  - `buildDateFields(draft)` → `{ dates, startDate, endDate }` or `null`
  - `freeformDateFields(text)` → `{ dates, startDate: '', endDate: '' }`
  - `formatIntervalHint(entry)` → `' [2020-01 → 2022-03]'`, `' [2020-01 → present]'`, or `''`

Where `Month` is `{ year: number, month: number }` with `month` in 1–12, and a `draft` is `{ start: Month|null, end: Month|null, ongoing: boolean }`.

- [ ] **Step 1: Make the shared parser and vocabulary public**

In `resume-designer/src/experienceGroups.js`, add the `export` keyword to two existing functions. Change **nothing else** — not the regex, not the vocabulary, not the doc comments. Loosening `parseYearMonth` is explicitly forbidden by the comment above it.

Line 77, from:

```js
function parseYearMonth(value) {
```

to:

```js
export function parseYearMonth(value) {
```

Line 88, from:

```js
function isOpenEnded(value) {
```

to:

```js
export function isOpenEnded(value) {
```

- [ ] **Step 2: Write the failing test**

Create `resume-designer/test/experienceDates.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  MONTH_NAMES, RANGE_SEPARATOR, ONGOING_LABEL,
  formatMonthYear, toMonth, formatMonthField,
  readEntryDates, buildDateFields, freeformDateFields, formatIntervalHint,
} from '../src/experienceDates.js';
import { datesAreContinuous } from '../src/experienceGroups.js';

describe('formatMonthYear', () => {
  it('formats from the hardcoded table, not the host locale', () => {
    expect(formatMonthYear(2020, 1)).toBe('Jan 2020');
    expect(formatMonthYear(2020, 12)).toBe('Dec 2020');
  });

  it('returns empty for an out-of-range month', () => {
    expect(formatMonthYear(2020, 0)).toBe('');
    expect(formatMonthYear(2020, 13)).toBe('');
  });

  it('exposes exactly twelve month names', () => {
    expect(MONTH_NAMES).toHaveLength(12);
  });
});

describe('toMonth', () => {
  it('reads a strict YYYY-MM', () => {
    expect(toMonth('2020-01')).toEqual({ year: 2020, month: 1 });
  });

  it('round-trips December, the boundary the year arithmetic gets wrong', () => {
    expect(toMonth('2020-12')).toEqual({ year: 2020, month: 12 });
    expect(toMonth('2021-01')).toEqual({ year: 2021, month: 1 });
  });

  it('refuses anything that is not YYYY-MM', () => {
    expect(toMonth('2020')).toBeNull();
    expect(toMonth('Jan 2020')).toBeNull();
    expect(toMonth('2020-13')).toBeNull();
    expect(toMonth('Present')).toBeNull();
    expect(toMonth(undefined)).toBeNull();
  });

  it('is the exact inverse of formatMonthField', () => {
    expect(formatMonthField({ year: 2020, month: 3 })).toBe('2020-03');
    expect(toMonth(formatMonthField({ year: 1999, month: 11 }))).toEqual({ year: 1999, month: 11 });
  });
});

describe('readEntryDates', () => {
  it('reads a closed structured range', () => {
    expect(readEntryDates({ startDate: '2020-01', endDate: '2022-03' })).toEqual({
      start: { year: 2020, month: 1 }, end: { year: 2022, month: 3 }, ongoing: false, freeform: false,
    });
  });

  it('reads an ongoing range', () => {
    expect(readEntryDates({ startDate: '2020-01', endDate: 'Present' })).toEqual({
      start: { year: 2020, month: 1 }, end: null, ongoing: true, freeform: false,
    });
  });

  it('reports freeform when the pair is missing or unreadable', () => {
    expect(readEntryDates({ dates: 'Summer 2019' }).freeform).toBe(true);
    expect(readEntryDates({ startDate: '2019', endDate: '2021' }).freeform).toBe(true);
  });

  it('reports freeform for a half pair rather than a lone start', () => {
    expect(readEntryDates({ startDate: '2020-01' }).freeform).toBe(true);
  });

  it('never recovers a month from the display string', () => {
    expect(readEntryDates({ dates: 'Jan 2020 – Mar 2022' }).freeform).toBe(true);
  });
});

describe('buildDateFields', () => {
  it('writes all three fields for a closed range', () => {
    expect(buildDateFields({ start: { year: 2020, month: 1 }, end: { year: 2022, month: 3 }, ongoing: false })).toEqual({
      dates: `Jan 2020 ${RANGE_SEPARATOR} Mar 2022`, startDate: '2020-01', endDate: '2022-03',
    });
  });

  it('writes the ongoing label rather than a month', () => {
    expect(buildDateFields({ start: { year: 2020, month: 1 }, end: null, ongoing: true })).toEqual({
      dates: `Jan 2020 ${RANGE_SEPARATOR} ${ONGOING_LABEL}`, startDate: '2020-01', endDate: ONGOING_LABEL,
    });
  });

  it('uses an en dash, not a hyphen', () => {
    const built = buildDateFields({ start: { year: 2020, month: 1 }, end: null, ongoing: true });
    expect(built.dates).toContain('–');
    expect(built.dates).not.toContain(' - ');
  });

  it('returns null rather than writing half a pair', () => {
    expect(buildDateFields({ start: { year: 2020, month: 1 }, end: null, ongoing: false })).toBeNull();
    expect(buildDateFields({ start: null, end: { year: 2022, month: 3 }, ongoing: false })).toBeNull();
    expect(buildDateFields(null)).toBeNull();
  });

  it('refuses a reversed range, which interval() would reject anyway', () => {
    expect(buildDateFields({ start: { year: 2022, month: 3 }, end: { year: 2020, month: 1 }, ongoing: false })).toBeNull();
  });

  it('allows a single-month range', () => {
    const built = buildDateFields({ start: { year: 2020, month: 6 }, end: { year: 2020, month: 6 }, ongoing: false });
    expect(built.startDate).toBe('2020-06');
    expect(built.endDate).toBe('2020-06');
  });
});

describe('freeformDateFields', () => {
  it('keeps the text and clears the machine-readable pair (R2)', () => {
    expect(freeformDateFields('Summer 2019')).toEqual({ dates: 'Summer 2019', startDate: '', endDate: '' });
  });

  it('coerces a nullish value to an empty string', () => {
    expect(freeformDateFields(undefined)).toEqual({ dates: '', startDate: '', endDate: '' });
  });
});

// The point of the whole feature: what the picker writes must be readable by
// the gate that decides whether two roles are one tenure.
describe('agreement with the run gate', () => {
  const built = (sy, sm, ey, em) => buildDateFields({
    start: { year: sy, month: sm },
    end: ey === null ? null : { year: ey, month: em },
    ongoing: ey === null,
  });

  it('treats immediate succession as one continuous tenure', () => {
    expect(datesAreContinuous(built(2019, 1, 2021, 6), built(2021, 7, null))).toBe(true);
  });

  it('treats a real gap as a separate stint', () => {
    expect(datesAreContinuous(built(2015, 1, 2018, 6), built(2021, 3, null))).toBe(false);
  });

  it('leaves a freeform entry unjoinable', () => {
    expect(datesAreContinuous(built(2019, 1, 2021, 6), freeformDateFields('2021 – 2024'))).toBe(false);
  });
});

describe('formatIntervalHint', () => {
  it('emits the closed interval', () => {
    expect(formatIntervalHint({ startDate: '2020-01', endDate: '2022-03' })).toBe(' [2020-01 → 2022-03]');
  });

  it('emits a lowercase present for an ongoing role', () => {
    expect(formatIntervalHint({ startDate: '2020-01', endDate: 'Present' })).toBe(' [2020-01 → present]');
  });

  it('emits nothing for a freeform entry', () => {
    expect(formatIntervalHint({ dates: 'Summer 2019' })).toBe('');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run test/experienceDates.test.js
```

Expected: FAIL — `Failed to resolve import "../src/experienceDates.js"`.

- [ ] **Step 4: Write the module**

Create `resume-designer/src/experienceDates.js`:

```js
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
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run test/experienceDates.test.js
```

Expected: PASS, all cases green.

- [ ] **Step 6: Run the full suite — the two new exports touch a shared module**

```bash
npm run test
```

Expected: PASS, no regressions. `test/experienceGroups.test.js` must still be green.

- [ ] **Step 7: Commit**

```bash
git add src/experienceGroups.js src/experienceDates.js test/experienceDates.test.js
git commit -m "feat(dates): add a month-range core shared with the run gate"
```

---

### Task 2: The control, wired into the Profile tab

**Files:**
- Create: `resume-designer/src/components/experience/ExperienceDateField.jsx`
- Modify: `resume-designer/src/components/profile/ProfileTabs.jsx` — `RoleSubCard` (~line 300), `SoloJobCard` (~line 435), `ExperienceTab` (~line 462)

**Interfaces:**
- Consumes: everything Task 1 produced from `src/experienceDates.js`.
- Produces:
  - `ExperienceDatePanel({ entry, onCommit })` — named export. The popover guts. Calls `onCommit(fields)` exactly once, when a selection completes or freeform text is submitted. `fields` is the `{ dates, startDate, endDate }` object from `buildDateFields` or `freeformDateFields`.
  - `ExperienceDateField({ entry, onCommit, placeholder })` — default export. Trigger + popover. Closes itself before calling `onCommit`.

- [ ] **Step 1: Write the control**

Create `resume-designer/src/components/experience/ExperienceDateField.jsx`:

```jsx
import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  MONTH_NAMES, buildDateFields, freeformDateFields, readEntryDates,
} from '../../experienceDates.js';

// Twelve months in a 3-column grid, with a year stepper above. Deliberately NOT
// shadcn's Calendar: that is a day grid (and would pull in react-day-picker),
// while resume dates are month-granular. Popover, Button, Input and Separator
// are the real primitives; this grid is app-level composition on top of them.
function MonthGrid({ label, year, onYearChange, selected, isDisabled, onPick }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 text-[11.5px] font-medium text-muted-foreground">{label}</div>
      <div className="mb-2 flex items-center justify-between">
        <Button
          type="button" variant="ghost" size="icon" className="size-6"
          aria-label={`Previous year, ${label.toLowerCase()}`}
          onClick={() => onYearChange(year - 1)}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <span className="text-[13px] font-medium tabular-nums">{year}</span>
        <Button
          type="button" variant="ghost" size="icon" className="size-6"
          aria-label={`Next year, ${label.toLowerCase()}`}
          onClick={() => onYearChange(year + 1)}
        >
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {MONTH_NAMES.map((name, i) => {
          const month = i + 1;
          const disabled = isDisabled(year, month);
          const active = !!selected && selected.year === year && selected.month === month;
          return (
            <button
              key={name}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onPick({ year, month })}
              className={cn(
                'rounded-[6px] px-1 py-1 text-[12px] transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent',
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The popover guts. Holds a DRAFT and commits once, because every store write
 * re-renders and re-paginates the resume — writing through on each click would
 * destroy the node this popover is anchored to mid-interaction.
 *
 * Selecting a start always clears the end, the way range pickers conventionally
 * restart a selection, so editing an existing range never commits prematurely.
 * Closing without completing a selection commits nothing: buildDateFields
 * refuses a half pair, and a half pair is exactly the contradiction R2 exists
 * to prevent.
 */
export function ExperienceDatePanel({ entry, onCommit }) {
  const initial = readEntryDates(entry);
  const thisYear = new Date().getFullYear();
  const [draft, setDraft] = useState({ start: initial.start, end: initial.end, ongoing: initial.ongoing });
  // Controlled, unlike the resume-data inputs elsewhere in the app: this is
  // draft state inside a popover, not a store-backed field being typed into.
  const [text, setText] = useState(entry?.dates || '');
  const [startYear, setStartYear] = useState(initial.start?.year ?? thisYear);
  const [endYear, setEndYear] = useState(initial.end?.year ?? initial.start?.year ?? thisYear);

  const commit = (next) => {
    const fields = buildDateFields(next);
    if (fields) onCommit(fields);
  };

  const pickStart = (month) => {
    const next = { start: month, end: null, ongoing: draft.ongoing };
    setDraft(next);
    setEndYear(month.year);
    if (next.ongoing) commit(next);
  };

  const pickEnd = (month) => {
    const next = { ...draft, end: month, ongoing: false };
    setDraft(next);
    commit(next);
  };

  const toggleOngoing = () => {
    const next = draft.ongoing
      ? { ...draft, ongoing: false }
      : { ...draft, ongoing: true, end: null };
    setDraft(next);
    if (next.ongoing) commit(next);
  };

  const startKey = draft.start ? draft.start.year * 12 + draft.start.month : null;

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <MonthGrid
          label="Start" year={startYear} onYearChange={setStartYear}
          selected={draft.start} isDisabled={() => false} onPick={pickStart}
        />
        <Separator orientation="vertical" className="h-auto" />
        <div className="min-w-0 flex-1">
          <Button
            type="button"
            variant={draft.ongoing ? 'default' : 'outline'}
            size="sm"
            className="mb-2 h-7 w-full text-[12px]"
            aria-pressed={draft.ongoing}
            onClick={toggleOngoing}
          >
            Present
          </Button>
          {!draft.ongoing && (
            <MonthGrid
              label="End" year={endYear} onYearChange={setEndYear}
              selected={draft.end}
              // A reversed range makes interval() return null, so the picker
              // must not be able to produce one.
              isDisabled={(y, m) => startKey !== null && y * 12 + m < startKey}
              onPick={pickEnd}
            />
          )}
        </div>
      </div>
      <Separator />
      <div className="space-y-1.5">
        <div className="text-[11.5px] text-muted-foreground">Or type it</div>
        <Input
          className="h-8 text-[12.5px]"
          placeholder="Summer 2019"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            onCommit(freeformDateFields(text));
          }}
        />
        <div className="text-[11px] text-muted-foreground">Press Enter to use this text</div>
      </div>
    </div>
  );
}

export default function ExperienceDateField({ entry, onCommit, placeholder = 'Add dates' }) {
  const [open, setOpen] = useState(false);
  // Close first, then write: the commit re-renders the surface this trigger
  // lives on, and an open popover would be left anchored to a replaced node.
  const handleCommit = (fields) => {
    setOpen(false);
    onCommit(fields);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-between font-normal">
          <span className={cn('truncate', !entry?.dates && 'text-muted-foreground')}>
            {entry?.dates || placeholder}
          </span>
          <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      {/* PopoverContent has no forceMount, so Radix unmounts it on close and the
          panel re-seeds its draft from the entry on every open. */}
      <PopoverContent className="w-[320px]" align="start">
        <ExperienceDatePanel entry={entry} onCommit={handleCommit} />
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Verify it parses**

```bash
npx vite build
```

Expected: exit 0. This is the only automated proof the JSX parses — vitest never loads `src/components/**`.

- [ ] **Step 3: Add the three-field writer to `ExperienceTab`**

In `resume-designer/src/components/profile/ProfileTabs.jsx`, add the import beside the existing component imports:

```jsx
import ExperienceDateField from '../experience/ExperienceDateField.jsx';
```

Then, inside `ExperienceTab` (around line 464), immediately after the existing `set` definition:

```js
  const set = (i, field) => (v) => { items[i][field] = v; scheduleSave(); };
```

add:

```js
  // Dates write THREE fields at once (the display string plus the
  // machine-readable pair), so this cannot go through `set`, which writes one.
  // The local bump re-renders the tab so the trigger label updates; it must NOT
  // be `refresh`, which bumps the parent's `version` — the tab wrapper's React
  // key — and would remount the tab mid-interaction.
  const setDates = (i) => (fields) => { Object.assign(items[i], fields); scheduleSave(); bumpGrouping(); };
```

- [ ] **Step 4: Use the field in `RoleSubCard`**

In `RoleSubCard`, add `setDates` to the destructured props:

```jsx
function RoleSubCard({ exp, index, set, setDates, onDelete, onDetach, canDetach }) {
```

and replace the dates `Input` (lines 300-304) — from:

```jsx
      <Input
        placeholder="Dates (e.g., Jan 2020 - Present)"
        defaultValue={exp.dates || ''}
        onChange={(e) => set(index, 'dates')(e.target.value)}
      />
```

to:

```jsx
      <ExperienceDateField entry={exp} onCommit={setDates(index)} />
```

- [ ] **Step 5: Use the field in `SoloJobCard`**

In `SoloJobCard`, add `setDates` to the destructured props the same way, and replace the dates `Input` (lines 435-439) — from:

```jsx
      <Input
        placeholder="Dates (e.g., Jan 2020 - Present)"
        defaultValue={exp.dates || ''}
        onChange={(e) => set(index, 'dates')(e.target.value)}
      />
```

to:

```jsx
      <ExperienceDateField entry={exp} onCommit={setDates(index)} />
```

- [ ] **Step 6: Pass `setDates` down from `ExperienceTab`**

Find every `<RoleSubCard` and `<SoloJobCard` JSX usage inside `ExperienceTab` and add the prop beside the existing `set={set}`:

```jsx
        set={set}
        setDates={setDates}
```

- [ ] **Step 7: Verify the build and the suite**

```bash
npx vite build && npm run test
```

Expected: build exit 0; tests PASS with no regressions.

- [ ] **Step 8: Confirm no orphaned import**

```bash
grep -n "Input" src/components/profile/ProfileTabs.jsx | head -5
```

Expected: `Input` is still used (company, job title and the education fields), so its import stays. If the grep shows the import alone with no usages, remove the import.

- [ ] **Step 9: Commit**

```bash
git add src/components/experience/ExperienceDateField.jsx src/components/profile/ProfileTabs.jsx
git commit -m "feat(profile): pick experience dates from a month range"
```

---

### Task 3: Structure panel

**Files:**
- Modify: `resume-designer/src/components/structure/StructurePanel.jsx` — near `writeField` (~line 73) and the experience field map (~line 365)

**Interfaces:**
- Consumes: `ExperienceDateField` (default export) from `src/components/experience/ExperienceDateField.jsx`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the import**

In `resume-designer/src/components/structure/StructurePanel.jsx`, beside the other component imports:

```jsx
import ExperienceDateField from '../experience/ExperienceDateField.jsx';
```

- [ ] **Step 2: Add the three-field writer**

Immediately after the existing `writeField` function (line 73-76):

```js
function writeField(path, value) {
  localEdit = true;
  try { store.update(path, value); } finally { localEdit = false; }
}
```

add:

```js
// Dates write three fields at once, so this cannot use writeField, which takes
// one path. One array write is one undo step and one re-render, matching the
// company-rename fan-out in inlineEditor.js. No `localEdit` guard: that exists
// to keep an uncontrolled input's caret while typing, and this writes on a
// popover commit, where a full re-render is exactly what we want.
function writeExperienceDates(index, fields) {
  const experience = store.get('experience');
  if (!Array.isArray(experience) || !experience[index]) return;
  const next = experience.map((entry, i) => (i === index ? { ...entry, ...fields } : entry));
  store.setChangeMetadata('Edited dates');
  store.update('experience', next);
}
```

- [ ] **Step 3: Take `dates` out of the generic field map**

At line 365, change the mapped list from:

```jsx
        {[['title', 'Job title'], ['company', 'Company'], ['dates', 'Dates']].map(([f, label]) => (
```

to:

```jsx
        {[['title', 'Job title'], ['company', 'Company']].map(([f, label]) => (
```

- [ ] **Step 4: Render the picker after the map**

Immediately after the closing `))}` of that map and before the `<div className="space-y-1.5">` that holds the Bullets label, insert:

```jsx
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Dates</Label>
          <ExperienceDateField entry={exp} onCommit={(fields) => writeExperienceDates(index, fields)} />
        </div>
```

- [ ] **Step 5: Verify the build and the suite**

```bash
npx vite build && npm run test
```

Expected: build exit 0; tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/structure/StructurePanel.jsx
git commit -m "feat(structure): pick experience dates from a month range"
```

---

### Task 4: The rendered résumé

This is the surface that can regress the pagination and PDF work already on this branch. Every constraint below exists for a reason recorded in the spec.

**Files:**
- Create: `resume-designer/src/components/experience/ExperienceDateEditorHost.jsx`
- Modify: `resume-designer/src/inlineEditor.js` — `handleClick` (~line 732), `showAIButton` (~line 640), `initInlineEditor` (~line 27)
- Modify: `resume-designer/src/App.jsx` — the host list (~line 102)

**Interfaces:**
- Consumes: `ExperienceDatePanel` (named export) from `src/components/experience/ExperienceDateField.jsx`; `store` from `src/store.js`.
- Produces: three `window` CustomEvents forming the bridge —
  - `rd:edit-dates` — vanilla → host. `detail: { path: 'experience[3].dates', rect: { top, left, width, height } }`
  - `rd:close-date-editor` — vanilla → host, no detail. Sent when the résumé scrolls or the window resizes.
  - `rd:date-editor-closed` — host → vanilla, no detail. Clears the AI-button suppression.

- [ ] **Step 1: Write the host**

Create `resume-designer/src/components/experience/ExperienceDateEditorHost.jsx`:

```jsx
import { useEffect, useState } from 'react';

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { store } from '../../store.js';
import { ExperienceDatePanel } from './ExperienceDateField.jsx';

/**
 * Bridges the vanilla inline editor to the React date panel.
 *
 * inlineEditor.js is a framework-free service module and stays that way: it
 * dispatches a CustomEvent and this host, mounted once in App, does the
 * rendering and the store write. That is the same hole confirmDestructive /
 * ConfirmHost already use.
 *
 * The popover is a Radix portal at document.body, so it is never a DOM child of
 * the resume. That matters twice over: pagination rebuilds the resume with
 * replaceChildren (a nested overlay would be destroyed on the next repaginate),
 * and it keeps the panel out of PDF capture. It also means clicks inside the
 * panel never reach inlineEditor's click listener, which is bound to #resume —
 * so no explicit exclusion is needed the way .editable-ai-container needs one.
 */
export function ExperienceDateEditorHost() {
  const [target, setTarget] = useState(null);

  useEffect(() => {
    const onOpen = (e) => setTarget(e.detail);
    const onClose = () => setTarget(null);
    window.addEventListener('rd:edit-dates', onOpen);
    window.addEventListener('rd:close-date-editor', onClose);
    return () => {
      window.removeEventListener('rd:edit-dates', onOpen);
      window.removeEventListener('rd:close-date-editor', onClose);
    };
  }, []);

  // Tell the vanilla side the picker is gone, whatever closed it — commit,
  // Escape, or a click outside — so the AI button becomes available again.
  useEffect(() => {
    if (target) return;
    window.dispatchEvent(new Event('rd:date-editor-closed'));
  }, [target]);

  if (!target) return null;

  const match = /^experience\[(\d+)\]\.dates$/.exec(target.path);
  const index = match ? Number(match[1]) : -1;
  const experience = store.get('experience');
  const entry = Array.isArray(experience) ? experience[index] : null;
  if (!entry) return null;

  // One array write with all three fields set — the company-rename precedent —
  // not three separate scalar updates. Close BEFORE writing: the update
  // re-renders and re-paginates the resume, replacing the node we are anchored
  // to.
  const commit = (fields) => {
    setTarget(null);
    const next = experience.map((it, i) => (i === index ? { ...it, ...fields } : it));
    store.setChangeMetadata('Edited dates');
    store.update('experience', next);
  };

  const { top, left, width, height } = target.rect;

  return (
    <Popover open onOpenChange={(open) => { if (!open) setTarget(null); }}>
      {/* A zero-interaction stand-in for the resume's date node, placed at the
          rect captured on click. pointerEvents: none so it never intercepts a
          click meant for the text underneath. */}
      <PopoverAnchor asChild>
        <div style={{ position: 'fixed', top, left, width, height, pointerEvents: 'none' }} />
      </PopoverAnchor>
      <PopoverContent className="w-[320px]" align="start">
        <ExperienceDatePanel entry={entry} onCommit={commit} />
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Intercept the click in the inline editor**

In `resume-designer/src/inlineEditor.js`, replace `handleClick` (lines 732-745) — from:

```js
function handleClick(e) {
  // Don't start editing if clicking on the AI container/menu
  if (e.target.closest('.editable-ai-container') || e.target.closest('.editable-ai-menu')) {
    return;
  }
  
  const editable = e.target.closest('[data-editable]');
  if (!editable) return;
  
  // Don't start editing if already editing
  if (editable.isContentEditable) return;
  
  startEditing(editable);
}
```

to:

```js
function handleClick(e) {
  // Don't start editing if clicking on the AI container/menu
  if (e.target.closest('.editable-ai-container') || e.target.closest('.editable-ai-menu')) {
    return;
  }
  
  const editable = e.target.closest('[data-editable]');
  if (!editable) return;
  
  // Don't start editing if already editing
  if (editable.isContentEditable) return;

  // Dates open a month-range picker instead of a contenteditable, so the
  // machine-readable startDate/endDate stay in step with the display string.
  // This module stays free of React: it dispatches, and a host mounted in App
  // renders the panel and performs the store write — the same arrangement
  // confirmDestructive uses. Both renderer variants carry this path (the <time>
  // in the default layout and the <span> in the timeline one).
  const path = editable.dataset.editable;
  if (/^experience\[\d+\]\.dates$/.test(path)) {
    // Commit any contenteditable still open, or its blur would land after ours.
    if (activeElement) finishEditing(activeElement);
    hideAIButton();
    dateEditorOpen = true;
    const rect = editable.getBoundingClientRect();
    window.dispatchEvent(new CustomEvent('rd:edit-dates', {
      detail: { path, rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } },
    }));
    return;
  }

  startEditing(editable);
}
```

- [ ] **Step 3: Add the suppression flag and its listener**

In `resume-designer/src/inlineEditor.js`, add a module-level declaration beside the other module state near the top of the file (above `initInlineEditor`):

```js
// True while the month-range picker is open. The AI button is fixed-position
// like the picker, so without this it paints over the panel when the pointer
// crosses the resume on its way there.
let dateEditorOpen = false;
```

Inside `initInlineEditor`, after the existing `resumeContainer.addEventListener('mouseout', handleMouseOut, true);` line:

```js
  window.addEventListener('rd:date-editor-closed', () => { dateEditorOpen = false; });
```

- [ ] **Step 4: Honour the flag in `showAIButton`**

In `showAIButton` (line 640), change the guard — from:

```js
function showAIButton(element) {
  if (!aiButton || !element) return;
```

to:

```js
function showAIButton(element) {
  if (!aiButton || !element || dateEditorOpen) return;
```

- [ ] **Step 5: Close the picker when the résumé scrolls**

The panel must never orphan at a stale coordinate — the anchor is a fixed rect captured on click, and scrolling invalidates it. Replace `handleResumeScroll` (lines 624-629) — from:

```js
function handleResumeScroll() {
  if (hoveredElement || isMenuVisible) {
    hideAIButton();
    hoveredElement = null;
  }
}
```

to:

```js
function handleResumeScroll() {
  // The picker is anchored to a rect captured at click time, so a scroll leaves
  // it floating over unrelated content. Close it, the way the AI button hides.
  if (dateEditorOpen) window.dispatchEvent(new Event('rd:close-date-editor'));
  if (hoveredElement || isMenuVisible) {
    hideAIButton();
    hoveredElement = null;
  }
}
```

- [ ] **Step 6: Mount the host**

In `resume-designer/src/App.jsx`, add the import beside the other host imports:

```jsx
import { ExperienceDateEditorHost } from './components/experience/ExperienceDateEditorHost.jsx';
```

and add it to the host list, after `<ConfirmHost />`:

```jsx
      <ConfirmHost />
      <ExperienceDateEditorHost />
```

- [ ] **Step 7: Verify the build and the suite**

```bash
npx vite build && npm run test
```

Expected: build exit 0; tests PASS.

- [ ] **Step 8: Confirm the interception is the only behaviour change to the click path**

```bash
git diff src/inlineEditor.js
```

Expected: only the additions above. `startEditing`, `finishEditing`, `extractEditedValue` and the tool-chip handling must be untouched — an entry with no structured dates still round-trips through `dates` exactly as before.

- [ ] **Step 9: Commit**

```bash
git add src/components/experience/ExperienceDateEditorHost.jsx src/inlineEditor.js src/App.jsx
git commit -m "feat(inline): pick experience dates from the rendered page"
```

---

### Task 5: Generation prompt

**Files:**
- Modify: `resume-designer/src/aiService.js` — the generation serialiser (~lines 664-680), `getUserProfileContext` (~line 761) and its serialiser (~lines 807-826)
- Test: `resume-designer/test/profileContextDates.test.js`

**Interfaces:**
- Consumes: `formatIntervalHint(entry)` from `src/experienceDates.js`.
- Produces: `getUserProfileContext(profile)` becomes an export taking an optional profile, defaulting to the stored one.

- [ ] **Step 1: Write the failing test**

Create `resume-designer/test/profileContextDates.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { getUserProfileContext } from '../src/aiService.js';

const profile = {
  workExperience: [
    { title: 'Senior Engineer', company: 'Acme', dates: 'Jan 2020 – Present', startDate: '2020-01', endDate: 'Present', details: 'Led the platform team.' },
    { title: 'Consultant', company: 'Globex', dates: 'Summer 2019', details: 'Short engagement.' },
  ],
};

describe('getUserProfileContext', () => {
  it('emits the exact interval for an entry that has one', () => {
    expect(getUserProfileContext(profile)).toContain('[2020-01 → present]');
  });

  it('emits nothing extra for a freeform entry', () => {
    const context = getUserProfileContext(profile);
    expect(context).toContain('Summer 2019');
    expect(context).not.toContain('[Summer');
  });

  it('keeps the human-readable dates alongside the interval', () => {
    expect(getUserProfileContext(profile)).toContain('(Jan 2020 – Present)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/profileContextDates.test.js
```

Expected: FAIL — `getUserProfileContext` is not exported, so the import is `undefined` and calling it throws.

- [ ] **Step 3: Import the helper**

In `resume-designer/src/aiService.js`, add to the existing import of `./experienceGroups.js`'s neighbours a new import line:

```js
import { formatIntervalHint } from './experienceDates.js';
```

- [ ] **Step 4: Export `getUserProfileContext` and let it take a profile**

At line 761, change:

```js
function getUserProfileContext() {
```

to:

```js
// Exported with an optional profile so the serialisation is unit-testable
// without seeding storage. Every existing caller passes nothing and gets the
// stored profile exactly as before.
export function getUserProfileContext(profile = getUserProfile()) {
```

The first line of the body is now redundant — the parameter replaces it. Delete it:

```js
  const profile = getUserProfile();
```

The three surviving callers (`aiService.js:934`, `:1289`, `:1368`) pass no argument and are unchanged. `isProfileEmpty` already treats a profile carrying only `workExperience` as non-empty, so the test's profile survives the early return.

- [ ] **Step 5: Emit the interval in the detailed serialiser**

In the block at lines 807-826, add the hint after each `dates` append. Change:

```js
          context += `- **${entry.title || 'Untitled'}**`;
          if (entry.dates) context += ` (${entry.dates})`;
          context += `\n`;
```

to:

```js
          context += `- **${entry.title || 'Untitled'}**`;
          if (entry.dates) context += ` (${entry.dates})`;
          context += formatIntervalHint(entry);
          context += `\n`;
```

and change:

```js
          context += `\n**${exp.title || 'Untitled'}** at ${exp.company || 'Unknown Company'}`;
          if (exp.dates) context += ` (${exp.dates})`;
          context += `\n`;
```

to:

```js
          context += `\n**${exp.title || 'Untitled'}** at ${exp.company || 'Unknown Company'}`;
          if (exp.dates) context += ` (${exp.dates})`;
          context += formatIntervalHint(exp);
          context += `\n`;
```

- [ ] **Step 6: Emit the interval in the generation serialiser**

In the block at lines 664-680, make the same two additions. Change:

```js
          profileContext += `- **${entry.title || 'Position'}**`;
          if (entry.dates) profileContext += ` (${entry.dates})`;
          profileContext += `\n`;
```

to:

```js
          profileContext += `- **${entry.title || 'Position'}**`;
          if (entry.dates) profileContext += ` (${entry.dates})`;
          profileContext += formatIntervalHint(entry);
          profileContext += `\n`;
```

and change:

```js
        profileContext += `\n**${exp.title || 'Position'}** at **${exp.company || 'Company'}**`;
        if (exp.dates) profileContext += ` (${exp.dates})`;
        profileContext += `\n`;
```

to:

```js
        profileContext += `\n**${exp.title || 'Position'}** at **${exp.company || 'Company'}**`;
        if (exp.dates) profileContext += ` (${exp.dates})`;
        profileContext += formatIntervalHint(exp);
        profileContext += `\n`;
```

This serialiser lives inside the exported async `generateResumeFromProfileForJob`, which cannot be unit-tested without mocking a live model call. It is covered by `formatIntervalHint`'s own tests plus review: the insertion is character-for-character the same as Step 5's.

- [ ] **Step 7: Tell the model what the bracket means**

In the generation prompt near line 542, which already instructs the model about `startDate`/`endDate`, append one sentence so the bracket is not read as prose. Find the existing instruction:

```js
  machine-readable startDate/endDate as "YYYY-MM" (a bare year is not enough —
```

and add immediately after that instruction's closing sentence:

```js
   Where a role in the profile carries a bracketed interval like [2020-01 → present],
   copy those values into startDate/endDate verbatim rather than inferring them.
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
npx vitest run test/profileContextDates.test.js
```

Expected: PASS, all three cases.

- [ ] **Step 9: Run the full gate**

```bash
npm run test && npx vite build && npm run lint
```

Expected: tests PASS, build exit 0, lint 0 errors.

- [ ] **Step 10: Commit**

```bash
git add src/aiService.js test/profileContextDates.test.js
git commit -m "feat(ai): give the model exact intervals from the profile"
```

---

## Manual verification (owner's machine, after all tasks)

Automated gates cannot see this. `npm run test` never loads `src/components/**`, and ClaudePreview is Chromium while the app ships on WKWebView.

```bash
npm run tauri:dev
```

Launch **by absolute path** and confirm Settings → About reads `1.0.0` first — several bundles on this machine share the frozen `com.resumedesigner.app` identifier, so it is easy to test the wrong build.

- [ ] Profile → Experience: pick a range on a role, reopen it, confirm the same months are selected.
- [ ] Profile → Experience: type `Summer 2019` into the popover's text field, press Enter, reopen — the grids are empty (R2 cleared the pair).
- [ ] Structure panel: pick a range; the résumé updates and undo restores the previous dates in one step.
- [ ] Rendered résumé: click a date near a page break, pick a range, confirm the page split is still correct afterwards.
- [ ] Rendered résumé: open the picker and scroll the résumé — it closes rather than orphaning.
- [ ] Rendered résumé: open the picker and confirm the AI button does not paint over it.
- [ ] Export a page-by-page PDF at Letter **and** A4 with the picker closed; no overlay appears in the output.
- [ ] Set two roles at one employer to immediately-successive months, generate a résumé, and confirm they group.

## Notes on divergence from the spec

The spec sketched the inline-editor bridge as a `setDateEditorOpener(fn)` registration in the shape of `variantManager`'s injected `confirmGrouping`. This plan uses a `CustomEvent` instead, matching `confirmDestructive`/`ConfirmHost`. Both satisfy the binding requirement — `inlineEditor.js` stays free of React — but the event needs no wiring in `main.js`, which calls `initInlineEditor()` and has no access to React components.

For the same reason, the spec's constraint "excluded from `handleClick` the way `.editable-ai-container` is" is met **structurally** rather than by an explicit exclusion: Radix portals `PopoverContent` to `document.body`, and the click listener is bound to `#resume`, so panel clicks never reach it. No marker class is added, because an unused one would be cruft.

The spec's "closed … before export" is likewise structural, and this plan adds no export hook. Both export paths capture `#resume` and nothing above it — the native one at `pdf.js:374` and the html2pdf fallback at `pdf.js:107` — so a body-level portal cannot reach the PDF. A Radix popover also closes on any outside pointer-down, so clicking Export closes it first. If a future export path ever captures the document rather than `#resume`, this becomes a real gap and `withPreviewSuppressed` in `inlineChanges.js` is where the close belongs.
