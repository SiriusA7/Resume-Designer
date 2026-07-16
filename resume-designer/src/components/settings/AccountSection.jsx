import { useRef, useState } from 'react';
import { Check, Download, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { confirmDestructive } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

import { appStorage } from '../../appStorage.js';
import { store } from '../../store.js';
import { flushPendingProfileSave } from '../../userProfilePanel.js';
import {
  loadRegistry, getActiveProfileId, setActiveProfile, createProfile,
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

function Avatar({ name }) {
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold tracking-tight text-primary"
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
    setActiveProfile(id);
    await appStorage.flush();
    window.location.reload();
  };

  const submitNew = async () => {
    const name = newName.trim();
    if (!name || adopting) return;
    if (!(await flushActiveEdits())) {
      toast.error('Could not save your latest changes — new profile cancelled.');
      return;
    }
    const profile = createProfile({ name });
    setActiveProfile(profile.id); // new profiles start empty; land in them
    await appStorage.flush();
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
      const profile = importProfileBackup(parsed);
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
        <ul className="space-y-1.5">
          {registry.map((p) => (
            <li key={p.id} className="flex items-center gap-2.5 rounded-lg border px-3 py-2">
              {editingId === p.id ? (
                <>
                  <Avatar name={draftName || p.name} />
                  <Input
                    className="h-8 flex-1"
                    value={draftName}
                    autoFocus
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename(p.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                  <Button size="sm" className="h-8" onClick={() => saveRename(p.id)}>Save</Button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:opacity-100"
                    onClick={() => switchTo(p.id)}
                    disabled={p.id === activeId || adopting}
                    title={p.id === activeId ? 'Current profile' : (adopting ? 'Finish setup before switching' : `Switch to ${p.name}`)}
                  >
                    <Avatar name={p.name} />
                    <span className="min-w-0 truncate text-[13.5px] font-medium">{p.name}</span>
                    {p.id === activeId
                      ? <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">Current</span>
                      : <span className="text-[11.5px] text-muted-foreground">Switch</span>}
                  </button>
                  <Button
                    variant="ghost" size="icon" className="size-8" title="Rename"
                    onClick={() => { setEditingId(p.id); setDraftName(p.name); }}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon" className="size-8" title="Export this profile"
                    onClick={() => onExport(p)}
                  >
                    <Download className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive"
                    title={p.id === activeId ? 'Switch away before deleting' : (registry.length <= 1 ? 'Cannot delete the last profile' : 'Delete')}
                    disabled={p.id === activeId || registry.length <= 1}
                    onClick={() => onDelete(p)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>

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
