import { useState } from 'react';
import { Check, Plus, Users } from 'lucide-react';
import { toast } from 'sonner';

import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import { appStorage } from '../../appStorage.js';
import { loadRegistry, getActiveProfileId, setActiveProfile, createProfile } from '../../profiles.js';
import { store } from '../../store.js';
import { flushPendingProfileSave } from '../../userProfilePanel.js';

// Flush pending saves, repoint the active profile, reload. The reload is the
// whole switching mechanism — every module re-boots from the new namespace
// (same pattern as the backup-restore reload in backupFlow.js). If the pre-switch
// flush isn't durable we abort so the current profile's latest edits aren't lost.
async function switchTo(id) {
  store.saveNow();
  flushPendingProfileSave();
  const durable = await appStorage.flush();
  if (!durable) {
    toast.error('Could not save your latest changes to disk — profile switch cancelled.');
    return;
  }
  setActiveProfile(id);
  await appStorage.flush();
  window.location.reload();
}

/**
 * Header profile switcher: a ghost-button dropdown listing every profile in the
 * registry, with the active one's emoji + name on the trigger. Switching flushes
 * and reloads (see switchTo). Hidden entirely pre-adoption (no registry / no
 * active match) so it never shows during the one-time boot migration.
 *
 * "New profile…" opens a small shadcn name Dialog (the in-house pattern Header
 * uses for variant rename) rather than window.prompt, then creates + switches.
 * "Manage profiles…" dispatches rd:open-profile-manager for the Task 9 dialog.
 */
export function ProfileSwitcher() {
  const [registry, setRegistry] = useState(() => loadRegistry() || []);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');

  const activeId = getActiveProfileId();
  const active = registry.find((p) => p.id === activeId);
  if (!active || registry.length === 0) return null; // pre-adoption boot: hide

  const refresh = () => setRegistry(loadRegistry() || []);

  const openNew = () => {
    setNewName('');
    setNewOpen(true);
  };
  const submitNew = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const profile = createProfile({ name });
    setNewOpen(false);
    await switchTo(profile.id);
  };

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && refresh()}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-[34px] max-w-[180px] gap-1.5 text-[13.5px]"
            title="Switch profile"
            aria-label="Switch profile"
          >
            <span aria-hidden>{active.emoji}</span>
            <span className="min-w-0 truncate">{active.name}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Profiles</DropdownMenuLabel>
          {registry.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => p.id !== activeId && switchTo(p.id)}>
              <span aria-hidden>{p.emoji}</span>
              <span className="flex-1 truncate">{p.name}</span>
              <Check className={cn('size-4', p.id !== activeId && 'opacity-0')} />
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openNew}>
            <Plus className="size-4" /> New profile…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent('rd:open-profile-manager'))}>
            <Users className="size-4" /> Manage profiles…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-sm glass-card">
          <DialogHeader>
            <DialogTitle>New profile</DialogTitle>
            <DialogDescription className="sr-only">Enter a name for the new profile</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitNew} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-profile-input">Name</Label>
              <Input
                id="new-profile-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Consulting, Academic"
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setNewOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newName.trim()}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
