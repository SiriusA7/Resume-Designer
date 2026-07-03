// Normalize OpenRouter/OpenAI `url_citation` annotations (web-search sources)
// to a flat `{ url, title }` list for rendering.
//
// The documented shape nests the fields: `{ type: 'url_citation',
// url_citation: { url, title, ... } }` (https://openrouter.ai/docs/guides/
// features/plugins/web-search) — reading a top-level `a.url` drops every real
// citation. Some responses flatten it, so accept either shape. Entries without
// a resolvable URL are dropped.
export function normalizeCitations(annotations) {
  return (annotations || [])
    .filter((a) => a && a.type === 'url_citation')
    .map((a) => {
      const c = a.url_citation || a;
      return c.url ? { url: c.url, title: c.title || '' } : null;
    })
    .filter(Boolean);
}
