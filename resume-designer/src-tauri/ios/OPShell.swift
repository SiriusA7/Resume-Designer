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

import Observation
import PDFKit
import PhotosUI
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
  /// `nil` while the library is closed. An object rather than a bare list of
  /// entries: the sheet has three tabs, and the stats and timeline are derived
  /// from the SAME applications the entries are, so splitting them across
  /// sibling keys would let them disagree about a résumé that changed
  /// underneath.
  var library: LibraryView?

  /// `nil` while the history sheet is closed. Mirrors `buildHistory()`.
  var history: History?

  /// `nil` while their sheets are closed. Both screens live in their own files
  /// — OPJobs.swift and OPProfile.swift — because this one is the shell, and
  /// two more full editors in it would make it unreadable.
  var jobs: JobsView?
  var profile: ProfileView?

  /// The onboarding / new-résumé wizard, or `nil` while it is closed.
  ///
  /// Unlike every other screen there is no command that opens it: the WEB
  /// wizard's own `open` is the gate, because one component serves both a first
  /// run and the header's "New resume" and it decides which. So this arriving
  /// non-nil IS the instruction to present. Lives in OPOnboarding.swift.
  var onboarding: OnboardingView?

  /// The change-review dialog, or `nil` while it is closed. Like the wizard it
  /// has no open command: the WEB dialog decides, because every entry point
  /// (chat's Review changes, jobs tailoring, history compare, the inline
  /// banner) opens the same one.
  var diff: DiffReview?

  /// Mirrors `buildDiffReview()` in src/iosShell.js.
  ///
  /// **Nothing here applies anything.** The buttons call back into the web
  /// dialog's own handlers: tailoring goes through diffEngine and
  /// `applyChangesToStore`, and Apply All must batch through the ordered
  /// helper rather than loop, because leaf paths are indexed against the
  /// PROPOSED array. That sequence exists once, over there.
  struct DiffReview: Decodable, Equatable {
    let open: Bool
    let title: String
    let changes: [Change]
    /// What Apply All would actually write — not `changes.count`, which
    /// includes everything already decided.
    let pending: Int
    let busy: Bool

    struct Change: Decodable, Equatable, Identifiable {
      let path: String
      let label: String
      /// "add" | "remove" | "modify"
      let kind: String
      /// Already rendered for display by the diff engine, so nothing here
      /// formats a résumé value.
      let before: String
      let after: String
      let applied: Bool
      let rejected: Bool
      var id: String { path }
    }
  }

  struct History: Decodable, Equatable {
    /// The résumé these versions belong to. History is per-résumé and the sheet
    /// has no session identity, so a switch underneath it has to be noticed —
    /// restoring a version from another document would overwrite this one.
    let variantId: String
    let entries: [Entry]
    /// The open comparison, if any. Computed on demand: the version PAYLOADS
    /// never ride the snapshot.
    let diff: Diff?

    struct Entry: Decodable, Equatable, Identifiable {
      /// The store's own index — Swift echoes it back and never computes one.
      let index: Int
      let timestamp: String
      let description: String
      let changeType: String
      let label: String
      let isCurrent: Bool
      /// Positional indices renumber, so they are not stable identity. The
      /// timestamp is what makes a row itself.
      var id: String { "\(index)-\(timestamp)" }
    }

    struct Diff: Decodable, Equatable {
      let label: String
      let changes: [ChatView.PendingChange]
    }
  }

  /// Mirrors `buildLibrary()` in src/iosShell.js.
  struct LibraryView: Decodable, Equatable {
    let entries: [LibraryEntry]
    let stats: Stats
    /// NEWEST first, the reverse of the web's left-to-right axis. Flat: which
    /// month a date falls in, and what that month is called, is a locale
    /// question and belongs on this side.
    let timeline: [TimelinePoint]

    struct Stats: Decodable, Equatable {
      let sent: Int
      let responded: Int
      /// `nil` where there is nothing to divide by. Rendered as "—", not 0% —
      /// no replies yet is not a 0% response rate.
      let responseRate: Double?
      let interviewRate: Double?
      let medianDaysToResponse: Double?
      let perVariant: [PerVariant]

      struct PerVariant: Decodable, Equatable, Identifiable {
        let variantId: String
        let variantName: String
        let sent: Int
        let responded: Int
        let interviewed: Int
        var id: String { variantId }
      }
    }

    struct TimelinePoint: Decodable, Equatable, Identifiable {
      let id: String
      let variantId: String
      let variantName: String
      /// ISO 8601. Parsed here so the grouping and the formatting agree.
      let at: String
      let status: String
      let title: String
      let company: String
    }
  }

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
      /// The Add button's label, or "" when this group's list cannot grow — a
      /// prose section is one string, not a list of rows.
      let addLabel: String
      /// The array this whole group is an element of, and where in it, for
      /// groups that can be deleted outright (a role, a section). `nil` for
      /// groups that are not array members, like the header.
      let removePath: String?
      let removeIndex: Int
      /// What the confirmation names, so it says "Delete Designer?" rather than
      /// "Delete this?".
      let removeTitle: String
    }
    var groups: [Group]
    /// Adding the FIRST of something. A group only exists once its array is
    /// non-empty, so a résumé with no education has no education group — and
    /// without these could never gain one.
    var additions: [Addition]

    struct Addition: Decodable, Equatable, Identifiable {
      let path: String
      let label: String
      var id: String { path }
    }
  }

  /// `nil` while the design sheet is closed. Same reasoning as `document`, and
  /// more of it: this projection carries a dozen option lists and the whole font
  /// catalogue, and it is rebuilt after every design write — which is per FRAME
  /// while a slider is moving.
  var design: Design?

  /// Mirrors `buildDesign()` in src/iosShell.js.
  ///
  /// Every value is a String, Bool or Double: the design model is a pile of CSS
  /// — gradients, hex colours, font stacks — and Swift decodes none of it. It
  /// renders the names it was given, echoes back the ids it was given, and
  /// leaves the meaning of `linear-135` or `#c45c3e` entirely on the web side.
  struct Design: Decodable, Equatable {
    /// An `{ id, name }` pair. Seven of the contract's lists are exactly this
    /// and nothing more; giving each its own type would buy nothing.
    struct Option: Decodable, Equatable, Identifiable {
      let id: String
      let name: String
    }

    struct Page: Decodable, Equatable {
      var size: String
      var orientation: String
      var widthIn: Double
      var groupPositions: Bool
    }

    /// Named for what it holds rather than `Color`, which inside this scope
    /// would shadow SwiftUI's own and make every tile's fill ambiguous.
    struct ColorSettings: Decodable, Equatable {
      var palette: String
      var customColor: String
    }

    /// `p1` accent, `p2` dark, `p3` light — the three tones the web swatch
    /// stripes, in that order.
    struct Palette: Decodable, Equatable, Identifiable {
      let id: String
      let name: String
      let p1: String
      let p2: String
      let p3: String
    }

    struct Header: Decodable, Equatable {
      /// solid | gradient | pattern | texture | image
      var type: String
      var styleId: String
      var imageOpacity: Double
      var imageFit: String
      /// Whether an image is set — never the image. A header background is a
      /// megabyte of base64 and the sheet has nothing to say about its pixels.
      var hasImage: Bool
    }

    struct HeaderStyle: Decodable, Equatable, Identifiable {
      let id: String
      let name: String
      /// gradient | pattern | texture — the picker's three sections.
      let group: String
      /// The CSS background the web tile paints with, already resolved against
      /// the current palette. Swift renders no CSS; `designSwatchColors` mines
      /// the hex out of it so a tile is at least the right colours.
      let css: String
    }

    struct Fonts: Decodable, Equatable {
      /// preset | google | system
      var mode: String
      /// "" when the two fonts do not add up to a pairing.
      var pairingId: String
      var displayName: String
      var bodyName: String
    }

    struct FontPairing: Decodable, Equatable, Identifiable {
      let id: String
      let name: String
      let display: String
      let body: String
    }

    struct GoogleFont: Decodable, Equatable, Identifiable {
      let family: String
      let category: String
      var id: String { family }
    }

    struct Spacing: Decodable, Equatable {
      var fontScale: Double
      var lineHeight: Double
      var sectionSpacing: Double
      var sidebarWidth: Double
      var marginTop: Double
      var marginRight: Double
      var marginBottom: Double
      var marginLeft: Double
      /// "" once the sliders have been moved off every preset.
      var presetId: String
    }

    struct Accent: Decodable, Equatable {
      var underlineStyle: String
      var underlineWidth: Double
      var bulletStyle: String
      var borderRadius: String
      var skillTagStyle: String
      var showCornerTriangle: Bool
      var showSidebarGradient: Bool
    }

    struct Bullet: Decodable, Equatable, Identifiable {
      let id: String
      let name: String
      /// The glyph itself, so a row shows what the résumé will show. Empty for
      /// "None".
      let char: String
    }

    struct Photo: Decodable, Equatable {
      var enabled: Bool
      var hasImage: Bool
      var placement: String
      var shape: String
      var size: String
      var borderColor: String
      /// A CSS `object-position` pair, "left top" through "right bottom".
      var objectPosition: String
      var scale: Double
    }

    var page: Page
    var pageSizes: [Option]
    var color: ColorSettings
    var palettes: [Palette]
    var layout: String
    var layouts: [Option]
    var header: Header
    var headerStyles: [HeaderStyle]
    var fonts: Fonts
    var fontPairings: [FontPairing]
    var systemFonts: [Option]
    var googleFonts: [GoogleFont]
    var spacing: Spacing
    var spacingPresets: [Option]
    var accent: Accent
    var underlines: [Option]
    var bullets: [Bullet]
    var radii: [Option]
    var skillTags: [Option]
    var photo: Photo
    var placements: [Option]
    var shapes: [Option]
    var sizes: [Option]
  }

  /// Mirrors `buildSettings()` in src/iosShell.js. A SUBSET of the web Settings
  /// dialog: the updater, the companion bridge and the legacy Electron import
  /// are all desktop-only, and showing controls that cannot work is worse than
  /// not showing them.
  ///
  /// `hasApiKey`, not the key. The key lives in the OS keychain; the sheet can
  /// write a new one but nothing needs to read it back, so nothing does.
  ///
  /// `syncEnabled` is the person's answer about iCloud, and the only half of
  /// sync that crosses in this direction. The STATUS is computed here (see
  /// `ShellModel.syncStatus`): the account state lives in the transport, and JS
  /// has no way to observe it.
  struct Settings: Decodable, Equatable {
    var theme: String
    var hasApiKey: Bool
    var autoFallback: Bool
    var syncEnabled: Bool
    var version: String

    static let empty = Settings(
      theme: "system", hasApiKey: false, autoFallback: false, syncEnabled: false, version: ""
    )
  }

  /// What the chrome shows before the first snapshot arrives — a fraction of a
  /// second at launch, but it must not render as blank or as "0%".
  static let empty = ShellSnapshot(
    variantId: nil, variantName: "On Paper", variants: [],
    zoom: 1, zoomPercent: 100, pdfBusy: false, modalOpen: false, settings: .empty,
    chat: nil, library: nil, history: nil, jobs: nil, profile: nil,
    document: nil, design: nil
  )
}

// MARK: - Reply pacing

/// Paces the live reply so it flows instead of landing in bursts.
///
/// Ported from Olia (`Screens/Chat/MessageBubble.swift`,
/// `StreamingAnimationController`). Tokens do not arrive smoothly — the network
/// delivers them in clumps and the JS side coalesces them again before
/// publishing — so rendering the snapshot directly makes a reply appear a
/// paragraph at a time. This holds a target and walks toward it a couple of
/// characters per tick, accelerating when it falls behind, which is what turns
/// arrival into typing.
///
/// A class, not view state: the timer has to outlive any view rebuild, and
/// `deinit` is the only place its invalidation can be guaranteed.
@MainActor
@Observable
final class ReplyStream {
  private(set) var visible = ""
  /// True once the pacing has drawn level with what has actually arrived. Until
  /// then the last line is still being typed.
  private(set) var caughtUp = false

  private var target = ""
  private var displayed = ""

  @ObservationIgnored
  private nonisolated(unsafe) var timer: Timer?

  private enum Pace {
    static let interval: TimeInterval = 0.03   // ~33fps
    static let baseChunk = 2                   // characters per tick at rest
    static let maxChunk = 8                    // ceiling, so catching up is not a jump
    static let accelerateOver = 30             // characters behind before speeding up
  }

  deinit { timer?.invalidate() }

  /// Point the pacing at what has actually arrived so far.
  ///
  /// Shrinking or empty input means a NEW reply (or none), so the pacing resets
  /// rather than trying to walk backwards.
  func update(to text: String) {
    guard text != target else { return }
    if text.isEmpty || !text.hasPrefix(displayed) {
      timer?.invalidate()
      timer = nil
      displayed = ""
      visible = ""
    }
    target = text
    guard !text.isEmpty else { caughtUp = true; return }
    caughtUp = false
    start()
  }

  private func start() {
    guard timer == nil else { return }
    // `.common` mode, not the default one: a timer scheduled the ordinary way
    // stops firing the moment a scroll gesture begins, which freezes the reply
    // for exactly as long as the user is reading it.
    let created = Timer(timeInterval: Pace.interval, repeats: true) { [weak self] t in
      guard t.isValid else { return }
      Task { @MainActor in self?.tick(t) }
    }
    RunLoop.current.add(created, forMode: .common)
    timer = created
  }

  private func tick(_ t: Timer) {
    guard displayed.count < target.count else {
      displayed = target
      t.invalidate()
      timer = nil
      withAnimation(.easeOut(duration: 0.3)) {
        visible = displayed
        caughtUp = true
      }
      return
    }

    let behind = target.count - displayed.count
    let acceleration = min(Double(behind) / Double(Pace.accelerateOver), 3)
    let chunk = max(Pace.baseChunk, min(Int(Double(Pace.baseChunk) * acceleration), Pace.maxChunk))
    let end = wordBoundary(after: displayed.count, within: chunk, in: target)

    let from = target.index(target.startIndex, offsetBy: displayed.count)
    let to = target.index(target.startIndex, offsetBy: end)
    displayed += target[from..<to]
    visible = Self.completeLines(of: displayed)
  }

  /// While typing, prefer to publish only COMPLETE lines: a half-written `##` or
  /// `- ` renders as a heading or a bullet that then changes shape, and the
  /// flicker is worse than the wait.
  ///
  /// Deliberately different from Olia in one place: with no complete line yet it
  /// shows the partial one rather than nothing. Olia waits, which is invisible
  /// there because its replies are short; here a long opening paragraph would
  /// leave the transcript blank for the whole time it was being written.
  private static func completeLines(of text: String) -> String {
    guard let lastNewline = text.lastIndex(of: "\n") else { return text }
    return String(text[...lastNewline])
  }

  /// End the chunk on a word boundary where one is close, so words are never
  /// half-drawn.
  private func wordBoundary(after start: Int, within maxChars: Int, in text: String) -> Int {
    let length = text.count
    let ideal = min(start + maxChars, length)
    guard ideal < length else { return ideal }

    let from = text.index(text.startIndex, offsetBy: ideal)
    let to = text.index(text.startIndex, offsetBy: min(ideal + 3, length))
    if let boundary = text[from..<to].firstIndex(where: { $0.isWhitespace || $0.isPunctuation }) {
      return ideal + text.distance(from: from, to: boundary) + 1
    }
    return ideal
  }
}

/// A generated PDF waiting to be reviewed and saved.
struct PdfPreviewRequest: Equatable, Identifiable {
  /// The temp file this process just wrote. Rendered directly by PDFKit.
  let path: String
  /// The name to offer, without the extension.
  let filename: String
  var id: String { path }
  var url: URL { URL(fileURLWithPath: path) }
}

/// What one round trip to `window.__opShell.command()` produced — see
/// `ShellModel.sendForResult`.
///
/// This was `Any?`, and one `nil` could not carry the answer: it meant "the page
/// returned null", "the command refused", "the eval failed" and "nobody answered
/// inside ten seconds" all at once. `syncUnit` needs the last one told apart
/// from the first. A JS `null` is the page saying it holds nothing under that
/// id — a final answer, and `recordToSend` is right to drop the queued send on
/// it. A timeout is the page not answering AT ALL, and reading that as "nothing"
/// threw a real local edit off the queue, where it stayed until the unit
/// happened to be edited again.
enum ShellReply {
  /// The command ran and returned. `NSNull` is a real JS `null`; `nil` is a
  /// handler that returned nothing, which the dispatcher sends as an absent
  /// `result` key.
  case answered(Any?)
  /// No answer: no webview, the eval failed, the command refused, or the ten
  /// seconds ran out.
  case unanswered
}

// MARK: - Model

/// The single piece of state the chrome renders from. Deliberately not durable:
/// `appStorage` and the Rust disk store stay the source of truth, and this is a
/// projection of them that is thrown away on every update.
@MainActor
final class ShellModel: ObservableObject {
  @Published var snapshot: ShellSnapshot = .empty {
    didSet {
      reply.update(to: Self.liveReplyText(in: snapshot))
      // The switch in Settings writes to storage and republishes; this is where
      // that answer becomes a running or a stopped transport. Without it the
      // toggle would move, the preference would persist, and sync would carry
      // on exactly as before — which looks correct from every side but the
      // account's.
      let enabled = snapshot.settings.syncEnabled
      guard enabled != syncEnabled else { return }
      Task { [weak self] in await self?.syncPreference(enabled) }
    }
  }

  /// Paces the live reply's text. Lives here rather than in the chat sheet so
  /// closing and reopening the sheet mid-reply does not retype it from the top.
  let reply = ReplyStream()

  /// Set when the web side has generated a PDF and wants it reviewed. Unlike
  /// every other sheet this one is opened by the PAGE, not by a toolbar tap —
  /// export runs for a second or two first.
  @Published var pdfPreview: PdfPreviewRequest?

  private static func liveReplyText(in snapshot: ShellSnapshot) -> String {
    snapshot.chat?.messages.first { $0.id == "streaming" }?.text ?? ""
  }

  /// Weak: the webview belongs to wry and is retained by the view hierarchy.
  weak var webView: WKWebView?

  /// The CloudKit transport, held STRONGLY and held nowhere else.
  ///
  /// `OPSyncEngine` holds its host weakly (OPSync.swift) so that CKSyncEngine's
  /// own strong hold on its delegate cannot close a cycle around the whole
  /// transport. That makes this the only strong reference in the app: a weak
  /// one here would let the engine deallocate the moment `start` returned, and
  /// the delegate would go with it — no callbacks, no error, no sign anything
  /// had stopped.
  ///
  /// `lazy` because `OPSyncEngine.init` takes `self`, which a stored property's
  /// initializer cannot reach. Assigning it in an `init` would work equally
  /// well; lazy keeps the reason next to the property instead of in a
  /// constructor this class does not otherwise need.
  private lazy var sync = OPSyncEngine(host: self)

  /// What the transport last said about the iCloud account. Drawn as a line in
  /// Settings (`syncStatus`) and nowhere else: signed out is a normal state,
  /// not an error, and it gets no alert.
  @Published private(set) var syncAccountState: OPSyncAccountState?

  /// ONE of the failures this device is not already acting on — see
  /// `syncDidFail`. Also only ever a line in Settings.
  ///
  /// WHICH one is not meaningful and deliberately not promised: `syncStatus`
  /// asks whether this is nil and nothing else, because no `CKError` is ever
  /// shown to a person. What IS promised is the bit — non-nil exactly while
  /// `syncOutstanding` holds something.
  @Published private(set) var syncFailure: OPSyncFailure?

  /// The one thing sync says while the app is in USE, rather than in Settings: a
  /// conflict was resolved underneath the person, and the version it replaced is
  /// still there to be restored. `nil` draws nothing. See `announceParked`.
  ///
  /// The design spec asks for "one non-blocking notice per resolution — not per
  /// record", and this is the whole of that. Non-blocking is not a style
  /// preference: sync is background reconciliation, nothing in the app waits on
  /// it, and an alert would take the keyboard away from someone mid-sentence to
  /// report something that has already been handled correctly.
  ///
  /// It lives on the model rather than in the chrome because the CLOCK that
  /// takes it back down is the model's. A notice raised while a sheet is up must
  /// not be cut short — or restarted — by that sheet closing and remounting the
  /// bar.
  @Published private(set) var conflictNotice: String?

  /// Counts notices so a stale hide cannot cut a newer one short — the same
  /// clock `keepZoomOpen` runs in the chrome, for the same reason.
  private var conflictNoticeGeneration = 0

  /// Every failure the status line is still standing behind, keyed the way
  /// `OPSyncFailure` names what failed: a unit id, or nil for the zone or a
  /// fetch, which applies to every unit in it. `Optional<String>` is a perfectly
  /// good key, so the key IS `failure.unitId` — no sentinel to explain and no
  /// second property to keep in step.
  ///
  /// This exists so the warning can come DOWN. It used to be one value cleared
  /// only by switching sync off, so a network blip left "some changes haven't
  /// reached iCloud yet" up until relaunch, long after the change had reached
  /// iCloud. The engine says when something lands (`syncDidLand`), and the only
  /// honest reading of that is per-name: unit A failing permanently while unit B
  /// saves fine is still a problem, so clearing on any success would hide A
  /// behind B.
  ///
  /// A SET of ids would have been smaller and is not enough — `syncFailure` has
  /// to publish an `OPSyncFailure`, and synthesising one to stand for an id is a
  /// worse lie than keeping the one that was reported. A dictionary is the same
  /// set with the reported value still attached.
  private var syncOutstanding: [String?: OPSyncFailure] = [:]

  /// Whether the person has turned iCloud sync on, as the page last reported
  /// it. `nil` until the first report, and that distinction is load-bearing:
  /// "this device already had sync on" and "they just turned it on" reach here
  /// identically, and only the second CREATES a full-upload debt for the profile
  /// that happens to be active. An existing debt survives either one (see
  /// `syncPreference`); a profile this device has never offered one for gets its
  /// own on the first gated start (see `runStartSync`).
  private var syncEnabled: Bool?

  /// The profile the page last activated with. The engine may not be running
  /// for it — sync switched off, or no iCloud account — but it is what a later
  /// start has to name, so it is recorded before that gate rather than after.
  /// A switch (which reloads the window) can then be told apart from the same
  /// document coming back after WebKit reclaimed its content process.
  private var syncProfileId: String?

  /// Unit ids `syncDidFail` has already re-queued once. The bound on the
  /// recovery loop; see `syncDidFail` for why there has to be one.
  private var syncRecovered: Set<String> = []

  /// Unit ids this device still owes the server a send of, drained by every
  /// start. Three things put one here and they are the same thing: the send
  /// could not be made (`sendSync`), the page could not be asked for the unit
  /// (`syncUnit(withId:)`), or the page could not APPLY what arrived and its
  /// change tag was forfeited, so only a send can bring that record back down
  /// the conflict path (`syncDidFetch`).
  private var syncDeferred: Set<String> = []

  /// Device-local transport bookkeeping, beside OPSync's own
  /// `op-sync-state-<profile>` and `op-sync-records-<profile>` UserDefaults.
  /// Per-profile because each profile is a different CloudKit zone, and outside
  /// JS storage so neither sync nor a backup can carry one device's debt to
  /// another.
  ///
  /// TRI-STATE, and all three states are load-bearing: absent means this device
  /// has never offered this profile a full upload, `true` means it owes one, and
  /// `false` means it settled one. `runStartSync` creates the debt on absent and
  /// `sendAllUnits` settles it to `false` — never back to absent, or every later
  /// activation of that profile would look like its first.
  private static func syncFullUploadKey(_ profileId: String) -> String {
    "op-sync-full-upload-owed-\(profileId)"
  }

  /// The `startSync` in flight, if any — see `startSync` for why one is enough.
  private var syncStart: Task<Void, Never>?

  /// What the last `setZoom` said, so a finger resting still does not fire a
  /// command per touch event. Everything a frame carries is in here, because
  /// dropping a frame whose SCALE was unchanged would also drop the pan a
  /// two-finger drag produces.
  private struct ZoomFrame: Equatable {
    let milliPercent: Int
    let live: Bool
    let focus: CGPoint?
  }
  private var lastZoomFrame: ZoomFrame?

  /// Drive the web zoom model from a native pinch.
  ///
  /// Clamped to the same range `zoomControls.js` uses, and de-duplicated at a
  /// tenth of a percent. NOT at a whole percent, which is where this started:
  /// one percent of absolute scale is a 2% jump at a typical fit zoom, so the
  /// canvas visibly stepped from one value to the next instead of tracking the
  /// fingers. A tenth is ~0.8px on the page's 816px width — finer than the
  /// display can show, and the readout still rounds to whole percent.
  ///
  /// `live` marks the frames of a gesture, which the web side applies without
  /// its zoom transition. The de-dupe deliberately lets a repeat through when
  /// `live` changes: the last frame of a pinch is usually the same value as
  /// the one before it, and swallowing it would leave the canvas stuck in
  /// no-transition mode for good.
  ///
  /// `focus` is the midpoint between the fingers, in the canvas view's own
  /// coordinates — which are also the page's client px, because page zoom is
  /// off and the webview is pinned to that view edge to edge. The web side
  /// scrolls to hold that point still, so the zoom happens under the gesture.
  func setZoom(_ value: Double, live: Bool = false, focus: CGPoint? = nil) {
    let clamped = min(max(value, 0.25), 2.0)
    let frame = ZoomFrame(
      milliPercent: Int((clamped * 1000).rounded()),
      live: live,
      focus: focus.map { CGPoint(x: $0.x.rounded(), y: $0.y.rounded()) }
    )
    guard frame != lastZoomFrame else { return }
    lastZoomFrame = frame
    var payload = [
      "value": String(format: "%.4f", clamped),
      "live": live ? "true" : "false",
    ]
    if let focus {
      payload["x"] = String(format: "%.1f", focus.x)
      payload["y"] = String(format: "%.1f", focus.y)
    }
    send("setZoom", payload)
  }

  /// Send a command to `window.__opShell.command()`.
  ///
  /// The payload crosses as a JS *string literal* rather than an object
  /// literal, so nothing in it can be parsed as code however it was built.
  /// `onResult` receives the dispatcher's own `ok` — false when the command ran
  /// and REFUSED, which is different from the eval failing. Most callers do not
  /// care, because the next snapshot shows whether the write landed; the ones
  /// that address a version by index do, because a refusal there means the
  /// history renumbered under the sheet and the user has to be told.
  func send(
    _ type: String, _ extra: [String: String] = [:], onResult: ((Bool) -> Void)? = nil
  ) {
    evaluate(type, extra) { reply in
      guard let onResult else { return }
      onResult((reply?["ok"] as? Bool) == true)
    }
  }

  /// `send`, but with the JS handler's own RETURN VALUE.
  ///
  /// The dispatcher replies `{ ok, result }` and `send` collapses that to `ok`,
  /// which is all any command needed until sync: `syncUnit` asks the page for a
  /// unit and the unit is the point.
  ///
  /// Never a Promise. The dispatcher drops thenables before replying, since
  /// `evaluateJavaScript` cannot serialize one.
  func sendForResult(_ type: String, _ extra: [String: String] = [:]) async -> ShellReply {
    await withCheckedContinuation { continuation in
      // Resumed exactly once, from whichever of the two paths below arrives
      // first. Both land on the main thread — WKWebView calls its completion
      // handlers there, and the timer is on the main queue — so the flag needs
      // no lock.
      var settled = false
      let finish: @MainActor (ShellReply) -> Void = { value in
        guard !settled else { return }
        settled = true
        continuation.resume(returning: value)
      }

      evaluate(type, extra) { reply in
        guard let reply, (reply["ok"] as? Bool) == true else {
          finish(.unanswered)
          return
        }
        finish(.answered(reply["result"]))
      }

      // BOUNDED, because `evaluateJavaScript` against a webview that is still
      // loading never calls back at all — measured, see `activateWeb`. That is
      // a live state here and not a hypothetical: WebKit reclaims the content
      // process of a backgrounded app and reloads on return, while the sync
      // engine sends on a schedule of its own. A continuation that never
      // resumes would suspend the engine's batch builder and with it every
      // later send for the life of the process, silently. Ten seconds is far
      // longer than a reply to a live page takes and short enough that the
      // engine is not left waiting on a page that is gone.
      DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
        MainActor.assumeIsolated {
          if !settled { NSLog("[OPShell] command \(type) never answered") }
          finish(.unanswered)
        }
      }
    }
  }

  /// One command out, one reply back. The encode-and-escape block lives here
  /// and only here; `send` and `sendForResult` differ only in what they keep
  /// from the reply.
  ///
  /// `handle` is called exactly once, including when there is no webview to ask
  /// — a caller awaiting an answer has to get one.
  private func evaluate(
    _ type: String, _ extra: [String: String], _ handle: @escaping @MainActor ([String: Any]?) -> Void
  ) {
    var body: [String: String] = extra
    body["type"] = type
    guard let json = try? JSONSerialization.data(withJSONObject: body),
          let text = String(data: json, encoding: .utf8),
          let literal = Self.jsStringLiteral(text) else {
      NSLog("[OPShell] could not encode command: \(type)")
      handle(nil)
      return
    }
    guard let webView else {
      NSLog("[OPShell] no webview for command: \(type)")
      handle(nil)
      return
    }
    webView.evaluateJavaScript("window.__opShell && window.__opShell.command(\(literal))") { value, error in
      if let error { NSLog("[OPShell] command \(type) failed: \(error)") }
      let reply = error == nil ? value as? [String: Any] : nil
      Task { @MainActor in handle(reply) }
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

// MARK: - Sync

/// Driving the transport. Four lifecycle moments — the switch in Settings, a
/// document coming up, a save landing, a return to the foreground — and nothing
/// else: sync is background reconciliation, so nothing in the UI waits on any of
/// it and no failure becomes a dialog.
extension ShellModel {
  /// Make the transport match the answer the page just reported.
  ///
  /// The switch writes to storage in JS and republishes; the snapshot's `didSet`
  /// lands here. That round trip is deliberate — the preference has ONE home,
  /// and it is the same storage every other setting lives in — but it means this
  /// is the only place the toggle actually does anything, so it has to do all of
  /// it.
  ///
  /// Idempotent: two snapshots carrying the same answer are one change.
  func syncPreference(_ enabled: Bool) async {
    let previous = syncEnabled
    guard previous != enabled else { return }
    syncEnabled = enabled

    guard enabled else {
      // Off means off, and off means QUIET — not gone. Stopping tears down the
      // engine and nothing else: every résumé stays exactly where it is, on
      // this device and in the account. Someone will eventually ask whether
      // turning sync off deletes the cloud copy. It does not, and deleting it
      // is a separate feature that is not built.
      //
      // A start can be IN FLIGHT while this runs, and another start can be
      // enqueued by a quick ON flick after this one. The stop joins that same
      // chain: it lands after everything already queued and before everything
      // queued later, including `stop()`'s `cancelOperations` suspension.
      await stopSync()
      // Only a real change earns a line. The first report of "off" is this
      // device's stored answer arriving at launch, not a decision just made.
      if previous == true {
        NSLog("[OPShell] iCloud sync switched off — the transport is down, local data untouched")
      }
      return
    }

    guard let syncProfileId else {
      // No document has come up yet. Its activation starts the engine, and it
      // will find the switch already on — and, this being that profile's first
      // start past the gate, will create its debt there (see `runStartSync`).
      return
    }
    // `previous == nil` is the first report of a preference that was already on
    // — a launch, not a decision — so it does not CREATE a new debt. Any debt
    // created before process death is already in UserDefaults and remains owed.
    //
    // `previous == false` is a decision just made, and it re-offers the whole
    // workspace even for a profile that settled a debt long ago: off-then-on
    // means "put this device's contents in the account", and the account may
    // have been emptied while the switch was down. That is deliberately NOT what
    // `runStartSync` does — it offers a profile exactly once, because its
    // trigger is an activation rather than a choice.
    //
    // EVERY profile this device has considered, not only the active one. The
    // shell still has no workspace list — it learns a profile exists when the
    // page activates it — but it does not need one: the markers ARE that list,
    // one key per profile that has ever reached a gated start, and nothing
    // removes them. `runStartSync` is still where a profile this device has
    // never seen gets its first offer, because that is the moment it is first
    // named to this side at all.
    if previous == false {
      oweFullUploadForEveryConsideredProfile()
      // The active profile can be exactly such a profile: a flip before any
      // gated start leaves no marker for it, and the sweep can only re-owe keys
      // that exist.
      setSyncFullUploadOwed(true, profileId: syncProfileId)
    }
    await startSync(profileId: syncProfileId)
  }

  /// The page's answer to `syncCollect`: the id of every unit this device would
  /// push, at the moment sync was turned on.
  ///
  /// The switch can go off during that round trip, and a batch that arrives
  /// after it did must not be sent — this is the whole device, not one save.
  /// A transport that is merely DOWN keeps the persisted debt: `sendSync` may
  /// also hold the ids for the next start, but a profile switch drops that
  /// process-local set because the ids belong to another zone. Re-collecting
  /// from the persisted marker is what closes that hole.
  func sendAllUnits(_ unitIds: [String]) async {
    guard syncEnabled == true else {
      NSLog("[OPShell] iCloud sync is off; \(unitIds.count) unit(s) not sent")
      return
    }
    guard let profileId = syncProfileId, syncFullUploadOwed(profileId: profileId) else {
      NSLog("[OPShell] no full upload is owed; \(unitIds.count) collected unit(s) ignored")
      return
    }
    NSLog("[OPShell] offering \(unitIds.count) unit(s) after iCloud sync was switched on")
    let sent = await sendSync(unitIds: unitIds)
    if sent {
      setSyncFullUploadOwed(false, profileId: profileId)
    }
  }

  /// Stop through the same ONE-AT-A-TIME chain as `startSync`. Capturing the
  /// current tail before installing this task is what orders a later ON flick
  /// behind the stop instead of letting its start enter `cancelOperations`.
  private func stopSync() async {
    let previous = syncStart
    let task = Task { @MainActor [weak self] in
      await previous?.value
      await self?.sync.stop()
      // The status line is about a transport that is now down; keeping the last
      // account state or failure would leave it describing a stopped engine.
      self?.syncAccountState = nil
      self?.forgetSyncFailures()
    }
    syncStart = task
    await task.value
    // Only if nothing queued behind it, or this would drop a start still to run.
    if syncStart == task { syncStart = nil }
  }

  /// Bring sync up for the profile the webview just loaded, and pull once.
  ///
  /// Called from the `activated` message, which is posted once per document —
  /// a first load, a profile switch (which reloads the window), or WebKit
  /// reclaiming a backgrounded content process and reloading. `start` is
  /// idempotent for the profile already running, so the repeats cost nothing
  /// and, importantly, do not tear down the engine's in-memory queue.
  ///
  /// ONE AT A TIME. That idempotency only holds up to the first suspension:
  /// `sync.start` checks whether the engine is already up for this profile, and
  /// `stop()`'s `await cancelOperations()` is a window in which a second caller
  /// passes the same check and builds a second `CKSyncEngine` over the first.
  /// An activation landing on a foreground `resumeSync` is exactly that pair,
  /// and the engine is the one object every other piece of state here is keyed
  /// to.
  ///
  /// Serialized rather than coalesced: a profile switch and a foreground resume
  /// can name DIFFERENT profiles, so the second call has real work to do and
  /// folding it into the first would skip the switch. It waits its turn instead.
  func startSync(profileId: String) async {
    let previous = syncStart
    let task = Task { @MainActor [weak self] in
      await previous?.value
      await self?.runStartSync(profileId: profileId)
    }
    syncStart = task
    await task.value
    // Only if nothing queued behind it, or this would drop a start still to run.
    if syncStart == task { syncStart = nil }
  }

  private func runStartSync(profileId: String) async {
    guard !profileId.isEmpty else {
      // Before the workspace has an active profile there is no zone to sync
      // to. The app works; sync waits for the next activation.
      NSLog("[OPShell] no active profile in the activation — sync stays down")
      return
    }
    if syncProfileId != profileId {
      // A different profile is a different zone and a different engine session,
      // so neither the previous session's recovery attempts nor its unsent ids
      // carry over — the latter name units in a zone this engine will not open.
      syncRecovered.removeAll()
      syncDeferred.removeAll()
      // Its outstanding failures go with them, for the same reason and one more:
      // an outstanding failure comes down when the thing it names next reaches
      // iCloud, and nothing in another profile's zone can ever be that. Held, it
      // would be a warning with no way left to clear it — which is the sticky
      // line this whole arrangement exists to stop. Anything still wrong there
      // is reported again by that profile's own next send.
      forgetSyncFailures()
      syncProfileId = profileId
    }

    // THE GATE. Every way the transport comes up runs through here — the
    // activation of a document, a return to the foreground (`resumeSync`), and
    // the switch itself — so this one check is what makes the toggle mean
    // something. It sits below the bookkeeping above on purpose: a person who
    // turns sync on mid-session needs a profile to start with, and this is
    // where the page said what it is.
    //
    // `nil` is the preference not yet reported, which happens on every launch:
    // the activation beats the first snapshot by a frame. Sync stays down until
    // that snapshot lands, and `syncPreference` starts it if the answer is yes.
    guard syncEnabled == true else {
      NSLog(syncEnabled == nil
            ? "[OPShell] the sync preference has not been reported yet — waiting for the snapshot"
            : "[OPShell] iCloud sync is off for this device — the transport stays down")
      return
    }

    // THIS profile's debt, if this device has never offered it one.
    //
    // `syncPreference` creates a debt when the switch is flipped, but only for
    // the profile that was active at that moment — and workspaces are a shipped
    // feature, so there are usually several. Every other profile's PRE-EXISTING
    // résumés therefore never reached iCloud at all: a unit arrives in the
    // account only when `send(unitIds:)` names it, and persistence names a unit
    // once, on the save that wrote it, so a second workspace trickled up one
    // résumé at a time as each happened to be edited again. Turning sync on is
    // the moment this device offers everything it holds, and it holds every
    // profile.
    //
    // Created on the profile's first start PAST THE GATE, which is the same
    // moment `syncPreference` represents for the active profile — "sync is on
    // and this workspace has come up" — generalised to all of them. Above the
    // account check for the same reason `syncPreference` is: a debt is OWED, not
    // sent, so turning sync on (or switching profile) while signed out still
    // records it, and whichever start does come up pays it.
    //
    // ONCE per profile per install, and the marker is what guarantees that
    // rather than a guess about when activations happen. An `activated` message
    // is posted per DOCUMENT — every profile switch, every relaunch, and every
    // time WebKit reclaims the content process and reloads — so a re-collection
    // on each one would be a whole-workspace re-upload several times a day.
    // `setSyncFullUploadOwed` now records `false` on settlement instead of
    // removing the key, so a settled debt is still a decision on record and only
    // a genuinely never-seen profile is absent here. Nothing removes the key
    // afterwards, so this branch cannot be taken twice for the same profile.
    if !syncFullUploadConsidered(profileId: profileId) {
      NSLog("[OPShell] first gated start for this profile — a full upload is owed")
      setSyncFullUploadOwed(true, profileId: profileId)
    }

    let state = await sync.start(profileId: profileId)
    syncAccountState = state
    guard state == .available else {
      // Signed out, restricted, or iCloud not reachable. All normal, none an
      // error, and NOTHING local changes because of them — an empty server is
      // not what this means.
      NSLog("[OPShell] sync is not running: \(state)")
      return
    }

    // Anything this device still owes a send of goes up before the pull, so a
    // unit changed on both sides meets the conflict path rather than being
    // quietly overwritten by what arrives. That is also the only thing that can
    // recover a batch the page would not apply: the pull cannot re-deliver it —
    // the change token has moved past it — but a send with no tag brings it back
    // down that same conflict path. See `syncDeferred`.
    let deferred = syncDeferred
    syncDeferred.removeAll()
    await sendSync(unitIds: Array(deferred))
    try? await sync.fetch()

    // Turning sync on is the one moment this device has to offer everything it
    // already holds. A unit reaches the account only when `send(unitIds:)` names
    // it, and persistence names a unit once — on the save that wrote it — so a
    // résumé the person never edits again would otherwise never arrive at all.
    // The page answers `syncCollect` with a `syncUnits` message.
    //
    // OWED rather than sent from the toggle, because turning it on while signed
    // out starts nothing: the upload waits for whichever start does come up.
    // Requesting the collection does NOT clear the debt. The process can die,
    // the page can reload, or `sendSync` can defer these ids; only a successful
    // send in `sendAllUnits` clears it.
    if syncFullUploadOwed(profileId: profileId) {
      send("syncCollect")
    }
  }

  /// Back in the foreground: another device may have moved on while this one
  /// was away.
  ///
  /// The whole activation path rather than a bare `fetch`, because the engine
  /// may never have come up — signed out at launch, or no network — and nothing
  /// else would bring it up before the next document load. `start` is
  /// idempotent for the profile already running, so the ordinary case costs one
  /// account-status check.
  ///
  /// Backgrounding needs no counterpart: the save debounce has already posted
  /// `syncDirty` for anything that changed.
  ///
  /// Gated like every other way up, because it goes through `startSync`: a
  /// device whose switch is off must not quietly start syncing the first time
  /// the app comes back to the foreground.
  func resumeSync() async {
    // No activation yet means no profile and no engine; that path fetches for
    // itself the moment the document comes up.
    guard let syncProfileId else { return }
    await startSync(profileId: syncProfileId)
  }

  /// Units whose bytes just landed on disk, named by `syncDirty`.
  ///
  /// The engine flushes EVERYTHING pending rather than just these, on purpose
  /// (OPSync.swift): a unit whose last send failed transiently is sitting in
  /// that queue and would otherwise wait for its own next edit.
  @discardableResult
  func sendSync(unitIds: [String]) async -> Bool {
    // An answered collection can legitimately be empty. There is no transport
    // work to do, and treating that as sent lets its persisted debt settle.
    guard !unitIds.isEmpty else { return true }
    do {
      try await sync.send(unitIds: unitIds)
      return true
    } catch {
      // Two things reach here: `notStarted` — signed out, or an edit that beat
      // the first activation — and anything `engine.sendChanges()` itself
      // throws. Holding the ids is what the first needs and costs the second
      // nothing: `send` queued those changes before it threw and
      // `add(pendingRecordZoneChanges:)` deduplicates, so the next start
      // re-queues nothing that is already there.
      //
      // These ids are the ONLY record that those bytes changed: persistence
      // names a unit once, on the save that wrote it, and will not name it
      // again until it is edited again. So they wait for the next start instead
      // of being dropped.
      syncDeferred.formUnion(unitIds)
      NSLog("[OPShell] sync is down; \(unitIds.count) unit(s) held for the next start")
      return false
    }
  }

  private func syncFullUploadOwed(profileId: String) -> Bool {
    UserDefaults.standard.bool(forKey: Self.syncFullUploadKey(profileId))
  }

  /// Whether this device has ever decided about a full upload for this profile —
  /// owed or settled, the two being the same answer to this question. Only an
  /// ABSENT key is "never", which is the state `runStartSync` acts on.
  private func syncFullUploadConsidered(profileId: String) -> Bool {
    UserDefaults.standard.object(forKey: Self.syncFullUploadKey(profileId)) != nil
  }

  private func setSyncFullUploadOwed(_ owed: Bool, profileId: String) {
    // RECORDED, not removed, on settlement. The absence of this key is what
    // `runStartSync` reads as "this profile has never been offered a full
    // upload", so removing it here would make every later activation of that
    // profile look like its first and re-collect the whole workspace.
    UserDefaults.standard.set(owed, forKey: Self.syncFullUploadKey(profileId))
  }

  /// Owe a full upload again for every profile this device has ever considered.
  ///
  /// THE MARKER KEYS ARE THE LIST. This side never sees a workspace list — a
  /// profile is named to it by the page's `activated` message and no other way —
  /// but `runStartSync` leaves one key per profile it has gated, and nothing
  /// removes one, so the keys enumerate every profile this device has ever
  /// started sync for. That is the second thing recording a settled debt as
  /// `false` instead of deleting the key bought.
  ///
  /// Re-owing is a WRITE of `true`, never a delete. Absence means "never
  /// considered", and turning a settled profile back into a never-considered one
  /// would make its next activation look like its first for reasons that have
  /// nothing to do with why it is being re-offered here.
  ///
  /// A profile with no key is not reached and does not need to be: its first
  /// gated start creates its debt from absent, which is the same offer arriving
  /// by the other route.
  ///
  /// Owed, not sent — as everywhere else in this feature. The next start for a
  /// profile is what asks the page to collect it.
  private func oweFullUploadForEveryConsideredProfile() {
    let defaults = UserDefaults.standard
    let prefix = Self.syncFullUploadKey("")
    let keys = defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(prefix) }
    for key in keys { defaults.set(true, forKey: key) }
    NSLog("[OPShell] a full upload is owed again for \(keys.count) considered profile(s)")
  }

  /// Stand behind one more failure. The published value is the one just
  /// reported, which is the closest thing to "most recent" this keeps.
  private func recordSyncFailure(_ failure: OPSyncFailure) {
    syncOutstanding[failure.unitId] = failure
    syncFailure = failure
  }

  /// `key` — a unit id, or nil for the zone-and-fetch entry — reached iCloud, so
  /// whatever was outstanding against it is not outstanding any more.
  ///
  /// Republishing from what is LEFT is the whole point: the line stays up while
  /// anything remains, and `values.first` is an arbitrary survivor because the
  /// line does not name one. Cheap by construction — the guard means this runs
  /// only when something actually cleared, not on every successful save.
  private func resolveSyncFailure(_ key: String?) {
    guard syncOutstanding.removeValue(forKey: key) != nil else { return }
    syncFailure = syncOutstanding.values.first
  }

  /// Stop standing behind any of it. For the two moments when nothing reported
  /// so far can still be observed: the transport going down, and the profile —
  /// and therefore the zone — changing under it.
  private func forgetSyncFailures() {
    syncOutstanding.removeAll()
    syncFailure = nil
  }

  /// The one line Settings shows under the switch — or "", which draws no row
  /// at all, because saying nothing is better than saying nothing useful.
  ///
  /// Computed here rather than projected from JS: both halves of it, the iCloud
  /// account's state and the last failure, exist only in the transport, and the
  /// page has no way to observe either.
  ///
  /// The rules the wording follows matter more than the words:
  ///
  /// - **Signed out is not an error.** It is an ordinary state — the app works
  ///   exactly as well without an account — so the line says what to do, not
  ///   what went wrong.
  /// - **No `CKError` ever reaches a person.** `OPSyncFailure.reason` is
  ///   diagnostic text for a log line; it is never shown.
  /// - **Nothing claims success it cannot back.** "Synced" is a claim about a
  ///   server this device cannot see inside, so it is not made.
  /// - **Nothing blames the person, and nothing suggests their résumés are at
  ///   risk.** They are on this device whatever iCloud is doing.
  var syncStatus: String {
    // The switch itself says sync is off; a second line saying so is a row that
    // tells the reader nothing they did not just set.
    guard snapshot.settings.syncEnabled else { return "" }
    // On, but the transport has not reported yet — a moment at launch, and the
    // whole time before the workspace has adopted a profile. Nothing to say.
    guard let syncAccountState else { return "" }

    switch syncAccountState {
    case .available:
      guard syncFailure == nil else {
        return "Some changes haven't reached iCloud yet. Your resumes are still here."
      }
      return "iCloud sync is on. New changes go up in the background."
    case .signedOut:
      return "Sign in to iCloud in the Settings app to sync this device."
    case .restricted:
      return "iCloud isn't available to On Paper on this device. Your resumes stay here."
    case .temporarilyUnavailable:
      return "iCloud isn't ready just now. On Paper will try again."
    case .undetermined:
      return "iCloud can't be reached right now. Your changes will go up when it is."
    case .checkFailed:
      return "On Paper couldn't check your iCloud account just now. It will try again."
    }
  }

  /// Long enough to read two clauses and decide whether to tap, short enough
  /// that it is gone before it becomes furniture. The same ten seconds the
  /// migration notice on the desktop already uses (`showMigrationToast` in
  /// src/main.js).
  private static let conflictNoticeSeconds = 10.0

  /// Raise the one notice for a resolution, and start the clock that takes it
  /// back down.
  ///
  /// A second resolution arriving while the first is still up REPLACES it and
  /// restarts the clock: one notice on screen at a time is the same rule as one
  /// notice per batch, applied across batches.
  private func announceParked(_ parked: Int) {
    guard parked > 0 else { return }
    conflictNotice = Self.conflictNoticeText(parked)
    conflictNoticeGeneration += 1
    let generation = conflictNoticeGeneration
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(Self.conflictNoticeSeconds))
      guard let self, generation == self.conflictNoticeGeneration else { return }
      self.conflictNotice = nil
    }
  }

  /// Read, or acted on. Bumps the generation so the pending hide belongs to
  /// nothing and cannot take a LATER notice down early.
  func dismissConflictNotice() {
    conflictNoticeGeneration += 1
    conflictNotice = nil
  }

  /// What the notice says. The rules behind the words:
  ///
  /// - **The source device is not named**, though the spec's example sentence
  ///   named one. The record carries an opaque device id and nothing else, and
  ///   since iOS 16 `UIDevice.current.name` is a generic model string anyway —
  ///   so "from your iPhone" would be a guess printed as a fact. The parked
  ///   entry is already labelled "From another device"
  ///   (src/historyEntryLabels.js) and this agrees with it, word for word.
  /// - **It names no résumé.** History is per-résumé, a batch can hold several,
  ///   and the unit id is the page's to decompose, not this side's — a unit is
  ///   `{ id, kind, payload, modifiedAt }` here and stays opaque. Saying "one of
  ///   your resumes" is less than the person would like and all that is true.
  /// - **Nothing suggests loss**, because there is none: the sentence exists to
  ///   say where the previous version went.
  private static func conflictNoticeText(_ parked: Int) -> String {
    parked == 1
      ? "A newer version from another device replaced one of your resumes. "
        + "The previous one is in Version history."
      : "Newer versions from another device replaced \(parked) of your resumes. "
        + "The previous ones are in Version history."
  }
}

/// Where the transport meets the page. Every one of these is a command on the
/// same bridge the rest of the chrome uses, and not one of them looks inside a
/// payload — a unit is `{ id, kind, payload, modifiedAt }` with the payload an
/// opaque string, and all decomposition stays in JS.
///
/// The non-async methods are called from inside the engine's event handling, so
/// they stay cheap and none of them re-enters the engine directly. The async
/// pair suspends on the bridge, and the engine awaits them: the whole point of
/// `syncDidFetch`'s answer is that the transport must not move on before it has
/// one.
extension ShellModel: OPSyncHost {
  /// The unit as the page holds it RIGHT NOW, asked at send time.
  func syncUnit(withId id: String) async -> SyncUnit? {
    guard case .answered(let value) = await sendForResult("syncUnit", ["unitId": id]) else {
      // Nobody answered — most often `sendForResult`'s ten-second bound against
      // a webview that is still reloading. That is NOT this device having
      // nothing: `recordToSend` (OPSync.swift) treats nil as a final answer and
      // takes the change off the queue, so reading silence that way dropped a
      // real local edit until the unit happened to be edited again. The id
      // waits for the next start instead, in the same set an edit made while
      // the transport was down waits in.
      syncDeferred.insert(id)
      NSLog("[OPShell] no answer for unit \(id); held for the next start")
      return nil
    }
    // A null result is this device having nothing under that id. The engine
    // drops the queued send and the server keeps whatever it already holds:
    // absence is never a deletion.
    guard let object = value as? [String: Any] else { return nil }
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object),
          let unit = try? JSONDecoder().decode(SyncUnit.self, from: data) else {
      // The two halves of the bridge disagree about the shape of a unit. Same
      // effect as having nothing to send, but it is a bug rather than a state,
      // so it does not pass in silence.
      NSLog("[OPShell] sync unit \(id) did not decode: \(object)")
      return nil
    }
    return unit
  }

  /// Units from another device, handed to the page to apply.
  ///
  /// Answers whether the page took ALL of them, which is what the transport
  /// keeps their change tags on (`deliver` in OPSync.swift). Every way of not
  /// knowing is `false`: the units would not encode, the round trip was never
  /// answered, the reply carried no usable count, or the count came back short.
  /// A wrong `true` is a silent overwrite of the server's newer copy; a wrong
  /// `false` costs one extra round trip the next time this unit is saved.
  ///
  /// A `false` also OWES THESE UNITS ANOTHER GO, and this is the only place that
  /// can record that. Forfeiting the change tags keeps the next save honest, but
  /// it does not bring the content down: the engine's change token has already
  /// advanced past these records and there is no public way to rewind it, so
  /// without this they arrive again only when this device happens to EDIT the
  /// same units — which, for a résumé the person is finished with, is never.
  ///
  /// So the ids join the set an edit made while the transport was down waits in,
  /// and every start drains it (`runStartSync`) — an activation, a return to the
  /// foreground, a profile switch. Sending is the recovery: the tag is gone, so
  /// the save quotes none, CloudKit answers `serverRecordChanged`, and the
  /// record comes back down the conflict path where both copies are compared and
  /// the loser is parked in version history. One round trip, and nothing is lost
  /// whichever copy wins — which is the same argument `deliver` makes for
  /// forfeiting the tag in the first place.
  ///
  /// NOT `syncDidFail`, which would re-queue the send in the same breath and
  /// spend this session's one recovery attempt on the webview that just failed
  /// to answer. Waiting for a start is the difference: a start is a moment the
  /// page is back.
  ///
  /// DELIBERATELY UNBOUNDED, unlike `syncDidFail`'s. A turn of this loop costs
  /// one activation, not one engine event, and every turn is a real attempt that
  /// can succeed — a page that refused because an edit was in flight, or because
  /// the arriving copy was older, is a page that will take it or overrule it
  /// later. A bound could only drop the id, and this same set is where local
  /// edits that never reached iCloud wait, so dropping one is dropping content.
  /// The one case that would loop for ever ends itself: a page that answers "I
  /// have nothing under that id" makes `recordToSend` take the change off the
  /// queue for good.
  func syncDidFetch(_ units: [SyncUnit]) async -> Bool {
    guard await applyFetched(units) else {
      syncDeferred.formUnion(units.map(\.id))
      NSLog("[OPShell] \(units.count) fetched unit(s) were not applied; "
            + "they are offered again at the next start")
      return false
    }
    return true
  }

  /// The ask itself, split out so that no answer of `false` can reach the
  /// transport without the ids being held — the two would otherwise have to be
  /// kept in step at three separate returns.
  private func applyFetched(_ units: [SyncUnit]) async -> Bool {
    guard let data = try? JSONEncoder().encode(units),
          let json = String(data: data, encoding: .utf8) else {
      NSLog("[OPShell] could not encode \(units.count) fetched unit(s)")
      return false
    }
    // A JSON STRING, not an object: the command channel is a JS string literal,
    // the same reason a picked file crosses as base64. `syncApply` parses it.
    //
    // `applied` is the count `applyUnits` returned, read off the dispatcher's
    // own `{ ok, result }` envelope. That is the bridge's shape, not a unit's:
    // this side still never looks inside a payload.
    guard case .answered(let value) = await sendForResult("syncApply", ["units": json]),
          let applied = (value as? [String: Any])?["applied"] as? Int else {
      NSLog("[OPShell] no usable answer for \(units.count) fetched unit(s)")
      return false
    }
    guard applied == units.count else {
      // Which of them landed is not knowable from a count, so the batch is
      // treated as unconfirmed whole. See `deliver`.
      NSLog("[OPShell] the page applied \(applied) of \(units.count) fetched unit(s)")
      return false
    }
    return true
  }

  /// The older side of a conflict, parked in that résumé's version history
  /// rather than discarded — and the one moment sync has anything to SAY.
  ///
  /// Deferred onto a later main-actor turn rather than run inline: this is
  /// called from inside the engine's event handling and the bridge re-enters the
  /// engine, which is the same reason `syncDidFail` defers.
  func syncDidLoseConflict(_ losers: [SyncUnit]) {
    Task { @MainActor [weak self] in await self?.park(losers) }
  }

  /// Park each loser, then tell the person ONCE.
  ///
  /// One command per unit — `parkLoser` takes one, and batching them here would
  /// only move the loop across the bridge — but one NOTICE for the batch, which
  /// is the spec's rule and not a nicety: a device that has been away comes back
  /// owing a full upload, so several résumés conflicting in a single push is an
  /// ordinary shape, and a stack of notices about something that resolved
  /// correctly reads as an alarm.
  ///
  /// The count is what actually LANDED, never `losers.count`. `parkLoser`
  /// answers false for a payload with no document in it and for every non-résumé
  /// unit, which has no history to park in — and a notice pointing at Version
  /// history for a version that is not in it would be worse than silence. Zero
  /// parks, no notice; the log lines are then the only record, which is right,
  /// because there is nothing the person could do about either case.
  private func park(_ losers: [SyncUnit]) async {
    var parked = 0
    for loser in losers {
      // The HANDLER's own return value, off the dispatcher's `{ ok, result }`
      // envelope. `send` collapses that to `ok`, which is only whether the
      // command ran — a refusal comes back as `{ ok: true, result: false }`, so
      // the log line below could never fire and this side could not have told a
      // parked version from a discarded one.
      let reply = await sendForResult(
        "syncParkLoser", ["unitId": loser.id, "payload": loser.payload]
      )
      guard case .answered(let value) = reply, (value as? Bool) == true else {
        // Refusing to park is the one way a version disappears in this design,
        // so it is said out loud rather than assumed away.
        NSLog("[OPShell] the page would not park the older \(loser.id)")
        continue
      }
      parked += 1
    }
    announceParked(parked)
  }

  /// Sends and fetches that did not land.
  ///
  /// One class of these has to be ACTED on rather than logged. A fetched record
  /// that could not be read was dropped and its change tag forgotten, and the
  /// engine's change token has already advanced past it with no public API to
  /// rewind — so the server's newer copy reaches this device only if something
  /// sends that unit again. Re-queueing it is a real recovery: with no tag the
  /// save quotes none, CloudKit answers `serverRecordChanged`, and the record
  /// comes back down the conflict path where both copies are compared and the
  /// loser is parked. Nothing is lost whichever way that comparison goes.
  ///
  /// AT MOST ONCE PER UNIT PER ENGINE SESSION. An unreadable record is most
  /// often an asset whose download did not finish, and an asset that never
  /// downloads fails identically every time: unbounded, this is drop → send →
  /// conflict → same unreadable record → drop, forever, at CloudKit's expense
  /// and the battery's. One attempt either clears it or leaves it for the next
  /// launch. `syncRecovered` is that memory, and `startSync` clears it when the
  /// profile changes — the only point at which the engine session ends without
  /// the process ending with it.
  func syncDidFail(_ failures: [OPSyncFailure]) {
    var recover: [String] = []
    for failure in failures {
      NSLog("[OPShell] sync failure (unit \(failure.unitId ?? "—"), "
            + "willRetry \(failure.willRetry)): \(failure.reason)")
      // Retryable, or about the zone or a fetch rather than one unit: the
      // engine is already handling the first and there is no unit to re-queue
      // for the second. Both are for the status line.
      guard let unitId = failure.unitId, !failure.willRetry else {
        recordSyncFailure(failure)
        continue
      }
      // `insert` reports whether this is the first time. A second failure for
      // the same unit is where the loop would have been, so it is held for the
      // status line instead — this device has now stopped trying.
      guard syncRecovered.insert(unitId).inserted else {
        recordSyncFailure(failure)
        continue
      }
      recover.append(unitId)
    }

    guard !recover.isEmpty else { return }
    // Deferred, not inline: this runs inside the engine's event handling and
    // `send` re-enters the engine. The task puts it on a later main-actor turn,
    // once the event these failures belong to has been fully handled.
    Task { @MainActor [weak self] in await self?.sendSync(unitIds: recover) }
  }

  /// Sends and fetches that landed, which is how a warning comes back DOWN.
  ///
  /// Nothing here is a claim that sync is well — only that these names got
  /// through, which is exactly as much as is needed to stop standing behind a
  /// failure reported against one of them. A failure this device never recorded,
  /// or already cleared, resolves to nothing: `resolveSyncFailure` is a lookup,
  /// so every ordinary successful save costs one.
  ///
  /// A unit id that reached iCloud after failing is settled and says nothing
  /// about any other unit. A nil is the zone or a fetch — the same scope the
  /// failure had, because the failure that names no unit is a failure of
  /// everything in the zone.
  func syncDidLand(_ unitIds: [String?]) {
    for unitId in unitIds { resolveSyncFailure(unitId) }
  }

  /// A different iCloud account is underneath the transport now.
  ///
  /// Every profile this device has considered owes its full upload again. A
  /// settled debt is a claim about the account it settled against, and the new
  /// account has none of these units: nothing in its container was ever named
  /// for send. Left alone, everything not edited since the switch would be
  /// silently absent from it — the same failure the marker exists to close.
  ///
  /// Nothing local changes and nothing is sent from here. The markers are what
  /// the next start reads, and coming back from the Settings app, where an
  /// account is switched, IS a start (`resumeSync`).
  func syncDidSwitchAccounts() {
    NSLog("[OPShell] the iCloud account changed — re-offering every profile's full upload")
    oweFullUploadForEveryConsideredProfile()
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
    case "pdfPreview":
      guard let path = body["path"] as? String else {
        NSLog("[OPShell] pdfPreview message with no path: \(body)")
        return
      }
      let filename = body["filename"] as? String ?? "Resume"
      Task { @MainActor in
        self.model?.pdfPreview = PdfPreviewRequest(path: path, filename: filename)
      }
    case "activated":
      // A document just came up — the first one, or a reload after WebKit
      // reclaimed the content process of a backgrounded app. Either way the
      // scroll view's zoom settings were re-derived from the new page, so the
      // lock has to be re-applied or the canvas gets a second scale back.
      //
      // It also carries the active workspace profile, which is the one thing
      // sync cannot start without: `getActiveProfileId()` lives in JS and the
      // profile names the CloudKit zone. This message is the right carrier
      // because a profile switch reloads the window, so the id is fixed for the
      // life of a document.
      let profileId = body["profileId"] as? String ?? ""
      Task { @MainActor in
        OPShell.lockWebViewZoom()
        await self.model?.startSync(profileId: profileId)
      }
    case "syncDirty":
      // Persistence names the units whose bytes just landed, on the save
      // debounce it already had. WHEN they go up is the engine's to decide —
      // this only says what changed.
      guard let unitIds = body["unitIds"] as? [String], !unitIds.isEmpty else {
        NSLog("[OPShell] syncDirty with no unit ids: \(body)")
        return
      }
      Task { @MainActor in await self.model?.sendSync(unitIds: unitIds) }
    case "syncUnits":
      // The answer to `syncCollect`: everything this device would push, asked
      // for once when the person switches sync on.
      //
      // Only the ID of each unit is read. The payloads are right there in the
      // message and they are deliberately left alone — the engine re-asks for
      // each unit's bytes at send time through `syncUnit(withId:)`, which is
      // the whole point of that callback, and decoding a payload here would be
      // the first place Swift knew what is inside one.
      guard let units = body["units"] as? [[String: Any]] else {
        NSLog("[OPShell] syncUnits with no units: \(body)")
        return
      }
      let unitIds = units.compactMap { $0["id"] as? String }
      // An empty collection is still an answer: there is nothing to put on the
      // wire, and `sendAllUnits` can settle the persisted full-upload debt.
      Task { @MainActor in await self.model?.sendAllUnits(unitIds) }
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
  /// the first JS callback returns, and again on every `activated` message —
  /// each page load re-derives these from the new document's viewport.
  @MainActor
  static func lockWebViewZoom(attempt: Int = 0) {
    guard let scrollView = model?.webView?.scrollView else { return }
    scrollView.pinchGestureRecognizer?.isEnabled = false
    scrollView.minimumZoomScale = 1
    scrollView.maximumZoomScale = 1
    scrollView.bouncesZoom = false
    if attempt == 0 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { lockWebViewZoom(attempt: 1) }
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
          lockWebViewZoom()
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
  /// Cumulative scale, the midpoint between the fingers, and the state.
  let onPinch: (CGFloat, CGPoint, UIGestureRecognizer.State) -> Void

  /// A real `UIPinchGestureRecognizer`, not SwiftUI's `MagnifyGesture`.
  ///
  /// SwiftUI gestures attached to a hosted UIKit view lose the arbitration to
  /// WKWebView's own recognizers — measured: `MagnifyGesture.onChanged` never
  /// fired once while the page went on scaling underneath. Attaching the
  /// recognizer directly, with a delegate that allows simultaneous recognition,
  /// puts us in the same arbitration WebKit is in rather than above it.
  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    let onPinch: (CGFloat, CGPoint, UIGestureRecognizer.State) -> Void
    /// The last focal point measured with both fingers still down. See below.
    private var twoFingerFocus: CGPoint?

    init(onPinch: @escaping (CGFloat, CGPoint, UIGestureRecognizer.State) -> Void) {
      self.onPinch = onPinch
    }

    @objc func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
      // `location(in:)` is the centroid of the touches STILL DOWN, in the
      // recognizer's own view — which is already the page's client coordinate
      // space, because the webview is pinned to that view.
      //
      // A pinch ends when the second finger lifts, and real fingers never lift
      // on the same frame. So on the final event the centroid has already
      // collapsed onto whichever finger is still there — up to half the finger
      // separation from where the gesture actually was. Anchoring the canvas to
      // that scrolled it by that much at the instant of release, which is the
      // snap. A simulated pinch does not show it: `simctl` lifts both touches
      // together, so its last event still reports two.
      //
      // Below two touches there is no meaningful focal point for a pinch, so
      // hold the last real one rather than trusting the collapsed centroid.
      let focus: CGPoint
      if recognizer.numberOfTouches >= 2 {
        focus = recognizer.location(in: recognizer.view)
        twoFingerFocus = focus
      } else {
        focus = twoFingerFocus ?? recognizer.location(in: recognizer.view)
      }
      switch recognizer.state {
      case .ended, .cancelled, .failed:
        twoFingerFocus = nil
      default:
        break
      }
      onPinch(recognizer.scale, focus, recognizer.state)
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
  /// The bar is showing the zoom controls rather than the tools — see
  /// `keepZoomOpen`.
  @State private var zoomExpanded = false
  /// Counts zoom interactions so a stale hide cannot cut a newer one short.
  @State private var zoomInteraction = 0

  private enum Sheet: String, Identifiable {
    case settings, structure, design, chat, library, history, jobs, profile, pdfPreview
    var id: String { rawValue }
  }

  private var snapshot: ShellSnapshot { model.snapshot }

  var body: some View {
    NavigationStack {
      CanvasHost(taoController: taoController, webView: webView) { scale, focus, state in
        // `scale` is cumulative from the START of the pinch, so it multiplies
        // the zoom the gesture began at. Multiplying the LIVE zoom instead
        // compounds and runs away within a few frames.
        switch state {
        case .began:
          pinchBase = snapshot.zoom
          keepZoomOpen()
        case .changed:
          model.setZoom((pinchBase ?? snapshot.zoom) * Double(scale), live: true, focus: focus)
          keepZoomOpen()
        default:
          // One final non-live value closes the gesture on the web side, which
          // is what puts the zoom transition back for the buttons. It still
          // carries the focal point, so the last frame does not jump back to
          // the corner as the gesture lifts.
          model.setZoom((pinchBase ?? snapshot.zoom) * Double(scale), live: false, focus: focus)
          pinchBase = nil
          keepZoomOpen()
        }
      }
        // The canvas runs the full height of the window, not from the bottom of
        // the navigation bar to the top of the home indicator. Both bars are
        // transparent, so this is what actually puts the résumé behind them —
        // inset to the safe area it would be sitting between two strips of
        // empty window instead. Running under the bottom bar is deliberate and
        // was reverted once when "fixed". `.resume-scroller` reserves the top
        // bar's height as padding, so the page starts below the chrome and
        // scrolls up behind it.
        //
        // This also keeps the KEYBOARD out of the layout (the default region
        // set includes it), which is what stops SwiftUI and WKWebView both
        // avoiding it and collapsing the canvas to a ~90pt strip.
        .ignoresSafeArea(edges: [.top, .bottom])
        .navigationBarTitleDisplayMode(.inline)
        // No bar backgrounds: the résumé runs edge to edge and shows THROUGH the
        // chrome, which is the whole point of glass controls floating over it.
        // Each toolbar item carries its own backing, so nothing here depends on
        // the bar for legibility.
        .toolbarBackground(.hidden, for: .navigationBar, .bottomBar)
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
        }
        .sheet(item: $sheet) { which in
          switch which {
          case .settings: SettingsSheet(model: model)
          case .structure: StructureSheet(model: model)
          case .design: DesignSheet(model: model)
          case .chat: ChatSheet(model: model)
          case .library: LibrarySheet(model: model)
          case .history: HistorySheet(model: model)
          case .jobs: JobsSheet(model: model)
          case .profile: ProfileSheet(model: model)
          case .pdfPreview:
            if let request = model.pdfPreview {
              PdfPreviewSheet(model: model, request: request)
            }
          }
        }
        // The wizard, which is not in `sheet` at all. It has no open command —
        // the WEB component decides when it runs, because one component serves
        // both a first launch and the "New resume" menu item — so its presence
        // in the snapshot IS the instruction to present. A `fullScreenCover`
        // rather than a sheet: a first run has to be finished or explicitly
        // cancelled, and a card that can be swiped away leaves the app with no
        // résumé and no explanation of why.
        .fullScreenCover(isPresented: .constant(snapshot.onboarding?.open == true)) {
          if let wizard = snapshot.onboarding {
            OnboardingSheet(model: model, view: wizard)
          }
        }
        // The change review, opened by the PAGE the same way — every entry
        // point routes through one always-mounted web dialog, so its own
        // `open` is the signal. A sheet rather than a cover: unlike a first
        // run this is dismissible, and closing it decides nothing.
        .sheet(isPresented: .constant(snapshot.diff?.open == true)) {
          if let review = snapshot.diff {
            DiffReviewSheet(model: model, review: review)
          }
        }
        // The one sheet the PAGE opens: export generates for a second or two
        // first, and the result arrives as a message rather than a tap.
        .onChange(of: model.pdfPreview) { _, request in
          if request != nil { sheet = .pdfPreview }
        }
        .onChange(of: sheet) { previous, _ in
          // Stop streaming whatever the closing sheet was subscribed to: both
          // outlines are the largest things on the wire and the canvas
          // re-renders on every keystroke.
          switch previous {
          case .structure: model.send("setStructureOpen", ["value": "false"])
          case .design: model.send("setDesignOpen", ["value": "false"])
          case .chat: model.send("setChatOpen", ["value": "false"])
          case .library: model.send("setLibraryOpen", ["value": "false"])
          case .history: model.send("setHistoryOpen", ["value": "false"])
          case .jobs: model.send("setJobsOpen", ["value": "false"])
          case .profile: model.send("setProfileOpen", ["value": "false"])
          case .pdfPreview:
            // Swiped away rather than answered. The web side is still holding
            // the export guard and the temp PDF waiting to hear which it was,
            // so an unanswered dismissal has to count as Cancel or the next
            // export cannot start and the file is never cleaned up.
            if model.pdfPreview != nil {
              model.pdfPreview = nil
              model.send("pdfCancel")
            }
          default: break
          }
        }
    }
    // On the NavigationStack rather than the canvas: the canvas ignores the
    // safe area, so `.bottom` there is the screen edge, while here it is where
    // a bottom bar belongs — no inset to compute and nothing to keep in step
    // with it.
    //
    // Withdrawn while a web dialog is up. The bar floats ABOVE the webview, so
    // it covered the PDF preview's Save button — the dialog rendered fine and
    // simply could not be completed. Its commands would act on the canvas
    // behind the dialog anyway.
    .overlay(alignment: .bottom) {
      if !snapshot.modalOpen { bottomBar }
    }
    // A SECOND overlay rather than a stack with the bar inside the first one:
    // stacked, the bar would jump upwards by the notice's height the moment a
    // background reconciliation finished, and a control moving out from under a
    // reaching finger is exactly what "non-blocking" is supposed to rule out.
    // Held clear of the bar by a fixed inset instead, so nothing already on
    // screen moves at all.
    //
    // Withdrawn while a web dialog is up for the same reason the bar is — it
    // floats above the webview and would cover the dialog's own buttons. The
    // cost is a notice that expires unseen behind one, which is the right way
    // round: the dialog is what the person is doing, and the parked version is
    // in Version history either way.
    .overlay(alignment: .bottom) {
      ZStack(alignment: .bottom) {
        if let notice = model.conflictNotice, !snapshot.modalOpen {
          conflictNotice(notice)
            .padding(.bottom, Self.conflictNoticeInset)
            .transition(.opacity)
        }
      }
      .animation(.snappy(duration: 0.3), value: model.conflictNotice)
    }
    // Pull whatever another device changed while this one was away. Nothing
    // waits on it and no failure surfaces — sync is background reconciliation.
    //
    // The notification rather than `scenePhase`: this view is installed into a
    // UIHostingController by hand, under a window tao owns and a scene
    // delegate declared in project.yml, so how much of SwiftUI's scene
    // environment reaches it is an inference. `willEnterForeground` is
    // UIKit's own signal and does not depend on any of that.
    .onReceive(NotificationCenter.default.publisher(
      for: UIApplication.willEnterForegroundNotification
    )) { _ in
      Task { await model.resumeSync() }
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
      // Managing the résumé belongs to the control that NAMES it, not to the
      // catch-all menu on the other side of the bar — same split the chat
      // sheet already uses, where the title menu owns the current thread.
      // Headed, because everything above this line is about some OTHER résumé:
      // without it "Rename…" reads as applying to whichever row you last
      // looked at rather than to the one on screen.
      Section("This resume") {
        Button { model.send("renameVariant") } label: { Label("Rename…", systemImage: "pencil") }
        Button { model.send("duplicateVariant") } label: {
          Label("Duplicate", systemImage: "plus.square.on.square")
        }
        Button(role: .destructive) { model.send("deleteVariant") } label: {
          Label("Delete", systemImage: "trash")
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
    .accessibilityLabel("Switch or manage resume")
  }

  /// Everything that is NOT about which résumé is open — that lives on the
  /// title menu, which is the control that names it.
  private var actionsMenu: some View {
    Menu {
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
        Button {
          model.send("setProfileOpen", ["value": "true"])
          sheet = .profile
        } label: {
          Label("Profile", systemImage: "person.crop.circle")
        }
        Button {
          model.send("setJobsOpen", ["value": "true"])
          sheet = .jobs
        } label: {
          Label("Jobs", systemImage: "briefcase")
        }
        Button {
          model.send("setHistoryOpen", ["value": "true"])
          sheet = .history
        } label: {
          Label("Version history", systemImage: "clock.arrow.circlepath")
        }
      }
      Section {
        Button { sheet = .settings } label: { Label("Settings", systemImage: "gearshape") }
      }
    } label: {
      Image(systemName: "ellipsis.circle")
    }
    .accessibilityLabel("More actions")
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

  /// The bottom bar, ours rather than the system's.
  ///
  /// It was a `ToolbarItemGroup` until the zoom controls needed to take its
  /// place, and a system toolbar item cannot morph — swapping the bar for an
  /// overlay read as one thing vanishing and another appearing. Ours can: the
  /// zoom capsule is never unmounted, so animating its frame carries its glass
  /// with it, from the trailing readout to the centred control.
  ///
  /// Deliberately NOT a `GlassEffectContainer`. One around both capsules merges
  /// them into a single hazy shape spanning the bar; the morph here comes from
  /// the capsule staying put, not from matched effect ids.
  ///
  /// It keeps the system's own shape deliberately — 44pt glass capsules at the
  /// bottom safe area, the same metrics the toolbar used — because the point is
  /// that it still reads as the standard bottom bar.
  private var bottomBar: some View {
    barRow
      .padding(.horizontal, 12)
      .padding(.bottom, 4)
  }

  /// Clears the bottom bar: its 44pt capsules (`BarCapsule`), the 4pt that holds
  /// them off the home indicator, and 8pt of air between the two.
  private static let conflictNoticeInset: CGFloat = 56

  /// What sync says when it has resolved a conflict — see
  /// `ShellModel.conflictNotice` for the rule and the copy.
  ///
  /// A button, because the sentence ends at Version history and that sheet is
  /// one tap away from here: the notice is then a route rather than a statement
  /// about somewhere else in the app. It opens the history of the résumé ON
  /// SCREEN, which is the one that produces very nearly every conflict — the
  /// copy names no résumé precisely so that this is a shortcut and not a claim.
  ///
  /// Glass on a rounded rect rather than `BarCapsule`: it is the same floating
  /// chrome as the bar below it, but a capsule around three lines of text draws
  /// a lozenge with enormous empty ends.
  private func conflictNotice(_ text: String) -> some View {
    Button {
      model.send("setHistoryOpen", ["value": "true"])
      sheet = .history
      model.dismissConflictNotice()
    } label: {
      HStack(alignment: .top, spacing: 10) {
        // The icon the "Version history" menu item already carries, so the two
        // read as the same destination.
        Image(systemName: "clock.arrow.circlepath")
          .font(.footnote)
          .foregroundStyle(.secondary)
          // Optical alignment with the first line of text rather than its box.
          .padding(.top, 1)
        Text(text)
          .font(.footnote)
          .foregroundStyle(.primary)
          .multilineTextAlignment(.leading)
          // Without this the text truncates instead of wrapping inside an
          // overlay that is free to be as tall as it likes.
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 20))
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 12)
    .accessibilityHint("Opens Version history")
  }

  private var barRow: some View {
    HStack(spacing: 12) {
      if !zoomExpanded {
        HStack(spacing: 20) {
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

          Button {
            model.send("setDesignOpen", ["value": "true"])
            sheet = .design
          } label: {
            Image(systemName: "paintbrush")
          }
          .accessibilityLabel("Design")

          formatMenu
        }
        .modifier(BarCapsule())
        // Scale rather than slide: the zoom capsule is growing into the space
        // this leaves, and two things travelling in different directions reads
        // as a swap. Shrinking in place reads as making room.
        .transition(.scale(scale: 0.9).combined(with: .opacity))

        Spacer(minLength: 0)
      }

      zoomControl
    }
    .font(.system(size: 17))
    .buttonStyle(.plain)
    .foregroundStyle(.primary)
  }

  /// Three separate items (−, readout, +) is what ran the bar out of room once
  /// Design joined it: seven capsules on a 390pt screen, and the last was
  /// clipped off the edge. As one item it is one capsule, and even expanded it
  /// leaves the four tools their room.
  ///
  /// Zoom is also not a thing you use continuously, which is what Safari's zoom
  /// UI is built around: a percentage at rest, and the controls only while you
  /// are actually changing it. `keepZoomOpen` runs that clock.
  ///
  /// The branch lives INSIDE this view rather than in the toolbar builder. A
  /// `ToolbarItemGroup` whose item COUNT changes is not reliably re-diffed by
  /// SwiftUI — the first version of this flipped its state and never redrew —
  /// but ordinary view content inside one item diffs normally.
  private var zoomControl: some View {
    HStack(spacing: 20) {
      if zoomExpanded {
        Button {
          model.send("zoomOut")
          keepZoomOpen()
        } label: {
          Image(systemName: "minus")
        }
        .accessibilityLabel("Zoom out")
        .transition(.opacity)
      }

      zoomMenu

      if zoomExpanded {
        Button {
          model.send("zoomIn")
          keepZoomOpen()
        } label: {
          Image(systemName: "plus")
        }
        .accessibilityLabel("Zoom in")
      .transition(.opacity)
      }
    }
    // The SAME id in both states — that is the morph. The capsule grows from
    // the corner readout into the centred control instead of one being
    // replaced by the other.
    .modifier(BarCapsule())
    // Centred while open, trailing while not: with the tools gone the leading
    // spacer goes with them, so this one is what balances it.
    .frame(maxWidth: zoomExpanded ? .infinity : nil)
  }

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

  /// Open the zoom controls, and restart the clock on closing them again.
  ///
  /// Called by the readout, by every zoom button, and by a pinch. Each call
  /// restarts the delay, so a run of taps or a long pinch keeps the controls up
  /// throughout and they leave once, together, when the user stops.
  private func keepZoomOpen() {
    zoomInteraction += 1
    let generation = zoomInteraction
    withAnimation(.snappy(duration: 0.25)) { zoomExpanded = true }
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(2.5))
      guard generation == zoomInteraction else { return }
      withAnimation(.snappy(duration: 0.3)) { zoomExpanded = false }
    }
  }

  /// The centre of the control: always the live percentage.
  ///
  /// Collapsed it is the button that opens the controls. Expanded it carries
  /// the two commands that are not a step — Fit and Actual size — because by
  /// then there is a control to hang them off.
  @ViewBuilder
  private var zoomMenu: some View {
    if zoomExpanded {
      Menu {
        Button { model.send("zoomFit"); keepZoomOpen() } label: {
          Label("Fit to view", systemImage: "arrow.up.left.and.arrow.down.right")
        }
        Button { model.send("zoomReset"); keepZoomOpen() } label: {
          Label("Actual size", systemImage: "1.magnifyingglass")
        }
      } label: {
        zoomReadout
      }
      .accessibilityLabel("Zoom, \(snapshot.zoomPercent) percent")
    } else {
      // Collapsed, the readout OPENS the controls. It was a Menu in both
      // states for a moment, and tapping the percentage offered Fit and Actual
      // size instead of the −/+ the tap is asking for.
      Button { keepZoomOpen() } label: { zoomReadout }
        .accessibilityLabel("Zoom, \(snapshot.zoomPercent) percent. Opens the zoom controls.")
    }
  }

  private var zoomReadout: some View {
    Text("\(snapshot.zoomPercent)%")
      .font(.subheadline)
      .monospacedDigit()
      // Fixed, or the capsule resizes on 99% → 100%.
      .frame(minWidth: 46)
      // Text is only hit-testable where its glyphs are; without this the pill
      // has a live centre and dead corners.
      .contentShape(.rect)
  }
}

// MARK: - PDF export

/// The generated PDF, before it is saved.
///
/// Replaces the web export dialog on iOS. That one rasterises the PDF with
/// pdf.js into stacked `<canvas>` sheets because a page has nothing better —
/// WKWebView will not render a PDF in a frame and the app's CSP forbids one
/// anyway. On iOS the system's own PDF view is right there: it renders text
/// sharply at any scale, scrolls and zooms for free, and needs no megabyte of
/// base64 through the bridge to do it.
///
/// The two outcomes route to the SAME callbacks pdf.js hands its own dialog, and
/// exactly one of them must run: the export guard is held from generation until
/// one does, and the temp file is only cleaned up by them. Hence the cancel on
/// an unanswered dismissal in ShellView.
private struct PdfPreviewSheet: View {
  @ObservedObject var model: ShellModel
  let request: PdfPreviewRequest
  @Environment(\.dismiss) private var dismiss

  @State private var filename = ""

  var body: some View {
    NavigationStack {
      PDFDocumentView(url: request.url)
        .safeAreaInset(edge: .bottom) { filenameField }
        .navigationTitle("Export PDF")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel", role: .cancel) { settle(save: false) }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") { settle(save: true) }
              .fontWeight(.semibold)
              .disabled(trimmed.isEmpty)
          }
        }
    }
    .onAppear { filename = request.filename }
  }

  private var trimmed: String { filename.trimmingCharacters(in: .whitespacesAndNewlines) }

  private var filenameField: some View {
    HStack(spacing: 6) {
      TextField("Resume", text: $filename)
        .textFieldStyle(.plain)
        .textInputAutocapitalization(.words)
        .autocorrectionDisabled()
        .submitLabel(.done)
        .onSubmit { if !trimmed.isEmpty { settle(save: true) } }
      Text(".pdf").foregroundStyle(.secondary)
    }
    .padding(.horizontal, 16)
    .frame(height: 48)
    .modifier(ComposerSurface())
    .padding(.horizontal, 12)
  }

  /// Answer the web side once, and only once.
  private func settle(save: Bool) {
    guard model.pdfPreview != nil else { return }
    model.pdfPreview = nil
    // Saving is a SHARE on iOS: `save_file`'s document picker never appears once
    // tao's view controller is nested, and the share sheet's own "Save to
    // Files" is the same destination the desktop picker writes to.
    model.send(save ? "pdfSave" : "pdfCancel", save ? ["filename": trimmed] : [:])
    dismiss()
  }
}

/// PDFKit, as a SwiftUI view.
private struct PDFDocumentView: UIViewRepresentable {
  let url: URL

  func makeUIView(context: Context) -> PDFView {
    let view = PDFView()
    // autoScales fits the page to the width and still allows pinching past it,
    // which is what makes a phone-sized preview of a letter page readable.
    view.autoScales = true
    view.displayDirection = .vertical
    view.displayMode = .singlePageContinuous
    view.backgroundColor = .secondarySystemBackground
    view.document = PDFDocument(url: url)
    return view
  }

  func updateUIView(_ view: PDFView, context: Context) {
    guard view.document?.documentURL != url else { return }
    view.document = PDFDocument(url: url)
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

        Section {
          Toggle("iCloud sync", isOn: syncBinding)
          // No row at all when there is nothing to say — see `syncStatus`.
          if !model.syncStatus.isEmpty {
            Text(model.syncStatus)
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        } header: {
          Text("Sync")
        } footer: {
          // The question the switch raises is "where do my resumes go", and it
          // is answered where the switch is rather than in a policy nobody
          // opens. Both halves matter: whose account they land in, and that On
          // Paper is not a party to any of it.
          Text(
            "Your resumes are copied to your own iCloud account, so the devices you "
            + "use stay in step. Nothing is sent to On Paper."
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

  /// Same read-from-the-snapshot rule, and here it is what makes the switch
  /// honest: the write persists the preference in JS, the next snapshot brings
  /// it back, and only THEN does the transport start or stop (see
  /// `ShellModel.syncPreference`). A toggle that moved on its own would be
  /// showing a state nothing had acted on.
  private var syncBinding: Binding<Bool> {
    Binding(
      get: { settings.syncEnabled },
      set: { model.send("setSyncEnabled", ["value": $0 ? "true" : "false"]) }
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
  /// A whole role or section awaiting confirmation. Asked NATIVELY and before
  /// the command is sent — the web's `confirmDestructive()` renders a Radix
  /// dialog inside the webview, behind this sheet, where nobody would see it
  /// and its promise would never settle.
  @State private var pendingRemoval: Removal?

  private struct Removal: Identifiable {
    let path: String
    let index: Int
    let title: String
    var id: String { "\(path)[\(index)]" }
  }

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
                    .onDelete { offsets in
                      // Same property as the move: list-relative, so the offset
                      // arithmetic that maps a ROW to an array element never
                      // happens here.
                      guard let at = offsets.first else { return }
                      model.send("removeItem", [
                        "path": listPath, "index": String(at),
                      ])
                    }
                }
                if !group.addLabel.isEmpty, let listPath = group.listPath {
                  Button {
                    model.send("addItem", ["path": listPath])
                  } label: {
                    Label(group.addLabel, systemImage: "plus.circle.fill")
                  }
                  // Otherwise edit mode offers to reorder and delete the Add
                  // button along with the rows it adds.
                  .deleteDisabled(true)
                  .moveDisabled(true)
                }
                if let removePath = group.removePath {
                  Button(role: .destructive) {
                    pendingRemoval = Removal(
                      path: removePath, index: group.removeIndex, title: group.removeTitle
                    )
                  } label: {
                    // `.destructive` reddens the TITLE and leaves the symbol on
                    // the accent colour, so a red label sits beside a blue
                    // trash can. Tint the whole label instead.
                    Label("Delete \(group.removeTitle)", systemImage: "trash")
                      .foregroundStyle(.red)
                  }
                  .deleteDisabled(true)
                  .moveDisabled(true)
                }
              }
            }

            if let additions = model.snapshot.document?.additions, !additions.isEmpty {
              Section {
                ForEach(additions) { addition in
                  Button {
                    model.send("addItem", ["path": addition.path])
                  } label: {
                    Label(addition.label, systemImage: "plus")
                  }
                  .deleteDisabled(true)
                  .moveDisabled(true)
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
    // An alert rather than a `confirmationDialog`: iOS 26 renders the compact
    // dialog with NO visible Cancel and relies on a tap outside, which is a
    // poor bargain when the other button deletes a section of the résumé.
    .alert(
      "Delete \(pendingRemoval?.title ?? "")?",
      isPresented: .init(
        get: { pendingRemoval != nil },
        set: { if !$0 { pendingRemoval = nil } }
      )
    ) {
      Button("Delete", role: .destructive) {
        if let removal = pendingRemoval {
          model.send("removeItem", [
            "path": removal.path, "index": String(removal.index),
          ])
        }
        pendingRemoval = nil
      }
      Button("Cancel", role: .cancel) { pendingRemoval = nil }
    } message: {
      Text("This cannot be undone from here.")
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
/// While the model is thinking it shows the CURRENT section title (the last
/// `**Title**` in the completed lines) and shimmers; once the answer starts it
/// settles to "Thought process". The timeline lives in the sheet behind it.
///
/// The chevron is the affordance, so it appears ONLY once there is something to
/// open — before the first summary line arrives this is an inert "Thinking…"
/// label, not a button that opens an empty sheet.
struct InlineReasoningIndicator: View {
  let reasoning: String
  /// True while the model is still thinking: reasoning may still be arriving and
  /// the answer has not started. Goes false the moment the first content token
  /// lands, which is what stops the shimmer and settles the label.
  let isStreaming: Bool
  @State private var showSheet = false

  private var hasReasoning: Bool {
    !reasoning.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

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
    Button { if hasReasoning { showSheet = true } } label: {
      HStack(spacing: 6) {
        Text(displayText).font(.subheadline).lineLimit(1)
        if hasReasoning {
          Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
        }
      }
      .foregroundStyle(.secondary)
      .shimmering(active: isStreaming)
    }
    .buttonStyle(.plain)
    .disabled(!hasReasoning)
    .sheet(isPresented: $showSheet) {
      ReasoningSheet(content: reasoning, isStreaming: isStreaming)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
    .accessibilityLabel(displayText)
    .accessibilityHint(hasReasoning ? "Opens the model's thought process" : "")
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

// MARK: - Markdown

/// Block-level markdown for a chat reply, ported from Olia
/// (`Screens/Chat/MarkdownText.swift`).
///
/// The models write in markdown — headings, bullets, numbered steps, the
/// occasional fenced block — and rendering that as one flat `Text` puts literal
/// `##` and `- ` in front of the user. SwiftUI's `Text` handles INLINE markdown
/// on its own (via `LocalizedStringKey`: bold, italic, code, links) but has no
/// notion of blocks, so this splits the text into blocks and lets `Text` finish
/// each one.
///
/// A hand-rolled parser rather than `AttributedString(markdown:)`: that one
/// throws on the half-formed markdown a stream produces mid-token, and it has no
/// block layout either.
struct MarkdownText: View {
  let text: String
  var spacing: CGFloat = 8
  /// Fade-and-rise each block in as it arrives, the way the reasoning timeline
  /// does its rows. Off for settled history, where every block would animate at
  /// once when the transcript scrolled into view.
  var isStreaming: Bool = false

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(_ text: String, spacing: CGFloat = 8, isStreaming: Bool = false) {
    self.text = text
    self.spacing = spacing
    self.isStreaming = isStreaming
  }

  var body: some View {
    let blocks = Self.parse(text)
    VStack(alignment: .leading, spacing: spacing) {
      ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
        blockView(block)
          .transition(arrival)
          .animation(arrivalAnimation(at: index), value: block.contentHash)
      }
    }
    .animation(isStreaming ? .easeOut(duration: 0.25) : .easeOut(duration: 0.3), value: blocks.count)
  }

  private var arrival: AnyTransition {
    guard isStreaming, !reduceMotion else { return .opacity }
    return .asymmetric(insertion: .opacity.combined(with: .offset(y: 4)), removal: .opacity)
  }

  /// Stagger the first few blocks so a burst that lands in one update still
  /// reads as arriving rather than appearing. Capped, or a long reply would
  /// queue an ever-growing delay.
  private func arrivalAnimation(at index: Int) -> Animation {
    guard isStreaming else { return .easeOut(duration: 0.3) }
    guard !reduceMotion else { return .easeOut(duration: 0.1) }
    return .easeOut(duration: 0.25).delay(min(Double(index) * 0.05, 0.15))
  }

  @ViewBuilder
  private func blockView(_ block: Block) -> some View {
    switch block.kind {
    case let .heading(level, content):
      Text(LocalizedStringKey(content))
        .font(level == 1 ? .title3 : level == 2 ? .headline : .subheadline)
        .fontWeight(.semibold)
        .padding(.top, 2)
    case let .paragraph(content):
      Text(LocalizedStringKey(content))
        .fixedSize(horizontal: false, vertical: true)
    case let .list(items):
      VStack(alignment: .leading, spacing: 6) {
        ForEach(items) { item in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(item.marker).fontWeight(.semibold).monospacedDigit()
            Text(LocalizedStringKey(item.content))
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(.leading, CGFloat(item.indent) * 16)
        }
      }
    case let .code(content):
      // Horizontally scrollable: a wrapped code line is unreadable, and a
      // clipped one silently hides the end of a command.
      ScrollView(.horizontal, showsIndicators: false) {
        Text(content)
          .font(.system(.footnote, design: .monospaced))
          .padding(10)
      }
      .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 8))
    case let .quote(content):
      HStack(spacing: 10) {
        Rectangle().fill(Color.secondary.opacity(0.4)).frame(width: 3)
        Text(LocalizedStringKey(content))
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    case .rule:
      Divider()
    }
  }

  // MARK: parsing

  struct Block: Identifiable {
    let id: Int
    let kind: Kind

    /// Changes when this block's text does, which is what the arrival animation
    /// keys on — a block that grew re-animates, its neighbours do not.
    var contentHash: Int {
      switch kind {
      case let .heading(_, content): return content.hashValue
      case let .paragraph(content): return content.hashValue
      case let .list(items): return items.map(\.content).joined().hashValue
      case let .code(content): return content.hashValue
      case let .quote(content): return content.hashValue
      case .rule: return 0
      }
    }

    enum Kind {
      case heading(level: Int, content: String)
      case paragraph(String)
      case list([Item])
      case code(String)
      case quote(String)
      case rule
    }

    struct Item: Identifiable {
      let id: Int
      let content: String
      let indent: Int
      let marker: String
    }
  }

  /// Split markdown into blocks. Consecutive list lines coalesce into one list
  /// so the rows share a container and line up; everything else is one block per
  /// line, which is also what makes a streaming reply grow a block at a time
  /// instead of re-laying out the whole reply on every token.
  static func parse(_ text: String) -> [Block] {
    var blocks: [Block] = []
    var items: [Block.Item] = []
    var codeLines: [String] = []
    var inCode = false
    var nextID = 0

    func add(_ kind: Block.Kind) {
      blocks.append(Block(id: nextID, kind: kind))
      nextID += 1
    }
    func flushList() {
      guard !items.isEmpty else { return }
      add(.list(items))
      items = []
    }

    for line in text.components(separatedBy: .newlines) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)

      if trimmed.hasPrefix("```") {
        if inCode {
          add(.code(codeLines.joined(separator: "\n")))
          codeLines = []
        } else {
          flushList()
        }
        inCode.toggle()
        continue
      }
      if inCode {
        codeLines.append(line)
        continue
      }

      if trimmed.count >= 3, Set(trimmed).isSubset(of: ["-", "*", "_"]), Set(trimmed).count == 1 {
        flushList()
        add(.rule)
        continue
      }
      if trimmed.hasPrefix("#") {
        flushList()
        let level = trimmed.prefix(while: { $0 == "#" }).count
        let content = String(trimmed.dropFirst(level)).trimmingCharacters(in: .whitespaces)
        add(.heading(level: min(level, 3), content: content))
        continue
      }
      if trimmed.hasPrefix(">") {
        flushList()
        add(.quote(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)))
        continue
      }
      if let item = listItem(line, id: items.count) {
        items.append(item)
        continue
      }
      if !trimmed.isEmpty {
        flushList()
        add(.paragraph(trimmed))
      }
    }

    // An unterminated fence is the normal state mid-stream, not an error: show
    // what has arrived rather than dropping it until the closing ``` lands.
    if inCode, !codeLines.isEmpty { add(.code(codeLines.joined(separator: "\n"))) }
    flushList()
    return blocks
  }

  private static func listItem(_ line: String, id: Int) -> Block.Item? {
    var spaces = 0
    for char in line {
      if char == " " { spaces += 1 } else if char == "\t" { spaces += 4 } else { break }
    }
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let indent = spaces / 2

    for bullet in ["- ", "* ", "+ "] where trimmed.hasPrefix(bullet) {
      let content = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
      return Block.Item(id: id, content: content, indent: indent, marker: "•")
    }
    if let space = trimmed.firstIndex(of: " ") {
      let prefix = trimmed[..<space]
      if prefix.hasSuffix(".") || prefix.hasSuffix(")"), Int(prefix.dropLast()) != nil {
        let content = String(trimmed[space...]).trimmingCharacters(in: .whitespaces)
        return Block.Item(id: id, content: content, indent: indent, marker: String(prefix))
      }
    }
    return nil
  }
}

// MARK: - Composer

/// Reasoning effort, mirroring `REASONING_OPTIONS` in
/// `src/components/chat/ChatComposer.jsx` — the same four levels and the same
/// descriptions, so the phone and the desktop offer the same setting.
private let reasoningLevels: [(value: String, label: String, detail: String)] = [
  ("none", "Off", "Fastest responses"),
  ("low", "Low", "Quick thinking"),
  ("medium", "Medium", "Balanced"),
  ("high", "High", "Deep analysis"),
]

/// The message composer: one rounded card holding the field, the model and
/// reasoning-effort controls, and Send — the arrangement ChatGPT and Claude both
/// use on iOS.
///
/// The controls live HERE rather than in the navigation bar because the model in
/// use is part of asking the question, not a property of the conversation: on a
/// fresh chat the bar showed a title and nothing about the model, so there was
/// no way to see what you were about to talk to. The bar's centre is the chat's
/// own title and management menu instead.
///
/// It is one glass surface, not a bar: the transcript scrolls UNDER it (the
/// sheet mounts this as a `safeAreaInset`), which is the whole point of putting
/// glass there.
private struct ChatComposer: View {
  @Binding var text: String
  let isSending: Bool
  let models: [ShellSnapshot.ChatView.ModelOption]
  let currentModel: String
  let reasoningEffort: String
  let reasoningSupported: Bool
  /// Bumped on send. See `fieldGeneration` below — this is what makes a
  /// multi-line field collapse back to one line.
  let generation: Int
  let onSend: () -> Void
  let onStop: () -> Void
  let onSelectModel: (String) -> Void
  let onSetReasoning: (String) -> Void

  @FocusState private var isFocused: Bool

  private let characterLimit = 4000

  private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var canSend: Bool { !trimmed.isEmpty && !isSending && text.count <= characterLimit }
  private var isNearLimit: Bool { text.count > characterLimit * 80 / 100 }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      TextField("Ask about this resume", text: $text, axis: .vertical)
        .textFieldStyle(.plain)
        .focused($isFocused)
        .disabled(isSending)
        .lineLimit(1...6)
        .padding(.horizontal, 6)
        .padding(.top, 6)
        // A vertical-axis TextField is a UITextView underneath, and clearing its
        // binding does not invalidate the intrinsic height it grew to — so after
        // sending a multi-line message the composer stayed tall until something
        // unrelated forced a layout pass. Changing the identity rebuilds it, at
        // the only moment where losing the field's internal state is what we
        // want anyway.
        .id(generation)

      HStack(spacing: 8) {
        modelButton
        if reasoningSupported { effortButton }
        Spacer(minLength: 0)
        if isNearLimit {
          Text("\(text.count)/\(characterLimit)")
            .font(.caption)
            .foregroundStyle(text.count > characterLimit ? Color.red : Color.secondary)
        }
        trailingButton
      }
    }
    .padding(.horizontal, ChatComposer.innerPadding)
    .padding(.vertical, ChatComposer.innerPadding)
    .modifier(ComposerSurface())
    .padding(.horizontal, 12)
    // No bottom padding: `safeAreaInset` already holds the bar clear of the home
    // indicator, and anything on top of that reads as the bar floating.
    .padding(.bottom, 0)
  }

  /// Concentricity, the reason these three numbers are named rather than
  /// sprinkled: a nested shape reads as belonging to its container only when
  /// their curves share a centre, which means the inner radius has to be the
  /// outer radius minus the padding between them. 26 − 8 = 18, and a capsule
  /// 36pt tall has exactly an 18pt radius. Change one, change all three.
  static let surfaceRadius: CGFloat = 26
  static let innerPadding: CGFloat = 8
  static let controlHeight: CGFloat = 36

  /// Grouped the way the web picker groups them (by provider), preserving the
  /// order the catalogue arrived in rather than sorting — the featured models
  /// lead it deliberately.
  private var groupedModels: [(group: String, options: [ShellSnapshot.ChatView.ModelOption])] {
    var order: [String] = []
    var byGroup: [String: [ShellSnapshot.ChatView.ModelOption]] = [:]
    for option in models {
      let key = option.group.isEmpty ? "Models" : option.group
      if byGroup[key] == nil { order.append(key) }
      byGroup[key, default: []].append(option)
    }
    return order.map { ($0, byGroup[$0] ?? []) }
  }

  private var currentModelLabel: String {
    models.first { $0.id == currentModel }?.label ?? "Model"
  }

  private var modelButton: some View {
    Menu {
      ForEach(groupedModels, id: \.group) { group in
        Section(group.group) {
          ForEach(group.options) { option in
            Button { onSelectModel(option.id) } label: {
              if option.id == currentModel {
                Label(option.label, systemImage: "checkmark")
              } else {
                Text(option.label)
              }
            }
          }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Text(currentModelLabel).lineLimit(1)
        Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
      }
      .modifier(ComposerChip())
    }
    .buttonStyle(.plain)
    .menuOrder(.fixed)
    .accessibilityLabel("Model: \(currentModelLabel)")
  }

  private var effortLabel: String {
    reasoningLevels.first { $0.value == reasoningEffort }?.label ?? "Medium"
  }

  private var effortButton: some View {
    Menu {
      Section("Reasoning effort") {
        ForEach(reasoningLevels, id: \.value) { level in
          Button { onSetReasoning(level.value) } label: {
            if level.value == reasoningEffort {
              Label("\(level.label) — \(level.detail)", systemImage: "checkmark")
            } else {
              Text("\(level.label) — \(level.detail)")
            }
          }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Image(systemName: "brain")
        Text(effortLabel)
      }
      .modifier(ComposerChip())
    }
    .buttonStyle(.plain)
    .menuOrder(.fixed)
    .accessibilityLabel("Reasoning effort: \(effortLabel)")
  }

  @ViewBuilder
  private var trailingButton: some View {
    if isSending {
      Button(action: onStop) {
        Image(systemName: "stop.fill")
          .font(.system(size: 14, weight: .semibold))
          .modifier(ComposerSendStyle(enabled: true))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Stop")
    } else {
      Button {
        guard canSend else { return }
        onSend()
        isFocused = false
      } label: {
        Image(systemName: "arrow.up")
          .font(.system(size: 16, weight: .semibold))
          .modifier(ComposerSendStyle(enabled: canSend))
      }
      .buttonStyle(.plain)
      .disabled(!canSend)
      .accessibilityLabel("Send")
    }
  }
}

/// The composer's own surface: liquid glass where it exists, a material before
/// it. Interactive glass on 26 so it responds to touch the way the system's own
/// input bars do.
private struct ComposerSurface: ViewModifier {
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: ChatComposer.surfaceRadius, style: .continuous)
    content.glassEffect(.regular.interactive(), in: shape)
  }
}

/// One capsule of the bottom bar.
///
/// 44pt and `.regular.interactive()`, matching what the system bottom bar drew
/// before this replaced it — the bar moved into our hands so the zoom control
/// could morph, not so it could look different.
private struct BarCapsule: ViewModifier {
  func body(content: Content) -> some View {
    let sized = content
      .padding(.horizontal, 20)
      .frame(height: 44)

    sized.glassEffect(.regular.interactive(), in: .capsule)
  }
}

/// The model and effort chips.
///
/// The capsule is part of the LABEL rather than a button style's background,
/// which is what fixes the sizing: as a `.bordered` Menu the pill was sized on
/// one pass and the text on another, so a label that changed — "Model" becoming
/// "Claude Sonnet 4.6" when the catalogue arrives — briefly overflowed its own
/// pill. Drawn behind the label, the shape cannot be out of date.
private struct ComposerChip: ViewModifier {
  func body(content: Content) -> some View {
    let base = content
      .font(.subheadline)
      .foregroundStyle(.primary)
      .lineLimit(1)
      .padding(.horizontal, 12)
      .frame(height: ChatComposer.controlHeight)

    base.glassEffect(.regular.interactive(), in: .capsule)
  }
}

/// Send/Stop: the same 36pt as the chips beside it, drawn rather than left to
/// `.glassProminent`.
///
/// The button style would add its own padding around whatever frame it was
/// given, which made this the tallest thing in the row — and since the row
/// centres its contents, that pushed the chips up off the card's bottom edge and
/// broke the concentricity they were sized for. One height for every control in
/// the row is what keeps that arithmetic true.
private struct ComposerSendStyle: ViewModifier {
  let enabled: Bool

  func body(content: Content) -> some View {
    let sized = content
      .foregroundStyle(enabled ? Color.white : Color.secondary)
      .frame(width: ChatComposer.controlHeight, height: ChatComposer.controlHeight)

    if enabled {
      sized.glassEffect(.regular.tint(.accentColor).interactive(), in: .circle)
    } else {
      // Plain, not glass: a disabled Send should not look tappable. The
      // accent-coloured arm of this branch went with the iOS-26 guard — inside
      // the `else`, `enabled` is false by construction.
      sized.background(.quaternary, in: .circle)
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
  @State private var showRename = false
  @State private var showDeleteConfirm = false
  @State private var renameDraft = ""
  /// Bumped on every send; the composer's field is keyed on it. See the comment
  /// on the `.id` there.
  @State private var fieldGeneration = 0

  private var chat: ShellSnapshot.ChatView? { model.snapshot.chat }

  var body: some View {
    NavigationStack {
      Group {
        if let chat, !chat.configured {
          ContentUnavailableView(
            "No API key",
            systemImage: "key",
            description: Text("Add an OpenRouter key in Settings to use the assistant.")
          )
        } else {
          transcript
            // An INSET, not a row in a VStack: the transcript keeps the full
            // height of the sheet and scrolls under the composer, so text passes
            // behind the glass instead of stopping at an opaque band above it.
            .safeAreaInset(edge: .bottom) {
              ChatComposer(
                text: $draft,
                isSending: chat?.loading ?? false,
                models: chat?.models ?? [],
                currentModel: chat?.currentModel ?? "",
                reasoningEffort: chat?.reasoningEffort ?? "medium",
                reasoningSupported: chat?.reasoningSupported ?? false,
                generation: fieldGeneration,
                onSend: sendDraft,
                onStop: { model.send("chatStop") },
                onSelectModel: { model.send("chatSetModel", ["id": $0]) },
                onSetReasoning: { model.send("chatSetReasoning", ["value": $0]) }
              )
            }
        }
      }
      .navigationBarTitleDisplayMode(.inline)
      // One tap on the transition from thinking to answering — the moment the
      // user has been waiting through. Mounted on the sheet, not on a message:
      // per-message it would fire once per row in the transcript. `nil` on the
      // way back suppresses a second tap when the finished stream row is
      // replaced by the committed message.
      .sensoryFeedback(trigger: responseStarted) { _, started in
        started ? .impact(weight: .light) : nil
      }
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { threadsMenu }
        ToolbarItem(placement: .principal) { titleMenu }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .sheet(isPresented: $showReview) {
        ChangeReviewSheet(model: model)
      }
      .alert("Rename chat", isPresented: $showRename) {
        TextField("Name", text: $renameDraft)
        Button("Cancel", role: .cancel) {}
        Button("Rename") {
          let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !title.isEmpty, let id = currentThread?.id else { return }
          model.send("chatRenameThread", ["id": id, "title": title])
        }
      }
      .confirmationDialog(
        "Delete this chat?", isPresented: $showDeleteConfirm, titleVisibility: .visible
      ) {
        Button("Delete", role: .destructive) {
          guard let id = currentThread?.id else { return }
          model.send("chatDeleteThread", ["id": id])
        }
      } message: {
        Text("The messages in it are removed. Your resume is not affected.")
      }
    }
  }

  // MARK: transcript

  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 20) {
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
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      // Keyed on the message COUNT, not the last message's text. Keying it on
      // the text scrolled on every token, which took the scroll away from anyone
      // who had scrolled up to re-read something while the answer streamed. A
      // new turn is worth following; a growing one is the user's to follow.
      .onChange(of: chat?.messages.count ?? 0) { _, _ in
        scrollToEnd(proxy, animated: true)
      }
      .onAppear { scrollToEnd(proxy, animated: false) }
    }
  }

  private func scrollToEnd(_ proxy: ScrollViewProxy, animated: Bool) {
    guard let last = chat?.messages.last else { return }
    if animated {
      withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
    } else {
      proxy.scrollTo(last.id, anchor: .bottom)
    }
  }

  /// True once the reply itself has started arriving.
  ///
  /// This is the line between thinking and answering, and it drives three things
  /// at once: the shimmer stops, the reasoning summary settles to "Thought
  /// process", and the phone taps once. Models interleave — reasoning tokens can
  /// keep arriving after the answer starts — so treating the first content token
  /// as the end of thinking is a deliberate simplification; showing both live at
  /// once reads as two answers being written at the same time.
  private var responseStarted: Bool {
    guard chat?.messages.contains(where: { $0.id == "streaming" }) == true else { return false }
    // The PACED text, not the snapshot's: this drives the shimmer, the label and
    // the haptic, and all three should land when the answer becomes visible
    // rather than when its first token quietly arrives behind the pacing.
    return !model.reply.visible.isEmpty
  }

  @ViewBuilder
  private func messageView(_ message: ShellSnapshot.ChatView.Message) -> some View {
    let isUser = message.role == "user"
    let isLive = message.id == "streaming"
    let stillThinking = isLive && !responseStarted

    VStack(alignment: isUser ? .trailing : .leading, spacing: 8) {
      if !isUser, !message.reasoning.isEmpty || stillThinking {
        // Olia's shape: a one-line, tappable summary — NOT the timeline inline.
        // The timeline lives in a sheet behind it.
        InlineReasoningIndicator(reasoning: message.reasoning, isStreaming: stillThinking)
      }
      if !message.text.isEmpty {
        messageBody(message, isUser: isUser)
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
    // The user's turn is a bubble and keeps a gutter on its leading edge; the
    // reply is not. A shape around the reply boxed in the one thing that should
    // read as the page's own text, and cost it the full width it needs for
    // lists and headings.
    .padding(.leading, isUser ? 48 : 0)
    .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
  }

  @ViewBuilder
  private func messageBody(_ message: ShellSnapshot.ChatView.Message, isUser: Bool) -> some View {
    if message.id == "streaming" {
      // The paced text, not the snapshot's: `ReplyStream` walks toward what has
      // arrived so the reply types itself in instead of landing a paragraph at a
      // time, and MarkdownText fades each block in as it completes.
      MarkdownText(model.reply.visible, isStreaming: !model.reply.caughtUp)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    } else if isUser {
      Text(message.text)
        .textSelection(.enabled)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.accentColor, in: .rect(cornerRadius: 20))
        .foregroundStyle(.white)
    } else if message.role == "error" {
      Label(message.text, systemImage: "exclamationmark.triangle")
        .font(.subheadline)
        .textSelection(.enabled)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.12), in: .rect(cornerRadius: 14))
    } else {
      MarkdownText(message.text)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  // MARK: chat management

  private var currentThread: ShellSnapshot.ChatView.Thread? {
    chat?.threads.first { $0.isCurrent }
  }

  private var currentTitle: String { currentThread?.title ?? "New chat" }

  /// The left button: which chat you are in, and starting another. Navigation
  /// between chats, kept apart from the title menu — that one acts on the chat
  /// you are already looking at.
  private var threadsMenu: some View {
    Menu {
      Section {
        Button { model.send("chatNewThread") } label: {
          Label("New chat", systemImage: "square.and.pencil")
        }
      }
      Section("Chats") {
        ForEach(chat?.threads ?? []) { thread in
          Button { model.send("chatSelectThread", ["id": thread.id]) } label: {
            if thread.isCurrent {
              Label(thread.title, systemImage: "checkmark")
            } else {
              Text(thread.title)
            }
          }
        }
      }
    } label: {
      Image(systemName: "bubble.left.and.bubble.right")
    }
    .menuOrder(.fixed)
    .accessibilityLabel("Chats")
  }

  /// The bar's centre: this chat's name and what you can do to it. The model
  /// picker used to live here, which put a per-message choice in the place a
  /// document's title belongs.
  private var titleMenu: some View {
    Menu {
      Button {
        renameDraft = currentTitle
        showRename = true
      } label: {
        Label("Rename", systemImage: "pencil")
      }
      Button(role: .destructive) { showDeleteConfirm = true } label: {
        Label("Delete chat", systemImage: "trash")
      }
    } label: {
      HStack(spacing: 4) {
        Text(currentTitle).font(.subheadline.weight(.semibold)).lineLimit(1)
        Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
      }
      .frame(maxWidth: 200)
    }
    .menuOrder(.fixed)
    .accessibilityLabel("Chat: \(currentTitle)")
  }

  private func sendDraft() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    model.send("chatSend", ["text": text])
    draft = ""
    fieldGeneration += 1
  }
}

// MARK: - Version history

/// Every saved version of this résumé, newest first.
///
/// The only surface that shows the undo stack as a list rather than one step at
/// a time — the Actions menu's Undo and Redo walk the same stack, so a restore
/// here changes what those two do next.
private struct HistorySheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  /// The version a confirmation is pending on. Held whole rather than by index:
  /// indices renumber, and this is what gets sent back for the check.
  @State private var pendingRestore: ShellSnapshot.History.Entry?
  @State private var staleWarning = false

  private var history: ShellSnapshot.History? { model.snapshot.history }

  var body: some View {
    NavigationStack {
      Group {
        if let diff = history?.diff {
          comparison(diff)
        } else if let entries = history?.entries, !entries.isEmpty {
          list(entries)
        } else if history == nil {
          ProgressView()
        } else {
          ContentUnavailableView(
            "No versions yet",
            systemImage: "clock.arrow.circlepath",
            description: Text("Edits to this resume are saved here as you make them.")
          )
        }
      }
      .navigationTitle(history?.diff == nil ? "Version history" : "Changes since")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if history?.diff != nil {
          ToolbarItem(placement: .cancellationAction) {
            Button("Back") { model.send("closeCompare") }
          }
        }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .confirmationDialog(
        "Restore this version?",
        isPresented: .init(
          get: { pendingRestore != nil },
          set: { if !$0 { pendingRestore = nil } }
        ),
        titleVisibility: .visible
      ) {
        Button("Restore", role: .destructive) {
          guard let entry = pendingRestore else { return }
          pendingRestore = nil
          model.send(
            "restoreVersion", ["index": "\(entry.index)", "timestamp": entry.timestamp]
          ) { ok in staleWarning = !ok }
        }
      } message: {
        // Precise about what survives, because the web dialog's wording is not:
        // restoreToEntry truncates nothing, so the newer versions stay in the
        // stack as redo-able ones rather than being "saved in history".
        Text("The whole resume goes back to this version. The newer versions stay in this list, so you can come forward again.")
      }
      .alert("That version moved", isPresented: $staleWarning) {
        Button("OK", role: .cancel) {}
      } message: {
        Text("The history changed while this was open. Pick it again from the refreshed list.")
      }
    }
  }

  private func list(_ entries: [ShellSnapshot.History.Entry]) -> some View {
    List {
      ForEach(entries) { entry in
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Image(systemName: symbol(for: entry.changeType))
              .font(.caption)
              .foregroundStyle(entry.isCurrent ? Color.accentColor : .secondary)
              .frame(width: 18)
            Text(entry.label).font(.subheadline.weight(.medium))
            Text(relative(entry.timestamp)).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if entry.isCurrent {
              Text("Current")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.accentColor.opacity(0.15), in: .capsule)
                .foregroundStyle(Color.accentColor)
            }
          }
          if !entry.description.isEmpty {
            Text(entry.description)
              .font(.footnote)
              .foregroundStyle(.secondary)
              .padding(.leading, 26)
          }
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          if !entry.isCurrent {
            Button("Restore") { pendingRestore = entry }.tint(.orange)
          }
          Button("Compare") {
            model.send("compareVersion", [
              "index": "\(entry.index)",
              "timestamp": entry.timestamp,
              "label": "\(entry.label) · \(relative(entry.timestamp))",
            ]) { ok in staleWarning = !ok }
          }
          .tint(.blue)
        }
        // The same two actions on a tap-and-hold, because a swipe on a row is
        // discoverable only if you already know it is there.
        .contextMenu {
          if !entry.isCurrent {
            Button("Restore this version", systemImage: "clock.arrow.circlepath") {
              pendingRestore = entry
            }
          }
          Button("Compare with current", systemImage: "arrow.left.arrow.right") {
            model.send("compareVersion", [
              "index": "\(entry.index)",
              "timestamp": entry.timestamp,
              "label": "\(entry.label) · \(relative(entry.timestamp))",
            ]) { ok in staleWarning = !ok }
          }
        }
      }
    }
  }

  /// Read-only on purpose. It reads "what has changed since then", not a
  /// proposal — the AI's review sheet is the only place changes get applied.
  private func comparison(_ diff: ShellSnapshot.History.Diff) -> some View {
    List {
      Section {
        if diff.changes.isEmpty {
          Text("Nothing has changed since this version.")
            .foregroundStyle(.secondary)
        }
        ForEach(diff.changes) { change in
          VStack(alignment: .leading, spacing: 6) {
            Text(change.label).font(.caption).foregroundStyle(.secondary)
            if !change.before.isEmpty {
              Text(change.before)
                .font(.footnote)
                .strikethrough(change.type == "remove")
                .foregroundStyle(.secondary)
            }
            if !change.after.isEmpty {
              Text(change.after).font(.footnote)
            }
          }
          .padding(.vertical, 2)
        }
      } header: {
        Text(diff.label.isEmpty ? "Compared version" : diff.label)
      } footer: {
        Text("Shown as it stands now against that version. Nothing here is applied.")
      }
    }
  }

  private func symbol(for changeType: String) -> String {
    switch changeType {
    case "initial": return "doc"
    case "ai": return "sparkles"
    case "import": return "square.and.arrow.down"
    case "reorder": return "arrow.up.arrow.down"
    case "add": return "plus"
    case "remove": return "minus"
    // A conflict's losing version, kept so it can still be restored. The web
    // dialog draws lucide's MonitorSmartphone for this; two device shapes is
    // the readable idea, so `laptopcomputer.and.iphone` is its counterpart
    // here. Only the LABEL is shared across the two platforms — the drawings
    // cannot be, which is why `src/historyEntryLabels.js` holds the strings and
    // nothing else.
    case "sync-conflict": return "laptopcomputer.and.iphone"
    default: return "pencil"
    }
  }

  /// The system's formatter, not a hand-rolled "3h ago": it speaks the user's
  /// language, which is why the timestamp crosses the bridge unformatted.
  private func relative(_ iso: String) -> String {
    guard let date = ISO8601DateFormatter.historyParser.date(from: iso) else { return "" }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter.localizedString(for: date, relativeTo: Date())
  }
}

private extension ISO8601DateFormatter {
  /// The store writes `new Date().toISOString()`, which always carries
  /// milliseconds — the default parser rejects those.
  static let historyParser: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
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
/// The application timeline.
///
/// The web draws a Gantt: one lane per résumé, dots on a shared horizontal
/// axis. That does not survive a 402pt screen — its lane-label column alone is
/// 148px, leaving a couple of hundred points for what can be a year of range,
/// and the dots land on top of each other. Same data, read top-down instead:
/// newest first, grouped by month, one row per application. The résumé each
/// one used is the secondary label rather than the axis.
private struct LibraryTimeline: View {
  @ObservedObject var model: ShellModel
  let points: [ShellSnapshot.LibraryView.TimelinePoint]
  let onOpen: () -> Void

  var body: some View {
    if points.isEmpty {
      ContentUnavailableView(
        "No applications yet",
        systemImage: "clock",
        description: Text(
          "Tailor a résumé against a job, or add an application from a "
          + "résumé, and it shows up here."
        )
      )
    } else {
      List {
        ForEach(months, id: \.key) { month in
          Section(month.title) {
            ForEach(month.points) { point in
              Button {
                model.send("openVariant", ["id": point.variantId])
                onOpen()
              } label: {
                row(point)
              }
              .buttonStyle(.plain)
            }
          }
        }
      }
    }
  }

  private func row(_ point: ShellSnapshot.LibraryView.TimelinePoint) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Circle()
        .fill(color(for: point.status))
        .frame(width: 9, height: 9)
        .padding(.top, 5)
      VStack(alignment: .leading, spacing: 2) {
        Text(point.title.isEmpty ? "Untitled role" : point.title)
          .font(.subheadline.weight(.medium))
        if !point.company.isEmpty {
          Text(point.company).font(.footnote).foregroundStyle(.secondary)
        }
        HStack(spacing: 6) {
          Text(point.variantName)
          if !point.status.isEmpty {
            Text("·")
            Text(Self.label(for: point.status))
          }
        }
        .font(.caption)
        .foregroundStyle(.tertiary)
      }
      Spacer(minLength: 0)
      Text(dayLabel(point.at))
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
    }
    .contentShape(.rect)
  }

  /// Muted for a draft that was never sent, so a prepared application does not
  /// read as an outcome — the same distinction the web makes by dimming it.
  ///
  /// The status set is closed and lives in `APPLICATION_STATUSES`
  /// (src/applications.js). It is matched here rather than sent as a colour
  /// because a colour is a rendering decision, and rather than imported
  /// because `applications.js` pulls in the store and its side effects, which
  /// would cost `iosShell.js` the purity its projections are tested on.
  private func color(for status: String) -> Color {
    switch status {
    case "prepared": return .secondary
    case "interview", "offer": return .green
    case "rejected", "no_response": return .red
    case "applied", "heard_back": return .blue
    default: return .secondary
    }
  }

  /// Mirrors `STATUS_LABELS` in src/applications.js. Not `.capitalized`, which
  /// renders `heard_back` as "Heard_back".
  private static func label(for status: String) -> String {
    switch status {
    case "prepared": return "Prepared"
    case "applied": return "Applied"
    case "heard_back": return "Heard back"
    case "interview": return "Interview"
    case "offer": return "Offer"
    case "rejected": return "Rejected"
    case "no_response": return "No response"
    default: return status
    }
  }

  private struct Month: Identifiable {
    let key: String
    let title: String
    let points: [ShellSnapshot.LibraryView.TimelinePoint]
    var id: String { key }
  }

  /// Grouped here rather than in the projection: which month a timestamp falls
  /// in depends on the device's calendar and time zone, and what that month is
  /// called depends on its locale.
  private var months: [Month] {
    var order: [String] = []
    var grouped: [String: [ShellSnapshot.LibraryView.TimelinePoint]] = [:]
    var titles: [String: String] = [:]
    for point in points {
      guard let date = Self.parse(point.at) else { continue }
      let key = Self.keyFormatter.string(from: date)
      if grouped[key] == nil {
        order.append(key)
        titles[key] = Self.monthFormatter.string(from: date)
      }
      grouped[key, default: []].append(point)
    }
    return order.map { Month(key: $0, title: titles[$0] ?? $0, points: grouped[$0] ?? []) }
  }

  private func dayLabel(_ iso: String) -> String {
    guard let date = Self.parse(iso) else { return "" }
    return Self.dayFormatter.string(from: date)
  }

  /// Two parsers: `appliedAt` carries fractional seconds and `createdAt` does
  /// not, and ISO8601DateFormatter fails outright on the option it was not
  /// given rather than ignoring it.
  private static func parse(_ iso: String) -> Date? {
    isoWithFraction.date(from: iso) ?? isoPlain.date(from: iso)
  }

  private static let isoWithFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  private static let isoPlain = ISO8601DateFormatter()
  private static let keyFormatter: DateFormatter = {
    let f = DateFormatter()
    // Fixed, because this one is a grouping KEY and must not change with the
    // locale — only the title the user reads does.
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM"
    return f
  }()
  private static let monthFormatter: DateFormatter = {
    let f = DateFormatter()
    f.setLocalizedDateFormatFromTemplate("MMMM yyyy")
    return f
  }()
  private static let dayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.setLocalizedDateFormatFromTemplate("MMM d")
    return f
  }()
}

/// Four outcome tiles and a per-résumé comparison. A strip, not a dashboard —
/// the same scope the web keeps.
private struct LibraryStats: View {
  let stats: ShellSnapshot.LibraryView.Stats?

  var body: some View {
    if let stats, stats.sent > 0 {
      List {
        Section {
          LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
            tile("Applications sent", "\(stats.sent)")
            tile("Response rate", percent(stats.responseRate))
            tile("Interview rate", percent(stats.interviewRate))
            tile("Median time to response", days(stats.medianDaysToResponse))
          }
          .padding(.vertical, 4)
        }
        .listRowBackground(Color.clear)

        if !stats.perVariant.isEmpty {
          Section("By résumé") {
            ForEach(stats.perVariant) { row in
              HStack(alignment: .firstTextBaseline) {
                Text(row.variantName).lineLimit(1)
                Spacer(minLength: 12)
                Text("\(row.responded)/\(row.sent) responses · \(row.interviewed) interview\(row.interviewed == 1 ? "" : "s")")
                  .font(.caption.monospacedDigit())
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
      }
    } else {
      ContentUnavailableView(
        "Nothing to measure yet",
        systemImage: "chart.bar",
        description: Text("Send an application and its outcome shows up here.")
      )
    }
  }

  private func tile(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(value).font(.title2.weight(.semibold).monospacedDigit())
      Text(label).font(.caption2).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
  }

  /// "—" rather than 0%: no replies yet is not a 0% response rate, and the
  /// projection sends null precisely so the two stay distinguishable.
  private func percent(_ value: Double?) -> String {
    guard let value else { return "—" }
    return "\(Int((value * 100).rounded()))%"
  }

  private func days(_ value: Double?) -> String {
    guard let value else { return "—" }
    if value < 1 { return "<1 day" }
    let n = Int(value.rounded())
    return "\(n) day\(n == 1 ? "" : "s")"
  }
}

/// Reviewing the AI's proposed changes.
///
/// **Nothing applies here.** Every button sends a command that calls the web
/// dialog's own handler — which is the whole design: tailoring goes through
/// diffEngine and `applyChangesToStore` rather than the inline-changes
/// session, and Apply All has to batch through the ordered helper rather than
/// loop, because leaf paths are indexed against the PROPOSED array. Rebuilding
/// any of that here is how someone accepts an edit that was never applied.
///
/// A decided change stays on screen, dimmed, rather than vanishing: a card
/// that disappears on Apply leaves no way to see what you just agreed to.
private struct DiffReviewSheet: View {
  @ObservedObject var model: ShellModel
  let review: ShellSnapshot.DiffReview

  var body: some View {
    NavigationStack {
      Group {
        if review.changes.isEmpty {
          ContentUnavailableView(
            "No changes to review",
            systemImage: "checkmark.circle",
            description: Text("Nothing was proposed for this résumé.")
          )
        } else {
          List {
            ForEach(review.changes) { change in
              Section {
                card(change)
              } header: {
                HStack(spacing: 6) {
                  Image(systemName: icon(for: change.kind))
                    .foregroundStyle(tint(for: change.kind))
                  Text(change.label)
                  Spacer(minLength: 0)
                  if change.applied {
                    Text("Applied").foregroundStyle(.green)
                  } else if change.rejected {
                    Text("Rejected").foregroundStyle(.secondary)
                  }
                }
                .font(.caption)
                .textCase(nil)
              }
            }
          }
        }
      }
      .navigationTitle(review.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { model.send("diffClose") }
        }
        ToolbarItem(placement: .confirmationAction) {
          // Counted, because "Apply all" beside eleven cards gives no way to
          // tell that eight of them were already decided.
          Button("Apply all (\(review.pending))") { model.send("diffApplyAll") }
            .disabled(review.pending == 0)
        }
      }
    }
  }

  @ViewBuilder
  private func card(_ change: ShellSnapshot.DiffReview.Change) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      // The old value is always struck: whether it is being replaced or
      // removed outright, it is what will no longer be there.
      if !change.before.isEmpty {
        value(change.before, tint: .red, strikethrough: true)
      }
      if !change.after.isEmpty {
        value(change.after, tint: .green, strikethrough: false)
      }
      if change.before.isEmpty && change.after.isEmpty {
        Text("(empty)").font(.footnote).italic().foregroundStyle(.secondary)
      }

      if !change.applied && !change.rejected {
        HStack(spacing: 10) {
          Button("Reject") { model.send("diffReject", ["path": change.path]) }
            .buttonStyle(.bordered)
          Button("Apply") { model.send("diffApply", ["path": change.path]) }
            .buttonStyle(.borderedProminent)
          Spacer(minLength: 0)
        }
        .controlSize(.small)
      }
    }
    .padding(.vertical, 4)
    .opacity(change.applied || change.rejected ? 0.5 : 1)
  }

  private func value(_ text: String, tint: Color, strikethrough: Bool) -> some View {
    Text(text)
      .font(.footnote)
      .strikethrough(strikethrough, color: tint)
      .foregroundStyle(strikethrough ? Color.secondary : Color.primary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(8)
      .background(tint.opacity(0.12), in: .rect(cornerRadius: 8))
  }

  private func icon(for kind: String) -> String {
    switch kind {
    case "add": return "plus.circle.fill"
    case "remove": return "minus.circle.fill"
    default: return "pencil.circle.fill"
    }
  }

  private func tint(for kind: String) -> Color {
    switch kind {
    case "add": return .green
    case "remove": return .red
    default: return .blue
    }
  }
}

private struct LibrarySheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var query = ""
  @State private var deep = false
  @State private var tab = Tab.resumes

  private enum Tab: String, CaseIterable, Identifiable {
    case resumes = "Resumes"
    case timeline = "Timeline"
    case stats = "Stats"
    var id: String { rawValue }
  }

  private var library: ShellSnapshot.LibraryView? { model.snapshot.library }
  private var entries: [ShellSnapshot.LibraryEntry] { library?.entries ?? [] }

  var body: some View {
    NavigationStack {
      Group {
        switch tab {
        case .resumes: resumeList
        case .timeline: LibraryTimeline(model: model, points: library?.timeline ?? []) { dismiss() }
        case .stats: LibraryStats(stats: library?.stats)
        }
      }
      .navigationTitle("All resumes")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .principal) {
          Picker("View", selection: $tab) {
            ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
          }
          .pickerStyle(.segmented)
          .frame(width: 260)
        }
      }
      .onAppear { search() }
    }
  }

  private var resumeList: some View {
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
    // Only the résumé list is searchable — the search filters ENTRIES, and
    // leaving the field up on a tab it does not affect reads as a broken
    // search rather than an inapplicable one.
    .searchable(text: $query, prompt: "Search resumes")
    .onChange(of: query) { _, _ in search() }
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

// MARK: - Design

private typealias Design = ShellSnapshot.Design

/// The native design panel.
///
/// A LIST of screens rather than one Form: the web panel is nine collapsing
/// sections holding sixty-odd controls, and a phone-width form of that is a
/// scroll nobody can hold their place in. Each row names a section and shows
/// what it is currently set to, which is also what makes the panel worth
/// reading without opening anything.
///
/// Nothing in here previews the résumé, and nothing needs to: the canvas is
/// directly behind the sheet and every control writes straight through to it,
/// so a grid of layout tiles only has to name them — tapping one re-renders the
/// page underneath.
private struct DesignSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if let design = model.snapshot.design {
          List {
            Section {
              row("Page", "doc", pageSummary(design)) { PageScreen(model: model) }
              row("Color", "paintpalette", colorSummary(design)) { ColorScreen(model: model) }
              row("Layout", "square.split.2x1", optionName(design.layout, in: design.layouts)) {
                LayoutScreen(model: model)
              }
              row("Header", "rectangle.tophalf.filled", headerSummary(design)) {
                HeaderScreen(model: model)
              }
            }
            Section {
              row("Typography", "textformat", fontsSummary(design)) { TypographyScreen(model: model) }
              row("Spacing", "arrow.up.and.down", spacingSummary(design)) { SpacingScreen(model: model) }
              row("Accents", "sparkles", accentSummary(design)) { AccentsScreen(model: model) }
              row("Photo", "person.crop.circle", photoSummary(design)) { PhotoScreen(model: model) }
            }
          }
        } else {
          // The first projection lands a frame after the sheet opens; an empty
          // list would read as a design panel with nothing in it.
          ProgressView()
        }
      }
      .navigationTitle("Design")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }

  private func row<Destination: View>(
    _ title: String, _ symbol: String, _ value: String,
    @ViewBuilder destination: () -> Destination
  ) -> some View {
    NavigationLink {
      destination()
    } label: {
      LabeledContent {
        Text(value).lineLimit(1)
      } label: {
        Label(title, systemImage: symbol)
      }
    }
  }

  // The summaries below all fall back to the raw id. A projection that gains a
  // value before this file learns its name should show the value rather than an
  // empty row that looks like nothing is set.

  private func pageSummary(_ design: Design) -> String {
    optionName(design.page.size, in: design.pageSizes)
  }

  private func colorSummary(_ design: Design) -> String {
    if design.color.palette == "custom" { return "Custom" }
    return design.palettes.first { $0.id == design.color.palette }?.name ?? design.color.palette
  }

  private func headerSummary(_ design: Design) -> String {
    switch design.header.type {
    case "solid": return "Solid"
    case "image": return "Image"
    default:
      return design.headerStyles.first { $0.id == design.header.styleId }?.name
        ?? design.header.styleId
    }
  }

  private func fontsSummary(_ design: Design) -> String {
    if design.fonts.mode == "preset",
       let pairing = design.fontPairings.first(where: { $0.id == design.fonts.pairingId }) {
      return pairing.name
    }
    let names = [design.fonts.displayName, design.fonts.bodyName].filter { !$0.isEmpty }
    return names.isEmpty ? "Default" : names.joined(separator: " + ")
  }

  private func spacingSummary(_ design: Design) -> String {
    design.spacing.presetId.isEmpty
      ? "Custom"
      : optionName(design.spacing.presetId, in: design.spacingPresets)
  }

  private func accentSummary(_ design: Design) -> String {
    let underline = optionName(design.accent.underlineStyle, in: design.underlines)
    let bullet = design.bullets.first { $0.id == design.accent.bulletStyle }?.name
      ?? design.accent.bulletStyle
    return "\(underline) · \(bullet)"
  }

  private func photoSummary(_ design: Design) -> String {
    guard design.photo.hasImage else { return "None" }
    guard design.photo.enabled else { return "Off" }
    return optionName(design.photo.placement, in: design.placements)
  }
}

// MARK: design plumbing

/// The name of the option with this id, or the id itself.
private func optionName(_ id: String, in options: [Design.Option]) -> String {
  options.first { $0.id == id }?.name ?? id
}

/// Bindings that WRITE through `setDesign` and READ from the LIVE snapshot.
///
/// The SettingsSheet rule, and it earns more here: `applyDesign` clamps and
/// normalises what it is given, and a preset write moves eight other controls at
/// once. A control holding its own copy would show a value the résumé never
/// took; reading the snapshot back means a rejected write simply springs the
/// control to what actually landed.
///
/// The fallbacks are inert — `design` is only nil while the sheet is closing,
/// and a control on its way off screen showing one frame of nothing is not
/// worth a second code path.
///
/// `@MainActor` on all three: a `Binding`'s get and set are `@Sendable`, and a
/// closure formed in a nonisolated function cannot then touch the model at all.
/// The isolation is what a View gets for free — every caller here is one — and
/// stating it is what keeps these free functions on the same footing.
@MainActor
private func designText(
  _ model: ShellModel, _ group: String, _ property: String,
  _ read: @escaping (Design) -> String
) -> Binding<String> {
  Binding(
    get: { model.snapshot.design.map(read) ?? "" },
    set: { model.send("setDesign", ["group": group, "property": property, "value": $0]) }
  )
}

@MainActor
private func designFlag(
  _ model: ShellModel, _ group: String, _ property: String,
  _ read: @escaping (Design) -> Bool
) -> Binding<Bool> {
  Binding(
    get: { model.snapshot.design.map(read) ?? false },
    set: {
      model.send(
        "setDesign", ["group": group, "property": property, "value": $0 ? "true" : "false"]
      )
    }
  )
}

/// `places` is the STEP's precision, not a display choice: the string is the
/// number the store keeps, and "%.2f" on a 0.1-step margin is what stops
/// 0.30000000000000004 crossing the bridge.
///
/// A slider sends on every frame of the drag, deliberately. The web side
/// debounces repagination by 200ms, so the canvas keeps up on its own and a
/// throttle here would only make the résumé lag the thumb.
@MainActor
private func designNumber(
  _ model: ShellModel, _ group: String, _ property: String,
  fallback: Double, places: Int,
  _ read: @escaping (Design) -> Double
) -> Binding<Double> {
  Binding(
    get: { model.snapshot.design.map(read) ?? fallback },
    set: {
      model.send(
        "setDesign",
        ["group": group, "property": property, "value": String(format: "%.\(places)f", $0)]
      )
    }
  )
}

/// A six-digit CSS hex as a Color. Everything on this wire is written the way
/// CSS writes it, because the store's own colour maths reads it back the same
/// way — `generateDarkColor` slices the string three bytes at a time.
private func designColor(_ hex: String) -> Color? {
  var digits = hex.trimmingCharacters(in: .whitespaces)
  if digits.hasPrefix("#") { digits.removeFirst() }
  guard digits.count == 6, let value = UInt64(digits, radix: 16) else { return nil }
  return Color(
    .sRGB,
    red: Double((value >> 16) & 0xFF) / 255,
    green: Double((value >> 8) & 0xFF) / 255,
    blue: Double(value & 0xFF) / 255,
    opacity: 1
  )
}

/// Back to `#rrggbb`, which is the only form the store parses.
///
/// The picker can hand back a wide-gamut colour whose components fall outside
/// 0–1. Clamping shifts it a shade; the alternative is a string the store reads
/// as NaN and paints black with.
private func designHex(_ color: Color) -> String {
  var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
  _ = UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
  func byte(_ value: CGFloat) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
  return String(format: "#%02X%02X%02X", byte(red), byte(green), byte(blue))
}

/// The opaque colours in a header style's CSS, in the order they appear.
///
/// Swift renders no CSS, and a grid of identical grey rectangles is a picker
/// nobody can use. Mining the hex out of the string the web tile paints with
/// gets the tile the right COLOURS, which is what a header style is mostly
/// about — the pattern families then differ only by name, and the résumé behind
/// the sheet is the real preview.
///
/// Only the six-digit ones: a pattern lists its accent tint first as a hex with
/// a two-digit alpha suffix, and a tile starting from an 8%-opaque overlay
/// reads as broken.
private func designSwatchColors(in css: String) -> [Color] {
  var tokens: [String] = []
  var current: String?
  for character in css {
    if character == "#" {
      if let pending = current { tokens.append(pending) }
      current = ""
    } else if current != nil, character.isHexDigit {
      current?.append(character)
    } else if let pending = current {
      tokens.append(pending)
      current = nil
    }
  }
  if let pending = current { tokens.append(pending) }
  return tokens.filter { $0.count == 6 }.compactMap(designColor)
}

/// The web swatch's three bands, at the same 135° and the same stops.
private func paletteSwatch(_ palette: Design.Palette) -> some View {
  let accent = designColor(palette.p1) ?? .secondary
  let dark = designColor(palette.p2) ?? .secondary
  let light = designColor(palette.p3) ?? .secondary
  return LinearGradient(
    stops: [
      .init(color: dark, location: 0),
      .init(color: dark, location: 0.4),
      .init(color: accent, location: 0.4),
      .init(color: accent, location: 0.6),
      .init(color: light, location: 0.6),
      .init(color: light, location: 1),
    ],
    startPoint: .topLeading,
    endPoint: .bottomTrailing
  )
}

/// The columns every tile grid in this panel uses. Adaptive rather than a fixed
/// count so the same grid works on a phone and on an iPad's wider sheet.
private let designTileColumns = [GridItem(.adaptive(minimum: 84), spacing: 12)]

/// A tile in one of the pickers: a swatch, its name under it, and a ring when it
/// is the chosen one.
private struct DesignTile<Swatch: View>: View {
  let name: String
  let selected: Bool
  let action: () -> Void
  @ViewBuilder let swatch: () -> Swatch

  var body: some View {
    Button(action: action) {
      VStack(spacing: 6) {
        swatch()
          .frame(height: 44)
          .frame(maxWidth: .infinity)
          .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
          .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .strokeBorder(
                selected ? Color.accentColor : Color.primary.opacity(0.12),
                lineWidth: selected ? 2.5 : 0.5
              )
          }
        Text(name)
          .font(.caption)
          .lineLimit(1)
          .foregroundStyle(selected ? Color.primary : Color.secondary)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(name)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }
}

/// A row that is a choice: its own content, and a checkmark when it is the one
/// in force.
///
/// A `Button` rather than a `Picker` row, because these lists carry a second
/// line of detail — a pairing's two font names, a font's category — and a picker
/// row is one line of text.
private struct DesignChoiceRow<Content: View>: View {
  let selected: Bool
  let action: () -> Void
  @ViewBuilder let content: () -> Content

  var body: some View {
    Button(action: action) {
      HStack {
        content()
        Spacer(minLength: 8)
        if selected {
          Image(systemName: "checkmark")
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.accentColor)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }
}

/// A labelled slider with its readout above the track.
///
/// The web panel puts the label beside the slider. A phone row leaves about
/// 100pt of track once it has, which is not enough to pick a 1% step out of.
private struct DesignSlider: View {
  let title: String
  let readout: String
  let value: Binding<Double>
  let range: ClosedRange<Double>
  var step: Double = 0.01

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      LabeledContent(title) {
        Text(readout).monospacedDigit().foregroundStyle(.secondary)
      }
      Slider(value: value, in: range, step: step)
        .accessibilityLabel(title)
        .accessibilityValue(readout)
    }
    .padding(.vertical, 2)
  }
}

private func designPercent(_ fraction: Double) -> String {
  "\(Int((fraction * 100).rounded()))%"
}

// MARK: design images

/// The longest edge, in pixels, of an image this sends across the bridge.
///
/// Generous enough that a header background still has detail at print
/// resolution, small enough that the data URL — which is stored with the
/// résumé, copied into every backup and re-parsed on every render — stays in
/// the hundreds of kilobytes.
private let designImageMaxEdge: CGFloat = 1600

/// Load a picked image and encode it as a data URL for `setDesignImage`.
private func designImageDataURL(for item: PhotosPickerItem) async -> String? {
  guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
  // Detached: decoding and redrawing a full-resolution photo takes long enough
  // to drop frames, and the picker is dismissing over the top of it.
  return await Task.detached { designEncodedImage(data) }.value
}

/// Downscale and re-encode picked image data.
///
/// Two things rule out passing the picked bytes through untouched. The picker
/// hands back whatever the library holds, which on an iPhone is usually HEIC —
/// WebKit renders it, the Windows build's WebView2 does not, and a résumé
/// travels between them through backup export. And a 12-megapixel photo is
/// ~4MB before base64 inflates it by a third, for an image the résumé draws
/// 100pt wide.
///
/// PNG only when the source actually carries alpha: JPEG fills it black, which
/// on a cut-out header image is the whole point of the file, and PNG on a
/// photograph is several megabytes for nothing.
private func designEncodedImage(_ data: Data) -> String? {
  guard let image = UIImage(data: data) else { return nil }
  let longEdge = max(image.size.width, image.size.height)
  guard longEdge > 0 else { return nil }
  let ratio = min(designImageMaxEdge / longEdge, 1)
  let size = CGSize(
    width: max((image.size.width * ratio).rounded(), 1),
    height: max((image.size.height * ratio).rounded(), 1)
  )

  let format = UIGraphicsImageRendererFormat.default()
  // 1, not the screen's 3: the renderer would otherwise return a bitmap three
  // times the size just asked for, which is the cap undone.
  format.scale = 1
  format.opaque = !designImageHasAlpha(image)
  let scaled = UIGraphicsImageRenderer(size: size, format: format).image { _ in
    image.draw(in: CGRect(origin: .zero, size: size))
  }

  if format.opaque, let jpeg = scaled.jpegData(compressionQuality: 0.85) {
    return "data:image/jpeg;base64," + jpeg.base64EncodedString()
  }
  guard let png = scaled.pngData() else { return nil }
  return "data:image/png;base64," + png.base64EncodedString()
}

private func designImageHasAlpha(_ image: UIImage) -> Bool {
  guard let info = image.cgImage?.alphaInfo else { return false }
  switch info {
  case .first, .last, .premultipliedFirst, .premultipliedLast, .alphaOnly: return true
  default: return false
  }
}

// MARK: page

private struct PageScreen: View {
  @ObservedObject var model: ShellModel

  var body: some View {
    Form { content }
      .navigationTitle("Page")
      .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        Picker("Size", selection: designText(model, "page", "size") { $0.page.size }) {
          ForEach(design.pageSizes) { Text($0.name).tag($0.id) }
        }
        // Width and orientation are alternatives, not both: a continuous page
        // has no second dimension to turn.
        if design.page.size == "continuous" {
          Stepper(
            value: designNumber(model, "page", "widthIn", fallback: 8.5, places: 2) {
              $0.page.widthIn
            },
            in: 3...20,
            step: 0.1
          ) {
            LabeledContent("Width", value: String(format: "%.1f in", design.page.widthIn))
          }
        } else {
          Picker(
            "Orientation",
            selection: designText(model, "page", "orientation") { $0.page.orientation }
          ) {
            Text("Portrait").tag("portrait")
            Text("Landscape").tag("landscape")
          }
          .pickerStyle(.segmented)
        }
      }

      Section {
        Picker(
          "Positions at one employer",
          selection: designFlag(model, "page", "groupPositions") { $0.page.groupPositions }
        ) {
          Text("Grouped").tag(true)
          Text("Separate").tag(false)
        }
        .pickerStyle(.segmented)
        // The label is longer than the row, so it moves to the header and the
        // segments take the full width. It stays here for VoiceOver.
        .labelsHidden()
      } header: {
        Text("Positions at one employer")
      } footer: {
        Text(
          "Grouped puts one heading over every role at the same employer. "
          + "Separate gives each role its own."
        )
      }
    }
  }
}

// MARK: colour

private struct ColorScreen: View {
  @ObservedObject var model: ShellModel

  var body: some View {
    Form { content }
      .navigationTitle("Color")
      .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        LazyVGrid(columns: designTileColumns, spacing: 12) {
          ForEach(design.palettes) { palette in
            DesignTile(
              name: palette.name,
              selected: design.color.palette == palette.id,
              action: {
                model.send(
                  "setDesign", ["group": "color", "property": "palette", "value": palette.id]
                )
              },
              swatch: { paletteSwatch(palette) }
            )
          }
        }
        .padding(.vertical, 6)
      } header: {
        Text("Palette")
      }

      Section {
        ColorPicker(
          "Custom color",
          selection: Binding(
            get: { designColor(model.snapshot.design?.color.customColor ?? "") ?? .accentColor },
            set: {
              model.send(
                "setDesign",
                ["group": "color", "property": "customColor", "value": designHex($0)]
              )
            }
          ),
          supportsOpacity: false
        )
        DesignChoiceRow(
          selected: design.color.palette == "custom",
          action: {
            model.send("setDesign", ["group": "color", "property": "palette", "value": "custom"])
          },
          content: { Text("Use the custom color") }
        )
      } footer: {
        // Two controls rather than one, because that is what the model is: the
        // custom colour is remembered whether or not it is in use, and picking
        // one on the web does not switch the résumé to it either.
        Text(
          design.color.palette == "custom"
            ? "The resume is using your custom color."
            : "Pick a color, then use it — the palette above stays in charge until you do."
        )
      }
    }
  }
}

// MARK: layout

private struct LayoutScreen: View {
  @ObservedObject var model: ShellModel

  var body: some View {
    Form { content }
      .navigationTitle("Layout")
      .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        // Names, not thumbnails. Drawing eleven schematics here would mean
        // teaching Swift what each layout looks like — a second description of
        // the templates, free to drift from the ones that render — and the
        // résumé itself is one tap away behind the sheet.
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
          ForEach(design.layouts) { layout in
            let selected = design.layout == layout.id
            Button {
              model.send("setDesign", ["group": "layout", "property": "value", "value": layout.id])
            } label: {
              HStack(spacing: 6) {
                Text(layout.name).lineLimit(1)
                Spacer(minLength: 0)
                if selected {
                  Image(systemName: "checkmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                }
              }
              .padding(.horizontal, 12)
              .frame(height: 44)
              .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .fill(selected ? Color.accentColor.opacity(0.10) : Color.clear)
              )
              .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .strokeBorder(
                    selected ? Color.accentColor : Color.primary.opacity(0.12),
                    lineWidth: selected ? 2 : 0.5
                  )
              }
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? [.isSelected] : [])
          }
        }
        .padding(.vertical, 6)
      } footer: {
        Text("The resume behind this sheet re-renders as you tap.")
      }
    }
  }
}

// MARK: header

private struct HeaderScreen: View {
  @ObservedObject var model: ShellModel

  @State private var pick: PhotosPickerItem?
  @State private var confirmRemove = false

  var body: some View {
    Form { content }
      .navigationTitle("Header")
      .navigationBarTitleDisplayMode(.inline)
      .onChange(of: pick) { _, item in
        guard let item else { return }
        Task {
          let url = await designImageDataURL(for: item)
          // Cleared either way, or picking the same photo twice in a row is the
          // same item and never fires this again.
          pick = nil
          guard let url else {
            NSLog("[OPShell] could not read the picked header image")
            return
          }
          model.send("setDesignImage", ["target": "header", "dataUrl": url])
        }
      }
      .confirmationDialog(
        "Remove the header image?", isPresented: $confirmRemove, titleVisibility: .visible
      ) {
        Button("Remove", role: .destructive) {
          model.send("clearDesignImage", ["target": "header"])
        }
      } message: {
        Text("The header goes back to a gradient. The image is not kept.")
      }
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        DesignChoiceRow(
          selected: design.header.type == "solid",
          action: { selectStyle(type: "solid", id: "solid") },
          content: { Text("Solid color") }
        )
      } footer: {
        Text("The header takes the palette's own color, with nothing over it.")
      }

      ForEach(styleGroups(design), id: \.self) { group in
        Section(groupTitle(group)) {
          LazyVGrid(columns: designTileColumns, spacing: 12) {
            ForEach(design.headerStyles.filter { $0.group == group }) { style in
              DesignTile(
                name: style.name,
                selected: design.header.type == group && design.header.styleId == style.id,
                action: { selectStyle(type: group, id: style.id) },
                swatch: { styleSwatch(style) }
              )
            }
          }
          .padding(.vertical, 6)
        }
      }

      Section {
        // No `photoLibrary:` argument, so the picker runs out of process: it
        // needs neither a permission prompt nor an `NSPhotoLibraryUsageDescription`
        // in an Info.plist this file does not own, and it still hands back the
        // one image that was chosen.
        PhotosPicker(selection: $pick, matching: .images) {
          Label(
            design.header.hasImage ? "Replace image" : "Add an image",
            systemImage: "photo.on.rectangle"
          )
        }
        if design.header.hasImage {
          DesignSlider(
            title: "Opacity",
            readout: designPercent(design.header.imageOpacity),
            value: designNumber(model, "header", "imageOpacity", fallback: 0.3, places: 2) {
              $0.header.imageOpacity
            },
            range: 0...1
          )
          Picker(
            "Fit",
            selection: designText(model, "header", "imageFit") { $0.header.imageFit }
          ) {
            Text("Cover").tag("cover")
            Text("Contain").tag("contain")
            Text("Tile").tag("tile")
          }
          .pickerStyle(.segmented)
          Button("Remove image", role: .destructive) { confirmRemove = true }
        }
      } header: {
        Text("Image")
      } footer: {
        // No preview of the image itself: the contract carries `hasImage` and
        // not the data URL, on purpose — a header background is a megabyte of
        // base64 and re-sending it on every design write would be the largest
        // thing on this wire by an order of magnitude.
        Text("An image sits behind the header at the opacity you choose, and is saved with the resume.")
      }
    }
  }

  /// The groups the contract sent, in the order it sent them.
  private func styleGroups(_ design: Design) -> [String] {
    var groups: [String] = []
    for style in design.headerStyles where !groups.contains(style.group) {
      groups.append(style.group)
    }
    return groups
  }

  /// gradient → Gradients. The contract's group ids are already the words.
  private func groupTitle(_ group: String) -> String {
    group.capitalized + "s"
  }

  private func selectStyle(type: String, id: String) {
    model.send("setDesign", ["group": "header", "property": "style", "value": "\(type):\(id)"])
  }

  @ViewBuilder
  private func styleSwatch(_ style: Design.HeaderStyle) -> some View {
    let colors = designSwatchColors(in: style.css)
    if colors.count >= 2 {
      LinearGradient(
        colors: Array(colors.prefix(3)), startPoint: .topLeading, endPoint: .bottomTrailing
      )
    } else if let only = colors.first {
      only
    } else {
      Color.secondary.opacity(0.2)
    }
  }
}

// MARK: typography

private struct TypographyScreen: View {
  @ObservedObject var model: ShellModel

  var body: some View {
    Form { content }
      .navigationTitle("Typography")
      .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        ForEach(design.fontPairings) { pairing in
          DesignChoiceRow(
            selected: design.fonts.mode == "preset" && design.fonts.pairingId == pairing.id,
            action: {
              model.send(
                "setDesign", ["group": "fonts", "property": "pairing", "value": pairing.id]
              )
            },
            content: {
              VStack(alignment: .leading, spacing: 2) {
                Text(pairing.name)
                Text("\(pairing.display) + \(pairing.body)")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
            }
          )
        }
      } header: {
        Text("Pairings")
      } footer: {
        Text("A pairing sets both fonts at once. Choosing either font below leaves it.")
      }

      Section("Fonts") {
        NavigationLink {
          FontScreen(model: model, role: "display", title: "Headings")
        } label: {
          LabeledContent("Headings", value: fontLabel(design.fonts.displayName))
        }
        NavigationLink {
          FontScreen(model: model, role: "body", title: "Body")
        } label: {
          LabeledContent("Body", value: fontLabel(design.fonts.bodyName))
        }
      }
    }
  }

  private func fontLabel(_ value: String) -> String {
    value.isEmpty ? "Default" : value
  }
}

private struct FontScreen: View {
  @ObservedObject var model: ShellModel
  /// "display" or "body" — the `setDesign` property, carried rather than
  /// derived, so this screen never has to know which of the two it is.
  let role: String
  let title: String

  @State private var query = ""

  var body: some View {
    List { content }
      // Filtered here rather than by a round trip, unlike the library's search:
      // the whole catalogue is a few dozen names and it is already in hand.
      .searchable(text: $query, prompt: "Search fonts")
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      // The contract sends the font's NAME, not the id it was chosen by, so
      // that is what the checkmark matches on. It is the only handle there is,
      // and it is enough: two fonts with one name are one font.
      let current = role == "display" ? design.fonts.displayName : design.fonts.bodyName
      let systemFonts = design.systemFonts.filter { matches($0.name) }
      let googleFonts = design.googleFonts.filter { matches($0.family) }

      if systemFonts.isEmpty, googleFonts.isEmpty {
        ContentUnavailableView.search(text: query)
      }

      if !systemFonts.isEmpty {
        Section {
          ForEach(systemFonts) { font in
            DesignChoiceRow(
              selected: font.name == current,
              action: { select("system:\(font.id)") },
              content: { Text(font.name) }
            )
          }
        } header: {
          Text("System")
        } footer: {
          Text("System fonts work offline and render the same on every device.")
        }
      }

      if !googleFonts.isEmpty {
        Section("Google Fonts") {
          ForEach(googleFonts) { font in
            DesignChoiceRow(
              selected: font.family == current,
              action: { select("google:\(font.family):\(font.category)") },
              content: {
                HStack(spacing: 8) {
                  Text(font.family)
                  Text(font.category).font(.caption).foregroundStyle(.secondary)
                }
              }
            )
          }
        }
      }
    }
  }

  private func matches(_ name: String) -> Bool {
    query.isEmpty || name.localizedCaseInsensitiveContains(query)
  }

  private func select(_ value: String) {
    model.send("setDesign", ["group": "fonts", "property": role, "value": value])
  }
}

// MARK: spacing

private struct SpacingScreen: View {
  @ObservedObject var model: ShellModel

  @State private var confirmReset = false

  var body: some View {
    Form { content }
      .navigationTitle("Spacing")
      .navigationBarTitleDisplayMode(.inline)
      .confirmationDialog(
        "Reset spacing?", isPresented: $confirmReset, titleVisibility: .visible
      ) {
        Button("Reset", role: .destructive) {
          model.send("resetDesign", ["group": "spacing"])
        }
      } message: {
        Text("Every size and margin here goes back to its default. Your text is not affected.")
      }
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        Picker(
          "Preset",
          selection: designText(model, "spacing", "preset") { $0.spacing.presetId }
        ) {
          ForEach(design.spacingPresets) { Text($0.name).tag($0.id) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
      } header: {
        Text("Preset")
      } footer: {
        // "" arrives once a slider has been moved off every preset, and no
        // segment being lit is then the truth: the spacing is none of them.
        Text(
          design.spacing.presetId.isEmpty
            ? "Fine-tuned — no preset is in force."
            : "A preset sets everything below at once."
        )
      }

      Section("Fine tune") {
        DesignSlider(
          title: "Font size",
          readout: designPercent(design.spacing.fontScale),
          value: designNumber(model, "spacing", "fontScale", fallback: 1, places: 2) {
            $0.spacing.fontScale
          },
          range: 0.7...1.3
        )
        DesignSlider(
          title: "Line height",
          readout: String(format: "%.2f", design.spacing.lineHeight),
          value: designNumber(model, "spacing", "lineHeight", fallback: 1.45, places: 2) {
            $0.spacing.lineHeight
          },
          range: 1.2...1.8
        )
        DesignSlider(
          title: "Section gap",
          readout: String(format: "%.1f rem", design.spacing.sectionSpacing),
          value: designNumber(model, "spacing", "sectionSpacing", fallback: 0.8, places: 1) {
            $0.spacing.sectionSpacing
          },
          range: 0.4...1.6,
          step: 0.1
        )
        DesignSlider(
          title: "Sidebar width",
          readout: String(format: "%.1f in", design.spacing.sidebarWidth),
          value: designNumber(model, "spacing", "sidebarWidth", fallback: 2.2, places: 1) {
            $0.spacing.sidebarWidth
          },
          range: 1.8...3.2,
          step: 0.1
        )
      }

      Section {
        marginStepper("Top", "marginTop") { $0.spacing.marginTop }
        marginStepper("Right", "marginRight") { $0.spacing.marginRight }
        marginStepper("Bottom", "marginBottom") { $0.spacing.marginBottom }
        marginStepper("Left", "marginLeft") { $0.spacing.marginLeft }
      } header: {
        Text("Page margins")
      } footer: {
        Text("Sidebar width and margins apply to the layouts that have them.")
      }

      Section {
        // Behind a dialog, where the desktop has a 28pt ghost icon in a section
        // header. On a phone an unconfirmed reset is one mis-tap away from an
        // hour of fitting a résumé onto one page.
        Button("Reset spacing", role: .destructive) { confirmReset = true }
      }
    }
  }

  private func marginStepper(
    _ title: String, _ property: String, _ read: @escaping (Design) -> Double
  ) -> some View {
    Stepper(
      value: designNumber(model, "spacing", property, fallback: 0.5, places: 2, read),
      in: 0.2...1.0,
      step: 0.1
    ) {
      LabeledContent(
        title, value: String(format: "%.1f in", model.snapshot.design.map(read) ?? 0.5)
      )
    }
  }
}

// MARK: accents

private struct AccentsScreen: View {
  @ObservedObject var model: ShellModel

  @State private var confirmReset = false

  var body: some View {
    Form { content }
      .navigationTitle("Accents")
      .navigationBarTitleDisplayMode(.inline)
      .confirmationDialog(
        "Reset accents?", isPresented: $confirmReset, titleVisibility: .visible
      ) {
        Button("Reset", role: .destructive) {
          model.send("resetDesign", ["group": "accent"])
        }
      } message: {
        Text("Underlines, bullets, corners and skill tags all go back to their defaults.")
      }
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section("Section titles") {
        Picker(
          "Underline",
          selection: designText(model, "accent", "underlineStyle") { $0.accent.underlineStyle }
        ) {
          ForEach(design.underlines) { Text($0.name).tag($0.id) }
        }
        DesignSlider(
          title: "Underline width",
          readout: "\(Int(design.accent.underlineWidth.rounded()))px",
          value: designNumber(model, "accent", "underlineWidth", fallback: 2, places: 0) {
            $0.accent.underlineWidth
          },
          range: 1...4,
          step: 1
        )
      }

      Section("Lists") {
        Picker(
          "Bullet",
          selection: designText(model, "accent", "bulletStyle") { $0.accent.bulletStyle }
        ) {
          // The glyph in front of the name, so the row shows what the résumé
          // will show. "None" has no glyph to show.
          ForEach(design.bullets) { bullet in
            Text(bullet.char.isEmpty ? bullet.name : "\(bullet.char)  \(bullet.name)")
              .tag(bullet.id)
          }
        }
      }

      Section("Shapes") {
        Picker(
          "Corner rounding",
          selection: designText(model, "accent", "borderRadius") { $0.accent.borderRadius }
        ) {
          ForEach(design.radii) { Text($0.name).tag($0.id) }
        }
        Picker(
          "Skill tags",
          selection: designText(model, "accent", "skillTagStyle") { $0.accent.skillTagStyle }
        ) {
          ForEach(design.skillTags) { Text($0.name).tag($0.id) }
        }
      }

      Section("Decoration") {
        Toggle(
          "Header corner accent",
          isOn: designFlag(model, "accent", "showCornerTriangle") { $0.accent.showCornerTriangle }
        )
        Toggle(
          "Sidebar gradient",
          isOn: designFlag(model, "accent", "showSidebarGradient") { $0.accent.showSidebarGradient }
        )
      }

      Section {
        Button("Reset accents", role: .destructive) { confirmReset = true }
      }
    }
  }
}

// MARK: photo

/// The nine `object-position` values, in reading order.
///
/// These are not on the wire and do not need to be: the pad's geometry IS the
/// value — top left is the button in the top left corner — so a list of ids
/// would not tell this screen anything the grid does not already say.
private let designFocusPositions = [
  "left top", "center top", "right top",
  "left center", "center center", "right center",
  "left bottom", "center bottom", "right bottom",
]

private struct PhotoScreen: View {
  @ObservedObject var model: ShellModel

  @State private var pick: PhotosPickerItem?
  @State private var confirmRemove = false

  var body: some View {
    Form { content }
      .navigationTitle("Photo")
      .navigationBarTitleDisplayMode(.inline)
      .onChange(of: pick) { _, item in
        guard let item else { return }
        Task {
          let url = await designImageDataURL(for: item)
          pick = nil
          guard let url else {
            NSLog("[OPShell] could not read the picked photo")
            return
          }
          model.send("setDesignImage", ["target": "photo", "dataUrl": url])
        }
      }
      .confirmationDialog(
        "Remove the photo?", isPresented: $confirmRemove, titleVisibility: .visible
      ) {
        Button("Remove", role: .destructive) {
          model.send("clearDesignImage", ["target": "photo"])
        }
      } message: {
        Text("The photo is deleted from this resume. Adding one again means picking it again.")
      }
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        // Out of process, as on the header screen — no permission, no plist.
        PhotosPicker(selection: $pick, matching: .images) {
          Label(
            design.photo.hasImage ? "Replace photo" : "Add a photo",
            systemImage: "person.crop.square"
          )
        }
        if design.photo.hasImage {
          Toggle("Show the photo", isOn: designFlag(model, "photo", "enabled") { $0.photo.enabled })
          Button("Remove photo", role: .destructive) { confirmRemove = true }
        }
      } footer: {
        Text(
          design.photo.hasImage
            ? "The photo is stored with this resume and travels with its backup."
            : "Photos suit some templates and some countries. Many hiring processes prefer none."
        )
      }

      if design.photo.hasImage {
        Section("Placement") {
          Picker(
            "Position",
            selection: designText(model, "photo", "placement") { $0.photo.placement }
          ) {
            ForEach(design.placements) { Text($0.name).tag($0.id) }
          }
          Picker("Shape", selection: designText(model, "photo", "shape") { $0.photo.shape }) {
            ForEach(design.shapes) { Text($0.name).tag($0.id) }
          }
          Picker("Size", selection: designText(model, "photo", "size") { $0.photo.size }) {
            ForEach(design.sizes) { Text($0.name).tag($0.id) }
          }
          Picker(
            "Border",
            selection: designText(model, "photo", "borderColor") { $0.photo.borderColor }
          ) {
            Text("Accent").tag("accent")
            Text("White").tag("white")
            Text("None").tag("none")
          }
        }

        Section {
          focusPad(design)
          DesignSlider(
            title: "Zoom",
            readout: designPercent(design.photo.scale),
            value: designNumber(model, "photo", "scale", fallback: 1, places: 2) { $0.photo.scale },
            range: 1...2
          )
        } header: {
          Text("Crop")
        } footer: {
          Text("The focus point decides which part of the photo survives the crop.")
        }
      }
    }
  }

  private func focusPad(_ design: Design) -> some View {
    LazyVGrid(
      columns: Array(repeating: GridItem(.fixed(40), spacing: 8), count: 3), spacing: 8
    ) {
      ForEach(designFocusPositions, id: \.self) { position in
        let selected = design.photo.objectPosition == position
        Button {
          model.send(
            "setDesign", ["group": "photo", "property": "objectPosition", "value": position]
          )
        } label: {
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(selected ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.12))
            .frame(width: 40, height: 40)
            .overlay {
              Circle()
                .fill(selected ? Color.accentColor : Color.secondary)
                .frame(width: 8, height: 8)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(position.capitalized)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 4)
  }
}
