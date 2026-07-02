import { useEffect, useState } from 'react';

import { fetchReleaseHistory } from '../changelogService.js';
import { SafeMarkdown } from '@/components/ui/SafeMarkdown';

// The Settings → Updates "What's new" list. Phase 1 sources history by fetching
// the public GitHub Releases API; failures degrade to a quiet message rather
// than an error (Phase 2 adds a bundled offline base merged in).
export function ChangelogHistory() {
  const [state, setState] = useState({ loading: true, releases: [] });

  useEffect(() => {
    let alive = true;
    fetchReleaseHistory().then((releases) => {
      if (alive) setState({ loading: false, releases });
    });
    return () => { alive = false; };
  }, []);

  if (state.loading) {
    return <p className="text-sm text-muted-foreground">Loading release history…</p>;
  }
  if (!state.releases.length) {
    return <p className="text-sm text-muted-foreground">Couldn't load release history.</p>;
  }

  return (
    <div className="space-y-2.5">
      {state.releases.map((r) => (
        <details key={r.version} className="rounded-lg border px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-medium">
            v{r.version}
            {r.date && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {new Date(r.date).toLocaleDateString()}
              </span>
            )}
          </summary>
          <SafeMarkdown className="chat-markdown mt-2 text-sm" content={r.summary} />
        </details>
      ))}
    </div>
  );
}
