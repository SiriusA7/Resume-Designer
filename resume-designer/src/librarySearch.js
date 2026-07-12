/**
 * Library Search Module
 *
 * Tiered, in-memory search over resume variants for the Library dialog.
 * Quick tier (always on): variant name + linked applications' job title/company.
 * Deep tier (opt-in):     + flattened resume body text, linked job description
 *                         text, and the variant's chat thread messages.
 *
 * Pure functions — callers pass all data in; nothing here touches storage.
 * Single-user data volumes make a per-keystroke linear scan trivially fast.
 */

/** Flatten a variant's data object into one searchable text blob. */
export function flattenResumeText(data) {
  if (!data) return '';
  const parts = [data.name, data.tagline, data.summary, data.tools];
  for (const value of Object.values(data.contact || {})) parts.push(value);
  for (const section of data.sections || []) {
    parts.push(section.title);
    if (Array.isArray(section.content)) parts.push(...section.content);
    else parts.push(section.content);
  }
  for (const exp of data.experience || []) {
    parts.push(exp.title, exp.company, exp.dates, ...(exp.bullets || []));
  }
  for (const edu of data.education || []) parts.push(edu);
  return parts.filter((p) => typeof p === 'string' && p).join('\n');
}

/** A short window of text around the first case-insensitive match, or null. */
export function makeSnippet(text, query, radius = 40) {
  if (!text || !query) return null;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  const window = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${window}${end < text.length ? '…' : ''}`;
}

function includes(haystack, q) {
  return typeof haystack === 'string' && haystack.toLowerCase().includes(q);
}

/**
 * Search the library.
 * @returns [{ variantId, quickHit, deepHits: [{ source, snippet }] }]
 *   Empty query → all variants (browse mode). Non-empty → matches only.
 */
export function searchLibrary(query, {
  variants = [],
  applications = [],
  jobDescriptions = [],
  threads = [],
  deep = false,
} = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    return variants.map((v) => ({ variantId: v.id, quickHit: false, deepHits: [] }));
  }

  const results = [];
  for (const variant of variants) {
    const apps = applications.filter((a) => a.variantId === variant.id);

    const quickHit = includes(variant.name, q)
      || apps.some((a) => includes(a.jobSnapshot?.title, q) || includes(a.jobSnapshot?.company, q));

    const deepHits = [];
    if (deep) {
      const resumeSnippet = makeSnippet(flattenResumeText(variant.data), q);
      if (resumeSnippet) deepHits.push({ source: 'resume', snippet: resumeSnippet });

      for (const app of apps) {
        const jd = jobDescriptions.find((j) => j.id === app.jobId);
        if (!jd) continue;
        const jdSnippet = makeSnippet(`${jd.title}\n${jd.company}\n${jd.description}`, q);
        if (jdSnippet) {
          deepHits.push({ source: 'job', snippet: jdSnippet });
          break; // one job hit per variant is enough signal
        }
      }

      for (const thread of threads) {
        if (thread.homeVariantId !== variant.id) continue;
        const msg = (thread.messages || []).find((m) => includes(m?.content, q));
        if (msg) {
          deepHits.push({ source: 'chat', snippet: makeSnippet(msg.content, q) });
          break; // one chat hit per variant is enough signal
        }
      }
    }

    if (quickHit || deepHits.length > 0) {
      results.push({ variantId: variant.id, quickHit, deepHits });
    }
  }
  return results;
}
