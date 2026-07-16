import { useRef, useState } from 'react';
import { Check, Download, MoreHorizontal, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { confirmDestructive } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

import { appStorage } from '../../appStorage.js';
import { store } from '../../store.js';
import { flushPendingProfileSave } from '../../userProfilePanel.js';
import {
  loadRegistry, getActiveProfileId, activateProfileDurably, createProfile,
  renameProfile, deleteProfile, exportProfileBackup, importProfileBackup,
  isAdoptionPending,
} from '../../profiles.js';
import { getVariants, getUserProfile } from '../../persistence.js';
import { getAllJobDescriptions } from '../../jobDescriptions.js';
import { getAllApplications } from '../../applications.js';
import { computeStats } from '../../applicationStats.js';
import {
  profileInitials, profileCompleteness, formatRate, formatDays,
} from '../../accountStats.js';

function SectionHeader({ title, description }) {
  return (
    <div className={cn(description ? 'mb-3.5' : 'mb-3')}>
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {description && <p className="mt-0.5 text-[12.5px] leading-[1.5] text-muted-foreground">{description}</p>}
    </div>
  );
}

function StatTile({ value, label, hint }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <div className="text-[19px] font-semibold leading-tight tabular-nums">{value}</div>
      <div className="mt-0.5 text-[12px] font-medium">{label}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Avatar({ name, className }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold tracking-tight text-primary',
        className,
      )}
    >
      {profileInitials(name)}
    </span>
  );
}

// Flush every pending edit of the active profile to disk before a switch/export
// reloads or serializes. Reports false on a passthrough-quota failure that
// appStorage.flush() alone would miss (store.saveNow / flushPendingProfileSave
// now surface it). Callers abort so unsaved edits aren't lost.
async function flushActiveEdits() {
  const savedResume = store.saveNow();
  const savedProfile = flushPendingProfileSave();
  const durable = await appStorage.flush();
  return savedResume && savedProfile && durable;
}

export function AccountSection() {
  const [registry, setRegistry] = useState(() => loadRegistry() || []);
  const [editingId, setEditingId] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const fileRef = useRef(null);
  const activeId = getActiveProfileId();
  // While a first-profile adoption is mid-recovery the live workspace still sits
  // under unprefixed keys and belongs to the adoption profile. Switching or
  // creating a profile then changes ACTIVE_PROFILE_KEY, so the next boot would
  // resume adoption under the wrong id and move the live data into it. Block
  // those actions until adoption completes (the Account tab is reachable via the
  // settings gear even though the header avatar is hidden in this state).
  const adopting = isAdoptionPending();

  const refresh = () => setRegistry(loadRegistry() || []);

  // The active profile renders as one distinct card; everyone else as compact
  // rows in a capped scroll list — "which profile am I in?" is answerable at a
  // glance and ten profiles don't swallow the tab. `current` can be null
  // mid-recovery (active id not in a rebuilt registry); everything then
  // renders as switchable rows, which is the honest state.
  const current = registry.find((p) => p.id === activeId) || null;
  const others = registry.filter((p) => p.id !== activeId);

  // Stats for the active workspace — read on render (the section mounts when the
  // user opens the Account tab, so these are fresh each visit).
  const resumeCount = Object.keys(getVariants()).length;
  const jdCount = getAllJobDescriptions().length;
  const appStats = computeStats(getAllApplications());
  const completeness = profileCompleteness(getUserProfile());

  const switchTo = async (id) => {
    if (id === activeId || adopting) return;
    if (!(await flushActiveEdits())) {
      toast.error('Could not save your latest changes — profile switch cancelled.');
      return;
    }
    if (!(await activateProfileDurably(id, activeId))) {
      toast.error("Could not switch profiles — the change didn't reach disk.");
      return;
    }
    window.location.reload();
  };

  const submitNew = async () => {
    const name = newName.trim();
    if (!name || adopting) return;
    if (!(await flushActiveEdits())) {
      toast.error('Could not save your latest changes — new profile cancelled.');
      return;
    }
    // createProfile can throw synchronously in passthrough mode — the new
    // registry entry ENLARGES localStorage, so it can hit quota even after a
    // successful flushActiveEdits (which only replaced existing values).
    let profile;
    try {
      profile = createProfile({ name });
    } catch (e) {
      toast.error(String(e.message || e));
      return;
    }
    // New profiles start empty; land in them — but only once the pointer is
    // durable. On failure, unwind the half-created profile too so a later
    // successful flush doesn't resurrect an empty registry entry.
    if (!(await activateProfileDurably(profile.id, activeId))) {
      try { deleteProfile(profile.id); } catch { /* best effort */ }
      await appStorage.flush();
      toast.error("Could not create the profile — the change didn't reach disk.");
      return;
    }
    window.location.reload();
  };

  const saveRename = (id) => {
    const name = draftName.trim();
    if (name) renameProfile(id, { name });
    setEditingId(null);
    refresh();
  };

  const onDelete = async (p) => {
    const ok = await confirmDestructive({
      title: `Delete profile "${p.name}"?`,
      description: 'Their résumés, job descriptions, applications, and chats are permanently removed. Export the profile first if you might need it again.',
      actionLabel: 'Delete profile',
    });
    if (!ok) return;
    try {
      deleteProfile(p.id);
      refresh();
      toast.success(`Deleted "${p.name}".`);
    } catch (e) {
      toast.error(String(e.message || e));
    }
  };

  const onExport = async (p) => {
    if (p.id === activeId && !(await flushActiveEdits())) {
      toast.error('Could not save your latest changes — export cancelled.');
      return;
    }
    try {
      await exportProfileBackup(p.id);
    } catch (e) {
      toast.error(String(e.message || e));
    }
  };

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || adopting) return;
    try {
      const parsed = JSON.parse(await file.text());
      const profile = await importProfileBackup(parsed);
      refresh();
      toast.success(`Imported "${profile.name}" as a new profile.`);
    } catch (err) {
      toast.error(String(err.message || err));
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <SectionHeader
          title="Profiles"
          description="Separate workspaces — each keeps its own résumés, job descriptions, applications, and chats. Switch to help someone else apply without mixing your data."
        />
        {current && (
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Current profile</div>
            <div className="rounded-lg border border-primary/25 bg-primary/5 px-3.5 py-3">
              {editingId === current.id ? (
                <div className="flex items-center gap-2.5">
                  <Avatar name={draftName || current.name} className="size-9 text-[12.5px]" />
                  <Input
                    className="h-8 flex-1"
                    value={draftName}
                    autoFocus
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename(current.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                  <Button size="sm" className="h-8" onClick={() => saveRename(current.id)}>Save</Button>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <Avatar name={current.name} className="size-9 text-[12.5px]" />
                  {/* The name is the only shrinkable item in this row — the
                      "current" semantics live in the section label above, so
                      no pill/actions can crush it at narrow widths. */}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{current.name}</div>
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      Everything you see and edit belongs to this profile.
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8 shrink-0" title="Profile actions">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => { setEditingId(current.id); setDraftName(current.name); }}>
                        <Pencil className="size-3.5 shrink-0" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onExport(current)}>
                        <Download className="size-3.5 shrink-0" />
                        Export
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          </div>
        )}

        {others.length > 0 && (
          <div className={current ? 'mt-4' : undefined}>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Other profiles</span>
              <span className="text-[11.5px] tabular-nums text-muted-foreground">{others.length}</span>
            </div>
            <ul className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
              {others.map((p) => (
                <li key={p.id} className="flex items-center gap-2.5 rounded-md border px-2.5 py-1.5">
                  {editingId === p.id ? (
                    <>
                      <Avatar name={draftName || p.name} className="size-6 text-[10px]" />
                      <Input
                        className="h-7 flex-1"
                        value={draftName}
                        autoFocus
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRename(p.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                      <Button size="sm" className="h-7" onClick={() => saveRename(p.id)}>Save</Button>
                    </>
                  ) : (
                    <>
                      <Avatar name={p.name} className="size-6 text-[10px]" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
                      <Button
                        variant="outline" size="sm" className="h-7 px-2.5 text-[12px]"
                        disabled={adopting}
                        title={adopting ? 'Finish setup before switching' : `Switch to ${p.name}`}
                        onClick={() => switchTo(p.id)}
                      >
                        Switch
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-7" title="More actions">
                            <MoreHorizontal className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => { setEditingId(p.id); setDraftName(p.name); }}>
                            <Pencil className="size-3.5 shrink-0" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => onExport(p)}>
                            <Download className="size-3.5 shrink-0" />
                            Export
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => onDelete(p)}
                          >
                            <Trash2 className="size-3.5 shrink-0" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          {adding ? (
            <>
              <Input
                className="h-8 flex-1"
                placeholder="e.g. Consulting, Academic, Partner"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitNew();
                  if (e.key === 'Escape') { setAdding(false); setNewName(''); }
                }}
              />
              <Button size="sm" className="h-8" disabled={!newName.trim()} onClick={submitNew}>Create &amp; switch</Button>
              <Button variant="ghost" size="icon" className="size-8" title="Cancel" onClick={() => { setAdding(false); setNewName(''); }}>
                <X className="size-4" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" className="h-8" disabled={adopting} onClick={() => { setAdding(true); setNewName(''); }}>
                <Plus className="size-3.5" /> New profile
              </Button>
              <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={onImport} />
              <Button variant="outline" size="sm" className="h-8" disabled={adopting} onClick={() => fileRef.current?.click()}>
                <Upload className="size-3.5" /> Import profile
              </Button>
            </>
          )}
        </div>

        {adopting && (
          <p className="mt-2.5 text-[12px] text-muted-foreground">
            Finishing setup on this device — switching, creating, and importing profiles is paused until it completes (this happens after a storage hiccup and clears on the next launch).
          </p>
        )}
      </section>

      <Separator />

      <section>
        <SectionHeader title="This profile" description="A snapshot of the active workspace." />
        <div className="grid grid-cols-3 gap-2.5">
          <StatTile value={resumeCount} label={resumeCount === 1 ? 'Résumé' : 'Résumés'} />
          <StatTile value={jdCount} label={jdCount === 1 ? 'Job description' : 'Job descriptions'} />
          <StatTile value={appStats.sent} label="Applications" hint="sent" />
        </div>

        <div className="mt-2.5 grid grid-cols-3 gap-2.5">
          <StatTile value={formatRate(appStats.responseRate)} label="Response rate" />
          <StatTile value={formatRate(appStats.interviewRate)} label="Interview rate" />
          <StatTile value={formatDays(appStats.medianDaysToResponse)} label="Median to hear back" />
        </div>
      </section>

      <Separator />

      <section>
        <SectionHeader
          title="Profile completeness"
          description={`${completeness.done} of ${completeness.total} key fields filled — a fuller profile helps the AI tailor better.`}
        />
        <ul className="space-y-1.5">
          {completeness.checks.map((c) => (
            <li key={c.key} className="flex items-center gap-2 text-[13px]">
              <span className={cn(
                'flex size-4 items-center justify-center rounded-full',
                c.done ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
              )}>
                {c.done ? <Check className="size-3" /> : <X className="size-3" />}
              </span>
              <span className={cn(!c.done && 'text-muted-foreground')}>{c.label}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
