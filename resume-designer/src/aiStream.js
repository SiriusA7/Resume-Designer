/**
 * Pure SSE accumulator for OpenRouter streaming chat-completions.
 *
 * No I/O: feed decoded text chunks to push() and it returns the events that
 * fired (content / reasoning / annotations); result() returns the accumulated
 * state. Extracted from aiService so the framing logic is unit-testable without
 * the network. SSE framing per the OpenRouter stream: `data: {json}` lines,
 * `: keep-alive` comments, and a final `data: [DONE]`.
 */
export function createStreamAccumulator() {
  let buffer = '';
  let content = '';
  let reasoning = '';
  const reasoningDetails = [];
  let annotations = [];
  let usage = null;
  let model = null;
  let finishReason = null;
  let done = false;

  function mergeReasoningDetails(arr) {
    for (const d of arr) {
      if (!d || typeof d.index !== 'number') { reasoningDetails.push(d); continue; }
      const cur = reasoningDetails[d.index] || {};
      reasoningDetails[d.index] = {
        ...cur,
        ...d,
        text: (cur.text || '') + (d.text || ''),
        summary: (cur.summary || '') + (d.summary || ''),
        data: d.data != null ? d.data : cur.data,
      };
    }
  }

  function handlePayload(payload, events) {
    if (payload === '[DONE]') { done = true; return; }
    let json;
    try { json = JSON.parse(payload); } catch { return; } // ignore unparseable fragments
    if (json.error) {
      throw new Error(json.error.message || `OpenRouter stream error ${json.error.code || ''}`.trim());
    }
    if (json.model) model = json.model;
    if (json.usage) usage = json.usage;
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      events.push({ type: 'content', delta: delta.content, full: content });
    }
    const hasPlainReasoning = typeof delta.reasoning === 'string' && !!delta.reasoning;
    if (hasPlainReasoning) {
      reasoning += delta.reasoning;
      events.push({ type: 'reasoning', delta: delta.reasoning, full: reasoning });
    }
    if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) {
      mergeReasoningDetails(delta.reasoning_details);
      // Some providers stream thinking ONLY as reasoning_details. Derive the
      // display text from them so the live panel gets events and the committed
      // turn keeps its reasoning — but only when this delta carried no plain
      // `reasoning` string, which is the same text already counted above.
      if (!hasPlainReasoning) {
        const derived = delta.reasoning_details
          .map((d) => (d && (d.text || d.summary)) || '')
          .join('');
        if (derived) {
          reasoning += derived;
          events.push({ type: 'reasoning', delta: derived, full: reasoning });
        }
      }
    }
    if (Array.isArray(delta.annotations) && delta.annotations.length) {
      annotations = annotations.concat(delta.annotations);
      events.push({ type: 'annotations', annotations: annotations.slice() });
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  return {
    push(chunk) {
      buffer += chunk;
      const events = [];
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep any partial trailing line for next push
      for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) handlePayload(line.slice(5).trim(), events);
      }
      return events;
    },
    result() {
      return {
        text: content,
        reasoning,
        reasoningDetails: reasoningDetails.filter(Boolean),
        annotations,
        usage,
        model,
        finishReason,
        done,
      };
    },
  };
}
