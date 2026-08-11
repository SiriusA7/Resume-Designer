// The native iOS chrome for On Paper.
//
// tao owns the application lifecycle, the run loop, the UIWindow and the
// WKWebView, exactly as it does on every other platform. Once the window is
// scene-attached, `src-tauri/src/ios_shell.rs` calls `installShell` here, which
// makes a UIHostingController the window's rootViewController and moves wry's
// existing WKWebView into it. See docs/ios/swiftui-lifecycle-spike.md for why
// this is the only route that keeps Tauri whole — inverting the lifecycle so
// Swift owns `@main` is not merely hard, it is ruled out by an assertion in tao.
//
// The webview keeps rendering the résumé canvas, which is not negotiable: PDF
// export hands WKWebView's `createPDF` the live app DOM, so a SwiftUI résumé
// would mean a second rendering engine drifting from the first. What this file
// replaces is only the chrome AROUND that canvas.
//
// This file is compiled straight from here — `project.yml` adds `../../ios` as
// a source path. Do not copy it into `gen/apple/Sources`.
// Its JS counterpart is `src/iosShell.js`; the two share a wire contract that
// is unit-tested there (test/iosShell.test.js).

import SwiftUI
import UIKit
import WebKit

// MARK: - Wire contract

/// Mirrors `buildSnapshot()` in src/iosShell.js. Changing either side without
/// the other silently empties the chrome.
struct ShellSnapshot: Decodable, Equatable {
  struct Variant: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
  }

  var variantId: String?
  var variantName: String
  var variants: [Variant]
  var zoom: Double
  var zoomPercent: Int
  var pdfBusy: Bool
  /// A web dialog owns the screen. The chrome floats above the webview, so it
  /// has to step aside or it covers the dialog's own buttons.
  var modalOpen: Bool
  var settings: Settings
  /// `nil` while the chat sheet is closed. Same reasoning as `document`.
  var chat: ChatView?
  /// `nil` while the library is closed.
  var library: [LibraryEntry]?

  struct LibraryEntry: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let updatedAt: String
    let applicationCount: Int
    let status: String
    let snippet: String
    let snippetSource: String
  }

  /// Mirrors `buildChatView()` in src/iosShell.js. A subset: threads, messages,
  /// streaming and sending. The model picker, context chips and the AI's
  /// proposed CHANGES stay in the web panel — applying a change runs the diff
  /// engine and a review session, and a partial native version of that is how
  /// someone accepts an edit they never saw.
  struct ChatView: Decodable, Equatable {
    struct Thread: Decodable, Equatable, Identifiable {
      let id: String
      let title: String
      let isCurrent: Bool
    }
    struct Message: Decodable, Equatable, Identifiable {
      let id: String
      let role: String
      let text: String
      let hasChanges: Bool
      /// Raw reasoning summary, unparsed. `ReasoningTimeline` splits and strips
      /// it — the same job `LiveReasoning.jsx` does on the web.
      let reasoning: String
    }
    var threads: [Thread]
    var messages: [Message]
    /// The AI's still-pending edits, from the LIVE review session — not a
    /// message's frozen copy, so applying one removes it here.
    var pendingChanges: [PendingChange]

    struct PendingChange: Decodable, Equatable, Identifiable {
      let path: String
      let label: String
      let type: String
      let before: String
      let after: String
      var id: String { path }
    }

    var loading: Bool
    var streaming: Bool
    var configured: Bool
    /// The engine's live status line. Empty when idle.
    var thinking: String
    var currentModel: String
    var models: [ModelOption]
    var reasoningEffort: String
    var reasoningSupported: Bool

    struct ModelOption: Decodable, Equatable, Identifiable {
      let id: String
      let label: String
      let group: String
    }
  }

  /// `nil` means the panel is closed and the outline is not being streamed —
  /// distinct from an empty outline, which would blank an open panel.
  var document: DocumentOutline?

  /// A flat, path-keyed projection of the résumé. Swift deliberately does NOT
  /// know the document's schema: it renders labelled fields and echoes back the
  /// paths it was given, so it cannot construct one and cannot become a second
  /// implementation of a grammar whose drift has corrupted data before.
  struct DocumentOutline: Decodable, Equatable {
    struct Field: Decodable, Equatable, Identifiable {
      let path: String
      let label: String
      let value: String
      let multiline: Bool
      var id: String { path }
    }
    struct Group: Decodable, Equatable, Identifiable {
      let id: String
      let title: String
      let fields: [Field]
      /// The path of the ARRAY behind this group's list rows, or nil when the
      /// group is a set of fields on one object and cannot be reordered.
      let listPath: String?
      /// How many non-list rows precede the list (a section's heading, a role's
      /// title/company/dates), so a row index maps to an array index.
      let listOffset: Int
    }
    var groups: [Group]
  }

  /// Mirrors `buildSettings()` in src/iosShell.js. A SUBSET of the web Settings
  /// dialog: the updater, the companion bridge and the legacy Electron import
  /// are all desktop-only, and showing controls that cannot work is worse than
  /// not showing them.
  ///
  /// `hasApiKey`, not the key. The key lives in the OS keychain; the sheet can
  /// write a new one but nothing needs to read it back, so nothing does.
  struct Settings: Decodable, Equatable {
    var theme: String
    var hasApiKey: Bool
    var autoFallback: Bool
    var version: String

    static let empty = Settings(theme: "system", hasApiKey: false, autoFallback: false, version: "")
  }

  /// What the chrome shows before the first snapshot arrives — a fraction of a
  /// second at launch, but it must not render as blank or as "0%".
  static let empty = ShellSnapshot(
    variantId: nil, variantName: "On Paper", variants: [],
    zoom: 1, zoomPercent: 100, pdfBusy: false, modalOpen: false, settings: .empty,
    chat: nil, library: nil, document: nil
  )
}

// MARK: - Model

/// The single piece of state the chrome renders from. Deliberately not durable:
/// `appStorage` and the Rust disk store stay the source of truth, and this is a
/// projection of them that is thrown away on every update.
@MainActor
final class ShellModel: ObservableObject {
  @Published var snapshot: ShellSnapshot = .empty

  /// Weak: the webview belongs to wry and is retained by the view hierarchy.
  weak var webView: WKWebView?

  /// Percent last sent, so a pinch does not fire a command per touch event.
  private var lastZoomPercentSent = -1

  /// Drive the web zoom model from a native pinch.
  ///
  /// Clamped to the same range `zoomControls.js` uses, and throttled to whole
  /// percent changes — a pinch delivers events far faster than the store wants
  /// writes, and the readout cannot show more precision than this anyway.
  func setZoom(_ value: Double) {
    let clamped = min(max(value, 0.25), 2.0)
    let percent = Int((clamped * 100).rounded())
    guard percent != lastZoomPercentSent else { return }
    lastZoomPercentSent = percent
    send("setZoom", ["value": String(format: "%.4f", clamped)])
  }

  /// Send a command to `window.__opShell.command()`.
  ///
  /// The payload crosses as a JS *string literal* rather than an object
  /// literal, so nothing in it can be parsed as code however it was built.
  func send(_ type: String, _ extra: [String: String] = [:]) {
    var body: [String: String] = extra
    body["type"] = type
    guard let json = try? JSONSerialization.data(withJSONObject: body),
          let text = String(data: json, encoding: .utf8),
          let literal = Self.jsStringLiteral(text) else {
      NSLog("[OPShell] could not encode command: \(type)")
      return
    }
    webView?.evaluateJavaScript("window.__opShell && window.__opShell.command(\(literal))") { _, error in
      if let error { NSLog("[OPShell] command \(type) failed: \(error)") }
    }
  }

  /// Quote `text` as a JS string literal using JSON's own escaping.
  private static func jsStringLiteral(_ text: String) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: [text]),
          let array = String(data: data, encoding: .utf8) else { return nil }
    // Strip the array brackets JSONSerialization needs at top level.
    let quoted = String(array.dropFirst().dropLast())
    // JSON permits raw U+2028/U+2029 inside strings; older JS parsers reject
    // them inside string literals. Cheap to escape, so never worth debugging.
    return quoted
      .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
      .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
  }
}

/// Receives snapshots from `window.webkit.messageHandlers.opShell`.
///
/// A separate object because `WKUserContentController` retains its handlers
/// strongly: were `ShellModel` itself the handler, the webview's configuration
/// would retain the model, the model's view would retain the webview, and
/// nothing would ever deallocate.
private final class SnapshotBridge: NSObject, WKScriptMessageHandler {
  weak var model: ShellModel?

  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard JSONSerialization.isValidJSONObject(message.body),
          let data = try? JSONSerialization.data(withJSONObject: message.body),
          let body = message.body as? [String: Any] else {
      NSLog("[OPShell] undecodable message: \(message.body)")
      return
    }

    switch body["kind"] as? String {
    case "share":
      guard let path = body["path"] as? String else {
        NSLog("[OPShell] share message with no path: \(body)")
        return
      }
      NSLog("[OPShell] share requested: \(path)")
      Task { @MainActor in OPShell.presentShareSheet(path: path) }
    default:
      guard let snapshot = try? JSONDecoder().decode(ShellSnapshot.self, from: data) else {
        NSLog("[OPShell] undecodable snapshot: \(message.body)")
        return
      }
      Task { @MainActor in self.model?.snapshot = snapshot }
    }
  }
}

// MARK: - Entry point

/// Objective-C entry point `src-tauri/src/ios_shell.rs` calls through
/// `objc_msgSend`. The explicit `@objc(...)` names are load-bearing: Swift
/// would otherwise mangle both the class symbol and the selector, and
/// `AnyClass::get(c"OPShell")` would return `None`.
@objc(OPShell)
final class OPShell: NSObject {
  /// Retains the model for the app's lifetime. The hosting controller's root
  /// view holds it too, but this makes the ownership explicit rather than an
  /// inference about SwiftUI's storage.
  @MainActor private static var model: ShellModel?
  @MainActor private static var bridge: SnapshotBridge?

  /// Installs the chrome into `window` and reparents `webView` into it.
  /// Main thread only; Rust guarantees a single invocation.
  @objc(installShellInWindow:webView:)
  static func installShell(window: UIWindow, webView: UIView) {
    MainActor.assumeIsolated {
      let model = ShellModel()
      model.webView = webView as? WKWebView
      self.model = model

      if let wk = webView as? WKWebView {
        let bridge = SnapshotBridge()
        bridge.model = model
        self.bridge = bridge
        // Named to match SHELL_HANDLER in src/iosShell.js.
        wk.configuration.userContentController.add(bridge, name: "opShell")
      } else {
        NSLog("[OPShell] not a WKWebView (\(type(of: webView))) — chrome will render, snapshots will not arrive")
      }

      // Capture tao's view controller BEFORE displacing it as root. It must
      // stay in the window hierarchy — see CanvasHost for what breaks otherwise.
      let taoController = window.rootViewController

      let host = UIHostingController(
        rootView: ShellView(model: model, taoController: taoController, webView: webView)
      )
      window.rootViewController = host
      window.makeKeyAndVisible()

      NSLog("[OPShell] installed: root=\(type(of: host)) webview=\(type(of: webView))")
      activateWeb()
    }
  }

  /// Present a share sheet for a file Rust staged (`stage_pdf_for_share`).
  ///
  /// iOS has no save-to-path dialog. `tauri-plugin-dialog`'s `save_file`
  /// approximates one with `UIDocumentPickerViewController(.exportToService)`
  /// presented on tao's view controller — and once tao is a CHILD of the
  /// hosting controller, that picker's remote view service launches and then
  /// never appears. Measured, twice.
  ///
  /// Presenting from the hosting controller — the window's actual root — avoids
  /// the whole question, and a share sheet is the better answer anyway: it
  /// offers Save to Files, AirDrop, Mail and Messages where the picker offered
  /// only a file location.
  @MainActor
  static func presentShareSheet(path: String) {
    guard let root = model?.webView?.window?.rootViewController else {
      NSLog("[OPShell] no root view controller to share from")
      return
    }
    NSLog("[OPShell] presenting share sheet from \(type(of: root))")
    let url = URL(fileURLWithPath: path)
    let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    // iPad presents this as a popover and CRASHES without an anchor. Anchor it
    // to the top-trailing corner, under the PDF button that started the export.
    if let popover = sheet.popoverPresentationController {
      popover.sourceView = root.view
      popover.sourceRect = CGRect(
        x: root.view.bounds.maxX - 40, y: root.view.safeAreaInsets.top, width: 1, height: 1
      )
      popover.permittedArrowDirections = [.up]
    }
    // A dialog may still be dismissing; present from whatever is frontmost.
    var presenter: UIViewController = root
    while let next = presenter.presentedViewController { presenter = next }
    presenter.present(sheet, animated: true)
  }

  @MainActor private static var handedOver = false

  /// Turn off WKWebView's own pinch zoom, so the app's CSS zoom model — the
  /// only one that reaches below 100% — is the single scale on the canvas.
  ///
  /// Called AFTER the handover, not at install: WebKit creates the scroll
  /// view's `pinchGestureRecognizer` lazily once the page and its viewport are
  /// parsed, so at install time it is still nil and disabling it is a silent
  /// no-op. Measured — that is exactly what the first version of this did, and
  /// a pinch went on scaling the page while the toolbar's readout sat still.
  ///
  /// Re-asserted once a second later because the recognizer can arrive after
  /// the first JS callback returns.
  @MainActor
  private static func disableWebViewPinch(attempt: Int = 0) {
    guard let scrollView = model?.webView?.scrollView else { return }
    scrollView.pinchGestureRecognizer?.isEnabled = false
    scrollView.minimumZoomScale = 1
    scrollView.maximumZoomScale = 1
    scrollView.bouncesZoom = false
    if attempt == 0 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { disableWebViewPinch(attempt: 1) }
    }
  }

  /// Hand the web side the class that hides its own chrome and ask it for a
  /// first snapshot.
  ///
  /// Retried, because the shell installs as soon as the window is
  /// scene-attached — which is normally BEFORE `src/main.js` has booted, and
  /// can be before the document that will run it even exists. A one-shot call
  /// sets a flag on a page that is about to be replaced, and the app comes up
  /// showing both chromes stacked on each other.
  ///
  /// The retry is scheduled by the timer, NOT from the completion handler:
  /// `evaluateJavaScript` against a webview that is still loading never calls
  /// back at all, so a chain driven by the callback stops after one attempt
  /// and takes the whole handover with it. Measured, not theorised — that was
  /// this function's first shape.
  @MainActor
  private static func activateWeb(attempt: Int = 0) {
    guard !handedOver else { return }
    guard let webView = model?.webView else {
      NSLog("[OPShell] no WKWebView to activate against")
      return
    }
    guard attempt < 100 else {
      NSLog("[OPShell] web side never activated — is initIOSShell() wired into main.js?")
      return
    }

    webView.evaluateJavaScript(
      "(function(){"
      + "window.__opShellPendingActivate = true;"
      + "return !!(window.__opShell && window.__opShell.activate());"
      + "})()"
    ) { result, error in
      MainActor.assumeIsolated {
        if result as? Bool == true, !handedOver {
          handedOver = true
          NSLog("[OPShell] web chrome handed over after \(attempt) retries")
          disableWebViewPinch()
        } else if let error, attempt == 0 {
          NSLog("[OPShell] first activation attempt errored (expected while loading): \(error)")
        }
      }
    }

    // 100 x 150ms = 15s. First-run boot waits on storage init and the legacy
    // migration probe, so the budget has to outlast those.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
      activateWeb(attempt: attempt + 1)
    }
  }
}

// MARK: - Hosting the webview

/// Hosts the *existing* webview as SwiftUI content. Nothing is recreated — that
/// is the whole point: Tauri's IPC, its script message handlers and the loaded
/// document all survive.
///
/// It re-parents tao's whole VIEW CONTROLLER rather than lifting the WKWebView
/// out of it, using real UIKit containment. That is not tidiness:
///
///   **`tauri-plugin-dialog` presents its `UIAlertController` on tao's view
///   controller.** Displace that controller as the window's root and leave it
///   out of the hierarchy, and every native dialog fails with "whose view is not
///   in the window hierarchy" — silently, since the presentation just never
///   happens and the JS promise never settles. That takes down the PDF export's
///   save dialog and, worse, the whole Phase 3.1 data-loss fix, which routes
///   every destructive confirmation through this plugin.
///
/// Found by exporting a PDF and watching the button spin forever. The webview
/// stays exactly where wry put it; only its ancestry above tao's controller
/// changes.
private struct CanvasHost: UIViewControllerRepresentable {
  let taoController: UIViewController?
  let webView: UIView
  let onPinch: (CGFloat, UIGestureRecognizer.State) -> Void

  /// A real `UIPinchGestureRecognizer`, not SwiftUI's `MagnifyGesture`.
  ///
  /// SwiftUI gestures attached to a hosted UIKit view lose the arbitration to
  /// WKWebView's own recognizers — measured: `MagnifyGesture.onChanged` never
  /// fired once while the page went on scaling underneath. Attaching the
  /// recognizer directly, with a delegate that allows simultaneous recognition,
  /// puts us in the same arbitration WebKit is in rather than above it.
  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    let onPinch: (CGFloat, UIGestureRecognizer.State) -> Void
    init(onPinch: @escaping (CGFloat, UIGestureRecognizer.State) -> Void) {
      self.onPinch = onPinch
    }
    @objc func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
      onPinch(recognizer.scale, recognizer.state)
    }
    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool { true }
  }

  func makeCoordinator() -> Coordinator { Coordinator(onPinch: onPinch) }

  func makeUIViewController(context: Context) -> UIViewController {
    let container = UIViewController()
    container.view.backgroundColor = .systemBackground

    let pinch = UIPinchGestureRecognizer(
      target: context.coordinator, action: #selector(Coordinator.handlePinch(_:))
    )
    pinch.delegate = context.coordinator
    container.view.addGestureRecognizer(pinch)

    // ios_view.rs drives these views by frame + autoresizing mask. Inside
    // SwiftUI it has to be Auto Layout's job instead, which is also why
    // rotation keeps working with tao's controller no longer the root.
    if let tao = taoController {
      container.addChild(tao)
      tao.view.translatesAutoresizingMaskIntoConstraints = false
      container.view.addSubview(tao.view)
      pin(tao.view, to: container.view)
      tao.didMove(toParent: container)

      // The webview needs pinning too, not just its controller's view.
      //
      // `ios_view.rs` sizes the webview to `UIScreen.bounds` and gives it a
      // flexible autoresizing mask. Reparenting moved its ORIGIN into the
      // content area but left its HEIGHT at the full screen's, so the page ran
      // ~114pt (the two bars) off the bottom of the display. Everything still
      // looked right, because the overflow is below the fold — but
      // `window.innerHeight` was 874 instead of 760, so every `vh` in the app
      // was wrong, dialogs centred too low, and the PDF preview's Save button
      // sat off-screen where a tap hit the overlay instead.
      //
      // Measured, not deduced: a diagnostic dumped `innerHeight: 874` next to a
      // 760pt content area.
      webView.translatesAutoresizingMaskIntoConstraints = false
      pin(webView, to: tao.view)
    } else {
      // No controller to adopt — fall back to hosting the bare webview so the
      // app still renders. Dialogs will be broken; the log line says so.
      NSLog("[OPShell] no tao view controller to adopt — native dialogs will not present")
      webView.removeFromSuperview()
      webView.translatesAutoresizingMaskIntoConstraints = false
      container.view.addSubview(webView)
      pin(webView, to: container.view)
    }
    return container
  }

  func updateUIViewController(_ controller: UIViewController, context: Context) {}

  private func pin(_ view: UIView, to parent: UIView) {
    NSLayoutConstraint.activate([
      view.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
      view.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
      view.topAnchor.constraint(equalTo: parent.topAnchor),
      view.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
    ])
  }
}

// MARK: - Chrome

private struct ShellView: View {
  @ObservedObject var model: ShellModel
  let taoController: UIViewController?
  let webView: UIView
  /// ONE sheet slot, not three `.sheet(isPresented:)` modifiers on the same
  /// view — SwiftUI honours only one of those, and the symptom is a button that
  /// silently does nothing. Measured: chat and structure both no-op'd while
  /// settings worked.
  @State private var sheet: Sheet?
  /// The zoom a pinch started from; nil when no pinch is in flight.
  @State private var pinchBase: Double?

  private enum Sheet: String, Identifiable {
    case settings, structure, chat, library
    var id: String { rawValue }
  }

  private var snapshot: ShellSnapshot { model.snapshot }

  var body: some View {
    NavigationStack {
      CanvasHost(taoController: taoController, webView: webView) { scale, state in
        // `scale` is cumulative from the START of the pinch, so it multiplies
        // the zoom the gesture began at. Multiplying the LIVE zoom instead
        // compounds and runs away within a few frames.
        switch state {
        case .began:
          pinchBase = snapshot.zoom
        case .changed:
          model.setZoom((pinchBase ?? snapshot.zoom) * Double(scale))
        default:
          pinchBase = nil
        }
      }
        .navigationBarTitleDisplayMode(.inline)
        // The content is a webview, so SwiftUI cannot observe its scrolling and
        // will not decide to show a bar background on its own. Pin both visible
        // rather than let the canvas bleed under floating glyphs.
        .toolbarBackground(.visible, for: .navigationBar, .bottomBar)
        .toolbar {
          // `.disabled` is applied per ITEM, never to the NavigationStack's
          // content. It is an environment modifier that propagates down the
          // whole tree, so putting it on the content disabled CanvasHost and
          // therefore the hosted WKWebView — every tap on the web dialog was
          // swallowed before it reached the page, silently.
          ToolbarItem(placement: .topBarLeading) {
            actionsMenu.disabled(snapshot.modalOpen)
          }
          ToolbarItem(placement: .principal) {
            titleMenu.disabled(snapshot.modalOpen)
          }
          ToolbarItem(placement: .topBarTrailing) {
            pdfButton.disabled(snapshot.modalOpen)
          }
          // Withdrawn while a web dialog is up. The toolbar floats ABOVE the
          // webview, so it covered the PDF preview's Save button — the dialog
          // rendered fine and simply could not be completed. Its commands
          // would act on the canvas behind the dialog anyway.
          if !snapshot.modalOpen {
            ToolbarItemGroup(placement: .bottomBar) { bottomBar }
          }
        }
        .sheet(item: $sheet) { which in
          switch which {
          case .settings: SettingsSheet(model: model)
          case .structure: StructureSheet(model: model)
          case .chat: ChatSheet(model: model)
          case .library: LibrarySheet(model: model)
          }
        }
        .onChange(of: sheet) { previous, _ in
          // Stop streaming whatever the closing sheet was subscribed to: both
          // outlines are the largest things on the wire and the canvas
          // re-renders on every keystroke.
          switch previous {
          case .structure: model.send("setStructureOpen", ["value": "false"])
          case .chat: model.send("setChatOpen", ["value": "false"])
          case .library: model.send("setLibraryOpen", ["value": "false"])
          default: break
          }
        }
    }
    // The app's own theme setting, not the system's. Without this a user who
    // picks Dark gets a dark resume canvas inside light native chrome; the two
    // halves of one screen disagreeing is worse than either choice.
    // `nil` means "System", which is exactly SwiftUI's default behaviour.
    .preferredColorScheme(preferredColorScheme)
  }

  private var preferredColorScheme: ColorScheme? {
    switch snapshot.settings.theme {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
  }

  // The title IS the résumé switcher: on a phone the navigation bar's centre is
  // the only place a title-length control fits, and a separate switcher would
  // cost a row of vertical space the canvas needs more.
  private var titleMenu: some View {
    Menu {
      Section {
        ForEach(snapshot.variants) { variant in
          Button {
            model.send("selectVariant", ["id": variant.id])
          } label: {
            // A checkmark on the current row, which is how iOS shows the
            // selected item in a menu.
            if variant.id == snapshot.variantId {
              Label(variant.name, systemImage: "checkmark")
            } else {
              Text(variant.name)
            }
          }
        }
      }
      Section {
        Button { model.send("newVariant") } label: { Label("New resume", systemImage: "plus") }
        Button {
          model.send("setLibraryOpen", ["value": "true"])
          sheet = .library
        } label: {
          Label("All resumes…", systemImage: "books.vertical")
        }
      }
    } label: {
      HStack(spacing: 4) {
        Text(snapshot.variantName.isEmpty ? "On Paper" : snapshot.variantName)
          .font(.headline)
          .lineLimit(1)
          .truncationMode(.tail)
        Image(systemName: "chevron.down")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
      }
      // Leaves room for the leading menu and the trailing PDF button without
      // letting a long résumé name push either off the bar.
      .frame(maxWidth: 200)
    }
    .accessibilityLabel("Switch resume")
  }

  private var actionsMenu: some View {
    Menu {
      Section("Resume") {
        Button { model.send("renameVariant") } label: { Label("Rename…", systemImage: "pencil") }
        Button { model.send("duplicateVariant") } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
        Button(role: .destructive) { model.send("deleteVariant") } label: {
          Label("Delete", systemImage: "trash")
        }
      }
      Section("Edit") {
        Button { model.send("undo") } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
        Button { model.send("redo") } label: { Label("Redo", systemImage: "arrow.uturn.forward") }
      }
      Section("File") {
        Button { model.send("importVariant") } label: { Label("Import…", systemImage: "square.and.arrow.down") }
        Button { model.send("exportVariant", ["format": "json"]) } label: { Label("Export as JSON", systemImage: "curlybraces") }
        Button { model.send("exportVariant", ["format": "md"]) } label: { Label("Export as Markdown", systemImage: "text.alignleft") }
      }
      Section("Tools") {
        Button { model.send("openProfile") } label: { Label("Profile", systemImage: "person.crop.circle") }
        Button { model.send("openJobs") } label: { Label("Jobs", systemImage: "briefcase") }
        Button { model.send("openHistory") } label: { Label("Version history", systemImage: "clock.arrow.circlepath") }
      }
      Section {
        Button { sheet = .settings } label: { Label("Settings", systemImage: "gearshape") }
      }
    } label: {
      Image(systemName: "ellipsis.circle")
    }
    .accessibilityLabel("Resume and app actions")
  }

  private var pdfButton: some View {
    Button {
      model.send("exportPdf")
    } label: {
      if snapshot.pdfBusy {
        ProgressView()
      } else {
        Image(systemName: "square.and.arrow.up")
      }
    }
    .disabled(snapshot.pdfBusy)
    .accessibilityLabel(snapshot.pdfBusy ? "Generating PDF" : "Export PDF")
  }

  @ViewBuilder
  private var bottomBar: some View {
    Button {
      model.send("setChatOpen", ["value": "true"])
      sheet = .chat
    } label: {
      Image(systemName: "bubble.left.and.text.bubble.right")
    }
    .accessibilityLabel("Assistant")

    Button {
      model.send("setStructureOpen", ["value": "true"])
      sheet = .structure
    } label: {
      Image(systemName: "list.bullet.rectangle")
    }
    .accessibilityLabel("Edit structure")

    formatMenu

    Spacer()

    Button { model.send("zoomOut") } label: { Image(systemName: "minus.magnifyingglass") }
      .accessibilityLabel("Zoom out")

    zoomMenu

    Button { model.send("zoomIn") } label: { Image(systemName: "plus.magnifyingglass") }
      .accessibilityLabel("Zoom in")
  }

  // The formatting controls used to live in the floating web toolbar that this
  // shell hides. Routing them here is what keeps hiding it from being a
  // functional regression.
  private var formatMenu: some View {
    Menu {
      Button { model.send("textBold") } label: { Label("Bold", systemImage: "bold") }
      Button { model.send("textItalic") } label: { Label("Italic", systemImage: "italic") }
      Button { model.send("textUnderline") } label: { Label("Underline", systemImage: "underline") }
      Button { model.send("textBullets") } label: { Label("Bulleted list", systemImage: "list.bullet") }
      Section {
        Button { model.send("textSizeIncrease") } label: { Label("Bigger text", systemImage: "textformat.size.larger") }
        Button { model.send("textSizeDecrease") } label: { Label("Smaller text", systemImage: "textformat.size.smaller") }
      }
      Section {
        Button { model.send("textClearFormat") } label: { Label("Clear formatting", systemImage: "eraser") }
      }
    } label: {
      Image(systemName: "textformat")
    }
    .accessibilityLabel("Text formatting")
  }

  private var zoomMenu: some View {
    Menu {
      Button { model.send("zoomFit") } label: { Label("Fit to view", systemImage: "arrow.up.left.and.arrow.down.right") }
      Button { model.send("zoomReset") } label: { Label("Actual size", systemImage: "1.magnifyingglass") }
    } label: {
      Text("\(snapshot.zoomPercent)%")
        .font(.subheadline)
        .monospacedDigit()
        // Without a fixed width the bar's other items shift every time the
        // readout goes 99% → 100%.
        .frame(minWidth: 48)
    }
    .accessibilityLabel("Zoom, \(snapshot.zoomPercent) percent")
  }
}

// MARK: - Settings

/// The native Settings sheet.
///
/// A pure form with no document access — deliberately the first thing built on
/// the bridge, because it exercises reads (the snapshot's `settings`) and
/// writes (four commands) without touching the résumé.
///
/// It renders from the SNAPSHOT, not from local state, so every control shows
/// what actually landed in the store rather than what it optimistically set.
/// The one exception is the API-key field, which has no snapshot to render
/// from: only whether a key exists comes back.
private struct SettingsSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var apiKeyDraft = ""
  @State private var apiKeyFocused = false

  private var settings: ShellSnapshot.Settings { model.snapshot.settings }

  var body: some View {
    NavigationStack {
      Form {
        Section("Appearance") {
          Picker("Theme", selection: themeBinding) {
            Text("System").tag("system")
            Text("Light").tag("light")
            Text("Dark").tag("dark")
          }
          .pickerStyle(.segmented)
        }

        Section {
          SecureField(
            settings.hasApiKey ? "Replace the saved key" : "sk-or-v1-…",
            text: $apiKeyDraft
          )
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          Button("Save key") {
            model.send("setApiKey", ["value": apiKeyDraft])
            apiKeyDraft = ""
          }
          .disabled(apiKeyDraft.trimmingCharacters(in: .whitespaces).isEmpty)

          Toggle("Automatic fallback", isOn: fallbackBinding)
        } header: {
          Text("AI")
        } footer: {
          // Says what the app does with the key, in the place the key is
          // entered — the same promise the web onboarding makes.
          Text(
            (settings.hasApiKey ? "A key is saved. " : "")
            + "Your key is stored in the iOS keychain and sent only to OpenRouter. "
            + "Automatic fallback retries an alternate model when the chosen one "
            + "is unavailable."
          )
        }

        Section("Data") {
          Button("Export backup…") { model.send("exportBackup") }
          Button("Import backup…") { model.send("importBackup") }
        }

        Section {
          Button("Replay welcome guide") {
            model.send("replayOnboarding")
            // The wizard is web and renders in the canvas underneath, so the
            // sheet has to get out of its way.
            dismiss()
          }
        } footer: {
          Text("Your resumes and settings are kept.")
        }

        Section("About") {
          LabeledContent("On Paper", value: settings.version.isEmpty ? "—" : settings.version)
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .presentationDetents([.large])
  }

  // Bindings that WRITE through the bridge and READ from the snapshot, so the
  // control cannot drift from the store: a rejected write simply never comes
  // back and the control springs back to the truth.
  private var themeBinding: Binding<String> {
    Binding(
      get: { settings.theme },
      set: { model.send("setTheme", ["value": $0]) }
    )
  }

  private var fallbackBinding: Binding<Bool> {
    Binding(
      get: { settings.autoFallback },
      set: { model.send("setAutoFallback", ["value": $0 ? "true" : "false"]) }
    )
  }
}

// MARK: - Structure panel

/// The native structure editor.
///
/// The only place the document crosses the bridge. It renders whatever
/// `DocumentOutline` it is given — labelled, path-keyed fields — and writes
/// back with `setField(path, value)`, which routes to the same `store.update`
/// the web editor uses. Same path grammar, same undo history, same re-render.
///
/// **The focus rule is the load-bearing part.** Typing here writes to the
/// store, the store re-renders and republishes, and the new snapshot arrives
/// while the user is still mid-word. Rendering that value straight back into
/// the field they are typing in resets the cursor to the end on every
/// keystroke. So a FOCUSED field renders from its local draft and ignores
/// inbound snapshots for its own path; every other field keeps updating live.
private struct StructureSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @FocusState private var focusedPath: String?
  @State private var drafts: [String: String] = [:]

  private var groups: [ShellSnapshot.DocumentOutline.Group] {
    model.snapshot.document?.groups ?? []
  }

  var body: some View {
    NavigationStack {
      Group {
        if groups.isEmpty {
          // The first outline lands a frame after the sheet opens; an empty
          // form would read as "this résumé has no content".
          ProgressView()
        } else {
          Form {
            ForEach(groups) { group in
              Section(group.title) {
                // Split, not one ForEach with `.onMove`: attaching the move to
                // the whole group put a drag handle on Role, Company and Dates
                // too, and a handle that refuses to do anything is worse than
                // no handle. Only the rows backed by an array get one.
                ForEach(fixedFields(of: group)) { fieldRow($0) }
                if let listPath = group.listPath {
                  ForEach(listFields(of: group)) { fieldRow($0) }
                    .onMove { indices, destination in
                      // Indices are already list-relative here, so there is no
                      // offset arithmetic to get wrong. Swift moves within a
                      // list it was TOLD about and never builds an element path.
                      guard let from = indices.first else { return }
                      model.send("moveItem", [
                        "path": listPath,
                        "from": String(from),
                        "to": String(destination),
                      ])
                    }
                }
              }
            }
          }
        }
      }
      .navigationTitle("Edit resume")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .environment(\.editMode, .constant(.active))
    .onChange(of: focusedPath) { previous, _ in
      // Drop the draft once focus leaves, so the field goes back to rendering
      // the store's value — including any normalisation the store applied.
      if let previous { drafts[previous] = nil }
    }
  }

  @ViewBuilder
  private func fieldRow(_ field: ShellSnapshot.DocumentOutline.Field) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(field.label)
        .font(.caption)
        .foregroundStyle(.secondary)
      if field.multiline {
        TextField(field.label, text: binding(for: field), axis: .vertical)
          .lineLimit(2...8)
          .focused($focusedPath, equals: field.path)
      } else {
        TextField(field.label, text: binding(for: field))
          .focused($focusedPath, equals: field.path)
      }
    }
    .padding(.vertical, 2)
  }

  /// The rows above the list: a section's heading, a role's title/company/dates.
  private func fixedFields(
    of group: ShellSnapshot.DocumentOutline.Group
  ) -> [ShellSnapshot.DocumentOutline.Field] {
    guard group.listPath != nil else { return group.fields }
    return Array(group.fields.prefix(group.listOffset))
  }

  /// The rows backed by the array at `group.listPath`.
  private func listFields(
    of group: ShellSnapshot.DocumentOutline.Group
  ) -> [ShellSnapshot.DocumentOutline.Field] {
    guard group.listPath != nil else { return [] }
    return Array(group.fields.dropFirst(group.listOffset))
  }

  private func binding(for field: ShellSnapshot.DocumentOutline.Field) -> Binding<String> {
    Binding(
      get: {
        // The focus rule. While this field has focus its draft wins, so an
        // inbound snapshot cannot move the cursor mid-word.
        focusedPath == field.path ? (drafts[field.path] ?? field.value) : field.value
      },
      set: { newValue in
        drafts[field.path] = newValue
        // Write on every keystroke rather than on blur: the canvas behind the
        // sheet is the point of the app, and it should track what is typed.
        // `path` is echoed back exactly as received — never built here.
        model.send("setField", ["path": field.path, "value": newValue])
      }
    )
  }
}

// MARK: - Reasoning timeline

/// One line of the model's reasoning summary.
struct ReasoningStep: Identifiable, Equatable {
  let id: Int
  let content: String
  let isFirst: Bool
  let isLast: Bool
  /// The terminal "Done" row, shown only once reasoning has settled.
  var isDone: Bool = false
}

/// Strip `**Title**` markers from a reasoning summary.
///
/// Ported from Olia (`Screens/Chat/ReasoningTimelineView.swift`), which learned
/// the shapes the hard way: models emit `**Title**` on one line, but the closing
/// `**` often lands on the NEXT line, and sometimes appears orphaned on its own.
/// All three have to go or the timeline shows asterisks as content.
func stripReasoningTitles(_ content: String) -> String {
  var result = content
  let patterns: [(String, NSRegularExpression.Options)] = [
    (#"\*\*[^*]+\*\*"#, []),          // **Title** on one line
    (#"\*\*[^*\n]+\n\*\*"#, []),      // **Title\n**
    (#"^\*\*$"#, [.anchorsMatchLines]) // an orphaned closing **
  ]
  for (pattern, options) in patterns {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { continue }
    result = regex.stringByReplacingMatches(
      in: result, options: [], range: NSRange(result.startIndex..., in: result), withTemplate: ""
    )
  }
  return result
}

/// A vertical timeline of reasoning steps: a dot per line, joined by rules.
///
/// Ported from Olia. The rules are drawn as `Rectangle`s above and below each
/// dot rather than as one line behind the column, which is what lets a row size
/// itself to its own text without the connector stretching or breaking.
struct ReasoningTimeline: View {
  let content: String
  /// Fade-and-rise rows in as they arrive. Off for settled history, where every
  /// row would animate at once on open.
  var animateAppearance: Bool = false

  private var steps: [ReasoningStep] {
    let lines = stripReasoningTitles(content)
      .components(separatedBy: .newlines)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
    return lines.enumerated().map { index, line in
      ReasoningStep(
        id: index, content: line,
        isFirst: index == 0, isLast: index == lines.count - 1
      )
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(steps) { step in
        ReasoningTimelineRow(step: step, animateAppearance: animateAppearance)
      }
    }
    .padding(.vertical, 8)
  }
}

struct ReasoningTimelineRow: View {
  let step: ReasoningStep
  var animateAppearance: Bool = false

  @State private var hasAppeared = false

  var body: some View {
    HStack(alignment: step.isDone ? .center : .top, spacing: 12) {
      ZStack(alignment: step.isDone ? .center : .top) {
        if !step.isFirst {
          Rectangle()
            .fill(Color.secondary.opacity(0.3))
            .frame(width: 1, height: 20)
            .offset(y: -20)
        }
        if !step.isLast {
          Rectangle()
            .fill(Color.secondary.opacity(0.3))
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .padding(.top, 20)
        }
        if step.isDone {
          Image(systemName: "checkmark.circle")
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(.primary)
        } else {
          Circle()
            .fill(Color.secondary)
            .frame(width: 8, height: 8)
            .padding(.top, 6)
        }
      }
      .frame(width: 16)

      Text(step.content)
        .font(.subheadline)
        .fontWeight(step.isDone ? .medium : .regular)
        .foregroundStyle(step.isDone ? .primary : .secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, step.isLast ? 0 : 20)
    }
    .opacity(animateAppearance ? (hasAppeared ? 1 : 0) : 1)
    .offset(y: animateAppearance ? (hasAppeared ? 0 : 6) : 0)
    .onAppear {
      guard animateAppearance, !hasAppeared else { return }
      withAnimation(.easeOut(duration: 0.3)) { hasAppeared = true }
    }
  }
}

/// Find the last `**Title**` in a reasoning summary.
///
/// Ported from Olia. Models emit section titles as bold markdown, and the
/// closing `**` frequently lands on the NEXT line — hence the second pattern.
/// This is what the inline indicator shows while reasoning streams.
func findLastTitle(in content: String) -> String? {
  for pattern in [#"\*\*([^*]+)\*\*"#, #"\*\*([^*\n]+)\n\*\*"#] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
    let range = NSRange(content.startIndex..., in: content)
    if let last = regex.matches(in: content, range: range).last,
       let titleRange = Range(last.range(at: 1), in: content) {
      return String(content[titleRange]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }
  return nil
}

/// Strip inline markdown for a one-line preview.
private func stripMarkdownForPreview(_ text: String) -> String {
  var result = text
  let replacements: [(String, String)] = [
    ("`(.+?)`", "$1"),
    ("\\[(.+?)\\]\\(.+?\\)", "$1"),
    ("^#{1,6}\\s*", ""),
    ("\\*\\*\\*(.+?)\\*\\*\\*", "$1"),
    ("\\*\\*(.+?)\\*\\*", "$1"),
    ("\\*([^*\\n]+)\\*", "$1"),
    ("^[\\p{Pd}\\*]\\s+", ""),
  ]
  for (pattern, template) in replacements {
    result = result.replacingOccurrences(
      of: pattern, with: template, options: .regularExpression
    )
  }
  return result.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Shimmer, for text that is still arriving. Ported from Olia.
private struct Shimmer: ViewModifier {
  let active: Bool
  @State private var start = UnitPoint(x: -1, y: 0.5)
  @State private var end = UnitPoint(x: 0, y: 0.5)

  func body(content: Content) -> some View {
    if active {
      content
        .mask(
          LinearGradient(
            stops: [
              .init(color: .black.opacity(0.4), location: 0),
              .init(color: .black, location: 0.3),
              .init(color: .black, location: 0.7),
              .init(color: .black.opacity(0.4), location: 1),
            ],
            startPoint: start, endPoint: end
          )
        )
        .onAppear {
          withAnimation(.linear(duration: 1.5).repeatForever(autoreverses: false)) {
            start = UnitPoint(x: 1, y: 0.5)
            end = UnitPoint(x: 2, y: 0.5)
          }
        }
    } else {
      content
    }
  }
}

extension View {
  func shimmering(active: Bool = true) -> some View { modifier(Shimmer(active: active)) }
}

/// The one-line, tappable reasoning summary — Olia's shape, and the thing this
/// port originally got wrong by rendering the timeline inline.
///
/// While reasoning streams it shows the CURRENT section title (the last
/// `**Title**` in the completed lines) and shimmers; when it settles it reads
/// "Thought process". Either way the chevron says it opens, and the timeline
/// lives in the sheet behind it.
struct InlineReasoningIndicator: View {
  let reasoning: String
  let isStreaming: Bool
  @State private var showSheet = false

  /// Only COMPLETE lines are considered, so a half-streamed title never shows.
  private var summary: String {
    guard isStreaming, let lastNewline = reasoning.lastIndex(of: "\n") else { return "" }
    let complete = String(reasoning[...lastNewline])
    if let title = findLastTitle(in: complete) { return title }
    let lines = complete.components(separatedBy: .newlines)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return stripMarkdownForPreview(lines.last ?? "")
  }

  private var displayText: String {
    if !isStreaming { return "Thought process" }
    return summary.isEmpty ? "Thinking…" : summary
  }

  var body: some View {
    Button { showSheet = true } label: {
      HStack(spacing: 6) {
        Text(displayText).font(.subheadline).lineLimit(1)
        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
      }
      .foregroundStyle(.secondary)
      .shimmering(active: isStreaming)
    }
    .buttonStyle(.plain)
    .sheet(isPresented: $showSheet) {
      ReasoningSheet(content: reasoning, isStreaming: isStreaming)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
    .accessibilityHint("Opens the model's thought process")
  }
}

/// The reasoning timeline, in a sheet.
///
/// A `List` rather than a `ScrollView`: on iOS 26 a ScrollView inside a sheet
/// picks up a green background tint. Olia hit that and the workaround is
/// carried over with it.
struct ReasoningSheet: View {
  let content: String
  let isStreaming: Bool

  private var visibleLines: [String] {
    let source: String
    if isStreaming {
      // Only complete lines while streaming, so a row never appears half-written.
      guard let lastNewline = content.lastIndex(of: "\n") else { return [] }
      source = String(content[...lastNewline])
    } else {
      source = content
    }
    return stripReasoningTitles(source)
      .components(separatedBy: .newlines)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
  }

  private var steps: [ReasoningStep] {
    let lines = visibleLines
    let showDone = !isStreaming && !lines.isEmpty
    var result = lines.enumerated().map { index, line in
      ReasoningStep(
        id: index, content: line,
        isFirst: index == 0,
        isLast: !showDone && index == lines.count - 1,
        isDone: false
      )
    }
    if showDone {
      result.append(ReasoningStep(
        id: result.count, content: "Done", isFirst: result.isEmpty, isLast: true, isDone: true
      ))
    }
    return result
  }

  var body: some View {
    NavigationStack {
      List {
        ForEach(steps) { step in
          ReasoningTimelineRow(step: step, animateAppearance: isStreaming)
            .listRowInsets(EdgeInsets(top: 0, leading: 28, bottom: 0, trailing: 28))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
      }
      .listStyle(.inset)
      .environment(\.defaultMinListRowHeight, 0)
      .navigationTitle(isStreaming ? (findLastTitle(in: content) ?? "Thinking…") : "Thought process")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

// MARK: - Composer

/// The message composer, ported from Olia (`Screens/Chat/MessageComposer.swift`).
///
/// The iOS 26 branch is the point: the field and the send button live in one
/// `GlassEffectContainer` with matched `glassEffectID`s in a shared namespace,
/// so the two MORPH into each other rather than sitting side by side. That is
/// the effect — a glass background alone does not produce it.
///
/// The pre-26 branch is not optional: On Paper's deployment target is 17.4.
private struct ChatComposer: View {
  @Binding var text: String
  let isSending: Bool
  let onSend: () -> Void
  let onStop: () -> Void

  @FocusState private var isFocused: Bool
  @Namespace private var glassNamespace

  private let characterLimit = 4000

  private var trimmed: String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  private var canSend: Bool { !trimmed.isEmpty && !isSending && text.count <= characterLimit }
  private var isNearLimit: Bool { text.count > characterLimit * 80 / 100 }

  var body: some View {
    VStack(alignment: .center, spacing: 0) {
      if #available(iOS 26.0, *) {
        GlassEffectContainer(spacing: 8) {
          HStack(alignment: .bottom, spacing: 8) { field; trailingButton }
            .padding(.leading, 16)
            .padding(.trailing, 12)
        }
      } else {
        HStack(alignment: .bottom, spacing: 8) { fallbackField; trailingButton }
          .padding(.leading, 16)
          .padding(.trailing, 12)
      }

      if isNearLimit {
        HStack {
          Spacer()
          Text("\(text.count)/\(characterLimit)")
            .font(.caption)
            .foregroundStyle(text.count > characterLimit ? Color.red : Color.secondary)
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
        }
      }
    }
  }

  @available(iOS 26.0, *)
  private var field: some View {
    TextField("Ask about this resume", text: $text, axis: .vertical)
      .textFieldStyle(.plain)
      .focused($isFocused)
      .disabled(isSending)
      .lineLimit(1...8)
      .frame(minHeight: 44)
      .padding(.horizontal, 16)
      .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
      .glassEffectID("textField", in: glassNamespace)
  }

  private var fallbackField: some View {
    TextField("Ask about this resume", text: $text, axis: .vertical)
      .textFieldStyle(.plain)
      .focused($isFocused)
      .disabled(isSending)
      .lineLimit(1...8)
      .frame(minHeight: 44)
      .padding(.horizontal, 16)
      .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .stroke(Color.primary.opacity(isFocused ? 0.2 : 0.08), lineWidth: 0.5)
      )
  }

  @ViewBuilder
  private var trailingButton: some View {
    if isSending {
      Button(action: onStop) {
        Image(systemName: "stop.fill").font(.system(size: 18, weight: .semibold)).padding(4)
      }
      .modifier(ComposerButtonStyle())
      .accessibilityLabel("Stop")
    } else {
      Button {
        guard canSend else { return }
        onSend()
        isFocused = false
      } label: {
        Image(systemName: "arrow.up")
          .font(.system(size: 20, weight: .semibold))
          .symbolEffect(.bounce, value: isSending)
          .padding(4)
      }
      .modifier(ComposerButtonStyle())
      .disabled(!canSend)
      .accessibilityLabel("Send")
    }
  }
}

/// `.glassProminent` where it exists, `.borderedProminent` before it — extracted
/// so the two composer branches do not each carry an availability check.
private struct ComposerButtonStyle: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) {
      content
        .buttonStyle(.glassProminent)
        .glassEffectID("sendButton", in: Namespace().wrappedValue)
        .buttonBorderShape(.circle)
    } else {
      content.buttonStyle(.borderedProminent).buttonBorderShape(.circle)
    }
  }
}

// MARK: - Chat

/// The native chat sheet, shaped after Olia's.
///
/// A second VIEW of the engine in `src/components/chat/useChat.js`, not a second
/// engine: every action dispatches an event the React panel handles, so
/// threading, streaming, aborting and persistence stay in the one implementation
/// that already works on desktop.
///
/// Still short of the web panel on purpose — no model picker, no context chips,
/// and no applying the AI's proposed CHANGES. Applying one runs the diff engine
/// and opens a review session; a partial native version of that is how someone
/// accepts an edit they never saw.
private struct ChatSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var draft = ""
  @State private var showReview = false

  private var chat: ShellSnapshot.ChatView? { model.snapshot.chat }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if let chat, !chat.configured {
          ContentUnavailableView(
            "No API key",
            systemImage: "key",
            description: Text("Add an OpenRouter key in Settings to use the assistant.")
          )
        } else {
          transcript
          ChatComposer(
            text: $draft,
            isSending: chat?.loading ?? false,
            onSend: sendDraft,
            onStop: { model.send("chatStop") }
          )
          .padding(.bottom, 8)
        }
      }
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { threadMenu }
        ToolbarItem(placement: .principal) { modelMenu }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .sheet(isPresented: $showReview) {
        ChangeReviewSheet(model: model)
      }
    }
  }

  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {
          ForEach(chat?.messages ?? []) { message in
            messageView(message).id(message.id)
          }
          if let thinking = chat?.thinking, !thinking.isEmpty {
            HStack(spacing: 8) {
              ProgressView().controlSize(.small)
              Text(thinking).font(.subheadline).foregroundStyle(.secondary)
            }
            .id("thinking")
          }
        }
        .padding()
      }
      // Keyed on the last message's text, not its id, so a reply that is still
      // growing keeps the view pinned to its tail.
      .onChange(of: chat?.messages.last?.text) { _, _ in
        guard let last = chat?.messages.last else { return }
        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
      }
    }
  }

  @ViewBuilder
  private func messageView(_ message: ShellSnapshot.ChatView.Message) -> some View {
    let isUser = message.role == "user"
    VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
      if !message.reasoning.isEmpty {
        // Olia's shape: a one-line, tappable summary — NOT the timeline inline.
        // The timeline lives in a sheet behind it.
        InlineReasoningIndicator(
          reasoning: message.reasoning,
          isStreaming: message.id == "streaming"
        )
      }
      if !message.text.isEmpty {
        Text(message.text)
          .textSelection(.enabled)
          .padding(10)
          .background(bubbleBackground(for: message.role), in: .rect(cornerRadius: 18))
          .foregroundStyle(isUser ? .white : .primary)
      }
      if message.hasChanges, let pending = chat?.pendingChanges, !pending.isEmpty {
        Button {
          showReview = true
        } label: {
          Label(
            pending.count == 1 ? "Review 1 suggested edit"
                               : "Review \(pending.count) suggested edits",
            systemImage: "wand.and.stars"
          )
          .font(.subheadline)
        }
        .buttonStyle(.bordered)
      } else if message.hasChanges {
        // The proposal was already decided — applied or rejected — so there is
        // nothing left to review. Saying so beats a button that opens an empty
        // sheet.
        Label("Suggested edits reviewed", systemImage: "checkmark")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
  }

  private func bubbleBackground(for role: String) -> Color {
    switch role {
    case "user": return .accentColor
    case "error": return .red.opacity(0.15)
    default: return Color(.secondarySystemBackground)
    }
  }

  /// Model and reasoning effort, in the bar's centre where the title would be.
  ///
  /// Effort only appears for models that reason — offering a setting with no
  /// effect is worse than not offering it.
  private var modelMenu: some View {
    Menu {
      Section("Model") {
        ForEach(chat?.models ?? []) { option in
          Button {
            model.send("chatSetModel", ["id": option.id])
          } label: {
            if option.id == chat?.currentModel {
              Label(option.label, systemImage: "checkmark")
            } else {
              Text(option.label)
            }
          }
        }
      }
      if chat?.reasoningSupported == true {
        Section("Reasoning effort") {
          ForEach(["low", "medium", "high"], id: \.self) { effort in
            Button {
              model.send("chatSetReasoning", ["value": effort])
            } label: {
              if effort == chat?.reasoningEffort {
                Label(effort.capitalized, systemImage: "checkmark")
              } else {
                Text(effort.capitalized)
              }
            }
          }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Text(currentModelLabel).font(.subheadline.weight(.semibold)).lineLimit(1)
        Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
      }
      .frame(maxWidth: 180)
    }
    .accessibilityLabel("Model and reasoning effort")
  }

  private var currentModelLabel: String {
    chat?.models.first { $0.id == chat?.currentModel }?.label ?? "Assistant"
  }

  private var threadMenu: some View {
    Menu {
      Section {
        ForEach(chat?.threads ?? []) { thread in
          Button {
            model.send("chatSelectThread", ["id": thread.id])
          } label: {
            if thread.isCurrent {
              Label(thread.title, systemImage: "checkmark")
            } else {
              Text(thread.title)
            }
          }
        }
      }
      Section {
        Button { model.send("chatNewThread") } label: { Label("New chat", systemImage: "plus") }
      }
    } label: {
      Image(systemName: "bubble.left.and.bubble.right")
    }
    .accessibilityLabel("Chats")
  }

  private func sendDraft() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    model.send("chatSend", ["text": text])
    draft = ""
  }
}

// MARK: - Change review

/// Review the AI's proposed edits before they land.
///
/// This exists because the alternative was worse in both directions: dropping
/// the proposals silently made chat useless on the phone, and applying them
/// from a button in the transcript would let someone accept an edit they never
/// saw. So the rule is that nothing applies without its BEFORE and AFTER on
/// screen first.
///
/// Every action routes to the same session `inlineChanges.js` drives on
/// desktop. Apply-all in particular is NOT a loop over apply-one: leaf paths are
/// indexed against the proposed array, so insertions and removals have to land
/// before modifications or a write hits the wrong element. `applyChangesToStore`
/// owns that ordering and this must not reimplement it.
private struct ChangeReviewSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  private var changes: [ShellSnapshot.ChatView.PendingChange] {
    model.snapshot.chat?.pendingChanges ?? []
  }

  var body: some View {
    NavigationStack {
      Group {
        if changes.isEmpty {
          ContentUnavailableView(
            "Nothing to review",
            systemImage: "checkmark.circle",
            description: Text("Every suggested edit has been applied or rejected.")
          )
        } else {
          List {
            ForEach(changes) { change in
              Section {
                if !change.before.isEmpty {
                  diffRow(label: "Before", text: change.before, tint: .red)
                }
                if !change.after.isEmpty {
                  diffRow(label: "After", text: change.after, tint: .green)
                }
                HStack {
                  Button("Reject", role: .destructive) {
                    model.send("rejectChange", ["path": change.path])
                  }
                  Spacer()
                  Button("Apply") {
                    model.send("applyChange", ["path": change.path])
                  }
                  .buttonStyle(.borderedProminent)
                }
                .buttonStyle(.bordered)
              } header: {
                Text(change.label).font(.footnote).textCase(nil)
              }
            }
          }
        }
      }
      .navigationTitle("Suggested edits")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        if !changes.isEmpty {
          ToolbarItemGroup(placement: .bottomBar) {
            Button("Reject all", role: .destructive) {
              model.send("rejectAllChanges")
              dismiss()
            }
            Spacer()
            Button("Apply all") {
              model.send("applyAllChanges")
              dismiss()
            }
          }
        }
      }
    }
  }

  private func diffRow(label: String, text: String, tint: Color) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(tint)
      Text(text)
        .font(.callout)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 2)
  }
}

// MARK: - Library

/// Every résumé, searchable.
///
/// A phone list rather than the desktop dialog's split view: one row per
/// résumé, and tapping it opens that résumé — which is what the desktop's
/// preview pane was for. Search runs in JS against the same `searchLibrary` the
/// dialog uses, so results cannot diverge; Swift owns only the query string.
///
/// Deep search is a toggle because it is materially slower: it flattens every
/// résumé's text and every attached job description, and on a phone that is
/// worth asking for rather than doing on every keystroke.
private struct LibrarySheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var query = ""
  @State private var deep = false

  private var entries: [ShellSnapshot.LibraryEntry] { model.snapshot.library ?? [] }

  var body: some View {
    NavigationStack {
      List {
        Section {
          Toggle("Search inside résumés and job descriptions", isOn: $deep)
            .font(.subheadline)
            .onChange(of: deep) { _, _ in search() }
        }
        Section {
          if entries.isEmpty {
            Text(query.isEmpty ? "No resumes yet." : "No matches.")
              .foregroundStyle(.secondary)
          } else {
            ForEach(entries) { entry in
              Button {
                model.send("openVariant", ["id": entry.id])
                dismiss()
              } label: {
                row(entry)
              }
              .buttonStyle(.plain)
            }
          }
        } header: {
          Text(entries.count == 1 ? "1 resume" : "\(entries.count) resumes")
        }
      }
      .searchable(text: $query, prompt: "Search resumes")
      .onChange(of: query) { _, _ in search() }
      .navigationTitle("All resumes")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .onAppear { search() }
    }
  }

  private func row(_ entry: ShellSnapshot.LibraryEntry) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(entry.name).font(.body)
        Spacer()
        if entry.applicationCount > 0 {
          Text("\(entry.applicationCount)")
            .font(.caption.monospacedDigit())
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(.tertiarySystemFill), in: .capsule)
        }
      }
      if !entry.status.isEmpty {
        Text(entry.status.capitalized).font(.caption).foregroundStyle(.secondary)
      }
      if !entry.snippet.isEmpty {
        // Says WHERE the match was, because a snippet with no source reads as
        // if it came from the résumé when it may have come from a job post.
        Text("\(entry.snippetSource.capitalized): \(entry.snippet)")
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
    }
    .padding(.vertical, 2)
    .contentShape(.rect)
  }

  private func search() {
    model.send("librarySearch", ["query": query, "deep": deep ? "true" : "false"])
  }
}
