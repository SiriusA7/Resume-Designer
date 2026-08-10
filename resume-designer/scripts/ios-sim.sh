#!/usr/bin/env bash
# Build On Paper for the iOS Simulator, install it on the booted device and
# launch it. Run from anywhere; paths are resolved from this script.
#
#   npm run ios:sim            build, install, launch
#   npm run ios:sim -- --log   ...then stream the app's own log lines
#
# Why this exists rather than a line in the README:
#
#   1. `tauri ios dev` is unusable for simulators — it misclassifies every one
#      as a physical device. Build + `simctl` is the only working loop.
#   2. Tauri's post-build packaging fails with
#      `failed to rename app ...: Directory not empty (os error 66)` whenever
#      output from a previous build is still there. The failure is at the very
#      END of a long build, so it is easy to miss in a scrollback and then
#      spend a while reading logs from a stale binary that never had your
#      change in it. The two `rm -rf`s below are the whole fix.
#   3. Renaming or adding a Swift file under `src-tauri/ios/` needs
#      `xcodegen generate`, because the Xcode project is committed source now
#      (docs/ios/xcode-project-ownership.md). Doing it every time is cheap and
#      idempotent; forgetting it produces a confusing "Build input file cannot
#      be found".

set -euo pipefail

APP_ID="com.resumedesigner.app"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLE="$ROOT/src-tauri/gen/apple"
APP="$APPLE/build/arm64-sim/On Paper.app"

cd "$ROOT"

if ! xcrun simctl list devices booted | grep -q "(Booted)"; then
  echo "No booted simulator. Boot one first, e.g.:" >&2
  echo "  xcrun simctl boot 'iPhone 17' && open -a Simulator" >&2
  exit 1
fi

echo "==> Regenerating the Xcode project from project.yml"
(cd "$APPLE" && xcodegen generate >/dev/null)

echo "==> Clearing previous build output (see note 2 above)"
rm -rf "$APPLE/build/arm64-sim" "$APPLE/build/resume-designer_iOS.xcarchive"

echo "==> Building"
npx tauri ios build --debug --target aarch64-sim

echo "==> Installing and launching"
xcrun simctl terminate booted "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl install booted "$APP"
xcrun simctl launch booted "$APP_ID"

if [[ "${1:-}" == "--log" ]]; then
  echo "==> Streaming app log (ctrl-C to stop)"
  xcrun simctl spawn booted log stream --style compact \
    --predicate "process == 'On Paper'"
fi
