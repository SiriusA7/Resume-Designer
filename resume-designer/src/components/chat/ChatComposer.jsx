import { useEffect, useRef, useState } from 'react';
import {
  Brain, Briefcase, Check, ChevronDown, CircleHelp, FileText, Globe,
  LayoutPanelTop, List, MessageCircle, Pencil, Send, Trash2, User, X, Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { ModelSelector } from './ModelSelector.jsx';

const SLASH_COMMANDS = [
  { command: '/feedback', description: 'Get detailed resume feedback', Icon: MessageCircle },
  { command: '/improve', description: 'Improve a section (e.g., /improve summary)', Icon: Pencil },
  { command: '/generate', description: 'Generate bullet points from context', Icon: Zap },
  { command: '/profile', description: 'Start AI interview to fill your profile', Icon: User },
  { command: '/done', description: 'Finish profile interview and save', Icon: Check },
  { command: '/debug', description: 'Show current profile status', Icon: CircleHelp },
  { command: '/clear', description: 'Clear chat history', Icon: Trash2 },
  { command: '/help', description: 'Show available commands', Icon: CircleHelp },
];

const COMMANDS_NEEDING_ARGS = ['/improve', '/generate'];

// Below this control-row width the reasoning control drops its text label. The
// chat panel resizes independently of the viewport (240–500px, ChatPanel.jsx),
// so a viewport media query would be measuring the wrong box — hence a
// ResizeObserver rather than a Tailwind breakpoint.
const COMPACT_ROW_WIDTH = 300;

const REASONING_OPTIONS = [
  { level: 'none', label: 'Off', desc: 'Fastest responses' },
  { level: 'low', label: 'Low', desc: 'Quick thinking' },
  { level: 'medium', label: 'Medium', desc: 'Balanced' },
  { level: 'high', label: 'High', desc: 'Deep analysis' },
];

const reasoningLabel = (v) => ({ none: 'Off', low: 'Low', medium: 'Medium', high: 'High' }[v] || 'Medium');

// Context-chip leading icon by chip type.
const CHIP_ICONS = {
  section: LayoutPanelTop,
  experience: Briefcase,
  bullet: List,
};

/**
 * The composer: context chips, quick-action shortcuts, slash-command
 * autocomplete, the auto-growing textarea, and the controls bar (model picker,
 * web-search toggle, reasoning-effort menu). The textarea is uncontrolled (a
 * ref) so typing never round-trips through React state — fast and caret-safe.
 */
export function ChatComposer({
  contextChips, onRemoveChip, onClearChips, onSend, loading,
  currentModel, configured, customModels, catalogRev, onRefreshCatalog,
  onSelectModel, onApplyCustomSlug, onRemoveCustom, onConfigure,
  reasoningEffort, reasoningSupported, onSetReasoning,
  webSearchEnabled, onToggleWebSearch,
}) {
  const inputRef = useRef(null);
  const [slashItems, setSlashItems] = useState(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const controlsRef = useRef(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = controlsRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width < COMPACT_ROW_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const autoResize = () => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  };

  const submit = () => {
    const ta = inputRef.current;
    const text = ta?.value.trim();
    // Bail BEFORE clearing when there's nothing to send OR a run is already in
    // flight: useChat.send() ignores concurrent calls (loadingRef guard), so
    // clearing here would silently discard a draft the user typed while the
    // assistant was still streaming. Leave the text in place — they can send
    // it once the current run finishes (or after pressing Stop).
    if (!text || loading) return;
    onSend(text);
    if (ta) { ta.value = ''; ta.style.height = 'auto'; }
    setSlashItems(null);
  };

  // Fill the input with a slash command. autoSend (keyboard pick) fires it
  // immediately for argument-free commands; arg commands get a trailing space.
  const fillSlash = (command, autoSend) => {
    const ta = inputRef.current;
    const needsArgs = COMMANDS_NEEDING_ARGS.includes(command);
    if (ta) {
      ta.value = command + (needsArgs || !autoSend ? ' ' : '');
      ta.focus();
      autoResize();
    }
    setSlashItems(null);
    if (autoSend && !needsArgs) setTimeout(submit, 10);
  };

  const handleInput = () => {
    autoResize();
    const value = inputRef.current?.value || '';
    if (value.startsWith('/')) {
      const query = value.slice(1).toLowerCase();
      const filtered = SLASH_COMMANDS.filter(
        (c) => c.command.slice(1).toLowerCase().includes(query) || c.description.toLowerCase().includes(query)
      );
      if (filtered.length) { setSlashItems(filtered); setSlashIndex(0); } else { setSlashItems(null); }
    } else {
      setSlashItems(null);
    }
  };

  const handleKeyDown = (e) => {
    if (slashItems) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashItems.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); fillSlash(slashItems[slashIndex].command, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlashItems(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <div className="relative shrink-0 space-y-2.5 border-t p-3">
      {contextChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Context</span>
          {contextChips.map((chip, i) => {
            const ChipIcon = CHIP_ICONS[chip.type] || FileText;
            return (
              <span
                key={i}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-[11.5px] font-medium text-primary"
              >
                <ChipIcon className="size-3 shrink-0" />
                <span className="min-w-0 truncate">{chip.label}</span>
                <button
                  type="button"
                  title="Remove"
                  aria-label="Remove context"
                  className="flex size-3.5 shrink-0 items-center justify-center rounded-full text-primary hover:bg-primary/20"
                  onClick={() => onRemoveChip(i)}
                >
                  <X className="size-2.5" />
                </button>
              </span>
            );
          })}
          <button
            type="button"
            className="text-[11.5px] font-medium text-primary hover:underline"
            onClick={onClearChips}
          >
            Clear all
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 max-[1024px]:hidden">
        <Button variant="outline" size="sm" className="h-7 rounded-full text-xs" disabled={loading} onClick={() => onSend('/feedback')}>
          Get feedback
        </Button>
        <Button variant="outline" size="sm" className="h-7 rounded-full text-xs" disabled={loading} onClick={() => onSend('/improve summary')}>
          Improve summary
        </Button>
      </div>

      {slashItems && (
        <div className="absolute inset-x-2 bottom-full z-50 mb-2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
          <div className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Commands</div>
          <div className="max-h-[280px] overflow-y-auto p-1">
            {slashItems.map(({ command, description, Icon }, i) => {
              const selected = i === slashIndex;
              return (
                <button
                  key={command}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
                    selected ? 'bg-accent' : 'hover:bg-accent'
                  )}
                  onMouseEnter={() => setSlashIndex(i)}
                  onClick={() => fillSlash(command, false)}
                >
                  <span
                    className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-md',
                      selected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="font-mono text-[12.5px] font-medium">{command}</span>
                    <span className="truncate text-[11.5px] text-muted-foreground">{description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Composer: bordered rounded card wrapping the uncontrolled textarea + the
          controls row (model button, web/reasoning toggles, send) — mockup `.composer`. */}
      <div className="rounded-[12px] border border-input bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring">
        <Textarea
          id="chat-input"
          placeholder="Ask anything..."
          rows={1}
          ref={inputRef}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          className="max-h-[200px] min-h-0 resize-none rounded-none border-0 bg-transparent px-3 pb-1 pt-2.5 shadow-none focus-visible:ring-0"
        />
        <div ref={controlsRef} className="flex items-center gap-1 px-1.5 pb-1.5 pt-0.5">
          <ModelSelector
            currentModel={currentModel}
            configured={configured}
            customModels={customModels}
            catalogRev={catalogRev}
            onRefreshCatalog={onRefreshCatalog}
            onSelect={onSelectModel}
            onApplyCustomSlug={onApplyCustomSlug}
            onRemoveCustom={onRemoveCustom}
            onConfigure={onConfigure}
          />

          <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />

          <Button
            variant="ghost"
            size="icon"
            className={cn('size-7 shrink-0', webSearchEnabled && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary')}
            title={webSearchEnabled ? 'Web search enabled' : 'Enable web search'}
            aria-label={webSearchEnabled ? 'Web search enabled' : 'Enable web search'}
            onClick={onToggleWebSearch}
          >
            <Globe className="size-4" />
          </Button>

          <Popover open={reasoningOpen && reasoningSupported} onOpenChange={setReasoningOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-7 shrink-0 gap-1 text-xs font-normal text-muted-foreground', compact ? 'px-1.5' : 'px-2')}
                disabled={!reasoningSupported}
                title={reasoningSupported ? `Reasoning effort: ${reasoningLabel(reasoningEffort)}` : 'Reasoning not available for this model'}
                aria-label={reasoningSupported ? `Reasoning effort: ${reasoningLabel(reasoningEffort)}` : 'Reasoning not available for this model'}
              >
                <Brain className="size-3.5" />
                {!compact && <span>{reasoningSupported ? reasoningLabel(reasoningEffort) : 'N/A'}</span>}
                {!compact && <ChevronDown className="size-3 opacity-60" />}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-[200px] p-1">
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Reasoning effort</div>
              {REASONING_OPTIONS.map((o) => (
                <button
                  key={o.level}
                  type="button"
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground',
                    o.level === reasoningEffort && 'bg-accent text-accent-foreground'
                  )}
                  onClick={() => { onSetReasoning(o.level); setReasoningOpen(false); }}
                >
                  <span className="text-sm">{o.label}</span>
                  <span className="text-xs text-muted-foreground">{o.desc}</span>
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <Button
            size="icon"
            className="ml-auto size-[30px] shrink-0 rounded-lg"
            title={loading ? 'Waiting for the current response…' : 'Send message'}
            aria-label="Send message"
            disabled={loading}
            onClick={submit}
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
