import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '../ui/dialog.jsx';
import { Input } from '../ui/input.jsx';
import { Badge } from '../ui/badge.jsx';
import { Checkbox } from '../ui/checkbox.jsx';
import { Label } from '../ui/label.jsx';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select.jsx';
import { cn } from '@/lib/utils';
import { useVariants } from '../../hooks/useVariants.js';
import { useApplications } from '../../hooks/useApplications.js';
import { searchLibrary } from '../../librarySearch.js';
import { getAllJobDescriptions } from '../../jobDescriptions.js';
import { loadThreads } from '../../chatThreads.js';
import { APPLICATION_STATUSES, STATUS_LABELS } from '../../applications.js';
import { STATUS_BADGE_CLASSES } from './statusStyles.js';
import DetailPane from './DetailPane.jsx';

// Relative-then-absolute date, same behavior as the header selector.
function formatDate(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (diffDays === 0) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const DEEP_SOURCE_LABELS = { resume: 'in resume', job: 'in job description', chat: 'in chat' };

export default function LibraryDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [deep, setDeep] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'untracked' | a status string
  const [selectedId, setSelectedId] = useState(null);

  const { currentId, list } = useVariants();
  const applications = useApplications();

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('rd:open-library', onOpen);
    return () => window.removeEventListener('rd:open-library', onOpen);
  }, []);

  // Default the selection to the current variant each time the dialog opens.
  useEffect(() => {
    if (open) setSelectedId(currentId);
  }, [open, currentId]);

  const results = useMemo(() => {
    if (!open) return [];
    return searchLibrary(query, {
      variants: list,
      applications,
      jobDescriptions: getAllJobDescriptions(),
      threads: loadThreads().threads,
      deep,
    });
  }, [open, query, deep, list, applications]);

  const rows = useMemo(() => {
    const byId = new Map(list.map((v) => [v.id, v]));
    return results
      .map((r) => ({ ...r, variant: byId.get(r.variantId) }))
      .filter((r) => r.variant)
      .filter((r) => {
        if (statusFilter === 'all') return true;
        const apps = applications.filter((a) => a.variantId === r.variantId);
        if (statusFilter === 'untracked') return apps.length === 0;
        return apps.some((a) => a.status === statusFilter);
      });
  }, [results, list, applications, statusFilter]);

  const selected = list.find((v) => v.id === selectedId) || null;
  const selectedApps = applications.filter((a) => a.variantId === selectedId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[82vh] w-[94vw] max-w-[980px] flex-col gap-0 overflow-hidden p-0 glass-card"
      >
        <DialogDescription className="sr-only">
          Search and browse your resumes and job applications
        </DialogDescription>

        <div className="flex shrink-0 items-start justify-between gap-3 border-b px-[22px] pb-4 pt-5">
          <div className="space-y-1">
            <DialogTitle>Resume Library</DialogTitle>
            <p className="text-[13px] text-muted-foreground">
              Search your resumes, see what each was tailored for, and track outcomes.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* LEFT: search + list */}
          <div className="flex w-[340px] shrink-0 flex-col border-r">
            <div className="space-y-2.5 border-b p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search resumes…"
                  className="pl-8"
                  autoFocus
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Checkbox id="lib-deep" checked={deep} onCheckedChange={(v) => setDeep(v === true)} />
                  <Label htmlFor="lib-deep" className="text-xs text-muted-foreground">
                    Search everything
                  </Label>
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-7 w-[130px] text-xs" aria-label="Filter by status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="untracked">Untracked</SelectItem>
                    {APPLICATION_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {rows.length === 0 && (
                <div className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                  {query
                    ? (deep ? 'No matches.' : 'No name or job matches. Try “Search everything”.')
                    : 'No resumes yet.'}
                </div>
              )}
              {rows.map(({ variant, quickHit, deepHits }) => {
                const apps = applications.filter((a) => a.variantId === variant.id);
                const firstDeep = !quickHit && deepHits[0];
                return (
                  <button
                    key={variant.id}
                    type="button"
                    onClick={() => setSelectedId(variant.id)}
                    className={cn(
                      'w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-accent',
                      variant.id === selectedId && 'bg-accent',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-[13.5px] font-medium">{variant.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatDate(variant.updatedAt)}
                      </span>
                    </div>
                    {apps.length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {apps.slice(0, 2).map((a) => (
                          <Badge key={a.id} variant="outline" className={cn('text-[10px]', STATUS_BADGE_CLASSES[a.status])}>
                            {a.jobSnapshot?.company || a.jobSnapshot?.title || 'Job'} · {STATUS_LABELS[a.status]}
                          </Badge>
                        ))}
                        {apps.length > 2 && (
                          <span className="text-[10px] text-muted-foreground">+{apps.length - 2}</span>
                        )}
                      </div>
                    )}
                    {firstDeep && (
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        <span className="font-medium">{DEEP_SOURCE_LABELS[firstDeep.source]}:</span> {firstDeep.snippet}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* RIGHT: detail */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {selected ? (
              <DetailPane
                variant={selected}
                applications={selectedApps}
                onAfterDelete={() => setSelectedId(null)}
                onClose={() => setOpen(false)}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
                Select a resume to see its details
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
