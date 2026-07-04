import { useState } from 'react';
import { ChevronDown, CornerUpLeft, MessageSquare, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { confirmDestructive } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

import { getThreadDisplayName, groupThreadsByHome } from '../../chatThreads.js';

/**
 * Chat-thread switcher. A controlled shadcn Popover (not DropdownMenu) so that
 * deleting a thread re-renders the list in place without the menu auto-closing,
 * matching the old behavior. Rows are styled after shadcn's DropdownMenuItem
 * source; the per-row delete reveals on hover.
 *
 * Threads are grouped relative to the active résumé: the current résumé's threads
 * first, then a "General" group (legacy / unhomed threads), then a section per
 * other résumé. Rows outside the current résumé get a "Move here" affordance.
 */
export function ThreadSelector({
  threads, currentThreadId, currentVariantId, variants,
  onSwitch, onNew, onDelete, onMoveToCurrent,
}) {
  const [open, setOpen] = useState(false);
  const current = threads.find((t) => t.id === currentThreadId);

  // Single-thread deletion asks for confirmation (you can't be left with none
  // unintentionally); with multiple threads it's a one-click delete.
  const handleDelete = async (id) => {
    if (threads.length > 1) {
      onDelete(id);
      return;
    }
    const ok = await confirmDestructive({
      title: 'Delete this chat thread?',
      description: 'This conversation history will be permanently deleted.',
      actionLabel: 'Delete',
    });
    if (ok) onDelete(id);
  };

  const { current: currentThreads, general, others } = groupThreadsByHome(
    threads, currentVariantId, variants
  );

  const Row = (t, { showMove } = {}) => (
    <div
      key={t.id}
      className={cn(
        'group flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground',
        t.id === currentThreadId && 'bg-accent text-accent-foreground'
      )}
      onClick={() => { onSwitch(t.id); setOpen(false); }}
    >
      <MessageSquare className="size-3.5 shrink-0 opacity-60" />
      <span className="min-w-0 flex-1 truncate">{getThreadDisplayName(t)}</span>
      {showMove && (
        <Button
          variant="ghost"
          size="icon"
          className="size-5 shrink-0 opacity-0 group-hover:opacity-100"
          title="Move to this résumé"
          aria-label="Move to this résumé"
          onClick={(e) => { e.stopPropagation(); onMoveToCurrent(t.id); }}
        >
          <CornerUpLeft className="size-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-5 shrink-0 opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        title="Delete thread"
        aria-label="Delete thread"
        onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );

  const SectionLabel = ({ children }) => (
    <div className="mt-1 border-t border-border px-2 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full justify-between gap-1 px-2.5 text-[13px] font-normal text-foreground"
        >
          <span className="min-w-0 truncate">{getThreadDisplayName(current)}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[260px] p-1">
        <div className="flex items-center justify-between px-2 py-1.5 text-xs font-medium text-muted-foreground">
          <span>Chat Threads</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title="Start new chat"
            aria-label="Start new chat"
            onClick={() => { onNew(); setOpen(false); }}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {currentThreads.map((t) => Row(t))}
          {general.length > 0 && (
            <>
              <SectionLabel>General</SectionLabel>
              {general.map((t) => Row(t, { showMove: true }))}
            </>
          )}
          {others.map((grp) => (
            <div key={grp.variantId}>
              <SectionLabel>{grp.variantName}</SectionLabel>
              {grp.threads.map((t) => Row(t, { showMove: true }))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
