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

  function values({ preventCancel = false } = {}) {
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

    return {
      async next() {
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
      },
      async return(value) {
        // Called when a consumer breaks out early. Without this the reader
        // stays locked and the stream can never be read again.
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
