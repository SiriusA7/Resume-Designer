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

  /// What the chrome shows before the first snapshot arrives — a fraction of a
  /// second at launch, but it must not render as blank or as "0%".
  static let empty = ShellSnapshot(
    variantId: nil, variantName: "On Paper", variants: [],
    zoom: 1, zoomPercent: 100, pdfBusy: false
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
          let snapshot = try? JSONDecoder().decode(ShellSnapshot.self, from: data) else {
      NSLog("[OPShell] undecodable snapshot: \(message.body)")
      return
    }
    Task { @MainActor in self.model?.snapshot = snapshot }
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

  @MainActor private static var handedOver = false

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

  func makeUIViewController(context: Context) -> UIViewController {
    let container = UIViewController()
    container.view.backgroundColor = .systemBackground

    // ios_view.rs drives these views by frame + autoresizing mask. Inside
    // SwiftUI it has to be Auto Layout's job instead, which is also why
    // rotation keeps working with tao's controller no longer the root.
    if let tao = taoController {
      container.addChild(tao)
      tao.view.translatesAutoresizingMaskIntoConstraints = false
      container.view.addSubview(tao.view)
      pin(tao.view, to: container.view)
      tao.didMove(toParent: container)
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

  private var snapshot: ShellSnapshot { model.snapshot }

  var body: some View {
    NavigationStack {
      CanvasHost(taoController: taoController, webView: webView)
        .navigationBarTitleDisplayMode(.inline)
        // The content is a webview, so SwiftUI cannot observe its scrolling and
        // will not decide to show a bar background on its own. Pin both visible
        // rather than let the canvas bleed under floating glyphs.
        .toolbarBackground(.visible, for: .navigationBar, .bottomBar)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { actionsMenu }
          ToolbarItem(placement: .principal) { titleMenu }
          ToolbarItem(placement: .topBarTrailing) { pdfButton }
          ToolbarItemGroup(placement: .bottomBar) { bottomBar }
        }
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
        Button { model.send("openLibrary") } label: { Label("All resumes…", systemImage: "books.vertical") }
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
        Button { model.send("openSettings") } label: { Label("Settings", systemImage: "gearshape") }
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
    Button { model.send("toggleChat") } label: { Image(systemName: "bubble.left.and.text.bubble.right") }
      .accessibilityLabel("Assistant")

    Button { model.send("toggleStructure") } label: { Image(systemName: "list.bullet.rectangle") }
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
