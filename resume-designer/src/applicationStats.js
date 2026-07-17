/**
 * Application Stats Module
 * Pure helpers that turn application records into outcome metrics and
 * timeline geometry. No storage access — callers pass applications in
 * (same posture as librarySearch.js). All metric definitions live here so
 * the stats strip and timeline can't drift from each other.
 */

const DAY_MS = 86_400_000;
const RESPONSE_STATUSES = ['heard_back', 'interview', 'offer', 'rejected'];
const INTERVIEW_STATUSES = ['interview', 'offer'];

/** Earliest statusHistory timestamp matching one of `statuses`, or null. */
function firstAt(app, statuses) {
  for (const entry of app.statusHistory || []) {
    if (statuses.includes(entry.status)) return entry.at;
  }
  return null;
}

export function computeStats(applications) {
  const sentApps = applications.filter((a) => a.appliedAt);
  const respondedApps = sentApps.filter((a) => firstAt(a, RESPONSE_STATUSES));
  const interviewedApps = sentApps.filter((a) => firstAt(a, INTERVIEW_STATUSES));

  const days = respondedApps
    .map((a) => (new Date(firstAt(a, RESPONSE_STATUSES)) - new Date(a.appliedAt)) / DAY_MS)
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((x, y) => x - y);
  let medianDaysToResponse = null;
  if (days.length > 0) {
    const mid = Math.floor(days.length / 2);
    medianDaysToResponse = days.length % 2 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
  }

  const byVariant = new Map();
  for (const a of sentApps) {
    const row = byVariant.get(a.variantId)
      || { variantId: a.variantId, variantName: a.variantName, sent: 0, responded: 0, interviewed: 0 };
    row.sent += 1;
    if (firstAt(a, RESPONSE_STATUSES)) row.responded += 1;
    if (firstAt(a, INTERVIEW_STATUSES)) row.interviewed += 1;
    byVariant.set(a.variantId, row);
  }

  return {
    sent: sentApps.length,
    responded: respondedApps.length,
    responseRate: sentApps.length ? respondedApps.length / sentApps.length : null,
    interviewRate: sentApps.length ? interviewedApps.length / sentApps.length : null,
    medianDaysToResponse,
    perVariant: [...byVariant.values()].sort((a, b) => b.sent - a.sent),
  };
}

/** One point per application at appliedAt (prepared drafts: createdAt). */
export function timelinePoints(applications) {
  return applications
    .map((a) => ({
      id: a.id,
      variantId: a.variantId,
      variantName: a.variantName,
      at: a.appliedAt || a.createdAt,
      status: a.status,
      title: a.jobSnapshot?.title || '',
      company: a.jobSnapshot?.company || '',
      history: a.statusHistory || [],
    }))
    .filter((p) => p.at)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Padded [start, end] in ms; right edge reaches at least `nowIso`. */
export function timelineRange(points, nowIso) {
  if (points.length === 0) return null;
  const PAD = 3 * DAY_MS;
  const start = new Date(points[0].at).getTime() - PAD;
  const end = Math.max(
    new Date(points[points.length - 1].at).getTime(),
    new Date(nowIso).getTime(),
  ) + PAD;
  return { start, end };
}

/** First-of-month boundaries strictly inside the range (local time). */
export function monthTicks(range) {
  if (!range || range.end <= range.start) return [];
  const ticks = [];
  const d = new Date(range.start);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() + 1);
  while (d.getTime() < range.end) {
    ticks.push({
      at: d.getTime(),
      label: d.toLocaleDateString(undefined, {
        month: 'short',
        ...(d.getMonth() === 0 ? { year: 'numeric' } : null),
      }),
    });
    d.setMonth(d.getMonth() + 1);
  }
  return ticks;
}

export function positionPct(range, atIso) {
  const t = new Date(atIso).getTime();
  return Math.min(100, Math.max(0, ((t - range.start) / (range.end - range.start)) * 100));
}

/** Group points into per-variant lanes, most recent activity first. */
export function timelineLanes(points) {
  const lanes = new Map();
  for (const p of points) {
    const lane = lanes.get(p.variantId)
      || { variantId: p.variantId, variantName: p.variantName, points: [] };
    lane.points.push(p);
    lanes.set(p.variantId, lane);
  }
  return [...lanes.values()].sort((a, b) => {
    const lastA = a.points[a.points.length - 1].at;
    const lastB = b.points[b.points.length - 1].at;
    return lastB.localeCompare(lastA);
  });
}
