/**
 * Whether a `<input type="file">` on THIS platform can actually supply a file.
 *
 * On iOS it cannot. A hidden file input in WKWebView accepts the tap and never
 * calls back — measured, and documented at `OPShellView.importingVariant` —
 * which is why every iOS import routes through a native picker in the shell and
 * only the TEXT crosses the bridge. That arrangement has one hole: when the
 * shell is not installed, the app keeps running the plain web UI whose import
 * controls are exactly those dead inputs. The buttons still look enabled, the
 * tap still registers, and nothing happens ever.
 *
 * Two ways to reach it, both real: `OP_NATIVE_SHELL=0`, the documented control
 * for running without the shell, and `ios_shell.rs` giving up after
 * `MAX_ATTEMPTS` passes with no scene-attached window.
 *
 * Returns a message to show, or null when picking works. A message rather than
 * a boolean because the only useful thing to do with it is say it: silently
 * disabling the button would replace one unexplained no-op with another.
 */
import { isIOSPlatform } from './native.js';
import { isNativeShellAvailable } from './iosShell.js';

export function filePickBlockedReason(win = globalThis) {
  // Read off the window PASSED IN, not the ambient one. `isIOSPlatform`'s
  // parameters default to the real `navigator`, so a version of this that let
  // them default answered about the machine the test was running on rather than
  // the one described — and every case passed while proving nothing.
  const nav = win?.navigator ?? {};
  if (!isIOSPlatform(nav.userAgent ?? '', nav.platform ?? '', nav.maxTouchPoints ?? 0)) return null;
  if (isNativeShellAvailable(win)) return null;
  return 'File picking is unavailable — the native shell did not start. Reopen the app, and if this keeps happening, import from the Files app instead.';
}
