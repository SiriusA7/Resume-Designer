#!/usr/bin/env node
// Validate the AI-digested release notes. The old guard compared bullet
// counts against the grouped source — which made summarization structurally
// impossible (any consolidation looked like truncation). This validator
// checks the digest CONTRACT instead: version heading, an optional prose
// summary, 1–8 flat bullets, and a trailing sentinel whose absence catches a
// truncated response (a truncated response is still a "successful" call,
// whatever the provider).
//
// CLI: `node validate-digest.mjs <digest-file> <version>` — prints the
// cleaned notes (sentinel stripped) to stdout and exits 0, or a reason to
// stderr and exits 1 (release.yml then falls back to the grouped changelog).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SENTINEL = '<!-- digest:end -->';
const MAX_BULLETS = 8;
// The orienting summary is 2-3 sentences of plain prose. The cap is a ceiling
// on runaway output, not a style rule — it sits well above anything the prompt
// asks for, because rejecting a good digest costs more than a wordy one.
export const MAX_SUMMARY_CHARS = 500;
// Markdown that turns read-only prose into structure or something clickable.
// Unlike mere verbosity, its presence means the model ignored the output format
// outright — a leaked "### Features" header is evidence the REST of the digest
// cannot be trusted either — so it fails the whole thing rather than being
// dropped.
const SUMMARY_STRUCTURE = /[#<>|`[\]]/;
const NUMBERED_LINE = /^\d+[.)]\s/;
const isBullet = (l) => /^[-*]\s+\S/.test(l);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validateDigest(text, version) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const content = lines.map((l) => l.trim()).filter((l) => l !== '');
  if (!content.length) return { ok: false, reason: 'empty digest' };

  if (content[content.length - 1] !== SENTINEL) {
    return { ok: false, reason: 'missing end sentinel — response likely truncated' };
  }
  // Substring check, not line equality: an inline sentinel inside a bullet
  // would otherwise pass and leak into the published notes.
  if (content.slice(0, -1).some((l) => l.includes(SENTINEL))) {
    return { ok: false, reason: 'sentinel appears before the end' };
  }
  const body = content.slice(0, -1);
  if (body.some((l) => l.includes('<!--'))) {
    return { ok: false, reason: 'digest must not contain HTML comments/markers' };
  }

  // Case-insensitive on the product name only. The heading is authored by the
  // model, whose casing drifts ("on paper", "ON PAPER") however plainly the
  // prompt states it. Rejecting on casing alone would silently throw away a good
  // digest and publish the raw grouped commit log instead — a worse outcome than
  // a miscased word. Everything else about the format stays strict, because that
  // strictness is what makes prompt-injected output unpublishable.
  const headingRe = new RegExp(`^##\\s+On Paper\\s+${escapeRe(String(version))}$`, 'i');
  if (!headingRe.test(body[0] || '')) {
    return { ok: false, reason: `first line must be "## On Paper ${version}"` };
  }
  // Every line after the heading MUST be a "- "/"* " bullet. The digest is a
  // flat bullet list by contract; anything else (a stray paragraph, a leaked
  // "###" section header, a prompt-injected instruction) means the AI ignored
  // the format, so reject and fall back to the grouped changelog. This subsumes
  // the old "no ### headers" and "at least one bullet" checks.
  // Everything before the first bullet is the optional orienting summary;
  // everything from the first bullet on must be a bullet. That split is what
  // lets prose lead the digest without weakening the injection guard: the
  // attack shape this has always rejected is a trailing "ignore previous
  // instructions…" line appended AFTER the bullets, and that stays rejected.
  const rest = body.slice(1);
  const firstBullet = rest.findIndex(isBullet);
  const summaryLines = firstBullet === -1 ? rest : rest.slice(0, firstBullet);
  const bulletLines = firstBullet === -1 ? [] : rest.slice(firstBullet);

  if (bulletLines.some((l) => !isBullet(l))) {
    return { ok: false, reason: 'every line after the first bullet must be a "- " bullet' };
  }
  if (bulletLines.length < 1) return { ok: false, reason: 'no bullets' };
  if (bulletLines.length > MAX_BULLETS) {
    return { ok: false, reason: `${bulletLines.length} bullets — digest must have at most ${MAX_BULLETS}` };
  }

  // Model output is hard-wrapped unpredictably, so the summary is judged as one
  // joined paragraph rather than line by line.
  const summary = summaryLines.join(' ').trim();
  let warning;
  if (SUMMARY_STRUCTURE.test(summary) || summaryLines.some((l) => NUMBERED_LINE.test(l))) {
    return { ok: false, reason: 'summary must be plain prose — no markdown, links or headers' };
  }
  // Over-length is the one soft failure. Verbosity is not evidence that the
  // format was ignored, and publishing good bullets without the summary beats
  // falling back to the raw grouped commit log.
  const keepSummary = summary !== '' && summary.length <= MAX_SUMMARY_CHARS;
  if (summary !== '' && !keepSummary) {
    warning = `summary dropped: ${summary.length} chars exceeds ${MAX_SUMMARY_CHARS}`;
  }

  // Emit the VALIDATED, normalized lines — never the raw input. The checks
  // above run on trimmed `content`, so raw lines carrying leading whitespace
  // (e.g. an AI that indents its bullets by four spaces) would pass validation
  // yet ship verbatim — and Markdown renders an indented "- " line as a code
  // block, not a bullet, silently violating the flat-digest contract. Rebuild
  // from `body` so the published notes are exactly what was checked: heading,
  // blank line, then the flat bullet list.
  const blocks = [body[0]];
  if (keepSummary) blocks.push(summary);
  blocks.push(bulletLines.join('\n'));
  const notes = `${blocks.join('\n\n')}\n`;
  return { ok: true, notes, warning };
}

// CLI entry (skipped when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, version] = process.argv.slice(2);
  const result = validateDigest(readFileSync(file, 'utf8'), version || '');
  if (!result.ok) {
    console.error(`digest rejected: ${result.reason}`);
    process.exit(1);
  }
  if (result.warning) console.error(`digest accepted with a change: ${result.warning}`);
  process.stdout.write(result.notes);
}
