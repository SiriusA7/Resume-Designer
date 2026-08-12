#!/usr/bin/env bash
# Build On Paper for the iOS Simulator, install it on the booted device and
# launch it. Run from anywhere; paths are resolved from this script.
#
#   npm run ios:sim                       build, install, launch
#   npm run ios:sim -- --log              ...then stream the app's own log lines
#   OP_SIM_UDID=<udid> npm run ios:sim    ...onto a named device
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
#   4. `simctl ... booted` is not a device. It is "whichever booted device
#      simctl picks", so with two simulators up it can resolve to the other
#      one — and then the build succeeds, the install succeeds, and you are
#      testing the PREVIOUS binary on the device you are actually looking at.
#      That is note 2's failure mode with none of its warning signs; it cost a
#      wrong "the fix does not work" during the pinch-zoom work. So resolve one
#      device up front and address it by UDID everywhere below.

set -euo pipefail

APP_ID="com.resumedesigner.app"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLE="$ROOT/src-tauri/gen/apple"
APP="$APPLE/build/arm64-sim/On Paper.app"

cd "$ROOT"

# See note 4 above. OP_SIM_UDID wins; otherwise there has to be exactly one.
if [[ -n "${OP_SIM_UDID:-}" ]]; then
  DEVICE="$OP_SIM_UDID"
else
  BOOTED="$(xcrun simctl list devices booted \
    | sed -nE 's/.*\(([0-9A-Fa-f-]{36})\) \(Booted\).*/\1/p')"
  COUNT="$(printf '%s\n' "$BOOTED" | grep -c . || true)"
  case "$COUNT" in
    0)
      echo "No booted simulator. Boot one first, e.g.:" >&2
      echo "  xcrun simctl boot 'iPhone 17' && open -a Simulator" >&2
      exit 1
      ;;
    1)
      DEVICE="$BOOTED"
      ;;
    *)
      echo "More than one simulator is booted, so 'booted' is ambiguous:" >&2
      xcrun simctl list devices booted | grep "(Booted)" >&2
      echo >&2
      echo "Name the one you are looking at, e.g.:" >&2
      echo "  OP_SIM_UDID=$(printf '%s\n' "$BOOTED" | head -1) npm run ios:sim" >&2
      echo "...or shut the others down with 'xcrun simctl shutdown <udid>'." >&2
      exit 1
      ;;
  esac
fi

echo "==> Target simulator: $(xcrun simctl list devices | grep "$DEVICE" | sed -E 's/^ *//' || echo "$DEVICE")"

echo "==> Regenerating the Xcode project from project.yml"
(cd "$APPLE" && xcodegen generate >/dev/null)

echo "==> Clearing previous build output (see note 2 above)"
rm -rf "$APPLE/build/arm64-sim" "$APPLE/build/resume-designer_iOS.xcarchive"

echo "==> Building"
npx tauri ios build --debug --target aarch64-sim

echo "==> Installing and launching"
xcrun simctl terminate "$DEVICE" "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl install "$DEVICE" "$APP"
xcrun simctl launch "$DEVICE" "$APP_ID"

if [[ "${1:-}" == "--log" ]]; then
  echo "==> Streaming app log (ctrl-C to stop)"
  xcrun simctl spawn "$DEVICE" log stream --style compact \
    --predicate "process == 'On Paper'"
fi
