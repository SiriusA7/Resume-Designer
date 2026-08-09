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
      // A released reader is DETACHED: the real one throws "Invalid state: The
      // reader is not attached to a stream" on any further use. Modelling that
      // is what makes the exhaustion tests real — with a no-op releaseLock they
      // pass whether or not the polyfill tracks completion, which is exactly
      // the trap this fixture fell into first time round.
      let detached = false;
      const assertAttached = () => {
        if (detached) throw new TypeError('Invalid state: The reader is not attached to a stream');
      };
      return {
        async read() {
          assertAttached();
          if (!stream._chunks.length) return { done: true, value: undefined };
          return { done: false, value: stream._chunks.shift() };
        },
        releaseLock() { detached = true; stream._locked = false; stream.lockReleased = true; },
        async cancel() { assertAttached(); stream.cancelled = true; },
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

  // Web IDL treats null as an empty options dictionary, so this is a valid call
  // and works natively. Destructuring null throws, which would make it fail
  // only where the polyfill is installed.
  // Web IDL dictionary conversion is stricter in BOTH directions than a
  // destructuring default, which throws on null AND silently boxes primitives.
  // Both rows measured against Node's native implementation.
  it('accepts null, undefined and objects as an options dictionary', () => {
    installReadableStreamAsyncIterator(target);
    for (const opt of [null, undefined, {}, { preventCancel: true }, function f() {}]) {
      expect(() => new Stream(['a']).values(opt), String(opt)).not.toThrow();
    }
    expect(() => new Stream(['a']).values()).not.toThrow();
  });

  it('rejects primitive options the way native does', () => {
    installReadableStreamAsyncIterator(target);
    for (const opt of [1, 0, 'x', '', true, false, Symbol('s'), 10n]) {
      expect(() => new Stream(['a']).values(opt), String(opt)).toThrow(TypeError);
    }
  });

  // Native iterators serialize their operations: return() waits for an
  // in-flight next() instead of cancelling underneath it. Measured against
  // Node's native implementation with a chunk that arrives after next() is
  // already waiting, native yields the chunk and a naive version yields
  // { done: true } — silently losing data, and only in WebKit.
  it('lets a pending next() finish before return() cancels', async () => {
    installReadableStreamAsyncIterator(target);

    // A stream whose chunk arrives only AFTER next() is already waiting.
    //
    // The fake must reproduce the one behaviour that makes this lossy:
    // cancelling a real reader resolves any in-flight read() as
    // { done: true }. Without that, return() cannot clobber the pending read
    // and the test passes whether or not operations are serialized — which is
    // precisely how the first version of this test asserted nothing.
    let pendingRead = null;
    const stream = new Stream([]);
    stream.getReader = () => ({
      read: () => new Promise((resolve) => { pendingRead = resolve; }),
      releaseLock() { stream.lockReleased = true; },
      async cancel() {
        stream.cancelled = true;
        if (pendingRead) { pendingRead({ done: true, value: undefined }); pendingRead = null; }
      },
    });

    const it = stream[Symbol.asyncIterator]();
    const pending = it.next();
    const returned = it.return('early');

    // Let the queued operations start so read() is genuinely in flight.
    await new Promise((r) => { setTimeout(r, 0); });
    if (pendingRead) pendingRead({ done: false, value: 'late' });

    // The chunk must survive: return() queues behind the in-flight read.
    await expect(pending).resolves.toEqual({ done: false, value: 'late' });
    await expect(returned).resolves.toEqual({ done: true, value: 'early' });
  });

  // Releasing the reader detaches it, so ANY later use throws "the reader is
  // not attached to a stream". A native async iterator instead stays
  // permanently done. Because this patches a global prototype, a consumer that
  // probes an exhausted iterator must not get a TypeError only in WebKit.
  describe('stays permanently done once exhausted', () => {
    it('keeps returning done from next()', async () => {
      installReadableStreamAsyncIterator(target);
      const it = new Stream(['a'])[Symbol.asyncIterator]();

      expect(await it.next()).toEqual({ done: false, value: 'a' });
      expect(await it.next()).toEqual({ done: true, value: undefined });
      // The call that used to throw.
      expect(await it.next()).toEqual({ done: true, value: undefined });
      expect(await it.next()).toEqual({ done: true, value: undefined });
    });

    it('keeps resolving return() after exhaustion', async () => {
      installReadableStreamAsyncIterator(target);
      const it = new Stream(['a'])[Symbol.asyncIterator]();

      await it.next();
      await it.next();
      expect(await it.return('x')).toEqual({ done: true, value: 'x' });
      expect(await it.return('y')).toEqual({ done: true, value: 'y' });
    });

    it('does not cancel a stream that already ended on its own', async () => {
      installReadableStreamAsyncIterator(target);
      const stream = new Stream(['a']);
      const it = stream[Symbol.asyncIterator]();

      await it.next();
      await it.next();
      await it.return('x');

      // The stream finished normally; return() must not retroactively cancel it.
      expect(stream.cancelled).toBe(false);
    });

    it('stays done after a read error rather than throwing again', async () => {
      installReadableStreamAsyncIterator(target);
      const stream = new Stream(['a']);
      const it = stream[Symbol.asyncIterator]();
      stream.getReader = () => { throw new Error('unreachable'); };

      // Force the read path to fail on the reader this iterator already holds.
      const broken = new Stream(['a']);
      const it2 = broken[Symbol.asyncIterator]();
      broken._chunks = null; // makes read() throw inside next()

      await expect(it2.next()).rejects.toThrow();
      expect(await it2.next()).toEqual({ done: true, value: undefined });
      expect(await it.next()).toEqual({ done: false, value: 'a' });
    });
  });
});
