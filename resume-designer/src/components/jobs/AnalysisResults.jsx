import { Zap, Info, Minus, Check, ArrowRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// Analysis-results renderer, ported from renderAnalysisResults +
// renderRecommendationCard + the impact helpers in jobDescriptionPanel.js. Pure
// presentational (applying a recommendation is delegated to onApply), composed
// entirely from genuine shadcn primitives: a conic-gradient score ring in the
// accent, status-tinted keyword Badges, plain lists, and impact-grouped
// recommendation Cards with an impact-colored left border + a title-tooltip
// impact Badge.

function getImpactPriority(impact) {
  return ({ high: 0, medium: 1, low: 2 })[impact] ?? 1;
}

function getImpactLabel(impact) {
  return ({ high: 'High impact', medium: 'Medium impact', low: 'Low impact' })[impact] || 'Medium impact';
}

// Per-impact presentation: leading icon, the impact Badge's tint, and the
// recommendation card's left-border color.
const IMPACT = {
  high: { Icon: Zap, badge: 'bg-destructive-bg text-destructive', border: 'border-l-destructive' },
  medium: { Icon: Info, badge: 'bg-warning-bg text-warning', border: 'border-l-warning' },
  low: { Icon: Minus, badge: 'bg-muted text-muted-foreground', border: 'border-l-muted-foreground/40' },
};

function RecommendationCard({ rec, originalIndex, appliedIndexes, onApply }) {
  const isApplied = appliedIndexes.has(originalIndex);
  const impact = rec.impact || 'medium';
  const { Icon, badge, border } = IMPACT[impact] || IMPACT.medium;

  return (
    <div className={cn('rounded-[9px] border border-l-[3px] bg-card px-[13px] py-[11px]', border, isApplied && 'opacity-60')}>
      <div className="mb-[9px] flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {rec.impactReason ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge className={cn('gap-1', badge)}>
                  <Icon className="h-3 w-3" /> {getImpactLabel(impact)}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px]">{rec.impactReason}</TooltipContent>
            </Tooltip>
          ) : (
            <Badge className={cn('gap-1', badge)}>
              <Icon className="h-3 w-3" /> {getImpactLabel(impact)}
            </Badge>
          )}
          <Badge variant="secondary">{rec.section}</Badge>
        </div>
        {isApplied ? (
          <Badge className="gap-1 bg-success-bg text-success">
            <Check className="h-3 w-3" /> Applied
          </Badge>
        ) : (
          <Button size="sm" className="h-7 shrink-0" onClick={() => onApply(originalIndex)}>Apply</Button>
        )}
      </div>

      {/* Current → Suggested diff — mockup .rec-diff grid (muted box · arrow · green box). */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-[9px] text-[12.5px]">
        <div className="rounded-[7px] bg-muted px-2.5 py-2 text-muted-foreground">{rec.current}</div>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="rounded-[7px] bg-success-bg px-2.5 py-2 text-success">{rec.suggested}</div>
      </div>

      <p className="mt-[9px] text-[12px] leading-[1.5] text-muted-foreground">{rec.reason}</p>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold">{title}</h4>
      {children}
    </section>
  );
}

export function AnalysisResults({ results, appliedIndexes, onApply }) {
  if (!results) return null;

  const recommendations = (results.recommendations || [])
    .map((rec, i) => ({ ...rec, originalIndex: i }))
    .sort((a, b) => getImpactPriority(a.impact) - getImpactPriority(b.impact));

  const highImpact = recommendations.filter((r) => r.impact === 'high');
  const mediumImpact = recommendations.filter((r) => r.impact === 'medium' || !r.impact);
  const lowImpact = recommendations.filter((r) => r.impact === 'low');

  const impactCounts = { high: highImpact.length, medium: mediumImpact.length, low: lowImpact.length };

  const groups = [
    { key: 'high', items: highImpact, label: 'High impact changes', hint: 'Address these first' },
    { key: 'medium', items: mediumImpact, label: 'Medium impact changes', hint: 'Worth considering next' },
    { key: 'low', items: lowImpact, label: 'Low impact changes', hint: 'Nice-to-have changes' },
  ];

  const score = Number(results.matchScore) || 0;

  return (
    <div className="space-y-5">
      {/* Score wrap — mockup .score-wrap: conic-gradient ring (84px / 64px inner
          well) beside the matching/missing keyword lists, in a tinted card. */}
      <div className="flex items-center gap-[18px] rounded-[12px] border bg-muted/30 p-[14px]">
        <div
          className="relative grid size-[84px] shrink-0 place-items-center rounded-full"
          style={{ '--v': score, background: 'conic-gradient(var(--primary) calc(var(--v) * 1%), var(--muted) 0)' }}
        >
          <div className="grid size-[64px] place-items-center rounded-full bg-background">
            <span className="text-xl font-bold tabular-nums leading-none tracking-tight">{results.matchScore}</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Match</span>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-[9px]">
          <div className="space-y-1.5">
            <div className="text-[12px] font-semibold">Matching keywords</div>
            {(results.keywordMatches || []).length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {(results.keywordMatches || []).map((k, i) => (
                  <Badge key={i} className="border-transparent bg-success-bg text-success">{k}</Badge>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">None found.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <div className="text-[12px] font-semibold">Missing keywords</div>
            {(results.missingKeywords || []).length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {(results.missingKeywords || []).map((k, i) => (
                  <Badge key={i} className="border-transparent bg-destructive-bg text-destructive">{k}</Badge>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">None — great coverage.</p>
            )}
          </div>
        </div>
      </div>

      <Section title="Strengths">
        <ul className="space-y-1.5">
          {(results.strengths || []).map((s, i) => (
            <li key={i} className="flex gap-2 text-sm text-muted-foreground">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Gaps to address">
        <ul className="space-y-2">
          {(results.gaps || []).map((g, i) => (
            <li key={i} className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{g.area}:</span> {g.issue}
              <span className="mt-0.5 block text-sm">{g.suggestion}</span>
            </li>
          ))}
        </ul>
      </Section>

      {recommendations.length > 0 && (
        <>
          <Separator />
          <section className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold">Recommended changes</h4>
              <div className="flex items-center gap-1.5">
                {impactCounts.high > 0 && <Badge className="border-transparent bg-destructive-bg text-destructive">{impactCounts.high} high</Badge>}
                {impactCounts.medium > 0 && <Badge className="border-transparent bg-warning-bg text-warning">{impactCounts.medium} medium</Badge>}
                {impactCounts.low > 0 && <Badge className="border-transparent bg-muted text-muted-foreground">{impactCounts.low} low</Badge>}
              </div>
            </div>

            {groups.map((group) => {
              if (group.items.length === 0) return null;
              const { Icon } = IMPACT[group.key];
              return (
                <div key={group.key} className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <Icon className="h-4 w-4 shrink-0 self-center text-muted-foreground" />
                    <span className="text-sm font-medium">{group.label}</span>
                    <span className="text-xs text-muted-foreground">{group.hint}</span>
                  </div>
                  {group.items.map((rec) => (
                    <RecommendationCard
                      key={rec.originalIndex}
                      rec={rec}
                      originalIndex={rec.originalIndex}
                      appliedIndexes={appliedIndexes}
                      onApply={onApply}
                    />
                  ))}
                </div>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}
