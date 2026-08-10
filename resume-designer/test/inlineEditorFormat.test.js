import { describe, it, expect } from 'vitest';
import { toggleMarkdownMarker } from '../src/inlineEditor.js';

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
});
