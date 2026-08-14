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
      }
    }
    .statusBarHidden(true)
    .accessibilityHidden(true)
  }
}
