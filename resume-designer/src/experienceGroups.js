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
 * Mint one fresh `_groupId` per run of 2+ consecutive entries with an identical
 * non-empty company. Used by markdown import and by AI generation, so those paths
 * and the renderer agree on grouping by construction.
 *
 * Returns a NEW array of shallow-copied entries; the input is never mutated.
 * Entries that already carry a `_groupId` keep it.
 *
 * @param {Array<object>} entries
 * @param {() => string} [makeId]
 * @returns {Array<object>}
 */
export function assignGroupIds(entries, makeId = () => generateId('grp')) {
  const out = (Array.isArray(entries) ? entries : []).map((entry) => ({ ...entry }));

  let i = 0;
  while (i < out.length) {
    const company = companyKey(out[i].company);
    let j = i + 1;
    if (company) {
      while (j < out.length && companyKey(out[j].company) === company) j += 1;
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
