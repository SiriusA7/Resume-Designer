/**
 * The guard that stops an iOS import button being a no-op.
 *
 * A hidden file input in WKWebView accepts the tap and never calls back, so
 * every iOS import goes through a native picker in the shell. Without the shell
 * the web controls remain, look enabled, and do nothing — and "does nothing" is
 * the one failure a person cannot tell from "is still working".
 */
import { describe, it, expect } from 'vitest';
import { filePickBlockedReason } from '../src/filePickGuard.js';

const iphone = (shell) => ({
  navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 },
  ...(shell ? { webkit: { messageHandlers: { opShell: { postMessage() {} } } } } : {}),
});

describe('filePickBlockedReason', () => {
  it('says nothing on a desktop build, where the input works', () => {
    // The same code ships to macOS and Windows, where a file input is the only
    // picker there is — a message here would break every desktop import.
    expect(filePickBlockedReason({})).toBeNull();
  });

  it('says nothing on iOS WITH the shell, which picks natively', () => {
    expect(filePickBlockedReason(iphone(true))).toBeNull();
  });

  it('SPEAKS UP on iOS without the shell, where the input is dead', () => {
    // The case the guard exists for, and the only one where staying silent is
    // indistinguishable from the app working.
    expect(filePickBlockedReason(iphone(false))).toMatch(/native shell did not start/i);
  });

  it('reads the window it is GIVEN, not the one it is running in', () => {
    // The iPad reports a Macintosh user agent, so the touch-point count is the
    // discriminator — and it has to come from the passed window or this function
    // answers about the test runner instead. An earlier version let
    // `isIOSPlatform`'s parameters default and every case above passed vacuously.
    const ipad = {
      navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 },
    };
    expect(filePickBlockedReason(ipad)).toMatch(/native shell did not start/i);
    // A real Mac reports 0, and must keep its working file input.
    const mac = { navigator: { ...ipad.navigator, maxTouchPoints: 0 } };
    expect(filePickBlockedReason(mac)).toBeNull();
  });
});
