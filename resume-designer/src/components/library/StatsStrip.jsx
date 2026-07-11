import { useMemo } from 'react';
import { computeStats } from '../../applicationStats.js';

function pct(x) {
  return x == null ? '—' : `${Math.round(x * 100)}%`;
}

function days(x) {
  if (x == null) return '—';
  if (x < 1) return '<1 day';
  const n = Math.round(x);
  return `${n} day${n === 1 ? '' : 's'}`;
}

/** Four outcome tiles + a per-resume comparison. A strip, not a dashboard. */
export default function StatsStrip({ applications }) {
  const stats = useMemo(() => computeStats(applications), [applications]);
  const tiles = [
    { label: 'Applications sent', value: String(stats.sent) },
    { label: 'Response rate', value: pct(stats.responseRate) },
    { label: 'Interview rate', value: pct(stats.interviewRate) },
    { label: 'Median time to response', value: days(stats.medianDaysToResponse) },
  ];

  return (
    <div className="shrink-0 space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border bg-card/50 px-3.5 py-2.5">
            <div className="text-[20px] font-semibold tabular-nums">{t.value}</div>
            <div className="text-[11px] text-muted-foreground">{t.label}</div>
          </div>
        ))}
      </div>
      {stats.perVariant.length > 0 && (
        <div className="rounded-lg border bg-card/50 px-3.5 py-1.5">
          {stats.perVariant.map((r) => (
            <div key={r.variantId} className="flex items-baseline justify-between gap-3 py-1 text-[12.5px]">
              <span className="min-w-0 truncate">{r.variantName || 'Untitled resume'}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {r.responded}/{r.sent} responses · {r.interviewed} interview{r.interviewed === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
