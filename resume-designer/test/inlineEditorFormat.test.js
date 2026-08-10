import { describe, it, expect } from 'vitest';
import { toggleMarkdownMarker, serializeEmphasis } from '../src/inlineEditor.js';

function el(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('toggleMarkdownMarker', () => {
  it('wraps a selection in the marker', () => {
    expect(toggleMarkdownMarker('hello world', 0, 5, '**'))
      .toEqual({ value: '**hello** world', start: 2, end: 7 });
  });

  it('unwraps an already-wrapped selection', () => {
    expect(toggleMarkdownMarker('**hello** world', 2, 7, '**'))
      .toEqual({ value: 'hello world', start: 0, end: 5 });
  });

  it('works for italic with a single-character marker', () => {
    expect(toggleMarkdownMarker('hello world', 6, 11, '_'))
      .toEqual({ value: 'hello _world_', start: 7, end: 12 });
  });

  it('works for underline', () => {
    expect(toggleMarkdownMarker('hello', 0, 5, '++'))
      .toEqual({ value: '++hello++', start: 2, end: 7 });
  });

  it('leaves an empty selection untouched', () => {
    expect(toggleMarkdownMarker('hello', 2, 2, '**'))
      .toEqual({ value: 'hello', start: 2, end: 2 });
  });

  it('does not confuse bold and italic markers', () => {
    // A `_`-toggle over text already bolded must add italics, not strip bold.
    expect(toggleMarkdownMarker('**hi**', 2, 4, '_'))
      .toEqual({ value: '**_hi_**', start: 3, end: 5 });
  });

  it('unwraps when the markers are INSIDE the selection (the select-all case)', () => {
    // startEditing auto-selects the whole raw value, markers included.
    expect(toggleMarkdownMarker('**Title**', 0, 9, '**'))
      .toEqual({ value: 'Title', start: 0, end: 5 });
  });

  it('unwraps markers inside the selection for single-character markers', () => {
    expect(toggleMarkdownMarker('_Title_', 0, 7, '_'))
      .toEqual({ value: 'Title', start: 0, end: 5 });
  });

  it('normalises a backwards selection', () => {
    expect(toggleMarkdownMarker('hello world', 5, 0, '**'))
      .toEqual({ value: '**hello** world', start: 2, end: 7 });
  });

  it('does not treat a too-short selection as wrapped', () => {
    // '**' selected alone is shorter than a full pair of markers, so it must
    // wrap rather than "unwrap" to an empty string.
    expect(toggleMarkdownMarker('**', 0, 2, '**'))
      .toEqual({ value: '******', start: 2, end: 4 });
  });
});

describe('serializeEmphasis', () => {
  it('re-applies markers for semantic tags', () => {
    expect(serializeEmphasis(el('Led <strong>infra</strong> work'))).toBe('Led **infra** work');
    expect(serializeEmphasis(el('Led <em>infra</em> work'))).toBe('Led _infra_ work');
    expect(serializeEmphasis(el('Led <u>infra</u> work'))).toBe('Led ++infra++ work');
  });

  it('re-applies markers for the presentational tags WebKit execCommand inserts', () => {
    expect(serializeEmphasis(el('Led <b>infra</b> work'))).toBe('Led **infra** work');
    expect(serializeEmphasis(el('Led <i>infra</i> work'))).toBe('Led _infra_ work');
  });

  it('returns plain text unchanged', () => {
    expect(serializeEmphasis(el('Led infra work'))).toBe('Led infra work');
  });
});
