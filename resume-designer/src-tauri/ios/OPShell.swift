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
    }
    var threads: [Thread]
    var messages: [Message]
    var loading: Bool
    var streaming: Bool
    var configured: Bool
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
    chat: nil, document: nil
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

  private enum Sheet: String, Identifiable {
    case settings, structure, chat
    var id: String { rawValue }
  }

  private var snapshot: ShellSnapshot { model.snapshot }

  var body: some View {
    NavigationStack {
      CanvasHost(taoController: taoController, webView: webView)
        // WKWebView already does its own keyboard avoidance — it insets its
        // scroll view and scrolls the focused element into view. Letting
        // SwiftUI ALSO shrink the content for the keyboard applies the inset
        // twice: the canvas collapsed to a ~90pt strip above a black void,
        // scrolled somewhere unrelated to the caret. Opt out and leave the
        // keyboard to the webview, which is the only side that knows where
        // the caret is.
        .ignoresSafeArea(.keyboard, edges: .bottom)
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
          }
        }
        .onChange(of: sheet) { previous, _ in
          // Stop streaming whatever the closing sheet was subscribed to: both
          // outlines are the largest things on the wire and the canvas
          // re-renders on every keystroke.
          switch previous {
          case .structure: model.send("setStructureOpen", ["value": "false"])
          case .chat: model.send("setChatOpen", ["value": "false"])
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
      NSLog("[OPShell] chat button tapped; sheet was \(String(describing: sheet))")
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

// MARK: - Chat

/// The native chat sheet.
///
/// A second VIEW of the engine in `src/components/chat/useChat.js`, not a
/// second engine: every action here dispatches an event the React panel
/// handles, so threading, streaming, aborting and persistence all stay in the
/// one implementation that already works on desktop.
///
/// Scope is deliberately short of the web panel — no model picker, no context
/// chips, and no applying the AI's proposed changes. That last one is why:
/// applying a change runs the diff engine and opens a review session, and a
/// partial native version of it would let someone accept an edit they never
/// saw. Replies that carry proposals say so and point back to the web panel.
private struct ChatSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var draft = ""
  @FocusState private var composerFocused: Bool

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
          composer
        }
      }
      .navigationTitle("Assistant")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { threadMenu }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
    }
  }

  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          ForEach(chat?.messages ?? []) { message in
            bubble(message).id(message.id)
          }
          if chat?.loading == true && chat?.streaming != true {
            ProgressView().frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding()
      }
      // Follow the stream. Keyed on the last message's text, not its id, so a
      // reply that is still growing keeps the view pinned to its tail.
      .onChange(of: chat?.messages.last?.text) { _, _ in
        guard let last = chat?.messages.last else { return }
        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
      }
    }
  }

  @ViewBuilder
  private func bubble(_ message: ShellSnapshot.ChatView.Message) -> some View {
    let isUser = message.role == "user"
    VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
      Text(message.text)
        .textSelection(.enabled)
        .padding(10)
        .background(bubbleBackground(for: message.role), in: .rect(cornerRadius: 14))
        .foregroundStyle(isUser ? .white : .primary)
      if message.hasChanges {
        // The reply proposed edits this sheet cannot apply. Saying so is the
        // honest version of dropping them silently.
        Label("Suggested edits — open the assistant on desktop to review",
              systemImage: "wand.and.stars")
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

  private var composer: some View {
    HStack(spacing: 8) {
      TextField("Ask about this resume", text: $draft, axis: .vertical)
        .lineLimit(1...5)
        .textFieldStyle(.roundedBorder)
        .focused($composerFocused)
      if chat?.loading == true {
        Button { model.send("chatStop") } label: {
          Image(systemName: "stop.circle.fill").font(.title2)
        }
        .accessibilityLabel("Stop")
      } else {
        Button { sendDraft() } label: {
          Image(systemName: "arrow.up.circle.fill").font(.title2)
        }
        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityLabel("Send")
      }
    }
    .padding()
    .background(.bar)
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
