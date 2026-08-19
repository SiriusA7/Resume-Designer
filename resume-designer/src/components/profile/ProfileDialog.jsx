import { useState, useRef, useReducer, useEffect, useCallback } from 'react';
import {
  Contact, User, Briefcase, Star, BookOpen, FolderGit2, Plus,
  Upload, Download, Sparkles, Check, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { filePickBlockedReason } from '@/filePickGuard';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { confirmDestructive } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

import { getUserProfile, saveUserProfile, downloadFile } from '../../persistence.js';
import { registerUserProfileHolder } from '../../userProfileHolder.js';
import { profileToMarkdown } from '../../profileMarkdown.js';
import { completeProfile, parseProfileImport } from '../../profileBridge.js';
import { ProfileTabContent } from './ProfileTabs.jsx';

const SAVE_DELAY = 500;

// The 7 profile sections, rendered as a left nav rail of `buttonVariants` items
// with lucide icons — the same idiom SettingsDialog uses for its tabs.
const PROFILE_TABS = [
  { id: 'contact', label: 'Contact', Icon: Contact },
  { id: 'summary', label: 'Summary', Icon: User },
  { id: 'experience', label: 'Experience', Icon: Briefcase },
  { id: 'skills', label: 'Skills', Icon: Star },
  { id: 'education', label: 'Education', Icon: BookOpen },
  { id: 'projects', label: 'Projects', Icon: FolderGit2 },
  { id: 'more', label: 'More', Icon: Plus },
];

// A deep, shape-complete clone of the stored profile to edit against (so edits
// never mutate the persisted object until saved, and every key/array exists).
// `completeProfile` lives in profileBridge.js because the native sheet builds
// the same shape from the same stored blob.
function buildWorkingCopy() {
  return completeProfile(getUserProfile());
}

/**
 * The User Profile editor — a genuine shadcn rail dialog matching SettingsDialog:
 * a glass `DialogContent` with the built-in close suppressed (the header carries
 * its own ghost X), a left `<nav>` rail of `buttonVariants` section items, and a
 * scrolling content pane. Always mounted (like Settings) so the
 * `rd:profile-flush` listener is present even when closed: that flush is
 * dispatched synchronously by backupFlow.js right before a backup import to win
 * the autosave-clobbers-import race.
 *
 * Edits mutate an in-memory working copy (a ref) and debounce-save to
 * persistence; a remount key (`version`) refreshes the uncontrolled inputs after
 * add/delete/import without disturbing the caret during typing.
 */
export default function ProfileDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('contact');
  const [saved, setSaved] = useState(false);
  const [version, bump] = useReducer((x) => x + 1, 0);

  const profileRef = useRef(null);
  if (profileRef.current === null) profileRef.current = buildWorkingCopy();
  const saveTimeoutRef = useRef(null);
  const savedTimeoutRef = useRef(null);
  // True when the last debounced save FAILED to persist (passthrough quota).
  // Without it, a fired-and-failed save leaves no pending timer, so flush()
  // would report success and a switch/export would reload away the edits.
  const failedSaveRef = useRef(false);

  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      const ok = saveUserProfile(profileRef.current) !== false;
      failedSaveRef.current = !ok;
      saveTimeoutRef.current = null;
      if (!ok) return; // don't flash "Saved ✓" over a failed persist
      setSaved(true);
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = setTimeout(() => setSaved(false), 1500);
    }, SAVE_DELAY);
  }, []);

  // Cancel the pending debounce and write immediately. Returns the persist
  // result (true when nothing was pending AND no fired save failed) so a
  // caller aborting on an unsaved edit can see a passthrough quota failure.
  // Safe to call unconditionally: it only writes when edits are pending or a
  // previous write failed — never for an untouched working copy.
  const flush = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
      const ok = saveUserProfile(profileRef.current) !== false;
      failedSaveRef.current = !ok;
      return ok;
    }
    // No timer pending — but the debounce may have already fired and FAILED,
    // discarding its result. Retry that write here so the caller either gets
    // a durable profile or a false to abort on.
    if (failedSaveRef.current) {
      const ok = saveUserProfile(profileRef.current) !== false;
      failedSaveRef.current = !ok;
      return ok;
    }
    return true;
  }, []);

  // Save + remount the tab so a structural change (add/delete) shows.
  const refresh = useCallback(() => { scheduleSave(); bump(); }, [scheduleSave]);

  // This dialog holds the app's ONE live copy of the user profile, and it is
  // mounted for the app's whole lifetime — so a profile sync landed in storage
  // was reverted by the next keystroke's debounced save, which wrote the
  // open-time snapshot back over the whole field and pushed it up as a clean,
  // uncontested update (see src/userProfileHolder.js). Register as its holder
  // while mounted, the same way useChat does for the thread list.
  //
  // `adopt` rebuilds the working copy from storage — which is exactly what the
  // caller just wrote — and bumps so the uncontrolled inputs remount onto it. It
  // deliberately does NOT save: a write-back would restamp the unit and send
  // this device's copy of what it only just received.
  //
  // `isBusy` is the dialog's own in-flight signal rather than a flag invented
  // for sync: an edit lives only in `profileRef` until the debounce fires, and a
  // fired-and-failed save is still in flight because flush() has to retry it.
  useEffect(() => registerUserProfileHolder({
    isBusy: () => saveTimeoutRef.current !== null || failedSaveRef.current,
    adopt: () => { profileRef.current = buildWorkingCopy(); bump(); },
  }), []);

  useEffect(() => {
    const onOpen = () => { profileRef.current = buildWorkingCopy(); bump(); setOpen(true); };
    // Report the flush result back through the event detail so the synchronous
    // flushPendingProfileSave() caller can abort a switch/export on failure.
    const onFlush = (e) => { const ok = flush(); if (e?.detail) e.detail.ok = ok; };
    window.addEventListener('rd:open-profile', onOpen);
    window.addEventListener('rd:profile-flush', onFlush);
    return () => {
      window.removeEventListener('rd:open-profile', onOpen);
      window.removeEventListener('rd:profile-flush', onFlush);
    };
  }, [flush]);

  const handleOpenChange = (next) => {
    if (!next) flush(); // persist pending edits on close (ESC / click-outside / X)
    setOpen(next);
  };

  const handleExport = () => {
    // Through the shared helper, not a hand-rolled `<a download>`: WKWebView
    // does nothing with one — no file, no error — so on iOS without the shell
    // this button silently produced nothing. See downloadFile in persistence.js.
    downloadFile(profileToMarkdown(profileRef.current), 'user-profile.md', 'text/markdown');
  };

  const handleImport = (file) => {
    file.text().then(async (text) => {
      const { imported, grouped, runCount } = parseProfileImport(text);
      if (runCount > 0) {
        const ok = await confirmDestructive({
          title: runCount === 1
            ? '1 employer has more than one role'
            : `${runCount} employers have more than one role`,
          description: 'Group each employer’s roles under a single company heading? Keep them separate if any of them are return stints rather than promotions.',
          actionLabel: 'Group',
          cancelLabel: 'Keep separate',
          destructive: false,
        });
        if (ok) imported.workExperience = grouped;
      }
      profileRef.current = completeProfile(imported);
      // Record the write result on the SAME tracked-save flag the debounce
      // uses. A direct save that fails (passthrough quota) must not look
      // durable: without this, closing the dialog leaves no pending timer and
      // no recorded failure, so flush() reports success and a later profile
      // switch reloads away the just-imported data. flush() retries on this
      // flag and reports false, letting the switch guard abort.
      failedSaveRef.current = saveUserProfile(profileRef.current) === false;
      if (failedSaveRef.current) {
        toast.error('Imported, but your storage is full — free space before switching profiles.');
      }
      bump();
    }).catch((err) => {
      console.error('Failed to import profile:', err);
      toast.error(`Failed to import profile: ${err.message}`);
    });
  };

  const startInterview = () => {
    // Persist any pending edit before handing off — this path bypasses
    // handleOpenChange, so without the flush the last change would sit in the
    // debounce timer and be lost if the app quits/reloads before it fires.
    flush();
    setOpen(false);
    // Let the dialog close before the chat panel takes over (matches the old flow).
    setTimeout(() => window.startProfileInterviewFromChat?.(), 200);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] w-[90vw] max-w-[740px] flex-col gap-0 overflow-hidden p-0 glass-card"
      >
        <DialogDescription className="sr-only">Background information for AI assistance</DialogDescription>

        {/* Header — mockup .dlg-head: 20px 22px 16px, title 17px, desc 13px. */}
        <div className="flex shrink-0 items-start justify-between gap-3 px-[22px] pb-4 pt-5">
          <div className="space-y-1">
            <DialogTitle>Profile</DialogTitle>
            <p className="text-[13px] text-muted-foreground">Background info for AI assistance</p>
          </div>
          <div className="flex items-center gap-1.5">
            {saved && (
              <Badge className="mr-1 gap-1 border-transparent bg-success-bg text-success">
                <Check className="h-3 w-3" />
                Saved
              </Badge>
            )}
            <Button asChild variant="outline" size="sm">
              <label
                className="cursor-pointer"
                title="Import profile from markdown file"
                onClick={(e) => {
                  // A label's default action is to activate the input it wraps.
                  // Preventing it is how this control is stopped, there being no
                  // click handler of its own to guard. See filePickGuard.
                  const blocked = filePickBlockedReason();
                  if (blocked) { e.preventDefault(); toast.error(blocked); }
                }}
              >
                <Upload className="h-4 w-4" />
                Import
                <input
                  type="file"
                  accept=".md,.markdown,.txt"
                  hidden
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleImport(f); }}
                />
              </label>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              title="Export profile to markdown file"
              onClick={handleExport}
            >
              <Download className="h-4 w-4" />
              Export
            </Button>
            <Button type="button" size="sm" title="Fill profile via AI interview" onClick={startInterview}>
              <Sparkles className="h-4 w-4" />
              AI interview
            </Button>
            <button
              type="button"
              aria-label="Close"
              onClick={() => handleOpenChange(false)}
              className="rounded-sm text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </div>
        </div>

        {/* Body: nav rail + content. Rail mirrors SettingsDialog — active item is
            terracotta-tinted (bg-primary/10 text-primary) per the mockup .rail;
            geometry pinned to .rail (172px col, 14px/10px pad) + .rail-item
            (13.5px/500, gap-9px, py-[7px]/px-2.5, rounded-md). */}
        <div className="grid min-h-0 flex-1 grid-cols-[172px_1fr] border-t">
          <nav className="flex flex-col gap-0.5 bg-muted/30 px-2.5 py-3.5">
            {PROFILE_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13.5px] font-medium transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
                  tab === id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon /> {label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 overflow-y-auto px-[22px] py-[18px]">
            <div key={`${tab}-${version}`}>
              <ProfileTabContent tab={tab} profile={profileRef.current} scheduleSave={scheduleSave} refresh={refresh} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
