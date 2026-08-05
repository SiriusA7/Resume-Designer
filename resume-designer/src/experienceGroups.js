/**
 * Experience grouping — the single source of truth for the "one employer, several
 * positions" run rule. Framework-free, no DOM, no side effects.
 *
 * A RUN is a maximal set of CONSECUTIVE entries sharing the same non-empty
 * `_groupId` AND the same non-empty `company`.
 *
 * Both halves are load-bearing:
 *  - Ids are minted fresh per tenure and never reused, so deleting or reordering
 *    the entry between two boomerang stints can never fuse them into one
 *    fabricated tenure.
 *  - Company equality is the anti-corruption rule. changeApply has no insert
 *    primitive, so an AI asked to insert a role performs a positional
 *    shift-rewrite that leaves the id on the index while replacing the content.
 *    Equality makes that entry drop out of the run visibly, rather than pulling a
 *    foreign employer under the company header.
 *
 * Adjacency alone cannot see a tenure boundary when the intervening job is OMITTED
 * from the document — an AI generating a targeted resume drops a job irrelevant to
 * the target role, and a user's own resume drops jobs they chose to leave out. The
 * two stints then arrive adjacent and adjacency-only id minting fuses them into one
 * header asserting continuous employment that never happened. `datesAreContinuous`
 * below is the second gate for callers whose input may be incomplete.
 */

import { generateId } from './store.js';

/**
 * The canonical company key for the run rule. A run needs a non-empty employer,
 * and "   " is not one — it forms a run whose header prints blank. Trimming here
 * rather than at each comparison keeps the rule in one place; every site that
 * decides run membership must use this.
 */
export function companyKey(value) {
  return String(value ?? '').trim();
}

/**
 * Partition a flat experience array into company runs.
 * @param {Array<object>} entries
 * @returns {Array<{ groupId: string|null, company: string, roles: Array<{ entry: object, index: number }> }>}
 */
export function groupExperience(entries) {
  const groups = [];
  let current = null;

  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    const groupId = entry && entry._groupId ? entry._groupId : null;
    const company = companyKey(entry && entry.company);
    const joins = current && groupId && company
      && current.groupId === groupId
      && current.company === company;

    if (joins) {
      current.roles.push({ entry, index });
    } else {
      current = { groupId, company, roles: [{ entry, index }] };
      groups.push(current);
    }
  });

  return groups;
}

/**
 * A second, deliberately STRICTER date reader than store.js#experienceSortValue.
 * The duplication is intentional and the two must NOT be merged:
 * `experienceSortValue` is a year-granular SORT KEY that reads the user-editable
 * human-readable `dates` string and degrades to 0 rather than failing, whereas the
 * run gate must be month-precise and must read only the machine-readable
 * startDate/endDate fields. Loosening this parser to match the sort key would
 * admit exactly the year-rounded boomerang the gate exists to refuse.
 *
 * Returns year*12+month, or null when the value is not strictly "YYYY-MM"
 * (an optional trailing day is tolerated).
 */
export function parseYearMonth(value) {
  const raw = String(value ?? '').trim();
  const m = raw.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (!m) return null;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  return parseInt(m[1], 10) * 12 + month;
}

// Vocabulary copied deliberately from store.js#experienceSortValue so the sort key
// and the run gate agree on what "ongoing" means. Applied to endDate ONLY.
export function isOpenEnded(value) {
  return /\b(present|current|currently|ongoing|now|to date|till date)\b/i.test(String(value ?? ''));
}

/**
 * The entry's machine-readable interval, or null when it cannot be read exactly.
 * `end === null` means open-ended (ongoing).
 */
function interval(entry) {
  const start = parseYearMonth(entry?.startDate);
  if (start === null) return null;
  if (isOpenEnded(entry?.endDate)) return { start, end: null };
  const end = parseYearMonth(entry?.endDate);
  if (end === null) return null;
  if (end < start) return null; // nonsense range — fail closed
  return { start, end };
}

/**
 * Can these two entries at one employer be part of the SAME continuous tenure?
 *
 * Used as the `canJoin` gate of `assignGroupIds` on paths whose input document may
 * be INCOMPLETE, where adjacency alone cannot distinguish a promotion from a
 * return to a former employer. Fails closed on every uncertainty; a refused pair
 * simply renders ungrouped, which is the pre-feature rendering: plainer, never false.
 *
 * The comparison is order-agnostic on purpose (older/newer are derived from the
 * dates, not the array order) — nothing enforces most-recent-first inside a run.
 *
 *  R1 fail closed on any unparseable side (missing/year-only/free-text/reversed).
 *  R2 equal starts overlap by construction, but only if BOTH ends are closed.
 *  R3 an open end is allowed only on the strictly-later-start role — otherwise
 *     "Present" copied onto the older stint would stretch it over the gap.
 *  R4 tolerance is exactly 1 month: overlap, or immediate succession
 *     (endDate 2021-06 -> startDate 2021-07). The gap is the ONLY signal that
 *     discriminates a return from a promotion, so every extra month of slack is a
 *     month of boomerang that fuses.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function datesAreContinuous(a, b) {
  const ia = interval(a);
  const ib = interval(b);
  if (!ia || !ib) return false; // R1
  if (ia.start === ib.start) return ia.end !== null && ib.end !== null; // R2
  const [older, newer] = ia.start < ib.start ? [ia, ib] : [ib, ia];
  if (older.end === null) return false; // R3
  return newer.start <= older.end + 1; // R4
}

/**
 * Mint one fresh `_groupId` per run of 2+ consecutive entries with an identical
 * non-empty company. Used by markdown import and by AI generation, so those paths
 * and the renderer agree on grouping by construction.
 *
 * Returns a NEW array of shallow-copied entries; the input is never mutated.
 * Entries that already carry a `_groupId` keep it.
 *
 * `canJoin(prev, next)` is an OPT-IN second gate on run membership, defaulting to
 * permissive. Callers that normalize a COMPLETE source document (parser.js,
 * profileMarkdown.js, aiService.js profile extraction) keep the default: there a
 * boomerang is genuinely non-adjacent, so adjacency alone is correct. The
 * generation path passes `datesAreContinuous`, because its document may omit an
 * intervening job. WARNING: the gate must NOT become the default — the
 * complete-document callers' entries carry no startDate/endDate at all, so a
 * date-based gate would stop their grouping entirely.
 *
 * With 3+ entries the run breaks at the FIRST pair that fails `canJoin`; the
 * joinable prefix (if 2+) gets one id, and scanning resumes at the failing entry,
 * so a later continuous sub-run at the same company mints its own FRESH id.
 *
 * @param {Array<object>} entries
 * @param {() => string} [makeId]
 * @param {(prev: object, next: object) => boolean} [canJoin]
 * @returns {Array<object>}
 */
export function assignGroupIds(entries, makeId = () => generateId('grp'), canJoin = () => true) {
  const out = (Array.isArray(entries) ? entries : []).map((entry) => ({ ...entry }));

  let i = 0;
  while (i < out.length) {
    const company = companyKey(out[i].company);
    let j = i + 1;
    if (company) {
      while (j < out.length
        && companyKey(out[j].company) === company
        && canJoin(out[j - 1], out[j])) j += 1;
    }
    if (company && j - i > 1) {
      const existing = out.slice(i, j).find((x) => x._groupId);
      const id = existing ? existing._groupId : makeId();
      for (let k = i; k < j; k += 1) {
        if (!out[k]._groupId) out[k]._groupId = id;
      }
    }
    i = j;
  }

  return out;
}

/**
 * Reorder experience entries WITHOUT shredding runs: partition into runs, order
 * the runs, preserve member order inside each, flatten.
 *
 * Every reordering path must go through this. Both shipped sort modes otherwise
 * interleave a foreign employer into a run, which silently drops the company
 * header from the preview and the PDF — and because applySort('custom') is a
 * no-op, the shredded order becomes the saved data with no way back.
 *
 * @param {Array<object>} entries
 * @param {(run: Array<object>) => number} runKey  Sort key for a whole run.
 * @param {(a: number, b: number) => number} compare
 * @returns {Array<object>} a new array
 */
export function sortRunAware(entries, runKey, compare) {
  const runs = groupExperience(entries).map((group) => group.roles.map((role) => role.entry));
  const decorated = runs.map((run, i) => ({ run, i, key: runKey(run) }));
  // Index tiebreak keeps the sort stable for equal keys.
  decorated.sort((a, b) => compare(a.key, b.key) || a.i - b.i);
  return decorated.flatMap((d) => d.run);
}
