import { ExternalLink } from 'lucide-react';
import { isLikelySafeUrl } from '../../htmlEscape.js';
import { normalizeCitations } from './citations.js';

/**
 * Sources list from OpenRouter url_citation annotations. Only http(s) URLs are
 * linked; anything else renders as inert text.
 */
export function Citations({ annotations }) {
  const cites = normalizeCitations(annotations);
  if (cites.length === 0) return null;
  return (
    <div className="mt-2.5 border-t pt-2.5">
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Sources</div>
      <ol className="space-y-1">
        {cites.map((c, i) => {
          const safe = isLikelySafeUrl(c.url);
          const label = c.title || c.url;
          return (
            <li key={i} className="flex gap-1.5 text-[11.5px] text-muted-foreground">
              <span className="shrink-0 tabular-nums">{i + 1}.</span>
              {safe ? (
                <a href={c.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate text-primary hover:underline">
                  <span className="truncate">{label}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              ) : (
                <span className="truncate">{label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
