/**
 * Status → Badge classes for application chips. Muted = draft, warm = in
 * motion, green = win, gray = closed. Shared by the list chips and the
 * detail-pane cards so the two can't drift.
 */
export const STATUS_BADGE_CLASSES = {
  prepared: 'border-transparent bg-muted text-muted-foreground',
  applied: 'border-transparent bg-secondary text-secondary-foreground',
  heard_back: 'border-transparent bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-300',
  interview: 'border-transparent bg-orange-100 text-orange-900 dark:bg-orange-500/20 dark:text-orange-300',
  offer: 'border-transparent bg-green-100 text-green-900 dark:bg-green-500/20 dark:text-green-300',
  rejected: 'border-transparent bg-muted text-muted-foreground',
  no_response: 'border-transparent bg-muted text-muted-foreground',
};

/**
 * Status → timeline dot classes. Same palette story as the badges: muted =
 * draft/closed, warm = in motion, green = win.
 */
export const STATUS_DOT_CLASSES = {
  prepared: 'bg-muted-foreground/40',
  applied: 'bg-foreground/60',
  heard_back: 'bg-amber-500',
  interview: 'bg-orange-500',
  offer: 'bg-green-500',
  rejected: 'bg-muted-foreground/60',
  no_response: 'bg-muted-foreground/30',
};
