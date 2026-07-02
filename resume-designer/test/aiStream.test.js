import { describe, it, expect } from 'vitest';
import { createStreamAccumulator } from '../src/aiStream.js';

// Build an SSE frame for one delta object.
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

describe('createStreamAccumulator', () => {
  it('accumulates content deltas and emits content events', () => {
    const acc = createStreamAccumulator();
    const e1 = acc.push(frame({ choices: [{ delta: { content: 'Hel' } }] }));
    const e2 = acc.push(frame({ choices: [{ delta: { content: 'lo' } }] }));
    expect(e1).toEqual([{ type: 'content', delta: 'Hel', full: 'Hel' }]);
    expect(e2).toEqual([{ type: 'content', delta: 'lo', full: 'Hello' }]);
    expect(acc.result().text).toBe('Hello');
  });

  it('accumulates reasoning separately from content', () => {
    const acc = createStreamAccumulator();
    acc.push(frame({ choices: [{ delta: { reasoning: 'think ' } }] }));
    acc.push(frame({ choices: [{ delta: { reasoning: 'more' } }] }));
    acc.push(frame({ choices: [{ delta: { content: 'answer' } }] }));
    const r = acc.result();
    expect(r.reasoning).toBe('think more');
    expect(r.text).toBe('answer');
  });

  it('merges reasoning_details text by index', () => {
    const acc = createStreamAccumulator();
    acc.push(frame({ choices: [{ delta: { reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'a' }] } }] }));
    acc.push(frame({ choices: [{ delta: { reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'b' }] } }] }));
    expect(acc.result().reasoningDetails[0].text).toBe('ab');
  });

  it('keeps encrypted reasoning_details data without readable text', () => {
    const acc = createStreamAccumulator();
    acc.push(frame({ choices: [{ delta: { reasoning_details: [{ index: 0, type: 'reasoning.encrypted', data: 'XYZ' }] } }] }));
    const d = acc.result().reasoningDetails[0];
    expect(d.type).toBe('reasoning.encrypted');
    expect(d.data).toBe('XYZ');
    expect(acc.result().reasoning).toBe('');
  });

  // Some providers stream thinking ONLY as reasoning_details (no plain
  // delta.reasoning). The display text must be derived from the details so the
  // live panel gets events and the committed turn keeps its reasoning.
  it('derives reasoning text and events from details-only deltas', () => {
    const acc = createStreamAccumulator();
    const e1 = acc.push(frame({ choices: [{ delta: { reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'think ' }] } }] }));
    const e2 = acc.push(frame({ choices: [{ delta: { reasoning_details: [{ index: 1, type: 'reasoning.summary', summary: 'more' }] } }] }));
    expect(e1).toEqual([{ type: 'reasoning', delta: 'think ', full: 'think ' }]);
    expect(e2).toEqual([{ type: 'reasoning', delta: 'more', full: 'think more' }]);
    expect(acc.result().reasoning).toBe('think more');
  });

  it('does not double-count when a delta carries both reasoning and reasoning_details', () => {
    const acc = createStreamAccumulator();
    const events = acc.push(frame({
      choices: [{
        delta: {
          reasoning: 'think',
          reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'think' }],
        },
      }],
    }));
    expect(events).toEqual([{ type: 'reasoning', delta: 'think', full: 'think' }]);
    expect(acc.result().reasoning).toBe('think');
    expect(acc.result().reasoningDetails[0].text).toBe('think'); // continuity payload intact
  });

  it('collects url_citation annotations', () => {
    const acc = createStreamAccumulator();
    const events = acc.push(frame({ choices: [{ delta: { annotations: [{ type: 'url_citation', url: 'https://x.com', title: 'X' }] } }] }));
    expect(events.find((e) => e.type === 'annotations').annotations).toHaveLength(1);
    expect(acc.result().annotations[0].url).toBe('https://x.com');
  });

  it('captures usage, model and finish_reason from the final chunk', () => {
    const acc = createStreamAccumulator();
    acc.push(frame({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }], model: 'anthropic/claude-sonnet-4.6', usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.001, completion_tokens_details: { reasoning_tokens: 10 } } }));
    const r = acc.result();
    expect(r.model).toBe('anthropic/claude-sonnet-4.6');
    expect(r.finishReason).toBe('stop');
    expect(r.usage.completion_tokens_details.reasoning_tokens).toBe(10);
  });

  it('buffers a payload split across two chunks (partial line)', () => {
    const acc = createStreamAccumulator();
    const e1 = acc.push('data: {"choices":[{"delta":{"con');
    const e2 = acc.push('tent":"split"}}]}\n\n');
    expect(e1).toEqual([]);
    expect(e2).toEqual([{ type: 'content', delta: 'split', full: 'split' }]);
  });

  it('ignores keep-alive comment lines', () => {
    const acc = createStreamAccumulator();
    const events = acc.push(': OPENROUTER PROCESSING\n\n');
    expect(events).toEqual([]);
  });

  it('marks done on the [DONE] sentinel', () => {
    const acc = createStreamAccumulator();
    acc.push('data: [DONE]\n\n');
    expect(acc.result().done).toBe(true);
  });

  it('throws on a mid-stream error payload', () => {
    const acc = createStreamAccumulator();
    expect(() => acc.push(frame({ error: { message: 'rate limited', code: 429 } }))).toThrow('rate limited');
  });
});
