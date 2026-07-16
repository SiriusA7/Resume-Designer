#!/usr/bin/env node
// Validate the AI-digested release notes. The old guard compared bullet
// counts against the grouped source — which made summarization structurally
// impossible (any consolidation looked like truncation). This validator
// checks the digest CONTRACT instead: version heading, 1–8 flat bullets, and
// a trailing sentinel whose absence catches a truncated response (a
// truncated stream is still a "successful" actions/ai-inference step).
//
// CLI: `node validate-digest.mjs <digest-file> <version>` — prints the
// cleaned notes (sentinel stripped) to stdout and exits 0, or a reason to
// stderr and exits 1 (release.yml then falls back to the grouped changelog).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SENTINEL = '<!-- digest:end -->';
const MAX_BULLETS = 8;

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

  const headingRe = new RegExp(`^##\\s+Resume Designer\\s+${escapeRe(String(version))}$`);
  if (!headingRe.test(body[0] || '')) {
    return { ok: false, reason: `first line must be "## Resume Designer ${version}"` };
  }
  if (body.some((l) => l.startsWith('###'))) {
    return { ok: false, reason: 'digest must be flat — no "###" section headers' };
  }
  const bullets = body.filter((l) => /^[-*]\s+\S/.test(l));
  if (bullets.length < 1) return { ok: false, reason: 'no bullets' };
  if (bullets.length > MAX_BULLETS) {
    return { ok: false, reason: `${bullets.length} bullets — digest must have at most ${MAX_BULLETS}` };
  }

  const notes = lines
    .filter((l) => l.trim() !== SENTINEL)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
  return { ok: true, notes };
}

// CLI entry (skipped when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, version] = process.argv.slice(2);
  const result = validateDigest(readFileSync(file, 'utf8'), version || '');
  if (!result.ok) {
    console.error(`digest rejected: ${result.reason}`);
    process.exit(1);
  }
  process.stdout.write(result.notes);
}
