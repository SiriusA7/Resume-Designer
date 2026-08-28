import SwiftUI

/// A pixel-matched continuation of the native `UILaunchScreen`.
///
/// Kept decorative so launch plumbing never adds a VoiceOver stop: the person
/// is not waiting on a control, and a focusable element here would be one more
/// thing between them and their resumes.
///
/// The centre is computed from the FULL size including safe-area insets because
/// the OS screen ignores them (`UIImageRespectsSafeAreaInsets: false`). Using
/// the inset size instead moves the logo by the notch height, and the hand-off
/// jumps.
struct LaunchScreenContinuationView: View {
  static let logoSize: CGFloat = 88
  static let dissolveDuration: Double = 0.55

  /// How long the screen stays perfectly still before admitting it is waiting.
  ///
  /// The splash now holds for the first pull, so it can last a second or two on
  /// a slow network instead of flashing past. A spinner from the first frame
  /// would make every launch look like work; one that appears only once the
  /// wait is long enough to notice says "still going" exactly when that is the
  /// question, and is never seen at all on a quick launch.
  private static let spinnerDelay: Double = 0.9

  @State private var waiting = false

  var body: some View {
    GeometryReader { proxy in
      let insets = proxy.safeAreaInsets
      let fullWidth = proxy.size.width + insets.leading + insets.trailing
      let fullHeight = proxy.size.height + insets.top + insets.bottom

      ZStack {
        Color("LaunchBackground").ignoresSafeArea()
        Image("LaunchLogo")
          .resizable()
          .scaledToFit()
          .frame(width: Self.logoSize, height: Self.logoSize)
          .position(x: fullWidth / 2 - insets.leading, y: fullHeight / 2 - insets.top)
        // BELOW the logo, and positioned off the same computed centre, so the
        // logo itself stays pixel-matched to the static launch screen — the
        // whole point of this view. Anything that moved the logo to make room
        // would reintroduce the jump at hand-off.
        ProgressView()
          .controlSize(.small)
          .tint(.secondary)
          .opacity(waiting ? 1 : 0)
          .animation(.easeIn(duration: 0.3), value: waiting)
          .position(
            x: fullWidth / 2 - insets.leading,
            y: fullHeight / 2 - insets.top + Self.logoSize
          )
      }
    }
    .statusBarHidden(true)
    .accessibilityHidden(true)
    .task {
      try? await Task.sleep(for: .seconds(Self.spinnerDelay))
      waiting = true
    }
  }
}
