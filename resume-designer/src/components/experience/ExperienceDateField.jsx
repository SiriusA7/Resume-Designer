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
