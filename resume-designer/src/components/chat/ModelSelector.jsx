import { useState } from 'react';
import { Check, ChevronDown, Settings2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import { getAIModels, getModelLabel } from './useChat.js';

/**
 * Model picker — curated groups + the user's cached custom slugs (removable) +
 * a free-type custom-slug field. A controlled shadcn Popover hosting the real
 * Command primitive (the shadcn combobox pattern: selected item = visible
 * leading Check, others transparent). Radix portals the content to <body>, so
 * the glass blur escapes the frosted panel for free.
 */
export function ModelSelector({
  currentModel, configured, customModels,
  onSelect, onApplyCustomSlug, onRemoveCustom, onConfigure,
}) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [invalid, setInvalid] = useState(false);

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
          className="h-7 max-w-40 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
        >
          <span className="min-w-0 truncate">{getModelLabel(currentModel)}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[280px] p-0">
        {configured ? (
          <>
            <Command>
              <CommandList className="max-h-[260px]">
                {getAIModels().map((group) => (
                  <CommandGroup
                    key={group.group}
                    heading={group.group}
                    className="[&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-primary"
                  >
                    {group.options.map((opt) => (
                      <CommandItem key={opt.value} value={opt.value} onSelect={() => pick(opt.value)}>
                        <Check className={cn('size-4', opt.value !== currentModel && 'opacity-0')} />
                        <span className="min-w-0 truncate">{opt.label}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}

                {customModels.length > 0 && (
                  <CommandGroup heading="Custom">
                    {customModels.map((s) => (
                      <CommandItem key={s} value={s} onSelect={() => pick(s)}>
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
              </CommandList>
            </Command>

            <div className="border-t p-2">
              <div className="flex gap-1.5">
                <Input
                  className={cn('h-[30px] font-mono text-xs', invalid && 'border-destructive')}
                  aria-invalid={invalid || undefined}
                  spellCheck={false}
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
