import { describe, it, expect } from 'vitest';
import { reconcileStreamBlocks, applyEdgeFade, htmlToBlocks } from '../src/components/chat/streamReconcile.js';
import { formatMessage } from '../src/markdownMessage.js';

// Mirror exactly how <StreamingMarkdown> builds the block array each token: parse
// the sanitized markdown HTML and reconcile the container to its top-level nodes.
function blocks(md) {
  const doc = new DOMParser().parseFromString(formatMessage(md), 'text/html');
  return [...doc.body.childNodes];
}
function stream(el, md) {
  reconcileStreamBlocks(el, blocks(md));
}

describe('reconcileStreamBlocks (streaming markdown)', () => {
  it('marks each brand-new block with the entrance class', () => {
    const el = document.createElement('div');
    stream(el, 'Hello');
    expect(el.children).toHaveLength(1);
    expect(el.children[0].tagName).toBe('P');
    expect(el.children[0].classList.contains('rd-stream-in')).toBe(true);
  });

  it('grows the live block IN PLACE — same element instance, animation preserved', () => {
    const el = document.createElement('div');
    stream(el, 'Hel');
    const first = el.children[0];
    stream(el, 'Hello world');
    expect(el.children[0]).toBe(first); // not torn down / re-created
    expect(el.children[0].textContent).toBe('Hello world');
    expect(el.children[0].classList.contains('rd-stream-in')).toBe(true);
  });

  it('leaves a settled block reference-stable and animates only the new one', () => {
    const el = document.createElement('div');
    stream(el, 'Para one.');
    const firstPara = el.children[0];
    stream(el, 'Para one.\n\nPara two.');
    expect(el.children).toHaveLength(2);
    expect(el.children[0]).toBe(firstPara);
    expect(el.children[1].textContent).toBe('Para two.');
    expect(el.children[1].classList.contains('rd-stream-in')).toBe(true);
  });

  it('does not re-churn a settled block on later tokens', () => {
    const el = document.createElement('div');
    stream(el, 'Para one.');
    const firstPara = el.children[0];
    const firstText = firstPara.firstChild; // inner text node
    stream(el, 'Para one.\n\nPara two.');
    stream(el, 'Para one.\n\nPara two, longer now.');
    expect(el.children[0]).toBe(firstPara);
    expect(el.children[0].firstChild).toBe(firstText); // never replaced
  });

  it('ends at the same structure as a plain one-shot render', () => {
    const md = '# Title\n\n- one\n- two\n\n`code` and **bold**';
    const el = document.createElement('div');
    stream(el, '# Title');
    stream(el, '# Title\n\n- one');
    stream(el, md);
    const oneShot = document.createElement('div');
    oneShot.replaceChildren(...blocks(md));
    const tags = (n) => [...n.children].map((c) => c.tagName);
    expect(tags(el)).toEqual(tags(oneShot));
    expect(el.textContent).toBe(oneShot.textContent);
  });

  it('trims trailing blocks when the output shrinks', () => {
    const el = document.createElement('div');
    stream(el, 'a\n\nb\n\nc');
    expect(el.children).toHaveLength(3);
    stream(el, 'a');
    expect(el.children).toHaveLength(1);
    expect(el.children[0].textContent).toBe('a');
  });

  it('handles empty content without throwing', () => {
    const el = document.createElement('div');
    expect(() => stream(el, '')).not.toThrow();
    expect(el.childNodes).toHaveLength(0);
  });

});

describe('applyEdgeFade (positional live-edge fade)', () => {
  it('wraps the last N characters of the live block', () => {
    const el = document.createElement('div');
    stream(el, 'Streaming smoothly now');
    applyEdgeFade(el, 6);
    const edge = el.querySelector('.rd-stream-edge');
    expect(edge).not.toBeNull();
    expect(edge.textContent).toBe('ly now'); // last 6 chars
    expect(el.querySelector('p').textContent).toBe('Streaming smoothly now'); // text intact
  });

  it('moves the edge to the live block and clears the one left on a settled block', () => {
    const el = document.createElement('div');
    stream(el, 'First paragraph');
    applyEdgeFade(el, 5);
    stream(el, 'First paragraph\n\nSecond');
    applyEdgeFade(el, 5);
    const edges = el.querySelectorAll('.rd-stream-edge');
    expect(edges).toHaveLength(1); // only the current live edge
    expect(edges[0].textContent).toBe('econd'); // last 5 of "Second"
  });

  it('wraps only what is available when the live block is shorter than N', () => {
    const el = document.createElement('div');
    stream(el, 'Hi');
    applyEdgeFade(el, 18);
    expect(el.querySelector('.rd-stream-edge').textContent).toBe('Hi');
  });

  it('is a no-op on an empty container', () => {
    const el = document.createElement('div');
    expect(() => applyEdgeFade(el, 6)).not.toThrow();
    expect(el.querySelector('.rd-stream-edge')).toBeNull();
  });
});

describe('htmlToBlocks (table wrapping)', () => {
  it('wraps a <table> in a scroll container, preserving the table element', () => {
    const nodes = htmlToBlocks(formatMessage('| a | b |\n|---|---|\n| 1 | 2 |'));
    const wrap = nodes.find((n) => n.nodeType === 1 && n.classList?.contains('rd-table-scroll'));
    expect(wrap).toBeTruthy();
    expect(wrap.querySelector('table')).toBeTruthy(); // still a real <table> inside
  });

  it('leaves table-free content untouched', () => {
    const nodes = htmlToBlocks(formatMessage('Just a paragraph.'));
    expect(nodes.some((n) => n.nodeName === 'P')).toBe(true);
    expect(nodes.some((n) => n.nodeType === 1 && n.classList?.contains('rd-table-scroll'))).toBe(false);
  });
});
