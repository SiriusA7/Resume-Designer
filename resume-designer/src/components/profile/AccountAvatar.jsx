import { Button } from '@/components/ui/button';

import { loadRegistry, getActiveProfileId, isAdoptionPending } from '../../profiles.js';
import { openSettings } from '../../settingsModal.js';
import { profileInitials } from '../../accountStats.js';

/**
 * Header account entry point: a compact initials avatar (terracotta-tinted, no
 * emoji — the app uses none) that opens Settings → Account, where profiles are
 * switched/managed and account stats live. Keeps at-a-glance "whose workspace"
 * awareness without a header-level switcher. Hidden pre-adoption (no registry /
 * no active match) and while an adoption is mid-recovery (switching then is
 * unsafe — see isAdoptionPending), matching the old switcher's guards.
 */
export function AccountAvatar() {
  const registry = loadRegistry() || [];
  const active = registry.find((p) => p.id === getActiveProfileId());
  if (!active || registry.length === 0 || isAdoptionPending()) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 rounded-full bg-primary/10 text-[11px] font-semibold tracking-tight text-primary hover:bg-primary/15"
      title={`${active.name} — account & profiles`}
      aria-label={`${active.name} — account and profiles`}
      onClick={() => openSettings('account')}
    >
      <span aria-hidden>{profileInitials(active.name)}</span>
    </Button>
  );
}
