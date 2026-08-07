/**
 * Polyfill `ReadableStream` async iteration, which WebKit does not implement.
 *
 * pdf.js consumes its own text stream with:
 *
 *     const readableStream = this.streamTextContent(params);
 *     for await (const value of readableStream) { … }
 *
 * and `streamTextContent` returns a NATIVE `new ReadableStream(...)`. `for await`
 * looks up `Symbol.asyncIterator` on it, Safari has never shipped that on
 * ReadableStream, and the loop dies with "undefined is not a function (near
 * '...value of readableStream...')" — taking PDF import with it.
 *
 * This is NOT a pdf.js 6 regression. pdf.js 5.7.284 has the identical loop over
 * the identical native stream, so PDF import has been broken in the desktop app
 * (WKWebView) since that code path shipped. It works in Chrome, which is why
 * every browser-side check passed: the app's only WebKit surface is the one
 * place nothing automated runs.
 *
 * Implemented to match the Streams spec's `values()` so behaviour matches
 * engines that ship it natively — release the lock when the stream ends or
 * throws, and cancel on early exit unless `preventCancel` is set. A hand-rolled
 * version that skipped `return()` would leak a locked reader whenever a caller
 * broke out of the loop.
 *
 * Import this BEFORE pdf.js. ES module evaluation follows import order, so the
 * import position in resumeParser.js / pdfPreview.js is what guarantees the
 * patch is in place before pdf.js runs.
 *
 * Scope note: this fixes the MAIN thread only. pdf.js's worker bundle has its
 * own `for await (const chunk of readable)`, and that file is a prebuilt asset
 * we load by URL, so nothing can be injected ahead of it. That path is not on
 * the text-extraction route and is untouched here.
 */

/** @returns {boolean} true if the patch was applied, false if it was not needed. */
export function installReadableStreamAsyncIterator(target = globalThis) {
  const Stream = target?.ReadableStream;
  if (typeof Stream !== 'function') return false;
  if (typeof Symbol === 'undefined' || !Symbol.asyncIterator) return false;
  // Already native (Chrome, Firefox, Node) — leave it alone. Overwriting a
  // working implementation with ours would be a pure downgrade.
  if (Stream.prototype[Symbol.asyncIterator]) return false;

  function values(options) {
    // Web IDL dictionary conversion, which is stricter in BOTH directions than
    // a destructuring default. Measured against Node's native implementation:
    //
    //   values(null) / values(undefined) / values({})  -> accepted
    //   values(1) / values('x') / values(true) / values(Symbol()) -> TypeError
    //
    // A destructuring default gets both wrong: it throws on null, and it
    // silently boxes primitives instead of rejecting them. Either way a call
    // behaves differently only where this polyfill is installed, which is the
    // engine divergence the module exists to remove.
    if (options !== undefined && options !== null
        && typeof options !== 'object' && typeof options !== 'function') {
      throw new TypeError('ReadableStream.values options must be an object or null');
    }
    const { preventCancel = false } = options ?? {};
    const reader = this.getReader();
    // Once the reader is released, ANY further use of it throws
    // "Invalid state: The reader is not attached to a stream". A native async
    // iterator instead stays permanently done: `next()` keeps resolving
    // `{ done: true }` and `return()` keeps succeeding, however many times they
    // are called. Since this patches a global prototype, it has to behave the
    // same — a consumer that probes an exhausted iterator must not get a
    // TypeError only in WebKit.
    let finished = false;
    const done = (value) => ({ done: true, value });

    // Native iterators SERIALIZE their operations. `return()` called while a
    // `next()` is still in flight waits for it; cancelling underneath instead
    // resolves that pending `next()` as done and DISCARDS the chunk it was
    // about to deliver. Measured against Node's native implementation with a
    // chunk that arrives after `next()` is already waiting:
    //
    //   native: pending next() -> { value: 'late', done: false }
    //   naive:  pending next() -> { done: true }            (chunk lost)
    //
    // Every operation therefore chains on the previous one. `then(op, op)` runs
    // the next operation whether the previous settled or rejected, so one
    // failed read cannot wedge the queue forever.
    let ongoing = Promise.resolve();
    const serialize = (op) => {
      const result = ongoing.then(op, op);
      ongoing = result.then(() => undefined, () => undefined);
      return result;
    };

    async function nextOp() {
      if (finished) return done(undefined);
      try {
        const result = await reader.read();
        if (result.done) {
          finished = true;
          reader.releaseLock();
        }
        return result;
      } catch (err) {
        finished = true;
        reader.releaseLock();
        throw err;
      }
    }

    async function returnOp(value) {
      // Called when a consumer breaks out early. Without this the reader stays
      // locked and the stream can never be read again.
      if (finished) return done(value);
      finished = true;
      if (preventCancel) {
        reader.releaseLock();
      } else {
        const cancelled = reader.cancel(value);
        reader.releaseLock();
        await cancelled;
      }
      return done(value);
    }

    return {
      next() {
        return serialize(nextOp);
      },
      return(value) {
        return serialize(() => returnOp(value));
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  Stream.prototype.values = values;
  Stream.prototype[Symbol.asyncIterator] = values;
  return true;
}

installReadableStreamAsyncIterator();
