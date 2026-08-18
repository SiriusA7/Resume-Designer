/**
 * What a synced key holds when a REPLACEMENT restore leaves it out.
 *
 * Absence is not a message in this protocol — `collectKeyUnit` says so out
 * loud: "a key this device cannot read is one it has nothing to say about". So
 * a restore that wipes a key the backup omits deletes it here and tells nobody,
 * the server keeps the old record, and the next fetch — on this device or any
 * other — hands the content back. The same failure the résumé tombstones exist
 * for, one level up at whole keys, and the same answer: write the value the
 * deletion MEANS, which is a change the interceptor can see, rather than an
 * absence it cannot.
 *
 * The design defaults are ASKED FOR rather than copied. Each module owns the
 * value it treats as "never customised", and a second copy here would be wrong
 * the first time either changed — the design keys are the one group where the
 * cleared value is a real object rather than an empty container.
 *
 * This module sits apart from syncKeys.js deliberately: syncKeys is the
 * dependency-light authority every layer reads, and this reaches into the UI
 * services.
 */
import { defaultSpacingSettings } from '../spacingService.js';
import { defaultAccentSettings } from '../accentService.js';
import { defaultPhotoSettings } from '../photoService.js';
import { defaultFontSettings } from '../fontService.js';
import { defaultHeaderStyleSettings } from '../headerStyleService.js';

const CLEARED = new Map([
  // Content, where empty is an empty container.
  ['resume-designer-job-descriptions', () => '[]'],
  ['resume-designer-applications', () => '[]'],
  ['resume-designer-chat-threads', () => '[]'],
  ['resume-designer-chat-history', () => '[]'],
  ['resume-designer-learned-answers', () => '[]'],
  // Design, where empty is the owner's default.
  ['resume-spacing-settings', () => JSON.stringify(defaultSpacingSettings())],
  ['resume-accent-settings', () => JSON.stringify(defaultAccentSettings())],
  ['resume-photo-settings', () => JSON.stringify(defaultPhotoSettings())],
  ['resume-font-settings', () => JSON.stringify(defaultFontSettings())],
  ['resume-header-style', () => JSON.stringify(defaultHeaderStyleSettings())],
]);

/**
 * The cleared value for `logicalKey`, or undefined when clearing it cannot
 * travel. The omissions are deliberate rather than pending:
 *
 * - `resume-designer-token-usage` and the `resume-designer-history-*` keys are
 *   UNIONS on the way in (`landTokenUsage`, `landHistory`). An empty payload
 *   merges into what the receiver already holds and changes nothing, so
 *   clearing them cannot travel by newer-wins at all. That is a property of
 *   accumulating units, and making them clearable needs a deletion concept in
 *   the protocol rather than an entry here.
 * - `resume-designer-onboarding-complete` and `resume-edit-hint-dismissed` are
 *   PROMPTS, and their cleared state is the one that shows the prompt. Sending
 *   it would re-open onboarding on a device somebody is working in — a worse
 *   outcome than the stale flag, and not what a person restoring a backup on
 *   another machine is asking for.
 * - `resume-designer-data` is represented by its `resume:`/`data:` units and
 *   carries its own tombstones.
 */
export function clearedPayloadFor(logicalKey) {
  return CLEARED.get(logicalKey)?.();
}
