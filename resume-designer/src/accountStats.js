/**
 * Pure helpers for the Settings → Account section. No DOM, no storage — the
 * component reads the raw data and passes it in, so these stay unit-testable.
 */

// Up to two initials for the header avatar and the profile rows: first letter of
// the first and last name parts (single word → its first two letters).
export function profileInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// A short checklist of the User Profile fields that most improve AI tailoring,
// with a done-count and percentage — nudges the user to fill the profile out.
export function profileCompleteness(profile = {}) {
  const checks = [
    { key: 'summary', label: 'Personal summary', done: !!String(profile.personalSummary || '').trim() },
    { key: 'experience', label: 'Work experience', done: (profile.workExperience?.length || 0) > 0 },
    { key: 'skills', label: 'Skills', done: (profile.skills?.length || 0) > 0 },
    { key: 'education', label: 'Education', done: (profile.education?.length || 0) > 0 },
  ];
  const done = checks.filter((c) => c.done).length;
  return { checks, done, total: checks.length, pct: Math.round((done / checks.length) * 100) };
}

// Format a 0..1 rate as a whole-number percentage, or '—' when there's no data.
export function formatRate(rate) {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`;
}

// Format a day count (median days to response), or '—' when unknown.
export function formatDays(days) {
  if (days == null || !Number.isFinite(days)) return '—';
  const rounded = Math.round(days);
  return `${rounded} ${rounded === 1 ? 'day' : 'days'}`;
}
