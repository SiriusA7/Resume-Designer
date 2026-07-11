import { useMemo } from 'react';
import {
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
} from '../ui/tooltip.jsx';
import { cn } from '@/lib/utils';
import {
  timelinePoints, timelineRange, monthTicks, positionPct, timelineLanes,
} from '../../applicationStats.js';
import { STATUS_LABELS } from '../../applications.js';
import { STATUS_DOT_CLASSES } from './statusStyles.js';

const LABEL_W = 148; // px — lane label column; axis + gridlines offset by this

const fmtDay = (isoOrMs) =>
  new Date(isoOrMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * One lane per resume, one dot per application, positioned on a shared time
 * axis (appliedAt; prepared drafts at createdAt, muted). Hover shows the
 * status progression from statusHistory; click jumps to the resume.
 */
export default function TimelineView({ applications, onSelect }) {
  const { lanes, range, ticks } = useMemo(() => {
    const points = timelinePoints(applications);
    const r = timelineRange(points, new Date().toISOString());
    return { lanes: timelineLanes(points), range: r, ticks: r ? monthTicks(r) : [] };
  }, [applications]);

  if (!range) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed p-10 text-center text-[13px] text-muted-foreground">
        No applications yet. Tailor a resume against a job — or add one from a
        resume&apos;s detail view — and it shows up here.
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="relative min-h-0 overflow-y-auto rounded-lg border bg-card/50">
        {/* month gridlines, offset past the label column */}
        {ticks.map((t) => (
          <div
            key={t.at}
            className="pointer-events-none absolute bottom-6 top-0 w-px bg-border/60"
            style={{ left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${positionPct(range, new Date(t.at).toISOString()) / 100})` }}
          />
        ))}

        {lanes.map((lane) => (
          <div key={lane.variantId} className="flex items-center border-b">
            <div
              className="shrink-0 truncate px-3 py-3 text-[12px] text-muted-foreground"
              style={{ width: LABEL_W }}
              title={lane.variantName}
            >
              {lane.variantName || 'Untitled resume'}
            </div>
            <div className="relative h-9 min-w-0 flex-1">
              {lane.points.map((p) => (
                <Tooltip key={p.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`${p.title || 'Application'}${p.company ? ` at ${p.company}` : ''} — ${STATUS_LABELS[p.status]}`}
                      onClick={() => onSelect(p.variantId)}
                      className={cn(
                        'absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-offset-background transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                        STATUS_DOT_CLASSES[p.status],
                      )}
                      style={{ left: `${positionPct(range, p.at)}%` }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[280px]">
                    <p className="font-medium">
                      {p.title || 'Application'}{p.company ? ` @ ${p.company}` : ''}
                    </p>
                    <p className="text-xs opacity-80">
                      {p.history.map((h) => `${STATUS_LABELS[h.status]} ${fmtDay(h.at)}`).join(' → ')}
                    </p>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}

        {/* time axis */}
        <div className="relative h-6" style={{ marginLeft: LABEL_W }}>
          {ticks.map((t) => (
            <span
              key={t.at}
              className="absolute top-1 -translate-x-1/2 text-[10px] text-muted-foreground"
              style={{ left: `${positionPct(range, new Date(t.at).toISOString())}%` }}
            >
              {t.label}
            </span>
          ))}
          {ticks.length === 0 && (
            <>
              <span className="absolute left-1 top-1 text-[10px] text-muted-foreground">{fmtDay(range.start)}</span>
              <span className="absolute right-1 top-1 text-[10px] text-muted-foreground">{fmtDay(range.end)}</span>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
