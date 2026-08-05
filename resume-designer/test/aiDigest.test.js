import { describe, it, expect } from 'vitest';
import { extractDigest } from '../scripts/ci/ai-digest.mjs';

// The release notes digest is a best-effort step: any failure falls back to the
// grouped changelog, so a broken digest publishes a HEALTHY-LOOKING release.
// That is precisely how the retired GitHub Models endpoint went unnoticed for
// nine releases. Parsing is therefore tested directly — a wrong assumption
// about the response shape has to fail here rather than quietly turn the
// feature off in production forever.

describe('extractDigest', () => {
  const payload = (content) => ({ choices: [{ message: { content } }] });

  it('returns the message content', () => {
    const result = extractDigest(payload('## On Paper 2.0.0\n\n- Something new'));
    expect(result.ok).toBe(true);
    expect(result.text).toBe('## On Paper 2.0.0\n\n- Something new');
  });

  // OpenRouter reports some upstream provider failures with HTTP 200 and an
  // `error` key, so response.ok is not on its own evidence of a usable body.
  it('rejects an error payload that arrived with a 200', () => {
    const result = extractDigest({ error: { message: 'upstream model is overloaded' } });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream model is overloaded');
  });

  it('rejects an error payload with no message', () => {
    expect(extractDigest({ error: { code: 502 } })).toMatchObject({ ok: false });
  });

  it('rejects a payload with no choices', () => {
    expect(extractDigest({ choices: [] }).ok).toBe(false);
    expect(extractDigest({}).ok).toBe(false);
  });

  it('rejects empty and whitespace-only content', () => {
    expect(extractDigest(payload('')).ok).toBe(false);
    expect(extractDigest(payload('   \n  ')).ok).toBe(false);
  });

  // Some chat APIs return content as an array of typed blocks rather than a
  // string. Publishing "[object Object]" as release notes would be worse than
  // falling back, so the type check is load-bearing, not defensive padding.
  it('rejects content that is not a string', () => {
    expect(extractDigest(payload([{ type: 'text', text: 'hi' }])).ok).toBe(false);
    expect(extractDigest(payload(null)).ok).toBe(false);
  });

  // A failed `response.json()` is passed through as null.
  it('rejects a body that did not parse as an object', () => {
    expect(extractDigest(null)).toMatchObject({ ok: false, reason: 'response was not a JSON object' });
    expect(extractDigest('not json').ok).toBe(false);
  });
});
