import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, Settings2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import { getAIModels, getModelLabel } from './useChat.js';
import { fetchModelCatalog, getSelectableChatModels } from '../../aiService.js';
import { shouldSpellcheck } from '../../spellcheck.js';

/**
 * Model picker — featured groups + the user's cached custom slugs (removable) +
 * a searchable "All models" section backed by the live catalog + a free-type
 * custom-slug field. A controlled shadcn Popover hosting the real Command
 * primitive (the shadcn combobox pattern: selected item = visible leading
 * Check, others transparent). Radix portals the content to <body>, so the
 * glass blur escapes the frosted panel for free.
 */
export function ModelSelector({
  currentModel, configured, customModels, catalogRev, onRefreshCatalog,
  onSelect, onApplyCustomSlug, onRemoveCustom, onConfigure,
}) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [catalogFailed, setCatalogFailed] = useState(false);

  // Recomputed when the popover opens or a catalog refresh lands.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const featured = useMemo(() => getAIModels(), [open, catalogRev]);
  // Selectable, not the raw catalog: image/audio/embedding models cannot answer
  // a chat request, and offering them only produces "The model returned an
  // empty response". Both this and the empty-check below must use the SAME
  // list — if they disagreed, a catalog that loaded with nothing selectable
  // would sit on "Loading the model catalog…" forever.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allModels = useMemo(() => getSelectableChatModels(), [open, catalogRev]);

  // Stale-while-revalidate: the lists above render from cache immediately, and
  // this kicks a background refresh that swaps them in via catalogRev.
  useEffect(() => {
    if (open && configured) onRefreshCatalog();
  }, [open, configured, onRefreshCatalog]);

  // The refresh above is fire-and-forget, so the loading row below would spin
  // forever when the fetch fails with nothing cached. fetchModelCatalog() joins
  // the same in-flight request; if it settles with the catalog still empty, the
  // load failed — say so instead of spinning. It never throws today, but that
  // invariant lives in aiService.js — the .catch keeps this component correct
  // locally if it ever changes.
  const catalogEmpty = allModels.length === 0;
  useEffect(() => {
    if (!open || !configured || !catalogEmpty) return undefined;
    let cancelled = false;
    setCatalogFailed(false);
    fetchModelCatalog()
      .then(() => {
        if (!cancelled && getSelectableChatModels().length === 0) setCatalogFailed(true);
      })
      .catch(() => {
        if (!cancelled) setCatalogFailed(true);
      });
    return () => { cancelled = true; };
  }, [open, configured, catalogEmpty]);

  // A failed load leaves catalogFailed latched, so reopening would paint the
  // "Couldn't load" notice for one frame before the effect above resets it.
  // Clear on close — here rather than in onOpenChange, because pick()/applySlug()
  // close by calling setOpen(false) directly.
  useEffect(() => {
    if (!open) setCatalogFailed(false);
  }, [open]);

  // Ids already listed in the Featured/Custom groups above — excluded from
  // "All models" so no model renders (and matches search) twice.
  const listedIds = useMemo(
    () => new Set([
      ...featured.flatMap((g) => g.options.map((o) => o.value)),
      ...customModels,
    ]),
    [featured, customModels],
  );

  const pick = (value) => { onSelect(value); setOpen(false); };

  const applySlug = () => {
    if (onApplyCustomSlug(slug)) {
      setSlug('');
      setInvalid(false);
      setOpen(false);
    } else {
      setInvalid(true);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 flex-1 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
        >
          <span className="min-w-0 truncate">{getModelLabel(currentModel)}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[280px] p-0">
        {configured ? (
          <>
            <Command>
              <CommandInput placeholder="Search 300+ models…" />
              <CommandList className="max-h-[300px]">
                <CommandEmpty>No model matches.</CommandEmpty>

                {featured.map((group) => (
                  <CommandGroup
                    key={group.group}
                    heading={group.group}
                    className="[&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-primary"
                  >
                    {group.options.map((opt) => (
                      <CommandItem key={opt.value} value={opt.value} keywords={[opt.label]} onSelect={() => pick(opt.value)}>
                        <Check className={cn('size-4', opt.value !== currentModel && 'opacity-0')} />
                        <span className="min-w-0 truncate">{opt.label}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}

                {customModels.length > 0 && (
                  <CommandGroup heading="Custom">
                    {customModels.map((s) => (
                      <CommandItem key={s} value={s} keywords={[getModelLabel(s)]} onSelect={() => pick(s)}>
                        <Check className={cn('size-4', s !== currentModel && 'opacity-0')} />
                        <span className="min-w-0 flex-1 truncate">{getModelLabel(s)}</span>
                        <span
                          role="button"
                          aria-label="Remove"
                          title="Remove from list"
                          className="ml-auto rounded-sm p-0.5 text-muted-foreground hover:bg-muted-foreground/20 hover:text-destructive"
                          onClick={(e) => { e.stopPropagation(); onRemoveCustom(s); }}
                        >
                          <X className="size-3.5" />
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {allModels.length > 0 && (
                  <CommandGroup heading="All models">
                    {allModels.filter((m) => !listedIds.has(m.id)).map((m) => (
                      <CommandItem key={m.id} value={m.id} keywords={[m.name]} onSelect={() => pick(m.id)}>
                        <Check className={cn('size-4', m.id !== currentModel && 'opacity-0')} />
                        <span className="min-w-0 truncate">{m.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>

            {catalogEmpty && (
              <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
                {catalogFailed ? (
                  "Couldn't load the full model list — showing built-in models."
                ) : (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    Loading the model catalog…
                  </>
                )}
              </div>
            )}

            <div className="border-t p-2">
              <div className="flex gap-1.5">
                <Input
                  className={cn('h-[30px] font-mono text-xs', invalid && 'border-destructive')}
                  aria-invalid={invalid || undefined}
                  spellCheck={shouldSpellcheck('slug')}
                  placeholder="Custom slug, e.g. anthropic/claude-opus-4.8"
                  value={slug}
                  onChange={(e) => { setSlug(e.target.value); setInvalid(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applySlug(); } }}
                />
                <Button size="sm" className="h-[30px]" onClick={applySlug}>Use</Button>
              </div>
              {invalid && (
                <p className="mt-1 text-xs text-destructive">
                  Enter a valid OpenRouter slug, e.g. anthropic/claude-opus-4.8
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-2 p-3">
            <p className="text-sm text-muted-foreground">OpenRouter API key not configured</p>
            <Button size="sm" onClick={() => { setOpen(false); onConfigure(); }}>
              <Settings2 className="size-3.5" />
              Configure
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
