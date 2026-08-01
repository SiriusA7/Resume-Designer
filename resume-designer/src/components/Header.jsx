import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, Copy, Pencil, Trash2, MoreHorizontal, Upload, Download,
  ChevronDown, Settings, FileDown, User, Briefcase, History, Menu, Check, Loader2, LibraryBig,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { confirmDestructive } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

import { useVariants } from '../hooks/useVariants.js';
import {
  loadVariant, duplicateVariant, deleteCurrentVariant, renameCurrentVariant,
  importVariant, exportCurrentVariant, getCurrentId,
} from '../variantManager.js';
import { handleVariantThreadsForDelete } from './chat/deleteVariantThreadsFlow.js';
import { openSettings } from '../settingsModal.js';
import { AccountAvatar } from './profile/AccountAvatar.jsx';

// Format a variant's updatedAt for the selector menu (relative, then absolute).
function formatDate(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (diffDays === 0) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Variant-action menu items, shared verbatim by the kebab menu (768–1400px) and
// the mobile hamburger (≤768px) so the two can't drift. The expanded icon-button
// mode (>1400px) is a separate <Button> map (a different element) and stays inline
// at its render site. `danger` flags the Delete entry with destructive text.
function VariantMenuItems({ actions }) {
  return actions.map(({ key, label, Icon, run, danger }) => (
    <DropdownMenuItem
      key={key}
      onSelect={run}
      className={danger ? 'text-destructive focus:text-destructive' : undefined}
    >
      <Icon className="size-4" />
      {label}
    </DropdownMenuItem>
  ));
}

/**
 * The app header, restyled onto genuine shadcn primitives + Tailwind for the
 * full-shadcn chrome redesign (spec §5.3). This is a presentation-only pass:
 * every handler, prop, event, and contract from the prior header is preserved —
 * only the markup/styling changed (real <Button>/<DropdownMenu> in place of the
 * bespoke `.header-*` / `.custom-dropdown*` classes).
 *
 * Rendered via createPortal into the empty `<header id="header-bar">` left in the
 * static skeleton. That element is NEVER replaced: it owns the bar's flex layout,
 * the liquid-glass background (glass.css frosts `.header-bar`), the macOS
 * traffic-light padding (driven by `<html>` classes from main.js), and the
 * window-drag region (tauriDrag.js attaches its mousedown handler to it). We
 * portal our content INTO it and return `null` if it is missing.
 *
 * Drag-safety: every interactive element below is a real shadcn `<Button>`
 * (renders a `<button>`) or a Radix DropdownMenu item (`role="menuitem"`), all of
 * which tauriDrag.js exempts from the drag handler. The zone wrappers deliberately
 * do NOT carry `data-no-drag`: the controls are exempted individually, so a
 * wrapper-level opt-out would only dead-zone the empty space — e.g. the gap
 * between the centered variant group and the right-aligned tools — and kill window
 * drag there. Radix menus portal to `<body>` (default) so they frost correctly
 * outside the header. No `.header-*`/`.custom-dropdown*` class names are applied
 * here.
 *
 * Variant CRUD lives in variantManager.js; this component is the view + the
 * rename dialog. deleteCurrentVariant() is unconditional (the confirm was lifted
 * out of variantManager), so the Header owns the delete confirmation (shadcn
 * AlertDialog via confirmDestructive) + the last-variant guard. The PDF button
 * proxies the hidden `#download-pdf` button wired by pdf.js and reflects its
 * generation state via the rd:pdf-busy event.
 */
export default function Header() {
  const { currentId, list } = useVariants();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const importInputRef = useRef(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  // Mirror pdf.js's generation state onto the visible PDF button (rd:pdf-busy).
  useEffect(() => {
    const onPdfBusy = (e) => setPdfBusy(!!e.detail?.busy);
    window.addEventListener('rd:pdf-busy', onPdfBusy);
    return () => window.removeEventListener('rd:pdf-busy', onPdfBusy);
  }, []);

  const host = typeof document !== 'undefined' ? document.getElementById('header-bar') : null;
  if (!host) return null;

  const currentName = list.find((v) => v.id === currentId)?.name || 'Select resume';

  const newVariant = () => window.showOnboardingWizard?.({ skipApiKeyStep: true });
  const openRename = () => {
    setRenameValue(currentName);
    setRenameOpen(true);
  };
  const submitRename = (e) => {
    e.preventDefault();
    if (renameCurrentVariant(renameValue)) setRenameOpen(false);
  };
  const pickImport = () => importInputRef.current?.click();
  const onImportChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      importVariant(file);
      e.target.value = ''; // allow re-importing the same file
    }
  };

  // deleteCurrentVariant() is unconditional now (the confirm was lifted out of
  // variantManager into the caller), so the Header owns the confirmation + the
  // last-variant guard.
  const handleDelete = async () => {
    if (list.length <= 1) {
      toast.info("You can't delete your only resume.");
      return;
    }
    // If the resume has chat threads, ask whether to keep (→General) or delete
    // them, and reassign BEFORE deleteCurrentVariant() so the id still exists.
    // After delete, loadVariant(newId) fires dataLoaded and useChat's follow
    // effect reloads threads, so the change is reflected automatically.
    const { cancelled, hadThreads } = await handleVariantThreadsForDelete({
      variantId: getCurrentId(),
      variantName: currentName,
    });
    if (cancelled) return;
    if (!hadThreads) {
      const ok = await confirmDestructive({
        title: 'Delete this resume?',
        description: `"${currentName}" will be permanently deleted. This can't be undone.`,
        actionLabel: 'Delete',
      });
      if (!ok) return;
    }
    deleteCurrentVariant();
  };

  // Variant action items reused by the expanded icon buttons, the kebab menu, and
  // the mobile hamburger. Delete is flagged `danger` and runs handleDelete, which
  // owns the confirm AlertDialog + the last-variant guard.
  const variantActions = [
    { key: 'duplicate', label: 'Duplicate', Icon: Copy, run: duplicateVariant },
    { key: 'rename', label: 'Rename', Icon: Pencil, run: openRename },
    { key: 'delete', label: 'Delete', Icon: Trash2, run: handleDelete, danger: true },
  ];
  // `short` is the visible header-button label (collapses to icon-only when
  // narrow); `label` is the full name used for the tooltip + the mobile menu.
  const toolItems = [
    { key: 'profile', label: 'Profile', short: 'Profile', Icon: User, run: () => window.openUserProfilePanel?.() },
    { key: 'jobs', label: 'Jobs', short: 'Jobs', Icon: Briefcase, run: () => window.openJobDescriptionPanel?.() },
    { key: 'library', label: 'Resumes', short: 'Library', Icon: LibraryBig, run: () => window.dispatchEvent(new CustomEvent('rd:open-library')) },
    { key: 'history', label: 'Version history', short: 'History', Icon: History, run: () => window.openHistoryPanel?.() },
  ];

  return createPortal(
    <>
      {/* LEFT ZONE — brand + profile identity. `flex-1` (matched by the right
          zone's flex-1) makes the CENTER zone sit at the header's center. The
          wrapper stays draggable; the switcher button self-exempts like every
          other header control (see drag-safety note above). */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Brand: terracotta rounded-square mark + Geist 600 wordmark.
            Geometry pinned to mockup: 24px mark, rounded-[7px], 14.5px wordmark. */}
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="flex size-6 items-center justify-center rounded-[7px] bg-primary text-[13px] font-bold text-primary-foreground">
            O
          </span>
          <span className="whitespace-nowrap text-[14.5px] font-semibold tracking-[-0.01em]">
            On Paper
          </span>
        </div>
        {/* Workspace identity: compact initials avatar opening Settings →
            Account (switch/manage profiles + account stats). No emoji — the app
            uses none — and kept away from the right cluster's unrelated Profile
            EDITOR button. */}
        <AccountAvatar />
      </div>

      {/* CENTER ZONE — New + variant selector + actions kebab, centered between
          the two flex-1 side zones. No `data-no-drag` (see drag-safety note above):
          the buttons self-exempt; the wrapper must stay draggable. */}
      <div className="flex min-w-0 items-center gap-1.5">
          {/* New resume — promoted out of the actions menu to a header button,
              left of the selector. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            title="New resume"
            aria-label="New resume"
            onClick={newVariant}
          >
            <Plus className="size-4" />
          </Button>

          {/* Variant selector — outline combobox-style trigger → standard menu. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-[34px] max-w-[230px] px-3 text-[13.5px] font-medium max-[900px]:max-w-[180px] max-[768px]:max-w-[160px] max-[500px]:max-w-[120px]"
              >
                <span className="min-w-0 truncate">{currentName}</span>
                <ChevronDown className="size-[13px] shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            {/* The variant list scrolls in an inner wrapper so the "View all"
                footer stays anchored — visible however long the list gets. */}
            <DropdownMenuContent align="start" className="flex min-w-56 flex-col p-0">
              <div className="max-h-[52vh] overflow-y-auto p-1">
                {list.map((v) => (
                  <DropdownMenuItem key={v.id} onSelect={() => loadVariant(v.id)}>
                    <Check className={cn('size-3.5 shrink-0', v.id !== currentId && 'opacity-0')} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{v.name}</span>
                      {v.updatedAt && (
                        <span className="text-xs text-muted-foreground">{formatDate(v.updatedAt)}</span>
                      )}
                    </span>
                  </DropdownMenuItem>
                ))}
              </div>
              <DropdownMenuSeparator className="my-0" />
              <div className="p-1">
                <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent('rd:open-library'))}>
                  <LibraryBig className="size-3.5 shrink-0" />
                  <span>View all resumes…</span>
                </DropdownMenuItem>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Resume/file actions — one "Actions" dropdown next to the selector:
              variant CRUD + import/export. Hidden ≤768px, where the hamburger
              takes over. */}
          <div className="hidden min-[769px]:flex">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  title="Resume actions"
                  aria-label="Resume actions"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-48">
                <VariantMenuItems actions={variantActions} />
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={pickImport}>
                  <Download className="size-4" /> Import…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportCurrentVariant('json')}>
                  <Upload className="size-4" /> Export as JSON
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportCurrentVariant('md')}>
                  <Upload className="size-4" /> Export as Markdown
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
      </div>

      {/* RIGHT ZONE — tools / settings / PDF + mobile menu. `flex-1` + justify-end
          (matched by the left zone's flex-1) right-aligns these and centers the
          middle zone. No `data-no-drag`: with justify-end, the zone's empty left
          half is the gap beside the variant group, and a wrapper opt-out would make
          that strip non-draggable (the buttons self-exempt — see note above). */}
      <div className="flex flex-1 items-center justify-end gap-1.5 max-[900px]:gap-1">
        {/* Desktop actions — hidden ≤768px; tighter gaps ≤900px. */}
        <div className="flex items-center gap-1.5 max-[900px]:gap-0.5 max-[768px]:hidden">
          {/* Tools, promoted to regular header buttons (icon + short label;
              labels collapse to icon-only ≤1100px, full name kept as tooltip). */}
          {toolItems.map(({ key, label, short, Icon, run }) => (
            <Button
              key={key}
              variant="ghost"
              size="sm"
              className="h-[34px] text-[13.5px]"
              title={label}
              aria-label={label}
              onClick={run}
            >
              <Icon className="size-4" />
              <span className="max-[1100px]:hidden">{short}</span>
            </Button>
          ))}
        </div>

        {/* Settings gear — always visible at every breakpoint (like PDF). */}
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          title="Settings"
          aria-label="Settings"
          onClick={() => openSettings()}
        >
          <Settings className="size-[17px]" />
        </Button>

        {/* PDF — the bar's only filled button; proxies the hidden #download-pdf. */}
        <Button
          size="sm"
          className="h-[34px] text-[13.5px]"
          title="Download PDF"
          aria-label="Download PDF"
          disabled={pdfBusy}
          onClick={() => document.getElementById('download-pdf')?.click()}
        >
          {pdfBusy ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
          <span className="max-[1200px]:hidden">{pdfBusy ? 'Generating…' : 'PDF'}</span>
        </Button>

        {/* Mobile hamburger menu — shown ≤768px only; groups Resume/Tools/File. */}
        <div className="hidden max-[768px]:flex">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9" title="Menu" aria-label="Menu">
                <Menu className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuLabel>Resume</DropdownMenuLabel>
              <VariantMenuItems actions={variantActions} />
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Tools</DropdownMenuLabel>
              {toolItems.map(({ key, label, Icon, run }) => (
                <DropdownMenuItem key={key} onSelect={run}>
                  <Icon className="size-4" />
                  {label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>File</DropdownMenuLabel>
              <DropdownMenuItem onSelect={pickImport}>
                <Download className="size-4" /> Import
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportCurrentVariant('json')}>
                <Upload className="size-4" /> Export as JSON
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportCurrentVariant('md')}>
                <Upload className="size-4" /> Export as Markdown
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Shared hidden file input for Import (desktop + mobile). Reset after pick. */}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,.md,.markdown"
        hidden
        onChange={onImportChange}
      />

      {/* Rename dialog (system shadcn Dialog shell + glass-card). */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm glass-card">
          <DialogHeader>
            <DialogTitle>Rename resume</DialogTitle>
            <DialogDescription className="sr-only">Enter a new name for the current resume variant</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitRename} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rename-variant-input">Name</Label>
              <Input
                id="rename-variant-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renameValue.trim()}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>,
    host
  );
}
