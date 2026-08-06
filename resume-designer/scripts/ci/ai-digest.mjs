#!/usr/bin/env node
// Rewrite the grouped changelog into a user-facing digest, via OpenRouter.
//
// This replaced `actions/ai-inference@v1` + GitHub Models. GitHub retired
// Models on 2026-07-30, and the `v1` tag is frozen at a pre-migration release,
// so it called a dead API and returned 410 on every run — which the release
// absorbed silently, publishing the grouped-changelog fallback behind a red
// annotation nobody read.
//
// Best-effort by contract: ANY failure here exits non-zero, and release.yml
// falls back to the grouped changelog. This must never break a release.
//
// CLI: `node ai-digest.mjs <prompt-file>` — writes the model's text to stdout.
// env: OPENROUTER_API_KEY (required), SYSTEM_PROMPT, AI_MODEL (optional).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// Attribution headers, matching what the app sends (see aiService.js) so CI
// spend is legible alongside app spend on the OpenRouter dashboard.
const REFERER = 'https://github.com/ashproto/Resume-Designer';
const TITLE = 'On Paper';
// The app's own default (aiService.js DEFAULT_MODEL_ID). Release notes are
// user-facing copy, so this is a taste call, not a throughput one.
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
const TIMEOUT_MS = 120_000;
const MAX_TOKENS = 4000;

/**
 * Pull the message text out of an OpenRouter chat-completions payload.
 *
 * Exported and tested because a silent shape mismatch here is INVISIBLE: the
 * step would fail, release.yml would fall back, and the release would publish
 * looking perfectly healthy — exactly how the GitHub Models breakage survived
 * nine releases. A wrong assumption about the response shape has to fail a
 * test, not quietly disable the digest forever.
 */
export function extractDigest(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'response was not a JSON object' };
  }
  // OpenRouter reports some upstream provider failures with HTTP 200 and an
  // `error` key, so a 2xx status is not on its own evidence of a usable body.
  if (payload.error) {
    return { ok: false, reason: payload.error.message || 'provider returned an error' };
  }
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'response carried no message content' };
  }
  return { ok: true, text };
}

function fail(reason) {
  process.stderr.write(`AI digest unavailable: ${reason}\n`);
  process.exit(1);
}

async function main() {
  const [promptFile] = process.argv.slice(2);
  if (!promptFile) fail('usage: ai-digest.mjs <prompt-file>');

  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) fail('OPENROUTER_API_KEY is not set');

  const body = {
    model: (process.env.AI_MODEL || '').trim() || DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: process.env.SYSTEM_PROMPT || '' },
      { role: 'user', content: readFileSync(promptFile, 'utf8') },
    ],
  };

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': REFERER,
      'X-Title': TITLE,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // Body, not just the status: a 400 from a retired or renamed model slug
    // says so in the payload, and that is the whole diagnosis.
    const detail = await response.text().catch(() => '');
    fail(`OpenRouter returned ${response.status} ${response.statusText} ${detail.slice(0, 300)}`);
  }

  const result = extractDigest(await response.json().catch(() => null));
  if (!result.ok) fail(result.reason);
  process.stdout.write(result.text);
}

// Guarded so the export above can be imported by tests without firing a
// request (and calling process.exit) as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => fail(e?.message || String(e)));
}
