import { describe, it, expect, beforeEach } from 'vitest';
import { installReadableStreamAsyncIterator } from '../src/readableStreamAsyncIterator.js';

// PDF import died in the desktop app with "undefined is not a function (near
// '...value of readableStream...')". pdf.js reads its text stream with
// `for await (const value of readableStream)` over a NATIVE ReadableStream, and
// WebKit has never shipped Symbol.asyncIterator on those.
//
// Not a pdf.js 6 regression: 5.7.284 has the identical loop over the identical
// native stream. It works in Chrome, which is exactly why nothing caught it —
// the app's only WebKit surface is the one place no automated check runs.
//
// These tests build a fake ReadableStream class so the WebKit-shaped gap can be
// simulated in Node/jsdom, which ship async iteration natively.

/** A minimal stand-in for a ReadableStream WITHOUT async iteration. */
function makeStreamClass() {
  return class FakeReadableStream {
    constructor(chunks) {
      this._chunks = [...chunks];
      this._locked = false;
      this.cancelled = false;
      this.lockReleased = false;
    }

    getReader() {
      if (this._locked) throw new TypeError('already locked');
      this._locked = true;
      const stream = this;
      return {
        async read() {
          if (!stream._chunks.length) return { done: true, value: undefined };
          return { done: false, value: stream._chunks.shift() };
        },
        releaseLock() { stream._locked = false; stream.lockReleased = true; },
        async cancel() { stream.cancelled = true; },
      };
    }
  };
}

let Stream;
let target;

beforeEach(() => {
  Stream = makeStreamClass();
  target = { ReadableStream: Stream };
});

describe('installReadableStreamAsyncIterator', () => {
  it('makes a stream iterable with for await — the failing pdf.js pattern', async () => {
    expect(installReadableStreamAsyncIterator(target)).toBe(true);

    const seen = [];
    for await (const value of new Stream(['a', 'b', 'c'])) seen.push(value);

    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('reports the exact WebKit failure when NOT installed', async () => {
    const run = async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const value of new Stream(['a'])) { /* unreachable */ }
    };
    await expect(run()).rejects.toThrow(TypeError);
  });

  // A working native implementation must not be replaced by ours.
  it('leaves a native implementation alone', () => {
    const native = function native() {};
    Stream.prototype[Symbol.asyncIterator] = native;

    expect(installReadableStreamAsyncIterator(target)).toBe(false);
    expect(Stream.prototype[Symbol.asyncIterator]).toBe(native);
  });

  it('is idempotent, so both entry points can install it', () => {
    expect(installReadableStreamAsyncIterator(target)).toBe(true);
    const first = Stream.prototype[Symbol.asyncIterator];
    expect(installReadableStreamAsyncIterator(target)).toBe(false);
    expect(Stream.prototype[Symbol.asyncIterator]).toBe(first);
  });

  // Breaking out of the loop must run the iterator's return(), or the reader
  // stays locked forever and the stream can never be read again.
  it('cancels and unlocks when a consumer exits early', async () => {
    installReadableStreamAsyncIterator(target);
    const stream = new Stream(['a', 'b', 'c']);

    for await (const value of stream) {
      if (value === 'a') break;
    }

    expect(stream.cancelled).toBe(true);
    expect(stream.lockReleased).toBe(true);
    // Provably reusable: a leaked lock would make this throw.
    expect(() => stream.getReader()).not.toThrow();
  });

  it('releases the lock when the stream ends normally', async () => {
    installReadableStreamAsyncIterator(target);
    const stream = new Stream(['only']);

    // eslint-disable-next-line no-unused-vars
    for await (const value of stream) { /* drain */ }

    expect(stream.lockReleased).toBe(true);
    expect(stream.cancelled).toBe(false);
  });

  it('does nothing when there is no ReadableStream at all', () => {
    expect(installReadableStreamAsyncIterator({})).toBe(false);
  });
});
